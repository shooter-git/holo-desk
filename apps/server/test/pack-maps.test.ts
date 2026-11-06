import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { availablePacks, installedPack, packFiles, refreshMaps } from '../src/pack-install.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-pack-maps-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** Install a shipped pack's samples (empty files will do) under an older map of it. */
function install(dir: string, id: string, older: (m: ReturnType<typeof availablePacks>[number]) => void, files = true) {
  const m = structuredClone(availablePacks().find((p) => p.id === id));
  if (!m) throw new Error(`no shipped ${id}`);
  if (files)
    for (const f of packFiles(m)) {
      const path = join(dir, id, m.root || 'samples', f);
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, '');
    }
  older(m);
  mkdirSync(join(dir, id), { recursive: true });
  writeFileSync(join(dir, id, 'holo-pack.json'), `${JSON.stringify(m)}\n`);
  return readFileSync(join(dir, id, 'holo-pack.json'), 'utf8');
}

describe("an installed pack's map, when HO[LO] ships a newer one", () => {
  it('is brought up to date when its samples are the same, and left alone when they are not', () => {
    const dir = join(work, 'packs');
    // the Rock Kit as installed before its pads had names
    install(dir, 'rock-kit', (m) => {
      for (const i of m.instruments) delete (i as { pads?: unknown }).pads;
    });
    // the Jazz Kit from another recipe (its samples aren't the ones the new map plays)
    const jazz = install(dir, 'jazz-kit', (m) => {
      for (const i of m.instruments) delete (i as { pads?: unknown }).pads;
      m.source = { kind: 'mix', note: 'an older mix' };
    });
    // the Prog Kit with its samples missing
    const prog = install(
      dir,
      'prog-kit',
      (m) => {
        for (const i of m.instruments) delete (i as { pads?: unknown }).pads;
      },
      false,
    );

    expect(refreshMaps(dir)).toEqual([availablePacks().find((p) => p.id === 'rock-kit')?.name]);
    expect(installedPack(dir, 'rock-kit')).toEqual(availablePacks().find((p) => p.id === 'rock-kit'));
    expect(installedPack(dir, 'rock-kit')?.instruments[0]?.pads?.length).toBeGreaterThan(16);
    expect(readFileSync(join(dir, 'jazz-kit', 'holo-pack.json'), 'utf8')).toBe(jazz);
    expect(readFileSync(join(dir, 'prog-kit', 'holo-pack.json'), 'utf8')).toBe(prog);
    // and once current, nothing more to do
    expect(refreshMaps(dir)).toEqual([]);
  });
});
