/**
 * The FFT the engine's convolution uses: iterative, in place, on separate real and imaginary arrays,
 * with its tables made once per size. Pairs of radix-2 stages run as one radix-4 pass (half the trips
 * through memory), each pass with its twiddles laid out in the order it reads them. The same
 * arithmetic everywhere the engine runs.
 *
 * A transform is a run of stages (the bit reversal, then each pass), and a caller may run them one at
 * a time (`fftStage`) across several audio blocks: the stages touch the arrays in the same order
 * either way, so a transform in pieces is the same numbers as one in a go.
 */

interface Pass {
  /** The first of the pair's stage lengths (the second is twice it). */
  len: number;
  /** W_len^k and W_2len^k for k below len/2. */
  w1r: Float64Array;
  w1i: Float64Array;
  w2r: Float64Array;
  w2i: Float64Array;
}

export interface FftPlan {
  size: number;
  rev: Uint32Array;
  /** An odd number of stages: the first (length 2, no twiddles) runs alone. */
  single: boolean;
  passes: Pass[];
  /** How many stages a transform of this size is: the bit reversal, the single stage if any, then the passes. */
  stages: number;
}

const plans = new Map<number, FftPlan>();

export function fftPlan(size: number): FftPlan {
  let p = plans.get(size);
  if (p) return p;
  if (size & (size - 1)) throw new Error(`FFT size ${size} is not a power of two`);
  const bits = Math.log2(size);
  const rev = new Uint32Array(size);
  for (let i = 0; i < size; i++) {
    let r = 0;
    for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
    rev[i] = r;
  }
  const single = bits % 2 === 1;
  const passes: Pass[] = [];
  for (let len = single ? 4 : 2; len < size; len *= 4) {
    const q = len / 2;
    const w1r = new Float64Array(q);
    const w1i = new Float64Array(q);
    const w2r = new Float64Array(q);
    const w2i = new Float64Array(q);
    for (let k = 0; k < q; k++) {
      w1r[k] = Math.cos((2 * Math.PI * k) / len);
      w1i[k] = -Math.sin((2 * Math.PI * k) / len);
      w2r[k] = Math.cos((2 * Math.PI * k) / (2 * len));
      w2i[k] = -Math.sin((2 * Math.PI * k) / (2 * len));
    }
    passes.push({ len, w1r, w1i, w2r, w2i });
  }
  p = { size, rev, single, passes, stages: 1 + (single ? 1 : 0) + passes.length };
  plans.set(size, p);
  return p;
}

/** Stage `stage` of the forward transform (0 to plan.stages − 1, in order) in place, no scaling. */
export function fftStage(plan: FftPlan, stage: number, re: Float64Array, im: Float64Array): void {
  const n = plan.size;
  if (n < 2) return;
  if (stage === 0) {
    const rev = plan.rev;
    for (let i = 0; i < n; i++) {
      const j = rev[i] as number;
      if (j > i) {
        const tr = re[i] as number;
        re[i] = re[j] as number;
        re[j] = tr;
        const ti = im[i] as number;
        im[i] = im[j] as number;
        im[j] = ti;
      }
    }
    return;
  }
  let pass = stage - 1;
  if (plan.single) {
    if (pass === 0) {
      for (let a = 0; a < n; a += 2) {
        const xr = re[a + 1] as number;
        const xi = im[a + 1] as number;
        re[a + 1] = (re[a] as number) - xr;
        im[a + 1] = (im[a] as number) - xi;
        re[a] = (re[a] as number) + xr;
        im[a] = (im[a] as number) + xi;
      }
      return;
    }
    pass--;
  }
  const { len, w1r, w1i, w2r, w2i } = plan.passes[pass] as Pass;
  const q = len / 2;
  for (let start = 0; start < n; start += 2 * len) {
    for (let k = 0; k < q; k++) {
      const a0 = start + k;
      const a1 = a0 + q;
      const a2 = a0 + len;
      const a3 = a2 + q;
      const ar = w1r[k] as number;
      const ai = w1i[k] as number;
      // the first stage: (a0, a1) and (a2, a3), each by W_len^k
      const b1r = (re[a1] as number) * ar - (im[a1] as number) * ai;
      const b1i = (re[a1] as number) * ai + (im[a1] as number) * ar;
      const b3r = (re[a3] as number) * ar - (im[a3] as number) * ai;
      const b3i = (re[a3] as number) * ai + (im[a3] as number) * ar;
      const t0r = (re[a0] as number) + b1r;
      const t0i = (im[a0] as number) + b1i;
      const t1r = (re[a0] as number) - b1r;
      const t1i = (im[a0] as number) - b1i;
      const t2r = (re[a2] as number) + b3r;
      const t2i = (im[a2] as number) + b3i;
      const t3r = (re[a2] as number) - b3r;
      const t3i = (im[a2] as number) - b3i;
      // the second: (a0, a2) by W_2len^k, (a1, a3) by W_2len^(k + len/2) = −i · W_2len^k
      const cr = w2r[k] as number;
      const ci = w2i[k] as number;
      const u2r = t2r * cr - t2i * ci;
      const u2i = t2r * ci + t2i * cr;
      const v3r = t3r * cr - t3i * ci;
      const v3i = t3r * ci + t3i * cr;
      // −i · (v3r + i v3i) = v3i − i v3r
      re[a0] = t0r + u2r;
      im[a0] = t0i + u2i;
      re[a2] = t0r - u2r;
      im[a2] = t0i - u2i;
      re[a1] = t1r + v3i;
      im[a1] = t1i - v3r;
      re[a3] = t1r - v3i;
      im[a3] = t1i + v3r;
    }
  }
}

/** Forward transform in place (no scaling): every stage, one after the other. */
export function fft(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  if (n < 2) return;
  const plan = fftPlan(n);
  for (let s = 0; s < plan.stages; s++) fftStage(plan, s, re, im);
}

/** The inverse's scaling by 1/n (its stages are the forward transform's with real and imaginary swapped). */
export function ifftScale(re: Float64Array, im: Float64Array): void {
  const n = re.length;
  const s = 1 / n;
  for (let i = 0; i < n; i++) {
    re[i] = (re[i] as number) * s;
    im[i] = (im[i] as number) * s;
  }
}

/** Inverse transform in place, scaled by 1/n (the forward transform with real and imaginary swapped). */
export function ifft(re: Float64Array, im: Float64Array): void {
  fft(im, re);
  ifftScale(re, im);
}
