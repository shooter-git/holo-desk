/**
 * The macros (correct-pitch, quantize-time, level) as the registry makes them, and a region's notes
 * made a MIDI track (notesToMidi): synthetic notes only.
 */
import { describe, expect, it } from 'vitest';
import {
  type AudioNote,
  type AudioNotes,
  applyOps,
  DIVISIONS,
  fileToTick,
  fileToTicks,
  MAX_MOVE_S,
  MIDI_LOUDEST_VELOCITY,
  MIDI_NOTE_VELOCITY,
  midiNotesOf,
  moveNotes,
  type NoteArgs,
  type NoteEdit,
  type NoteEditContext,
  newAudioTrack,
  newProject,
  newRegion,
  noteEdit,
  notesToMidi,
  type Op,
  PPQ,
  type Project,
  parseAudioNotes,
  parseProject,
  type Region,
  warpOf,
  warpProblem,
} from '../src/index.ts';

const mono = (n: unknown[]): AudioNotes => parseAudioNotes({ mode: 'mono', v: 1, n }) as AudioNotes;
const poly = (n: unknown[]): AudioNotes => parseAudioNotes({ mode: 'poly', v: 1, n }) as AudioNotes;

/** What a song keeps: read back, the notes are the same to the bit, and a line's moves fit the warp. */
function expectCanonical(notes: AudioNotes): void {
  expect(parseAudioNotes(JSON.parse(JSON.stringify(notes)))).toEqual(notes);
  if (notes.mode === 'mono') expect(warpProblem(warpOf(notes))).toBe(-1);
}

const macro = (name: string) => noteEdit(name) as NoteEdit;
const all = (notes: AudioNotes) => notes.n.map((_, i) => i);

/** A line: a note 12 cents sharp with a consonant, one on G, one 30 cents sharp, a breath, one 40 cents flat. */
const LINE = mono([
  { t: 1, d: 0.5, p: 60.12, u: 0.05 },
  { t: 1.5, d: 0.4, p: 62 },
  { t: 2.2, d: 0.5, p: 64.3 },
  { t: 3, d: 0.3, p: null },
  { t: 3.5, d: 0.6, p: 66.6 },
]);

/** A song at 120 bpm, then 90 from bar 2; a vocal region from beat 2, 0.5 s into its recording, stretched 1.25. */
function vocalSong(notes: AudioNotes): Project {
  const p = newProject('Vocal');
  p.key = 'C major';
  p.tempo = [
    { tick: 0, bpm: 120 },
    { tick: 4 * PPQ, bpm: 90 },
  ];
  const region: Region = { ...newRegion(2 * PPQ, 16 * PPQ, 'Take'), id: 'rgn_vocal' };
  region.audio = { file: 'aud_vocal', offset: 0.5, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1.25, notes };
  p.files = [{ id: 'aud_vocal', name: 'Vocal.wav', seconds: 30, rate: 48000, channels: 1 }];
  p.tracks.push({ ...newAudioTrack('Vocal'), id: 'trk_vocal', regions: [region] });
  return parseProject(p);
}
const regionOf = (p: Project) => p.tracks.flatMap((t) => t.regions).find((r) => r.id === 'rgn_vocal') as Region;
const contextOf = (p: Project, notes: AudioNotes, more: Partial<NoteEditContext> = {}): NoteEditContext => {
  const r = regionOf(p);
  return {
    project: p,
    region: { start: r.start, audio: { ...(r.audio as NonNullable<Region['audio']>), notes } },
    ...more,
  };
};

describe('correct-pitch', () => {
  const run = (args: NoteArgs, notes = LINE, idx = all(notes), ctx: NoteEditContext = {}) =>
    macro('correct-pitch').apply(notes, idx, args, ctx);

  it('lands each note’s centre on its semitone, all the way by default, leaving breaths and notes on pitch alone', () => {
    const out = run({});
    expect(out.n.map((n) => n.to)).toEqual([60, undefined, 64, undefined, 67]);
    // (a note on its pitch already, and a breath, are the same objects)
    expect(out.n[1]).toBe(LINE.n[1]);
    expect(out.n[3]).toBe(LINE.n[3]);
    expectCanonical(out);
    // a second time changes nothing: the same notes
    expect(run({}, out)).toBe(out);
  });

  it('moves part of the way: 50% halfway, from where a note is tuned now', () => {
    expect(run({ centre: 50 }).n.map((n) => n.to)).toEqual([60.06, undefined, 64.15, undefined, 66.8]);
    // a note shifted by hand before: toward the semitone nearest where it is now
    const shifted = { ...LINE, n: LINE.n.map((n, i) => (i === 2 ? { ...n, to: 66.4 } : n)) };
    expect(run({ centre: 50 }, shifted).n[2]?.to).toBe(66.2);
  });

  it('leaves notes within the tolerance of their pitch as they are, drift too', () => {
    const out = run({ tolerance: 20, drift: 50 });
    // 12 cents sharp: left; on G (0 cents): left; 30 and 40 cents off: tuned
    expect(out.n[0]).toBe(LINE.n[0]);
    expect(out.n[1]).toBe(LINE.n[1]);
    expect(out.n[2]).toMatchObject({ to: 64, dr: 0.5 });
    expect(out.n[4]).toMatchObject({ to: 67, dr: 0.5 });
    // no tolerance: a note on its pitch takes the drift
    expect(run({ drift: 50 }).n[1]).toEqual({ t: 1.5, d: 0.4, p: 62, dr: 0.5 });
  });

  it('takes out the share of drift asked, as sung, and none by default', () => {
    const out = run({ centre: 0, drift: 40 });
    expect(out.n.map((n) => n.dr)).toEqual([0.6, 0.6, 0.6, undefined, 0.6]);
    expect(out.n.map((n) => n.to)).toEqual([undefined, undefined, undefined, undefined, undefined]);
    expect(run({}).n.every((n) => n.dr === undefined)).toBe(true);
    // a drift kept before is left as it is when none is taken out
    const kept = run({ centre: 0, drift: 70 });
    expect(run({}, kept).n[1]?.dr).toBe(0.3);
    expect(run({ centre: 0, drift: 100 }).n[0]?.dr).toBe(0);
  });

  it('snaps to the key’s scale where each note plays, following a key change mid-song', () => {
    // two notes at F# +40 cents: in C major the nearest note of the scale is G; in D major, F#
    const notes = mono([
      { t: 1, d: 0.5, p: 66.4 },
      { t: 12, d: 0.5, p: 66.4 },
    ]);
    const p = vocalSong(notes);
    p.keys = [
      { tick: 0, fifths: 0, mode: 'major' },
      { tick: 8 * PPQ, fifths: 2, mode: 'major' },
    ];
    // (the first plays before bar 3, the second after)
    const r = regionOf(p);
    expect(fileToTick(p, r, 1)).toBeLessThan(8 * PPQ);
    expect(fileToTick(p, r, 12)).toBeGreaterThan(8 * PPQ);
    const ctx = contextOf(p, notes);
    expect(run({ snap: 'scale' }, notes, [0, 1], ctx).n.map((n) => n.to)).toEqual([67, 66]);
    expect(run({ snap: 'semitone' }, notes, [0, 1], ctx).n.map((n) => n.to)).toEqual([66, 66]);
    // without the song, a scale snaps to the nearest semitone
    expect(run({ snap: 'scale' }, notes, [0, 1]).n.map((n) => n.to)).toEqual([66, 66]);
  });

  it('tunes chords’ notes too, and only the notes chosen', () => {
    const chords = poly([
      { t: 1, d: 1, p: 60.2 },
      { t: 1, d: 1, p: 63.7 },
      { t: 1, d: 1, p: 67 },
    ]);
    const out = run({}, chords, [1]);
    expect(out.n.map((n) => n.to)).toEqual([undefined, 64, undefined]);
    expect(out.n[0]).toBe(chords.n[0]);
    expectCanonical(out);
    const perc = parseAudioNotes({ mode: 'perc', v: 1, n: [{ t: 1, d: 0.1, p: null }] }) as AudioNotes;
    expect(run({}, perc)).toBe(perc);
  });
});

describe('quantize-time', () => {
  /** A line in a song with a tempo change and a stretched, offset region: three notes off the 1/8 grid, two touching. */
  const notes = mono([
    { t: 1.03, d: 0.4, p: 60, u: 0.06 },
    { t: 1.62, d: 0.3, p: 62 },
    { t: 1.92, d: 0.4, p: 64 },
    { t: 3.07, d: 0.5, p: null },
    { t: 4.01, d: 0.6, p: 67, u: 0.04 },
  ]);
  const song = vocalSong(notes);
  const ctx = contextOf(song, notes);
  const eighth = DIVISIONS['1/8'] as number;
  const run = (args: NoteArgs, idx = [0, 1, 2, 4], c: NoteEditContext = ctx) =>
    macro('quantize-time').apply(notes, idx, { grid: '1/8', ...args }, c);
  /** Where each note's beat plays, in ticks: past its consonant, as the region plays it. */
  const beats = (out: AudioNotes) => {
    const tick = fileToTicks(song, regionOf(song), true);
    return out.n.map((n) => tick((n.ts ?? n.t) + (n.u ?? 0)));
  };
  const offGrid = (tick: number) => tick - Math.round(tick / eighth) * eighth;

  it('puts the beats on the grid, each note moving whole so its consonant stays before its beat', () => {
    const before = beats(notes);
    const out = run({});
    expectCanonical(out);
    const after = beats(out);
    for (const i of [0, 1, 2, 4]) {
      expect(Math.abs(offGrid(before[i] as number))).toBeGreaterThan(5);
      // (to the 0.1 ms a time is kept to: under a tick)
      expect(Math.abs(offGrid(after[i] as number)), `note ${i + 1}`).toBeLessThan(0.5);
      const n = out.n[i] as AudioNote;
      expect(n.u).toBe(notes.n[i]?.u);
      if (n.u) expect((n.ts as number) + n.u).toBeGreaterThan(n.ts as number);
    }
    // the breath wasn't chosen: it stays where it was
    expect(out.n[3]).toBe(notes.n[3]);
    // the two touching notes still touch where they now play
    expect(out.n[1]?.te).toBe(out.n[2]?.ts);
    expect(warpProblem(warpOf(out))).toBe(-1);
  });

  it('moves halfway at 50%, and not at all at 0%', () => {
    const before = beats(notes);
    const after = beats(run({ amount: 50 }));
    for (const i of [0, 2, 4])
      expect(Math.abs((after[i] as number) - (before[i] as number) + offGrid(before[i] as number) / 2)).toBeLessThan(1);
    expect(run({ amount: 0 })).toBe(notes);
  });

  it('follows the grid chosen, in any case of its name', () => {
    const quarter = DIVISIONS['1/4'] as number;
    const after = beats(run({ grid: '1/4' }));
    expect(Math.abs((after[4] as number) - Math.round((after[4] as number) / quarter) * quarter)).toBeLessThan(0.5);
    const triplets = beats(run({ grid: '1/8t' }));
    const step = DIVISIONS['1/8T'] as number;
    expect(Math.abs((triplets[4] as number) - Math.round((triplets[4] as number) / step) * step)).toBeLessThan(0.5);
  });

  it('keeps every move within 4 s and the warp, as far as it fits', () => {
    // a whole note at 20 bpm is 12 s: the nearest bar line is more than 4 s from this note's beat
    const slow = vocalSong(mono([{ t: 6, d: 0.5, p: 60 }]));
    slow.tempo = [{ tick: 0, bpm: 20 }];
    const lone = regionOf(slow).audio?.notes as AudioNotes;
    const out = macro('quantize-time').apply(lone, [0], { grid: '1/1' }, contextOf(slow, lone));
    const n = out.n[0] as AudioNote;
    expect(n.ts).toBeDefined();
    expect(Math.abs((n.ts as number) - n.t)).toBeLessThanOrEqual(MAX_MOVE_S);
    expect(warpProblem(warpOf(out))).toBe(-1);
    expectCanonical(out);
  });

  it('moves from where a note plays now, and changes nothing a second time', () => {
    const moved = moveNotes(notes, [4], 0.21);
    const once = macro('quantize-time').apply(moved, [4], { grid: '1/8' }, contextOf(song, moved));
    expect(Math.abs(offGrid(beats(once)[4] as number))).toBeLessThan(0.5);
    const out = run({});
    expect(macro('quantize-time').apply(out, [0, 1, 2, 4], { grid: '1/8' }, contextOf(song, out))).toBe(out);
  });

  it('needs the song and region, and moves only a line’s notes', () => {
    expect(macro('quantize-time').apply(notes, [0], {})).toBe(notes);
    const chords = poly([{ t: 1.03, d: 1, p: 60 }]);
    expect(macro('quantize-time').apply(chords, [0], {}, contextOf(song, chords))).toBe(chords);
  });
});

describe('level', () => {
  const run = (args: NoteArgs, levels: (number | null)[] | undefined, notes = LINE, idx = all(notes)) =>
    macro('level').apply(notes, idx, args, levels ? { levels } : {});
  const LEVELS = [-20.004, -14, -31, -40, -17];
  /** Each note's level as it plays: as recorded, with its gain. */
  const playing = (out: AudioNotes, levels = LEVELS) => out.n.map((n, i) => (levels[i] as number) + (n.g ?? 0));

  it('brings the notes’ levels to their mean all the way, halfway at 50%', () => {
    const out = run({}, LEVELS);
    expectCanonical(out);
    const mean = (-20 - 14 - 31 - 40 - 17) / 5;
    for (const level of playing(out)) expect(level).toBeCloseTo(mean, 1);
    expect(out.n.map((n) => n.g)).toEqual([-4.4, -10.4, 6.6, 15.6, -7.4]);
    // a breath takes a level too
    expect(out.n[3]?.p).toBeNull();
    // a second time, nothing changes
    expect(run({}, LEVELS, out)).toBe(out);
    const half = playing(run({ amount: 50 }, LEVELS));
    const spread = (xs: number[]) => Math.max(...xs) - Math.min(...xs);
    expect(spread(half)).toBeCloseTo(spread(playing(LINE)) / 2, 1);
  });

  it('goes to a level given instead', () => {
    for (const level of playing(run({ target: -18 }, LEVELS))) expect(level).toBeCloseTo(-18, 1);
  });

  it('counts the notes as they play: their gain in, muted ones and ones without a level left out', () => {
    const edited = {
      ...LINE,
      n: LINE.n.map((n, i) => (i === 1 ? { ...n, g: -6 } : i === 4 ? { ...n, m: true as const } : n)),
    };
    const out = run({}, [-20, -14, null, -32, -17], edited);
    // -20, -20 (as it plays) and -32: the mean is -24
    expect(out.n.map((n) => n.g)).toEqual([-4, -10, undefined, 8, undefined]);
    expect(out.n[2]).toBe(edited.n[2]);
    expect(out.n[4]).toBe(edited.n[4]);
  });

  it('doesn’t apply without the levels, as without an argument it needs', () => {
    expect(run({}, undefined)).toBe(LINE);
    expect(run({}, [null, null, null, null, null])).toBe(LINE);
    expect(macro('level').needsLevels).toBe(true);
  });
});

describe('a region’s notes as a MIDI track', () => {
  const notes = mono([
    { t: 0.4, d: 0.3, p: 60 },
    { t: 1, d: 0.5, p: 60.12, u: 0.05 },
    { t: 1.5, d: 0.4, p: 62.6 },
    { t: 2.2, d: 0.5, p: 64.3, to: 65.4 },
    { t: 3, d: 0.3, p: null },
    { t: 3.5, d: 0.6, p: 67, m: true },
    { t: 4.6, d: 0.6, p: 69 },
  ]);
  const song = vocalSong(notes);
  const region = regionOf(song);
  const tick = fileToTicks(song, region);

  it('puts each note where its beat plays, through the offset, the stretch and a tempo change, to where it ends', () => {
    const midi = midiNotesOf(song, region, notes);
    // the first starts before the region (0.4 s, its offset 0.5 s): left out; the breath and the muted note too
    expect(midi.map((n) => n.p)).toEqual([60, 63, 65, 69]);
    const [a, b, , d] = midi;
    expect(a?.t).toBe(Math.round(tick(1.05)) - region.start);
    expect(a?.d).toBe(Math.round(tick(1.5)) - Math.round(tick(1.05)));
    expect(b?.t).toBe(Math.round(tick(1.5)) - region.start);
    // 4.6 s of the recording plays 4.1 s after its offset, stretched to 5.125 s after the region's start
    // (1 s into the song, at 120 bpm): past the change to 90 at bar 2 (2 s)
    const seconds = 1 + 5.125;
    expect(seconds).toBeGreaterThan(2);
    expect(d?.t).toBe(Math.round(4 * PPQ + ((seconds - 2) * 90 * PPQ) / 60) - region.start);
    expect(midi.every((n) => n.v === MIDI_NOTE_VELOCITY)).toBe(true);
  });

  it('plays a note moved in time where it now plays, and an edited pitch at its nearest semitone', () => {
    const moved = moveNotes(notes, [6], 0.1);
    const midi = midiNotesOf(song, region, moved);
    expect(midi[3]?.t).toBe(Math.round(fileToTick(song, region, 4.7, true)) - region.start);
    expect(midi[2]?.p).toBe(65);
    // the region's edits off: as recorded, the muted note in
    const off = midiNotesOf(song, region, { ...moved, off: true });
    expect(off.map((n) => n.p)).toEqual([60, 63, 64, 67, 69]);
    expect(off[4]?.t).toBe(Math.round(fileToTick(song, region, 4.6, true)) - region.start);
  });

  it('gives velocities from the notes’ levels as they play, the loudest at 110', () => {
    const levels = [-10, -12, -18, null, -30, -5, -6];
    const midi = midiNotesOf(song, region, notes, levels);
    // (the muted note, loudest of all, isn't counted)
    expect(midi.map((n) => n.v)).toEqual([
      Math.round(MIDI_LOUDEST_VELOCITY * 10 ** (-6 / 40)),
      Math.round(MIDI_LOUDEST_VELOCITY * 10 ** (-12 / 40)),
      MIDI_NOTE_VELOCITY,
      MIDI_LOUDEST_VELOCITY,
    ]);
  });

  it('adds a MIDI track named after the audio track, just below it, with one region over the recording’s', () => {
    const ops = notesToMidi(song, 'trk_vocal', 'rgn_vocal');
    expect(ops.map((o) => o.op)).toEqual(['addTrack', 'addRegion']);
    const [add, put] = ops as [Extract<Op, { op: 'addTrack' }>, Extract<Op, { op: 'addRegion' }>];
    const at = song.tracks.findIndex((t) => t.id === 'trk_vocal');
    expect(add).toMatchObject({ index: at + 1, track: { name: 'Vocal notes', kind: 'instrument' } });
    expect(put.track).toBe(add.track.id);
    expect(put.region).toMatchObject({ start: region.start, length: region.length, name: 'Take' });
    expect(put.region.notes).toEqual(midiNotesOf(song, region, notes));
    // they apply to the song, and it reads back with the track
    const next = parseProject(applyOps(song, ops));
    expect(next.tracks[at + 1]).toMatchObject({ name: 'Vocal notes', kind: 'instrument' });
    expect(next.tracks[at + 1]?.regions[0]?.notes).toHaveLength(4);
    // given notes (found, before a first edit), and nothing for a region that isn't a recording
    expect(
      (notesToMidi(song, 'trk_vocal', 'rgn_vocal', { notes: mono([]) })[1] as { region: Region }).region.notes,
    ).toEqual([]);
    expect(notesToMidi(song, 'trk_vocal', 'rgn_nope')).toEqual([]);
  });
});
