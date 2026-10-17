/**
 * Rendering on a computer rather than in a browser: the songs, packs and audio files HO[LO] keeps in
 * its data folder, read straight from disk (the server and the `holo` command use this).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import type { InstrumentManifest, RenderSource } from './render.ts';

interface PackFile {
  id: string;
  root?: string;
  instruments: Omit<InstrumentManifest, 'pack'>[];
  /** Impulse responses (Space Designer), as files under the root. */
  impulses?: { name: string; title?: string; file: string }[];
}

/** A render's source in a data folder: data/packs/<pack>/holo-pack.json and data/audio/<song>/. */
export function dataFolderSource(dataDir: string, projectId: string): RenderSource {
  const packs = new Map<string, { pack: PackFile; root: string }>();
  const packsDir = join(dataDir, 'packs');
  if (existsSync(packsDir)) {
    for (const entry of readdirSync(packsDir, { withFileTypes: true })) {
      const file = join(packsDir, entry.name, 'holo-pack.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const pack = JSON.parse(readFileSync(file, 'utf8')) as PackFile;
      packs.set(pack.id, { pack, root: resolve(packsDir, entry.name, pack.root || 'samples') });
    }
  }
  const inside = (root: string, rel: string) => {
    const path = normalize(join(root, rel));
    if (!path.startsWith(root + sep)) throw new Error(`${rel} is outside its folder`);
    return path;
  };
  const audioDir = join(dataDir, 'audio', projectId.replace(/[^\w-]/g, ''));
  return {
    async instrument(pack, name) {
      const found = packs.get(pack)?.pack.instruments.find((i) => i.name === name);
      if (!found) throw new Error(`No instrument ${pack}/${name} in ${packsDir}`);
      return { ...found, pack };
    },
    async sample(pack, file) {
      const p = packs.get(pack);
      if (!p) throw new Error(`No pack ${pack}`);
      return new Uint8Array(readFileSync(inside(p.root, file)));
    },
    async impulse(pack, name) {
      const p = packs.get(pack);
      const found = p?.pack.impulses?.find((i) => i.name === name);
      if (!p || !found) throw new Error(`No impulse response ${pack}/${name}`);
      return new Uint8Array(readFileSync(inside(p.root, found.file)));
    },
    async audio(file) {
      if (!/^aud_[a-z0-9]+$/.test(file)) throw new Error(`No audio file ${file}`);
      const found = existsSync(audioDir) ? readdirSync(audioDir).find((f) => f.startsWith(`${file}.`)) : undefined;
      if (!found) throw new Error(`No audio file ${file} for this song`);
      return new Uint8Array(readFileSync(join(audioDir, found)));
    },
  };
}
