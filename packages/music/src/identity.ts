/**
 * Which engine a song is built with. HO[LO]'s sound is its engine's code (the engine, the session
 * format and the build an experience carries) and the maps of the sample libraries it plays; an
 * engine's `source` is a fingerprint of all of them, the same however it is read (a checkout, a
 * commit taken out of git, the studio's Docker image). Its commit and date say where it came from,
 * so two engines can be put in order.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** What the sound depends on, relative to HO[LO]'s repository. */
export const ENGINE_PATHS = [
  'packages/engine/src',
  'packages/session/src',
  'packages/music/src',
  'packs/manifests',
  'packs/checksums',
] as const;

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
}

function files(dir: string, rel: string, out: string[]): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.')) continue;
    const path = `${rel}/${entry.name}`;
    if (entry.isDirectory()) files(join(dir, entry.name), path, out);
    else if (entry.isFile()) out.push(path);
  }
}

/** The fingerprint of an engine's sources in a folder laid out as HO[LO]'s repository. */
export function engineSource(root: string): string {
  const list: string[] = [];
  for (const p of ENGINE_PATHS) files(join(root, p), p, list);
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

/** The engine package's version in a folder laid out as HO[LO]'s repository. */
export function engineVersion(root: string): string {
  return (JSON.parse(readFileSync(join(root, 'packages/engine/package.json'), 'utf8')) as { version: string }).version;
}

/** The last commit that changed the engine at a ref, and its date, from git. */
export function engineCommit(repo: string, ref = 'HEAD'): { commit: string; date: string } | null {
  try {
    const out = execFileSync('git', ['-C', repo, 'log', '-1', '--format=%H%n%cI', ref, '--', ...ENGINE_PATHS], {
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
      execFileSync('git', ['-C', repo, 'status', '--porcelain', '--', ...ENGINE_PATHS], {
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

/** The engine a checkout or an image runs: from git when it has it, else from the stamp. */
export function studioEngine(root: string): EngineIdentity {
  const source = engineSource(root);
  const version = engineVersion(root);
  if (existsSync(join(root, '.git'))) {
    const at = engineCommit(root);
    if (at) return { version, source, ...at, ...(engineChanged(root) ? { changed: true } : {}) };
  }
  try {
    const stamp = JSON.parse(readFileSync(join(root, STAMP_FILE), 'utf8')) as Partial<EngineIdentity>;
    if (stamp.source === source && stamp.commit && stamp.date)
      return { version, source, commit: stamp.commit, date: stamp.date };
  } catch {
    // no stamp
  }
  return { version, source, commit: null, date: null };
}

/** A short name for an engine: its version and commit ("0.1.0+4ba9e85"). */
export function engineLabel(e: Pick<EngineIdentity, 'version' | 'commit' | 'changed' | 'source'>): string {
  const at = e.commit ? e.commit.slice(0, 7) : e.source.slice(0, 7);
  return `${e.version}+${at}${e.changed ? '.changed' : ''}`;
}

/**
 * How an experience's pinned engine stands to the studio's: the same sound, older (the studio has
 * moved on: `holo update-engine`), newer (the studio is behind: rebuild it), or different with no
 * way to tell (an engine whose commit isn't known).
 */
export type EngineRelation = 'same' | 'older' | 'newer' | 'different';

export function engineRelation(pinned: EngineIdentity, studio: EngineIdentity): EngineRelation {
  if (pinned.source === studio.source) return 'same';
  if (!pinned.date || !studio.date) return 'different';
  const a = Date.parse(pinned.date);
  const b = Date.parse(studio.date);
  // the studio's own changes, not yet committed, come after its commit
  if (a < b || (a === b && studio.changed)) return 'older';
  if (a > b) return 'newer';
  return 'different';
}
