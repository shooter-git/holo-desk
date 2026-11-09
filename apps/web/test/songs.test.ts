import { describe, expect, it } from 'vitest';
import type { Creation, CreationEngine, ProjectRow } from '../src/app/api.ts';
import { engineBadge, groupSongs, searchSongs, songDetailNames } from '../src/app/songs.ts';

const row = (
  id: string,
  title: string,
  modified: string,
  creation: string | null = null,
  details: { artist?: string; album?: string } = {},
): ProjectRow => ({
  id,
  title,
  revision: 1,
  created: modified,
  modified,
  creation,
  piece: creation ? title.toLowerCase() : null,
  artist: details.artist ?? null,
  album: details.album ?? null,
});

const engine = (relation: CreationEngine['relation']): CreationEngine => ({
  label: '0.1.0+1111111',
  commit: '1'.repeat(40),
  date: '2026-10-01T00:00:00.000Z',
  node: '22.23.2',
  relation,
  studio: '0.1.0+2222222',
  studioDate: '2026-10-17T00:00:00.000Z',
});

const creation = (name: string, title: string, pieces: Creation['pieces'], e: CreationEngine | null): Creation => ({
  name,
  title,
  exportHelp: null,
  renderHelp: null,
  canRender: true,
  engine: e,
  pieces,
});

describe('the Songs dialog', () => {
  it('groups songs by the experience they belong to, your own on their own', () => {
    const rows = [
      row('p1', 'Sketch', '2026-10-17T10:00:00Z'),
      row('p2', 'Theme', '2026-10-17T09:00:00Z', 'moon'),
      row('p3', 'Boss', '2026-10-17T11:00:00Z', 'tide'),
      row('p4', 'Lost', '2026-10-16T11:00:00Z', 'gone'),
    ];
    const creations = [
      creation(
        'moon',
        'Paper Moon',
        [
          { piece: 'theme', title: 'Theme', modified: '', tracks: 1, edited: 0, project: 'p2' },
          { piece: 'ending', title: 'Ending', modified: '', tracks: 1, edited: 0, project: null },
        ],
        engine('older'),
      ),
      creation('tide', 'Tide Pool', [], engine('same')),
      creation('empty', 'Empty One', [], null),
    ];
    const groups = groupSongs(rows, creations);
    expect(groups.map((g) => g.title)).toEqual(['Your songs', 'Tide Pool', 'Paper Moon', 'gone', 'Empty One']);
    expect(groups[0]?.songs.map((s) => s.title)).toEqual(['Sketch']);
    const moon = groups.find((g) => g.key === 'moon');
    expect(moon?.songs.map((s) => s.id)).toEqual(['p2']);
    // a piece already open in the studio is the song; the other waits in its folder
    expect(moon?.pieces.map((p) => p.piece)).toEqual(['ending']);
    expect(groups.find((g) => g.key === 'gone')?.creation).toBeNull();
  });

  it('groups your songs by album and artist, artists A to Z, after those with neither', () => {
    const rows = [
      row('a1', 'Lantern Theme', '2026-11-09T10:00:00Z', null, { artist: 'Mara Vale', album: 'Hallowed Lanterns' }),
      row('a2', 'Ember', '2026-11-08T10:00:00Z', null, { artist: 'Mara Vale', album: 'Hallowed Lanterns' }),
      row('a3', 'Demo 4', '2026-11-09T12:00:00Z', null, { artist: 'Mara Vale' }),
      row('a4', 'Opener', '2026-11-01T10:00:00Z', null, { artist: 'Cold Harbor', album: 'Tidewater' }),
      row('a5', 'Loose Idea', '2026-11-02T10:00:00Z', null, { album: 'Sketches' }),
      row('a6', 'Untitled', '2026-11-03T10:00:00Z'),
    ];
    const groups = groupSongs(rows, []);
    expect(groups.map((g) => [g.kind, g.title, g.artist])).toEqual([
      ['own', 'Your songs', null],
      ['album', 'Tidewater', 'Cold Harbor'],
      // the artist's songs on no album were worked on last, so they come before the album
      ['album', 'Mara Vale', 'Mara Vale'],
      ['album', 'Hallowed Lanterns', 'Mara Vale'],
      ['album', 'Sketches', null],
    ]);
    expect(groups.find((g) => g.title === 'Hallowed Lanterns')?.songs.map((s) => s.id)).toEqual(['a1', 'a2']);
    expect(groups.find((g) => g.title === 'Mara Vale')?.album).toBeNull();

    // when every song has an artist or album, there's no empty "Your songs"
    expect(groupSongs(rows.slice(0, 5), [])[0]?.title).toBe('Tidewater');
    // but with no songs at all, it's there to say so
    expect(groupSongs([], []).map((g) => g.title)).toEqual(['Your songs']);

    expect(songDetailNames(rows)).toEqual({
      artists: ['Cold Harbor', 'Mara Vale'],
      albums: ['Hallowed Lanterns', 'Sketches', 'Tidewater'],
    });
  });

  it('searches by title, artist, album and experience, and keeps each group in its order', () => {
    const rows = [
      row('a1', 'Lantern Theme', '2026-11-09T10:00:00Z', null, { artist: 'Mara Vale', album: 'Hallowed Lanterns' }),
      row('a2', 'Ember', '2026-11-08T10:00:00Z', null, { artist: 'Mara Vale', album: 'Hallowed Lanterns' }),
      row('a3', 'Opener', '2026-11-01T10:00:00Z', null, { artist: 'Cold Harbor', album: 'Tidewater' }),
      row('a4', 'Ember Reprise', '2026-11-02T10:00:00Z'),
      row('p2', 'Theme', '2026-10-17T09:00:00Z', 'moon'),
    ];
    const groups = groupSongs(rows, [creation('moon', 'Paper Moon', [], null)]);
    const titles = (q: string) => searchSongs(groups, q).map((g) => [g.title, g.songs.map((s) => s.id)]);

    expect(searchSongs(groups, '  ')).toBe(groups);
    expect(titles('mara')).toEqual([['Hallowed Lanterns', ['a1', 'a2']]]);
    expect(titles('ember')).toEqual([
      ['Your songs', ['a4']],
      ['Hallowed Lanterns', ['a2']],
    ]);
    expect(titles('tidewater')).toEqual([['Tidewater', ['a3']]]);
    expect(titles('paper moon')).toEqual([['Paper Moon', ['p2']]]);
    // a slip of the keys, when nothing matches as typed
    expect(titles('hallowd')).toEqual([['Hallowed Lanterns', ['a1', 'a2']]]);
    expect(titles('zzzz')).toEqual([]);
  });

  it("badges an experience whose engine isn't the studio's, and points to holo update-engine", () => {
    expect(engineBadge('Tide Pool', engine('same'))).toBeNull();
    expect(engineBadge('Plain', null)).toBeNull();
    const older = engineBadge('Paper Moon', engine('older'));
    expect(older?.text).toBe('Builds with engine 0.1.0+1111111 · holo update-engine');
    expect(older?.detail).toMatch(/the studio plays a newer one, 0\.1\.0\+2222222/);
    expect(engineBadge('X', engine('newer'))?.detail).toMatch(/Rebuild the studio \(pnpm up\)/);
    expect(engineBadge('X', engine('different'))?.text).toBe('Builds with engine 0.1.0+1111111');
  });
});
