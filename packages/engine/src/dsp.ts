/** Small DSP building blocks for the audio thread. Nothing here allocates while audio runs. */

export const dbToGain = (db: number): number => (db <= -144 ? 0 : 10 ** (db / 20));
export const gainToDb = (g: number): number => (g <= 1e-9 ? -180 : 20 * Math.log10(g));

/** A one-pole smoother for parameters, so a moved fader never clicks. */
export class Smooth {
  value: number;
  target: number;
  private coef: number;
  constructor(value: number, sr: number, ms = 20) {
    this.value = value;
    this.target = value;
    this.coef = Math.exp(-1 / ((ms / 1000) * sr));
  }
  set(target: number, immediate = false): void {
    this.target = target;
    if (immediate) this.value = target;
  }
  next(): number {
    this.value = this.target + (this.value - this.target) * this.coef;
    return this.value;
  }
  get settled(): boolean {
    return Math.abs(this.value - this.target) < 1e-6;
  }
}

export type BiquadKind = 'lowpass' | 'highpass' | 'bandpass' | 'peak' | 'lowshelf' | 'highshelf' | 'notch';

/** RBJ-cookbook biquad, transposed direct form II, stereo. */
export class Biquad {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  private zl1 = 0;
  private zl2 = 0;
  private zr1 = 0;
  private zr2 = 0;

  set(kind: BiquadKind, freq: number, q: number, gainDb: number, sr: number): void {
    const f = Math.min(Math.max(freq, 5), sr * 0.49);
    const w = (2 * Math.PI * f) / sr;
    const cos = Math.cos(w);
    const sin = Math.sin(w);
    const A = 10 ** (gainDb / 40);
    const alpha = sin / (2 * Math.max(q, 0.01));
    let b0 = 1;
    let b1 = 0;
    let b2 = 0;
    let a0 = 1;
    let a1 = 0;
    let a2 = 0;
    switch (kind) {
      case 'lowpass':
        b0 = (1 - cos) / 2;
        b1 = 1 - cos;
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'highpass':
        b0 = (1 + cos) / 2;
        b1 = -(1 + cos);
        b2 = b0;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'bandpass':
        b0 = alpha;
        b1 = 0;
        b2 = -alpha;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'notch':
        b0 = 1;
        b1 = -2 * cos;
        b2 = 1;
        a0 = 1 + alpha;
        a1 = -2 * cos;
        a2 = 1 - alpha;
        break;
      case 'peak':
        b0 = 1 + alpha * A;
        b1 = -2 * cos;
        b2 = 1 - alpha * A;
        a0 = 1 + alpha / A;
        a1 = -2 * cos;
        a2 = 1 - alpha / A;
        break;
      case 'lowshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 - (A - 1) * cos + s);
        b1 = 2 * A * (A - 1 - (A + 1) * cos);
        b2 = A * (A + 1 - (A - 1) * cos - s);
        a0 = A + 1 + (A - 1) * cos + s;
        a1 = -2 * (A - 1 + (A + 1) * cos);
        a2 = A + 1 + (A - 1) * cos - s;
        break;
      }
      case 'highshelf': {
        const s = 2 * Math.sqrt(A) * alpha;
        b0 = A * (A + 1 + (A - 1) * cos + s);
        b1 = -2 * A * (A - 1 + (A + 1) * cos);
        b2 = A * (A + 1 + (A - 1) * cos - s);
        a0 = A + 1 - (A - 1) * cos + s;
        a1 = 2 * (A - 1 - (A + 1) * cos);
        a2 = A + 1 - (A - 1) * cos - s;
        break;
      }
    }
    this.b0 = b0 / a0;
    this.b1 = b1 / a0;
    this.b2 = b2 / a0;
    this.a1 = a1 / a0;
    this.a2 = a2 / a0;
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const { b0, b1, b2, a1, a2 } = this;
    let zl1 = this.zl1;
    let zl2 = this.zl2;
    let zr1 = this.zr1;
    let zr2 = this.zr2;
    for (let i = 0; i < n; i++) {
      const xl = l[i] as number;
      const yl = b0 * xl + zl1;
      zl1 = b1 * xl - a1 * yl + zl2;
      zl2 = b2 * xl - a2 * yl;
      l[i] = yl;
      const xr = r[i] as number;
      const yr = b0 * xr + zr1;
      zr1 = b1 * xr - a1 * yr + zr2;
      zr2 = b2 * xr - a2 * yr;
      r[i] = yr;
    }
    // flush denormals
    this.zl1 = Math.abs(zl1) < 1e-20 ? 0 : zl1;
    this.zl2 = Math.abs(zl2) < 1e-20 ? 0 : zl2;
    this.zr1 = Math.abs(zr1) < 1e-20 ? 0 : zr1;
    this.zr2 = Math.abs(zr2) < 1e-20 ? 0 : zr2;
  }

  /** One sample, mono (for filters inside a voice). */
  tick(x: number): number {
    const y = this.b0 * x + this.zl1;
    this.zl1 = this.b1 * x - this.a1 * y + this.zl2;
    this.zl2 = this.b2 * x - this.a2 * y;
    return y;
  }

  reset(): void {
    this.zl1 = this.zl2 = this.zr1 = this.zr2 = 0;
  }
}

/** A delay line with fractional (linear) reads. */
export class DelayLine {
  readonly buf: Float32Array;
  private w = 0;
  constructor(size: number) {
    this.buf = new Float32Array(Math.max(4, size));
  }
  write(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) % this.buf.length;
  }
  /** `d` samples ago (≥ 1). */
  read(d: number): number {
    const len = this.buf.length;
    const pos = this.w - d;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[((i % len) + len) % len] as number;
    const b = this.buf[(((i + 1) % len) + len) % len] as number;
    return a + (b - a) * f;
  }
  clear(): void {
    this.buf.fill(0);
  }
}

/**
 * Zavalishin's topology-preserving state-variable filter: stays stable while its cutoff moves every
 * sample, so it suits synth voices.
 */
export class Svf {
  private ic1 = 0;
  private ic2 = 0;
  lp = 0;
  bp = 0;
  hp = 0;
  run(x: number, cutoff: number, res: number, sr: number): number {
    const g = Math.tan((Math.PI * Math.min(cutoff, sr * 0.45)) / sr);
    const k = 2 - 2 * Math.min(res, 0.98);
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.lp = v2;
    this.bp = v1;
    this.hp = x - k * v1 - v2;
    return v2;
  }
  reset(): void {
    this.ic1 = this.ic2 = 0;
  }
}

/** A fast, seeded noise source (xorshift), −1..1. */
export class Noise {
  private s: number;
  constructor(seed = 22222) {
    this.s = seed | 0 || 1;
  }
  next(): number {
    let s = this.s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.s = s;
    return (s | 0) / 2147483648;
  }
}

/** Four-point, third-order Hermite interpolation. */
export function hermite(xm1: number, x0: number, x1: number, x2: number, t: number): number {
  const c = (x1 - xm1) * 0.5;
  const v = x0 - x1;
  const w = c + v;
  const a = w + v + (x2 - x0) * 0.5;
  const b = w + a;
  return ((a * t - b) * t + c) * t + x0;
}
