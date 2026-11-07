import { mkdtempSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { notate, type Scan, toMusicXml } from '@holo/score';
import { newProject, newRegion, PPQ, type Project, parseNotation } from '@holo/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-omr-test-'));
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let engine: Server;

/** The song as an engine would read the page: bar 2 read wrong. */
function reading(): string {
  const p = newProject('Page');
  const r = newRegion(0, PPQ * 8);
  r.notes = parseNotation('D5:4 E5:4 | G5:8', { unit: PPQ / 2 });
  const t = p.tracks[0];
  if (t) t.regions = [r];
  return toMusicXml(notate(p));
}

beforeAll(async () => {
  // a stand-in for the engines' container
  engine = createServer((req, res) => {
    if (req.url === '/health') {
      res.end(JSON.stringify({ engines: ['stub'] }));
      return;
    }
    req.resume();
    req.on('end', () => res.end(JSON.stringify({ readings: [{ engine: 'stub', musicxml: reading() }] })));
  });
  await new Promise<void>((r) => engine.listen(0, '127.0.0.1', () => r()));
  const port = (engine.address() as { port: number }).port;
  ({ app } = await buildApp({
    port: 0,
    host: '127.0.0.1',
    dataDir: join(work, 'data'),
    creationsDir: null,
    webDir: join(work, 'no-web'),
    repoDir: resolve(import.meta.dirname, '../../..'),
    networkMidi: null,
    omrUrl: `http://127.0.0.1:${port}`,
  }));
}, 30_000);
afterAll(async () => {
  await app.close();
  engine.close();
  rmSync(work, { recursive: true, force: true });
});

describe('the recognition engines', () => {
  it('flag the bars they read differently from the song', async () => {
    const song = newProject('Page');
    const r = newRegion(0, PPQ * 8);
    r.notes = parseNotation('D5:4 E5:4 | F5:8', { unit: PPQ / 2 });
    const t = song.tracks[0];
    if (t) t.regions = [r];
    const saved = (
      await app.inject({ method: 'POST', url: '/api/projects', payload: { doc: song } })
    ).json() as Project;
    const scan = (
      await app.inject({ method: 'POST', url: '/api/scans', payload: { project: saved.id } })
    ).json() as Scan;
    await app.inject({
      method: 'PUT',
      url: `/api/scans/${scan.id}/pages/0`,
      headers: { 'content-type': 'image/png' },
      payload: Buffer.from('not really a png'),
    });
    await app.inject({
      method: 'PUT',
      url: `/api/scans/${scan.id}`,
      payload: {
        ...scan,
        pages: [
          {
            w: 100,
            h: 100,
            type: 'png',
            systems: [
              {
                top: 0,
                bottom: 50,
                left: 0,
                right: 100,
                staves: 1,
                bars: [0, 50, 100],
                state: 'read',
                written: [1, 2],
              },
            ],
          },
        ],
      },
    });
    expect((await app.inject({ method: 'GET', url: '/api/omr' })).json()).toEqual({
      available: true,
      engines: ['stub'],
    });
    const res = await app.inject({ method: 'POST', url: `/api/scans/${scan.id}/engines` });
    expect(res.json()).toMatchObject({ flagged: 1 });
    const after = (await app.inject({ method: 'GET', url: `/api/scans/${scan.id}` })).json() as Scan;
    expect(after.pages[0]?.systems[0]?.flags).toEqual(['stub reads bar 2 as G5 (the song has F5)']);
  });
});
