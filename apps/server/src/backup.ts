/**
 * A copy of the songs' database, made before a new version of HO[LO] starts (tools/update.mjs asks
 * for it): `backups/holo-<version>-<time>.db` in the data folder, the last few kept. It's made by
 * SQLite's own online backup, from the open database, so it's whole whatever is being saved meanwhile.
 * A copy is only ever put back by hand: stop HO[LO], put the file in the data folder as `holo.db`
 * (with no `holo.db-wal` or `holo.db-shm` beside it), start HO[LO].
 */
import { chmodSync, mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { Store } from './db.ts';

/** How many copies are kept: the newest. */
export const KEEP_BACKUPS = 3;

/** Room left over once the copy is made, at least: the database goes on growing as it's used. */
const SPARE_BYTES = 64 * 1024 * 1024;

/**
 * A copy made here or by the updater: `holo-<what>-<UTC time>.db`. Only these are ever let go: another
 * file someone keeps in the folder (a copy of their own, whatever it's called) is left alone.
 */
const NAME = /^holo-[\w.+-]+-\d{8}T\d{6}Z\.db$/;

export type Backup =
  | { ok: true; file: string; size: number }
  /** The data folder's disk hasn't room for it: nothing was written. */
  | { ok: false; need: number; free: number };

const size = (file: string): number => {
  try {
    return statSync(file).size;
  } catch {
    return 0;
  }
};

/** A version as part of a file's name: what a name can't hold becomes `-`. */
const named = (version: string) => version.replace(/[^\w.+-]/g, '-').slice(0, 40) || 'unknown';

/** When a copy was made, as its name says (`…-20310506T070809Z.db`). */
const stampOf = (file: string) => /-(\d{8}T\d{6}Z)\.db$/.exec(file)?.[1] ?? '';

/** The copies in a data folder, newest first (by the time in their names: a file's own date can be anything). */
export function backups(dataDir: string): string[] {
  try {
    return readdirSync(join(dataDir, 'backups'))
      .filter((f) => NAME.test(f))
      .sort((a, b) => (stampOf(a) === stampOf(b) ? (a < b ? 1 : -1) : stampOf(a) < stampOf(b) ? 1 : -1));
  } catch {
    return [];
  }
}

export interface BackupOptions {
  /** The bytes free where the data folder is (the disk's own figure otherwise). */
  free?: (dir: string) => number;
  now?: () => Date;
}

/**
 * Copy the database into the data folder's `backups`, then let go of all but the newest few. Refused,
 * with nothing written, when the disk hasn't room for the copy and something to spare.
 */
export async function backupDatabase(
  store: Store,
  dataDir: string,
  version: string,
  o: BackupOptions = {},
): Promise<Backup> {
  const db = join(dataDir, 'holo.db');
  // (what's in the write-ahead log goes into the copy too)
  const need = size(db) + size(`${db}-wal`) + SPARE_BYTES;
  const free = (o.free ?? ((dir) => Number(statfsSync(dir).bavail) * Number(statfsSync(dir).bsize)))(dataDir);
  if (free < need) return { ok: false, need, free };
  const dir = join(dataDir, 'backups');
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stamp = (o.now?.() ?? new Date())
    .toISOString()
    .replace(/[-:]/g, '')
    .replace(/\.\d+Z$/, 'Z');
  const name = `holo-${named(version)}-${stamp}.db`;
  // under another name until it's whole: a copy cut short is never taken for one
  const part = join(dir, `${name}.part`);
  // (and what a copy cut short before left: one is made at a time, so none of these is being written)
  for (const f of readdirSync(dir)) if (/^holo-.*\.db\.part$/.test(f)) rmSync(join(dir, f), { force: true });
  try {
    await store.backup(part);
    chmodSync(part, 0o600);
    renameSync(part, join(dir, name));
  } catch (err) {
    rmSync(part, { force: true });
    throw err;
  }
  // (the one just made stays, whatever the clock said when the others were)
  for (const old of backups(dataDir).slice(KEEP_BACKUPS)) {
    if (old === name) continue;
    // (with what SQLite leaves beside a copy someone opened)
    for (const end of ['', '-wal', '-shm']) rmSync(join(dir, `${old}${end}`), { force: true });
  }
  return { ok: true, file: join('backups', name), size: size(join(dir, name)) };
}
