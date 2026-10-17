/**
 * Projects on disk: one SQLite file in the data folder. Every save keeps the session and its
 * revision; earlier versions are kept too (a few minutes apart), so nothing is ever lost to a bad
 * edit, yours or the AI's.
 */
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { type Project, parseProject } from '@holo/session';

export interface ProjectRow {
  id: string;
  title: string;
  revision: number;
  created: string;
  modified: string;
  creation: string | null;
  piece: string | null;
}

export interface HistoryRow {
  revision: number;
  saved: string;
  author: string | null;
}

const SNAPSHOT_EVERY_MS = 3 * 60 * 1000;
const KEEP_SNAPSHOTS = 200;

export class Store {
  private db: DatabaseSync;

  constructor(dataDir: string) {
    mkdirSync(dataDir, { recursive: true });
    this.db = new DatabaseSync(join(dataDir, 'holo.db'));
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        revision INTEGER NOT NULL,
        created TEXT NOT NULL,
        modified TEXT NOT NULL,
        doc TEXT NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0,
        creation TEXT,
        piece TEXT
      );
      CREATE TABLE IF NOT EXISTS revisions (
        project TEXT NOT NULL,
        revision INTEGER NOT NULL,
        saved TEXT NOT NULL,
        author TEXT,
        doc TEXT NOT NULL,
        PRIMARY KEY (project, revision)
      );
      CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    `);
  }

  list(): ProjectRow[] {
    return this.db
      .prepare(
        'SELECT id, title, revision, created, modified, creation, piece FROM projects WHERE deleted = 0 ORDER BY modified DESC',
      )
      .all() as unknown as ProjectRow[];
  }

  get(id: string): Project | null {
    const row = this.db.prepare('SELECT doc FROM projects WHERE id = ? AND deleted = 0').get(id) as
      | { doc: string }
      | undefined;
    return row ? parseProject(JSON.parse(row.doc)) : null;
  }

  findByOrigin(creation: string, piece: string): ProjectRow | null {
    const row = this.db
      .prepare(
        'SELECT id, title, revision, created, modified, creation, piece FROM projects WHERE deleted = 0 AND creation = ? AND piece = ? ORDER BY modified DESC',
      )
      .get(creation, piece);
    return (row as unknown as ProjectRow | undefined) ?? null;
  }

  /** Save a session as the next revision. Returns the saved session, or null on a conflict. */
  save(project: Project, baseRevision: number | null, author: string): Project | null {
    const current = this.db.prepare('SELECT revision FROM projects WHERE id = ?').get(project.id) as
      | { revision: number }
      | undefined;
    if (current && baseRevision !== null && current.revision !== baseRevision) return null;
    const saved: Project = {
      ...project,
      revision: (current?.revision ?? project.revision) + (current ? 1 : 0),
      modified: new Date().toISOString(),
    };
    const doc = JSON.stringify(saved);
    this.db
      .prepare(
        `INSERT INTO projects (id, title, revision, created, modified, doc, deleted, creation, piece)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?)
         ON CONFLICT(id) DO UPDATE SET title = excluded.title, revision = excluded.revision,
           modified = excluded.modified, doc = excluded.doc, deleted = 0,
           creation = excluded.creation, piece = excluded.piece`,
      )
      .run(
        saved.id,
        saved.title,
        saved.revision,
        saved.created,
        saved.modified,
        doc,
        saved.origin?.creation ?? null,
        saved.origin?.piece ?? null,
      );
    this.snapshot(saved, doc, author);
    return saved;
  }

  private snapshot(project: Project, doc: string, author: string): void {
    const last = this.db
      .prepare('SELECT saved, author FROM revisions WHERE project = ? ORDER BY revision DESC LIMIT 1')
      .get(project.id) as { saved: string; author: string | null } | undefined;
    const due = !last || last.author !== author || Date.now() - Date.parse(last.saved) > SNAPSHOT_EVERY_MS;
    if (!due) return;
    this.db
      .prepare('INSERT OR REPLACE INTO revisions (project, revision, saved, author, doc) VALUES (?, ?, ?, ?, ?)')
      .run(project.id, project.revision, project.modified, author, doc);
    this.db
      .prepare(
        `DELETE FROM revisions WHERE project = ? AND revision NOT IN
         (SELECT revision FROM revisions WHERE project = ? ORDER BY revision DESC LIMIT ?)`,
      )
      .run(project.id, project.id, KEEP_SNAPSHOTS);
  }

  history(id: string): HistoryRow[] {
    return this.db
      .prepare('SELECT revision, saved, author FROM revisions WHERE project = ? ORDER BY revision DESC')
      .all(id) as unknown as HistoryRow[];
  }

  revision(id: string, revision: number): Project | null {
    const row = this.db.prepare('SELECT doc FROM revisions WHERE project = ? AND revision = ?').get(id, revision) as
      | { doc: string }
      | undefined;
    return row ? parseProject(JSON.parse(row.doc)) : null;
  }

  /** Into the bin: hidden from the list, still on disk. */
  remove(id: string): boolean {
    return Number(this.db.prepare('UPDATE projects SET deleted = 1 WHERE id = ?').run(id).changes) > 0;
  }

  setting(key: string): string | null {
    const row = this.db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value ?? null;
  }

  setSetting(key: string, value: string): void {
    this.db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
