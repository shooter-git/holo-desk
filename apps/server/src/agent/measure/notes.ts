/**
 * A recording's notes, for the agent's `audio_notes` and `holo notes` (tasks.ts runs them in the
 * measuring child): found as the studio's Notes view finds them, and what a take sounds like with its
 * notes edited.
 *
 * - **Found the same way.** The recording is decoded as every renderer decodes it (`decodeWav`, at its
 *   own rate) and its notes found with the studio's own call (`notesAndCurves`), so the host and the
 *   studio find the same notes in the same file. Beside them: each note's drift and vibrato as sung,
 *   from the same pitch curve, measured as a take's are (the engine's `noteShape`), and what kind of
 *   recording it looks like.
 * - **What plays.** A region whose notes are edited plays its recording with its patches in place
 *   (`renderNotePatch`, `assembleClip`): the recording at the song's rate, stretched as the region
 *   stretches it, as a bounce plays it. Measuring a take reads that, so a note tuned is measured where
 *   it now sings.
 */
import {
  assembleClip,
  classifyRecording,
  decodeWav,
  loadClipAudio,
  type NoteCurves,
  noteShape,
  notesAndCurves,
  type RenderSource,
  regionPatches,
  renderNotePatch,
} from '@holo/engine';
import type { AudioClip, AudioNote, AudioNotes, AudioNotesMode, Project, Track } from '@holo/session';

/** A note's drift (cents a straight line through its held part moves) and vibrato ([Hz, ±cents]), as sung. */
export interface NoteShape {
  drift: number;
  vibrato: [number, number] | null;
}

export interface FoundNotes {
  notes: AudioNotes;
  /** Each note's shape, by its index (null for a note with no pitch). */
  shapes: (NoteShape | null)[];
  /** What kind of recording it looks like: notes are found as one line's for now, a chord's strongest. */
  looks: AudioNotesMode;
}

/** To a tenth (and 0, never −0). */
const r1 = (v: number) => Math.round(v * 10) / 10 || 0;

/** A note's drift and vibrato as sung (the engine's `noteShape`), rounded to a tenth. */
function shapeOf(n: AudioNote, curves: NoteCurves): NoteShape | null {
  const s = noteShape(n, curves);
  if (!s) return null;
  return { drift: r1(s.drift), vibrato: s.vibrato ? [r1(s.vibrato.rate), r1(s.vibrato.depth)] : null };
}

/** A recording's notes as the studio finds them (its WAV bytes, as the song keeps them), with their shapes. */
export function findNotes(wav: Uint8Array): FoundNotes & { seconds: number } {
  const d = decodeWav(wav);
  const { notes, curves } = notesAndCurves(d.channels, d.rate);
  return {
    notes,
    shapes: notes.n.map((n) => shapeOf(n, curves)),
    looks: classifyRecording(d.channels, d.rate).mode,
    seconds: Math.round(((d.channels[0]?.length ?? 0) / d.rate) * 1000) / 1000,
  };
}

/** A region's recording as it plays with its note edits (at `sr`, stretched), or null when none is edited. */
export async function editedClip(source: RenderSource, clip: AudioClip, sr: number): Promise<Float32Array[] | null> {
  const jobs = regionPatches(clip, sr);
  if (!jobs.length) return null;
  const base = await loadClipAudio(source, clip, sr);
  return assembleClip(
    base,
    jobs.map((job) => ({ spec: job.spec, channels: renderNotePatch(base, sr, job.spec) })),
  );
}

/** What stands for an edited region's recording while a take is measured. */
const EDITED = 'edited:';

/**
 * A take's track as it plays, for measuring: each region whose notes are edited (`region`'s alone,
 * when given) reads its recording with its patches in place, as a recording of its own at the song's
 * rate that needs no stretch (`decode` finds it); the rest read their files as they are.
 */
export async function playedTake(
  project: Project,
  track: Track,
  source: RenderSource & { decodeAudio(file: string): { rate: number; channels: Float32Array[] } | null },
  region?: string,
): Promise<{
  project: Project;
  track: Track;
  decode: (file: string) => { rate: number; channels: Float32Array[] } | null;
}> {
  const sr = project.sampleRate ?? 48000;
  const edited = new Map<string, Float32Array[]>();
  const regions = await Promise.all(
    track.regions.map(async (r) => {
      const clip = r.audio;
      if (!clip?.notes || r.muted || (region && r.id !== region)) return r;
      const channels = await editedClip(source, clip, sr);
      if (!channels) return r;
      edited.set(r.id, channels);
      const audio: AudioClip = {
        file: `${EDITED}${r.id}`,
        offset: clip.offset * clip.stretch,
        gain: clip.gain,
        fadeIn: clip.fadeIn,
        fadeOut: clip.fadeOut,
        stretch: 1,
      };
      return { ...r, audio };
    }),
  );
  if (!edited.size) return { project, track, decode: (file) => source.decodeAudio(file) };
  const played = { ...track, regions };
  return {
    project: { ...project, tracks: project.tracks.map((t) => (t.id === track.id ? played : t)) },
    track: played,
    decode: (file) => {
      const channels = file.startsWith(EDITED) ? edited.get(file.slice(EDITED.length)) : undefined;
      return channels ? { rate: sr, channels } : source.decodeAudio(file);
    },
  };
}
