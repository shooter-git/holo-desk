/**
 * A note heard as it's pressed in the Notes view: the stretch of its recording it plays, as edited,
 * from just before it starts (its onset, its consonant) to its end, laid out as the clips the engines
 * play for an audition (the core's `audition` message). Its pieces are the region's own, cut as a song
 * plays them: the recording where nothing is edited or a patch isn't rendered yet, the patch where one is.
 */
import { type ClipSpec, compileClips, type PatchJob, regionPatches, type TempoSegment } from '@holo/engine';
import { type AudioClip, type AudioNotes, type Region, type Track, warpAt, warpOf } from '@holo/session';

/** How long before a note's start its audition starts, seconds. */
export const AUDITION_LEAD_S = 0.03;
/**
 * An audition's own fades, seconds: in at its start, out at the note's end. Its start is often in the
 * middle of a sound (the note before, sung through): faded in over a few ms, that's a click; over 10,
 * it isn't, and it's done well before the note itself starts.
 */
const FADE_IN_S = 0.01;
const FADE_OUT_S = 0.01;

/**
 * The stretch of its recording a note plays, in seconds of the file as the region plays it (past its
 * notes' moves, before its stretch): from AUDITION_LEAD_S before it starts to its end. A note moved or
 * stretched in time plays from `ts` to `te`, and one in an island another's move warps, where the warp
 * takes it. Null when there's no such note.
 */
export function auditionRange(notes: AudioNotes, i: number): [number, number] | null {
  const n = notes.n[i];
  if (!n) return null;
  const w = notes.off || notes.mode !== 'mono' ? null : warpOf(notes);
  const at = (x: number) => (w?.src.length ? warpAt(w, x) : x);
  const from = at(n.t);
  const to = at(n.t + n.d);
  return [Math.max(0, from - AUDITION_LEAD_S), Math.max(from, to)];
}

/** Song frames as ticks, one for one: a region laid out in frames. */
const FRAMES: TempoSegment[] = [{ frame: 0, tick: 0, framesPerTick: 1 }];

/**
 * An audition's clips: the stretch `range` (auditionRange) of a region's recording as `clip` plays it,
 * from frame 0, cut where its patches start and end (those `ready`, the engines have; the recording
 * where they aren't yet), at the region's gain, with fades of a few ms at either end. compileClips lays
 * them out, as for the song, so a note sounds as the song plays it.
 */
export function auditionClips(
  track: Track,
  clip: AudioClip,
  range: readonly [number, number],
  sr: number,
  ready: (key: string) => boolean,
): ClipSpec[] {
  const frames = Math.round((range[1] - range[0]) * clip.stretch * sr);
  if (frames <= 0) return [];
  const region: Region = {
    id: 'audition',
    name: '',
    start: 0,
    length: frames,
    muted: false,
    notes: [],
    cc: {},
    audio: { ...clip, offset: range[0], fadeIn: FADE_IN_S, fadeOut: FADE_OUT_S },
  };
  return compileClips({ ...track, kind: 'audio', regions: [region] }, FRAMES, sr, ready);
}

/** The patches an audition of `range` plays (those of the region's that overlap it), first first. */
export function auditionPatches(clip: AudioClip, range: readonly [number, number], sr: number): PatchJob[] {
  const scale = clip.stretch * sr;
  const a = Math.max(0, Math.round(range[0] * scale));
  const b = a + Math.round((range[1] - range[0]) * scale);
  return regionPatches(clip, sr).filter((j) => j.spec.b > a && j.spec.a < b);
}
