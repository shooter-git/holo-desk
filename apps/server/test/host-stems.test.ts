/** A song's stems, made on the host: a ZIP of a WAV for each track, which add up to the mix. */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { stemSongs } from '@holo/agent/edits';
import { decodeWav, encodeWav, renderSession } from '@holo/engine';
import { dataFolderSource } from '@holo/engine/node';
import { bytesAccess, ZipFile } from '@holo/music';
import { newBus, newPlugin, newProject, newRegion, newTrack, type Project, type Track } from '@holo/session';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';
import { HostBounces } from '../src/host-bounce.ts';
import { BAR, FakeChild } from './measure-fakes.ts';

const made: string[] = [];
afterAll(() => {
  for (const dir of made) rmSync(dir, { recursive: true, force: true });
});
afterEach(() => vi.useRealTimers());

const scratch = () => {
  const dir = mkdtempSync(join(tmpdir(), 'holo-host-stems-'));
  made.push(dir);
  return join(dir, 'data');
};

/** Three synth tracks through two bars, each sent to a hall, the bass through a bus of its own. */
function song(): Project {
  const p = newProject('Stems');
  p.tempo = [{ tick: 0, bpm: 120 }];
  // (nothing that reacts to level: these stems add up to the mix)
  p.master.inserts = [];
  const hall = newBus('Hall');
  hall.channel.inserts = [newPlugin('reverb')];
  const low = newBus('Low');
  low.channel.inserts = [newPlugin('eq')];
  p.buses = [hall, low];
  const part = (name: string, preset: string, pitches: number[], pan: number): Track => {
    const t = newTrack(name, { type: 'synth', preset });
    const r = newRegion(0, BAR * 2, name);
    for (let b = 0; b < 2; b++) for (const pitch of pitches) r.notes.push({ t: b * BAR, d: BAR / 2, p: pitch, v: 90 });
    t.regions = [r];
    t.channel.pan = pan;
    t.channel.volume = -9;
    t.channel.sends = [{ bus: hall.id, level: -12, pre: false }];
    return t;
  };
  const bass = part('Bass', 'Analog Bass', [38], 0);
  bass.channel.output = low.id;
  const muted = part('Muted', 'Pluck', [72], 0);
  muted.channel.mute = true;
  p.tracks = [part('Keys', 'Soft Keys', [50, 53, 57], -0.4), bass, part('Lead', 'Bright Lead', [69], 0.5), muted];
  return p;
}

describe('a stems job in the host’s queue', () => {
  function fakes(limitMs?: number) {
    const dataDir = scratch();
    const children: FakeChild[] = [];
    const bounces = new HostBounces({
      dataDir,
      spawn: () => {
        const child = new FakeChild();
        children.push(child);
        return child;
      },
      ...(limitMs ? { limitMs } : {}),
    });
    return { dataDir, bounces, children };
  }

  it('tells its process to make stems, and keeps the ZIP it wrote under the job’s name', async () => {
    const { bounces, children } = fakes();
    const s = song();
    const job = bounces.start({ song: s, from: 0, to: BAR * 2, tail: 3, name: 'Stems (stems)', stems: true });
    expect(job?.stems).toBe(true);
    const child = children[0] as FakeChild;
    const input = child.sent[0]?.input as { part: string; stems?: boolean };
    expect(input.stems).toBe(true);
    writeFileSync(input.part, 'PK');
    child.say({ type: 'progress', id: job?.id, line: 'Stem 2 of 3, Bass: Rendering 40%' });
    expect(bounces.get(job?.id ?? '')?.line).toBe('Stem 2 of 3, Bass: Rendering 40%');
    child.say({ type: 'done', id: job?.id, seconds: 7 });
    const done = bounces.get(job?.id ?? '');
    expect([done?.state, done?.seconds]).toEqual(['done', 7]);
    expect(done?.file).toMatch(/^\d{4}-\d\d-\d\d \d\d\.\d\d\.\d\d Stems \(stems\)\.zip$/);
    expect(done?.url).toContain('.zip');
    bounces.close();
  });

  it('gives it a bounce’s time for each stem, and a bounce only its own', async () => {
    vi.useFakeTimers();
    const { bounces, children } = fakes(1000);
    const s = song();
    const stems = bounces.start({ song: s, from: 0, to: BAR * 2, tail: 3, name: 'S', stems: true });
    // three stems: three bounces' time
    await vi.advanceTimersByTimeAsync(2900);
    expect(bounces.get(stems?.id ?? '')?.state).toBe('running');
    await vi.advanceTimersByTimeAsync(200);
    expect(bounces.get(stems?.id ?? '')?.error).toMatch(/took too long/);
    const mix = bounces.start({ song: s, from: 0, to: BAR * 2, tail: 3, name: 'M' });
    await vi.advanceTimersByTimeAsync(1100);
    expect(bounces.get(mix?.id ?? '')?.error).toMatch(/took too long/);
    expect(children).toHaveLength(2);
    bounces.close();
  });
});

describe('stems asked of the host', () => {
  const config = (dataDir: string) => ({
    port: 0,
    host: '127.0.0.1',
    dataDir,
    creationsDir: null,
    webDir: join(dataDir, 'no-web'),
    repoDir: resolve(import.meta.dirname, '../../..'),
    networkMidi: null,
  });

  it('are a ZIP of each track’s own render, which add up to the mix before its finish', async () => {
    const dataDir = scratch();
    const s = song();
    // (a finish on the song: the stems are without it, whatever it is)
    s.finish = { lufs: -16, ceiling: -1, glue: true, lowcut: 28, tilt: 0 };
    const { app, services } = await buildApp(config(dataDir));
    try {
      const made = await app.inject({ method: 'POST', url: '/api/projects', payload: { doc: s } });
      const id = (made.json() as { id: string }).id;
      const doc = { ...s, id };
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${id}/bounces/host`,
        payload: { doc, from: 0, to: BAR * 2, tail: 2, stems: true },
      });
      expect(res.statusCode).toBe(202);
      const job = (res.json() as { id: string }).id;
      await vi.waitFor(
        async () => {
          const j = (await app.inject({ method: 'GET', url: `/api/bounce-jobs/${job}` })).json();
          expect(j.error).toBeNull();
          expect(j.state).toBe('done');
        },
        { timeout: 120_000, interval: 100 },
      );
      const done = services.bounces.get(job);
      expect(done?.file).toMatch(/ Stems \(stems\)\.zip$/);
      const file = await app.inject({ method: 'GET', url: done?.url ?? '' });
      expect(file.statusCode).toBe(200);
      expect(file.headers['content-type']).toBe('application/zip');
      expect(file.headers['content-disposition']).toBe(`attachment; filename="${done?.file}"`);
      const named = await app.inject({ method: 'GET', url: `${done?.url}?as=${encodeURIComponent('My stems')}` });
      expect(named.headers['content-disposition']).toBe('attachment; filename="My stems.zip"');

      // a file for each track the mix is made of (the muted one has none), in the song's order
      const zip = new ZipFile(bytesAccess(new Uint8Array(file.rawPayload)));
      expect(zip.names()).toEqual(['01 Keys.wav', '02 Bass.wav', '03 Lead.wav']);

      const render = async (p: Project) => {
        const out = await renderSession(p, dataFolderSource(dataDir, id), {
          sampleRate: 48000,
          from: 0,
          to: BAR * 2,
          tail: 2,
          finish: false,
        });
        expect(out.errors).toEqual([]);
        return out.channels;
      };
      // each is that track rendered alone, to the byte
      const stems = stemSongs(doc as Project);
      for (const stem of stems) {
        const own = Buffer.from(encodeWav(await render(stem.song), 48000, 'pcm24'));
        expect(Buffer.from(zip.read(stem.file)).equals(own), stem.file).toBe(true);
      }
      // and together they are the mix, to within the 24 bits each was written at
      const mix = await render(doc as Project);
      const sum = mix.map((ch) => new Float64Array(ch.length));
      for (const stem of stems) {
        const wav = decodeWav(zip.read(stem.file));
        wav.channels.forEach((ch, c) => {
          const into = sum[c] as Float64Array;
          for (let i = 0; i < ch.length; i++) into[i] = (into[i] as number) + (ch[i] as number);
        });
      }
      let off = 0;
      let peak = 0;
      mix.forEach((ch, c) => {
        for (let i = 0; i < ch.length; i++) {
          off = Math.max(off, Math.abs((ch[i] as number) - ((sum[c] as Float64Array)[i] as number)));
          peak = Math.max(peak, Math.abs(ch[i] as number));
        }
      });
      expect(peak).toBeGreaterThan(0.01);
      expect(off).toBeLessThan((stems.length + 1) / 2 ** 23);

      // listed with the song's bounces, with its size and no length (it's not one recording)
      const listed = (await app.inject({ method: 'GET', url: `/api/projects/${id}/bounces` })).json();
      expect(listed).toHaveLength(1);
      expect(listed[0].file).toBe(done?.file);
      expect(listed[0].bytes).toBe(file.rawPayload.length);
      expect(listed[0].seconds).toBeUndefined();
      // and deleted as a bounce is
      expect((await app.inject({ method: 'DELETE', url: done?.url ?? '' })).statusCode).toBe(200);
      expect((await app.inject({ method: 'GET', url: `/api/projects/${id}/bounces` })).json()).toEqual([]);
    } finally {
      await app.close();
    }
  }, 180_000);

  it('are refused for a song with nothing to hear', async () => {
    const dataDir = scratch();
    const { app } = await buildApp(config(dataDir));
    try {
      const empty = newProject('Empty');
      const made = await app.inject({ method: 'POST', url: '/api/projects', payload: { doc: empty } });
      const id = (made.json() as { id: string }).id;
      const res = await app.inject({
        method: 'POST',
        url: `/api/projects/${id}/bounces/host`,
        payload: { doc: { ...empty, id }, from: 0, to: BAR, stems: true },
      });
      expect([res.statusCode, res.json().error]).toEqual([
        400,
        expect.stringMatching(/Nothing in the song would be heard/),
      ]);
    } finally {
      await app.close();
    }
  });
});
