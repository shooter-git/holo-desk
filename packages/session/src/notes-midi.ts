/**
 * A recording's notes as MIDI: a region's notes (as they play, edits in) written as a new MIDI track's
 * notes on the song's timeline, for the studio's "Notes to MIDI track", the agent's `audio_notes`
 * `midi` and `holo notes midi`. Not an edit of the notes (NOTE_EDITS): it adds a track, and the
 * recording's notes stay as they are.
 *
 * - **Where.** Each note starts at the tick where its beat plays (after its consonant: `t + u`) and
 *   ends where it ends, both through the warp its moves make, the region's offset and stretch and the
 *   tempo map (`fileToTicks`). Only the notes whose beat plays within the region are written, cut at
 *   its end.
 * - **Which.** Notes with no pitch (breaths, consonants) and muted notes are left out. Each pitch is
 *   the nearest semitone of where it's tuned (`to`, else as found).
 * - **How loud.** With the notes' levels (dB as recorded, by index, measured from the recording), each
 *   velocity follows its level as it plays (with its gain): the loudest at 110, 6 dB quieter at about
 *   0.7 of that (velocity as 40·log10, a common curve). Without them, every note plays at
 *   100.
 * - When the region's edits are off it plays as recorded, and its notes are written so: pitches as
 *   found, no moves, muted notes in.
 */
import { fileToTicks } from './audio-notes.ts';
import { DEFAULT_SYNTH, newRegion, newTrack } from './defaults.ts';
import type { Op } from './ops.ts';
import type { AudioNote, AudioNotes, Note, Project, Region, Track } from './types.ts';

/** A note's velocity when the notes' levels aren't known. */
export const MIDI_NOTE_VELOCITY = 100;
/** The loudest note's velocity when they are. */
export const MIDI_LOUDEST_VELOCITY = 110;

export interface NotesToMidi {
  /** The notes, when they aren't the region's own (those found in its recording, before its first edit). */
  notes?: AudioNotes;
  /** Each note's level as recorded (dB, by its index; null where unknown): its velocity follows it. */
  levels?: readonly (number | null | undefined)[];
}

/** A region's notes as a MIDI region's notes (ticks from the region's start), in order. */
export function midiNotesOf(
  project: Pick<Project, 'tempo'>,
  region: Region,
  notes: AudioNotes,
  levels?: readonly (number | null | undefined)[],
): Note[] {
  const clip = region.audio;
  if (!clip) return [];
  const asRecorded = notes.off === true;
  const tick = fileToTicks(project, { start: region.start, audio: { ...clip, notes } });
  const end = region.start + region.length;
  const plays = (n: AudioNote) => n.p !== null && (asRecorded || !n.m);
  // the loudest as it plays, of the notes written with a level
  const levelOf = (n: AudioNote, i: number): number | null => {
    const level = levels?.[i];
    if (typeof level !== 'number' || !Number.isFinite(level)) return null;
    return level + (asRecorded ? 0 : (n.g ?? 0));
  };
  let loudest = Number.NEGATIVE_INFINITY;
  notes.n.forEach((n, i) => {
    const level = plays(n) ? levelOf(n, i) : null;
    if (level !== null) loudest = Math.max(loudest, level);
  });
  const out: Note[] = [];
  notes.n.forEach((n, i) => {
    if (!plays(n)) return;
    const start = Math.round(tick(n.t + (n.u ?? 0)));
    if (start < region.start || start >= end) return;
    const stop = Math.min(end, Math.round(tick(n.t + n.d)));
    const pitch = Math.min(127, Math.max(0, Math.round(asRecorded ? (n.p as number) : (n.to ?? (n.p as number)))));
    const level = levelOf(n, i);
    const v =
      level === null
        ? MIDI_NOTE_VELOCITY
        : Math.min(127, Math.max(1, Math.round(MIDI_LOUDEST_VELOCITY * 10 ** ((level - loudest) / 40))));
    out.push({ t: start - region.start, d: Math.max(1, stop - start), p: pitch, v });
  });
  return out.sort((a, b) => a.t - b.t || a.p - b.p);
}

/**
 * The operations that add a MIDI track playing an audio region's notes: named after the audio track
 * ("Vocal notes"), just below it, in its colour, with one region over the audio region's span. Empty
 * when the region isn't a recording on that track, or it has no notes (`o.notes` when they aren't the
 * region's own).
 */
export function notesToMidi(project: Project, trackId: string, regionId: string, o: NotesToMidi = {}): Op[] {
  const index = project.tracks.findIndex((t) => t.id === trackId);
  const track = project.tracks[index];
  const region = track?.regions.find((r) => r.id === regionId);
  const notes = o.notes ?? region?.audio?.notes;
  if (!track || !region?.audio || !notes) return [];
  const added: Track = newTrack(`${track.name} notes`, { ...DEFAULT_SYNTH }, track.color);
  const midi: Region = {
    ...newRegion(region.start, region.length, region.name),
    notes: midiNotesOf(project, region, notes, o.levels),
  };
  return [
    { op: 'addTrack', track: added, index: index + 1 },
    { op: 'addRegion', track: added.id, region: midi },
  ];
}
