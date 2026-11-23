/**
 * Editing the notes selected in the Score, as a notation program does: a line or space up or down the
 * staff, a sharp, flat or natural, a new value, copied and pasted, from the keys, the menu a right
 * click or a long press opens, and the tools a touch screen shows under the music. Every change is
 * one undo step, and leaves what it changed selected.
 */
import {
  type Caret,
  clipNotes,
  type EditResult,
  moveOnStaff,
  type NoteClip,
  noteWrittenLength,
  pasteClip,
  placesOf,
  respell,
  type ScoreDoc,
  setAccidental,
  setLength,
} from '@holo/score';
import { type Note, type Op, PPQ, type Project } from '@holo/session';
import { useSyncExternalStore } from 'react';
import { apply, deleteSelection, ensureAudio, locateNote, transposeSelection } from '../app/actions.ts';
import { store, toast } from '../app/store.ts';
import { engine } from '../audio/engine.ts';
import type { MenuEntry } from '../ui/menu.tsx';
import { entry, notesIn, scoreNow } from './doc.ts';
import { DIGIT_VALUES, lengthOf } from './entry.ts';

// ---- what's copied, and whether a tap adds to the selection ----

interface EditState {
  /** The notes copied, to paste. */
  clip: NoteClip | null;
  /** A tap on a note adds it to the selection (or takes it out), as Shift-click does: a touch screen's Shift. */
  adding: boolean;
}

let state: EditState = { clip: null, adding: false };
const listeners = new Set<() => void>();

function setState(patch: Partial<EditState>): void {
  state = { ...state, ...patch };
  for (const l of listeners) l();
}

export const editState = (): EditState => state;

export function useEditState(): EditState {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => state,
  );
}

export function setAdding(adding: boolean): void {
  if (adding !== state.adding) setState({ adding });
}

// ---- the selection ----

/** The selected notes the score shows (the Piano Roll may have selected others). */
export function selectionIn(doc: ScoreDoc, selected: readonly Note[] = store.get().selectedNotes): Note[] {
  const shown = notesIn(doc);
  return selected.filter((n) => shown.has(n));
}

/** Where a note starts on the timeline. */
function startOf(project: Project, n: Note): number {
  const at = locateNote(project, n);
  return at ? at.region.start + n.t : Number.POSITIVE_INFINITY;
}

/** Where a note starts: its track, and the tick. */
export function spotOf(n: Note): { track: string; tick: number } | null {
  const p = store.get().project;
  const at = p ? locateNote(p, n) : null;
  return at ? { track: at.track.id, tick: at.region.start + n.t } : null;
}

/** Whether these notes are all on drum parts (where a line is a drum, not a pitch). */
export function onDrums(doc: ScoreDoc, notes: readonly Note[]): boolean {
  const places = placesOf(doc);
  return notes.every((n) => doc.parts.find((p) => p.track === places.get(n)?.track)?.drums);
}

/** Hear notes (a few, briefly), each on its own track. */
function audition(notes: readonly Note[]): void {
  const p = store.get().project;
  if (!p || !notes.length) return;
  const heard = notes.slice(0, 6).flatMap((n) => {
    const at = locateNote(p, n);
    return at ? [{ track: at.track.id, n }] : [];
  });
  void ensureAudio().then(() => {
    for (const { track, n } of heard) engine.audition(track, n.p, n.v, 300);
  });
}

/** Change the selected notes the score shows: one undo step, the changed notes selected after it. */
function edit(label: string, make: (p: Project, doc: ScoreDoc, notes: Note[]) => EditResult, hear = false): boolean {
  const p = store.get().project;
  const doc = scoreNow();
  if (!p || !doc) return false;
  const notes = selectionIn(doc);
  if (!notes.length) return false;
  const r = make(p, doc, notes);
  if (!r.ops.length || !apply(r.ops, label)) return false;
  store.set({ selectedNotes: r.notes });
  if (hear) audition(r.notes);
  return true;
}

/** Up or down a semitone (or an octave), heard. */
export function semitones(n: number): void {
  transposeSelection(n);
  audition(store.get().selectedNotes);
}

/** Up or down the staff a line or space at a time, in the key. */
export const stepSelection = (steps: number) =>
  edit('Score: move notes', (p, d, n) => moveOnStaff(p, d, n, steps), true);

/** A sharp (1), flat (−1) or natural (0) on the notes' own letters. */
export const accidentalSelection = (alter: number) =>
  edit(
    alter > 0 ? 'Score: sharp' : alter < 0 ? 'Score: flat' : 'Score: natural',
    (p, d, n) => setAccidental(p, d, n, alter),
    true,
  );

export const respellSelection = () => edit('Score: respell', (p, d, n) => respell(p, d, n));

/** A new length, in ticks, for the selected notes' chords. */
const lengthTicks = (len: number) => edit('Score: length', (p, d, n) => setLength(p, d, n, Math.round(len)));

/** A new value for the selected notes' chords (1 a whole … 32, with dots). */
export const lengthSelection = (value: number, dots = 0) => lengthTicks(lengthOf(value, dots));

/** Hear where a drag would put notes (of a track), `steps` lines and spaces from where they are. */
export function hearMoved(track: string, notes: readonly Note[], steps: number): void {
  const p = store.get().project;
  const doc = scoreNow();
  if (!p || !doc) return;
  const heard = (steps ? moveOnStaff(p, doc, notes, steps).notes : notes).slice(0, 6);
  void ensureAudio().then(() => {
    for (const n of heard) engine.audition(track, n.p, n.v, 300);
  });
}

/** Notes moved by a drag: one step, the notes it moved selected. */
export function moveNotes(notes: readonly Note[], steps: number): void {
  const p = store.get().project;
  const doc = scoreNow();
  if (!p || !doc || !steps) return;
  const r = moveOnStaff(p, doc, notes, steps);
  if (r.ops.length && apply(r.ops, notes.length > 1 ? 'Score: move notes' : 'Score: move note'))
    store.set({ selectedNotes: r.notes });
}

// ---- copy and paste ----

const count = (n: number) => (n === 1 ? 'one note' : `${n} notes`);

/** Copy the selected notes (and with `cut`, take them away). False when none are selected. */
export function copySelection(cut = false): boolean {
  const p = store.get().project;
  const doc = scoreNow();
  if (!p || !doc) return false;
  const notes = selectionIn(doc);
  const clip = notes.length ? clipNotes(p, doc, notes) : null;
  if (!clip) return false;
  setState({ clip });
  if (cut) {
    const doomed = new Set(
      clip.notes.length === notes.length ? notes : notes.filter((n) => locateNote(p, n)?.track.id === clip.track),
    );
    const ops: Op[] = [];
    for (const track of p.tracks)
      for (const region of track.regions)
        if (region.notes.some((n) => doomed.has(n)))
          ops.push({
            op: 'setNotes',
            track: track.id,
            region: region.id,
            notes: region.notes.filter((n) => !doomed.has(n)),
          });
    if (ops.length && apply(ops, 'Score: cut')) store.set({ selectedNotes: [] });
  }
  toast(`${cut ? 'Cut' : 'Copied'} ${count(clip.notes.length)}`, 'info', 1800);
  return true;
}

/** The note or rest nearest a tick on a part's first staff (or its bar's start): where a paste lands. */
function nearestEvent(doc: ScoreDoc, track: string, tick: number): number {
  const staff = doc.parts.find((p) => p.track === track)?.staves[0];
  let best = doc.bars[0]?.start ?? 0;
  const consider = (t: number) => {
    if (Math.abs(t - tick) < Math.abs(best - tick)) best = t;
  };
  doc.bars.forEach((bar, i) => {
    consider(bar.start);
    for (const v of staff?.bars[i]?.voices ?? [])
      for (const e of v.events) if (!(e.kind === 'chord' && e.grace)) consider(e.tick);
  });
  return best;
}

/**
 * Where a paste goes: the caret while writing; else the first selected note (as a notation program
 * pastes at its selection); else the playhead, on the note or rest nearest it, in the selected part.
 */
function pasteCaret(doc: ScoreDoc, p: Project): Caret | null {
  const s = entry.state;
  if (s) return { track: s.track, staff: s.staff, voice: s.voice, tick: s.tick };
  const sel = selectionIn(doc);
  if (sel.length) {
    const first = sel.reduce((a, n) => (startOf(p, n) < startOf(p, a) ? n : a));
    const at = placesOf(doc).get(first);
    if (at) return { track: at.track, staff: at.staff, voice: at.voice, tick: startOf(p, first) };
  }
  const track = doc.parts.find((x) => x.track === store.get().selectedTrack)?.track ?? doc.parts[0]?.track;
  if (!track) return null;
  return { track, staff: 1, voice: 1, tick: nearestEvent(doc, track, Math.max(0, engine.positionTick())) };
}

/** Paste what's copied (at `at`, a place on a staff, else where pasting goes now). False with nothing copied. */
export function paste(at?: { track: string; staff: number; tick: number }): boolean {
  const p = store.get().project;
  const doc = scoreNow();
  const clip = state.clip;
  if (!p || !doc || !clip) return false;
  const caret = at ? { ...at, voice: 1, tick: nearestEvent(doc, at.track, at.tick) } : pasteCaret(doc, p);
  if (!caret) return false;
  const r = pasteClip(p, doc, clip, caret);
  if (!r.ops.length || !apply(r.ops, 'Score: paste')) return true;
  store.set({ selectedNotes: r.notes, selectedTrack: caret.track });
  // writing goes on after what was pasted
  if (entry.state) entry.place({ ...caret, tick: caret.tick + clip.length });
  return true;
}

/** Every note of a part in the bar at a tick, selected. */
export function selectBar(track: string, tick: number): void {
  const doc = scoreNow();
  if (!doc) return;
  const i = doc.bars.findIndex((b) => tick >= b.start && tick < b.start + b.length);
  const part = doc.parts.find((x) => x.track === track);
  if (i < 0 || !part) return;
  const notes = new Set<Note>();
  for (const staff of part.staves)
    for (const v of staff.bars[i]?.voices ?? [])
      for (const e of v.events) if (e.kind === 'chord') for (const h of e.heads) notes.add(h.ref.note);
  store.set({ selectedNotes: [...notes], selectedTrack: track });
}

// ---- the menus ----

/** The values a note can be given: [value, name, its key]. */
export const LENGTHS: [number, string, string][] = [
  [1, 'Whole', '7'],
  [2, 'Half', '6'],
  [4, 'Quarter', '5'],
  [8, 'Eighth', '4'],
  [16, 'Sixteenth', '3'],
  [32, 'Thirty-second', '2'],
];

/** The written length the selected notes share, if they share one. */
export function sharedLength(notes: readonly Note[]): number | null {
  const lengths = new Set(notes.filter((n) => !n.n?.g).map(noteWrittenLength));
  return lengths.size === 1 ? ([...lengths][0] as number) : null;
}

/** A length as a value and its dot (null when it's neither, a tuplet's or a tie's). */
export function noteValueOf(len: number | null): { value: number; dotted: boolean } | null {
  for (const [value] of LENGTHS) {
    if (len === lengthOf(value, 0)) return { value, dotted: false };
    if (len === lengthOf(value, 1)) return { value, dotted: true };
  }
  return null;
}

/** The accidental the selected notes are all written with, if they share one. */
export function sharedAccidental(doc: ScoreDoc, notes: readonly Note[]): number | null {
  const places = placesOf(doc);
  const alters = new Set(notes.map((n) => places.get(n)?.written.alter ?? null));
  return alters.size === 1 ? ([...alters][0] as number | null) : null;
}

/**
 * The value menu's entries: each value, and a dot on or off. A key beside each with `keys` (and not
 * while writing, where the digits are the next note's).
 */
export function lengthItems(notes: readonly Note[], keys = true): MenuEntry[] {
  const now = sharedLength(notes);
  const v = noteValueOf(now);
  const hints = keys && !entry.state;
  return [
    ...LENGTHS.map(
      ([value, name, key]): MenuEntry => ({
        label: name,
        ...(hints ? { hint: key } : {}),
        checked: v?.value === value,
        onSelect: () => lengthSelection(value),
      }),
    ),
    {
      label: 'Dotted',
      checked: !!v?.dotted,
      disabled: now === null || (!v?.dotted && now * 1.5 > PPQ * 6),
      onSelect: () => now !== null && lengthTicks(v?.dotted ? now / 1.5 : now * 1.5),
    },
  ];
}

/** A place on a staff: a part, its staff and a tick there. */
export interface StaffSpot {
  track: string;
  staff: number;
  tick: number;
}

/**
 * The menu for the selected notes (a right click or a long press on one): copy and paste first, then
 * the pitch, then (unless `tools`: a touch screen's tools under the music have them) the accidental
 * and the value. The keys beside them with `keys`.
 */
export function noteItems(doc: ScoreDoc, at: StaffSpot | null, tools = false, keys = true): MenuEntry[] {
  const notes = selectionIn(doc);
  const drums = onDrums(doc, notes);
  const alter = sharedAccidental(doc, notes);
  const key = (hint: string) => (keys ? { hint } : {});
  const pitch: MenuEntry[] = drums
    ? []
    : [
        'sep',
        { label: 'Up a step', ...key('Alt ↑'), onSelect: () => stepSelection(1) },
        { label: 'Down a step', ...key('Alt ↓'), onSelect: () => stepSelection(-1) },
        { label: 'Up a semitone', ...key('↑'), onSelect: () => semitones(1) },
        { label: 'Down a semitone', ...key('↓'), onSelect: () => semitones(-1) },
        { label: 'Up an octave', ...key('Shift ↑'), onSelect: () => semitones(12) },
        { label: 'Down an octave', ...key('Shift ↓'), onSelect: () => semitones(-12) },
        ...(tools
          ? []
          : [
              { heading: 'Accidental' },
              { label: 'Sharp ♯', checked: alter === 1, onSelect: () => accidentalSelection(1) },
              { label: 'Flat ♭', checked: alter === -1, onSelect: () => accidentalSelection(-1) },
              { label: 'Natural ♮', checked: alter === 0, onSelect: () => accidentalSelection(0) },
            ]),
        { label: 'Respell (F♯ ↔ G♭)', ...(entry.state ? key('J') : {}), onSelect: respellSelection },
      ];
  return [
    { label: 'Copy', ...key('Ctrl C'), onSelect: () => copySelection() },
    { label: 'Cut', ...key('Ctrl X'), onSelect: () => copySelection(true) },
    { label: 'Paste here', ...key('Ctrl V'), disabled: !state.clip, onSelect: () => paste() },
    { label: notes.length > 1 ? 'Delete notes' : 'Delete', ...key('Delete'), onSelect: deleteSelection },
    ...(at ? [{ label: 'Select the bar', onSelect: () => selectBar(at.track, at.tick) }] : []),
    ...pitch,
    ...(tools ? [] : [{ heading: 'Value' }, ...lengthItems(notes, keys)]),
  ];
}

/** The menu for a place with no note (a right click or a long press there). */
export function spotItems(at: StaffSpot, keys = true): MenuEntry[] {
  return [
    { label: 'Paste here', ...(keys ? { hint: 'Ctrl V' } : {}), disabled: !state.clip, onSelect: () => paste(at) },
    { label: 'Select the bar', onSelect: () => selectBar(at.track, at.tick) },
  ];
}

// ---- the keys ----

/**
 * A key while the Score is open: true when it was the Score's. Copy, cut and paste always; while
 * writing, the writing's keys; else, with notes selected, a digit gives them a value (5 a quarter, as
 * in MuseScore) and Alt ↑ ↓ moves them a step.
 */
export function scoreKey(e: KeyboardEvent): boolean {
  const ctrl = e.ctrlKey || e.metaKey;
  const k = e.key.toLowerCase();
  if (ctrl && !e.altKey && !e.shiftKey && (k === 'c' || k === 'x' || k === 'v')) {
    return k === 'v' ? paste() : copySelection(k === 'x');
  }
  if (entry.state) return entry.key_(e);
  if (ctrl) return false;
  const doc = scoreNow();
  if (!doc || !selectionIn(doc).length) return false;
  if (!e.shiftKey && !e.altKey && e.key in DIGIT_VALUES) {
    lengthSelection(DIGIT_VALUES[e.key] as number);
    return true;
  }
  if (e.altKey && !e.shiftKey && (e.key === 'ArrowUp' || e.key === 'ArrowDown')) {
    stepSelection(e.key === 'ArrowUp' ? 1 : -1);
    return true;
  }
  return false;
}
