import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createEffect, type Host } from '../src/fx.ts';

/**
 * Songs keep their sound: the plugins a saved song already uses render the same bytes as they did
 * before newer settings were added beside theirs (a setting a song never stored keeps its default,
 * and its default is the sound it had). Each digest is of the output of a fixed signal, as the
 * studio plays it, 128 frames at a time.
 */

const SR = 48000;
const host = (lowLatency: boolean): Host => ({
  sr: SR,
  lowLatency,
  beatSeconds: () => 0.5,
  impulse: () => undefined,
  songFrame: () => 0,
  clip: () => undefined,
});

/** Chords that swell past full scale and fall away, with a little noise: enough to make a compressor and a limiter work. */
function signal(seconds: number): [Float32Array, Float32Array] {
  const n = SR * seconds;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  let seed = 12345;
  for (let i = 0; i < n; i++) {
    seed = (seed * 1664525 + 1013904223) >>> 0;
    const noise = seed / 4294967296 - 0.5;
    const t = i / SR;
    const k = Math.floor(t / 0.5);
    const tt = t - k * 0.5;
    const env = (tt < 0.35 ? Math.exp(-tt * 6) : 0) * (0.4 + 0.5 * (k % 3));
    const f = [110, 147, 196, 262][k % 4] as number;
    l[i] = (Math.sin(2 * Math.PI * f * t) + 0.4 * Math.sin(2 * Math.PI * f * 2.01 * t) + 0.1 * noise) * env;
    r[i] = (Math.sin(2 * Math.PI * f * 1.002 * t + 0.3) + 0.1 * noise) * env * 0.9;
  }
  return [l, r];
}

function digest(type: string, params: Record<string, number>, lowLatency = false): string {
  const fx = createEffect(type, host(lowLatency));
  if (!fx) throw new Error(type);
  fx.setParams(params);
  const [l, r] = signal(3);
  for (let at = 0; at < l.length; at += 128) fx.process(l.subarray(at, at + 128), r.subarray(at, at + 128), 128);
  return createHash('sha256').update(Buffer.from(l.buffer)).update(Buffer.from(r.buffer)).digest('hex').slice(0, 16);
}

const CASES: [string, string, Record<string, number>, boolean?][] = [
  ['eq', 'defaults', {}],
  ['eq', 'every band', { hpOn: 1, lpOn: 1, lsGain: 3, b1Gain: -4, b2Gain: 5, b2Q: 3, b3Gain: -2, hsGain: 4 }],
  ['compressor', 'defaults', {}],
  ['compressor', 'linear, hard', { threshold: -30, ratio: 8, knee: 0, attack: 1, release: 300, detector: 1, mix: 70 }],
  ['limiter', 'defaults', {}],
  ['limiter', 'driven', { gain: 12, ceiling: -3, release: 200, lookahead: 5 }],
  ['limiter', 'driven, low latency', { gain: 12, ceiling: -3, release: 200 }, true],
  ['reverb', 'defaults', {}],
  ['reverb', 'long and wet', { size: 90, decay: 6, damping: 3000, mix: 80, width: 60 }],
  ['delay', 'defaults', {}],
  ['delay', 'free, ping-pong', { sync: 0, time: 230, feedback: 70, pingpong: 1, mix: 60 }],
];

/** The digests before the newer settings came (a change here changes saved songs). */
const BEFORE: Record<string, string> = {
  'eq defaults': 'cc39ffdc4283992b',
  'eq every band': 'ba8dc3b191c62610',
  'compressor defaults': 'f74f9603b17272bd',
  'compressor linear, hard': 'a787bc153347b4b6',
  'limiter defaults': '9511f44a144f6267',
  'limiter driven': 'aefd727357b9e05f',
  'limiter driven, low latency': 'eb9c13ca360715be',
  'reverb defaults': '6814d7d6449c04a0',
  'reverb long and wet': '85209a2a934cfb97',
  'delay defaults': '03c6b63af9f54e6d',
  'delay free, ping-pong': 'a75f95818724a26b',
};

describe('plugins saved songs use', () => {
  for (const [type, label, params, low] of CASES) {
    it(`${type} (${label}) renders as it always has`, () => {
      expect(digest(type, params, low)).toBe(BEFORE[`${type} ${label}`]);
    });
  }
});
