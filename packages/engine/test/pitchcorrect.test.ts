import { newAudioTrack, newPlugin, newProject, newRegion, PPQ } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { createEffect, type Effect, type Host } from '../src/fx.ts';
import { encodeWav } from '../src/wav.ts';

const SR = 48000;
const host = (lowLatency = false): Host => ({
  sr: SR,
  lowLatency,
  beatSeconds: () => 0.5,
  impulse: () => undefined,
  songFrame: () => 0,
  clip: () => undefined,
});

function effect(params: Record<string, number> = {}, lowLatency = false): Effect {
  const e = createEffect('pitch', host(lowLatency));
  if (!e) throw new Error('pitch');
  e.setParams(params);
  return e;
}

/** A sung-like tone: eight harmonics falling away, its pitch (Hz) at each second given, from `from` (s) on. */
function tone(hz: number | ((t: number) => number), seconds: number, from = 0): Float32Array {
  const x = new Float32Array(Math.round(seconds * SR));
  const f = typeof hz === 'number' ? () => hz : hz;
  let ph = 0;
  for (let i = Math.round(from * SR); i < x.length; i++) {
    let v = 0;
    for (let k = 1; k <= 8; k++) v += Math.sin(k * ph) / k;
    x[i] = 0.3 * v;
    ph += (2 * Math.PI * f(i / SR)) / SR;
  }
  return x;
}

/** Runs a signal through (both sides the same), `block` frames at a time; the left side out. */
function through(e: Effect, x: Float32Array, block = 128): Float32Array {
  const a = x.slice();
  const b = x.slice();
  for (let at = 0; at < a.length; at += block) {
    const n = Math.min(block, a.length - at);
    e.process(a.subarray(at, at + n), b.subarray(at, at + n), n);
  }
  return a;
}

/** The pitch (Hz) of frames from…to, by autocorrelation within 6% of `near`, between lags by a parabola. */
function pitchOf(x: Float32Array, from: number, to: number, near: number): number {
  const period = SR / near;
  const ac = (lag: number) => {
    let s = 0;
    for (let i = from; i + lag < to; i++) s += (x[i] as number) * (x[i + lag] as number);
    return s / (to - from - lag);
  };
  let best = 0;
  let most = -Infinity;
  for (let lag = Math.floor(period / 1.06); lag <= Math.ceil(period * 1.06); lag++) {
    const v = ac(lag);
    if (v > most) {
      most = v;
      best = lag;
    }
  }
  const a = ac(best - 1);
  const b = ac(best);
  const c = ac(best + 1);
  return SR / (best + (0.5 * (a - c)) / (a - 2 * b + c));
}

const midiHz = (m: number) => 440 * 2 ** ((m - 69) / 12);
const cents = (hz: number, ref: number) => 1200 * Math.log2(hz / ref);
/** The pitch (cents from `ref` Hz) of the output's second `at` (song time: the effect's latency taken off). */
const centsAt = (y: Float32Array, at: number, length: number, ref: number, late = 0) => {
  const from = Math.round(at * SR) + late;
  return cents(pitchOf(y, from, from + Math.round(length * SR), ref), ref);
};

describe('Pitch Correction', () => {
  const A4 = 440;
  const flat = tone(A4 * 2 ** (-35 / 1200), 2);

  for (const lowLatency of [false, true]) {
    const mode = lowLatency ? ' (Low Latency Mode)' : '';
    it(`brings a tone 35 cents flat of A4 to within 3 cents of it${mode}`, () => {
      expect(centsAt(flat, 0.8, 1, A4)).toBeCloseTo(-35, 0);
      const e = effect({}, lowLatency);
      const y = through(e, flat);
      expect(Math.abs(centsAt(y, 0.8, 1, A4, e.latency))).toBeLessThan(3);
    });

    it(`at an Amount of 50%, corrects it halfway${mode}`, () => {
      const e = effect({ amount: 50 }, lowLatency);
      const y = through(e, flat);
      expect(centsAt(y, 0.8, 1, A4, e.latency)).toBeCloseTo(-17.5, 0);
    });
  }

  it('reaches the note with the Response as its time constant', () => {
    const e = effect({ response: 100 });
    const y = through(e, flat);
    // 100 ms later, what's left of the correction is e⁻¹ of what it was, wherever the voice was first heard
    const early = centsAt(y, 0.08, 0.04, A4, e.latency);
    const later = centsAt(y, 0.18, 0.04, A4, e.latency);
    const after = centsAt(y, 0.38, 0.04, A4, e.latency);
    expect(early).toBeLessThan(-10);
    expect(later / early).toBeGreaterThan(Math.exp(-1) * 0.75);
    expect(later / early).toBeLessThan(Math.exp(-1) * 1.3);
    expect(Math.abs(after)).toBeLessThan(2);
    // with none, it's on the note as soon as the voice is heard
    const hard = effect({ response: 0 });
    expect(Math.abs(centsAt(through(hard, flat), 0.1, 0.04, A4, hard.latency))).toBeLessThan(3);
  });

  it('snaps to the nearest note of the key’s scale, or of every semitone in Chromatic', () => {
    // [pitch sung (MIDI), Chromatic’s target, C major’s target]
    const cases: [number, number, number][] = [
      [60.6, 61, 60],
      [61.4, 61, 62],
      [64.45, 64, 64],
      [65.7, 66, 65],
    ];
    for (const [sung, chromatic, major] of cases) {
      const x = tone(midiHz(sung), 1.2);
      for (const [scale, want] of [
        [11, chromatic],
        [0, major],
      ] as const) {
        const e = effect({ key: 0, scale, response: 0 });
        const y = through(e, x);
        expect(Math.abs(centsAt(y, 0.5, 0.6, midiHz(want), e.latency))).toBeLessThan(3);
      }
    }
    // D major has the C♯ C major hasn't
    const e = effect({ key: 2, scale: 0, response: 0 });
    const y = through(e, tone(midiHz(61.4), 1.2));
    expect(Math.abs(centsAt(y, 0.5, 0.6, midiHz(61), e.latency))).toBeLessThan(3);
  });

  it('holds a voice halfway between two notes on one of them, not flipping between them', () => {
    // a quarter tone above A4, wandering ±6 cents
    const x = tone((t) => midiHz(69.5 + 0.06 * Math.sin(2 * Math.PI * 0.7 * t)), 3);
    const e = effect({ response: 0 });
    const y = through(e, x);
    const heard: number[] = [];
    for (let at = 0.3; at < 2.7; at += 0.1) heard.push(centsAt(y, at, 0.08, A4, e.latency));
    const note = Math.round((heard[0] as number) / 100);
    expect([0, 1]).toContain(note);
    for (const c of heard) expect(Math.abs(c - note * 100)).toBeLessThan(4);
  });

  it('corrects low and high voices in their Range', () => {
    // [pitch (Hz), cents off, Range, the note]
    const cases: [number, number, number, number][] = [
      [midiHz(43), -30, 0, 43],
      [midiHz(50), 28, 0, 50],
      [midiHz(57), -40, 1, 57],
      [midiHz(76), 25, 2, 76],
      [midiHz(84), -30, 2, 84],
    ];
    for (const lowLatency of [false, true]) {
      for (const [hz, off, range, note] of cases) {
        const e = effect({ range, response: 0 }, lowLatency);
        const y = through(e, tone(hz * 2 ** (off / 1200), 1.5));
        expect(Math.abs(centsAt(y, 0.6, 0.8, midiHz(note), e.latency))).toBeLessThan(3);
      }
    }
  });

  it('lets noise through finite, and silence silent', () => {
    let seed = 7;
    const noise = new Float32Array(SR * 2).map(() => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return (seed / 4294967296 - 0.5) * 0.8;
    });
    for (const lowLatency of [false, true]) {
      const y = through(effect({}, lowLatency), noise);
      expect(y.every(Number.isFinite)).toBe(true);
      expect(Math.max(...y.map(Math.abs))).toBeLessThan(1);
      const quiet = through(effect({}, lowLatency), new Float32Array(SR));
      expect(quiet.every((v) => v === 0)).toBe(true);
    }
  });

  it('delays what it doesn’t tune by exactly its latency, and in Low Latency Mode not at all', () => {
    // a click, then noise (nothing voiced): every frame comes out as it went in
    let seed = 3;
    const x = new Float32Array(SR);
    x[5000] = 0.9;
    for (let i = 9000; i < 30000; i++) {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      x[i] = (seed / 4294967296 - 0.5) * 0.5;
    }
    const e = effect();
    expect(e.latency).toBe(1024);
    const y = through(e, x);
    expect(y.findIndex((v) => v !== 0)).toBe(5000 + 1024);
    for (let i = 1024; i < y.length; i++) expect(y[i]).toBe(x[i - 1024]);
    const now = effect({}, true);
    expect(now.latency).toBe(0);
    expect(Array.from(through(now, x))).toEqual(Array.from(x));
  });

  it('at an Amount of 0, delays a voice by its latency and leaves it exactly as it was', () => {
    const x = tone((t) => 220 * 2 ** ((0.4 * Math.sin(2 * Math.PI * 5 * t)) / 12), 1.5, 0.2);
    const e = effect({ amount: 0 });
    const y = through(e, x);
    for (let i = 1024; i < y.length; i++) expect(y[i]).toBe(x[i - 1024]);
    expect(Array.from(through(effect({ amount: 0 }, true), x))).toEqual(Array.from(x));
  });

  it('lines up with a dry copy in a render (its latency compensated)', async () => {
    const { renderSession } = await import('../src/render.ts');
    const p = newProject('Tuned');
    p.tempo = [{ tick: 0, bpm: 120 }];
    p.master.inserts = [];
    const clip = { file: 'aud_voice', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
    const tuned = newAudioTrack('Tuned');
    tuned.channel.pan = -1;
    tuned.channel.inserts = [newPlugin('pitch', { response: 20 })];
    tuned.regions = [{ ...newRegion(0, PPQ * 8), audio: clip }];
    const dry = newAudioTrack('Dry');
    dry.channel.pan = 1;
    dry.regions = [{ ...newRegion(0, PPQ * 8), audio: clip }];
    p.tracks = [tuned, dry];
    // notes a little off, with breaths between them
    const voice = new Float32Array(SR * 3);
    const notes = [57.3, 59.8, 61.25, 62.6];
    let seed = 11;
    const breaths: number[] = [];
    notes.forEach((m, k) => {
      const at = Math.round((0.1 + k * 0.7) * SR);
      const x = tone(midiHz(m), 0.5);
      for (let i = 0; i < x.length; i++) {
        const env = Math.min(1, i / 400, (x.length - i) / 400);
        voice[at + i] = (x[i] as number) * env;
      }
      breaths.push(at + x.length + 2000);
      for (let i = 0; i < 2400; i++) {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        voice[at + x.length + 2000 + i] = (seed / 4294967296 - 0.5) * 0.2;
      }
    });
    const wav = encodeWav([voice], SR, 'float32');
    const source = {
      instrument: () => Promise.reject(new Error('no packs here')),
      sample: () => Promise.reject(new Error('no packs here')),
      audio: () => Promise.resolve(wav),
      impulse: () => Promise.reject(new Error('no packs here')),
    };
    const out = await renderSession(p, source, { sampleRate: SR, tail: 0.2, finish: false });
    const [left, right] = out.channels as [Float32Array, Float32Array];
    // the breaths (unvoiced: the tuned track's sound as it was) line up with the dry track's
    let lag = 0;
    let most = -Infinity;
    for (let d = -2000; d <= 2000; d++) {
      let s = 0;
      for (const at of breaths)
        for (let i = at; i < at + 2400; i++) s += (right[i] as number) * (left[i + d] as number);
      if (s > most) {
        most = s;
        lag = d;
      }
    }
    expect(lag).toBe(0);
    // and it was tuned: the second note, sung 20 cents flat of B3, is B3
    expect(Math.abs(centsAt(left, 0.95, 0.3, midiHz(60)))).toBeLessThan(3);
    expect(centsAt(right, 0.95, 0.3, midiHz(60))).toBeCloseTo(-20, 0);
  });

  /** A line of slightly-off notes with vibrato, slides and breaths: the voicing changing often. */
  function sung(seconds: number): Float32Array {
    const x = new Float32Array(SR * seconds);
    const line = [
      [0.1, 0.6, 64.3],
      [0.75, 1.3, 66.8],
      [1.3, 2.0, 67.6],
      [2.2, 2.9, 62.2],
    ];
    let seed = 5;
    let ph = 0;
    for (let i = 0; i < x.length; i++) {
      const t = i / SR;
      const note = line.find(([a, b]) => t >= (a as number) && t < (b as number));
      if (note) {
        const vib = 0.3 * Math.min(1, (t - (note[0] as number)) / 0.3) * Math.sin(2 * Math.PI * 5.5 * t);
        const f = midiHz((note[2] as number) + vib);
        let v = 0;
        for (let k = 1; k <= 8; k++) v += Math.sin(k * ph) / k;
        x[i] = 0.3 * v;
        ph += (2 * Math.PI * f) / SR;
      } else {
        seed = (seed * 1664525 + 1013904223) >>> 0;
        x[i] = (seed / 4294967296 - 0.5) * 0.1;
      }
    }
    return x;
  }

  it('comes out the same to the byte, run again or in other block sizes', () => {
    const x = sung(3);
    for (const lowLatency of [false, true]) {
      const once = through(effect({ response: 30 }, lowLatency), x);
      expect(once.every(Number.isFinite)).toBe(true);
      for (const block of [128, 64, 37]) {
        const again = through(effect({ response: 30 }, lowLatency), x, block);
        expect(Buffer.from(again.buffer).equals(Buffer.from(once.buffer))).toBe(true);
      }
    }
  });

  it('allocates nothing while it plays', () => {
    const x = sung(3);
    for (const lowLatency of [false, true]) {
      const e = effect({ response: 30 }, lowLatency);
      const a = x.slice();
      const b = x.slice();
      const blocks: [Float32Array, Float32Array][] = [];
      for (let at = 0; at < a.length; at += 128) blocks.push([a.subarray(at, at + 128), b.subarray(at, at + 128)]);
      const saved = [globalThis.Float32Array, globalThis.Float64Array, globalThis.Uint8Array, globalThis.Array];
      const refuse = () => {
        throw new Error('allocated while playing');
      };
      try {
        Object.assign(globalThis, { Float32Array: refuse, Float64Array: refuse, Uint8Array: refuse, Array: refuse });
        for (const [l, r] of blocks) e.process(l, r, 128);
      } finally {
        const [f32, f64, u8, arr] = saved;
        Object.assign(globalThis, { Float32Array: f32, Float64Array: f64, Uint8Array: u8, Array: arr });
      }
      expect(a.every(Number.isFinite)).toBe(true);
    }
  });

  it('keeps playing through a change of Low Latency Mode', () => {
    const h = host(false);
    const e = createEffect('pitch', h);
    if (!e) throw new Error('pitch');
    e.setParams({});
    const x = sung(3);
    const a = x.slice();
    const b = x.slice();
    for (let at = 0, k = 0; at < a.length; at += 128, k++) {
      if (k % 150 === 75) h.lowLatency = !h.lowLatency;
      e.process(a.subarray(at, at + 128), b.subarray(at, at + 128), 128);
    }
    expect(a.every((v) => Number.isFinite(v) && Math.abs(v) < 1)).toBe(true);
  });
});
