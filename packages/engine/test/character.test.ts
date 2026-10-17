import { newAudioTrack, newBus, newPlugin, newProject, newRegion, PPQ } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { prepareImpulse } from '../src/convolver.ts';
import { createEffect, type Effect, type Host } from '../src/fx.ts';
import { bandsResponse, peqBands } from '../src/peq.ts';
import { impulseFor } from '../src/space.ts';
import { generateSpace } from '../src/spaces.ts';
import { encodeWav } from '../src/wav.ts';

const SR = 44100;
const host = (extra: Partial<Host> = {}): Host => ({
  sr: SR,
  lowLatency: false,
  beatSeconds: () => 0.5,
  impulse: () => undefined,
  songFrame: () => 0,
  clip: () => undefined,
  ...extra,
});

function effect(type: string, params: Record<string, number>, h = host(), settings?: Record<string, string>): Effect {
  const e = createEffect(type, h);
  if (!e) throw new Error(type);
  e.setParams(params, settings);
  return e;
}

/** Runs a stereo signal through, 128 frames at a time. */
function through(e: Effect, l: Float32Array, r: Float32Array = l.slice()): [Float32Array, Float32Array] {
  const a = l.slice();
  const b = r.slice();
  for (let at = 0; at < a.length; at += 128) {
    const n = Math.min(128, a.length - at);
    e.process(a.subarray(at, at + n), b.subarray(at, at + n), n);
  }
  return [a, b];
}

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
};

describe('Parametric EQ', () => {
  it('sounds as its curve says (the curve is drawn from the same coefficients)', () => {
    const params = { t1: 1, f1: 80, q1: 0.7, t2: 3, f2: 1000, g2: 6, q2: 1.4, t3: 6, f3: 8000, g3: -4, q3: 0.7 };
    const e = effect('peq', params);
    for (const f of [60, 500, 1000, 3000, 12000]) {
      const n = SR;
      const x = new Float32Array(n);
      for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * f * i) / SR) * 0.1;
      e.reset();
      const [y] = through(e, x);
      const measured = 20 * Math.log10(rms(y, n / 2) / rms(x, n / 2));
      const curve = bandsResponse(peqBands(params), [f], SR)[0] as number;
      expect(Math.abs(measured - curve)).toBeLessThan(0.05);
    }
  });

  it('is transparent with every band off', () => {
    const x = new Float32Array(4096).map((_, i) => Math.sin(i * 0.05));
    const [y] = through(effect('peq', {}), x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });
});

describe('Transient Softener', () => {
  it('pulls down an attack more than the body of the note', () => {
    const n = SR;
    const x = new Float32Array(n);
    for (let i = 0; i < n; i++) x[i] = Math.sin((2 * Math.PI * 330 * i) / SR) * Math.exp(-i / SR) * 0.8;
    const [y] = through(effect('softener', { amount: 80 }), x);
    const attack = rms(y, 0, 44) / rms(x, 0, 44);
    const body = rms(y, SR / 4, SR / 2) / rms(x, SR / 4, SR / 2);
    expect(attack).toBeLessThan(0.7);
    expect(attack).toBeLessThan(body * 0.8);
  });
});

describe('Stereo Width', () => {
  const l = new Float32Array(8192).map((_, i) => Math.sin(i * 0.01));
  const r = new Float32Array(8192).map((_, i) => Math.sin(i * 0.013));
  it('makes mono at no width', () => {
    const [a, b] = through(effect('width', { width: 0 }), l, r);
    expect(Array.from(a)).toEqual(Array.from(b));
  });
  it('keeps the centre at unity and turns at constant power', () => {
    const [a, b] = through(effect('width', { position: -100 }), l, r);
    expect(rms(b)).toBeLessThan(1e-6);
    expect(rms(a) / rms(l)).toBeCloseTo(Math.SQRT2, 3);
  });
  it('eases the lows towards mono and leaves the highs', () => {
    const lo = new Float32Array(SR).map((_, i) => Math.sin((2 * Math.PI * 30 * i) / SR));
    const hi = new Float32Array(SR).map((_, i) => Math.sin((2 * Math.PI * 4000 * i) / SR));
    const [a, b] = through(
      effect('width', { mono: 1, monoFreq: 150 }),
      lo,
      lo.map((v) => -v),
    );
    // the game's way: each side less the low pass of the difference, so the side falls away below it
    expect(rms(a, SR / 2) / rms(lo, SR / 2)).toBeLessThan(0.35);
    expect(rms(b, SR / 2) / rms(lo, SR / 2)).toBeLessThan(0.35);
    const [c, d] = through(
      effect('width', { mono: 1, monoFreq: 150 }),
      hi,
      hi.map((v) => -v),
    );
    expect(rms(c, SR / 2)).toBeGreaterThan(0.69);
    expect(rms(d, SR / 2)).toBeGreaterThan(0.69);
  });
});

describe('Tape Warmth', () => {
  it('leaves a full-scale peak at full scale, and takes out the offset it adds', () => {
    const x = new Float32Array(SR).map((_, i) => Math.sin((2 * Math.PI * 100 * i) / SR));
    const [y] = through(effect('tape', { drive: 2, even: 20 }), x);
    let peak = 0;
    let mean = 0;
    for (let i = SR / 2; i < SR; i++) {
      peak = Math.max(peak, Math.abs(y[i] as number));
      mean += y[i] as number;
    }
    expect(peak).toBeLessThan(1.25);
    expect(peak).toBeGreaterThan(0.8);
    expect(Math.abs(mean / (SR / 2))).toBeLessThan(0.01);
  });

  it("takes a creation's centre away from its saturated sound (in step with its mix)", () => {
    const x = new Float32Array(SR / 10).map((_, i) => Math.sin((2 * Math.PI * 100 * i) / SR) * 0.5);
    const params = { drive: 1.4, even: 8, mix: 50, input: 0, body: 0, top: 0, dcBlock: 0 };
    const [a, b] = through(effect('tape', params), x);
    const [c, d] = through(effect('tape', params, host(), { centre: '0.01,-0.02' }), x);
    for (let i = 0; i < x.length; i += 97) {
      expect(c[i]).toBeCloseTo((a[i] as number) - 0.5 * 0.01, 6);
      expect(d[i]).toBeCloseTo((b[i] as number) + 0.5 * 0.02, 6);
    }
  });
});

describe('Wow & Flutter', () => {
  it('wobbles the pitch a little, never the level', () => {
    const x = new Float32Array(SR * 3).map((_, i) => Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.5);
    const [y] = through(effect('wow', { wow: 0.2, flutter: 0.05 }), x);
    let peak = 0;
    for (let i = SR; i < y.length; i++) peak = Math.max(peak, Math.abs(y[i] as number));
    expect(peak).toBeLessThan(0.51);
    expect(peak).toBeGreaterThan(0.49);
    // zero crossings a second apart: within a percent of 1 kHz, and not exactly it
    const counts: number[] = [];
    for (let s = 1; s < 3; s++) {
      let c = 0;
      for (let i = s * SR - SR / 2 + 1; i < s * SR + SR / 2; i++)
        if ((y[i - 1] as number) < 0 && (y[i] as number) >= 0) c++;
      counts.push(c);
    }
    for (const c of counts) expect(Math.abs(c - 1000)).toBeLessThan(10);
  });

  it('follows a drift curve from the song exactly', () => {
    const curve = new Float32Array(SR).fill(100 / SR); // a delay of 100 frames, held
    const x = new Float32Array(4096).map((_, i) => Math.sin(i * 0.02));
    const h = host({ clip: (key) => (key === 'curve_1' ? [curve] : undefined) });
    const [y] = through(effect('wow', {}, h, { curve: 'curve_1' }), x);
    for (let i = 200; i < 4096; i += 97) expect(y[i]).toBeCloseTo(x[i - 100] as number, 6);
  });
});

describe('Shimmer', () => {
  const impulses = new Map<string, ReturnType<typeof prepareImpulse>>();
  for (let g = 0; g <= 2; g++) {
    const want = impulseFor({ space: 0, seed: 1 }, undefined, SR, 'shimmer', g);
    if (want && want.source.kind === 'space')
      impulses.set(want.key, prepareImpulse(generateSpace(want.source.name, want.source.seed, 1, SR)));
  }
  const h = host({ impulse: (k) => impulses.get(k) });
  const x = new Float32Array(SR * 2);
  for (let i = 0; i < SR / 10; i++) x[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;

  it('adds an octave above, generation by generation', () => {
    const [none] = through(effect('shimmer', { space: 0, seed: 1, generations: 0 }, h), x);
    const [two] = through(effect('shimmer', { space: 0, seed: 1, generations: 2 }, h), x);
    expect(rms(two)).toBeGreaterThan(rms(none));
    for (const v of two) expect(Number.isFinite(v)).toBe(true);
  });

  it('with look-ahead, comes as late as it says and no later', () => {
    const e = effect('shimmer', { space: 0, seed: 1, generations: 2, lookahead: 1, dry: 0 }, h);
    const late = e.latency ?? 0;
    expect(late).toBeGreaterThan(8000);
    const [y] = through(e, x);
    // the dry sound comes out exactly that late
    const click = new Float32Array(late + 1000);
    click[0] = 1;
    const e2 = effect('shimmer', { space: 0, seed: 1, generations: 2, lookahead: 1, dry: 0, wet: -60 }, h);
    const [c] = through(e2, click);
    expect(Math.abs((c[late] as number) - 1)).toBeLessThan(1e-3);
    expect(rms(y)).toBeGreaterThan(0);
  });
});

describe('plugin delay compensation', () => {
  it('lines up a path through a look-ahead with the paths around it', async () => {
    const { renderSession } = await import('../src/render.ts');
    const p = newProject('Aligned');
    p.tempo = [{ tick: 0, bpm: 120 }];
    p.master.inserts = [];
    const bus = newBus('Look-ahead');
    bus.channel.inserts = [newPlugin('limiter', { lookahead: 5, ceiling: 0 })];
    const track = newAudioTrack('Click');
    track.channel.sends = [{ bus: bus.id, level: 0, pre: false }];
    track.regions = [
      { ...newRegion(0, PPQ * 2), audio: { file: 'aud_click', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 } },
    ];
    p.tracks = [track];
    p.buses = [bus];
    const click = new Float32Array(SR);
    click[1000] = 0.25;
    const wav = encodeWav([click], SR, 'float32');
    const source = {
      instrument: () => Promise.reject(new Error('no packs here')),
      sample: () => Promise.reject(new Error('no packs here')),
      audio: () => Promise.resolve(wav),
      impulse: () => Promise.reject(new Error('no packs here')),
    };
    const out = await renderSession(p, source, { sampleRate: SR, tail: 0.1 });
    const left = out.channels[0] as Float32Array;
    let at = 0;
    for (let i = 0; i < left.length; i++) if (Math.abs(left[i] as number) > Math.abs(left[at] as number)) at = i;
    // one click, the dry and the bus's together, where the song has it
    expect(at).toBe(1000);
    expect(left[at]).toBeCloseTo(0.5, 3);
    let others = 0;
    for (let i = 0; i < left.length; i++) if (i !== at) others = Math.max(others, Math.abs(left[i] as number));
    expect(others).toBeLessThan(0.01);
  });
});

describe('stage', () => {
  /** A held 1 kHz tone on a track seated between a near and a far seat, rendered with its sends to two buses. */
  async function seated(distance: number, lanes: Parameters<typeof Object.assign>[0][] = []) {
    const { renderSession } = await import('../src/render.ts');
    const p = newProject('Stage');
    p.tempo = [{ tick: 0, bpm: 120 }];
    p.master.inserts = [];
    const room = newBus('Room');
    const hall = newBus('Hall');
    room.channel.inserts = [];
    hall.channel.inserts = [];
    room.channel.mute = true; // hear the direct sound alone; the sends are checked through the hall
    const track = newAudioTrack('Voice');
    track.regions = [
      { ...newRegion(0, PPQ * 8), audio: { file: 'aud_tone', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 } },
    ];
    track.channel.stage = {
      distance,
      near: { depth: 0, sends: [{ bus: room.id, level: -12 }] },
      far: { depth: 1, sends: [{ bus: hall.id, level: 0 }] },
    };
    track.channel.automation = lanes as never;
    p.tracks = [track];
    p.buses = [room, hall];
    const tone = new Float32Array(SR * 2).map((_, i) => Math.sin((2 * Math.PI * 1000 * i) / SR) * 0.5);
    const wav = encodeWav([tone], SR, 'float32');
    const source = {
      instrument: () => Promise.reject(new Error('none')),
      sample: () => Promise.reject(new Error('none')),
      audio: () => Promise.resolve(wav),
      impulse: () => Promise.reject(new Error('none')),
    };
    const hallOnly = await renderSession(
      { ...p, tracks: [{ ...track, channel: { ...track.channel, output: room.id } }] },
      source,
      {
        sampleRate: SR,
        tail: 0,
      },
    );
    const all = await renderSession(p, source, { sampleRate: SR, tail: 0 });
    return { all: all.channels[0] as Float32Array, hall: hallOnly.channels[0] as Float32Array };
  }

  it('at the near seat: the direct sound as it is, and only the near seat’s sends', async () => {
    const { all, hall } = await seated(0);
    expect(rms(all, SR / 2, SR) / (0.5 / Math.SQRT2)).toBeCloseTo(1, 3);
    expect(rms(hall, SR / 2, SR)).toBeLessThan(1e-6);
  });

  it('at the far seat: the direct sound set back (−7 dB, darker) and the far seat’s sends at their level', async () => {
    const { all, hall } = await seated(1);
    const direct = rms(all, SR / 2, SR) - rms(hall, SR / 2, SR);
    // −7 dB, and a touch more from the low pass even at 1 kHz
    expect(20 * Math.log10(direct / (0.5 / Math.SQRT2))).toBeCloseTo(-7.1, 1);
    expect(rms(hall, SR / 2, SR) / (0.5 / Math.SQRT2)).toBeCloseTo(1, 3);
  });

  it('moves between the seats at equal power, along a smooth lane', async () => {
    const lanes = [
      {
        param: 'distance',
        points: [
          [0, 0],
          [PPQ * 2, 1],
        ],
        mode: 'read',
        curve: 'smooth',
      },
    ];
    const { hall } = await seated(0, lanes);
    // half way through the move (0.5 s), the cosine ease is at half: sin(π/4) of the far seat's send
    const at = SR / 2;
    const level = rms(hall, at - 200, at + 200) / (0.5 / Math.SQRT2);
    expect(level).toBeCloseTo(Math.sin(Math.PI / 4), 2);
  });
});
