/**
 * What someone played, heard so it can be written down: its tempo, its meter (with any pickup before
 * the first bar line) and its key, each as ranked readings, and its notes snapped to a grid in the
 * best reading and in the best reading of another meter, as ticks and as score text. The timing read
 * is the performance's own, in milliseconds: someone playing freely, a little early or late here and
 * there, pushing on and holding back.
 *
 * How it listens:
 * - Notes starting within 45 ms of the first are one onset (a chord).
 * - The pulse. The intervals between nearby onsets are matched against eighth-note periods. The best
 *   few, with their doubles, halves and 3:2 relatives (a pulse is easily heard twice as fast or
 *   slow), are each followed through the performance: every onset placed on the grid from where the
 *   last few put it, the tempo read again as it goes, then the whole placed again from a tempo curve
 *   that sees both sides of each long note. A tempo that drifts is followed rather than lost.
 * - The meter. For each pulse, each meter and each place the first bar line could fall: how well the
 *   onsets sit on its grid, how many fall on its strong beats, whether the loud, long, low and full
 *   onsets are the ones on strong beats, how few notes are held across a stronger beat than the one
 *   they start on, and whether long notes (phrase ends) come a whole number of bars apart. Beats
 *   near 100 a minute and the common meters are gently preferred.
 * - The key. Krumhansl and Kessler's major and minor profiles against how long each pitch class
 *   sounds.
 *
 * Everything is plain arithmetic in a fixed order: the same notes always give the same reading.
 */
import { type KeyMode, keyText, type Note, newProject, newRegion, PPQ, parseKey } from '@holo/session';
import { notate } from './notate.ts';
import { scoreText } from './text.ts';

/** A note someone played: as the server's listening gives it. */
export interface PlayedNote {
  /** ms from the start of the performance. */
  time: number;
  /** MIDI pitch (a sung pitch may have cents; it's rounded). */
  pitch: number;
  velocity: number;
  /** How long it sounded, in ms (null: still held when the listening ended). */
  length: number | null;
  /** The song's tick when the transport was playing; not used: the performance's own timing is read. */
  tick?: number | null;
}

export interface TempoCandidate {
  /** The beat a minute, as a musician counts it: a quarter in 3/4, a dotted quarter in 6/8. */
  bpm: number;
  beat: 'quarter' | 'dotted quarter';
  /** The song's tempo for it: quarter notes a minute, as `tempo` and the score text take it. */
  quarterBpm: number;
  /** 0–1, against the other readings. */
  confidence: number;
}

export interface MeterCandidate extends TempoCandidate {
  /** "6/8". */
  time: string;
  num: number;
  den: number;
  /** How a bar of 7/8 groups, in eighths. */
  groups?: number[];
  /** The upbeat before the first bar line, in ticks (0: none). */
  pickup: number;
  /** How sure the pickup is (or that there's none), in this meter. */
  pickupConfidence: number;
}

export interface KeyCandidate {
  /** "E minor", as the song's key takes it. */
  key: string;
  fifths: number;
  mode: Extract<KeyMode, 'major' | 'minor'>;
  /** How well the notes fit the key's profile (a correlation, −1…1). */
  score: number;
}

export interface QuantizedNote {
  /**
   * As on the score: bar 1 is the first full bar (0 a pickup's). The beat counts from 1 in the
   * meter's own unit (an eighth in 6/8, as positions are typed): 2.5 is half way through beat 2.
   */
  bar: number;
  beat: number;
  /**
   * Where it starts on the song's timeline (PPQ to the quarter; with a pickup, bar 0 is a full bar
   * from tick 0 with the music at its end, as the song has it), and how long it lasts.
   */
  ticks: number;
  durationTicks: number;
  pitch: number;
  velocity: number;
}

export interface Transcription {
  reading: MeterCandidate;
  key: KeyCandidate | null;
  /** The grid the notes were snapped to: straight sixteenths, eighth-note triplets, or some beats of each. */
  grid: 'sixteenths' | 'triplets' | 'mixed';
  notes: QuantizedNote[];
  /**
   * The notes as score text, for `writeScoreText`: a "bar 1  time …  key …  tempo …" header (bar 0
   * and "pickup" when there's one: set the song's pickup first), then a line a staff for one part,
   * P1 (two staves when the playing spans both clefs widely). Rename P1 to the part it goes into.
   */
  text: string;
}

export interface PerformanceAnalysis {
  /** How many notes, and the seconds from the first onset to the last note's end. */
  notes: number;
  seconds: number;
  /** Tempo readings, the likeliest first. */
  tempos: TempoCandidate[];
  /** Meter readings (each with its tempo and pickup), the likeliest first. */
  meters: MeterCandidate[];
  /** The three likeliest keys. */
  keys: KeyCandidate[];
  /** The likeliest reading written down; null with too few notes to tell. */
  best: Transcription | null;
  /** The likeliest reading in another meter, written down. */
  second: Transcription | null;
}

export interface AnalyzeOptions {
  /** Only these meters ("3/4", "6/8"…); all eight by default. */
  meters?: readonly string[];
  /** Write the score text (default true; false skips laying out the notation). */
  text?: boolean;
  /** The score text covers at most this many bars (64 by default); `notes` has them all. */
  textBars?: number;
}

// ---- the meters ----

/** An eighth note: every reading is counted in eighths of its own. */
const UNIT = PPQ / 2;
/** Sixths of an eighth: fine enough for both sixteenths (3) and triplet eighths (4). */
const SIX = 6;

interface MeterDef {
  time: string;
  num: number;
  den: number;
  groups?: number[];
  /** Eighths in a bar, and in the beat a musician counts (a quarter, or a dotted quarter). */
  units: number;
  beat: 2 | 3;
  /** Where the felt beats start, in eighths (7/8's are uneven), and the half bar of 4/4 and 12/8. */
  beats: number[];
  mids: number[];
  /** A small preference for the common meters. */
  prior: number;
}

const METERS: MeterDef[] = [
  { time: '4/4', num: 4, den: 4, units: 8, beat: 2, beats: [0, 2, 4, 6], mids: [4], prior: 0 },
  { time: '3/4', num: 3, den: 4, units: 6, beat: 2, beats: [0, 2, 4], mids: [], prior: 0 },
  { time: '2/4', num: 2, den: 4, units: 4, beat: 2, beats: [0, 2], mids: [], prior: -0.04 },
  { time: '6/8', num: 6, den: 8, units: 6, beat: 3, beats: [0, 3], mids: [], prior: -0.02 },
  { time: '12/8', num: 12, den: 8, units: 12, beat: 3, beats: [0, 3, 6, 9], mids: [6], prior: -0.06 },
  { time: '9/8', num: 9, den: 8, units: 9, beat: 3, beats: [0, 3, 6], mids: [], prior: -0.1 },
  { time: '5/4', num: 5, den: 4, units: 10, beat: 2, beats: [0, 2, 4, 6, 8], mids: [], prior: -0.15 },
  { time: '7/8', num: 7, den: 8, groups: [2, 2, 3], units: 7, beat: 2, beats: [0, 2, 4], mids: [], prior: -0.15 },
];

/**
 * How strong each place in a bar is, in sixths of an eighth: the bar line 1, the half bar 0.75, a
 * beat 0.5, an eighth 0.25, a sixteenth 0.1, anything finer (a triplet in simple time) 0. The same
 * levels in every meter, so meters are weighed on equal terms.
 */
interface Levels {
  def: MeterDef;
  at: Float64Array;
  /** How much an onset here says the beat is right: a beat (any) 1, an eighth 0.4, a sixteenth 0.15. */
  onBeat: Float64Array;
  /** The strongest place strictly inside a span: [start * (len + 1) + span length]. */
  inside: Float64Array;
}

function levelsOf(def: MeterDef): Levels {
  const len = def.units * SIX;
  const at = new Float64Array(len);
  for (let r = 0; r < len; r++) {
    const eighth = r / SIX;
    if (r === 0) at[r] = 1;
    else if (r % SIX === 0 && def.mids.includes(eighth)) at[r] = 0.75;
    else if (r % SIX === 0 && def.beats.includes(eighth)) at[r] = 0.5;
    else if (r % SIX === 0) at[r] = 0.25;
    else if (r % (SIX / 2) === 0) at[r] = 0.1;
  }
  const inside = new Float64Array(len * (len + 1));
  for (let r = 0; r < len; r++) {
    let most = 0;
    for (let s = 2; s <= len; s++) {
      most = Math.max(most, at[(r + s - 1) % len] as number);
      inside[r * (len + 1) + s] = most;
    }
  }
  const onBeat = at.map((l) => (l >= 0.5 ? 1 : l >= 0.25 ? 0.4 : l >= 0.1 ? 0.15 : 0));
  return { def, at, onBeat, inside };
}

const LEVELS = METERS.map(levelsOf);

// ---- onsets ----

/** Notes starting this close together are one onset (a chord, its notes a little apart). */
const CHORD_MS = 45;

interface Onset {
  t: number;
  /** Its notes, in the sorted list: [first, end). */
  first: number;
  end: number;
  loud: number;
  low: number;
  /** ms to the next onset (the last: its longest note). */
  ioi: number;
}

interface Heard {
  time: number;
  pitch: number;
  velocity: number;
  length: number | null;
}

function onsetsOf(notes: readonly Heard[]): Onset[] {
  const out: Onset[] = [];
  for (let i = 0; i < notes.length; ) {
    const start = (notes[i] as Heard).time;
    let end = i;
    let sum = 0;
    let loud = 0;
    let low = Number.POSITIVE_INFINITY;
    while (end < notes.length && (notes[end] as Heard).time - start <= CHORD_MS) {
      const n = notes[end] as Heard;
      sum += n.time;
      loud = Math.max(loud, n.velocity);
      low = Math.min(low, n.pitch);
      end++;
    }
    out.push({ t: sum / (end - i), first: i, end, loud, low, ioi: 0 });
    i = end;
  }
  const iois = out.slice(0, -1).map((o, i) => (out[i + 1] as Onset).t - o.t);
  const typical = median(iois) || 500;
  out.forEach((o, i) => {
    const next = out[i + 1];
    if (next) o.ioi = next.t - o.t;
    else {
      let longest = 0;
      let held = false;
      for (let k = o.first; k < o.end; k++) {
        const len = (notes[k] as Heard).length;
        if (len === null) held = true;
        else longest = Math.max(longest, len);
      }
      o.ioi = held ? 2 * typical : Math.max(longest, typical);
    }
  });
  return out;
}

function median(values: readonly number[]): number {
  if (!values.length) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 ? (s[mid] as number) : ((s[mid - 1] as number) + (s[mid] as number)) / 2;
}

/**
 * How accented each onset is, centered on 0: louder than the onsets around it, longer until the
 * next (a held note, a phrase end), lower (a bass note), fuller (a chord).
 */
function accentsOf(onsets: readonly Onset[]): Float64Array {
  const n = onsets.length;
  const typical = median(onsets.slice(0, -1).map((o) => o.ioi)) || 500;
  const loud = new Float64Array(n);
  const low = new Float64Array(n);
  const long = new Float64Array(n);
  const full = new Float64Array(n);
  const W = 6;
  for (let i = 0; i < n; i++) {
    const o = onsets[i] as Onset;
    let sumLoud = 0;
    let sumLow = 0;
    let count = 0;
    for (let k = Math.max(0, i - W); k <= Math.min(n - 1, i + W); k++) {
      sumLoud += (onsets[k] as Onset).loud;
      sumLow += (onsets[k] as Onset).low;
      count++;
    }
    loud[i] = o.loud - sumLoud / count;
    low[i] = sumLow / count - o.low;
    long[i] = Math.max(-1.5, Math.min(2.5, Math.log2(Math.max(1, o.ioi) / typical)));
    full[i] = o.end - o.first - 1;
  }
  const a = new Float64Array(n);
  const add = (f: Float64Array, floor: number, weight: number) => {
    let mean = 0;
    for (const x of f) mean += x;
    mean /= n;
    let v = 0;
    for (const x of f) v += (x - mean) ** 2;
    const sd = Math.max(floor, Math.sqrt(v / n));
    for (let i = 0; i < n; i++) a[i] = (a[i] as number) + (weight * ((f[i] as number) - mean)) / sd;
  };
  add(loud, 6, 1);
  add(long, 0.3, 0.6);
  add(low, 4, 0.3);
  add(full, 0.5, 0.2);
  return a;
}

// ---- the pulse ----

/** The fastest and slowest eighth any reading allows: 6/8 at 208, and a quarter beat at 40. */
const MIN_UNIT = 60000 / 208 / 3;
const MAX_UNIT = 60000 / 40 / 2;

/**
 * Eighth-note periods the onsets suggest: how much better than chance the intervals between nearby
 * onsets fall on whole numbers of the period, at the best few, and their relatives.
 */
function pulses(onsets: readonly Onset[]): number[] {
  const BIN = 5;
  const MAX_IOI = 3000;
  const hist = new Float64Array(MAX_IOI / BIN);
  for (let i = 0; i < onsets.length; i++) {
    for (let j = i + 1; j < onsets.length && j <= i + 6; j++) {
      const ioi = (onsets[j] as Onset).t - (onsets[i] as Onset).t;
      if (ioi >= MAX_IOI) break;
      if (ioi < 50) continue;
      const b = Math.floor(ioi / BIN);
      hist[b] = (hist[b] as number) + 1 / (j - i);
    }
  }
  const bins: [number, number][] = [];
  hist.forEach((c, b) => {
    if (c > 0) bins.push([(b + 0.5) * BIN, c]);
  });
  const periods: number[] = [];
  const scores: number[] = [];
  for (let u = MIN_UNIT * 0.95; u <= MAX_UNIT * 1.05; u *= 1.02) {
    let s = 0;
    for (const [ioi, c] of bins) {
      const m = Math.round(ioi / u);
      if (m < 1 || m > 8) continue;
      const sigma = Math.sqrt(15 ** 2 + (0.04 * ioi) ** 2);
      const err = ioi - m * u;
      s += c * (Math.exp(-0.5 * (err / sigma) ** 2) - Math.min(1, (2.5066 * sigma) / u));
    }
    periods.push(u);
    scores.push(s);
  }
  const peaks: number[] = [];
  for (let k = 0; k < periods.length; k++) {
    const s = scores[k] as number;
    if (s > 0 && s > (scores[k - 1] ?? Number.NEGATIVE_INFINITY) && s >= (scores[k + 1] ?? Number.NEGATIVE_INFINITY))
      peaks.push(k);
  }
  peaks.sort((x, y) => (scores[y] as number) - (scores[x] as number) || x - y);
  const top = peaks.slice(0, 3).map((k) => periods[k] as number);
  const best = top[0];
  if (best === undefined) return [];
  const out: number[] = [];
  for (const u of [...top, best * 2, best / 2, best * 1.5, best / 1.5]) {
    if (u < MIN_UNIT * 0.97 || u > MAX_UNIT * 1.03) continue;
    if (out.some((v) => Math.abs(v / u - 1) < 0.05)) continue;
    out.push(u);
  }
  return out;
}

/**
 * Where an onset goes, from where the onsets before it put it (`est`, in eighths). After a short
 * step that's the nearest sixteenth: its length is never in doubt. After a long note it may be:
 * a drifting tempo makes a long note's length uncertain (the more so the longer it is), and a
 * note after a long one is far likelier to start on an eighth, or on the quarter the recent notes
 * fall on, than a sixteenth off them. So each candidate is weighed by how far it is from the
 * estimate against that uncertainty, and by how likely its place is. Triplets aren't placed here
 * (a drifting tempo would pass for them); they're found afterwards, beat by beat.
 */
function placeAfter(est: number, g: Float64Array, i: number): number {
  const prev = g[i - 1] as number;
  const step = est - prev;
  const near = Math.max(prev + 0.5, Math.round(est * 2) / 2);
  if (step <= 2.25) return near;
  // where the recent onsets fall: which sixteenth of the quarter (0–3; even ones are on the eighths)
  let q0 = 0;
  let q1 = 0;
  let q2 = 0;
  let q3 = 0;
  const from = Math.max(0, i - 8);
  for (let j = from; j < i; j++) {
    const k = (((Math.round((g[j] as number) * 2) % 4) + 4) % 4) as 0 | 1 | 2 | 3;
    if (k === 0) q0++;
    else if (k === 1) q1++;
    else if (k === 2) q2++;
    else q3++;
  }
  const count = i - from;
  const half = q1 + q3 > q0 + q2 ? 1 : 0;
  const most = Math.max(q0, q1, q2, q3);
  const quarter = most === q0 ? 0 : most === q1 ? 1 : most === q2 ? 2 : 3;
  const eighthSure = (half ? q1 + q3 : q0 + q2) >= 0.7 * count;
  const quarterSure = most >= 0.7 * count;
  const sigma = Math.hypot(0.08, 0.035 * step);
  let best = near;
  let bestCost = Number.POSITIVE_INFINITY;
  for (let c = Math.max(prev + 0.5, Math.floor(est * 2) / 2 - 1); c <= est + 1; c += 0.5) {
    const k = Math.round(c * 2);
    let like = 1;
    if (eighthSure && ((k % 2) + 2) % 2 !== half) like *= 0.25;
    if (quarterSure && ((k % 4) + 4) % 4 === quarter) like *= 1.6;
    const cost = (est - c) ** 2 / (2 * sigma * sigma) - Math.log(like);
    if (cost < bestCost - 1e-9) {
      best = c;
      bestCost = cost;
    }
  }
  return best;
}

/**
 * Where the last four onsets put onset `i`, given its distance from each in eighths: the nearer ones
 * count more (a drifting tempo has had less time to drift), and the one answer furthest from the
 * rest is left out, so one misplaced onset doesn't throw the next.
 */
function estimate(g: Float64Array, i: number, apart: (j: number) => number): number {
  const from = Math.max(0, i - 4);
  let sum = 0;
  let weights = 0;
  for (let j = from; j < i; j++) {
    sum += ((g[j] as number) + apart(j)) / (i - j);
    weights += 1 / (i - j);
  }
  if (i - from < 3) return sum / weights;
  const mean = sum / weights;
  let worst = from;
  let far = -1;
  for (let j = from; j < i; j++) {
    const d = Math.abs((g[j] as number) + apart(j) - mean);
    if (d > far) {
      far = d;
      worst = j;
    }
  }
  return (sum - ((g[worst] as number) + apart(worst)) / (i - worst)) / (weights - 1 / (i - worst));
}

/** Each onset placed on the grid from where the last few onsets put it, given its distance from each in eighths. */
function regrid(n: number, apart: (i: number, j: number) => number): Float64Array {
  const g = new Float64Array(n);
  for (let i = 1; i < n; i++)
    g[i] = placeAfter(
      estimate(g, i, (j) => apart(i, j)),
      g,
      i,
    );
  return g;
}

/**
 * The tempo through the performance, as the length of an eighth in ms at any time: read from the
 * short steps between onsets (a quarter or less), whose length in eighths is never in doubt, and
 * smoothed over about two beats either side. Steps far off the curve (a misread dotted rhythm) are
 * dropped and the curve read again.
 */
function tempoCurve(times: Float64Array, g: Float64Array, u0: number): (t: number) => number {
  const at: number[] = [];
  const unit: number[] = [];
  const weight: number[] = [];
  for (let i = 0; i + 1 < times.length; i++) {
    const steps = (g[i + 1] as number) - (g[i] as number);
    if (steps <= 0 || steps > 2.01) continue;
    at.push(((times[i] as number) + (times[i + 1] as number)) / 2);
    unit.push(((times[i + 1] as number) - (times[i] as number)) / steps);
    weight.push(steps);
  }
  // smoothed over about two beats either side (a biweight: like a bell curve, but with an edge)
  const reach = 10 * u0;
  let sumW = 0;
  let sumU = 0;
  unit.forEach((u, k) => {
    sumW += weight[k] as number;
    sumU += u * (weight[k] as number);
  });
  const typical = sumW > 0 ? sumU / sumW : u0;
  // the curve on a grid a quarter apart, read between its points
  const start = times[0] as number;
  const step = 2 * u0;
  const size = Math.ceil(((times[times.length - 1] as number) - start) / step) + 2;
  const sample = (keep: (k: number) => boolean): Float64Array => {
    const out = new Float64Array(size);
    let lo = 0;
    for (let p = 0; p < size; p++) {
      const t = start + p * step;
      while (lo < at.length && (at[lo] as number) < t - reach) lo++;
      let sw = 0;
      let su = 0;
      for (let k = lo; k < at.length && (at[k] as number) <= t + reach; k++) {
        if (!keep(k)) continue;
        const d = ((at[k] as number) - t) / reach;
        const w = (weight[k] as number) * (1 - d * d) ** 2;
        sw += w;
        su += w * (unit[k] as number);
      }
      out[p] = sw > 1e-6 ? su / sw : typical;
    }
    return out;
  };
  const read = (grid: Float64Array) => (t: number) => {
    const x = Math.max(0, Math.min(size - 1.000001, (t - start) / step));
    const p = Math.floor(x);
    return (grid[p] as number) + ((grid[p + 1] as number) - (grid[p] as number)) * (x - p);
  };
  const first = read(sample(() => true));
  const kept = unit.map((u, k) => Math.abs(u / first(at[k] as number) - 1) < 0.25);
  return read(sample((k) => kept[k] === true));
}

/**
 * The pulse followed through the performance: each onset's place on the grid, in eighths from the
 * first. A first pass places each onset from the last few at the tempo of the last eight (so it
 * keeps up with a player who pushes on or holds back); then twice, the tempo curve that placing
 * gives, which sees both sides of a long note, places them again.
 */
function follow(times: Float64Array, u0: number): Float64Array {
  const n = times.length;
  const lo = u0 / 1.5;
  const hi = u0 * 1.5;
  let u = u0;
  const g = new Float64Array(n);
  for (let i = 1; i < n; i++) {
    g[i] = placeAfter(
      estimate(g, i, (j) => ((times[i] as number) - (times[j] as number)) / u),
      g,
      i,
    );
    const from = Math.max(0, i - 7);
    let mg = 0;
    let mt = 0;
    for (let j = from; j <= i; j++) {
      mg += g[j] as number;
      mt += times[j] as number;
    }
    mg /= i - from + 1;
    mt /= i - from + 1;
    let sgg = 0;
    let sgt = 0;
    for (let j = from; j <= i; j++) {
      sgg += ((g[j] as number) - mg) ** 2;
      sgt += ((g[j] as number) - mg) * ((times[j] as number) - mt);
    }
    if (sgg >= 2) u = Math.max(lo, Math.min(hi, sgt / sgg));
  }
  let placed: Float64Array = g;
  for (let pass = 0; pass < 2; pass++) {
    const curve = tempoCurve(times, placed, u0);
    // continuous places through the curve: each step's eighths, Simpson's rule over 1/tempo
    const P = new Float64Array(n);
    for (let i = 1; i < n; i++) {
      const a = times[i - 1] as number;
      const b = times[i] as number;
      P[i] = (P[i - 1] as number) + ((b - a) * (1 / curve(a) + 4 / curve((a + b) / 2) + 1 / curve(b))) / 6;
    }
    placed = regrid(n, (i, j) => (P[i] as number) - (P[j] as number));
  }
  return placed;
}

/**
 * A smooth map from the grid to time, through the followed places: each eighth's time from a line
 * fitted to the onsets within a few eighths of it (nearer ones count more), so single early or late
 * notes don't bend it but a drifting tempo does.
 */
function smoothMap(times: Float64Array, g: Float64Array): Float64Array {
  const n = times.length;
  const last = Math.ceil(g[n - 1] as number) + 2;
  const ticks = new Float64Array(last + 1);
  let lo = 0;
  for (let k = 0; k <= last; k++) {
    // nearer onsets count more (a biweight, reaching 8 eighths either side); reach further across a
    // long rest, until there are two places to draw a line through
    for (let reach = 8; ; reach *= 2) {
      while (lo < n && (g[lo] as number) < k - reach) lo++;
      let a = lo;
      while (a > 0 && (g[a - 1] as number) >= k - reach) a--;
      let w0 = 0;
      let wg = 0;
      let wt = 0;
      let wgg = 0;
      let wgt = 0;
      let first = Number.NaN;
      let spread = false;
      for (let i = a; i < n && (g[i] as number) <= k + reach; i++) {
        const x = g[i] as number;
        const t = times[i] as number;
        const d = (x - k) / reach;
        const w = (1 - d * d) ** 2;
        w0 += w;
        wg += w * x;
        wt += w * t;
        wgg += w * x * x;
        wgt += w * x * t;
        if (Number.isNaN(first)) first = x;
        else if (x !== first) spread = true;
      }
      if ((spread && w0 > 1e-9) || reach > 4 * (last + 1)) {
        const det = w0 * wgg - wg * wg;
        const slope = det > 1e-9 ? (w0 * wgt - wg * wt) / det : 0;
        ticks[k] = w0 > 0 ? (wt + slope * (k * w0 - wg)) / w0 : (times[0] as number);
        break;
      }
    }
  }
  // never backwards, whatever a fit across a rest says
  for (let k = 1; k <= last; k++)
    if ((ticks[k] as number) <= (ticks[k - 1] as number)) ticks[k] = (ticks[k - 1] as number) + 1;
  return ticks;
}

/** A time as a place on the followed pulse, in eighths from the first onset. */
function placeOf(ticks: Float64Array, time: number): number {
  const last = ticks.length - 1;
  if (last < 1) return 0;
  if (time <= (ticks[0] as number))
    return (time - (ticks[0] as number)) / ((ticks[1] as number) - (ticks[0] as number));
  if (time >= (ticks[last] as number))
    return last + (time - (ticks[last] as number)) / ((ticks[last] as number) - (ticks[last - 1] as number));
  let lo = 0;
  let hi = last;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((ticks[mid] as number) <= time) lo = mid;
    else hi = mid;
  }
  return lo + (time - (ticks[lo] as number)) / ((ticks[lo + 1] as number) - (ticks[lo] as number));
}

interface Track {
  ticks: Float64Array;
  /** The first onset's place: 0, or half an eighth when it's a sixteenth off the eighths. */
  shift: number;
  /** Each onset's place, in eighths. */
  pos: Float64Array;
}

const where = (track: Track, time: number) => placeOf(track.ticks, time) + track.shift;

/** A pulse followed from the first onset, on the eighths or a sixteenth off them: whichever more onsets sit on. */
function trackOf(times: Float64Array, u: number): Track {
  const ticks = smoothMap(times, follow(times, u));
  const pos = times.map((t) => placeOf(ticks, t));
  let on = 0;
  let off = 0;
  for (const p of pos) {
    on += Math.exp(-(((p - Math.round(p)) / 0.12) ** 2));
    off += Math.exp(-(((p + 0.5 - Math.round(p + 0.5)) / 0.12) ** 2));
  }
  const shift = off > on + 1e-9 ? 0.5 : 0;
  return { ticks, shift, pos: shift ? pos.map((p) => p + shift) : pos };
}

// ---- the grid ----

interface Snap {
  /** Each onset's place on the grid, in eighths (a multiple of 1/2, or 1/3 in a triplet beat). */
  q: Float64Array;
  /** The same in sixths of an eighth, and how far to the next onset (the last: 0). */
  six: Int32Array;
  span: Int32Array;
  /** Which onsets are in triplet beats. */
  triplet: Uint8Array;
  /** How close the onsets sit to the grid, 0–1 (relative to the grid's spacing). */
  fit: number;
  /** The share of onsets in triplet beats. */
  triplets: number;
}

/**
 * How close an onset sits to its grid point, 0–1, from how far off it is in ms: a player's ±20 ms
 * still counts as on it, whatever the tempo, so slow and fast readings are judged alike.
 */
const closeness = (eighths: number, unitMs: number) => Math.exp(-(((eighths * unitMs) / 30) ** 2));

/** Straight sixteenths everywhere: compound meters and 7/8. */
function snapStraight(pos: Float64Array, unitMs: number): Snap {
  const q = pos.map((p) => Math.round(p * 2) / 2);
  let fit = 0;
  pos.forEach((p, i) => {
    fit += closeness(Math.abs(p - (q[i] as number)), unitMs);
  });
  return withSixths({ q, triplet: new Uint8Array(pos.length), fit: fit / Math.max(1, pos.length), triplets: 0 });
}

/** A snap's places in whole sixths, worked out once for every reading weighed against it. */
function withSixths(snap: Omit<Snap, 'six' | 'span'>): Snap {
  const n = snap.q.length;
  const six = new Int32Array(n);
  const span = new Int32Array(n);
  for (let i = 0; i < n; i++) six[i] = Math.round((snap.q[i] as number) * SIX);
  for (let i = 0; i + 1 < n; i++) span[i] = (six[i + 1] as number) - (six[i] as number);
  return { ...snap, six, span };
}

/**
 * Simple meters, with beats starting `phase` eighths into the pulse: each beat on straight
 * sixteenths, or on eighth-note triplets where those fit clearly better.
 */
function snapSimple(pos: Float64Array, unitMs: number): [Snap, Snap] {
  return [0, 1].map((phase) => {
    const n = pos.length;
    const q = new Float64Array(n);
    const triplet = new Uint8Array(n);
    let fit = 0;
    let inTriplets = 0;
    for (let i = 0; i < n; ) {
      const beat = Math.floor(((pos[i] as number) - phase + 0.25) / 2);
      let end = i;
      let straight = 0;
      let three = 0;
      while (end < n && Math.floor(((pos[end] as number) - phase + 0.25) / 2) === beat) {
        const x = (pos[end] as number) - phase - 2 * beat;
        straight += Math.abs(x - Math.round(x * 2) / 2);
        three += Math.abs(x - Math.round(x * 1.5) / 1.5);
        end++;
      }
      const useThree = three + 0.04 * (end - i) < straight;
      for (let k = i; k < end; k++) {
        const x = (pos[k] as number) - phase - 2 * beat;
        const s = useThree ? Math.round(x * 1.5) / 1.5 : Math.round(x * 2) / 2;
        q[k] = phase + 2 * beat + s;
        triplet[k] = useThree ? 1 : 0;
        fit += closeness(Math.abs(x - s), unitMs);
      }
      if (useThree) inTriplets += end - i;
      i = end;
    }
    return withSixths({ q, triplet, fit: fit / Math.max(1, n), triplets: inTriplets / Math.max(1, n) });
  }) as [Snap, Snap];
}

// ---- the readings ----

interface Hypothesis {
  track: number;
  meter: number;
  /** Where the first bar line falls, in eighths on the track. */
  offset: number;
  score: number;
  /** The beat a minute, and the average eighth in ms. */
  bpm: number;
  unit: number;
}

/** How many onsets readings are weighed on, at most. */
const WEIGHED = 2000;

/** The tempo the beat is most often felt at; the preference is broad (an octave either way costs little). */
const tempoPrior = (bpm: number) => -(Math.log2(bpm / 100) ** 2) / 2;

/**
 * Phrases a whole number of bars long: how often the phrase ends (notes held, or followed by a rest,
 * well past the usual) come a whole number of bars apart, above what chance would give.
 */
function phrasing(long: readonly number[], q: Float64Array, def: MeterDef): number {
  if (long.length < 3) return 0;
  let hits = 0;
  for (let k = 1; k < long.length; k++) {
    const d = (q[long[k] as number] as number) - (q[long[k - 1] as number] as number);
    const r = ((d % def.units) + def.units) % def.units;
    if (r < 0.26 || def.units - r < 0.26) hits++;
  }
  return hits / (long.length - 1) - 1 / def.beats.length;
}

function score(levels: Levels, snap: Snap, offset: number, accents: Float64Array, phrase: number, bpm: number): number {
  const { at, onBeat, inside, def } = levels;
  const len = def.units * SIX;
  // a long performance is weighed on its first stretch: the meter shows by then, and it keeps this quick
  const n = Math.min(snap.q.length, WEIGHED);
  const shift = len - ((offset * SIX) % len);
  let sumM = 0;
  let sumB = 0;
  let sumMM = 0;
  let sumMA = 0;
  let sync = 0;
  for (let i = 0; i < n; i++) {
    let r = ((snap.six[i] as number) + shift) % len;
    if (r < 0) r += len;
    const m = at[r] as number;
    sumM += m;
    sumB += onBeat[r] as number;
    sumMM += m * m;
    sumMA += m * (accents[i] as number);
    // a note held across a stronger place than its own (until the next onset)
    const to = i + 1 < snap.q.length ? (snap.span[i] as number) : def.beat * SIX;
    const span = to < 1 ? 1 : to > len ? len : to;
    const stronger = inside[r * (len + 1) + span] as number;
    if (stronger > m) sync += stronger - m;
  }
  const meanM = sumM / n;
  const varM = sumMM / n - meanM * meanM;
  // the accents against the strong places: in the accents' own scale, so faint ones count for little
  const corr = varM > 1e-9 ? Math.max(-2, Math.min(2, sumMA / n / Math.sqrt(varM))) : 0;
  // a pickup is common, but needs the evidence: a little against it, more the longer it is
  const pickup = offset > 0 ? -0.03 - (0.1 * offset) / def.units : 0;
  return (
    1.0 * snap.fit +
    1.0 * (sumB / n) +
    0.4 * corr -
    0.8 * (sync / n) +
    0.1 * phrase +
    0.3 * tempoPrior(bpm) +
    def.prior +
    pickup -
    0.15 * snap.triplets
  );
}

// ---- keys ----

const KK_MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const KK_MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];
const MAJOR_NAMES = ['C', 'Db', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];
const MINOR_NAMES = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'G#', 'A', 'Bb', 'B'];

function correlation(a: readonly number[], b: readonly number[]): number {
  const n = a.length;
  let ma = 0;
  let mb = 0;
  for (let i = 0; i < n; i++) {
    ma += a[i] as number;
    mb += b[i] as number;
  }
  ma /= n;
  mb /= n;
  let ab = 0;
  let aa = 0;
  let bb = 0;
  for (let i = 0; i < n; i++) {
    const x = (a[i] as number) - ma;
    const y = (b[i] as number) - mb;
    ab += x * y;
    aa += x * x;
    bb += y * y;
  }
  return aa > 0 && bb > 0 ? ab / Math.sqrt(aa * bb) : 0;
}

/** The likeliest keys: each major and minor profile against how long each pitch class sounds. */
function keysOf(notes: readonly Heard[], onsets: readonly Onset[]): KeyCandidate[] {
  const weights = new Array<number>(12).fill(0);
  for (const o of onsets) {
    for (let k = o.first; k < o.end; k++) {
      const note = notes[k] as Heard;
      const sounding = Math.max(60, Math.min(2000, note.length ?? o.ioi));
      const pc = ((Math.round(note.pitch) % 12) + 12) % 12;
      weights[pc] = (weights[pc] as number) + sounding;
    }
  }
  if (weights.filter((w) => w > 0).length < 2) return [];
  const out: KeyCandidate[] = [];
  for (const mode of ['major', 'minor'] as const) {
    const profile = mode === 'major' ? KK_MAJOR : KK_MINOR;
    for (let tonic = 0; tonic < 12; tonic++) {
      const rotated = weights.map((_, pc) => profile[(pc - tonic + 12) % 12] as number);
      const name = (mode === 'major' ? MAJOR_NAMES : MINOR_NAMES)[tonic] as string;
      const k = parseKey(`${name} ${mode}`);
      if (!k) continue;
      out.push({ key: keyText(k), fifths: k.fifths, mode, score: round3(correlation(weights, rotated)) });
    }
  }
  return out.sort((x, y) => y.score - x.score || x.fifths - y.fifths || (x.mode < y.mode ? -1 : 1)).slice(0, 3);
}

const round3 = (x: number) => Math.round(x * 1000) / 1000;

// ---- writing it down ----

interface Chosen {
  hyp: Hypothesis;
  track: Track;
  snap: Snap;
  def: MeterDef;
}

function quantize(chosen: Chosen, notes: readonly Heard[], onsets: readonly Onset[], pickup: number): QuantizedNote[] {
  const { hyp, track, snap, def } = chosen;
  const barTicks = def.units * UNIT;
  const beatTicks = (PPQ * 4) / def.den;
  // where an eighth on the track lands on the song's timeline
  const shift = pickup > 0 ? def.units - hyp.offset : -hyp.offset;
  const phase = hyp.offset % 2;
  const out: QuantizedNote[] = [];
  onsets.forEach((o, i) => {
    const q = snap.q[i] as number;
    const triplet = snap.triplet[i] === 1;
    const cell = triplet ? 2 / 3 : 0.5;
    const nextQ = i + 1 < onsets.length ? (snap.q[i + 1] as number) : null;
    for (let k = o.first; k < o.end; k++) {
      const note = notes[k] as Heard;
      let end: number;
      if (note.length === null) end = nextQ ?? q + def.beat;
      else {
        // as written: a player lets go a little before the note's end, and notes mostly end on an eighth
        const at = q + Math.max(cell, (where(track, note.time + note.length) - q) / 0.92);
        const eighth = Math.round(at);
        if (triplet) end = phase + Math.round((at - phase) * 1.5) / 1.5;
        else end = Math.abs(at - eighth) <= 0.35 ? eighth : Math.round(at * 2) / 2;
      }
      end = Math.max(end, q + cell);
      if (nextQ !== null) {
        // a little past the next onset, or a little short of it: as written, it lasts until it
        const gap = nextQ - q;
        if (end > nextQ && end - nextQ <= Math.max(0.5, 0.25 * gap)) end = nextQ;
        else if (end < nextQ && nextQ - end <= Math.max(0.5, 0.2 * gap)) end = nextQ;
      }
      const ticks = Math.round((q + shift) * UNIT);
      const inBar = ((ticks % barTicks) + barTicks) % barTicks;
      out.push({
        bar: Math.floor(ticks / barTicks) + (pickup > 0 ? 0 : 1),
        beat: round3(1 + inBar / beatTicks),
        ticks,
        durationTicks: Math.max(1, Math.round((end - q) * UNIT)),
        pitch: Math.round(note.pitch),
        velocity: Math.max(1, Math.min(127, Math.round(note.velocity))),
      });
    }
  });
  return out;
}

/** The notes as score text: one part, its first `bars` bars, in the reading's meter, key and tempo. */
function textOf(
  reading: MeterCandidate,
  key: KeyCandidate | null,
  all: readonly QuantizedNote[],
  bars: number,
): string {
  const p = newProject('Played');
  const barTicks = (reading.num * PPQ * 4) / reading.den;
  const notes = all.filter((n) => n.bar <= bars);
  p.meter = [
    {
      tick: 0,
      num: reading.num,
      den: reading.den,
      ...(reading.groups ? { groups: reading.groups } : {}),
      ...(reading.pickup ? { pickup: reading.pickup } : {}),
    },
  ];
  if (key) {
    p.key = key.key;
    p.keys = [{ tick: 0, fifths: key.fifths, mode: key.mode }];
  }
  // at the first written bar's start, so the header shows it (a pickup's bar starts late)
  p.tempo = [{ tick: reading.pickup ? barTicks - reading.pickup : 0, bpm: reading.quarterBpm, mm: true }];
  const track = p.tracks[0];
  if (!track) return '';
  track.name = 'Played';
  const pitches = notes.map((n) => n.pitch).sort((a, b) => a - b);
  const low = pitches[Math.floor(pitches.length * 0.1)] ?? 60;
  const high = pitches[Math.floor(pitches.length * 0.9)] ?? 60;
  const mid = pitches[Math.floor(pitches.length / 2)] ?? 60;
  track.score =
    low < 52 && high > 67
      ? {
          staves: 2,
          clefs: [
            [0, 1, 'G'],
            [0, 2, 'F'],
          ],
        }
      : { staves: 1, clefs: [[0, 1, mid < 56 ? 'F' : 'G']] };
  let end = barTicks;
  for (const n of notes) end = Math.max(end, n.ticks + n.durationTicks);
  const region = newRegion(0, Math.min(Math.ceil(end / barTicks), bars + 1) * barTicks);
  region.notes = notes.map((n): Note => ({ t: n.ticks, d: n.durationTicks, p: n.pitch, v: n.velocity }));
  track.regions = [region];
  const lines = scoreText(notate(p)).split('\n');
  const from = lines.findIndex((l) => /^bar\s/.test(l));
  return lines
    .slice(Math.max(0, from))
    .filter((l) => !/^\s*clef\s/.test(l))
    .join('\n');
}

// ---- the analysis ----

/**
 * What a performance is: tempo, meter, pickup and key readings, ranked, and the notes written down
 * in the likeliest reading and in the likeliest of another meter.
 */
export function analyzePerformance(played: readonly PlayedNote[], options: AnalyzeOptions = {}): PerformanceAnalysis {
  const notes: Heard[] = played
    .filter((n) => Number.isFinite(n.time) && Number.isFinite(n.pitch))
    .map((n) => ({
      time: n.time,
      pitch: n.pitch,
      velocity: Number.isFinite(n.velocity) ? n.velocity : 64,
      length: n.length !== null && Number.isFinite(n.length) && n.length > 0 ? n.length : null,
    }))
    .sort((a, b) => a.time - b.time || a.pitch - b.pitch);
  const empty: PerformanceAnalysis = {
    notes: notes.length,
    seconds: 0,
    tempos: [],
    meters: [],
    keys: [],
    best: null,
    second: null,
  };
  if (!notes.length) return empty;
  const onsets = onsetsOf(notes);
  const startMs = (notes[0] as Heard).time;
  let endMs = startMs;
  for (const n of notes) endMs = Math.max(endMs, n.time + (n.length ?? 0));
  const keys = keysOf(notes, onsets);
  const base = { ...empty, seconds: round3((endMs - startMs) / 1000), keys };
  // a tempo needs a few intervals to go on
  if (onsets.length < 4) return base;

  const times = Float64Array.from(onsets.map((o) => o.t));
  const accents = accentsOf(onsets);
  // the phrase ends: notes held, or followed by a rest, well past the usual
  const typical = median(onsets.slice(0, -1).map((o) => o.ioi)) || 500;
  const phraseEnds: number[] = [];
  for (let i = 0; i + 1 < onsets.length; i++) if ((onsets[i] as Onset).ioi >= 2.5 * typical) phraseEnds.push(i);
  const allowed = options.meters?.length ? new Set(options.meters) : null;
  const meters = LEVELS.map((l, i) => [l, i] as const).filter(([l]) => !allowed || allowed.has(l.def.time));
  const tracks: Track[] = [];
  const snaps: { straight: Snap; simple: [Snap, Snap] }[] = [];
  const units: number[] = [];
  for (const u of pulses(onsets)) {
    const track = trackOf(times, u);
    // the average eighth, from the first onset to the last
    const rough = snapStraight(track.pos, u);
    const span = (rough.q[rough.q.length - 1] as number) - (rough.q[0] as number);
    const unit = span > 0 ? ((times[times.length - 1] as number) - (times[0] as number)) / span : u;
    tracks.push(track);
    snaps.push({ straight: snapStraight(track.pos, unit), simple: snapSimple(track.pos, unit) });
    units.push(unit);
  }
  // a pulse the onsets sit far worse on than the best isn't weighed further
  const bestFit = Math.max(...snaps.map((x) => Math.max(x.straight.fit, x.simple[0].fit, x.simple[1].fit)));
  const hyps: Hypothesis[] = [];
  for (let t = 0; t < tracks.length; t++) {
    const { straight, simple } = snaps[t] as { straight: Snap; simple: [Snap, Snap] };
    if (Math.max(straight.fit, simple[0].fit, simple[1].fit) < bestFit - 0.2) continue;
    const unit = units[t] as number;
    for (const [levels, m] of meters) {
      const def = levels.def;
      const bpm = 60000 / (def.beat * unit);
      if (bpm < 40 || bpm > 208) continue;
      const phrase = phrasing(phraseEnds, straight.q, def);
      for (let offset = 0; offset < def.units; offset++) {
        const snap = def.beat === 3 || def.groups ? straight : simple[offset % 2];
        if (!snap) continue;
        hyps.push({ track: t, meter: m, offset, bpm, unit, score: score(levels, snap, offset, accents, phrase, bpm) });
      }
    }
  }
  if (!hyps.length) return base;

  // how likely each reading is against the others: a lead of 0.1 in the weighing is about twelve to one
  const TEMPERATURE = 0.04;
  const top = Math.max(...hyps.map((h) => h.score));
  const weight = hyps.map((h) => Math.exp((h.score - top) / TEMPERATURE));
  const total = weight.reduce((a, b) => a + b, 0);
  // a reading is a meter at a tempo; its pickup is the likeliest of its bar line's places
  interface Group {
    best: Hypothesis;
    mass: number;
  }
  const groups: Group[] = [];
  hyps.forEach((h, i) => {
    const w = (weight[i] as number) / total;
    const same = groups.find((g) => g.best.meter === h.meter && Math.abs(g.best.bpm / h.bpm - 1) < 0.04);
    if (!same) groups.push({ best: h, mass: w });
    else {
      same.mass += w;
      if (h.score > same.best.score) same.best = h;
    }
  });
  groups.sort((x, y) => y.mass - x.mass || y.best.score - x.best.score);

  const chosenOf = (h: Hypothesis): Chosen => {
    const def = (LEVELS[h.meter] as Levels).def;
    const s = snaps[h.track] as { straight: Snap; simple: [Snap, Snap] };
    return {
      hyp: h,
      track: tracks[h.track] as Track,
      snap: def.beat === 3 || def.groups ? s.straight : (s.simple[h.offset % 2] as Snap),
      def,
    };
  };
  // the upbeat before the first bar line, in ticks
  const pickups = hyps.map((h) => {
    const first = chosenOf(h).snap.q[0] as number;
    return h.offset > first + 1e-9 ? Math.round((h.offset - first) * UNIT) : 0;
  });
  const candidates = groups.map((g): MeterCandidate => {
    const { def } = chosenOf(g.best);
    const pickup = pickups[hyps.indexOf(g.best)] as number;
    // the same meter and tempo with its bar line elsewhere: how sure this pickup (or none) is
    let here = 0;
    hyps.forEach((h, i) => {
      if (h.meter === g.best.meter && Math.abs(h.bpm / g.best.bpm - 1) < 0.04 && pickups[i] === pickup)
        here += (weight[i] as number) / total;
    });
    return {
      time: def.time,
      num: def.num,
      den: def.den,
      ...(def.groups ? { groups: def.groups } : {}),
      bpm: Math.round(g.best.bpm),
      beat: def.beat === 3 ? 'dotted quarter' : 'quarter',
      quarterBpm: Math.round(60000 / (2 * g.best.unit)),
      confidence: round3(g.mass),
      pickup,
      pickupConfidence: round3(g.mass > 0 ? Math.min(1, here / g.mass) : 0),
    };
  });

  const tempos: TempoCandidate[] = [];
  for (const c of candidates) {
    const same = tempos.find((t) => t.beat === c.beat && Math.abs(t.bpm / c.bpm - 1) < 0.04);
    if (same) same.confidence = round3(same.confidence + c.confidence);
    else tempos.push({ bpm: c.bpm, beat: c.beat, quarterBpm: c.quarterBpm, confidence: c.confidence });
  }
  tempos.sort((x, y) => y.confidence - x.confidence);

  const write = (index: number): Transcription | null => {
    const g = groups[index];
    const reading = candidates[index];
    if (!g || !reading) return null;
    const chosen = chosenOf(g.best);
    const quantized = quantize(chosen, notes, onsets, reading.pickup);
    const key = keys[0] ?? null;
    const share = chosen.snap.triplets;
    return {
      reading,
      key,
      grid: share === 0 ? 'sixteenths' : share >= 0.8 ? 'triplets' : 'mixed',
      notes: quantized,
      text: options.text === false ? '' : textOf(reading, key, quantized, Math.max(1, options.textBars ?? 64)),
    };
  };
  const other = candidates.findIndex((c) => c.time !== candidates[0]?.time);
  return {
    ...base,
    tempos,
    meters: candidates,
    best: write(0),
    second: other >= 0 ? write(other) : null,
  };
}

// ---- in words ----

const WORDS = ['no', 'one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten', 'eleven'];

/** A pickup's length in words: "one eighth", "two quarters", "three sixteenths". */
export function pickupWords(ticks: number, den = 4): string {
  const count = (n: number, what: string) => `${WORDS[n] ?? String(n)} ${what}${n === 1 ? '' : 's'}`;
  if (den === 4 && ticks % PPQ === 0) return count(ticks / PPQ, 'quarter');
  if (ticks % UNIT === 0) return count(ticks / UNIT, 'eighth');
  if (ticks % (UNIT / 2) === 0) return count(ticks / (UNIT / 2), 'sixteenth');
  return `${ticks} ticks`;
}

const sureness = (p: number) => (p >= 0.6 ? 'strong' : p >= 0.3 ? 'fair' : 'weak');

/** A key's sureness: how well it fits, and how far ahead of the next. */
function keySureness(keys: readonly KeyCandidate[]): string {
  const [a, b] = keys;
  if (!a) return 'weak';
  const lead = a.score - (b?.score ?? 0);
  return a.score >= 0.75 && lead >= 0.05 ? 'strong' : a.score >= 0.55 ? 'fair' : 'weak';
}

/**
 * What was heard, in a line: "Heard 13 notes over about 10 s: 6/8 at 72 (strong), E minor (strong), a
 * pickup of one eighth; alternatives: 3/4 at 108".
 */
export function describePerformance(a: PerformanceAnalysis): string {
  if (!a.notes) return 'Heard nothing.';
  const secs = a.seconds < 1 ? ' in under a second' : ` over about ${Math.round(a.seconds)} s`;
  const head = `Heard ${a.notes} note${a.notes === 1 ? '' : 's'}${a.notes > 1 ? secs : ''}`;
  const key = a.keys[0] ? `${a.keys[0].key} (${keySureness(a.keys)})` : null;
  const best = a.meters[0];
  if (!best) return `${head}: too few to tell a tempo or a meter${key ? `; ${key}` : ''}.`;
  const bits = [`${best.time} at ${best.bpm} (${sureness(best.confidence)})`];
  if (key) bits.push(key);
  if (best.pickup)
    bits.push(`${best.pickupConfidence < 0.5 ? 'perhaps ' : ''}a pickup of ${pickupWords(best.pickup, best.den)}`);
  const grid = a.best?.grid;
  if (grid === 'triplets') bits.push('in triplets');
  else if (grid === 'mixed') bits.push('with some triplets');
  const others = a.meters
    .slice(1)
    .filter((m) => m.confidence >= 0.02)
    .slice(0, 2)
    .map((m) => `${m.time} at ${m.bpm}`);
  return `${head}: ${bits.join(', ')}${others.length ? `; alternatives: ${others.join(', ')}` : ''}`;
}
