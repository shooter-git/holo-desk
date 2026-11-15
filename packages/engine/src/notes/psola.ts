/**
 * A line's notes moved in pitch, formant and time, and pasted, offline (the patches of a `mono` region:
 * patch.ts): pitch-synchronous overlap-add (TD-PSOLA). The same recording and patch give the same
 * samples wherever it runs.
 *
 * - **The way through.** Each frame of the patch plays the sound of one place in the recording: the
 *   warp the notes' moves make (audio-notes.ts in the session: `ts`, `te`, `at`) says what time of the
 *   notes plays there, and a pasted note (`s`) plays the sound found `s − t` later than its own place.
 *   Piece by piece that's the identity (outside the warp's islands and pasted notes, and always
 *   outside the patch itself), a move (a note moved whole, its consonant, a pasted note: the sound read
 *   a fixed number of frames away) or a stretch (the warp squeezing or stretching the sound between
 *   its anchors). The warp is in seconds of the file, the patch in frames of the recording as the
 *   region plays it, so a second of the warp is `rate × stretch` frames.
 * - **Hearing it.** The mean of the channels, from 200 ms before anything can move to 200 ms after
 *   (and 100 ms past the patch at least; within the frames the patch may read, `ctx`), and 200 ms
 *   either side of where a pasted note's sound comes from. Its pitch is the fine track
 *   (analysis/take.ts: every 5 ms, as note-finding hears it), its voiced runs shorter than 15 ms let go
 *   and its gaps filled in where the sound still repeats itself near the period between the pitches
 *   either side: up to 25 ms, or 60 ms where its level doesn't dip (the track loses a fast glide; a
 *   consonant isn't filled in). In a gap filled in, the pitch is read from the analysis marks, which
 *   follow the sound itself. A patch that only changes levels isn't heard at all.
 * - **Analysis marks.** Through a voiced run, one period apart: the first at the run's loudest sample in
 *   its first period, each next where the period around it best matches the one around the mark before
 *   (normalized cross-correlation, within 20% of the period the track says). Elsewhere, every 5 ms from
 *   the recording's first frame, so they fall in the same places whatever stretch is read. (A voiced run
 *   more than 100 ms from where anything can move is only ever copied: it's marked every 5 ms too.)
 * - **The shift and the formant.** curve.ts `targetShift` (from the pitch heard: the notes' centres,
 *   drift, vibrato and glides) and `formantShift`, at the time of the notes each frame plays: so a
 *   note's edits move with it. A pasted note's pitch as found is its sound's, read where that comes
 *   from. Neither moves where the sound read isn't voiced, so a consonant or a breath inside a moved
 *   note isn't moved.
 * - **Synthesis marks** lie on the patch's own frames. Each lies the period divided by the ratio
 *   (2^(shift/12)) after the one before, the period of the sound read there, and takes the grain of the
 *   analysis mark nearest where it's read: where the sound is stretched a grain plays again, where it's
 *   squeezed one is left out, and the voice keeps its pitch. A grain is the sound around its mark under a
 *   Hann window whose halves reach as far as the nearer of the analysis mark's neighbour and the
 *   synthesis mark's, so that from one synthesis mark to the next one grain fades out as the next fades
 *   in (adding to one, except where the pitch goes down: the grains are then further apart than the
 *   sound they were read from, and keep to its length). A grain placed between samples is read between
 *   them (interp.ts). Where the sound isn't voiced, grains are read from exactly where the way says, a
 *   grid step apart (so a consonant moved whole plays as it was); where that sound is stretched, each
 *   from a place picked by a hash of where it plays, within half a step of that (one grain played again
 *   and again would buzz). Out of sound with no pitch into a voice, a synthesis mark lands on where the
 *   voice's first analysis mark now plays, so a note after a rest starts where it was moved to.
 * - **Formant.** A voiced grain is read 2^(formant/12) times as fast as it was recorded (through the
 *   same windowed sinc, its cutoff lowered as much as it's sped up), under the same window: its
 *   formants move by that much, its pitch (where the grains are) doesn't. Grains of unvoiced sound are
 *   read as they were.
 * - **Level.** Grains brought closer together or further apart overlap more or less, and a voice's
 *   energy sits in a pulse each period: moved a few semitones, the level would drift by a dB or two.
 *   So each period the voiced grains make (between two synthesis marks) is measured against the
 *   recording around the marks it was read from, over the five periods around it, and its level put
 *   back (between periods in line, back to 1 where the sound is copied). Grains read from places picked
 *   by a hash are different sound and don't add as one (a stretched breath would lose a dB or two):
 *   their periods are put back the same way.
 * - **Locked.** Wherever the pitch and the formant don't move and the way is the identity or a move,
 *   the synthesis marks are the analysis marks, moved as the way moves them, and the sound is copied:
 *   to the bit where nothing moves (overlap-added, it would be a rounding away); read a fixed distance
 *   away where it's moved. A change starts from an analysis mark. Once nothing changes from a synthesis
 *   mark on, the marks lock again: into sound with no pitch, straight onto the first analysis mark there
 *   a grid step past the last voiced grain (a jump in noise is heard as nothing, and that grain fades
 *   over it); into a voice from sound with no pitch, straight onto its first mark, half a grid step past
 *   the grain before at least. Where it's voiced they follow the recording's periods (through a
 *   stretch too, so a moved note's neighbour brings them onto the note's marks as it plays) and drift
 *   onto its marks bit by bit: each period changed by a hundredth at most where the patch has room
 *   (over up to 64 periods), by what its room allows where it hasn't, the change coming in and going
 *   over the first and last quarter of them so that neighbouring periods differ by much less. So a
 *   patch, which reaches past its edits, starts and ends as the recording does; a breath between moved
 *   notes is copied as it is. Where the sound read jumps (into or out of a pasted note) no periods are
 *   followed across: the marks lock straight onto the other side's, from the first played half a
 *   period past the mark before (one just before the jump too, so the jump lands on that sound's own
 *   periods). The sound changes there anyway; marks drifting onto it would bend its pitch for a few
 *   hundred ms.
 * - **Level edits** (curve.ts `noteGain`), last, at the time of the notes each frame plays.
 *
 * Every channel is moved by the same marks and levels, so a stereo image stays where it was.
 */
import { type AudioNote, type Warp, warpAt, warpOf } from '@holo/session';
import { FINE_STEP_S, fineTrack } from '../analysis/take.ts';
import { formantShift, noteGain, type PitchTrack, pitchSpan, targetShift } from './curve.ts';
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
/** Two moves this close (frames) are one: the same rounding of one move. */
const SAME_MOVE = 1e-6;
/** A piece of the warp this close to a slope of 1 moves the sound rather than stretching it. */
const SLOPE_EPS = 1e-9;
/** Where the place read moves on by more than this (frames) from one piece to the next, the sound read jumps. */
const JUMP = 0.5;

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
  const way = wayOf(spec.notes, scale, a, b, c0, c1);
  const span = movingSpan(spec.notes, way, scale, a, b);
  if (span) {
    const [first, last] = span;
    // the frames heard: 200 ms either side of where anything can move
    const reach = Math.round(HEARD_S * sr);
    const w0 = Math.max(c0, first - reach);
    // (and 100 ms past the patch at least: the fine track stops short of the end of what it hears, and the
    // marks drifting back onto the recording's want to follow its periods to the patch's end)
    const w1 = Math.min(c1, Math.max(last + 1 + reach, b + (reach >> 1)));
    const heard = hear(base, sr, windowsOf(way, [w0, w1], [first, last], reach, c0, c1), first);
    const main = heard.main;
    const n = main.w1 - main.w0;
    // the time of the notes each frame plays, and the pitch as found at those times
    const at = new Float64Array(n);
    way.noteTimes(main.w0, at);
    const shift = targetShift(spec.notes, at, noteTrack(spec.notes, heard, sr, scale));
    const formant = formantShift(spec.notes, at);
    let moves = way.kind.some((k) => k !== IDENTITY);
    for (let i = 0; i < n; i++) {
      const y = main.w0 + i;
      // (nothing moves outside the patch: what a note near it does is its own patch's; nor where the sound read isn't voiced)
      if (y < a || y >= b || !heard.voicedAt(way.src(y))) {
        shift[i] = 0;
        formant[i] = 0;
      }
      if (shift[i] !== 0 || formant[i] !== 0) moves = true;
    }
    if (moves && heard.marks.at.length) {
      const lay = layout(way, shift, formant, main.w0);
      const plan = synthesisPlan(heard, way, lay, b, Math.round(GRID_S * sr));
      overlapAdd(base, out, heard.marks, plan, formant, main.w0, a, b);
    }
  }
  const times = new Float64Array(b - a);
  way.noteTimes(a, times);
  const gain = noteGain(spec.notes, times);
  for (const c of out)
    for (let i = 0; i < Math.min(c.length, gain.length); i++)
      if (gain[i] !== 1) c[i] = (c[i] as number) * (gain[i] as number);
  return out;
}

// ---- the way through: what each frame of the patch plays ----

const IDENTITY = 0;
const MOVED = 1;
const STRETCHED = 2;

/**
 * Where each frame of a patch reads its sound, piece by piece (frames of the recording as the region
 * plays it): the identity, a move (read `d` frames earlier) or a stretch (from frame `s0` at its start,
 * `k` frames read a frame played); and the time of the notes it plays (seconds of the file).
 */
interface Way {
  /** Each piece's first frame (ascending, the first −∞), and what it is. */
  y0: number[];
  kind: number[];
  /** A moved piece: how many frames after where it's read it plays; and how many seconds after the time of the notes it plays. */
  d: number[];
  xd: number[];
  /** A stretched piece: where its first frame is read and how fast, and the time of the notes there and how fast that goes (s a frame). */
  s0: number[];
  k: number[];
  x0: number[];
  xk: number[];
  /** Whether a piece plays a rest or a note with no pitch (not a note's voice: its consonant lead is moved whole, never stretched). */
  rest: boolean[];
  /** Whether a piece plays a pasted note: its sound comes from elsewhere, so where it stops reading isn't where the piece after it starts. */
  pasted: boolean[];
  /** Whether any does. */
  pastes: boolean;
  scale: number;
  src(y: number): number;
  /** Where piece p reads frame y (as it would past its own frames too). */
  srcIn(p: number, y: number): number;
  /** Whether the sound read jumps from somewhere to elsewhere after frame y0, up to y1 (into or out of a pasted note). */
  jumps(y0: number, y1: number): boolean;
  noteTimes(from: number, into: Float64Array): void;
  /** The piece a frame is in. */
  pieceAt(y: number): number;
  /** Where frames `from` to `to` first read frame z, or NaN where they don't (they jump past it, or stop short). */
  outputOf(z: number, from: number, to: number): number;
}

/**
 * The way a patch's notes make (frames `a` to `b`, the identity everywhere else): the warp their moves
 * make, and the notes pasted from sound within the frames it may read (c0 to c1).
 */
function wayOf(notes: readonly AudioNote[], scale: number, a: number, b: number, c0: number, c1: number): Way {
  const warp: Warp = warpOf(notes);
  const pasted: { t0: number; t1: number; off: number }[] = [];
  for (const n of notes)
    if (n.s !== undefined && n.s !== n.t && n.s * scale >= c0 && (n.s + n.d) * scale <= c1)
      pasted.push({ t0: n.t, t1: n.t + n.d, off: n.s - n.t });
  // where pieces start: the warp's anchors and pasted notes' edges, as they now play, within the patch
  const cuts = [a, b];
  for (const y of warp.out) cuts.push(y * scale);
  for (const p of pasted) cuts.push(warpAt(warp, p.t0) * scale, warpAt(warp, p.t1) * scale);
  const inside = cuts.filter((y) => y >= a && y <= b).sort((u, v) => u - v);
  const way: Way = {
    y0: [],
    kind: [],
    d: [],
    xd: [],
    s0: [],
    k: [],
    x0: [],
    xk: [],
    rest: [],
    pasted: [],
    pastes: false,
    scale,
    src(y) {
      return this.srcIn(this.pieceAt(y), y);
    },
    srcIn(p, y) {
      const kind = this.kind[p];
      if (kind === IDENTITY) return y;
      if (kind === MOVED) return y - (this.d[p] as number);
      return (this.s0[p] as number) + (y - (this.y0[p] as number)) * (this.k[p] as number);
    },
    jumps(y0, y1) {
      if (!this.pastes) return false;
      for (let p = this.pieceAt(y0) + 1; p < this.y0.length && (this.y0[p] as number) <= y1; p++) {
        const y = this.y0[p] as number;
        if ((this.pasted[p] || this.pasted[p - 1]) && Math.abs(this.srcIn(p, y) - this.srcIn(p - 1, y)) > JUMP)
          return true;
      }
      return false;
    },
    noteTimes(from, into) {
      let p = this.pieceAt(from);
      for (let i = 0; i < into.length; i++) {
        const y = from + i;
        while (p + 1 < this.y0.length && (this.y0[p + 1] as number) <= y) p++;
        const kind = this.kind[p];
        into[i] =
          kind === IDENTITY
            ? y / scale
            : kind === MOVED
              ? y / scale - (this.xd[p] as number)
              : (this.x0[p] as number) + (y - (this.y0[p] as number)) * (this.xk[p] as number);
      }
    },
    pieceAt(y) {
      let lo = 0;
      let hi = this.y0.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((this.y0[mid] as number) <= y) lo = mid;
        else hi = mid - 1;
      }
      return lo;
    },
    outputOf(z, from, to) {
      for (let p = this.pieceAt(from); p < this.y0.length && (this.y0[p] as number) < to; p++) {
        const ya = Math.max(from, this.y0[p] as number);
        const yb = Math.min(to, p + 1 < this.y0.length ? (this.y0[p + 1] as number) : Number.POSITIVE_INFINITY);
        if (!(yb > ya)) continue;
        const kind = this.kind[p];
        const y =
          kind === IDENTITY
            ? z
            : kind === MOVED
              ? z + (this.d[p] as number)
              : (this.y0[p] as number) + (z - (this.s0[p] as number)) / (this.k[p] as number);
        if (y < ya) return Number.NaN;
        if (y < yb) return y;
      }
      return Number.NaN;
    },
  };
  const piece = (
    y0: number,
    kind: number,
    d: number,
    xd: number,
    s0: number,
    k: number,
    x0: number,
    xk: number,
    rest = false,
    pasted = false,
  ) => {
    way.rest.push(rest);
    way.pasted.push(pasted);
    way.y0.push(y0);
    way.kind.push(kind);
    way.d.push(d);
    way.xd.push(xd);
    way.s0.push(s0);
    way.k.push(k);
    way.x0.push(x0);
    way.xk.push(xk);
  };
  piece(Number.NEGATIVE_INFINITY, IDENTITY, 0, 0, 0, 1, 0, 0);
  for (let c = 0; c + 1 < inside.length; c++) {
    const f0 = inside[c] as number;
    const f1 = inside[c + 1] as number;
    if (!(f1 > f0)) continue;
    // the warp's piece in the middle of it (none: the identity)
    const mid = (f0 + f1) / 2 / scale;
    const { src, out } = warp;
    let i = -1;
    if (out.length >= 2 && mid > (out[0] as number) && mid < (out[out.length - 1] as number)) {
      let lo = 0;
      let hi = out.length - 1;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if ((out[m] as number) <= mid) lo = m;
        else hi = m;
      }
      i = lo;
    }
    const xa = i < 0 ? 0 : (src[i] as number);
    const ya = i < 0 ? 0 : (out[i] as number);
    const still = i < 0 || (xa === ya && src[i + 1] === out[i + 1]);
    const slope = still ? 1 : ((src[i + 1] as number) - xa) / ((out[i + 1] as number) - ya);
    const x = still ? mid : xa + (mid - ya) * slope;
    const off = pasted.find((p) => x >= p.t0 && x < p.t1)?.off ?? 0;
    if (still && off === 0) piece(f0, IDENTITY, 0, 0, 0, 1, 0, 0);
    else if (Math.abs(slope - 1) <= SLOPE_EPS) {
      // moved whole: read a fixed distance away (one move a hair off the piece before's is the same move)
      const xd = still ? 0 : ya - xa;
      let d = (xd - off) * scale;
      const prev = way.kind.length - 1;
      if (way.kind[prev] === MOVED && Math.abs((way.d[prev] as number) - d) < SAME_MOVE) d = way.d[prev] as number;
      piece(f0, MOVED, d, xd, 0, 1, 0, 0, false, off !== 0);
    } else {
      const x0 = xa + (f0 / scale - ya) * slope;
      const voice = notes.some((n) => n.p !== null && x >= n.t + (n.u ?? 0) && x < n.t + n.d);
      piece(f0, STRETCHED, 0, 0, (x0 + off) * scale, slope, x0, slope / scale, !voice, off !== 0);
    }
  }
  piece(b, IDENTITY, 0, 0, 0, 1, 0, 0);
  way.pastes = way.pasted.includes(true);
  return way;
}

/**
 * The frames of a patch from the first to the last where anything can move (the pitch or formant of a
 * note, or the way), or null where nothing does.
 */
function movingSpan(
  notes: readonly AudioNote[],
  way: Way,
  scale: number,
  a: number,
  b: number,
): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let p = 0; p < way.kind.length; p++) {
    if (way.kind[p] === IDENTITY) continue;
    lo = Math.min(lo, Math.ceil(way.y0[p] as number));
    hi = Math.max(hi, Math.floor((way.y0[p + 1] as number) - 1e-9));
  }
  const span = pitchSpan(notes);
  if (span) {
    // (the warp is the identity at the patch's edges: within them, where the notes move now plays)
    const x0 = Math.max(span[0], a / scale);
    const x1 = Math.min(span[1], b / scale);
    if (x1 >= x0) {
      const w = warpOf(notes);
      lo = Math.min(lo, Math.ceil(warpAt(w, x0) * scale));
      hi = Math.max(hi, Math.floor(warpAt(w, x1) * scale));
    }
  }
  lo = Math.max(a, lo);
  hi = Math.min(b - 1, hi);
  return hi >= lo ? [lo, hi] : null;
}

// ---- hearing it ----

/** A stretch of the recording heard (frames w0 to w1), and where in it (frames) its voiced runs are marked period by period around. */
interface Window {
  w0: number;
  w1: number;
  moving: [number, number][];
}

/**
 * What's heard: the stretch around where anything can move (`main`, frames w0 to w1, moving from
 * `first` to `last`), and around where a piece of the way reads from elsewhere (a pasted note's sound);
 * those that overlap heard as one.
 */
function windowsOf(
  way: Way,
  [w0, w1]: [number, number],
  [first, last]: [number, number],
  reach: number,
  c0: number,
  c1: number,
): Window[] {
  const all: Window[] = [{ w0, w1, moving: [[first, last]] }];
  for (let p = 0; p < way.kind.length; p++) {
    if (way.kind[p] === IDENTITY) continue;
    const y0 = way.y0[p] as number;
    const y1 = way.y0[p + 1] as number;
    // (a pasted note's sound is heard to where its own piece stops reading it, not to where the next
    // piece starts: that's elsewhere in the recording)
    const s0 = way.src(y0);
    const s1 = way.pasted[p] ? way.srcIn(p, y1) : way.src(y1);
    const lo = Math.floor(Math.min(s0, s1));
    const hi = Math.ceil(Math.max(s0, s1));
    const from = Math.max(c0, lo - reach);
    const to = Math.min(c1, hi + 1 + reach);
    if (to > from) all.push({ w0: from, w1: to, moving: [[lo, hi]] });
  }
  all.sort((x, y) => x.w0 - y.w0 || x.w1 - y.w1);
  const out: Window[] = [];
  for (const w of all) {
    const last = out[out.length - 1];
    if (last && w.w0 <= last.w1) {
      last.w1 = Math.max(last.w1, w.w1);
      last.moving.push(...w.moving);
    } else out.push({ w0: w.w0, w1: w.w1, moving: [...w.moving] });
  }
  return out;
}

/** A stretch heard: its frames, its pitch heard, and its marks' first and last index among all. */
interface Hearing extends Window {
  heard: Heard;
  k0: number;
  k1: number;
}

/** All that's heard: each stretch, the main one, every analysis mark (frames of the recording), and whether the sound at a frame is voiced. */
interface Analysis {
  wins: Hearing[];
  main: Hearing;
  marks: AllMarks;
  voicedAt(frame: number): boolean;
}

function hear(base: readonly Float32Array[], sr: number, windows: Window[], first: number): Analysis {
  const wins: Hearing[] = [];
  const at: number[] = [];
  const voiced: number[] = [];
  const noise: number[] = [];
  const power: number[] = [];
  for (const w of windows) {
    const n = w.w1 - w.w0;
    const mono = new Float64Array(n);
    for (const c of base) for (let i = 0; i < n; i++) mono[i] = (mono[i] as number) + (c[w.w0 + i] as number);
    if (base.length > 1) for (let i = 0; i < n; i++) mono[i] = (mono[i] as number) / base.length;
    const heard = periodsOf(mono, sr);
    const energy = new Float64Array(n + 1);
    for (let i = 0; i < n; i++) energy[i + 1] = (energy[i] as number) + (mono[i] as number) * (mono[i] as number);
    // marked period by period: the voiced runs within 100 ms of where anything can move
    const moving = w.moving.map(([lo, hi]) => [lo - w.w0, hi - w.w0] as const);
    const marks = analysisMarks(
      mono,
      energy,
      heard.period,
      (x, y) => moving.every(([lo, hi]) => y < lo || x > hi),
      w.w0,
      sr,
    );
    // the pitch heard where the track lost it, from the marks
    pitchFromMarks(heard, marks, sr);
    const k0 = at.length;
    const t = marks.at;
    const K = t.length;
    for (let s = 0; s < K; s++) {
      at.push(w.w0 + (t[s] as number));
      voiced.push(marks.voiced[s] as number);
      noise.push(marks.noise[s] as number);
      // the recording's power around it: from halfway to the mark before to halfway to the next
      const lo = Math.max(0, Math.round(((t[Math.max(0, s - 1)] as number) + (t[s] as number)) / 2));
      const hi = Math.min(n, Math.round(((t[s] as number) + (t[Math.min(K - 1, s + 1)] as number)) / 2));
      power.push(hi > lo ? ((energy[hi] as number) - (energy[lo] as number)) / (hi - lo) : 0);
    }
    wins.push({ ...w, heard, k0, k1: at.length - 1 });
  }
  const main = wins.find((w) => first >= w.w0 && first < w.w1) as Hearing;
  return {
    wins,
    main,
    marks: {
      at: Int32Array.from(at),
      voiced: Uint8Array.from(voiced),
      noise: Uint8Array.from(noise),
      power: Float64Array.from(power),
    },
    voicedAt(frame) {
      const f = Math.round(frame);
      for (const w of wins) if (f >= w.w0 && f < w.w1) return !Number.isNaN(w.heard.period[f - w.w0] as number);
      return false;
    },
  };
}

/**
 * The pitch as found at the times of the notes, every 5 ms through what's heard of the patch: as heard
 * there, and within a pasted note, as heard where its sound comes from.
 */
function noteTrack(notes: readonly AudioNote[], heard: Analysis, sr: number, scale: number): PitchTrack {
  const main = heard.main;
  const t = Float64Array.from(main.heard.t, (s) => (main.w0 + s * sr) / scale);
  const midi = Float64Array.from(main.heard.midi);
  for (const n of notes) {
    if (n.s === undefined || n.s === n.t) continue;
    for (let k = 0; k < t.length; k++) {
      const x = t[k] as number;
      if (x < n.t || x >= n.t + n.d) continue;
      const f = (x + n.s - n.t) * scale;
      const w = heard.wins.find((v) => f >= v.w0 && f < v.w1);
      if (w) midi[k] = pitchAt(w.heard, (f - w.w0) / sr);
    }
  }
  return { t, midi };
}

/** A pitch track's pitch at a time (s from its first sample): in line between steps, the nearer step's where the other isn't voiced, NaN outside. */
function pitchAt(heard: Heard, x: number): number {
  const { t, midi } = heard;
  const steps = t.length;
  if (!steps || x < (t[0] as number) || x > (t[steps - 1] as number)) return Number.NaN;
  let lo = 0;
  let hi = steps - 1;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if ((t[m] as number) <= x) lo = m;
    else hi = m;
  }
  const a = midi[lo] as number;
  const b = midi[hi] as number;
  const u = hi > lo ? (x - (t[lo] as number)) / ((t[hi] as number) - (t[lo] as number)) : 0;
  if (Number.isNaN(a) || Number.isNaN(b)) return u < 0.5 ? a : b;
  return a + (b - a) * u;
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

/** Whether nothing moves anywhere from sample lo up to hi (of the frames heard). */
type Still = (lo: number, hi: number) => boolean;

/** Analysis marks (samples, ascending), whether each is a voiced run's, and whether it's in sound with no pitch (a grid mark where it isn't voiced). */
interface Marks {
  at: Int32Array;
  voiced: Uint8Array;
  noise: Uint8Array;
}

/** Every analysis mark heard (frames of the recording), and the recording's power around each (from halfway to the mark before to halfway to the next; mean of the channels). */
interface AllMarks extends Marks {
  power: Float64Array;
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

/** A number from 0 to 1 for a whole number, the same every time (a multiply–xorshift hash). */
function hash01(i: number): number {
  let h = (i | 0) ^ 0x9e3779b9;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  h ^= h >>> 16;
  return (h >>> 0) / 4294967296;
}

/** What moves where, frame by frame through the main stretch heard. */
interface Layout {
  /** The shift (semitones) at a frame. */
  shiftAt(y: number): number;
  /** Whether the pitch and the formant don't move anywhere from frame lo up to hi. */
  still(lo: number, hi: number): boolean;
  /** How far after where they're read frames lo up to hi play (either way round), where the marks can lock on them: the pitch and formant still, one move all through (0 the identity); else NaN. */
  lockable(lo: number, hi: number): number;
  /** How far after where it's read frame y plays, NaN where the sound is stretched. */
  moveAt(y: number): number;
}

function layout(way: Way, shift: Float64Array, formant: Float64Array, w0: number): Layout {
  const n = shift.length;
  const moved = new Int32Array(n + 1);
  for (let i = 0; i < n; i++) moved[i + 1] = (moved[i] as number) + (shift[i] !== 0 || formant[i] !== 0 ? 1 : 0);
  // runs of frames read the same distance away, one after another (−1 where the sound is stretched)
  const run = new Int32Array(n);
  const runD: number[] = [];
  let p = way.pieceAt(w0);
  for (let i = 0; i < n; i++) {
    const y = w0 + i;
    while (p + 1 < way.y0.length && (way.y0[p + 1] as number) <= y) p++;
    const kind = way.kind[p];
    if (kind === STRETCHED) {
      run[i] = -1;
      continue;
    }
    const d = kind === MOVED ? (way.d[p] as number) : 0;
    const r = runD.length - 1;
    if (i > 0 && r >= 0 && run[i - 1] === r && runD[r] === d) run[i] = r;
    else {
      runD.push(d);
      run[i] = runD.length - 1;
    }
  }
  const index = (y: number) => Math.max(0, Math.min(n - 1, Math.floor(y) - w0));
  const count = (y: number) => moved[Math.max(0, Math.min(n, Math.floor(y) - w0))] as number;
  return {
    shiftAt: (y) => shift[Math.max(0, Math.min(n - 1, Math.round(y) - w0))] as number,
    still: (lo, hi) => count(hi) === count(lo),
    lockable(lo, hi) {
      const l = Math.min(lo, hi);
      const h = Math.max(lo, hi);
      if (count(h) !== count(l)) return Number.NaN;
      const r = run[index(l)] as number;
      return r >= 0 && run[index(Math.max(Math.floor(l), Math.floor(h) - 1))] === r ? (runD[r] as number) : Number.NaN;
    },
    moveAt(y) {
      const r = run[index(y)] as number;
      return r >= 0 ? (runD[r] as number) : Number.NaN;
    },
  };
}

/**
 * Synthesis marks (frames of the patch, ascending, between frames where they fall), the analysis mark
 * each takes its grain from, where its grain is read (a frame of the recording: its analysis mark's,
 * or where the way says for sound with no pitch), the move it's locked with (NaN where it isn't), and
 * whether that place was picked by a hash (1).
 */
interface Plan {
  tau: number[];
  src: number[];
  at: number[];
  lock: number[];
  hashed: number[];
}

/** How much of a drift back onto the analysis marks is done a share `u` of the way through it: its pace rises over the first SETTLE_RAMP of it and falls over the last. */
function settled(u: number): number {
  const r = SETTLE_RAMP;
  const k = 1 / (2 * r * (1 - r));
  if (u <= r) return k * u * u;
  if (u >= 1 - r) return 1 - k * (1 - u) * (1 - u);
  return (u - r / 2) / (1 - r);
}

/** The synthesis marks through the main stretch heard, locked again by `end` (the patch's last frame) wherever they can be; `grid`: the grid's step (frames). */
function synthesisPlan(heard: Analysis, way: Way, lay: Layout, end: number, grid: number): Plan {
  const { marks, main } = heard;
  const t = marks.at;
  const K = t.length;
  const plan: Plan = { tau: [], src: [], at: [], lock: [], hashed: [] };
  const { tau, src, at, lock, hashed } = plan;
  if (main.k1 < main.k0) return plan;
  const last = t[main.k1] as number;
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
  /**
   * The period of the sound read under a step from synthesis mark x: that of the analysis interval where
   * it's read; where the sound is stretched, that of the interval where its middle is read (else the
   * pitch the steps make would lag the grains by half a period).
   */
  const periodFrom = (x: number): number => {
    const i0 = interval(way.src(x));
    const p0 = (t[Math.min(K - 1, i0 + 1)] as number) - (t[i0] as number);
    const mid = x + p0 / 2;
    if (way.kind[way.pieceAt(x)] !== STRETCHED && way.kind[way.pieceAt(mid)] !== STRETCHED) return p0;
    const i = interval(way.src(mid));
    return i + 1 < K ? (t[i + 1] as number) - (t[i] as number) : p0;
  };
  const push = (y: number, s: number, from: number, d: number, hash = 0) => {
    tau.push(y);
    src.push(s);
    at.push(from);
    lock.push(d);
    hashed.push(hash);
  };
  const pop = () => {
    tau.pop();
    src.pop();
    at.pop();
    lock.pop();
    hashed.pop();
  };
  let k = main.k0; // the analysis mark the synthesis marks are locked on, or −1
  let D = 0; // and how far after it they play
  const lockOn = (m: number, d: number): number => {
    push((t[m] as number) + d, m, t[m] as number, d);
    D = d;
    return m;
  };
  /**
   * A synthesis mark at y, not locked: within a voiced run, the grain of the analysis mark nearest where
   * it's read; elsewhere (before a voice's first mark too, so no voice is heard before it starts) the
   * sound from where the way says; in a rest or a breath that's stretched, picked by a hash near there
   * (within half a grid step where it plays twice as long or more, less where it's stretched less; a
   * note's voice before the pitch is heard in it, soft as it starts, isn't moved about).
   */
  const free = (y: number) => {
    const z = way.src(y);
    const s = nearest(z);
    if (marks.voiced[s] && marks.voiced[interval(z)]) push(y, s, t[s] as number, Number.NaN);
    else {
      const p = way.pieceAt(y);
      const reach =
        way.kind[p] === STRETCHED && way.rest[p] ? Math.min(1, 2 * Math.max(0, 1 - (way.k[p] as number))) : 0;
      if (reach > 0) push(y, s, z + (hash01(Math.round(y)) - 0.5) * grid * reach, Number.NaN, 1);
      else push(y, s, z, Number.NaN);
    }
  };

  /**
   * Nothing moves the pitch at synthesis mark j: lock again, if nothing does from there on until the
   * marks are back on the analysis marks (as the way moves them, before `end`). Where it already sits on
   * a voiced mark, as it is. Into noise, onto its first analysis mark straight away (a grid step past the
   * last voiced grain, in place of mark j where it can be, else half a grid step past the marks followed
   * so far, so the grains between still cross over); out of noise into a voice, onto the voice's first
   * mark straight away; where it's voiced, after following the recording's periods (through a stretch
   * too) and drifting back bit by bit. The analysis mark locked onto, or −1.
   */
  const relock = (j: number): number => {
    const x0 = tau[j] as number;
    const s0 = src[j] as number;
    const d0 = lay.moveAt(x0);
    if (marks.voiced[s0] && at[j] === t[s0] && x0 === (t[s0] as number) + d0 && lay.lockable(x0, x0 + 1) === d0) {
      lock[j] = d0;
      D = d0;
      return s0;
    }
    if (j > 0 && !Number.isNaN(d0) && way.jumps(tau[j - 1] as number, x0)) {
      // where the sound read jumps (into or out of a pasted note), straight onto the marks of the sound
      // now read, in place of mark j (the sound changes there anyway; marks drifting onto it would bend
      // its pitch for a few hundred ms): from its first played half a period past the mark before, each
      // where it plays (one just before the jump too, so the jump lands on that sound's own periods),
      // locked from the first past it
      const before = tau[j - 1] as number;
      const half = periodFrom(x0) / 2;
      const far = x0 + 4 * half;
      let m = interval(before + half - d0);
      while (m < K && (t[m] as number) + d0 < before + half) m++;
      let r = m;
      while (
        r < K &&
        (t[r] as number) + d0 < far &&
        lay.lockable((t[r] as number) + d0, (t[r] as number) + d0 + 1) !== d0
      )
        r++;
      const o = (t[r] as number) + d0;
      if (r < K && r - m <= 1 && o < far && o < end && marks.voiced[m] && marks.voiced[r] && lay.still(before, o + 1)) {
        pop();
        if (r > m) push((t[m] as number) + d0, m, t[m] as number, d0);
        return lockOn(r, d0);
      }
    }
    const steps: number[] = [];
    let x = x0;
    let reached = -1; // the first step where the marks can lock
    for (let q = 0; q < SETTLE_MAX; q++) {
      const i = interval(way.src(x));
      if (i + 1 >= K) return -1;
      if (marks.noise[i + 1]) {
        // into noise: lock onto its next mark, a grid step past the mark before at least (in place
        // of mark j itself where nothing moves from there on, so no grain read off the recording's time plays)
        const dx = lay.moveAt(x);
        if (Number.isNaN(dx)) return -1;
        if (q === 0 && j > 0) {
          const before = tau[j - 1] as number;
          let m = interval(before - dx) + 1;
          while (m < K && ((t[m] as number) + dx < before + grid || lay.lockable((t[m] as number) + dx, x0 + 1) !== dx))
            m++;
          if (
            m < K &&
            marks.noise[m] &&
            (t[m] as number) + dx < end &&
            lay.lockable(x0, (t[m] as number) + dx + 1) === dx
          ) {
            pop();
            return lockOn(m, dx);
          }
        }
        let m = i + 1;
        if ((t[m] as number) + dx - x < grid / 2) m++;
        if (
          m >= K ||
          !marks.noise[m] ||
          (t[m] as number) + dx >= end ||
          lay.lockable(x0, (t[m] as number) + dx + 1) !== dx
        )
          return -1;
        for (const s of steps) free(s);
        return lockOn(m, dx);
      }
      if (!marks.voiced[i] || !marks.voiced[i + 1]) {
        // out of sound with no pitch into a voice: onto its first mark, half a grid step past the grain
        // before at least (in place of mark j where that's too close)
        if (q === 0 && marks.voiced[i + 1] && !Number.isNaN(d0)) {
          const o = (t[i + 1] as number) + d0;
          if (o < end && lay.lockable(x0, o + 1) === d0) {
            if (o - x0 >= grid / 2) return lockOn(i + 1, d0);
            if (j > 0 && !marks.voiced[src[j - 1] as number] && o - (tau[j - 1] as number) >= grid / 2) {
              pop();
              return lockOn(i + 1, d0);
            }
          }
        }
        // (where its periods aren't marked, they can't be followed)
        break;
      }
      const next = x + periodFrom(x);
      // (a period's room left after it, for the mark it locks onto; and no periods to follow across a jump
      // in the sound read: the marks lock straight onto the other side's there)
      if (next > last || 2 * next - x >= end || !lay.still(x, 2 * next - x + 1) || way.jumps(x, next)) break;
      steps.push(next);
      if (reached < 0 && !Number.isNaN(lay.moveAt(next))) reached = steps.length - 1;
      x = next;
    }
    if (steps.length < SETTLE || reached < 0) return -1;
    // how far the marks are off the analysis marks (where they can lock), and over how many marks that's made up
    const S = steps.length;
    const dR = lay.moveAt(steps[reached] as number);
    const ref = lay.moveAt(steps[S - 1] as number) === dR ? (steps[S - 1] as number) : (steps[reached] as number);
    const off0 = (t[nearest(ref - dR)] as number) + dR - ref;
    const i0 = interval(way.src(x0));
    const p = (t[Math.min(K - 1, i0 + 1)] as number) - (t[i0] as number);
    const need = Math.ceil(Math.abs(off0) / (SETTLE_CHANGE * p * (1 - SETTLE_RAMP)));
    const N = Math.min(S, Math.max(SETTLE_VOICED, need, reached + 1));
    const xN = steps[N - 1] as number;
    const dN = lay.moveAt(xN);
    if (Number.isNaN(dN)) return -1;
    const m = nearest(xN - dN);
    const target = (t[m] as number) + dN;
    if (target <= x0 || target >= end || lay.lockable(xN, target + 1) !== dN) return -1;
    const off = target - xN;
    for (let q = 1; q < N; q++) free((steps[q - 1] as number) + off * settled(q / N));
    return lockOn(m, dN);
  };

  push(t[k] as number, k, t[k] as number, 0);
  for (;;) {
    const x = tau[tau.length - 1] as number;
    if (k >= 0) {
      if (D === 0 && k >= main.k1) break;
      if (k + 1 < K) {
        const next = (t[k + 1] as number) + D;
        if (lay.lockable((t[k] as number) + D, next + 1) === D) {
          k++;
          push(next, k, t[k] as number, D);
          continue;
        }
      }
      k = -1;
    }
    const z = way.src(x);
    const i = interval(z);
    if (i + 1 >= K) break;
    const p = marks.voiced[i] ? periodFrom(x) : (t[i + 1] as number) - (t[i] as number);
    let next = x + p / 2 ** (lay.shiftAt(x + p / 2) / 12);
    if (!marks.voiced[i]) {
      // sound with no pitch: where a voice is near, a step onto where its first mark now plays (or half
      // way there, so no step is much shorter than the grid's)
      let v = i + 1;
      while (v < K && !marks.voiced[v] && (t[v] as number) < z + 3 * grid) v++;
      if (v < K && marks.voiced[v]) {
        const o = way.outputOf(t[v] as number, x, x + 2.5 * grid);
        if (o > x) next = o - x <= 1.5 * grid ? o : x + (o - x) / 2;
      }
    }
    if (next >= last) break;
    free(next);
    if (lay.shiftAt(next) === 0) k = relock(tau.length - 1);
  }
  return plan;
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
 * What a period between two synthesis marks is, besides copied as it is (0): made, made of voiced
 * grains, copied from a fixed distance away, made of grains read from places picked by a hash.
 */
const MADE = 1;
const VOICED = 2;
const COPIED_MOVED = 3;
const HASHED = 4;
const made = (kind: number) => kind === MADE || kind === VOICED || kind === HASHED;

/**
 * The channels overlap-added by the plan into `out` (the patch's frames a to b, holding the
 * recording's own, which stay wherever the marks are locked on it), each voiced period's level put
 * back to the recording's around it, and each period of grains read from places picked by a hash (they
 * don't add as one, being different sound: a dB or two would be lost). `formant`: the formant shift at
 * each frame from fw0.
 */
function overlapAdd(
  base: readonly Float32Array[],
  out: Float32Array[],
  marks: AllMarks,
  plan: Plan,
  formant: Float64Array,
  fw0: number,
  a: number,
  b: number,
): void {
  const t = marks.at;
  const { tau, src, at, lock, hashed } = plan;
  const J = tau.length;
  const K = t.length;
  const C = base.length;
  if (J < 2) return;
  const gap = (k: number): number =>
    K < 2 ? Number.POSITIVE_INFINITY : (t[Math.min(K - 1, k + 1)] as number) - (t[Math.max(0, k)] as number);
  // each grain's reach either side, and how it's read: as recorded (its pace 1), whole samples off where
  // it's read and the taps between, made once; or at its pace, through the cutoff table for it
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
    const f = marks.voiced[s] ? (formant[Math.max(0, Math.min(formant.length - 1, Math.round(x) - fw0))] as number) : 0;
    pace[q] = f === 0 ? 1 : 2 ** (f / 12);
    const off = (at[q] as number) - x;
    whole[q] = Math.floor(off);
    const frac = off - Math.floor(off);
    taps.push(pace[q] !== 1 ? tableFor(pace[q] as number) : frac === 0 ? null : fractionalTaps(frac));
  }
  const hA = new Float64Array(INTERP_TAPS);
  const hB = new Float64Array(INTERP_TAPS);
  const vA = new Float64Array(C);
  const vB = new Float64Array(C);
  /** Grain q's sound at frame i of the patch, each channel's into `v` (taps worked out in `h`, where its pace isn't 1). */
  const read = (q: number, i: number, h: Float64Array, v: Float64Array): void => {
    const p = pace[q] as number;
    let z: number;
    let k: Float64Array | null;
    if (p === 1) {
      z = i + (whole[q] as number);
      k = taps[q] as Float64Array | null;
    } else {
      const from = (at[q] as number) + p * (i - (tau[q] as number));
      z = Math.floor(from);
      const frac = from - z;
      k = frac === 0 && p < 1 ? null : tableTaps(taps[q] as Float64Array, frac, h);
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
  // what each period between synthesis marks is; its energy made, mean of the channels, and the
  // recording's around the marks it was read from
  const kind = new Uint8Array(J);
  const energy = new Float64Array(J);
  const wanted = new Float64Array(J);
  for (let q = 0; q + 1 < J; q++) {
    const x0 = tau[q] as number;
    const x1 = tau[q + 1] as number;
    // between two marks on neighbouring analysis marks, read as recorded: the recording as it is, or
    // from a fixed distance away where both are locked with that move
    const s0 = src[q] as number;
    const s1 = src[q + 1] as number;
    const whole1 = s1 === s0 + 1 && pace[q] === 1 && pace[q + 1] === 1 && at[q] === t[s0] && at[q + 1] === t[s1];
    if (whole1 && x0 === t[s0] && x1 === t[s1]) continue;
    kind[q] =
      whole1 && lock[q] === lock[q + 1] && !Number.isNaN(lock[q] as number)
        ? COPIED_MOVED
        : marks.voiced[s0] && marks.voiced[s1]
          ? VOICED
          : hashed[q] && hashed[q + 1]
            ? HASHED
            : MADE;
    const from = Math.max(a, Math.ceil(x0));
    const to = Math.min(b, Math.ceil(x1));
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
        (out[ch] as Float32Array)[i - a] = y;
        mean += y;
      }
      mean /= C;
      sum += mean * mean;
    }
    energy[q] = sum;
    wanted[q] = (Math.max(0, to - from) * ((marks.power[s0] as number) + (marks.power[s1] as number))) / 2;
  }
  // each voiced period's level, against the recording's, over the periods around it made of voiced
  // grains; and likewise each period of grains from places picked by a hash
  const level = new Float64Array(J).fill(1);
  for (let q = 0; q + 1 < J; q++) {
    const k = kind[q];
    if (k !== VOICED && k !== HASHED) continue;
    let m = 0;
    let w = 0;
    for (let d = -LEVEL_REACH; d <= LEVEL_REACH; d++) {
      // (as far as the periods made the same way run on unbroken)
      const e = q + d;
      let ok = e >= 0 && e + 1 < J;
      for (let g = Math.min(q, e); ok && g <= Math.max(q, e); g++) ok = kind[g] === k;
      if (!ok) continue;
      m += energy[e] as number;
      w += wanted[e] as number;
    }
    if (m > 0 && w > 0) level[q] = Math.min(LEVEL_MAX, Math.max(1 / LEVEL_MAX, Math.sqrt(w / m)));
  }
  // put back, in line from each period's middle to the next's (1 where a period is copied)
  for (let q = 0; q + 1 < J; q++) {
    if (!made(kind[q] as number)) continue;
    const g = level[q] as number;
    const before = q > 0 && made(kind[q - 1] as number) ? ((level[q - 1] as number) + g) / 2 : 1;
    const after = q + 2 < J && made(kind[q + 1] as number) ? ((level[q + 1] as number) + g) / 2 : 1;
    if (g === 1 && before === 1 && after === 1) continue;
    const x0 = tau[q] as number;
    const x1 = tau[q + 1] as number;
    const middle = (x0 + x1) / 2;
    const from = Math.max(a, Math.ceil(x0));
    const to = Math.min(b, Math.ceil(x1));
    for (let i = from; i < to; i++) {
      const v =
        i < middle
          ? before + ((g - before) * (i - x0)) / (middle - x0)
          : g + ((after - g) * (i - middle)) / (x1 - middle);
      for (let ch = 0; ch < C; ch++)
        (out[ch] as Float32Array)[i - a] = ((out[ch] as Float32Array)[i - a] as number) * v;
    }
  }
}
