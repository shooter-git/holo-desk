import { describe, expect, it } from 'vitest';
import type { Creation, CreationEngine, ProjectRow } from '../src/app/api.ts';
import { engineBadge, groupSongs } from '../src/app/songs.ts';

const row = (id: string, title: string, modified: string, creation: string | null = null): ProjectRow => ({
  id,
  title,
  revision: 1,
  created: modified,
  modified,
  creation,
  piece: creation ? title.toLowerCase() : null,
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
