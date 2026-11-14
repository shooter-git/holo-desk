import { describe, expect, it } from 'vitest';
import {
  AUDIO_NOTES_MODES,
  type AudioNote,
  type AudioNotes,
  type AudioNotesMode,
  addNote,
  applyOp,
  canonicalNotes,
  describeChanges,
  describeProject,
  editNotes,
  fileToTick,
  fileToTicks,
  fixOctave,
  joinNotes,
  MAX_WARP,
  mergeNotes,
  missingNoteEdits,
  moveBoundary,
  moveNotes,
  NOTE_EDIT_NAMES,
  NOTE_EDITS,
  type NoteArgs,
  type NoteEdit,
  newAudioTrack,
  newProject,
  newRegion,
  noteChanges,
  noteChangesText,
  noteEdit,
  notesCompatible,
  PPQ,
  type Project,
  parseAudioNotes,
  parseProject,
  pruneNotes,
  type Region,
  readNoteArgs,
  removeNote,
  resetNotes,
  resizeNote,
  type Scale,
  scaleAt,
  selectNotes,
  setAttack,
  shiftNotes,
  snapTarget,
  splitNote,
  splitRegionAt,
  tickToFile,
  warpAt,
  warpOf,
  warpProblem,
} from '../src/index.ts';

const mono = (n: unknown[]): AudioNotes => parseAudioNotes({ mode: 'mono', v: 1, n }) as AudioNotes;
const poly = (n: unknown[]): AudioNotes => parseAudioNotes({ mode: 'poly', v: 1, n }) as AudioNotes;

/** A line: a note with a consonant, one straight after it (legato), a rest, a breath, a last note. */
const LINE = mono([
  { t: 1, d: 0.5, p: 60.12, u: 0.05 },
  { t: 1.5, d: 0.4, p: 62 },
  { t: 2.2, d: 0.5, p: 64.3 },
  { t: 3, d: 0.3, p: null },
  { t: 3.5, d: 0.6, p: 67 },
]);

const CHORDS = poly([
  { t: 1, d: 1, p: 60 },
  { t: 1, d: 1, p: 64.2 },
  { t: 1, d: 1, p: 67 },
  { t: 2, d: 0.5, p: null },
]);

/** What a song keeps: read back, the notes are the same to the bit, and no edit is left that changes nothing. */
function expectCanonical(notes: AudioNotes): void {
  expect(parseAudioNotes(JSON.parse(JSON.stringify(notes)))).toEqual(notes);
  for (const n of notes.n) {
    if (n.p !== null) expect(n.to).not.toBe(n.p);
    for (const f of ['dr', 'mo', 'tr', 'at'] as const) expect(n[f]).not.toBe(1);
    for (const f of ['fo', 'g'] as const) expect(n[f]).not.toBe(0);
    expect(n.ts).not.toBe(n.t);
    expect(n.te).not.toBe(Math.round((n.t + n.d) * 1e4) / 1e4);
    expect(n.m).not.toBe(false);
  }
  if (notes.mode === 'mono') expect(warpProblem(warpOf(notes))).toBe(-1);
}

/** The notes not named (nor next to one named) are the same objects as before. */
function expectShared(before: AudioNotes, after: AudioNotes, edited: number[]): void {
  expect(after.n).toHaveLength(before.n.length);
  before.n.forEach((n, i) => {
    if (edited.some((e) => Math.abs(e - i) <= 1)) return;
    expect(after.n[i]).toBe(n);
  });
}

describe('setting notes’ edits', () => {
  it('sets edits on several notes, each in its range, leaving the rest as the same objects', () => {
    const out = editNotes(LINE, [0, 2], { to: 61, dr: 0.4, mo: 3, fo: -20, g: -3.333 });
    expect(out.n[0]).toEqual({ t: 1, d: 0.5, p: 60.12, u: 0.05, to: 61, dr: 0.4, mo: 2, fo: -12, g: -3.33 });
    expect(out.n[2]).toMatchObject({ to: 61, dr: 0.4, mo: 2, fo: -12, g: -3.33 });
    for (const i of [1, 3, 4]) expect(out.n[i]).toBe(LINE.n[i]);
    expect(LINE.n[0]).toEqual({ t: 1, d: 0.5, p: 60.12, u: 0.05 });
    expectCanonical(out);
  });

  it('gives a note with no pitch its level and mute only, and a chord’s notes no glide', () => {
    expect(editNotes(LINE, [3], { to: 60, dr: 0, tr: 2, fo: 2 })).toBe(LINE);
    expect(editNotes(LINE, [3], { g: -6, m: true }).n[3]).toEqual({ t: 3, d: 0.3, p: null, g: -6, m: true });
    expect(editNotes(CHORDS, [1], { tr: 2 })).toBe(CHORDS);
    expect(editNotes(CHORDS, [1], { to: 64 }).n[1]).toEqual({ t: 1, d: 1, p: 64.2, to: 64 });
  });

  it('leaves no edit that changes nothing, and gives the notes back as they were when nothing changes', () => {
    expect(editNotes(LINE, [0], { to: 60.12, dr: 1, mo: 1, tr: 1, fo: 0, g: 0, m: false })).toBe(LINE);
    const tuned = editNotes(LINE, [0, 1], { to: 63, g: 2, m: true });
    const back = editNotes(tuned, [0, 1], { to: null, g: 0, m: null });
    expect(back).toEqual(LINE);
    expect(back.n[2]).toBe(LINE.n[2]);
    expect(editNotes(LINE, [], { to: 50 })).toBe(LINE);
    expect(editNotes(LINE, [9, -1, 1.5], { to: 50 })).toBe(LINE);
  });
});

describe('snapping a pitch', () => {
  const cMajor: Scale = { tonic: 0, steps: [0, 2, 4, 5, 7, 9, 11], name: 'C major' };
  const dMajor: Scale = { tonic: 2, steps: [0, 2, 4, 5, 7, 9, 11], name: 'D major' };

  it('keeps it free (to 0.1 cent), on the nearest semitone, or on the nearest note of the scale', () => {
    expect(snapTarget(64.18349, 'free')).toBe(64.183);
    expect(snapTarget(64.6, 'semitone')).toBe(65);
    expect(snapTarget(61.4, 'scale', cMajor)).toBe(62);
    expect(snapTarget(65, 'scale', dMajor)).toBe(66);
    // no scale: the nearest semitone
    expect(snapTarget(61.4, 'scale', null)).toBe(61);
    expect(snapTarget(200, 'semitone')).toBe(127);
  });

  it('goes the way it leans when it’s halfway', () => {
    expect(snapTarget(61, 'scale', cMajor)).toBe(62);
    expect(snapTarget(61, 'scale', cMajor, 1)).toBe(62);
    expect(snapTarget(61, 'scale', cMajor, -1)).toBe(60);
    expect(snapTarget(61.5, 'semitone', null, -1)).toBe(61);
  });

  it('finds the scale of the song’s key where a note plays', () => {
    const p = newProject('Keys');
    p.key = 'A minor';
    p.keys = [
      { tick: 0, fifths: 0, mode: 'minor' },
      { tick: 8 * 4 * PPQ, fifths: -2, mode: 'major' },
    ];
    expect(scaleAt(p, 0)).toEqual({ tonic: 9, steps: [0, 2, 3, 5, 7, 8, 10], name: 'A minor' });
    expect(scaleAt(p, 9 * 4 * PPQ)).toEqual({ tonic: 10, steps: [0, 2, 4, 5, 7, 9, 11], name: 'Bb major' });
    expect(scaleAt({ key: 'F# dorian' }, 0)).toMatchObject({ tonic: 6, name: 'F# dorian' });
    expect(scaleAt({ key: null }, 0)).toBeNull();
  });
});

describe('moving pitches', () => {
  const cMajor: Scale = { tonic: 0, steps: [0, 2, 4, 5, 7, 9, 11], name: 'C major' };

  it('shifts from where a note is now, snapped as asked; a note with no pitch stays', () => {
    expect(shiftNotes(LINE, [0], 2).n[0]?.to).toBe(62.12);
    expect(shiftNotes(LINE, [0], 2, 'semitone').n[0]?.to).toBe(62);
    expect(shiftNotes(LINE, [2], 1, 'scale', cMajor).n[2]?.to).toBe(65);
    const tuned = editNotes(LINE, [2], { to: 63 });
    expect(shiftNotes(tuned, [2], -1, 'scale', cMajor).n[2]?.to).toBe(62);
    // by each note's own scale
    expect(shiftNotes(LINE, [0, 2], 0.5, 'scale', (i) => (i === 0 ? cMajor : null)).n.map((n) => n.to)).toEqual([
      60,
      undefined,
      65,
      undefined,
      undefined,
    ]);
    expect(shiftNotes(LINE, [3], 5)).toBe(LINE);
    expectCanonical(shiftNotes(LINE, [0, 1, 2, 3, 4], 3.5, 'semitone'));
  });

  it('snaps in place with no shift, and comes back to nothing at where it was found', () => {
    expect(shiftNotes(LINE, [0], 0, 'semitone').n[0]?.to).toBe(60);
    const up = shiftNotes(LINE, [1], 2);
    expect(shiftNotes(up, [1], -2)).toEqual(LINE);
  });

  it('puts an octave right without changing what it sounds like', () => {
    const tuned = editNotes(LINE, [2], { to: 65 });
    const fixed = fixOctave(tuned, 2, 12);
    expect(fixed.n[2]).toMatchObject({ p: 76.3, to: 77 });
    expect((fixed.n[2]?.to as number) - (fixed.n[2]?.p as number)).toBeCloseTo(65 - 64.3, 9);
    expect(fixOctave(LINE, 0, -12).n[0]).toEqual({ ...LINE.n[0], p: 48.12 });
    expect(fixOctave(LINE, 3, 12)).toBe(LINE);
    expect(fixOctave(LINE, 4, 72)).toBe(LINE);
    expect(fixOctave(LINE, 0, 0)).toBe(LINE);
    expectCanonical(fixed);
  });
});

describe('moving notes in time', () => {
  it('moves a note and the sound under it; the rests either side absorb it', () => {
    const out = moveNotes(LINE, [2], 0.1);
    expect(out.n[2]).toEqual({ t: 2.2, d: 0.5, p: 64.3, ts: 2.3, te: 2.8 });
    expectShared(LINE, out, [2]);
    expectCanonical(out);
    // back again: nothing left
    expect(moveNotes(out, [2], -0.1)).toEqual(LINE);
  });

  it('makes a move that doesn’t fit as far as it fits, never letting it go', () => {
    const out = moveNotes(LINE, [2], 2);
    const ts = out.n[2]?.ts as number;
    expect(ts).toBeGreaterThan(2.2);
    expect(ts).toBeLessThan(3);
    expectCanonical(out);
    // it went as far as it could: no further
    expect(moveNotes(out, [2], 0.001)).toBe(out);
    // and not past what any note may move (4 s)
    expect(moveNotes(LINE, [4], 10).n[4]?.ts).toBeLessThanOrEqual(3.5 + 4);
  });

  it('keeps a legato line joined: a neighbour that touches follows at that edge', () => {
    const out = moveNotes(LINE, [1], 0.05);
    expect(out.n[1]).toMatchObject({ ts: 1.55, te: 1.95 });
    // the note before ends where it now starts
    expect(out.n[0]).toEqual({ ...LINE.n[0], te: 1.55 });
    expectCanonical(out);
    // two moved together move as one
    const both = moveNotes(LINE, [0, 1], -0.1);
    expect(both.n[0]).toMatchObject({ ts: 0.9, te: 1.4 });
    expect(both.n[1]).toMatchObject({ ts: 1.4, te: 1.8 });
    expectCanonical(both);
  });

  it('moves only a line’s notes, and nothing for no time', () => {
    expect(moveNotes(CHORDS, [0], 0.1)).toBe(CHORDS);
    expect(moveNotes(LINE, [2], 0)).toBe(LINE);
    expect(moveNotes(LINE, [], 0.1)).toBe(LINE);
  });

  it('stretches a note by one edge, as far as the warp lets it', () => {
    const longer = resizeNote(LINE, 2, 'end', 2.8);
    expect(longer.n[2]).toEqual({ ...LINE.n[2], te: 2.8 });
    expectCanonical(longer);
    // into the rest before the breath: the rest squeezes to a quarter at most (its middle stays), so 2.88
    expect(resizeNote(LINE, 2, 'end', 2.95).n[2]?.te).toBe(2.88);
    // squeezed past a quarter of its length: as far as it goes
    const short = resizeNote(LINE, 2, 'end', 2.25);
    const te = short.n[2]?.te as number;
    expect(te - 2.2).toBeGreaterThanOrEqual(0.5 / MAX_WARP - 1e-9);
    expect(te).toBeLessThan(2.7);
    expectCanonical(short);
    // a start moved earlier takes the legato note before with it
    const early = resizeNote(LINE, 1, 'start', 1.45);
    expect(early.n[1]).toEqual({ ...LINE.n[1], ts: 1.45 });
    expect(early.n[0]).toEqual({ ...LINE.n[0], te: 1.45 });
    expectCanonical(early);
    expect(resizeNote(LINE, 2, 'end', 2.7)).toBe(LINE);
    expect(resizeNote(CHORDS, 0, 'end', 2.5)).toBe(CHORDS);
  });

  it('plays an attack quicker or slower, and as sung leaves nothing', () => {
    const out = setAttack(LINE, [0, 2], 0.5);
    expect(out.n[0]?.at).toBe(0.5);
    expect(out.n[2]?.at).toBe(0.5);
    expectCanonical(out);
    expect(setAttack(out, [0, 2], 1)).toEqual(LINE);
    expect(setAttack(LINE, [0], 1)).toBe(LINE);
    expect(setAttack(CHORDS, [0], 2)).toBe(CHORDS);
  });
});

describe('splitting and joining', () => {
  it('cuts a note in two that touch, both with its pitch and edits, the first with its consonant and glide', () => {
    const edited = editNotes(LINE, [0], { to: 61, tr: 2, g: -2 });
    const out = splitNote(edited, 0, 1.2);
    expect(out.n.slice(0, 2)).toEqual([
      { t: 1, d: 0.2, p: 60.12, u: 0.05, to: 61, tr: 2, g: -2 },
      { t: 1.2, d: 0.3, p: 60.12, to: 61, g: -2 },
    ]);
    expect(out.n[2]).toBe(LINE.n[1]);
    expectCanonical(out);
    // not within 10 ms of either end
    expect(splitNote(LINE, 0, 1.005)).toBe(LINE);
    expect(splitNote(LINE, 0, 1.495)).toBe(LINE);
    expect(splitNote(LINE, 0, 2)).toBe(LINE);
  });

  it('cuts a note moved in time where the cut now plays, so the warp is as it was', () => {
    const moved = moveNotes(LINE, [2], 0.1);
    const out = splitNote(moved, 2, 2.4);
    expect(out.n[2]).toEqual({ t: 2.2, d: 0.2, p: 64.3, ts: 2.3, te: 2.5 });
    expect(out.n[3]).toEqual({ t: 2.4, d: 0.3, p: 64.3, ts: 2.5, te: 2.8 });
    expectCanonical(out);
    const [w0, w1] = [warpOf(moved), warpOf(out)];
    for (let x = 1.5; x < 3.5; x += 0.0371) expect(warpAt(w1, x)).toBeCloseTo(warpAt(w0, x), 9);
  });

  it('cuts a pasted note’s source with it', () => {
    const pasted = mono([{ t: 1, d: 0.5, p: 60, s: 7 }]);
    expect(splitNote(pasted, 0, 1.25).n).toEqual([
      { t: 1, d: 0.25, p: 60, s: 7 },
      { t: 1.25, d: 0.25, p: 60, s: 7.25 },
    ]);
  });

  it('joins a note with the next: the longer’s pitch and edits, the first’s consonant', () => {
    const edited = editNotes(LINE, [0, 1], { to: 61 });
    const out = joinNotes(editNotes(edited, [1], { g: -4 }), 0);
    expect(out.n[0]).toEqual({ t: 1, d: 0.9, p: 60.12, u: 0.05, to: 61 });
    expect(out.n).toHaveLength(4);
    expect(out.n[1]).toBe(LINE.n[2]);
    expectCanonical(out);
    expect(joinNotes(LINE, 4)).toBe(LINE);
    expect(joinNotes(CHORDS, 0)).toBe(CHORDS);
    // across a rest, and onto a breath: one note with the pitch
    expect(joinNotes(LINE, 2).n[2]).toEqual({ t: 2.2, d: 1.1, p: 64.3 });
  });

  it('joins what it split back into the note it was', () => {
    const edited = editNotes(LINE, [0], { to: 61, mo: 0.5 });
    expect(joinNotes(splitNote(edited, 0, 1.3), 0)).toEqual(edited);
  });

  it('moves where two touching notes meet, keeping them touching and 10 ms long at least', () => {
    const out = moveBoundary(LINE, 0, 1.6);
    expect(out.n.slice(0, 2)).toEqual([
      { t: 1, d: 0.6, p: 60.12, u: 0.05 },
      { t: 1.6, d: 0.3, p: 62 },
    ]);
    expectCanonical(out);
    expect(moveBoundary(LINE, 0, 5).n[1]).toEqual({ t: 1.89, d: 0.01, p: 62 });
    // notes that don't touch
    expect(moveBoundary(LINE, 1, 2)).toBe(LINE);
    expect(moveBoundary(LINE, 0, 1.5)).toBe(LINE);
  });

  it('moves a boundary between notes moved in time as far as the warp lets it', () => {
    const moved = moveNotes(LINE, [0, 1], 0.05);
    const out = moveBoundary(moved, 0, 1.7);
    expectCanonical(out);
    expect(out.n[1]?.t).toBe(1.7);
    expect(out.n[0]?.te).toBe(out.n[1]?.ts);
  });
});

describe('notes found again', () => {
  it('adds a missed note in the gap where it starts, cut short at the next', () => {
    const out = addNote(LINE, 2.75, 0.5, 65.5);
    expect(out.n[3]).toEqual({ t: 2.75, d: 0.25, p: 65.5 });
    expect(out.n).toHaveLength(6);
    expectCanonical(out);
    expect(addNote(LINE, 0.2, 0.3, null).n[0]).toEqual({ t: 0.2, d: 0.3, p: null });
    // not over another, nor under 10 ms
    expect(addNote(LINE, 1.2, 0.1, 60)).toBe(LINE);
    expect(addNote(LINE, 2.995, 0.5, 60)).toBe(LINE);
  });

  it('lets a chord’s notes overlap, but not twice the same', () => {
    const out = addNote(CHORDS, 1, 1, 62);
    expect(out.n.map((n) => n.p)).toEqual([60, 62, 64.2, 67, null]);
    expect(addNote(CHORDS, 1, 1, 60)).toBe(CHORDS);
  });

  it('takes a note out, the rest as they were', () => {
    const out = removeNote(LINE, 2);
    expect(out.n).toEqual([LINE.n[0], LINE.n[1], LINE.n[3], LINE.n[4]]);
    expect(out.n[0]).toBe(LINE.n[0]);
    expect(removeNote(LINE, 7)).toBe(LINE);
    // a moved note taken out takes the legato edge that followed it back
    const moved = moveNotes(LINE, [1], 0.05);
    expect(removeNote(moved, 1).n[0]).toEqual(LINE.n[0]);
  });

  it('puts notes back as found: everything, or only what’s named', () => {
    const edited = moveNotes(editNotes(LINE, [0, 2], { to: 66, g: -3, m: true }), [2], 0.1);
    expect(resetNotes(edited, [0, 2])).toEqual(LINE);
    const kept = resetNotes(edited, [0, 2], ['to']);
    expect(kept.n[0]).toEqual({ ...LINE.n[0], g: -3, m: true });
    expect(kept.n[2]).toMatchObject({ g: -3, m: true, ts: 2.3, te: 2.8 });
    expect(resetNotes(LINE, [0, 1, 2])).toBe(LINE);
    // a legato move put back takes the neighbour's edge back too
    const legato = moveNotes(LINE, [1], 0.05);
    expect(resetNotes(legato, [1], ['ts', 'te', 'at'])).toEqual(LINE);
  });
});

describe('choosing notes by words', () => {
  /** 120 bpm in 4/4: a bar is 2 s. The region starts at bar 2 and plays its recording from 0.3 s. */
  const song = newProject('Choose');
  song.tempo = [{ tick: 0, bpm: 120 }];
  const region = { start: 4 * PPQ, audio: { offset: 0.3, stretch: 1, notes: LINE } };
  const ctx = { project: song, region };

  it('chooses all, the selection, or numbers counted from 1', () => {
    expect(selectNotes(LINE, 'all')).toEqual([0, 1, 2, 3, 4]);
    expect(selectNotes(LINE, ' Selected ', { selected: [3, 1, 9, 1] })).toEqual([1, 3]);
    expect(selectNotes(LINE, 'selected')).toEqual([]);
    expect(selectNotes(LINE, '1-3,5')).toEqual([0, 1, 2, 4]);
    expect(selectNotes(LINE, 'notes 4–2')).toEqual([1, 2, 3]);
    expect(selectNotes(LINE, '2')).toEqual([1]);
    expect(() => selectNotes(LINE, '2-6')).toThrow(/are 5 notes: 6 isn't one/);
    expect(() => selectNotes(LINE, '0')).toThrow(/isn't one/);
    expect(() => selectNotes(LINE, 'the loud ones')).toThrow(/doesn't choose notes/);
  });

  it('chooses by bars, where each note’s beat plays (after its consonant)', () => {
    // bar 2 starts at 2 s, playing the recording's 0.3 s: the recording's 2.3 s is bar 3
    expect(selectNotes(LINE, 'bar 2', ctx)).toEqual([0, 1, 2]);
    expect(selectNotes(LINE, 'bars 3-4', ctx)).toEqual([3, 4]);
    expect(selectNotes(LINE, 'bars 9-13', ctx)).toEqual([]);
    // a note moved in time is where it now plays
    const moved = moveNotes(LINE, [2], 0.15);
    expect(moved.n[2]?.ts).toBe(2.35);
    expect(selectNotes(moved, 'bar 3', ctx)).toEqual([2, 3, 4]);
    expect(() => selectNotes(LINE, 'bars 2-3')).toThrow(/needs the song and the region/);
    expect(() => selectNotes(LINE, 'bar 0', ctx)).toThrow(/count from 1/);
  });

  it('chooses by pitch as the notes are now, to the nearest semitone, named either way', () => {
    expect(selectNotes(LINE, 'pitch E4')).toEqual([2]);
    expect(selectNotes(LINE, 'pitch C4, D4')).toEqual([0, 1]);
    expect(selectNotes(LINE, 'pitch E3', { middleC: 'C3' })).toEqual([2]);
    expect(selectNotes(LINE, 'pitch 67')).toEqual([4]);
    expect(selectNotes(editNotes(LINE, [2], { to: 65 }), 'pitch E4')).toEqual([]);
    expect(() => selectNotes(LINE, 'pitch H2')).toThrow(/isn't a pitch/);
  });
});

describe('a region’s notes cut to what it plays', () => {
  /** Twenty notes, 0.4 s each with 0.1 s between. */
  const long = mono(Array.from({ length: 20 }, (_, i) => ({ t: i * 0.5, d: 0.4, p: 60 + (i % 5) })));

  it('keeps the notes it plays and the two nearest either side, a note across an edge as it is', () => {
    const out = pruneNotes(long, [3.1, 5.2]);
    expect(out.n.map((n) => n.t)).toEqual([2, 2.5, 3, 3.5, 4, 4.5, 5, 5.5, 6]);
    for (const n of out.n) expect(long.n).toContain(n);
    expectCanonical(out);
    expect(pruneNotes(long, [-1, 20])).toBe(long);
  });

  it('keeps on past notes moved in time to the first that isn’t, so the warp is the same where it plays', () => {
    const moved = moveNotes(long, [7, 8, 9], 0.02);
    const out = pruneNotes(moved, [0, 2.9]);
    expect(out.n.map((n) => n.t)).toEqual([0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4, 4.5, 5]);
    const [w0, w1] = [warpOf(moved), warpOf(out)];
    for (let x = 0; x < 2.9; x += 0.013) expect(warpAt(w1, x)).toBeCloseTo(warpAt(w0, x), 9);
  });

  it('keeps chords’ notes by where each reaches', () => {
    const chords = poly([
      { t: 0, d: 4, p: 48 },
      { t: 1, d: 0.5, p: 60 },
      { t: 2, d: 0.5, p: 62 },
      { t: 3, d: 0.5, p: 64 },
      { t: 5, d: 0.5, p: 65 },
      { t: 6, d: 0.5, p: 67 },
      { t: 7, d: 0.5, p: 69 },
    ]);
    expect(pruneNotes(chords, [3.2, 3.4]).n.map((n) => n.p)).toEqual([48, 60, 62, 64, 65, 67]);
  });
});

/** A song with a tempo change, and a vocal region (stretched, from 0.5 s into its recording) whose notes are edited. */
function vocalSong(notes: AudioNotes | undefined = LINE): Project {
  const p = newProject('Vocal');
  p.tempo = [
    { tick: 0, bpm: 120 },
    { tick: 4 * PPQ, bpm: 90 },
  ];
  const region: Region = { ...newRegion(2 * PPQ, 8 * PPQ, 'Vocal'), id: 'rgn_vocal' };
  region.audio = { file: 'aud_vocal', offset: 0.5, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1.25 };
  if (notes) region.audio.notes = notes;
  p.files = [{ id: 'aud_vocal', name: 'Vocal.wav', seconds: 30, rate: 48000, channels: 1 }];
  p.tracks.push({ ...newAudioTrack('Vocal'), id: 'trk_vocal', regions: [region] });
  return p;
}
const regionOf = (p: Project, id = 'rgn_vocal') =>
  p.tracks.flatMap((t) => t.regions).find((r) => r.id === id) as Region;

describe('a region’s notes on the song’s timeline', () => {
  it('plays a time in the recording through its offset, its stretch and the tempo map, and back', () => {
    const p = vocalSong();
    const r = regionOf(p);
    // the region's start plays its offset
    expect(fileToTick(p, r, 0.5)).toBeCloseTo(2 * PPQ, 6);
    // 1 s of the recording later, stretched 1.25 s: 1 s at 120 (to the change at tick 3840), then 0.25 s at 90
    expect(fileToTick(p, r, 1.5)).toBeCloseTo(4 * PPQ + (0.25 / (60 / 90)) * PPQ, 6);
    for (const x of [0, 0.3, 0.5, 1.234, 2.2, 3.7, 9]) expect(tickToFile(p, r, fileToTick(p, r, x))).toBeCloseTo(x, 9);
  });

  it('plays a note moved in time where it now plays, and comes back through the warp', () => {
    const p = vocalSong(moveNotes(LINE, [2], 0.12));
    const r = regionOf(p);
    const n = r.audio?.notes?.n[2] as AudioNote;
    expect(n.ts).toBe(2.32);
    expect(fileToTick(p, r, n.t)).toBeCloseTo(fileToTick(p, r, n.ts as number, true), 6);
    expect(fileToTick(p, r, n.t)).not.toBeCloseTo(fileToTick(p, r, n.t, true), 2);
    for (const x of [1.95, 2.2, 2.45, 2.7, 2.9]) expect(tickToFile(p, r, fileToTick(p, r, x))).toBeCloseTo(x, 9);
    const tick = fileToTick(p, r, 2.5);
    expect(tickToFile(p, r, tick, true)).toBeCloseTo(warpAt(warpOf(r.audio?.notes as AudioNotes), 2.5), 9);
    // many points at once, the same
    const ticks = fileToTicks(p, r);
    for (const x of [1, 2.3, 4]) expect(ticks(x)).toBe(fileToTick(p, r, x));
    // with the edits off, the recording plays as it is
    const clip = r.audio as NonNullable<Region['audio']>;
    const off: Region = { ...r, audio: { ...clip, notes: { ...(clip.notes as AudioNotes), off: true } } };
    expect(fileToTick(p, off, n.t)).toBeCloseTo(fileToTick(p, r, n.t, true), 9);
  });
});

describe('splitting and healing a region with notes', () => {
  const edited = editNotes(moveNotes(LINE, [2], 0.08), [0, 4], { to: 61, g: -2 });

  it('gives each half the notes it plays, a note across the cut to both as it is', () => {
    const p = vocalSong(edited);
    const r = regionOf(p);
    // the cut plays the recording's 2.3 s (inside note 2, 2.2–2.7, moved to 2.28–2.78)
    const at = Math.round(fileToTick(p, r, 2.3, true));
    const [left, right] = splitRegionAt(p, r, at, 'rgn_right');
    const [l, rr] = [left.audio?.notes as AudioNotes, right.audio?.notes as AudioNotes];
    expect(l.n).toEqual(edited.n);
    expect(rr.n).toEqual(edited.n);
    expect(rr.n[2]).toBe(edited.n[2]);
    expect(notesCompatible(l, rr)).toBe(true);
    expect(mergeNotes(l, rr)).toBe(l);
  });

  it('cuts a long recording’s notes to each half, and heals back to the notes it played', () => {
    const many = mono(Array.from({ length: 40 }, (_, i) => ({ t: i * 0.5, d: 0.4, p: 60 + (i % 7) })));
    const notes = editNotes(moveNotes(many, [9], 0.05), [3, 10, 25], { to: 59, m: true });
    const p = vocalSong(notes);
    const r = regionOf(p);
    const end = tickToFile(p, r, r.start + r.length, true);
    const at = Math.round(fileToTick(p, r, 4.33, true));
    const [left, right] = splitRegionAt(p, r, at, 'rgn_right');
    const [l, rr] = [left.audio?.notes as AudioNotes, right.audio?.notes as AudioNotes];
    // each its own window and two past it; the note across the cut (4–4.4) in both, as it was
    expect(l.n[0]?.t).toBe(0);
    expect(l.n[l.n.length - 1]?.t).toBe(5);
    expect(rr.n[0]?.t).toBe(3);
    expect(rr.n.find((n) => n.t === 4)).toBe(notes.n[8]);
    expect(l.n.find((n) => n.t === 4)).toBe(notes.n[8]);
    expectCanonical(l);
    expectCanonical(rr);
    expect(notesCompatible(l, rr)).toBe(true);
    expect(mergeNotes(l, rr)).toEqual(pruneNotes(notes, [0.5, end]));
    // a half edited where both keep it doesn't heal
    expect(notesCompatible(l, editNotes(rr, [1], { g: 3 }))).toBe(false);
    expect(notesCompatible(l, { ...rr, v: 2 })).toBe(false);
    // none against notes with edits doesn't either; against notes with none, it does
    expect(notesCompatible(undefined, rr)).toBe(false);
    expect(notesCompatible(undefined, mono([{ t: 1, d: 1, p: 60 }]))).toBe(true);
    expect(notesCompatible(undefined, undefined)).toBe(true);
  });

  it('heals the pieces bars inserted into a recording left, once the bars go again, with their notes', () => {
    const many = mono(Array.from({ length: 40 }, (_, i) => ({ t: i * 0.5, d: 0.4, p: 60 + (i % 7) })));
    const notes = editNotes(many, [2, 6, 9], { to: 70, fo: 2 });
    const p = vocalSong(notes);
    const r = regionOf(p);
    const end = tickToFile(p, r, r.start + r.length, true);
    const opened = applyOp(p, { op: 'arrange', edit: 'insert', from: 4 * PPQ, to: 8 * PPQ });
    const vocal = (s: Project) => s.tracks.find((t) => t.id === 'trk_vocal')?.regions ?? [];
    const pieces = vocal(opened);
    expect(pieces).toHaveLength(2);
    for (const piece of pieces) expect(piece.audio?.notes?.n.length).toBeLessThan(notes.n.length);
    const closed = applyOp(opened, { op: 'arrange', edit: 'delete', from: 4 * PPQ, to: 8 * PPQ });
    const healed = vocal(closed);
    expect(healed).toHaveLength(1);
    expect(healed[0]?.audio?.notes).toEqual(pruneNotes(notes, [0.5, end]));
    expect(() => parseProject(closed)).not.toThrow();
    // a piece edited in between stays apart
    const piece = pieces[1] as Region;
    const changed = applyOp(opened, {
      op: 'updateRegion',
      track: 'trk_vocal',
      region: piece.id,
      patch: {
        audio: {
          ...(piece.audio as NonNullable<Region['audio']>),
          notes: editNotes(piece.audio?.notes as AudioNotes, [0], { g: -9 }),
        },
      },
    });
    const apart = applyOp(changed, { op: 'arrange', edit: 'delete', from: 4 * PPQ, to: 8 * PPQ });
    expect(vocal(apart)).toHaveLength(2);
  });
});

describe('what changed in a region’s notes, in words', () => {
  const count = (was: AudioNotes | undefined, now: AudioNotes | undefined) => noteChanges(was, now).counts;

  it('counts edits by kind, a note counted under each way it changed', () => {
    const now = moveNotes(editNotes(LINE, [0, 1, 2, 4], { to: 70 }), [2], 0.1);
    expect(count(LINE, now)).toEqual({ tuned: 4, moved: 1 });
    expect(noteChangesText(noteChanges(LINE, now))).toBe('4 notes tuned, 1 moved');
    expect(count(LINE, editNotes(LINE, [3], { m: true, g: -3 }))).toEqual({ level: 1, muted: 1 });
    expect(count(LINE, setAttack(LINE, [0], 2))).toEqual({ attack: 1 });
    expect(count(LINE, resizeNote(LINE, 2, 'end', 2.8))).toEqual({ stretched: 1 });
    expect(count(editNotes(LINE, [0, 1], { to: 70, dr: 0 }), LINE)).toEqual({ reset: 2 });
    expect(count(LINE, LINE)).toEqual({});
  });

  it('tells notes found again: split, joined, a boundary moved, an octave put right, added, removed', () => {
    expect(count(LINE, splitNote(LINE, 0, 1.2))).toEqual({ split: 1 });
    expect(count(LINE, joinNotes(LINE, 0))).toEqual({ joined: 2 });
    expect(count(LINE, moveBoundary(LINE, 0, 1.6))).toEqual({ boundary: 1 });
    expect(count(LINE, fixOctave(LINE, 2, 12))).toEqual({ octave: 1 });
    expect(count(LINE, addNote(LINE, 2.75, 0.2, 66))).toEqual({ added: 1 });
    expect(count(LINE, removeNote(removeNote(LINE, 4), 2))).toEqual({ removed: 2 });
    expect(noteChangesText(noteChanges(LINE, moveBoundary(LINE, 0, 1.6)))).toBe('1 boundary moved');
  });

  it('counts the edits of notes written with their first edit, and of notes taken away', () => {
    const now = editNotes(LINE, [0, 2], { to: 70 });
    expect(count(undefined, now)).toEqual({ tuned: 2 });
    expect(count(now, undefined)).toEqual({ reset: 2 });
  });

  it('says it in the song’s changes, with the bars the notes play in', () => {
    const before = vocalSong();
    const after = structuredClone(before);
    const r = regionOf(after);
    (r.audio as NonNullable<Region['audio']>).notes = moveNotes(editNotes(LINE, [0, 1, 2, 4], { to: 70 }), [2], 0.1);
    expect(describeChanges(before, after)).toEqual(['Vocal bars 1–3: 4 notes tuned, 1 moved']);
    const off = structuredClone(before);
    (regionOf(off).audio as NonNullable<Region['audio']>).notes = { ...LINE, off: true };
    expect(describeChanges(before, off)).toEqual(['Vocal: region at bar 1 beat 3 note edits turned off']);
    // with the region's own changes as well
    const both = structuredClone(after);
    (regionOf(both).audio as NonNullable<Region['audio']>).gain = -3;
    expect(describeChanges(before, both)).toEqual([
      'Vocal: region at bar 1 beat 3 gain changed',
      'Vocal bars 1–3: 4 notes tuned, 1 moved',
    ]);
  });

  it('says how many notes are edited in the song’s overview', () => {
    const p = vocalSong(editNotes(LINE, [0, 3], { g: -2 }));
    expect(describeProject(p)).toContain('2 of 5 notes edited');
    expect(describeProject(vocalSong())).toContain('5 notes found, none edited');
  });
});

// ---- the registry ----

/** Arguments for an edit: its defaults, else a value inside each range (a pitch, a choice's first). */
function sampleArgs(edit: NoteEdit): Record<string, number | string | boolean> {
  const out: Record<string, number | string | boolean> = {};
  for (const a of edit.args) {
    if (a.default !== undefined) out[a.name] = a.default;
    else if (a.values) out[a.name] = a.values[a.values.length - 1] as string;
    else if (a.kind === 'pitch') out[a.name] = 'F#4';
    else if (a.name === 'start') out[a.name] = 2.75;
    else if (a.kind === 'seconds') out[a.name] = 0.05;
    else out[a.name] = Math.min(a.max ?? 1, Math.max(a.min ?? 0, ((a.min ?? 0) + (a.max ?? 1)) / 3));
  }
  return out;
}

const SAMPLES: Record<AudioNotesMode, AudioNotes> = {
  mono: LINE,
  poly: CHORDS,
  perc: parseAudioNotes({
    mode: 'perc',
    v: 1,
    n: [
      { t: 0.5, d: 0.1, p: null },
      { t: 1, d: 0.1, p: null },
    ],
  }) as AudioNotes,
};

describe('the note edits’ registry', () => {
  it('lists each edit once, by a stable name, with a sentence, its kinds of notes and its arguments', () => {
    expect(new Set(NOTE_EDIT_NAMES).size).toBe(NOTE_EDITS.length);
    expect(NOTE_EDIT_NAMES).toEqual([
      'shift',
      'set-pitch',
      'drift',
      'vibrato',
      'transition',
      'formant',
      'gain',
      'mute',
      'unmute',
      'move',
      'resize',
      'attack',
      'split',
      'join',
      'boundary',
      'octave',
      'add',
      'remove',
      'reset',
    ]);
    for (const e of NOTE_EDITS) {
      expect(e.name).toMatch(/^[a-z]+(-[a-z]+)*$/);
      expect(e.summary).toMatch(/^[A-Z].*\.$/);
      expect(e.summary.split('. ')).toHaveLength(1);
      expect(e.modes.length).toBeGreaterThan(0);
      for (const m of e.modes) expect(AUDIO_NOTES_MODES).toContain(m);
      expect(new Set(e.args.map((a) => a.name)).size).toBe(e.args.length);
      for (const a of e.args) {
        expect(a.name).toMatch(/^[a-z]+$/);
        expect(a.help.length).toBeGreaterThan(5);
        if (a.kind === 'snap' || a.kind === 'choice') expect(a.values?.length).toBeGreaterThan(1);
        if (a.min !== undefined && a.max !== undefined) expect(a.min).toBeLessThan(a.max);
        if (typeof a.default === 'number') {
          expect(a.default).toBeGreaterThanOrEqual(a.min ?? Number.NEGATIVE_INFINITY);
          expect(a.default).toBeLessThanOrEqual(a.max ?? Number.POSITIVE_INFINITY);
        }
        if (typeof a.default === 'string') expect(a.values).toContain(a.default);
        expect(a.required && a.default !== undefined).toBeFalsy();
      }
    }
    expect(noteEdit('shift')).toBe(NOTE_EDITS[0]);
    expect(noteEdit('no-such-edit')).toBeUndefined();
  });

  it('says which edits a list of names leaves out (for the parity of the studio, the agent and holo notes)', () => {
    expect(missingNoteEdits(NOTE_EDIT_NAMES)).toEqual([]);
    expect(missingNoteEdits(NOTE_EDIT_NAMES.filter((n) => n !== 'join' && n !== 'add'))).toEqual(['join', 'add']);
  });

  for (const edit of NOTE_EDITS) {
    describe(edit.name, () => {
      it('applies only to its kinds of notes, and comes out canonical, sharing the notes it didn’t edit', () => {
        for (const mode of AUDIO_NOTES_MODES) {
          const notes = SAMPLES[mode];
          const chosen = mode === 'mono' ? [0, 2] : [1];
          const out = edit.apply(notes, chosen, sampleArgs(edit));
          if (!edit.modes.includes(mode)) {
            expect(out).toBe(notes);
            continue;
          }
          expectCanonical(out);
          expect(notes).toEqual(SAMPLES[mode]);
          if (out.n.length === notes.n.length) expectShared(notes, out, chosen);
        }
      });

      it('brings arguments outside their ranges in, and does nothing without one it needs', () => {
        const notes = SAMPLES.mono;
        const big: Record<string, number | string | boolean> = { ...sampleArgs(edit) };
        const top: Record<string, number | string | boolean> = { ...sampleArgs(edit) };
        for (const a of edit.args) {
          if (a.max === undefined || a.kind === 'pitch') continue;
          big[a.name] = a.max * 10 + 100;
          top[a.name] = a.max;
        }
        expect(edit.apply(notes, [0, 2], big)).toEqual(edit.apply(notes, [0, 2], top));
        const required = edit.args.find((a) => a.required);
        if (required) {
          const { [required.name]: _, ...missing } = sampleArgs(edit);
          expect(edit.apply(notes, [0, 2], missing as NoteArgs)).toBe(notes);
        }
        if (edit.selection) expect(edit.apply(notes, [], sampleArgs(edit))).toBe(notes);
      });
    });
  }

  it('makes each edit as its helper does', () => {
    const run = (name: string, idx: number[], args: NoteArgs = {}, notes = LINE) =>
      (noteEdit(name) as NoteEdit).apply(notes, idx, args);
    expect(run('shift', [0], { semitones: 2, snap: 'semitone' })).toEqual(shiftNotes(LINE, [0], 2, 'semitone'));
    expect(run('shift', [2], { semitones: 1, snap: 'scale' }, LINE).n[2]?.to).toBe(65);
    expect(run('set-pitch', [0, 1], { pitch: 'E4+20c' }).n.map((n) => n.to)).toEqual([
      64.2,
      64.2,
      undefined,
      undefined,
      undefined,
    ]);
    expect(run('drift', [0], { keep: 40 }).n[0]?.dr).toBe(0.4);
    expect(run('vibrato', [0], { keep: 150 }).n[0]?.mo).toBe(1.5);
    expect(run('transition', [1], { length: 50 }).n[1]?.tr).toBe(0.5);
    expect(run('formant', [0], { semitones: -3 }).n[0]?.fo).toBe(-3);
    expect(run('gain', [3], { db: -6 }).n[3]?.g).toBe(-6);
    expect(run('unmute', [3], {}, run('mute', [3]))).toEqual(LINE);
    expect(run('move', [2], { seconds: 0.1 })).toEqual(moveNotes(LINE, [2], 0.1));
    expect(run('resize', [2], { seconds: 0.1 }).n[2]?.te).toBe(2.8);
    expect(run('resize', [1], { edge: 'start', seconds: -0.05 })).toEqual(resizeNote(LINE, 1, 'start', 1.45));
    expect(run('attack', [0], { length: 50 }).n[0]?.at).toBe(0.5);
    expect(
      run('split', [0])
        .n.slice(0, 2)
        .map((n) => [n.t, n.d]),
    ).toEqual([
      [1, 0.25],
      [1.25, 0.25],
    ]);
    expect(run('split', [0, 2], { at: 0.1 }).n.map((n) => n.t)).toEqual([1, 1.1, 1.5, 2.2, 2.3, 3, 3.5]);
    expect(run('join', [0, 1, 2]).n.map((n) => [n.t, n.d])).toEqual([
      [1, 1.7],
      [3, 0.3],
      [3.5, 0.6],
    ]);
    expect(run('join', [0, 3])).toEqual(joinNotes(joinNotes(LINE, 3), 0));
    expect(run('boundary', [0], { seconds: 0.1 })).toEqual(moveBoundary(LINE, 0, 1.6));
    expect(run('octave', [2], { direction: 'down' }).n[2]?.p).toBe(52.3);
    expect(run('add', [], { start: 2.75, length: 0.1, pitch: 66 })).toEqual(addNote(LINE, 2.75, 0.1, 66));
    expect(run('add', [], { start: 2.75, length: 0.1 }).n[3]).toEqual({ t: 2.75, d: 0.1, p: null });
    expect(run('remove', [1, 3]).n).toEqual([LINE.n[0], LINE.n[2], LINE.n[4]]);
    const edited = editNotes(LINE, [0], { to: 66, g: -3 });
    expect(run('reset', [0], { what: 'pitch' }, edited).n[0]).toEqual({ ...LINE.n[0], g: -3 });
    expect(run('reset', [0], {}, edited)).toEqual(LINE);
  });

  it('snaps to the song’s key where each note plays, or the scale it’s given', () => {
    const shift = noteEdit('shift') as NoteEdit;
    const p = vocalSong();
    p.key = 'D major';
    const r = regionOf(p);
    expect(shift.apply(LINE, [2], { semitones: 1, snap: 'scale' }, { project: p, region: r }).n[2]?.to).toBe(66);
    const scale: Scale = { tonic: 0, steps: [0, 2, 4, 5, 7, 9, 11], name: 'C major' };
    expect(shift.apply(LINE, [2], { semitones: 1, snap: 'scale' }, { project: p, region: r, scale }).n[2]?.to).toBe(65);
  });

  it('reads arguments as the agent and holo notes give them, and says what’s wrong', () => {
    const shift = noteEdit('shift') as NoteEdit;
    expect(readNoteArgs(shift, { semitones: '2' })).toEqual({ semitones: 2, cents: 0, snap: 'free' });
    expect(readNoteArgs(noteEdit('set-pitch') as NoteEdit, { pitch: 'E3' }, 'C3')).toEqual({ pitch: 64 });
    expect(readNoteArgs(noteEdit('reset') as NoteEdit, {})).toEqual({ what: 'all' });
    expect(() => readNoteArgs(shift, { semitones: 60 })).toThrow(/"semitones" is -48 to 48 semitones \(got 60\)/);
    expect(() => readNoteArgs(shift, { snap: 'nearest' })).toThrow(/one of free, semitone, scale/);
    expect(() => readNoteArgs(shift, { by: 2 })).toThrow(/shift takes no "by"/);
    expect(() => readNoteArgs(noteEdit('gain') as NoteEdit, {})).toThrow(/Say "db"/);
    expect(() => readNoteArgs(noteEdit('set-pitch') as NoteEdit, { pitch: 'H4' })).toThrow(/a note name/);
    expect(() => readNoteArgs(noteEdit('mute') as NoteEdit, { db: 3 })).toThrow(/mute takes no "db"$/);
  });

  it('keeps notes canonical through any run of edits', () => {
    let notes = LINE;
    const steps: [string, number[], NoteArgs][] = [
      ['shift', [0, 1, 2], { semitones: 1.37, snap: 'free' }],
      ['move', [1], { seconds: 0.03 }],
      ['split', [2], {}],
      ['vibrato', [0, 1, 2, 3], { keep: 0 }],
      ['resize', [4], { edge: 'start', seconds: -0.4 }],
      ['boundary', [0], { seconds: -0.2 }],
      ['add', [], { start: 0.1, length: 0.2, pitch: 59 }],
      ['join', [3, 4], {}],
      ['octave', [1], { direction: 'up' }],
      ['remove', [2], {}],
      ['reset', [0, 1, 2, 3, 4, 5], { what: 'time' }],
    ];
    for (const [name, idx, args] of steps) {
      notes = (noteEdit(name) as NoteEdit).apply(notes, idx, args);
      expectCanonical(notes);
    }
    expect(canonicalNotes(notes, notes.n)).toBe(notes);
  });
});
