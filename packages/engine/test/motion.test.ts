import { describe, expect, it } from 'vitest';
import { createEffect, type Effect, type Host } from '../src/fx.ts';

const SR = 48000;
const host = (extra: Partial<Host> = {}): Host => ({
  sr: SR,
  lowLatency: false,
  beatSeconds: () => 0.5,
  impulse: () => undefined,
  songFrame: () => 0,
  clip: () => undefined,
  ...extra,
});

function effect(type: string, params: Record<string, number>, h = host()): Effect {
  const e = createEffect(type, h);
  if (!e) throw new Error(type);
  e.setParams(params);
  return e;
}

/** Runs a stereo signal through, 128 frames at a time (`each` before each block). */
function through(
  e: Effect,
  l: Float32Array,
  r: Float32Array = l.slice(),
  each?: (at: number) => void,
): [Float32Array, Float32Array] {
  const a = l.slice();
  const b = r.slice();
  for (let at = 0; at < a.length; at += 128) {
    const n = Math.min(128, a.length - at);
    each?.(at);
    e.process(a.subarray(at, at + n), b.subarray(at, at + n), n);
  }
  return [a, b];
}

const sine = (f: number, seconds: number, amp = 0.5) =>
  Float32Array.from({ length: Math.round(SR * seconds) }, (_, i) => Math.sin((2 * Math.PI * f * i) / SR) * amp);

const rms = (x: Float32Array, from = 0, to = x.length) => {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, to - from));
};

/** How many times a level (5 ms windows) crosses its own average: twice a cycle of whatever moves it. */
function swings(x: Float32Array, from: number, to: number): number {
  const w = SR / 200;
  const env: number[] = [];
  for (let i = from; i + w <= to; i += w) env.push(rms(x, i, i + w));
  const mean = env.reduce((a, b) => a + b, 0) / env.length;
  let n = 0;
  for (let i = 1; i < env.length; i++) if ((env[i - 1] as number) < mean !== (env[i] as number) < mean) n++;
  return n;
}

describe('Rotary Speaker', () => {
  it('turns quickly on Fast, slowly on Slow, and not at all on Brake', () => {
    // a tone the horn plays, its level swinging as the horn turns past each microphone (close up:
    // further off each hears the other side too, and the two interfere as they move)
    const x = sine(3000, 3);
    const count = (speed: number) => {
      const [l] = through(effect('rotary', { speed, drive: 0, distance: 0 }), x);
      return swings(l, SR, 3 * SR);
    };
    const fast = count(2);
    const slow = count(1);
    // two seconds: about 6.8 turns a second fast, 0.8 slow
    expect(fast).toBeGreaterThan(20);
    expect(fast).toBeLessThan(34);
    expect(slow).toBeLessThan(6);
    const [still] = through(effect('rotary', { speed: 0, drive: 0 }), x);
    const level = rms(still, SR, 2 * SR);
    for (let at = SR; at < 3 * SR; at += SR / 10)
      expect(Math.abs(rms(still, at, at + SR / 10) / level - 1)).toBeLessThan(0.01);
  });

  it('takes its ramp time to get up to speed (the drum longer than the horn)', () => {
    const e = effect('rotary', { speed: 1, drive: 0, distance: 0, hornRamp: 1, drumRamp: 6 });
    const x = sine(3000, 4);
    let switched = false;
    const [l] = through(e, x, x.slice(), (at) => {
      if (at >= SR && !switched) {
        switched = true;
        e.setParams({ speed: 2, drive: 0, distance: 0, hornRamp: 1, drumRamp: 6 });
      }
    });
    // the first half second after the switch turns well short of the second after it
    expect(swings(l, SR, 1.5 * SR) * 2).toBeLessThan(swings(l, 2.5 * SR, 3.5 * SR));
  });

  it('hears the two sides apart, and keeps a quiet sound at its level however hard it drives', () => {
    const x = sine(3000, 2, 0.05);
    const [l, r] = through(effect('rotary', { speed: 2, drive: 0 }), x);
    let diff = 0;
    for (let i = SR; i < 2 * SR; i++) diff = Math.max(diff, Math.abs((l[i] as number) - (r[i] as number)));
    expect(diff).toBeGreaterThan(0.01);
    const [driven] = through(effect('rotary', { speed: 0, drive: 100 }), x);
    const [clean] = through(effect('rotary', { speed: 0, drive: 0 }), x);
    expect(Math.abs(20 * Math.log10(rms(driven, SR) / rms(clean, SR)))).toBeLessThan(1.5);
  });
});

describe('Phaser', () => {
  it('notches the sound where its stages turn it half round, and passes it where they turn it whole', () => {
    // four stages with their corner held at 1 kHz: notches at about 0.41 and 2.4 times it
    const params = { depth: 0, low: 1000, high: 1000, feedback: 0, stages: 1, spread: 0, mix: 50 };
    const notch = through(effect('phaser', params), sine(414, 1))[0];
    const pass = through(effect('phaser', params), sine(1000, 1))[0];
    expect(rms(notch, SR / 2) / rms(sine(414, 1), SR / 2)).toBeLessThan(0.05);
    expect(rms(pass, SR / 2) / rms(sine(1000, 1), SR / 2)).toBeGreaterThan(0.95);
  });

  it('is the sound itself with the mix down', () => {
    const x = sine(440, 0.5);
    const [y] = through(effect('phaser', { mix: 0 }), x);
    expect(Array.from(y)).toEqual(Array.from(x));
  });
});

describe('Tremolo', () => {
  it('in time with the song, turns down on the second half of every beat, the top on the beat', () => {
    let frame = 0;
    const h = host({ beatSeconds: () => 0.5, beatAt: () => frame / (0.5 * SR) });
    const e = effect('tremolo', { mode: 0, sync: 1, division: 1, depth: 100, shape: 2 }, h);
    const x = new Float32Array(SR * 3).fill(0.5);
    // the song starting at beat 0.25: the wave picks up the song's phase
    const [y] = through(e, x, x.slice(), (at) => {
      frame = at + SR / 8;
    });
    for (let beat = 1; beat < 5; beat++) {
      const start = Math.round(beat * 0.5 * SR - SR / 8);
      expect(y[start + 960]).toBeCloseTo(0.5, 3);
      expect(y[start + SR / 4 + 960]).toBeCloseTo(0, 3);
    }
  });

  it('pans at constant power, the whole way at full depth', () => {
    const e = effect('tremolo', { mode: 1, sync: 0, rate: 2, depth: 100, shape: 0 });
    const x = new Float32Array(SR).fill(0.5);
    const [l, r] = through(e, x);
    let least = 1;
    for (let i = 0; i < SR; i++) {
      expect((l[i] as number) ** 2 + (r[i] as number) ** 2).toBeCloseTo(0.5, 5);
      least = Math.min(least, l[i] as number);
    }
    expect(least).toBeLessThan(0.01);
  });
});

describe('Lo-fi', () => {
  it('keeps to its bits and holds each sample until the next is due', () => {
    const x = sine(300, 0.5, 0.8);
    const [crushed] = through(effect('lofi', { bits: 4, rate: 48000, wow: 0, noise: -90, tone: 20000, mix: 100 }), x);
    for (const v of crushed) expect(Math.abs(v * 8 - Math.round(v * 8))).toBeLessThan(1e-6);
    const [held] = through(effect('lofi', { bits: 16, rate: 8000, wow: 0, noise: -90, tone: 20000, mix: 100 }), x);
    let runs = 0;
    let changes = 0;
    for (let i = 1; i < held.length; i++) if (held[i] !== held[i - 1]) changes++;
    runs = held.length / changes;
    expect(runs).toBeGreaterThan(5.5);
    expect(runs).toBeLessThan(6.5);
  });

  it('wavers in pitch with wow, and hisses with noise', () => {
    const x = sine(1000, 2);
    const [wavy] = through(effect('lofi', { bits: 16, rate: 48000, wow: 100, noise: -90, tone: 20000 }), x);
    // the pitch moves: the wave drifts against the steady one
    let apart = 0;
    for (let i = SR; i < 2 * SR; i++) apart = Math.max(apart, Math.abs((wavy[i] as number) - (x[i] as number)));
    expect(apart).toBeGreaterThan(0.1);
    const [hiss] = through(effect('lofi', { noise: -40 }), new Float32Array(SR));
    expect(20 * Math.log10(rms(hiss))).toBeGreaterThan(-50);
    expect(20 * Math.log10(rms(hiss))).toBeLessThan(-38);
  });
});

describe('String Resonance', () => {
  /** A piano-like note: twelve slightly stretched partials dying away, the top ones sooner. */
  function note(midi: number, seconds: number, total: number): Float32Array {
    const x = new Float32Array(Math.round(SR * total));
    const f = 440 * 2 ** ((midi - 69) / 12);
    for (let i = 0; i < SR * seconds; i++) {
      const t = i / SR;
      let v = 0;
      for (let h = 1; h <= 12; h++) {
        const fh = f * h * Math.sqrt(1 + 0.0002 * h * h);
        if (fh < 18000) v += (Math.sin(2 * Math.PI * fh * t) * Math.exp(-t * (1 + h * 0.6))) / h;
      }
      x[i] = v * 0.3 * Math.min(1, i / 48);
    }
    return x;
  }
  const ring = (y: Float32Array, x: Float32Array) => y.map((v, i) => v - (x[i] as number));

  it('rings on after the note, quietly under it', () => {
    const x = note(60, 1, 3);
    const [y] = through(effect('resonance', { amount: 100 }), x);
    const wet = ring(y, x);
    const under = 20 * Math.log10(rms(wet, SR / 2, SR) / rms(x, SR / 2, SR));
    expect(under).toBeLessThan(-6);
    expect(under).toBeGreaterThan(-24);
    // the note has stopped: the strings still sound
    expect(20 * Math.log10(rms(wet, 1.2 * SR, 1.6 * SR) / rms(x, 0, SR))).toBeGreaterThan(-45);
  });

  it('dies away sooner the more it is damped, and adds the extended strings below A0', () => {
    const x = note(36, 1, 4);
    const tail = (params: Record<string, number>) =>
      rms(ring(through(effect('resonance', params), x)[0], x), 2.5 * SR, 4 * SR);
    expect(tail({ amount: 100, damping: 90 })).toBeLessThan(tail({ amount: 100, damping: 10 }) * 0.3);
    const low = note(24, 1, 3);
    const with9 = ring(through(effect('resonance', { amount: 100, bass: 9 }), low)[0], low);
    const with0 = ring(through(effect('resonance', { amount: 100, bass: 0 }), low)[0], low);
    // (their ring meets the others' at its own phase: what they add, not a louder sum)
    const added = with9.map((v, i) => v - (with0[i] as number));
    expect(rms(added, SR, 3 * SR)).toBeGreaterThan(rms(with0, SR, 3 * SR) * 0.3);
  });

  it('places the bass on the left and leaves silence silent', () => {
    const low = note(28, 1, 2);
    const [l, r] = through(effect('resonance', { amount: 100 }), low);
    expect(rms(ring(l, low), SR) / rms(ring(r, low), SR)).toBeGreaterThan(1.2);
    const quiet = new Float32Array(SR);
    const [s] = through(effect('resonance', { amount: 100 }), quiet);
    expect(s.every((v) => v === 0)).toBe(true);
    const x = note(60, 0.5, 1);
    const [none] = through(effect('resonance', { amount: 0 }), x);
    expect(Array.from(none)).toEqual(Array.from(x));
  });
});
