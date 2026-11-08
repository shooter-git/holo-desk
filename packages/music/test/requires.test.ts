import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newProject, newTrack } from '@holo/session';
import { afterAll, describe, expect, it } from 'vitest';
import { sha256 } from '../src/fetch.ts';
import { packSha256 } from '../src/pack-lock.ts';
import { formatPinnedPacks, type PinnedPack, parsePinnedPacks, withRequired } from '../src/packs.ts';
import { syncPinnedPacks } from '../src/sync.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-requires-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A pack of one instrument (or none), as packs.json holds it. */
function pack(id: string, requires?: string[], files = true): PinnedPack {
  return {
    id,
    name: id.toUpperCase(),
    license: 'CC0-1.0',
    credit: 'for the tests',
    source: files ? { kind: 'local' } : { kind: 'none' },
    instruments: files
      ? [
          {
            name: 'one',
            release: 0.1,
            attack: 0,
            oneShot: true,
            velocityRange: 12,
            zones: [
              {
                file: `${id}.wav`,
                root: 60,
                lo: 0,
                hi: 127,
                lovel: 1,
                hivel: 127,
                gain: 0,
                start: 0,
                end: 0,
                loopStart: 0,
                loopEnd: 0,
                rate: 48000,
              },
            ],
          },
        ]
      : [],
    ...(requires ? { requires } : {}),
    files: files ? { [`${id}.wav`]: 'a'.repeat(64) } : {},
  } as unknown as PinnedPack;
}

describe('packs that require others', () => {
  it('come after what they require, each once, and a loop is refused', async () => {
    const reqs: Record<string, string[]> = { epic: ['strings', 'brass'], brass: ['hall'], strings: ['hall'] };
    expect(await withRequired(['epic', 'keys'], (id) => reqs[id])).toEqual([
      'hall',
      'strings',
      'brass',
      'epic',
      'keys',
    ]);
    await expect(withRequired(['a'], (id) => (id === 'a' ? ['b'] : ['a']))).rejects.toThrow(/a → b → a/);
  });

  it('are pinned in an experience with what they require when a song plays them', async () => {
    // "kit" plays files of "room" (it requires it); the palette "set" has no files at all
    const kit = pack('kit', ['room']);
    const room = pack('room');
    const set = pack('set', ['kit'], false);
    const maps = join(work, 'maps');
    mkdirSync(maps, { recursive: true });
    for (const p of [kit, room, set]) writeFileSync(join(maps, `${packSha256(p)}.json`), JSON.stringify(p));
    const root = join(work, 'game');
    mkdirSync(join(root, 'music/sessions'), { recursive: true });
    mkdirSync(join(root, 'music/holo'), { recursive: true });
    writeFileSync(join(root, 'music/holo/packs.json'), formatPinnedPacks([]));
    writeFileSync(
      join(root, 'holo.creation.json'),
      JSON.stringify({
        format: 'holo-creation',
        version: 1,
        name: 'game',
        title: 'Game',
        sessions: 'music/sessions',
        engine: {
          version: '0.1.0',
          source: '0'.repeat(64),
          date: null,
          commit: null,
          node: '24.0.0',
          file: 'music/holo/holo-music.mjs',
          sha256: '0'.repeat(64),
          packs: 'music/holo/packs.json',
          packsSha256: sha256(Buffer.from(formatPinnedPacks([]))),
          pinned: [],
          catalog: Object.fromEntries([kit, room, set].map((p) => [p.id, packSha256(p)])),
          packsAt: { repo: 'test/packs', commit: 'c'.repeat(40) },
        },
      }),
    );
    const song = newProject('Song');
    song.tracks = [newTrack('Kit', { type: 'sampler', pack: 'kit', name: 'one' })];
    writeFileSync(join(root, 'music/sessions/song.holo.json'), JSON.stringify(song));
    const offline = async () => {
      throw new Error('offline');
    };
    const change = await syncPinnedPacks(root, { mapsDir: maps, fetch: offline });
    expect(change.added).toEqual(['room', 'kit']);
    const pinned = parsePinnedPacks(readFileSync(join(root, 'music/holo/packs.json'), 'utf8'));
    expect(pinned.packs.map((p) => p.id)).toEqual(['kit', 'room']);

    // the song no longer plays the kit: what it required goes with it
    song.tracks = [];
    writeFileSync(join(root, 'music/sessions/song.holo.json'), JSON.stringify(song));
    expect((await syncPinnedPacks(root, { mapsDir: maps, fetch: offline })).dropped.sort()).toEqual(['kit', 'room']);
  });
});
