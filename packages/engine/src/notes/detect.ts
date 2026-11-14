/**
 * Finding a recording's notes to edit them (the Audio Editor's Notes, `AudioClip.notes`): one line's
 * notes (a voice, a solo instrument), the curves they're drawn with, and a guess at what kind of
 * recording it is. Plain functions over a file's own samples at its own rate, deterministic, so the
 * studio's worker and the host find the same notes in the same file.
 *
 * The notes come from the line's pitch every 5 ms (analysis/line.ts, the fine track a take's notes
 * are measured by), as an editor wants them: fewer and more musical than a take's measured notes.
 * - **Octaves.** Where the pitch jumps an octave between two steps and later jumps back, the tracker
 *   slipped (a voice glides, it never leaps an octave in 5 ms): within a stretch of voice, each piece
 *   is put back in the octave heard longest. A short note an octave off the notes either side of it
 *   (close by, and within two semitones of each other) is put back too.
 * - **Vibrato.** Where the pitch swings up and down evenly (three half swings or more, 3 to 9 a
 *   second, up to 2.5 semitones), the middles of its swings stand for it while notes are found.
 * - **Dips.** Each stretch of voice (gaps in its pitch of 20 ms or less bridged, or 50 ms across a
 *   move to another pitch where the sound goes on: the tracker losing a fast slide) is cut where its
 *   level dips 12 dB
 *   under its level within 150 ms on both sides (deeper than a vibrato's level swings), 80 ms or more
 *   from either end: a consonant between two syllables. The note after it starts where the level
 *   falls 6 dB, and its beat is where it comes back within 6 dB (its vowel).
 * - **Steps.** Each piece is cut into runs of steady pitch: the cuts that fit the pitch best (least
 *   squares, in semitones) with a cost for each new note (PELT, Killick et al. 2012): what a step of a
 *   semitone between two 80 ms notes saves.
 * - **One note.** Neighbouring runs whose medians are under 0.7 semitone apart are one note: a drift,
 *   a pitch that settles. A run under 150 ms off the pitch between two runs on it (a quick dip or lift
 *   of the voice) starts the second: the same note sung again.
 * - **Slides.** A run under 150 ms whose middle half moves half a semitone or more is a slide: into
 *   the note after it (a scoop) or off the note before (a fall), whichever it meets nearer in pitch.
 *   So is a run with under 60 ms after its beat; a run under 150 ms from silence into a note twice as
 *   long or more, or out of one into silence (the voice settling onto a note, or leaving it); and one
 *   between silence and a dip (a voiced consonant: m, n, l).
 * - **Legato.** Notes straight after one another touch: one ends where the next starts, where the
 *   pitch crosses halfway between them (or at the dip).
 * - **Starts.** A note from silence starts where its voice does (line.ts `voiceStart`, as a take's
 *   note does). Its beat is there too, unless its level jumps 6 dB within 10 ms to within 6 dB of its
 *   loudest 30 ms or more later (a quieter voiced consonant first: the vowel is on the beat). Unvoiced
 *   sound just before it (s, t, k, h), up to 300 ms with its voiced consonant, starts it instead. A
 *   note's lead (`u`) is from its start to its beat.
 * - **Breaths.** Unvoiced sound between notes that's no note's lead, 80 ms or more (a breath, a
 *   noise, a lone consonant), is a note with no pitch. Shorter, straight after a note, it's that
 *   note's end (a final t or s).
 * - **Pitch.** A note's pitch is that of its held part, from its beat (line.ts `heldPitch`): the
 *   median, or with a vibrato the mean over whole cycles.
 *
 * Unvoiced sound is sound (12 dB over the room, the quietest twentieth of the recording, and within
 * 50 dB of its loudest) with no pitch whose spectrum sits high: the RMS frequency of the sound (from
 * its first difference against itself) 1.2 kHz or more, where a sung vowel's is lower.
 */
import {
  type AudioNote,
  type AudioNotes,
  type AudioNotesMode,
  MAX_AUDIO_NOTES,
  roundPitch,
  roundTime,
} from '@holo/session';
import { FINE_S, heldPart, heldPitch, median, monoOf, type Tracked, trackOf, voiceStart } from '../analysis/line.ts';
import { downsample, yin } from '../analysis/pitch.ts';

/** The version of the detection: notes found by another stay as they were found. */
export const DETECT_V = 1;

/** Gaps in the pitch this many steps long or shorter are bridged (20 ms); up to GAP_LONG (50 ms) across a slide. */
const GAP = 4;
const GAP_LONG = 10;
/** A pitch this far from a note's (semitones) is another note. */
const STEP = 0.7;
/** The cost of a new note: what a step of a semitone between two 80 ms notes saves (squared semitones, steps). */
const PENALTY = (16 * 16) / 32;
/** Runs of pitch are this many steps long at least (20 ms), and found within 4 s at most (longer is one run cut and joined again). */
const MIN_RUN = 4;
const MAX_RUN = 800;
/** A vibrato's swings: each this many steps long (55 to 170 ms: 3 to 9 a second) and this big (semitones), three or more in a row, evenly. */
const SWING_STEPS = [11, 34] as const;
const SWING = [0.2, 2.5] as const;
const SWINGS = 3;
/** How far the pitch must turn back to be a swing's end (semitones). */
const TURN = 0.1;
/** A dip in the level this deep (12 dB) on both sides within DIP_REACH steps, DIP_EDGE or more from either end, cuts. */
const DIP = 10 ** (12 / 10);
const DIP_REACH = 30;
const DIP_EDGE = 16;
/** Shorter than this (s) a run that moves is a slide; with less than MIN_NOTE_S after its beat any run is. */
const SLIDE_S = 0.15;
const MIN_NOTE_S = 0.06;
/** How much a slide's middle half moves (semitones). */
const SLIDE_MOVES = 0.5;
/** A note's vowel is heard within this (s) of its voice's start; a voiced consonant before it lasts this long at least, and it starts with a jump of this many dB. */
const VOWEL_S = 0.15;
const CONSONANT_S = 0.03;
const VOWEL_JUMP = 6;
/** A consonant before a note is this long at least, and at most (s). */
const LEAD_MIN_S = 0.015;
const LEAD_MAX_S = 0.3;
/** Unvoiced sound this long (s) between notes is a note with no pitch. */
const NOISE_MIN_S = 0.08;
/** Sound is this far over the room (dB) and within this much of the loudest. */
const ROOM_DB = 12;
const RANGE_DB = 50;
/** Unvoiced sound's RMS frequency is this high at least (Hz). */
const BRIGHT_HZ = 1200;

/** The curves a recording's notes are drawn with: every `step` seconds from `t0`. */
export interface NoteCurves {
  t0: number;
  step: number;
  /** The pitch (MIDI with cents), NaN where it isn't voiced. */
  midi: Float32Array;
  /** The power (mean square over 10 ms). */
  power: Float32Array;
  /** 1 where there's sound but no pitch (a consonant, a breath, a noise). */
  unvoiced: Uint8Array;
}

/** What kind of recording it is, as `classifyRecording` guesses. */
export interface RecordingKind {
  mode: AudioNotesMode;
  /** The share of its sound that has one clear pitch (0–1). */
  voiced: number;
  /** How many times a second its level jumps up (a hit, a note from silence). */
  onsetsPerSecond: number;
}

/** A recording heard every 5 ms: its pitch (octaves put back), level and how high its spectrum sits. */
interface Heard {
  n: number;
  /** Each step's time (s). */
  t: Float64Array;
  /** The pitch, NaN where it isn't voiced. */
  midi: Float64Array;
  power: Float64Array;
  /** The RMS frequency of the sound around each step (Hz). */
  bright: Float64Array;
  /** The power over which there's sound. */
  sound: number;
  tracked: Tracked | null;
  end: number;
}

/** The power and RMS frequency of the samples over 10 ms around each time. */
function levelsAt(x: Float32Array, sr: number, t: Float64Array): { power: Float64Array; bright: Float64Array } {
  const power = new Float64Array(t.length);
  const bright = new Float64Array(t.length);
  const half = Math.round(0.005 * sr);
  for (let k = 0; k < t.length; k++) {
    const c = Math.round((t[k] as number) * sr);
    const a = Math.max(1, c - half);
    const b = Math.min(x.length, c + half);
    let e = 0;
    let d = 0;
    for (let i = a; i < b; i++) {
      const v = x[i] as number;
      const w = v - (x[i - 1] as number);
      e += v * v;
      d += w * w;
    }
    power[k] = b > a ? e / (b - a) : 0;
    // a sine of frequency f has a first difference 2 sin(πf/sr) its size: so a spectrum's RMS frequency
    bright[k] = e > 0 ? (sr / (2 * Math.PI)) * Math.acos(Math.max(-1, Math.min(1, 1 - d / e / 2))) : 0;
  }
  return { power, bright };
}

/** The power over which there's sound: ROOM_DB over the quietest twentieth, and within RANGE_DB of the loudest. */
function soundOf(power: Float64Array): number {
  if (!power.length) return Number.POSITIVE_INFINITY;
  const sorted = Float64Array.from(power).sort();
  const room = sorted[Math.floor(sorted.length * 0.05)] as number;
  const loudest = sorted[sorted.length - 1] as number;
  return Math.max(room * 10 ** (ROOM_DB / 10), loudest * 10 ** (-RANGE_DB / 10), 1e-12);
}

/** Unvoiced sound at a step: sound, no pitch, its spectrum high. */
const unvoicedAt = (h: Heard, k: number) =>
  (h.power[k] as number) >= h.sound && (h.bright[k] as number) >= BRIGHT_HZ && Number.isNaN(h.midi[k] as number);

/**
 * Pieces of a stretch of voice that jump an octave in an instant, and jump back, put back in the
 * octave heard longest (ties: the one nearest the pitch as found, then the lower).
 */
function repairOctaves(m: Float64Array): void {
  const n = m.length;
  let k = 0;
  while (k < n) {
    if (Number.isNaN(m[k] as number)) {
      k++;
      continue;
    }
    const pieces: { a: number; b: number; octave: number }[] = [];
    let a = k;
    let octave = 0;
    let last = k;
    for (let j = k + 1; j < n; j++) {
      const v = m[j] as number;
      if (Number.isNaN(v)) {
        if (j - last > GAP) break;
        continue;
      }
      const jump = v - (m[last] as number);
      const o = Math.round(jump / 12);
      if (o !== 0 && Math.abs(jump - 12 * o) < 0.75) {
        pieces.push({ a, b: last + 1, octave });
        a = j;
        octave += o;
      }
      last = j;
    }
    pieces.push({ a, b: last + 1, octave });
    if (pieces.length > 1) {
      const heard = new Map<number, number>();
      for (const p of pieces) heard.set(p.octave, (heard.get(p.octave) ?? 0) + (p.b - p.a));
      let best = 0;
      let most = -1;
      for (const [o, count] of [...heard].sort((x, y) => Math.abs(x[0]) - Math.abs(y[0]) || x[0] - y[0]))
        if (count > most) {
          most = count;
          best = o;
        }
      for (const p of pieces) {
        const shift = (best - p.octave) * 12;
        if (shift) for (let j = p.a; j < p.b; j++) if (!Number.isNaN(m[j] as number)) m[j] = (m[j] as number) + shift;
      }
    }
    k = last + 1;
  }
}

/** A recording heard: the fine track on a grid from the start of the samples, and the levels. */
function hear(x: Float32Array, sr: number): Heard {
  const tracked = trackOf(x, sr);
  const end = x.length / sr;
  let t: Float64Array;
  let midi: Float64Array;
  if (tracked) {
    // steps before the track's first, back to the start, so a consonant before the first note is heard
    const first = tracked.fineT[0] as number;
    const pre = Math.floor(first / FINE_S + 1e-9);
    const n = pre + tracked.fineT.length;
    t = new Float64Array(n);
    midi = new Float64Array(n).fill(Number.NaN);
    for (let k = 0; k < pre; k++) t[k] = Math.max(0, first - (pre - k) * FINE_S);
    tracked.fineT.forEach((v, j) => {
      t[pre + j] = v;
      midi[pre + j] = tracked.fineP[j] as number;
    });
  } else {
    const n = Math.max(0, Math.ceil(end / FINE_S));
    t = Float64Array.from({ length: n }, (_, k) => k * FINE_S);
    midi = new Float64Array(n).fill(Number.NaN);
  }
  repairOctaves(midi);
  const { power, bright } = levelsAt(x, sr, t);
  return { n: t.length, t, midi, power, bright, sound: soundOf(power), tracked, end };
}

/**
 * A stretch of pitch with its vibrato taken out: where it swings up and down evenly (SWINGS or more
 * half swings in a row, each SWING_STEPS long and SWING big, none more than twice as long or as big
 * as the one before), the middle of each swing (halfway between its top and its bottom) in its place.
 * A step to another note under a vibrato stays a step: the middles step too.
 */
function withoutVibrato(y: Float64Array): Float64Array {
  const out = Float64Array.from(y);
  const len = y.length;
  if (len < 3) return out;
  // where it turns: alternately its tops and bottoms, each turned back from by TURN or more
  const turns: number[] = [];
  let dir = 0;
  let hi = 0;
  let lo = 0;
  let at = 0;
  for (let k = 1; k < len; k++) {
    const v = y[k] as number;
    if (dir === 0) {
      if (v > (y[hi] as number)) hi = k;
      if (v < (y[lo] as number)) lo = k;
      if ((y[hi] as number) - v > TURN) {
        turns.push(hi);
        dir = -1;
        at = k;
      } else if (v - (y[lo] as number) > TURN) {
        turns.push(lo);
        dir = 1;
        at = k;
      }
    } else if (dir === 1) {
      if (v > (y[at] as number)) at = k;
      else if ((y[at] as number) - v > TURN) {
        turns.push(at);
        dir = -1;
        at = k;
      }
    } else if (v < (y[at] as number)) at = k;
    else if (v - (y[at] as number) > TURN) {
      turns.push(at);
      dir = 1;
      at = k;
    }
  }
  // runs of even swings
  const swing = (i: number) => {
    const steps = (turns[i + 1] as number) - (turns[i] as number);
    const size = Math.abs((y[turns[i + 1] as number] as number) - (y[turns[i] as number] as number));
    return {
      steps,
      size,
      ok: steps >= SWING_STEPS[0] && steps <= SWING_STEPS[1] && size >= SWING[0] && size <= SWING[1],
    };
  };
  const even = (i: number) => {
    const u = swing(i - 1);
    const v = swing(i);
    return v.steps <= 2 * u.steps && u.steps <= 2 * v.steps && v.size <= 2 * u.size && u.size <= 2 * v.size;
  };
  let i = 0;
  while (i + 1 < turns.length) {
    if (!swing(i).ok) {
      i++;
      continue;
    }
    let j = i + 1;
    while (j + 1 < turns.length && swing(j).ok && even(j)) j++;
    // swings i to j - 1
    if (j - i >= SWINGS) {
      const mids: [number, number][] = [];
      for (let q = i; q < j; q++) {
        const a = turns[q] as number;
        const b = turns[q + 1] as number;
        mids.push([(a + b) / 2, ((y[a] as number) + (y[b] as number)) / 2]);
      }
      let m = 0;
      for (let k = turns[i] as number; k <= (turns[j] as number); k++) {
        while (m + 1 < mids.length && (mids[m + 1] as [number, number])[0] <= k) m++;
        const [x0, v0] = mids[m] as [number, number];
        const next = mids[m + 1];
        out[k] = !next || k <= x0 ? v0 : v0 + ((next[1] - v0) * (k - x0)) / (next[0] - x0);
      }
    }
    i = j;
  }
  return out;
}

/** The cuts that fit `y` (a piece of pitch) best as steady runs, a cost of PENALTY each: each run's start. */
function steadyRuns(y: Float64Array): number[] {
  const len = y.length;
  if (len < 2 * MIN_RUN) return [0];
  const s1 = new Float64Array(len + 1);
  const s2 = new Float64Array(len + 1);
  for (let i = 0; i < len; i++) {
    s1[i + 1] = (s1[i] as number) + (y[i] as number);
    s2[i + 1] = (s2[i] as number) + (y[i] as number) ** 2;
  }
  const cost = (i: number, j: number) => {
    const s = (s1[j] as number) - (s1[i] as number);
    return (s2[j] as number) - (s2[i] as number) - (s * s) / (j - i);
  };
  const best = new Float64Array(len + 1).fill(Number.POSITIVE_INFINITY);
  const from = new Int32Array(len + 1);
  best[0] = -PENALTY;
  let candidates: number[] = [0];
  for (let t = MIN_RUN; t <= len; t++) {
    let low = Number.POSITIVE_INFINITY;
    let arg = 0;
    for (const c of candidates) {
      if (t - c < MIN_RUN || t - c > MAX_RUN) continue;
      const v = (best[c] as number) + cost(c, t) + PENALTY;
      if (v < low) {
        low = v;
        arg = c;
      }
    }
    best[t] = low;
    from[t] = arg;
    if (Number.isFinite(low)) candidates.push(t);
    // a start that does worse up to s than s does can't do better after (s is a start for t + 1 on)
    const s = t + 1 - MIN_RUN;
    const bs = best[s] as number;
    candidates = candidates.filter(
      (c) =>
        t + 1 - c <= MAX_RUN && !(s - c >= MIN_RUN && Number.isFinite(bs) && (best[c] as number) + cost(c, s) > bs),
    );
  }
  const starts: number[] = [];
  for (let t = len; t > 0; t = from[t] as number) starts.push(from[t] as number);
  return starts.reverse();
}

/**
 * A run of pitch, steps `a` to `b`: whether a hard cut (a gap, a dip) is before it, its median pitch,
 * and the step its beat is on (after its consonant, if it starts with one; else `a`).
 */
interface Run {
  a: number;
  b: number;
  hard: boolean;
  p: number;
  beat: number;
  /** A slide on its own, long enough to be a note. */
  alone?: true;
}

/** The notes found in a recording heard: runs of steps, each with its voice's start, its lead, its end. */
interface Found {
  a: number;
  b: number;
  p: number | null;
  /** Where it starts (its consonant's start), where its beat is (its vowel's start), where it ends (s). */
  t: number;
  voice: number;
  end: number;
}

const medianOf = (y: Float64Array, a: number, b: number): number => {
  const s = Array.from(y.subarray(a, b)).sort((u, v) => u - v);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/**
 * Where a stretch of voice (steps `a` to `b`) dips: for each dip, the step its level falls 6 dB
 * under the level before it (where the consonant starts: the note after it starts there) and the
 * step it comes back within 6 dB of the level after it (where the vowel starts: that note's beat).
 */
function dipsOf(power: Float64Array, a: number, b: number): { start: number; beat: number }[] {
  const out: { start: number; beat: number }[] = [];
  let lastMin = a;
  for (let j = a + DIP_EDGE; j < b - DIP_EDGE; j++) {
    const e = power[j] as number;
    if (e >= (power[j - 1] as number) || e > (power[j + 1] as number) || j - lastMin < DIP_EDGE) continue;
    const from = out.length ? (out[out.length - 1] as { beat: number }).beat : a;
    let before = 0;
    let after = 0;
    for (let i = Math.max(from, j - DIP_REACH); i < j; i++) before = Math.max(before, power[i] as number);
    for (let i = j + 1; i <= Math.min(b - 1, j + DIP_REACH); i++) after = Math.max(after, power[i] as number);
    if (before < DIP * e || after < DIP * e) continue;
    let start = j;
    while (start - 1 > from + MIN_RUN && (power[start - 1] as number) < before / 4) start--;
    let beat = j;
    while (beat + 1 < b - MIN_RUN && (power[beat] as number) < after / 4) beat++;
    out.push({ start, beat });
    lastMin = j;
  }
  return out;
}

/**
 * Where the vowel of a note from silence starts (its voice starting at `start`, lasting to `stop`):
 * where its level jumps up VOWEL_JUMP dB within 10 ms to within 6 dB of its loudest in its first
 * VOWEL_S, if that's CONSONANT_S or more after its voice starts (a voiced consonant before it: m, n,
 * l, v). Else its voice's start: a swell, or a fast attack, is all vowel.
 */
function vowelAfter(h: Heard, start: number, stop: number): number {
  const { n, t, power } = h;
  let k = 0;
  while (k < n && (t[k] as number) < start) k++;
  let loudest = 0;
  for (let j = k; j < n && (t[j] as number) < Math.min(stop, start + VOWEL_S); j++)
    loudest = Math.max(loudest, power[j] as number);
  let j = k;
  while (j < n && (power[j] as number) < loudest / 4) j++;
  if (j >= n || (t[j] as number) - start < CONSONANT_S || j < 2) return start;
  return (power[j - 2] as number) * 10 ** (VOWEL_JUMP / 10) <= (power[j] as number) ? (t[j] as number) : start;
}

/**
 * Whether the voice slides on between two voiced steps (`a` and `b` of the smoothed pitch `p`,
 * GAP_LONG apart at most): its pitch moves STEP or more across, and the sound goes on (no dip of DIP
 * under the quieter of them, nothing unvoiced). Then the gap is the tracker losing a fast slide. (On
 * one pitch, a gap with the sound going on is more often a consonant than a slip.)
 */
function slidesOn(h: Heard, p: Float64Array, a: number, b: number): boolean {
  if (b - a - 1 > GAP_LONG || Math.abs((p[b] as number) - (p[a] as number)) < STEP) return false;
  const floor = Math.min(h.power[a] as number, h.power[b] as number) / DIP;
  for (let k = a + 1; k < b; k++) if ((h.power[k] as number) < floor || unvoicedAt(h, k)) return false;
  return true;
}

/** The pitched notes of a recording heard, by start. */
function pitchedNotes(h: Heard): Found[] {
  const { n, t, midi, power } = h;
  const time = (k: number) => (k < n ? (t[k] as number) : h.end);
  // the pitch smoothed (median of five) for finding notes
  const smooth = new Float64Array(n).fill(Number.NaN);
  for (let k = 0; k < n; k++) {
    if (Number.isNaN(midi[k] as number)) continue;
    const near: number[] = [];
    for (let j = Math.max(0, k - 2); j <= Math.min(n - 1, k + 2); j++)
      if (!Number.isNaN(midi[j] as number)) near.push(midi[j] as number);
    if (near.length >= 3) smooth[k] = median(near);
  }
  // each stretch of voice: filled across its gaps, its vibrato taken out, cut where it dips, then into steady runs
  const filled = new Float64Array(n).fill(Number.NaN);
  const runs: Run[] = [];
  let k = 0;
  while (k < n) {
    if (Number.isNaN(smooth[k] as number)) {
      k++;
      continue;
    }
    const a = k;
    let last = k;
    for (let j = k + 1; j < n; j++) {
      if (Number.isNaN(smooth[j] as number)) {
        if (j - last > GAP_LONG) break;
        continue;
      }
      if (j - last - 1 > GAP && !slidesOn(h, smooth, last, j)) break;
      last = j;
    }
    const b = last + 1;
    for (let j = a; j < b; j++) {
      if (!Number.isNaN(smooth[j] as number)) {
        filled[j] = smooth[j] as number;
        continue;
      }
      let q = j;
      while (Number.isNaN(smooth[q] as number)) q++;
      const p0 = smooth[j - 1] as number;
      const p1 = smooth[q] as number;
      for (let i = j; i < q; i++) filled[i] = p0 + ((p1 - p0) * (i - j + 1)) / (q - j + 1);
      j = q - 1;
    }
    filled.set(withoutVibrato(filled.subarray(a, b)), a);
    const pieces = [{ start: a, beat: a }, ...dipsOf(power, a, b)];
    pieces.forEach((piece, c) => {
      const pa = piece.start;
      const pb = c + 1 < pieces.length ? (pieces[c + 1] as { start: number }).start : b;
      const starts = steadyRuns(filled.subarray(pa, pb));
      starts.forEach((s, i) => {
        const ra = pa + s;
        const rb = i + 1 < starts.length ? pa + (starts[i + 1] as number) : pb;
        // (the dip's beat, if it's in the first run: else the dip was no consonant's)
        const beat = i === 0 && piece.beat < rb ? piece.beat : ra;
        runs.push({ a: ra, b: rb, hard: i === 0, p: medianOf(filled, ra, rb), beat });
      });
    });
    k = b;
  }
  // neighbours under STEP apart are one note (the nearest first)
  const close = () => {
    for (;;) {
      let at = -1;
      let nearest = STEP;
      for (let i = 1; i < runs.length; i++) {
        const r = runs[i] as Run;
        const prev = runs[i - 1] as Run;
        if (r.hard || prev.b !== r.a) continue;
        const d = Math.abs(r.p - prev.p);
        if (d < nearest) {
          nearest = d;
          at = i;
        }
      }
      if (at < 0) return;
      const x = runs[at - 1] as Run;
      const y = runs[at] as Run;
      runs.splice(at - 1, 2, { a: x.a, b: y.b, hard: x.hard, p: medianOf(filled, x.a, y.b), beat: x.beat });
    }
  };
  /** Run `i` joins the run after it: its start, and its beat unless a dip was between them. */
  const intoNext = (i: number) => {
    const r = runs[i] as Run;
    const next = runs[i + 1] as Run;
    if (!next.hard) next.beat = r.beat;
    next.a = r.a;
    next.hard = r.hard;
    runs.splice(i, 1);
  };
  close();
  // a short run off the pitch between two runs on it (a quick dip or lift of the voice) starts the
  // second: the same note sung again
  for (let i = 1; i + 1 < runs.length; i++) {
    const r = runs[i] as Run;
    const prev = runs[i - 1] as Run;
    const next = runs[i + 1] as Run;
    if (prev.b !== r.a || r.b !== next.a || next.hard || time(r.b) - time(r.a) >= SLIDE_S) continue;
    if (Math.abs(prev.p - next.p) >= STEP || Math.abs(r.p - prev.p) < STEP) continue;
    intoNext(i);
    next.hard = true;
  }
  // slides belong to the note they meet (the shortest first), as do runs too short to be notes, and a
  // short run between a dip and silence (a consonant: m, n, l)
  for (;;) {
    let at = -1;
    let shortest = SLIDE_S;
    for (let i = 0; i < runs.length; i++) {
      const r = runs[i] as Run;
      const len = time(r.b) - time(r.a);
      if (len >= shortest || r.alone) continue;
      const prev = runs[i - 1];
      const next = runs[i + 1];
      const afterSilence = !prev || prev.b !== r.a;
      const beforeSilence = !next || next.a !== r.b;
      const consonant =
        (afterSilence && !beforeSilence && (next as Run).hard) || (beforeSilence && !afterSilence && r.hard);
      // (a short run from silence into a note twice as long or more, or out of one into silence: the
      // voice settling onto it, or leaving it)
      const edge =
        (afterSilence &&
          !beforeSilence &&
          !(next as Run).hard &&
          (next as Run).b - (next as Run).a >= 2 * (r.b - r.a)) ||
        (beforeSilence && !afterSilence && !r.hard && (prev as Run).b - (prev as Run).a >= 2 * (r.b - r.a));
      const q = Math.floor((r.b - r.a) / 4);
      let lo = Number.POSITIVE_INFINITY;
      let hi = Number.NEGATIVE_INFINITY;
      for (let j = r.a + q; j < r.b - q; j++) {
        lo = Math.min(lo, filled[j] as number);
        hi = Math.max(hi, filled[j] as number);
      }
      if (time(r.b) - time(r.beat) < MIN_NOTE_S || consonant || edge || hi - lo >= SLIDE_MOVES) {
        shortest = len;
        at = i;
      }
    }
    if (at < 0) break;
    const r = runs[at] as Run;
    const prev = runs[at - 1];
    const next = runs[at + 1];
    // into the neighbour it meets nearer in pitch, over a soft cut if it can, else over a dip
    const toPrev = prev && prev.b === r.a ? Math.abs((filled[r.a] as number) - prev.p) : Number.POSITIVE_INFINITY;
    const toNext = next && next.a === r.b ? Math.abs((filled[r.b - 1] as number) - next.p) : Number.POSITIVE_INFINITY;
    const softPrev = Number.isFinite(toPrev) && !r.hard;
    const softNext = Number.isFinite(toNext) && !(next as Run).hard;
    // (a consonant with next to no vowel after it is the next note's)
    const goNext =
      r.beat > r.a && Number.isFinite(toNext)
        ? true
        : softNext && softPrev
          ? toNext <= toPrev
          : softNext || (!softPrev && Number.isFinite(toNext));
    if (goNext) intoNext(at);
    else if (Number.isFinite(toPrev)) {
      (prev as Run).b = r.b;
      runs.splice(at, 1);
    } else if (time(r.b) - time(r.a) < MIN_NOTE_S) runs.splice(at, 1);
    // (a slide on its own, long enough, is a note)
    else r.alone = true;
  }
  close();
  // each note's times: between two notes on different pitches, where the pitch crosses halfway
  const found: Found[] = [];
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i] as Run;
    const prev = runs[i - 1];
    const before = found[found.length - 1];
    const legato = !!prev && prev.b === r.a;
    let a = r.a;
    let start = time(r.a);
    if (legato && !r.hard && Math.abs(r.p - (prev as Run).p) >= SLIDE_MOVES) {
      const mid = (r.p + (prev as Run).p) / 2;
      let best = -1;
      for (let j = Math.max((prev as Run).a + MIN_RUN, r.a - 20); j <= Math.min(r.b - MIN_RUN, r.a + 20); j++) {
        const u = (filled[j - 1] as number) - mid;
        const v = (filled[j] as number) - mid;
        if (((u < 0 && v >= 0) || (u > 0 && v <= 0)) && (best < 0 || Math.abs(j - r.a) < Math.abs(best - r.a)))
          best = j;
      }
      if (best >= 0) {
        const u = filled[best - 1] as number;
        const v = filled[best] as number;
        a = best;
        start = time(best - 1) + ((time(best) - time(best - 1)) * (mid - u)) / (v - u);
        (before as Found).b = best;
      }
    }
    if (legato) (before as Found).end = start;
    let voice = r.beat > a ? time(Math.min(r.beat, r.b - 1)) : start;
    if (!legato && h.tracked) {
      // from silence: where its voice starts, and its vowel if a quieter voiced consonant comes first
      const floorT = Math.max(before ? before.end : 0, start - 0.15);
      start = voiceStart(h.tracked, start, time(r.b), floorT, 1 / (440 * 2 ** ((r.p - 69) / 12)));
      if (r.beat <= r.a) voice = vowelAfter(h, start, time(r.b));
    }
    found.push({ a, b: r.b, p: r.p, t: start, voice: Math.max(start, voice), end: time(r.b) });
  }
  return found;
}

/** A short note an octave off the notes either side of it, close by and near each other, put back (its curve too). */
function repairNoteOctaves(h: Heard, notes: Found[]): void {
  for (let i = 1; i + 1 < notes.length; i++) {
    const n = notes[i] as Found;
    const prev = notes[i - 1] as Found;
    const next = notes[i + 1] as Found;
    if (n.end - n.voice > 0.25 || n.voice - prev.end > 0.1 || next.voice - n.end > 0.1) continue;
    const around = ((prev.p as number) + (next.p as number)) / 2;
    if (Math.abs((prev.p as number) - (next.p as number)) > 2) continue;
    const o = Math.round(((n.p as number) - around) / 12);
    if (o === 0 || Math.abs((n.p as number) - 12 * o - around) > 2) continue;
    n.p = (n.p as number) - 12 * o;
    for (let k = n.a; k < n.b; k++) if (!Number.isNaN(h.midi[k] as number)) h.midi[k] = (h.midi[k] as number) - 12 * o;
  }
}

/** Each note's consonant: unvoiced sound straight before a note from silence (two steps' pause allowed). */
function addLeads(h: Heard, notes: Found[]): void {
  notes.forEach((n, i) => {
    const prev = notes[i - 1];
    if (prev && prev.end >= n.t) return;
    const floor = prev ? prev.end : 0;
    let k = n.a;
    while (k > 0 && (h.t[k - 1] as number) + FINE_S / 2 > n.t) k--;
    let first = -1;
    let miss = 0;
    for (let j = k - 1; j >= 0 && (h.t[j] as number) >= floor; j--) {
      if (unvoicedAt(h, j)) {
        first = j;
        miss = 0;
      } else if (++miss > 2) break;
    }
    if (first < 0) return;
    const start = Math.max(floor, h.t[first] as number);
    const lead = n.voice - start;
    if (lead >= LEAD_MIN_S && lead <= LEAD_MAX_S && n.t - start >= FINE_S) n.t = start;
  });
}

/** Unvoiced sound between notes: 80 ms or more, a note with no pitch; shorter, straight after a note, its end. */
function addNoises(h: Heard, notes: Found[]): Found[] {
  const out: Found[] = [];
  let i = 0;
  let k = 0;
  const { n, t } = h;
  while (k < n) {
    // (past the notes that end before this step)
    while (i < notes.length && (notes[i] as Found).end <= (t[k] as number)) out.push(notes[i++] as Found);
    const at = notes[i];
    if (at && (t[k] as number) >= at.t) {
      k++;
      continue;
    }
    if (!unvoicedAt(h, k)) {
      k++;
      continue;
    }
    // a run of unvoiced sound (two steps' pause allowed), up to the next note
    const a = k;
    let last = k;
    for (let j = k + 1; j < n && j - last <= 3; j++) {
      if (at && (t[j] as number) >= at.t) break;
      if (unvoicedAt(h, j)) last = j;
    }
    const before = out[out.length - 1];
    const from = Math.max(before ? before.end : 0, t[a] as number);
    const to = Math.min(at ? at.t : h.end, t[last] as number);
    if (to - from >= NOISE_MIN_S) out.push({ a, b: last + 1, p: null, t: from, voice: from, end: to });
    else if (before && before.p !== null && from - before.end < 0.01) before.end = to;
    k = last + 1;
  }
  while (i < notes.length) out.push(notes[i++] as Found);
  return out;
}

/** The notes found in a recording heard, with their pitch. */
function notesOf(h: Heard): Found[] {
  const notes = pitchedNotes(h);
  repairNoteOctaves(h, notes);
  addLeads(h, notes);
  for (const n of notes) {
    const { ht, hp } = heldPart(h.t, h.midi, n.a, n.b, n.voice, n.end);
    if (hp.length) n.p = heldPitch(ht, hp).pitch;
  }
  return addNoises(h, notes);
}

/** Notes as a region keeps them: rounded, by start, one after another. */
function canonical(found: Found[]): AudioNote[] {
  const out: AudioNote[] = [];
  for (const f of found.slice(0, MAX_AUDIO_NOTES)) {
    const t = roundTime(f.t);
    const d = roundTime(roundTime(f.end) - t);
    if (d < 0.01) continue;
    const note: AudioNote = { t, d, p: f.p === null ? null : roundPitch(Math.max(0, Math.min(127, f.p))) };
    const u = roundTime(Math.min(roundTime(f.voice) - t, d));
    if (u > 0) note.u = u;
    out.push(note);
  }
  return out;
}

/**
 * The notes of a recording (its channels at their own rate) as the note editor shows them: one
 * line's, found as the header says. Chords and hits are found by later versions: for now any
 * recording is read as one line (a chord's strongest).
 */
export function detectNotes(
  channels: readonly Float32Array[],
  sampleRate: number,
  _opts: { mode?: AudioNotesMode } = {},
): AudioNotes {
  if (!channels.length) return { mode: 'mono', v: DETECT_V, n: [] };
  return { mode: 'mono', v: DETECT_V, n: canonical(notesOf(hear(monoOf(channels), sampleRate))) };
}

/** The curves a recording's notes are drawn with (its channels at their own rate), every 5 ms. */
export function noteCurves(channels: readonly Float32Array[], sampleRate: number): NoteCurves {
  const h = hear(channels.length ? monoOf(channels) : new Float32Array(0), sampleRate);
  // (octaves the notes put back are put back in the curve too)
  if (h.tracked) notesOf(h);
  return curvesOf(h);
}

/**
 * A recording's notes and the curves they're drawn with, heard once: `detectNotes` and `noteCurves`
 * together, for the note editor, which wants both (hearing is most of the work).
 */
export function notesAndCurves(
  channels: readonly Float32Array[],
  sampleRate: number,
): { notes: AudioNotes; curves: NoteCurves } {
  const h = hear(channels.length ? monoOf(channels) : new Float32Array(0), sampleRate);
  const n = channels.length ? canonical(notesOf(h)) : [];
  return { notes: { mode: 'mono', v: DETECT_V, n }, curves: curvesOf(h) };
}

/** The curves of a recording heard (its octaves put back as its notes were found). */
function curvesOf(h: Heard): NoteCurves {
  const unvoiced = new Uint8Array(h.n);
  for (let k = 0; k < h.n; k++)
    unvoiced[k] = (h.power[k] as number) >= h.sound && Number.isNaN(h.midi[k] as number) ? 1 : 0;
  return {
    t0: h.n ? (h.t[0] as number) : 0,
    step: FINE_S,
    midi: Float32Array.from(h.midi),
    power: Float32Array.from(h.power),
    unvoiced,
  };
}

/** Where the level jumps up 10 dB or more within 40 ms, 40 dB or less under the loudest, 50 ms apart at least. */
function onsetsOf(power: Float64Array): number {
  let loudest = 0;
  for (const p of power) loudest = Math.max(loudest, p);
  if (loudest <= 0) return 0;
  const db = Array.from(power, (p) => 10 * Math.log10(p / loudest + 1e-12));
  let count = 0;
  let last = Number.NEGATIVE_INFINITY;
  for (let k = 1; k < db.length; k++) {
    if ((db[k] as number) < -40 || k - last < 10) continue;
    let low = Number.POSITIVE_INFINITY;
    for (let j = Math.max(0, k - 8); j < k; j++) low = Math.min(low, db[j] as number);
    if ((db[k] as number) - low >= 10) {
      count++;
      last = k;
    }
  }
  return count;
}

/** The frame and hop a recording's kind is heard with, at about 11 kHz (93 ms frames, every 23 ms; as `measure` hears it). */
const KIND_FRAME = 1024;
const KIND_HOP = 256;

/**
 * The share of a frame's energy (Hann windowed) in the first three partials of a pitch (Hz), each
 * looked for within a quarter of a semitone.
 */
function partialShare(frame: Float32Array, rate: number, hz: number): number {
  const n = frame.length;
  const w = new Float64Array(n);
  let energy = 0;
  for (let i = 0; i < n; i++) {
    w[i] = (frame[i] as number) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / n));
    energy += (w[i] as number) ** 2;
  }
  if (energy <= 0) return 0;
  let sum = 0;
  for (let h = 1; h <= 3; h++) {
    let most = 0;
    for (const detune of [-0.25, 0, 0.25]) {
      const f = h * hz * 2 ** (detune / 12);
      if (f >= rate / 2) continue;
      // Goertzel
      const c = 2 * Math.cos((2 * Math.PI * f) / rate);
      let s1 = 0;
      let s2 = 0;
      for (let i = 0; i < n; i++) {
        const s0 = (w[i] as number) + c * s1 - s2;
        s2 = s1;
        s1 = s0;
      }
      most = Math.max(most, s1 * s1 + s2 * s2 - c * s1 * s2);
    }
    sum += most;
  }
  // (a sine's whole energy reads as 1)
  return (3 * sum) / (n * energy);
}

/**
 * What kind of recording it is (its channels at their own rate), by two simple measures:
 * - `voiced`: of its frames with sound (within 22 dB of the loudest, as `measure` hears them), the
 *   share with one clear pitch: YIN's clarity over 0.7, and a tenth or more of the frame's energy in
 *   that pitch's first three partials. A line is mostly that. A hit has no pitch; a chord's notes
 *   blur it, or (a major chord) repeat together at a period below them all, whose own partials are
 *   missing.
 * - `onsetsPerSecond`: how often its level jumps up 10 dB within 40 ms.
 * Half its sound or more clearly pitched is one line (`mono`); under a quarter, with a jump a second
 * or more, it's hits (`perc`); anything else is chords or a mix (`poly`). Silence reads as a line.
 */
export function classifyRecording(channels: readonly Float32Array[], sampleRate: number): RecordingKind {
  const x = channels.length ? monoOf(channels) : new Float32Array(0);
  const seconds = x.length / sampleRate;
  const low = downsample(x, sampleRate);
  const frames: { at: number; rms: number }[] = [];
  let loudest = 0;
  for (let at = 0; at + KIND_FRAME <= low.samples.length; at += KIND_HOP) {
    let sum = 0;
    for (let i = at; i < at + KIND_FRAME; i++) sum += (low.samples[i] as number) ** 2;
    const rms = Math.sqrt(sum / KIND_FRAME);
    frames.push({ at, rms });
    loudest = Math.max(loudest, rms);
  }
  const floor = Math.max(0.005, loudest * 0.08);
  let sounding = 0;
  let clear = 0;
  for (const f of frames) {
    if (f.rms < floor) continue;
    sounding++;
    const frame = low.samples.subarray(f.at, f.at + KIND_FRAME);
    const found = yin(frame, low.sampleRate);
    if (found && found.clarity > 0.7 && partialShare(frame, low.sampleRate, found.hz) >= 0.1) clear++;
  }
  const t = Float64Array.from({ length: Math.max(0, Math.floor(seconds / FINE_S)) }, (_, k) => k * FINE_S);
  const onsets = onsetsOf(levelsAt(x, sampleRate, t).power);
  const voiced = sounding ? clear / sounding : 0;
  const onsetsPerSecond = seconds > 0 ? onsets / seconds : 0;
  const mode: AudioNotesMode =
    !sounding || voiced >= 0.5 ? 'mono' : voiced < 0.25 && onsetsPerSecond >= 1 ? 'perc' : 'poly';
  return { mode, voiced: Math.round(voiced * 1000) / 1000, onsetsPerSecond: Math.round(onsetsPerSecond * 100) / 100 };
}
