/**
 * Which stretches of a region's recording its note edits change, and the key each plays by
 * (`AudioClip.notes`, audio-notes.ts in the session).
 *
 * A region's edits never render its whole recording again. Each stretch they change is a **patch**: a
 * piece of the recording as the region plays it (the file at the engine's rate, stretched), from frame
 * `a` to `b`, rendered from that recording and the notes around it, and played in place of those frames
 * (compileClips). Everything else plays the recording itself, to the bit.
 *
 * A patch's key is `${clipKey}#hash`, the hash of everything its sound depends on: the renderer's
 * version, the rate, the stretch, its frames and the notes around it. So the same edits in several
 * regions of one recording render once, an edit renders only the patch it's in, and a patch rendered
 * once is found again (by undo, say) under the same key.
 *
 * A stretch is an edited note's sound and 30 ms either side of it; a note whose pitch changes takes
 * the glide into it and out of it too (up to 180 ms either side), and one moved in time the whole
 * island it warps (audio-notes.ts). Stretches closer than 40 ms are one patch. The renderer reads the
 * notes within 200 ms of a patch (its `notes`), and the recording from 200 ms before it to 200 ms
 * after (`ctx`).
 */
import {
  type AudioClip,
  type AudioNote,
  type AudioNotes,
  movesInTime,
  type Project,
  tickToSeconds,
  warpOf,
} from '@holo/session';
import { clipKey } from '../compile.ts';
import { sha256 } from '../random.ts';

/** The renderer's version: a change to what any edit sounds like changes it, so every patch is rendered again. */
export const RENDER_V = 2;
/** Around an edited note's sound, seconds. */
const PAD_S = 0.03;
/** The most a glide into or out of a note reaches past it, seconds. */
const GLIDE_S = 0.18;
/** Stretches closer than this are one patch, seconds. */
const JOIN_S = 0.04;
/** The notes and the sound the renderer reads past a patch's edges, seconds. */
const CONTEXT_S = 0.2;

/** What a patch is rendered from: its frames in the recording as the region plays it, and the notes around it. */
export interface PatchSpec {
  /** Its first frame and the frame after its last, in the recording at the engine's rate, stretched. */
  a: number;
  b: number;
  /** The frames the renderer may read around it. */
  ctx: [number, number];
  /** Frames a second, and the region's stretch (a note's seconds × stretch × rate is its frame). */
  sr: number;
  stretch: number;
  mode: AudioNotes['mode'];
  v: number;
  /** The notes within 200 ms of it, as kept. */
  notes: AudioNote[];
}

/** A patch to render: its key, the recording it's a part of, and what it's rendered from. */
export interface PatchJob {
  key: string;
  base: Pick<AudioClip, 'file' | 'stretch'>;
  spec: PatchSpec;
}

const changed = (v: number | undefined, neutral: number) => v !== undefined && v !== neutral;

/** Whether a note's pitch, or the glide into it, sounds different. */
function pitchEdited(n: AudioNote): boolean {
  return (n.p !== null && changed(n.to, n.p)) || changed(n.dr, 1) || changed(n.mo, 1) || changed(n.tr, 1);
}

/** Whether a note sounds different from the recording at all. */
export function isEdited(n: AudioNote): boolean {
  return (
    pitchEdited(n) ||
    changed(n.fo, 0) ||
    changed(n.g, 0) ||
    n.m === true ||
    (n.s !== undefined && n.s !== n.t) ||
    movesInTime(n)
  );
}

/** A note's edited stretch, seconds of the file as the region plays it (after the warp, before the stretch). */
function spanOf(n: AudioNote, notes: AudioNotes): [number, number] {
  let lo = Math.min(n.t, n.ts ?? n.t) - PAD_S;
  let hi = Math.max(n.t + n.d, n.te ?? n.t + n.d) + PAD_S;
  if (pitchEdited(n)) {
    lo -= GLIDE_S;
    hi += GLIDE_S;
  }
  if (movesInTime(n) && notes.mode === 'mono') {
    // the island it warps: out to the places either side that don't move
    const w = warpOf(notes);
    let left = Number.NEGATIVE_INFINITY;
    let right = Number.POSITIVE_INFINITY;
    for (let i = 0; i < w.src.length; i++) {
      const s = w.src[i] as number;
      if (s !== w.out[i]) continue;
      if (s <= n.t) left = Math.max(left, s);
      if (s >= n.t + n.d) right = Math.min(right, s);
    }
    if (Number.isFinite(left)) lo = Math.min(lo, left - PAD_S);
    if (Number.isFinite(right)) hi = Math.max(hi, right + PAD_S);
  }
  return [Math.max(0, lo), hi];
}

/** A note as the hash reads it: its fields in a fixed order (however its object was made). */
const FIELDS = ['t', 'd', 'p', 'u', 'to', 'dr', 'mo', 'tr', 'fo', 'g', 'm', 'ts', 'te', 'at', 's', 'off'] as const;
const flat = (n: AudioNote) => FIELDS.map((f) => n[f] ?? null);

function hex(bytes: Uint8Array, count: number): string {
  let out = '';
  for (let i = 0; i < count; i++) out += (bytes[i] as number).toString(16).padStart(2, '0');
  return out;
}

const plans = new WeakMap<AudioNotes, Map<string, PatchJob[]>>();

/**
 * A region's patches: the stretches its edits change, by start (none when its notes are off or none is
 * edited). The same notes, stretch and rate give the same patches, under the same keys.
 */
export function regionPatches(clip: AudioClip, sr: number): PatchJob[] {
  const notes = clip.notes;
  if (!notes || notes.off) return [];
  const memo = `${clip.file}|${clip.stretch}|${sr}`;
  let kept = plans.get(notes);
  const found = kept?.get(memo);
  if (found) return found;
  const spans = notes.n
    .filter(isEdited)
    .map((n) => spanOf(n, notes))
    .sort((x, y) => x[0] - y[0]);
  const joined: [number, number][] = [];
  for (const s of spans) {
    const last = joined[joined.length - 1];
    if (last && s[0] - last[1] < JOIN_S) last[1] = Math.max(last[1], s[1]);
    else joined.push([s[0], s[1]]);
  }
  const base = { file: clip.file, stretch: clip.stretch };
  const scale = clip.stretch * sr;
  const jobs = joined.map(([lo, hi]): PatchJob => {
    const a = Math.max(0, Math.floor(lo * scale));
    const b = Math.ceil(hi * scale);
    const near = notes.n.filter((n) => n.t < hi + CONTEXT_S && n.t + n.d > lo - CONTEXT_S);
    const spec: PatchSpec = {
      a,
      b,
      ctx: [Math.max(0, Math.floor((lo - CONTEXT_S) * scale)), Math.ceil((hi + CONTEXT_S) * scale)],
      sr,
      stretch: clip.stretch,
      mode: notes.mode,
      v: notes.v,
      notes: near,
    };
    const identity = JSON.stringify([RENDER_V, sr, notes.mode, notes.v, clip.stretch, a, b, near.map(flat)]);
    return { key: `${clipKey(base)}#${hex(sha256(new TextEncoder().encode(identity)), 8)}`, base, spec };
  });
  if (!kept) {
    kept = new Map();
    plans.set(notes, kept);
  }
  kept.set(memo, jobs);
  return jobs;
}

/**
 * Every patch a song plays, one per key: those of each region, within the stretch of its recording it
 * plays (and 200 ms past it), muted regions left out.
 */
export function songPatches(project: Project, sr: number): PatchJob[] {
  const out = new Map<string, PatchJob>();
  for (const t of project.tracks) {
    if (t.kind !== 'audio') continue;
    for (const r of t.regions) {
      const a = r.audio;
      if (!a?.notes || r.muted) continue;
      const seconds = tickToSeconds(project.tempo, r.start + r.length) - tickToSeconds(project.tempo, r.start);
      const from = a.offset - CONTEXT_S;
      const to = a.offset + seconds / a.stretch + CONTEXT_S;
      const scale = a.stretch * sr;
      for (const job of regionPatches(a, sr))
        if (job.spec.b > from * scale && job.spec.a < to * scale) out.set(job.key, job);
    }
  }
  return [...out.values()];
}
