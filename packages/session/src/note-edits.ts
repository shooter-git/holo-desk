/**
 * Every edit of a recording's notes, listed once (`NOTE_EDITS`): the Audio Editor's tools, the
 * agent's `audio_notes` actions and the `holo notes` commands are all made from this list, so each
 * edit is offered in all three, by the same name, with the same arguments, and comes out the same.
 *
 * An edit says what it does in a sentence, which kinds of notes it applies to, whether it works on
 * notes chosen first (`selectNotes`), and its arguments, each with a kind (semitones, seconds, dB…), a
 * range and a default, from which a tool's arguments or a command's flags are made. `apply` makes it:
 * from the notes as they are to the notes as edited (audio-notes-edit.ts), canonical, and the notes as
 * they were when it doesn't apply (another kind of notes, an argument missing, or something it needs
 * to know beyond the notes: the song and region for the grid, the notes' levels).
 *
 * The macros (`correct-pitch`, `quantize-time`, `level`: note-macros.ts) are edits here like the
 * rest, and so are `paste` and `copy-settings`, which copy from another note of the recording: one of
 * these by its number (`from`), or one the context gives (`source`: copied in another region of the
 * same recording, or an edit linked across regions, note-link.ts), so an edit carries what it copies
 * wherever it's made. Beside the edits, each of the three offers what's in `NOTE_EXTRAS` by the same name: a
 * region's notes made a MIDI track (`midi`, notes-midi.ts), which adds a track rather than editing.
 */

import { AUDIO_NOTES_MODES, fileToTicks, MAX_MOVE_S, MIN_NOTE_S } from './audio-notes.ts';
import {
  addNote,
  copySettings,
  editNotes,
  fixOctave,
  joinNotes,
  moveBoundary,
  moveNotes,
  NOTE_EDIT_FIELDS,
  type NoteEditField,
  type NoteScales,
  type NoteSelectContext,
  noteIndices,
  PITCH_SNAPS,
  type PitchSnap,
  pasteNotes,
  removeNote,
  resetNotes,
  resizeNote,
  type Scale,
  scaleAt,
  setAttack,
  shiftNotes,
  splitNote,
  unpasteNotes,
} from './audio-notes-edit.ts';
import { type MiddleC, parseNoteName } from './notation.ts';
import { correctPitch, levelNotes, quantizeNotes } from './note-macros.ts';
import { DIVISIONS } from './time.ts';
import type { AudioNote, AudioNotes, AudioNotesMode, Project } from './types.ts';

/**
 * What an argument is: `semitones`, `cents`, `seconds`, `percent` (100 is as recorded), `db` numbers;
 * `pitch` a note name ("E4", "F#3+20c") or a MIDI number; `snap` one of PITCH_SNAPS; `choice` one of
 * its `values`; `boolean`; `index` a note's number, counted from 1.
 */
export type NoteArgKind =
  | 'semitones'
  | 'cents'
  | 'seconds'
  | 'percent'
  | 'db'
  | 'pitch'
  | 'snap'
  | 'choice'
  | 'boolean'
  | 'index';

/** Each kind of argument's unit, as it's written after a number ("" for none). */
export const NOTE_ARG_UNITS: Record<NoteArgKind, string> = {
  semitones: 'semitones',
  cents: 'cents',
  seconds: 's',
  percent: '%',
  db: 'dB',
  pitch: '',
  snap: '',
  choice: '',
  boolean: '',
  index: '',
};

export interface NoteArg {
  /** Its name: a tool's argument, a command's flag (`--semitones`). */
  name: string;
  kind: NoteArgKind;
  /** What it is, in a line. */
  help: string;
  /** A number's range (a pitch's too, as MIDI). */
  min?: number;
  max?: number;
  /** What it is when left out; an argument with none and `required` must be given. */
  default?: number | string | boolean;
  required?: boolean;
  /** A `snap` or `choice` argument's values. */
  values?: readonly string[];
}

export type NoteArgValue = number | string | boolean;
export type NoteArgs = Readonly<Record<string, NoteArgValue | undefined>>;

/**
 * What an edit may need to know beyond the notes: for snapping to the key's scale and for the grid,
 * the song and region (or a scale); for `level`, the notes' levels.
 */
export interface NoteEditContext extends NoteSelectContext {
  project?: Pick<Project, 'tempo' | 'meter' | 'key' | 'keys'>;
  /** The scale to snap to, instead of the song's key where each note plays. */
  scale?: Scale | null;
  /**
   * Each note's level as recorded, dB of full scale by its index (null where it isn't known): measured
   * from the recording (the engine's `noteLevel`), as it isn't in the song. `level` needs them.
   */
  levels?: readonly (number | null)[];
  /**
   * The note `paste` and `copy-settings` copy from, when it isn't one of these notes (so its number,
   * `from`, isn't needed): one of the same recording copied in another region (the studio's clipboard,
   * another region named to the agent), or the note an edit linked across regions copies from.
   */
  source?: AudioNote;
  /**
   * The recording's notes as detection found them: `reset` gives a pasted note back its own pitch and
   * unvoiced start as found with them (a paste brings its sound's); without them those stay.
   */
  found?: readonly AudioNote[];
}

export interface NoteEdit {
  /** Its name, for good: the studio's tool, the agent's action and the `holo notes` command go by it. */
  name: string;
  /** What it does, in a sentence. */
  summary: string;
  /** The kinds of notes it applies to. */
  modes: readonly AudioNotesMode[];
  args: readonly NoteArg[];
  /** Whether it works on notes chosen first (else it chooses none: adding a note). */
  selection: boolean;
  /** It needs each note's level, measured from the recording (`levels` in its context); without them it doesn't apply. */
  needsLevels?: boolean;
  /**
   * It copies from another note: the argument that numbers it among these notes (`from`), which isn't
   * needed when its context gives the note (`source`).
   */
  source?: string;
  /** The notes edited: canonical, or the notes as they were when it doesn't apply. Arguments outside their ranges are brought in. */
  apply(notes: AudioNotes, indices: readonly number[], args: NoteArgs, ctx?: NoteEditContext): AudioNotes;
}

/** An edit as it's written below: its arguments come to `run` read, in range, with their defaults. */
interface Def extends Omit<NoteEdit, 'apply'> {
  run(notes: AudioNotes, indices: number[], args: Record<string, NoteArgValue>, ctx: NoteEditContext): AudioNotes;
}

const PITCHED: readonly AudioNotesMode[] = ['mono', 'poly'];
const LINE: readonly AudioNotesMode[] = ['mono'];
const ALL = AUDIO_NOTES_MODES;

const pct = (a: Record<string, NoteArgValue>, k: string) => (a[k] as number) / 100;

/** The note an edit copies from: the context's, else the one `from` numbers among these (from 1). */
function sourceOf(notes: AudioNotes, a: Record<string, NoteArgValue>, ctx: NoteEditContext): AudioNote | undefined {
  if (ctx.source) return ctx.source;
  return typeof a.from === 'number' ? notes.n[a.from - 1] : undefined;
}

/** The scale each note snaps to: the context's, else the song's key where the note's beat plays. */
function scalesOf(notes: AudioNotes, ctx: NoteEditContext): NoteScales {
  if (ctx.scale !== undefined) return ctx.scale;
  const { project, region } = ctx;
  if (!project || !region) return null;
  const tick = fileToTicks(project, { start: region.start, audio: region.audio && { ...region.audio, notes } });
  return (i) => {
    const n = notes.n[i] as AudioNote | undefined;
    return n ? scaleAt(project, tick(n.t + (n.u ?? 0))) : null;
  };
}

/** Each run of notes one after another, among indices in order. */
function runs(indices: readonly number[]): number[][] {
  const out: number[][] = [];
  for (const i of indices) {
    const run = out[out.length - 1];
    if (run && run[run.length - 1] === i - 1) run.push(i);
    else out.push([i]);
  }
  return out;
}

/** An edit made note by note, from the last (so splitting, joining or removing one leaves the others' places as they were). */
function eachFromLast(notes: AudioNotes, indices: readonly number[], edit: (n: AudioNotes, i: number) => AudioNotes) {
  let out = notes;
  for (const i of [...indices].reverse()) out = edit(out, i);
  return out;
}

/** What `reset` puts back, by name. */
const RESETS: Record<string, readonly NoteEditField[]> = {
  all: NOTE_EDIT_FIELDS,
  pitch: ['to'],
  drift: ['dr'],
  vibrato: ['mo'],
  transition: ['tr'],
  formant: ['fo'],
  gain: ['g'],
  mute: ['m'],
  time: ['ts', 'te', 'at'],
};

const DEFS: Def[] = [
  {
    name: 'shift',
    summary: 'Move notes’ pitch up or down by semitones and cents from where it is now, snapped if asked.',
    modes: PITCHED,
    selection: true,
    args: [
      { name: 'semitones', kind: 'semitones', min: -48, max: 48, default: 0, help: 'How far: up when above 0' },
      { name: 'cents', kind: 'cents', min: -100, max: 100, default: 0, help: 'And this much more, in cents' },
      {
        name: 'snap',
        kind: 'snap',
        values: PITCH_SNAPS,
        default: 'free',
        help: 'Where it lands: free (as moved), on a semitone, or on a note of the key’s scale',
      },
    ],
    run: (notes, idx, a, ctx) =>
      shiftNotes(
        notes,
        idx,
        (a.semitones as number) + (a.cents as number) / 100,
        a.snap as PitchSnap,
        a.snap === 'scale' ? scalesOf(notes, ctx) : null,
      ),
  },
  {
    name: 'set-pitch',
    summary: 'Tune notes to a pitch.',
    modes: PITCHED,
    selection: true,
    args: [
      {
        name: 'pitch',
        kind: 'pitch',
        min: 0,
        max: 127,
        required: true,
        help: 'The pitch: a note name (E4, F#3+20c) or a MIDI number (64.2)',
      },
    ],
    run: (notes, idx, a) => editNotes(notes, idx, { to: a.pitch as number }),
  },
  {
    name: 'drift',
    summary: 'Keep more or less of how notes’ pitch wanders slowly as they’re held.',
    modes: PITCHED,
    selection: true,
    args: [
      { name: 'keep', kind: 'percent', min: 0, max: 100, required: true, help: '100 as sung, 0 none: held steady' },
    ],
    run: (notes, idx, a) => editNotes(notes, idx, { dr: pct(a, 'keep') }),
  },
  {
    name: 'vibrato',
    summary: 'Make notes’ vibrato smaller or bigger.',
    modes: PITCHED,
    selection: true,
    args: [
      {
        name: 'keep',
        kind: 'percent',
        min: 0,
        max: 200,
        required: true,
        help: '100 as sung, 0 none, 200 twice as wide',
      },
    ],
    run: (notes, idx, a) => editNotes(notes, idx, { mo: pct(a, 'keep') }),
  },
  {
    name: 'transition',
    summary: 'Make the glide into notes from the note before quicker or slower.',
    modes: LINE,
    selection: true,
    args: [
      {
        name: 'length',
        kind: 'percent',
        min: 0,
        max: 300,
        required: true,
        help: '100 as sung, 0 a jump, 300 three times as long',
      },
    ],
    run: (notes, idx, a) => editNotes(notes, idx, { tr: pct(a, 'length') }),
  },
  {
    name: 'formant',
    summary: 'Move notes’ formant (the voice’s colour: bigger or smaller) while their pitch stays.',
    modes: PITCHED,
    selection: true,
    args: [
      { name: 'semitones', kind: 'semitones', min: -12, max: 12, required: true, help: 'Down darker, up brighter' },
    ],
    run: (notes, idx, a) => editNotes(notes, idx, { fo: a.semitones as number }),
  },
  {
    name: 'gain',
    summary: 'Set notes’ level.',
    modes: ALL,
    selection: true,
    args: [{ name: 'db', kind: 'db', min: -60, max: 24, required: true, help: 'Against as recorded: 0 as it was' }],
    run: (notes, idx, a) => editNotes(notes, idx, { g: a.db as number }),
  },
  {
    name: 'mute',
    summary: 'Mute notes.',
    modes: ALL,
    selection: true,
    args: [],
    run: (notes, idx) => editNotes(notes, idx, { m: true }),
  },
  {
    name: 'unmute',
    summary: 'Unmute notes.',
    modes: ALL,
    selection: true,
    args: [],
    run: (notes, idx) => editNotes(notes, idx, { m: null }),
  },
  {
    name: 'move',
    summary: 'Move notes earlier or later; the notes around them stretch or squeeze to make room.',
    modes: LINE,
    selection: true,
    args: [
      {
        name: 'seconds',
        kind: 'seconds',
        min: -MAX_MOVE_S,
        max: MAX_MOVE_S,
        required: true,
        help: 'How far: later when above 0 (as far as fits)',
      },
    ],
    run: (notes, idx, a) => moveNotes(notes, idx, a.seconds as number),
  },
  {
    name: 'resize',
    summary: 'Move notes’ start or end, stretching or squeezing them.',
    modes: LINE,
    selection: true,
    args: [
      { name: 'edge', kind: 'choice', values: ['start', 'end'], default: 'end', help: 'Which edge moves' },
      {
        name: 'seconds',
        kind: 'seconds',
        min: -MAX_MOVE_S,
        max: MAX_MOVE_S,
        required: true,
        help: 'How far it moves: later when above 0 (as far as fits)',
      },
    ],
    run: (notes, idx, a) => {
      const edge = a.edge as 'start' | 'end';
      let out = notes;
      for (const i of idx) {
        const n = out.n[i] as AudioNote;
        const now = edge === 'start' ? (n.ts ?? n.t) : (n.te ?? n.t + n.d);
        out = resizeNote(out, i, edge, now + (a.seconds as number));
      }
      return out;
    },
  },
  {
    name: 'attack',
    summary: 'Play notes’ attacks quicker or slower.',
    modes: LINE,
    selection: true,
    args: [
      {
        name: 'length',
        kind: 'percent',
        min: 25,
        max: 400,
        required: true,
        help: 'The attack’s length: 100 as sung, 50 in half the time',
      },
    ],
    run: (notes, idx, a) => setAttack(notes, idx, pct(a, 'length')),
  },
  {
    name: 'split',
    summary: 'Cut notes in two.',
    modes: PITCHED,
    selection: true,
    args: [
      {
        name: 'at',
        kind: 'seconds',
        min: 0,
        help: 'Where: seconds after the note starts (its middle when left out)',
      },
    ],
    run: (notes, idx, a) =>
      eachFromLast(notes, idx, (out, i) => {
        const n = out.n[i] as AudioNote;
        return splitNote(out, i, n.t + (typeof a.at === 'number' ? a.at : n.d / 2));
      }),
  },
  {
    name: 'join',
    summary: 'Join notes one after another into one; a single note joins the next.',
    modes: LINE,
    selection: true,
    args: [],
    run: (notes, idx) =>
      runs(idx)
        .reverse()
        .reduce((out, run) => {
          let joined = out;
          for (let k = 0; k < Math.max(1, run.length - 1); k++) joined = joinNotes(joined, run[0] as number);
          return joined;
        }, notes),
  },
  {
    name: 'boundary',
    summary: 'Move where a note ends and the next one, touching it, starts.',
    modes: LINE,
    selection: true,
    args: [
      {
        name: 'seconds',
        kind: 'seconds',
        min: -MAX_MOVE_S,
        max: MAX_MOVE_S,
        required: true,
        help: 'How far: later when above 0',
      },
    ],
    run: (notes, idx, a) =>
      eachFromLast(notes, idx, (out, i) => {
        const next = out.n[i + 1];
        return next ? moveBoundary(out, i, next.t + (a.seconds as number)) : out;
      }),
  },
  {
    name: 'octave',
    summary: 'Put right a note heard an octave off: its pitch as found moves an octave, its sound stays.',
    modes: PITCHED,
    selection: true,
    args: [{ name: 'direction', kind: 'choice', values: ['up', 'down'], required: true, help: 'Which way' }],
    run: (notes, idx, a) => eachFromLast(notes, idx, (out, i) => fixOctave(out, i, a.direction === 'down' ? -12 : 12)),
  },
  {
    name: 'add',
    summary: 'Add a note detection missed (in a line, in the gap where it starts).',
    modes: ALL,
    selection: false,
    args: [
      { name: 'start', kind: 'seconds', min: 0, required: true, help: 'Where it starts: seconds into the recording' },
      { name: 'length', kind: 'seconds', min: MIN_NOTE_S, max: 60, required: true, help: 'How long, seconds' },
      { name: 'pitch', kind: 'pitch', min: 0, max: 127, help: 'Its pitch (none for a breath or a hit)' },
    ],
    run: (notes, _idx, a) =>
      addNote(notes, a.start as number, a.length as number, typeof a.pitch === 'number' ? a.pitch : null),
  },
  {
    name: 'remove',
    summary: 'Take out notes detection heard wrongly: their sound plays as recorded.',
    modes: ALL,
    selection: true,
    args: [],
    run: (notes, idx) => eachFromLast(notes, idx, removeNote),
  },
  {
    name: 'reset',
    summary: 'Put notes back as they were found: every edit, or one kind.',
    modes: ALL,
    selection: true,
    args: [
      {
        name: 'what',
        kind: 'choice',
        values: Object.keys(RESETS),
        default: 'all',
        help: 'Which edits go back',
      },
    ],
    run: (notes, idx, a, ctx) => {
      const fields = RESETS[a.what as string] ?? NOTE_EDIT_FIELDS;
      const out = resetNotes(notes, idx, fields);
      return ctx.found && fields.includes('s') ? unpasteNotes(notes, out, idx, ctx.found) : out;
    },
  },
  {
    name: 'paste',
    summary:
      'Make notes play another note’s sound in their place (from the same recording), with its pitch as found; a note longer than it plays all of it stretched over the note, quiet at its end for a quarter of the difference.',
    modes: LINE,
    selection: true,
    source: 'from',
    args: [
      {
        name: 'from',
        kind: 'index',
        min: 1,
        required: true,
        help: 'The note whose sound is pasted: its number',
      },
    ],
    run: (notes, idx, a, ctx) => {
      const source = sourceOf(notes, a, ctx);
      return source ? pasteNotes(notes, idx, source) : notes;
    },
  },
  {
    name: 'copy-settings',
    summary:
      'Give notes another note’s edits: its drift, vibrato, glide, formant, level, mute and attack, and its pitch move from its nearest semitone.',
    modes: ALL,
    selection: true,
    source: 'from',
    args: [
      {
        name: 'from',
        kind: 'index',
        min: 1,
        required: true,
        help: 'The note whose edits are copied: its number',
      },
    ],
    run: (notes, idx, a, ctx) => {
      const source = sourceOf(notes, a, ctx);
      return source ? copySettings(notes, idx, source) : notes;
    },
  },
  {
    name: 'correct-pitch',
    summary:
      'Tune notes toward the nearest semitone or note of the key, and take out some of their drift, all at once.',
    modes: PITCHED,
    selection: true,
    args: [
      {
        name: 'centre',
        kind: 'percent',
        min: 0,
        max: 100,
        default: 100,
        help: 'How far each note’s centre moves to its pitch: 100 all the way, 0 not at all',
      },
      {
        name: 'drift',
        kind: 'percent',
        min: 0,
        max: 100,
        default: 0,
        help: 'How much of each note’s drift as sung is taken out: 0 none (left as it is), 100 all',
      },
      {
        name: 'snap',
        kind: 'snap',
        values: ['semitone', 'scale'],
        default: 'semitone',
        help: 'Where each note goes: the nearest semitone, or the nearest note of the key’s scale where it plays',
      },
      {
        name: 'tolerance',
        kind: 'cents',
        min: 0,
        max: 50,
        default: 0,
        help: 'Notes this close to their pitch already are left as they are (0: none are)',
      },
    ],
    run: (notes, idx, a, ctx) =>
      correctPitch(
        notes,
        idx,
        {
          centre: pct(a, 'centre'),
          drift: pct(a, 'drift'),
          snap: a.snap === 'scale' ? 'scale' : 'semitone',
          tolerance: a.tolerance as number,
        },
        a.snap === 'scale' ? scalesOf(notes, ctx) : null,
      ),
  },
  {
    name: 'quantize-time',
    summary: 'Move notes’ beats (where the voice starts, after a consonant) toward the song’s grid.',
    modes: LINE,
    selection: true,
    args: [
      {
        name: 'amount',
        kind: 'percent',
        min: 0,
        max: 100,
        default: 100,
        help: 'How far toward the grid: 100 onto it, 50 halfway',
      },
      {
        name: 'grid',
        kind: 'choice',
        values: Object.keys(DIVISIONS),
        default: '1/16',
        help: 'The grid, a note value: 1/8, 1/16, 1/8T a triplet, 1/16. dotted',
      },
    ],
    run: (notes, idx, a, ctx) =>
      ctx.project && ctx.region
        ? quantizeNotes(notes, idx, pct(a, 'amount'), DIVISIONS[a.grid as string] ?? 0, ctx.project, ctx.region)
        : notes,
  },
  {
    name: 'level',
    summary: 'Bring notes’ levels toward one level: their mean, or a level given.',
    modes: ALL,
    selection: true,
    needsLevels: true,
    args: [
      {
        name: 'amount',
        kind: 'percent',
        min: 0,
        max: 100,
        default: 100,
        help: 'How far toward it: 100 all the way, 50 halfway',
      },
      {
        name: 'target',
        kind: 'db',
        min: -60,
        max: 0,
        help: 'The level they go to, dB of full scale (their mean when left out)',
      },
    ],
    run: (notes, idx, a, ctx) =>
      ctx.levels
        ? levelNotes(notes, idx, ctx.levels, pct(a, 'amount'), typeof a.target === 'number' ? a.target : undefined)
        : notes,
  },
];

/**
 * What the studio, the agent and `holo notes` each offer beside the edits, by the same name (their
 * parity tests check these as they check the edits): `midi`, a region's notes made a new MIDI track
 * (`notesToMidi`).
 */
export const NOTE_EXTRAS: readonly string[] = ['midi'];

/** An argument as given, read: a number in its range, a pitch as MIDI, a value of its list; undefined when it can't be read. */
function readArg(def: NoteArg, v: unknown, middleC: MiddleC, strict: boolean): NoteArgValue | undefined {
  const lo = def.min ?? Number.NEGATIVE_INFINITY;
  const hi = def.max ?? Number.POSITIVE_INFINITY;
  const inRange = (x: number) => {
    if (strict && (x < lo || x > hi)) return undefined;
    return Math.min(hi, Math.max(lo, x));
  };
  switch (def.kind) {
    case 'boolean':
      if (typeof v === 'boolean') return v;
      if (v === 'true' || v === 'yes') return true;
      if (v === 'false' || v === 'no') return false;
      return undefined;
    case 'snap':
    case 'choice': {
      // (in any case: "1/8t" is the grid's "1/8T")
      const s = typeof v === 'string' ? v.trim().toLowerCase() : undefined;
      return s === undefined ? undefined : (def.values ?? []).find((x) => x.toLowerCase() === s);
    }
    case 'pitch': {
      let p: number | undefined;
      if (typeof v === 'number') p = v;
      else if (typeof v === 'string') {
        try {
          p = parseNoteName(v.trim(), middleC);
        } catch {
          return undefined;
        }
      }
      return p !== undefined && Number.isFinite(p) ? inRange(p) : undefined;
    }
    default: {
      const x = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : Number.NaN;
      if (!Number.isFinite(x)) return undefined;
      if (def.kind === 'index' && !Number.isInteger(x)) return undefined;
      return inRange(x);
    }
  }
}

/** A range as words: "-12 to 12 semitones", "0 or more s". */
function rangeText(def: NoteArg): string {
  const unit = NOTE_ARG_UNITS[def.kind];
  const u = unit ? ` ${unit}` : '';
  if (def.values) return `one of ${def.values.join(', ')}`;
  if (def.kind === 'pitch') return 'a note name (E4, F#3+20c) or a MIDI number';
  if (def.min !== undefined && def.max !== undefined) return `${def.min} to ${def.max}${u}`;
  if (def.min !== undefined) return `${def.min} or more${u}`;
  if (def.max !== undefined) return `${def.max} or less${u}`;
  return `a number${u}`;
}

/**
 * The arguments given to an edit, checked as the agent's tool and `holo notes` take them: each read
 * (numbers from text too, a pitch from its name), in its range, the defaults filled in. Anything
 * wrong (an argument it doesn't take, one missing, out of range) throws an error that says what.
 */
export function readNoteArgs(
  edit: Pick<NoteEdit, 'name' | 'args'>,
  given: Readonly<Record<string, unknown>>,
  middleC: MiddleC = 'C4',
): Record<string, NoteArgValue> {
  const problems: string[] = [];
  for (const k of Object.keys(given))
    if (given[k] !== undefined && !edit.args.some((d) => d.name === k))
      problems.push(
        `${edit.name} takes no "${k}"${edit.args.length ? ` (it takes ${edit.args.map((d) => d.name).join(', ')})` : ''}`,
      );
  const out: Record<string, NoteArgValue> = {};
  for (const def of edit.args) {
    const v = given[def.name];
    if (v === undefined || v === null) {
      if (def.default !== undefined) out[def.name] = def.default;
      else if (def.required) problems.push(`Say "${def.name}": ${def.help.toLowerCase()} (${rangeText(def)})`);
      continue;
    }
    const read = readArg(def, v, middleC, true);
    if (read === undefined) problems.push(`"${def.name}" is ${rangeText(def)} (got ${JSON.stringify(v)})`);
    else out[def.name] = read;
  }
  if (problems.length) throw new Error(problems.join('; '));
  return out;
}

/**
 * Arguments as `apply` takes them: read leniently (out of range brought in), defaults filled; null when
 * a required one is missing or can't be read (but `stoodFor`, which the context stands in for).
 */
function lenientArgs(
  def: Def,
  given: NoteArgs,
  middleC: MiddleC,
  stoodFor?: string,
): Record<string, NoteArgValue> | null {
  const out: Record<string, NoteArgValue> = {};
  for (const a of def.args) {
    const v = given[a.name];
    const read = v === undefined ? undefined : readArg(a, v, middleC, false);
    if (read !== undefined) out[a.name] = read;
    else if (a.default !== undefined) out[a.name] = a.default;
    else if (a.required && a.name !== stoodFor) return null;
  }
  return out;
}

/** Every edit of a recording's notes, in the order they're offered. */
export const NOTE_EDITS: readonly NoteEdit[] = DEFS.map(
  (def): NoteEdit => ({
    name: def.name,
    summary: def.summary,
    modes: def.modes,
    args: def.args,
    selection: def.selection,
    ...(def.needsLevels ? { needsLevels: true } : {}),
    ...(def.source ? { source: def.source } : {}),
    apply(notes, indices, args, ctx = {}) {
      if (!def.modes.includes(notes.mode)) return notes;
      const a = lenientArgs(def, args, ctx.middleC ?? 'C4', ctx.source ? def.source : undefined);
      if (!a) return notes;
      const idx = def.selection ? noteIndices(notes, indices) : [];
      if (def.selection && !idx.length) return notes;
      return def.run(notes, idx, a, ctx);
    },
  }),
);

/** The edits' names, in order: what the studio, the agent and `holo notes` must each offer. */
export const NOTE_EDIT_NAMES: readonly string[] = NOTE_EDITS.map((e) => e.name);

/** An edit by its name. */
export const noteEdit = (name: string): NoteEdit | undefined => NOTE_EDITS.find((e) => e.name === name);

/** The edits a list of names leaves out (for a test that the studio, the agent or `holo notes` offers every one). */
export function missingNoteEdits(offered: Iterable<string>): string[] {
  const have = new Set(offered);
  return NOTE_EDIT_NAMES.filter((n) => !have.has(n));
}

/** What beside the edits (`NOTE_EXTRAS`) a list of names leaves out, for the same tests. */
export function missingNoteExtras(offered: Iterable<string>): string[] {
  const have = new Set(offered);
  return NOTE_EXTRAS.filter((n) => !have.has(n));
}
