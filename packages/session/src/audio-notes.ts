/**
 * A recording's notes as a region plays them (`AudioClip.notes`, types.ts): how they're read and kept
 * canonical, and the time warp their moves make.
 *
 * **Canonical.** Every number is rounded as it's made (times to 0.1 ms, pitches to 0.1 cent, amounts
 * to hundredths) and clamped to its range, so a song saved and read back is the same to the bit. What
 * a region's edits render is keyed by them, so a reload that changed a digit would render it all
 * again. `parseAudioNotes` is lenient: a note it can't read is left out, never the song.
 *
 * **The warp.** A note moved or stretched in time (`ts`, `te`, `at`) moves the sound under it: the
 * warp maps a time in the file as recorded to where it now plays (seconds of the file, before the
 * region's stretch). It's piecewise linear and only ever increases, and it's the identity outside
 * "islands": an island runs between two places that don't move (a rest between notes, an unmoved
 * note's edges, half a second past the outermost notes), so it maps that stretch onto itself and no
 * sample outside an edited island moves. A note's unvoiced start keeps its length (the vowel
 * stretches, not the "s"). A move that would run time backwards, or squeeze or stretch any part of the
 * sound past four times, is let go (that note's time edits are dropped), as is one more than 4 s away.
 * Only a line's notes (`mono`) move in time; the notes of chords don't (yet).
 */
import type { AudioNote, AudioNotes, AudioNotesMode } from './types.ts';

/** At most this many notes in a region. */
export const MAX_AUDIO_NOTES = 20_000;
export const AUDIO_NOTES_MODES: readonly AudioNotesMode[] = ['mono', 'poly', 'perc'];
/** The shortest note, seconds. */
export const MIN_NOTE_S = 0.01;
/** How far a note may move in time, seconds. */
export const MAX_MOVE_S = 4;
/** How far a part of the sound may be squeezed or stretched by the warp, either way. */
export const MAX_WARP = 4;
/** An attack is the first this many seconds of a note's voice (a third of a short note). */
export const ATTACK_S = 0.06;
/** The places that don't move past the outermost notes, seconds before the first and after the last. */
export const WARP_EDGE_S = 4.5;
/** A rest at least this long between two notes has a place that doesn't move at its middle. */
export const WARP_REST_S = 0.02;

/** Seconds, to 0.1 ms. */
export const roundTime = (s: number): number => Math.round(s * 1e4) / 1e4;
/** A pitch (MIDI with cents), to 0.1 cent. */
export const roundPitch = (p: number): number => Math.round(p * 1e3) / 1e3;
/** An amount or a level, to hundredths. */
export const roundAmount = (x: number): number => Math.round(x * 100) / 100;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const finite = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** An edit that's a number in a range, rounded: kept when it's there and a number, else left out. */
function amount(v: unknown, lo: number, hi: number, round: (x: number) => number): number | undefined {
  return finite(v) ? round(clamp(v, lo, hi)) : undefined;
}

/** One note as read: null when its start, length or pitch can't be read. */
function readNote(v: unknown, mode: AudioNotesMode): AudioNote | null {
  if (!isObj(v) || !finite(v.t) || !finite(v.d)) return null;
  if (v.p !== null && !finite(v.p)) return null;
  const t = roundTime(Math.max(0, v.t));
  const d = roundTime(Math.max(MIN_NOTE_S, v.d));
  const p = v.p === null ? null : roundPitch(clamp(v.p, 0, 127));
  const n: AudioNote = { t, d, p };
  const u = amount(v.u, 0, d, roundTime);
  if (u) n.u = u;
  if (p !== null) {
    const to = amount(v.to, 0, 127, roundPitch);
    if (to !== undefined) n.to = to;
    const dr = amount(v.dr, 0, 1, roundAmount);
    if (dr !== undefined) n.dr = dr;
    const mo = amount(v.mo, 0, 2, roundAmount);
    if (mo !== undefined) n.mo = mo;
    const fo = amount(v.fo, -12, 12, roundAmount);
    if (fo !== undefined) n.fo = fo;
    if (mode === 'mono') {
      const tr = amount(v.tr, 0, 3, roundAmount);
      if (tr !== undefined) n.tr = tr;
    }
  }
  const g = amount(v.g, -60, 24, roundAmount);
  if (g !== undefined) n.g = g;
  if (v.m === true) n.m = true;
  if (mode === 'mono') {
    // (the warp, below, lets go of moves that don't fit)
    const ts = amount(v.ts, Math.max(0, t - MAX_MOVE_S), t + MAX_MOVE_S, roundTime);
    if (ts !== undefined) n.ts = ts;
    const te = amount(v.te, Math.max(0, t + d - MAX_MOVE_S), t + d + MAX_MOVE_S, roundTime);
    if (te !== undefined) n.te = te;
    const at = amount(v.at, 1 / MAX_WARP, MAX_WARP, roundAmount);
    if (at !== undefined) n.at = at;
    const s = amount(v.s, 0, Number.MAX_SAFE_INTEGER, roundTime);
    if (s !== undefined) n.s = s;
  }
  if (mode === 'poly' && v.off === true) n.off = true;
  return n;
}

/** By start, then pitch (no pitch last). */
function byStart(a: AudioNote, b: AudioNote): number {
  return a.t - b.t || (a.p ?? Number.POSITIVE_INFINITY) - (b.p ?? Number.POSITIVE_INFINITY);
}

/**
 * A region's notes as read from a song: canonical (rounded, clamped, sorted; a line's notes don't
 * overlap, and its moves fit the warp), or undefined when there's nothing that can be read as notes.
 */
export function parseAudioNotes(v: unknown): AudioNotes | undefined {
  if (!isObj(v) || !AUDIO_NOTES_MODES.includes(v.mode as AudioNotesMode) || !Array.isArray(v.n)) return undefined;
  const mode = v.mode as AudioNotesMode;
  let notes = v.n.map((n) => readNote(n, mode)).filter((n): n is AudioNote => n !== null);
  notes.sort(byStart);
  if (mode === 'mono') notes = apart(notes);
  if (notes.length > MAX_AUDIO_NOTES) notes = notes.slice(0, MAX_AUDIO_NOTES);
  if (mode === 'mono') notes = fitWarp(notes);
  const out: AudioNotes = { mode, v: finite(v.v) ? Math.max(0, Math.round(v.v)) : 1, n: notes };
  if (v.off === true) out.off = true;
  const a4 = amount(v.a4, 400, 480, roundAmount);
  if (a4 !== undefined && a4 !== 440) out.a4 = a4;
  const sens = amount(v.sens, 0, 1, roundAmount);
  if (sens !== undefined) out.sens = sens;
  return out;
}

/** A line's notes one after another: each ends where the next starts at the latest (one that starts on another's start goes). */
function apart(notes: AudioNote[]): AudioNote[] {
  const out: AudioNote[] = [];
  for (const n of notes) {
    const last = out[out.length - 1];
    if (last) {
      if (n.t - last.t < MIN_NOTE_S) continue;
      if (last.t + last.d > n.t) out[out.length - 1] = shorten(last, roundTime(n.t - last.t));
    }
    out.push(n);
  }
  return out;
}

/** A note made shorter: its unvoiced start and its end where it moved stay within it. */
function shorten(n: AudioNote, d: number): AudioNote {
  const out: AudioNote = { ...n, d };
  if (out.u !== undefined && out.u > d) out.u = d;
  if (out.te !== undefined) out.te = roundTime(clamp(out.te, Math.max(0, n.t + d - MAX_MOVE_S), n.t + d + MAX_MOVE_S));
  return out;
}

// ---- the warp ----

/** Where the sound moves: from `src` (as recorded) to `out` (as it plays), seconds of the file. */
export interface Warp {
  src: number[];
  out: number[];
  /** Each anchor's note (its index), or −1 for a place that doesn't move by itself (a rest, an edge). */
  of: number[];
}

/** Whether a note moves the sound in time. */
export const movesInTime = (n: AudioNote): boolean => n.ts !== undefined || n.te !== undefined || n.at !== undefined;

/** A note's anchors: its start, its voice's start, its attack's end, its end; each as recorded and as it plays. */
function anchorsOf(n: AudioNote): [number, number][] {
  const end = n.t + n.d;
  if (!movesInTime(n))
    return [
      [n.t, n.t],
      [end, end],
    ];
  const ts = n.ts ?? n.t;
  const te = n.te ?? end;
  const out: [number, number][] = [[n.t, ts]];
  const u = n.u ?? 0;
  if (u > 0 && u < n.d) out.push([n.t + u, ts + u]);
  if (n.at !== undefined) {
    const a = Math.min(ATTACK_S, n.d / 3);
    if (u + a < n.d - 0.001) out.push([n.t + u + a, ts + u + a * n.at]);
  }
  out.push([end, te]);
  return out;
}

/** The warp a list of notes makes (notes by start; a line's notes only: chords' notes don't move in time). */
export function warpOf(notes: AudioNotes | readonly AudioNote[]): Warp {
  const list = Array.isArray(notes) ? (notes as readonly AudioNote[]) : (notes as AudioNotes).n;
  if (!Array.isArray(notes) && (notes as AudioNotes).mode !== 'mono') return { src: [], out: [], of: [] };
  return build(list);
}

function build(notes: readonly AudioNote[]): Warp {
  const w: Warp = { src: [], out: [], of: [] };
  if (!notes.some(movesInTime)) return w;
  const add = (src: number, out: number, of: number) => {
    w.src.push(src);
    w.out.push(out);
    w.of.push(of);
  };
  const first = notes[0] as AudioNote;
  const last = notes[notes.length - 1] as AudioNote;
  const lo = Math.max(0, first.t - WARP_EDGE_S);
  if (lo < first.t) add(lo, lo, -1);
  notes.forEach((n, i) => {
    for (const [src, out] of anchorsOf(n)) add(src, out, i);
    const next = notes[i + 1];
    if (!next) return;
    // a rest long enough for a place that doesn't move at its middle (so islands stay short)
    const from = Math.max(n.t + n.d, n.te ?? n.t + n.d);
    const to = Math.min(next.t, next.ts ?? next.t);
    if (to - from >= WARP_REST_S) {
      const mid = (from + to) / 2;
      add(mid, mid, -1);
    }
  });
  const hi = last.t + last.d + WARP_EDGE_S;
  add(hi, hi, -1);
  return w;
}

/** The first piece of a warp that runs backwards or squeezes or stretches past MAX_WARP: the index of its later anchor, or −1. */
export function warpProblem(w: Warp): number {
  for (let i = 1; i < w.src.length; i++) {
    const ds = (w.src[i] as number) - (w.src[i - 1] as number);
    const dout = (w.out[i] as number) - (w.out[i - 1] as number);
    if (ds <= 0 || dout <= 0) return i;
    const slope = dout / ds;
    if (slope < 1 / MAX_WARP - 1e-9 || slope > MAX_WARP + 1e-9) return i;
  }
  return -1;
}

/** A line's notes with the moves that don't fit the warp let go, one at a time from the first that doesn't. */
function fitWarp(notes: AudioNote[]): AudioNote[] {
  let list = notes;
  for (let guard = 0; guard <= list.length; guard++) {
    const w = build(list);
    const bad = warpProblem(w);
    if (bad < 0) return list;
    // the note to blame: the later anchor's when it moves, else the earlier one's
    const later = w.of[bad] as number;
    const earlier = w.of[bad - 1] as number;
    const blame = later >= 0 && movesInTime(list[later] as AudioNote) ? later : earlier;
    if (blame < 0) return list;
    const { ts: _ts, te: _te, at: _at, ...kept } = list[blame] as AudioNote;
    list = list.slice();
    list[blame] = kept;
  }
  return list;
}

/** Where a time in the file as recorded now plays (seconds of the file, before the region's stretch). */
export function warpAt(w: Warp, x: number): number {
  return through(w.src, w.out, x);
}

/** What time in the file as recorded plays at a time as it now plays: the warp's inverse. */
export function unwarpAt(w: Warp, y: number): number {
  return through(w.out, w.src, y);
}

function through(from: readonly number[], to: readonly number[], x: number): number {
  const n = from.length;
  if (n < 2 || x <= (from[0] as number) || x >= (from[n - 1] as number)) return x;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((from[mid] as number) <= x) lo = mid;
    else hi = mid;
  }
  const f0 = from[lo] as number;
  const f1 = from[hi] as number;
  const t0 = to[lo] as number;
  const t1 = to[hi] as number;
  return t0 + ((x - f0) * (t1 - t0)) / (f1 - f0);
}
