/**
 * Generated spaces: impulse responses made from a description (how long each frequency band rings,
 * the pre-delay, the early reflections and how the tail builds), as Hallowed Lanterns makes its halls.
 * Seeded, so a space is the same response every time and everywhere. Four paths (left to left, right
 * to right, and the cross paths a little quieter) from decorrelated noise.
 */

import type { ImpulseResponse } from './convolver.ts';
import { fft, ifft } from './fft.ts';

export interface SpaceDesign {
  /** Seconds to fall 60 dB in seven bands (edges 150, 400, 1000, 2500, 5000, 9000 Hz). */
  rt: number[];
  pre: number;
  /** Early reflections: how many, over how long, and how dull (0..1). */
  er: number;
  erSpan: number;
  erLp?: number;
  /** Seconds for the tail to build up. */
  build: number;
  length: number;
  /** Where the top rolls off, Hz. */
  hi: number;
  /** Clumpy, scattered tails (forests, fields), 0..1. */
  sparse?: number;
}

export const SPACES: Record<string, SpaceDesign> = {
  room: {
    rt: [0.7, 0.65, 0.6, 0.55, 0.45, 0.35, 0.25],
    pre: 0.006,
    er: 14,
    erSpan: 0.03,
    build: 0.01,
    length: 1.6,
    hi: 9000,
  },
  chamber: {
    rt: [1.6, 1.5, 1.35, 1.2, 0.95, 0.7, 0.45],
    pre: 0.012,
    er: 30,
    erSpan: 0.045,
    build: 0.02,
    length: 3.0,
    hi: 6500,
    erLp: 0.4,
  },
  hall: {
    rt: [2.6, 2.5, 2.3, 2.1, 1.7, 1.2, 0.8],
    pre: 0.018,
    er: 24,
    erSpan: 0.07,
    build: 0.035,
    length: 5.0,
    hi: 9000,
  },
  scoring: {
    rt: [2.9, 2.7, 2.4, 2.1, 1.7, 1.2, 0.8],
    pre: 0.022,
    er: 36,
    erSpan: 0.09,
    build: 0.03,
    length: 5.5,
    hi: 9000,
  },
  concert: {
    rt: [3.6, 3.4, 3.0, 2.6, 2.0, 1.35, 0.85],
    pre: 0.026,
    er: 34,
    erSpan: 0.09,
    build: 0.06,
    length: 8.0,
    hi: 5800,
    erLp: 0.5,
  },
  epic: {
    rt: [4.4, 4.1, 3.6, 3.0, 2.3, 1.5, 0.9],
    pre: 0.03,
    er: 40,
    erSpan: 0.12,
    build: 0.05,
    length: 7.5,
    hi: 8500,
  },
  cathedral: {
    rt: [5.5, 5.4, 5.0, 4.3, 3.2, 2.2, 1.4],
    pre: 0.035,
    er: 30,
    erSpan: 0.12,
    build: 0.07,
    length: 8.5,
    hi: 8000,
  },
  'dark cathedral': {
    rt: [6.2, 6.0, 5.2, 4.2, 3.0, 1.9, 1.1],
    pre: 0.038,
    er: 36,
    erSpan: 0.14,
    build: 0.1,
    length: 11.0,
    hi: 4800,
    erLp: 0.6,
  },
  plate: {
    rt: [3.2, 3.2, 3.0, 2.8, 2.4, 1.9, 1.3],
    pre: 0.004,
    er: 0,
    erSpan: 0.01,
    build: 0.005,
    length: 6.0,
    hi: 10000,
  },
  forest: {
    rt: [1.6, 1.6, 1.5, 1.3, 1.0, 0.7, 0.45],
    pre: 0.012,
    er: 22,
    erSpan: 0.09,
    build: 0.03,
    length: 3.2,
    hi: 7000,
    sparse: 0.5,
  },
  field: {
    rt: [2.2, 2.0, 1.6, 1.2, 0.8, 0.5, 0.3],
    pre: 0.02,
    er: 6,
    erSpan: 0.15,
    build: 0.05,
    length: 4.0,
    hi: 6000,
    sparse: 0.7,
  },
  underwater: {
    rt: [4.5, 4.2, 3.4, 2.2, 1.2, 0.6, 0.3],
    pre: 0.03,
    er: 10,
    erSpan: 0.08,
    build: 0.12,
    length: 7.0,
    hi: 3500,
  },
  sky: { rt: [7.5, 7.2, 6.8, 6.0, 4.8, 3.4, 2.2], pre: 0.06, er: 8, erSpan: 0.2, build: 0.25, length: 11.0, hi: 7500 },
};

/** The spaces in the order the plugin offers them. */
export const SPACE_NAMES = Object.keys(SPACES);

const EDGES = [150, 400, 1000, 2500, 5000, 9000];

/** A small, fast, seeded generator (sfc32), and normal deviates from it (Box–Muller). */
/** A seeded random source (sfc32), with normal draws: the same numbers wherever the engine runs. */
export class Random {
  private a: number;
  private b: number;
  private c: number;
  private d: number;
  private spare: number | null = null;
  constructor(seed: string) {
    let h = 1779033703 ^ seed.length;
    for (let i = 0; i < seed.length; i++) {
      h = Math.imul(h ^ seed.charCodeAt(i), 3432918353);
      h = (h << 13) | (h >>> 19);
    }
    const next = () => {
      h = Math.imul(h ^ (h >>> 16), 2246822507);
      h = Math.imul(h ^ (h >>> 13), 3266489909);
      h ^= h >>> 16;
      return h >>> 0;
    };
    this.a = next();
    this.b = next();
    this.c = next();
    this.d = next();
    for (let i = 0; i < 12; i++) this.uniform();
  }
  uniform(): number {
    const t = (((this.a + this.b) | 0) + this.d) | 0;
    this.d = (this.d + 1) | 0;
    this.a = this.b ^ (this.b >>> 9);
    this.b = (this.c + (this.c << 3)) | 0;
    this.c = (this.c << 21) | (this.c >>> 11);
    this.c = (this.c + t) | 0;
    return (t >>> 0) / 4294967296;
  }
  normal(): number {
    if (this.spare !== null) {
      const s = this.spare;
      this.spare = null;
      return s;
    }
    let u = 0;
    while (u === 0) u = this.uniform();
    const v = this.uniform();
    const r = Math.sqrt(-2 * Math.log(u));
    this.spare = r * Math.sin(2 * Math.PI * v);
    return r * Math.cos(2 * Math.PI * v);
  }
}

/** A space's impulse response at a rate; `decay` scales every band's time. */
export function generateSpace(name: string, seed: number, decay: number, rate: number): ImpulseResponse {
  const p = SPACES[name] ?? (SPACES.hall as SpaceDesign);
  const r = new Random(`space:${name}:${seed}`);
  const n = Math.round(p.length * Math.max(1, decay) * rate);
  let size = 1;
  while (size < n) size <<= 1;
  // the bands' shapes over frequency (soft edges on a log scale), summing to one
  const bins = size / 2 + 1;
  const masks: Float64Array[] = Array.from({ length: 7 }, () => new Float64Array(bins));
  const roll = new Float64Array(bins);
  for (let k = 0; k < bins; k++) {
    const f = (k * rate) / size;
    const lf = Math.log2(Math.max(f, 1));
    let total = 0;
    for (let b = 0; b < 7; b++) {
      let m = 1;
      if (b > 0) m *= 0.5 + 0.5 * Math.tanh((lf - Math.log2(EDGES[b - 1] as number)) * 4);
      if (b < 6) m *= 0.5 - 0.5 * Math.tanh((lf - Math.log2(EDGES[b] as number)) * 4);
      (masks[b] as Float64Array)[k] = m;
      total += m;
    }
    for (let b = 0; b < 7; b++) (masks[b] as Float64Array)[k] = ((masks[b] as Float64Array)[k] as number) / total;
    roll[k] = (1 / Math.sqrt(1 + (f / p.hi) ** 4)) * (1 / Math.sqrt(1 + (60 / Math.max(f, 1)) ** 4));
  }
  const pre = Math.round(p.pre * rate);
  const paths: Float32Array[] = [];
  for (let ch = 0; ch < 4; ch++) {
    // the noise, made clumpy for scattering spaces
    const nre = new Float64Array(size);
    const nim = new Float64Array(size);
    for (let i = 0; i < n; i++) nre[i] = r.normal();
    if (p.sparse) {
      // a slowly varying weight (30 points a second), its size twice its absolute value
      const step = Math.round(rate / 30);
      let a = r.normal();
      let b2 = r.normal();
      for (let i = 0; i < n; i++) {
        if (i % step === 0) {
          a = b2;
          b2 = r.normal();
        }
        const t = (i % step) / step;
        const w = Math.abs(a + (b2 - a) * t) * 2;
        nre[i] = (nre[i] as number) * (1 - p.sparse + p.sparse * w);
      }
    }
    fft(nre, nim);
    // each band rings out at its own rate; two bands per inverse transform (both are real)
    const late = new Float64Array(n);
    for (let b = 0; b < 7; b += 2) {
      const ma = masks[b] as Float64Array;
      const mb = (masks[b + 1] ?? null) as Float64Array | null;
      const re = new Float64Array(size);
      const im = new Float64Array(size);
      for (let k = 0; k < bins; k++) {
        const ga = (ma[k] as number) * (roll[k] as number);
        const gb = mb ? (mb[k] as number) * (roll[k] as number) : 0;
        const xr = nre[k] as number;
        const xi = nim[k] as number;
        // A·X + i·B·X, written over the whole spectrum
        re[k] = ga * xr - gb * xi;
        im[k] = ga * xi + gb * xr;
        if (k > 0 && k < size / 2) {
          // the mirrored bin of a real signal's spectrum is the conjugate
          re[size - k] = ga * xr + gb * xi;
          im[size - k] = -ga * xi + gb * xr;
        }
      }
      ifft(re, im);
      const rtA = (p.rt[b] as number) * decay;
      const rtB = mb ? (p.rt[b + 1] as number) * decay : 1;
      for (let i = 0; i < n; i++) {
        const t = i / rate;
        late[i] = (late[i] as number) + (re[i] as number) * Math.exp((-6.9078 * t) / rtA);
        if (mb) late[i] = (late[i] as number) + (im[i] as number) * Math.exp((-6.9078 * t) / rtB);
      }
    }
    for (let i = 0; i < n; i++) {
      const t = i / rate;
      late[i] = t < p.pre ? 0 : (late[i] as number) * (1 - Math.exp(-(t - p.pre) / p.build));
    }
    // early reflections after the pre-delay, thicker and duller as they go
    const er = new Float64Array(n);
    if (p.er) {
      const times: number[] = [];
      for (let k = 0; k < p.er; k++) times.push(p.pre + r.uniform() * p.erSpan * (1 + 0.25 * (ch % 2)));
      times.sort((x, y) => x - y);
      for (const d of times) {
        const i = Math.round(d * rate);
        const sign = r.uniform() < 0.5 ? -1 : 1;
        const amp = 0.35 + r.uniform() * 0.65;
        if (i < n) er[i] = (er[i] as number) + sign * amp * Math.exp(-(d - p.pre) / (p.erSpan * 0.8 + 1e-3));
      }
      const a = p.erLp ?? 0.35;
      let prev = 0;
      let y1 = 0;
      let y2 = 0;
      for (let i = 0; i < n; i++) {
        const x = er[i] as number;
        const avg = 0.5 * x + 0.5 * prev;
        prev = x;
        y1 = (1 - a) * avg + a * y1;
        y2 = (1 - a * 0.6) * y1 + a * 0.6 * y2;
        er[i] = y2;
      }
    }
    let le = 1e-12;
    let ee = 1e-12;
    for (let i = 0; i < n; i++) {
      le += (late[i] as number) ** 2;
      ee += (er[i] as number) ** 2;
    }
    le = Math.sqrt(le);
    ee = Math.sqrt(ee);
    const path = new Float32Array(n);
    const cross = ch >= 2 ? 0.8 : 1;
    const fade = Math.round(0.2 * rate);
    for (let i = 0; i < n; i++) {
      let v = (late[i] as number) / le + (p.er ? (0.45 * (er[i] as number)) / ee : 0);
      if (i < pre / 2) v = 0;
      if (i >= n - fade) v *= (n - i) / fade;
      path[i] = v * cross;
    }
    paths.push(path);
  }
  return {
    rate,
    ll: paths[0] as Float32Array,
    rr: paths[1] as Float32Array,
    lr: paths[2] as Float32Array,
    rl: paths[3] as Float32Array,
  };
}
