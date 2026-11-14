/**
 * What a line's note edits do to its sound moment by moment: how far its pitch moves (semitones) and
 * the level it plays at. The renderer moves the sound by these (psola.ts) and the Notes view draws
 * them, from the same code, so what's drawn is what plays.
 *
 * - A note's pitch moved (`to`) moves its sound by `to − p` all through it. Between two notes that
 *   touch (one sung straight into the next), the shift goes from one note's to the next's across a
 *   transition centred where they meet: the shorter of 120 ms and 40% of the shorter note, along an
 *   S-shaped curve (smoothstep), so the glide between them moves with them. A note that doesn't touch
 *   its neighbour takes its shift up and down over 10 ms around that edge. Nothing moves anywhere
 *   else, nor where the sound isn't voiced (a consonant, a breath: there's no pitch to move).
 * - A note's level (`g`, dB) or its mute (`m`) comes in and goes over 10 ms around its edges; between
 *   notes that touch, from one's level to the next's.
 *
 * Each note's part is its weight (1 within it, 0 away from it, the curve across its edges) times its
 * change, and the weights of two notes that touch add to one across their transition. Where no note's
 * change reaches, the shift is exactly 0 and the level exactly 1, so the renderer copies the recording
 * there, to the bit. A note's drift (`dr`), vibrato (`mo`), transition (`tr`) and formant (`fo`) are
 * kept with it but not heard yet: each will be its own change under the same weights.
 */
import type { AudioNote } from '@holo/session';

/** A note's edges, where it doesn't touch its neighbour: its changes come in and go over this long (s). */
const EDGE_S = 0.01;
/** The longest transition of pitch between notes that touch (s), and the most of the shorter note it takes. */
const TRANSITION_S = 0.12;
const TRANSITION_SHARE = 0.4;
/** Notes this close (s) touch. */
const TOUCH_S = 0.001;

const smooth = (u: number): number => (u <= 0 ? 0 : u >= 1 ? 1 : u * u * (3 - 2 * u));
const endOf = (n: AudioNote): number => n.t + n.d;

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

function weightOf(notes: readonly AudioNote[], i: number, across: Across): Weight {
  const n = notes[i] as AudioNote;
  const into = between(notes, i - 1, across) ?? [n.t - EDGE_S / 2, n.t + EDGE_S / 2];
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
  change: (n: AudioNote) => number,
): void {
  for (let i = 0; i < notes.length; i++) {
    const c = change(notes[i] as AudioNote);
    if (c === 0) continue;
    const w = weightOf(notes, i, across);
    const end = firstAtOrPast(t, w.f1);
    for (let k = firstAtOrPast(t, w.r0); k < end; k++) out[k] = (out[k] as number) + c * weightAt(w, t[k] as number);
  }
}

/**
 * How far a line's notes (by start, as kept) move its pitch at each time of `t` (seconds of the file,
 * ascending), in semitones. With `midi` (the pitch found at each of those times, NaN where the sound
 * isn't voiced), nothing moves where it isn't voiced.
 */
export function targetShift(notes: readonly AudioNote[], t: ArrayLike<number>, midi?: ArrayLike<number>): Float64Array {
  const out = new Float64Array(t.length);
  addChanges(out, notes, t, pitchAcross, (n) => (n.p !== null && n.to !== undefined ? n.to - n.p : 0));
  if (midi) for (let k = 0; k < out.length; k++) if (Number.isNaN(midi[k] as number)) out[k] = 0;
  return out;
}

/** The level a line's notes (by start, as kept) play at at each time of `t` (seconds of the file, ascending): 1 as recorded, 0 muted. */
export function noteGain(notes: readonly AudioNote[], t: ArrayLike<number>): Float64Array {
  const out = new Float64Array(t.length).fill(1);
  addChanges(out, notes, t, levelAcross, (n) => (n.m ? 0 : 10 ** ((n.g ?? 0) / 20)) - 1);
  return out;
}
