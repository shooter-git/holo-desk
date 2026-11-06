/**
 * The sample packs HO[LO] plays, pinned: `packs.lock.json` names one commit of the packs repository
 * (github.com/shooter-git/holo-packs, a folder a pack: its map and every file's checksum) and every
 * pack's hash at that commit. A pack's map is fetched from that commit when first needed, kept only if
 * its hash is the one the lock names, and kept by that hash (so it is fetched once, whoever needs it).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sha256 } from './fetch.ts';
import { LOCK_FILE } from './identity.ts';
import { type PackManifest, type PinnedPack, parseChecksums, pinPack } from './packs.ts';

/** The packs repository at one commit, and every pack's hash there. */
export interface PackLock {
  format: 'holo-packs-lock';
  version: 1;
  /** "owner/name" on GitHub. */
  repo: string;
  /** The commit (40 hex). */
  commit: string;
  /** Each pack's id and `packSha256`. */
  packs: Record<string, string>;
}

/** A pack's hash: the sha256 of its line in an experience's packs.json (its maps and checksums). */
export function packSha256(pack: PinnedPack): string {
  return sha256(Buffer.from(JSON.stringify(pack)));
}

export function parseLock(text: string): PackLock {
  const lock = JSON.parse(text) as PackLock;
  if (lock.format !== 'holo-packs-lock' || lock.version !== 1) throw new Error(`Not a ${LOCK_FILE}`);
  if (!/^[\w.-]+\/[\w.-]+$/.test(lock.repo)) throw new Error(`${LOCK_FILE}: "${lock.repo}" isn't owner/name`);
  if (!/^[0-9a-f]{40}$/.test(lock.commit)) throw new Error(`${LOCK_FILE}: "${lock.commit}" isn't a commit`);
  for (const [id, hash] of Object.entries(lock.packs ?? {}))
    if (!/^[a-z0-9][a-z0-9_-]*$/.test(id) || !/^[0-9a-f]{64}$/.test(hash))
      throw new Error(`${LOCK_FILE}: "${id}" isn't a pack id with its sha256`);
  return lock;
}

/** The lock as it is written: one pack to a line, by id. */
export function formatLock(lock: PackLock): string {
  const ids = Object.keys(lock.packs).sort();
  const packs = ids.map((id) => `    ${JSON.stringify(id)}: ${JSON.stringify(lock.packs[id])}`).join(',\n');
  return (
    `{\n  "format": "holo-packs-lock",\n  "version": 1,\n  "repo": ${JSON.stringify(lock.repo)},\n` +
    `  "commit": ${JSON.stringify(lock.commit)},\n  "packs": {\n${packs}\n  }\n}\n`
  );
}

/** The lock in a folder laid out as HO[LO]'s repository (null when it has none: an older engine). */
export function readLock(root: string): PackLock | null {
  const file = join(root, LOCK_FILE);
  return existsSync(file) ? parseLock(readFileSync(file, 'utf8')) : null;
}

/** Where a pack's files are at the locked commit. */
export function packUrl(
  lock: Pick<PackLock, 'repo' | 'commit'>,
  id: string,
  file: 'pack.json' | 'files.sha256',
): string {
  return `https://raw.githubusercontent.com/${lock.repo}/${lock.commit}/packs/${id}/${file}`;
}

/** Where the fetched maps are kept: in HO[LO]'s data folder (HOLO_DATA_DIR, as the server reads it). */
export function mapsDir(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolve(repo, env.HOLO_DATA_DIR ?? './data'), 'pack-maps');
}

/** A pinned pack as the map it was made from (as packs/<id>/pack.json has it). */
export function manifestOf(pack: PinnedPack): PackManifest {
  const { files: _files, ...rest } = pack;
  return { format: 'holo-pack', version: 1, ...rest };
}

/** A pack's map and checksums made into its pinned entry. */
export function pinFiles(id: string, mapText: string, sumsText: string): PinnedPack {
  const manifest = JSON.parse(mapText) as PackManifest;
  if (manifest.format !== 'holo-pack' || manifest.id !== id) throw new Error(`packs/${id}/pack.json isn't ${id}'s map`);
  return pinPack(manifest, parseChecksums(sumsText));
}

type Fetch = (url: string) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

const defaultFetch: Fetch = (url) =>
  fetch(url, {
    signal: AbortSignal.timeout(60_000),
    headers: url.startsWith('https://api.github.com/') ? { accept: 'application/vnd.github+json' } : {},
  });

/**
 * The lock for a commit of a packs repository on GitHub (a branch, a tag or a commit): every pack
 * there (packs/<id>/pack.json and files.sha256), fetched and hashed.
 */
export async function lockAt(repo: string, ref = 'main', fetcher: Fetch = defaultFetch): Promise<PackLock> {
  const json = async <T>(url: string): Promise<T> => {
    const res = await fetcher(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    return JSON.parse(await res.text()) as T;
  };
  const commit = /^[0-9a-f]{40}$/.test(ref)
    ? ref
    : (await json<{ sha: string }>(`https://api.github.com/repos/${repo}/commits/${encodeURIComponent(ref)}`)).sha;
  const tree = await json<{ tree: { path: string }[]; truncated?: boolean }>(
    `https://api.github.com/repos/${repo}/git/trees/${commit}?recursive=1`,
  );
  if (tree.truncated) throw new Error(`${repo}@${commit.slice(0, 7)}: GitHub listed only part of its files`);
  const ids = tree.tree
    .map((e) => /^packs\/([^/]+)\/pack\.json$/.exec(e.path)?.[1])
    .filter((id): id is string => !!id)
    .sort();
  const packs: Record<string, string> = {};
  for (const id of ids) {
    const text = async (file: 'pack.json' | 'files.sha256') => {
      const url = packUrl({ repo, commit }, id, file);
      const res = await fetcher(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return res.text();
    };
    packs[id] = packSha256(pinFiles(id, await text('pack.json'), await text('files.sha256')));
  }
  return { format: 'holo-packs-lock', version: 1, repo, commit, packs };
}

/** The maps of the packs a lock pins: from memory, the folder they're kept in, or the packs repository. */
export class PackMaps {
  readonly lock: PackLock;
  readonly dir: string | null;
  private readonly fetch: Fetch;
  private readonly memory = new Map<string, PinnedPack>();
  private readonly pending = new Map<string, Promise<PinnedPack>>();

  constructor(lock: PackLock, dir: string | null, fetcher: Fetch = defaultFetch) {
    this.lock = lock;
    this.dir = dir;
    this.fetch = fetcher;
  }

  /** Every pack the lock pins, by id. */
  ids(): string[] {
    return Object.keys(this.lock.packs).sort();
  }

  /** A pack's map if it is here already (memory or the folder), checked against the lock. */
  cached(id: string): PinnedPack | null {
    const want = this.lock.packs[id];
    if (!want) return null;
    const have = this.memory.get(id);
    if (have) return have;
    if (!this.dir) return null;
    const file = join(this.dir, `${want}.json`);
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8');
    if (sha256(Buffer.from(text)) !== want) return null;
    const pack = JSON.parse(text) as PinnedPack;
    this.memory.set(id, pack);
    return pack;
  }

  /** A pack's map: kept, else fetched from the locked commit and kept only if its hash is the lock's. */
  get(id: string): Promise<PinnedPack> {
    const want = this.lock.packs[id];
    if (!want) return Promise.reject(new Error(`"${id}" isn't one of the packs ${LOCK_FILE} pins`));
    const have = this.cached(id);
    if (have) return Promise.resolve(have);
    let job = this.pending.get(id);
    if (!job) {
      job = this.download(id, want).finally(() => this.pending.delete(id));
      this.pending.set(id, job);
    }
    return job;
  }

  /** Every pack's map (fetching those not kept yet, a few at once). */
  async all(): Promise<PinnedPack[]> {
    const ids = this.ids();
    const out: PinnedPack[] = new Array(ids.length);
    let next = 0;
    const worker = async () => {
      while (next < ids.length) {
        const at = next++;
        out[at] = await this.get(ids[at] as string);
      }
    };
    await Promise.all(Array.from({ length: Math.min(4, ids.length) }, worker));
    return out;
  }

  private async download(id: string, want: string): Promise<PinnedPack> {
    const text = async (file: 'pack.json' | 'files.sha256') => {
      const url = packUrl(this.lock, id, file);
      const res = await this.fetch(url);
      if (!res.ok) throw new Error(`${url}: ${res.status}`);
      return res.text();
    };
    const [map, sums] = await Promise.all([text('pack.json'), text('files.sha256')]);
    const pack = pinFiles(id, map, sums);
    const line = JSON.stringify(pack);
    const got = sha256(Buffer.from(line));
    if (got !== want) {
      throw new Error(
        `${id}'s map at ${this.lock.repo}@${this.lock.commit.slice(0, 7)} isn't the one ${LOCK_FILE} pins ` +
          `(sha256 ${got.slice(0, 12)}…, not ${want.slice(0, 12)}…)`,
      );
    }
    if (this.dir) {
      mkdirSync(this.dir, { recursive: true });
      const file = join(this.dir, `${want}.json`);
      writeFileSync(`${file}.part`, line);
      renameSync(`${file}.part`, file);
    }
    this.memory.set(id, pack);
    return pack;
  }
}
