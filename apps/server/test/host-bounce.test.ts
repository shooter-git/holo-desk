import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { encodeWav, renderSession } from '@holo/engine';
import { dataFolderSource } from '@holo/engine/node';
import { newProject, newRegion, type Project, type Track } from '@holo/session';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { BOUNCE_STOPPED, bounceFileName, HostBounces } from '../src/host-bounce.ts';
import { BAR, FakeChild, takeWorld } from './measure-fakes.ts';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'holo-host-bounce-'));
  made.push(dir);
  return join(dir, 'data');
};

/** A queue whose rendering processes are stand-ins, each kept to be spoken through. */
function fakes(options: { limitMs?: number; waiting?: number } = {}) {
  const dataDir = scratch();
  const children: FakeChild[] = [];
  const bounces = new HostBounces({
    dataDir,
    spawn: () => {
      const child = new FakeChild();
      children.push(child);
      return child;
    },
    ...options,
  });
  const ask = (title = 'Song', id = 'prj_one') => {
    const song = newProject(title);
    song.id = id;
    return bounces.start({ song, from: 0, to: BAR * 4, tail: 3, name: title });
  };
  /** The stand-in writes its file where it was told to, as the child does before it says it's done. */
  const wrote = (child: FakeChild, bytes = 'RIFF') => {
    const input = child.sent[0]?.input as { part: string };
    writeFileSync(input.part, bytes);
    return input.part;
  };
  return { dataDir, bounces, children, ask, wrote };
}

const settled = () => new Promise((done) => setImmediate(done));

describe('a bounce’s file name', () => {
  it('is when it was made and what it’s of, with nothing a folder can’t hold', () => {
    const at = new Date('2026-03-04T05:06:07.890Z');
    expect(bounceFileName('Lantern Sketch (cycle)', at)).toBe('2026-03-04 05.06.07 Lantern Sketch (cycle).wav');
    expect(bounceFileName('../../etc/passwd: "x"', at)).toBe('2026-03-04 05.06.07 ....etcpasswd x.wav');
    expect(bounceFileName('  ', at)).toBe('2026-03-04 05.06.07 Bounce.wav');
    expect(bounceFileName('é'.repeat(4) + 'a'.repeat(120), at)).toHaveLength(20 + 80 + 4);
  });
});

describe('the bounces the host makes', () => {
  afterEach(() => vi.useRealTimers());

  it('starts nothing until one is asked for, then one process for it', () => {
    const { bounces, children, ask } = fakes();
    expect(children).toHaveLength(0);
    expect(bounces.busy()).toBe(false);
    const job = ask();
    expect(job).toMatchObject({ project: 'prj_one', name: 'Song', state: 'running', lost: false, file: null });
    expect(children).toHaveLength(1);
    expect(bounces.busy()).toBe(true);
    expect(children[0]?.sent[0]).toMatchObject({
      type: 'run',
      id: job?.id,
      input: { from: 0, to: BAR * 4, tail: 3, project: { id: 'prj_one', title: 'Song' } },
    });
    bounces.close();
  });

  it('says how far it has got, keeps the file under the bounce’s name, and lets its process go', async () => {
    const { dataDir, bounces, children, ask, wrote } = fakes();
    const job = ask('Lantern Sketch');
    const child = children[0] as FakeChild;
    child.say({ type: 'progress', id: job?.id, line: 'Rendering… 40%' });
    expect(bounces.get(job?.id ?? '')?.line).toBe('Rendering… 40%');
    // (something said of another bounce is nothing to this one)
    child.say({ type: 'progress', id: 'bnc_other', line: 'Rendering… 99%' });
    expect(job?.line).toBe('Rendering… 40%');
    const part = wrote(child, 'the wav');
    child.say({ type: 'done', id: job?.id, seconds: 12.5 });
    expect(job).toMatchObject({ state: 'done', seconds: 12.5, error: null, lost: false });
    expect(job?.file).toMatch(/^\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d Lantern Sketch\.wav$/);
    expect(job?.url).toBe(`/api/projects/prj_one/bounces/${encodeURIComponent(job?.file ?? '')}`);
    expect(job?.path).toBe(`bounces/prj_one/${job?.file}`);
    expect(readFileSync(join(dataDir, 'bounces', 'prj_one', job?.file ?? ''), 'utf8')).toBe('the wav');
    expect(existsSync(part)).toBe(false);
    expect(child.killed).toBe(true);
    await settled();
    expect(bounces.busy()).toBe(false);
  });

  it('makes them one at a time, in the order they were asked for', async () => {
    const { bounces, children, ask, wrote } = fakes();
    const [a, b, c] = [ask('A'), ask('B'), ask('C')];
    expect([a?.state, b?.state, c?.state]).toEqual(['running', 'waiting', 'waiting']);
    expect(children).toHaveLength(1);
    wrote(children[0] as FakeChild);
    children[0]?.say({ type: 'done', id: a?.id, seconds: 1 });
    expect([a?.state, b?.state, c?.state]).toEqual(['done', 'running', 'waiting']);
    expect(children).toHaveLength(2);
    // (the first one's process leaving is nothing to the second)
    await settled();
    expect(b?.state).toBe('running');
    children[1]?.say({ type: 'failed', id: b?.id, error: 'No instrument vsco2/violin' });
    expect([b?.state, c?.state]).toEqual(['failed', 'running']);
    expect(bounces.busy()).toBe(true);
    bounces.close();
  });

  it('takes a few to wait their turn and no more', () => {
    const { bounces, ask } = fakes({ waiting: 2 });
    expect([ask(), ask(), ask()].every((j) => j !== null)).toBe(true);
    expect(ask()).toBeNull();
    bounces.close();
    expect(ask()).toBeNull();
  });

  it('says why one it couldn’t make failed: the song, or the host out of room', async () => {
    const { dataDir, bounces, children, ask, wrote } = fakes();
    // the render says what's wrong with the song: the device would fail the same way
    const a = ask('A');
    const part = wrote(children[0] as FakeChild);
    children[0]?.say({ type: 'failed', id: a?.id, error: 'The engine stopped: no such preset' });
    expect(a).toMatchObject({ state: 'failed', error: 'The engine stopped: no such preset', lost: false });
    expect(existsSync(part)).toBe(false);
    // its process gone before it was done
    const b = ask('B');
    children[1]?.kill();
    await settled();
    expect(b).toMatchObject({ state: 'failed', error: BOUNCE_STOPPED, lost: false });
    // said done, with no file to show for it
    const c = ask('C');
    children[2]?.say({ type: 'done', id: c?.id, seconds: 3 });
    expect(c).toMatchObject({ state: 'failed', lost: false });
    expect(readdirSync(join(dataDir, 'bounces', 'prj_one'))).toEqual([]);
    expect(bounces.busy()).toBe(false);
  });

  it('stops one that takes too long, and goes on to the next', () => {
    vi.useFakeTimers();
    const { children, ask } = fakes({ limitMs: 60_000 });
    const [a, b] = [ask('A'), ask('B')];
    vi.advanceTimersByTime(59_000);
    expect(a?.state).toBe('running');
    vi.advanceTimersByTime(2_000);
    expect(a).toMatchObject({ state: 'failed', lost: false });
    expect(a?.error).toContain('too long');
    expect(children[0]?.killed).toBe(true);
    expect(b?.state).toBe('running');
  });

  it('clears away what an earlier bounce left half-written, and nothing else', () => {
    const { dataDir, bounces, ask } = fakes();
    const dir = join(dataDir, 'bounces', 'prj_one');
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, '.bnc_stale123.part'), 'half');
    writeFileSync(join(dir, '2026-01-01 00.00.00 Kept.wav'), 'whole');
    ask();
    expect(readdirSync(dir)).toEqual(['2026-01-01 00.00.00 Kept.wav']);
    bounces.close();
  });

  it('stops everything when the server closes', async () => {
    const { bounces, children, ask, wrote } = fakes();
    const [a, b] = [ask('A'), ask('B')];
    const part = wrote(children[0] as FakeChild);
    const listening = process.listenerCount('exit');
    bounces.close();
    expect(a).toMatchObject({ state: 'failed', error: 'HO[LO] is closing', lost: true });
    expect(b).toMatchObject({ state: 'failed', error: 'HO[LO] is closing', lost: true });
    expect(children[0]?.killed).toBe(true);
    expect(children).toHaveLength(1);
    expect(existsSync(part)).toBe(false);
    expect(bounces.busy()).toBe(false);
    // (and it listens for this process's end only while one is under way)
    expect(process.listenerCount('exit')).toBe(listening - 1);
    await settled();
    expect(a?.error).toBe('HO[LO] is closing');
  });

  it('forgets the oldest finished bounces past the few it keeps', () => {
    const { bounces, children, ask } = fakes();
    const first = ask('First');
    children[0]?.say({ type: 'failed', id: first?.id, error: 'no' });
    for (let i = 0; i < 21; i++) {
      const job = ask(`Song ${i}`);
      children.at(-1)?.say({ type: 'failed', id: job?.id, error: 'no' });
    }
    expect(bounces.get(first?.id ?? '')).toBeNull();
    bounces.close();
  });
});

describe('a bounce asked of the host', () => {
  const config = (dataDir: string) => ({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    creationsDir: null,
    webDir: join(dataDir, 'no-web'),
    repoDir: resolve(import.meta.dirname, '../../..'),
    networkMidi: null,
  });

  /** The take's song (a recording, and a synth sent to a reverb bus playing chords through four bars), as a studio has it. */
  function world() {
    const w = takeWorld();
    made.push(join(w.dataDir, '..'));
    const keys = w.song.tracks[0] as Track;
    const r = newRegion(0, BAR * 4, 'Chords');
    for (let b = 0; b < 4; b++) for (const p of [50, 53, 57]) r.notes.push({ t: b * BAR, d: BAR, p, v: 90 });
    keys.regions.push(r);
    return w;
  }

  it('is refused for what isn’t a bounce of a song the host has', async () => {
    const children: FakeChild[] = [];
    const { dataDir, song } = world();
    const { app, services } = await buildApp(config(dataDir), {
      bounceSpawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
    });
    try {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { doc: song } });
      const ask = (payload: Record<string, unknown>, id = song.id) =>
        app.inject({ method: 'POST', url: `/api/projects/${id}/bounces/host`, payload });
      const whole = { doc: song, from: 0, to: BAR * 4, tail: 3, name: 'Measured' };
      expect((await ask(whole, 'prj_nosuchsong')).statusCode).toBe(404);
      expect((await ask({ ...whole, doc: { nothing: 'here' } })).statusCode).toBe(400);
      expect((await ask({ ...whole, doc: { ...song, id: 'prj_another' } })).statusCode).toBe(400);
      // (without both ends the engine would render the song's loop: another file)
      expect((await ask({ ...whole, to: undefined })).statusCode).toBe(400);
      expect((await ask({ ...whole, from: undefined })).statusCode).toBe(400);
      expect((await ask({ ...whole, from: BAR * 4, to: BAR * 4 })).statusCode).toBe(400);
      expect((await ask({ ...whole, tail: 600 })).statusCode).toBe(400);
      expect(children).toHaveLength(0);
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json().busy).toBe(false);

      // asked for properly: a job to ask about, and an update waits for it
      const res = await ask(whole);
      expect(res.statusCode).toBe(202);
      const { id } = res.json() as { id: string };
      expect(children).toHaveLength(1);
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json().busy).toBe(true);
      children[0]?.say({ type: 'progress', id, line: 'Loading instruments (1/2)' });
      const job = (await app.inject({ method: 'GET', url: `/api/bounce-jobs/${id}` })).json();
      expect(job).toMatchObject({ id, project: song.id, name: 'Measured', state: 'running' });
      expect(job.line).toBe('Loading instruments (1/2)');
      // (the job is what a studio follows: the song isn't sent back with it)
      expect(JSON.stringify(job)).not.toContain('tracks');
      expect((await app.inject({ method: 'GET', url: '/api/bounce-jobs/bnc_nosuch' })).statusCode).toBe(404);

      // the tail is three seconds unless said, and the name the song's
      await ask({ doc: song, from: 0, to: BAR });
      // more than may wait: the device is told to bounce it itself
      for (let i = 0; i < 3; i++) expect((await ask(whole)).statusCode).toBe(202);
      expect((await ask(whole)).statusCode).toBe(503);
      expect(children).toHaveLength(1);
      expect(services.bounces.busy()).toBe(true);
    } finally {
      await app.close();
    }
    // closed with the server
    expect(children[0]?.killed).toBe(true);
    expect(services.bounces.busy()).toBe(false);
  });

  it('is the file the studio’s own bounce makes, the whole song or a stretch of it', async () => {
    const { dataDir, song } = world();
    const { app, services } = await buildApp(config(dataDir));
    try {
      await app.inject({ method: 'POST', url: '/api/projects', payload: { doc: song } });
      /** As the studio's bounce renders (apps/web/src/audio/render.worker.ts), from the data folder. */
      const studio = async (p: Project, from: number, to: number) => {
        const out = await renderSession(p, dataFolderSource(dataDir, p.id), {
          sampleRate: p.sampleRate ?? 48000,
          from,
          to,
          tail: 3,
        });
        expect(out.errors).toEqual([]);
        return Buffer.from(encodeWav(out.channels, out.sampleRate, 'pcm24'));
      };
      const bounced = async (payload: Record<string, unknown>) => {
        const res = await app.inject({ method: 'POST', url: `/api/projects/${song.id}/bounces/host`, payload });
        expect(res.statusCode).toBe(202);
        const { id } = res.json() as { id: string };
        await vi.waitFor(
          async () => {
            const job = (await app.inject({ method: 'GET', url: `/api/bounce-jobs/${id}` })).json();
            expect(job.error).toBeNull();
            expect(job.state).toBe('done');
          },
          { timeout: 60_000, interval: 100 },
        );
        return services.bounces.get(id);
      };

      // the whole song
      const whole = await bounced({ doc: song, from: 0, to: BAR * 4, tail: 3, name: 'Measured' });
      expect(whole?.seconds).toBeGreaterThan(8);
      const file = await app.inject({ method: 'GET', url: whole?.url ?? '' });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('audio/wav');
      expect(file.headers['content-disposition']).toBe(`attachment; filename="${whole?.file}"`);
      expect(file.rawPayload.equals(await studio(song, 0, BAR * 4))).toBe(true);
      // (it sounds: a chord and a take, not silence)
      expect(file.rawPayload.subarray(44).some((b) => b !== 0)).toBe(true);
      // saved on a device under the name it asks for, when that's a name a file can have
      const named = (as: string) => app.inject({ method: 'GET', url: `${whole?.url}?as=${encodeURIComponent(as)}` });
      expect((await named('Measured')).headers['content-disposition']).toBe('attachment; filename="Measured.wav"');
      expect((await named('a/b"c')).headers['content-disposition']).toBe(`attachment; filename="${whole?.file}"`);
      // and listed with the song's bounces, the half-written name gone
      const listed = (await app.inject({ method: 'GET', url: `/api/projects/${song.id}/bounces` })).json();
      expect(listed.map((b: { file: string }) => b.file)).toEqual([whole?.file]);
      expect(readdirSync(join(dataDir, 'bounces', song.id))).toEqual([whole?.file]);

      // a stretch of the song as the page has it, changed since it was saved (a bounce is of what's there)
      const edited = structuredClone(song);
      (edited.tracks[0] as Track).regions[0]?.notes.push({ t: BAR, d: BAR, p: 62, v: 100 });
      const part = await bounced({ doc: edited, from: BAR, to: BAR * 3, tail: 3, name: 'Measured (cycle)' });
      expect(part?.file).toContain('Measured (cycle)');
      const stretch = readFileSync(join(dataDir, 'bounces', song.id, part?.file ?? ''));
      expect(stretch.equals(await studio(edited, BAR, BAR * 3))).toBe(true);
      expect(stretch.equals(await studio(song, BAR, BAR * 3))).toBe(false);
      expect((await app.inject({ method: 'GET', url: '/api/health' })).json().busy).toBe(false);
    } finally {
      await app.close();
    }
  }, 120_000);
});
