import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-engine-dl-'));
const dist = join(work, 'engine');
let app: Awaited<ReturnType<typeof buildApp>>['app'];

beforeAll(async () => {
  // what the image's build leaves: the downloads and the engine they carry
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'holo-engine-windows-x64.exe'), 'MZ the windows one');
  writeFileSync(join(dist, 'holo-engine-linux-x64.zip'), 'PK the linux one');
  writeFileSync(join(dist, 'engine.json'), JSON.stringify({ engine: 'e'.repeat(64), version: '0.2.1' }));
  writeFileSync(join(work, 'secret.txt'), 'not for download');
  process.env.HOLO_ENGINE_DIR = dist;
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
  delete process.env.HOLO_ENGINE_DIR;
  await app.close();
  rmSync(work, { recursive: true, force: true });
});

describe('HO[LO] Engine downloads from the host', () => {
  it('lists those it has, with the engine they carry', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/engine' });
    expect(res.json()).toEqual({
      engine: 'e'.repeat(64),
      downloads: [
        { target: 'win32-x64', file: 'holo-engine-windows-x64.exe', size: 18 },
        { target: 'linux-x64', file: 'holo-engine-linux-x64.zip', size: 16 },
      ],
    });
  });

  it('sends one as a download, and nothing that is not one', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/engine/files/holo-engine-windows-x64.exe' });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toBe('attachment; filename="holo-engine-windows-x64.exe"');
    expect(res.body).toBe('MZ the windows one');
    for (const file of ['engine.json', '..%2Fsecret.txt', 'holo-engine-macos-arm64.zip']) {
      const r = await app.inject({ method: 'GET', url: `/api/engine/files/${file}` });
      expect(r.statusCode).toBe(404);
    }
  });
});
