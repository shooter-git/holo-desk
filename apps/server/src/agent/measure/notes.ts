/**
 * A recording's notes, for the agent's `audio_notes` and `holo notes` (tasks.ts runs them in the
 * measuring child): found as the studio's Notes view finds them, and what a take sounds like with its
 * notes edited.
 *
 * - **Found the same way.** The recording is decoded as every renderer decodes it (`decodeWav`, at its
 *   own rate) and its notes found with the studio's own call (`notesAndCurves`), so the host and the
 *   studio find the same notes in the same file. Beside them: each note's drift and vibrato as sung,
 *   from the same pitch curve, measured as a take's are (the engine's `noteShape`), each note's level
 *   as recorded from the same power curve (`noteLevel`, as the studio reads it, for the `level` macro
 *   and a MIDI track's velocities), and what kind of recording it looks like.
 * - **What plays.** A region whose notes are edited plays its recording with its patches in place
 *   (`renderNotePatch`, `assembleClip`): the recording at the song's rate, stretched as the region
 *   stretches it, as a bounce plays it. Measuring a take reads that, so a note tuned is measured where
 *   it now sings, and finds any click its edits make (the engine's click measure, over each patch
 *   against the recording there).
 */
import {
  assembleClip,
  classifyRecording,
  decodeWav,
  loadClipAudio,
  type NoteCurves,
  noteLevel,
  noteShape,
  notesAndCurves,
  type RenderSource,
  regionPatches,
  renderNotePatch,
} from '@holo/engine';
import { findClicks } from '@holo/engine/analysis';
import {
  type AudioClip,
  type AudioNote,
  type AudioNotes,
  type AudioNotesMode,
  fileToTicks,
  type Project,
  type Region,
  type Track,
  tickToSeconds,
} from '@holo/session';

/** A note's drift (cents a straight line through its held part moves) and vibrato ([Hz, ±cents]), as sung. */
export interface NoteShape {
  drift: number;
  vibrato: [number, number] | null;
}

export interface FoundNotes {
  notes: AudioNotes;
  /** Each note's shape, by its index (null for a note with no pitch). */
  shapes: (NoteShape | null)[];
  /** Each note's level as recorded, dB of full scale, by its index (null where there's nothing to read). */
  levels: (number | null)[];
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
    levels: notes.n.map((n) => noteLevel(n, curves)),
    looks: classifyRecording(d.channels, d.rate).mode,
    seconds: Math.round(((d.channels[0]?.length ?? 0) / d.rate) * 1000) / 1000,
  };
}

/** A click a region's note edits make: where it plays (ticks, and seconds of the song), what kind and how big. */
export interface EditClick {
  region: string;
  tick: number;
  at: number;
  kind: 'burst' | 'jump';
  /** dB of high frequencies over the recording's there (a burst), or the share of the level it jumps by (a jump). */
  size: number;
  /** How loud it is there, dBFS. */
  level: number;
}

/** The mean of a recording's channels. */
const meanOf = (channels: readonly Float32Array[]): Float32Array => {
  const first = channels[0] ?? new Float32Array(0);
  if (channels.length < 2) return first;
  return first.map((_, i) => channels.reduce((m, c) => m + ((c[i] as number) ?? 0), 0) / channels.length);
};

/**
 * A region's recording as it plays with its note edits (at `sr`, stretched), and the clicks they make
 * in it (the patches' sound against the recording's, 50 ms either side of each: elsewhere it's the
 * recording itself), by frame; null when none is edited.
 */
export async function editedClip(
  source: RenderSource,
  clip: AudioClip,
  sr: number,
): Promise<{
  channels: Float32Array[];
  clicks: { frame: number; kind: 'burst' | 'jump'; size: number; level: number }[];
} | null> {
  const jobs = regionPatches(clip, sr);
  if (!jobs.length) return null;
  const base = await loadClipAudio(source, clip, sr);
  const channels = assembleClip(
    base,
    jobs.map((job) => ({ spec: job.spec, channels: renderNotePatch(base, sr, job.spec) })),
  );
  const heard = meanOf(base);
  const ref = new Float32Array(heard.length).fill(Number.NaN);
  const pad = Math.round(0.05 * sr);
  for (const j of jobs)
    for (let i = Math.max(0, j.spec.a - pad); i < Math.min(ref.length, j.spec.b + pad); i++)
      ref[i] = heard[i] as number;
  return { channels, clicks: findClicks(meanOf(channels), sr, [ref]) };
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
  /** The clicks the edits make, where the regions play them (none edited: null). */
  clicks: EditClick[] | null;
}> {
  const sr = project.sampleRate ?? 48000;
  const edited = new Map<string, Float32Array[]>();
  const clicks: EditClick[] = [];
  const regions = await Promise.all(
    track.regions.map(async (r) => {
      const clip = r.audio;
      if (!clip?.notes || r.muted || (region && r.id !== region)) return r;
      const done = await editedClip(source, clip, sr);
      if (!done) return r;
      const { channels } = done;
      edited.set(r.id, channels);
      clicks.push(...placed(project, r, clip, sr, done.clicks));
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
  if (!edited.size) return { project, track, decode: (file) => source.decodeAudio(file), clicks: null };
  const played = { ...track, regions };
  return {
    clicks: clicks.sort((a, b) => a.tick - b.tick),
    project: { ...project, tracks: project.tracks.map((t) => (t.id === track.id ? played : t)) },
    track: played,
    decode: (file) => {
      const channels = file.startsWith(EDITED) ? edited.get(file.slice(EDITED.length)) : undefined;
      return channels ? { rate: sr, channels } : source.decodeAudio(file);
    },
  };
}

/** A region's clicks (by frame of its recording as it plays, at `sr`) where it plays them on the song's timeline; those it doesn't play left out. */
function placed(
  project: Project,
  region: Region,
  clip: AudioClip,
  sr: number,
  found: readonly { frame: number; kind: 'burst' | 'jump'; size: number; level: number }[],
): EditClick[] {
  const tickOf = fileToTicks(project, region, true);
  const out: EditClick[] = [];
  for (const c of found) {
    const tick = tickOf(c.frame / (sr * clip.stretch));
    if (tick < region.start || tick >= region.start + region.length) continue;
    const at = Math.round(tickToSeconds(project.tempo, tick) * 1000) / 1000;
    out.push({
      region: region.id,
      tick: Math.round(tick),
      at,
      kind: c.kind,
      size: Math.round(c.size * 100) / 100,
      level: Math.round(c.level),
    });
  }
  return out;
}
