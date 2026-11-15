import { micParam } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { toShared } from '../src/ahead.ts';
import type { SampleFrames, SamplerSpec, SampleZone } from '../src/protocol.ts';
import { fadeTail } from '../src/render.ts';
import { Sampler } from '../src/sampler.ts';

const SR = 48000;

/** Frames of noise as 16-bit PCM, the same every run. */
function pcm(n: number, seed: number): Int16Array {
  const out = new Int16Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) - 32768;
  }
  return out;
}

/** The same frames as the decoder gives them: each 16-bit step a 32768th. */
const asFloats = (a: Int16Array) => Float32Array.from(a, (v) => v / 32768);

const same = (a: Float32Array, b: Float32Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

describe('16-bit samples', () => {
  const zones = (frames: (a: Int16Array) => SampleFrames): SampleZone[] => [
    // a stereo sample that loops (its seam cross-fades), on one microphone
    {
      left: frames(pcm(SR, 1)),
      right: frames(pcm(SR, 2)),
      root: 60,
      lo: 0,
      hi: 64,
      lovel: 1,
      hivel: 127,
      gain: 0.7,
      loopStart: 12000,
      loopEnd: 30000,
      rr: 0,
      mic: 'close',
    },
    // a mono one panned, on another microphone, for the same keys
    {
      left: frames(pcm(SR / 2, 3)),
      right: null,
      root: 62,
      lo: 0,
      hi: 64,
      lovel: 1,
      hivel: 127,
      gain: 1.3,
      loopStart: 0,
      loopEnd: 0,
      rr: 0,
      mic: 'room',
      pan: -0.4,
    },
    // and one alone higher up, played without microphones' levels in the way
    {
      left: frames(pcm(SR / 4, 4)),
      right: frames(pcm(SR / 4, 5)),
      root: 72,
      lo: 65,
      hi: 127,
      lovel: 1,
      hivel: 127,
      gain: 1,
      loopStart: 0,
      loopEnd: 0,
      rr: 0,
    },
  ];
  const spec = (z: SampleZone[]): SamplerSpec => ({
    key: 'x',
    zones: z,
    release: 0.05,
    oneShot: false,
    pitched: true,
    velocityRange: 20,
    attack: 0.002,
    mics: [
      { id: 'close', name: 'Close' },
      { id: 'room', name: 'Room' },
    ],
  });
  /** A phrase: notes shifted up and down, a microphone's level moving, a bend, a note let go. */
  const play = (s: Sampler): [Float32Array, Float32Array] => {
    const n = SR;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    const events: [number, () => void][] = [
      [0, () => s.noteOn(57, 90)],
      [2000, () => s.noteOn(63, 110)],
      [5000, () => s.noteOn(80, 70)],
      [9000, () => s.update({ [micParam('room')]: -9 })],
      [15000, () => s.pitchBend(2900)],
      [24000, () => s.noteOff(57)],
      [36000, () => s.noteOff(63)],
    ];
    for (let f = 0; f < n; f += 128) {
      for (const [at, fn] of events) if (at >= f && at < f + 128) fn();
      s.render(l, r, f, Math.min(n, f + 128));
    }
    return [l, r];
  };

  it('play exactly as the same samples do as floats', () => {
    const [fl, fr] = play(new Sampler(SR, spec(zones(asFloats))));
    const [il, ir] = play(new Sampler(SR, spec(zones((a) => a))));
    expect(Math.max(...fl.map(Math.abs))).toBeGreaterThan(0.01);
    expect(same(fl, il)).toBe(true);
    expect(same(fr, ir)).toBe(true);
  });

  it('fade out rounded to the nearest step, and floats as before', () => {
    const whole = new Int16Array(8).fill(1000);
    fadeTail(whole, 4);
    const float = new Float32Array(8).fill(1000);
    fadeTail(float, 4);
    expect([...whole]).toEqual([...float].map((v) => Math.round(v)));
    expect(float[7]).toBe(0);
    expect(float[4]).toBeCloseTo(1000 * (1 - 0.25 * 0.25 * (3 - 0.5)), 3);
  });

  it('stay 16-bit in shared memory', () => {
    const a = pcm(100, 9);
    const s = toShared(a);
    expect(s).toBeInstanceOf(Int16Array);
    expect(s.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect([...s]).toEqual([...a]);
    expect(toShared(s)).toBe(s);
    expect(toShared(new Float32Array(3))).toBeInstanceOf(Float32Array);
  });
});
