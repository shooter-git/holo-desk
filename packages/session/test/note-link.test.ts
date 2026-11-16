/**
 * Pasting a note's sound (`paste`), giving notes another's edits (`copy-settings`), and an edit linked
 * across the regions that play one recording (`linkedNoteEdits`): synthetic notes only.
 */
import { describe, expect, it } from 'vitest';
import {
  type AudioNote,
  type AudioNotes,
  applyOps,
  COPIED_SETTINGS,
  copySettings,
  linkedNoteEdits,
  linkedRegions,
  type NoteArgs,
  type NoteEdit,
  type NoteEditContext,
  newAudioTrack,
  newProject,
  newRegion,
  noteChanges,
  noteChangesText,
  noteEdit,
  PPQ,
  type Project,
  parseAudioNotes,
  parseProject,
  pasteNotes,
  pruneNotes,
  type Region,
  regionWindow,
  warpAt,
  warpOf,
  warpProblem,
} from '../src/index.ts';

const mono = (n: unknown[]): AudioNotes => parseAudioNotes({ mode: 'mono', v: 1, n }) as AudioNotes;
const poly = (n: unknown[]): AudioNotes => parseAudioNotes({ mode: 'poly', v: 1, n }) as AudioNotes;
const edit = (name: string) => noteEdit(name) as NoteEdit;
const run = (name: string, notes: AudioNotes, idx: number[], args: NoteArgs, ctx?: NoteEditContext) =>
  edit(name).apply(notes, idx, args, ctx);

/** What a song keeps: read back, the notes are the same to the bit, and a line's moves fit the warp. */
function expectCanonical(notes: AudioNotes): void {
  expect(parseAudioNotes(JSON.parse(JSON.stringify(notes)))).toEqual(notes);
  if (notes.mode === 'mono') expect(warpProblem(warpOf(notes))).toBe(-1);
}

/** Where each pasted note reads its sound, [from, to) in seconds of the recording. */
const reads = (notes: AudioNotes) =>
  notes.n
    .filter((n) => n.s !== undefined && n.s !== n.t)
    .map((n) => [n.s as number, Math.round(((n.s as number) + n.d) * 1e4) / 1e4]);

/**
 * A line: a short note with a consonant, a longer one tuned onto its semitone and quieter, a breath,
 * then a long note sung straight into the last one.
 */
const LINE = mono([
  { t: 1, d: 0.4, p: 60.12, u: 0.05 },
  { t: 1.6, d: 0.5, p: 64.3, to: 64, g: -3, mo: 0.5 },
  { t: 2.3, d: 0.2, p: null },
  { t: 2.8, d: 0.9, p: 67.2 },
  { t: 3.7, d: 0.5, p: 65 },
]);

describe('pasting a note’s sound', () => {
  it('plays the source’s sound from its start, with its pitch and consonant as found: what the renderer reads', () => {
    const out = run('paste', LINE, [4], { from: 1 });
    // the last note is longer than the first (0.5 s against 0.4 s): the next test; here, the first onto a shorter one
    const short = run('paste', LINE, [0], { from: 5 });
    expect(short.n[0]).toEqual({ t: 1, d: 0.4, p: 65, s: 3.7 });
    expect(reads(short)).toEqual([[3.7, 4.1]]);
    expectCanonical(short);
    expectCanonical(out);
    // the same as the helper, with the note itself
    expect(short).toEqual(pasteNotes(LINE, [0], LINE.n[4] as AudioNote));
  });

  it('keeps the note’s own edits, its pitch move carried from its nearest semitone to the new pitch’s', () => {
    // note 2 is tuned onto E4 from 30 cents sharp: pasted with note 4's sound (G4 20 cents sharp), it's tuned onto G4
    const out = run('paste', LINE, [1], { from: 4 }, {});
    const n = out.n[1] as AudioNote;
    expect(n).toMatchObject({ t: 1.6, d: 0.5, p: 67.2, s: 2.8, to: 67, g: -3, mo: 0.5 });
    // moved up a fifth from its semitone, it's moved up a fifth from the new one's
    const fifth = run('paste', run('set-pitch', LINE, [1], { pitch: 71 }), [1], { from: 4 });
    expect(fifth.n[1]?.to).toBe(74);
    // not moved: it plays the sound at its own pitch
    expect(run('paste', LINE, [3], { from: 5 }).n[3]?.to).toBeUndefined();
  });

  it('never reads past the source’s end: a longer note plays all of it stretched over itself, as far as the warp lets it, then is muted', () => {
    // note 4 (0.9 s, sung into note 5) pasted with note 2's sound (0.5 s)
    const out = run('paste', LINE, [3], { from: 2 });
    expectCanonical(out);
    expect(out.n).toHaveLength(6);
    // (only the sound comes: none of the source's edits) all of it, played over 0.8 s of the note's 0.9:
    // the rest is muted and squeezed to a quarter of its 0.4 s, as far as the warp squeezes
    expect(out.n[3]).toEqual({ t: 2.8, d: 0.5, p: 64.3, s: 1.6, te: 3.6 });
    expect(out.n[4]).toEqual({ t: 3.3, d: 0.4, p: 67.2, m: true, ts: 3.6 });
    expect(reads(out)).toEqual([[1.6, 2.1]]);
    // the note still starts and ends where it did, and the next note is as it was
    const w = warpOf(out);
    expect(warpAt(w, 2.8)).toBe(2.8);
    expect(warpAt(w, 3.7)).toBe(3.7);
    expect(out.n[5]).toBe(LINE.n[4]);
    expect(noteChangesText(noteChanges(LINE, out))).toBe('1 note pasted');
    // (a note moved in time is cut where the cut now plays, both parts keeping the move)
    const moved = run('move', LINE, [3], { seconds: -0.05 });
    const later = run('paste', moved, [3], { from: 2 });
    expectCanonical(later);
    expect(later.n[3]).toMatchObject({ t: 2.8, d: 0.5, s: 1.6, ts: 2.75, te: 3.55 });
    expect(later.n[4]).toMatchObject({ t: 3.3, m: true, ts: 3.55, te: 3.65 });
  });

  it('within 10 ms of the source’s length, reads a little less of it rather than past its end', () => {
    const notes = mono([
      { t: 1, d: 0.3, p: 60 },
      { t: 2, d: 0.305, p: 62 },
    ]);
    const out = run('paste', notes, [1], { from: 1 });
    expect(reads(out)).toEqual([[1, 1.295]]);
    // (stretched over the note but for a quarter of the 10 ms muted)
    const cut = 2.305 - 0.01 / 4;
    expect(out.n[1]?.te).toBeCloseTo(cut, 9);
    expect(out.n[2]).toMatchObject({ t: 2.295, d: 0.01, m: true });
    expect(out.n[2]?.ts).toBeCloseTo(cut, 9);
    expectCanonical(out);
  });

  it('pastes from a note the context gives (another region of the recording), and from none without one', () => {
    const elsewhere: AudioNote = { t: 9, d: 0.6, p: 57.5, u: 0.02, to: 58, g: 4 };
    const out = run('paste', LINE, [0, 1], {}, { source: elsewhere });
    expect(out.n[0]).toEqual({ t: 1, d: 0.4, p: 57.5, u: 0.02, s: 9 });
    expect(out.n[1]).toMatchObject({ s: 9, p: 57.5, to: 58, g: -3 });
    // (only its sound comes: none of its edits)
    expect(out.n[1]?.g).toBe(-3);
    // a pasted note's sound is what it plays
    const twice = run('paste', LINE, [4], { from: 1 }, { source: out.n[0] });
    expect(twice.n[4]).toMatchObject({ s: 9, p: 57.5 });
    expect(run('paste', LINE, [0], {})).toBe(LINE);
    expect(run('paste', LINE, [0], { from: 9 })).toBe(LINE);
    // its own sound: nothing changes
    expect(run('paste', LINE, [0], { from: 1 })).toBe(LINE);
  });

  it('is for a line’s notes only, as time edits are', () => {
    const chords = poly([
      { t: 1, d: 1, p: 60 },
      { t: 1, d: 1, p: 64 },
    ]);
    expect(run('paste', chords, [1], { from: 1 })).toBe(chords);
    expect(edit('paste').modes).toEqual(['mono']);
  });

  it('gives a pasted note its own pitch back when the paste is put back, the notes as found known', () => {
    const out = run('paste', LINE, [0], { from: 5 });
    const back = run('reset', out, [0], {}, { found: LINE.n });
    expect(back).toEqual(LINE);
    expect(noteChangesText(noteChanges(out, back))).toBe('1 note back as recorded');
    // without them, its sound comes back but its pitch as found stays the sound's
    expect(run('reset', out, [0], {}).n[0]).toEqual({ t: 1, d: 0.4, p: 65 });
  });
});

describe('copying a note’s edits', () => {
  it('copies exactly the edits it says, each as the source has it, put back where it has none', () => {
    expect(COPIED_SETTINGS).toEqual(['to', 'dr', 'mo', 'tr', 'fo', 'g', 'm', 'at']);
    const source = {
      t: 9,
      d: 0.5,
      p: 62.4,
      u: 0.03,
      to: 62,
      dr: 0.3,
      mo: 1.5,
      tr: 0.5,
      fo: -2,
      g: -6,
      m: true,
      at: 0.5,
      ts: 9.1,
      te: 9.6,
      s: 4,
    } as AudioNote;
    const out = copySettings(LINE, [0, 3], source);
    expectCanonical(out);
    // the pitch move from its semitone (tuned onto it), never where it starts, ends or what it plays
    expect(out.n[0]).toEqual({
      t: 1,
      d: 0.4,
      p: 60.12,
      u: 0.05,
      to: 60,
      dr: 0.3,
      mo: 1.5,
      tr: 0.5,
      fo: -2,
      g: -6,
      m: true,
      at: 0.5,
    });
    expect(out.n[3]).toEqual({
      t: 2.8,
      d: 0.9,
      p: 67.2,
      to: 67,
      dr: 0.3,
      mo: 1.5,
      tr: 0.5,
      fo: -2,
      g: -6,
      m: true,
      at: 0.5,
    });
    // a source with none of them puts each back
    expect(copySettings(LINE, [1], { t: 9, d: 0.5, p: 62 }).n[1]).toEqual({ t: 1.6, d: 0.5, p: 64.3 });
    expect(run('copy-settings', LINE, [0, 3], { from: 2 }).n[3]).toEqual({
      t: 2.8,
      d: 0.9,
      p: 67.2,
      to: 67,
      g: -3,
      mo: 0.5,
    });
  });

  it('copies the pitch move as a distance from each note’s nearest semitone, so every note keeps its own pitch', () => {
    // up a fourth from its semitone: each goes up a fourth from its own
    const up = run('set-pitch', LINE, [1], { pitch: 69.1 });
    const out = run('copy-settings', up, [0, 3, 4], { from: 2 });
    expect([0, 3, 4].map((i) => out.n[i]?.to)).toEqual([65.1, 72.1, 70.1]);
  });

  it('from a note with no pitch, copies its level, mute and attack, and leaves the rest', () => {
    const breath = { t: 9, d: 0.3, p: null, g: -12, m: true } as AudioNote;
    const out = run('copy-settings', LINE, [1], {}, { source: breath });
    expect(out.n[1]).toEqual({ t: 1.6, d: 0.5, p: 64.3, to: 64, mo: 0.5, g: -12, m: true });
    // and a note with no pitch takes only those
    expect(run('copy-settings', LINE, [2], { from: 2 }).n[2]).toEqual({ t: 2.3, d: 0.2, p: null, g: -3 });
  });

  it('applies to chords’ notes as their edits do (no glide, no attack)', () => {
    const chords = poly([
      { t: 1, d: 1, p: 60.3, to: 60, tr: 2, fo: 1 },
      { t: 1, d: 1, p: 64.2 },
    ]);
    const out = run('copy-settings', chords, [1], { from: 1 });
    expect(out.n[1]).toEqual({ t: 1, d: 1, p: 64.2, to: 64, fo: 1 });
    expectCanonical(out);
  });
});

// ---- linked across regions ----

const BAR = 4 * PPQ;

/** A recording's notes as found: a note every half second from 0.25 s, the 5th sung into the 6th. */
function found(): AudioNotes {
  const n: AudioNote[] = [];
  for (let k = 0; k < 16; k++) n.push({ t: 0.25 + k * 0.5, d: k === 4 ? 0.5 : 0.4, p: 60 + (k % 5) + 0.25 });
  return mono(n);
}

/**
 * At 120 bpm: Verse plays 0–4 s of the take (bars 1–2), Again plays 1–5 s (bars 5–6) and keeps its
 * notes, Late plays 6–8 s, Other plays another recording; Keys is a MIDI track.
 */
function song(): Project {
  const p = newProject('Linked');
  p.tempo = [{ tick: 0, bpm: 120 }];
  const clip = (file: string, offset: number) => ({ file, offset, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 });
  const verse: Region = { ...newRegion(0, 2 * BAR, 'Verse'), id: 'rgn_verse', audio: clip('aud_take', 0) };
  const again: Region = {
    ...newRegion(4 * BAR, 2 * BAR, 'Again'),
    id: 'rgn_again',
    audio: { ...clip('aud_take', 1), notes: pruneNotes(found(), [1, 5]) },
  };
  const late: Region = { ...newRegion(8 * BAR, BAR, 'Late'), id: 'rgn_late', audio: clip('aud_take', 6) };
  const other: Region = { ...newRegion(0, 2 * BAR, 'Other'), id: 'rgn_other', audio: clip('aud_other', 0) };
  p.tracks = [
    { ...newAudioTrack('Vocal'), id: 'trk_vocal', regions: [verse, late] },
    { ...newAudioTrack('Double'), id: 'trk_double', regions: [again, other] },
  ];
  return parseProject(p);
}

const notesOf = (p: Project, id: string) =>
  p.tracks.flatMap((t) => t.regions).find((r) => r.id === id)?.audio?.notes as AudioNotes | undefined;

describe('an edit linked across the regions that play one recording', () => {
  it('finds the other regions playing the recording, on any track', () => {
    const p = song();
    expect(linkedRegions(p, 'rgn_verse').map((x) => x.region.id)).toEqual(['rgn_late', 'rgn_again']);
    expect(linkedRegions(p, 'rgn_other')).toEqual([]);
    expect(regionWindow(p, p.tracks[1]?.regions[0] as Region, p.tracks[1]?.regions[0]?.audio as never)).toEqual([1, 5]);
  });

  it('makes the edit on the same notes of each region that plays them, and only those, in one batch', () => {
    const p = song();
    const base = pruneNotes(found(), [0, 4]);
    // notes 3-4 of Verse (1.25 s and 1.75 s): Again plays them, Late doesn't
    const step = { name: 'shift', indices: [2, 3], args: { semitones: 2 } };
    const next = run('shift', base, [2, 3], { semitones: 2 });
    const { ops, changes } = linkedNoteEdits(p, { track: 'trk_vocal', region: 'rgn_verse' }, [step], {
      base,
      next,
      found: found(),
    });
    expect(changes.map((c) => [c.region.id, c.kept])).toEqual([
      ['rgn_verse', false],
      ['rgn_again', true],
    ]);
    expect(ops.map((o) => (o.op === 'updateRegion' ? o.region : ''))).toEqual(['rgn_verse', 'rgn_again']);
    const after = parseProject(applyOps(p, ops));
    // the song reads back the same, to the bit
    expect(parseProject(JSON.parse(JSON.stringify(after)))).toEqual(after);
    expect(notesOf(after, 'rgn_verse')).toEqual(next);
    const again = notesOf(after, 'rgn_again') as AudioNotes;
    expect(again.n.filter((n) => n.to !== undefined).map((n) => [n.t, n.to])).toEqual([
      [1.25, 64.25],
      [1.75, 65.25],
    ]);
    expect(notesOf(after, 'rgn_late')).toBeUndefined();
    expect(notesOf(after, 'rgn_other')).toBeUndefined();
    expect(noteChangesText(noteChanges(notesOf(p, 'rgn_again'), again))).toBe('2 notes tuned');
  });

  it('gives a region with no notes yet those found there, pruned, with the edit: its first edit', () => {
    const p = song();
    const base = notesOf(p, 'rgn_again') as AudioNotes;
    // Again's note at 6.75 s (its last, kept past its edge) isn't played there; Late plays it
    const i = base.n.findIndex((n) => n.t === 3.25);
    const next = run('mute', base, [i], {});
    const { changes } = linkedNoteEdits(
      p,
      { track: 'trk_double', region: 'rgn_again' },
      [{ name: 'mute', indices: [i], args: {} }],
      { base, next, found: found() },
    );
    const verse = changes.find((c) => c.region.id === 'rgn_verse');
    expect(verse?.kept).toBe(false);
    expect(verse?.now).toEqual(run('mute', pruneNotes(found(), [0, 4]), [6], {}));
    expect(verse?.was).toEqual(pruneNotes(found(), [0, 4]));
    expect(changes.map((c) => c.region.id)).toEqual(['rgn_again', 'rgn_verse']);
    // without the notes found, a region with none is left out
    expect(
      linkedNoteEdits(p, { track: 'trk_double', region: 'rgn_again' }, [{ name: 'mute', indices: [i], args: {} }], {
        base,
        next,
      }).changes.map((c) => c.region.id),
    ).toEqual(['rgn_again']);
  });

  it('pastes the same sound in every region, the note it’s copied from carried as itself', () => {
    const p = song();
    const base = pruneNotes(found(), [0, 4]);
    // note 4 of Verse (1.75 s) takes the sound of its note 1 (0.25 s), which Again doesn't keep
    const next = run('paste', base, [3], { from: 1 });
    const { changes } = linkedNoteEdits(
      p,
      { track: 'trk_vocal', region: 'rgn_verse' },
      [{ name: 'paste', indices: [3], args: { from: 1 } }],
      { base, next, found: found() },
    );
    const again = changes.find((c) => c.region.id === 'rgn_again')?.now as AudioNotes;
    expect(again.n.find((n) => n.t === 1.75)).toMatchObject({ s: 0.25, p: 60.25 });
    expectCanonical(again);
  });

  it('leaves regions found by another detection, and makes the edits of a gesture one after another', () => {
    const p = song();
    const again = p.tracks[1]?.regions[0];
    if (again?.audio?.notes) again.audio.notes = { ...again.audio.notes, v: 2 };
    const base = pruneNotes(found(), [0, 4]);
    const steps = [
      { name: 'gain', indices: [2], args: { db: -3 } },
      { name: 'gain', indices: [3], args: { db: -6 } },
    ];
    const next = run('gain', run('gain', base, [2], { db: -3 }), [3], { db: -6 });
    expect(
      linkedNoteEdits(p, { track: 'trk_vocal', region: 'rgn_verse' }, steps, {
        base,
        next,
        found: found(),
      }).changes.map((c) => c.region.id),
    ).toEqual(['rgn_verse']);
    const q = song();
    const linked = linkedNoteEdits(q, { track: 'trk_vocal', region: 'rgn_verse' }, steps, {
      base,
      next,
      found: found(),
    });
    const now = linked.changes[1]?.now as AudioNotes;
    expect(now.n.filter((n) => n.g !== undefined).map((n) => [n.t, n.g])).toEqual([
      [1.25, -3],
      [1.75, -6],
    ]);
  });
});
