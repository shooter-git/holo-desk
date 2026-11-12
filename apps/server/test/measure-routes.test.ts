import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav } from '@holo/engine';
import { newRegion, newTrack, type Project, type Track } from '@holo/session';
import Fastify from 'fastify';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { JobRouteKit } from '../src/agent/job-routes/index.ts';
import { type AgentJob, Refusal } from '../src/agent/jobs.ts';
import measureRoutes from '../src/agent/measure/routes.ts';
import { MeasureRunner } from '../src/agent/measure/runner.ts';
import { NO_ANSWER } from '../src/live.ts';
import { agentWorld, auth } from './agent-fakes.ts';
import { BAR, FakeChild, SR, takeWorld, tone } from './measure-fakes.ts';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const JOB = 'agj_00000000000a';

interface KitOptions {
  studio?: boolean;
  meters?: Record<string, unknown>;
  attachments?: (song: Project) => Record<string, { project: string; type: string; name: string }>;
  runner?: MeasureRunner;
}

/** The measuring routes on a server of their own, for a job on the take's song (its Keys a synth). */
function served(o: KitOptions = {}) {
  const { dataDir, song, vocals } = takeWorld();
  made.push(join(dataDir, '..'));
  const app = Fastify();
  const job = { view: { id: JOB, project: song.id, state: 'running' } } as unknown as AgentJob;
  const ends: ((j: AgentJob) => void)[] = [];
  const closing: (() => void)[] = [];
  const forJob: JobRouteKit['forJob'] = (handler) => async (req, reply) => {
    try {
      return await handler(req, reply, job);
    } catch (err) {
      if (err instanceof Refusal)
        return reply.code(err.status).send({ error: err.message, ...(err.reason ? { reason: err.reason } : {}) });
      throw err;
    }
  };
  const kit = {
    app,
    J: '/api/agent/jobs/:job',
    forJob,
    jobs: {
      song: async () => structuredClone(song),
      studio: () => (o.studio === false ? null : {}),
      mayRead: () => true,
      onJobEnd: (fn: (j: AgentJob) => void) => ends.push(fn),
    },
    live: { request: async () => o.meters ?? { ok: false, error: NO_ANSWER } },
    attachments: {
      get: (id: string) => o.attachments?.(song)[id] ?? null,
      file: (id: string) => (o.attachments?.(song)[id] ? join(dataDir, 'agent', 'attachments', id, 'data') : null),
    },
    dataDir,
    onClose: (fn: () => void) => closing.push(fn),
  } as unknown as JobRouteKit;
  measureRoutes(kit, o.runner ? { runner: o.runner } : {});
  const post = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/agent/jobs/${JOB}/measure`, payload });
  const close = async () => {
    for (const fn of closing) fn();
    await app.close();
  };
  return { app, song, vocals, keys: song.tracks[0] as Track, dataDir, job, ends, post, close };
}

describe('measuring through the job’s routes', () => {
  it('measures a take, checking what it’s asked', async () => {
    const s = served();
    try {
      const res = await s.post({ what: 'take', track: s.vocals.id });
      expect(res.statusCode, res.body).toBe(200);
      const a = res.json();
      expect(a).toMatchObject({ done: true, result: { kind: 'take', name: 'Vocals', against: { kind: 'key' } } });
      expect(a.result.notes).toHaveLength(3);
      // asked again: from the cache
      expect((await s.post({ what: 'take', track: s.vocals.id })).json()).toMatchObject({ done: true, cached: true });
      const refused = async (payload: Record<string, unknown>, status: number, error: RegExp) => {
        const r = await s.post(payload);
        expect(r.statusCode, r.body).toBe(status);
        expect(r.json().error).toMatch(error);
      };
      await refused({ what: 'loudness' }, 400, /^what is take, mix/);
      await refused({ what: 'take', track: s.keys.id }, 400, /isn’t an audio track/);
      await refused({ what: 'take', track: 'trk_nope' }, 404, /No track trk_nope/);
      await refused({ what: 'take', track: s.vocals.id, from: BAR * 4, to: BAR * 2 }, 400, /to is after from/);
      await refused({ what: 'take', track: s.vocals.id, region: 'rgn_nope' }, 404, /No region rgn_nope/);
      await refused({ what: 'take', track: s.vocals.id, against: s.vocals.id }, 400, /against is "key", "none"/);
      await refused({ what: 'take', track: s.vocals.id, grid: 1 }, 400, /grid is a whole number/);
      await refused({ what: 'plugin', track: s.keys.id, plugin: 'fx_nope' }, 404, /No plugin fx_nope/);
      await refused({ what: 'tracks', against: s.keys.id }, 400, /against needs a track/);
    } finally {
      await s.close();
    }
  });

  it('answers how far a long one has got, and its answer when asked again by id', async () => {
    const children: FakeChild[] = [];
    const runner = new MeasureRunner({
      budgetMs: 20,
      spawn: () => {
        const c = new FakeChild();
        children.push(c);
        return c;
      },
    });
    const s = served({ runner });
    try {
      const a = (await s.post({ what: 'mix', from: 0, to: BAR * 2 })).json();
      expect(a).toMatchObject({ done: false, progress: 0 });
      expect(a.eta).toBeGreaterThan(0);
      const child = children[0] as FakeChild;
      expect(child.sent[0]).toMatchObject({ type: 'run', input: { kind: 'mix', from: 0, to: BAR * 2 } });
      child.say({ type: 'done', id: a.task, result: { kind: 'mix', ok: 1 } });
      const again = await s.app.inject({ method: 'GET', url: `/api/agent/jobs/${JOB}/measure/${a.task}` });
      expect(again.json()).toEqual({ done: true, task: a.task, result: { kind: 'mix', ok: 1 } });
      const unknown = await s.app.inject({ method: 'GET', url: `/api/agent/jobs/${JOB}/measure/msr_nope` });
      expect(unknown.statusCode).toBe(404);
      // a failure is said as such
      const b = (await s.post({ what: 'tracks', track: s.keys.id })).json();
      child.say({ type: 'failed', id: b.task, error: 'No instrument x/y' });
      const failed = await s.app.inject({ method: 'GET', url: `/api/agent/jobs/${JOB}/measure/${b.task}` });
      expect(failed.statusCode).toBe(422);
      expect(failed.json().error).toBe('The measurement failed: No instrument x/y');
    } finally {
      await s.close();
    }
  });

  it('refuses a render that would take too long, and says what to do instead', async () => {
    const s = served();
    try {
      // 300 bars on 20 sampled tracks
      const song = s.song as Project;
      for (let i = 0; i < 20; i++) {
        const t = newTrack(`Strings ${i}`, { type: 'sampler', pack: 'p', name: 'n' });
        t.regions.push(newRegion(0, BAR * 300, 'Long'));
        song.tracks.push(t);
      }
      const res = await s.post({ what: 'mix' });
      expect(res.statusCode).toBe(422);
      expect(res.json()).toMatchObject({ reason: 'too-long' });
      expect(res.json().error).toMatch(/minutes to render here: measure fewer bars .* bounce/);
      expect((await s.post({ what: 'tracks' })).json().reason).toBe('too-long');
    } finally {
      await s.close();
    }
  });

  it('reads the newest bounce, and says when the song changed after it', async () => {
    const s = served();
    try {
      const none = await s.post({ what: 'mix', source: 'bounce' });
      expect(none.statusCode).toBe(404);
      expect(none.json().reason).toBe('no-bounce');
      const dir = join(s.dataDir, 'bounces', s.song.id);
      mkdirSync(dir, { recursive: true });
      const write = (name: string, dbfs: number, at: Date) => {
        // 1 kHz, where K-weighting is level
        const t = tone(69 + 12 * Math.log2(1000 / 440), 6, 10 ** (dbfs / 20));
        writeFileSync(join(dir, name), encodeWav([t, t], SR, 'pcm24'));
        utimesSync(join(dir, name), at, at);
      };
      write('2026-11-01 09.00.00 Old.wav', -30, new Date('2026-11-01T09:00:00Z'));
      write('2026-11-02 09.00.00 New.wav', -20, new Date('2026-11-02T09:00:00Z'));
      s.song.modified = '2026-11-03T09:00:00Z';
      const a = (await s.post({ what: 'file' })).json();
      expect(a).toMatchObject({
        done: true,
        result: { kind: 'mix', source: 'bounce', name: '2026-11-02 09.00.00 New.wav', stale: true },
      });
      expect(a.result.loudness.integrated).toBeCloseTo(-20, 0);
      expect(a.result.made).toBe('2026-11-02T09:00:00.000Z');
    } finally {
      await s.close();
    }
  });

  it('reads only this request’s recordings, and only those the host decodes', async () => {
    const s = served({
      attachments: (song) => ({
        att_000000000001: { project: 'prj_other', type: 'audio/wav', name: 'a.wav' },
        att_000000000002: { project: song.id, type: 'audio/mpeg', name: 'b.mp3' },
        att_000000000003: { project: song.id, type: 'audio/wav', name: 'c.wav' },
      }),
    });
    try {
      const dir = join(s.dataDir, 'agent', 'attachments', 'att_000000000003');
      mkdirSync(dir, { recursive: true });
      writeFileSync(join(dir, 'data'), encodeWav([tone(64.2, 1)], SR, 'pcm24'));
      expect((await s.post({ what: 'file', attachment: 'att_000000000001' })).statusCode).toBe(403);
      const mp3 = await s.post({ what: 'take', attachment: 'att_000000000002' });
      expect(mp3.statusCode).toBe(422);
      expect(mp3.json().error).toMatch(/what the studio heard in this one is in its meta/);
      expect((await s.post({ what: 'take', attachment: 'att_000000000009' })).statusCode).toBe(404);
      const take = (await s.post({ what: 'take', attachment: 'att_000000000003' })).json();
      expect(take).toMatchObject({ done: true, result: { kind: 'take', track: null, name: 'c.wav' } });
      expect(take.result.notes.map((n: { target: number; cents: number }) => [n.target, Math.round(n.cents)])).toEqual([
        [64, 20],
      ]);
      const file = (await s.post({ what: 'file', attachment: 'att_000000000003' })).json();
      expect(file).toMatchObject({ done: true, result: { kind: 'mix', source: 'file', name: 'c.wav', tick: null } });
    } finally {
      await s.close();
    }
  });

  it('asks the studio for its meters while the song plays', async () => {
    const meters = {
      ok: true,
      playing: true,
      seconds: 12.3,
      channels: [
        { id: 'master', peak: [-3, -3.2], max: [-1, -1.1], gr: null, grMax: null, clipped: true },
        { id: 'trk_vocals', peak: [-9, -9], max: [-6, -6], gr: -2.5, grMax: -6.1, clipped: false },
        { id: 'not an id!', peak: [0, 0] },
      ],
    };
    const s = served({ meters });
    try {
      expect((await s.post({ what: 'meters' })).json()).toEqual({
        done: true,
        task: 'meters',
        result: {
          kind: 'meters',
          playing: true,
          seconds: 12.3,
          channels: [
            { id: 'master', peak: [-3, -3.2], max: [-1, -1.1], gr: null, grMax: null, clipped: true },
            { id: 'trk_vocals', peak: [-9, -9], max: [-6, -6], gr: -2.5, grMax: -6.1, clipped: false },
          ],
        },
      });
    } finally {
      await s.close();
    }
    const gone = served({ studio: false });
    expect((await gone.post({ what: 'meters' })).statusCode).toBe(403);
    await gone.close();
    const silent = served();
    expect((await silent.post({ what: 'meters' })).statusCode).toBe(504);
    await silent.close();
  });

  it('stops a stopped request’s measurements, lets a finished turn’s run on, and stops with the server', async () => {
    const runner = { jobEnded: vi.fn(), close: vi.fn() } as unknown as MeasureRunner;
    const s = served({ runner });
    const end = s.ends[0] as (j: AgentJob) => void;
    end({ view: { id: 'agj_1', state: 'cancelled' } } as unknown as AgentJob);
    end({ view: { id: 'agj_2', state: 'failed' } } as unknown as AgentJob);
    end({ view: { id: 'agj_3', state: 'done' } } as unknown as AgentJob);
    end({ view: { id: 'agj_4', state: 'awaiting' } } as unknown as AgentJob);
    expect(vi.mocked(runner.jobEnded).mock.calls).toEqual([
      ['agj_1', true],
      ['agj_2', true],
      ['agj_3', false],
      ['agj_4', false],
    ]);
    await s.close();
    expect(runner.close).toHaveBeenCalled();
  });
});

describe('measuring in HO[LO]', () => {
  it('measures a take for a job’s tools, as the studio saved the song', async () => {
    const w = await agentWorld();
    try {
      // the song in the world's data folder, with its take
      const { song: made, dataDir } = takeWorld();
      const song = { ...structuredClone(w.s), tracks: [...w.s.tracks, ...made.tracks.slice(1)], key: 'D minor' };
      const dir = join(w.dataDir, 'audio', song.id);
      mkdirSync(dir, { recursive: true });
      const { readFileSync } = await import('node:fs');
      writeFileSync(join(dir, 'aud_take1.wav'), readFileSync(join(dataDir, 'audio', made.id, 'aud_take1.wav')));
      rmSync(join(dataDir, '..'), { recursive: true, force: true });
      await w.save(song);
      const { job, token } = await w.start({ project: song.id, text: 'How in tune is the vocal?' });
      const res = await w.tool(job, token, 'POST', '/measure', { what: 'take', track: 'trk_vocals' });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json().result.notes.map((n: { target: number }) => n.target)).toEqual([62, 65, 69]);
      // a token that isn't the job's can't
      const other = await w.app.inject({
        method: 'POST',
        url: `/api/agent/jobs/${job}/measure`,
        headers: auth('x'.repeat(43)),
        payload: { what: 'take', track: 'trk_vocals' },
      });
      expect(other.statusCode).toBe(403);
    } finally {
      await w.close();
    }
  });
});
