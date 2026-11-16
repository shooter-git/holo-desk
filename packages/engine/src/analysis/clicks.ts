/**
 * Clicks: where a sound has a transient its own sound around it doesn't explain, and the sound it
 * should be (a recording, a bounce: its references) doesn't have at the same place. For a note edit
 * against its recording, the studio's playing against its bounce, a note heard in the Notes view
 * against the note itself.
 *
 * Two kinds:
 *
 * - **A burst** of high frequencies (the second difference, where a step or a kink stands out), each
 *   2 ms against the sound's own around it (the larger of the medians of the 20 ms before and the
 *   20 ms after, so that a smooth start out of silence doesn't count and a step does), in dB.
 * - **A jump** in level: every ms, the level (RMS) of the 6 ms before against the 6 ms after, as a
 *   share of the loudest within 10 ms. A held note cut over a ms or two (heard plainly on a phone's
 *   speaker, though its high frequencies may stay under the recording's hiss) jumps by all of it; a
 *   fade over 10 ms by half; a voice's own pulses hardly at all (6 ms holds a period of most voices).
 *
 * Either counts only where it stands over the sound's own elsewhere within 20 ms (a voice's pulses
 * repeat each period; a click stands alone) and over each reference's at the same place, give or take
 * a step (a consonant's onset is in the recording too). A reference that's NaN somewhere says nothing
 * there; where no reference says anything, nothing is judged. With no references at all, a click is
 * what stands out of the sound alone (a recording's own).
 */

/** Where a click is, what kind and how big. */
export interface Click {
  /** Its frame. */
  frame: number;
  kind: 'burst' | 'jump';
  /**
   * How far it stands out: for a burst, dB of high frequencies over the most of its surroundings and
   * of the references'; for a jump, the share of the level (0 to 1) it moves by over theirs.
   */
  size: number;
  /** How loud the sound is there, dBFS (RMS, the loudest within 10 ms). */
  level: number;
}

export interface ClickOptions {
  /** A burst this many dB over its surroundings and the references' counts (6). */
  burstDb?: number;
  /** A jump of this share of the level more than theirs counts (0.6). */
  jump?: number;
  /** Quieter than this (dBFS) nothing is judged (−60). */
  floorDb?: number;
}

/** A burst's windows, and the steps a jump is read at, seconds. */
const BURST_S = 0.002;
const STEP_S = 0.001;
/** A jump: the level this long before a step against this long after. */
const SIDE_S = 0.006;
/** Read against the 20 ms either way; the loudest within 10 ms is the level. */
const AROUND_S = 0.02;
const LEVEL_S = 0.01;
/** The same event within this either way, not elsewhere (a dip falls and rises within it). */
const SAME_S = 0.006;
/** The floor added to high frequencies' energy before they're compared (−90 dB). */
const HF_FLOOR = 1e-9;

function median(e: Float64Array, a: number, b: number, tmp: number[]): number {
  tmp.length = 0;
  for (let k = Math.max(0, a); k < Math.min(e.length, b); k++) {
    const v = e[k] as number;
    if (!Number.isNaN(v)) tmp.push(v);
  }
  if (!tmp.length) return 0;
  tmp.sort((x, y) => x - y);
  return tmp[tmp.length >> 1] as number;
}

/** Each window's high frequencies over its surroundings, dB (NaN where the sound is). */
function bursts(x: Float32Array, size: number): Float64Array {
  const n = Math.floor(x.length / size);
  const hf = new Float64Array(n);
  for (let w = 0; w < n; w++) {
    let h = 0;
    for (let i = Math.max(2, w * size); i < (w + 1) * size; i++) {
      const d = (x[i] as number) - 2 * (x[i - 1] as number) + (x[i - 2] as number);
      h += d * d;
    }
    hf[w] = h / size;
  }
  const around = Math.round(AROUND_S / BURST_S);
  const out = new Float64Array(n);
  const tmp: number[] = [];
  for (let w = 0; w < n; w++) {
    const near = Math.max(median(hf, w - around, w, tmp), median(hf, w + 1, w + 1 + around, tmp));
    out[w] = 10 * Math.log10(((hf[w] as number) + HF_FLOOR) / (near + HF_FLOOR));
  }
  return out;
}

/** At each step: the level of the side before and of the side after (RMS; NaN where the sound is). */
function sides(x: Float32Array, step: number, side: number): { before: Float64Array; after: Float64Array } {
  // (running sums of the energy, and of the frames that say nothing: a side with one of those is NaN)
  const sum = new Float64Array(x.length + 1);
  const blind = new Uint32Array(x.length + 1);
  for (let i = 0; i < x.length; i++) {
    const v = x[i] as number;
    const nan = Number.isNaN(v);
    sum[i + 1] = (sum[i] as number) + (nan ? 0 : v * v);
    blind[i + 1] = (blind[i] as number) + (nan ? 1 : 0);
  }
  const level = (a: number, b: number) =>
    blind[b] !== blind[a] ? Number.NaN : Math.sqrt(Math.max(0, (sum[b] as number) - (sum[a] as number)) / (b - a));
  const n = Math.floor(x.length / step);
  const before = new Float64Array(n).fill(Number.NaN);
  const after = new Float64Array(n).fill(Number.NaN);
  for (let k = 0; k < n; k++) {
    const at = k * step;
    if (at >= side) before[k] = level(at - side, at);
    if (at + side <= x.length) after[k] = level(at, at + side);
  }
  return { before, after };
}

/** The most of `x` from `a` to `b` (NaN ignored; −Infinity where there's nothing). */
function most(x: Float64Array, a: number, b: number): number {
  let m = Number.NEGATIVE_INFINITY;
  for (let k = Math.max(0, a); k <= Math.min(x.length - 1, b); k++) {
    const v = x[k] as number;
    if (!Number.isNaN(v) && v > m) m = v;
  }
  return m;
}

/** The most of `x` within `span` of `w` but more than `same` from it (0 at least). */
function elsewhere(x: Float64Array, w: number, span: number, same: number): number {
  return Math.max(most(x, w - span, w - same - 1), most(x, w + same + 1, w + span), 0);
}

/**
 * Clicks in `signal` that none of `references` (each as long, aligned to it) has at the same place;
 * with none, those that stand out of its own sound alone. In frame order.
 */
export function findClicks(
  signal: Float32Array,
  sr: number,
  references: readonly Float32Array[],
  options: ClickOptions = {},
): Click[] {
  const burstDb = options.burstDb ?? 6;
  const jumpMin = options.jump ?? 0.6;
  const floor = 10 ** ((options.floorDb ?? -60) / 20);
  const out: Click[] = [];

  // bursts, every 2 ms
  const bsize = Math.max(8, Math.round(BURST_S * sr));
  const own = bursts(signal, bsize);
  const refBursts = references.map((r) => bursts(r, bsize));
  const levels = sides(signal, bsize, bsize);
  const bAround = Math.round(AROUND_S / BURST_S);
  const bSame = Math.round(SAME_S / BURST_S);
  const bLevel = Math.round(LEVEL_S / BURST_S);
  for (let w = 0; w < own.length; w++) {
    const b = own[w] as number;
    if (b < burstDb) continue;
    let ref = 0;
    if (refBursts.length) {
      ref = Number.NEGATIVE_INFINITY;
      for (const r of refBursts) ref = Math.max(ref, most(r, w - 1, w + 1));
      if (ref === Number.NEGATIVE_INFINITY) continue;
    }
    const top = most(levels.after, w - bLevel, w + bLevel);
    if (!(top >= floor)) continue;
    const size = b - Math.max(ref, elsewhere(own, w, bAround, bSame));
    if (size >= burstDb)
      out.push({ frame: w * bsize + (bsize >> 1), kind: 'burst', size, level: 20 * Math.log10(top) });
  }

  // jumps, every ms
  const step = Math.max(4, Math.round(STEP_S * sr));
  const side = Math.round(SIDE_S * sr);
  const mine = sides(signal, step, side);
  const jumps = (s: { before: Float64Array; after: Float64Array }) =>
    s.before.map((v, k) => Math.abs((s.after[k] as number) - v));
  const ownJumps = jumps(mine);
  const refJumps = references.map((r) => jumps(sides(r, step, side)));
  const jAround = Math.round(AROUND_S / STEP_S);
  const jSame = Math.round(SAME_S / STEP_S);
  const jLevel = Math.round(LEVEL_S / STEP_S);
  let last = Number.NEGATIVE_INFINITY;
  for (let k = 0; k < ownJumps.length; k++) {
    const j = ownJumps[k] as number;
    if (Number.isNaN(j)) continue;
    const top = Math.max(most(mine.before, k - jLevel, k + jLevel), most(mine.after, k - jLevel, k + jLevel));
    if (!(top >= floor) || j / top < jumpMin) continue;
    let ref = 0;
    if (refJumps.length) {
      ref = Number.NEGATIVE_INFINITY;
      for (const r of refJumps) ref = Math.max(ref, most(r, k - 1, k + 1));
      if (ref === Number.NEGATIVE_INFINITY) continue;
    }
    const size = (j - Math.max(ref, elsewhere(ownJumps, k, jAround, jSame))) / top;
    // (one click, however many steps it spans)
    if (size >= jumpMin && k - last > jSame) {
      out.push({ frame: k * step, kind: 'jump', size, level: 20 * Math.log10(top) });
      last = k;
    }
  }
  return out.sort((a, b) => a.frame - b.frame);
}
