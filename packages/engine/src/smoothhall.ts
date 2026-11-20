/**
 * Smooth Hall: a soft, even hall with few settings.
 *
 * The sound (both sides together) waits out the pre-delay, loses its rumble and its glare (Low Cut,
 * High Cut), and is spread by four diffusers in a row. Then it circles a figure eight: two loops,
 * each a slowly moving diffuser, a delay, a damping low-pass, a second diffuser and a second delay,
 * each one feeding the other. The two loops' diffusers move out of step (more with Spread), so the
 * tail never settles into a pitch, and their lengths grow with Size. Decay sets how much of the sound
 * comes round each time; Density how strongly the diffusers smear it. Each side takes its sound from
 * several points along both loops.
 */
import { paramValue } from '@holo/session';
import type { Effect, Host } from './fx.ts';

/** The input diffusers (ms at the middle size) and their strengths. */
const INPUT = [4.1, 3.3, 11.9, 8.7];
const INPUT_GAIN = [0.74, 0.74, 0.62, 0.62];
/** Each loop's moving diffuser, first delay, second diffuser and second delay (ms at the middle size). */
const LOOPS = [
  [23.3, 143.1, 61.7, 118.9],
  [31.1, 137.3, 89.3, 101.9],
];
/**
 * The output taps (ms at the middle size), each side's: twice into the other loop's first delay, once
 * into its second diffuser (taken away), once into this loop's second delay (taken away).
 */
const TAPS_LEFT = [8.9, 99.4, 64.3, 67.0];
const TAPS_RIGHT = [11.3, 121.7, 41.2, 70.1];

/** A delay line a power of two long. */
class Line {
  readonly buf: Float32Array;
  readonly mask: number;
  w = 0;
  constructor(frames: number) {
    let size = 16;
    while (size < frames + 4) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }
  clear(): void {
    this.buf.fill(0);
  }
}

function onePole(f: number, sr: number): number {
  const k = Math.tan((Math.PI * Math.min(f, sr * 0.49)) / sr);
  return k / (1 + k);
}

/** Size's stretch of every length: half to one and a half times the middle size. */
const stretch = (size: number) => 0.5 + size / 100;

/** The decay (RT60, s) the hall rings with at each of `freqs`: Decay, shortened above High Cut by the loops' damping. */
export function hallDecay(params: Record<string, number>, freqs: ArrayLike<number>, sr = 48000): Float64Array {
  const v = (id: string) => paramValue('smoothhall', params, id);
  const decay = v('decay');
  const c = onePole(v('highcut'), sr);
  const loop = (LOOPS[0] as number[]).reduce((s, ms) => s + ms, 0) * stretch(v('size')) * 0.001;
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const w = (2 * Math.PI * (freqs[i] as number)) / sr;
    // the damping one-pole's loss at f, once a loop
    const re = 1 - (1 - c) * Math.cos(w);
    const im = (1 - c) * Math.sin(w);
    const mag = c / Math.sqrt(re * re + im * im);
    const lossDb = -20 * Math.log10(Math.max(1e-6, mag));
    out[i] = 60 / (60 / decay + lossDb / loop);
  }
  return out;
}

export class SmoothHall implements Effect {
  gr = 0;
  private readonly pre: Line;
  private readonly input: Line[];
  private readonly parts: Line[];
  private readonly host: Host;
  private preFrames = 1;
  private readonly inLen = new Int32Array(4);
  private readonly inGain = new Float64Array(4);
  /** Per loop: moving diffuser, delay, diffuser, delay lengths. */
  private readonly len = new Int32Array(8);
  private readonly taps = new Int32Array(8);
  private g1 = 0.7;
  private g2 = 0.5;
  private decay = 0.5;
  private lc = 0;
  private hc = 1;
  private damp = 0.3;
  private depth = 0;
  private width = 1;
  private dry = 1;
  private wet = 0.25;
  private hpIn = 0;
  private lpIn = 0;
  private dampA = 0;
  private dampB = 0;
  private endA = 0;
  private endB = 0;
  private oc = 1;
  private os = 0;
  private rc = 1;
  private rs = 0;
  /** The second loop's drift, out of step with the first. */
  private skewC = 1;
  private skewS = 0;
  constructor(host: Host) {
    this.host = host;
    const sr = host.sr;
    this.pre = new Line(Math.ceil(sr * 0.21));
    this.input = INPUT.map((ms) => new Line(Math.ceil((ms / 1000) * sr * 1.6)));
    this.parts = (LOOPS.flat() as number[]).map((ms) => new Line(Math.ceil((ms / 1000) * sr * 1.6) + 128));
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('smoothhall', p, id);
    const sr = this.host.sr;
    const k = stretch(v('size'));
    this.preFrames = Math.max(0, Math.round((v('predelay') / 1000) * sr));
    INPUT.forEach((ms, i) => {
      this.inLen[i] = Math.max(1, Math.round((ms / 1000) * sr * k));
      this.inGain[i] = (INPUT_GAIN[i] as number) * (0.4 + 0.6 * (v('density') / 100));
    });
    (LOOPS.flat() as number[]).forEach((ms, i) => {
      this.len[i] = Math.max(1, Math.round((ms / 1000) * sr * k));
    });
    [...TAPS_LEFT, ...TAPS_RIGHT].forEach((ms, i) => {
      this.taps[i] = Math.max(1, Math.round((ms / 1000) * sr * k));
    });
    const density = v('density') / 100;
    this.g1 = 0.45 + 0.27 * density;
    this.g2 = 0.3 + 0.25 * density;
    // one loop's length, and what's left of the sound after it for the decay asked (taken twice a loop)
    const loop = (LOOPS[0] as number[]).reduce((s, ms) => s + ms, 0) * k * 0.001;
    this.decay = 10 ** ((-1.5 * loop) / v('decay'));
    this.lc = onePole(v('lowcut'), sr);
    this.hc = onePole(Math.min(20000, v('highcut') * 1.4), sr);
    this.damp = onePole(v('highcut'), sr);
    this.depth = (v('modDepth') / 100) * 0.0011 * sr;
    const turn = (2 * Math.PI * v('modRate')) / sr;
    this.rc = Math.cos(turn);
    this.rs = Math.sin(turn);
    const skew = (Math.PI / 2) * (0.25 + 0.75 * (v('spread') / 100));
    this.skewC = Math.cos(skew);
    this.skewS = Math.sin(skew);
    this.width = v('spread') / 100;
    const dry = v('dry');
    const wet = v('wet');
    this.dry = dry <= -60 ? 0 : 10 ** (dry / 20);
    this.wet = wet <= -60 ? 0 : 10 ** (wet / 20);
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const { pre, input, parts, inLen, inGain, len, taps, g1, g2, decay, lc, hc, damp, depth, width, dry, wet } = this;
    const { rc, rs, skewC, skewS, preFrames } = this;
    let { hpIn, lpIn, dampA, dampB, endA, endB, oc, os } = this;
    const pm = pre.mask;
    const p0 = parts[0] as Line;
    const p1 = parts[1] as Line;
    const p2 = parts[2] as Line;
    const p3 = parts[3] as Line;
    const p4 = parts[4] as Line;
    const p5 = parts[5] as Line;
    const p6 = parts[6] as Line;
    const p7 = parts[7] as Line;
    const L0 = len[0] as number;
    const L1 = len[1] as number;
    const L2 = len[2] as number;
    const L3 = len[3] as number;
    const L4 = len[4] as number;
    const L5 = len[5] as number;
    const L6 = len[6] as number;
    const L7 = len[7] as number;
    const t0 = taps[0] as number;
    const t1 = taps[1] as number;
    const t2 = taps[2] as number;
    const t3 = taps[3] as number;
    const t4 = taps[4] as number;
    const t5 = taps[5] as number;
    const t6 = taps[6] as number;
    const t7 = taps[7] as number;
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      pre.buf[pre.w] = (a + b) * 0.5;
      let x = pre.buf[(pre.w - preFrames) & pm] as number;
      pre.w = (pre.w + 1) & pm;
      // the rumble and the glare taken off what goes in
      lpIn += (x - lpIn) * hc;
      hpIn += (lpIn - hpIn) * lc;
      x = lpIn - hpIn;
      for (let k = 0; k < 4; k++) {
        const line = input[k] as Line;
        const g = inGain[k] as number;
        const d = line.buf[(line.w - (inLen[k] as number)) & line.mask] as number;
        const vv = x - g * d;
        line.buf[line.w] = vv;
        line.w = (line.w + 1) & line.mask;
        x = d + g * vv;
      }
      // the drift, a quarter turn or so apart in the two loops
      const c2 = oc * rc - os * rs;
      os = oc * rs + os * rc;
      oc = c2;
      const driftB = oc * skewC - os * skewS;
      // loop A: moving diffuser, delay, damping, diffuser, delay
      let u = x + endB * decay;
      {
        const pos = p0.w - (L0 + depth * (1 + oc));
        const fi = Math.floor(pos);
        const f = pos - fi;
        const y0 = p0.buf[fi & p0.mask] as number;
        const d = y0 + ((p0.buf[(fi + 1) & p0.mask] as number) - y0) * f;
        const vv = u + g1 * d;
        p0.buf[p0.w] = vv;
        p0.w = (p0.w + 1) & p0.mask;
        u = d - g1 * vv;
      }
      p1.buf[p1.w] = u;
      u = p1.buf[(p1.w - L1) & p1.mask] as number;
      p1.w = (p1.w + 1) & p1.mask;
      dampA += (u - dampA) * damp;
      u = dampA * decay;
      {
        const d = p2.buf[(p2.w - L2) & p2.mask] as number;
        const vv = u - g2 * d;
        p2.buf[p2.w] = vv;
        p2.w = (p2.w + 1) & p2.mask;
        u = d + g2 * vv;
      }
      p3.buf[p3.w] = u;
      const nextA = p3.buf[(p3.w - L3) & p3.mask] as number;
      p3.w = (p3.w + 1) & p3.mask;
      // loop B, the same, its drift out of step
      let q = x + endA * decay;
      {
        const pos = p4.w - (L4 + depth * (1 + driftB));
        const fi = Math.floor(pos);
        const f = pos - fi;
        const y0 = p4.buf[fi & p4.mask] as number;
        const d = y0 + ((p4.buf[(fi + 1) & p4.mask] as number) - y0) * f;
        const vv = q + g1 * d;
        p4.buf[p4.w] = vv;
        p4.w = (p4.w + 1) & p4.mask;
        q = d - g1 * vv;
      }
      p5.buf[p5.w] = q;
      q = p5.buf[(p5.w - L5) & p5.mask] as number;
      p5.w = (p5.w + 1) & p5.mask;
      dampB += (q - dampB) * damp;
      q = dampB * decay;
      {
        const d = p6.buf[(p6.w - L6) & p6.mask] as number;
        const vv = q - g2 * d;
        p6.buf[p6.w] = vv;
        p6.w = (p6.w + 1) & p6.mask;
        q = d + g2 * vv;
      }
      p7.buf[p7.w] = q;
      const nextB = p7.buf[(p7.w - L7) & p7.mask] as number;
      p7.w = (p7.w + 1) & p7.mask;
      endA = nextA;
      endB = nextB;
      // each side from points along both loops (left: mostly B's, right: mostly A's)
      const left =
        (p5.buf[(p5.w - t0) & p5.mask] as number) +
        (p5.buf[(p5.w - t1) & p5.mask] as number) -
        (p6.buf[(p6.w - t2) & p6.mask] as number) -
        (p3.buf[(p3.w - t3) & p3.mask] as number);
      const right =
        (p1.buf[(p1.w - t4) & p1.mask] as number) +
        (p1.buf[(p1.w - t5) & p1.mask] as number) -
        (p2.buf[(p2.w - t6) & p2.mask] as number) -
        (p7.buf[(p7.w - t7) & p7.mask] as number);
      const mid = (left + right) * 0.3;
      const side = (left - right) * 0.3 * width;
      l[i] = a * dry + (mid + side) * wet;
      r[i] = b * dry + (mid - side) * wet;
    }
    const norm = 1 / Math.sqrt(oc * oc + os * os);
    this.oc = oc * norm;
    this.os = os * norm;
    this.hpIn = hpIn;
    this.lpIn = lpIn;
    this.dampA = Math.abs(dampA) < 1e-20 ? 0 : dampA;
    this.dampB = Math.abs(dampB) < 1e-20 ? 0 : dampB;
    this.endA = endA;
    this.endB = endB;
  }
  reset(): void {
    this.pre.clear();
    for (const line of [...this.input, ...this.parts]) line.clear();
    this.hpIn = this.lpIn = this.dampA = this.dampB = this.endA = this.endB = 0;
  }
}
