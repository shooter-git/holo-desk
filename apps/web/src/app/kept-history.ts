/**
 * The open song, kept on this device: its undo history, and its changes the host doesn't have yet.
 *
 * **The history.** A reload, or the song opened again later, brings its Undo and Redo back, the
 * agent's steps (and their job) among them. A history is kept with the revision it leads up to, once
 * the song is saved, so the song as it is then is that revision. It comes back only when the song
 * opens at that same revision: saved since somewhere else (another device, a creation, a scan read on
 * the host), its steps would undo to songs that no longer line up with it, and the history starts
 * afresh, as it always did. So it does when HO[LO] was updated with other code for songs (the session
 * and engine's fingerprint): its steps hold songs as the code before wrote them.
 *
 * **Changes not saved yet.** The studio saves a moment after an edit, and can't while the host is out
 * of reach or the song was changed somewhere else. Until it has, the song as it is, with its history
 * and the revision its changes were made on, is kept here a tenth of a second after each change, and
 * when the page is hidden. (A browser drops what a page writes as it goes, so this is written while
 * it's still there.) A reload, a closed tab, a phone that let the page go, or another song opened,
 * finds them when the song opens here again: it opens with them and saves them. If the host already
 * has the song as they left it (their save got there just before the page went), they're let go and
 * the history comes back; if it was changed somewhere else meanwhile, the save asks which version to
 * keep, as ever. Once saved, or the other version chosen, they're let go. Unsaved changes are never
 * let go to make room.
 *
 * Every step holds a whole song, but an edit makes a new song that shares each part it didn't change
 * with the one before, and the browser's database stores a part that's shared once (a history goes
 * in as one value), so a long history costs about one song and what each of its steps changed (a
 * few hundred bytes for most).
 */
import { type Project, parseProject } from '@holo/session';
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

/** A song's changes the host doesn't have yet, as they're kept. */
export interface Unsaved {
  /** The song's id. */
  project: string;
  /** The revision they were made on: their save is based on it. */
  base: number;
  /** The song with them. */
  song: Project;
  /** The history leading up to it. */
  undo: Step[];
  redo: Step[];
  /** When they were kept (ms since the epoch). */
  kept: number;
  /** The code that made the songs: the session and engine's fingerprint. */
  made: string;
}

/** Where songs are kept: the browser's database (or, in a test, maps). */
export interface Shelf {
  get(project: string): Promise<Kept | undefined>;
  /** Keep a song's history (it's saved): its unsaved changes, if any were kept, go with the same write. */
  put(kept: Kept): Promise<void>;
  delete(project: string): Promise<void>;
  /** Each kept history's song, and when it was kept. */
  list(): Promise<{ project: string; kept: number }[]>;
  unsaved(project: string): Promise<Unsaved | undefined>;
  keepUnsaved(unsaved: Unsaved): Promise<void>;
  dropUnsaved(project: string): Promise<void>;
}

/** What of the studio's state is kept. */
export interface Keepable {
  project: Project | null;
  serverRevision: number;
  saveState: SaveState;
  undo: Step[];
  redo: Step[];
}

/** The save states in which the song has changes the host doesn't have. */
const UNSAVED_STATES: ReadonlySet<SaveState> = new Set(['dirty', 'saving', 'offline', 'conflict', 'error']);

/**
 * The history to keep, or null: there's none, or the song isn't saved as it is (its history would lead
 * to a song the host doesn't have).
 */
export function toKeep(s: Keepable, made: string, now = Date.now()): Kept | null {
  if (!s.project || s.saveState !== 'saved') return null;
  if (!s.undo.length && !s.redo.length) return null;
  return { project: s.project.id, revision: s.serverRevision, undo: s.undo, redo: s.redo, kept: now, made };
}

/** The changes to keep, or null: the song is saved as it is. */
export function toKeepUnsaved(s: Keepable, made: string, now = Date.now()): Unsaved | null {
  if (!s.project || !UNSAVED_STATES.has(s.saveState)) return null;
  return {
    project: s.project.id,
    base: s.serverRevision,
    song: s.project,
    undo: s.undo,
    redo: s.redo,
    kept: now,
    made,
  };
}

/** The kept history, if it's this song's at the revision it opened at, made by the same code. */
export function restorable(kept: Kept | undefined, project: Project, made: string): History | null {
  if (!kept || kept.project !== project.id || kept.revision !== project.revision || kept.made !== made) return null;
  if (!Array.isArray(kept.undo) || !Array.isArray(kept.redo)) return null;
  return { undo: kept.undo, redo: kept.redo };
}

/** Whether two songs are the same but for their revision and when they were saved. */
export function sameSong(a: Project, b: Project): boolean {
  const plain = (p: Project) => JSON.stringify({ ...parseProject(p), revision: 0, modified: '' });
  try {
    return plain(a) === plain(b);
  } catch {
    return false;
  }
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

/** What a song opens with, of what was kept of it. */
export type Restored =
  /** Its history, at the revision it opened at. */
  | ({ kind: 'history' } & History)
  /** Its changes the host didn't get: the song with them, the revision they were made on, and its history. */
  | ({ kind: 'unsaved'; song: Project; base: number } & History);

/** One write of what's kept of a song. */
type Keep =
  | { kind: 'history'; kept: Kept }
  | { kind: 'unsaved'; unsaved: Unsaved }
  /** Saved, with no history to keep: unsaved changes kept from before go. */
  | { kind: 'saved'; project: string };

/** Whether two writes would keep the same thing. */
function sameKeep(a: Keep, b: Keep | undefined): boolean {
  if (!b || a.kind !== b.kind) return false;
  if (a.kind === 'history' && b.kind === 'history')
    return a.kept.revision === b.kept.revision && a.kept.undo === b.kept.undo && a.kept.redo === b.kept.redo;
  if (a.kind === 'unsaved' && b.kind === 'unsaved')
    return (
      a.unsaved.base === b.unsaved.base &&
      a.unsaved.song === b.unsaved.song &&
      a.unsaved.undo === b.unsaved.undo &&
      a.unsaved.redo === b.unsaved.redo
    );
  return true;
}

/**
 * Keeps the open song as it changes: a moment after a change, and at once when the page is hidden.
 * Nothing kept (no database, a full or refused one) is never an error: what wasn't kept just isn't
 * there after a reload, as before.
 */
export class Keeper {
  private readonly shelf: Shelf | null;
  private readonly made: string;
  private readonly delay: number;
  /** What was last kept (or brought back) of each song, to not keep the same again. */
  private readonly last = new Map<string, Keep>();
  /** What's to be kept, a song each. */
  private readonly waiting = new Map<string, Keep>();
  /** The songs whose unsaved changes are kept, as far as this page knows. */
  private readonly unsavedKept = new Set<string>();
  /** The songs being opened: their state isn't kept until what was kept of them is read. */
  private readonly opening = new Map<string, number>();
  private timer: ReturnType<typeof setTimeout> | null = null;
  private writing: Promise<void> = Promise.resolve();
  /** When the last history was kept: each one after is later, so the oldest is always the one to go. */
  private clock = 0;

  /** `made`: the fingerprint of the code that makes the songs (kept with each). */
  constructor(shelf: Shelf | null, { made = '', delay = 100 }: { made?: string; delay?: number } = {}) {
    this.shelf = shelf;
    this.made = made;
    this.delay = delay;
  }

  /** The studio's state changed (or a song left behind was saved): what's new of it is kept soon. */
  changed(s: Keepable): void {
    if (!this.shelf || !s.project) return;
    const id = s.project.id;
    if (this.opening.has(id)) return;
    const keep = this.toWrite(s);
    if (!keep || sameKeep(keep, this.last.get(id))) return;
    if (keep.kind === 'history') {
      keep.kept.kept = Math.max(keep.kept.kept, this.clock + 1);
      this.clock = keep.kept.kept;
    }
    this.last.set(id, keep);
    this.waiting.set(id, keep);
    this.timer ??= setTimeout(() => void this.flush(), this.delay);
  }

  private toWrite(s: Keepable): Keep | null {
    const unsaved = toKeepUnsaved(s, this.made);
    if (unsaved) return { kind: 'unsaved', unsaved };
    const kept = toKeep(s, this.made);
    if (kept) return { kind: 'history', kept };
    // saved, with no history (the other version was taken, say): changes kept from before go
    const id = s.project?.id;
    return id && this.unsavedKept.has(id) ? { kind: 'saved', project: id } : null;
  }

  /** Keep what's waiting now. Resolves once it's kept (or couldn't be). */
  flush(): Promise<void> {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const keeps = [...this.waiting.values()];
    this.waiting.clear();
    const shelf = this.shelf;
    if (!keeps.length || !shelf) return this.writing;
    this.writing = this.writing.then(async () => {
      for (const k of keeps) {
        try {
          await this.write(shelf, k);
        } catch {
          // not kept: it's there until the page goes, as before
        }
      }
    });
    return this.writing;
  }

  private async write(shelf: Shelf, k: Keep): Promise<void> {
    switch (k.kind) {
      case 'history':
        this.unsavedKept.delete(k.kept.project);
        await shelf.put(k.kept);
        for (const id of overflow(await shelf.list())) if (id !== k.kept.project) await shelf.delete(id);
        return;
      case 'unsaved':
        this.unsavedKept.add(k.unsaved.project);
        await shelf.keepUnsaved(k.unsaved);
        return;
      case 'saved':
        this.unsavedKept.delete(k.project);
        await shelf.dropUnsaved(k.project);
    }
  }

  /**
   * The song is opening: what was kept of it that can come back (its changes the host didn't get, or
   * its history at the revision it opened at). Call it before the studio's state changes to the song:
   * until it resolves, the song's state isn't kept, as that would let go of what's being read. With
   * `discard`, its unsaved changes go instead (the other version was chosen).
   */
  open(project: Project, { discard = false }: { discard?: boolean } = {}): Promise<Restored | null> {
    const id = project.id;
    this.opening.set(id, (this.opening.get(id) ?? 0) + 1);
    if (discard) {
      this.waiting.delete(id);
      this.last.delete(id);
    }
    return this.read(project, discard).finally(() => {
      const n = (this.opening.get(id) ?? 1) - 1;
      if (n > 0) this.opening.set(id, n);
      else this.opening.delete(id);
    });
  }

  private async read(project: Project, discard: boolean): Promise<Restored | null> {
    const shelf = this.shelf;
    if (!shelf) return null;
    // (what's on its way in, this song's included, goes in first)
    await this.flush();
    const id = project.id;
    try {
      if (discard) {
        this.unsavedKept.delete(id);
        await shelf.dropUnsaved(id);
      } else {
        const back = await this.unsavedBack(shelf, project);
        if (back) return back;
      }
      const h = restorable(await shelf.get(id), project, this.made);
      if (!h) return null;
      this.last.set(id, {
        kind: 'history',
        kept: { project: id, revision: project.revision, undo: h.undo, redo: h.redo, kept: 0, made: this.made },
      });
      return { kind: 'history', ...h };
    } catch {
      return null;
    }
  }

  /** The song's kept changes, as it opens with them (null: none, or the host has them already). */
  private async unsavedBack(shelf: Shelf, project: Project): Promise<Restored | null> {
    const id = project.id;
    const u = await shelf.unsaved(id);
    if (!u || u.project !== id) return null;
    this.unsavedKept.add(id);
    const sameCode = u.made === this.made;
    let song: Project;
    try {
      // kept by other code for songs: read as this code reads a song
      song = sameCode ? u.song : parseProject(u.song);
    } catch {
      this.unsavedKept.delete(id);
      await shelf.dropUnsaved(id);
      return null;
    }
    // (kept by other code, the history's songs are as that code wrote them: the changes come without it)
    const h: History =
      sameCode && Array.isArray(u.undo) && Array.isArray(u.redo)
        ? { undo: u.undo, redo: u.redo }
        : { undo: [], redo: [] };
    if (sameSong(song, project)) {
      // their save got to the host before the page went: the song is as saved, and the history leads up to it
      this.unsavedKept.delete(id);
      await shelf.dropUnsaved(id);
      return h.undo.length || h.redo.length ? { kind: 'history', ...h } : null;
    }
    this.last.set(id, { kind: 'unsaved', unsaved: { ...u, song, ...h } });
    return { kind: 'unsaved', song, base: u.base, ...h };
  }
}

// ---- the browser's database ----

const DB = 'holo-undo';
const SONGS = 'songs';
const UNSAVED = 'unsaved';

function opened(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(SONGS)) {
        const songs = db.createObjectStore(SONGS, { keyPath: 'project' });
        songs.createIndex('kept', 'kept');
      }
      // (a song's changes not saved yet: kept apart, so making room for histories never lets them go)
      if (!db.objectStoreNames.contains(UNSAVED)) db.createObjectStore(UNSAVED, { keyPath: 'project' });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
    req.onblocked = () => reject(new Error('The undo history’s database is in use by an older page'));
  });
}

/** Requests in one transaction: the last one's result, once the transaction is done. */
function within<T>(
  db: IDBDatabase,
  stores: string[],
  mode: IDBTransactionMode,
  make: (store: (name: string) => IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return new Promise((resolve, reject) => {
    let req: IDBRequest<T>;
    try {
      const tx = db.transaction(stores, mode);
      req = make((name) => tx.objectStore(name));
      tx.oncomplete = () => resolve(req.result);
      tx.onabort = () => reject(tx.error ?? new Error('Aborted'));
      tx.onerror = () => reject(tx.error ?? req.error);
    } catch (err) {
      // (a song that can't be cloned throws as it's put)
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
      return (await within(await connect(), [SONGS], 'readonly', (s) => s(SONGS).get(project))) as Kept | undefined;
    },
    async put(kept) {
      await within(await connect(), [SONGS, UNSAVED], 'readwrite', (s) => {
        s(UNSAVED).delete(kept.project);
        return s(SONGS).put(kept);
      });
    },
    async delete(project) {
      await within(await connect(), [SONGS], 'readwrite', (s) => s(SONGS).delete(project));
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
    async unsaved(project) {
      return (await within(await connect(), [UNSAVED], 'readonly', (s) => s(UNSAVED).get(project))) as
        | Unsaved
        | undefined;
    },
    async keepUnsaved(unsaved) {
      await within(await connect(), [UNSAVED], 'readwrite', (s) => s(UNSAVED).put(unsaved));
    },
    async dropUnsaved(project) {
      await within(await connect(), [UNSAVED], 'readwrite', (s) => s(UNSAVED).delete(project));
    },
  };
}
