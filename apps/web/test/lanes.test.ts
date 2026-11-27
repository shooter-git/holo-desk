/** The Arrangement and Chords lanes' arithmetic: what's under a point, where a section or a marker's line may land. */
import { type Section, sections } from '@holo/agent/edits';
import { type ChordMark, newProject, newRegion, newTrack, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  barStart,
  beatStart,
  chordAt,
  chordsShown,
  chordWidth,
  dropPlace,
  edgeAt,
  edgePlace,
  LANE,
  type LaneRows,
  laneAt,
  lanesHeight,
  nearestBar,
  sectionAt,
  sectionColor,
} from '../src/ui/lanes.ts';

const BAR = PPQ * 4;

/** Intro 1–4, Theme 5–12, Bridge 13–16, Theme 2 17–24, Outro 25–28. */
function song(): Project {
  const p = newProject('Lanes');
  const t = newTrack('Piano', { type: 'synth', preset: 'Soft Keys' });
  t.regions = [newRegion(0, 28 * BAR)];
  p.tracks = [t];
  p.markers = [
    { id: 'm1', tick: 0, name: 'Intro' },
    { id: 'm2', tick: 4 * BAR, name: 'Theme' },
    { id: 'm3', tick: 12 * BAR, name: 'Bridge' },
    { id: 'm4', tick: 16 * BAR, name: 'Theme 2' },
    { id: 'm5', tick: 24 * BAR, name: 'Outro' },
  ];
  return p;
}
const named = (list: Section[], name: string) => list.find((s) => s.name === name) as Section;

describe('the lanes’ rows', () => {
  it('are as tall as what View has on, the Arrangement lane first', () => {
    const both: LaneRows = { arrangement: true, chords: true, row: LANE };
    expect(lanesHeight(both)).toBe(2 * LANE);
    expect([laneAt(both, 0), laneAt(both, LANE - 1), laneAt(both, LANE), laneAt(both, 2 * LANE)]).toEqual([
      'arrangement',
      'arrangement',
      'chords',
      null,
    ]);
    const chords: LaneRows = { arrangement: false, chords: true, row: LANE };
    expect([lanesHeight(chords), laneAt(chords, 3)]).toEqual([LANE, 'chords']);
    expect(lanesHeight({ arrangement: false, chords: false, row: LANE })).toBe(0);
    expect(laneAt(both, -1)).toBeNull();
  });
});

describe('sections under the pointer', () => {
  it('finds the section a tick is in, and the marker line near it', () => {
    const list = sections(song());
    expect(sectionAt(list, 5 * BAR)?.name).toBe('Theme');
    expect(sectionAt(list, 12 * BAR)?.name).toBe('Bridge');
    expect(sectionAt(list, 40 * BAR)).toBeNull();
    expect(edgeAt(list, 12 * BAR + 30, 60)?.name).toBe('Bridge');
    expect(edgeAt(list, 12 * BAR + 90, 60)).toBeNull();
    // the song's own start isn't a line to drag
    expect(edgeAt(list, 10, 60)).toBeNull();
  });

  it('gives sections that share a name’s start one colour', () => {
    const list = sections(song());
    expect(sectionColor(list, named(list, 'Theme'))).toBe(sectionColor(list, named(list, 'Theme 2')));
    expect(sectionColor(list, named(list, 'Theme'))).not.toBe(sectionColor(list, named(list, 'Bridge')));
  });
});

describe('where a dragged section lands', () => {
  it('is the boundary nearest the pointer that isn’t inside it, and nowhere when that’s where it is', () => {
    const list = sections(song());
    const bridge = named(list, 'Bridge');
    expect(dropPlace(list, bridge, 4 * BAR + 100)).toBe(4 * BAR);
    expect(dropPlace(list, bridge, 0)).toBe(0);
    expect(dropPlace(list, bridge, 27 * BAR)).toBe(28 * BAR);
    expect(dropPlace(list, bridge, 23 * BAR)).toBe(24 * BAR);
    // over itself, or nearest its own start or end: it stays
    expect(dropPlace(list, bridge, 13 * BAR)).toBeNull();
    expect(dropPlace(list, bridge, 16 * BAR + 50)).toBeNull();
  });
});

describe('where a marker’s line may go', () => {
  it('is the bar line nearest the pointer, a bar at least from the markers either side', () => {
    const p = song();
    const list = sections(p);
    const bridge = named(list, 'Bridge');
    expect(edgePlace(list, bridge, p.meter, 10 * BAR + 100)).toBe(10 * BAR);
    expect(edgePlace(list, bridge, p.meter, 2 * BAR)).toBe(5 * BAR);
    expect(edgePlace(list, bridge, p.meter, 30 * BAR)).toBe(15 * BAR);
  });

  it('counts bars in the meter', () => {
    const p = song();
    p.meter = [{ tick: 0, num: 3, den: 4 }];
    expect(nearestBar(p.meter, 3 * PPQ + 100)).toBe(3 * PPQ);
    expect(barStart(p.meter, 5 * PPQ)).toBe(3 * PPQ);
    expect(beatStart(p.meter, 5 * PPQ + 300)).toBe(5 * PPQ);
  });
});

describe('chords under the pointer', () => {
  const chords: ChordMark[] = [
    { tick: 0, symbol: 'Dm' },
    { tick: BAR, symbol: 'Gm7' },
    { tick: BAR + 2 * PPQ, symbol: 'C7' },
  ];

  it('is the chord whose symbol reaches that far', () => {
    const px = 0.1; // a bar is 384 px
    expect(chordAt(chords, 50, px)?.symbol).toBe('Dm');
    expect(chordAt(chords, (chordWidth('Dm') + 5) / px, px)).toBeNull();
    expect(chordAt(chords, BAR + 100, px)?.symbol).toBe('Gm7');
    expect(chordAt(chords, BAR + 2 * PPQ + 10, px)?.symbol).toBe('C7');
  });

  it('leaves out the ones with no room at the zoom, earlier ones first in line', () => {
    // a bar 384 px wide: all three; narrower, each needs its own width before the next one drawn
    expect(chordsShown(chords, 0.1).map((c) => c.symbol)).toEqual(['Dm', 'Gm7', 'C7']);
    expect(chordsShown(chords, 20 / BAR).map((c) => c.symbol)).toEqual(['Dm', 'C7']);
    expect(chordsShown(chords, 40 / BAR).map((c) => c.symbol)).toEqual(['Dm', 'Gm7']);
  });
});
