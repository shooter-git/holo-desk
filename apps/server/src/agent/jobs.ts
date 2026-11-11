/**
 * The agent's jobs: a request from a device's studio, carried out by a harness the runner starts on
 * this computer. One job runs per song. Each has a token for its tools (valid only while it runs) and
 * belongs to the runner it was handed to: only that runner may say how it goes. Its changes reach only
 * the studio that asked, as one undo step; when its turn is done the studio saves, and the song as
 * saved is what the agent saw, for "since your last reply" next time.
 *
 * A job is `waiting` until the runner or its tools are first heard from, then `running`. It ends
 * `done`, `awaiting` (it asked for a permission: the user's click starts the follow-up), `failed`
 * (the harness failed, the runner dropped, it ran out of time) or `cancelled` (Stop, the requester
 * opened another song or undid the job's change, the device was removed, the agent turned off).
 */
import { randomBytes } from 'node:crypto';
import { SCAN_ID, type Scan } from '@holo/score';
import { applyOps, barToTick, type MiddleC, type Op, type Project, parseProject } from '@holo/session';
import type { Store } from '../db.ts';
import { type AgentHooks, type Live, type LiveClient, NO_ANSWER } from '../live.ts';
import { hashToken, newToken, sameHash } from './auth.ts';
import {
  type AttachmentInfo,
  buildPrompt,
  contextLines,
  oneLine,
  type Permission,
  type PermissionKind,
  permissionFollowUp,
  presetRequest,
  presetTitle,
  type RequestContext,
  readRules,
  type ScanPreset,
  sinceLines,
} from './prompt.ts';
import { type AgentStore, HARNESSES, type HarnessId, type ThreadRow } from './store.ts';
import type { Threads } from './threads.ts';

export type JobState = 'waiting' | 'running' | 'awaiting' | 'done' | 'failed' | 'cancelled';

/** A line of a hand-off brief the studio flags: a command to run, or a link. */
export interface BriefWarning {
  /** Its index in the brief's lines (from 0). */
  line: number;
  kind: 'command' | 'url';
}

/** A job as the studios see it (docs/agent.md). */
export interface JobView {
  id: string;
  project: string;
  device: string;
  state: JobState;
  request: string;
  line?: string;
  reply?: string;
  label?: string;
  permission?: Permission;
  brief?: string;
  briefWarnings?: BriefWarning[];
  error?: string;
  started: number;
  finished?: number;
}

/** A harness on the runner's computer, as the runner reports it. */
export interface HarnessInfo {
  id: HarnessId;
  name: string;
  found: boolean;
  version?: string;
  signedIn?: boolean;
  account?: string;
  update?: { available: boolean; latest?: string };
  sealed: boolean;
  reason?: string;
  models?: string[];
  efforts?: string[];
}

/** A job as the server keeps it. */
export interface AgentJob {
  view: JobView;
  thread: string;
  harness: HarnessId;
  /** sha256 of its tools' token; null once revoked. */
  tokenHash: string | null;
  preset: ScanPreset | null;
  /** What it asked the user to allow during its turn: it waits for them once the turn ends. */
  asked: Permission | null;
  /** Batches applied here (a scan preset whose studio went away), each once: their revisions. */
  batches: Map<string, number>;
  /** Its wall clock, and the countdown once its runner dropped. */
  clock: NodeJS.Timeout | null;
  dropped: NodeJS.Timeout | null;
  /** Its turn is over: the studio is saving, and the song is being read. */
  ending: boolean;
}

/** A refusal: the HTTP status, the words the studio (or the agent) shows, and a reason it can act on. */
export class Refusal extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/** A model or effort as the harnesses take them (passed as `--opt=value`, so nothing that reads as more). */
export const MODEL = /^[A-Za-z0-9][\w.:\-[\]=]{0,79}$/;
export const JOB_ID = /^agj_[0-9a-f]{12}$/;

const MINUTE = 60_000;

export interface Limits {
  /** A request's wall clock, and a scan preset's. */
  clockMs: number;
  scanClockMs: number;
  /** How long a job outlives its runner's connection. */
  droppedMs: number;
  /** How long the studio has to save, and to apply a batch of changes. */
  flushMs: number;
  opsMs: number;
}

export const LIMITS: Limits = {
  clockMs: 10 * MINUTE,
  scanClockMs: 45 * MINUTE,
  droppedMs: 15_000,
  flushMs: 10_000,
  opsMs: 60_000,
};

export interface JobsOptions {
  live: Live;
  store: Store;
  agentStore: AgentStore;
  threads: Threads;
  /** HO[LO]'s folder (where packages/agent/AGENT.md is). */
  repoDir: string;
  /** The URL the agent's tools reach this server at. */
  base: () => string;
  scan: (id: string) => Scan | null;
  /** An attachment of a song's (step C13); none until then. */
  attachment?: (id: string, project: string) => AttachmentInfo | null;
  /** The device an agent token belongs to, and whether a device is still allowed. */
  deviceFor: (token: string) => string | null;
  allowed: (device: string) => boolean;
  limits?: Partial<Limits>;
}

/** What a request asks for, checked by its route. */
export interface NewRequest {
  project: string;
  text: string;
  context?: RequestContext;
  attachments: string[];
  preset: ScanPreset | null;
}

const LIVE: ReadonlySet<JobState> = new Set(['waiting', 'running']);
const isLive = (job: AgentJob) => LIVE.has(job.view.state);
const HARNESS_NAMES: Record<HarnessId, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor' };

export class Jobs implements AgentHooks {
  private readonly o: JobsOptions;
  private readonly limits: Limits;
  private readonly jobs = new Map<string, AgentJob>();
  /** The runner each job was handed to: only it may say how the job goes. */
  private readonly assigned = new WeakMap<AgentJob, LiveClient>();
  /** What each runner said it has. */
  private readonly reported = new WeakMap<LiveClient, HarnessInfo[]>();
  /** Songs a request is being started on (it waits for the studio to save first). */
  private readonly starting = new Set<string>();

  constructor(options: JobsOptions) {
    this.o = options;
    this.limits = { ...LIMITS, ...options.limits };
  }

  get(id: string): AgentJob | null {
    return this.jobs.get(id) ?? null;
  }

  /** The song's job that's running (or about to), if one is. */
  running(project: string): AgentJob | null {
    for (const job of this.jobs.values()) if (job.view.project === project && isLive(job)) return job;
    return null;
  }

  // ---- harnesses ----

  /** Each harness as the runners report it (the best report of each). */
  harnesses(): HarnessInfo[] {
    const out: HarnessInfo[] = [];
    for (const id of HARNESSES) {
      let best: HarnessInfo | null = null;
      for (const runner of this.o.live.agentRunners()) {
        const h = this.reported.get(runner)?.find((x) => x.id === id);
        if (h && (!best || rank(h) > rank(best))) best = h;
      }
      if (best) out.push(best);
    }
    return out;
  }

  /** The runner to hand a harness's job (or sign-in) to: one that has it, sealed, signed in if it can be. */
  private runnerFor(harness: HarnessId): { runner: LiveClient; info: HarnessInfo } | null {
    let found: { runner: LiveClient; info: HarnessInfo } | null = null;
    for (const runner of this.o.live.agentRunners()) {
      const info = this.reported.get(runner)?.find((x) => x.id === harness && x.found);
      if (info && (!found || rank(info) > rank(found.info))) found = { runner, info };
    }
    return found;
  }

  /** The harness a request runs with, and its runner; or why there's none. */
  private pick(wanted: HarnessId | null): { harness: HarnessId; runner: LiveClient } {
    if (!this.o.live.agentRunners().length)
      throw new Refusal(
        409,
        'The agent runs through the runner on this computer: start it with pnpm runner',
        'no-runner',
      );
    // none chosen: the first that can be sealed, else the first found (whose refusal then says why)
    const sealed = HARNESSES.filter((id) => this.runnerFor(id)?.info.sealed);
    const ids = wanted ? [wanted] : sealed.length ? sealed : HARNESSES.filter((id) => this.runnerFor(id));
    const harness = ids[0];
    const found = harness ? this.runnerFor(harness) : null;
    if (!harness || !found)
      throw new Refusal(
        409,
        wanted
          ? `${HARNESS_NAMES[wanted]} isn’t on this computer: pick another harness in Settings › Agent`
          : 'No harness is on this computer: install Claude Code, Codex or Cursor',
        'no-harness',
      );
    if (!found.info.sealed)
      throw new Refusal(
        409,
        `${HARNESS_NAMES[harness]} can’t be limited to HO[LO]’s tools${found.info.reason ? `: ${found.info.reason}` : ''}`,
        'not-sealed',
      );
    if (found.info.signedIn === false)
      throw new Refusal(409, `${HARNESS_NAMES[harness]} is signed out: sign in in Settings › Agent`, 'signed-out');
    return { harness, runner: found.runner };
  }

  /** Ask the runners to look for harnesses again, or a harness's runner to sign in, take a code, or update. */
  relay(action: 'refresh' | 'login' | 'login-code' | 'update', harness?: HarnessId, code?: string): void {
    if (action === 'refresh') {
      const runners = this.o.live.agentRunners();
      if (!runners.length) throw new Refusal(409, 'Start the runner on this computer: pnpm runner', 'no-runner');
      for (const r of runners) this.o.live.sendTo(r, { type: 'agent-refresh' });
      return;
    }
    if (!harness) throw new Refusal(400, 'Which harness?');
    const found = this.runnerFor(harness);
    if (!found) throw new Refusal(409, `${HARNESS_NAMES[harness]} isn’t on this computer`, 'no-harness');
    if (action !== 'login-code' && [...this.jobs.values()].some((j) => j.harness === harness && isLive(j)))
      throw new Refusal(409, `${HARNESS_NAMES[harness]} is working on a request: try once it’s done`, 'busy');
    if (action === 'login') {
      // HO[LO] only signs in a harness that's signed out: it never signs out or switches accounts
      if (found.info.signedIn === true) throw new Refusal(409, `${HARNESS_NAMES[harness]} is signed in already`);
      this.o.live.sendTo(found.runner, { type: 'agent-login', harness });
    } else if (action === 'login-code') this.o.live.sendTo(found.runner, { type: 'agent-login-code', harness, code });
    else this.o.live.sendTo(found.runner, { type: 'agent-update', harness });
  }

  // ---- requests ----

  /** Start a request on the song a device's studio has open: the job's id. */
  async request(device: string, req: NewRequest): Promise<string> {
    const song = this.o.store.get(req.project);
    if (!song) throw new Refusal(404, 'No such song');
    if (!this.o.live.studioFor(device, req.project))
      throw new Refusal(409, 'Open the song in this studio first', 'not-open');
    this.free(req.project);
    if (req.preset) {
      const scan = this.o.scan(req.preset.scan);
      if (!scan || scan.project !== req.project) throw new Refusal(404, 'No such scan for this song');
    }
    if (req.context?.scan) {
      const scan = this.o.scan(req.context.scan);
      if (!scan || scan.project !== req.project) delete req.context.scan;
    }
    const attachments: AttachmentInfo[] = [];
    for (const id of req.attachments) {
      const a = this.o.attachment?.(id, req.project) ?? null;
      if (!a) throw new Refusal(400, `No such attachment: ${id}`);
      attachments.push({ id, name: a.name, type: a.type });
    }
    const settings = this.o.agentStore.settings();
    const { harness, runner } = this.pick(settings.harness);
    const thread = this.o.threads.forRequest(req.project, harness);
    const request = req.preset ? presetTitle(req.preset) : req.text;
    return this.begin(device, req.project, thread, runner, request, req.preset, async (now) =>
      buildPrompt({
        rules: readRules(this.o.repoDir),
        since: this.since(thread.id, now),
        context: contextLines(req.context, now),
        attachments,
        request: req.preset ? presetRequest(req.preset) : req.text,
      }),
    );
  }

  /** There's no job running on a song (or being started), or a refusal. */
  private free(project: string): void {
    if (this.running(project) || this.starting.has(project))
      throw new Refusal(409, 'Still working on this song', 'busy');
  }

  /** What the agent hears of first: what the user did since its last reply, and how the song changed. */
  private since(threadId: string, now: Project): string[] | null {
    const thread = this.o.threads.get(threadId);
    if (!thread) return null;
    return sinceLines(this.o.threads.events(thread), this.o.threads.seenSong(thread), now, this.middleC());
  }

  private middleC(): MiddleC {
    return this.o.store.setting('middleC') === 'C4' ? 'C4' : 'C3';
  }

  /**
   * The start of a job: the studio saves, a restore point is taken, the prompt is made from the song
   * as it is now, and the runner is handed the job with its token.
   */
  private async begin(
    device: string,
    project: string,
    thread: ThreadRow,
    runner: LiveClient,
    request: string,
    preset: ScanPreset | null,
    prompt: (now: Project) => Promise<string>,
  ): Promise<string> {
    this.starting.add(project);
    let job: AgentJob;
    try {
      await this.flush(device, project);
      const now = this.o.store.get(project);
      if (!now) throw new Refusal(404, 'No such song');
      // a restore point, whatever the agent does
      this.o.store.snapshotNow(project, 'Agent');
      const text = await prompt(now);
      const settings = this.o.agentStore.settings();
      const token = newToken();
      job = {
        view: {
          id: `agj_${randomBytes(6).toString('hex')}`,
          project,
          device,
          state: 'waiting',
          request,
          started: Date.now(),
        },
        thread: thread.id,
        harness: thread.harness,
        tokenHash: hashToken(token),
        preset,
        asked: null,
        batches: new Map(),
        clock: null,
        dropped: null,
        ending: false,
      };
      // the runner may have gone while the studio saved
      if (!this.o.live.agentRunners().includes(runner))
        throw new Refusal(409, 'The runner disconnected: start it again with pnpm runner', 'no-runner');
      this.jobs.set(job.view.id, job);
      this.assigned.set(job, runner);
      const current = this.o.threads.get(thread.id);
      this.o.live.sendTo(runner, {
        type: 'agent-run',
        job: job.view.id,
        thread: thread.id,
        harness: thread.harness,
        model: settings.model,
        effort: settings.effort,
        prompt: text,
        token,
        ...(current?.session ? { session: current.session } : {}),
        workspace: thread.id,
        base: this.o.base(),
      });
    } finally {
      this.starting.delete(project);
    }
    // what the user did is told now: it starts again from none
    this.o.threads.clearEvents(thread.id);
    this.o.agentStore.addTurn({
      thread: thread.id,
      job: job.view.id,
      request,
      reply: null,
      label: null,
      state: job.view.state,
      at: job.view.started,
    });
    job.clock = setTimeout(
      () =>
        this.end(
          job,
          'failed',
          `It took longer than ${Math.round((preset ? this.limits.scanClockMs : this.limits.clockMs) / MINUTE)} minutes`,
          true,
        ),
      preset ? this.limits.scanClockMs : this.limits.clockMs,
    );
    job.clock.unref?.();
    // a permission still waiting on this song is passed over by the new request
    for (const other of this.jobs.values()) {
      if (other !== job && other.view.project === project && other.view.state === 'awaiting') {
        other.view.state = 'done';
        this.o.agentStore.updateTurn(other.view.id, { state: 'done' });
        this.tell(other);
      }
    }
    this.prune();
    this.tell(job);
    return job.view.id;
  }

  /** The studio saves now (it answers once it has, or in at most 10 s). */
  private async flush(device: string, project: string): Promise<void> {
    const studio = this.o.live.studioFor(device, project);
    if (studio) await this.o.live.request(studio, { type: 'agent-flush' }, this.limits.flushMs);
  }

  // ---- the user's answers ----

  /** Stop a job (any allowed device may), or dismiss one waiting for a permission. */
  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) throw new Refusal(404, 'No such job');
    if (job.view.state === 'awaiting') {
      job.view.state = 'cancelled';
      this.o.agentStore.updateTurn(job.view.id, { state: 'cancelled' });
      this.tell(job);
      return;
    }
    if (!isLive(job)) throw new Refusal(409, 'That job has ended');
    this.end(job, 'cancelled', 'Stopped', true);
  }

  /**
   * The user's answer to what the job asked: allowed, the follow-up starts on the same thread (the
   * same harness session) with what happened; not, it ends with "Not now".
   */
  async permit(device: string, id: string, grant: boolean, result: string): Promise<string | null> {
    const job = this.jobs.get(id);
    if (!job) throw new Refusal(404, 'No such job');
    if (job.view.device !== device) throw new Refusal(403, 'Only the device that asked can answer');
    const permission = job.view.permission;
    if (job.view.state !== 'awaiting' || !permission) throw new Refusal(409, 'That job isn’t waiting for an answer');
    if (!grant) {
      job.view.state = 'done';
      job.view.reply = 'Not now';
      this.o.threads.addEventTo(job.thread, { action: 'denied', label: permission.detail, at: Date.now() });
      this.o.agentStore.updateTurn(job.view.id, { state: 'done', reply: job.view.reply });
      this.tell(job);
      return null;
    }
    const thread = this.o.threads.get(job.thread);
    if (!thread) throw new Refusal(409, 'That conversation was started over');
    if (!this.o.live.studioFor(device, job.view.project))
      throw new Refusal(409, 'Open the song in this studio first', 'not-open');
    this.free(job.view.project);
    const found = this.runnerFor(thread.harness);
    if (!found) throw new Refusal(409, `${HARNESS_NAMES[thread.harness]} isn’t available now`, 'no-harness');
    const next = await this.begin(
      device,
      job.view.project,
      thread,
      found.runner,
      job.view.request,
      job.preset,
      async (now) =>
        buildPrompt({
          rules: readRules(this.o.repoDir),
          since: this.since(thread.id, now),
          context: [],
          attachments: [],
          request: permissionFollowUp(permission, result, job.view.request),
        }),
    );
    if (job.view.state === 'awaiting') {
      job.view.state = 'done';
      this.o.agentStore.updateTurn(job.view.id, { state: 'done' });
      this.tell(job);
    }
    return next;
  }

  /** A device was removed: its jobs stop at once. */
  deviceRemoved(device: string): void {
    for (const job of this.jobs.values()) {
      if (job.view.device !== device) continue;
      if (isLive(job)) this.end(job, 'cancelled', 'This device was removed', true);
      else if (job.view.state === 'awaiting') {
        job.view.state = 'cancelled';
        this.tell(job);
      }
    }
  }

  /** The agent was turned off: every job stops. */
  stopAll(why: string): void {
    for (const job of this.jobs.values()) {
      if (isLive(job)) this.end(job, 'cancelled', why, true);
      else if (job.view.state === 'awaiting') {
        job.view.state = 'cancelled';
        this.tell(job);
      }
    }
  }

  /** The server is closing: no clock keeps it up. */
  close(): void {
    for (const job of this.jobs.values()) this.clearTimers(job);
  }

  // ---- the end of a job ----

  /**
   * A job ends early: its runner is told to stop (when `cancel`), its token stops working, and the
   * agent hears next time that its turn didn't finish.
   */
  private end(job: AgentJob, state: 'cancelled' | 'failed', why: string, cancel: boolean): void {
    if (!isLive(job)) return;
    const runner = this.assigned.get(job);
    if (cancel && runner) this.o.live.sendTo(runner, { type: 'agent-cancel', job: job.view.id });
    job.tokenHash = null;
    this.clearTimers(job);
    job.view.state = state;
    job.view.error = oneLine(why, 500);
    job.view.finished = Date.now();
    this.o.threads.addEventTo(job.thread, {
      action: state === 'failed' ? 'failed' : 'stopped',
      label: job.view.error,
      at: Date.now(),
    });
    this.o.agentStore.updateTurn(job.view.id, {
      state,
      reply: job.view.reply ?? null,
      label: job.view.label ?? null,
    });
    this.tell(job);
  }

  /** The harness finished its turn: the studio saves, and the song as saved is what the agent saw. */
  private async turnDone(job: AgentJob): Promise<void> {
    if (!isLive(job) || job.ending) return;
    job.ending = true;
    // the harness has exited: its tools are done
    job.tokenHash = null;
    this.clearTimers(job);
    await this.flush(job.view.device, job.view.project);
    // (stopped while the studio saved)
    if (!isLive(job)) return;
    const song = this.o.store.get(job.view.project);
    if (song) this.o.threads.seen(job.thread, song);
    job.view.state = job.asked ? 'awaiting' : 'done';
    if (job.asked) job.view.permission = job.asked;
    job.view.finished = Date.now();
    this.o.agentStore.updateTurn(job.view.id, {
      state: job.view.state,
      reply: job.view.reply ?? null,
      label: job.view.label ?? null,
    });
    this.tell(job);
  }

  private clearTimers(job: AgentJob): void {
    if (job.clock) clearTimeout(job.clock);
    if (job.dropped) clearTimeout(job.dropped);
    job.clock = null;
    job.dropped = null;
  }

  /** The studios that hear how a job goes: the requester's, and allowed devices with its song open. */
  private tell(job: AgentJob): void {
    this.o.live.toDevices(
      { type: 'agent-status', job: job.view },
      (c) => c.device === job.view.device || c.state?.project === job.view.project,
    );
  }

  /** Jobs that ended are kept a while (the last 50), the others always. */
  private prune(): void {
    const ended = [...this.jobs.values()].filter((j) => !isLive(j) && j.view.state !== 'awaiting');
    for (const job of ended.slice(0, -50)) this.jobs.delete(job.view.id);
  }

  // ---- the live channel (AgentHooks) ----

  device(token: string): string | null {
    return this.o.deviceFor(token);
  }

  message(client: LiveClient, msg: Record<string, unknown>): void {
    if (msg.type === 'history') {
      this.history(client, msg);
      return;
    }
    // everything else comes from a runner with the key
    if (client.role !== 'runner' || !client.keyed) return;
    if (msg.type === 'harnesses') {
      this.reported.set(client, parseHarnesses(msg.list));
      return;
    }
    if (msg.type === 'agent-harness') {
      const relay = parseHarnessEvent(msg);
      if (relay) this.o.live.toDevices({ type: 'agent-harness', ...relay });
      return;
    }
    const job = typeof msg.job === 'string' ? this.jobs.get(msg.job) : undefined;
    // only from the runner it was handed to, and only while it runs
    if (!job || this.assigned.get(job) !== client || !isLive(job) || job.ending) return;
    switch (msg.type) {
      case 'agent-progress':
        job.view.state = 'running';
        job.view.line = oneLine(String(msg.line ?? ''), 200);
        this.tell(job);
        break;
      case 'agent-session':
        if (typeof msg.session === 'string' && /^[A-Za-z0-9][\w.:-]{0,199}$/.test(msg.session)) {
          this.o.threads.setSession(job.thread, msg.session);
          if (job.view.state === 'waiting') {
            job.view.state = 'running';
            this.tell(job);
          }
        }
        break;
      case 'agent-done':
        void this.turnDone(job);
        break;
      case 'agent-failed':
        this.end(job, 'failed', typeof msg.error === 'string' && msg.error ? msg.error : 'The agent stopped', false);
        break;
    }
  }

  /**
   * A studio undid, redid or made a step: the agent hears of it before its next reply. Undoing a step
   * of the device's own running job stops that job.
   */
  private history(client: LiveClient, msg: Record<string, unknown>): void {
    if (client.role !== 'editor' || !client.device) return;
    if (!this.o.allowed(client.device)) {
      this.o.live.downgrade(client.device);
      return;
    }
    const action = msg.action;
    if (action !== 'undo' && action !== 'redo' && action !== 'step') return;
    const project = client.state?.project;
    if (!project || typeof msg.label !== 'string') return;
    const job = typeof msg.job === 'string' && JOB_ID.test(msg.job) ? this.jobs.get(msg.job) : undefined;
    const ours = job?.view.project === project ? job : undefined;
    this.o.threads.addEvent(project, {
      action,
      label: oneLine(msg.label, 120),
      ...(ours ? { agent: true } : {}),
      at: Date.now(),
    });
    if (action === 'undo' && ours && isLive(ours) && ours.view.device === client.device)
      this.end(ours, 'cancelled', 'You undid its change', true);
  }

  state(client: LiveClient, was: string | null): void {
    const device = client.device;
    const now = client.state?.project ?? null;
    if (!device || !was || was === now) return;
    for (const job of this.jobs.values()) {
      // a scan preset carries on without the studio (its changes are saved here, with a restore point)
      if (job.view.device !== device || job.view.project !== was || !isLive(job) || job.preset) continue;
      if (!this.o.live.studioFor(device, was)) this.end(job, 'cancelled', 'You opened another song', true);
    }
  }

  gone(client: LiveClient): void {
    if (client.role !== 'runner') return;
    for (const job of this.jobs.values()) {
      if (this.assigned.get(job) !== client || !isLive(job) || job.dropped) continue;
      job.dropped = setTimeout(() => this.end(job, 'failed', 'The runner disconnected', false), this.limits.droppedMs);
      job.dropped.unref?.();
    }
  }

  // ---- the job's tools (/api/agent/jobs/:job/*) ----

  /** The job a tool's token is for, while it runs; null otherwise (the same either way it fails). */
  forTool(id: string, token: string): AgentJob | null {
    const job = this.jobs.get(id);
    if (!job || !isLive(job) || job.ending) return null;
    const hash = hashToken(token);
    if (!job.tokenHash || !sameHash(hash, job.tokenHash)) return null;
    if (job.view.state === 'waiting') {
      job.view.state = 'running';
      this.tell(job);
    }
    return job;
  }

  /** The requester's studio, while it has the job's song open. */
  studio(job: AgentJob): LiveClient | null {
    return this.o.live.studioFor(job.view.device, job.view.project);
  }

  /** The song as the studio has it now (it saves first, so nothing it applied is missed). */
  async song(job: AgentJob): Promise<Project> {
    await this.flush(job.view.device, job.view.project);
    const song = this.o.store.get(job.view.project);
    if (!song) throw new Refusal(404, 'The song is gone');
    return song;
  }

  /** What the requester's studio shows: the playhead, the selection, the cycle, the view. */
  studioState(job: AgentJob): Record<string, unknown> {
    const studio = this.studio(job);
    const s = studio?.state;
    if (!s) throw new Refusal(403, 'The song isn’t open in the studio that asked');
    const extra = s as unknown as Record<string, unknown>;
    return {
      playhead: s.tick,
      position: s.position,
      playing: s.playing,
      recording: s.recording,
      bpm: s.bpm,
      selection: s.selection,
      cycle: s.cycle,
      middleC: s.middleC,
      ...(typeof extra.view === 'string' ? { view: extra.view.slice(0, 40) } : {}),
      ...(typeof extra.scan === 'string' && SCAN_ID.test(extra.scan) ? { scan: extra.scan } : {}),
    };
  }

  /**
   * A batch of the job's changes, for the requester's studio (one undo step with the rest of the
   * job's), answered once it's applied. Never applied here, except for a scan preset whose studio
   * went away: then it's saved as a revision of the agent's, as a scan read always was.
   */
  async ops(job: AgentJob, ops: Op[], label: string, batch: string): Promise<{ ok: true; revision?: number }> {
    const studio = this.studio(job);
    if (studio) {
      const answer = await this.o.live.request(
        studio,
        { type: 'agent-ops', project: job.view.project, job: job.view.id, batch, ops, label },
        this.limits.opsMs,
      );
      if (!answer.ok)
        throw new Refusal(answer.error === NO_ANSWER ? 504 : 400, answer.error ?? 'The studio refused the change');
      return typeof answer.revision === 'number' ? { ok: true, revision: answer.revision } : { ok: true };
    }
    if (!job.preset) throw new Refusal(403, 'The song isn’t open in the studio that asked');
    const done = job.batches.get(batch);
    if (done !== undefined) return { ok: true, revision: done };
    const song = this.o.store.get(job.view.project);
    if (!song) throw new Refusal(404, 'The song is gone');
    let next: Project;
    try {
      next = parseProject(applyOps(song, ops));
    } catch (err) {
      throw new Refusal(400, err instanceof Error ? err.message : String(err));
    }
    const saved = this.o.store.save(next, song.revision, 'Agent');
    if (!saved) throw new Refusal(409, 'Changed while applying; try again');
    job.batches.set(batch, saved.revision);
    this.o.live.tell({ type: 'saved', project: saved.id, revision: saved.revision });
    return { ok: true, revision: saved.revision };
  }

  /** Play, stop, or move the playhead to a bar, in the requester's studio. */
  async transport(job: AgentJob, action: 'play' | 'stop' | 'locate', bar?: number): Promise<{ ok: boolean }> {
    const studio = this.studio(job);
    if (!studio) throw new Refusal(403, 'The song isn’t open in the studio that asked');
    let at: number | undefined;
    if (bar !== undefined) {
      const song = this.o.store.get(job.view.project);
      if (!song) throw new Refusal(404, 'The song is gone');
      at = barToTick(song.meter, bar);
    }
    const answer = await this.o.live.request(studio, {
      type: 'transport',
      action,
      ...(at !== undefined ? { at } : {}),
    });
    if (!answer.ok) throw new Refusal(409, answer.error ?? 'The studio couldn’t do that');
    return { ok: true };
  }

  /** Notes played in the requester's studio now (not recorded). */
  audition(job: AgentJob, events: number[][], track?: string): void {
    const studio = this.studio(job);
    if (!studio) throw new Refusal(403, 'The song isn’t open in the studio that asked');
    this.o.live.sendTo(studio, { type: 'play-notes', events, track: track ?? null, port: 'Agent' });
  }

  /** A line under the bar while the agent works. */
  progress(job: AgentJob, line: string): void {
    job.view.state = 'running';
    job.view.line = oneLine(line, 200);
    this.tell(job);
  }

  /** The agent asks the user to allow something: the job waits for them once its turn ends. */
  permission(job: AgentJob, permission: Permission): void {
    job.asked = permission;
  }

  /** A brief for the user's own harness, shown in full with its commands and links flagged. */
  handoff(job: AgentJob, brief: string): void {
    job.view.brief = brief;
    const warnings = briefWarnings(brief);
    if (warnings.length) job.view.briefWarnings = warnings;
    else delete job.view.briefWarnings;
    this.tell(job);
  }

  /** The undo step's label and the reply under the bar. */
  finish(job: AgentJob, label: string, reply: string): void {
    job.view.label = label;
    job.view.reply = reply;
    this.o.agentStore.updateTurn(job.view.id, { label, reply });
  }
}

/** Which report of a harness says most: found, then sealed, then signed in. */
function rank(h: HarnessInfo): number {
  return (h.found ? 4 : 0) + (h.sealed ? 2 : 0) + (h.signedIn !== false ? 1 : 0);
}

/** Programs a brief might ask the user to run (as typed in a terminal: lower case). */
const SHELL =
  '(?:sudo|curl|wget|rm|chmod|chown|npm|npx|pnpm|yarn|node|python3?|pip3?|git|bash|sh|zsh|powershell|pwsh|iex|eval|brew|apt(?:-get)?|docker|cargo)';
/** A line that runs something: a shell prompt, a program and its arguments (in code or not), pipes into a shell, chains. */
const COMMAND = new RegExp(`(^\\s*\\$\\s)|(^\\s*${SHELL}\\s)|(\`\\s*${SHELL}\\b)|(\\|\\s*(?:ba|z)?sh\\b)|&&|\\$\\(`);
const LINK = /\b(https?|ftp|file):\/\/|\bwww\.[a-z0-9-]+\.[a-z]/i;

/** The lines of a brief the user should read twice before pasting: commands, and links. */
export function briefWarnings(brief: string): BriefWarning[] {
  const out: BriefWarning[] = [];
  for (const [line, text] of brief.split('\n').entries()) {
    if (LINK.test(text)) out.push({ line, kind: 'url' });
    else if (COMMAND.test(text)) out.push({ line, kind: 'command' });
  }
  return out;
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 ? oneLine(v, max) : undefined;

/** The harnesses a runner reports, checked: what's not as it should be is left out. */
export function parseHarnesses(list: unknown): HarnessInfo[] {
  if (!Array.isArray(list)) return [];
  const out: HarnessInfo[] = [];
  for (const raw of list.slice(0, 10)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const h = raw as Record<string, unknown>;
    if (!HARNESSES.includes(h.id as HarnessId) || out.some((x) => x.id === h.id)) continue;
    const info: HarnessInfo = {
      id: h.id as HarnessId,
      name: str(h.name, 40) ?? HARNESS_NAMES[h.id as HarnessId],
      found: h.found === true,
      sealed: h.sealed === true,
    };
    const version = str(h.version, 80);
    if (version) info.version = version;
    if (typeof h.signedIn === 'boolean') info.signedIn = h.signedIn;
    const account = str(h.account, 120);
    if (account) info.account = account;
    if (typeof h.update === 'object' && h.update !== null) {
      const u = h.update as Record<string, unknown>;
      const latest = str(u.latest, 80);
      info.update = { available: u.available === true, ...(latest ? { latest } : {}) };
    }
    const reason = str(h.reason, 300);
    if (reason) info.reason = reason;
    for (const key of ['models', 'efforts'] as const) {
      const values = h[key];
      if (Array.isArray(values))
        info[key] = values.filter((m): m is string => typeof m === 'string' && MODEL.test(m)).slice(0, 50);
    }
    out.push(info);
  }
  return out;
}

/** How a sign-in, update or refresh goes, from the runner, checked before the studios see it. */
export function parseHarnessEvent(msg: Record<string, unknown>): Record<string, unknown> | null {
  if (!HARNESSES.includes(msg.harness as HarnessId)) return null;
  if (msg.kind !== 'login' && msg.kind !== 'update' && msg.kind !== 'refresh') return null;
  if (msg.state !== 'running' && msg.state !== 'done' && msg.state !== 'failed') return null;
  const out: Record<string, unknown> = { harness: msg.harness, kind: msg.kind, state: msg.state };
  if (typeof msg.url === 'string' && msg.url.length <= 500) {
    try {
      const url = new URL(msg.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') out.url = url.href;
    } catch {
      // not a link: left out
    }
  }
  if (typeof msg.code === 'string' && /^[\x21-\x7e]{1,64}$/.test(msg.code)) out.code = msg.code;
  if (msg.ask === 'code') out.ask = 'code';
  const line = str(msg.line, 200);
  if (line) out.line = line;
  const error = str(msg.error, 500);
  if (error) out.error = error;
  return out;
}

export const PERMISSION_KINDS: readonly PermissionKind[] = ['install-pack', 'send-creation', 'screen', 'photo'];
