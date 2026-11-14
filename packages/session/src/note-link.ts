/**
 * An edit of a recording's notes made in every region of the song that plays that recording too:
 * linked editing (the studio's Link, the agent's and `holo notes`' `linked`). A region keeps its notes
 * and their edits as its own (a split or a copy edits on its own after), so linking is something an
 * edit does, not something the song keeps.
 *
 * - **The same notes.** Another region's note is the same note when it was found by the same detection
 *   (the notes' kind and version) at the same start in the recording (`t`; and the same pitch as found
 *   among chords' notes, which can start together), and the region plays it (it's within what the
 *   region plays of its recording, not one of those kept just past its edges).
 * - **The same edit.** Each edit is made again there (NOTE_EDITS, by name, with the same arguments), on
 *   those notes, in that region's place in the song: snapping to the key where it plays there, the
 *   grid where it plays there. What an edit copies from (`paste`, `copy-settings`) goes with it as
 *   the note itself, so it's the same note wherever the edit is made. A region the edit chooses none
 *   of the notes of is left as it is.
 * - **A first edit.** A region with no notes of its own yet gets those found in its recording (the
 *   two nearest past either edge kept too, as a split keeps them), with the edit, as any first edit.
 * - **One step.** Every region changed is one operation in one batch: one undo step.
 */
import { tickToFile } from './audio-notes.ts';
import { pruneNotes } from './audio-notes-edit.ts';
import type { MiddleC } from './notation.ts';
import { type NoteArgs, type NoteEditContext, noteEdit } from './note-edits.ts';
import type { Op } from './ops.ts';
import type { AudioClip, AudioNote, AudioNotes, Project, Region, Track } from './types.ts';

/** A note edit as it was made: its name in NOTE_EDITS, the notes it chose (indices), its arguments, and the note it copied from when that wasn't one of them. */
export interface NoteEditStep {
  name: string;
  indices: readonly number[];
  args: NoteArgs;
  source?: AudioNote;
}

/** A region of the song, with its track. */
export interface PlacedRegion {
  track: Track;
  region: Region;
}

/** The regions of the song that play a recording (its file's id), in the song's order. */
export function regionsPlaying(project: Pick<Project, 'tracks'>, file: string): PlacedRegion[] {
  return project.tracks.flatMap((track) =>
    track.regions.filter((r) => r.audio?.file === file).map((region) => ({ track, region })),
  );
}

/** The regions an edit of a region's notes is linked to: the others of the song playing its recording. */
export function linkedRegions(project: Pick<Project, 'tracks'>, regionId: string): PlacedRegion[] {
  const file = project.tracks.flatMap((t) => t.regions).find((r) => r.id === regionId)?.audio?.file;
  return file ? regionsPlaying(project, file).filter((x) => x.region.id !== regionId) : [];
}

/** The seconds of its recording a region plays, [from, to). */
export function regionWindow(project: Pick<Project, 'tempo'>, region: Region, clip: AudioClip): [number, number] {
  return [clip.offset, tickToFile(project, { start: region.start, audio: clip }, region.start + region.length)];
}

export interface LinkOptions {
  /** The region's notes the edits were made on, and as they came out there (what's applied to it). */
  base: AudioNotes;
  next: AudioNotes;
  /** The notes found in the recording, for a region with none of its own yet (and `reset`'s pitches as found). */
  found?: AudioNotes;
  middleC?: MiddleC;
  /** Each note's level as recorded (by index of the notes given), for `level`. */
  levels?: (notes: AudioNotes) => readonly (number | null)[] | null;
}

/** A region an edit changed: its notes before (as kept, or as found when it kept none) and after. */
export interface LinkedChange extends PlacedRegion {
  was: AudioNotes;
  now: AudioNotes;
  /** It kept notes of its own before (else these are its first). */
  kept: boolean;
}

/** Which note it is, among those found by one detection: where it starts (and, among chords' notes, its pitch as found). */
const sameKey = (notes: AudioNotes, n: AudioNote) => (notes.mode === 'mono' ? `${n.t}` : `${n.t}|${n.p}`);

/** What an edit needs to know of a region beyond its notes, there. */
function contextIn(
  project: Project,
  region: Region,
  clip: AudioClip,
  notes: AudioNotes,
  o: LinkOptions,
  source: AudioNote | undefined,
): NoteEditContext {
  const levels = o.levels?.(notes);
  return {
    project,
    region: { start: region.start, audio: { offset: clip.offset, stretch: clip.stretch, notes } },
    ...(o.middleC ? { middleC: o.middleC } : {}),
    ...(levels ? { levels } : {}),
    ...(source ? { source } : {}),
    ...(o.found ? { found: o.found.n } : {}),
  };
}

/**
 * The edits made on a region's notes (`steps`, which took `o.base` to `o.next`) made in every other
 * region of the song playing the same recording too, on the same notes: the operations, one per
 * region changed (the region itself first), to apply as one batch, and what changed in each.
 */
export function linkedNoteEdits(
  project: Project,
  at: { track: string; region: string },
  steps: readonly NoteEditStep[],
  o: LinkOptions,
): { ops: Op[]; changes: LinkedChange[] } {
  const track = project.tracks.find((t) => t.id === at.track);
  const region = track?.regions.find((r) => r.id === at.region);
  const clip = region?.audio;
  if (!track || !region || !clip) return { ops: [], changes: [] };
  const changes: LinkedChange[] = [];
  if (o.next !== o.base) changes.push({ track, region, was: o.base, now: o.next, kept: !!clip.notes });
  // the others, each with its notes as they stand (none: not found by the same detection, or not known yet)
  const others = linkedRegions(project, region.id).flatMap((x) => {
    const c = x.region.audio as AudioClip;
    const window = regionWindow(project, x.region, c);
    const notes = c.notes ?? (o.found ? pruneNotes(o.found, window) : null);
    if (!notes || notes.mode !== o.base.mode || notes.v !== o.base.v) return [];
    return [{ ...x, clip: c, window, was: notes, now: notes }];
  });
  let mine = o.base;
  for (const step of steps) {
    const edit = noteEdit(step.name);
    if (!edit) continue;
    // the note it copies from, as itself, so it's the same note in every region
    const from = step.args[edit.source ?? ''];
    const source = step.source ?? (edit.source && typeof from === 'number' ? mine.n[Math.round(from) - 1] : undefined);
    if (edit.source && !source) continue;
    const keys = new Set(step.indices.map((i) => mine.n[i]).flatMap((n) => (n ? [sameKey(mine, n)] : [])));
    for (const x of others) {
      const [lo, hi] = x.window;
      const plays = (n: AudioNote) => n.t < hi && n.t + n.d > lo;
      let idx: number[] = [];
      if (edit.selection) {
        idx = x.now.n.flatMap((n, i) => (keys.has(sameKey(x.now, n)) && plays(n) ? [i] : []));
        if (!idx.length) continue;
      } else {
        // a note added is added where the region plays it
        const start = Number(step.args.start);
        const length = Number(step.args.length);
        if (!(start < hi && start + length > lo)) continue;
      }
      x.now = edit.apply(x.now, idx, step.args, contextIn(project, x.region, x.clip, x.now, o, source));
    }
    mine = edit.apply(mine, step.indices, step.args, contextIn(project, region, clip, mine, o, source));
  }
  for (const x of others)
    if (x.now !== x.was)
      changes.push({ track: x.track, region: x.region, was: x.was, now: x.now, kept: !!x.clip.notes });
  const ops: Op[] = changes.map((c) => ({
    op: 'updateRegion',
    track: c.track.id,
    region: c.region.id,
    patch: { audio: { ...(c.region.audio as AudioClip), notes: c.now } },
  }));
  return { ops, changes };
}
