import {
  applyOps,
  type Note,
  newProject,
  newRegion,
  newTrack,
  PPQ,
  type Project,
  parseNotation,
  type Track,
} from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  engineReadingOps,
  notate,
  type PageReading,
  readScanWithEngines,
  type Scan,
  type ScanSystem,
  scoreText,
  toMusicXml,
} from '../src/index.ts';

const BAR = PPQ * 4;

/** A track playing `notes` (quarter-note units) from the start, as many bars long as they are. */
function track(name: string, notes: string, preset = 'Soft Keys'): Track {
  const t = newTrack(name, { type: 'synth', preset });
  const played = parseNotation(notes, { unit: PPQ });
  const end = Math.max(0, ...played.map((n) => n.t + n.d));
  const r = newRegion(0, Math.max(1, Math.ceil(end / BAR)) * BAR);
  r.notes = played;
  t.regions = [r];
  return t;
}

/** A page as an engine reads it: its parts as MusicXML. */
function page(parts: Track[], setup?: (p: Project) => void): string {
  const p = newProject('Page');
  p.tracks = parts;
  setup?.(p);
  return toMusicXml(notate(p));
}

/** A system on a page: `bars` bars between its bar lines. */
const system = (k: number, bars: number, more: Partial<ScanSystem> = {}): ScanSystem => ({
  k,
  top: k * 200,
  bottom: k * 200 + 150,
  left: 40,
  right: 1160,
  staves: 1,
  bars: Array.from({ length: bars + 1 }, (_, i) => 40 + i * 200),
  state: 'new',
  ...more,
});

function scanOf(song: Project, pages: ScanSystem[][], more: Partial<Scan> = {}): Scan {
  return {
    id: 'scn_test01',
    project: song.id,
    title: 'Scan',
    created: '2026-11-11T00:00:00.000Z',
    pages: pages.map((systems, n) => ({ n, w: 1200, h: 1600, type: 'png', systems })),
    ...more,
  };
}

function songWith(...tracks: Track[]): Project {
  const p = newProject('Song');
  p.tracks = tracks;
  return p;
}

/** A song's notes on a track, by where they start and their pitch. */
const notesOf = (p: Project, name: string): [number, number][] =>
  (p.tracks.find((t) => t.name === name)?.regions ?? [])
    .flatMap((r) => r.notes.map((n: Note) => [r.start + n.t, n.p] as [number, number]))
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);

const FOUR_BARS = 'D5:4 | E5:2 F5:2 | G5:1 A5:1 B5:2 | C6:4';

describe('reading a scan with the recognition engines', () => {
  it('writes a two-system page as the song’s bars, then has nothing left to read', () => {
    const song = songWith(track('Flute', ''));
    const scan = scanOf(song, [[system(0, 2), system(1, 2)]]);
    const readings: PageReading[] = [{ page: 0, engine: 'audiveris', musicxml: page([track('Flute', FOUR_BARS)]) }];

    const reading = readScanWithEngines(song, scan, readings);
    expect(reading.warnings).toEqual([]);
    expect(reading.setup).toEqual([]);
    expect(reading.pages).toEqual([{ page: 0, engine: 'audiveris', others: [] }]);
    expect(reading.systems.map((s) => [s.page, s.k, s.bars])).toEqual([
      [0, 0, [1, 2]],
      [0, 1, [3, 4]],
    ]);
    expect(reading.systems[0]?.text).toBe('bar 1  time 4/4\n  clef P1 s1 G\n  P1: d5:w\nbar 2\n  P1: e5:h f5:h');
    expect(reading.systems[1]?.text.split('\n')[0]).toBe('bar 3  time 4/4');

    const write = engineReadingOps(song, scan, reading);
    expect(write.errors).toEqual([]);
    expect(write.written).toEqual([1, 2, 3, 4]);
    expect(write.label).toBe('Scan: bars 1–4, read by audiveris');
    expect(write.systems).toEqual([
      { page: 0, k: 0, state: 'read', written: [1, 2] },
      { page: 0, k: 1, state: 'read', written: [3, 4] },
    ]);
    expect(write.scan.pages[0]?.systems.map((s) => [s.state, s.written])).toEqual([
      ['read', [1, 2]],
      ['read', [3, 4]],
    ]);
    const after = applyOps(song, write.ops);
    expect(scoreText(notate(after)).split('\n').slice(2)).toEqual([
      'bar 1  time 4/4',
      '  clef P1 s1 G',
      '  P1: d5:w',
      'bar 2',
      '  P1: e5:h f5:h',
      'bar 3',
      '  P1: g5:q a5:q b5:h',
      'bar 4',
      '  P1: c6:w',
    ]);

    // read again: every system is read, so nothing changes
    const again = readScanWithEngines(after, write.scan, readings);
    expect(again.systems).toEqual([]);
    expect(again.setup).toEqual([]);
    const none = engineReadingOps(after, write.scan, again, readings);
    expect(none.ops).toEqual([]);
    expect(none.scan).toBe(write.scan);
  });

  it('numbers the bars on from the last bar the scan has written, skipping systems already read', () => {
    const song = songWith(track('Flute', 'C5:4 | C5:4 | C5:4 | C5:4 | C5:4 | C5:4'));
    // page 1 is read as bars 1–6; on page 2 the first system is read as bars 7–8, the second isn't
    const scan = scanOf(song, [
      [system(0, 3, { state: 'checked', written: [1, 3] }), system(1, 3, { state: 'read', written: [4, 6] })],
      [system(0, 2, { state: 'approved', written: [7, 8] }), system(1, 2)],
    ]);
    const readings: PageReading[] = [{ page: 1, engine: 'oemer', musicxml: page([track('Flute', FOUR_BARS)]) }];
    const reading = readScanWithEngines(song, scan, readings);
    // the second system's bars are the engine's third and fourth, written as bars 9 and 10
    expect(reading.systems.map((s) => [s.page, s.k, s.bars])).toEqual([[1, 1, [9, 10]]]);
    expect(reading.systems[0]?.text).toContain('bar 9  time 4/4');
    expect(reading.systems[0]?.text).toContain('P1: g5:q a5:q b5:h');
    expect(reading.systems[0]?.text).toContain('bar 10\n  P1: c6:w');
    const write = engineReadingOps(song, scan, reading);
    expect(write.written).toEqual([9, 10]);
    expect(write.scan.pages[0]?.systems.map((s) => s.state)).toEqual(['checked', 'read']);
    const after = applyOps(song, write.ops);
    expect(notesOf(after, 'Flute').slice(-4)).toEqual([
      [8 * BAR, 79],
      [8 * BAR + PPQ, 81],
      [8 * BAR + 2 * PPQ, 83],
      [9 * BAR, 84],
    ]);
  });

  it('uses the engine that agrees most with the others, and flags where the others differ', () => {
    const song = songWith(track('Flute', ''));
    const scan = scanOf(song, [[system(0, 2), system(1, 2)]]);
    const right = page([track('Flute', FOUR_BARS)]);
    // bar 2 misread, listed first
    const wrong = page([track('Flute', 'D5:4 | E5:2 G5:2 | G5:1 A5:1 B5:2 | C6:4')]);
    const readings: PageReading[] = [
      { page: 0, engine: 'oemer', musicxml: wrong },
      { page: 0, engine: 'audiveris', musicxml: right },
      { page: 0, engine: 'homr', musicxml: right },
    ];
    const reading = readScanWithEngines(song, scan, readings);
    expect(reading.pages).toEqual([{ page: 0, engine: 'audiveris', others: ['oemer', 'homr'] }]);
    const write = engineReadingOps(song, scan, reading, readings);
    expect(write.systems).toEqual([
      { page: 0, k: 0, state: 'read', written: [1, 2], flags: ['oemer reads bar 2 as E5 G5 (the song has E5 F5)'] },
      { page: 0, k: 1, state: 'read', written: [3, 4] },
    ]);
    expect(write.scan.pages[0]?.systems[0]?.flags).toEqual(['oemer reads bar 2 as E5 G5 (the song has E5 F5)']);
  });

  it('with two engines, uses the one whose bars fit the page', () => {
    const song = songWith(track('Flute', ''));
    const scan = scanOf(song, [[system(0, 2), system(1, 2)]]);
    // one finds a bar too many (it split the last), the other the page's four
    const extra = page([track('Flute', 'D5:4 | E5:2 F5:2 | G5:1 A5:1 B5:2 | C6:4 | C6:4')]);
    const readings: PageReading[] = [
      { page: 0, engine: 'oemer', musicxml: extra },
      { page: 0, engine: 'audiveris', musicxml: page([track('Flute', FOUR_BARS)]) },
    ];
    expect(readScanWithEngines(song, scan, readings).pages[0]?.engine).toBe('audiveris');
  });

  it('adds a track for a part the song lacks, and writes each part into its own', () => {
    const song = songWith(track('Flute', ''));
    const scan = scanOf(song, [[system(0, 2, { staves: 2 }), system(1, 2, { staves: 2 })]]);
    const readings: PageReading[] = [
      {
        page: 0,
        engine: 'audiveris',
        musicxml: page([track('Flute', FOUR_BARS), track('Cello', 'C3:4 | G2:4 | C3:4 | C3:4')]),
      },
    ];
    const reading = readScanWithEngines(song, scan, readings);
    expect(reading.setup.map((op) => op.op)).toEqual(['addTrack']);
    expect(reading.systems[0]?.text).toContain('  P2: c3:w');
    const write = engineReadingOps(song, scan, reading);
    expect(write.errors).toEqual([]);
    const after = applyOps(song, write.ops);
    expect(after.tracks.map((t) => t.name)).toEqual(['Flute', 'Cello']);
    expect(notesOf(after, 'Cello')).toEqual([
      [0, 48],
      [BAR, 43],
      [2 * BAR, 48],
      [3 * BAR, 48],
    ]);
    expect(notesOf(after, 'Flute').map(([, p]) => p)).toEqual([74, 76, 77, 79, 81, 83, 84]);
  });

  it('writes only the scan’s part when the scan is for one', () => {
    const song = songWith(track('Piano', ''), track('Flute', ''));
    const flute = song.tracks[1] as Track;
    const scan = scanOf(song, [[system(0, 2), system(1, 2)]], { track: flute.id });
    const readings: PageReading[] = [
      { page: 0, engine: 'audiveris', musicxml: page([track('Flute', FOUR_BARS), track('Cello', 'C3:16')]) },
    ];
    const reading = readScanWithEngines(song, scan, readings);
    expect(reading.warnings).toEqual(['the engines read 2 parts; the scan is for one, so only the first is written']);
    expect(reading.systems[0]?.text).toContain('  P2: d5:w');
    expect(reading.systems[0]?.text).not.toContain('P1');
    const after = applyOps(song, engineReadingOps(song, scan, reading).ops);
    expect(notesOf(after, 'Flute')).toHaveLength(7);
    expect(notesOf(after, 'Piano')).toEqual([]);
  });

  it('writes a transposing part at the right pitch', () => {
    // a clarinet in B♭ is written a tone above how it sounds; the page was read as sounding
    const song = songWith(track('Clarinet in Bb', ''));
    const scan = scanOf(song, [[system(0, 2), system(1, 2)]]);
    const readings: PageReading[] = [{ page: 0, engine: 'audiveris', musicxml: page([track('Flute', FOUR_BARS)]) }];
    const reading = readScanWithEngines(song, scan, readings);
    expect(reading.systems[0]?.text).toContain('P1: e5:w');
    const after = applyOps(song, engineReadingOps(song, scan, reading).ops);
    expect(notesOf(after, 'Clarinet in Bb').map(([, p]) => p)).toEqual([74, 76, 77, 79, 81, 83, 84]);
  });

  it('starts the song with the page’s pickup', () => {
    const song = songWith(track('Flute', ''));
    const scan = scanOf(song, [[system(0, 2), system(1, 2)]]);
    const withPickup = page([track('Flute', 'r:2 G4:1 | C5:3 | E5:3 | G5:3')], (p) => {
      p.meter = [{ tick: 0, num: 3, den: 4, pickup: PPQ }];
    });
    const reading = readScanWithEngines(song, scan, [{ page: 0, engine: 'audiveris', musicxml: withPickup }]);
    expect(reading.systems.map((s) => s.bars)).toEqual([
      [0, 1],
      [2, 3],
    ]);
    expect(reading.systems[0]?.text.split('\n')[0]).toBe('bar 0  time 3/4  pickup');
    expect(reading.setup).toEqual([{ op: 'setProject', patch: { meter: [{ tick: 0, num: 3, den: 4, pickup: PPQ }] } }]);
    const write = engineReadingOps(song, scan, reading);
    expect(write.errors).toEqual([]);
    expect(write.warnings).toEqual([]);
    expect(write.written).toEqual([0, 1, 2, 3]);
    const after = applyOps(song, write.ops);
    expect(after.meter).toEqual([{ tick: 0, num: 3, den: 4, pickup: PPQ }]);
    expect(notesOf(after, 'Flute')).toEqual([
      [2 * PPQ, 67],
      [3 * PPQ, 72],
      [6 * PPQ, 76],
      [9 * PPQ, 79],
    ]);
  });

  it('leaves a page no engine read, and says so', () => {
    const song = songWith(track('Flute', ''));
    const scan = scanOf(song, [[system(0, 2)], [system(0, 2)]]);
    const readings: PageReading[] = [
      { page: 1, engine: 'audiveris', musicxml: page([track('Flute', FOUR_BARS)]) },
      { page: 0, engine: 'oemer', musicxml: '<score-partwise><part-list>' },
    ];
    const reading = readScanWithEngines(song, scan, readings);
    expect(reading.warnings[0]).toMatch(/^page 1: oemer's reading couldn't be read/);
    expect(reading.warnings[1]).toBe('page 1: no engine has read it');
    expect(reading.systems.map((s) => [s.page, s.bars])).toEqual([[1, [1, 2]]]);
  });

  it('keeps a system new, flagged with why, when its bars are refused', () => {
    const song = songWith(track('Flute', ''));
    const scan = scanOf(song, [[system(0, 1), system(1, 1)]]);
    const write = engineReadingOps(song, scan, {
      systems: [
        { page: 0, k: 0, engine: 'audiveris', bars: [1, 1], text: 'bar 1\n  P1: c5:w' },
        { page: 0, k: 1, engine: 'audiveris', bars: [2, 2], text: 'bar 2\n  P1: c5:q' },
      ],
      setup: [],
      pages: [{ page: 0, engine: 'audiveris', others: [] }],
      warnings: [],
    });
    expect(write.written).toEqual([1]);
    expect(write.systems[0]).toEqual({ page: 0, k: 0, state: 'read', written: [1, 1] });
    expect(write.systems[1]?.state).toBe('new');
    expect(write.systems[1]?.written).toBeUndefined();
    expect(write.systems[1]?.flags?.[0]).toMatch(/^bar 2 P1: /);
    expect(write.label).toBe('Scan: bar 1, read by audiveris');
  });
});
