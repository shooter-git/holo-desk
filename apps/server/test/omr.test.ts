import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { notate, type Scan, scoreText, toMusicXml } from '@holo/score';
import { newProject, newRegion, newTrack, PPQ, type Project, parseNotation, type Track } from '@holo/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import type { EngineReadingAnswer } from '../src/omr.ts';

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

// ---- reading a scan in with the engines ----

const BAR = PPQ * 4;
const FOUR_BARS = 'D5:4 | E5:2 F5:2 | G5:1 A5:1 B5:2 | C6:4';

/** A track playing `notes` (quarter-note units) from the start, as many bars long as they are. */
function track(name: string, notes: string): Track {
  const t = newTrack(name, { type: 'synth', preset: 'Soft Keys' });
  const played = parseNotation(notes, { unit: PPQ });
  const end = Math.max(0, ...played.map((n) => n.t + n.d));
  const r = newRegion(0, Math.max(1, Math.ceil(end / BAR)) * BAR);
  r.notes = played;
  t.regions = [r];
  return t;
}

/** A page as an engine reads it: its parts as MusicXML. */
function page(parts: Track[]): string {
  const p = newProject('Page');
  p.tracks = parts;
  return toMusicXml(notate(p));
}

/** A system on a page: `bars` bars between its bar lines. */
const system = (k: number, bars: number, more: Record<string, unknown> = {}) => ({
  top: k * 200,
  bottom: k * 200 + 150,
  left: 40,
  right: 1160,
  staves: 1,
  bars: Array.from({ length: bars + 1 }, (_, i) => 40 + i * 200),
  state: 'new',
  ...more,
});

/** A song saved on the host, and a scan of it with these pages of systems. */
async function scanned(song: Project, pages: ReturnType<typeof system>[][]): Promise<{ project: Project; scan: Scan }> {
  const project = (
    await app.inject({ method: 'POST', url: '/api/projects', payload: { doc: song } })
  ).json() as Project;
  const made = (
    await app.inject({ method: 'POST', url: '/api/scans', payload: { project: project.id } })
  ).json() as Scan;
  const scan = (
    await app.inject({
      method: 'PUT',
      url: `/api/scans/${made.id}`,
      payload: { ...made, pages: pages.map((systems) => ({ w: 1200, h: 1600, type: 'png', systems })) },
    })
  ).json() as Scan;
  return { project, scan };
}

/** An engine's reading of a page, kept where the engines' run keeps it. */
function kept(scan: Scan, n: number, engine: string, musicxml: string): void {
  const dir = join(work, 'data', 'scans', scan.id, 'engines');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${n}-${engine}.musicxml`), musicxml);
}

function songWith(...tracks: Track[]): Project {
  const p = newProject('Song');
  p.tracks = tracks;
  return p;
}

const readIn = (id: string) => app.inject({ method: 'GET', url: `/api/scans/${id}/engines/reading` });
const get = async <T>(url: string) => (await app.inject({ method: 'GET', url })).json() as T;

describe('reading a scan in with the engines', () => {
  it('answers the systems not read yet as one change, changing nothing itself; then has nothing left', async () => {
    const { project, scan } = await scanned(songWith(track('Flute', '')), [[system(0, 2), system(1, 2)]]);
    kept(scan, 0, 'audiveris', page([track('Flute', FOUR_BARS)]));

    const res = await readIn(scan.id);
    expect(res.statusCode).toBe(200);
    const r = res.json() as EngineReadingAnswer;
    expect(r.label).toBe('Scan: bars 1–4, read by audiveris');
    expect(r.revision).toBe(project.revision);
    expect(r.systems).toEqual([
      { page: 0, system: 0, state: 'read', written: [1, 2] },
      { page: 0, system: 1, state: 'read', written: [3, 4] },
    ]);
    expect(r.pages).toEqual([{ page: 0, engine: 'audiveris', others: [] }]);
    expect(r.written).toEqual([1, 2, 3, 4]);
    expect(r.errors).toEqual([]);
    expect(r.warnings).toEqual([]);
    expect(r.ops.length).toBeGreaterThan(0);

    // nothing changed: the scan's systems are still new, the song as it was
    expect(await get<Scan>(`/api/scans/${scan.id}`)).toEqual(scan);
    expect((await get<Project>(`/api/projects/${project.id}`)).revision).toBe(project.revision);

    // the ops are the bars, as one change (with no studio open, the host applies them)
    const applied = await app.inject({
      method: 'POST',
      url: `/api/projects/${project.id}/ops`,
      payload: { ops: r.ops, label: r.label },
    });
    expect(applied.statusCode).toBe(200);
    const after = await get<Project>(`/api/projects/${project.id}`);
    expect(scoreText(notate(after)).split('\n').slice(2)).toEqual([
      'bar 1  time 4/4',
      '  clef P1 s1 G',
      '  P1: d5:w',
      'bar 2',
      '  P1: e5:h f5:h',
      'bar 3',
      '  P1: g5:q a5:q b5:h',
      'bar 4',
      '  P1: c6:w',
    ]);

    // the studio marks the systems once it has applied them, through the systems' own route
    for (const s of r.systems) {
      const patched = await app.inject({
        method: 'PATCH',
        url: `/api/scans/${scan.id}/systems/${s.page}/${s.system}`,
        payload: { state: s.state, written: s.written, flags: s.flags ?? [] },
      });
      expect(patched.statusCode).toBe(200);
    }
    const again = await readIn(scan.id);
    expect(again.statusCode).toBe(200);
    expect(again.json()).toEqual({
      ops: [],
      label: '',
      revision: after.revision,
      systems: [],
      pages: [],
      written: [],
      errors: [],
      warnings: [],
    });
  });

  it('flags the systems the other engines read differently', async () => {
    const { scan } = await scanned(songWith(track('Flute', '')), [[system(0, 2), system(1, 2)]]);
    kept(scan, 0, 'audiveris', page([track('Flute', FOUR_BARS)]));
    // bar 2 misread
    kept(scan, 0, 'oemer', page([track('Flute', 'D5:4 | E5:2 G5:2 | G5:1 A5:1 B5:2 | C6:4')]));
    const r = (await readIn(scan.id)).json() as EngineReadingAnswer;
    expect(r.pages).toEqual([{ page: 0, engine: 'audiveris', others: ['oemer'] }]);
    expect(r.label).toBe('Scan: bars 1–4, read by audiveris');
    expect(r.systems).toEqual([
      {
        page: 0,
        system: 0,
        state: 'read',
        written: [1, 2],
        flags: ['oemer reads bar 2 as E5 G5 (the song has E5 F5)'],
      },
      { page: 0, system: 1, state: 'read', written: [3, 4] },
    ]);
  });

  it('reads in what the engines read when they ran', async () => {
    const { scan } = await scanned(newProject('Song'), [[system(0, 2)]]);
    await app.inject({
      method: 'PUT',
      url: `/api/scans/${scan.id}/pages/0`,
      headers: { 'content-type': 'image/png' },
      payload: Buffer.from('not really a png'),
    });
    // not run yet: the studio runs them, then asks again
    expect((await readIn(scan.id)).statusCode).toBe(409);
    const ran = await app.inject({ method: 'POST', url: `/api/scans/${scan.id}/engines` });
    expect(ran.json()).toEqual({ summary: ['page 1: stub read it'], flagged: 0 });
    const r = (await readIn(scan.id)).json() as EngineReadingAnswer;
    expect(r.label).toBe('Scan: bars 1–2, read by stub');
    expect(r.systems).toEqual([{ page: 0, system: 0, state: 'read', written: [1, 2] }]);
  });

  it('refuses plainly: no such scan, no engine readings, nothing left to read', async () => {
    expect((await readIn('scn_nope00')).statusCode).toBe(404);
    expect((await readIn('scn_nope00')).json()).toEqual({ error: 'No such scan' });
    expect((await readIn('..%2F..%2Fholo.db')).statusCode).toBe(404);

    const { scan } = await scanned(songWith(track('Flute', '')), [[system(0, 2)]]);
    const none = await readIn(scan.id);
    expect(none.statusCode).toBe(409);
    expect(none.json()).toEqual({
      error: 'The engines haven’t read this scan yet: run them first',
      reason: 'no-readings',
    });

    // read only a page whose systems are all read: still nothing for the systems left
    const two = await scanned(songWith(track('Flute', '')), [
      [system(0, 2, { state: 'read', written: [1, 2] })],
      [system(0, 2)],
    ]);
    kept(two.scan, 0, 'audiveris', page([track('Flute', FOUR_BARS)]));
    expect((await readIn(two.scan.id)).statusCode).toBe(409);

    // every system read: nothing to do, readings or not
    const done = await scanned(songWith(track('Flute', '')), [[system(0, 2, { state: 'approved', written: [1, 2] })]]);
    const nothing = await readIn(done.scan.id);
    expect(nothing.statusCode).toBe(200);
    expect(nothing.json()).toMatchObject({ ops: [], label: '', systems: [] });
  });
});
