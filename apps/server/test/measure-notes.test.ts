/**
 * A recording's notes on the host (the agent's audio_notes, holo notes): found as the studio finds them,
 * once per file whoever asks, through the agent's routes and the command line's; and a take measured
 * as it plays, its notes edited.
 */
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { decodeWav, encodeWav } from '@holo/engine';
import { notesAndCurves } from '@holo/engine/notes';
import type { AudioNotes, Project, Track } from '@holo/session';
import Fastify from 'fastify';
import { afterAll, describe, expect, it } from 'vitest';
import type { JobRouteKit } from '../src/agent/job-routes/index.ts';
import { type AgentJob, Refusal } from '../src/agent/jobs.ts';
import measureRoutes from '../src/agent/measure/routes.ts';
import { MeasureRunner, type RunnerOptions } from '../src/agent/measure/runner.ts';
import { runTask } from '../src/agent/measure/tasks.ts';
import { FakeChild, SR, takeWorld } from './measure-fakes.ts';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const JOB = 'agj_00000000000c';

function world() {
  const w = takeWorld();
  made.push(join(w.dataDir, '..'));
  return w;
}

/** A sung note with a vibrato (5.5 a second, ±40 cents) at a MIDI pitch, in silence: [at, length] s of `seconds`. */
function withVibrato(seconds: number, at: number, length: number, midi: number): Float32Array {
  const out = new Float32Array(Math.round(seconds * SR));
  let phase = 0;
  for (let i = 0; i < Math.round(length * SR); i++) {
    const t = i / SR;
    const hz = 440 * 2 ** ((midi + 0.4 * Math.sin(2 * Math.PI * 5.5 * t) - 69) / 12);
    phase += (2 * Math.PI * hz) / SR;
    out[Math.round(at * SR) + i] = 0.3 * Math.sin(phase);
  }
  return out;
}

/** The measuring routes, the agent's and the command line's, on one server and one runner. */
function served(o: RunnerOptions = {}) {
  const { dataDir, song, vocals } = world();
  const app = Fastify();
  const job = { view: { id: JOB, project: song.id, state: 'running' } } as unknown as AgentJob;
  const closing: (() => void)[] = [];
  const lines: string[] = [];
  const forJob: JobRouteKit['forJob'] = (handler) => async (req, reply) => {
    try {
      return await handler(req, reply, job);
    } catch (err) {
      if (err instanceof Refusal) return reply.code(err.status).send({ error: err.message });
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
      progress: (_j: AgentJob, line: string) => lines.push(line),
    },
    store: { get: (id: string) => (id === song.id ? structuredClone(song) : null) },
    live: { editor: () => null, request: async () => ({ ok: true }) },
    attachments: { get: () => null, file: () => null },
    dataDir,
    onClose: (fn: () => void) => closing.push(fn),
  } as unknown as JobRouteKit;
  const runner = new MeasureRunner(o);
  measureRoutes(kit, { runner });
  const agent = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/agent/jobs/${JOB}/measure`, payload });
  const terminal = (payload: Record<string, unknown>) =>
    app.inject({ method: 'POST', url: `/api/projects/${song.id}/measure`, payload });
  const close = async () => {
    for (const fn of closing) fn();
    await app.close();
  };
  return { app, song, vocals, keys: song.tracks[0] as Track, dataDir, runner, lines, agent, terminal, close };
}

describe('a recording’s notes, found on the host', () => {
  it('are found as the studio finds them, with each one’s drift and vibrato as sung', async () => {
    const { dataDir, song } = world();
    const r = await runTask(
      { kind: 'notes', dataDir, project: song.id, file: 'aud_take1', name: 'take.wav' },
      () => {},
    );
    if (r.kind !== 'notes') throw new Error(r.kind);
    expect(r).toMatchObject({ file: 'aud_take1', name: 'take.wav', seconds: 4, looks: 'mono' });
    expect(r.notes.n.map((n) => n.p)).toEqual([62, 65.3, 69]);
    expect(r.shapes).toEqual([
      { drift: 0, vibrato: null },
      { drift: 0, vibrato: null },
      { drift: 0, vibrato: null },
    ]);
    // the notes the studio's worker finds in the same file: decoded the same way, found by the same call
    const wav = decodeWav(new Uint8Array(readFileSync(join(dataDir, 'audio', song.id, 'aud_take1.wav'))));
    expect(r.notes).toEqual(notesAndCurves(wav.channels, wav.rate).notes);
    // a vibrato, as sung
    writeFileSync(join(dataDir, 'audio', song.id, 'aud_vib.wav'), encodeWav([withVibrato(3, 0.5, 2, 67)], SR, 'pcm24'));
    const v = await runTask({ kind: 'notes', dataDir, project: song.id, file: 'aud_vib', name: 'vib.wav' }, () => {});
    if (v.kind !== 'notes') throw new Error(v.kind);
    expect(v.notes.n).toHaveLength(1);
    const [rate, depth] = v.shapes[0]?.vibrato ?? [0, 0];
    expect(rate).toBeCloseTo(5.5, 0);
    expect(Math.abs(depth - 40)).toBeLessThan(8);
    // a file that's gone says so
    await expect(
      runTask({ kind: 'notes', dataDir, project: song.id, file: 'aud_gone', name: 'gone.wav' }, () => {}),
    ).rejects.toThrow('The recording gone.wav is missing');
  });

  it('are found once per file, whoever asks and whatever the song’s revision, through both routes', async () => {
    const s = served();
    try {
      const a = await s.agent({ what: 'notes', track: s.vocals.id, region: 'rgn_take1' });
      expect(a.statusCode, a.body).toBe(200);
      expect(a.json()).toMatchObject({ done: true, result: { kind: 'notes', file: 'aud_take1', name: 'take.wav' } });
      expect(a.json().result.notes.n).toHaveLength(3);
      // the song changed: its recording's notes didn't
      s.song.revision += 5;
      s.song.title = 'Changed';
      const t = await s.terminal({ what: 'notes', track: s.vocals.id });
      expect(t.json()).toMatchObject({ done: true, cached: true, task: a.json().task });
      const refused = async (payload: Record<string, unknown>, status: number, error: RegExp) => {
        for (const ask of [s.agent, s.terminal]) {
          const r = await ask(payload);
          expect(r.statusCode, r.body).toBe(status);
          expect(r.json().error).toMatch(error);
        }
      };
      await refused({ what: 'notes', track: s.keys.id }, 400, /isn’t an audio track: notes are found in a recording/);
      await refused({ what: 'notes', track: s.vocals.id, region: 'rgn_nope' }, 404, /No region rgn_nope on Vocals/);
      await refused({ what: 'notes' }, 400, /track is an id/);
    } finally {
      await s.close();
    }
  }, 20_000);

  it('answer how far they’ve got within the budget, and the same call again joins them', async () => {
    const children: FakeChild[] = [];
    const s = served({
      budgetMs: 20,
      spawn: () => {
        const c = new FakeChild();
        children.push(c);
        return c;
      },
    });
    try {
      const first = (await s.agent({ what: 'notes', track: s.vocals.id })).json();
      expect(first).toMatchObject({ done: false });
      const child = children[0] as FakeChild;
      expect(child.sent[0]).toMatchObject({
        type: 'run',
        input: { kind: 'notes', project: s.song.id, file: 'aud_take1', name: 'take.wav' },
      });
      expect(s.runner.status().files.running).toBe(first.task);
      child.say({ type: 'progress', id: child.running, fraction: 0.5, stage: 'Finding the notes in take.wav' });
      const again = (await s.terminal({ what: 'notes', track: s.vocals.id })).json();
      expect(again).toMatchObject({ done: false, task: first.task, progress: 0.5 });
      const notes: AudioNotes = { mode: 'mono', v: 1, n: [{ t: 0.5, d: 0.6, p: 62 }] };
      child.say({
        type: 'done',
        id: child.running,
        result: {
          kind: 'notes',
          file: 'aud_take1',
          name: 'take.wav',
          seconds: 4,
          notes,
          shapes: [null],
          looks: 'mono',
        },
      });
      expect((await s.agent({ what: 'notes', track: s.vocals.id })).json()).toMatchObject({
        done: true,
        task: first.task,
        result: { notes },
      });
    } finally {
      await s.close();
    }
  });
});

describe('a take measured as it plays', () => {
  /** The take with its F4 (30 cents sharp) moved up two semitones, as a first edit keeps its notes. */
  async function edited(): Promise<{ dataDir: string; song: Project; vocals: Track }> {
    const w = world();
    const found = await runTask(
      { kind: 'notes', dataDir: w.dataDir, project: w.song.id, file: 'aud_take1', name: 'take.wav' },
      () => {},
    );
    if (found.kind !== 'notes') throw new Error(found.kind);
    const notes = structuredClone(found.notes);
    const f = notes.n[1] as AudioNotes['n'][number];
    f.to = (f.p as number) + 2;
    const audio = w.vocals.regions[0]?.audio;
    if (audio) audio.notes = notes;
    return w;
  }

  it('hears a note moved where it now sings, and the rest as recorded', async () => {
    const { dataDir, song, vocals } = await edited();
    const take = { kind: 'take' as const, dataDir, project: song, track: vocals.id, against: 'none', grid: 240 };
    const r = await runTask(take, () => {});
    if (r.kind !== 'take') throw new Error(r.kind);
    expect(r.notes.map((n) => n.target)).toEqual([62, 67, 69]);
    // two semitones up from 30 cents sharp, within 5 cents; the others untouched
    expect(Math.abs((r.notes[1]?.pitch ?? 0) - 67.3)).toBeLessThan(0.05);
    expect(r.notes[0]?.pitch).toBeCloseTo(62, 2);
    expect(r.notes[2]?.pitch).toBeCloseTo(69, 2);
    // on the timeline where it was, at its level
    const audio = vocals.regions[0]?.audio;
    const plain = structuredClone(song);
    delete plain.tracks[1]?.regions[0]?.audio?.notes;
    const raw = await runTask({ ...take, project: plain }, () => {});
    if (raw.kind !== 'take') throw new Error(raw.kind);
    r.notes.forEach((n, i) => {
      const was = raw.notes[i] as (typeof raw.notes)[number];
      expect(Math.abs(n.at - was.at), `note ${i}`).toBeLessThan(0.01);
      expect(Math.abs(n.db - was.db), `note ${i}`).toBeLessThan(0.5);
      expect(n.region).toBe('rgn_take1');
    });
    // edits off: as recorded; and the song itself is left as it was
    if (audio?.notes) audio.notes.off = true;
    const off = await runTask(take, () => {});
    expect(off.kind === 'take' && off.notes.map((n) => n.target)).toEqual([62, 65, 69]);
    expect(audio).toMatchObject({ file: 'aud_take1', offset: 0, stretch: 1 });
  });

  it('through the command line’s route as through the agent’s', async () => {
    const w = await edited();
    const s = served();
    try {
      // (the served song, its take edited as above: the same recording)
      s.song.tracks = w.song.tracks;
      const t = (await s.terminal({ what: 'take', track: s.vocals.id, against: 'none' })).json();
      expect(t.result.notes.map((n: { target: number }) => n.target)).toEqual([62, 67, 69]);
      const a = (await s.agent({ what: 'take', track: s.vocals.id, against: 'none' })).json();
      expect(a).toMatchObject({ done: true, cached: true, task: t.task });
    } finally {
      await s.close();
    }
  }, 20_000);
});
