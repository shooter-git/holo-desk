import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { notate, toMusicXml } from '@holo/score';
import { newProject, newRegion, PPQ, type Project, parseNotation } from '@holo/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-score-test-'));
let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeAll(async () => {
  ({ app } = await buildApp({
    port: 0,
    host: '127.0.0.1',
    dataDir: join(work, 'data'),
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

describe('scores in and out', () => {
  it('imports MusicXML as a new song, and exports a song as MusicXML', async () => {
    const p = newProject('Air');
    const r = newRegion(0, PPQ * 4);
    r.notes = parseNotation('D5:2 E5:2 F#5:4', { unit: PPQ / 2 });
    const t = p.tracks[0];
    if (t) {
      t.name = 'Flute';
      t.regions = [r];
    }
    p.key = 'D major';
    const xml = toMusicXml(notate(p));
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/score?title=Air',
      headers: { 'content-type': 'application/vnd.recordare.musicxml+xml' },
      payload: xml,
    });
    expect(res.statusCode).toBe(201);
    const made = res.json() as Project;
    expect(made.title).toBe('Air');
    expect(made.key).toBe('D major');
    expect(made.tracks[0]?.regions[0]?.notes.map((n) => n.p)).toEqual([74, 76, 78]);
    const out = await app.inject({ method: 'GET', url: `/api/projects/${made.id}/musicxml` });
    expect(out.headers['content-type']).toContain('musicxml');
    expect(out.body).toContain('<work-title>Air</work-title>');
  });

  it('says what it can’t read', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/import/score',
      headers: { 'content-type': 'application/xml' },
      payload: '<html><body>not a score</body></html>',
    });
    expect(res.statusCode).toBe(400);
  });
});
