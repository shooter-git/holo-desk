import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-engine-dl-'));
const dist = join(work, 'engine');
const LOCAL = 'e'.repeat(64);
const PUBLISHED = `abcdef012345${'1'.repeat(52)}`;
const OTHER_SAME_TAG = `abcdef012345${'2'.repeat(52)}`;
let app: Awaited<ReturnType<typeof buildApp>>['app'];
const asked: string[] = [];

beforeAll(async () => {
  // a build of this checkout (pnpm engine:build --release)
  mkdirSync(dist, { recursive: true });
  writeFileSync(join(dist, 'holo-engine-windows-x64.exe'), 'MZ the windows one');
  writeFileSync(join(dist, 'engine.json'), JSON.stringify({ engine: LOCAL, version: '0.2.1' }));
  writeFileSync(join(work, 'secret.txt'), 'not for download');
  process.env.HOLO_ENGINE_DIR = dist;
  // GitHub: the pre-release CI published for one engine
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input) => {
    const url = String(input);
    asked.push(url);
    if (url === 'https://api.github.com/repos/shooter-git/holo-desk/releases/tags/engine-abcdef012345')
      return new Response(
        JSON.stringify({
          html_url: 'https://github.com/shooter-git/holo-desk/releases/tag/engine-abcdef012345',
          body: `HO[LO] Engine built from 0123abc, carrying the engine whose fingerprint is ${PUBLISHED}.`,
          assets: [
            {
              name: 'holo-engine-windows-x64.exe',
              size: 95_000_000,
              browser_download_url: 'https://example.test/w.exe',
            },
            {
              name: 'holo-engine-macos-arm64.zip',
              size: 40_000_000,
              browser_download_url: 'https://example.test/m.zip',
            },
            { name: 'notes.txt', size: 3, browser_download_url: 'https://example.test/n.txt' },
          ],
        }),
        { status: 200 },
      );
    return new Response('{"message":"Not Found"}', { status: 404 });
  });
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
  vi.restoreAllMocks();
  delete process.env.HOLO_ENGINE_DIR;
  await app.close();
  rmSync(work, { recursive: true, force: true });
});

const engine = async (fp: string) => (await app.inject({ method: 'GET', url: `/api/engine?engine=${fp}` })).json();

describe('where to get the HO[LO] Engine that carries a studio’s engine', () => {
  it("offers a build of this checkout's first, when it carries that engine", async () => {
    expect(await engine(LOCAL)).toEqual({
      engine: LOCAL,
      from: 'this checkout',
      page: null,
      downloads: [
        {
          target: 'win32-x64',
          file: 'holo-engine-windows-x64.exe',
          size: 18,
          url: '/api/engine/files/holo-engine-windows-x64.exe',
        },
      ],
    });
    const res = await app.inject({ method: 'GET', url: '/api/engine/files/holo-engine-windows-x64.exe' });
    expect(res.headers['content-disposition']).toBe('attachment; filename="holo-engine-windows-x64.exe"');
    expect(res.body).toBe('MZ the windows one');
    for (const file of ['engine.json', '..%2Fsecret.txt', 'holo-engine-linux-x64.zip']) {
      expect((await app.inject({ method: 'GET', url: `/api/engine/files/${file}` })).statusCode).toBe(404);
    }
  });

  it("links to CI's pre-release for that engine on GitHub, and asks GitHub once in a while", async () => {
    const want = {
      engine: PUBLISHED,
      from: 'github',
      page: 'https://github.com/shooter-git/holo-desk/releases/tag/engine-abcdef012345',
      downloads: [
        {
          target: 'win32-x64',
          file: 'holo-engine-windows-x64.exe',
          size: 95_000_000,
          url: 'https://example.test/w.exe',
        },
        {
          target: 'darwin-arm64',
          file: 'holo-engine-macos-arm64.zip',
          size: 40_000_000,
          url: 'https://example.test/m.zip',
        },
      ],
    };
    expect(await engine(PUBLISHED)).toEqual(want);
    const before = asked.length;
    expect(await engine(PUBLISHED)).toEqual(want);
    expect(asked.length).toBe(before);
  });

  it('offers nothing for an engine with no build, or one whose name is only alike', async () => {
    expect(await engine('0'.repeat(64))).toEqual({ engine: '0'.repeat(64), from: null, page: null, downloads: [] });
    expect((await engine(OTHER_SAME_TAG)).downloads).toEqual([]);
    expect((await app.inject({ method: 'GET', url: '/api/engine?engine=nope' })).statusCode).toBe(400);
  });
});
