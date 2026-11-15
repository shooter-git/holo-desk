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
 * island it warps (audio-notes.ts). Where the voice may go on past what changes (past a pasted note,
 * past an island that ends at a note's edge rather than in a rest), it reaches 180 ms further, for the
 * renderer to settle back onto the recording. Stretches closer than 40 ms are one patch.
 *
 * The renderer reads the notes within 200 ms of a patch (its `notes`), and where notes move in time, as
 * many more either side as it takes for the warp those notes make alone to be the region's all through
 * the patch and its context (the notes past a long rest place its middle, which doesn't move). It reads
 * the recording from 200 ms before the patch to 200 ms after, and 200 ms either side of where a pasted
 * note's sound comes from (`ctx`, one stretch from the first of those frames to the last).
 */
import {
  type AudioClip,
  type AudioNote,
  type AudioNotes,
  movesInTime,
  type Project,
  tickToSeconds,
  unwarpAt,
  type Warp,
  warpAt,
  warpOf,
} from '@holo/session';
import { clipKey } from '../compile.ts';
import { sha256 } from '../random.ts';

/** The renderer's version: a change to what any edit sounds like changes it, so every patch is rendered again. */
export const RENDER_V = 5;
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
  /** The notes within 200 ms of it, as kept (and those further out its warp needs). */
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

const pasted = (n: AudioNote) => n.s !== undefined && n.s !== n.t;

/**
 * A note's edited stretch, seconds of the file as the region plays it (after the warp, before the
 * stretch). Where the sound it changes may be voiced on past it (the glides of a pitch moved, a pasted
 * note's end, an island that ends at a note's edge), it reaches far enough past for the marks to settle
 * back onto the recording's.
 */
function spanOf(n: AudioNote, notes: AudioNotes, w: Warp): [number, number] {
  let lo = Math.min(n.t, n.ts ?? n.t) - PAD_S;
  let hi = Math.max(n.t + n.d, n.te ?? n.t + n.d) + PAD_S;
  if (pitchEdited(n)) {
    lo -= GLIDE_S;
    hi += GLIDE_S;
  }
  if (pasted(n)) hi += GLIDE_S;
  if (movesInTime(n) && notes.mode === 'mono') {
    // the island it warps: out to the places either side that don't move
    let left = Number.NEGATIVE_INFINITY;
    let right = Number.POSITIVE_INFINITY;
    let voiced = false;
    // (a note's end anchor is its end rounded as kept: 1.6 + 0.3 reads 1.9000000000000001)
    for (let i = 0; i < w.src.length; i++) {
      const s = w.src[i] as number;
      if (s !== w.out[i]) continue;
      if (s <= n.t + 1e-9) left = Math.max(left, s);
      if (s >= n.t + n.d - 1e-9 && s < right) {
        right = s;
        voiced = (w.of[i] as number) >= 0;
      }
    }
    if (Number.isFinite(left)) lo = Math.min(lo, left - PAD_S);
    if (Number.isFinite(right)) hi = Math.max(hi, right + PAD_S + (voiced ? GLIDE_S : 0));
  }
  return [Math.max(0, lo), hi];
}

/**
 * Where two warps first differ from `x0` to `x1` (seconds, as recorded or as played: each one's anchors
 * there, both ways), or NaN where they don't.
 */
function warpsDiffer(w: Warp, v: Warp, x0: number, x1: number): number {
  const at = [x0, x1];
  for (const u of [w, v]) for (const x of [...u.src, ...u.out]) if (x > x0 && x < x1) at.push(x);
  at.sort((p, q) => p - q);
  for (const x of at)
    if (Math.abs(warpAt(w, x) - warpAt(v, x)) > 1e-9 || Math.abs(unwarpAt(w, x) - unwarpAt(v, x)) > 1e-9) return x;
  return Number.NaN;
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
  const warp = warpOf(notes);
  const spans = notes.n
    .filter(isEdited)
    .map((n) => spanOf(n, notes, warp))
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
    const near = nearNotes(notes, warp, lo - CONTEXT_S, hi + CONTEXT_S);
    // (and the sound pasted notes play, wherever it is)
    let c0 = Math.max(0, Math.floor((lo - CONTEXT_S) * scale));
    let c1 = Math.ceil((hi + CONTEXT_S) * scale);
    for (const n of near)
      if (pasted(n)) {
        c0 = Math.min(c0, Math.max(0, Math.floor(((n.s as number) - CONTEXT_S) * scale)));
        c1 = Math.max(c1, Math.ceil(((n.s as number) + n.d + CONTEXT_S) * scale));
      }
    const spec: PatchSpec = {
      a,
      b,
      ctx: [c0, c1],
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
 * The notes a patch is rendered with: those within 200 ms of it (`x0` to `x1`, seconds), and where some
 * move in time, as many more either side as it takes for the warp they make alone to be the region's
 * there (a note moved from further away, the rest before the first of them).
 */
function nearNotes(notes: AudioNotes, warp: Warp, x0: number, x1: number): AudioNote[] {
  const all = notes.n;
  if (notes.mode !== 'mono' || !warp.src.length) return all.filter((n) => n.t < x1 && n.t + n.d > x0);
  let i0 = all.findIndex((n) => n.t + n.d > x0);
  if (i0 < 0) i0 = all.length;
  let i1 = i0 - 1;
  while (i1 + 1 < all.length && (all[i1 + 1] as AudioNote).t < x1) i1++;
  for (;;) {
    const bad = i1 >= i0 ? warpsDiffer(warpOf(all.slice(i0, i1 + 1)), warp, x0, x1) : x0;
    if (Number.isNaN(bad)) break;
    // widened on the side it differs (the notes' middle splits them), else on whichever side is left
    const first = all[i0];
    const last = all[i1];
    const mid = first && last ? (first.t + last.t + last.d) / 2 : bad;
    if (bad < mid && i0 > 0) i0--;
    else if (i1 + 1 < all.length) i1++;
    else if (i0 > 0) i0--;
    else break;
  }
  return all.slice(i0, i1 + 1);
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
