/**
 * Installing the sample libraries HO[LO] ships maps for (packs/manifests): from their pinned source
 * (a sparse git checkout at the pinned commit, notes cut from published downloads, files decoded or
 * mixed from a published archive), or from a folder you already have; each file is checked against
 * packs/checksums. The command line (`pnpm packs install`) and the studio's Library both use this.
 */
import { execFile } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { promisify } from 'node:util';
import { fetchFiles, type PackManifest, packPaths, parseChecksums, pinPack, SampleCache, sha256 } from '@holo/music';
import type { Pack } from './packs.ts';

const run = promisify(execFile);

export type Manifest = Pack & { format: string; version: number; hlLibrary?: string };

const repo = resolve(import.meta.dirname, '../../..');
export const MANIFESTS_DIR = join(repo, 'packs/manifests');
export const CHECKSUMS_DIR = join(repo, 'packs/checksums');

/** The libraries HO[LO] ships maps for. */
export function availablePacks(): Manifest[] {
  if (!existsSync(MANIFESTS_DIR)) return [];
  return readdirSync(MANIFESTS_DIR)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(MANIFESTS_DIR, f), 'utf8')) as Manifest)
    .sort((a, b) => a.name.localeCompare(b.name));
}

export function installedPack(packsDir: string, id: string): Manifest | null {
  const p = join(packsDir, id, 'holo-pack.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Manifest) : null;
}

export function packFiles(pack: Pack): string[] {
  return packPaths(pack as unknown as PackManifest);
}

export function packChecksums(id: string): Record<string, string> | null {
  const file = join(CHECKSUMS_DIR, `${id}.sha256`);
  return existsSync(file) ? parseChecksums(readFileSync(file, 'utf8')) : null;
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
  const sums = packChecksums(pack.id);
  if (!sums) throw new Error(`${pack.name} has no checksums (packs/checksums/${pack.id}.sha256)`);
  const pinned = pinPack(pack as unknown as PackManifest, sums);
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

/** Install one of the shipped libraries (from a folder you have, else its pinned source), and write its map. */
export async function installPack(
  packsDir: string,
  id: string,
  opts: { from?: string; log?: (line: string) => void } = {},
): Promise<InstallResult> {
  const log = opts.log ?? (() => undefined);
  const m = availablePacks().find((x) => x.id === id);
  if (!m)
    throw new Error(
      `No pack "${id}". Available: ${availablePacks()
        .map((x) => x.id)
        .join(', ')}`,
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

export function removePack(packsDir: string, id: string): void {
  if (!installedPack(packsDir, id)) throw new Error(`No installed pack "${id}"`);
  rmSync(join(packsDir, id), { recursive: true, force: true });
}

/** Bring an installed pack's map up to date with the shipped one (no download). */
export function refreshPack(packsDir: string, m: Manifest): boolean {
  if (!installedPack(packsDir, m.id)) return false;
  writeFileSync(join(packsDir, m.id, 'holo-pack.json'), `${JSON.stringify(m)}\n`);
  return true;
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

  start(id: string): InstallJob {
    if (this.job?.state === 'running') throw new Error(`${this.job.name} is installing: one pack at a time`);
    const m = availablePacks().find((x) => x.id === id);
    if (!m) throw new Error(`No pack "${id}"`);
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
