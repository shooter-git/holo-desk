/**
 * The arithmetic of a region's edges: trimming, stretching and fading an audio region (where its
 * recording lies on the timeline, how its offset and stretch follow), and splitting any region in
 * two. The studio's tracks area and Audio Editor, the agent's tools and the `splitRegion` operation
 * share it, so a trim or a split comes out the same wherever it's made.
 */
import { pruneNotes } from './audio-notes-edit.ts';
import { secondsToTick, tickToSeconds } from './time.ts';
import type { AudioClip, CCPoint, Mark, Project, Region } from './types.ts';

const seconds = (project: Project, from: number, to: number) =>
  tickToSeconds(project.tempo, to) - tickToSeconds(project.tempo, from);

/** Where the whole recording lies on the timeline (for showing what a trim has hidden). */
export function fileSpan(project: Project, region: Pick<Region, 'start'>, clip: AudioClip): [number, number] {
  const file = project.files?.find((f) => f.id === clip.file);
  const s0 = tickToSeconds(project.tempo, region.start);
  const start = secondsToTick(project.tempo, Math.max(0, s0 - clip.offset * clip.stretch));
  const end = file
    ? secondsToTick(project.tempo, s0 + (file.seconds - clip.offset) * clip.stretch)
    : Number.POSITIVE_INFINITY;
  return [start, end];
}

/** The region's end moved: longer or shorter (never past the recording), or time-stretched. */
export function trimEnd(
  project: Project,
  region: Region,
  clip: AudioClip,
  length: number,
  stretch: boolean,
): { length: number; audio: AudioClip } {
  if (stretch) {
    const before = seconds(project, region.start, region.start + region.length);
    const ratio = seconds(project, region.start, region.start + Math.max(1, length)) / before;
    const s = Math.round(Math.max(0.25, Math.min(4, clip.stretch * ratio)) * 10000) / 10000;
    const sec = (before * s) / clip.stretch;
    const end = secondsToTick(project.tempo, tickToSeconds(project.tempo, region.start) + sec);
    return { length: Math.max(1, Math.round(end - region.start)), audio: { ...clip, stretch: s } };
  }
  const [, fileEnd] = fileSpan(project, region, clip);
  return { length: Math.max(1, Math.min(Math.round(length), Math.floor(fileEnd - region.start))), audio: clip };
}

/** The region's start moved: later, or earlier as far as the recording goes; the end stays. */
export function trimStart(
  project: Project,
  region: Region,
  clip: AudioClip,
  start: number,
): { start: number; length: number; audio: AudioClip } {
  const end = region.start + region.length;
  const [fileStart] = fileSpan(project, region, clip);
  const s = Math.round(Math.max(Math.ceil(fileStart), 0, Math.min(end - 1, start)));
  const offset = Math.max(0, clip.offset + seconds(project, region.start, s) / clip.stretch);
  return { start: s, length: end - s, audio: { ...clip, offset } };
}

/** A fade's corner dragged to a tick. */
export function fadeTo(
  project: Project,
  region: Region,
  clip: AudioClip,
  which: 'fadeIn' | 'fadeOut',
  tick: number,
): AudioClip {
  const total = seconds(project, region.start, region.start + region.length);
  const sec = seconds(project, region.start, tick);
  const ms = (v: number) => Math.round(v * 1000) / 1000;
  return which === 'fadeIn'
    ? { ...clip, fadeIn: ms(Math.max(0, Math.min(total - clip.fadeOut, sec))) }
    : { ...clip, fadeOut: ms(Math.max(0, Math.min(total - clip.fadeIn, total - sec))) };
}

/** A new stretch typed in: the start stays and the length follows. */
export function setStretch(project: Project, region: Region, clip: AudioClip, stretch: number): Region {
  const s = Math.round(Math.max(0.25, Math.min(4, stretch)) * 10000) / 10000;
  const sec = (seconds(project, region.start, region.start + region.length) * s) / clip.stretch;
  const end = secondsToTick(project.tempo, tickToSeconds(project.tempo, region.start) + sec);
  return { ...region, length: Math.max(1, Math.round(end - region.start)), audio: { ...clip, stretch: s } };
}

/**
 * A region cut in two at a tick of the song (inside it), as the studio's Split does: the left half
 * keeps the region's id, the right half takes `id`. Notes and controller points go to the half they
 * start in (a note keeps its length), score marks too (a line that runs past the cut stops there);
 * an audio region's right half plays on from where the cut fell in its recording, and neither half
 * fades at the cut. Its recording's notes go to each half that plays them (pruneNotes): a note across
 * the cut to both, as it is, so each half sounds as the region did.
 */
export function splitRegionAt(project: Project, region: Region, at: number, id: string): [Region, Region] {
  const cut = at - region.start;
  const lanes = (keep: (p: CCPoint) => boolean, shift: number) =>
    Object.fromEntries(
      Object.entries(region.cc).map(([k, v]) => [k, v.filter(keep).map(([t, y]): CCPoint => [t - shift, y])]),
    );
  const left: Region = {
    ...region,
    length: cut,
    notes: region.notes.filter((n) => n.t < cut),
    cc: lanes((x) => x[0] < cut, 0),
  };
  const right: Region = {
    ...region,
    id,
    start: at,
    length: region.length - cut,
    notes: region.notes.filter((n) => n.t >= cut).map((n) => ({ ...n, t: n.t - cut })),
    cc: lanes((x) => x[0] >= cut, cut),
  };
  if (region.marks) {
    const before = region.marks
      .filter((m) => m.t < cut)
      .map((m): Mark => (m.e !== undefined && m.e > cut ? { ...m, e: cut } : m));
    const after = region.marks
      .filter((m) => m.t >= cut)
      .map((m): Mark => ({ ...m, t: m.t - cut, ...(m.e !== undefined ? { e: m.e - cut } : {}) }));
    if (before.length) left.marks = before;
    else delete left.marks;
    if (after.length) right.marks = after;
    else delete right.marks;
  }
  if (region.audio) {
    // the right half plays on from where the cut fell in the recording
    const a = region.audio;
    const cutAt = a.offset + seconds(project, region.start, at) / a.stretch;
    left.audio = { ...a, fadeOut: 0 };
    right.audio = { ...a, fadeIn: 0, offset: cutAt };
    if (a.notes) {
      const end = a.offset + seconds(project, region.start, region.start + region.length) / a.stretch;
      left.audio.notes = pruneNotes(a.notes, [a.offset, cutAt]);
      right.audio.notes = pruneNotes(a.notes, [cutAt, end]);
    }
  }
  return [left, right];
}

/**
 * A MIDI region's start moved to a tick (later, or earlier), its end staying: its notes, controller
 * points and marks stay where they are in the song. Notes before the new start are left out, and each
 * controller lane starts from the value it had there.
 */
export function trimMidiStart(region: Region, start: number): Region {
  const end = region.start + region.length;
  const s = Math.round(Math.min(end - 1, start));
  const shift = s - region.start;
  const next: Region = {
    ...region,
    start: s,
    length: end - s,
    notes: region.notes.filter((n) => n.t >= shift).map((n) => ({ ...n, t: n.t - shift })),
    cc: Object.fromEntries(
      Object.entries(region.cc).map(([k, pts]) => {
        const out: CCPoint[] = [];
        let held: CCPoint | undefined;
        for (const p of pts) {
          if (p[0] < shift) held = p;
          else out.push([p[0] - shift, p[1]]);
        }
        if (held && !(out[0] && out[0][0] === 0)) out.unshift([0, held[1]]);
        return [k, out];
      }),
    ),
  };
  if (region.marks) {
    const marks = region.marks
      .filter((m) => m.t >= shift)
      .map((m): Mark => ({ ...m, t: m.t - shift, ...(m.e !== undefined ? { e: m.e - shift } : {}) }));
    if (marks.length) next.marks = marks;
    else delete next.marks;
  }
  return next;
}

/**
 * A MIDI region stretched in time by `ratio` from its start: its length, its notes' times and
 * lengths, its controller points and its marks (2 plays it at half speed, twice as long).
 */
export function stretchMidi(region: Region, ratio: number): Region {
  const at = (t: number) => Math.round(t * ratio);
  const next: Region = {
    ...region,
    length: Math.max(1, at(region.length)),
    notes: region.notes.map((n) => ({ ...n, t: at(n.t), d: Math.max(1, at(n.d)) })),
    cc: Object.fromEntries(Object.entries(region.cc).map(([k, pts]) => [k, pts.map(([t, v]): CCPoint => [at(t), v])])),
  };
  if (region.marks)
    next.marks = region.marks.map((m) => ({ ...m, t: at(m.t), ...(m.e !== undefined ? { e: at(m.e) } : {}) }));
  return next;
}
