import { newProject, newTrack } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { compileGraph, compileTempo } from '../src/compile.ts';
import { EngineCore } from '../src/core.ts';
import { GlassLineVoice, GlassVoice, planGlass, planGlassLine } from '../src/glass.ts';
import { type PerfInstrument, PlanVoice, planPart, type SampleData } from '../src/performance.ts';
import type { SamplerSpec, SampleZone } from '../src/protocol.ts';
import { Sampler } from '../src/sampler.ts';

const SR = 44100;

const same = (a: Float32Array, b: Float32Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/** A voice played from its start, and another joined late by skip(): the same samples from where they overlap. */
function lateJoin<
  V extends {
    done: boolean;
    render(l: Float32Array, r: Float32Array, from: number, to: number, offset?: number): boolean;
  },
>(make: () => V, at: number, late: number, n: number): [Float32Array, Float32Array] {
  const play = (from: number) => {
    const v = make();
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let f = from; f < n && !v.done; f += 128) v.render(L, R, f, Math.min(n, f + 128), f);
    return L;
  };
  const whole = play(Math.max(0, at));
  const joined = play(Math.max(0, at) + late);
  return [whole.subarray(Math.max(0, at) + late), joined.subarray(Math.max(0, at) + late)];
}

describe('a planned voice joined late', () => {
  it('glass sounds as it would have, breath and all', () => {
    const notes = [
      { t: 0.1, d: 2, p: 64, v: 0.6 },
      { t: 0.4, d: 1, p: 71, v: 0.4, x: { pan: 0.3 } },
    ];
    for (const o of [{ seed: 3 }, { seed: 4, breath: 0 }]) {
      for (const p of planGlass(notes, o, SR)) {
        const [a, b] = lateJoin(() => new GlassVoice(p, SR), p.at, 7001, SR * 3);
        expect(same(a, b)).toBe(true);
        expect(a.some((x) => x !== 0)).toBe(true);
      }
    }
  });

  it('a glass line sounds as it would have, through its glides', () => {
    const notes = [
      { t: 0, d: 0.5, p: 60, v: 0.5 },
      { t: 0.5, d: 0.5, p: 64, v: 0.7 },
      { t: 1.0, d: 0.8, p: 67, v: 0.6 },
    ];
    for (const p of planGlassLine(notes, { seed: 5 }, SR)) {
      const [a, b] = lateJoin(() => new GlassLineVoice(p, SR), p.at, 30011, SR * 3);
      expect(same(a, b)).toBe(true);
      expect(a.some((x) => x !== 0)).toBe(true);
    }
  });

  it('a performance note sounds as it would have, read straight or through a glide', () => {
    const n = SR * 2;
    const make = (f: number): SampleData => {
      const l = new Float32Array(n);
      for (let i = 0; i < n; i++) l[i] = Math.sin((2 * Math.PI * f * i) / SR) * 0.5 * Math.min(1, i / 200);
      return [l, l.slice()];
    };
    const row = (sample: number, midi: number) => ({
      sample,
      midi,
      layer: 1,
      start: 0,
      attack: 300,
      frames: n,
      tune: 0,
      gainDb: 0,
      loopStart: SR / 2,
      loopEnd: SR + SR / 2,
      loopRho: 0.95,
    });
    const inst: PerfInstrument = {
      name: 'test_sus',
      kind: 'sus',
      release: 0.4,
      lag: 0,
      maxLead: 0.06,
      legatoSkip: 0.16,
      xfade: 0.16,
      pan: 0,
      width: 0.8,
      maxAttack: 0,
      rows: [row(0, 60), row(1, 67)],
    };
    const data = [make(261.63), make(392)];
    // a copied read, an interpolated one that needs its loop, and a vibrato's glide
    const notes = [
      { t: 0.1, d: 0.5, p: 60, v: 0.6 },
      { t: 0.7, d: 3.5, p: 62, v: 0.5, x: { legato: false } },
      { t: 0.2, d: 1.5, p: 65, v: 0.7, x: { vib: { depth: 0.3, rate: 5 } } },
    ];
    const plans = planPart(inst, notes, { seed: 4, gainDb: 0, shape: { swell: 0.2, taper: 1, attack: 0.2 } }, SR);
    expect(plans.some((p) => p.copy)).toBe(true);
    expect(plans.some((p) => p.extend)).toBe(true);
    expect(plans.some((p) => p.glide)).toBe(true);
    for (const p of plans) {
      const [a, b] = lateJoin(() => new PlanVoice(p, data[p.row.sample] as SampleData, SR), p.at, 12345, SR * 5);
      expect(same(a, b)).toBe(true);
      expect(a.some((x) => x !== 0)).toBe(true);
    }
  });
});

describe('the sampler', () => {
  const zone = (lo: number, hi: number, lovel: number, hivel: number, mark: number): SampleZone => {
    // each zone's first sample says which it is
    const left = new Float32Array(64);
    left[1] = mark;
    return { left, right: null, root: 60, lo, hi, lovel, hivel, gain: 1, loopStart: 0, loopEnd: 0, rr: 0 };
  };
  const spec: SamplerSpec = {
    key: 't',
    zones: [zone(0, 64, 1, 127, 0.1), zone(0, 64, 1, 127, 0.2), zone(0, 64, 1, 127, 0.3), zone(65, 127, 1, 127, 0.4)],
    release: 0.05,
    oneShot: true,
    pitched: false,
    velocityRange: 0,
    attack: 0,
  };
  const played = (s: Sampler, key: number) => {
    s.noteOn(key, 127);
    const l = new Float32Array(4);
    const r = new Float32Array(4);
    s.render(l, r, 0, 4);
    s.allNotesOff(true);
    for (let i = 0; i < 64; i++) s.render(new Float32Array(4), new Float32Array(4), 0, 4);
    return Math.round((l[1] as number) * 10) / 10;
  };
  it('takes tied zones in turn, and the one zone that fits otherwise', () => {
    const s = new Sampler(SR, spec);
    expect([60, 60, 60, 60, 61].map((k) => played(s, k))).toEqual([0.1, 0.2, 0.3, 0.1, 0.2]);
    expect(played(s, 80)).toBe(0.4);
    expect(played(s, 80)).toBe(0.4);
  });
});

describe('the sampler, played', () => {
  /** A steady tone of `level` (so a fade shows as the level falling), 2 s long. */
  const tone = (level: number, extra: Partial<SampleZone> = {}): SampleZone => ({
    left: new Float32Array(SR * 2).fill(level),
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
  const base = (zones: SampleZone[], extra: Partial<SamplerSpec> = {}): SamplerSpec => ({
    key: 't',
    zones,
    release: 0.05,
    oneShot: false,
    pitched: false,
    velocityRange: 0,
    attack: 0,
    ...extra,
  });
  /** The level `frames` from now (the mix of every voice), rendering up to it. */
  const level = (s: Sampler, frames: number) => {
    const l = new Float32Array(frames);
    s.render(l, new Float32Array(frames), 0, frames);
    return l[frames - 1] as number;
  };

  it('chokes the open hi-hat when the closed one is struck', () => {
    const open = tone(0.5, { lo: 46, hi: 46, offBy: 1 });
    const closed = tone(0.25, { lo: 42, hi: 42, group: 1 });
    const s = new Sampler(SR, base([open, closed], { oneShot: true, offTime: 0.01 }));
    s.noteOn(46, 127);
    expect(level(s, 64)).toBeCloseTo(0.5, 5);
    s.noteOn(42, 127);
    // 30 ms on, the open hat has gone and the closed one is all there is
    expect(level(s, Math.round(SR * 0.03))).toBeCloseTo(0.25, 2);
    // without the group, both ring
    const t = new Sampler(SR, base([tone(0.5, { lo: 46, hi: 46 }), tone(0.25, { lo: 42, hi: 42 })], { oneShot: true }));
    t.noteOn(46, 127);
    t.noteOn(42, 127);
    expect(level(t, Math.round(SR * 0.03))).toBeCloseTo(0.75, 5);
  });

  it('fades the oldest of a key struck past its limit', () => {
    const s = new Sampler(SR, base([tone(0.1)], { oneShot: true, notePolyphony: 2, offTime: 0.01 }));
    s.noteOn(60, 127);
    s.noteOn(60, 127);
    expect(level(s, 64)).toBeCloseTo(0.2, 5);
    s.noteOn(60, 127);
    expect(level(s, Math.round(SR * 0.03))).toBeCloseTo(0.2, 3);
    // another key is its own
    s.noteOn(61, 127);
    expect(level(s, 64)).toBeCloseTo(0.3, 3);
  });

  it('holds a note on a loop that is the whole sample: every frame a number, sounding pass after pass', () => {
    // 44 cycles of a 441 Hz sine (100 frames each, so the loop is seamless), looped from its first frame to its last
    const n = 4400;
    const sine = new Float32Array(n);
    for (let i = 0; i < n; i++) sine[i] = 0.5 * Math.sin((2 * Math.PI * 441 * i) / SR);
    const whole = (extra: Partial<SampleZone> = {}) => tone(0, { left: sine, loopStart: 0, loopEnd: n, ...extra });
    const mics = [
      { id: 'a', name: 'A' },
      { id: 'b', name: 'B' },
    ];
    const cases: [string, SampleZone[], Partial<SamplerSpec>, number][] = [
      // one sample (read alone), at its own pitch and between its frames
      ['alone', [whole()], {}, 60],
      ['alone, transposed', [whole()], { pitched: true }, 67],
      // two microphones of it (read under one envelope)
      ['microphones', [whole({ mic: 'a' }), whole({ mic: 'b' })], { mics, pitched: true }, 67],
    ];
    for (const [name, zones, extra, key] of cases) {
      const s = new Sampler(SR, base(zones, extra));
      s.noteOn(key, 127);
      // a second: ten times around the loop and more
      const l = new Float32Array(SR);
      const r = new Float32Array(SR);
      for (let f = 0; f < SR; f += 128) s.render(l, r, f, Math.min(SR, f + 128));
      expect(l.every(Number.isFinite), `${name}: every frame a number`).toBe(true);
      const peak = (a: Float32Array) => a.reduce((p, x) => Math.max(p, Math.abs(x)), 0);
      const first = peak(l.subarray(0, n));
      expect(first, `${name}: it sounds`).toBeGreaterThan(0.4);
      // still sounding on its last pass, as loud as on its first
      expect(peak(l.subarray(SR - n)), `${name}: it goes on`).toBeCloseTo(first, 2);
      // and no step at the seam bigger than the sine's own steepest
      const ratio = 2 ** ((key - 60) / 12);
      const steepest = (first * 2 * Math.PI * 441 * ratio) / SR;
      let step = 0;
      for (let i = 1; i < SR; i++) step = Math.max(step, Math.abs((l[i] as number) - (l[i - 1] as number)));
      expect(step, `${name}: no click at the seam`).toBeLessThan(steepest * 1.1);
    }
  });

  it('plays the release sample when a note is let go, quieter the longer it was held', () => {
    const struck = tone(0.5);
    const rel = tone(0.2, { trigger: 'release' });
    const spec = base([struck, rel], { release: 0.005, releaseDecay: 6 });
    const s = new Sampler(SR, spec);
    s.noteOn(60, 127);
    expect(level(s, 64)).toBeCloseTo(0.5, 5);
    s.noteOff(60);
    // the note has faded; its release sample plays, from a note held 64 frames (all but its full level)
    expect(level(s, Math.round(SR * 0.1))).toBeCloseTo(0.2, 2);
    const t = new Sampler(SR, spec);
    t.noteOn(60, 127);
    level(t, SR); // held a second: 6 dB down
    t.noteOff(60);
    expect(level(t, Math.round(SR * 0.1))).toBeCloseTo(0.2 / 10 ** (6 / 20), 2);
  });

  it('holds the release sample for the pedal, and leaves strings without dampers ringing', () => {
    const rel = { ...tone(0.2, { trigger: 'release' }), left: new Float32Array(Math.round(SR * 0.2)).fill(0.2) };
    const s = new Sampler(SR, base([tone(0.5), rel], { release: 0.005, undamped: 90 }));
    s.cc(64, 127);
    s.noteOn(60, 127);
    s.noteOff(60);
    expect(level(s, Math.round(SR * 0.05))).toBeCloseTo(0.5, 5);
    s.cc(64, 0);
    expect(level(s, Math.round(SR * 0.1))).toBeCloseTo(0.2, 2);
    level(s, Math.round(SR * 0.2));
    // a top string rings on through note-off, and drops no damper
    s.noteOn(96, 127);
    s.noteOff(96);
    expect(level(s, Math.round(SR * 0.6))).toBeCloseTo(0.5, 2);
  });

  it('plays one release sample of each part, each by its own decay', () => {
    const short = (level: number, extra: Partial<SampleZone>) => ({
      ...tone(level, extra),
      left: new Float32Array(Math.round(SR * 0.5)).fill(level),
    });
    // the key coming back (part 1, no decay) and the string's ring-off (part 0, 20 dB a second)
    const s = new Sampler(
      SR,
      base(
        [
          tone(0.5),
          short(0.1, { trigger: 'release', decay: 20 }),
          short(0.05, { trigger: 'release', part: 1, decay: 0 }),
        ],
        {
          release: 0.005,
        },
      ),
    );
    s.noteOn(60, 127);
    level(s, SR); // held a second
    s.noteOff(60);
    expect(level(s, Math.round(SR * 0.1))).toBeCloseTo(0.05 + 0.01, 3);
  });

  it('sounds the pedal going down and coming up, once each way', () => {
    const blip = (level: number, trigger: 'pedalDown' | 'pedalUp') => ({
      ...tone(level, { trigger }),
      left: new Float32Array(Math.round(SR * 0.1)).fill(level),
    });
    const s = new Sampler(SR, base([tone(0.5), blip(0.01, 'pedalDown'), blip(0.02, 'pedalUp')]));
    s.cc(64, 127);
    expect(level(s, 64)).toBeCloseTo(0.01, 5);
    s.cc(64, 120); // still down: nothing new
    expect(level(s, 64)).toBeCloseTo(0.01, 5);
    level(s, SR * 0.2);
    s.cc(64, 0);
    expect(level(s, 64)).toBeCloseTo(0.02, 5);
  });
});

describe('the sampler, with microphones', () => {
  /** A steady level on one microphone (a fade shows as the level falling), 1 s long unless said. */
  const take = (key: number, mic: string, rr: number, level: number, extra: Partial<SampleZone> = {}): SampleZone => ({
    left: new Float32Array(SR).fill(level),
    right: null,
    root: key,
    lo: key,
    hi: key,
    lovel: 1,
    hivel: 127,
    gain: 1,
    loopStart: 0,
    loopEnd: 0,
    rr,
    mic,
    ...extra,
  });
  const mics = [
    { id: 'close', name: 'Close' },
    { id: 'oh', name: 'Overheads' },
    { id: 'room', name: 'Room' },
  ];
  const kit = (zones: SampleZone[], extra: Partial<SamplerSpec> = {}): SamplerSpec => ({
    key: 'kit',
    zones,
    release: 0.05,
    oneShot: true,
    pitched: false,
    velocityRange: 0,
    attack: 0,
    mics,
    ...extra,
  });
  /** A snare's two takes on three microphones, each its own level (the overheads' listed the other way around). */
  const snare = [
    take(38, 'close', 1, 0.1),
    take(38, 'close', 2, 0.2),
    take(38, 'oh', 2, 0.02),
    take(38, 'oh', 1, 0.01),
    take(38, 'room', 1, 0.001),
    take(38, 'room', 2, 0.002),
  ];
  /** Both sides `frames` from now (the mix of every voice), rendering up to it. */
  const sides = (s: Sampler, frames: number): [number, number] => {
    const l = new Float32Array(frames);
    const r = new Float32Array(frames);
    s.render(l, r, 0, frames);
    return [l[frames - 1] as number, r[frames - 1] as number];
  };
  const level = (s: Sampler, frames: number) => sides(s, frames)[0];
  const hit = (s: Sampler, key: number) => {
    s.noteOn(key, 127);
    const v = level(s, 64);
    s.allNotesOff(true);
    level(s, SR / 10);
    return Math.round(v * 1e6) / 1e6;
  };

  it('sounds every microphone of a hit together, one round robin for them all', () => {
    const s = new Sampler(SR, kit(snare));
    expect([hit(s, 38), hit(s, 38), hit(s, 38)]).toEqual([0.111, 0.222, 0.111]);
    // the hit is one voice
    s.noteOn(38, 127);
    expect(s.active).toBe(1);
  });

  it("sounds only the microphones that have the piece, never another piece's", () => {
    const kick = take(36, 'close', 1, 0.5);
    const s = new Sampler(SR, kit([kick, ...snare.filter((z) => z.rr === 1 && z.mic !== 'close')]));
    // the snare isn't on the close microphone (it has only the kick): the kick doesn't sound for it
    expect(hit(s, 38)).toBe(0.011);
    expect(hit(s, 36)).toBe(0.5);
  });

  it('turns each microphone to its level as it plays, and starts where its knob is', () => {
    const one = snare.filter((z) => z.rr === 1);
    const s = new Sampler(SR, kit(one, { mics: [...mics.slice(0, 2), { id: 'room', name: 'Room', level: -60 }] }));
    // the room starts off
    expect(hit(s, 38)).toBe(0.11);
    s.update({ 'mic:room': 0, 'mic:close': -60 });
    expect(hit(s, 38)).toBe(0.011);
    // a sounding hit glides to a new level within a block
    s.noteOn(38, 127);
    expect(level(s, 64)).toBeCloseTo(0.011, 6);
    s.update({ 'mic:room': 0, 'mic:close': 0, 'mic:oh': -6.0206 });
    expect(level(s, 128)).toBeCloseTo(0.1 + 0.005 + 0.001, 5);
  });

  it("places a mono microphone by its pan, a zone's own pan first", () => {
    const close = take(38, 'close', 1, 0.1);
    const s = new Sampler(SR, kit([close], { mics: [{ id: 'close', name: 'Close', pan: 1 }] }));
    s.noteOn(38, 127);
    const [l, r] = sides(s, 64);
    expect(l).toBeCloseTo(0, 6);
    expect(r).toBeCloseTo(0.1 * Math.SQRT2, 6);
    const t = new Sampler(SR, kit([{ ...close, pan: -1 }], { mics: [{ id: 'close', name: 'Close', pan: 1 }] }));
    t.noteOn(38, 127);
    const [l2, r2] = sides(t, 64);
    expect(l2).toBeCloseTo(0.1 * Math.SQRT2, 6);
    expect(r2).toBeCloseTo(0, 6);
  });

  it('chokes every microphone of the open hi-hat when the closed one is struck', () => {
    const open = [take(46, 'close', 1, 0.5, { offBy: 1 }), take(46, 'oh', 1, 0.05, { offBy: 1 })];
    const closed = [take(42, 'close', 1, 0.2, { group: 1 }), take(42, 'oh', 1, 0.02, { group: 1 })];
    const s = new Sampler(SR, kit([...open, ...closed], { offTime: 0.01 }));
    s.noteOn(46, 127);
    expect(level(s, 64)).toBeCloseTo(0.55, 5);
    s.noteOn(42, 127);
    expect(level(s, Math.round(SR * 0.03))).toBeCloseTo(0.22, 2);
  });

  it("counts hits, not microphones, against a key's limit and the polyphony", () => {
    const two = snare.filter((z) => z.rr === 1 && z.mic !== 'room');
    const s = new Sampler(SR, kit(two, { notePolyphony: 2, offTime: 0.01 }));
    s.noteOn(38, 127);
    s.noteOn(38, 127);
    expect(level(s, 64)).toBeCloseTo(0.22, 5);
    s.noteOn(38, 127);
    // the oldest hit (both its microphones) faded, two still ring
    expect(level(s, Math.round(SR * 0.03))).toBeCloseTo(0.22, 3);
    const t = new Sampler(SR, kit([...two, ...two.map((z) => ({ ...z, lo: 40, hi: 40, root: 40 }))], { polyphony: 2 }));
    t.noteOn(38, 127);
    t.noteOn(40, 127);
    // two hits of two microphones each: both fit
    expect(t.active).toBe(2);
    expect(level(t, 64)).toBeCloseTo(0.22, 5);
  });

  it("tunes the hits that come after its knob is turned, and keeps that much of each hit's ring", () => {
    const short = take(38, 'close', 1, 0.5, { left: new Float32Array(1000).fill(0.5) });
    const s = new Sampler(SR, kit([short], { mics: [mics[0] as (typeof mics)[number]] }));
    s.noteOn(38, 127);
    s.update({ tune: 12 });
    // the hit already sounding keeps its pitch: 1000 frames
    expect(level(s, 900)).toBeCloseTo(0.5, 5);
    level(s, 200);
    s.noteOn(38, 127);
    // an octave up, it's over in half the time
    expect(level(s, 400)).toBeCloseTo(0.5, 5);
    expect(level(s, 200)).toBe(0);

    const long = take(38, 'close', 1, 0.5);
    const d = new Sampler(SR, kit([long], { mics: [mics[0] as (typeof mics)[number]] }), { decay: 50 });
    d.noteOn(38, 127);
    // half its ring: 60 dB down by half its length, a quarter of the way it's 30 dB down
    expect(level(d, SR / 4)).toBeCloseTo(0.5 * 10 ** (-30 / 20), 3);
    level(d, SR / 2);
    expect(d.active).toBe(0);
    const whole = new Sampler(SR, kit([long], { mics: [mics[0] as (typeof mics)[number]] }));
    whole.noteOn(38, 127);
    expect(level(whole, (SR * 9) / 10)).toBeCloseTo(0.5, 5);
  });

  it('takes its knobs where it is in the engine, and is made again for another kit', () => {
    const core = new EngineCore(SR, () => undefined);
    const p = newProject('t');
    const track = newTrack('Kit', { type: 'sampler', pack: 'test', name: 'kit' });
    p.tracks = [track];
    core.receive({ type: 'sampler', spec: { ...kit(snare), key: 'test/kit' } });
    core.receive({ type: 'sampler', spec: { ...kit(snare), key: 'test/other' } });
    const send = () => core.receive({ type: 'graph', graph: compileGraph(p, () => 1, compileTempo(p, SR)) });
    const instrument = () =>
      (core as unknown as { tracks: Map<number, { instruments: unknown[] }> }).tracks.get(1)?.instruments[0];
    send();
    const first = instrument();
    expect(first).toBeInstanceOf(Sampler);
    track.instrument = { type: 'sampler', pack: 'test', name: 'kit', params: { 'mic:room': -12, decay: 60 } };
    send();
    expect(instrument()).toBe(first);
    track.instrument = { type: 'sampler', pack: 'test', name: 'other' };
    send();
    expect(instrument()).not.toBe(first);
    expect(instrument()).toBeInstanceOf(Sampler);
  });
});
