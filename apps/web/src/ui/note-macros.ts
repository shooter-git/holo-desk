/**
 * The Macros dialog (NoteMacros.tsx), as plain arithmetic: which macros it offers (each a note edit of
 * NOTE_EDITS), the controls each one's arguments make (a slider for an amount, a row of buttons or a
 * list for a choice, a switch for an argument it can do without), the arguments a dialog's values
 * come to, and each note's level as recorded, read from the curve the Notes view found it with.
 * Everything comes from the registry's arguments, so an argument added to a macro is a control here.
 */
import { noteLevel } from '@holo/engine/notes';
import { type AudioNote, NOTE_ARG_UNITS, type NoteArg, type NoteArgs, type NoteEdit } from '@holo/session';

/** The macros the dialog offers, in its order: each its note edit's name, and its undo step's. */
export const NOTE_MACROS: readonly { edit: string; name: string }[] = [
  { edit: 'correct-pitch', name: 'Correct Pitch' },
  { edit: 'quantize-time', name: 'Quantize Time' },
  { edit: 'level', name: 'Level' },
];

export type MacroControl =
  | {
      kind: 'slider';
      arg: string;
      label: string;
      help: string;
      min: number;
      max: number;
      step: number;
      /** Its unit after the number ("%", " cents", " dB"). */
      unit: string;
      /** Where it starts: its default; for one it can do without, where it starts when switched on. */
      start: number;
      /** It can be left out (switched off): the macro does without it. */
      optional: boolean;
    }
  | {
      kind: 'choice';
      arg: string;
      label: string;
      help: string;
      values: readonly { value: string; label: string }[];
      start: string;
      /** A row of buttons, or a list where there are too many for a row. */
      list: boolean;
    }
  | { kind: 'switch'; arg: string; label: string; help: string; start: boolean };

/** A word of an argument's name, as a control's label: "centre" → "Centre". */
const labelOf = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/** How a choice's value reads on its button: "semitone" → "Semitone"; a grid's note value as it is. */
const valueLabel = (v: string) => (/^[a-z]/.test(v) ? labelOf(v) : v);

/** A slider's step, by the kind of its amount. */
const STEPS: Partial<Record<NoteArg['kind'], number>> = {
  percent: 1,
  cents: 1,
  db: 0.5,
  semitones: 0.1,
  seconds: 0.01,
  pitch: 1,
  index: 1,
};

/** More values than this make a list rather than a row of buttons. */
const ROW = 4;

/**
 * The controls a macro's arguments make, in their order. `starts` sets where a slider an argument
 * can do without starts when it's switched on (the dialog gives `level`'s target the notes' mean).
 */
export function macroControls(
  edit: Pick<NoteEdit, 'args'>,
  starts: Readonly<Record<string, number>> = {},
): MacroControl[] {
  return edit.args.map((a): MacroControl => {
    const label = labelOf(a.name);
    if (a.kind === 'boolean') return { kind: 'switch', arg: a.name, label, help: a.help, start: a.default === true };
    if (a.values) {
      const start = typeof a.default === 'string' ? a.default : (a.values[0] as string);
      return {
        kind: 'choice',
        arg: a.name,
        label,
        help: a.help,
        values: a.values.map((value) => ({ value, label: valueLabel(value) })),
        start,
        list: a.values.length > ROW,
      };
    }
    const min = a.min ?? 0;
    const max = a.max ?? Math.max(min + 1, 100);
    const unit = NOTE_ARG_UNITS[a.kind];
    const step = STEPS[a.kind] ?? 1;
    const fallback = starts[a.name] ?? (min + max) / 2;
    const start = typeof a.default === 'number' ? a.default : Math.round(fallback / step) * step;
    return {
      kind: 'slider',
      arg: a.name,
      label,
      help: a.help,
      min,
      max,
      step,
      unit: unit === '%' ? '%' : unit ? ` ${unit}` : '',
      start: Math.min(max, Math.max(min, start)),
      optional: a.default === undefined && !a.required,
    };
  });
}

/** A dialog's values: each control's, by its argument (null: one it can do without, switched off). */
export type MacroValues = Record<string, number | string | boolean | null>;

/** Each control where it starts: an argument it can do without starts switched off. */
export function macroValues(controls: readonly MacroControl[]): MacroValues {
  const out: MacroValues = {};
  for (const c of controls) out[c.arg] = c.kind === 'slider' && c.optional ? null : c.start;
  return out;
}

/** The macro's arguments a dialog's values come to (those switched off left out, so the macro does without them). */
export function macroArgs(values: Readonly<MacroValues>): NoteArgs {
  const out: Record<string, number | string | boolean> = {};
  for (const [k, v] of Object.entries(values)) if (v !== null) out[k] = v;
  return out;
}

/** A value as its control shows it: "80%", "−12.5 dB", "Scale". */
export function valueText(c: MacroControl, v: number | string | boolean | null): string {
  if (v === null) return 'Off';
  if (c.kind === 'switch') return v ? 'On' : 'Off';
  if (c.kind === 'choice') return c.values.find((x) => x.value === v)?.label ?? String(v);
  const n = Number(v);
  const digits = c.step < 1 ? (c.step < 0.1 ? 2 : 1) : 0;
  return `${n < 0 ? '−' : ''}${Math.abs(n).toFixed(digits)}${c.unit}`;
}

/** The curve the Notes view found a recording's notes with, as far as levels go: its first time and step, and its power. */
export interface LevelCurve {
  t: ArrayLike<number>;
  step: number;
  power: ArrayLike<number>;
}

const levelsKept = new WeakMap<readonly AudioNote[], { curve: LevelCurve; levels: (number | null)[] }>();

/**
 * Each note's level as recorded (dB of full scale, by index; null where there's nothing to read), read
 * from the found curve by the engine's `noteLevel`, as the host reads it for the agent: worked out
 * once per list of notes and curve.
 */
export function notesLevels(notes: readonly AudioNote[], curve: LevelCurve): (number | null)[] {
  const kept = levelsKept.get(notes);
  if (kept?.curve === curve) return kept.levels;
  const shape = { t0: (curve.t[0] as number | undefined) ?? 0, step: curve.step, power: curve.power };
  const levels = notes.map((n) => noteLevel(n, shape));
  levelsKept.set(notes, { curve, levels });
  return levels;
}

/** The mean of the levels known among some notes (null when none is), for where a target starts. */
export function meanLevel(levels: readonly (number | null)[], indices: readonly number[]): number | null {
  let sum = 0;
  let count = 0;
  for (const i of indices) {
    const l = levels[i];
    if (typeof l !== 'number') continue;
    sum += l;
    count++;
  }
  return count ? sum / count : null;
}
