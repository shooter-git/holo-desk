/**
 * Sample packs: each is a folder in the data folder's packs/ with a holo-pack.json describing its
 * instruments (every sample's key and velocity range, true pitch, level and loop) and the sample
 * files under its root.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';

export interface Zone {
  file: string;
  root: number;
  lo: number;
  hi: number;
  lovel: number;
  hivel: number;
  gain: number;
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  rate: number;
  rr: number;
}

export interface PackInstrument {
  name: string;
  title: string;
  category: string;
  pitched?: boolean;
  release: number;
  attack: number;
  oneShot: boolean;
  velocityRange: number;
  zones: Zone[];
  size?: number;
}

export type PackSource =
  | { kind: 'git'; url: string; branch?: string; commit?: string }
  /** Notes cut out of published downloads (the recipe is in the pack's manifest). */
  | { kind: 'cut'; note?: string }
  /** Files decoded from a published archive (which one, and what's taken from it, is in the manifest). */
  | { kind: 'archive'; note?: string }
  | { kind: 'local'; note?: string }
  | { kind: 'imported'; from: string };

export interface Pack {
  id: string;
  name: string;
  license: string;
  credit: string;
  source: PackSource;
  /** Folder of the sample files, relative to the pack's folder. */
  root: string;
  instruments: PackInstrument[];
  /** Impulse responses for Space Designer (WAV: 1, 2 or 4 channels), under the root. */
  impulses?: { name: string; title?: string; file: string; seconds?: number }[];
}

interface Loaded {
  pack: Pack;
  dir: string;
  root: string;
}

export class Packs {
  private packs = new Map<string, Loaded>();

  private readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
    this.scan();
  }

  scan(): void {
    this.packs.clear();
    if (!existsSync(this.dir)) return;
    for (const entry of readdirSync(this.dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const dir = join(this.dir, entry.name);
      const file = join(dir, 'holo-pack.json');
      if (!existsSync(file)) continue;
      try {
        const pack = JSON.parse(readFileSync(file, 'utf8')) as Pack;
        const root = resolve(dir, pack.root || 'samples');
        // a pack's size on disk, per instrument, for the library to show
        for (const inst of pack.instruments) {
          let bytes = 0;
          for (const z of inst.zones) {
            try {
              bytes += statSync(join(root, z.file)).size;
            } catch {
              // a missing file shows up when it's loaded
            }
          }
          inst.size = Math.round((bytes / 1048576) * 10) / 10;
        }
        this.packs.set(pack.id, { pack, dir, root });
      } catch (err) {
        console.error(`Skipping pack ${entry.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  summaries() {
    return [...this.packs.values()].map(({ pack }) => ({
      id: pack.id,
      name: pack.name,
      license: pack.license,
      credit: pack.credit,
      source: pack.source,
      instruments: pack.instruments.map((i) => ({
        name: i.name,
        title: i.title,
        category: i.category,
        zones: i.zones.length,
        size: i.size ?? 0,
      })),
      impulses: (pack.impulses ?? []).map((i) => ({
        name: i.name,
        title: i.title ?? i.name,
        seconds: i.seconds ?? null,
      })),
    }));
  }

  /** The path of an impulse response file, only if it's inside the pack's root. */
  impulse(packId: string, name: string): string | null {
    const found = this.packs.get(packId)?.pack.impulses?.find((i) => i.name === name);
    return found ? this.file(packId, found.file) : null;
  }

  instrument(packId: string, name: string) {
    const loaded = this.packs.get(packId);
    const inst = loaded?.pack.instruments.find((i) => i.name === name);
    if (!loaded || !inst) return null;
    return { pack: packId, ...inst };
  }

  /** The path of a sample file, only if it really is inside the pack's root. */
  file(packId: string, rel: string): string | null {
    const loaded = this.packs.get(packId);
    if (!loaded) return null;
    const path = normalize(join(loaded.root, rel));
    if (!path.startsWith(loaded.root + sep)) return null;
    return existsSync(path) && statSync(path).isFile() ? path : null;
  }
}
