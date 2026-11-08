/**
 * Samples on this computer: a cache kept by checksum (shared by every experience and engine, since
 * the same file is the same file), filled from each library's pinned source and checked before it is
 * kept. Nothing reaches the cache, or a render, unless its sha256 is the one the engine was pinned with.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  closeSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { type ArchiveFormat, archiveExtension, archiveFormat, unpack } from './archives.ts';
import { cutNote, decodeAiff, floatWav } from './cut.ts';
import { decodeFlac, pcmWav } from './flac.ts';
import { type DecodedInput, decodeInput, type MixSource, mixArchive, mixExtension, mixFile, mixUrl } from './mix.ts';
import type { ArchiveSource, CutSource, GitSource, NeededFile, PinnedPack } from './packs.ts';

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

  /** Let a file go (a download every file made from it has been made from). */
  drop(hash: string, ext: string): void {
    rmSync(this.path(hash, ext), { force: true });
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

/**
 * A download written straight to a file as it comes (an archive of many gigabytes is never held in
 * memory), kept only if its sha256 is the one pinned. Returns where it is.
 */
async function downloadFile(url: string, path: string, hash: string, what: string, tries = 4): Promise<void> {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.part`;
  let last: unknown;
  for (let i = 0; i < tries; i++) {
    const fd = openSync(tmp, 'w');
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(3_600_000) });
      if (res.status === 404) throw Object.assign(new Error(`${url}: not found (404)`), { final: true });
      if (!res.ok || !res.body) throw new Error(`${url}: ${res.status} ${res.statusText}`);
      const h = createHash('sha256');
      for await (const chunk of res.body as AsyncIterable<Uint8Array>) {
        h.update(chunk);
        let at = 0;
        while (at < chunk.length) at += writeSync(fd, chunk, at);
      }
      closeSync(fd);
      const got = h.digest('hex');
      if (got !== hash)
        throw Object.assign(
          new Error(`${what} isn't the file the engine was pinned with (sha256 ${got}, not ${hash})`),
          {
            final: true,
          },
        );
      renameSync(tmp, path);
      return;
    } catch (err) {
      try {
        closeSync(fd);
      } catch {
        // closed already
      }
      rmSync(tmp, { force: true });
      last = err;
      if ((err as { final?: boolean }).final) break;
      await new Promise((ok) => setTimeout(ok, 1000 * 2 ** i));
    }
  }
  throw last instanceof Error ? last : new Error(String(last));
}

/** A file taken out of an archive as a pack plays it: a FLAC decoded to the WAV first made of it, a WAV as it is. */
export function archiveEntryFile(bytes: Uint8Array, software?: string): Uint8Array {
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length >= 4 && tag(0) === 'fLaC') return pcmWav(decodeFlac(bytes), software);
  if (bytes.length >= 12 && tag(0) === 'RIFF' && tag(8) === 'WAVE') return bytes;
  throw new Error('not a FLAC or WAV file');
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

/** A mix source's download, kept in the cache (by its own checksum) until every file made from it is made. */
async function mixDownload(source: MixSource, name: string, cache: SampleCache): Promise<Uint8Array> {
  const hash = source.downloads[name];
  if (!hash) throw new Error(`${name} isn't one of the pinned downloads`);
  const ext = mixExtension(name);
  if (!cache.has(hash, ext)) {
    if (mixArchive(source, name)) throw new Error(`${name} wasn't taken out of its archive`);
    cache.put(hash, ext, await download(mixUrl(source, name)), name);
  }
  return cache.read(hash, ext);
}

/** An archive, downloaded into the cache (by its own checksum) unless it's there; where it is. */
async function archiveDownload(
  url: string,
  hash: string,
  format: ArchiveFormat,
  cache: SampleCache,
  log: (line: string) => void,
): Promise<string> {
  const ext = archiveExtension(format);
  const path = cache.path(hash, ext);
  if (!cache.has(hash, ext)) {
    log(`Downloading ${url}…`);
    await downloadFile(url, path, hash, url);
  }
  return path;
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
  // a mix's downloads: how many files still to make from each (it's let go when none are left)
  const uses = new Map<string, number>();
  const useKey = (pack: PinnedPack, name: string) => `${pack.id}\0${name}`;
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
    } else if (source.kind === 'mix') {
      const recipe = source.files[f.path];
      if (!recipe) throw new Error(`${label(f)} has no recipe in its pack's mix`);
      for (const [name] of recipe.in) uses.set(useKey(f.pack, name), (uses.get(useKey(f.pack, name)) ?? 0) + 1);
      jobs.push({
        files: [f],
        run: async () => {
          const inputs = new Map<string, DecodedInput>();
          for (const [name] of recipe.in) {
            if (!inputs.has(name)) inputs.set(name, decodeInput(await mixDownload(source, name, cache)));
          }
          cache.put(f.sha256, extname(f.path), mixFile(recipe, inputs, source.bits), label(f));
          for (const name of inputs.keys()) {
            const left = (uses.get(useKey(f.pack, name)) ?? 1) - 1;
            uses.set(useKey(f.pack, name), left);
            if (left <= 0) cache.drop(source.downloads[name] as string, mixExtension(name));
          }
        },
      });
    }
  }
  for (const [pack, group] of byArchive) {
    const source = pack.source as ArchiveSource;
    jobs.push({
      files: group,
      run: async () => {
        const format = archiveFormat(source.url, source.format);
        const path = await archiveDownload(source.url, source.sha256, format, cache, log);
        const byEntry = new Map<string, NeededFile[]>();
        for (const f of group) {
          const entry = source.entries[f.path] as string;
          byEntry.set(entry, [...(byEntry.get(entry) ?? []), f]);
        }
        await unpack(path, format, new Set(byEntry.keys()), (entry, data) => {
          let made: Uint8Array;
          try {
            made = archiveEntryFile(data, source.software);
          } catch (err) {
            throw new Error(`${entry}: ${(err as Error).message}`);
          }
          for (const f of byEntry.get(entry) ?? []) cache.put(f.sha256, extname(f.path), made, label(f));
        });
        // a 7z is small and kept; a tar or zip may be gigabytes, and every file wanted is out of it
        if (format !== '7z') cache.drop(source.sha256, archiveExtension(format));
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
  await unpackMixArchives(
    rest.filter((f) => f.pack.source.kind === 'mix'),
    cache,
    log,
  );
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

/**
 * The downloads mix files are made from that are in archives: each archive fetched once and the
 * files wanted taken out of it into the cache (each checked against its own pinned sha256), so the
 * files can be made from them as from any download. The archive goes once they're out.
 */
async function unpackMixArchives(files: NeededFile[], cache: SampleCache, log: (line: string) => void): Promise<void> {
  const wanted = new Map<string, { pack: PinnedPack; archive: string; entries: Map<string, string> }>();
  for (const f of files) {
    const source = f.pack.source as MixSource;
    const recipe = source.files[f.path];
    if (!recipe) continue;
    for (const [name] of recipe.in) {
      const where = mixArchive(source, name);
      const hash = source.downloads[name];
      if (!where || !hash || cache.has(hash, mixExtension(name))) continue;
      const key = `${f.pack.id}\0${where[0]}`;
      if (!wanted.has(key)) wanted.set(key, { pack: f.pack, archive: where[0], entries: new Map() });
      wanted.get(key)?.entries.set(where[1], name);
    }
  }
  for (const { pack, archive, entries } of wanted.values()) {
    const source = pack.source as MixSource;
    const a = source.archives?.[archive];
    if (!a) continue;
    const format = archiveFormat(a.url, a.format);
    const path = await archiveDownload(a.url, a.sha256, format, cache, log);
    log(`Unpacking ${entries.size} file(s) of ${pack.name} from ${a.url.split('/').pop()}…`);
    await unpack(path, format, new Set(entries.keys()), (entry, data) => {
      const name = entries.get(entry) as string;
      cache.put(source.downloads[name] as string, mixExtension(name), data, `${pack.id}: ${name}`);
    });
    cache.drop(a.sha256, archiveExtension(format));
  }
}
