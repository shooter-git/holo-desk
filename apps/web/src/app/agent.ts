/**
 * The in-app agent, as the studio sees it (docs/agent.md): whether it's on for this device, its
 * settings and devices, the open song's conversation, and the jobs asked for here (followed across a
 * reload, so a page the browser let go comes back to them). While it's off, or this device isn't
 * allowed, nothing of it shows, reports or asks anything.
 *
 * The device's token is kept apart from the view this device remembers (`holo:view`), in a key of its
 * own, and goes only to HO[LO]'s host: as the bearer of the agent's routes, and in each live hello.
 */
import type { HarnessLimits, RunUsage } from '@holo/agent/limits';
import type { Go, View } from '@holo/agent/view';
import { type Project, parseProject } from '@holo/session';
import { useSyncExternalStore } from 'react';
import { IDLE_MS, patiently } from './api.ts';
import type { Ready } from './attach.ts';
import { type Command, selectionSpan } from './commands.ts';
import { diskSize } from './disk-size.ts';
import { shownNoteView } from './note-view.ts';
import { type AppState, store as studio } from './store.ts';

export type HarnessId = 'claude' | 'codex' | 'cursor' | 'antigravity';

/** A harness on the runner's computer, as the runner reports it. */
export interface HarnessInfo {
  id: HarnessId;
  name: string;
  found: boolean;
  version?: string;
  signedIn?: boolean;
  account?: string;
  /** The account's plan, in its vendor's word for it ("max", "Pro+"), when the harness says. */
  plan?: string;
  /**
   * What the account has left, as its vendor reports it: read as Settings › Agent opens and after each
   * of its requests (Claude Code says it only with a request). None for one that doesn't report it (Cursor).
   */
  limits?: HarnessLimits;
  update?: { available: boolean; latest?: string };
  /** It can be limited to HO[LO]'s tools; when not, it can't be used, and `reason` says why. */
  sealed: boolean;
  /**
   * Whether it can be limited is checked once it's signed in (Cursor asks for its sign-in first;
   * Antigravity's check would start a browser sign-in).
   */
  sealUnknown?: boolean;
  reason?: string;
  models?: string[];
  efforts?: string[];
  /**
   * By model: the efforts it takes, when the models don't all take the same (Antigravity, Codex). A
   * model listed with none takes none: its effort comes with it.
   */
  modelEfforts?: Record<string, string[]>;
  /** What a run uses when Model is left empty: the harness's own default, as it lists it. */
  defaultModel?: string;
  /** By model: the effort a run uses when Effort is left empty. */
  defaultEfforts?: Record<string, string>;
  /** By alias: the model it stood for at its last run (Claude Code's `opus`). */
  aliases?: Record<string, string>;
  /** It lists no defaults (Claude Code): it runs only with a model and an effort chosen. */
  mustChoose?: boolean;
  /** The computer it's on (the runner's). */
  host?: string;
  /** Not installed: the official installer Install runs there. */
  installer?: string;
}

/** What the requests that ran with one model and effort of a harness used, added up. */
export interface UsageSum extends RunUsage {
  harness: HarnessId;
  /** The model they ran with (empty: the harness's own, when it doesn't name it). */
  model: string;
  effort: string;
  requests: number;
}

export interface AgentSettings {
  enabled: boolean;
  harness: HarnessId | null;
  model: string;
  effort: string;
  harnesses: HarnessInfo[];
  /** What the requests of the last `days` days used, as their harnesses counted it, by harness and model. */
  usage?: { days: number; rows: UsageSum[] };
  /** Sign-ins, updates and installs under way, as the host has them (shown again after a reload, or on another device). */
  relays?: HarnessEvent[];
}

/** What the host says of the agent, to anyone: on or off, this device allowed, the first device still to pair. */
export interface AgentInfo {
  enabled: boolean;
  allowed: boolean;
  pairing: boolean;
  /**
   * The runners: `ready` (one with the key), `old` (from before keys), `no-key` (one that can't read
   * it), `wrong-key` (another HO[LO]'s), `none`. `host` is the runner's computer, told only to an allowed device.
   */
  runner: { connected: boolean; keyed: boolean; state?: RunnerState; host?: string };
}

export type RunnerState = 'none' | 'ready' | 'old' | 'no-key' | 'wrong-key';

/**
 * Why the agent has no runner to run on, said to an allowed device: none connected, or the one that is
 * from before keys, can't read the key, or has another HO[LO]'s. Nothing when one is ready. (A host
 * from before `state` says only connected or not: one connected without the key is taken as old.)
 */
export function runnerProblem(runner: AgentInfo['runner'] | undefined): string | null {
  if (!runner || runner.keyed) return null;
  const it = `The runner${runner.host ? ` on ${runner.host}` : ''}`;
  const state = runner.state ?? (runner.connected ? 'old' : 'none');
  if (state === 'old')
    return `${it} is from an older HO[LO] than this studio, so the agent can’t use it: bring its checkout up to this version and restart it.`;
  if (state === 'no-key')
    return `${it} can’t read HO[LO]’s runner key: run it from the checkout whose data folder HO[LO] uses (or give it HOLO_RUNNER_KEY).`;
  if (state === 'wrong-key')
    return `${it} has another HO[LO]’s runner key: point its HOLO_DATA_DIR at this HO[LO]’s data folder.`;
  return 'No runner is connected: start it on the computer HO[LO] runs on (pnpm runner; on Linux, pnpm run runner-service on keeps it running). It finds Claude Code, Codex, Cursor and Antigravity.';
}

export type JobState = 'waiting' | 'running' | 'awaiting' | 'done' | 'failed' | 'cancelled';
export type PermissionKind =
  | 'install-pack'
  | 'send-creation'
  | 'bounce'
  | 'stems'
  | 'stems-stacks'
  | 'render'
  | 'screen'
  | 'photo'
  | 'microphone';

export interface Permission {
  kind: PermissionKind;
  detail: string;
  pack?: string;
}

/** Why a line of a brief is flagged: it runs a command, holds a link, or asks for something secret (keys, `.env`…). */
export type BriefWarning = 'command' | 'url' | 'secret';

/** A job as the host tells it (`agent-status`). */
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
  briefWarnings?: { line: number; kind: BriefWarning }[];
  /** What the reply shows under it, and where the studio goes as it arrives (on the device that asked). */
  view?: View;
  go?: Go;
  error?: string;
  started: number;
  finished?: number;
  /** Its song's title as it was asked: how the bar names it while another song is open. */
  title?: string;
  /**
   * The harness it runs with (and the model and effort given it: none, the harness's own), why it
   * didn't go on (when the host knows), and the earlier go it carries on.
   */
  harness?: HarnessId;
  model?: string;
  effort?: string;
  stop?: TurnStop;
  continues?: string;
  /** When the host carries it on by itself, its limit having started again ("Carry on when it resets"). */
  wait?: number;
}

/** A harness with the model and effort it's given (each empty: the harness's own). */
export interface Choice {
  harness: HarnessId;
  model: string;
  effort: string;
}

/**
 * Why a request didn't go on, where the host knows for sure: HO[LO] or its runner stopped under it
 * (`interrupted`), its harness's account is out of usage (till `resets`, when that's known), or the
 * harness is signed out or no longer installed. With the last three, trying again as it is won't help.
 */
export interface TurnStop {
  why: 'interrupted' | 'usage' | 'signed-out' | 'not-installed';
  resets?: number;
}

/** A request and its reply, as the song's conversation keeps them (with what it asked, its brief, why it stopped). */
export interface Turn {
  job: string;
  request: string;
  reply: string | null;
  label: string | null;
  state: string;
  at: number;
  permission?: Permission;
  brief?: string;
  briefWarnings?: { line: number; kind: BriefWarning }[];
  view?: View;
  go?: Go;
  error?: string;
  harness?: HarnessId;
  model?: string;
  effort?: string;
  stop?: TurnStop;
  continues?: string;
  wait?: number;
}

/** How a harness's sign-in, update, install or new look goes, from the runner (`agent-harness`). */
export interface HarnessEvent {
  harness: HarnessId;
  kind: 'login' | 'update' | 'install' | 'refresh';
  state: 'running' | 'done' | 'failed';
  url?: string;
  code?: string;
  ask?: 'code';
  line?: string;
  error?: string;
}

export interface DeviceList {
  devices: { id: string; name: string; added: number; seen: number | null; current: boolean }[];
  requests: { id: string; name: string; code: string; created: number }[];
}

export interface AgentState {
  /** What the host last said; null until it's been asked. */
  info: AgentInfo | null;
  /** This device's id, once allowed. */
  me: string | null;
  settings: AgentSettings | null;
  devices: DeviceList | null;
  harness: Partial<Record<HarnessId, HarnessEvent>>;
  /** The jobs the host has told of, by id. */
  jobs: Record<string, JobView>;
  /**
   * The open song's conversation as the host keeps it (read when the bar opens), with the song's own
   * choice of what it runs with (null: it follows Settings › Agent).
   */
  thread: { project: string; turns: Turn[]; choice: Choice | null } | null;
  /** The song whose page shows the chooser ("Continue this conversation with…"), opened from a command or the header's line. */
  choosing: string | null;
  /** A request on its way to the host (it has no job yet); `continues`: an earlier go it carries on. */
  sending: { project: string; request: string; at: number; continues?: string } | null;
  /** A request the host turned down: what was asked, and why (shown as the reply). */
  refused: { project: string; request: string; error: string; at: number } | null;
  /** The job listening to what's played, until the user says Done. */
  listening: string | null;
  /**
   * The songs one of this device's jobs ended on while the bar wasn't open on that song: a dot on the
   * bar's button until it is (the bar opened on the song, or the song opened under an open bar).
   */
  unseen: readonly string[];
  /**
   * How far the host's clock is ahead of this device's (ms), from the `now` its answers carry: a job's
   * times are the host's, so the time a request has been working is counted on the host's clock.
   */
  skew: number;
}

export const EMPTY: AgentState = {
  info: null,
  me: null,
  settings: null,
  devices: null,
  harness: {},
  jobs: {},
  thread: null,
  choosing: null,
  sending: null,
  refused: null,
  listening: null,
  unseen: [],
  skew: 0,
};

const LIVE: ReadonlySet<string> = new Set(['waiting', 'running']);
export const isLive = (state: string): boolean => LIVE.has(state);

/** The agent is on and this device may use it: only then does any of it show. */
export function isOn(a: AgentState): boolean {
  return !!a.info?.enabled && !!a.info.allowed;
}

// ---- what changes it (pure, so it can be tried on its own) ----

export type AgentEvent =
  | { type: 'info'; info: AgentInfo }
  | { type: 'me'; id: string | null }
  | { type: 'settings'; settings: AgentSettings }
  | { type: 'enabled'; enabled: boolean }
  | { type: 'devices'; devices: DeviceList }
  | { type: 'harness'; event: HarnessEvent }
  | { type: 'status'; job: JobView; barOpen: boolean }
  | { type: 'listen'; job: string; on: boolean }
  | { type: 'thread'; project: string; turns: Turn[]; choice?: Choice | null }
  | { type: 'choosing'; project: string | null }
  | { type: 'sending'; project: string; request: string; at: number; continues?: string }
  | { type: 'sent'; job: JobView }
  | { type: 'refused'; project: string; request: string; error: string; at: number }
  | { type: 'reset'; project: string }
  | { type: 'seen'; project: string | null }
  | { type: 'removed' }
  | { type: 'clock'; skew: number };

/** A change in the host's clock smaller than this is a message's time on the way, not the clock: it's let be. */
const SKEW_STEADY_MS = 1000;

export function reduce(a: AgentState, e: AgentEvent): AgentState {
  switch (e.type) {
    case 'info':
      // the agent turned off (or this device was let go): nothing of it is kept to show
      return e.info.enabled && e.info.allowed
        ? { ...a, info: e.info }
        : { ...EMPTY, info: e.info, me: a.me, skew: a.skew };
    case 'me':
      return { ...a, me: e.id };
    case 'settings': {
      // a sign-in or an update under way that this page didn't see start (Settings opened on another
      // device, or this one reloaded on coming back from the sign-in page): as the host has it
      const harness = { ...a.harness };
      for (const r of e.settings.relays ?? []) if (harness[r.harness]?.state !== 'running') harness[r.harness] = r;
      return { ...a, settings: e.settings, harness };
    }
    case 'enabled':
      // turned on or off on some device: off, everything of it goes at once
      return a.info ? reduce(a, { type: 'info', info: { ...a.info, enabled: e.enabled } }) : a;
    case 'devices': {
      const me = e.devices.devices.find((d) => d.current)?.id ?? a.me;
      return { ...a, devices: e.devices, me };
    }
    case 'harness':
      return { ...a, harness: { ...a.harness, [e.event.harness]: e.event } };
    case 'status': {
      const was = a.jobs[e.job.id];
      const mine = e.job.device === a.me;
      // one of this device's ends while the bar isn't open on its song (`barOpen`: closed, or open on
      // another): the button says so until it is
      const ended = !isLive(e.job.state) && (!was || isLive(was.state));
      const unseen = mine && ended && !e.barOpen && !a.unseen.includes(e.job.project);
      const sending = a.sending?.project === e.job.project && a.sending.request === e.job.request ? null : a.sending;
      return {
        ...a,
        jobs: { ...a.jobs, [e.job.id]: e.job },
        sending,
        listening: a.listening === e.job.id && !isLive(e.job.state) ? null : a.listening,
        unseen: unseen ? [...a.unseen, e.job.project] : a.unseen,
      };
    }
    case 'listen':
      return { ...a, listening: e.on ? e.job : a.listening === e.job ? null : a.listening };
    case 'thread':
      return { ...a, thread: { project: e.project, turns: e.turns, choice: e.choice ?? null } };
    case 'choosing':
      return a.choosing === e.project ? a : { ...a, choosing: e.project };
    case 'sending':
      return {
        ...a,
        sending: {
          project: e.project,
          request: e.request,
          at: e.at,
          ...(e.continues ? { continues: e.continues } : {}),
        },
        refused: null,
      };
    case 'sent': {
      // the job may have been told of already (the live channel can be quicker than the answer)
      const known = a.jobs[e.job.id];
      return { ...a, sending: null, jobs: known ? a.jobs : { ...a.jobs, [e.job.id]: e.job } };
    }
    case 'refused':
      return {
        ...a,
        sending: null,
        refused: { project: e.project, request: e.request, error: e.error, at: e.at },
      };
    case 'reset': {
      // a new conversation: what was said on this song goes from the bar (a job still running stays)
      const jobs = Object.fromEntries(
        Object.entries(a.jobs).filter(([, j]) => j.project !== e.project || isLive(j.state)),
      );
      return {
        ...a,
        jobs,
        // (its own choice of harness went with the conversation)
        thread: a.thread?.project === e.project ? { project: e.project, turns: [], choice: null } : a.thread,
        refused: a.refused?.project === e.project ? null : a.refused,
        unseen: a.unseen.includes(e.project) ? a.unseen.filter((p) => p !== e.project) : a.unseen,
      };
    }
    case 'seen':
      return e.project !== null && a.unseen.includes(e.project)
        ? { ...a, unseen: a.unseen.filter((p) => p !== e.project) }
        : a;
    case 'removed':
      return { ...EMPTY, info: a.info ? { ...a.info, allowed: false } : null, skew: a.skew };
    case 'clock':
      return Math.abs(e.skew - a.skew) < SKEW_STEADY_MS ? a : { ...a, skew: e.skew };
  }
}

/**
 * How long a request has been working (ms): from when it started, on the host's clock, to `now` on
 * this device's, the clocks' difference (`skew`) taken in. Never less than none.
 */
export function elapsedMs(started: number, now: number, skew: number): number {
  return Math.max(0, now + skew - started);
}

/** A time a request has been working, as the page says it: "0:07", "1:05", "1:02:09" past an hour. */
export function elapsedClock(ms: number): string {
  const s = Math.floor(Math.max(0, ms) / 1000);
  const two = (n: number) => String(n).padStart(2, '0');
  const h = Math.floor(s / 3600);
  const m = Math.floor(s / 60) % 60;
  return h ? `${h}:${two(m)}:${two(s % 60)}` : `${m}:${two(s % 60)}`;
}

/**
 * What the studio does when the host says how one of its jobs goes: whether it runs, its step's final
 * name, and (as the reply arrives: `was` was the job still running) where it goes, when the reply
 * brings a go.
 */
export function statusEffects(
  a: AgentState,
  job: JobView,
  was?: JobView,
): { running: boolean; label?: string; go?: Go } | null {
  if (job.device !== a.me) return null;
  const running = isLive(job.state);
  const arrived = job.state === 'done' && !!job.go && !!was && isLive(was.state);
  return {
    running,
    ...(!running && job.label ? { label: job.label } : {}),
    ...(arrived && job.go ? { go: job.go } : {}),
  };
}

/** An exchange on a song: the bar shows the last under its field, the page all of them. */
export interface Exchange {
  /** Its job (none while the request is on its way, or when it was turned down). */
  job: string | null;
  /** When it was asked, on the host's clock: what the song's conversation is in the order of. */
  at: number;
  /** When its work began, on the host's clock: what the time it has been working is counted from. */
  started: number;
  /** Its step's name, once it has one (an earlier turn's row says it). */
  label: string | null;
  request: string;
  /** Working: the ring, the line it's on, and Stop. */
  working: boolean;
  line: string | null;
  /** The reply (or why it stopped). */
  reply: string | null;
  permission: Permission | null;
  brief: string | null;
  flagged: Map<number, BriefWarning>;
  /** Asked for here: only this device answers a permission. */
  mine: boolean;
  listening: boolean;
  /** What the reply shows under it, once it's done. */
  view: View | null;
  /** It failed (not stopped by someone, not turned down): the conversation's last such can be tried again. */
  failed: boolean;
  /** Why it didn't go on, where the host knows, and the harness it ran with (and the model and effort given it). */
  stop: TurnStop | null;
  harness: HarnessId | null;
  model: string;
  effort: string;
  /** The request's first go, when this one carries it on: the page shows only the latest go of a request. */
  continues: string | null;
  /** It failed out of usage, and the host carries it on by itself at this time (the user asked). */
  wait: number | null;
}

/** Why a job ended without a reply, as said under the request. */
function endedWhy(state: string, error?: string | null): string | null {
  if (error) return error;
  if (state === 'cancelled') return 'Stopped';
  if (state === 'failed') return 'It stopped before it was done';
  return null;
}

type Seen = { at: number; make: () => Exchange };

/**
 * What's known of a song's exchanges, each with its time: a request on its way, one turned down, the
 * jobs the host told of, then the conversation's `turns` the jobs don't already stand for.
 */
function told(a: AgentState, project: string, turns: readonly Turn[]): Seen[] {
  const seen: Seen[] = [];
  const base = {
    permission: null,
    brief: null,
    flagged: new Map(),
    mine: false,
    listening: false,
    view: null,
    label: null,
    failed: false,
    stop: null,
    harness: null,
    model: '',
    effort: '',
    continues: null,
    wait: null,
  };
  if (a.sending?.project === project) {
    const s = a.sending;
    seen.push({
      at: s.at,
      make: () => ({
        ...base,
        job: null,
        at: s.at,
        started: s.at,
        request: s.request,
        working: true,
        line: null,
        reply: null,
        mine: true,
        continues: s.continues ?? null,
      }),
    });
  }
  if (a.refused?.project === project) {
    const r = a.refused;
    seen.push({
      at: r.at,
      make: () => ({
        ...base,
        job: null,
        at: r.at,
        started: r.at,
        request: r.request,
        working: false,
        line: null,
        reply: r.error,
        mine: true,
      }),
    });
  }
  for (const j of Object.values(a.jobs)) {
    if (j.project !== project) continue;
    seen.push({
      at: j.started,
      make: () => ({
        job: j.id,
        at: j.started,
        started: j.started,
        label: j.label ?? null,
        request: j.request,
        working: isLive(j.state),
        line: j.line ?? null,
        reply: isLive(j.state) ? null : (j.reply ?? endedWhy(j.state, j.error)),
        permission: j.state === 'awaiting' ? (j.permission ?? null) : null,
        brief: j.brief ?? null,
        flagged: new Map((j.briefWarnings ?? []).map((w) => [w.line, w.kind])),
        mine: j.device === a.me,
        listening: a.listening === j.id,
        view: isLive(j.state) ? null : (j.view ?? null),
        failed: j.state === 'failed',
        stop: j.state === 'failed' ? (j.stop ?? null) : null,
        harness: j.harness ?? null,
        model: j.model ?? '',
        effort: j.effort ?? '',
        continues: j.continues ?? null,
        wait: j.state === 'failed' ? (j.wait ?? null) : null,
      }),
    });
  }
  for (const t of turns) {
    if (a.jobs[t.job]) continue;
    seen.push({
      at: t.at,
      make: () => ({
        ...base,
        job: t.job,
        at: t.at,
        started: t.at,
        label: t.label,
        request: t.request,
        working: isLive(t.state),
        line: null,
        reply: isLive(t.state) ? null : (t.reply ?? endedWhy(t.state, t.error)),
        permission: t.state === 'awaiting' ? (t.permission ?? null) : null,
        brief: t.brief ?? null,
        flagged: new Map((t.briefWarnings ?? []).map((w) => [w.line, w.kind])),
        // (the host answers a permission only from the device that asked)
        mine: true,
        view: isLive(t.state) ? null : (t.view ?? null),
        failed: t.state === 'failed',
        stop: t.state === 'failed' ? (t.stop ?? null) : null,
        harness: t.harness ?? null,
        model: t.model ?? '',
        effort: t.effort ?? '',
        continues: t.continues ?? null,
        wait: t.state === 'failed' ? (t.wait ?? null) : null,
      }),
    });
  }
  return seen;
}

/**
 * The song's latest exchange: the newest of a request on its way, one turned down, the jobs the host
 * told of, and the conversation's last turn. Null when the song has none.
 */
export function exchange(a: AgentState, project: string | null): Exchange | null {
  if (!project || !isOn(a)) return null;
  const last = a.thread?.project === project ? a.thread.turns[a.thread.turns.length - 1] : undefined;
  const seen = told(a, project, last ? [last] : []);
  if (!seen.length) return null;
  seen.sort((x, y) => y.at - x.at);
  return (seen[0] as Seen).make();
}

/**
 * The song's whole conversation, oldest first, as the page shows it: every turn the host keeps, with
 * the jobs it told of standing for theirs (a job's news is the newer), a request on its way and one
 * turned down. Of two at the same time the one `exchange` shows comes last, so the last is always it.
 */
export function conversation(a: AgentState, project: string | null): Exchange[] {
  if (!project || !isOn(a)) return [];
  const turns = a.thread?.project === project ? a.thread.turns : [];
  const all = told(a, project, turns)
    .map((seen, i) => ({ seen, i }))
    .sort((x, y) => x.seen.at - y.seen.at || y.i - x.i)
    .map(({ seen }) => seen.make());
  // a request tried again is one exchange: its latest go (the earlier ones didn't finish)
  const latest = new Map<string, Exchange>();
  for (const ex of all) {
    const first = ex.continues ?? ex.job;
    if (first) latest.set(first, ex);
  }
  return all.filter((ex) => {
    const first = ex.continues ?? ex.job;
    return !first || latest.get(first) === ex;
  });
}

export const HARNESS_NAME: Record<HarnessId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
};

/**
 * What a failed exchange says under its error, and whether it can be tried again as it is: not when
 * the host knows that wouldn't help (the account is out of usage, the harness signed out or gone).
 * `startsAgain` words when a limit starts again ("in 2 h 10 min", "Thu 3 Dec, 07:02"); past that time
 * (`now`, the host's), it can be tried again. Null for an exchange that didn't fail.
 */
export function afterFailure(
  ex: Pick<Exchange, 'failed' | 'stop' | 'harness'>,
  startsAgain: (resets: number) => string,
  now = 0,
): { say: string | null; again: boolean } | null {
  if (!ex.failed) return null;
  const name = ex.harness ? HARNESS_NAME[ex.harness] : 'The harness';
  switch (ex.stop?.why) {
    case 'usage':
      // (its limit has started again since: trying again may well do)
      if (ex.stop.resets && ex.stop.resets <= now)
        return { say: `${name} was out of usage: its limit has started again since.`, again: true };
      return {
        say: `${name} is out of usage${ex.stop.resets ? `: its limit starts again ${startsAgain(ex.stop.resets)}` : ''}.`,
        again: false,
      };
    case 'signed-out':
      return { say: `${name} is signed out: sign it in again in Settings › Agent.`, again: false };
    case 'not-installed':
      return { say: `${name} isn’t installed on the host any more: Settings › Agent can install it.`, again: false };
    default:
      return { say: null, again: true };
  }
}

/**
 * "Carry on when it resets", under a reply that ran out of usage: `waiting`, the host carries it on
 * by itself at that time (the user asked, and can call it off); `at`, it can be asked to, once its
 * limit has started again then (only where the harness said when that is, and it's still ahead). Null
 * otherwise.
 */
export function resetOffer(
  ex: Pick<Exchange, 'failed' | 'stop' | 'wait'>,
  now: number,
): { waiting: number } | { at: number } | null {
  if (!ex.failed) return null;
  if (ex.wait) return { waiting: ex.wait };
  const resets = ex.stop?.why === 'usage' ? ex.stop.resets : undefined;
  return resets !== undefined && resets > now ? { at: resets } : null;
}

/**
 * What the bar's button shows: a turning ring while a job of this device's works on the open song, and
 * a dot while a reply of this device's hasn't been seen, on the open song or on another (the bar then
 * says which: `elsewhere`). Both, when a reply waits on another song while the open one's is worked on.
 */
export function barSign(a: AgentState, project: string | null): 'busy' | 'done' | 'busy done' | null {
  if (!isOn(a)) return null;
  const working =
    (a.sending !== null && a.sending.project === project) ||
    Object.values(a.jobs).some((j) => j.project === project && j.device === a.me && isLive(j.state));
  const waiting = a.unseen.length > 0;
  if (working) return waiting ? 'busy done' : 'busy';
  return waiting ? 'done' : null;
}

/** A request of this device's on a song: at work there, or its reply not seen yet. */
export interface SongRequest {
  project: string;
  /** Its job (the reply the song opens at). */
  job: string;
  /** The song's title as the request was made (null: asked before titles were told). */
  title: string | null;
  working: boolean;
  /** The line it's on, while it works. */
  line: string | null;
  started: number;
}

/**
 * This device's requests the user may want to go to, one a song (its latest): those at work, then
 * those whose reply hasn't been seen, each oldest first. `open` (the open song) is left out: the bar
 * shows its own.
 */
export function songRequests(a: AgentState, open: string | null = null): SongRequest[] {
  if (!isOn(a)) return [];
  const bySong = new Map<string, JobView>();
  for (const j of Object.values(a.jobs)) {
    if (j.device !== a.me || j.project === open) continue;
    if (!isLive(j.state) && !a.unseen.includes(j.project)) continue;
    const had = bySong.get(j.project);
    if (!had || j.started > had.started) bySong.set(j.project, j);
  }
  return [...bySong.values()]
    .map((j) => ({
      project: j.project,
      job: j.id,
      title: j.title ?? null,
      working: isLive(j.state),
      line: isLive(j.state) ? (j.line ?? null) : null,
      started: j.started,
    }))
    .sort((x, y) => Number(y.working) - Number(x.working) || x.started - y.started);
}

/** By song, for the list of songs: `busy` while this device's request works on it, `done` while its reply waits. */
export function songSigns(a: AgentState): Map<string, 'busy' | 'done'> {
  return new Map(songRequests(a).map((r) => [r.project, r.working ? 'busy' : 'done']));
}

/** What a permission's one button says. */
const ALLOW: Record<PermissionKind, string> = {
  'install-pack': 'Install it',
  'send-creation': 'Send it',
  bounce: 'Bounce the song',
  stems: 'Export the stems',
  'stems-stacks': 'Export the stems, by stack',
  render: 'Hear it as the creation plays it',
  screen: 'Share the screen',
  photo: 'Take a photo',
  microphone: 'Record',
};

/**
 * The permission's button: a pack's says what it downloads ("Install it (131 MB)"), or, when the
 * catalog doesn't say, which pack it is ("Install Iowa Flute"); a creation's render, which creation
 * ("Hear it as my-game").
 */
export function allowLabel(
  p: Pick<Permission, 'kind' | 'pack'>,
  pack?: { name: string; bytes: number | null; installed?: boolean },
  creation?: string,
): string {
  if (p.kind === 'render' && creation) return `Hear it as ${creation}`;
  if (p.kind !== 'install-pack') return ALLOW[p.kind];
  if (pack?.bytes && !pack.installed) return `${ALLOW['install-pack']} (${diskSize(pack.bytes)})`;
  const name = pack?.name ?? p.pack;
  return name ? `Install ${name}` : ALLOW['install-pack'];
}

/** The studio's view, as a request says it ("tracks and piano roll", "mixer", "scan"). */
export function viewName(
  s: Pick<AppState, 'editor' | 'noteView' | 'mobileTab' | 'scanView' | 'printView'> &
    Partial<Pick<AppState, 'project' | 'selectedTrack'>>,
  phone: boolean,
): string {
  if (s.scanView) return 'scan';
  if (s.printView) return 'print';
  // (the Step Grid is a kit's: any other track shows its Piano Roll)
  const shown = shownNoteView({
    noteView: s.noteView,
    project: s.project ?? null,
    selectedTrack: s.selectedTrack ?? null,
  });
  const notes = shown === 'score' ? 'score' : shown === 'steps' ? 'step grid' : 'piano roll';
  if (phone) {
    if (s.mobileTab === 'editor') return notes;
    return s.mobileTab;
  }
  if (s.editor === 'mixer') return 'tracks and mixer';
  if (s.editor === 'piano') return `tracks and ${notes}`;
  return 'tracks';
}

/** What a request carries of the studio: the view, the selection, the playhead, the cycle, the open scan. */
export interface RequestContext {
  view: string;
  selection: { track: string | null; regions: string[]; notes: number; from?: number; to?: number };
  playhead: number;
  cycle: { on: boolean; start: number; end: number };
  scan?: string;
}

/** What a request carries of the studio, as it is when the request is sent. */
export function requestContext(
  s: Pick<
    AppState,
    | 'project'
    | 'selectedTrack'
    | 'selectedRegions'
    | 'selectedNotes'
    | 'editor'
    | 'noteView'
    | 'mobileTab'
    | 'scanView'
    | 'printView'
  >,
  playhead: number,
  phone: boolean,
): RequestContext {
  const p = s.project;
  const span = p ? selectionSpan(p, s.selectedNotes, s.selectedRegions) : null;
  return {
    view: viewName(s, phone),
    selection: {
      track: s.selectedTrack,
      regions: s.selectedRegions.slice(0, 1000),
      notes: s.selectedNotes.length,
      ...(span ? { from: span.start, to: span.end } : {}),
    },
    playhead: Math.max(0, Math.round(playhead)),
    cycle: p ? { on: p.cycle.on, start: p.cycle.start, end: p.cycle.end } : { on: false, start: 0, end: 0 },
    ...(s.scanView?.id ? { scan: s.scanView.id } : {}),
  };
}

export type ScanTask = 'read' | 'check' | 'fix';

/**
 * What the bar offers of the agent's besides asking (only while it's on for this device): with a scan
 * open, its three tasks (read it in, check what was written, fix what was flagged); starting a new
 * conversation on the song, or choosing what it runs with, when nothing runs on it; and this device's requests on other songs
 * (`elsewhere`), each a row that opens its song at it. One that has replied and hasn't been read is
 * offered with nothing typed (it's what the button's dot is for); one still at work is found by name,
 * so a song at work elsewhere adds nothing to the bar.
 */
export function agentCommands(
  o: { on: boolean; project: string | null; scan: string | null; busy: boolean; elsewhere?: readonly SongRequest[] },
  run: {
    scan: (task: ScanTask, scan: string) => void;
    reset: () => void;
    open?: (r: SongRequest) => void;
    choose?: () => void;
  },
): { suggest: Command[]; commands: Command[] } {
  if (!o.on || !o.project) return { suggest: [], commands: [] };
  const others: Command[] = (o.elsewhere ?? []).map((r) => ({
    id: `agent-song-${r.project}`,
    title: elsewhereTitle(r),
    group: 'Agent',
    also: 'agent request reply song working waiting',
    run: () => run.open?.(r),
  }));
  const { scan } = o;
  const scanRows: Command[] = scan
    ? (
        [
          ['read', 'Read this scan', 'read in write recognise'],
          ['check', 'Check it', 'check compare proofread scan'],
          ['fix', 'Fix flagged', 'fix flags scan'],
        ] as const
      ).map(([task, title, also]) => ({
        id: `scan-${task}`,
        title,
        group: 'Scan',
        also,
        keepOpen: true,
        available: () => !o.busy,
        run: () => run.scan(task, scan),
      }))
    : [];
  const reset: Command = {
    id: 'agent-new',
    title: 'Start a new conversation with the agent',
    group: 'Agent',
    also: 'start over reset clear forget',
    available: () => !o.busy,
    run: run.reset,
  };
  // what this song's conversation runs with, chosen on the agent's page (and how it follows Settings again)
  const choose: Command = {
    id: 'agent-continue',
    title: 'Continue this conversation with…',
    group: 'Agent',
    also: 'agent harness model effort switch change move claude codex cursor antigravity usage limit settings',
    keepOpen: true,
    available: () => !o.busy,
    run: () => run.choose?.(),
  };
  const replied = others.filter((_, i) => !o.elsewhere?.[i]?.working);
  return {
    suggest: [...(o.busy ? [] : scanRows), ...replied],
    commands: [...scanRows, reset, ...(run.choose ? [choose] : []), ...others],
  };
}

/** How the bar names a request on another song: its song, and whether it's at work or has replied. */
export function elsewhereTitle(r: Pick<SongRequest, 'title' | 'working'>): string {
  const song = r.title ? `“${r.title}”` : 'Another song';
  return r.working ? `${song}: the agent is at work` : `${song}: a reply is waiting`;
}

// ---- the token: this device's, kept in its own key ----

const TOKEN_KEY = 'holo:agent-token';
const DEVICE_KEY = 'holo:agent-device';

/** Where the token is kept (a test passes its own). */
export interface TokenStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

function storage(): TokenStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

export function readToken(s: TokenStorage | null = storage()): string | null {
  try {
    return s?.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

/** The id of the device this browser was allowed as, as kept with its token (null: none kept). */
export function readDevice(s: TokenStorage | null = storage()): string | null {
  try {
    return s?.getItem(DEVICE_KEY) || null;
  } catch {
    return null;
  }
}

export function keepToken(token: string, device: string | null, s: TokenStorage | null = storage()): void {
  try {
    s?.setItem(TOKEN_KEY, token);
    if (device) s?.setItem(DEVICE_KEY, device);
    else s?.removeItem(DEVICE_KEY);
  } catch {
    // a private window refusing storage: allowed until the page closes
  }
  memoryToken = token;
}

export function forgetToken(s: TokenStorage | null = storage()): void {
  try {
    s?.removeItem(TOKEN_KEY);
    s?.removeItem(DEVICE_KEY);
  } catch {
    // nothing kept
  }
  memoryToken = null;
}

/** The token when storage refused it (a private window): this page's only. */
let memoryToken: string | null = null;
const token = () => readToken() ?? memoryToken;

/** What a live hello carries of the agent: this device's token, when it has one. */
export function helloFields(): { agentToken?: string } {
  const t = token();
  return t ? { agentToken: t } : {};
}

const tokenListeners = new Set<() => void>();
/** Called when the token comes or goes (the live channel says hello again with it). */
export function onTokenChange(fn: () => void): () => void {
  tokenListeners.add(fn);
  return () => tokenListeners.delete(fn);
}
const tokenChanged = () => {
  for (const fn of tokenListeners) fn();
};

// ---- this device's requests, followed across a reload ----

const FOLLOW_KEY = 'holo:agent-follow';
/** At most this many are followed (the latest). */
const FOLLOW_MOST = 20;

/** A request of this device's the studio follows: one still working, or one whose reply hasn't been seen. */
export interface Followed {
  id: string;
  project: string;
  device: string;
  request: string;
  started: number;
  /** Its song's title, when the host told it. */
  title?: string;
}

/** The requests kept as followed, checked (what isn't one is left out). */
export function readFollowed(s: TokenStorage | null = storage()): Followed[] {
  try {
    const list = JSON.parse(s?.getItem(FOLLOW_KEY) ?? '[]') as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (f): f is Followed =>
          typeof f === 'object' &&
          f !== null &&
          typeof f.id === 'string' &&
          /^agj_[0-9a-f]{12}$/.test(f.id) &&
          typeof f.project === 'string' &&
          typeof f.device === 'string' &&
          typeof f.request === 'string' &&
          typeof f.started === 'number' &&
          (f.title === undefined || typeof f.title === 'string'),
      )
      .slice(-FOLLOW_MOST);
  } catch {
    return [];
  }
}

/**
 * Which of this device's requests are followed once the host has said how one goes: one that's
 * working, or that ended while the bar wasn't open on its song (its reply not seen yet), stays or
 * comes in; one seen (the bar open on its song as it ended, or since) goes. A page the browser let go
 * (a phone in another app) comes back to them: the bar's button turns while they work, and shows a
 * reply is waiting after.
 */
export function followed(list: readonly Followed[], a: AgentState, e: AgentEvent): Followed[] {
  const of = (j: JobView): Followed => ({
    id: j.id,
    project: j.project,
    device: j.device,
    request: j.request,
    started: j.started,
    ...(j.title ? { title: j.title } : {}),
  });
  const without = (id: string) => list.filter((f) => f.id !== id);
  switch (e.type) {
    case 'sent':
      return [...without(e.job.id), of(e.job)].slice(-FOLLOW_MOST);
    case 'status': {
      if (e.job.device !== a.me) return [...list];
      // (`a` is as it is now: a reply that came while the bar wasn't open on its song has left it unseen)
      const seen = !isLive(e.job.state) && (e.barOpen || !a.unseen.includes(e.job.project));
      if (seen) return without(e.job.id);
      // (one followed already keeps its place: two at work don't change places at each one's word)
      return list.some((f) => f.id === e.job.id)
        ? list.map((f) => (f.id === e.job.id ? of(e.job) : f))
        : [...list, of(e.job)].slice(-FOLLOW_MOST);
    }
    case 'seen':
      // (those of the song seen go; one working, or replied to on a song not seen yet, stays)
      return list.filter((f) => isLive(a.jobs[f.id]?.state ?? '') || a.unseen.includes(f.project));
    case 'reset':
      return list.filter((f) => f.project !== e.project || isLive(a.jobs[f.id]?.state ?? ''));
    case 'removed':
      return [];
    case 'info':
      return isOn(a) ? [...list] : [];
    default:
      return [...list];
  }
}

/** The followed requests, as the jobs the studio knows before the host has said how they stand: working. */
function followedJobs(list: readonly Followed[]): Record<string, JobView> {
  return Object.fromEntries(list.map((f) => [f.id, { ...f, state: 'running' as const }]));
}

// ---- the store ----

let following = readFollowed();
let state: AgentState = {
  ...EMPTY,
  me: (() => storage()?.getItem(DEVICE_KEY) ?? null)(),
  // (the host is asked how each stands once the live channel opens: catchUp)
  jobs: followedJobs(following),
};
const listeners = new Set<() => void>();

/** Keep the followed requests as they now are (once, when they change). */
function follow(e: AgentEvent): void {
  const next = followed(following, state, e);
  if (next.length === following.length && next.every((f, i) => f.id === following[i]?.id)) return;
  following = next;
  try {
    storage()?.setItem(FOLLOW_KEY, JSON.stringify(next));
  } catch {
    // followed until the page goes
  }
}

export const agent = {
  get: (): AgentState => state,
  dispatch(e: AgentEvent): void {
    const next = reduce(state, e);
    if (next === state) return;
    state = next;
    follow(e);
    // Undo and Redo are told to the host only while the agent is on for this device
    const on = isOn(state);
    if (studio.get().agentReport !== on) studio.set({ agentReport: on });
    for (const l of listeners) l();
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useAgent<T>(selector: (a: AgentState) => T): T {
  return useSyncExternalStore(agent.subscribe, () => selector(agent.get()));
}

/** The time now on the host's clock, as near as this device knows it (what a request is stamped with). */
export function serverNow(): number {
  return Date.now() + state.skew;
}

/** An answer from the host said its time (`now`): how far its clock is from this device's is kept. */
function heardClock(now: unknown): void {
  if (typeof now === 'number' && Number.isFinite(now)) agent.dispatch({ type: 'clock', skew: now - Date.now() });
}

// ---- the host ----

/** A refusal from the host: its words, its status, and a reason the studio can act on. */
export class AgentError extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(message: string, status: number, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/**
 * One of the agent's routes, with this device's token (notify.ts uses it too). `idleMs`: given up
 * only once nothing of the answer has come for that long (`patiently`).
 */
export async function call<T>(
  method: 'GET' | 'POST' | 'PUT' | 'DELETE',
  path: string,
  body?: unknown,
  idleMs?: number,
): Promise<T> {
  const t = token();
  const init: RequestInit = {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  };
  let res: Response;
  let data: Record<string, unknown>;
  if (idleMs) {
    const got = await patiently(path, init, idleMs);
    res = got.res;
    data = (() => {
      try {
        return JSON.parse(got.text) as Record<string, unknown>;
      } catch {
        return {};
      }
    })();
  } else {
    res = await fetch(path, init);
    data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  }
  if (!res.ok) {
    const reason = typeof data.reason === 'string' ? data.reason : undefined;
    // turned off elsewhere, or this device let go: the studio catches up
    if (reason === 'off' || res.status === 401) void refreshAgent();
    throw new AgentError(
      typeof data.error === 'string' ? data.error : `The host answered ${res.status}`,
      res.status,
      reason,
    );
  }
  return data as T;
}

/**
 * Ask the host how the agent stands (at start, on reconnecting, from Settings). `idleMs`: given up
 * (null) once nothing of the answer has come for that long.
 */
export async function refreshAgent(idleMs?: number): Promise<AgentInfo | null> {
  const asked = token();
  let info: AgentInfo;
  try {
    info = await call<AgentInfo>('GET', '/api/agent', undefined, idleMs);
  } catch {
    return null;
  }
  // a token came or went while it was asked (pairing answers after the host tells every studio the
  // agent is on): the answer is about the old one, so ask again
  if (token() !== asked) return refreshAgent(idleMs);
  // a token the host no longer takes (the device was removed while away) is let go
  if (asked && !info.allowed) {
    forgetToken();
    agent.dispatch({ type: 'me', id: null });
    tokenChanged();
  }
  agent.dispatch({ type: 'info', info });
  if (info.allowed && !state.me) await loadDevices().catch(() => undefined);
  return info;
}

export async function loadSettings(): Promise<void> {
  agent.dispatch({ type: 'settings', settings: await call<AgentSettings>('GET', '/api/agent/settings') });
}

export async function setSettings(patch: Partial<Omit<AgentSettings, 'harnesses'>>): Promise<void> {
  const settings = await call<AgentSettings>('PUT', '/api/agent/settings', patch);
  agent.dispatch({ type: 'settings', settings });
  if (patch.enabled !== undefined) await refreshAgent();
}

export async function loadDevices(): Promise<void> {
  agent.dispatch({ type: 'devices', devices: await call<DeviceList>('GET', '/api/agent/devices') });
}

/**
 * Pairing: a keyed runner prints a code on the host (for the first device, or one with no allowed
 * device at hand); one that still works is kept unless `fresh`. Without a runner, `holo pair` on the host
 * prints one: false then (409 `no-runner`), and the code is asked for all the same.
 */
export async function startPairing(fresh = false): Promise<boolean> {
  try {
    await call<{ expires: number }>('POST', '/api/agent/pairing', fresh ? { fresh: true } : {});
    return true;
  } catch (err) {
    if (err instanceof AgentError && err.reason === 'no-runner') return false;
    throw err;
  }
}

/**
 * Pair with a code from the host (any device, any time: the first, or one with no allowed device at hand):
 * this device is allowed, and the agent turns on. It resolves only once the host says so.
 */
export async function pair(code: string, name: string): Promise<void> {
  const r = await call<{ token: string; device: { id: string } }>('POST', '/api/agent/pair', { code, name });
  allowedNow(r.token, r.device.id);
  await settle();
}

function allowedNow(t: string, device: string): void {
  keepToken(t, device);
  agent.dispatch({ type: 'me', id: device });
  tokenChanged();
}

const sleep = (ms: number) => new Promise<void>((ok) => setTimeout(ok, ms));

/**
 * A token just came: this device counts as allowed only once the host says so (asked again for a few
 * seconds while it doesn't answer). One the host doesn't take is let go, and that's an error.
 */
async function settle(): Promise<void> {
  for (let wait = 250; ; wait *= 2) {
    const info = await refreshAgent();
    if (info?.allowed) return;
    if (info) throw new AgentError('The host didn’t take this device: try again', 401);
    if (wait > 2000)
      throw new AgentError('HO[LO]’s host stopped answering: this device shows as allowed once it’s back', 0);
    await sleep(wait);
  }
}

/** A later device asks to join: an allowed one approves it. */
export async function askToJoin(name: string): Promise<{ id: string; secret: string; code: string }> {
  return call('POST', '/api/agent/devices/requests', { name });
}

/**
 * How the request stands; once approved, this device is allowed (resolved once the host says so).
 * `lost`: approved, but the answer that carried the token never arrived, so this device isn't allowed.
 */
export async function pollJoin(
  id: string,
  secret: string,
): Promise<'pending' | 'approved' | 'denied' | 'lapsed' | 'lost'> {
  let r: { state: 'pending' | 'approved' | 'denied'; token?: string; device?: { id: string } };
  try {
    r = await call('GET', `/api/agent/devices/requests/${encodeURIComponent(id)}?secret=${encodeURIComponent(secret)}`);
  } catch (err) {
    if (err instanceof AgentError && err.status === 404) return 'lapsed';
    throw err;
  }
  if (r.state !== 'approved') return r.state;
  // the token comes with the first answer only (a later one finds it here, or never had it)
  if (r.token && r.device) allowedNow(r.token, r.device.id);
  else if (!token()) return 'lost';
  await settle();
  return 'approved';
}

export async function answerRequest(id: string, approve: boolean): Promise<void> {
  await call('POST', `/api/agent/devices/requests/${encodeURIComponent(id)}/${approve ? 'approve' : 'deny'}`);
  await loadDevices();
}

export async function removeDevice(id: string): Promise<void> {
  await call('DELETE', `/api/agent/devices/${encodeURIComponent(id)}`);
  if (id === state.me) deviceRemoved();
  else await loadDevices();
}

export async function harnessAction(harness: HarnessId, action: 'login' | 'update' | 'install'): Promise<void> {
  await call('POST', `/api/agent/harnesses/${harness}/${action}`);
}

export async function sendLoginCode(harness: HarnessId, code: string): Promise<void> {
  await call('POST', `/api/agent/harnesses/${harness}/login/code`, { code });
}

export async function lookForHarnesses(): Promise<void> {
  await call('POST', '/api/agent/harnesses/refresh');
}

/**
 * Settings › Agent was opened: the host has a runner that last looked an hour ago or more look again,
 * quietly (new versions' models and efforts). What's known shows meanwhile; the new list comes as
 * `agent-settings`.
 */
export async function lookAtHarnesses(): Promise<void> {
  await call('POST', '/api/agent/harnesses/look');
}

/**
 * The open song's conversation, for the bar (or the page) as it opens. With `barOpen` false (a phone's
 * tray, as a song opens, the bar closed) only its turns are kept: the song's job that's working or
 * waiting isn't told of from here, so it's neither taken as seen nor as a reply waiting, and the bar's
 * button's ring and dot, and the requests followed, stay as they are (they're caught up on their own).
 */
export async function loadThread(project: string, barOpen = true): Promise<void> {
  if (!isOn(state)) return;
  try {
    const asked = ++threadAsked;
    const r = await call<ThreadAnswer>('GET', `/api/agent/threads/${encodeURIComponent(project)}`);
    if (!showThread(project, r, asked)) return;
    // the song's job that's working, or waiting for a click (after a reload, its button comes back);
    // seen only if the song is still the open one (another may have opened before the answer came)
    const open = studio.get().project?.id;
    if (r.job && barOpen) agent.dispatch({ type: 'status', job: r.job, barOpen: !open || open === project });
  } catch {
    // the bar shows what it has
  }
}

/** A song's conversation as the host answers it: its turns, its job at work or waiting, its own choice. */
interface ThreadAnswer {
  thread: { turns: Turn[] } | null;
  job?: JobView | null;
  choice?: Choice | null;
  now?: number;
}

/**
 * What the song's conversation runs with from here on: a harness with its model and effort, the
 * song's own (it lasts until it's changed, or the conversation is started over), or null for what
 * Settings › Agent says again. The other songs aren't touched.
 */
export async function setChoice(project: string, choice: Choice | null): Promise<void> {
  const asked = ++threadAsked;
  const r = await call<ThreadAnswer>(
    'PUT',
    `/api/agent/threads/${encodeURIComponent(project)}/choice`,
    choice ?? { harness: null },
  );
  showThread(project, r, asked);
}

/** How many times a song's conversation has been asked for, and the latest of those whose answer shows. */
let threadAsked = 0;
let threadShown = 0;

/**
 * A song's conversation as the host just answered it, kept as the open song's: not when another song
 * has opened since it was asked (its answer would stand in for that song's, its own choice with it),
 * nor when a later ask has answered already. False when it wasn't kept.
 */
function showThread(project: string, r: ThreadAnswer, asked: number): boolean {
  const open = studio.get().project?.id;
  if ((open && open !== project) || asked < threadShown) return false;
  threadShown = asked;
  heardClock(r.now);
  agent.dispatch({ type: 'thread', project, turns: r.thread?.turns ?? [], choice: r.choice ?? null });
  return true;
}

/** The chooser on a song's page: shown, or put away. */
export function showChooser(project: string | null): void {
  agent.dispatch({ type: 'choosing', project });
}

/**
 * The names the song's conversation gave these jobs' steps, for steps kept from before a reload (a
 * job that ended while the page was away never told this one). Empty while the agent isn't on here.
 */
export async function jobLabels(project: string, jobs: readonly string[]): Promise<Map<string, string>> {
  const labels = new Map<string, string>();
  try {
    if (!state.info) await refreshAgent();
    if (!isOn(state)) return labels;
    const r = await call<{ thread: { turns: Turn[] } | null }>(
      'GET',
      `/api/agent/threads/${encodeURIComponent(project)}`,
    );
    for (const t of r.thread?.turns ?? []) if (t.label && jobs.includes(t.job)) labels.set(t.job, t.label);
  } catch {
    // the steps keep the names they have
  }
  return labels;
}

/**
 * What this device's request saved of its changes on the host while this studio was away (a phone in
 * another app, a closed tab), to pick up from revision `from` as its job's step: the batches after it,
 * by id (`base`, the revision they were made on: a later one than `from` when this studio's own save
 * got there unanswered), the revision they bring the song to and the song then, the job's label. Null
 * when there's nothing to pick up, or the agent isn't on here; thrown when the host doesn't answer.
 */
export interface AwayChanges {
  job: string;
  label: string;
  running: boolean;
  base: number;
  head: number;
  batches: { batch: string }[];
  song: Project;
}

/** What `p` comes to, or null when it hasn't within `ms`. */
function inTime<T>(p: Promise<T>, ms: number): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<null>((done) => {
    timer = setTimeout(() => done(null), ms);
  });
  return Promise.race([p, late]).finally(() => clearTimeout(timer));
}

export async function awayChanges(project: string, from: number): Promise<AwayChanges | null> {
  // (no answer from the host at all is thrown: what it would have said may be the agent's; and none
  // in time, the devices read after it included, is none: a save waits on this)
  if (!state.info && !(await inTime(refreshAgent(IDLE_MS), 2 * IDLE_MS))) throw new Error('The host didn’t answer');
  if (!isOn(state)) return null;
  let away: AwayChanges | null | undefined;
  try {
    // (a whole song: given up only once nothing of it has come for a while)
    ({ away } = await call<{ away?: AwayChanges | null }>(
      'GET',
      `/api/agent/away/${encodeURIComponent(project)}?from=${from}`,
      undefined,
      IDLE_MS,
    ));
  } catch (err) {
    if (err instanceof AgentError) return null;
    throw err;
  }
  if (
    !away ||
    typeof away.job !== 'string' ||
    typeof away.label !== 'string' ||
    typeof away.base !== 'number' ||
    typeof away.head !== 'number' ||
    !Array.isArray(away.batches) ||
    !away.batches.every((b) => typeof b?.batch === 'string')
  )
    return null;
  try {
    // (the song, read as the studio reads any song from the host)
    return { ...away, song: parseProject(away.song) };
  } catch {
    return null;
  }
}

/** Send a file that goes with a request (or a permission's answer): its id. What was measured of it follows. */
export async function upload(file: Ready, project: string): Promise<string> {
  const t = token();
  const query = new URLSearchParams({ project, name: file.name.slice(0, 120), type: file.type });
  const res = await fetch(`/api/agent/attachments?${query}`, {
    method: 'POST',
    headers: { 'content-type': file.type, ...(t ? { authorization: `Bearer ${t}` } : {}) },
    body: file.blob,
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !data.id)
    throw new AgentError(data.error ?? `${file.name} couldn’t be sent (${res.status})`, res.status);
  if (file.meta) await call('PUT', `/api/agent/attachments/${data.id}/meta`, file.meta);
  return data.id;
}

/** A file this device sent (or its running job may read), as the host keeps it: for the studio to import. */
export async function attachmentData(id: string): Promise<Blob> {
  const t = token();
  const res = await fetch(`/api/agent/attachments/${encodeURIComponent(id)}/data`, {
    headers: t ? { authorization: `Bearer ${t}` } : {},
  });
  if (!res.ok) {
    const data = (await res.json().catch(() => ({}))) as { error?: string };
    throw new AgentError(data.error ?? `The attachment couldn’t be fetched (${res.status})`, res.status);
  }
  return res.blob();
}

/**
 * Send a request about the open song, with the files that go with it (made ready while it was typed):
 * the bar shows it, then the reply.
 */
export async function ask(
  text: string,
  project: string,
  context: RequestContext,
  files: readonly Promise<Ready>[] = [],
): Promise<void> {
  const request = text.trim();
  if (!request || !isOn(state)) return;
  // (on the host's clock, as the job's own times are: the page orders the conversation by them)
  const at = serverNow();
  agent.dispatch({ type: 'sending', project, request, at });
  try {
    const attachments: string[] = [];
    for (const f of files) attachments.push(await upload(await f, project));
    const { job } = await call<{ job: string }>('POST', '/api/agent/requests', {
      project,
      text: request,
      context,
      ...(attachments.length ? { attachments } : {}),
    });
    agent.dispatch({
      type: 'sent',
      job: { id: job, project, device: state.me ?? '', state: 'waiting', request, started: at },
    });
  } catch (err) {
    agent.dispatch({ type: 'refused', project, request, error: (err as Error).message, at });
  }
}

/** A scan's task for the agent (read it in, check it, fix what was flagged), from its fixed words. */
export async function askScan(task: ScanTask, scan: string, project: string, context: RequestContext): Promise<void> {
  if (!isOn(state)) return;
  const at = serverNow();
  const request = task === 'read' ? 'Read this scan' : task === 'check' ? 'Check this scan' : 'Fix what was flagged';
  agent.dispatch({ type: 'sending', project, request, at });
  try {
    const { job } = await call<{ job: string }>('POST', '/api/agent/requests', {
      project,
      text: '',
      context,
      preset: { kind: 'scan', task, scan },
    });
    agent.dispatch({
      type: 'sent',
      job: { id: job, project, device: state.me ?? '', state: 'waiting', request, started: at },
    });
  } catch (err) {
    agent.dispatch({ type: 'refused', project, request, error: (err as Error).message, at });
  }
}

/**
 * Try again: a request whose last go failed, carried on in the same conversation (the host starts a
 * job that continues it). The bar shows it on its way, then working, as a request. With a `choice` it's
 * carried on with that harness, model and effort, the song's own from then on (null: what Settings ›
 * Agent says, again); the host tells the song's studios, which read its conversation again.
 */
export async function tryAgain(
  ex: Pick<Exchange, 'job' | 'request' | 'continues'>,
  project: string,
  choice?: Choice | null,
): Promise<void> {
  if (!ex.job || !isOn(state)) return;
  const at = serverNow();
  const continues = ex.continues ?? ex.job;
  agent.dispatch({ type: 'sending', project, request: ex.request, at, continues });
  try {
    const { job } = await call<{ job: string }>(
      'POST',
      `/api/agent/jobs/${encodeURIComponent(ex.job)}/continue`,
      choice === undefined ? {} : (choice ?? { harness: null }),
    );
    agent.dispatch({
      type: 'sent',
      job: { id: job, project, device: state.me ?? '', state: 'waiting', request: ex.request, started: at, continues },
    });
  } catch (err) {
    agent.dispatch({ type: 'refused', project, request: ex.request, error: (err as Error).message, at });
  }
}

/**
 * "Carry on when it resets": the host carries the failed request on by itself once its harness's limit
 * has started again, or (`on` false) no longer does. The host tells the studios that show it.
 */
export async function waitForReset(job: string, on: boolean): Promise<void> {
  await call(on ? 'POST' : 'DELETE', `/api/agent/jobs/${encodeURIComponent(job)}/wait`);
}

export async function stopJob(job: string): Promise<void> {
  await call('POST', `/api/agent/jobs/${encodeURIComponent(job)}/cancel`);
}

/** The user's answer to what a job asked: allowed (with what happened, and what it brought: a screenshot), or not. */
export async function permit(job: string, grant: boolean, result: string, attachments: string[] = []): Promise<void> {
  await call('POST', `/api/agent/jobs/${encodeURIComponent(job)}/permission`, {
    grant,
    result,
    ...(attachments.length ? { attachments } : {}),
  });
}

/** The user is done playing to the listening agent. */
export async function doneListening(job: string): Promise<void> {
  agent.dispatch({ type: 'listen', job, on: false });
  await call('POST', `/api/agent/jobs/${encodeURIComponent(job)}/done-listening`).catch(() => undefined);
}

/** "Start a new conversation": the song's next request starts afresh. */
export async function newConversation(project: string): Promise<void> {
  await call('POST', `/api/agent/threads/${encodeURIComponent(project)}/reset`);
  agent.dispatch({ type: 'reset', project });
  agent.dispatch({ type: 'choosing', project: null });
}

/** This device was removed: its token goes, and so does everything of the agent's. */
function deviceRemoved(): void {
  forgetToken();
  agent.dispatch({ type: 'removed' });
  tokenChanged();
}

/**
 * The agent's messages on the live channel. True when it was one; `effects` says what the studio
 * does about a job's status (whether it runs, its step's final name).
 */
export function agentMessage(msg: Record<string, unknown>): { handled: boolean; effects?: JobEffect } {
  switch (msg.type) {
    case 'agent-status': {
      const job = msg.job as JobView | undefined;
      if (!job || typeof job.id !== 'string' || !isOn(state)) return { handled: true };
      heardClock(msg.now);
      const was = state.jobs[job.id];
      agent.dispatch({ type: 'status', job, barOpen: barShows(job.project) });
      const fx = statusEffects(state, job, was);
      // (where a reply goes is a place in its own song: not the one open now, if that's another)
      if (fx?.go && job.project !== studio.get().project?.id) delete fx.go;
      return { handled: true, ...(fx ? { effects: { job: job.id, ...fx } } : {}) };
    }
    case 'agent-listen':
      // `on` as a listen begins, `off` once it's over (nothing comes between two of its parts: it keeps showing)
      if (typeof msg.job === 'string' && (msg.state === 'on' || msg.state === 'off'))
        agent.dispatch({ type: 'listen', job: msg.job, on: msg.state === 'on' });
      return { handled: true };
    case 'agent-settings': {
      // turned on or off, or (to allowed devices) its harness, model or effort changed, on some device
      if (typeof msg.enabled !== 'boolean') return { handled: true };
      if (!state.info) void refreshAgent();
      else agent.dispatch({ type: 'enabled', enabled: msg.enabled });
      if (Array.isArray(msg.harnesses)) agent.dispatch({ type: 'settings', settings: msg as unknown as AgentSettings });
      // turned on: whether this device may use it is the host's to say
      if (msg.enabled && !isOn(state)) void refreshAgent();
      return { handled: true };
    }
    case 'agent-harness': {
      const event = msg as unknown as HarnessEvent;
      agent.dispatch({ type: 'harness', event });
      if (event.state !== 'running') void loadSettings().catch(() => undefined);
      return { handled: true };
    }
    case 'agent-devices':
      if (isOn(state) || state.info?.allowed) void loadDevices().catch(() => undefined);
      return { handled: true };
    case 'agent-thread':
      // what a song's conversation runs with changed (on this device or another): it's read again
      if (typeof msg.project === 'string' && state.thread?.project === msg.project)
        void loadThread(msg.project, barShows(msg.project));
      return { handled: true };
    case 'agent-removed':
      deviceRemoved();
      return { handled: true };
  }
  return { handled: false };
}

/** The bar (or the page) is open on a song: a reply that ends there is seen as it comes. */
function barShows(project: string): boolean {
  const s = studio.get();
  return s.bar && s.project?.id === project;
}

/** What the studio does about one of its jobs: whether it runs, its step's final name, where it goes. */
export type JobEffect = { job: string; running: boolean; label?: string; go?: Go };

/** How many runners the host's last list of who's connected had (null: none seen since the channel opened). */
let runnersKnown: number | null = null;

/**
 * The host's list of who's connected (`peers`): when its runners change (the runner came back after
 * the host restarted, or went), the host is asked how the agent stands, for Settings to say so.
 */
export function peersSeen(peers: readonly { role: string }[]): void {
  const runners = peers.filter((p) => p.role === 'runner').length;
  if (runners === runnersKnown) return;
  runnersKnown = runners;
  void refreshAgent();
}

/**
 * The live channel is back (after the host restarted, say): how the agent stands, and for an allowed
 * device its settings and devices, and the jobs this studio was following. A restart ends those; one
 * may also have ended unheard while away. What the studio then does about its own jobs is returned.
 */
export async function catchUp(): Promise<JobEffect[]> {
  runnersKnown = null;
  const info = await refreshAgent();
  if (!info?.allowed) return [];
  await Promise.all([loadSettings(), loadDevices()]).catch(() => undefined);
  if (!isOn(state)) return [];
  const followed = Object.values(state.jobs).filter((j) => isLive(j.state) || j.state === 'awaiting');
  const effects: JobEffect[] = [];
  for (const project of new Set(followed.map((j) => j.project))) {
    let r: { thread: { turns: Turn[] } | null; job?: JobView | null; now?: number };
    try {
      r = await call('GET', `/api/agent/threads/${encodeURIComponent(project)}`);
    } catch {
      continue;
    }
    heardClock(r.now);
    for (const j of followed.filter((x) => x.project === project)) {
      const turn = r.thread?.turns.find((t) => t.job === j.id);
      const now = r.job?.id === j.id ? r.job : asEnded(j, turn);
      if (!now) continue;
      agent.dispatch({ type: 'status', job: now, barOpen: barShows(now.project) });
      const fx = statusEffects(state, now);
      if (fx) effects.push({ job: now.id, ...fx });
    }
  }
  return effects;
}

/** A job the host no longer runs, as its conversation's turn tells it (none: it was lost, as failed). */
function asEnded(j: JobView, turn: Turn | undefined): JobView | null {
  // (a turn still under way while the host has no job for it: it's asked again next time)
  if (turn && (isLive(turn.state) || turn.state === 'awaiting')) return null;
  return {
    ...j,
    state: (turn?.state ?? 'failed') as JobState,
    ...(turn?.reply ? { reply: turn.reply } : {}),
    ...(turn?.label ? { label: turn.label } : {}),
    ...(turn?.brief ? { brief: turn.brief, briefWarnings: turn.briefWarnings ?? [] } : {}),
    ...(turn?.view ? { view: turn.view } : {}),
    ...(turn?.error ? { error: turn.error } : {}),
    ...(turn?.wait ? { wait: turn.wait } : {}),
    finished: Date.now(),
  };
}
