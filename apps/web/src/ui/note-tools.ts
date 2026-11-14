/**
 * The Notes view's tools (AudioNotes.tsx), as plain arithmetic: which note a pointer is on and which
 * part of it, which way a drag goes once it has gone far enough to tell, how far a drag moves a pitch,
 * a time or an amount, where a note detection missed can go, and which of the note edits (NOTE_EDITS)
 * each tool, menu entry and key offers, so a test can tell the studio offers every one.
 */
import {
  ATTACK_S,
  type AudioNote,
  MIN_NOTE_S,
  NOTE_EDIT_NAMES,
  type PitchSnap,
  type Scale,
  snapTarget,
} from '@holo/session';
import { capsuleHalf, firstAt, restingPitch } from './note-lanes.ts';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---- the tools ----

export type NoteTool = 'pointer' | 'pitch' | 'vibrato' | 'drift' | 'transition' | 'formant' | 'gain' | 'time' | 'split';

export interface NoteToolDef {
  id: NoteTool;
  name: string;
  /** What it does: its button's title. */
  help: string;
  /** The note edits it makes, by their names in NOTE_EDITS. */
  edits: readonly string[];
}

export const NOTE_TOOLS: readonly NoteToolDef[] = [
  {
    id: 'pointer',
    name: 'Pointer',
    help: 'Pointer: select; drag a note up or down for its pitch, sideways to move it, by an end to stretch it; double-click to snap its pitch',
    edits: ['shift', 'set-pitch', 'move', 'resize'],
  },
  {
    id: 'pitch',
    name: 'Pitch',
    help: 'Pitch: drag notes up or down (their centre; drift and vibrato stay); double-click to snap',
    edits: ['shift', 'set-pitch'],
  },
  {
    id: 'vibrato',
    name: 'Vibrato',
    help: 'Vibrato: drag up for more, down for less; double-click puts it back as sung',
    edits: ['vibrato', 'reset'],
  },
  {
    id: 'drift',
    name: 'Drift',
    help: 'Drift: drag down to hold notes steadier, up to keep how they wander; double-click puts it back',
    edits: ['drift', 'reset'],
  },
  {
    id: 'transition',
    name: 'Transition',
    help: 'Transition: drag up for a slower glide into a note, down for a quicker one; double-click puts it back',
    edits: ['transition', 'reset'],
  },
  {
    id: 'formant',
    name: 'Formant',
    help: 'Formant: drag up for a brighter, smaller voice, down for a darker, bigger one; double-click puts it back',
    edits: ['formant', 'reset'],
  },
  {
    id: 'gain',
    name: 'Gain',
    help: 'Gain: drag up for louder, down for quieter; double-click puts it back',
    edits: ['gain', 'reset'],
  },
  {
    id: 'time',
    name: 'Time',
    help: 'Time: drag a note sideways to move it, by an end to stretch it, by its attack handle to play its attack quicker or slower; double-click puts its timing back',
    edits: ['move', 'resize', 'attack', 'reset'],
  },
  {
    id: 'split',
    name: 'Split',
    help: 'Split: click a note to cut it there; drag where two notes meet to move that boundary; double-click it to join them',
    edits: ['split', 'boundary', 'join'],
  },
];

export const noteTool = (id: NoteTool): NoteToolDef =>
  NOTE_TOOLS.find((t) => t.id === id) ?? (NOTE_TOOLS[0] as NoteToolDef);

/** How a pitch dragged lands, in words. */
export const PITCH_SNAP_NAMES: Record<PitchSnap, string> = { free: 'Free', semitone: 'Semitone', scale: 'Scale' };

/** The note edits the menu on a note, or on the space between them, offers. */
export const NOTE_MENU_EDITS: readonly string[] = [
  'mute',
  'unmute',
  'set-pitch',
  'octave',
  'split',
  'join',
  'reset',
  'remove',
  'add',
];

/** The note edits the keys make while the Notes view has the keyboard. */
export const NOTE_KEY_EDITS: Readonly<Record<string, readonly string[]>> = {
  '↑ / ↓': ['shift'],
  M: ['mute', 'unmute'],
  Delete: ['reset'],
};

/** Each note edit the studio offers, with the controls that offer it ("Vibrato tool", "menu", "M key"). */
export function studioNoteEdits(): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const add = (edit: string, control: string) => {
    const list = out.get(edit);
    if (list) list.push(control);
    else out.set(edit, [control]);
  };
  for (const t of NOTE_TOOLS) for (const e of t.edits) add(e, `${t.name} tool`);
  for (const e of NOTE_MENU_EDITS) add(e, 'menu');
  for (const [key, edits] of Object.entries(NOTE_KEY_EDITS)) for (const e of edits) add(e, `${key} key`);
  return out;
}

/** Names the studio offers that aren't note edits at all (a name changed in NOTE_EDITS and not here). */
export function unknownStudioEdits(): string[] {
  const known = new Set(NOTE_EDIT_NAMES);
  return [...studioNoteEdits().keys()].filter((e) => !known.has(e));
}

// ---- dragging an amount ----

/** The tools that set an amount by dragging up or down. */
export type AmountToolId = 'vibrato' | 'drift' | 'transition' | 'formant' | 'gain';

export interface AmountTool {
  /** The note edit it makes, and the argument the amount goes in. */
  edit: string;
  arg: string;
  /** The note's field it reads, and the value that field is when it isn't there. */
  field: 'mo' | 'dr' | 'tr' | 'fo' | 'g';
  neutral: number;
  min: number;
  max: number;
  /** How much a pixel up adds, and the step it's rounded to. */
  perPx: number;
  step: number;
  /** The edit's argument for an amount (a percentage for a share). */
  toArg: (v: number) => number;
  /** What `reset` puts back for it. */
  reset: string;
  /** Its undo step, and the amount in words. */
  label: string;
  text: (v: number) => string;
}

const percent = (v: number) => Math.round(v * 100);

export const AMOUNT_TOOLS: Readonly<Record<AmountToolId, AmountTool>> = {
  vibrato: {
    edit: 'vibrato',
    arg: 'keep',
    field: 'mo',
    neutral: 1,
    min: 0,
    max: 2,
    perPx: 0.01,
    step: 0.01,
    toArg: percent,
    reset: 'vibrato',
    label: 'Note Vibrato',
    text: (v) => `Vibrato ${percent(v)}%`,
  },
  drift: {
    edit: 'drift',
    arg: 'keep',
    field: 'dr',
    neutral: 1,
    min: 0,
    max: 1,
    perPx: 0.005,
    step: 0.01,
    toArg: percent,
    reset: 'drift',
    label: 'Note Drift',
    text: (v) => `Drift ${percent(v)}%`,
  },
  transition: {
    edit: 'transition',
    arg: 'length',
    field: 'tr',
    neutral: 1,
    min: 0,
    max: 3,
    perPx: 0.01,
    step: 0.01,
    toArg: percent,
    reset: 'transition',
    label: 'Note Transition',
    text: (v) => `Transition ${percent(v)}%`,
  },
  formant: {
    edit: 'formant',
    arg: 'semitones',
    field: 'fo',
    neutral: 0,
    min: -12,
    max: 12,
    perPx: 1 / 12,
    step: 0.1,
    toArg: (v) => v,
    reset: 'formant',
    label: 'Note Formant',
    text: (v) => `Formant ${v > 0 ? '+' : ''}${v.toFixed(1)} st`,
  },
  gain: {
    edit: 'gain',
    arg: 'db',
    field: 'g',
    neutral: 0,
    min: -60,
    max: 24,
    perPx: 0.2,
    step: 0.1,
    toArg: (v) => v,
    reset: 'gain',
    label: 'Note Gain',
    text: (v) => `Gain ${v > 0 ? '+' : ''}${v.toFixed(1)} dB`,
  },
};

export const isAmountTool = (t: NoteTool): t is AmountToolId => t in AMOUNT_TOOLS;

/** A note's amount for a tool: its edit, else as it was found. */
export const amountOf = (tool: AmountTool, n: AudioNote): number => n[tool.field] ?? tool.neutral;

/** An amount after a drag `dy` pixels down (up is more), kept in range and to its step. */
export function amountAfterDrag(tool: AmountTool, from: number, dy: number): number {
  const v = clamp(from - dy * tool.perPx, tool.min, tool.max);
  const per = Math.round(1 / tool.step);
  return Math.round(v * per) / per;
}

/**
 * Notes grouped by the amount each comes to after a drag (each from its own amount), so the edit runs
 * once per amount rather than once per note: [amount, the notes' indices].
 */
export function amountGroups(
  tool: AmountTool,
  notes: readonly AudioNote[],
  indices: readonly number[],
  dy: number,
): [number, number[]][] {
  const out = new Map<number, number[]>();
  for (const i of indices) {
    const n = notes[i];
    if (!n) continue;
    const v = amountAfterDrag(tool, amountOf(tool, n), dy);
    const list = out.get(v);
    if (list) list.push(i);
    else out.set(v, [i]);
  }
  return [...out];
}

// ---- which way a drag goes ----

/** How far a drag on a note goes before it chooses its way, pixels (a finger's own threshold when larger). */
export const AXIS_LOCK_PX = 6;

/** The way a drag goes once it's this far from where it was pressed: across (time) or up and down (pitch); null till then. */
export function lockAxis(dx: number, dy: number, min = AXIS_LOCK_PX): 'x' | 'y' | null {
  if (Math.hypot(dx, dy) < min) return null;
  return Math.abs(dy) > Math.abs(dx) ? 'y' : 'x';
}

/** A tick on the nearest of the grid's steps (`free`: on the nearest tick). */
export function snapTick(tick: number, step: number, free: boolean): number {
  if (free || !(step > 0)) return Math.round(tick);
  return Math.round(tick / step) * step;
}

/** The `shift` edit's arguments for a drag up or down of so many semitones (with cents): snapped as chosen, or `free`. */
export function shiftArgs(semitones: number, snap: PitchSnap, free: boolean): { semitones: number; snap: PitchSnap } {
  return { semitones, snap: free ? 'free' : snap };
}

/** The `shift` edit's arguments for ↑ or ↓ (`dir` 1 or −1): a semitone, snapped as chosen; `fine` (Shift): 10 cents, free. */
export function keyShiftArgs(
  dir: number,
  fine: boolean,
  snap: PitchSnap,
): { semitones: number; cents: number; snap: PitchSnap } {
  return fine ? { semitones: 0, cents: 10 * dir, snap: 'free' } : { semitones: dir, cents: 0, snap };
}

/**
 * How far a drag across moves a time of a note (seconds, as the region plays it: its beat, or an
 * end), `dTick` ticks of the song: onto the grid's step nearest where it's dragged, or as dragged
 * (`free`). `toTick` and `toSeconds` place seconds as the region plays them on the timeline and back.
 */
export function dragSeconds(
  from: number,
  dTick: number,
  step: number,
  free: boolean,
  toTick: (seconds: number) => number,
  toSeconds: (tick: number) => number,
): number {
  return toSeconds(snapTick(toTick(from) + dTick, step, free)) - from;
}

/**
 * A note's attack after its handle is dragged `seconds` later (slower) or earlier (quicker): its
 * length against as sung (the `attack` edit's share), from its attack as it plays now, 0.25 to 4.
 */
export function attackAfterDrag(n: Pick<AudioNote, 'd' | 'at'>, seconds: number): number {
  const attack = Math.min(ATTACK_S, n.d / 3);
  return clamp((attack * (n.at ?? 1) + seconds) / attack, 0.25, 4);
}

/**
 * Where a note's pitch snaps to (double-click, the menu's Snap Pitch): the nearest semitone, or the
 * nearest note of the scale; never left free, which would leave it where it is. Null with no pitch.
 */
export function snapPitchTarget(n: Pick<AudioNote, 'p' | 'to'>, snap: PitchSnap, scale: Scale | null): number | null {
  if (n.p === null) return null;
  return snapTarget(n.to ?? n.p, snap === 'free' ? 'semitone' : snap, scale);
}

// ---- which note a pointer is on ----

/** A note as it's drawn, for finding the one under a pointer. */
export interface NoteBox {
  /** Its index in its region's notes. */
  i: number;
  /** From where to where across it's drawn, the height of its middle, and half its thickness. */
  x0: number;
  x1: number;
  y: number;
  half: number;
  pitched: boolean;
  /** Where its attack ends as it plays (the Time tool's handle), or null where it has none to drag. */
  attack: number | null;
}

/** What `noteBoxes` needs to know of how notes are drawn. */
export interface BoxPlacing {
  /** Where a second of the recording as recorded is drawn across (its notes' moves taken in). */
  xOf: (seconds: number) => number;
  /** Where a pitch is drawn up and down. */
  yOf: (pitch: number) => number;
  /** The pitch a note is drawn at (null where it has none). */
  pitchOf: (n: AudioNote) => number | null;
  keyHeight: number;
  /** Only the notes drawn within these (the region's span): what's beyond it is dim, and not for editing. */
  from: number;
  to: number;
}

/** The notes as they're drawn, within the region's span, in order. */
export function noteBoxes(notes: readonly AudioNote[], o: BoxPlacing): NoteBox[] {
  const out: NoteBox[] = [];
  for (let i = 0; i < notes.length; i++) {
    const n = notes[i] as AudioNote;
    const x0 = o.xOf(n.t);
    const x1 = o.xOf(n.t + n.d);
    if (x1 < o.from || x0 > o.to) continue;
    const pitch = o.pitchOf(n);
    const pitched = pitch !== null;
    const rest = pitched ? pitch : restingPitch(notes, i);
    let attack: number | null = null;
    const u = n.u ?? 0;
    const a = Math.min(ATTACK_S, n.d / 3);
    if (pitched && u + a < n.d - 0.001) attack = o.xOf(n.t + u + a);
    out.push({
      i,
      x0,
      x1,
      y: rest === null ? Number.NaN : o.yOf(rest),
      half: pitched ? capsuleHalf(o.keyHeight, x1 - x0) : 1.5,
      pitched,
      attack,
    });
  }
  return out;
}

/** Which part of a note a pointer is on: its body, an end (to stretch it), or its attack handle. */
export type NotePart = 'body' | 'start' | 'end' | 'attack';

export interface NoteHit {
  i: number;
  part: NotePart;
}

export interface HitOptions {
  /** A finger: more room round a note and its ends. */
  touch: boolean;
  keyHeight: number;
  /** The tool offers a note's ends to stretch it, and its attack handle. */
  edges?: boolean;
  attack?: boolean;
}

/** How near a note's end a pointer grabs the end, pixels (a third of the note at most). */
export const EDGE_PX = { mouse: 7, touch: 14 } as const;
/** How near its attack handle. */
const ATTACK_PX = { mouse: 5, touch: 11 } as const;

/** The note under a pointer, and the part of it; the nearest of those it's on (null on none). */
export function hitNote(boxes: readonly NoteBox[], x: number, y: number, o: HitOptions): NoteHit | null {
  const reach = Math.max(o.keyHeight * 0.5, o.touch ? 16 : 5);
  const pad = o.touch ? 6 : 2;
  let best: NoteHit | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const b of boxes) {
    if (Number.isNaN(b.y) || x < b.x0 - pad || x > b.x1 + pad) continue;
    const dy = Math.abs(y - b.y);
    if (dy > Math.max(b.half, reach)) continue;
    const dx = x < b.x0 ? b.x0 - x : x > b.x1 ? x - b.x1 : 0;
    const distance = dy + 2 * dx;
    if (distance >= bestDistance) continue;
    bestDistance = distance;
    best = { i: b.i, part: partOf(b, x, o) };
  }
  return best;
}

function partOf(b: NoteBox, x: number, o: HitOptions): NotePart {
  const width = b.x1 - b.x0;
  const edge = Math.min(o.touch ? EDGE_PX.touch : EDGE_PX.mouse, width / 3);
  if (o.edges && b.x1 - x < edge) return 'end';
  if (o.attack && b.attack !== null && b.attack - b.x0 > edge * 0.6) {
    if (Math.abs(x - b.attack) <= (o.touch ? ATTACK_PX.touch : ATTACK_PX.mouse)) return 'attack';
  }
  if (o.edges && x - b.x0 < edge) return 'start';
  return 'body';
}

/** Whether one note ends where the next starts (as found), to the 0.1 ms they're kept to. */
export function notesTouch(a: AudioNote | undefined, b: AudioNote | undefined): boolean {
  return !!a && !!b && Math.abs(a.t + a.d - b.t) < 5e-5;
}

/** Where two notes that touch meet, under a pointer: the index of the first (null where there's none in reach). */
export function hitBoundary(
  boxes: readonly NoteBox[],
  notes: readonly AudioNote[],
  x: number,
  y: number,
  o: Pick<HitOptions, 'touch' | 'keyHeight'>,
): number | null {
  const near = o.touch ? 12 : 5;
  const reach = Math.max(o.keyHeight * 0.5, o.touch ? 16 : 5);
  let best: number | null = null;
  let bestDx = Number.POSITIVE_INFINITY;
  for (let k = 0; k + 1 < boxes.length; k++) {
    const a = boxes[k] as NoteBox;
    const b = boxes[k + 1] as NoteBox;
    if (b.i !== a.i + 1 || !notesTouch(notes[a.i], notes[b.i])) continue;
    const dx = Math.abs(x - a.x1);
    if (dx > near || dx >= bestDx) continue;
    const ys = [a.y, b.y].filter((v) => !Number.isNaN(v));
    if (!ys.length || y < Math.min(...ys) - reach || y > Math.max(...ys) + reach) continue;
    best = a.i;
    bestDx = dx;
  }
  return best;
}

/** The notes a marquee from (x0, y0) to (x1, y1) touches, by index. */
export function notesInRect(boxes: readonly NoteBox[], x0: number, y0: number, x1: number, y1: number): number[] {
  const [l, r] = [Math.min(x0, x1), Math.max(x0, x1)];
  const [t, b] = [Math.min(y0, y1), Math.max(y0, y1)];
  return boxes
    .filter(
      (n) =>
        !Number.isNaN(n.y) &&
        n.x1 >= l &&
        n.x0 <= r &&
        n.y + Math.max(2, n.half) >= t &&
        n.y - Math.max(2, n.half) <= b,
    )
    .map((n) => n.i);
}

// ---- a note detection missed ----

/** The longest note added at a time, seconds. */
const ADD_MAX_S = 2;
/** A note with no pitch added where the recording isn't voiced: this long either side of the pointer at most. */
const ADD_UNVOICED_S = 0.15;

/**
 * Where a note can be added at a time in the recording (seconds as recorded), between the notes
 * either side: over the voiced stretch of its pitch around that time, at that stretch's middle pitch
 * (the median); where it isn't voiced, a note with no pitch (a breath, a hit) close round the time.
 * Two seconds at most; null inside a note, or where there's no room for 10 ms.
 */
export function missedSpan(
  notes: readonly AudioNote[],
  curve: { t: ArrayLike<number>; midi: ArrayLike<number> } | null,
  at: number,
): { t: number; d: number; p: number | null } | null {
  let lo = 0;
  let hi = Number.POSITIVE_INFINITY;
  for (const n of notes) {
    const end = n.t + n.d;
    if (n.t <= at && at < end) return null;
    if (end <= at) lo = Math.max(lo, end);
    else if (n.t > at) hi = Math.min(hi, n.t);
  }
  lo = Math.max(lo, at - ADD_MAX_S);
  hi = Math.min(hi, at + ADD_MAX_S);
  let span: [number, number] = [Math.max(lo, at - ADD_UNVOICED_S), Math.min(hi, at + ADD_UNVOICED_S)];
  let p: number | null = null;
  const steps = curve?.t.length ?? 0;
  if (curve && steps > 1) {
    const step = (curve.t[1] as number) - (curve.t[0] as number);
    let k = Math.min(steps - 1, firstAt(curve.t, at));
    if (k > 0 && Number.isNaN(curve.midi[k] as number)) k--;
    if (!Number.isNaN(curve.midi[k] as number) && Math.abs((curve.t[k] as number) - at) <= step) {
      let a = k;
      let b = k;
      while (a > 0 && !Number.isNaN(curve.midi[a - 1] as number) && (curve.t[a - 1] as number) >= lo) a--;
      while (b + 1 < steps && !Number.isNaN(curve.midi[b + 1] as number) && (curve.t[b + 1] as number) < hi) b++;
      const pitches: number[] = [];
      for (let q = a; q <= b; q++) pitches.push(curve.midi[q] as number);
      pitches.sort((x, y) => x - y);
      const m = pitches.length;
      p = m % 2 ? (pitches[m >> 1] as number) : ((pitches[m / 2 - 1] as number) + (pitches[m / 2] as number)) / 2;
      span = [Math.max(lo, curve.t[a] as number), Math.min(hi, (curve.t[b] as number) + step)];
    }
  }
  const d = span[1] - span[0];
  if (!(d >= MIN_NOTE_S - 1e-9)) return null;
  return { t: span[0], d, p };
}
