import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { formatChecksums, type PackLock, type PackManifest, PackMaps, packSha256, pinPack, sha256 } from '@holo/music';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config.ts';
import {
  availablePacks,
  installedPack,
  packFiles,
  refreshMaps,
  removePack,
  useShippedMaps,
} from '../src/pack-install.ts';
import { folderBytes } from '../src/packs.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-pack-maps-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
afterEach(() => useShippedMaps(undefined));

/** A small kit's map, as the packs repository has it. */
function kit(id: string, name: string): PackManifest {
  const zone = (file: string, key: number) => ({
    file,
    root: key,
    lo: key,
    hi: key,
    lovel: 1,
    hivel: 127,
    gain: 0,
    start: 0,
    end: 100,
    loopStart: 0,
    loopEnd: 0,
    rate: 48000,
  });
  return {
    format: 'holo-pack',
    version: 1,
    id,
    name,
    license: 'CC0-1.0',
    credit: `${name}, for the tests`,
    source: { kind: 'mix', note: 'made for the tests' } as unknown as PackManifest['source'],
    root: 'samples',
    instruments: [
      {
        name: 'kit',
        title: name,
        category: 'Drums',
        pitched: false,
        zones: [zone('kick/kick_v1.wav', 36), zone('snare/snare_v1.wav', 38)],
        pads: [
          { key: 36, name: 'Kick' },
          { key: 38, name: 'Snare' },
        ],
      } as unknown as PackManifest['instruments'][number],
    ],
  };
}

/** The packs repository at one commit (its files by path), and a lock of it. */
function repository(manifests: PackManifest[]) {
  const files = new Map<string, string>();
  const packs: Record<string, string> = {};
  for (const m of manifests) {
    const sums = Object.fromEntries(packFiles(m as never).map((f) => [f, sha256(Buffer.from(''))]));
    files.set(`packs/${m.id}/pack.json`, `${JSON.stringify(m, null, 1)}\n`);
    files.set(`packs/${m.id}/files.sha256`, formatChecksums(sums));
    packs[m.id] = packSha256(pinPack(m, sums));
  }
  const lock: PackLock = { format: 'holo-packs-lock', version: 1, repo: 'test/packs', commit: 'c'.repeat(40), packs };
  const asked: string[] = [];
  const fetch = async (url: string) => {
    asked.push(url);
    const path = url.replace(`https://raw.githubusercontent.com/test/packs/${'c'.repeat(40)}/`, '');
    const text = files.get(path);
    return { ok: text !== undefined, status: text === undefined ? 404 : 200, text: async () => text ?? '' };
  };
  return { files, lock, fetch, asked };
}

/** Install a pinned pack's samples (empty files will do) under an older map of it. */
function install(dir: string, m: PackManifest, older: (m: PackManifest) => void, files = true) {
  const copy = structuredClone(m);
  if (files)
    for (const f of packFiles(copy as never)) {
      const path = join(dir, copy.id, copy.root || 'samples', f);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
    }
  older(copy);
  mkdirSync(join(dir, copy.id), { recursive: true });
  writeFileSync(join(dir, copy.id, 'holo-pack.json'), `${JSON.stringify(copy)}\n`);
  return readFileSync(join(dir, copy.id, 'holo-pack.json'), 'utf8');
}

describe('the packs HO[LO] pins', () => {
  it('come from the packs repository at the locked commit, each kept only if it is the map the lock names', async () => {
    const rock = kit('rock-kit', 'Rock Kit');
    const repo = repository([rock, kit('jazz-kit', 'Jazz Kit')]);
    const dir = join(work, 'maps');
    useShippedMaps(new PackMaps(repo.lock, dir, repo.fetch));
    expect((await availablePacks()).map((p) => p.name)).toEqual(['Jazz Kit', 'Rock Kit']);
    // the map as the packs repository has it, exactly
    expect((await availablePacks()).find((p) => p.id === 'rock-kit')).toEqual(rock);
    expect(repo.asked).toHaveLength(4);

    // kept by its hash: a second studio (or the CLI) needs no network
    const again = new PackMaps(repo.lock, dir, async () => {
      throw new Error('offline');
    });
    expect((await again.all()).map((p) => p.id)).toEqual(['jazz-kit', 'rock-kit']);

    // a map that isn't the locked one is refused
    repo.files.set('packs/rock-kit/pack.json', JSON.stringify({ ...rock, name: 'Changed' }));
    const fresh = new PackMaps(repo.lock, null, repo.fetch);
    await expect(fresh.get('rock-kit')).rejects.toThrow(/isn't the one packs.lock.json pins/);
    await expect(fresh.get('nope')).rejects.toThrow(/isn't one of the packs/);
  });
});

describe("an installed pack's map, when HO[LO] pins a newer one", () => {
  it('is brought up to date when its samples are the same, and left alone when they are not', async () => {
    const [rock, jazz, prog] = [kit('rock-kit', 'Rock Kit'), kit('jazz-kit', 'Jazz Kit'), kit('prog-kit', 'Prog Kit')];
    const repo = repository([rock, jazz, prog]);
    useShippedMaps(new PackMaps(repo.lock, null, repo.fetch));
    const dir = join(work, 'packs');
    const unnamed = (m: PackManifest) => {
      for (const i of m.instruments) delete (i as { pads?: unknown }).pads;
    };
    // the Rock Kit as installed before its pads had names
    install(dir, rock, unnamed);
    // the Jazz Kit from another recipe (its samples aren't the ones the new map plays)
    const jazzText = install(dir, jazz, (m) => {
      unnamed(m);
      m.source = { kind: 'mix', note: 'an older mix' } as unknown as PackManifest['source'];
    });
    // the Prog Kit with its samples missing
    const progText = install(dir, prog, unnamed, false);

    expect(await refreshMaps(dir)).toEqual(['Rock Kit']);
    expect(installedPack(dir, 'rock-kit')).toEqual(rock);
    expect(readFileSync(join(dir, 'jazz-kit', 'holo-pack.json'), 'utf8')).toBe(jazzText);
    expect(readFileSync(join(dir, 'prog-kit', 'holo-pack.json'), 'utf8')).toBe(progText);
    // and once current, nothing more to do
    expect(await refreshMaps(dir)).toEqual([]);
  });
});

describe('removing a pack', () => {
  it('frees its folder, and says how much', () => {
    const dir = join(work, 'remove');
    install(dir, kit('rock-kit', 'Rock Kit'), () => undefined);
    writeFileSync(join(dir, 'rock-kit', 'samples', 'kick', 'kick_v1.wav'), Buffer.alloc(1000));
    const size = folderBytes(join(dir, 'rock-kit'));
    expect(size).toBeGreaterThanOrEqual(1000);
    expect(removePack(dir, 'rock-kit')).toBe(size);
    expect(installedPack(dir, 'rock-kit')).toBeNull();
    expect(() => removePack(dir, 'rock-kit')).toThrow(/No installed pack/);
    expect(() => removePack(dir, '../etc')).toThrow(/No installed pack/);
  });
});

describe("the studio's own lock", () => {
  it('names a commit of the packs repository and every pack by its hash', () => {
    const lock = JSON.parse(readFileSync(join(loadConfig().repoDir, 'packs.lock.json'), 'utf8')) as PackLock;
    expect(lock.repo).toBe('shooter-git/holo-packs');
    expect(lock.commit).toMatch(/^[0-9a-f]{40}$/);
    expect(Object.keys(lock.packs).length).toBeGreaterThan(0);
    for (const hash of Object.values(lock.packs)) expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});
