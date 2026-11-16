/**
 * What a line's note edits do to its sound moment by moment: how far its pitch moves (semitones), how
 * far its formants move (semitones) and the level it plays at. The renderer moves the sound by these
 * (psola.ts) and the Notes view draws them (`editedPitch`), from the same code, so what's drawn is what
 * plays.
 *
 * - **A note's weight.** A note's change counts fully within it and not at all away from it. Where it
 *   doesn't touch its neighbour, its change comes in and goes over 10 ms around that edge; its pitch
 *   and formant come in around its beat, after its consonant (`u`), so a consonant isn't moved. Between
 *   two notes that touch (one sung straight into the next), the change goes from one note's to the
 *   next's across a transition centred where they meet: for pitch and formant the shorter of 120 ms
 *   and 40% of the shorter note, along an S-shaped curve (smoothstep), so the glide between them moves
 *   with them; for level 10 ms. The weights of two notes that touch add to one across it.
 * - **Pitch.** A note's centre moved (`to`) moves it by `to − p`. With the pitch as found (a
 *   `PitchTrack`), the note's pitch P is its centre p, its drift D and its vibrato M: D is how far P is
 *   from p, smoothed (a moving average applied twice, each over 150 ms or one cycle of its vibrato if
 *   that's longer, a straight line through it taken out first so that its ends keep their slope), and
 *   M is what's left. The note moves by `(to − p) + (dr − 1)·D + (mo − 1)·M`: its drift kept by `dr`
 *   (0 sits it on `to`, wherever its centre was found; 1 moves it by exactly `to − p`) and its vibrato
 *   by `mo` (0 none, 2 twice as deep). That's over its held part, from 60 ms after its beat to 60 ms
 *   before its end (a quarter of its voice each at most). In its attack and its release the drift stays
 *   at its value at the held part's edge and the vibrato is left alone (its edit comes in over 40 ms),
 *   so a scoop into the note or a fall off it keeps its shape and moves with it.
 * - **Glide** (`tr`, with the pitch as found). Into a note from one it touches, the glide as sung is
 *   heard (where the pitch crosses 10%, 50% and 90% of the way from the first note's line, its centre
 *   plus its drift, to the second's) and made again, centred where it was sung and `tr` times as long
 *   (10 ms at least, and within 45% of either note and 180 ms of where they meet): the pitch goes from
 *   the first note's line to the second's, each as edited and with its vibrato as edited, along a
 *   smoothstep. Over where it was sung and where it's made, the pitch is that; it comes in and goes
 *   over 20 ms either side. With `tr` absent or 1 the glide is as sung (moved by the crossing above).
 * - **Formant** (`fo`): each note's by its weight.
 * - **Level**: a note's level (`g`, dB) or its mute (`m`).
 *
 * Where no note's change reaches, the shift is exactly 0, the formant 0 and the level exactly 1, so
 * the renderer copies the recording there, to the bit. Nothing moves where the sound isn't voiced (a
 * consonant, a breath: there's no pitch to move).
 */
import type { AudioNote } from '@holo/session';
import { FINE_S, heldPitch } from '../analysis/line.ts';

/** A note's edges, where it doesn't touch its neighbour: its changes come in and go over this long (s). */
const EDGE_S = 0.01;
/** The longest transition of pitch between notes that touch (s), and the most of the shorter note it takes. */
const TRANSITION_S = 0.12;
const TRANSITION_SHARE = 0.4;
/** Notes this close (s) touch. */
const TOUCH_S = 0.001;
/** A note's attack after its beat and its release before its end (s; a quarter of its voice each at most). */
const ATTACK_S = 0.06;
const RELEASE_S = 0.06;
/** A note's vibrato edit comes in over this long from its held part's edges (s). */
const VIBRATO_IN_S = 0.04;
/** A note's drift is its pitch smoothed over this long at least (s), or over one cycle of its vibrato. */
const DRIFT_S = 0.15;
/** A glide made again: this long at least (s); it reaches at most this far into either note from where they meet (s), and this share of it. */
const GLIDE_MIN_S = 0.01;
const GLIDE_REACH_S = 0.18;
const GLIDE_SHARE = 0.45;
/** A glide made again comes in and goes over this long (s). */
const GLIDE_IN_S = 0.02;
/** Two notes' lines closer than this (semitones) have no glide between them to hear. */
const GLIDE_STEP = 0.25;
/** A smoothstep's rise from 10% to 90%, as a share of its length. */
const RISE_SHARE = 0.6084;

/**
 * A line's pitch as found: at each of the times `t` (seconds of the file, ascending, evenly apart: the
 * fine track's 5 ms steps), MIDI with cents, NaN where the sound isn't voiced.
 */
export interface PitchTrack {
  t: ArrayLike<number>;
  midi: ArrayLike<number>;
}

const smooth = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const endOf = (n: AudioNote): number => n.t + n.d;
/** Where a note's voice starts: after its consonant. */
const beatOf = (n: AudioNote): number => Math.min(endOf(n), n.t + (n.u ?? 0));

/** How long a change takes to go from one note to the next where they touch (s). */
type Across = (a: AudioNote, b: AudioNote) => number;
const pitchAcross: Across = (a, b) => Math.min(TRANSITION_S, TRANSITION_SHARE * Math.min(a.d, b.d));
const levelAcross: Across = () => EDGE_S;

/** Where the change between note i and the next turns over, [from, to] (s), or null where they don't touch. */
function between(notes: readonly AudioNote[], i: number, across: Across): [number, number] | null {
  const a = notes[i];
  const b = notes[i + 1];
  if (!a || !b) return null;
  const gap = b.t - endOf(a);
  if (gap < -TOUCH_S || gap > TOUCH_S) return null;
  const mid = (endOf(a) + b.t) / 2;
  const z = across(a, b);
  return [mid - z / 2, mid + z / 2];
}

/** Note i's weight: it rises across [r0, r1] and falls across [f0, f1] (s). */
interface Weight {
  r0: number;
  r1: number;
  f0: number;
  f1: number;
}

/** Note i's weight; `voice`: from its beat, not its start, where it doesn't touch the note before. */
function weightOf(notes: readonly AudioNote[], i: number, across: Across, voice: boolean): Weight {
  const n = notes[i] as AudioNote;
  const from = voice ? beatOf(n) : n.t;
  const into = between(notes, i - 1, across) ?? [from - EDGE_S / 2, from + EDGE_S / 2];
  const out = between(notes, i, across) ?? [endOf(n) - EDGE_S / 2, endOf(n) + EDGE_S / 2];
  return { r0: into[0], r1: into[1], f0: out[0], f1: out[1] };
}

/** The weight at a time (s). Two notes that touch read one turn-over the same way, so theirs add to one. */
function weightAt(w: Weight, x: number): number {
  return smooth((x - w.r0) / (w.r1 - w.r0)) * (1 - smooth((x - w.f0) / (w.f1 - w.f0)));
}

/** The first index of ascending `t` at or past `x`. */
function firstAtOrPast(t: ArrayLike<number>, x: number): number {
  let lo = 0;
  let hi = t.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((t[mid] as number) < x) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** Adds each note's change times its weight into `out`, at the times `t` (s, ascending). */
function addChanges(
  out: Float64Array,
  notes: readonly AudioNote[],
  t: ArrayLike<number>,
  across: Across,
  voice: boolean,
  change: (n: AudioNote) => number,
): void {
  for (let i = 0; i < notes.length; i++) {
    const c = change(notes[i] as AudioNote);
    if (c === 0) continue;
    const w = weightOf(notes, i, across, voice);
    const end = firstAtOrPast(t, w.f1);
    for (let k = firstAtOrPast(t, w.r0); k < end; k++) out[k] = (out[k] as number) + c * weightAt(w, t[k] as number);
  }
}

/**
 * A note's pitch as found, against its centre p: its drift and its vibrato over its held part (steps
 * k0 to k1 of the track, both in), the drift held at its edge values either side of it.
 */
interface Parts {
  k0: number;
  k1: number;
  /** The drift at each held step (semitones from p). */
  drift: Float64Array;
  /** The vibrato at each held step, times how much of its edit is heard there (0 at the held part's edges, 1 within). */
  vib: Float64Array;
}

/**
 * A moving average over `w` steps (all of them where there are fewer), its window kept within the
 * values at the ends; an even window has its extra step after (`late`) or before the step it's for.
 */
function average(x: Float64Array, w: number, late: boolean): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const sum = new Float64Array(n + 1);
  for (let s = 0; s < n; s++) sum[s + 1] = (sum[s] as number) + (x[s] as number);
  if (w >= n) return out.fill((sum[n] as number) / n);
  const back = late ? Math.floor((w - 1) / 2) : Math.ceil((w - 1) / 2);
  for (let s = 0; s < n; s++) {
    const lo = Math.max(0, Math.min(n - w, s - back));
    out[s] = ((sum[lo + w] as number) - (sum[lo] as number)) / w;
  }
  return out;
}

/** A pitched note's drift and vibrato, from the pitch as found (null where the track has no steps). */
function partsOf(n: AudioNote, track: PitchTrack): Parts | null {
  const { t, midi } = track;
  const steps = t.length;
  if (!steps) return null;
  const p = n.p as number;
  const end = endOf(n);
  const beat = beatOf(n);
  const h0 = beat + Math.min(ATTACK_S, (end - beat) / 4);
  const h1 = end - Math.min(RELEASE_S, (end - beat) / 4);
  const k0 = firstAtOrPast(t, h0);
  const k1 = firstAtOrPast(t, h1 + 1e-9) - 1;
  const ht: number[] = [];
  const hp: number[] = [];
  for (let k = k0; k <= k1; k++)
    if (!Number.isNaN(midi[k] as number)) {
      ht.push(t[k] as number);
      hp.push(midi[k] as number);
    }
  if (hp.length < 3) {
    // too little held to tell a drift from a vibrato: the note's mean, all through
    let sum = 0;
    let count = 0;
    for (let k = firstAtOrPast(t, n.t); k < steps && (t[k] as number) < end; k++)
      if (!Number.isNaN(midi[k] as number)) {
        sum += (midi[k] as number) - p;
        count++;
      }
    const at = Math.max(0, Math.min(steps - 1, firstAtOrPast(t, (n.t + end) / 2)));
    return { k0: at, k1: at, drift: Float64Array.of(count ? sum / count : 0), vib: new Float64Array(1) };
  }
  // the held part, its gaps filled in between the pitches either side
  const count = k1 - k0 + 1;
  const dev = new Float64Array(count);
  let last = -1;
  for (let s = 0; s < count; s++) {
    const m = midi[k0 + s] as number;
    if (Number.isNaN(m)) continue;
    dev[s] = m - p;
    if (last < 0) dev.fill(m - p, 0, s);
    else
      for (let q = last + 1; q < s; q++)
        dev[q] = (dev[last] as number) + ((m - p - (dev[last] as number)) * (q - last)) / (s - last);
    last = s;
  }
  dev.fill(dev[last] as number, last + 1);
  // a straight line through it, then what swings around that line smoothed
  let sx = 0;
  let sy = 0;
  for (let s = 0; s < count; s++) {
    sx += s;
    sy += dev[s] as number;
  }
  const mx = sx / count;
  const my = sy / count;
  let num = 0;
  let den = 0;
  for (let s = 0; s < count; s++) {
    num += (s - mx) * ((dev[s] as number) - my);
    den += (s - mx) * (s - mx);
  }
  const slope = den > 0 ? num / den : 0;
  const rest = Float64Array.from(dev, (v, s) => v - (my + slope * (s - mx)));
  const step = count > 1 ? ((t[k1] as number) - (t[k0] as number)) / (count - 1) : FINE_S;
  const vibrato = heldPitch(ht, hp).vibrato;
  // (the vibrato's cycle in steps: it's measured on the steps as they are, FINE_S apart as it reads them)
  const cycle = vibrato ? 1 / (vibrato.rate * FINE_S) : 0;
  const w = Math.max(1, Math.round(DRIFT_S / step), Math.round(cycle));
  const smoothed = average(average(rest, w, false), w, true);
  const drift = Float64Array.from(smoothed, (v, s) => v + my + slope * (s - mx));
  const t0 = t[k0] as number;
  const t1 = t[k1] as number;
  const vib = Float64Array.from(
    dev,
    (v, s) =>
      (v - (drift[s] as number)) *
      smooth(Math.min((t[k0 + s] as number) - t0, t1 - (t[k0 + s] as number)) / VIBRATO_IN_S),
  );
  return { k0, k1, drift, vib };
}

/**
 * Reads values kept at steps k0..k1 of a track's times at ascending times, in line between steps:
 * outside them the value at the nearer end (`hold`) or 0.
 */
function reader(
  t: ArrayLike<number>,
  k0: number,
  k1: number,
  values: Float64Array,
  hold: boolean,
): (x: number) => number {
  let k = k0;
  const first = values[0] as number;
  const last = values[values.length - 1] as number;
  return (x) => {
    if (x <= (t[k0] as number)) return hold || x === t[k0] ? first : 0;
    if (x >= (t[k1] as number)) return hold || x === t[k1] ? last : 0;
    while (k + 1 < k1 && (t[k + 1] as number) <= x) k++;
    const ta = t[k] as number;
    const v = values[k - k0] as number;
    return v + ((values[k + 1 - k0] as number) - v) * ((x - ta) / ((t[k + 1] as number) - ta));
  };
}

/** The pitch as found at ascending times: in line between steps, the nearer step's where the other isn't voiced (NaN outside the track). */
function pitchReader(track: PitchTrack): (x: number) => number {
  const { t, midi } = track;
  const steps = t.length;
  let k = 0;
  return (x) => {
    if (!steps || x < (t[0] as number) || x > (t[steps - 1] as number)) return Number.NaN;
    while (k + 1 < steps && (t[k + 1] as number) <= x) k++;
    if (k + 1 >= steps) return midi[k] as number;
    const a = midi[k] as number;
    const b = midi[k + 1] as number;
    const u = (x - (t[k] as number)) / ((t[k + 1] as number) - (t[k] as number));
    if (Number.isNaN(a) || Number.isNaN(b)) return u < 0.5 ? a : b;
    return a + (b - a) * u;
  };
}

/** Whether a note moves the pitch (its centre, drift or vibrato edited). */
const pitchMoved = (n: AudioNote): boolean =>
  n.p !== null && ((n.to !== undefined && n.to !== n.p) || (n.dr ?? 1) !== 1 || (n.mo ?? 1) !== 1);

/** Whether the glide into note i is made again: its `tr` set (not 1), from a pitched note it touches. */
function glideEdited(notes: readonly AudioNote[], i: number): boolean {
  const n = notes[i] as AudioNote;
  const prev = notes[i - 1];
  return (
    n.tr !== undefined &&
    n.tr !== 1 &&
    n.p !== null &&
    prev !== undefined &&
    prev.p !== null &&
    between(notes, i - 1, pitchAcross) !== null
  );
}

/** How far a glide made again may reach into a note from where it meets the next (s), its way in and out within. */
const glideReach = (n: AudioNote): number => Math.min(GLIDE_SHARE * n.d, GLIDE_REACH_S);

/**
 * From when to when (seconds of the file) a line's notes' pitch and formant edits can move its sound
 * at all, or null where none does: the renderer hears the recording around it.
 */
export function pitchSpan(notes: readonly AudioNote[]): [number, number] | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i] as AudioNote;
    const glide = glideEdited(notes, i);
    if (!pitchMoved(n) && (n.fo ?? 0) === 0 && !glide) continue;
    const w = weightOf(notes, i, pitchAcross, true);
    lo = Math.min(lo, w.r0);
    hi = Math.max(hi, w.f1);
    if (glide) {
      const prev = notes[i - 1] as AudioNote;
      const mid = (endOf(prev) + n.t) / 2;
      lo = Math.min(lo, mid - glideReach(prev));
      hi = Math.max(hi, mid + glideReach(n));
    }
  }
  return lo <= hi ? [lo, hi] : null;
}

/** The glide into a note made again: where it's heard, fully from u0 to u1, and the smoothstep it follows (from g0, gl long). */
interface Glide {
  u0: number;
  u1: number;
  g0: number;
  gl: number;
}

/** The glide into note i (from the note before, which it touches) made again, or null where it can't be. */
function glideOf(notes: readonly AudioNote[], i: number, track: PitchTrack, a: Parts, b: Parts): Glide | null {
  const prev = notes[i - 1] as AudioNote;
  const n = notes[i] as AudioNote;
  const zone = between(notes, i - 1, pitchAcross) as [number, number];
  const mid = (zone[0] + zone[1]) / 2;
  const z = zone[1] - zone[0];
  const reachA = glideReach(prev) - GLIDE_IN_S;
  const reachB = glideReach(n) - GLIDE_IN_S;
  if (reachA <= 0 || reachB <= 0) return null;
  // the glide as sung: where it crosses 10%, 50% and 90% of the way from one note's line to the next's
  const { t, midi } = track;
  const lineA = reader(t, a.k0, a.k1, a.drift, true);
  const lineB = reader(t, b.k0, b.k1, b.drift, true);
  const pa = prev.p as number;
  const pb = n.p as number;
  const lo = firstAtOrPast(t, mid - z);
  const hi = firstAtOrPast(t, mid + z);
  const ts: number[] = [];
  const share: number[] = [];
  for (let k = lo; k < hi; k++) {
    const m = midi[k] as number;
    const x = t[k] as number;
    const from = pa + lineA(x);
    const to = pb + lineB(x);
    if (Number.isNaN(m) || Math.abs(to - from) < GLIDE_STEP) continue;
    ts.push(x);
    share.push((m - from) / (to - from));
  }
  /** Where the share crosses `level` between steps j and j + 1, or NaN. */
  const crossing = (j: number, level: number): number => {
    const u = (share[j] as number) - level;
    const v = (share[j + 1] as number) - level;
    if (u === v || (u > 0 && v > 0) || (u < 0 && v < 0)) return Number.NaN;
    return (ts[j] as number) + (((ts[j + 1] as number) - (ts[j] as number)) * u) / (u - v);
  };
  let centre = Number.NaN;
  let half = -1;
  for (let j = 0; j + 1 < ts.length; j++) {
    const c = crossing(j, 0.5);
    if (!Number.isNaN(c) && (Number.isNaN(centre) || Math.abs(c - mid) < Math.abs(centre - mid))) {
      centre = c;
      half = j;
    }
  }
  let t10 = Number.NaN;
  let t90 = Number.NaN;
  if (half >= 0) {
    for (let j = half; j >= 0 && Number.isNaN(t10); j--) t10 = crossing(j, 0.1);
    for (let j = half; j + 1 < ts.length && Number.isNaN(t90); j++) t90 = crossing(j, 0.9);
  }
  let sung = z;
  if (Number.isNaN(t10) || Number.isNaN(t90) || !(t90 > t10)) centre = mid;
  else sung = Math.max(GLIDE_MIN_S, (t90 - t10) / RISE_SHARE);
  // made again, `tr` times as long, within the notes
  const limit = 2 * Math.min(centre - (mid - reachA), mid + reachB - centre);
  if (!(limit > 0)) return null;
  const gl = Math.min(limit, Math.max(GLIDE_MIN_S, (n.tr as number) * sung));
  const u0 = Math.max(mid - reachA, Math.min(mid - z / 2, centre - Math.max(sung, gl) / 2));
  const u1 = Math.min(mid + reachB, Math.max(mid + z / 2, centre + Math.max(sung, gl) / 2));
  return { u0, u1, g0: centre - gl / 2, gl };
}

/** Each note's drift and vibrato, worked out once they're asked for. */
function partsCache(notes: readonly AudioNote[], track: PitchTrack): (i: number) => Parts | null {
  const kept: (Parts | null | undefined)[] = new Array(notes.length);
  return (i) => {
    let p = kept[i];
    if (p === undefined) {
      p = partsOf(notes[i] as AudioNote, track);
      kept[i] = p;
    }
    return p;
  };
}

/** A note's line as edited, with its vibrato as edited, at ascending times. */
function editedLine(n: AudioNote, parts: Parts, track: PitchTrack): (x: number) => number {
  const drift = reader(track.t, parts.k0, parts.k1, parts.drift, true);
  const vib = reader(track.t, parts.k0, parts.k1, parts.vib, false);
  const centre = n.to ?? (n.p as number);
  const dr = n.dr ?? 1;
  const mo = n.mo ?? 1;
  return (x) => centre + dr * drift(x) + mo * vib(x);
}

/**
 * How far a line's notes (by start, as kept) move its pitch at each time of `t` (seconds of the file,
 * ascending), in semitones. With `track` (the pitch as found), their drift, vibrato and glides too, and
 * nothing moves where it isn't voiced.
 */
export function targetShift(notes: readonly AudioNote[], t: ArrayLike<number>, track?: PitchTrack): Float64Array {
  const out = new Float64Array(t.length);
  addChanges(out, notes, t, pitchAcross, true, (n) => (n.p !== null && n.to !== undefined ? n.to - n.p : 0));
  if (!track) return out;
  const parts = partsCache(notes, track);
  // each note's drift and vibrato, as much as is kept
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i] as AudioNote;
    const dr = (n.dr ?? 1) - 1;
    const mo = (n.mo ?? 1) - 1;
    if (n.p === null || (dr === 0 && mo === 0)) continue;
    const p = parts(i);
    if (!p) continue;
    const drift = reader(track.t, p.k0, p.k1, p.drift, true);
    const vib = reader(track.t, p.k0, p.k1, p.vib, false);
    const w = weightOf(notes, i, pitchAcross, true);
    const end = firstAtOrPast(t, w.f1);
    for (let k = firstAtOrPast(t, w.r0); k < end; k++) {
      const x = t[k] as number;
      out[k] = (out[k] as number) + weightAt(w, x) * (dr * drift(x) + mo * vib(x));
    }
  }
  // the glides made again
  for (let i = 1; i < notes.length; i++) {
    if (!glideEdited(notes, i)) continue;
    const a = parts(i - 1);
    const b = parts(i);
    if (!a || !b) continue;
    const g = glideOf(notes, i, track, a, b);
    if (!g) continue;
    const from = editedLine(notes[i - 1] as AudioNote, a, track);
    const to = editedLine(notes[i] as AudioNote, b, track);
    const pitch = pitchReader(track);
    const end = firstAtOrPast(t, g.u1 + GLIDE_IN_S);
    for (let k = firstAtOrPast(t, g.u0 - GLIDE_IN_S); k < end; k++) {
      const x = t[k] as number;
      const heard = pitch(x);
      if (Number.isNaN(heard)) continue;
      const blend = smooth((x - (g.u0 - GLIDE_IN_S)) / GLIDE_IN_S) * (1 - smooth((x - g.u1) / GLIDE_IN_S));
      const u = smooth((x - g.g0) / g.gl);
      const target = (1 - u) * from(x) + u * to(x);
      out[k] = (out[k] as number) + blend * (target - heard - (out[k] as number));
    }
  }
  const pitch = pitchReader(track);
  for (let k = 0; k < out.length; k++) if (out[k] !== 0 && Number.isNaN(pitch(t[k] as number))) out[k] = 0;
  return out;
}

/**
 * A line's pitch as its note edits make it sound, at each step of the pitch as found (MIDI with cents,
 * NaN where it isn't voiced): what the Notes view draws, from the same shift the renderer moves it by.
 */
export function editedPitch(notes: readonly AudioNote[], track: PitchTrack): Float64Array {
  const shift = targetShift(notes, track.t, track);
  const out = new Float64Array(track.t.length);
  for (let k = 0; k < out.length; k++) out[k] = (track.midi[k] as number) + (shift[k] as number);
  return out;
}

/** How far a line's notes (by start, as kept) move its formants at each time of `t` (seconds of the file, ascending), in semitones. */
export function formantShift(notes: readonly AudioNote[], t: ArrayLike<number>): Float64Array {
  const out = new Float64Array(t.length);
  addChanges(out, notes, t, pitchAcross, true, (n) => (n.p !== null ? (n.fo ?? 0) : 0));
  return out;
}

/** The level a line's notes (by start, as kept) play at at each time of `t` (seconds of the file, ascending): 1 as recorded, 0 muted. */
export function noteGain(notes: readonly AudioNote[], t: ArrayLike<number>): Float64Array {
  const out = new Float64Array(t.length).fill(1);
  addChanges(out, notes, t, levelAcross, false, (n) => (n.m ? 0 : 10 ** ((n.g ?? 0) / 20)) - 1);
  return out;
}
