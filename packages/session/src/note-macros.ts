/**
 * The macros: edits of many notes at once, each note by its own amount (note-edits.ts offers them as
 * `correct-pitch`, `quantize-time` and `level`, in the studio's Macros dialog, the agent's
 * `audio_notes` and `holo notes`). Each is made with the helpers single edits use (audio-notes-edit.ts),
 * so what comes back is canonical, a move in time stays within the warp and within 4 s, and a note
 * already where the macro would put it is the same object as before.
 *
 * - **Correct pitch** moves each note's centre (its pitch now: moved, or as found) toward the pitch it
 *   snaps to, and takes some of its drift out. All the way, it lands exactly there, and a second time
 *   changes nothing.
 * - **Quantize time** moves each note's beat (where its voice starts, after its consonant: `t + u`, as
 *   it plays) toward the song's grid; the whole note moves, so its consonant stays before the beat. A
 *   line's notes only.
 * - **Level** brings notes' levels as they play (the recording's level there, measured, with the
 *   note's gain) toward their mean, or a level given. A note's level isn't in the song: it's measured
 *   from the recording (the engine's `noteLevel`) and given by index.
 */
import { fileToTicks, type NotesPlacing, roundAmount, roundPitch, roundTime, tickToFile } from './audio-notes.ts';
import {
  editEachNote,
  moveNotes,
  type NoteScales,
  noteIndices,
  type PitchSnap,
  resizeNote,
  snapTarget,
} from './audio-notes-edit.ts';
import type { AudioNote, AudioNotes, TempoPoint } from './types.ts';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

export interface CorrectPitch {
  /** How far each note's centre moves toward the pitch it snaps to: 0 not at all, 1 all the way. */
  centre: number;
  /** How much of each note's drift is taken out, as sung: 0 leaves its drift as it is, 1 holds it steady. */
  drift: number;
  /** Where each note goes: the nearest semitone, or the nearest note of the scale. */
  snap: Exclude<PitchSnap, 'free'>;
  /** Notes this many cents or closer to the pitch they snap to are left as they are (0: none are). */
  tolerance: number;
}

/**
 * Notes' pitches corrected: each centre moved part or all of the way to the nearest semitone (or note
 * of its scale), and part of its drift taken out (`dr` set to what's kept: `1 − drift`). A note with
 * no pitch, or within the tolerance of where it would go, is left as it is.
 */
export function correctPitch(
  notes: AudioNotes,
  indices: readonly number[],
  o: CorrectPitch,
  scale?: NoteScales,
): AudioNotes {
  const centre = clamp(Number.isFinite(o.centre) ? o.centre : 0, 0, 1);
  const drift = clamp(Number.isFinite(o.drift) ? o.drift : 0, 0, 1);
  const tolerance = Math.max(0, Number.isFinite(o.tolerance) ? o.tolerance : 0);
  if (!centre && !drift) return notes;
  const scaleOf = typeof scale === 'function' ? scale : () => scale ?? null;
  return editEachNote(notes, indices, (n, i) => {
    if (n.p === null) return null;
    const now = n.to ?? n.p;
    const target = snapTarget(now, o.snap, o.snap === 'scale' ? scaleOf(i) : null);
    if (tolerance > 0 && Math.abs(target - now) * 100 <= tolerance + 1e-6) return null;
    return {
      ...(centre ? { to: roundPitch(now + centre * (target - now)) } : {}),
      ...(drift ? { dr: roundAmount(1 - drift) } : {}),
    };
  });
}

/** Where a note starts as the region plays it (seconds of the file), and its beat: after its consonant. */
const playedStart = (n: AudioNote) => n.ts ?? n.t;
const playedBeat = (n: AudioNote) => playedStart(n) + (n.u ?? 0);

/**
 * A line's notes' beats moved toward the song's grid (`grid` ticks; `amount` 1 onto it, 0.5
 * halfway): each note's beat, where it plays now, to the nearest step of the grid on the song's
 * timeline (through the region's offset, stretch and the tempo map). Each note moves as a whole by
 * its own amount, one after another (`moveNotes`), as far as the warp lets it and within 4 s of where
 * it was found. Where two notes touch they stay joined: a note's start that followed the note
 * before it is put at its beat's place again (`resizeNote`), and that note's end follows it.
 */
export function quantizeNotes(
  notes: AudioNotes,
  indices: readonly number[],
  amount: number,
  grid: number,
  project: { tempo: readonly TempoPoint[] },
  region: NotesPlacing,
): AudioNotes {
  const share = clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
  if (notes.mode !== 'mono' || !share || !(grid > 0)) return notes;
  // (seconds as the region plays them: past the warp, so a beat moved before is where it plays)
  const placing: NotesPlacing = {
    start: region.start,
    audio: region.audio && { offset: region.audio.offset, stretch: region.audio.stretch },
  };
  const toTick = fileToTicks(project, placing, true);
  let out = notes;
  for (const i of noteIndices(notes, indices)) {
    const n = notes.n[i] as AudioNote;
    const from = playedBeat(n);
    const step = Math.round(toTick(from) / grid) * grid;
    const goal = from + share * (tickToFile(project, placing, step, true) - from);
    out = moveNotes(out, [i], goal - from);
    // (a legato note before it, moved first, took its start along: back to where its beat goes)
    const start = roundTime(goal - (n.u ?? 0));
    if (playedStart(out.n[i] as AudioNote) !== start) out = resizeNote(out, i, 'start', start);
  }
  return out;
}

/**
 * The notes `level` counts, of those chosen: each muted, or whose level isn't known, is left out, and
 * so is a note with no pitch (a breath, a lone consonant) unless `breaths` asks for them or they're
 * all that's chosen: levelled with the sung notes, a breath would come up as loud as a word.
 */
function levelled(
  notes: AudioNotes,
  indices: readonly number[],
  levels: readonly (number | null | undefined)[],
  breaths: boolean,
): number[] {
  const known = noteIndices(notes, indices).filter((i) => {
    const level = levels[i];
    return !notes.n[i]?.m && typeof level === 'number' && Number.isFinite(level);
  });
  const sung = known.filter((i) => notes.n[i]?.p !== null);
  return breaths || !sung.length ? known : sung;
}

/** A note's level as it plays: as recorded (`levels`, dB, to a hundredth) with its gain. */
const playing = (notes: AudioNotes, levels: readonly (number | null | undefined)[], i: number) =>
  roundAmount(levels[i] as number) + ((notes.n[i] as AudioNote).g ?? 0);

/**
 * Where `level` brings notes without a `target`: the mean of the levels, as they play, of the notes it
 * counts (dB, to a hundredth), or null when it counts none. The Macros dialog starts its target here.
 */
export function levelGoal(
  notes: AudioNotes,
  indices: readonly number[],
  levels: readonly (number | null | undefined)[],
  breaths = false,
): number | null {
  const idx = levelled(notes, indices, levels, breaths);
  if (!idx.length) return null;
  let sum = 0;
  for (const i of idx) sum += playing(notes, levels, i);
  return roundAmount(sum / idx.length);
}

/**
 * Notes' levels brought toward one level: their mean as they play (`levelGoal`), or `target` (dB)
 * when given; `amount` 1 all the way. The notes it counts are `levelGoal`'s: not muted, with a known
 * level, and with a pitch unless `breaths` is on or none chosen has one. Levels are taken to
 * hundredths of a dB, so all the way they come out the same and a second time changes nothing.
 */
export function levelNotes(
  notes: AudioNotes,
  indices: readonly number[],
  levels: readonly (number | null | undefined)[],
  amount: number,
  target?: number,
  breaths = false,
): AudioNotes {
  const share = clamp(Number.isFinite(amount) ? amount : 0, 0, 1);
  const idx = levelled(notes, indices, levels, breaths);
  if (!share || !idx.length) return notes;
  const goal =
    target !== undefined && Number.isFinite(target)
      ? roundAmount(target)
      : (levelGoal(notes, indices, levels, breaths) as number);
  return editEachNote(notes, idx, (n, i) => ({
    g: roundAmount((n.g ?? 0) + share * (goal - playing(notes, levels, i))),
  }));
}
