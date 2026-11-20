import { createHash } from 'node:crypto';
import { padParam, saturate } from '@holo/session';
import { describe, expect, it } from 'vitest';
import type { SamplerSpec, SampleZone } from '../src/protocol.ts';
import { playingExtras } from '../src/render.ts';
import { Sampler } from '../src/sampler.ts';

const SR = 44100;

/** A deterministic noise burst: a hit's shape (an attack, a ring that falls) without a recording. */
function burst(seed: number, frames: number, decay: number, level: number): Float32Array {
  const out = new Float32Array(frames);
  let s = seed >>> 0;
  let lp = 0;
  for (let i = 0; i < frames; i++) {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    const white = s / 2 ** 31 - 1;
    // a little body under the noise: a falling tone, as a drum has
    lp += (white - lp) * 0.2;
    const tone = Math.sin((2 * Math.PI * (60 + 140 * Math.exp(-i / 900)) * i) / SR);
    out[i] = level * Math.exp(-i / decay) * (0.6 * lp + 0.4 * tone);
  }
  return out;
}

/** The same burst as 16-bit frames (as a pack's 16-bit samples are kept). */
const pcm = (f: Float32Array) => Int16Array.from(f, (x) => Math.round(x * 32767));

/**
 * A kit shaped like the packs HO[LO] plays: velocity layers, round robins, a choke group, a key's
 * limit, stereo and mono samples, 16-bit and float, and a hit on three microphones.
 */
function fixtureKit(extra: Partial<SamplerSpec> = {}): SamplerSpec {
  const zones: SampleZone[] = [];
  const z = (
    key: number,
    lovel: number,
    hivel: number,
    rr: number,
    left: SampleZone['left'],
    more: Partial<SampleZone> = {},
  ) =>
    zones.push({
      left,
      right: null,
      root: key,
      lo: key,
      hi: key,
      lovel,
      hivel,
      gain: 1,
      loopStart: 0,
      loopEnd: 0,
      rr,
      ...more,
    });
  // a kick: two layers, two takes each, stereo floats
  for (const [lo, hi, lvl] of [
    [1, 80, 0.4],
    [81, 127, 0.9],
  ] as const)
    for (const rr of [1, 2])
      z(36, lo, hi, rr, burst(36 * rr + lo, 9000, 2400, lvl), {
        right: burst(37 * rr + lo, 9000, 2300, lvl),
        gain: 0.8,
      });
  // a snare on three microphones (close mono 16-bit, overheads stereo, room mono), two takes
  for (const rr of [1, 2]) {
    z(38, 1, 127, rr, pcm(burst(380 + rr, 7000, 1500, 0.7)), { mic: 'close' });
    z(38, 1, 127, rr, burst(390 + rr, 7000, 1900, 0.3), { mic: 'oh', right: burst(395 + rr, 7000, 1800, 0.3) });
    z(38, 1, 127, rr, burst(400 + rr, 9000, 3200, 0.2), { mic: 'room', pan: -0.4 });
  }
  // the hi-hats: the closed one chokes the open one
  z(42, 1, 127, 0, pcm(burst(42, 3000, 400, 0.5)), { group: 1, mic: 'oh' });
  z(46, 1, 127, 0, burst(46, 20000, 6000, 0.5), { offBy: 1, mic: 'oh', gain: 0.7 });
  // a tom with a zone pan of its own, and a crash that rings long
  z(45, 1, 127, 0, burst(45, 12000, 3000, 0.6), { pan: 0.35, mic: 'close' });
  z(49, 1, 127, 0, burst(49, 40000, 12000, 0.4), { mic: 'oh', right: burst(50, 40000, 11000, 0.4) });
  return {
    key: 'fixture/kit',
    zones,
    release: 0.05,
    oneShot: true,
    pitched: false,
    velocityRange: 28,
    attack: 0,
    notePolyphony: 3,
    offTime: 0.02,
    mics: [
      { id: 'close', name: 'Close' },
      { id: 'oh', name: 'Overheads', level: -2 },
      { id: 'room', name: 'Room', level: -6, pan: 0.2 },
    ],
    ...extra,
  };
}

/** What the kit plays: [frame, key, velocity] (velocity 0: let go), and knobs turned on the way. */
const PATTERN: [number, number, number][] = [];
for (let i = 0; i < 64; i++) {
  const at = i * 5512;
  PATTERN.push([at, i % 4 === 0 ? 36 : i % 4 === 2 ? 38 : 42, 30 + ((i * 37) % 98)]);
  if (i % 8 === 7) PATTERN.push([at + 2756, 46, 100]);
  if (i % 16 === 5) for (let k = 0; k < 5; k++) PATTERN.push([at + 1000 + k * 600, 38, 50 + k * 15]);
  if (i % 12 === 3) PATTERN.push([at + 300, 45, 90]);
  if (i % 32 === 0) PATTERN.push([at + 40, 49, 120]);
  PATTERN.push([at + 2000, 36, 0]);
}
PATTERN.sort((a, b) => a[0] - b[0]);
const KNOBS: [number, Record<string, number>][] = [
  [100000, { tune: -1.5 }],
  [200000, { tune: 2, decay: 55, 'mic:room': -12 }],
  [300000, { 'mic:oh': 3, 'mic:close': -3 }],
];

/** The kit played through the pattern, in blocks as the engine plays it: both sides, one after the other. */
function play(spec: SamplerSpec, params?: Record<string, number>, knobs = KNOBS): Float32Array {
  const s = new Sampler(SR, spec, params);
  const frames = 64 * 5512 + SR;
  const l = new Float32Array(frames);
  const r = new Float32Array(frames);
  let next = 0;
  let knob = 0;
  for (let f = 0; f < frames; f += 128) {
    const end = Math.min(frames, f + 128);
    while (knob < knobs.length && (knobs[knob] as [number, Record<string, number>])[0] < end) {
      s.update({ ...params, ...(knobs[knob] as [number, Record<string, number>])[1] });
      knob++;
    }
    let at = f;
    while (next < PATTERN.length && (PATTERN[next] as [number, number, number])[0] < end) {
      const [frame, key, vel] = PATTERN[next] as [number, number, number];
      if (frame > at) s.render(l, r, at, frame);
      at = Math.max(at, frame);
      if (vel > 0) s.noteOn(key, vel);
      else s.noteOff(key);
      next++;
    }
    s.render(l, r, at, end);
  }
  const out = new Float32Array(frames * 2);
  out.set(l, 0);
  out.set(r, frames);
  return out;
}

const fingerprint = (a: Float32Array) =>
  createHash('sha256')
    .update(Buffer.from(a.buffer, a.byteOffset, a.byteLength))
    .digest('hex')
    .slice(0, 16);

/** The fixture kit's sound before pads had settings: every sample of both sides, by the sampler as it was. */
const BEFORE = '780b8b8c54acb689';

describe('kit pads', () => {
  it('leave a kit without pad settings sounding exactly as before', () => {
    expect(fingerprint(play(fixtureKit()))).toBe(BEFORE);
  });

  it('leave it so with pads named but set to nothing, or set by the song to what they are', () => {
    const pads = [{ key: 36 }, { key: 38 }, { key: 42 }, { key: 46 }];
    expect(fingerprint(play(fixtureKit({ pads })))).toBe(BEFORE);
    // every setting at its own default, as a window that was opened and put back leaves them
    const defaults: Record<string, number> = {};
    for (const key of [36, 38, 42, 45, 46, 49])
      Object.assign(defaults, {
        [padParam(key, 'level')]: 0,
        [padParam(key, 'tune')]: 0,
        [padParam(key, 'pan')]: 0,
        [padParam(key, 'drive')]: 0,
        [padParam(key, 'output')]: -6,
        [padParam(key, 'curve')]: 0,
        [padParam(key, 'range')]: 28,
        [padParam(key, 'pitchEnv')]: 0,
        [padParam(key, 'filter')]: 0,
        [padParam(key, 'cutoff')]: 500,
        [padParam(key, 'play')]: 0,
      });
    expect(fingerprint(play(fixtureKit({ pads }), defaults))).toBe(BEFORE);
    // and a song's knob putting back what a pack set
    const set = fixtureKit({ pads: [{ key: 38, drive: 60, level: -3 }] });
    expect(fingerprint(play(set, { [padParam(38, 'drive')]: 0, [padParam(38, 'level')]: 0 }))).toBe(BEFORE);
    expect(fingerprint(play(set))).not.toBe(BEFORE);
  });
});

describe('a pad', () => {
  /** A zone of `left` (and `right`) on key 60, full level. */
  const zone = (left: SampleZone['left'], extra: Partial<SampleZone> = {}): SampleZone => ({
    left,
    right: null,
    root: 60,
    lo: 0,
    hi: 127,
    lovel: 1,
    hivel: 127,
    gain: 1,
    loopStart: 0,
    loopEnd: 0,
    rr: 0,
    ...extra,
  });
  const kit = (zones: SampleZone[], extra: Partial<SamplerSpec> = {}): SamplerSpec => ({
    key: 'pad',
    zones,
    release: 0.01,
    oneShot: true,
    pitched: false,
    velocityRange: 20,
    attack: 0,
    ...extra,
  });
  /** One hit of key 60 at `velocity`, its first `frames` on both sides. */
  const hit = (spec: SamplerSpec, params: Record<string, number>, frames: number, velocity = 127) => {
    const s = new Sampler(SR, spec, params);
    s.noteOn(60, velocity);
    const l = new Float32Array(frames);
    const r = new Float32Array(frames);
    for (let f = 0; f < frames; f += 128) s.render(l, r, f, Math.min(frames, f + 128));
    return { l, r, s };
  };
  /** A sample whose frames step evenly from -1.2 to 1.2 (every input level the saturator meets, and over). */
  const ramp = Float32Array.from({ length: 2401 }, (_, i) => -1.2 + i / 1000);

  it('saturates each sample as the curve has it, soft or hard, mixed in or driven', () => {
    const cases: [number, number][] = [
      [14.0625, 0],
      [25, 0],
      [40.625, 0],
      [100, 0],
      [10, 1],
      [60, 1],
    ];
    for (const [drive, character] of cases) {
      const p = { [padParam(60, 'drive')]: drive, [padParam(60, 'character')]: character };
      const { l, r } = hit(kit([zone(ramp)]), p, 2300);
      for (let i = 0; i < 2300; i += 7) {
        const want = saturate(ramp[i] as number, drive / 25, character === 1);
        expect(l[i], `${drive}% ${character ? 'hard' : 'soft'} at ${ramp[i]}`).toBeCloseTo(want, 6);
        expect(r[i]).toBeCloseTo(want, 6);
      }
    }
  });

  it("saturates a 16-bit sample at full scale and at its zone's level, then sets the output", () => {
    const half = Int16Array.from({ length: 512 }, () => 16384);
    const p = { [padParam(60, 'drive')]: 50, [padParam(60, 'output')]: -6.0206 };
    // into the curve at 0.5 × 0.8: 2 × 0.4 = 0.8 → 2(0.8) - 0.64 = 0.96; out at half
    const { l } = hit(kit([zone(half, { gain: 0.8 })]), p, 256);
    expect(l[100]).toBeCloseTo(0.48, 5);
  });

  it('sets each velocity on its curve: decibels with a range, cubic or linear with an intensity', () => {
    const one = new Float32Array(512).fill(0.5);
    const at = (p: Record<string, number>, v: number) => hit(kit([zone(one)]), p, 256, v).l[100] as number;
    const curve = (c: number, more: Record<string, number> = {}) => ({ [padParam(60, 'curve')]: c, ...more });
    // the kit's own: 20 dB from 1 to 127
    expect(at({}, 1)).toBeCloseTo(0.05, 5);
    expect(at(curve(0, { [padParam(60, 'range')]: 40 }), 1)).toBeCloseTo(0.005, 6);
    expect(at(curve(1), 64)).toBeCloseTo(0.5 * (64 / 127) ** 3, 6);
    expect(at(curve(1, { [padParam(60, 'intensity')]: 50 }), 64)).toBeCloseTo(0.5 * (1 - (1 - 64 / 127) / 2) ** 3, 6);
    expect(at(curve(2, { [padParam(60, 'intensity')]: 50 }), 1)).toBeCloseTo(0.5 * (1 - (1 - 1 / 127) / 2), 6);
    expect(at(curve(1), 127)).toBeCloseTo(0.5, 6);
    // the gain is the hit's, after the saturator: a soft hit is saturated as hard as a loud one, then quieter
    const sat = { [padParam(60, 'drive')]: 50, ...curve(1) };
    expect(at(sat, 64)).toBeCloseTo(saturate(0.5, 2, false) * (64 / 127) ** 3, 6);
  });

  it('sets its level, its tune and its place', () => {
    const one = new Float32Array(4000).fill(0.5);
    const level = hit(kit([zone(one)]), { [padParam(60, 'level')]: -6.0206 }, 256).l[100] as number;
    expect(level).toBeCloseTo(0.25, 5);
    expect(hit(kit([zone(one)]), { [padParam(60, 'level')]: -60 }, 256).l[100]).toBe(0);
    // an octave down plays the sample at half speed: twice as long
    const long = (p: Record<string, number>) => {
      const { l } = hit(kit([zone(one)]), p, 10000);
      return l.indexOf(0);
    };
    expect(long({ [padParam(60, 'tune')]: -12 })).toBeGreaterThan(1.98 * long({}));
    // a stereo sample balanced, a mono one at constant power
    const stereo = hit(kit([zone(one, { right: one })]), { [padParam(60, 'pan')]: 0.5 }, 256);
    expect([stereo.l[100], stereo.r[100]]).toEqual([0.25, 0.5]);
    const mono = hit(kit([zone(one)]), { [padParam(60, 'pan')]: -1 }, 256);
    expect(mono.l[100]).toBeCloseTo(0.5 * Math.SQRT2, 6);
    expect(mono.r[100]).toBeCloseTo(0, 6);
  });

  it('plays to its end or stops when let go, whatever the kit does', () => {
    const one = new Float32Array(SR).fill(0.5);
    const after = (spec: SamplerSpec, p: Record<string, number>) => {
      const s = new Sampler(SR, spec, p);
      s.noteOn(60, 127);
      const l = new Float32Array(4096);
      s.render(l, new Float32Array(4096), 0, 1024);
      s.noteOff(60);
      s.render(l, new Float32Array(4096), 1024, 4096);
      return l[4000] as number;
    };
    const gated = { [padParam(60, 'play')]: 1 };
    const oneShot = { [padParam(60, 'play')]: 0 };
    expect(after(kit([zone(one)]), {})).toBe(0.5);
    expect(after(kit([zone(one)]), gated)).toBeLessThan(1e-3);
    expect(after(kit([zone(one)], { oneShot: false }), {})).toBeLessThan(1e-3);
    expect(after(kit([zone(one)], { oneShot: false }), oneShot)).toBe(0.5);
    // another key is the kit's
    const s = new Sampler(SR, kit([zone(one)]), { [padParam(61, 'play')]: 1 });
    s.noteOn(60, 127);
    s.noteOff(60);
    const l = new Float32Array(2048);
    s.render(l, new Float32Array(2048), 0, 2048);
    expect(l[2000]).toBe(0.5);
  });

  it('starts away from its pitch and falls to it over its decay', () => {
    // the sample's value is where it's read: the read speed is the pitch
    const at = Float32Array.from({ length: 40000 }, (_, i) => i / 40000);
    const p = { [padParam(60, 'pitchEnv')]: 12, [padParam(60, 'pitchDecay')]: 0.05 };
    const { l } = hit(kit([zone(at)]), p, 8000);
    const speed = (a: Float32Array, i: number) => ((a[i + 1] as number) - (a[i] as number)) * 40000;
    // an octave up to start with, falling (69 dB over the decay) to the pad's own pitch
    const left = (i: number) => Math.exp((-6.9 * i) / (0.05 * SR));
    expect(speed(l, 1)).toBeCloseTo(2, 2);
    expect(speed(l, 300)).toBeCloseTo(2 ** left(300), 3);
    // a decay later it's there (and stays)
    expect(speed(l, Math.round(0.05 * SR) + 50)).toBeCloseTo(1, 3);
    expect(speed(l, 7000)).toBeCloseTo(1, 3);
    // down, as well
    const down = hit(kit([zone(at)]), { ...p, [padParam(60, 'pitchEnv')]: -12 }, 400).l;
    expect(speed(down, 20)).toBeCloseTo(2 ** -left(20), 3);
    expect(speed(down, 20)).toBeLessThan(0.53);
  });

  it('filters each hit, low or high, the softest hits darker by its velocity amount', () => {
    // white noise, the same each time
    let s = 7;
    const noise = Float32Array.from({ length: 20000 }, () => {
      s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
      return (s / 2 ** 32 - 0.5) * 0.5;
    });
    /** How much changes from frame to frame (the top of the spectrum), against the level. */
    const bright = (a: Float32Array) => {
      let d = 0;
      let e = 0;
      for (let i = 1000; i < 15000; i++) {
        d += ((a[i] as number) - (a[i - 1] as number)) ** 2;
        e += (a[i] as number) ** 2;
      }
      return d / e;
    };
    const lp = (more: Record<string, number> = {}, v = 127) =>
      hit(kit([zone(noise)]), { [padParam(60, 'filter')]: 1, [padParam(60, 'cutoff')]: 1000, ...more }, 16000, v).l;
    const plain = bright(hit(kit([zone(noise)]), {}, 16000).l);
    expect(bright(lp())).toBeLessThan(plain / 20);
    const vel = { [padParam(60, 'filterVelocity')]: 100 };
    expect(bright(lp(vel, 32))).toBeLessThan(bright(lp(vel, 127)) / 4);
    expect(bright(lp(vel, 127))).toBeCloseTo(bright(lp()), 6);
    // resonance lifts the cutoff: a ringing tone where there was none
    expect(Math.max(...lp({ [padParam(60, 'resonance')]: 95 }).map(Math.abs))).toBeGreaterThan(
      Math.max(...lp().map(Math.abs)),
    );
    // a high-pass lets a steady level through for no time at all
    const dc = hit(
      kit([zone(new Float32Array(8000).fill(0.5))]),
      { [padParam(60, 'filter')]: 2, [padParam(60, 'cutoff')]: 200 },
      6000,
    ).l;
    expect(Math.abs(dc[5000] as number)).toBeLessThan(1e-3);
    expect(
      bright(hit(kit([zone(noise)]), { [padParam(60, 'filter')]: 2, [padParam(60, 'cutoff')]: 5000 }, 16000).l),
    ).toBeGreaterThan(plain);
  });

  it("works on every microphone of a hit, at each one's level", () => {
    const one = new Float32Array(2000).fill(0.5);
    const spec = kit([zone(one, { mic: 'a' }), zone(one, { mic: 'b' })], {
      mics: [
        { id: 'a', name: 'A' },
        { id: 'b', name: 'B', level: -6.0206 },
      ],
    });
    const { l } = hit(spec, { [padParam(60, 'drive')]: 50 }, 512);
    expect(l[300]).toBeCloseTo(saturate(0.5, 2, false) * 1.5, 5);
  });

  it('turns with the song, the hits after a change taking it', () => {
    const one = new Float32Array(SR).fill(0.5);
    const s = new Sampler(SR, kit([zone(one)], { pads: [{ key: 60, level: -6.0206 }] }));
    const l = new Float32Array(2048);
    const r = new Float32Array(2048);
    s.noteOn(60, 127);
    s.render(l, r, 0, 512);
    expect(l[100]).toBeCloseTo(0.25, 5);
    s.update({ [padParam(60, 'level')]: 0 });
    s.noteOn(60, 127);
    s.render(l, r, 512, 1024);
    // the first hit as it was, the second at the new level
    expect(l[1000]).toBeCloseTo(0.75, 5);
  });
});

describe('a pack pad', () => {
  it('reaches the sampler only with settings of its own, each valid', () => {
    const extras = playingExtras({
      pads: [
        { key: 36, name: 'Kick' },
        { key: 38, name: 'Snare', drive: 40, character: 'hard', curve: 'cubic', play: 'gated' },
        { key: 42, name: 'Hi-hat closed', level: 99, filter: 'bandpass' as never },
      ],
    });
    expect(extras.pads).toEqual([
      { key: 38, drive: 40, character: 'hard', curve: 'cubic', play: 'gated' },
      { key: 42, level: 12 },
    ]);
    expect(playingExtras({ pads: [{ key: 36, name: 'Kick' }] }).pads).toBeUndefined();
  });
});
