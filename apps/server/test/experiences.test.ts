import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { studioEngine } from '@holo/music';
import type { Project } from '@holo/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-exp-test-'));
const creations = join(work, 'creations');
const repo = resolve(import.meta.dirname, '../../..');
const studio = studioEngine(repo);
let app: Awaited<ReturnType<typeof buildApp>>['app'];

/** An experience as `holo init` leaves it, pinned to an engine. */
function experience(name: string, engine: { source: string; date: string | null; commit: string | null }) {
  const root = join(creations, name);
  mkdirSync(join(root, 'music/sessions'), { recursive: true });
  writeFileSync(
    join(root, 'holo.creation.json'),
    JSON.stringify({
      format: 'holo-creation',
      version: 1,
      name,
      title: name.toUpperCase(),
      sessions: 'music/sessions',
      engine: {
        version: '0.1.0',
        ...engine,
        node: '22.23.2',
        file: 'music/holo/holo-music.mjs',
        sha256: '0'.repeat(64),
        packs: 'music/holo/packs.json',
        packsSha256: '0'.repeat(64),
      },
    }),
  );
  return root;
}

beforeAll(async () => {
  experience('current', { source: studio.source, date: studio.date, commit: studio.commit });
  experience('behind', { source: 'f'.repeat(64), date: '2020-01-01T00:00:00.000Z', commit: 'a'.repeat(40) });
  ({ app } = await buildApp({
    port: 0,
    host: '127.0.0.1',
    dataDir: join(work, 'data'),
    creationsDir: creations,
    webDir: join(work, 'no-web'),
    repoDir: repo,
    networkMidi: null,
  }));
}, 30_000);
afterAll(async () => {
  await app.close();
  rmSync(work, { recursive: true, force: true });
});

const json = async <T>(method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) => {
  const res = await app.inject({ method, url, ...(payload ? { payload: payload as object } : {}) });
  return { status: res.statusCode, body: res.json() as T };
};

describe('experiences in the studio', () => {
  it("says which engine each experience builds with, against the studio's", async () => {
    const health = await json<{ engine: { source: string; label: string } }>('GET', '/api/health');
    expect(health.body.engine.source).toBe(studio.source);
    const { body } = await json<{ name: string; engine: { relation: string; label: string } | null }[]>(
      'GET',
      '/api/creations',
    );
    const by = Object.fromEntries(body.map((c) => [c.name, c.engine]));
    expect(by.current?.relation).toBe('same');
    expect(by.behind?.relation).toBe(studio.date ? 'older' : 'different');
    expect(by.behind?.label).toBe('0.1.0+aaaaaaa');
  });

  it('makes a song for an experience, its file written at once under a free name', async () => {
    const a = await json<{ project: Project; path: string }>('POST', '/api/creations/current/songs', {
      title: 'Night Theme',
    });
    expect(a.status).toBe(201);
    expect(a.body.path).toBe('music/sessions/night-theme.holo.json');
    expect(a.body.project.origin).toMatchObject({ creation: 'current', piece: 'night-theme' });
    const file = JSON.parse(readFileSync(join(creations, 'current/music/sessions/night-theme.holo.json'), 'utf8'));
    expect(file.title).toBe('Night Theme');
    const b = await json<{ path: string }>('POST', '/api/creations/current/songs', { title: 'Night Theme' });
    expect(b.body.path).toBe('music/sessions/night-theme-2.holo.json');
    const c = await json<{ error: string }>('POST', '/api/creations/current/songs', {
      title: 'x',
      piece: 'night-theme',
    });
    expect(c.status).toBe(409);
    expect(c.body.error).toMatch(/has a song "night-theme" already/);
  });

  it('makes one of your songs an experience’s, and its recordings travel with it both ways', async () => {
    const made = await json<Project>('POST', '/api/projects', { title: 'Field Recording' });
    const song = made.body;
    // a recording kept with the song, and played by it
    const audio = join(work, 'data/audio', song.id);
    mkdirSync(audio, { recursive: true });
    writeFileSync(join(audio, 'aud_take1.wav'), 'RIFF-take-1');
    writeFileSync(join(audio, 'aud_unused.wav'), 'RIFF-unused');
    const withFile = { ...song, files: [{ id: 'aud_take1', name: 'take.wav', seconds: 1, rate: 44100, channels: 1 }] };
    expect((await json('PUT', `/api/projects/${song.id}`, { doc: withFile, baseRevision: song.revision })).status).toBe(
      200,
    );
    const sent = await json<{ path: string }>('POST', `/api/projects/${song.id}/send`, { creation: 'behind' });
    expect(sent.status).toBe(200);
    expect(sent.body.path).toBe('music/sessions/field-recording.holo.json');
    const folder = join(creations, 'behind/music/sessions/field-recording.audio');
    expect(readdirSync(folder)).toEqual(['aud_take1.wav']);
    expect((await json<Project>('GET', `/api/projects/${song.id}`)).body.origin?.creation).toBe('behind');
    // it belongs to that experience now
    const again = await json<{ error: string }>('POST', `/api/projects/${song.id}/send`, { creation: 'current' });
    expect(again.status).toBe(409);

    // brought in as a new song, its recording comes with it
    const opened = await json<Project>('POST', '/api/creations/behind/pieces/field-recording/open', { mode: 'new' });
    expect(opened.body.id).not.toBe(song.id);
    expect(existsSync(join(work, 'data/audio', opened.body.id, 'aud_take1.wav'))).toBe(true);

    // a recording the song no longer plays leaves the experience on the next send
    const current = (await json<Project>('GET', `/api/projects/${song.id}`)).body;
    await json('PUT', `/api/projects/${song.id}`, { doc: { ...current, files: [] }, baseRevision: current.revision });
    await json('POST', `/api/projects/${song.id}/send`);
    expect(readdirSync(folder)).toEqual([]);
  });
});
