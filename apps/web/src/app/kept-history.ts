/**
 * The open song's undo history, kept on this device: a reload, or the song opened again later, brings
 * its Undo and Redo back, the agent's steps (and their job) among them.
 *
 * A history is kept with the revision it leads up to, and only while the song is saved, so the song
 * as it is then is that revision. It comes back only when the song opens at that same revision: saved
 * since somewhere else (another device, a creation, a scan read on the host), its steps would undo to
 * songs that no longer line up with it, and the history starts afresh, as it always did. So it does
 * when HO[LO] was updated with other code for songs (the session and engine's fingerprint): its steps
 * hold songs as the code before wrote them.
 *
 * Every step holds a whole song, but an edit makes a new song that shares each part it didn't change
 * with the one before, and the browser's database stores a part that's shared once (the history goes
 * in as one value), so a long history costs about one song and what each of its steps changed (a
 * few hundred bytes for most).
 */
import type { Project } from '@holo/session';
import type { History } from './history.ts';
import type { SaveState, Step } from './store.ts';

/** How many songs' histories a device keeps: past that, the one kept longest ago goes. */
export const KEEP_SONGS = 20;

/** A song's undo history as it's kept. */
export interface Kept {
  /** The song's id. */
  project: string;
  /** The saved revision the history leads up to: the song as it was when the history was kept. */
  revision: number;
  undo: Step[];
  redo: Step[];
  /** When it was kept (ms since the epoch). */
  kept: number;
  /** The code that made its songs: the session and engine's fingerprint. */
  made: string;
}

/** Where histories are kept: the browser's database (or, in a test, a map). */
export interface Shelf {
  get(project: string): Promise<Kept | undefined>;
  put(kept: Kept): Promise<void>;
  delete(project: string): Promise<void>;
  /** Each kept history's song, and when it was kept. */
  list(): Promise<{ project: string; kept: number }[]>;
}

/** What of the studio's state a history is kept from. */
export interface Keepable {
  project: Project | null;
  serverRevision: number;
  saveState: SaveState;
  undo: Step[];
  redo: Step[];
}

/**
 * The history to keep, or null: there's none, or the song isn't saved as it is (its history would lead
 * to a song the host doesn't have).
 */
export function toKeep(s: Keepable, made: string, now = Date.now()): Kept | null {
  if (!s.project || s.saveState !== 'saved') return null;
  if (!s.undo.length && !s.redo.length) return null;
  return { project: s.project.id, revision: s.serverRevision, undo: s.undo, redo: s.redo, kept: now, made };
}

/** The kept history, if it's this song's at the revision it opened at, made by the same code. */
export function restorable(kept: Kept | undefined, project: Project, made: string): History | null {
  if (!kept || kept.project !== project.id || kept.revision !== project.revision || kept.made !== made) return null;
  if (!Array.isArray(kept.undo) || !Array.isArray(kept.redo)) return null;
  return { undo: kept.undo, redo: kept.redo };
}

/** The songs whose histories go, so that at most `max` are kept: those kept longest ago. */
export function overflow(list: readonly { project: string; kept: number }[], max = KEEP_SONGS): string[] {
  return [...list]
    .sort((a, b) => b.kept - a.kept)
    .slice(max)
    .map((k) => k.project);
}

/** The steps' jobs, each once. */
export function stepJobs(h: History): string[] {
  const jobs = new Set<string>();
  for (const s of [...h.undo, ...h.redo]) if (s.job) jobs.add(s.job);
  return [...jobs];
}

/**
 * Keeps the open song's history as it changes: a moment after a change, and at once when the page
 * is hidden. Nothing kept (no database, a full or refused one) is never an error: the history just
 * isn't there after a reload, as before.
 */
export class Keeper {
  private readonly shelf: Shelf | null;
  private readonly made: string;
  private readonly delay: number;
  /** The history last kept (or brought back), to not keep the same again. */
  private last: Omit<Kept, 'kept' | 'made'> | null = null;
  private waiting: Kept | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** When the last history was kept: each one after is later, so the oldest is always the one to go. */
  private clock = 0;

  /** `made`: the fingerprint of the code that makes the songs (kept with each history). */
  constructor(shelf: Shelf | null, { made = '', delay = 250 }: { made?: string; delay?: number } = {}) {
    this.shelf = shelf;
    this.made = made;
    this.delay = delay;
  }

  /** The studio's state changed: its history is kept soon, if it's one to keep and a new one. */
  changed(s: Keepable): void {
    if (!this.shelf) return;
    const kept = toKeep(s, this.made);
    if (!kept) return;
    const l = this.last;
    if (l && l.project === kept.project && l.revision === kept.revision && l.undo === kept.undo && l.redo === kept.redo)
      return;
    kept.kept = Math.max(kept.kept, this.clock + 1);
    this.clock = kept.kept;
    this.last = kept;
    this.waiting = kept;
    this.timer ??= setTimeout(() => void this.flush(), this.delay);
  }

  /** Keep what's waiting now. Resolves once it's kept (or couldn't be). */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const kept = this.waiting;
    this.waiting = null;
    const shelf = this.shelf;
    if (!kept || !shelf) return this.writing;
    this.writing = this.writing.then(async () => {
      try {
        await shelf.put(kept);
        for (const id of overflow(await shelf.list())) if (id !== kept.project) await shelf.delete(id);
      } catch {
        // not kept: the history is there until the page goes, as before
      }
    });
    return this.writing;
  }

  /** The song opened: its kept history, if it's the one for the revision it opened at. */
  async restore(project: Project): Promise<History | null> {
    if (!this.shelf) return null;
    // (this song's history on its way in finishes first)
    await this.flush();
    try {
      const h = restorable(await this.shelf.get(project.id), project, this.made);
      if (h) this.last = { project: project.id, revision: project.revision, undo: h.undo, redo: h.redo };
      return h;
    } catch {
      return null;
    }
  }
}

// ---- the browser's database ----

const DB = 'holo-undo';
const SONGS = 'songs';

function opened(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 1);
    req.onupgradeneeded = () => {
      const songs = req.result.createObjectStore(SONGS, { keyPath: 'project' });
      songs.createIndex('kept', 'kept');
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('The undo history’s database is in use by an older page'));
  });
}

/** One request in its own transaction: its result, once the transaction is done. */
function within<T>(
  db: IDBDatabase,
  mode: IDBTransactionMode,
  make: (songs: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let req: IDBRequest<T>;
    try {
      const tx = db.transaction(SONGS, mode);
      req = make(tx.objectStore(SONGS));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = () => reject(tx.error ?? new Error('Aborted'));
      tx.onerror = () => reject(tx.error ?? req.error);
    } catch (err) {
      // (a history that can't be cloned throws as it's put)
      reject(err);
    }
  });
}

/** The browser's database as a shelf, or null where there's none (a private window may refuse it). */
export function browserShelf(): Shelf | null {
  if (typeof indexedDB === 'undefined') return null;
  let db: Promise<IDBDatabase> | null = null;
  const connect = (): Promise<IDBDatabase> => {
    db ??= opened().then(
      (d) => {
        // a newer page that changes the database's shape: this one lets it go
        d.onversionchange = () => {
          d.close();
          db = null;
        };
        return d;
      },
      (err) => {
        db = null;
        throw err;
      },
    );
    return db;
  };
  return {
    async get(project) {
      return (await within(await connect(), 'readonly', (s) => s.get(project))) as Kept | undefined;
    },
    async put(kept) {
      await within(await connect(), 'readwrite', (s) => s.put(kept));
    },
    async delete(project) {
      await within(await connect(), 'readwrite', (s) => s.delete(project));
    },
    async list() {
      const d = await connect();
      return new Promise((resolve, reject) => {
        const out: { project: string; kept: number }[] = [];
        // the index's keys alone: no history is read to list them
        const req = d.transaction(SONGS, 'readonly').objectStore(SONGS).index('kept').openKeyCursor();
        req.onsuccess = () => {
          const c = req.result;
          if (!c) return resolve(out);
          out.push({ project: String(c.primaryKey), kept: Number(c.key) });
          c.continue();
        };
        req.onerror = () => reject(req.error);
      });
    },
  };
}
