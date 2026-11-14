/**
 * A line's notes moved in pitch and formant, offline (the patches of a `mono` region: patch.ts):
 * pitch-synchronous overlap-add (TD-PSOLA). The same recording and patch give the same samples
 * wherever it runs.
 *
 * - **Hearing it.** The mean of the channels, from 200 ms before anything can move to 200 ms after
 *   (and 100 ms past the patch at least; within the frames the patch may read, `ctx`). Its pitch is the
 *   fine track (analysis/take.ts: every 5 ms, as note-finding hears it), its voiced runs shorter than
 *   15 ms let go and its gaps filled in where the sound still repeats itself near the period between
 *   the pitches either side: up to 25 ms, or 60 ms where its level doesn't dip (the track loses a fast
 *   glide; a consonant isn't filled in). In a gap filled in, the pitch is read from the analysis marks,
 *   which follow the sound itself. A patch that only changes levels isn't heard at all.
 * - **Analysis marks.** Through a voiced run, one period apart: the first at the run's loudest sample in
 *   its first period, each next where the period around it best matches the one around the mark before
 *   (normalized cross-correlation, within 20% of the period the track says). Elsewhere, every 5 ms from
 *   the recording's first frame, so they fall in the same places whatever stretch is read. (A voiced run
 *   more than 100 ms from where anything can move is only ever copied: it's marked every 5 ms too.)
 * - **The shift and the formant.** curve.ts `targetShift` (from the pitch heard: the notes' centres,
 *   drift, vibrato and glides) and `formantShift`; neither where the sound isn't voiced, so a consonant
 *   or a breath inside a moved note isn't moved.
 * - **Synthesis marks.** Each lies the period divided by the ratio (2^(shift/12)) after the one before,
 *   and takes the grain of the analysis mark nearest it: the sound around that mark under a Hann window
 *   whose halves reach as far as the nearer of the analysis mark's neighbour and the synthesis mark's,
 *   so that from one synthesis mark to the next one grain fades out as the next fades in (adding to
 *   one, except where the pitch goes down: the grains are then further apart than the sound they were
 *   read from, and keep to its length). A grain placed between samples is read between them (interp.ts).
 * - **Formant.** A voiced grain is read 2^(formant/12) times as fast as it was recorded (through the
 *   same windowed sinc, its cutoff lowered as much as it's sped up), under the same window: its
 *   formants move by that much, its pitch (where the grains are) doesn't. Grains of unvoiced sound are
 *   read as they were.
 * - **Level.** Grains brought closer together or further apart overlap more or less, and a voice's
 *   energy sits in a pulse each period: moved a few semitones, the level would drift by a dB or two.
 *   So each period the voiced grains make (between two synthesis marks) is measured against the
 *   recording around the marks it was read from, over the five periods around it, and its level put
 *   back (between periods in line, back to 1 where the sound is copied).
 * - **Locked.** Wherever nothing moves, the synthesis marks are the analysis marks and the sound is
 *   copied, to the bit (overlap-added, it would be a rounding away). A shift starts from an analysis
 *   mark. Once nothing moves from a synthesis mark on, the marks lock again. Into sound with no pitch,
 *   straight onto the first analysis mark there a grid step past the last voiced grain (a jump in noise
 *   is heard as nothing, and that grain fades over it). Where it's voiced they follow the recording's
 *   periods and drift onto its marks bit by bit: each period changed by a hundredth at most where the
 *   patch has room (over up to 64 periods), by what its room allows where it hasn't, the change coming
 *   in and going over the first and last quarter of them so that neighbouring periods differ by much
 *   less. So a patch, which reaches past its edits, starts and ends as the recording does, and a breath
 *   between moved notes is copied as it is.
 * - **Level edits** (curve.ts `noteGain`), last.
 *
 * Every channel is moved by the same marks and levels, so a stereo image stays where it was.
 */
import { FINE_STEP_S, fineTrack } from '../analysis/take.ts';
import { formantShift, noteGain, pitchSpan, targetShift } from './curve.ts';
import { cutoffTable, FIRST_TAP, fractionalTaps, INTERP_TAPS, tableTaps } from './interp.ts';
import type { PatchSpec } from './plan.ts';

/** Gaps in the pitch track up to this many steps are filled in, up to this many where the level doesn't dip this far; voiced runs shorter than this many are let go. */
const FILL_STEPS = 5;
const BRIDGE_STEPS = 12;
const BRIDGE_DIP = 10 ** (-12 / 10);
/** A gap's sound repeats itself near the period with a normalized difference under this, to be filled (noise is near 1). */
const BRIDGE_VOICED = 0.35;
const MIN_RUN_STEPS = 3;
/** How far from the period the track says a mark's next is looked for (a share of the period). */
const SEARCH = 0.2;
/** Where nothing is voiced, analysis marks lie this far apart (s). */
const GRID_S = 0.005;
/** How far around where anything can move the sound is heard (s); and how close to a move a voiced run is marked period by period. */
const HEARD_S = 0.2;
const MARK_REACH_S = 0.1;
/** Where it's voiced, marks drift back onto the analysis marks over this many at least (fewer only where the patch ends first, down to SETTLE) and this many at most. */
const SETTLE = 4;
const SETTLE_VOICED = 8;
const SETTLE_MAX = 64;
/** The most a period changes as the marks drift back (a share of it), where there's room; the drift's share that comes in and goes at either end. */
const SETTLE_CHANGE = 0.01;
const SETTLE_RAMP = 0.25;
/** A period's level is measured over this many periods either side; it's put back by this much at most either way. */
const LEVEL_REACH = 2;
const LEVEL_MAX = 2;

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
  const span = pitchSpan(spec.notes);
  const first = span ? Math.max(c0, Math.ceil(span[0] * scale)) : c1;
  const last = span ? Math.min(c1 - 1, Math.floor(span[1] * scale)) : c0;
  if (last >= first) {
    // the frames read: 200 ms either side of where anything can move (frame w0 of the recording is frame 0 here)
    const reach = Math.round(HEARD_S * sr);
    const w0 = Math.max(c0, first - reach);
    // (and 100 ms past the patch at least: the fine track stops short of the end of what it hears, and the
    // marks drifting back onto the recording's want to follow its periods to the patch's end)
    const w1 = Math.min(c1, Math.max(last + 1 + reach, b + (reach >> 1)));
    const n = w1 - w0;
    const mono = new Float64Array(n);
    for (const c of base) for (let i = 0; i < n; i++) mono[i] = (mono[i] as number) + (c[w0 + i] as number);
    if (base.length > 1) for (let i = 0; i < n; i++) mono[i] = (mono[i] as number) / base.length;
    const heard = periodsOf(mono, sr);
    const { period } = heard;
    const energy = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) energy[i + 1] = (energy[i] as number) + (mono[i] as number) * (mono[i] as number);
    // marked period by period: the voiced runs within 100 ms of where anything can move
    const lo = first - w0;
    const hi = last - w0;
    const marks = analysisMarks(mono, energy, period, (x, y) => y < lo || x > hi, w0, sr);
    // the pitch heard, at seconds of the file (where the track lost it, from the marks)
    pitchFromMarks(heard, marks, sr);
    const track = { t: Float64Array.from(heard.t, (s) => (w0 + s * sr) / scale), midi: heard.midi };
    const at = times.subarray(w0 - c0, w1 - c0);
    const shift = targetShift(spec.notes, at, track);
    const formant = formantShift(spec.notes, at);
    let moves = false;
    for (let i = 0; i < n; i++) {
      if (Number.isNaN(period[i] as number)) {
        shift[i] = 0;
        formant[i] = 0;
      }
      if (shift[i] !== 0 || formant[i] !== 0) moves = true;
    }
    if (moves) {
      const still = stillness(shift, formant);
      const plan = synthesisPlan(marks, shift, still, b - w0, Math.round(GRID_S * sr));
      overlapAdd(base, out, energy, marks, plan, formant, w0, a - w0, b - w0);
    }
  }
  const gain = noteGain(spec.notes, times.subarray(a - c0, b - c0));
  for (const c of out)
    for (let i = 0; i < Math.min(c.length, gain.length); i++)
      if (gain[i] !== 1) c[i] = (c[i] as number) * (gain[i] as number);
  return out;
}

/** A line heard: the period (samples) at each sample, NaN where it isn't voiced; and its pitch track (gaps filled, short runs let go). */
interface Heard {
  period: Float64Array;
  /** Each step's time (s from the first sample) and its pitch (MIDI with cents, NaN where it isn't voiced). */
  t: Float64Array;
  midi: Float64Array;
  /** 1 at the steps of a gap filled in. */
  filled: Uint8Array;
}

/**
 * The period (samples) at each sample of a line, from its fine track: NaN where it isn't voiced. Gaps
 * where the sound still repeats itself near the period between the pitches either side are filled in
 * (between those pitches): up to FILL_STEPS steps, or up to BRIDGE_STEPS where its level doesn't dip
 * either (the track losing a fast glide); a consonant isn't. Runs shorter than MIN_RUN_STEPS are let
 * go. Each step stands for the 5 ms around it, the period between steps in line.
 */
function periodsOf(mono: Float64Array, sr: number): Heard {
  const track = fineTrack(Float32Array.from(mono), sr);
  const steps = track.midi.length;
  const midi = Float64Array.from(track.midi);
  const filled = new Uint8Array(steps);
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
    let bridge = k > 0 && e < steps && e - k <= BRIDGE_STEPS;
    if (bridge && e - k > FILL_STEPS) {
      const floor = Math.min(track.power[k - 1] as number, track.power[e] as number) * BRIDGE_DIP;
      for (let j = k; j < e && bridge; j++) bridge = (track.power[j] as number) >= floor;
    }
    // (and only where the sound repeats itself near the period between: a glide, not a consonant)
    for (let j = k; j < e && bridge; j++) {
      const m = (midi[k - 1] as number) + (((midi[e] as number) - (midi[k - 1] as number)) * (j - k + 1)) / (e - k + 1);
      bridge = periodic(mono, Math.round((track.t[j] as number) * sr), sr / (440 * 2 ** ((m - 69) / 12)));
    }
    if (bridge) {
      const m0 = midi[k - 1] as number;
      const m1 = midi[e] as number;
      for (let j = k; j < e; j++) midi[j] = m0 + ((m1 - m0) * (j - k + 1)) / (e - k + 1);
      filled.fill(1, k, e);
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
    } else {
      midi.fill(Number.NaN, k, e);
      filled.fill(0, k, e);
    }
    k = e;
  }
  return { period, t: track.t, midi, filled };
}

/**
 * Whether the sound around sample c repeats itself near a period of p samples: its normalized squared
 * difference against itself under BRIDGE_VOICED at some shift within SEARCH of p, over a period and a
 * half (a glide's period changes as it goes).
 */
function periodic(x: Float64Array, c: number, p: number): boolean {
  const lo = Math.max(2, Math.floor(p * (1 - SEARCH)));
  const hi = Math.ceil(p * (1 + SEARCH));
  const w = Math.round(1.5 * p);
  const a = Math.round(c - (w + p) / 2);
  if (a < 0 || a + w + hi >= x.length) return false;
  for (let tau = lo; tau <= hi; tau++) {
    let d = 0;
    let m = 0;
    for (let j = 0; j < w; j++) {
      const u = x[a + j] as number;
      const v = x[a + j + tau] as number;
      d += (u - v) * (u - v);
      m += u * u + v * v;
    }
    if (m > 0 && d / m < BRIDGE_VOICED) return true;
  }
  return false;
}

/**
 * The pitch at a line's filled-in steps from its analysis marks instead, where they're marked period
 * by period: each period's pitch at its middle, in line between periods. (The marks follow the sound
 * itself, a glide the track lost too.)
 */
function pitchFromMarks(heard: Heard, marks: Marks, sr: number): void {
  const t = marks.at;
  const K = t.length;
  /** The pitch of the period from mark i to the next, or NaN where it isn't one (unvoiced, or across runs). */
  const pitchOf = (i: number): number => {
    if (i < 0 || i + 1 >= K || !marks.voiced[i] || !marks.voiced[i + 1]) return Number.NaN;
    const len = (t[i + 1] as number) - (t[i] as number);
    const guess = heard.period[Math.round(((t[i] as number) + (t[i + 1] as number)) / 2)] as number;
    if (!(Math.abs(len - guess) < 0.25 * guess)) return Number.NaN;
    return 69 + 12 * Math.log2(sr / (440 * len));
  };
  let i = 0;
  for (let k = 0; k < heard.t.length; k++) {
    if (!heard.filled[k]) continue;
    const x = (heard.t[k] as number) * sr;
    while (i + 1 < K && (t[i + 1] as number) <= x) i++;
    const centre = ((t[i] as number) + (t[Math.min(K - 1, i + 1)] as number)) / 2;
    const j = x < centre ? i - 1 : i;
    const a = pitchOf(j);
    const b = pitchOf(j + 1);
    const ca = ((t[Math.max(0, j)] as number) + (t[Math.max(0, Math.min(K - 1, j + 1))] as number)) / 2;
    const cb = ((t[Math.max(0, Math.min(K - 1, j + 1))] as number) + (t[Math.min(K - 1, j + 2)] as number)) / 2;
    if (!Number.isNaN(a) && !Number.isNaN(b) && cb > ca)
      heard.midi[k] = a + (b - a) * Math.min(1, Math.max(0, (x - ca) / (cb - ca)));
    else if (!Number.isNaN(a)) heard.midi[k] = a;
    else if (!Number.isNaN(b)) heard.midi[k] = b;
  }
}

/** Whether nothing moves anywhere from sample lo up to hi (of the frames read). */
type Still = (lo: number, hi: number) => boolean;

function stillness(shift: Float64Array, formant: Float64Array): Still {
  const moved = new Int32Array(shift.length + 1);
  for (let i = 0; i < shift.length; i++)
    moved[i + 1] = (moved[i] as number) + (shift[i] !== 0 || formant[i] !== 0 ? 1 : 0);
  const at = (i: number) => moved[Math.max(0, Math.min(shift.length, Math.floor(i)))] as number;
  return (lo, hi) => at(hi) === at(lo);
}

/** Analysis marks (samples of the frames read, ascending), whether each is a voiced run's, and whether it's in sound with no pitch (a grid mark where it isn't voiced). */
interface Marks {
  at: Int32Array;
  voiced: Uint8Array;
  noise: Uint8Array;
}

function analysisMarks(
  x: Float64Array,
  energy: Float64Array,
  period: Float64Array,
  still: Still,
  w0: number,
  sr: number,
): Marks {
  const n = x.length;
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
  const noise = Uint8Array.from(at, (m, k) => (!voiced[k] && Number.isNaN(period[m] as number) ? 1 : 0));
  return { at: Int32Array.from(at), voiced: Uint8Array.from(voiced), noise };
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

/** How much of a drift back onto the analysis marks is done a share `u` of the way through it: its pace rises over the first SETTLE_RAMP of it and falls over the last. */
function settled(u: number): number {
  const r = SETTLE_RAMP;
  const k = 1 / (2 * r * (1 - r));
  if (u <= r) return k * u * u;
  if (u >= 1 - r) return 1 - k * (1 - u) * (1 - u);
  return (u - r / 2) / (1 - r);
}

/** The synthesis marks, locked again by `end` (a frame of those read: the patch's last) wherever they can be; `grid`: the grid's step (samples). */
function synthesisPlan(marks: Marks, shift: Float64Array, still: Still, end: number, grid: number): Plan {
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
  const lockOn = (m: number): number => {
    tau.push(t[m] as number);
    src.push(m);
    return m;
  };

  /**
   * Nothing moves at synthesis mark j: lock again, if nothing moves from there on until the marks are
   * back on the analysis marks (before `end`). Into noise, onto its first analysis mark straight away
   * (a grid step past the last voiced grain, in place of mark j where it can be, else half a grid step
   * past the marks followed so far, so the grains between still cross over); where it's voiced, after
   * following the recording's periods and drifting back bit by bit. The analysis mark locked onto, or −1.
   */
  const relock = (j: number): number => {
    const x0 = tau[j] as number;
    const steps: number[] = [];
    let x = x0;
    for (let q = 0; q < SETTLE_MAX; q++) {
      const i = interval(x);
      if (i + 1 >= K) return -1;
      if (marks.noise[i + 1]) {
        // into noise: lock onto its next mark, a grid step past the mark before at least (in place
        // of mark j itself where nothing moves from there on, so no grain read off the recording's time plays)
        if (q === 0 && j > 0) {
          const before = tau[j - 1] as number;
          let m = interval(before) + 1;
          while (m < K && ((t[m] as number) < before + grid || !still(t[m] as number, x0 + 1))) m++;
          if (m < K && marks.noise[m] && (t[m] as number) < end && still(x0, (t[m] as number) + 1)) {
            tau.pop();
            src.pop();
            return lockOn(m);
          }
        }
        let m = i + 1;
        if ((t[m] as number) - x < grid / 2) m++;
        if (m >= K || !marks.noise[m] || (t[m] as number) >= end || !still(x0, (t[m] as number) + 1)) return -1;
        for (const s of steps) {
          tau.push(s);
          src.push(nearest(s));
        }
        return lockOn(m);
      }
      // (where its periods aren't marked, they can't be followed)
      if (!marks.voiced[i] || !marks.voiced[i + 1]) break;
      const next = x + ((t[i + 1] as number) - (t[i] as number));
      // (a period's room left after it, for the mark it locks onto)
      if (next > last || 2 * next - x >= end || !still(x, 2 * next - x + 1)) break;
      steps.push(next);
      x = next;
    }
    if (steps.length < SETTLE) return -1;
    // how far the marks are off the analysis marks, and over how many marks that's made up
    const S = steps.length;
    const off0 = (t[nearest(steps[S - 1] as number)] as number) - (steps[S - 1] as number);
    const p = (t[Math.min(K - 1, interval(x0) + 1)] as number) - (t[interval(x0)] as number);
    const need = Math.ceil(Math.abs(off0) / (SETTLE_CHANGE * p * (1 - SETTLE_RAMP)));
    const N = Math.min(S, Math.max(SETTLE_VOICED, need));
    const xN = steps[N - 1] as number;
    const m = nearest(xN);
    const target = t[m] as number;
    if (target <= x0 || target >= end || !still(xN, target + 1)) return -1;
    const off = target - xN;
    for (let q = 1; q < N; q++) {
      const s = (steps[q - 1] as number) + off * settled(q / N);
      tau.push(s);
      src.push(nearest(s));
    }
    return lockOn(m);
  };

  tau.push(t[0] as number);
  src.push(0);
  let k = 0; // the analysis mark the synthesis marks are locked on, or −1
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
      k = -1;
    }
    const i = interval(x);
    if (i + 1 >= K) break;
    const p = (t[i + 1] as number) - (t[i] as number);
    const next = x + p / 2 ** (shiftAt(x + p / 2) / 12);
    if (next >= last) break;
    tau.push(next);
    src.push(nearest(next));
    if (shiftAt(next) === 0) k = relock(j + 1);
  }
  return { tau, src };
}

/** A grain read faster than recorded reads through a cutoff table: its cutoff, down to a 64th, so few are made (and kept). */
const CUTOFF_STEPS = 64;
const tables: (Float64Array | undefined)[] = [];

function tableFor(pace: number): Float64Array {
  const step = Math.max(1, Math.floor(Math.min(1, 1 / pace) * CUTOFF_STEPS));
  let table = tables[step];
  if (!table) {
    table = cutoffTable(step / CUTOFF_STEPS);
    tables[step] = table;
  }
  return table;
}

/**
 * The channels overlap-added by the plan into `out` (frames lo to hi of those read; `out` holds the
 * recording's own, which stay wherever the marks are locked), each voiced period's level put back to
 * the recording's around it (`energy`: the running sum of squares of the line heard).
 */
function overlapAdd(
  base: readonly Float32Array[],
  out: Float32Array[],
  energy: Float64Array,
  marks: Marks,
  plan: Plan,
  formant: Float64Array,
  w0: number,
  lo: number,
  hi: number,
): void {
  const t = marks.at;
  const { tau, src } = plan;
  const J = tau.length;
  const K = t.length;
  const C = base.length;
  if (J < 2) return;
  const gap = (k: number): number =>
    K < 2 ? Number.POSITIVE_INFINITY : (t[Math.min(K - 1, k + 1)] as number) - (t[Math.max(0, k)] as number);
  // each grain's reach either side, and how it's read: as recorded (its pace 1), whole samples off its
  // analysis mark and the taps between, made once; or at its pace, through the cutoff table for it
  const left = new Float64Array(J);
  const right = new Float64Array(J);
  const whole = new Int32Array(J);
  const pace = new Float64Array(J);
  const taps: (Float64Array | null)[] = [];
  for (let q = 0; q < J; q++) {
    const s = src[q] as number;
    const x = tau[q] as number;
    left[q] = Math.min(gap(s > 0 ? s - 1 : 0), q > 0 ? x - (tau[q - 1] as number) : Number.POSITIVE_INFINITY);
    right[q] = Math.min(gap(s < K - 1 ? s : K - 2), q + 1 < J ? (tau[q + 1] as number) - x : Number.POSITIVE_INFINITY);
    const f = marks.voiced[s] ? (formant[Math.max(0, Math.min(formant.length - 1, Math.round(x)))] as number) : 0;
    pace[q] = f === 0 ? 1 : 2 ** (f / 12);
    const off = (t[s] as number) - x;
    whole[q] = Math.floor(off);
    const frac = off - Math.floor(off);
    taps.push(pace[q] !== 1 ? tableFor(pace[q] as number) : frac === 0 ? null : fractionalTaps(frac));
  }
  const hA = new Float64Array(INTERP_TAPS);
  const hB = new Float64Array(INTERP_TAPS);
  const vA = new Float64Array(C);
  const vB = new Float64Array(C);
  /** Grain q's sound at frame i (of those read), each channel's into `v` (taps worked out in `h`, where its pace isn't 1). */
  const read = (q: number, i: number, h: Float64Array, v: Float64Array): void => {
    const a = pace[q] as number;
    let z: number;
    let k: Float64Array | null;
    if (a === 1) {
      z = w0 + i + (whole[q] as number);
      k = taps[q] as Float64Array | null;
    } else {
      const at = w0 + (t[src[q] as number] as number) + a * (i - (tau[q] as number));
      z = Math.floor(at);
      const frac = at - z;
      k = frac === 0 && a < 1 ? null : tableTaps(taps[q] as Float64Array, frac, h);
    }
    for (let ch = 0; ch < C; ch++) {
      const c = base[ch] as Float32Array;
      if (!k) {
        v[ch] = z >= 0 && z < c.length ? (c[z] as number) : 0;
        continue;
      }
      const from = z + FIRST_TAP;
      let y = 0;
      if (from >= 0 && from + INTERP_TAPS <= c.length)
        for (let m = 0; m < INTERP_TAPS; m++) y += (k[m] as number) * (c[from + m] as number);
      else
        for (let m = 0; m < INTERP_TAPS; m++)
          if (from + m >= 0 && from + m < c.length) y += (k[m] as number) * (c[from + m] as number);
      v[ch] = y;
    }
  };
  // what each period between synthesis marks is: copied (0), made (1), made of voiced grains (2); its
  // energy made, mean of the channels, and the recording's around the marks it was read from
  const kind = new Uint8Array(J);
  const made = new Float64Array(J);
  const wanted = new Float64Array(J);
  /** The recording's power around analysis mark s: from halfway to the mark before to halfway to the next. */
  const power = (s: number): number => {
    const a = Math.max(0, Math.round(((t[Math.max(0, s - 1)] as number) + (t[s] as number)) / 2));
    const b = Math.min(energy.length - 1, Math.round(((t[s] as number) + (t[Math.min(K - 1, s + 1)] as number)) / 2));
    return b > a ? ((energy[b] as number) - (energy[a] as number)) / (b - a) : 0;
  };
  for (let q = 0; q + 1 < J; q++) {
    const x0 = tau[q] as number;
    const x1 = tau[q + 1] as number;
    // between two marks locked on neighbouring analysis marks, read as recorded, the recording as it is
    const s0 = src[q] as number;
    const s1 = src[q + 1] as number;
    if (s1 === s0 + 1 && x0 === t[s0] && x1 === t[s1] && pace[q] === 1 && pace[q + 1] === 1) continue;
    kind[q] = marks.voiced[s0] && marks.voiced[s1] ? 2 : 1;
    const from = Math.max(lo, Math.ceil(x0));
    const to = Math.min(hi, Math.ceil(x1));
    const r = right[q] as number;
    const l = left[q + 1] as number;
    let sum = 0;
    for (let i = from; i < to; i++) {
      const du = i - x0;
      const dv = x1 - i;
      const fade = du < r ? 0.5 + 0.5 * Math.cos((Math.PI * du) / r) : 0;
      const rise = dv < l ? 0.5 + 0.5 * Math.cos((Math.PI * dv) / l) : 0;
      if (fade > 0) read(q, i, hA, vA);
      if (rise > 0) read(q + 1, i, hB, vB);
      let mean = 0;
      for (let ch = 0; ch < C; ch++) {
        const y = (fade > 0 ? fade * (vA[ch] as number) : 0) + (rise > 0 ? rise * (vB[ch] as number) : 0);
        (out[ch] as Float32Array)[i - lo] = y;
        mean += y;
      }
      mean /= C;
      sum += mean * mean;
    }
    made[q] = sum;
    wanted[q] = (Math.max(0, to - from) * (power(s0) + power(s1))) / 2;
  }
  // each voiced period's level, against the recording's, over the periods around it made of voiced grains
  const level = new Float64Array(J).fill(1);
  for (let q = 0; q + 1 < J; q++) {
    if (kind[q] !== 2) continue;
    let m = 0;
    let w = 0;
    for (let d = -LEVEL_REACH; d <= LEVEL_REACH; d++) {
      // (as far as the periods made of voiced grains run on unbroken)
      const e = q + d;
      let ok = e >= 0 && e + 1 < J;
      for (let g = Math.min(q, e); ok && g <= Math.max(q, e); g++) ok = kind[g] === 2;
      if (!ok) continue;
      m += made[e] as number;
      w += wanted[e] as number;
    }
    if (m > 0 && w > 0) level[q] = Math.min(LEVEL_MAX, Math.max(1 / LEVEL_MAX, Math.sqrt(w / m)));
  }
  // put back, in line from each period's middle to the next's (1 where a period is copied)
  for (let q = 0; q + 1 < J; q++) {
    if (kind[q] === 0) continue;
    const g = level[q] as number;
    const before = q > 0 && kind[q - 1] !== 0 ? ((level[q - 1] as number) + g) / 2 : 1;
    const after = q + 2 < J && kind[q + 1] !== 0 ? ((level[q + 1] as number) + g) / 2 : 1;
    if (g === 1 && before === 1 && after === 1) continue;
    const x0 = tau[q] as number;
    const x1 = tau[q + 1] as number;
    const middle = (x0 + x1) / 2;
    const from = Math.max(lo, Math.ceil(x0));
    const to = Math.min(hi, Math.ceil(x1));
    for (let i = from; i < to; i++) {
      const v =
        i < middle
          ? before + ((g - before) * (i - x0)) / (middle - x0)
          : g + ((after - g) * (i - middle)) / (x1 - middle);
      for (let ch = 0; ch < C; ch++)
        (out[ch] as Float32Array)[i - lo] = ((out[ch] as Float32Array)[i - lo] as number) * v;
    }
  }
}
