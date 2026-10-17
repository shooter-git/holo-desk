/**
 * Samples on this computer: a cache kept by checksum (shared by every experience and engine, since
 * the same file is the same file), filled from each library's pinned source and checked before it is
 * kept. Nothing reaches the cache, or a render, unless its sha256 is the one the engine was pinned with.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { cutNote, decodeAiff, floatWav } from './cut.ts';
import { decodeFlac, pcmWav } from './flac.ts';
import type { ArchiveSource, CutSource, GitSource, NeededFile, PinnedPack } from './packs.ts';
import { SevenZip } from './sevenzip.ts';

export const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Where samples are kept: HOLO_MUSIC_CACHE, else the system's cache folder. */
export function defaultCacheDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.HOLO_MUSIC_CACHE) return env.HOLO_MUSIC_CACHE;
  if (process.platform === 'win32' && env.LOCALAPPDATA) return join(env.LOCALAPPDATA, 'holo-music');
  if (process.platform === 'darwin') return join(homedir(), 'Library', 'Caches', 'holo-music');
  return join(env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'holo-music');
}

export class SampleCache {
  readonly dir: string;
  constructor(dir: string) {
    this.dir = dir;
  }

  path(hash: string, ext: string): string {
    return join(this.dir, 'files', hash.slice(0, 2), `${hash}${ext.toLowerCase()}`);
  }

  has(hash: string, ext: string): boolean {
    return existsSync(this.path(hash, ext));
  }

  read(hash: string, ext: string): Uint8Array {
    return new Uint8Array(readFileSync(this.path(hash, ext)));
  }

  /** Keep a file, if it is the one wanted (written whole, then moved into place). */
  put(hash: string, ext: string, bytes: Uint8Array, what: string): void {
    const got = sha256(bytes);
    if (got !== hash) throw new Error(`${what} isn't the file the engine was pinned with (sha256 ${got}, not ${hash})`);
    const path = this.path(hash, ext);
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.part`;
    writeFileSync(tmp, bytes);
    renameSync(tmp, path);
  }
}

export interface FetchOptions {
  cache: SampleCache;
  /** Folders that may already hold a pack's files (a HO[LO] data folder, a library you downloaded). */
  from?: string[];
  /** Downloads at once. */
  parallel?: number;
  log?: (line: string) => void;
}

async function download(url: string, tries = 4): Promise<Uint8Array> {
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(180_000) });
      if (res.status === 404) throw Object.assign(new Error(`${url}: not found (404)`), { final: true });
      if (!res.ok) throw new Error(`${url}: ${res.status} ${res.statusText}`);
      return new Uint8Array(await res.arrayBuffer());
    } catch (err) {
      last = err;
      if ((err as { final?: boolean }).final) break;
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** A GitHub repository's file at a commit, straight from its raw files. */
function githubRaw(source: GitSource, path: string): string | null {
  const m = /^https:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/.exec(source.url);
  return m ? `https://raw.githubusercontent.com/${m[1]}/${m[2]}/${source.commit}/${encodePath(path)}` : null;
}

/** Other git hosts: the files' folders checked out sparsely at the commit, with git. */
function gitCheckout(source: GitSource, paths: string[]): Map<string, Uint8Array> {
  const dir = mkdtempSync(join(tmpdir(), 'holo-music-git-'));
  try {
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], { stdio: ['ignore', 'ignore', 'pipe'] });
    git('init', '-q');
    git('remote', 'add', 'origin', source.url);
    git('sparse-checkout', 'set', '--no-cone', ...[...new Set(paths.map((p) => `/${dirname(p)}/`))]);
    git('fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', source.commit);
    git('checkout', '-q', 'FETCH_HEAD');
    return new Map(paths.map((p) => [p, new Uint8Array(readFileSync(join(dir, p)))]));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/** A cut source's download, kept in the cache too (by its own checksum). */
async function cutDownload(source: CutSource, name: string, cache: SampleCache): Promise<Uint8Array> {
  const hash = source.downloads[name];
  if (!hash) throw new Error(`${name} isn't one of the pinned downloads`);
  const ext = extname(name);
  if (!cache.has(hash, ext)) cache.put(hash, ext, await download(`${source.base}${encodePath(name)}`), name);
  return cache.read(hash, ext);
}

/** An archive source's download, kept in the cache too (by its own checksum). */
async function archiveDownload(source: ArchiveSource, cache: SampleCache): Promise<Uint8Array> {
  const ext = extname(new URL(source.url).pathname) || '.7z';
  if (!cache.has(source.sha256, ext)) cache.put(source.sha256, ext, await download(source.url), source.url);
  return cache.read(source.sha256, ext);
}

function fromFolders(pack: PinnedPack, path: string, folders: string[]): Uint8Array | null {
  for (const f of folders) {
    for (const candidate of [
      join(f, path),
      join(f, pack.id, pack.root || 'samples', path),
      join(f, 'packs', pack.id, pack.root || 'samples', path),
    ]) {
      if (existsSync(candidate)) return new Uint8Array(readFileSync(candidate));
    }
  }
  return null;
}

/** Bring every needed file into the cache (those already there are left as they are). */
export async function fetchFiles(files: NeededFile[], opts: FetchOptions): Promise<void> {
  const { cache } = opts;
  const log = opts.log ?? (() => undefined);
  const missing = files.filter((f) => !cache.has(f.sha256, extname(f.path)));
  if (!missing.length) return;
  const label = (f: NeededFile) => `${f.pack.id}/${f.path}`;
  // what's in a folder you named needs no download
  const rest: NeededFile[] = [];
  for (const f of missing) {
    const bytes = opts.from?.length ? fromFolders(f.pack, f.path, opts.from) : null;
    if (bytes && sha256(bytes) === f.sha256) cache.put(f.sha256, extname(f.path), bytes, label(f));
    else rest.push(f);
  }
  const local = rest.filter((f) => f.pack.source.kind === 'local');
  if (local.length) {
    const packs = [...new Set(local.map((f) => f.pack))];
    throw new Error(
      packs
        .map(
          (p) =>
            `${p.name} (${p.id}) can't be downloaded${'note' in p.source && p.source.note ? `: ${p.source.note}` : ''}. ` +
            `Point the build at a folder that has its files (--from DIR, e.g. a HO[LO] data folder's packs).`,
        )
        .join('\n'),
    );
  }
  // git hosts other than GitHub: one sparse checkout per pack
  const other = rest.filter((f) => f.pack.source.kind === 'git' && !githubRaw(f.pack.source as GitSource, f.path));
  for (const pack of new Set(other.map((f) => f.pack))) {
    const mine = other.filter((f) => f.pack === pack);
    log(`Checking out ${mine.length} file(s) of ${pack.name} with git…`);
    const got = gitCheckout(pack.source as GitSource, [...new Set(mine.map((f) => f.path))]);
    for (const f of mine) cache.put(f.sha256, extname(f.path), got.get(f.path) as Uint8Array, label(f));
  }
  // a job is one file of a git library, every note wanted from one download of a cut library, or every
  // file wanted from one archive
  const jobs: { files: NeededFile[]; run: () => Promise<void> }[] = [];
  const byDownload = new Map<string, NeededFile[]>();
  const byArchive = new Map<PinnedPack, NeededFile[]>();
  for (const f of rest) {
    if (other.includes(f)) continue;
    const source = f.pack.source;
    if (source.kind === 'git') {
      jobs.push({
        files: [f],
        run: async () =>
          cache.put(f.sha256, extname(f.path), await download(githubRaw(source, f.path) as string), label(f)),
      });
    } else if (source.kind === 'cut') {
      const cut = source.cuts[f.path];
      if (!cut) throw new Error(`${label(f)} has no cut in its pack's recipe`);
      const key = `${f.pack.id}\0${cut[0]}`;
      byDownload.set(key, [...(byDownload.get(key) ?? []), f]);
    } else if (source.kind === 'archive') {
      if (!source.entries[f.path]) throw new Error(`${label(f)} has no entry in its pack's archive`);
      byArchive.set(f.pack, [...(byArchive.get(f.pack) ?? []), f]);
    }
  }
  for (const [pack, group] of byArchive) {
    const source = pack.source as ArchiveSource;
    jobs.push({
      files: group,
      run: async () => {
        const archive = new SevenZip(await archiveDownload(source, cache));
        for (const f of group) {
          const entry = source.entries[f.path] as string;
          cache.put(f.sha256, extname(f.path), pcmWav(decodeFlac(archive.read(entry)), source.software), label(f));
        }
      },
    });
  }
  for (const group of byDownload.values()) {
    const first = group[0] as NeededFile;
    const source = first.pack.source as CutSource;
    const name = (source.cuts[first.path] as [string, number, number])[0];
    jobs.push({
      files: group,
      run: async () => {
        const decoded = decodeAiff(await cutDownload(source, name, cache));
        if (decoded.channels.length !== 1 || decoded.rate !== source.rate)
          throw new Error(`${name}: expected one channel at ${source.rate} Hz`);
        const samples = decoded.channels[0] as Float32Array;
        for (const f of group) {
          const [, start, frames] = source.cuts[f.path] as [string, number, number];
          cache.put(
            f.sha256,
            extname(f.path),
            floatWav(cutNote(samples, start, frames, source.fade), source.rate),
            label(f),
          );
        }
      },
    });
  }
  const total = jobs.reduce((n, j) => n + j.files.length, 0);
  let done = 0;
  let shown = 0;
  const parallel = Math.max(1, opts.parallel ?? 6);
  let next = 0;
  const errors: string[] = [];
  await Promise.all(
    Array.from({ length: Math.min(parallel, jobs.length) }, async () => {
      while (next < jobs.length) {
        const job = jobs[next++] as (typeof jobs)[number];
        try {
          await job.run();
        } catch (err) {
          errors.push(err instanceof Error ? err.message : String(err));
        }
        done += job.files.length;
        if (done === total || done - shown >= 25) {
          shown = done;
          log(`Samples: ${done}/${total}`);
        }
      }
    }),
  );
  if (errors.length)
    throw new Error(
      `${errors.length} sample file(s) couldn't be fetched:\n  ${errors.slice(0, 6).join('\n  ')}${errors.length > 6 ? '\n  …' : ''}`,
    );
}
