import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Scan } from '@holo/score';
import { newProject } from '@holo/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-scan-test-'));
let app: Awaited<ReturnType<typeof buildApp>>['app'];
let project = '';

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
  const res = await app.inject({ method: 'POST', url: '/api/projects', payload: newProject('Scanned') as object });
  project = (res.json() as { id: string }).id;
}, 30_000);
afterAll(async () => {
  await app.close();
  rmSync(work, { recursive: true, force: true });
});

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

describe('scans', () => {
  it('keeps a scan: its record, its pages and strips, and each system’s progress', async () => {
    const made = await app.inject({ method: 'POST', url: '/api/scans', payload: { project, title: 'Hymn' } });
    expect(made.statusCode).toBe(201);
    const scan = made.json() as Scan;
    expect(scan.id).toMatch(/^scn_/);

    const page = await app.inject({
      method: 'PUT',
      url: `/api/scans/${scan.id}/pages/0`,
      headers: { 'content-type': 'image/png' },
      payload: png,
    });
    expect(page.statusCode).toBe(200);
    await app.inject({
      method: 'PUT',
      url: `/api/scans/${scan.id}/strips/0/0`,
      headers: { 'content-type': 'image/png' },
      payload: png,
    });

    const record = {
      ...scan,
      pages: [
        {
          w: 1200,
          h: 1600,
          type: 'png',
          systems: [{ top: 80, bottom: 400, left: 100, right: 1100, staves: 2, bars: [100, 400, 700, 1100] }],
        },
      ],
    };
    const put = await app.inject({ method: 'PUT', url: `/api/scans/${scan.id}`, payload: record });
    expect(put.statusCode).toBe(200);
    const patched = await app.inject({
      method: 'PATCH',
      url: `/api/scans/${scan.id}/systems/0/0`,
      payload: { state: 'read', written: [1, 3] },
    });
    expect(patched.json()).toMatchObject({ state: 'read', written: [1, 3], staves: 2 });

    const strip = await app.inject({ method: 'GET', url: `/api/scans/${scan.id}/strips/0/0` });
    expect(strip.headers['content-type']).toBe('image/png');
    expect(strip.rawPayload.equals(png)).toBe(true);

    const list = await app.inject({ method: 'GET', url: `/api/scans?project=${project}` });
    expect(list.json()).toMatchObject([{ id: scan.id, title: 'Hymn', progress: { read: 1, new: 0 } }]);
  });

  it('refuses what isn’t a scan or an image, and keeps paths inside the scan', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/scans', payload: { project: 'prj_nope' } })).statusCode).toBe(
      404,
    );
    expect((await app.inject({ method: 'GET', url: '/api/scans/..%2F..%2Fholo.db' })).statusCode).toBe(404);
    const scan = (await app.inject({ method: 'POST', url: '/api/scans', payload: { project } })).json() as Scan;
    const bad = await app.inject({
      method: 'PUT',
      url: `/api/scans/${scan.id}/pages/..%2F1`,
      headers: { 'content-type': 'image/png' },
      payload: png,
    });
    expect(bad.statusCode).toBe(400);
    const text = await app.inject({
      method: 'PUT',
      url: `/api/scans/${scan.id}/pages/1`,
      headers: { 'content-type': 'text/plain' },
      payload: 'hello',
    });
    expect(text.statusCode).toBeGreaterThanOrEqual(400);
  });

  it('goes when its song does', async () => {
    const scan = (await app.inject({ method: 'POST', url: '/api/scans', payload: { project } })).json() as Scan;
    expect(existsSync(join(work, 'data', 'scans', scan.id))).toBe(true);
    await app.inject({ method: 'DELETE', url: `/api/projects/${project}` });
    expect(existsSync(join(work, 'data', 'scans', scan.id))).toBe(false);
  });
});
