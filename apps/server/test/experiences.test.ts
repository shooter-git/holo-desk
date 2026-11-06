import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { formatPinnedPacks, type PinnedPack, packSha256, parsePinnedPacks, sha256, studioEngine } from '@holo/music';
import { newTrack, type Project } from '@holo/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-exp-test-'));
const creations = join(work, 'creations');
const repo = resolve(import.meta.dirname, '../../..');
const studio = studioEngine(repo);
let app: Awaited<ReturnType<typeof buildApp>>['app'];

/** A pack an experience's engine knows (a drum kit of one file), as packs.json holds it. */
const fxKit: PinnedPack = {
  id: 'fx-kit',
  name: 'FX Kit',
  license: 'CC0-1.0',
  credit: 'for the tests',
  source: { kind: 'local' },
  root: 'samples',
  instruments: [
    {
      name: 'kit',
      title: 'FX Kit',
      release: 0.1,
      attack: 0,
      oneShot: true,
      velocityRange: 12,
      zones: [
        {
          file: 'hit.wav',
          root: 36,
          lo: 36,
          hi: 36,
          lovel: 1,
          hivel: 127,
          gain: 0,
          start: 0,
          end: 0,
          loopStart: 0,
          loopEnd: 0,
          rate: 48000,
          rr: 1,
        },
      ],
    },
  ],
  files: { 'hit.wav': 'a'.repeat(64) },
} as unknown as PinnedPack;

/** An experience as `holo init` leaves it, pinned to an engine. */
function experience(
  name: string,
  engine: {
    source: string;
    date: string | null;
    commit: string | null;
    catalog?: Record<string, string>;
    packsAt?: { repo: string; commit: string };
  },
) {
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
        packsSha256: sha256(Buffer.from(formatPinnedPacks([]))),
        ...(engine.catalog ? { pinned: [] } : {}),
      },
    }),
  );
  mkdirSync(join(root, 'music/holo'), { recursive: true });
  writeFileSync(join(root, 'music/holo/packs.json'), formatPinnedPacks([]));
  return root;
}

beforeAll(async () => {
  experience('current', { source: studio.source, date: studio.date, commit: studio.commit });
  // an engine that knows the FX Kit (its map kept in the data folder, by its hash: no network)
  experience('pinned', {
    source: studio.source,
    date: studio.date,
    commit: studio.commit,
    catalog: { 'fx-kit': packSha256(fxKit) },
    packsAt: { repo: 'test/packs', commit: 'c'.repeat(40) },
  });
  mkdirSync(join(work, 'data/pack-maps'), { recursive: true });
  writeFileSync(join(work, 'data/pack-maps', `${packSha256(fxKit)}.json`), JSON.stringify(fxKit));
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

const json = async <T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: unknown) => {
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

describe("an experience's pinned packs", () => {
  it('follow what its songs play when one is sent: added as its engine knows them, let go when none plays them', async () => {
    const root = join(creations, 'pinned');
    const made = await json<Project>('POST', '/api/projects', { title: 'Hits' });
    const kit = newTrack('Kit', { type: 'sampler', pack: 'fx-kit', name: 'kit' }, '#fff');
    const doc = { ...made.body, tracks: [kit] };
    await json('PUT', `/api/projects/${made.body.id}`, { doc, baseRevision: made.body.revision });
    const sent = await json<{ packs: { added: string[] }; note: string }>(
      'POST',
      `/api/projects/${made.body.id}/send`,
      { creation: 'pinned' },
    );
    expect(sent.status).toBe(200);
    expect(sent.body.packs.added).toEqual(['fx-kit']);
    expect(sent.body.note).toMatch(/pins FX Kit now|pins fx-kit now/);
    const text = readFileSync(join(root, 'music/holo/packs.json'), 'utf8');
    expect(parsePinnedPacks(text).packs.map((p) => p.id)).toEqual(['fx-kit']);
    const manifest = JSON.parse(readFileSync(join(root, 'holo.creation.json'), 'utf8'));
    expect(manifest.engine.pinned).toEqual(['fx-kit']);
    expect(manifest.engine.packsSha256).toBe(sha256(Buffer.from(text)));
    // the same engine and the packs it plays: the same sound as the studio's
    const list = await json<{ name: string; engine: { relation: string } }[]>('GET', '/api/creations');
    expect(list.body.find((c) => c.name === 'pinned')?.engine.relation).toBe('same');

    // a pack the studio has that this engine doesn't know: said, not pinned
    const newer = Object.keys(studio.packs)[0] as string;
    const now = (await json<Project>('GET', `/api/projects/${made.body.id}`)).body;
    const other = newTrack('Other', { type: 'sampler', pack: newer, name: 'x' }, '#fff');
    await json('PUT', `/api/projects/${made.body.id}`, {
      doc: { ...now, tracks: [...now.tracks, other] },
      baseRevision: now.revision,
    });
    const again = await json<{ packs: { missing: { id: string; why: string }[] }; note: string }>(
      'POST',
      `/api/projects/${made.body.id}/send`,
    );
    expect(again.body.packs.missing).toEqual([{ id: newer, why: 'newer' }]);
    expect(again.body.note).toMatch(/holo update-engine/);

    // the song plays neither now: both let go
    const last = (await json<Project>('GET', `/api/projects/${made.body.id}`)).body;
    await json('PUT', `/api/projects/${made.body.id}`, { doc: { ...last, tracks: [] }, baseRevision: last.revision });
    const none = await json<{ packs: { dropped: string[] } }>('POST', `/api/projects/${made.body.id}/send`);
    expect(none.body.packs.dropped).toEqual(['fx-kit']);
  });
});

describe('removing a pack from the Library', () => {
  it('names the songs that play it, frees its folder, and is gone from the Library', async () => {
    const dir = join(work, 'data/packs/fake');
    mkdirSync(join(dir, 'samples'), { recursive: true });
    writeFileSync(join(dir, 'samples/hit.wav'), Buffer.alloc(2048));
    writeFileSync(
      join(dir, 'holo-pack.json'),
      JSON.stringify({
        ...fxKit,
        id: 'fake',
        name: 'Fake Kit',
        source: { kind: 'imported', from: 'x' },
        files: undefined,
      }),
    );
    await json('POST', '/api/packs/rescan');
    const listed = await json<{ id: string; bytes: number }[]>('GET', '/api/packs');
    expect(listed.body.find((p) => p.id === 'fake')?.bytes).toBeGreaterThanOrEqual(2048);

    const made = await json<Project>('POST', '/api/projects', { title: 'Uses Fake' });
    const kit = newTrack('Kit', { type: 'sampler', pack: 'fake', name: 'kit' }, '#fff');
    await json('PUT', `/api/projects/${made.body.id}`, {
      doc: { ...made.body, tracks: [kit] },
      baseRevision: made.body.revision,
    });
    const songs = await json<{ songs: { title: string }[] }>('GET', '/api/packs/fake/songs');
    expect(songs.body.songs.map((x) => x.title)).toEqual(['Uses Fake']);

    const removed = await json<{ freed: number }>('DELETE', '/api/packs/fake');
    expect(removed.status).toBe(200);
    expect(removed.body.freed).toBeGreaterThanOrEqual(2048);
    expect(existsSync(dir)).toBe(false);
    expect((await json<{ id: string }[]>('GET', '/api/packs')).body.some((p) => p.id === 'fake')).toBe(false);
    expect((await json('DELETE', '/api/packs/fake')).status).toBe(404);
  });
});
