import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeWav } from '@holo/engine';
import { newRegion, newTrack, type Project } from '@holo/session';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import type { JobRouteKit } from '../src/agent/job-routes/index.ts';
import { type AgentJob, Refusal } from '../src/agent/jobs.ts';
import measureRoutes from '../src/agent/measure/routes.ts';
import { buildApp } from '../src/app.ts';
import { NO_ANSWER } from '../src/live.ts';
import { BAR, SR, takeWorld, tone } from './measure-fakes.ts';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const JOB = 'agj_00000000000b';

/** The measuring routes, the agent's and the command line's, on one server and one runner. */
function served(o: { studio?: boolean; meters?: Record<string, unknown> } = {}) {
  const { dataDir, song, vocals } = takeWorld();
  made.push(join(dataDir, '..'));
  const app = Fastify();
  app.addContentTypeParser('application/x-holo-audio', (_req, payload, done) => done(null, payload));
  const job = { view: { id: JOB, project: song.id, state: 'running' } } as unknown as AgentJob;
  const closing: (() => void)[] = [];
  /** What the studio was asked. */
  const asked: Record<string, unknown>[] = [];
  const forJob: JobRouteKit['forJob'] = (handler) => async (req, reply) => {
    try {
      return await handler(req, reply, job);
    } catch (err) {
      if (err instanceof Refusal) return reply.code(err.status).send({ error: err.message, reason: err.reason });
      throw err;
    }
  };
  const kit = {
    app,
    J: '/api/agent/jobs/:job',
    forJob,
    jobs: {
      song: async () => structuredClone(song),
      studioBack: async () => ({}),
      mayRead: () => true,
      onJobEnd: () => undefined,
      progress: () => undefined,
    },
    store: { get: (id: string) => (id === song.id ? structuredClone(song) : null) },
    live: {
      editor: (project?: string) => (o.studio && (!project || project === song.id) ? {} : null),
      request: async (_studio: unknown, msg: Record<string, unknown>) => {
        asked.push(msg);
        if (msg.type === 'agent-flush') return { ok: true, revision: 1 };
        return o.meters ?? { ok: false, error: NO_ANSWER };
      },
    },
    attachments: { get: () => null, file: () => null },
    dataDir,
    onClose: (fn: () => void) => closing.push(fn),
  } as unknown as JobRouteKit;
  measureRoutes(kit);
  const measure = (payload: Record<string, unknown>, id = song.id) =>
    app.inject({ method: 'POST', url: `/api/projects/${id}/measure`, payload });
  const send = (bytes: Uint8Array, name = 'take.wav') =>
    app.inject({
      method: 'POST',
      url: `/api/projects/${song.id}/measure/files?name=${encodeURIComponent(name)}`,
      headers: { 'content-type': 'application/x-holo-audio' },
      payload: Buffer.from(bytes),
    });
  const close = async () => {
    for (const fn of closing) fn();
    await app.close();
  };
  return { app, song, vocals, asked, measure, send, close };
}

describe('measuring from the command line', () => {
  it('measures a take as the agent does, the same measurement whoever asks', async () => {
    const s = served({ studio: true });
    try {
      const res = await s.measure({ what: 'take', track: s.vocals.id });
      expect(res.statusCode, res.body).toBe(200);
      const a = res.json();
      expect(a).toMatchObject({ done: true, result: { kind: 'take', name: 'Vocals', against: { kind: 'key' } } });
      expect(a.result.notes).toHaveLength(3);
      // the studio with the song open saved it first
      expect(s.asked[0]).toMatchObject({ type: 'agent-flush' });
      // the agent asking the same of the same song gets the same measurement, from the cache
      const agent = await s.app.inject({
        method: 'POST',
        url: `/api/agent/jobs/${JOB}/measure`,
        payload: { what: 'take', track: s.vocals.id },
      });
      expect(agent.json()).toMatchObject({ done: true, cached: true, task: a.task });
      expect(agent.json().result).toEqual(a.result);
      // and by its id
      const again = await s.app.inject({ method: 'GET', url: `/api/projects/${s.song.id}/measure/${a.task}` });
      expect(again.json()).toMatchObject({ done: true, task: a.task });
    } finally {
      await s.close();
    }
  });

  it('refuses what it can’t measure, in the command line’s words', async () => {
    const s = served();
    try {
      expect((await s.measure({ what: 'take', track: s.vocals.id }, 'prj_nope')).statusCode).toBe(404);
      expect((await s.measure({ what: 'loudness' })).json().error).toMatch(/^what is take, mix/);
      expect((await s.measure({ what: 'file', attachment: 'att_000000000001' })).statusCode).toBe(400);
      const meters = await s.measure({ what: 'meters' });
      expect(meters.statusCode).toBe(409);
      expect(meters.json().error).toMatch(/No studio has this song open/);
      const none = await s.measure({ what: 'mix', source: 'bounce' });
      expect(none.json()).toMatchObject({ reason: 'no-bounce' });
      expect(none.json().error).toMatch(/holo bounce/);
      // 300 bars on 20 sampled tracks
      const song = s.song as Project;
      for (let i = 0; i < 20; i++) {
        const t = newTrack(`Strings ${i}`, { type: 'sampler', pack: 'p', name: 'n' });
        t.regions.push(newRegion(0, BAR * 300, 'Long'));
        song.tracks.push(t);
      }
      const long = await s.measure({ what: 'mix' });
      expect(long.json()).toMatchObject({ reason: 'too-long' });
      expect(long.json().error).toMatch(/--from and --to.*holo bounce.*--source bounce/);
    } finally {
      await s.close();
    }
  });

  it('asks the studio with the song open for its meters', async () => {
    const s = served({ studio: true, meters: { ok: true, playing: true, seconds: 8, covered: 8, channels: [] } });
    try {
      const res = await s.measure({ what: 'meters', seconds: 4 });
      expect(res.json()).toMatchObject({ done: true, task: 'meters', result: { kind: 'meters', playing: true } });
      expect(s.asked.at(-1)).toMatchObject({ type: 'agent-meters', seconds: 4 });
    } finally {
      await s.close();
    }
  });

  it('measures a recording sent to it, the same file under the same id', async () => {
    const s = served();
    try {
      const t = tone(69 + 12 * Math.log2(1000 / 440), 3, 0.25);
      const wav = encodeWav([t, t], SR, 'pcm24');
      const sent = await s.send(wav);
      expect(sent.statusCode, sent.body).toBe(201);
      const { file } = sent.json();
      expect(file).toMatch(/^mfl_[0-9a-f]{16}$/);
      expect((await s.send(wav)).json().file).toBe(file);
      const res = await s.measure({ what: 'file', file });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toMatchObject({ done: true, result: { kind: 'mix', source: 'file', name: 'take.wav' } });
      expect((await s.measure({ what: 'take', file, through: 'effects' })).json().error).toMatch(/--through effects/);
      expect((await s.measure({ what: 'file', file: 'mfl_0000000000000000' })).statusCode).toBe(404);
      const text = await s.send(new TextEncoder().encode('not a recording at all'), 'notes.txt');
      expect(text.statusCode).toBe(415);
    } finally {
      await s.close();
    }
  });
});

describe('what was just played, for the command line', () => {
  const work = mkdtempSync(join(tmpdir(), 'holo-played-test-'));
  made.push(work);

  it('asks the open studio, and says so when there is none', async () => {
    const { app } = await buildApp({
      port: 0,
      host: '127.0.0.1',
      dataDir: join(work, 'data'),
      creationsDir: null,
      webDir: join(work, 'no-web'),
      repoDir: resolve(import.meta.dirname, '../../..'),
      networkMidi: null,
    });
    try {
      expect((await app.inject({ method: 'GET', url: '/api/live/played?seconds=90' })).statusCode).toBe(400);
      const none = await app.inject({ method: 'GET', url: '/api/live/played?seconds=20' });
      expect(none.statusCode).toBe(409);
      expect(none.json().error).toMatch(/No studio is open/);
      const other = await app.inject({ method: 'GET', url: '/api/live/played?project=prj_x' });
      expect(other.json().error).toMatch(/No studio has this song open/);
    } finally {
      await app.close();
    }
  }, 30_000);
});
