import { type AudioNote, type AudioNotes, NOTE_EDITS, type NoteEdit, noteEdit } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  macroArgs,
  macroControls,
  macroValues,
  meanLevel,
  NOTE_MACROS,
  notesLevels,
  valueText,
} from '../src/ui/note-macros.ts';

const edit = (name: string) => noteEdit(name) as NoteEdit;

describe('the Macros dialog, from the note edits', () => {
  it('offers the three macros, each a note edit, named for its undo step', () => {
    expect(NOTE_MACROS.map((m) => [m.edit, m.name])).toEqual([
      ['correct-pitch', 'Correct Pitch'],
      ['quantize-time', 'Quantize Time'],
      ['level', 'Level'],
    ]);
    for (const m of NOTE_MACROS) expect(NOTE_EDITS.map((e) => e.name)).toContain(m.edit);
  });

  it('makes a control of each argument: sliders for amounts, buttons or a list for a choice', () => {
    const pitch = macroControls(edit('correct-pitch'));
    expect(pitch.map((c) => [c.arg, c.kind, c.label])).toEqual([
      ['centre', 'slider', 'Centre'],
      ['drift', 'slider', 'Drift'],
      ['snap', 'choice', 'Snap'],
      ['tolerance', 'slider', 'Tolerance'],
    ]);
    expect(pitch[0]).toMatchObject({ min: 0, max: 100, step: 1, unit: '%', start: 100, optional: false });
    expect(pitch[2]).toMatchObject({
      values: [
        { value: 'semitone', label: 'Semitone' },
        { value: 'scale', label: 'Scale' },
      ],
      start: 'semitone',
      list: false,
    });
    expect(pitch[3]).toMatchObject({ unit: ' cents', max: 50, start: 0 });
    // the grid: too many note values for a row, so a list; named as the piano roll names them
    const [, grid] = macroControls(edit('quantize-time'));
    expect(grid).toMatchObject({ kind: 'choice', list: true, start: '1/16' });
    expect(grid?.kind === 'choice' && grid.values.map((v) => v.label)).toContain('1/8T');
  });

  it('switches off an argument a macro can do without, and starts it where it’s told when on', () => {
    const level = macroControls(edit('level'), { target: -17.5 });
    expect(level[1]).toMatchObject({
      arg: 'target',
      kind: 'slider',
      optional: true,
      start: -17.5,
      unit: ' dB',
      step: 0.5,
    });
    // (with nothing to start from: the middle of its range)
    expect(macroControls(edit('level'))[1]).toMatchObject({ start: -30 });
    const values = macroValues(level);
    expect(values).toEqual({ amount: 100, target: null });
    expect(macroArgs(values)).toEqual({ amount: 100 });
    expect(macroArgs({ ...values, target: -12 })).toEqual({ amount: 100, target: -12 });
  });

  it('gives a new argument a control by itself', () => {
    const more: Pick<NoteEdit, 'args'> = {
      args: [
        ...edit('correct-pitch').args,
        { name: 'keep', kind: 'boolean', default: true, help: 'Keep something' },
        { name: 'glide', kind: 'seconds', min: 0, max: 1, default: 0.2, help: 'A glide' },
      ],
    };
    const controls = macroControls(more);
    expect(controls.slice(4)).toMatchObject([
      { kind: 'switch', arg: 'keep', start: true },
      { kind: 'slider', arg: 'glide', step: 0.01, unit: ' s', start: 0.2 },
    ]);
    expect(macroArgs(macroValues(controls))).toEqual({
      centre: 100,
      drift: 0,
      snap: 'semitone',
      tolerance: 0,
      keep: true,
      glide: 0.2,
    });
  });

  it('comes to the arguments the agent and holo notes take, with the same result', () => {
    const notes: AudioNotes = {
      mode: 'mono',
      v: 1,
      n: [
        { t: 1, d: 0.5, p: 60.3 },
        { t: 2, d: 0.5, p: 61.8 },
      ],
    };
    const values = { ...macroValues(macroControls(edit('correct-pitch'))), centre: 80, drift: 40 };
    const dialog = edit('correct-pitch').apply(notes, [0, 1], macroArgs(values));
    const agent = edit('correct-pitch').apply(notes, [0, 1], { centre: 80, drift: 40 });
    expect(dialog).toEqual(agent);
    expect(dialog.n.map((n) => [n.to, n.dr])).toEqual([
      [60.06, 0.6],
      [61.96, 0.6],
    ]);
  });

  it('says each value as its control shows it', () => {
    const [centre, , snap] = macroControls(edit('correct-pitch'));
    const [, target] = macroControls(edit('level'));
    expect(valueText(centre as never, 80)).toBe('80%');
    expect(valueText(snap as never, 'scale')).toBe('Scale');
    expect(valueText(target as never, -12.5)).toBe('−12.5 dB');
    expect(valueText(target as never, null)).toBe('Off');
  });
});

describe('the notes’ levels, read from the curve they were found with', () => {
  /** A curve every 5 ms from 0.0025 s: silence, then a note at power 0.01 (−20 dB), then one at 0.04 (−14 dB). */
  const t: number[] = [];
  const power: number[] = [];
  for (let k = 0; k < 400; k++) {
    const at = 0.0025 + k * 0.005;
    t.push(at);
    power.push(at > 0.2 && at < 0.8 ? 0.01 : at > 1 && at < 1.6 ? 0.04 : 0);
  }
  const curve = { t: Float64Array.from(t), step: 0.005, power: Float64Array.from(power) };
  const notes: AudioNote[] = [
    { t: 0.2, d: 0.6, p: 60 },
    { t: 1, d: 0.6, p: 62 },
    { t: 1.7, d: 0.2, p: 64 },
  ];

  it('reads each in dB, the same list for the same notes and curve', () => {
    const levels = notesLevels(notes, curve);
    expect(levels).toEqual([-20, -13.98, null]);
    expect(notesLevels(notes, curve)).toBe(levels);
    expect(meanLevel(levels, [0, 1, 2])).toBeCloseTo(-16.99, 2);
    expect(meanLevel(levels, [2])).toBeNull();
  });
});
