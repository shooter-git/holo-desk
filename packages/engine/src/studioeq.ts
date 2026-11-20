/**
 * Studio EQ: a low and a high cut (Butterworth cascades of order 1 to 8, so 6 to 48 dB an octave,
 * with a resonance), two shelves and four bells, then an output gain. Every section is a biquad
 * worked out from its analog prototype by the bilinear transform, prewarped so its frequency lands
 * where it's set.
 *
 * - Bells: the boost/cut-symmetric peak filter (1 + G·band pass): a boost's band pass has the Q
 *   as set, a cut's is narrowed by its gain, so a cut mirrors the boost of the same size. The Q is
 *   corrected for the bilinear transform's squeeze toward the top, so a bell keeps its width there.
 * - Shelves: the cookbook shelf, its Q the shelf's slope (0.71 is the steepest without a bump; higher
 *   lifts a little bump either side), kept below the value where the curve would fold.
 * - Cuts: each order's Butterworth poles; Q scales the sharpest section, so 0.71 is Butterworth
 *   (−3 dB at the frequency) and more rings at the corner.
 * - Proportional Q narrows a bell as its gain grows (the asymmetric ones narrow cuts three times as
 *   much): broad when gentle, focused when strong.
 */
import { EQ_SLOPES, paramValue, STUDIO_EQ_BELLS } from '@holo/session';
import { Biquad } from './dsp.ts';
import type { Effect, Host } from './fx.ts';

/** One section's coefficients (a0 = 1). */
export interface Coefs {
  b0: number;
  b1: number;
  b2: number;
  a1: number;
  a2: number;
}

/** The highest frequency a section is tuned to, as a share of the sample rate. */
const TOP = 0.49;
/** The bells' Q at most, after Proportional Q. */
const MAX_Q = 100;

/** How much each of PROPORTIONAL_Q's choices narrows (the last three narrow cuts three times as much). */
const PROP_STRENGTH = [0, 0.5, 1, 2, 0.5, 1, 2];

/** A bell's Q once Proportional Q has had its say. */
export function bellQ(q: number, gain: number, mode: number): number {
  const s = PROP_STRENGTH[mode] ?? 0;
  if (!s) return q;
  const g = Math.abs(gain);
  const k = gain < 0 && mode >= 4 ? 3 * s : s;
  return Math.min(MAX_Q, q * (1 + k * g * (0.05 + 0.004 * g)));
}

/** tan(π f / sr), the bilinear transform's prewarped frequency. */
function warp(f: number, sr: number): number {
  return Math.tan((Math.PI * Math.min(f, sr * TOP)) / sr);
}

export function bell(f: number, gain: number, q: number, sr: number): Coefs {
  const v = 10 ** (gain / 20);
  const big = v - 1;
  const fc = Math.min(f, sr * TOP);
  const w = (Math.PI * fc) / sr;
  const k = Math.tan(w);
  // a cut's band pass is narrower by its gain; and the transform's squeeze of the band is made up
  const qb = (gain < 0 ? q * v : q) * (w / k);
  const d = 1 + k / qb + k * k;
  const bp = k / qb / d;
  const a1 = (2 * (k * k - 1)) / d;
  const a2 = (1 - k / qb + k * k) / d;
  return { b0: 1 + big * bp, b1: a1, b2: a2 - big * bp, a1, a2 };
}

export function shelf(low: boolean, f: number, gain: number, q: number, sr: number): Coefs {
  const A = 10 ** (gain / 40);
  const w0 = (2 * Math.PI * Math.min(f, sr * TOP)) / sr;
  const cos = Math.cos(w0);
  // the slope as set, kept where the curve still rises (or falls) all the way
  const fold = A === 1 ? Number.POSITIVE_INFINITY : (A * A + 1) / ((A - 1) * (A - 1));
  const slope = Math.min(q, 0.95 * fold);
  const beta = Math.sin(w0) * Math.sqrt(Math.max(0, (A * A + 1) / slope - (A - 1) * (A - 1)));
  const sign = low ? 1 : -1;
  const a0 = A + 1 + sign * (A - 1) * cos + beta;
  return {
    b0: (A * (A + 1 - sign * (A - 1) * cos + beta)) / a0,
    b1: (sign * 2 * A * (A - 1 - sign * (A + 1) * cos)) / a0,
    b2: (A * (A + 1 - sign * (A - 1) * cos - beta)) / a0,
    a1: (-sign * 2 * (A - 1 + sign * (A + 1) * cos)) / a0,
    a2: (A + 1 + sign * (A - 1) * cos - beta) / a0,
  };
}

/** One section of a cut: second order with a Q, or first order (q 0). */
function cutSection(high: boolean, f: number, q: number, sr: number): Coefs {
  const k = warp(f, sr);
  if (q <= 0) {
    const d = 1 + k;
    const a1 = (k - 1) / d;
    return high ? { b0: 1 / d, b1: -1 / d, b2: 0, a1, a2: 0 } : { b0: k / d, b1: k / d, b2: 0, a1, a2: 0 };
  }
  const d = 1 + k / q + k * k;
  const a1 = (2 * (k * k - 1)) / d;
  const a2 = (1 - k / q + k * k) / d;
  if (high) return { b0: 1 / d, b1: -2 / d, b2: 1 / d, a1, a2 };
  const kk = (k * k) / d;
  return { b0: kk, b1: 2 * kk, b2: kk, a1, a2 };
}

/** A cut's sections: the order's Butterworth poles (a first-order one when it's odd), the sharpest scaled by Q / 0.71. */
export function cut(high: boolean, f: number, order: number, q: number, sr: number): Coefs[] {
  const out: Coefs[] = [];
  if (order % 2) out.push(cutSection(high, f, 0, sr));
  const pairs = Math.floor(order / 2);
  for (let k = 1; k <= pairs; k++) {
    // the k-th pole pair's angle from the negative real axis: Q = 1 / (2 cos)
    const angle = ((2 * k - 1) * Math.PI) / (2 * order);
    const qb = order % 2 ? 1 / (2 * Math.cos((k * Math.PI) / order)) : 1 / (2 * Math.cos(angle));
    out.push(cutSection(high, f, k === pairs ? (qb * q) / Math.SQRT1_2 : qb, sr));
  }
  return out;
}

/** Every section a Studio EQ's settings turn on, low to high, and its output gain (linear). */
export function studioEqSections(params: Record<string, number>, sr: number): { sections: Coefs[]; out: number } {
  const v = (id: string) => paramValue('studioeq', params, id);
  const on = (id: string) => v(id) >= 0.5;
  const sections: Coefs[] = [];
  const order = (id: string) => (EQ_SLOPES[Math.round(v(id))] ?? 12) / 6;
  if (on('lcOn')) sections.push(...cut(true, v('lcFreq'), order('lcSlope'), v('lcQ'), sr));
  if (on('lsOn') && Math.abs(v('lsGain')) > 0.01) sections.push(shelf(true, v('lsFreq'), v('lsGain'), v('lsQ'), sr));
  const mode = Math.round(v('propQ'));
  for (let b = 1; b <= STUDIO_EQ_BELLS; b++) {
    const g = v(`p${b}Gain`);
    if (!on(`p${b}On`) || Math.abs(g) <= 0.01) continue;
    sections.push(bell(v(`p${b}Freq`), g, bellQ(v(`p${b}Q`), g, mode), sr));
  }
  if (on('hsOn') && Math.abs(v('hsGain')) > 0.01) sections.push(shelf(false, v('hsFreq'), v('hsGain'), v('hsQ'), sr));
  if (on('hcOn')) sections.push(...cut(false, v('hcFreq'), order('hcSlope'), v('hcQ'), sr));
  return { sections, out: 10 ** (v('output') / 20) };
}

/** The curve (dB at each frequency), from the coefficients the engine runs. */
export function studioEqResponse(params: Record<string, number>, freqs: ArrayLike<number>, sr: number): Float64Array {
  const { sections, out } = studioEqSections(params, sr);
  const res = new Float64Array(freqs.length).fill(20 * Math.log10(out));
  for (const c of sections) {
    for (let i = 0; i < freqs.length; i++) {
      const w = (2 * Math.PI * (freqs[i] as number)) / sr;
      const c1 = Math.cos(w);
      const s1 = Math.sin(w);
      const c2 = Math.cos(2 * w);
      const s2 = Math.sin(2 * w);
      const nr = c.b0 + c.b1 * c1 + c.b2 * c2;
      const ni = -(c.b1 * s1 + c.b2 * s2);
      const dr = 1 + c.a1 * c1 + c.a2 * c2;
      const di = -(c.a1 * s1 + c.a2 * s2);
      res[i] = (res[i] as number) + 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-30);
    }
  }
  return res;
}

export class StudioEq implements Effect {
  gr = 0;
  /** Enough for both cuts at 48 dB, the shelves and the bells. */
  private readonly filters = Array.from({ length: 16 }, () => new Biquad());
  private count = 0;
  private out = 1;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const { sections, out } = studioEqSections(p, this.host.sr);
    // a section keeps its state while it's tuned; one switched on or off shifts those after it
    sections.forEach((c, i) => {
      const f = this.filters[i] as Biquad;
      f.b0 = c.b0;
      f.b1 = c.b1;
      f.b2 = c.b2;
      f.a1 = c.a1;
      f.a2 = c.a2;
    });
    for (let i = sections.length; i < this.count; i++) this.filters[i]?.reset();
    this.count = sections.length;
    this.out = out;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < this.count; i++) this.filters[i]?.process(l, r, n);
    const out = this.out;
    if (out !== 1) {
      for (let i = 0; i < n; i++) {
        l[i] = (l[i] as number) * out;
        r[i] = (r[i] as number) * out;
      }
    }
  }
  reset(): void {
    for (const f of this.filters) f.reset();
  }
}
