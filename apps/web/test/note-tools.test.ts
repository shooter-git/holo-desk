import { type AudioNote, type AudioNotes, missingNoteEdits, NOTE_EDITS, noteEdit } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { capsuleHalf } from '../src/ui/note-lanes.ts';
import {
  AMOUNT_TOOLS,
  amountAfterDrag,
  amountGroups,
  attackAfterDrag,
  type BoxPlacing,
  dragSeconds,
  hitBoundary,
  hitNote,
  keyShiftArgs,
  lockAxis,
  missedSpan,
  NOTE_TOOLS,
  noteBoxes,
  notesInRect,
  shiftArgs,
  snapPitchTarget,
  snapTick,
  studioNoteEdits,
  unknownStudioEdits,
} from '../src/ui/note-tools.ts';

/** A line of notes: E4 (18 cents sharp) from 1 s, G4 touching it at 1.5 s, a breath, then A4 at 2.5 s. */
const line: AudioNote[] = [
  { t: 1, d: 0.5, p: 64.18, u: 0.04 },
  { t: 1.5, d: 0.4, p: 67 },
  { t: 2, d: 0.2, p: null },
  { t: 2.5, d: 0.6, p: 69 },
];
const notes: AudioNotes = { mode: 'mono', v: 1, n: line };

/** 100 pixels a second from 0 s, a semitone 10 pixels tall with MIDI 70 at the top. */
const placing: BoxPlacing = {
  xOf: (s) => s * 100,
  yOf: (p) => (70 - p) * 10 + 5,
  pitchOf: (n) => (n.p === null ? null : (n.to ?? n.p)),
  keyHeight: 10,
  from: 0,
  to: 1000,
};

describe('which note a pointer is on', () => {
  const boxes = noteBoxes(line, placing);

  it('places each note where it’s drawn, a breath at the pitch of the note nearest it', () => {
    expect(boxes.map((b) => [b.i, Math.round(b.x0), Math.round(b.x1)])).toEqual([
      [0, 100, 150],
      [1, 150, 190],
      [2, 200, 220],
      [3, 250, 310],
    ]);
    expect(boxes[0]?.y).toBeCloseTo(63.2, 6);
    // the breath sits at G4's height (the note before is as near as the one after: the one before)
    expect(boxes[2]?.y).toBe(boxes[1]?.y);
    expect(boxes[2]?.pitched).toBe(false);
    // the attack ends 60 ms after the consonant
    expect(boxes[0]?.attack).toBeCloseTo(110, 6);
  });

  it('keeps only the notes in the region’s span', () => {
    expect(noteBoxes(line, { ...placing, from: 160, to: 240 }).map((b) => b.i)).toEqual([1, 2]);
  });

  it('finds the note under the pointer, and which part of it', () => {
    const o = { touch: false, keyHeight: 10, edges: true };
    expect(hitNote(boxes, 125, 63, o)).toEqual({ i: 0, part: 'body' });
    expect(hitNote(boxes, 147, 63, o)).toEqual({ i: 0, part: 'end' });
    expect(hitNote(boxes, 102, 63, o)).toEqual({ i: 0, part: 'start' });
    // a tool that doesn't stretch notes has no ends to grab
    expect(hitNote(boxes, 147, 63, { ...o, edges: false })).toEqual({ i: 0, part: 'body' });
    // a lane above and below is nothing
    expect(hitNote(boxes, 125, 80, o)).toBeNull();
    expect(hitNote(boxes, 230, 35, o)).toBeNull();
  });

  it('gives a finger more room round a note and its ends', () => {
    expect(hitNote(boxes, 125, 77, { touch: false, keyHeight: 10 })).toBeNull();
    expect(hitNote(boxes, 125, 77, { touch: true, keyHeight: 10 })).toEqual({ i: 0, part: 'body' });
    expect(hitNote(boxes, 285, 15, { touch: true, keyHeight: 10, edges: true })).toEqual({ i: 3, part: 'body' });
    expect(hitNote(boxes, 299, 15, { touch: true, keyHeight: 10, edges: true })).toEqual({ i: 3, part: 'end' });
  });

  it('offers the attack handle to the Time tool, nearer than the note’s start', () => {
    const o = { touch: false, keyHeight: 10, edges: true, attack: true };
    expect(hitNote(boxes, 111, 63, o)).toEqual({ i: 0, part: 'attack' });
    expect(hitNote(boxes, 111, 63, { ...o, attack: false })).toEqual({ i: 0, part: 'body' });
  });

  it('picks the nearer of two notes that touch', () => {
    // at 150 px E4 ends and G4 starts, three semitones higher: the pointer's height chooses
    expect(hitNote(boxes, 150, 63, { touch: true, keyHeight: 10 })?.i).toBe(0);
    expect(hitNote(boxes, 150, 35, { touch: true, keyHeight: 10 })?.i).toBe(1);
  });

  it('finds where two notes that touch meet, and only there', () => {
    expect(hitBoundary(boxes, line, 152, 50, { touch: false, keyHeight: 10 })).toBe(0);
    expect(hitBoundary(boxes, line, 160, 50, { touch: false, keyHeight: 10 })).toBeNull();
    expect(hitBoundary(boxes, line, 160, 50, { touch: true, keyHeight: 10 })).toBe(0);
    // G4 and the breath don't touch: no boundary there
    expect(hitBoundary(boxes, line, 195, 35, { touch: true, keyHeight: 10 })).toBeNull();
  });

  it('selects what a marquee touches', () => {
    expect(notesInRect(boxes, 140, 12, 260, 40)).toEqual([1, 2, 3]);
    expect(notesInRect(boxes, 260, 40, 140, 12)).toEqual([1, 2, 3]);
    // A4's lane is above: a marquee short of it leaves it out
    expect(notesInRect(boxes, 140, 22, 260, 40)).toEqual([1, 2]);
    expect(notesInRect(boxes, 0, 0, 90, 200)).toEqual([]);
  });
});

describe('a capsule’s thickness', () => {
  it('stays within its lane', () => {
    expect(capsuleHalf(14, 500)).toBeCloseTo(6.65, 6);
    expect(capsuleHalf(5, 500)).toBe(2.375);
  });

  it('is never more than a share of its length: a short note is a slim pill, not a bubble', () => {
    expect(capsuleHalf(14, 10)).toBe(2);
    expect(2 * capsuleHalf(14, 20)).toBe(8);
    expect(2 * capsuleHalf(40, 12)).toBeLessThan(0.5 * 12);
    expect(capsuleHalf(14, 1)).toBe(1);
  });
});

describe('which way a drag goes', () => {
  it('waits until it has gone far enough to tell', () => {
    expect(lockAxis(3, 4)).toBeNull();
    expect(lockAxis(5, 1)).toBeNull();
    expect(lockAxis(6, 1)).toBe('x');
    expect(lockAxis(1, -7)).toBe('y');
    expect(lockAxis(8, 8, 12)).toBeNull();
    // as far across as up and down: across
    expect(lockAxis(5, 5)).toBe('x');
  });
});

describe('a drag’s arguments for the note edits', () => {
  it('moves pitches snapped as chosen, or free with Alt', () => {
    expect(shiftArgs(1.8, 'semitone', false)).toEqual({ semitones: 1.8, snap: 'semitone' });
    expect(shiftArgs(1.8, 'scale', true)).toEqual({ semitones: 1.8, snap: 'free' });
    const shift = noteEdit('shift');
    // dragged up 1.8 semitones from 64.18: snapped onto F#4, or left at 65.98
    expect(shift?.apply(notes, [0], shiftArgs(1.8, 'semitone', false)).n[0]?.to).toBe(66);
    expect(shift?.apply(notes, [0], shiftArgs(1.8, 'semitone', true)).n[0]?.to).toBe(65.98);
  });

  it('moves a semitone with the keys, or 10 cents with Shift', () => {
    const shift = noteEdit('shift');
    expect(shift?.apply(notes, [0], keyShiftArgs(1, false, 'semitone')).n[0]?.to).toBe(65);
    expect(shift?.apply(notes, [0], keyShiftArgs(-1, true, 'semitone')).n[0]?.to).toBe(64.08);
    expect(shift?.apply(notes, [0], keyShiftArgs(1, false, 'free')).n[0]?.to).toBe(65.18);
  });

  it('moves a time onto the grid, or as dragged', () => {
    // 960 ticks a second, from 0
    const toTick = (s: number) => s * 960;
    const toSeconds = (t: number) => t / 960;
    // a beat at 1.04 s dragged 300 ticks later lands on the quarter (240 ticks) nearest 1298.4: 1200
    expect(dragSeconds(1.04, 300, 240, false, toTick, toSeconds)).toBeCloseTo(1200 / 960 - 1.04, 9);
    expect(dragSeconds(1.04, 300, 240, true, toTick, toSeconds)).toBeCloseTo(1298 / 960 - 1.04, 9);
    expect(snapTick(1298.4, 240, false)).toBe(1200);
    expect(snapTick(1298.4, 0, false)).toBe(1298);
  });

  it('makes an attack slower dragged later, quicker earlier, within a quarter and four times', () => {
    // a long note's attack is 60 ms
    expect(attackAfterDrag({ d: 1 }, 0.06)).toBeCloseTo(2, 9);
    expect(attackAfterDrag({ d: 1, at: 2 }, -0.09)).toBeCloseTo(0.5, 9);
    expect(attackAfterDrag({ d: 1 }, -1)).toBe(0.25);
    expect(attackAfterDrag({ d: 1 }, 1)).toBe(4);
    // a short note's is a third of it
    expect(attackAfterDrag({ d: 0.09 }, 0.03)).toBeCloseTo(2, 9);
  });

  it('turns a drag up or down into an amount, each note from its own', () => {
    const vibrato = AMOUNT_TOOLS.vibrato;
    expect(amountAfterDrag(vibrato, 1, -40)).toBeCloseTo(1.4, 9);
    expect(amountAfterDrag(vibrato, 1, 500)).toBe(0);
    expect(amountAfterDrag(AMOUNT_TOOLS.gain, 0, -17)).toBeCloseTo(3.4, 9);
    expect(amountAfterDrag(AMOUNT_TOOLS.formant, 0, -18)).toBeCloseTo(1.5, 9);
    const mixed: AudioNote[] = [
      { t: 0, d: 1, p: 60 },
      { t: 1, d: 1, p: 62, mo: 0.5 },
      { t: 2, d: 1, p: 64 },
    ];
    expect(amountGroups(vibrato, mixed, [0, 1, 2], -20)).toEqual([
      [1.2, [0, 2]],
      [0.7, [1]],
    ]);
  });

  it('snaps a pitch to its target on a double-click, never leaving it free', () => {
    expect(snapPitchTarget({ p: 64.18 }, 'free', null)).toBe(64);
    expect(snapPitchTarget({ p: 64.18, to: 65.6 }, 'semitone', null)).toBe(66);
    // C major: F# isn't in it, F and G are; 66.4 is nearer G
    const cMajor = { tonic: 0, steps: [0, 2, 4, 5, 7, 9, 11], name: 'C major' };
    expect(snapPitchTarget({ p: 66.4 }, 'scale', cMajor)).toBe(67);
    expect(snapPitchTarget({ p: null }, 'semitone', null)).toBeNull();
  });
});

describe('a note detection missed', () => {
  // the pitch every 5 ms from 0 to 4 s: voiced (B4, 71) from 3.2 s to 3.5 s, else not
  const t = Float64Array.from({ length: 800 }, (_, k) => k * 0.005);
  const midi = Float64Array.from(t, (x) => (x >= 3.2 && x < 3.5 ? 71 + (x > 3.35 ? 0.1 : 0) : Number.NaN));

  it('goes over the voiced stretch round the pointer, at its middle pitch', () => {
    const span = missedSpan(line, { t, midi }, 3.3);
    expect(span?.t).toBeCloseTo(3.2, 9);
    expect(span?.t !== undefined && span.t + span.d).toBeCloseTo(3.5, 6);
    expect(span?.p).toBe(71);
  });

  it('has no pitch where the recording isn’t voiced, close round the pointer', () => {
    const span = missedSpan(line, { t, midi }, 3.8);
    expect(span).toMatchObject({ p: null });
    expect(span?.t).toBeCloseTo(3.65, 9);
    expect(span?.d).toBeCloseTo(0.3, 9);
  });

  it('stays in the gap between the notes either side', () => {
    // 2.3 s: between the breath (to 2.2 s) and A4 (from 2.5 s)
    const span = missedSpan(line, null, 2.3);
    expect(span?.t).toBeCloseTo(2.2, 9);
    expect(span?.d).toBeCloseTo(0.25, 9);
  });

  it('isn’t found inside a note', () => {
    expect(missedSpan(line, { t, midi }, 1.2)).toBeNull();
  });

  it('makes a note the add edit takes', () => {
    const span = missedSpan(line, { t, midi }, 3.3);
    if (!span) throw new Error('no span');
    const added = noteEdit('add')?.apply(notes, [], { start: span.t, length: span.d, pitch: span.p ?? undefined });
    expect(added?.n).toHaveLength(5);
    expect(added?.n[4]).toEqual({ t: 3.2, d: 0.3, p: 71 });
  });
});

describe('the studio offers every note edit', () => {
  const offered = studioNoteEdits();

  it('has a control for each edit in NOTE_EDITS, by name', () => {
    expect(missingNoteEdits(offered.keys())).toEqual([]);
    expect(unknownStudioEdits()).toEqual([]);
    for (const edit of NOTE_EDITS) expect(offered.get(edit.name)?.length, edit.name).toBeGreaterThan(0);
  });

  it('says which control offers each', () => {
    expect(Object.fromEntries(offered)).toEqual({
      shift: ['Pointer tool', 'Pitch tool', '↑ / ↓ key'],
      'set-pitch': ['Pointer tool', 'Pitch tool', 'menu'],
      move: ['Pointer tool', 'Time tool'],
      resize: ['Pointer tool', 'Time tool'],
      vibrato: ['Vibrato tool'],
      reset: [
        'Vibrato tool',
        'Drift tool',
        'Transition tool',
        'Formant tool',
        'Gain tool',
        'Time tool',
        'menu',
        'Delete key',
      ],
      drift: ['Drift tool'],
      transition: ['Transition tool'],
      formant: ['Formant tool'],
      gain: ['Gain tool'],
      attack: ['Time tool'],
      split: ['Split tool', 'menu'],
      boundary: ['Split tool'],
      join: ['Split tool', 'menu'],
      mute: ['menu', 'M key'],
      unmute: ['menu', 'M key'],
      octave: ['menu'],
      add: ['menu'],
      remove: ['menu'],
    });
  });

  it('would miss an edit added to NOTE_EDITS without a control', () => {
    expect(missingNoteEdits([...offered.keys()].filter((e) => e !== 'attack'))).toEqual(['attack']);
  });

  it('has each tool’s amount edit among its edits', () => {
    for (const [id, def] of Object.entries(AMOUNT_TOOLS)) {
      const tool = NOTE_TOOLS.find((t) => t.id === id);
      expect(tool?.edits).toContain(def.edit);
      expect(tool?.edits).toContain('reset');
      expect(noteEdit(def.edit)?.args.some((a) => a.name === def.arg)).toBe(true);
    }
  });
});
