import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Project } from '@holo/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { type ProjectRow, Store } from '../src/db.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-song-details-test-'));
let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeAll(async () => {
  ({ app } = await buildApp({
    port: 0,
    host: '127.0.0.1',
    dataDir: join(work, 'data'),
    creationsDir: null,
    webDir: join(work, 'no-web'),
    repoDir: resolve(import.meta.dirname, '../../..'),
    networkMidi: null,
  }));
}, 30_000);
afterAll(async () => {
  await app.close();
  rmSync(work, { recursive: true, force: true });
});

const create = async (title: string) =>
  (await app.inject({ method: 'POST', url: '/api/projects', payload: { title } })).json() as Project;
const details = (id: string, payload: Record<string, unknown>) =>
  app.inject({ method: 'PUT', url: `/api/projects/${id}/details`, payload });
const row = async (id: string) =>
  ((await app.inject({ method: 'GET', url: '/api/projects' })).json() as ProjectRow[]).find((r) => r.id === id);

describe("a song's artist and album", () => {
  it('sets them, keeps them through a save, and clears them, without a new revision', async () => {
    const song = await create('Lantern Sketch');
    expect(await row(song.id)).toMatchObject({ artist: null, album: null });

    const res = await details(song.id, { artist: '  Mara   Vale ', album: 'Hallowed Lanterns' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ ok: true, artist: 'Mara Vale', album: 'Hallowed Lanterns' });
    expect(await row(song.id)).toMatchObject({ artist: 'Mara Vale', album: 'Hallowed Lanterns', revision: 0 });

    // saving the song keeps them
    const saved = await app.inject({
      method: 'PUT',
      url: `/api/projects/${song.id}`,
      payload: { doc: { ...song, title: 'Lantern Theme' }, baseRevision: song.revision },
    });
    expect(saved.statusCode).toBe(200);
    expect(await row(song.id)).toMatchObject({ artist: 'Mara Vale', album: 'Hallowed Lanterns' });

    // one left out stays; an empty one, like null, clears
    expect((await details(song.id, { album: '   ' })).json()).toEqual({ ok: true, artist: 'Mara Vale', album: null });
    expect((await details(song.id, { artist: null })).json()).toEqual({ ok: true, artist: null, album: null });
  });

  it("refuses a name that isn't one, a song that isn't there and a creation's song", async () => {
    const song = await create('Odd One');
    expect((await details(song.id, { artist: 42 })).statusCode).toBe(400);
    expect((await details(song.id, { album: 'x'.repeat(121) })).statusCode).toBe(400);
    expect((await details('prj_nothere', { artist: 'Anyone' })).statusCode).toBe(404);

    const theirs = await app.inject({
      method: 'POST',
      url: '/api/projects',
      payload: { doc: { ...song, id: 'prj_theirs', origin: { creation: 'moon', piece: 'theme', exportedAt: '' } } },
    });
    expect(theirs.statusCode).toBe(201);
    const res = await details('prj_theirs', { album: 'Mine now' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/moon's/);
  });

  it('gives a data folder from before them the columns, every song with neither', () => {
    const dir = join(work, 'old-data');
    new Store(dir).close();
    // the projects table as the first release made it
    const db = new DatabaseSync(join(dir, 'holo.db'));
    db.exec('DROP TABLE projects');
    db.exec(`CREATE TABLE projects (id TEXT PRIMARY KEY, title TEXT NOT NULL, revision INTEGER NOT NULL,
      created TEXT NOT NULL, modified TEXT NOT NULL, doc TEXT NOT NULL, deleted INTEGER NOT NULL DEFAULT 0,
      creation TEXT, piece TEXT)`);
    db.prepare(
      "INSERT INTO projects (id, title, revision, created, modified, doc) VALUES ('prj_old', 'Old', 3, '', '', '{}')",
    ).run();
    db.close();
    const store = new Store(dir);
    expect(store.list()).toEqual([expect.objectContaining({ id: 'prj_old', artist: null, album: null })]);
    expect(store.setDetails('prj_old', { artist: 'Archive Band' })).toBe(true);
    expect(store.row('prj_old')).toMatchObject({ artist: 'Archive Band', album: null });
    store.close();
  });
});
