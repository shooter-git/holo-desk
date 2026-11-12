/**
 * A stock plugin run on its own, outside the mixer, as the engine runs it (fx.ts `createEffect`, in
 * blocks of 128): an impulse through it (what a filter, a reverb or a delay does), or a recording
 * through it with its gain reduction read after every block (what a compressor or a gate does to it).
 */
import { createEffect, type Host } from '../fx.ts';

/** What a plugin reaches while it runs (fx.ts Host): the rate, the song's tempo, its responses and clips. */
export type EffectHost = Host;

const BLOCK = 128;

/** A plugin's response to an impulse of `amplitude` in both channels, `frames` long; null for a plugin HO[LO] doesn't have. */
export function effectResponse(
  type: string,
  params: Record<string, number>,
  settings: Record<string, string> | undefined,
  host: Host,
  frames: number,
  amplitude = 0.25,
): { left: Float32Array; right: Float32Array; latency: number } | null {
  const fx = createEffect(type, host);
  if (!fx) return null;
  fx.setParams(params, settings);
  fx.refresh?.();
  const left = new Float32Array(frames);
  const right = new Float32Array(frames);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let at = 0; at < frames; at += BLOCK) {
    const n = Math.min(BLOCK, frames - at);
    l.fill(0);
    r.fill(0);
    if (at === 0) {
      l[0] = amplitude;
      r[0] = amplitude;
    }
    fx.process(l, r, n);
    left.set(l.subarray(0, n), at);
    right.set(r.subarray(0, n), at);
  }
  return { left, right, latency: fx.latency ?? 0 };
}

/**
 * A stereo recording through a plugin: what comes out, and its gain reduction (dB, ≤ 0) after each
 * block. `at` is told each block's first frame first (the host's song position follows it).
 */
export function throughEffect(
  type: string,
  params: Record<string, number>,
  settings: Record<string, string> | undefined,
  host: Host,
  input: readonly Float32Array[],
  at: (frame: number) => void = () => {},
): { output: Float32Array[]; gr: Float32Array; peaks: Float32Array; latency: number } | null {
  const fx = createEffect(type, host);
  if (!fx) return null;
  fx.setParams(params, settings);
  fx.refresh?.();
  const inL = input[0] ?? new Float32Array(0);
  const inR = input[1] ?? inL;
  const n = inL.length;
  const outL = new Float32Array(n);
  const outR = new Float32Array(n);
  const blocks = Math.ceil(n / BLOCK);
  const gr = new Float32Array(blocks);
  const peaks = new Float32Array(blocks);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    const i = b * BLOCK;
    const k = Math.min(BLOCK, n - i);
    l.fill(0);
    r.fill(0);
    l.set(inL.subarray(i, i + k));
    r.set(inR.subarray(i, i + k));
    let peak = 0;
    for (let j = 0; j < k; j++) peak = Math.max(peak, Math.abs(l[j] as number), Math.abs(r[j] as number));
    peaks[b] = peak;
    at(i);
    fx.process(l, r, k);
    gr[b] = fx.gr;
    outL.set(l.subarray(0, k), i);
    outR.set(r.subarray(0, k), i);
  }
  return { output: [outL, outR], gr, peaks, latency: fx.latency ?? 0 };
}
