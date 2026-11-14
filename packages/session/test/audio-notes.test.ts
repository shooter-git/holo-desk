import { describe, expect, it } from 'vitest';
import {
  type AudioNote,
  type AudioNotes,
  MAX_AUDIO_NOTES,
  newAudioTrack,
  newProject,
  newRegion,
  PPQ,
  type Project,
  parseAudioNotes,
  parseProject,
  unwarpAt,
  warpAt,
  warpOf,
  warpProblem,
} from '../src/index.ts';

/** A song with one audio region whose clip carries `notes` as given (anything: the song is read as it comes). */
function songWith(notes: unknown): Project {
  const p = newProject('Notes');
  const region = {
    ...newRegion(0, 4 * PPQ),
    audio: { file: 'aud_vocal', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1, notes: notes as AudioNotes },
  };
  p.tracks.push({ ...newAudioTrack('Vocal'), id: 'trk_vocal', regions: [region] });
  return p;
}
const notesOf = (p: Project) => p.tracks.find((t) => t.id === 'trk_vocal')?.regions[0]?.audio?.notes;
const read = (n: unknown) => notesOf(parseProject(songWith(n)));
const mono = (n: unknown[]): AudioNotes | undefined => parseAudioNotes({ mode: 'mono', v: 1, n });

describe('a region’s notes in the song', () => {
  it('read back the same, to the bit, however often the song is saved', () => {
    const notes = {
      mode: 'mono',
      v: 1,
      n: [
        { t: 0.5, d: 0.4, p: 64.183, u: 0.05, to: 64, dr: 0.5, mo: 1.2, tr: 0.8, fo: -2, g: 3 },
        { t: 1, d: 0.3, p: null, m: true },
        { t: 1.4, d: 0.5, p: 67.02, ts: 1.45, te: 1.9, at: 0.5 },
      ],
    };
    const once = parseProject(songWith(notes));
    const twice = parseProject(JSON.parse(JSON.stringify(once)));
    expect(notesOf(twice)).toEqual(notesOf(once));
    expect(notesOf(once)).toEqual(notes);
  });

  it('round each number as it’s kept, and clamp it to its range', () => {
    expect(
      read({
        mode: 'mono',
        v: 2.4,
        n: [{ t: 1.234567, d: 0.000_5, p: 64.18349, u: 0.3, to: 200, dr: 1.333, mo: -1, fo: 20, g: -100 }],
      }),
    ).toEqual({
      mode: 'mono',
      v: 2,
      n: [{ t: 1.2346, d: 0.01, p: 64.183, u: 0.01, to: 127, dr: 1, mo: 0, fo: 12, g: -60 }],
    });
  });

  it('leave out what can’t be read: unknown keys, broken notes, an unknown kind of notes', () => {
    expect(
      read({ mode: 'mono', v: 1, n: [{ t: 1, d: 0.5, p: 60, zz: 1 }, { t: 'x', d: 1, p: 60 }, null, { t: 2, d: 1 }] }),
    ).toEqual({ mode: 'mono', v: 1, n: [{ t: 1, d: 0.5, p: 60 }] });
    expect(read({ mode: 'melodic', v: 1, n: [] })).toBeUndefined();
    expect(read({ mode: 'mono', v: 1 })).toBeUndefined();
    expect(read('notes')).toBeUndefined();
    // a region without notes keeps none
    expect(notesOf(parseProject(songWith(undefined)))).toBeUndefined();
  });

  it('keep a line’s notes apart: one ends where the next starts, one on another’s start goes', () => {
    expect(
      mono([
        { t: 1, d: 0.6, p: 60, u: 0.5 },
        { t: 1.2, d: 0.3, p: 62 },
        { t: 1.205, d: 0.2, p: 64 },
      ])?.n,
    ).toEqual([
      { t: 1, d: 0.2, p: 60, u: 0.2 },
      { t: 1.2, d: 0.3, p: 62 },
    ]);
  });

  it('let chords’ notes overlap, sorted by start then pitch, and keep no moves in time for them yet', () => {
    const poly = parseAudioNotes({
      mode: 'poly',
      v: 1,
      n: [
        { t: 1, d: 1, p: 67, ts: 1.1, te: 2, at: 2, s: 0.5, tr: 2, off: true },
        { t: 1, d: 1, p: 60, to: 61 },
        { t: 0.5, d: 2, p: null },
      ],
    });
    expect(poly?.n).toEqual([
      { t: 0.5, d: 2, p: null },
      { t: 1, d: 1, p: 60, to: 61 },
      { t: 1, d: 1, p: 67, off: true },
    ]);
    // `off` is a chord's note left out by hand: a line has none
    expect(mono([{ t: 1, d: 1, p: 60, off: true }])?.n).toEqual([{ t: 1, d: 1, p: 60 }]);
  });

  it('give a note with no pitch no pitch edits, but its level and mute', () => {
    expect(mono([{ t: 1, d: 0.2, p: null, to: 60, dr: 0, mo: 0, tr: 1, fo: 3, g: -6, m: true }])?.n).toEqual([
      { t: 1, d: 0.2, p: null, g: -6, m: true },
    ]);
  });

  it('keep a tuning and a sensitivity in range, and no tuning at 440', () => {
    expect(parseAudioNotes({ mode: 'poly', v: 1, n: [], a4: 442.123, sens: 3, off: true })).toEqual({
      mode: 'poly',
      v: 1,
      n: [],
      a4: 442.12,
      sens: 1,
      off: true,
    });
    expect(parseAudioNotes({ mode: 'mono', v: 1, n: [], a4: 440 })).toEqual({ mode: 'mono', v: 1, n: [] });
  });

  it(`keep at most ${MAX_AUDIO_NOTES} notes`, () => {
    const many = Array.from({ length: MAX_AUDIO_NOTES + 5 }, (_, i) => ({ t: i * 0.02, d: 0.015, p: 60 }));
    expect(mono(many)?.n).toHaveLength(MAX_AUDIO_NOTES);
  });
});

describe('the warp of notes moved in time', () => {
  const line = (moved: Partial<AudioNote>): AudioNote[] =>
    mono([
      { t: 1, d: 0.5, p: 60 },
      { t: 2, d: 0.5, p: 62, u: 0.08, ...moved },
      { t: 3, d: 0.5, p: 64 },
    ])?.n as AudioNote[];

  it('is nothing when no note moves', () => {
    const w = warpOf(line({}));
    expect(w.src).toEqual([]);
    expect(warpAt(w, 2.3)).toBe(2.3);
  });

  it('moves a note and the sound under it, and nothing past the rests either side', () => {
    const notes = line({ ts: 2.1, te: 2.6 });
    expect(notes[1]).toMatchObject({ ts: 2.1, te: 2.6 });
    const w = warpOf(notes);
    expect(warpProblem(w)).toBe(-1);
    expect(warpAt(w, 2)).toBeCloseTo(2.1, 12);
    expect(warpAt(w, 2.5)).toBeCloseTo(2.6, 12);
    // its consonant keeps its length
    expect(warpAt(w, 2.08)).toBeCloseTo(2.18, 12);
    // the notes either side, and everything past the rests, stay where they were
    for (const x of [0.2, 1, 1.25, 1.5, 3, 3.25, 3.5, 10]) expect(warpAt(w, x)).toBe(x);
    // and the way back
    for (const x of [1.8, 2.05, 2.3, 2.75]) expect(unwarpAt(w, warpAt(w, x))).toBeCloseTo(x, 12);
  });

  it('stretches a note’s vowel, not its consonant, and plays its attack faster or slower', () => {
    const w = warpOf(line({ te: 2.75, at: 0.5 }));
    expect(warpAt(w, 2)).toBe(2);
    expect(warpAt(w, 2.08)).toBeCloseTo(2.08, 12);
    // the attack (60 ms after the consonant) in half the time
    expect(warpAt(w, 2.14)).toBeCloseTo(2.11, 12);
    expect(warpAt(w, 2.5)).toBeCloseTo(2.75, 12);
  });

  it('lets go of a move that runs time backwards or squeezes past four times', () => {
    // past the next note: time would run backwards
    expect(line({ ts: 3.1, te: 3.6 })[1]).toEqual({ t: 2, d: 0.5, p: 62, u: 0.08 });
    // its 0.5 s squeezed into 0.1 s
    expect(line({ te: 2.1 })[1]).toEqual({ t: 2, d: 0.5, p: 62, u: 0.08 });
    // and a move further than 4 s is held to 4 s, then fits or goes
    expect(line({ ts: 9, te: 9.5 })[1]).toEqual({ t: 2, d: 0.5, p: 62, u: 0.08 });
  });

  it('only moves a line’s notes', () => {
    expect(warpOf({ mode: 'poly', v: 1, n: [{ t: 1, d: 1, p: 60, ts: 1.2 }] }).src).toEqual([]);
  });
});
