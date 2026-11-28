import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import type { Project } from '@holo/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { backupDatabase, backups, KEEP_BACKUPS } from '../src/backup.ts';
import { Store } from '../src/db.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-backup-test-'));
const data = join(work, 'data');
let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeAll(async () => {
  ({ app } = await buildApp({
    port: 0,
    host: '127.0.0.1',
    dataDir: data,
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

const key = () => readFileSync(join(data, 'runner.key'), 'utf8').trim();
const ask = (headers: Record<string, string> = {}) => app.inject({ method: 'POST', url: '/api/backup', headers });

/** The songs' titles in a copy, opened as a database of its own. */
function titlesIn(file: string): string[] {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare('SELECT title FROM projects ORDER BY title').all() as { title: string }[]).map((r) => r.title);
  } finally {
    db.close();
  }
}

describe('a copy of the songs’ database', () => {
  it('is made only for this computer’s owner: with the runner key', async () => {
    expect((await ask()).statusCode).toBe(403);
    expect((await ask({ 'x-holo-runner-key': 'ab'.repeat(32) })).statusCode).toBe(403);
    expect(backups(data)).toEqual([]);
  });

  it('holds the songs as they are, in a file of its own that only its owner reads', async () => {
    const song = (
      await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Lantern Sketch' } })
    ).json() as Project;
    const res = await ask({ 'x-holo-runner-key': key() });
    expect(res.statusCode).toBe(200);
    const made = res.json() as { file: string; size: number };
    expect(made.file).toMatch(/^backups[\\/]holo-0\.\d+\.\d+-\d{8}T\d{6}Z\.db$/);
    const file = join(data, made.file);
    expect(statSync(file).size).toBe(made.size);
    expect(made.size).toBeGreaterThan(0);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(titlesIn(file)).toEqual(['Lantern Sketch']);
    // a song made after it isn't in it, and is in the next
    await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Second Light' } });
    expect(titlesIn(file)).toEqual(['Lantern Sketch']);
    await new Promise((ok) => setTimeout(ok, 1100));
    const next = (await ask({ 'x-holo-runner-key': key() })).json() as { file: string };
    expect(next.file).not.toBe(made.file);
    expect(titlesIn(join(data, next.file))).toEqual(['Lantern Sketch', 'Second Light']);
    expect(song.title).toBe('Lantern Sketch');
    // nothing is left half made
    expect(readdirSync(join(data, 'backups')).filter((f) => f.endsWith('.part'))).toEqual([]);
  });
});

describe('backupDatabase', () => {
  it('keeps the newest few, and lets the older go', async () => {
    const dir = join(work, 'kept');
    const store = new Store(dir);
    const names: string[] = [];
    for (let i = 0; i < KEEP_BACKUPS + 2; i++) {
      const made = await backupDatabase(store, dir, `1.0.${i}`, { now: () => new Date(Date.UTC(2031, 0, 1 + i)) });
      expect(made.ok).toBe(true);
      if (made.ok) names.push(made.file);
    }
    store.close();
    expect(backups(dir)).toEqual(
      names
        .slice(-KEEP_BACKUPS)
        .reverse()
        .map((f) => f.replace(/^backups[\\/]/, '')),
    );
  });

  it('lets go only of copies named as it names them: a file someone keeps there stays', async () => {
    const dir = join(work, 'own');
    const store = new Store(dir);
    await backupDatabase(store, dir, '1.0.0', { now: () => new Date(Date.UTC(2031, 0, 1)) });
    const own = ['holo-before-my-big-edit.db', 'my-songs.db', 'holo-1.0.0-20300101T000000Z.db.bak'];
    for (const f of own) writeFileSync(join(dir, 'backups', f), 'mine');
    // (and one a copy cut short left behind)
    writeFileSync(join(dir, 'backups', 'holo-0.9.0-20290101T000000Z.db.part'), 'half');
    for (let i = 1; i <= KEEP_BACKUPS + 1; i++)
      await backupDatabase(store, dir, '1.0.0', { now: () => new Date(Date.UTC(2031, 0, 1 + i)) });
    store.close();
    const left = readdirSync(join(dir, 'backups')).sort();
    for (const f of own) expect(left).toContain(f);
    expect(left.filter((f) => f.endsWith('.part'))).toEqual([]);
    expect(backups(dir)).toHaveLength(KEEP_BACKUPS);
  });

  it('never lets go of the copy it just made, whatever the others’ names say', async () => {
    const dir = join(work, 'clock');
    const store = new Store(dir);
    for (let i = 0; i < KEEP_BACKUPS; i++)
      await backupDatabase(store, dir, '2.0.0', { now: () => new Date(Date.UTC(2040, 0, 1 + i)) });
    // a clock put right since: this one's name is the oldest
    const made = await backupDatabase(store, dir, '2.0.1', { now: () => new Date(Date.UTC(2031, 0, 1)) });
    store.close();
    expect(made.ok && existsSync(join(dir, made.file))).toBe(true);
  });

  it('writes nothing when the disk hasn’t room, and says what it would take', async () => {
    const dir = join(work, 'full');
    const store = new Store(dir);
    const made = await backupDatabase(store, dir, '1.0.0', { free: () => 1024 });
    store.close();
    expect(made).toMatchObject({ ok: false, free: 1024 });
    if (!made.ok) expect(made.need).toBeGreaterThan(1024);
    expect(existsSync(join(dir, 'backups'))).toBe(false);
  });

  it('names a copy for its version, whatever the version holds', async () => {
    const dir = join(work, 'named');
    const store = new Store(dir);
    const made = await backupDatabase(store, dir, '../1.0 beta', {
      now: () => new Date(Date.UTC(2031, 4, 6, 7, 8, 9)),
    });
    store.close();
    expect(made).toMatchObject({ ok: true, file: join('backups', 'holo-..-1.0-beta-20310506T070809Z.db') });
  });
});
