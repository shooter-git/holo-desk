/**
 * Convolution: a true-stereo impulse response (left to left, right to right, and the two cross
 * paths) played by partitioned convolution, the same arithmetic live, in bounces and headless.
 *
 * The response is cut into segments. The first 128 taps are convolved directly; then uniform blocks
 * of 128 (to 2176 taps), 1024 (to 32896) and 16384 samples (to the end) in the frequency domain. A
 * big block's work (its transforms, stage by stage, and its multiply-adds) is spread over the audio
 * blocks of its period, so a long hall never makes one block slow. The convolver's output starts at
 * once: there is no added latency.
 *
 * Preparing a response (its segments' spectra) is the heavy part and happens once, away from the
 * audio thread; a Convolver made from the prepared data is cheap.
 */
import { type FftPlan, fft, fftPlan, fftStage, ifftScale } from './fft.ts';

export const BLOCK = 128;

/** A response as four paths (stereo responses have no cross paths; a mono one is used for both). */
export interface ImpulseResponse {
  rate: number;
  ll: Float32Array;
  rr: Float32Array;
  lr: Float32Array | null;
  rl: Float32Array | null;
}

/**
 * One segment: blocks of `size` from tap `start`, `parts` of them. Each path's spectra are laid out
 * bin by bin, the parts side by side ([bin][part][re, im]), so a bin's sum over the parts reads one
 * run of memory.
 */
interface PreparedSegment {
  size: number;
  start: number;
  parts: number;
  ll: Float32Array;
  rr: Float32Array;
  lr: Float32Array | null;
  rl: Float32Array | null;
}

export interface PreparedImpulse {
  rate: number;
  length: number;
  /** The first BLOCK taps, convolved directly (null when they're all silent). */
  head: { ll: Float32Array; rr: Float32Array; lr: Float32Array | null; rl: Float32Array | null } | null;
  segments: PreparedSegment[];
}

/** The segments: [start, size] in order, each block size starting at least twice its size in. */
const PLAN: [number, number][] = [
  [BLOCK, BLOCK],
  [2176, 1024],
  [32896, 16384],
];
const ENDS = [2176, 32896, Number.POSITIVE_INFINITY];

function spectra(path: Float32Array, start: number, size: number, parts: number): Float32Array {
  const m = size * 2;
  const bins = size + 1;
  const out = new Float32Array(bins * parts * 2);
  const re = new Float64Array(m);
  const im = new Float64Array(m);
  for (let p = 0; p < parts; p++) {
    re.fill(0);
    im.fill(0);
    const from = start + p * size;
    const to = Math.min(path.length, from + size);
    for (let i = from; i < to; i++) re[i - from] = path[i] as number;
    fft(re, im);
    for (let k = 0; k < bins; k++) {
      out[(k * parts + p) * 2] = re[k] as number;
      out[(k * parts + p) * 2 + 1] = im[k] as number;
    }
  }
  return out;
}

export function prepareImpulse(ir: ImpulseResponse): PreparedImpulse {
  const length = Math.max(ir.ll.length, ir.rr.length, ir.lr?.length ?? 0, ir.rl?.length ?? 0);
  const paths = [ir.ll, ir.rr, ir.lr, ir.rl];
  const headOf = (p: Float32Array | null) => (p ? p.slice(0, BLOCK) : null);
  const silent = paths.every((p) => !p || p.subarray(0, BLOCK).every((v) => v === 0));
  const segments: PreparedSegment[] = [];
  PLAN.forEach(([start, size], i) => {
    if (start >= length) return;
    const end = Math.min(length, ENDS[i] as number);
    const parts = Math.ceil((end - start) / size);
    segments.push({
      size,
      start,
      parts,
      ll: spectra(ir.ll, start, size, parts),
      rr: spectra(ir.rr, start, size, parts),
      lr: ir.lr ? spectra(ir.lr, start, size, parts) : null,
      rl: ir.rl ? spectra(ir.rl, start, size, parts) : null,
    });
  });
  return {
    rate: ir.rate,
    length,
    head: silent
      ? null
      : {
          ll: headOf(ir.ll) as Float32Array,
          rr: headOf(ir.rr) as Float32Array,
          lr: headOf(ir.lr),
          rl: headOf(ir.rl),
        },
    segments,
  };
}

/** Every array a prepared response holds (to hand it to another thread without copying). */
export function impulseBuffers(p: PreparedImpulse): ArrayBuffer[] {
  const out: ArrayBuffer[] = [];
  const add = (a: Float32Array | null) => a && out.push(a.buffer as ArrayBuffer);
  if (p.head) [p.head.ll, p.head.rr, p.head.lr, p.head.rl].forEach(add);
  for (const s of p.segments) [s.ll, s.rr, s.lr, s.rl].forEach(add);
  return out;
}

/** One segment's running state. */
class Segment {
  readonly size: number;
  readonly start: number;
  private readonly d: PreparedSegment;
  private readonly m: number;
  private readonly bins: number;
  private readonly perPeriod: number;
  private readonly plan: FftPlan;
  /** The last 2·size input samples, as the period's transform needs them. */
  private readonly histL: Float64Array;
  private readonly histR: Float64Array;
  private fill = 0;
  /** The inputs' spectra for the last `parts` periods, bin by bin ([bin][slot][re, im]; newest at `newest`). */
  private readonly xL: Float64Array;
  private readonly xR: Float64Array;
  private newest = 0;
  private periods = 0;
  /** The forward transform's arrays, and the inverse's (the period's sum, filled bin by bin). */
  private readonly fre: Float64Array;
  private readonly fim: Float64Array;
  private readonly re: Float64Array;
  private readonly im: Float64Array;
  private cross = 0;
  /** Output waiting for its time, as a ring. */
  private readonly outL: Float64Array;
  private readonly outR: Float64Array;
  private readonly mask: number;
  /** The period whose work is under way, how many blocks in, and how far its sum has got (in bins). */
  private job = -1;
  private jobBlock = 0;
  private jobBin = 0;
  /**
   * A period's work as units of about equal size, in order: the forward transform's stages, its
   * spectrum taken, the sum (`sumUnits` of them), the inverse's stages, then its scaling and the
   * output. Each block of the period after the one that completes it does the units from
   * `unitFrom[block]` to `unitTo[block]`.
   */
  private readonly sumUnits: number;
  private readonly units: number;
  private readonly unitFrom: Int32Array;
  private readonly unitTo: Int32Array;

  constructor(d: PreparedSegment) {
    this.d = d;
    this.size = d.size;
    this.start = d.start;
    this.m = d.size * 2;
    this.bins = d.size + 1;
    this.perPeriod = d.size / BLOCK;
    this.plan = fftPlan(this.m);
    this.histL = new Float64Array(this.m);
    this.histR = new Float64Array(this.m);
    this.xL = new Float64Array(this.bins * d.parts * 2);
    this.xR = new Float64Array(this.bins * d.parts * 2);
    this.fre = new Float64Array(this.m);
    this.fim = new Float64Array(this.m);
    this.re = new Float64Array(this.m);
    this.im = new Float64Array(this.m);
    let ring = 1;
    while (ring < d.start + this.m * 2 + BLOCK) ring <<= 1;
    this.outL = new Float64Array(ring);
    this.outR = new Float64Array(ring);
    this.mask = ring - 1;
    // the period's output is first due a whole period after it completes (its segment starts at
    // least two sizes in), so its work has the period's remaining blocks: the fixed units one to a
    // block where there's room, the sum over whatever blocks are left (and in pieces over half the
    // blocks at least, where the fixed units already come more than one to a block)
    const fixed = this.plan.stages * 2 + 2;
    const blocks = this.perPeriod - 1;
    this.sumUnits = Math.max(1, blocks - fixed, Math.ceil(blocks / 2));
    this.units = fixed + this.sumUnits;
    this.unitFrom = new Int32Array(this.perPeriod);
    this.unitTo = new Int32Array(this.perPeriod);
    for (let b = 1; b < this.perPeriod; b++) {
      this.unitFrom[b] = Math.floor(((b - 1) * this.units) / blocks);
      this.unitTo[b] = Math.floor((b * this.units) / blocks);
    }
  }

  /** Take one block of input (block number `b`); do this block's share of the work. */
  run(inL: Float32Array, inR: Float32Array, b: number, cross: number): void {
    // the input, into the second half of the history
    const half = this.size;
    const at = half + this.fill;
    for (let i = 0; i < BLOCK; i++) {
      this.histL[at + i] = inL[i] as number;
      this.histR[at + i] = inR[i] as number;
    }
    this.fill += BLOCK;
    if (this.fill === half) {
      // a period is complete: its transform's input (both channels in one transform), then shift the history
      const { fre: re, fim: im, m } = this;
      const parts = this.d.parts;
      for (let i = 0; i < m; i++) {
        re[i] = this.histL[i] as number;
        im[i] = this.histR[i] as number;
      }
      this.newest = (this.newest + parts - 1) % parts;
      this.histL.copyWithin(0, half, m);
      this.histR.copyWithin(0, half, m);
      this.fill = 0;
      this.job = this.periods++;
      this.jobBlock = 0;
      this.jobBin = 0;
      this.cross = cross;
      if (this.perPeriod === 1) this.work(0, this.units);
      return;
    }
    if (this.job < 0) return;
    this.jobBlock++;
    this.work(this.unitFrom[this.jobBlock] as number, this.unitTo[this.jobBlock] as number);
    void b;
  }

  /** Units `from` to `to` of the period's work. */
  private work(from: number, to: number): void {
    const stages = this.plan.stages;
    const sumUnits = this.sumUnits;
    for (let u = from; u < to; u++) {
      if (u < stages) fftStage(this.plan, u, this.fre, this.fim);
      else if (u === stages) this.spectrum();
      else if (u <= stages + sumUnits) {
        // the sum's share: as far through the bins as this unit's place in it
        this.sum(Math.ceil((this.bins * (u - stages)) / sumUnits) - this.jobBin);
      } else {
        const s = u - stages - sumUnits - 1;
        // (the inverse transform: the forward one with real and imaginary swapped)
        if (s < stages) fftStage(this.plan, s, this.im, this.re);
        else this.finish();
      }
    }
  }

  /** The period's spectrum, into its slot: the two channels' halves of the one transform. */
  private spectrum(): void {
    const { fre: re, fim: im, m, xL, xR } = this;
    const half = this.size;
    const parts = this.d.parts;
    for (let k = 0; k <= half; k++) {
      const j = (m - k) % m;
      const a = re[k] as number;
      const bb = im[k] as number;
      const c = re[j] as number;
      const d = im[j] as number;
      const at2 = (k * parts + this.newest) * 2;
      xL[at2] = (a + c) / 2;
      xL[at2 + 1] = (bb - d) / 2;
      xR[at2] = (bb + d) / 2;
      xR[at2 + 1] = (c - a) / 2;
    }
  }

  /**
   * `count` more bins of the period's sum: each bin's products over the parts (newest input with the
   * response's first part, and so on back), the four paths held apart until the cross bleed joins
   * them, then laid into the inverse transform as Z = YL + i·YR (and its mirror above half).
   */
  private sum(count: number): void {
    const d = this.d;
    const parts = d.parts;
    const end = Math.min(this.bins, this.jobBin + count);
    const { xL, xR, re, im, m } = this;
    const half = this.size;
    const { ll, rr } = d;
    const rl = d.rl;
    const lr = d.lr;
    const crossed = rl !== null && lr !== null;
    const cross = crossed ? this.cross : 0;
    // the newest input's slot onwards pairs with the response's parts from 0; then the older slots wrap
    const first = parts - this.newest;
    for (let k = this.jobBin; k < end; k++) {
      const base = k * parts * 2;
      let lRe = 0;
      let lIm = 0;
      let rRe = 0;
      let rIm = 0;
      let lcRe = 0;
      let lcIm = 0;
      let rcRe = 0;
      let rcIm = 0;
      // two runs: the response's parts from 0 with the slots from the newest, then with the slots from 0
      for (let run = 0; run < 2; run++) {
        const p0 = run === 0 ? 0 : first;
        const p1 = run === 0 ? first : parts;
        const shift = run === 0 ? this.newest * 2 : -first * 2;
        if (crossed) {
          const rlh = rl as Float32Array;
          const lrh = lr as Float32Array;
          for (let hi = base + p0 * 2, xi = hi + shift, stop = base + p1 * 2; hi < stop; hi += 2, xi += 2) {
            const ar = xL[xi] as number;
            const ai = xL[xi + 1] as number;
            const br = xR[xi] as number;
            const bi = xR[xi + 1] as number;
            const llr = ll[hi] as number;
            const lli = ll[hi + 1] as number;
            const rrr = rr[hi] as number;
            const rri = rr[hi + 1] as number;
            const rlr = rlh[hi] as number;
            const rli = rlh[hi + 1] as number;
            const lrr = lrh[hi] as number;
            const lri = lrh[hi + 1] as number;
            lRe += ar * llr - ai * lli;
            lIm += ar * lli + ai * llr;
            rRe += br * rrr - bi * rri;
            rIm += br * rri + bi * rrr;
            // left out hears the right input through RL; right out hears the left through LR
            lcRe += br * rlr - bi * rli;
            lcIm += br * rli + bi * rlr;
            rcRe += ar * lrr - ai * lri;
            rcIm += ar * lri + ai * lrr;
          }
        } else {
          for (let hi = base + p0 * 2, xi = hi + shift, stop = base + p1 * 2; hi < stop; hi += 2, xi += 2) {
            const ar = xL[xi] as number;
            const ai = xL[xi + 1] as number;
            const br = xR[xi] as number;
            const bi = xR[xi + 1] as number;
            const llr = ll[hi] as number;
            const lli = ll[hi + 1] as number;
            const rrr = rr[hi] as number;
            const rri = rr[hi + 1] as number;
            lRe += ar * llr - ai * lli;
            lIm += ar * lli + ai * llr;
            rRe += br * rrr - bi * rri;
            rIm += br * rri + bi * rrr;
          }
        }
      }
      let yl = lRe;
      let yli = lIm;
      let yr = rRe;
      let yri = rIm;
      if (crossed && cross !== 0) {
        yl += cross * lcRe;
        yli += cross * lcIm;
        yr += cross * rcRe;
        yri += cross * rcIm;
      }
      // Z = YL + i·YR on the bins up to half; the rest follow from the outputs being real
      re[k] = yl - yri;
      im[k] = yli + yr;
      if (k > 0 && k < half) {
        re[m - k] = yl + yri;
        im[m - k] = -yli + yr;
      }
    }
    this.jobBin = end;
  }

  /** The period's sum, back in time (its stages done), scaled and into the output ring. */
  private finish(): void {
    const { re, im } = this;
    const half = this.size;
    ifftScale(re, im);
    // outputs for the period that ended `job`: from its start, `start` samples later
    const t0 = this.job * this.size + this.start;
    for (let i = 0; i < half; i++) {
      const at = (t0 + i) & this.mask;
      this.outL[at] = re[half + i] as number;
      this.outR[at] = im[half + i] as number;
    }
    this.job = -1;
  }

  /** Add this block's output (block number `b`) and clear it from the ring. */
  read(outL: Float32Array, outR: Float32Array, b: number): void {
    const t0 = b * BLOCK;
    for (let i = 0; i < BLOCK; i++) {
      const at = (t0 + i) & this.mask;
      outL[i] = (outL[i] as number) + (this.outL[at] as number);
      outR[i] = (outR[i] as number) + (this.outR[at] as number);
      this.outL[at] = 0;
      this.outR[at] = 0;
    }
  }
}

export class Convolver {
  readonly rate: number;
  private readonly head: PreparedImpulse['head'];
  private readonly segments: Segment[];
  private readonly histL = new Float64Array(BLOCK * 2);
  private readonly histR = new Float64Array(BLOCK * 2);
  private block = 0;

  constructor(p: PreparedImpulse) {
    this.rate = p.rate;
    this.head = p.head;
    this.segments = p.segments.map((s) => new Segment(s));
  }

  /** One block of exactly BLOCK samples: the wet signal into outL/outR (overwritten). */
  process(inL: Float32Array, inR: Float32Array, outL: Float32Array, outR: Float32Array, cross: number): void {
    const b = this.block++;
    outL.fill(0, 0, BLOCK);
    outR.fill(0, 0, BLOCK);
    // the first taps, directly
    if (this.head) {
      const { ll, rr, lr, rl } = this.head;
      this.histL.copyWithin(0, BLOCK);
      this.histR.copyWithin(0, BLOCK);
      for (let i = 0; i < BLOCK; i++) {
        this.histL[BLOCK + i] = inL[i] as number;
        this.histR[BLOCK + i] = inR[i] as number;
      }
      for (let i = 0; i < BLOCK; i++) {
        let l = 0;
        let r = 0;
        let lc = 0;
        let rc = 0;
        const now = BLOCK + i;
        for (let j = 0; j < BLOCK; j++) {
          const xl = this.histL[now - j] as number;
          const xr = this.histR[now - j] as number;
          l += xl * (ll[j] as number);
          r += xr * (rr[j] as number);
          if (rl && lr) {
            lc += xr * (rl[j] as number);
            rc += xl * (lr[j] as number);
          }
        }
        outL[i] = l + cross * lc;
        outR[i] = r + cross * rc;
      }
    }
    for (const s of this.segments) {
      s.run(inL, inR, b, cross);
      s.read(outL, outR, b);
    }
  }
}
