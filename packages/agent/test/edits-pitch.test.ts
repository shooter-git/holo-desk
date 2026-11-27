/** Notes and the song's key: what the Piano Roll's shading, Snap to key and Move into key go by, and `regions into_key`. */
import { type Note, newRegion, PPQ, type Project, type Region, type Scale, scaleAt } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { inKey, intoKey, keySpans, notesIntoKey, outsideKey, stepInKey } from '../src/edits/pitch.ts';

const BAR = PPQ * 4;
const dMinor = scaleAt({ key: 'D minor' }, 0) as Scale;
const cMajor = scaleAt({ key: 'C major' }, 0) as Scale;

describe('inKey', () => {
  it('knows a key’s notes in every octave', () => {
    // D E F G A B♭ C
    for (const p of [62, 64, 65, 67, 69, 70, 72, 50, 38, 74]) expect([p, inKey(dMinor, p)]).toEqual([p, true]);
    for (const p of [61, 63, 66, 68, 71, 73]) expect([p, inKey(dMinor, p)]).toEqual([p, false]);
  });

  it('counts every note as in when there’s no key', () => {
    expect(inKey(null, 61)).toBe(true);
  });
});

describe('intoKey', () => {
  it('leaves a note of the key where it is', () => {
    for (const p of [60, 62, 64, 65, 67, 69, 71]) expect(intoKey(cMajor, p)).toBe(p);
  });

  it('takes a note between two of the key to the lower, as the Scale Quantizer does', () => {
    expect(intoKey(cMajor, 61)).toBe(60);
    expect(intoKey(cMajor, 66)).toBe(65);
    expect(intoKey(cMajor, 70)).toBe(69);
  });

  it('takes the nearer where one is', () => {
    // in D minor, B (71) is a semitone above B♭ and a semitone under C: the lower; C♯ (61): C or D, the lower
    expect(intoKey(dMinor, 71)).toBe(70);
    expect(intoKey(dMinor, 61)).toBe(60);
    // E♭ (63): D below, E above, both a semitone: the lower
    expect(intoKey(dMinor, 63)).toBe(62);
  });

  it('stays on the keyboard, and is the pitch itself with no key', () => {
    expect(intoKey(cMajor, 127)).toBe(127);
    expect(intoKey(dMinor, 0)).toBe(0);
    expect(intoKey(dMinor, 1)).toBe(0);
    expect(intoKey(null, 61.4)).toBe(61);
  });
});

describe('stepInKey', () => {
  it('moves by the key’s steps, up and down', () => {
    expect(stepInKey(cMajor, 60, 1)).toBe(62);
    expect(stepInKey(cMajor, 60, 2)).toBe(64);
    expect(stepInKey(cMajor, 64, 1)).toBe(65);
    expect(stepInKey(cMajor, 60, -1)).toBe(59);
    expect(stepInKey(cMajor, 60, 7)).toBe(72);
    expect(stepInKey(cMajor, 60, 0)).toBe(60);
  });

  it('from a note outside the key, the first step is onto it', () => {
    expect(stepInKey(cMajor, 61, 1)).toBe(62);
    expect(stepInKey(cMajor, 61, -1)).toBe(60);
    expect(stepInKey(cMajor, 61, 2)).toBe(64);
    expect(stepInKey(cMajor, 61, 0)).toBe(61);
  });

  it('stops at the ends of the keyboard', () => {
    expect(stepInKey(cMajor, 127, 3)).toBe(127);
    expect(stepInKey(cMajor, 0, -2)).toBe(0);
  });

  it('is a semitone a step with no key', () => {
    expect(stepInKey(null, 60, 3)).toBe(63);
    expect(stepInKey(null, 126, 5)).toBe(127);
  });
});

describe('keySpans', () => {
  it('has none for a song with no key', () => {
    expect(keySpans({ key: null }, 0, 100 * BAR)).toEqual([]);
    expect(keySpans({ key: 'no key here' }, 0, 100 * BAR)).toEqual([]);
  });

  it('is one span for a song in one key', () => {
    const spans = keySpans({ key: 'D minor' }, 4 * BAR, 12 * BAR);
    expect(spans.map((s) => [s.from, s.to, s.scale.name])).toEqual([[4 * BAR, 12 * BAR, 'D minor']]);
  });

  it('cuts where the key changes, within what’s asked for', () => {
    const song: Pick<Project, 'key' | 'keys'> = {
      key: 'D minor',
      keys: [
        { tick: 0, fifths: -1, mode: 'minor' },
        { tick: 8 * BAR, fifths: 2, mode: 'major' },
        { tick: 16 * BAR, fifths: 2, mode: 'major' },
        { tick: 24 * BAR, fifths: 0, mode: 'major' },
      ],
    };
    expect(keySpans(song, 4 * BAR, 20 * BAR).map((s) => [s.from / BAR, s.to / BAR, s.scale.name])).toEqual([
      [4, 8, 'D minor'],
      // (the same key said again at bar 17 is one span)
      [8, 20, 'D major'],
    ]);
    expect(keySpans(song, 30 * BAR, 31 * BAR).map((s) => s.scale.name)).toEqual(['C major']);
  });
});

describe('a region’s notes and the key', () => {
  const song: Pick<Project, 'key' | 'keys'> = {
    key: 'C major',
    keys: [
      { tick: 0, fifths: 0, mode: 'major' },
      { tick: 2 * BAR, fifths: 2, mode: 'major' },
    ],
  };
  const note = (t: number, p: number): Note => ({ t, d: PPQ, p, v: 90 });
  // a region from bar 2: its second bar is in D major
  const region: Region = {
    ...newRegion(BAR, 2 * BAR),
    notes: [note(0, 60), note(PPQ, 66), note(BAR, 66), note(BAR + PPQ, 60), note(BAR + 2 * PPQ, 61)],
  };

  it('reads each note against the key where it starts', () => {
    // F♯ is outside C major (bar 2) and in D major (bar 3); C is in C major and outside D major
    expect(outsideKey(song, region).map((n) => [n.t, n.p])).toEqual([
      [PPQ, 66],
      [BAR + PPQ, 60],
    ]);
  });

  it('moves the ones outside onto it, and says how many', () => {
    const into = notesIntoKey(song, region);
    expect(into?.moved).toBe(2);
    expect(into?.notes.map((n) => n.p)).toEqual([60, 65, 66, 59, 61]);
    // the notes that stayed are the same notes
    expect(into?.notes[0]).toBe(region.notes[0]);
  });

  it('moves only the notes it’s given', () => {
    const into = notesIntoKey(song, region, new Set([region.notes[3] as Note]));
    expect(into?.notes.map((n) => n.p)).toEqual([60, 66, 66, 59, 61]);
  });

  it('has nothing to do when every note is in, or the song has no key', () => {
    expect(notesIntoKey(song, { ...region, notes: [note(0, 60), note(BAR, 62)] })).toBeNull();
    expect(notesIntoKey({ key: null }, region)).toBeNull();
    expect(outsideKey({ key: null }, region)).toEqual([]);
  });
});
