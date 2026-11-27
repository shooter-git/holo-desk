/** The song's sections (a marker to the next) and its chord symbols, as the lanes and the agent's tools read and write them. */
import { newProject, newRegion, newTrack, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { chordOps, moveChordOps, withChord } from '../src/edits/chords.ts';
import { sections, sectionsNamed, songEnd } from '../src/edits/sections.ts';

const BAR = PPQ * 4;

function song(bars = 20): Project {
  const p = newProject('Sections');
  const t = newTrack('Piano', { type: 'synth', preset: 'Soft Keys' });
  t.regions = [newRegion(0, bars * BAR)];
  p.tracks = [t];
  return p;
}

describe('sections', () => {
  it('has none without markers', () => {
    expect(sections(song())).toEqual([]);
  });

  it('runs from each marker to the next, the last to the end of the music', () => {
    const p = song(20);
    p.markers = [
      { id: 'b', tick: 8 * BAR, name: 'Chorus' },
      { id: 'a', tick: 0, name: 'Verse' },
      { id: 'c', tick: 16 * BAR, name: 'Verse' },
    ];
    expect(sections(p).map((s) => [s.id, s.name, s.from / BAR, s.to / BAR, s.whole])).toEqual([
      ['a', 'Verse', 0, 8, true],
      ['b', 'Chorus', 8, 16, true],
      ['c', 'Verse', 16, 20, true],
    ]);
  });

  it('counts what comes before the first marker as a section with no name', () => {
    const p = song();
    p.markers = [{ id: 'a', tick: 4 * BAR, name: 'Theme' }];
    const [start, theme] = sections(p);
    expect([start?.id, start?.name, start?.marker, start?.from, start?.to]).toEqual(['start', '', null, 0, 4 * BAR]);
    expect(theme?.name).toBe('Theme');
  });

  it('says when a section doesn’t sit on bar lines (its bars can’t be moved)', () => {
    const p = song();
    p.markers = [
      { id: 'a', tick: 0, name: 'A' },
      { id: 'b', tick: 4 * BAR + PPQ, name: 'B' },
      { id: 'c', tick: 8 * BAR, name: 'C' },
    ];
    expect(sections(p).map((s) => s.whole)).toEqual([false, false, true]);
  });

  it('ends a bar at least past a marker that sits after the music', () => {
    const p = song(4);
    p.markers = [{ id: 'a', tick: 8 * BAR, name: 'Later' }];
    expect(songEnd(p)).toBe(9 * BAR);
    expect(sections(p).map((s) => [s.name, s.from / BAR, s.to / BAR])).toEqual([
      ['', 0, 8],
      ['Later', 8, 9],
    ]);
  });

  it('skips a marker another sits on top of', () => {
    const p = song();
    p.markers = [
      { id: 'a', tick: 0, name: 'One' },
      { id: 'b', tick: 0, name: 'Two' },
    ];
    expect(sections(p).map((s) => s.name)).toEqual(['Two']);
  });
});

describe('a section by name', () => {
  const p = song(32);
  p.markers = [
    { id: 'a', tick: 0, name: 'Intro' },
    { id: 'b', tick: 4 * BAR, name: 'Theme' },
    { id: 'c', tick: 12 * BAR, name: 'Bridge' },
    { id: 'd', tick: 16 * BAR, name: 'Theme' },
    { id: 'e', tick: 24 * BAR, name: 'Verse 2' },
  ];
  const list = sections(p);

  it('is found whatever its case, every one that has it', () => {
    expect(sectionsNamed(list, 'bridge').map((s) => s.id)).toEqual(['c']);
    expect(sectionsNamed(list, ' THEME ').map((s) => s.id)).toEqual(['b', 'd']);
    expect(sectionsNamed(list, 'Coda')).toEqual([]);
    expect(sectionsNamed(list, '')).toEqual([]);
  });

  it('takes a number after the name as which of them, unless a section has that whole name', () => {
    expect(sectionsNamed(list, 'Theme 2').map((s) => s.id)).toEqual(['d']);
    expect(sectionsNamed(list, 'theme #1').map((s) => s.id)).toEqual(['b']);
    expect(sectionsNamed(list, 'Theme 3')).toEqual([]);
    expect(sectionsNamed(list, 'Verse 2').map((s) => s.id)).toEqual(['e']);
  });
});

describe('chord symbols', () => {
  const chords = [
    { tick: 0, symbol: 'Dm' },
    { tick: BAR, symbol: 'G7' },
  ];

  it('sets one at a tick, in order, replacing the one there', () => {
    expect(withChord(chords, 2 * BAR, ' C ')).toEqual([...chords, { tick: 2 * BAR, symbol: 'C' }]);
    expect(withChord(chords, 2 * PPQ, 'A7').map((c) => c.symbol)).toEqual(['Dm', 'A7', 'G7']);
    expect(withChord(chords, BAR, 'G9')).toEqual([chords[0], { tick: BAR, symbol: 'G9' }]);
  });

  it('removes with an empty symbol, and is the same list when nothing changes', () => {
    expect(withChord(chords, BAR, '  ')).toEqual([chords[0]]);
    expect(withChord(chords, 5 * BAR, '')).toBe(chords);
    expect(withChord(chords, BAR, 'G7')).toBe(chords);
    expect(chordOps({ chords }, BAR, 'G7')).toEqual([]);
    expect(chordOps({ chords }, BAR, '')).toEqual([{ op: 'setProject', patch: { chords: [chords[0]] } }]);
  });

  it('moves one to another tick, taking the place of one there', () => {
    expect(moveChordOps({ chords }, BAR, 3 * PPQ)).toEqual([
      {
        op: 'setProject',
        patch: {
          chords: [
            { tick: 0, symbol: 'Dm' },
            { tick: 3 * PPQ, symbol: 'G7' },
          ],
        },
      },
    ]);
    expect(moveChordOps({ chords }, BAR, 0)).toEqual([
      { op: 'setProject', patch: { chords: [{ tick: 0, symbol: 'G7' }] } },
    ]);
    expect(moveChordOps({ chords }, BAR, BAR)).toEqual([]);
    expect(moveChordOps({ chords }, 7 * BAR, 0)).toEqual([]);
  });
});
