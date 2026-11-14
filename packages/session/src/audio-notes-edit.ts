/**
 * Editing a recording's notes (`AudioClip.notes`, audio-notes.ts): what the Audio Editor's tools, the
 * agent's `audio_notes` and `holo notes` do to them (note-edits.ts lists each edit once for all
 * three), and how a region's notes follow it when it's split or healed.
 *
 * - **Never changed in place.** Each edit returns new notes, sharing every note it didn't touch with
 *   the notes before it (so an undo step holds only what changed); the notes as they were (the same
 *   object) when it changes nothing.
 * - **Canonical.** What comes back is what a song keeps (`canonicalNotes`): it reads back the same to
 *   the bit, and no edit is left that changes nothing (a pitch moved back to where it was found, all of
 *   its vibrato kept, a level of 0 dB).
 * - **What applies where.** A note with no pitch (a breath) takes a level and mute only. The notes of
 *   chords (`poly`) take pitch, drift, vibrato, formant, level and mute, and don't move in time; only
 *   a line's notes (`mono`) glide, move and stretch in time, and join.
 * - **Moves that fit.** A move in time the warp can't take (time running backwards, part of the sound
 *   squeezed or stretched past four times, further than 4 s) is made as far as it fits, never let go.
 *   A legato line stays joined: where a moved note touches one that isn't moved, that note's edge
 *   follows (it stretches or squeezes), as a rest between notes would.
 * - **Indices** are a note's place in `notes.n`, from 0 (people count from 1: `selectNotes`).
 */
import {
  AUDIO_NOTE_FIELDS,
  canonicalNote,
  canonicalNotes,
  fileToTicks,
  isNoteEdited,
  MAX_MOVE_S,
  MAX_WARP,
  MIN_NOTE_S,
  movesInTime,
  type NotesPlacing,
  roundAmount,
  roundPitch,
  roundTime,
  sameNote,
  warpAt,
  warpOf,
  warpProblem,
} from './audio-notes.ts';
import { fifthsOf, keyAt, keysOf, keyText, keyTonic } from './keysig.ts';
import { type MiddleC, parseNoteName } from './notation.ts';
import { SCALES } from './plugins.ts';
import { barToTick, firstBar } from './time.ts';
import type { AudioNote, AudioNotes, AudioNotesMode, KeyMode, Project } from './types.ts';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));
const mod12 = (x: number) => ((x % 12) + 12) % 12;
const endOf = (n: AudioNote) => roundTime(n.t + n.d);
/** Where a note plays now: its start and end after its moves. */
const playedStart = (n: AudioNote) => n.ts ?? n.t;
const playedEnd = (n: AudioNote) => n.te ?? endOf(n);
/** Whether one note ends where the next starts (as found), to the 0.1 ms they're kept to. */
const touch = (a: AudioNote | undefined, b: AudioNote | undefined) => !!a && !!b && Math.abs(endOf(a) - b.t) < 5e-5;
/** Time steps: the 0.1 ms times are kept to, and the hundredths amounts are. */
const TIME_STEP = 1e4;
const AMOUNT_STEP = 100;

/** The notes indices name, each once, in order (those that aren't a note's left out). */
export function noteIndices(notes: AudioNotes, indices: readonly number[]): number[] {
  return [...new Set(indices)].filter((i) => Number.isInteger(i) && i >= 0 && i < notes.n.length).sort((a, b) => a - b);
}

/** A note changed: the note it was when the change comes to nothing (as a song keeps it). */
function settled(was: AudioNote, next: AudioNote, mode: AudioNotesMode): AudioNote {
  const k = canonicalNote(next, mode);
  return !k || sameNote(k, was) ? was : k;
}

/** A list of notes made the region's: a note that came to what it was is kept as that note. */
function commit(notes: AudioNotes, list: AudioNote[]): AudioNotes {
  if (list.length === notes.n.length)
    for (let i = 0; i < list.length; i++) {
      const was = notes.n[i] as AudioNote;
      if (list[i] !== was) list[i] = settled(was, list[i] as AudioNote, notes.mode);
    }
  return canonicalNotes(notes, list);
}

/** Each note the indices name changed by `edit`, the rest kept. */
function change(
  notes: AudioNotes,
  indices: readonly number[],
  edit: (n: AudioNote, i: number) => AudioNote,
): AudioNotes {
  let list: AudioNote[] | null = null;
  for (const i of noteIndices(notes, indices)) {
    const was = notes.n[i] as AudioNote;
    const now = settled(was, edit(was, i), notes.mode);
    if (now === was) continue;
    list ??= notes.n.slice();
    list[i] = now;
  }
  return list ? canonicalNotes(notes, list) : notes;
}

/** Whether a line's notes make a warp that works. */
const fits = (list: readonly AudioNote[]) => warpProblem(warpOf(list)) < 0;

/**
 * The furthest of `steps` steps (1 to `steps`) a change can go with its notes still making a warp
 * that works, found by halving: the notes it makes there, or null when not even one step fits.
 */
function furthest(steps: number, make: (k: number) => AudioNote[]): AudioNote[] | null {
  if (!(steps >= 1)) return null;
  const all = make(steps);
  if (fits(all)) return all;
  let lo = 0;
  let hi = steps;
  let best: AudioNote[] | null = null;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    const list = make(mid);
    if (fits(list)) {
      lo = mid;
      best = list;
    } else hi = mid;
  }
  return best;
}

// ---- pitch, glide, formant, level ----

/** Edits set on notes: each a value, or null (or false) to put it back as found. */
export interface NotePatch {
  /** The pitch it's moved to (MIDI with cents). */
  to?: number | null;
  /** How much of its drift is kept (0–1), and of its vibrato (0–2). */
  dr?: number | null;
  mo?: number | null;
  /** How long the glide into it takes, against as sung (0–3; a line's notes only). */
  tr?: number | null;
  /** Its formant moved, semitones (−12 to 12). */
  fo?: number | null;
  /** Its level, dB (−60 to 24), and muted. */
  g?: number | null;
  m?: boolean | null;
}

const PATCH_FIELDS = ['to', 'dr', 'mo', 'tr', 'fo', 'g', 'm'] as const;
const PITCHED = new Set<string>(['to', 'dr', 'mo', 'tr', 'fo']);

/**
 * Edits set on several notes at once, each kept within its range. A note with no pitch takes only its
 * level and mute; a chord's notes take no glide.
 */
export function editNotes(notes: AudioNotes, indices: readonly number[], patch: NotePatch): AudioNotes {
  return change(notes, indices, (n) => {
    const out: AudioNote = { ...n };
    const fields = out as unknown as Record<string, unknown>;
    for (const f of PATCH_FIELDS) {
      if (!(f in patch) || (n.p === null && PITCHED.has(f))) continue;
      const v = patch[f];
      if (v === null || v === undefined || v === false) delete fields[f];
      else fields[f] = v;
    }
    return out;
  });
}

/** How a pitch is snapped: not at all, to the nearest semitone, or to the nearest note of the key's scale. */
export type PitchSnap = 'free' | 'semitone' | 'scale';
export const PITCH_SNAPS: readonly PitchSnap[] = ['free', 'semitone', 'scale'];

/** A scale: its tonic (a pitch class, C 0 … B 11) and its steps above it; named as the key is ("A minor"). */
export interface Scale {
  tonic: number;
  steps: readonly number[];
  name: string;
}

/**
 * Where a pitch lands, snapped: as it is (to 0.1 cent), on the nearest semitone, or on the nearest
 * semitone of the scale (on the nearest semitone when there's no scale). Halfway between two goes the
 * way it `lean`s (up when it doesn't): a note dragged down lands on the lower.
 */
export function snapTarget(pitch: number, mode: PitchSnap, scale?: Scale | null, lean = 0): number {
  const p = clamp(pitch, 0, 127);
  if (mode === 'free') return roundPitch(p);
  const inScale = (k: number) => mode !== 'scale' || !scale || scale.steps.includes(mod12(k - scale.tonic));
  let best = Math.round(p);
  let gap = Number.POSITIVE_INFINITY;
  for (let k = Math.max(0, Math.floor(p) - 12); k <= Math.min(127, Math.ceil(p) + 12); k++) {
    if (!inScale(k)) continue;
    const g = Math.abs(k - p);
    if (g < gap - 1e-9 || (g <= gap + 1e-9 && lean >= 0)) {
      best = k;
      gap = g;
    }
  }
  return best;
}

/** Each key's mode as the scale it's played in (SCALES). */
const MODE_SCALES: Record<KeyMode, string> = {
  major: 'Major',
  minor: 'Natural minor',
  dorian: 'Dorian',
  phrygian: 'Phrygian',
  lydian: 'Lydian',
  mixolydian: 'Mixolydian',
  locrian: 'Locrian',
};

/** The scale of the song's key at a tick (its key signature there); null where it has none. */
export function scaleAt(project: Pick<Project, 'key' | 'keys'>, tick: number): Scale | null {
  const k = keyAt(keysOf(project), tick);
  if (!k) return null;
  const tonic = keyTonic(k);
  let alter = 0;
  for (const a of tonic.slice(1)) alter += a === '#' ? 1 : -1;
  const steps = SCALES.find((s) => s.name === MODE_SCALES[k.mode])?.steps ?? (SCALES[0] as { steps: number[] }).steps;
  return { tonic: mod12(fifthsOf(tonic.slice(0, 1), alter) * 7), steps, name: keyText(k) };
}

/** A scale for every note (by its index), or one for them all. */
export type NoteScales = Scale | null | ((i: number) => Scale | null);

/**
 * Notes' pitches moved by some semitones (with cents) from where they are now (moved or as found),
 * then snapped. A note with no pitch stays as it is.
 */
export function shiftNotes(
  notes: AudioNotes,
  indices: readonly number[],
  semitones: number,
  snap: PitchSnap = 'free',
  scale?: NoteScales,
): AudioNotes {
  if (!Number.isFinite(semitones)) return notes;
  const scaleOf = typeof scale === 'function' ? scale : () => scale ?? null;
  return change(notes, indices, (n, i) => {
    if (n.p === null) return n;
    const to = snapTarget((n.to ?? n.p) + semitones, snap, snap === 'scale' ? scaleOf(i) : null, Math.sign(semitones));
    return { ...n, to };
  });
}

/**
 * A note's pitch as found moved by octaves (detection heard it an octave off), with where it's moved
 * to: what it sounds like doesn't change. `semitones` is ±12 (or a number of octaves of them).
 */
export function fixOctave(notes: AudioNotes, i: number, semitones: number): AudioNotes {
  const by = Math.round(semitones / 12) * 12;
  const n = notes.n[i];
  if (!n || n.p === null || !by) return notes;
  const p = n.p + by;
  const to = n.to === undefined ? undefined : n.to + by;
  if (p < 0 || p > 127 || (to !== undefined && (to < 0 || to > 127))) return notes;
  return change(notes, [i], (x) => ({ ...x, p: roundPitch(p), ...(to === undefined ? {} : { to: roundPitch(to) }) }));
}

// ---- time ----

/** How far each of these notes may still move one way (`dir`), seconds: within MAX_MOVE_S of where it was found, and not before the file starts. */
function room(notes: AudioNotes, indices: readonly number[], dir: number): number {
  let most = Number.POSITIVE_INFINITY;
  for (const i of indices) {
    const n = notes.n[i] as AudioNote;
    const edges: [number, number][] = [
      [n.t, playedStart(n)],
      [endOf(n), playedEnd(n)],
    ];
    for (const [found, now] of edges)
      most = Math.min(most, dir > 0 ? found + MAX_MOVE_S - now : now - Math.max(0, found - MAX_MOVE_S));
  }
  return most;
}

/**
 * Notes moved in time by some seconds (later when it's more than 0), each its start and end; the
 * notes either side absorb it through the warp (a rest between, or a legato neighbour's edge). A move
 * that doesn't fit is made as far as it does. Only a line's notes move in time.
 */
export function moveNotes(notes: AudioNotes, indices: readonly number[], seconds: number): AudioNotes {
  if (notes.mode !== 'mono' || !Number.isFinite(seconds) || !seconds) return notes;
  const idx = noteIndices(notes, indices);
  if (!idx.length) return notes;
  const dir = Math.sign(seconds);
  const moved = new Set(idx);
  const steps = Math.floor(Math.min(Math.abs(seconds), room(notes, idx, dir)) * TIME_STEP + 1e-6);
  const list = furthest(steps, (k) => {
    const by = (dir * k) / TIME_STEP;
    const out = notes.n.slice();
    for (const i of idx) {
      const n = notes.n[i] as AudioNote;
      out[i] = { ...n, ts: roundTime(playedStart(n) + by), te: roundTime(playedEnd(n) + by) };
    }
    // a neighbour that touches a moved note, and isn't moved itself, follows it at that edge
    for (const i of idx) {
      const n = out[i] as AudioNote;
      if (!moved.has(i - 1) && touch(notes.n[i - 1], notes.n[i]))
        out[i - 1] = { ...(out[i - 1] as AudioNote), te: n.ts };
      if (!moved.has(i + 1) && touch(notes.n[i], notes.n[i + 1]))
        out[i + 1] = { ...(out[i + 1] as AudioNote), ts: n.te };
    }
    return out;
  });
  return list ? commit(notes, list) : notes;
}

/**
 * One edge of a note moved in time, to where it now plays (`toSeconds`: seconds of the file as the
 * region plays it, as `ts` and `te` are): the note stretches or squeezes, and a legato neighbour at
 * that edge follows. As far as the warp lets it, when it can't go all the way. A line's notes only.
 */
export function resizeNote(notes: AudioNotes, i: number, edge: 'start' | 'end', toSeconds: number): AudioNotes {
  const n = notes.n[i];
  if (notes.mode !== 'mono' || !n || !Number.isFinite(toSeconds)) return notes;
  const start = edge === 'start';
  const found = start ? n.t : endOf(n);
  const from = start ? playedStart(n) : playedEnd(n);
  const to = roundTime(clamp(toSeconds, Math.max(0, found - MAX_MOVE_S), found + MAX_MOVE_S));
  const dir = Math.sign(to - from);
  const steps = Math.round(Math.abs(to - from) * TIME_STEP);
  const list = furthest(steps, (k) => {
    const at = roundTime(from + (dir * k) / TIME_STEP);
    const out = notes.n.slice();
    out[i] = start ? { ...n, ts: at } : { ...n, te: at };
    const j = start ? i - 1 : i + 1;
    if (start ? touch(notes.n[j], n) : touch(n, notes.n[j]))
      out[j] = start ? { ...(out[j] as AudioNote), te: at } : { ...(out[j] as AudioNote), ts: at };
    return out;
  });
  return list ? commit(notes, list) : notes;
}

/**
 * Notes' attacks played faster or slower: `at` is an attack's length against as it was sung
 * (0.25–4; 0.5 plays it in half the time). As far toward it as the warp lets each. A line's notes only.
 */
export function setAttack(notes: AudioNotes, indices: readonly number[], at: number): AudioNotes {
  if (notes.mode !== 'mono' || !Number.isFinite(at)) return notes;
  const target = roundAmount(clamp(at, 1 / MAX_WARP, MAX_WARP));
  let out = notes;
  for (const i of noteIndices(notes, indices)) {
    const n = out.n[i] as AudioNote;
    const from = n.at ?? 1;
    const dir = Math.sign(target - from);
    const list = furthest(Math.round(Math.abs(target - from) * AMOUNT_STEP), (k) => {
      const l = out.n.slice();
      l[i] = { ...n, at: roundAmount(from + (dir * k) / AMOUNT_STEP) };
      return l;
    });
    if (list) out = commit(out, list);
  }
  return out;
}

// ---- splitting and joining ----

/**
 * A note cut in two at a time in it (seconds of the file as recorded), each half 10 ms long at least:
 * both keep its pitch and edits, the first its unvoiced start, its glide and its attack. The halves
 * touch; a note moved in time is cut where the cut now plays, so it sounds as it did.
 */
export function splitNote(notes: AudioNotes, i: number, atSeconds: number): AudioNotes {
  const n = notes.n[i];
  if (!n || !Number.isFinite(atSeconds)) return notes;
  const at = roundTime(atSeconds);
  if (at - n.t < MIN_NOTE_S - 1e-9 || endOf(n) - at < MIN_NOTE_S - 1e-9) return notes;
  const a: AudioNote = { ...n, d: roundTime(at - n.t) };
  const b: AudioNote = { ...n, t: at, d: roundTime(endOf(n) - at) };
  delete b.u;
  delete b.tr;
  delete b.at;
  if (n.s !== undefined) b.s = roundTime(n.s + (at - n.t));
  if (notes.mode === 'mono' && movesInTime(n)) {
    const cut = roundTime(warpAt(warpOf(notes), at));
    a.ts = playedStart(n);
    a.te = cut;
    b.ts = cut;
    b.te = playedEnd(n);
  }
  return canonicalNotes(notes, [...notes.n.slice(0, i), a, b, ...notes.n.slice(i + 1)]);
}

/**
 * A note joined with the next into one, from the first's start to the second's end: it takes the
 * pitch and edits of the longer (of those with a pitch), the first's unvoiced start, glide and attack,
 * and the first's start and the second's end where they now play. A line's notes only.
 */
export function joinNotes(notes: AudioNotes, i: number): AudioNotes {
  const a = notes.n[i];
  const b = notes.n[i + 1];
  if (notes.mode !== 'mono' || !a || !b) return notes;
  const main = a.p === null ? b : b.p === null ? a : b.d > a.d ? b : a;
  const joined: AudioNote = { t: a.t, d: roundTime(endOf(b) - a.t), p: main.p };
  if (a.u !== undefined) joined.u = a.u;
  const { to, dr, mo, fo, g, m } = main;
  Object.assign(joined, { to, dr, mo, fo, g, m, tr: a.tr });
  if (movesInTime(a) || movesInTime(b)) Object.assign(joined, { ts: playedStart(a), te: playedEnd(b), at: a.at });
  for (const f of AUDIO_NOTE_FIELDS) if (joined[f] === undefined) delete joined[f];
  return canonicalNotes(notes, [...notes.n.slice(0, i), joined, ...notes.n.slice(i + 2)]);
}

/**
 * Where a note ends and the next (touching it) starts, moved to a time between their starts and ends
 * (seconds of the file as recorded, 10 ms from either at least). Notes that don't touch stay as they
 * are; with notes moved in time, the boundary goes as far as the warp lets it. A line's notes only.
 */
export function moveBoundary(notes: AudioNotes, i: number, atSeconds: number): AudioNotes {
  const a = notes.n[i];
  const b = notes.n[i + 1];
  if (notes.mode !== 'mono' || !a || !b || !touch(a, b) || !Number.isFinite(atSeconds)) return notes;
  const target = roundTime(clamp(atSeconds, a.t + MIN_NOTE_S, endOf(b) - MIN_NOTE_S));
  const from = b.t;
  const dir = Math.sign(target - from);
  const steps = Math.round(Math.abs(target - from) * TIME_STEP);
  const w = movesInTime(a) || movesInTime(b) ? warpOf(notes) : null;
  const make = (k: number) => {
    const at = roundTime(from + (dir * k) / TIME_STEP);
    const na: AudioNote = { ...a, d: roundTime(at - a.t) };
    const nb: AudioNote = { ...b, t: at, d: roundTime(endOf(b) - at) };
    if (b.s !== undefined) nb.s = roundTime(b.s + (at - b.t));
    if (w) {
      const cut = roundTime(warpAt(w, at));
      na.ts = playedStart(a);
      na.te = cut;
      nb.ts = cut;
      nb.te = playedEnd(b);
    }
    const out = notes.n.slice();
    out[i] = na;
    out[i + 1] = nb;
    return out;
  };
  if (!steps) return notes;
  const list = w ? furthest(steps, make) : make(steps);
  return list ? canonicalNotes(notes, list) : notes;
}

// ---- notes found again: added, removed, edits reset ----

/**
 * A note detection missed, added (seconds of the file as recorded; no pitch for a breath or a hit),
 * untouched. In a line it goes in the gap it starts in: cut short where the next note starts, and
 * not added at all when it starts inside another, would be under 10 ms, or breaks a move's warp.
 */
export function addNote(notes: AudioNotes, t: number, d: number, p: number | null): AudioNotes {
  if (!Number.isFinite(t) || !Number.isFinite(d)) return notes;
  const start = roundTime(Math.max(0, t));
  let stop = roundTime(start + Math.max(MIN_NOTE_S, d));
  const pitch = p === null || !Number.isFinite(p) ? null : roundPitch(clamp(p, 0, 127));
  if (notes.mode === 'mono') {
    for (const n of notes.n) {
      if (n.t <= start && start < endOf(n)) return notes;
      if (n.t > start) {
        stop = Math.min(stop, n.t);
        break;
      }
    }
    if (stop - start < MIN_NOTE_S - 1e-9) return notes;
  } else if (notes.n.some((n) => n.t === start && n.p === pitch && endOf(n) === stop)) return notes;
  const note: AudioNote = { t: start, d: roundTime(stop - start), p: pitch };
  const at = notes.n.findIndex(
    (n) => n.t > start || (n.t === start && (n.p ?? Number.POSITIVE_INFINITY) > (pitch ?? Number.POSITIVE_INFINITY)),
  );
  const list = at < 0 ? [...notes.n, note] : [...notes.n.slice(0, at), note, ...notes.n.slice(at)];
  if (notes.mode === 'mono' && !fits(list)) return notes;
  return canonicalNotes(notes, list);
}

/**
 * A note taken out (detection heard one that isn't there): its sound plays as recorded, part of what's
 * around it. A legato neighbour's edge that followed its move goes back.
 */
export function removeNote(notes: AudioNotes, i: number): AudioNotes {
  const n = notes.n[i];
  if (!n) return notes;
  const list = notes.n.slice();
  list.splice(i, 1);
  if (notes.mode === 'mono' && movesInTime(n)) {
    const prev = notes.n[i - 1];
    const next = notes.n[i + 1];
    if (prev && touch(prev, n) && prev.te !== undefined) list[i - 1] = { ...prev, te: endOf(prev) };
    if (next && touch(n, next) && next.ts !== undefined) list[i] = { ...next, ts: next.t };
  }
  return canonicalNotes(notes, list);
}

/** A note's edits, by the field each is kept in. */
export type NoteEditField = 'to' | 'dr' | 'mo' | 'tr' | 'fo' | 'g' | 'm' | 'ts' | 'te' | 'at' | 's';
export const NOTE_EDIT_FIELDS: readonly NoteEditField[] = [
  'to',
  'dr',
  'mo',
  'tr',
  'fo',
  'g',
  'm',
  'ts',
  'te',
  'at',
  's',
];

/**
 * Notes put back as found: all their edits, or those named. A move in time put back takes a legato
 * neighbour's edge that followed it back too.
 */
export function resetNotes(
  notes: AudioNotes,
  indices: readonly number[],
  fields: readonly NoteEditField[] = NOTE_EDIT_FIELDS,
): AudioNotes {
  const idx = noteIndices(notes, indices);
  const gone = new Set(idx);
  const back = (n: AudioNote, drop: readonly NoteEditField[]): AudioNote => {
    const out: AudioNote = { ...n };
    for (const f of drop) delete out[f];
    return out;
  };
  let out = change(notes, idx, (n) => back(n, fields));
  if (notes.mode !== 'mono' || out === notes) return out;
  // the edges of untouched legato neighbours that followed a move put back
  const edges: [number, NoteEditField][] = [];
  for (const i of idx) {
    if (fields.includes('ts') && !gone.has(i - 1) && touch(notes.n[i - 1], notes.n[i])) edges.push([i - 1, 'te']);
    if (fields.includes('te') && !gone.has(i + 1) && touch(notes.n[i], notes.n[i + 1])) edges.push([i + 1, 'ts']);
  }
  for (const [j, f] of edges) out = change(out, [j], (n) => back(n, [f]));
  return out;
}

// ---- choosing notes ----

/** What choosing notes by words needs to know, when the words need it. */
export interface NoteSelectContext {
  /** The notes selected in the studio (indices from 0), for "selected". */
  selected?: readonly number[];
  /** The song and the region the notes are in, for "bars 9-13". */
  project?: Pick<Project, 'tempo' | 'meter'>;
  region?: NotesPlacing;
  /** How pitches are named, for "pitch E4": middle C as C4 (the default) or C3. */
  middleC?: MiddleC;
}

const QUERY_HELP = 'say "all", "selected", note numbers ("1-12,15"), "bars 9-13" or "pitch E4"';

/**
 * The notes some words choose, as indices (from 0, in order): "all"; "selected"; note numbers counted
 * from 1, with ranges ("3", "1-12,15"); "bars 9-13" or "bar 9" (the notes whose beat, after their
 * unvoiced start, plays in those bars, where the region now plays them: needs the song and the
 * region); "pitch E4" or "pitch E4,G4" (the notes at that pitch now, to the nearest semitone). Words
 * that choose nothing this way, or a number past the notes, throw an error that says why.
 */
export function selectNotes(notes: AudioNotes, query: string, ctx: NoteSelectContext = {}): number[] {
  const text = query.trim().replace(/[–—]/g, '-');
  const q = text.toLowerCase();
  const count = notes.n.length;
  if (q === 'all') return notes.n.map((_, i) => i);
  if (q === 'selected') return noteIndices(notes, ctx.selected ?? []);
  const numbers = /^(?:notes?\s+)?(\d+(?:\s*-\s*\d+)?(?:\s*,\s*\d+(?:\s*-\s*\d+)?)*)$/.exec(q);
  if (numbers) {
    const out = new Set<number>();
    for (const part of (numbers[1] as string).split(',')) {
      const [a = 0, b = a] = part.split('-').map((x) => Number(x.trim()));
      for (const x of [a, b])
        if (x < 1 || x > count)
          throw new Error(
            count ? `There ${count === 1 ? 'is 1 note' : `are ${count} notes`}: ${x} isn't one` : 'There are no notes',
          );
      for (let x = Math.min(a, b); x <= Math.max(a, b); x++) out.add(x - 1);
    }
    return [...out].sort((x, y) => x - y);
  }
  const bars = /^bars?\s+(-?\d+)(?:\s*-\s*(-?\d+))?$/.exec(q);
  if (bars) {
    const { project, region } = ctx;
    if (!project || !region) throw new Error('Choosing notes by bars needs the song and the region they’re in');
    const a = Number(bars[1]);
    const b = bars[2] === undefined ? a : Number(bars[2]);
    const lowest = firstBar(project.meter);
    if (Math.min(a, b) < lowest) throw new Error(`Bars count from ${lowest}`);
    const from = barToTick(project.meter, Math.min(a, b));
    const to = barToTick(project.meter, Math.max(a, b) + 1);
    const tick = fileToTicks(project, { start: region.start, audio: region.audio && { ...region.audio, notes } });
    const out: number[] = [];
    notes.n.forEach((n, i) => {
      const at = tick(n.t + (n.u ?? 0));
      if (at >= from - 1e-6 && at < to - 1e-6) out.push(i);
    });
    return out;
  }
  const pitch = /^pitch(?:es)?\s+(.+)$/i.exec(text);
  if (pitch) {
    const wanted = new Set<number>();
    for (const name of (pitch[1] as string).split(',')) {
      try {
        wanted.add(Math.round(parseNoteName(name.trim(), ctx.middleC ?? 'C4')));
      } catch {
        throw new Error(`"${name.trim()}" isn't a pitch: use a note name such as E4 or F#3, or a MIDI number`);
      }
    }
    const out: number[] = [];
    notes.n.forEach((n, i) => {
      if (n.p !== null && wanted.has(Math.round(n.to ?? n.p))) out.push(i);
    });
    return out;
  }
  throw new Error(`"${query.trim()}" doesn't choose notes: ${QUERY_HELP}`);
}

// ---- a region's notes as it's split and healed ----

/** How many notes past each side of what a region plays its notes keep. */
export const NOTES_PAST_EDGE = 2;

/** Where a note's sound is, as found and where it now plays (its moves), seconds of the file. */
const reach = (n: AudioNote): [number, number] => [Math.min(n.t, playedStart(n)), Math.max(endOf(n), playedEnd(n))];

/**
 * A region's notes cut to what it plays of its recording, [from, to) in seconds of the file as it
 * plays (from its offset): the notes there, and the two nearest past either side (so a patch at an
 * edge renders as it did). A note across an edge is kept as it is. In a line, past a note moved in
 * time it keeps on to the first that isn't, so the warp is the same where the region plays.
 */
export function pruneNotes(notes: AudioNotes, window: readonly [number, number]): AudioNotes {
  const [from, to] = window;
  const list = notes.n;
  const keep = new Set<number>();
  const before: number[] = [];
  const after: number[] = [];
  list.forEach((n, i) => {
    const [a, b] = reach(n);
    if (a < to && b > from) keep.add(i);
    else if (b <= from) before.push(i);
    else after.push(i);
  });
  before.sort((x, y) => reach(list[y] as AudioNote)[1] - reach(list[x] as AudioNote)[1] || y - x);
  after.sort((x, y) => reach(list[x] as AudioNote)[0] - reach(list[y] as AudioNote)[0] || x - y);
  for (const i of [...before.slice(0, NOTES_PAST_EDGE), ...after.slice(0, NOTES_PAST_EDGE)]) keep.add(i);
  if (notes.mode === 'mono' && keep.size) {
    let lo = Math.min(...keep);
    let hi = Math.max(...keep);
    for (let i = lo; i <= hi; i++) keep.add(i);
    while (lo > 0 && movesInTime(list[lo] as AudioNote)) keep.add(--lo);
    while (hi < list.length - 1 && movesInTime(list[hi] as AudioNote)) keep.add(++hi);
  }
  if (keep.size === list.length) return notes;
  return canonicalNotes(
    notes,
    list.filter((_, i) => keep.has(i)),
  );
}

/** A note as text, every field: two notes with the same key are the same note. */
const noteKey = (n: AudioNote) => AUDIO_NOTE_FIELDS.map((f) => n[f] ?? '').join('|');

/** Where a region's notes reach, as found: the first start to the last end. */
function extent(notes: AudioNotes): [number, number] {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;
  for (const n of notes.n) {
    lo = Math.min(lo, n.t);
    hi = Math.max(hi, endOf(n));
  }
  return [lo, hi];
}

/**
 * Whether two regions' notes can be one region's (pieces of one recording healing into one region):
 * found the same way, and the notes both keep, where their notes reach in common, the same notes with
 * the same edits. Notes on one side only can join none on the other when none of them is edited.
 */
export function notesCompatible(a: AudioNotes | undefined, b: AudioNotes | undefined): boolean {
  if (!a || !b) return !(a ?? b)?.n.some(isNoteEdited);
  if (a.mode !== b.mode || a.v !== b.v || a.off !== b.off || a.a4 !== b.a4 || a.sens !== b.sens) return false;
  if (!a.n.length || !b.n.length) return true;
  const [a0, a1] = extent(a);
  const [b0, b1] = extent(b);
  const lo = Math.max(a0, b0);
  const hi = Math.min(a1, b1);
  const shared = (x: AudioNotes) => x.n.filter((n) => n.t < hi && endOf(n) > lo).map(noteKey);
  const [x, y] = [shared(a), shared(b)];
  return x.length === y.length && x.every((k, i) => k === y[i]);
}

/** Two regions' compatible notes as one region's (`notesCompatible`): every note of either, those both keep once. */
export function mergeNotes(a: AudioNotes | undefined, b: AudioNotes | undefined): AudioNotes | undefined {
  if (!a || !b) return a ?? b;
  const counts = new Map<string, number>();
  const list: AudioNote[] = [];
  for (const n of a.n) {
    const k = noteKey(n);
    counts.set(k, (counts.get(k) ?? 0) + 1);
    list.push(n);
  }
  for (const n of b.n) {
    const k = noteKey(n);
    const left = counts.get(k) ?? 0;
    if (left > 0) counts.set(k, left - 1);
    else list.push(n);
  }
  return canonicalNotes(a, list);
}

// ---- what changed ----

/** A way notes changed between two versions of a region's notes. */
export type NoteChangeKind =
  | 'tuned'
  | 'octave'
  | 'drift'
  | 'vibrato'
  | 'glide'
  | 'formant'
  | 'level'
  | 'muted'
  | 'unmuted'
  | 'moved'
  | 'stretched'
  | 'attack'
  | 'pasted'
  | 'reset'
  | 'split'
  | 'joined'
  | 'boundary'
  | 'added'
  | 'removed';

/** Each way, in the order they're told, and its words. */
const CHANGE_WORDS: [NoteChangeKind, string][] = [
  ['tuned', 'tuned'],
  ['octave', 'octave put right'],
  ['drift', 'drift changed'],
  ['vibrato', 'vibrato changed'],
  ['glide', 'glide changed'],
  ['formant', 'formant moved'],
  ['level', 'level changed'],
  ['muted', 'muted'],
  ['unmuted', 'unmuted'],
  ['moved', 'moved'],
  ['stretched', 'stretched'],
  ['attack', 'attack changed'],
  ['pasted', 'pasted'],
  ['reset', 'back as recorded'],
  ['split', 'split'],
  ['joined', 'joined'],
  ['boundary', 'moved'],
  ['added', 'added'],
  ['removed', 'removed'],
];

export interface NoteChanges {
  /** How many notes changed each way (a note may change several ways); a boundary is counted once. */
  counts: Partial<Record<NoteChangeKind, number>>;
  /** The notes that changed as they are now, and those that went as they were (to say where). */
  now: AudioNote[];
  was: AudioNote[];
}

/** A note's pitch shift, edits, played start and played length: what's compared of a note found in both versions. */
function compareNote(x: AudioNote, y: AudioNote, counts: NoteChanges['counts']): boolean {
  const add = (k: NoteChangeKind) => {
    counts[k] = (counts[k] ?? 0) + 1;
  };
  if (isNoteEdited(x) && !isNoteEdited(y)) {
    add('reset');
    return true;
  }
  const kinds: NoteChangeKind[] = [];
  const shift = (n: AudioNote) => (n.p === null ? 0 : roundPitch((n.to ?? n.p) - n.p));
  if (shift(x) !== shift(y)) kinds.push('tuned');
  if ((x.dr ?? 1) !== (y.dr ?? 1)) kinds.push('drift');
  if ((x.mo ?? 1) !== (y.mo ?? 1)) kinds.push('vibrato');
  if ((x.tr ?? 1) !== (y.tr ?? 1)) kinds.push('glide');
  if ((x.fo ?? 0) !== (y.fo ?? 0)) kinds.push('formant');
  if ((x.g ?? 0) !== (y.g ?? 0)) kinds.push('level');
  if (!x.m && y.m) kinds.push('muted');
  if (x.m && !y.m) kinds.push('unmuted');
  if (playedStart(x) !== playedStart(y)) kinds.push('moved');
  if (roundTime(playedEnd(x) - playedStart(x)) !== roundTime(playedEnd(y) - playedStart(y))) kinds.push('stretched');
  if ((x.at ?? 1) !== (y.at ?? 1)) kinds.push('attack');
  if ((x.s ?? x.t) !== (y.s ?? y.t)) kinds.push('pasted');
  for (const k of kinds) add(k);
  return kinds.length > 0;
}

/**
 * What changed between two versions of a region's notes, note by note: edits (tuned, moved, muted…),
 * and notes found again (split, joined, a boundary moved, an octave put right, added, removed). Notes
 * that weren't there before count by their edits, as if they had been there untouched.
 */
export function noteChanges(was: AudioNotes | undefined, now: AudioNotes | undefined): NoteChanges {
  const out: NoteChanges = { counts: {}, now: [], was: [] };
  if (was === now) return out;
  if (!was || !now) {
    // notes written with a first edit, or taken away: each edited note, against itself untouched
    for (const n of (now ?? was)?.n ?? []) {
      if (!isNoteEdited(n)) continue;
      const plain = { t: n.t, d: n.d, p: n.p };
      if (now) compareNote(plain, n, out.counts);
      else compareNote(n, plain, out.counts);
      (now ? out.now : out.was).push(n);
    }
    return out;
  }
  const found = (n: AudioNote) => `${n.t}|${n.d}|${n.p}`;
  const pool = new Map<string, AudioNote[]>();
  for (const n of was.n) {
    const k = found(n);
    const list = pool.get(k);
    if (list) list.push(n);
    else pool.set(k, [n]);
  }
  const added: AudioNote[] = [];
  for (const n of now.n) {
    const list = pool.get(found(n));
    if (!list?.length) {
      added.push(n);
      continue;
    }
    const at = Math.max(
      0,
      list.findIndex((x) => sameNote(x, n)),
    );
    const x = list.splice(at, 1)[0] as AudioNote;
    if (x !== n && !sameNote(x, n) && compareNote(x, n, out.counts)) out.now.push(n);
  }
  let removed = [...pool.values()].flat();
  // an octave put right: the same note, its pitch as found an octave or more away
  const fresh: AudioNote[] = [];
  for (const n of added) {
    const i = removed.findIndex(
      (x) => x.t === n.t && x.d === n.d && x.p !== null && n.p !== null && Math.abs(n.p - x.p) % 12 < 1e-6,
    );
    if (i < 0) {
      fresh.push(n);
      continue;
    }
    const x = removed[i] as AudioNote;
    removed = removed.filter((_, j) => j !== i);
    out.counts.octave = (out.counts.octave ?? 0) + 1;
    compareNote(x, n, out.counts);
    out.now.push(n);
  }
  // the rest in groups that overlap: one note into several is a split, several into one a join, as many
  // into as many over the same stretch a boundary moved
  const items = [...removed.map((n) => ({ n, old: true })), ...fresh.map((n) => ({ n, old: false }))].sort(
    (a, b) => a.n.t - b.n.t,
  );
  let group: typeof items = [];
  let reachEnd = Number.NEGATIVE_INFINITY;
  const close = () => {
    if (!group.length) return;
    const olds = group.filter((g) => g.old).length;
    const news = group.length - olds;
    const span = (old: boolean) => {
      const gs = group.filter((g) => g.old === old).map((g) => g.n);
      return [Math.min(...gs.map((n) => n.t)), Math.max(...gs.map(endOf))].join();
    };
    const c = out.counts;
    if (!olds) c.added = (c.added ?? 0) + news;
    else if (!news) c.removed = (c.removed ?? 0) + olds;
    else if (olds === 1 && news > 1) c.split = (c.split ?? 0) + 1;
    else if (news === 1 && olds > 1) c.joined = (c.joined ?? 0) + olds;
    else if (olds === news && olds > 1 && span(true) === span(false)) c.boundary = (c.boundary ?? 0) + olds - 1;
    else {
      c.removed = (c.removed ?? 0) + olds;
      c.added = (c.added ?? 0) + news;
    }
    for (const g of group) (g.old ? out.was : out.now).push(g.n);
    group = [];
  };
  for (const item of items) {
    if (group.length && item.n.t >= reachEnd - 1e-9) close();
    group.push(item);
    reachEnd = group.length === 1 ? endOf(item.n) : Math.max(reachEnd, endOf(item.n));
  }
  close();
  return out;
}

/** What changed, in words: "4 notes tuned, 1 moved, 1 boundary moved" (empty when nothing did). */
export function noteChangesText(changes: Pick<NoteChanges, 'counts'>): string {
  const parts: string[] = [];
  for (const [k, words] of CHANGE_WORDS) {
    const n = changes.counts[k];
    if (!n) continue;
    if (k === 'boundary') parts.push(`${n} ${n === 1 ? 'boundary' : 'boundaries'} ${words}`);
    else parts.push(parts.length ? `${n} ${words}` : `${n} ${n === 1 ? 'note' : 'notes'} ${words}`);
  }
  return parts.join(', ');
}
