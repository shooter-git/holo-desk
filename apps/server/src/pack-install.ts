/**
 * Installing the sample packs HO[LO] pins (packs.lock.json: a commit of the packs repository and
 * every pack's hash), from their pinned source (a sparse git checkout at the pinned commit, notes cut
 * from published downloads, files decoded or mixed from a published archive), or from a folder you
 * already have; each file is checked against the pack's checksums. A pack's map comes from the packs
 * repository at the locked commit, checked against the lock and kept in the data folder. The command
 * line (`pnpm packs install`) and the studio's Library both use this.
 */
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import {
  fetchFiles,
  manifestOf,
  mapsDir,
  type PackManifest,
  PackMaps,
  packPaths,
  readLock,
  SampleCache,
  sha256,
} from '@holo/music';
import { PRIVATE_PREFIX } from './pack-import.ts';
import { folderBytes, type Pack } from './packs.ts';

const run = promisify(execFile);

export type Manifest = Pack & { format: string; version: number; hlLibrary?: string };

const repo = resolve(import.meta.dirname, '../../..');

let maps: PackMaps | null | undefined;
let chosen = false;

/** The packs HO[LO] pins, their maps fetched once and kept in the data folder (null without a lock). */
export function shippedMaps(): PackMaps | null {
  if (maps === undefined) {
    const lock = readLock(repo);
    maps = lock ? new PackMaps(lock, mapsDir(repo)) : null;
  }
  return maps;
}

/** Keep the maps in this data folder (the server's), unless other maps were chosen. */
export function useDataDir(dataDir: string): void {
  if (chosen) return;
  const lock = readLock(repo);
  maps = lock ? new PackMaps(lock, join(dataDir, 'pack-maps')) : null;
}

/** Use other maps (tests: a lock and maps of their own; null for none; undefined for HO[LO]'s own). */
export function useShippedMaps(next: PackMaps | null | undefined): void {
  maps = next;
  chosen = next !== undefined;
}

/** The packs HO[LO] pins, by name (their maps fetched from the packs repository the first time). */
export async function availablePacks(): Promise<Manifest[]> {
  const m = shippedMaps();
  if (!m) return [];
  return (await m.all()).map((p) => manifestOf(p) as unknown as Manifest).sort((a, b) => a.name.localeCompare(b.name));
}

/** One of the packs HO[LO] pins, or null when it pins none by that id. */
export async function availablePack(id: string): Promise<Manifest | null> {
  const m = shippedMaps();
  if (!m?.lock.packs[id]) return null;
  return manifestOf(await m.get(id)) as unknown as Manifest;
}

export function installedPack(packsDir: string, id: string): Manifest | null {
  const p = join(packsDir, id, 'holo-pack.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Manifest) : null;
}

export function packFiles(pack: Pack): string[] {
  return packPaths(pack as unknown as PackManifest);
}

/** A pinned pack's checksums, once its map is here (null for a pack HO[LO] doesn't pin). */
export function packChecksums(id: string): Record<string, string> | null {
  return shippedMaps()?.cached(id)?.files ?? null;
}

const samplesDir = (packsDir: string, pack: Pack) => join(packsDir, pack.id, pack.root || 'samples');

/** Files that aren't the ones HO[LO] pins (an experience's build would refuse them). */
export function mismatchedFiles(packsDir: string, pack: Pack): string[] {
  const sums = packChecksums(pack.id);
  if (!sums) return [];
  const root = samplesDir(packsDir, pack);
  return packFiles(pack).filter((f) => {
    const path = join(root, f);
    return existsSync(path) && sums[f] !== undefined && sha256(readFileSync(path)) !== sums[f];
  });
}

export function presentFiles(packsDir: string, pack: Pack): number {
  const root = samplesDir(packsDir, pack);
  return packFiles(pack).filter((f) => existsSync(join(root, f))).length;
}

function place(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) return;
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}

function fromFolder(packsDir: string, pack: Manifest, from: string, log: (line: string) => void): number {
  const root = samplesDir(packsDir, pack);
  let n = 0;
  const missing: string[] = [];
  for (const f of packFiles(pack)) {
    const candidates = [join(from, f), ...(pack.hlLibrary ? [join(from, pack.hlLibrary, f)] : [])];
    const src = candidates.find((c) => existsSync(c));
    if (src) {
      place(src, join(root, f));
      n++;
    } else missing.push(f);
  }
  if (missing.length) log(`${missing.length} sample(s) not found under ${from}, e.g. ${missing[0]}`);
  return n;
}

/**
 * Files made from the downloads the pack's recipe names (notes cut from runs, FLAC decoded from an
 * archive, hits mixed from their microphones), each checked, into the pack's folder.
 */
async function fromRecipe(packsDir: string, pack: Manifest, log: (line: string) => void): Promise<void> {
  const pinned = shippedMaps()?.cached(pack.id);
  if (!pinned) throw new Error(`${pack.name} has no checksums: it isn't one of the packs HO[LO] pins`);
  // fetched beside the packs (in Docker the data folder is what's writable), then linked into place
  const cache = new SampleCache(mkdtempSync(join(packsDir, '.fetch-')));
  const root = samplesDir(packsDir, pack);
  try {
    const want = packFiles(pack).map((path) => ({ pack: pinned, path, sha256: pinned.files[path] as string }));
    await fetchFiles(want, { cache, log });
    for (const f of want) place(cache.path(f.sha256, extname(f.path)), join(root, f.path));
  } finally {
    rmSync(cache.dir, { recursive: true, force: true });
  }
}

async function fromGit(packsDir: string, pack: Manifest, log: (line: string) => void): Promise<void> {
  if (pack.source.kind !== 'git')
    throw new Error(
      `${pack.name} can't be downloaded: install it with --from (${'note' in pack.source ? pack.source.note : ''})`,
    );
  const root = samplesDir(packsDir, pack);
  const dirs = [...new Set(packFiles(pack).map((f) => dirname(f)))].map((d) => `/${d}/`);
  const git = (...args: string[]) => run('git', args, { maxBuffer: 64 * 1024 * 1024 });
  const commit = pack.source.commit;
  log('Fetching the samples with git…');
  if (commit) {
    // the commit HO[LO] pins: the files every experience's build checks against
    if (!existsSync(join(root, '.git'))) {
      mkdirSync(root, { recursive: true });
      await git('-C', root, 'init', '-q');
      await git('-C', root, 'remote', 'add', 'origin', pack.source.url);
    }
    await git('-C', root, 'sparse-checkout', 'set', '--no-cone', ...dirs);
    await git('-C', root, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit);
    await git('-C', root, 'checkout', '-q', commit);
    return;
  }
  if (!existsSync(join(root, '.git'))) {
    mkdirSync(dirname(root), { recursive: true });
    await git(
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      '--depth',
      '1',
      '--branch',
      pack.source.branch ?? 'master',
      pack.source.url,
      root,
    );
  }
  await git('-C', root, 'sparse-checkout', 'set', '--no-cone', ...dirs);
  await git('-C', root, 'checkout');
}

export interface InstallResult {
  present: number;
  total: number;
  checked: boolean;
  /** Files that aren't the ones HO[LO] pins. */
  wrong: string[];
}

/**
 * A pack of your own in the packs folder under this id (imported, or made on this computer): HO[LO]
 * never installs or refreshes a pinned pack over it.
 */
function ownPack(packsDir: string, id: string): boolean {
  const kind = installedPack(packsDir, id)?.source?.kind;
  return id.startsWith(PRIVATE_PREFIX) || kind === 'imported' || kind === 'local';
}

/** Install one of the shipped libraries (from a folder you have, else its pinned source), and write its map. */
export async function installPack(
  packsDir: string,
  id: string,
  opts: { from?: string; log?: (line: string) => void } = {},
): Promise<InstallResult> {
  const log = opts.log ?? (() => undefined);
  if (id.startsWith(PRIVATE_PREFIX)) throw new Error(`${id} is a pack of your own: there's nothing to install`);
  const m = await availablePack(id);
  if (!m) throw new Error(`No pack "${id}". Available: ${shippedMaps()?.ids().join(', ') || 'none'}`);
  if (ownPack(packsDir, m.id))
    throw new Error(
      `${m.id} here is a pack of your own (${installedPack(packsDir, m.id)?.source.kind}): HO[LO] won't install ` +
        `${m.name} over it. Remove it, or import it again (it gets a mine- id), then install.`,
    );
  mkdirSync(packsDir, { recursive: true });
  if (opts.from) log(`${fromFolder(packsDir, m, resolve(opts.from), log)} sample(s) from ${opts.from}`);
  else if (m.source.kind === 'cut' || m.source.kind === 'archive' || m.source.kind === 'mix')
    await fromRecipe(packsDir, m, log);
  else await fromGit(packsDir, m, log);
  writeFileSync(join(packsDir, m.id, 'holo-pack.json'), `${JSON.stringify(m)}\n`);
  return {
    present: presentFiles(packsDir, m),
    total: packFiles(m).length,
    checked: packChecksums(m.id) !== null,
    wrong: mismatchedFiles(packsDir, m),
  };
}

/** Uninstall a pack (shipped or imported): its folder goes, samples and all. Returns the bytes freed. */
export function removePack(packsDir: string, id: string): number {
  if (!/^[a-z0-9][a-z0-9_-]*$/i.test(id) || !installedPack(packsDir, id)) throw new Error(`No installed pack "${id}"`);
  const dir = join(packsDir, id);
  const bytes = folderBytes(dir);
  rmSync(dir, { recursive: true, force: true });
  return bytes;
}

/** Bring an installed pack's map up to date with the shipped one (no download). */
export function refreshPack(packsDir: string, m: Manifest): boolean {
  if (!installedPack(packsDir, m.id) || ownPack(packsDir, m.id)) return false;
  writeFileSync(join(packsDir, m.id, 'holo-pack.json'), `${JSON.stringify(m)}\n`);
  return true;
}

/**
 * The installed packs whose shipped map changed while their samples didn't (the same pinned source,
 * and every file the new map plays is there), brought up to date: a new HO[LO] brings its packs'
 * fixes (a kit's pad names, say) without a download. A pack whose samples changed is left as it is,
 * for a reinstall. Returns the packs' names.
 */
export async function refreshMaps(packsDir: string): Promise<string[]> {
  const done: string[] = [];
  const shipped = shippedMaps();
  if (!shipped) return done;
  for (const id of shipped.ids()) {
    // only the packs installed here: no map is fetched for one that isn't
    if (!installedPack(packsDir, id)) continue;
    const m = manifestOf(await shipped.get(id)) as unknown as Manifest;
    const have = installedPack(packsDir, m.id);
    if (!have || JSON.stringify(have) === JSON.stringify(m)) continue;
    if (JSON.stringify(have.source) !== JSON.stringify(m.source)) continue;
    if (presentFiles(packsDir, m) !== packFiles(m).length) continue;
    refreshPack(packsDir, m);
    done.push(m.name);
  }
  return done;
}

/**
 * One install at a time, for the studio: what it's doing and how far it has got, for the Library to
 * show while the samples come in.
 */
export interface InstallJob {
  id: string;
  name: string;
  state: 'running' | 'done' | 'error';
  /** The last thing it said ("Samples: 120/480"). */
  line: string;
  done: number;
  total: number;
  error?: string;
}

export class Installer {
  job: InstallJob | null = null;
  private readonly packsDir: string;
  private readonly onDone: () => void;
  constructor(packsDir: string, onDone: () => void) {
    this.packsDir = packsDir;
    this.onDone = onDone;
  }

  /** The pack being installed now, if any. */
  installing(): string | null {
    return this.job?.state === 'running' ? this.job.id : null;
  }

  async start(id: string): Promise<InstallJob> {
    if (this.job?.state === 'running') throw new Error(`${this.job.name} is installing: one pack at a time`);
    const m = await availablePack(id);
    if (!m) throw new Error(`No pack "${id}"`);
    // another may have started while the map came
    if (this.installing()) throw new Error(`${this.job?.name} is installing: one pack at a time`);
    const job: InstallJob = {
      id,
      name: m.name,
      state: 'running',
      line: 'Starting…',
      done: 0,
      total: packFiles(m).length,
    };
    this.job = job;
    void installPack(this.packsDir, id, {
      log: (line) => {
        job.line = line;
        const n = /Samples: (\d+)\/(\d+)/.exec(line);
        if (n) {
          job.done = Number(n[1]);
          job.total = Number(n[2]);
        }
      },
    })
      .then((r) => {
        if (r.wrong.length) {
          job.state = 'error';
          job.error = `${r.wrong.length} file(s) aren't the ones HO[LO] pins, e.g. ${r.wrong[0]}`;
        } else {
          job.state = 'done';
          job.done = r.present;
          job.total = r.total;
          job.line = `Ready: ${r.present}/${r.total} samples${r.checked ? ', checked' : ''}`;
        }
      })
      .catch((err: unknown) => {
        job.state = 'error';
        job.error = err instanceof Error ? err.message : String(err);
      })
      .finally(() => this.onDone());
    return job;
  }
}
