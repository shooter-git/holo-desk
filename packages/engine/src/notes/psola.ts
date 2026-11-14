/**
 * A line's notes moved in pitch, offline (the patches of a `mono` region: patch.ts): pitch-synchronous
 * overlap-add (TD-PSOLA). The same recording and patch give the same samples wherever it runs.
 *
 * - **Hearing it.** The mean of the channels, from 200 ms before anything moves to 200 ms after (within
 *   the frames the patch may read, `ctx`). Its pitch is the fine track (analysis/take.ts: every 5 ms, as
 *   note-finding hears it), its gaps up to 25 ms filled in and its voiced runs shorter than 15 ms let go.
 *   A patch that only changes levels isn't heard at all.
 * - **Analysis marks.** Through a voiced run, one period apart: the first at the run's loudest sample in
 *   its first period, each next where the period around it best matches the one around the mark before
 *   (normalized cross-correlation, within 20% of the period the track says). Elsewhere, every 5 ms from
 *   the recording's first frame, so they fall in the same places whatever stretch is read. (A voiced run
 *   more than 100 ms from any shift is only ever copied: it's marked every 5 ms too.)
 * - **The shift.** curve.ts `targetShift`, nothing where the sound isn't voiced.
 * - **Synthesis marks.** Each lies the period divided by the ratio (2^(shift/12)) after the one before,
 *   and takes the grain of the analysis mark nearest it: the sound around that mark under a Hann window
 *   whose halves reach as far as the nearer of the analysis mark's neighbour and the synthesis mark's,
 *   so that from one synthesis mark to the next one grain fades out as the next fades in (adding to
 *   one, except where the pitch goes down: the grains are then further apart than the sound they were
 *   read from, and keep to its length). A grain placed between samples is read between them (interp.ts).
 * - **Locked.** Wherever nothing moves, the synthesis marks are the analysis marks and the sound is
 *   copied, to the bit (overlap-added, it would be a rounding away). A shift starts from an analysis
 *   mark; once it's back to nothing for good, the synthesis marks drift back onto the analysis marks
 *   over the last of the shift's descent and four more marks (at least eight where it's voiced, where a
 *   drift is a tiny change of pitch; in noise it's none), and lock again. So a patch, which reaches past
 *   its edits, starts and ends as the recording does.
 * - **Level** (curve.ts `noteGain`), last.
 *
 * Every channel is moved by the same marks, so a stereo image stays where it was.
 */
import { FINE_STEP_S, fineTrack } from '../analysis/take.ts';
import { noteGain, targetShift } from './curve.ts';
import { FIRST_TAP, fractionalTaps, INTERP_TAPS } from './interp.ts';
import type { PatchSpec } from './plan.ts';

/** Gaps in the pitch track up to this many steps are filled in; voiced runs shorter than this many are let go. */
const FILL_STEPS = 5;
const MIN_RUN_STEPS = 3;
/** How far from the period the track says a mark's next is looked for (a share of the period). */
const SEARCH = 0.2;
/** Where nothing is voiced, analysis marks lie this far apart (s). */
const GRID_S = 0.005;
/** How far around where anything moves the sound is heard (s); and how close to a shift a voiced run is marked period by period. */
const HEARD_S = 0.2;
const MARK_REACH_S = 0.1;
/** Marks after a shift's end that drift back onto the analysis marks, and the fewest that drift where it's voiced. */
const SETTLE = 4;
const SETTLE_VOICED = 8;

/** The patch of a line: the frames `a` to `b` of `base` with its notes' edits, rendered. */
export function renderLinePatch(base: readonly Float32Array[], sr: number, spec: PatchSpec): Float32Array[] {
  const out = base.map((c) => c.slice(Math.min(spec.a, c.length), Math.min(spec.b, c.length)));
  if (!base.length) return out;
  const len = base.reduce((m, c) => Math.min(m, c.length), Number.POSITIVE_INFINITY);
  const a = Math.min(spec.a, len);
  const b = Math.min(spec.b, len);
  if (!(b > a)) return out;
  // the frames it may read: the patch and its context
  const c0 = Math.max(0, Math.min(spec.ctx[0], a));
  const c1 = Math.min(len, Math.max(spec.ctx[1], b));
  const scale = sr * spec.stretch;
  const times = new Float64Array(c1 - c0);
  for (let i = 0; i < times.length; i++) times[i] = (c0 + i) / scale;
  const moves = targetShift(spec.notes, times);
  let first = 0;
  while (first < moves.length && moves[first] === 0) first++;
  if (first < moves.length) {
    // the frames read: 200 ms either side of where anything moves (frame w0 of the recording is frame 0 here)
    let last = moves.length - 1;
    while (moves[last] === 0) last--;
    const reach = Math.round(HEARD_S * sr);
    const w0 = c0 + Math.max(0, first - reach);
    const w1 = c0 + Math.min(moves.length, last + 1 + reach);
    const n = w1 - w0;
    const shift = moves.slice(w0 - c0, w1 - c0);
    const mono = new Float64Array(n);
    for (const c of base) for (let i = 0; i < n; i++) mono[i] = (mono[i] as number) + (c[w0 + i] as number);
    if (base.length > 1) for (let i = 0; i < n; i++) mono[i] = (mono[i] as number) / base.length;
    const period = periodsOf(mono, sr);
    for (let i = 0; i < n; i++) if (Number.isNaN(period[i] as number)) shift[i] = 0;
    if (shift.some((s) => s !== 0)) {
      const still = stillness(shift);
      const marks = analysisMarks(mono, period, still, w0, sr);
      overlapAdd(base, out, marks.at, synthesisPlan(marks, shift, still), w0, a - w0, b - w0);
    }
  }
  const gain = noteGain(spec.notes, times.subarray(a - c0, b - c0));
  for (const c of out)
    for (let i = 0; i < Math.min(c.length, gain.length); i++)
      if (gain[i] !== 1) c[i] = (c[i] as number) * (gain[i] as number);
  return out;
}

/**
 * The period (samples) at each sample of a line, from its fine track: NaN where it isn't voiced. Gaps
 * up to FILL_STEPS steps are filled in (between the pitches either side), and runs shorter than
 * MIN_RUN_STEPS let go; each step stands for the 5 ms around it, the period between steps in line.
 */
function periodsOf(mono: Float64Array, sr: number): Float64Array {
  const track = fineTrack(Float32Array.from(mono), sr);
  const steps = track.midi.length;
  const midi = Float64Array.from(track.midi);
  const runEnd = (k: number, voiced: boolean): number => {
    let e = k;
    while (e < steps && Number.isNaN(midi[e] as number) !== voiced) e++;
    return e;
  };
  for (let k = 0; k < steps; ) {
    if (!Number.isNaN(midi[k] as number)) {
      k++;
      continue;
    }
    const e = runEnd(k, false);
    if (k > 0 && e < steps && e - k <= FILL_STEPS) {
      const m0 = midi[k - 1] as number;
      const m1 = midi[e] as number;
      for (let j = k; j < e; j++) midi[j] = m0 + ((m1 - m0) * (j - k + 1)) / (e - k + 1);
    }
    k = e;
  }
  const steady = Float64Array.from(midi, (m) => sr / (440 * 2 ** ((m - 69) / 12)));
  const period = new Float64Array(mono.length).fill(Number.NaN);
  for (let k = 0; k < steps; ) {
    if (Number.isNaN(midi[k] as number)) {
      k++;
      continue;
    }
    const e = runEnd(k, true);
    if (e - k >= MIN_RUN_STEPS) {
      const t0 = track.t[k] as number;
      const from = Math.max(0, Math.round((t0 - FINE_STEP_S / 2) * sr));
      const to = Math.min(mono.length, Math.round(((track.t[e - 1] as number) + FINE_STEP_S / 2) * sr));
      for (let i = from; i < to; i++) {
        const f = Math.min(e - 1, Math.max(k, k + (i / sr - t0) / FINE_STEP_S));
        const j = Math.floor(f);
        const p = steady[j] as number;
        period[i] = j + 1 < e ? p + ((steady[j + 1] as number) - p) * (f - j) : p;
      }
    }
    k = e;
  }
  return period;
}

/** Whether nothing moves anywhere from sample lo up to hi (of the frames read). */
type Still = (lo: number, hi: number) => boolean;

function stillness(shift: Float64Array): Still {
  const moved = new Int32Array(shift.length + 1);
  for (let i = 0; i < shift.length; i++) moved[i + 1] = (moved[i] as number) + (shift[i] !== 0 ? 1 : 0);
  const at = (i: number) => moved[Math.max(0, Math.min(shift.length, Math.floor(i)))] as number;
  return (lo, hi) => at(hi) === at(lo);
}

/** Analysis marks (samples of the frames read, ascending), and whether each is a voiced run's. */
interface Marks {
  at: Int32Array;
  voiced: Uint8Array;
}

function analysisMarks(x: Float64Array, period: Float64Array, still: Still, w0: number, sr: number): Marks {
  const n = x.length;
  const energy = new Float64Array(n + 1);
  for (let i = 0; i < n; i++) energy[i + 1] = (energy[i] as number) + (x[i] as number) * (x[i] as number);
  const reach = Math.round(MARK_REACH_S * sr);
  const grid = Math.round(GRID_S * sr);
  const at: number[] = [];
  const voiced: number[] = [];
  /** Grid marks from lo to hi (inclusive), on multiples of the grid from the recording's first frame. */
  const fill = (lo: number, hi: number) => {
    for (let g = Math.ceil((Math.max(0, lo) + w0) / grid) * grid - w0; g <= Math.min(n - 1, hi); g += grid) {
      at.push(g);
      voiced.push(0);
    }
  };
  let last = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < n; ) {
    if (Number.isNaN(period[i] as number)) {
      i++;
      continue;
    }
    let to = i;
    while (to < n && !Number.isNaN(period[to] as number)) to++;
    const from = i;
    i = to;
    if (still(from - reach, to + reach)) continue;
    const run = markRun(x, energy, period, from, to);
    if (!run.length) continue;
    fill(last + grid / 2, (run[0] as number) - grid / 2);
    for (const m of run) {
      at.push(m);
      voiced.push(1);
    }
    last = run[run.length - 1] as number;
  }
  fill(last + grid / 2, n - 1);
  return { at: Int32Array.from(at), voiced: Uint8Array.from(voiced) };
}

/** A voiced run's marks, from..to (samples), one period apart. */
function markRun(x: Float64Array, energy: Float64Array, period: Float64Array, from: number, to: number): number[] {
  const n = x.length;
  const out: number[] = [];
  // the first: the loudest sample of the first period
  let m = from;
  const first = Math.min(to, from + Math.round(period[from] as number));
  for (let i = from + 1; i < first; i++) if (Math.abs(x[i] as number) > Math.abs(x[m] as number)) m = i;
  out.push(m);
  for (;;) {
    const p = period[m] as number;
    const half = Math.max(1, Math.round(p / 2));
    const lo = m + Math.ceil(p * (1 - SEARCH));
    const hi = Math.min(to - 1, n - half - 1, m + Math.floor(p * (1 + SEARCH)));
    if (lo > hi || m - half < 0) break;
    const em = (energy[m + half] as number) - (energy[m - half] as number);
    let best = Number.NEGATIVE_INFINITY;
    let next = lo;
    for (let c = lo; c <= hi; c++) {
      let xy = 0;
      for (let j = -half; j < half; j++) xy += (x[m + j] as number) * (x[c + j] as number);
      const e = em * ((energy[c + half] as number) - (energy[c - half] as number));
      const score = e > 0 ? xy / Math.sqrt(e) : 0;
      if (score > best) {
        best = score;
        next = c;
      }
    }
    m = next;
    out.push(m);
  }
  return out;
}

/** Synthesis marks (samples of the frames read, ascending, between samples where they fall) and the analysis mark each takes its grain from. */
interface Plan {
  tau: number[];
  src: number[];
}

function synthesisPlan(marks: Marks, shift: Float64Array, still: Still): Plan {
  const t = marks.at;
  const K = t.length;
  const tau: number[] = [];
  const src: number[] = [];
  if (K === 0) return { tau, src };
  const last = t[K - 1] as number;
  /** The analysis interval x is in: i with t[i] ≤ x < t[i + 1]. */
  const interval = (x: number): number => {
    let lo = 0;
    let hi = K - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if ((t[mid] as number) <= x) lo = mid;
      else hi = mid;
    }
    return lo;
  };
  const nearest = (x: number): number => {
    const i = interval(x);
    return i + 1 < K && (t[i + 1] as number) - x < x - (t[i] as number) ? i + 1 : i;
  };
  const shiftAt = (x: number): number => shift[Math.max(0, Math.min(shift.length - 1, Math.round(x)))] as number;

  /**
   * The shift is over at synthesis mark j: lock again, if nothing moves until the analysis mark SETTLE
   * steps on is reached. The marks from the start of the shift's last descent (not before the run's
   * first, `from`) drift onto it bit by bit. The analysis mark locked onto, or −1.
   */
  const relock = (j: number, from: number): number => {
    const steps: number[] = [];
    let x = tau[j] as number;
    for (let q = 0; q < SETTLE; q++) {
      const i = interval(x);
      if (i + 1 >= K) return -1;
      x += (t[i + 1] as number) - (t[i] as number);
      steps.push(x);
    }
    if (x > last) return -1;
    const m = nearest(x);
    const target = t[m] as number;
    if (target <= (tau[j] as number) || !still(tau[j] as number, target + 1)) return -1;
    let c = j - 1;
    while (c > from) {
      const s = Math.abs(shiftAt(tau[c] as number));
      if (s === 0 || s >= Math.abs(shiftAt(tau[c - 1] as number))) break;
      c--;
    }
    if (steps.some((s) => marks.voiced[nearest(s)])) c = Math.max(from, Math.min(c, j + SETTLE - SETTLE_VOICED));
    for (const s of steps) {
      tau.push(s);
      src.push(0);
    }
    const end = tau.length - 1;
    const off = target - x;
    for (let q = c + 1; q < end; q++) {
      tau[q] = (tau[q] as number) + (off * (q - c)) / (end - c);
      src[q] = nearest(tau[q] as number);
    }
    tau[end] = target;
    src[end] = m;
    return m;
  };

  tau.push(t[0] as number);
  src.push(0);
  let k = 0; // the analysis mark the synthesis marks are locked on, or −1
  let from = 0; // where the marks last left the analysis marks
  for (;;) {
    const j = tau.length - 1;
    const x = tau[j] as number;
    if (k >= 0) {
      if (k + 1 >= K) break;
      if (still(t[k] as number, (t[k + 1] as number) + 1)) {
        k++;
        tau.push(t[k] as number);
        src.push(k);
        continue;
      }
      from = j;
      k = -1;
    }
    const i = interval(x);
    if (i + 1 >= K) break;
    const p = (t[i + 1] as number) - (t[i] as number);
    const next = x + p / 2 ** (shiftAt(x + p / 2) / 12);
    if (next >= last) break;
    tau.push(next);
    src.push(nearest(next));
    if (shiftAt(next) === 0) k = relock(j + 1, from);
  }
  return { tau, src };
}

/**
 * The channels overlap-added by the plan into `out` (frames lo to hi of those read; `out` holds the
 * recording's own, which stay wherever the marks are locked).
 */
function overlapAdd(
  base: readonly Float32Array[],
  out: Float32Array[],
  t: Int32Array,
  plan: Plan,
  w0: number,
  lo: number,
  hi: number,
): void {
  const { tau, src } = plan;
  const J = tau.length;
  const K = t.length;
  if (J < 2) return;
  const gap = (k: number): number =>
    K < 2 ? Number.POSITIVE_INFINITY : (t[Math.min(K - 1, k + 1)] as number) - (t[Math.max(0, k)] as number);
  // each grain's reach either side, and how it's read (whole samples off its analysis mark, the taps between)
  const left = new Float64Array(J);
  const right = new Float64Array(J);
  const whole = new Int32Array(J);
  const taps: (Float64Array | null)[] = [];
  for (let q = 0; q < J; q++) {
    const s = src[q] as number;
    const x = tau[q] as number;
    left[q] = Math.min(gap(s > 0 ? s - 1 : 0), q > 0 ? x - (tau[q - 1] as number) : Number.POSITIVE_INFINITY);
    right[q] = Math.min(gap(s < K - 1 ? s : K - 2), q + 1 < J ? (tau[q + 1] as number) - x : Number.POSITIVE_INFINITY);
    const off = (t[s] as number) - x;
    whole[q] = Math.floor(off);
    const frac = off - Math.floor(off);
    taps.push(frac === 0 ? null : fractionalTaps(frac));
  }
  /** Grain q's sound at frame i (of those read), from channel c. */
  const read = (c: Float32Array, q: number, i: number): number => {
    const at = w0 + i + (whole[q] as number);
    const h = taps[q];
    if (!h) return at >= 0 && at < c.length ? (c[at] as number) : 0;
    const z = at + FIRST_TAP;
    let v = 0;
    if (z >= 0 && z + INTERP_TAPS <= c.length)
      for (let m = 0; m < INTERP_TAPS; m++) v += (h[m] as number) * (c[z + m] as number);
    else
      for (let m = 0; m < INTERP_TAPS; m++)
        if (z + m >= 0 && z + m < c.length) v += (h[m] as number) * (c[z + m] as number);
    return v;
  };
  for (let q = 0; q + 1 < J; q++) {
    const x0 = tau[q] as number;
    const x1 = tau[q + 1] as number;
    // between two marks locked on neighbouring analysis marks, the recording as it is
    const s0 = src[q] as number;
    const s1 = src[q + 1] as number;
    if (s1 === s0 + 1 && x0 === t[s0] && x1 === t[s1]) continue;
    const from = Math.max(lo, Math.ceil(x0));
    const to = Math.min(hi, Math.ceil(x1));
    const r = right[q] as number;
    const l = left[q + 1] as number;
    for (let i = from; i < to; i++) {
      const du = i - x0;
      const dv = x1 - i;
      const fade = du < r ? 0.5 + 0.5 * Math.cos((Math.PI * du) / r) : 0;
      const rise = dv < l ? 0.5 + 0.5 * Math.cos((Math.PI * dv) / l) : 0;
      for (let ch = 0; ch < base.length; ch++) {
        const c = base[ch] as Float32Array;
        let y = 0;
        if (fade > 0) y += fade * read(c, q, i);
        if (rise > 0) y += rise * read(c, q + 1, i);
        (out[ch] as Float32Array)[i - lo] = y;
      }
    }
  }
}
