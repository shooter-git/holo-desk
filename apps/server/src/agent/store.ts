/**
 * What the agent keeps on disk, in HO[LO]'s own database (db.ts): whether it's on and with which
 * harness, the devices allowed to use it (only a hash of each one's token), devices asking to join,
 * and each song's conversation with it (its thread: what the agent last saw of the song, what the
 * user did since, and the requests and replies the bar shows).
 */
import type { DatabaseSync } from 'node:sqlite';

export type HarnessId = 'claude' | 'codex' | 'cursor';
export const HARNESSES: readonly HarnessId[] = ['claude', 'codex', 'cursor'];

export interface AgentSettings {
  enabled: boolean;
  /** null: whichever is available (Claude Code, then Codex, then Cursor). */
  harness: HarnessId | null;
  /** Empty: the harness's own default. */
  model: string;
  effort: string;
}

export interface DeviceRow {
  id: string;
  name: string;
  /** sha256 of its token, as hex. */
  token_hash: string;
  added: number;
  seen: number | null;
}

export interface RequestRow {
  id: string;
  name: string;
  /** Shown on both devices, so the person approving knows which one asks. */
  code: string;
  secret_hash: string;
  state: 'pending' | 'approved' | 'denied';
  /** Set once the token went to the device that asked (it goes once). */
  token_hash: string | null;
  created: number;
}

/** Something the user did that the agent hears of before its next reply. */
export interface ThreadEvent {
  action: 'undo' | 'redo' | 'step' | 'stopped' | 'failed' | 'denied';
  label: string;
  /** One of the agent's own steps (undone or redone). */
  agent?: boolean;
  at: number;
}

export interface ThreadRow {
  id: string;
  project: string;
  harness: HarnessId;
  /** The harness's own session, resumed for the next request. */
  session: string | null;
  /** The song as the agent left it at the end of its last reply (JSON). */
  seen_doc: string | null;
  seen_revision: number | null;
  events_json: string;
  created: number;
  updated: number;
  current: number;
}

/** What a turn keeps besides its reply: what it asked, the brief it wrote, why it stopped, what was attached. */
export interface TurnExtra {
  permission?: { kind: string; detail: string; pack?: string };
  brief?: string;
  briefWarnings?: { line: number; kind: 'command' | 'url' }[];
  error?: string;
  /** The attachments its request carried (its job, and later ones on the thread, may read them). */
  attachments?: string[];
}

export interface TurnRow {
  thread: string;
  job: string;
  request: string;
  reply: string | null;
  label: string | null;
  state: string;
  at: number;
  /** TurnExtra, as JSON. */
  extra: string | null;
}

const KEEP_TURNS = 50;

export class AgentStore {
  private readonly db: DatabaseSync;

  constructor(db: DatabaseSync) {
    this.db = db;
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_settings (
        id INTEGER PRIMARY KEY CHECK (id = 1),
        enabled INTEGER NOT NULL DEFAULT 0,
        harness TEXT,
        model TEXT NOT NULL DEFAULT '',
        effort TEXT NOT NULL DEFAULT ''
      );
      CREATE TABLE IF NOT EXISTS agent_devices (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        added INTEGER NOT NULL,
        seen INTEGER
      );
      CREATE TABLE IF NOT EXISTS agent_requests (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL,
        secret_hash TEXT NOT NULL,
        state TEXT NOT NULL,
        token_hash TEXT,
        created INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_threads (
        id TEXT PRIMARY KEY,
        project TEXT NOT NULL,
        harness TEXT NOT NULL,
        session TEXT,
        seen_doc TEXT,
        seen_revision INTEGER,
        events_json TEXT NOT NULL DEFAULT '[]',
        created INTEGER NOT NULL,
        updated INTEGER NOT NULL,
        current INTEGER NOT NULL DEFAULT 1
      );
      CREATE INDEX IF NOT EXISTS agent_threads_project ON agent_threads (project, current);
      CREATE TABLE IF NOT EXISTS agent_turns (
        job TEXT PRIMARY KEY,
        thread TEXT NOT NULL,
        request TEXT NOT NULL,
        reply TEXT,
        label TEXT,
        state TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_turns_thread ON agent_turns (thread, at);
      INSERT OR IGNORE INTO agent_settings (id) VALUES (1);
    `);
    // added after the first version: turns keep what they asked, their brief, why they stopped
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(agent_turns)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has('extra')) this.db.exec('ALTER TABLE agent_turns ADD COLUMN extra TEXT');
    // jobs live in memory: a turn still running, or waiting for a click, when HO[LO] stopped can't go on
    this.db.exec(`
      UPDATE agent_turns SET state = 'failed' WHERE state IN ('waiting', 'running');
      UPDATE agent_turns SET state = 'cancelled' WHERE state = 'awaiting';
    `);
  }

  // ---- settings ----

  settings(): AgentSettings {
    const row = this.db.prepare('SELECT enabled, harness, model, effort FROM agent_settings WHERE id = 1').get() as {
      enabled: number;
      harness: string | null;
      model: string;
      effort: string;
    };
    return {
      enabled: row.enabled === 1,
      harness: HARNESSES.includes(row.harness as HarnessId) ? (row.harness as HarnessId) : null,
      model: row.model,
      effort: row.effort,
    };
  }

  setSettings(patch: Partial<AgentSettings>): AgentSettings {
    const next = { ...this.settings(), ...patch };
    this.db
      .prepare('UPDATE agent_settings SET enabled = ?, harness = ?, model = ?, effort = ? WHERE id = 1')
      .run(next.enabled ? 1 : 0, next.harness, next.model, next.effort);
    return this.settings();
  }

  // ---- devices ----

  devices(): DeviceRow[] {
    return this.db
      .prepare('SELECT id, name, token_hash, added, seen FROM agent_devices ORDER BY added')
      .all() as unknown as DeviceRow[];
  }

  device(id: string): DeviceRow | null {
    const row = this.db.prepare('SELECT id, name, token_hash, added, seen FROM agent_devices WHERE id = ?').get(id);
    return (row as unknown as DeviceRow | undefined) ?? null;
  }

  addDevice(device: DeviceRow): void {
    this.db
      .prepare('INSERT INTO agent_devices (id, name, token_hash, added, seen) VALUES (?, ?, ?, ?, ?)')
      .run(device.id, device.name, device.token_hash, device.added, device.seen);
  }

  seen(id: string, at: number): void {
    this.db.prepare('UPDATE agent_devices SET seen = ? WHERE id = ?').run(at, id);
  }

  removeDevice(id: string): boolean {
    return Number(this.db.prepare('DELETE FROM agent_devices WHERE id = ?').run(id).changes) > 0;
  }

  // ---- devices asking to join ----

  requests(): RequestRow[] {
    return this.db
      .prepare('SELECT id, name, code, secret_hash, state, token_hash, created FROM agent_requests ORDER BY created')
      .all() as unknown as RequestRow[];
  }

  request(id: string): RequestRow | null {
    const row = this.db
      .prepare('SELECT id, name, code, secret_hash, state, token_hash, created FROM agent_requests WHERE id = ?')
      .get(id);
    return (row as unknown as RequestRow | undefined) ?? null;
  }

  addRequest(r: RequestRow): void {
    this.db
      .prepare(
        'INSERT INTO agent_requests (id, name, code, secret_hash, state, token_hash, created) VALUES (?, ?, ?, ?, ?, ?, ?)',
      )
      .run(r.id, r.name, r.code, r.secret_hash, r.state, r.token_hash, r.created);
  }

  setRequest(id: string, state: RequestRow['state'], tokenHash: string | null = null): void {
    this.db.prepare('UPDATE agent_requests SET state = ?, token_hash = ? WHERE id = ?').run(state, tokenHash, id);
  }

  /** Requests from before `before` are forgotten (a device that asked and went away). */
  dropRequests(before: number): void {
    this.db.prepare('DELETE FROM agent_requests WHERE created < ?').run(before);
  }

  // ---- threads ----

  thread(id: string): ThreadRow | null {
    const row = this.db.prepare('SELECT * FROM agent_threads WHERE id = ?').get(id);
    return (row as unknown as ThreadRow | undefined) ?? null;
  }

  /** A song's current thread, or null. */
  currentThread(project: string): ThreadRow | null {
    const row = this.db
      .prepare('SELECT * FROM agent_threads WHERE project = ? AND current = 1 ORDER BY created DESC LIMIT 1')
      .get(project);
    return (row as unknown as ThreadRow | undefined) ?? null;
  }

  /** A new thread for a song: from now on the current one. */
  addThread(t: Omit<ThreadRow, 'current'>): ThreadRow {
    this.endThreads(t.project);
    this.db
      .prepare(
        `INSERT INTO agent_threads (id, project, harness, session, seen_doc, seen_revision, events_json, created, updated, current)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`,
      )
      .run(t.id, t.project, t.harness, t.session, t.seen_doc, t.seen_revision, t.events_json, t.created, t.updated);
    return { ...t, current: 1 };
  }

  /** The song's next request starts a new thread. */
  endThreads(project: string): void {
    this.db.prepare('UPDATE agent_threads SET current = 0 WHERE project = ?').run(project);
  }

  updateThread(id: string, patch: Partial<Pick<ThreadRow, 'session' | 'seen_doc' | 'seen_revision' | 'events_json'>>) {
    const row = this.thread(id);
    if (!row) return;
    const next = { ...row, ...patch };
    this.db
      .prepare(
        'UPDATE agent_threads SET session = ?, seen_doc = ?, seen_revision = ?, events_json = ?, updated = ? WHERE id = ?',
      )
      .run(next.session, next.seen_doc, next.seen_revision, next.events_json, Date.now(), id);
  }

  // ---- turns: what the bar shows of a thread ----

  addTurn(t: TurnRow): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO agent_turns (job, thread, request, reply, label, state, at, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(t.job, t.thread, t.request, t.reply, t.label, t.state, t.at, t.extra);
    this.db
      .prepare(
        `DELETE FROM agent_turns WHERE thread = ? AND job NOT IN
         (SELECT job FROM agent_turns WHERE thread = ? ORDER BY at DESC LIMIT ?)`,
      )
      .run(t.thread, t.thread, KEEP_TURNS);
  }

  updateTurn(job: string, patch: Partial<Pick<TurnRow, 'reply' | 'label' | 'state' | 'extra'>>): void {
    const row = this.db.prepare('SELECT reply, label, state, extra FROM agent_turns WHERE job = ?').get(job) as
      | Pick<TurnRow, 'reply' | 'label' | 'state' | 'extra'>
      | undefined;
    if (!row) return;
    const next = { ...row, ...patch };
    this.db
      .prepare('UPDATE agent_turns SET reply = ?, label = ?, state = ?, extra = ? WHERE job = ?')
      .run(next.reply, next.label, next.state, next.extra, job);
  }

  turns(thread: string): TurnRow[] {
    return this.db
      .prepare(
        'SELECT thread, job, request, reply, label, state, at, extra FROM agent_turns WHERE thread = ? ORDER BY at, rowid',
      )
      .all(thread) as unknown as TurnRow[];
  }
}
