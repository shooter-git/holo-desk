/**
 * Which engine a song is built with. HO[LO]'s sound is its engine's code (the engine, the session
 * format and the build an experience carries) and the maps of the sample packs it plays (pinned by
 * packs.lock.json: a commit of the packs repository and every pack's hash). An engine's `source` is a
 * fingerprint of all of them and its `code` of the code alone, each the same however it is read (a
 * checkout, a commit taken out of git, the studio's Docker image). Its commit and date say where it
 * came from, so two engines can be put in order.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** The packs an engine plays: a commit of the packs repository and every pack's hash there. */
export const LOCK_FILE = 'packs.lock.json';

/** The packs a lock in a folder pins, by id (none without a lock). */
function lockedPacks(root: string): Record<string, string> {
  const file = join(root, LOCK_FILE);
  if (!existsSync(file)) return {};
  return (JSON.parse(readFileSync(file, 'utf8')) as { packs?: Record<string, string> }).packs ?? {};
}

/** The engine's code, relative to HO[LO]'s repository. */
export const CODE_PATHS = ['packages/engine/src', 'packages/session/src', 'packages/music/src'] as const;

/** What the sound depends on: the code and the packs it plays. */
export const ENGINE_PATHS = [...CODE_PATHS, LOCK_FILE] as const;

/** What it depended on before the packs had a repository of their own (their maps were in HO[LO]'s). */
export const LEGACY_ENGINE_PATHS = [...CODE_PATHS, 'packs/manifests', 'packs/checksums'] as const;

export interface EngineIdentity {
  /** The engine package's version. */
  version: string;
  /** sha256 of every file under ENGINE_PATHS (paths and contents), as hex. */
  source: string;
  /** The last HO[LO] commit that changed any of them, when known. */
  commit: string | null;
  /** That commit's date (ISO 8601), when known. */
  date: string | null;
  /** The files differ from that commit (an engine being worked on). */
  changed?: boolean;
  /** sha256 of the code alone (CODE_PATHS): absent from engines pinned before it was kept. */
  code?: string;
}

function files(path: string, rel: string, out: string[]): void {
  if (!existsSync(path)) return;
  if (statSync(path).isFile()) {
    out.push(rel);
    return;
  }
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const sub = `${rel}/${entry.name}`;
    if (entry.isDirectory()) files(join(path, entry.name), sub, out);
    else if (entry.isFile()) out.push(sub);
  }
}

/** The fingerprint of some of HO[LO]'s sources (paths relative to its repository), however they're read. */
function fingerprint(root: string, paths: readonly string[]): string {
  const list: string[] = [];
  for (const p of paths) files(join(root, p), p, list);
  list.sort();
  const h = createHash('sha256');
  for (const path of list) {
    // line endings as git keeps them, so a Windows checkout has the same engine
    const text = readFileSync(join(root, path)).toString('latin1').replace(/\r\n/g, '\n');
    h.update(`${path}\0${text.length}\0`);
    h.update(text, 'latin1');
  }
  return h.digest('hex');
}

/** The paths an engine in a folder depends on: its lock, or (an older engine) the maps it carried. */
export function enginePaths(root: string): readonly string[] {
  return existsSync(join(root, LOCK_FILE)) || !existsSync(join(root, 'packs/manifests'))
    ? ENGINE_PATHS
    : LEGACY_ENGINE_PATHS;
}

/** The fingerprint of an engine's sources in a folder laid out as HO[LO]'s repository. */
export function engineSource(root: string): string {
  return fingerprint(root, enginePaths(root));
}

/** The fingerprint of an engine's code alone: what decides how it plays the packs it pins. */
export function engineCode(root: string): string {
  return fingerprint(root, CODE_PATHS);
}

/**
 * What plays a song live, and so what HO[LO] Engine carries: the engine (its instruments, its mixer,
 * the messages it takes) and the session format. A studio and an Engine built from the same of these
 * play alike; built from different ones, the Engine may play the newest instruments wrong or not at
 * all (the studio says so).
 */
export const LIVE_PATHS = ['packages/engine/src', 'packages/session/src'] as const;

export function liveSource(root: string): string {
  return fingerprint(root, LIVE_PATHS);
}

/** The engine package's version in a folder laid out as HO[LO]'s repository. */
export function engineVersion(root: string): string {
  return (JSON.parse(readFileSync(join(root, 'packages/engine/package.json'), 'utf8')) as { version: string }).version;
}

/** Every path an engine has depended on (its lock, and the maps older ones carried), for git. */
const HISTORY_PATHS = [...new Set<string>([...ENGINE_PATHS, ...LEGACY_ENGINE_PATHS])];

/** The last commit that changed the engine at a ref, and its date, from git. */
export function engineCommit(repo: string, ref = 'HEAD'): { commit: string; date: string } | null {
  try {
    const out = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%H%n%cI', ref, '--', ...HISTORY_PATHS], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    const [commit, date] = out.split('\n');
    return commit && date ? { commit, date: new Date(date).toISOString() } : null;
  } catch {
    return null;
  }
}

/** Whether a checkout's engine files differ from its last commit. */
export function engineChanged(repo: string): boolean {
  try {
    return (
      execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', ...HISTORY_PATHS], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim() !== ''
    );
  } catch {
    return false;
  }
}

/**
 * A stamp `pnpm up` leaves for the studio's image (which has no git): the engine's commit and date,
 * kept only while its fingerprint still matches the files beside it.
 */
export const STAMP_FILE = 'packages/music/engine-stamp.json';

/** The engine a studio runs: its identity, its code's fingerprint and the packs its lock pins. */
export interface StudioEngine extends EngineIdentity {
  code: string;
  /** Each pack's id and hash (packs.lock.json); empty for an engine without a lock. */
  packs: Record<string, string>;
}

/** The engine a checkout or an image runs: from git when it has it, else from the stamp. */
export function studioEngine(root: string): StudioEngine {
  const source = engineSource(root);
  const version = engineVersion(root);
  const own = { code: engineCode(root), packs: lockedPacks(root) };
  if (existsSync(join(root, '.git'))) {
    const at = engineCommit(root);
    if (at) return { version, source, ...own, ...at, ...(engineChanged(root) ? { changed: true } : {}) };
  }
  try {
    const stamp = JSON.parse(readFileSync(join(root, STAMP_FILE), 'utf8')) as Partial<EngineIdentity>;
    if (stamp.source === source && stamp.commit && stamp.date)
      return { version, source, ...own, commit: stamp.commit, date: stamp.date };
  } catch {
    // no stamp
  }
  return { version, source, ...own, commit: null, date: null };
}

/** A short name for an engine: its version and commit ("0.1.0+4ba9e85"). */
export function engineLabel(e: Pick<EngineIdentity, 'version' | 'commit' | 'changed' | 'source'>): string {
  const at = e.commit ? e.commit.slice(0, 7) : e.source.slice(0, 7);
  return `${e.version}+${at}${e.changed ? '.changed' : ''}`;
}

/** The packs an experience's engine knows (`catalog`: every pack its lock pinned) and plays (`pinned`). */
export interface PackPins {
  catalog?: Record<string, string>;
  pinned?: string[];
}

/**
 * How an experience's pinned engine stands to the studio's: the same sound, older (the studio has
 * moved on: `holo update-engine`), newer (the studio is behind: rebuild it), or different with no
 * way to tell (an engine whose commit isn't known). The same sound is the same code playing the same
 * maps of the packs the experience plays: a pack it doesn't play, new or changed, makes no difference.
 */
export type EngineRelation = 'same' | 'older' | 'newer' | 'different';

export function engineRelation(
  pinned: EngineIdentity & PackPins,
  studio: EngineIdentity & { packs?: Record<string, string> },
): EngineRelation {
  if (pinned.source === studio.source) return 'same';
  const { catalog, pinned: plays } = pinned;
  if (pinned.code && catalog && plays && pinned.code === studio.code && studio.packs) {
    const packs = studio.packs;
    if (plays.every((id) => catalog[id] !== undefined && packs[id] === catalog[id])) return 'same';
  }
  if (!pinned.date || !studio.date) return 'different';
  const a = Date.parse(pinned.date);
  const b = Date.parse(studio.date);
  // the studio's own changes, not yet committed, come after its commit
  if (a < b || (a === b && studio.changed)) return 'older';
  if (a > b) return 'newer';
  return 'different';
}
