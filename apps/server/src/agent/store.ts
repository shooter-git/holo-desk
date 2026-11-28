/**
 * What the agent keeps on disk, in HO[LO]'s own database (db.ts): whether it's on and with which
 * harness, the devices allowed to use it (only a hash of each one's token), devices asking to join,
 * and each song's conversation with it (its thread: what the agent last saw of the song, what the
 * user did since, and the requests and replies the bar shows). A device that turned on notices
 * outside HO[LO] has its push subscription here too, and the replies it asked for that no device has
 * seen yet (its Home Screen badge).
 */

import type { DatabaseSync } from 'node:sqlite';
import type { RunUsage, StopWhy } from '@holo/agent/limits';
import type { Go, View } from '@holo/agent/view';
import type { RequestContext, ScanPreset } from './prompt.ts';

export type HarnessId = 'claude' | 'codex' | 'cursor' | 'antigravity';
export const HARNESSES: readonly HarnessId[] = ['claude', 'codex', 'cursor', 'antigravity'];

/**
 * Harnesses used only once they're chosen in Settings › Agent, never as whichever is available:
 * Google's terms don't support another app running Antigravity on a consumer plan, so the studio asks
 * before it's signed in or used, and nothing picks it on the user's behalf.
 */
export const CHOSEN_ONLY: ReadonlySet<HarnessId> = new Set(['antigravity']);

export interface AgentSettings {
  enabled: boolean;
  /** null: whichever is available (Claude Code, then Codex, then Cursor; never one that's CHOSEN_ONLY). */
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
  /** A failed turn whose conversation can't go on: the next request starts a new one. */
  fresh?: boolean;
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
  /**
   * The song's own choice of what its conversation runs with (`own_harness` null: it follows Settings ›
   * Agent). Its model and effort are empty for the harness's own.
   */
  own_harness?: HarnessId | null;
  own_model?: string | null;
  own_effort?: string | null;
}

/**
 * One harness's part in a song's conversation: its own session there, what it last saw of the song,
 * and the folder its runs work in. A conversation that moves to another harness keeps each one's, so
 * going back to one carries its own session on.
 */
export interface LegRow {
  thread: string;
  harness: HarnessId;
  /** The harness's own session in this conversation, resumed when it runs here again. */
  session: string | null;
  /** The song as it left it at the end of its last reply here (JSON), and that song's revision. */
  seen_doc: string | null;
  seen_revision: number | null;
  /**
   * The last turn of the conversation its session knows of: its own latest that reached it (the
   * prompt of that turn told it everything before). Turns after it made with another harness are what
   * it has missed. Null: none yet, or not known (a leg from before this was kept).
   */
  told: string | null;
  /** Its workspace's name under the runner's folder for the agent (the thread's id for the conversation's first). */
  workspace: string;
  updated: number;
}

/** What a turn keeps besides its reply: what it asked, the brief it wrote, why it stopped, what was attached. */
export interface TurnExtra {
  permission?: { kind: string; detail: string; pack?: string };
  brief?: string;
  briefWarnings?: { line: number; kind: 'command' | 'url' | 'secret' }[];
  error?: string;
  /** The attachments its request carried (its job, and later ones on the thread, may read them). */
  attachments?: string[];
  /** The revision kept as the song before its request (the next request's "previous"). */
  before?: number;
  /** What its reply shows under it, and where the studio went as it arrived. */
  view?: View;
  go?: Go;
  /** When its job began and ended, and the song's title then (the job's view, kept for a restart). */
  started?: number;
  finished?: number;
  title?: string;
  /** What it ran with: the harness, and the model and effort handed to its runner (empty: the harness's own). */
  harness?: HarnessId;
  model?: string;
  effort?: string;
  /** What the studio showed as it was asked, and the preset it was (a scan's): to carry the request on. */
  context?: RequestContext;
  preset?: ScanPreset;
  /** What the agent was told the user did before it, as it read it (the thread's events then). */
  heard?: string[];
  /** What its tools changed, in order: each batch's label, and how many in a row had it. */
  changes?: [string, number][];
  /**
   * Why it didn't go on, when that's known for sure: `interrupted` (HO[LO] or its runner stopped under
   * it), or what its harness made plain (out of usage, signed out, not installed).
   */
  stop?: TurnStop;
  /** The turn it carries on: an earlier go at the same request, which didn't finish. */
  continues?: string;
  /** What the user allowed, and what the studio reported, when it follows a permission (its request carried on). */
  allowed?: string;
  /** The song before the conversation's previous request (the job's "previous"). */
  previous?: number;
}

/** Why a turn stopped short, where HO[LO] knows. */
export interface TurnStop {
  why: 'interrupted' | StopWhy;
  /** When the limit that stopped it starts again (ms since 1970), for `usage`, when that's known. */
  resets?: number;
}

/** How many of a turn's changes are kept (the rest are counted as one more line). */
export const KEEP_CHANGES = 40;

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
  /** The device that asked (null: a turn from before this was kept). */
  device?: string | null;
}

/** A turn that wasn't over when HO[LO] last stopped, with its thread's song and whether that thread is current. */
export interface UnfinishedTurn extends TurnRow {
  project: string | null;
  current: number | null;
}

/** When a device is told of a reply outside HO[LO] (Settings › Agent, "Tell me outside HO[LO]"). */
export type PushMode = 'long' | 'every';

/** A device's push subscription (its browser's push service, and the keys its notices are encrypted to). */
export interface PushRow {
  device: string;
  /** The push service's URL for this device (an allowed host: push.ts, `allowedEndpoint`). */
  endpoint: string;
  /** The browser's P-256 public key (65 bytes) and its auth secret (16 bytes), as base64url. */
  p256dh: string;
  auth: string;
  mode: PushMode;
  added: number;
}

/** What a request used, as its harness counted it: one row a request that said. */
export interface UsageRow extends RunUsage {
  job: string;
  harness: HarnessId;
  /** The model it ran with (the harness's default by name, when none was chosen and it lists one). */
  model: string;
  effort: string;
  at: number;
}

/** The requests that ran with one model and effort of a harness, added up. */
export interface UsageSum extends RunUsage {
  harness: HarnessId;
  model: string;
  effort: string;
  requests: number;
}

const KEEP_TURNS = 50;
/** How long a request's usage is kept: Settings › Agent adds up the last 30 days. */
const KEEP_USAGE_MS = 90 * 86_400_000;
/** A device's unseen replies kept for its badge: the newest this many. */
const KEEP_UNSEEN = 50;

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
      CREATE TABLE IF NOT EXISTS agent_push (
        device TEXT PRIMARY KEY,
        endpoint TEXT NOT NULL,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        mode TEXT NOT NULL CHECK (mode IN ('long', 'every')),
        added INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_unseen (
        job TEXT PRIMARY KEY,
        device TEXT NOT NULL,
        project TEXT NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_unseen_device ON agent_unseen (device, at);
      CREATE INDEX IF NOT EXISTS agent_unseen_project ON agent_unseen (project);
      CREATE TABLE IF NOT EXISTS agent_usage (
        job TEXT PRIMARY KEY,
        harness TEXT NOT NULL,
        model TEXT NOT NULL DEFAULT '',
        effort TEXT NOT NULL DEFAULT '',
        input INTEGER NOT NULL,
        cached INTEGER NOT NULL,
        output INTEGER NOT NULL,
        at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_usage_at ON agent_usage (at);
      INSERT OR IGNORE INTO agent_settings (id) VALUES (1);
    `);
    // added after the first version: turns keep what they asked, their brief, why they stopped
    const columns = new Set(
      (this.db.prepare('PRAGMA table_info(agent_turns)').all() as { name: string }[]).map((c) => c.name),
    );
    if (!columns.has('extra')) this.db.exec('ALTER TABLE agent_turns ADD COLUMN extra TEXT');
    // added later still: who asked, so a turn waiting for their click is theirs after a restart too
    if (!columns.has('device')) this.db.exec('ALTER TABLE agent_turns ADD COLUMN device TEXT');
    // added with a song's own choice of harness, model and effort (none: it follows Settings › Agent)
    const threadColumns = new Set(
      (this.db.prepare('PRAGMA table_info(agent_threads)').all() as { name: string }[]).map((c) => c.name),
    );
    for (const column of ['own_harness', 'own_model', 'own_effort'])
      if (!threadColumns.has(column)) this.db.exec(`ALTER TABLE agent_threads ADD COLUMN ${column} TEXT`);
    // added with conversations that span harnesses: each harness's own session and workspace in one.
    // The conversations there already get theirs as they were: one harness each, working in the
    // thread's own folder (its session is found there)
    const legs = this.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'agent_legs'").get();
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_legs (
        thread TEXT NOT NULL,
        harness TEXT NOT NULL,
        session TEXT,
        seen_doc TEXT,
        seen_revision INTEGER,
        told TEXT,
        workspace TEXT NOT NULL,
        updated INTEGER NOT NULL,
        PRIMARY KEY (thread, harness)
      );
    `);
    if (!legs)
      this.db.exec(`
        INSERT OR IGNORE INTO agent_legs (thread, harness, session, seen_doc, seen_revision, workspace, updated)
        SELECT id, harness, session, seen_doc, seen_revision, id, updated FROM agent_threads WHERE current = 1;
      `);
    // (the turns that weren't over when HO[LO] stopped are seen to as it starts: Jobs.recover)
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

  /** A device removed: its notices' subscription and unseen replies go with it. */
  removeDevice(id: string): boolean {
    this.removePush(id);
    return Number(this.db.prepare('DELETE FROM agent_devices WHERE id = ?').run(id).changes) > 0;
  }

  // ---- notices outside HO[LO] (push.ts), per device ----

  push(device: string): PushRow | null {
    const row = this.db
      .prepare('SELECT device, endpoint, p256dh, auth, mode, added FROM agent_push WHERE device = ?')
      .get(device);
    return (row as unknown as PushRow | undefined) ?? null;
  }

  /**
   * A device's subscription, new or changed. A browser has one subscription for HO[LO], so another
   * device with the same one (the same browser, paired again after its site data was cleared) lets it go.
   */
  setPush(row: PushRow): void {
    this.db.prepare('DELETE FROM agent_push WHERE endpoint = ? AND device != ?').run(row.endpoint, row.device);
    this.db
      .prepare(
        `INSERT INTO agent_push (device, endpoint, p256dh, auth, mode, added) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(device) DO UPDATE SET endpoint = excluded.endpoint, p256dh = excluded.p256dh,
         auth = excluded.auth, mode = excluded.mode`,
      )
      .run(row.device, row.endpoint, row.p256dh, row.auth, row.mode, row.added);
  }

  /** Notices off for a device (Off, its subscription ended, or the device removed): its unseen replies go too. */
  removePush(device: string): void {
    this.db.prepare('DELETE FROM agent_push WHERE device = ?').run(device);
    this.db.prepare('DELETE FROM agent_unseen WHERE device = ?').run(device);
  }

  /** A reply the device asked for ended unseen (its newest KEEP_UNSEEN are kept). */
  addUnseen(job: string, device: string, project: string, at: number): void {
    this.db
      .prepare('INSERT OR REPLACE INTO agent_unseen (job, device, project, at) VALUES (?, ?, ?, ?)')
      .run(job, device, project, at);
    this.db
      .prepare(
        `DELETE FROM agent_unseen WHERE device = ? AND job NOT IN
         (SELECT job FROM agent_unseen WHERE device = ? ORDER BY at DESC, rowid DESC LIMIT ?)`,
      )
      .run(device, device, KEEP_UNSEEN);
  }

  /** How many replies a device asked for are unseen: its Home Screen badge. */
  unseen(device: string): number {
    const row = this.db.prepare('SELECT COUNT(*) AS n FROM agent_unseen WHERE device = ?').get(device) as { n: number };
    return Number(row.n);
  }

  /** A song's replies were seen (on any device): none of them counts as unseen on any device now. */
  seenSong(project: string): void {
    this.db.prepare('DELETE FROM agent_unseen WHERE project = ?').run(project);
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

  updateThread(
    id: string,
    patch: Partial<Pick<ThreadRow, 'harness' | 'session' | 'seen_doc' | 'seen_revision' | 'events_json'>>,
  ) {
    const row = this.thread(id);
    if (!row) return;
    const next = { ...row, ...patch };
    this.db
      .prepare(
        'UPDATE agent_threads SET harness = ?, session = ?, seen_doc = ?, seen_revision = ?, events_json = ?, updated = ? WHERE id = ?',
      )
      .run(next.harness, next.session, next.seen_doc, next.seen_revision, next.events_json, Date.now(), id);
  }

  /** A thread's own choice of what it runs with; null: it follows Settings › Agent again. */
  setChoice(id: string, choice: { harness: HarnessId; model: string; effort: string } | null): void {
    this.db
      .prepare('UPDATE agent_threads SET own_harness = ?, own_model = ?, own_effort = ?, updated = ? WHERE id = ?')
      .run(choice?.harness ?? null, choice?.model ?? null, choice?.effort ?? null, Date.now(), id);
  }

  // ---- legs: each harness's own part in a conversation ----

  leg(thread: string, harness: HarnessId): LegRow | null {
    const row = this.db.prepare('SELECT * FROM agent_legs WHERE thread = ? AND harness = ?').get(thread, harness);
    return (row as unknown as LegRow | undefined) ?? null;
  }

  /** A conversation's legs, the one that ran last first. */
  legs(thread: string): LegRow[] {
    return this.db
      .prepare('SELECT * FROM agent_legs WHERE thread = ? ORDER BY updated DESC, rowid DESC')
      .all(thread) as unknown as LegRow[];
  }

  /** A leg as it is now (made if it isn't there yet). */
  putLeg(leg: Omit<LegRow, 'updated'>): LegRow {
    const updated = Date.now();
    this.db
      .prepare(
        `INSERT INTO agent_legs (thread, harness, session, seen_doc, seen_revision, told, workspace, updated)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (thread, harness) DO UPDATE SET
           session = excluded.session, seen_doc = excluded.seen_doc, seen_revision = excluded.seen_revision,
           told = excluded.told, workspace = excluded.workspace, updated = excluded.updated`,
      )
      .run(leg.thread, leg.harness, leg.session, leg.seen_doc, leg.seen_revision, leg.told, leg.workspace, updated);
    return { ...leg, updated };
  }

  /** A thread's legs, gone: for one no request has run on yet. */
  dropLegs(thread: string): void {
    this.db.prepare('DELETE FROM agent_legs WHERE thread = ?').run(thread);
  }

  // ---- usage: what each request used, as its harness counted it ----

  /** Keep what a request used (once a request: a second word for the same one replaces the first). */
  addUsage(u: UsageRow): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO agent_usage (job, harness, model, effort, input, cached, output, at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(u.job, u.harness, u.model, u.effort, u.input, u.cached, u.output, u.at);
    this.db.prepare('DELETE FROM agent_usage WHERE at < ?').run(u.at - KEEP_USAGE_MS);
  }

  /** The requests since a time, added up by harness, model and effort: the most used first. */
  usage(since: number): UsageSum[] {
    const rows = this.db
      .prepare(
        `SELECT harness, model, effort, COUNT(*) AS requests,
                SUM(input) AS input, SUM(cached) AS cached, SUM(output) AS output
         FROM agent_usage WHERE at >= ?
         GROUP BY harness, model, effort
         ORDER BY requests DESC, harness, model, effort`,
      )
      .all(since) as unknown as UsageSum[];
    return rows.filter((r) => HARNESSES.includes(r.harness));
  }

  // ---- turns: what the bar shows of a thread ----

  addTurn(t: TurnRow): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO agent_turns (job, thread, request, reply, label, state, at, extra, device) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      )
      .run(t.job, t.thread, t.request, t.reply, t.label, t.state, t.at, t.extra, t.device ?? null);
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
        'SELECT thread, job, request, reply, label, state, at, extra, device FROM agent_turns WHERE thread = ? ORDER BY at, rowid',
      )
      .all(thread) as unknown as TurnRow[];
  }

  /** One turn, by its job. */
  turn(job: string): TurnRow | null {
    const row = this.db
      .prepare('SELECT thread, job, request, reply, label, state, at, extra, device FROM agent_turns WHERE job = ?')
      .get(job);
    return (row as unknown as TurnRow | undefined) ?? null;
  }

  /** The turns that weren't over when HO[LO] last stopped (working, or waiting for a click), oldest first. */
  unfinishedTurns(): UnfinishedTurn[] {
    return this.db
      .prepare(
        `SELECT t.thread, t.job, t.request, t.reply, t.label, t.state, t.at, t.extra, t.device,
                th.project AS project, th.current AS current
         FROM agent_turns t LEFT JOIN agent_threads th ON th.id = t.thread
         WHERE t.state IN ('waiting', 'running', 'awaiting')
         ORDER BY t.at, t.rowid`,
      )
      .all() as unknown as UnfinishedTurn[];
  }
}
