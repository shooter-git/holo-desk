/**
 * The in-app agent, as the studio sees it (docs/agent.md): whether it's on for this device, its
 * settings and devices, the open song's conversation, and the jobs asked for here (followed across a
 * reload, so a page the browser let go comes back to them). While it's off, or this device isn't
 * allowed, nothing of it shows, reports or asks anything.
 *
 * The device's token is kept apart from the view this device remembers (`holo:view`), in a key of its
 * own, and goes only to HO[LO]'s host: as the bearer of the agent's routes, and in each live hello.
 */
import type { Go, View } from '@holo/agent/view';
import { type Project, parseProject } from '@holo/session';
import { useSyncExternalStore } from 'react';
import { IDLE_MS, patiently } from './api.ts';
import type { Ready } from './attach.ts';
import { type Command, selectionSpan } from './commands.ts';
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

export interface AgentSettings {
  enabled: boolean;
  harness: HarnessId | null;
  model: string;
  effort: string;
  harnesses: HarnessInfo[];
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
export type PermissionKind = 'install-pack' | 'send-creation' | 'bounce' | 'render' | 'screen' | 'photo' | 'microphone';

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
  error?: string;
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
  /** The open song's conversation as the host keeps it (read when the bar opens). */
  thread: { project: string; turns: Turn[] } | null;
  /** A request on its way to the host (it has no job yet). */
  sending: { project: string; request: string; at: number } | null;
  /** A request the host turned down: what was asked, and why (shown as the reply). */
  refused: { project: string; request: string; error: string; at: number } | null;
  /** The job listening to what's played, until the user says Done. */
  listening: string | null;
  /** One of this device's jobs ended while the bar was closed: a dot on the bar's button until it opens. */
  unseen: boolean;
}

export const EMPTY: AgentState = {
  info: null,
  me: null,
  settings: null,
  devices: null,
  harness: {},
  jobs: {},
  thread: null,
  sending: null,
  refused: null,
  listening: null,
  unseen: false,
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
  | { type: 'thread'; project: string; turns: Turn[] }
  | { type: 'sending'; project: string; request: string; at: number }
  | { type: 'sent'; job: JobView }
  | { type: 'refused'; project: string; request: string; error: string; at: number }
  | { type: 'reset'; project: string }
  | { type: 'seen' }
  | { type: 'removed' };

export function reduce(a: AgentState, e: AgentEvent): AgentState {
  switch (e.type) {
    case 'info':
      // the agent turned off (or this device was let go): nothing of it is kept to show
      return e.info.enabled && e.info.allowed ? { ...a, info: e.info } : { ...EMPTY, info: e.info, me: a.me };
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
      // one of this device's ends while the bar is closed: the button says so until it's opened
      const ended = !isLive(e.job.state) && (!was || isLive(was.state));
      const sending = a.sending?.project === e.job.project && a.sending.request === e.job.request ? null : a.sending;
      return {
        ...a,
        jobs: { ...a.jobs, [e.job.id]: e.job },
        sending,
        listening: a.listening === e.job.id && !isLive(e.job.state) ? null : a.listening,
        unseen: a.unseen || (mine && ended && !e.barOpen),
      };
    }
    case 'listen':
      return { ...a, listening: e.on ? e.job : a.listening === e.job ? null : a.listening };
    case 'thread':
      return { ...a, thread: { project: e.project, turns: e.turns } };
    case 'sending':
      return { ...a, sending: { project: e.project, request: e.request, at: e.at }, refused: null };
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
        thread: a.thread?.project === e.project ? { project: e.project, turns: [] } : a.thread,
        refused: a.refused?.project === e.project ? null : a.refused,
      };
    }
    case 'seen':
      return a.unseen ? { ...a, unseen: false } : a;
    case 'removed':
      return { ...EMPTY, info: a.info ? { ...a.info, allowed: false } : null };
  }
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

/** The last exchange on a song, as the bar shows it under its field. */
export interface Exchange {
  /** Its job (none while the request is on its way, or when it was turned down). */
  job: string | null;
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
}

/** Why a job ended without a reply, as said under the request. */
function endedWhy(state: string, error?: string | null): string | null {
  if (error) return error;
  if (state === 'cancelled') return 'Stopped';
  if (state === 'failed') return 'It stopped before it was done';
  return null;
}

/**
 * The song's latest exchange: the newest of a request on its way, one turned down, the jobs the host
 * told of, and the conversation's last turn. Null when the song has none.
 */
export function exchange(a: AgentState, project: string | null): Exchange | null {
  if (!project || !isOn(a)) return null;
  type Seen = { at: number; make: () => Exchange };
  const seen: Seen[] = [];
  const base = { permission: null, brief: null, flagged: new Map(), mine: false, listening: false, view: null };
  if (a.sending?.project === project) {
    const s = a.sending;
    seen.push({
      at: s.at,
      make: () => ({ ...base, job: null, request: s.request, working: true, line: null, reply: null, mine: true }),
    });
  }
  if (a.refused?.project === project) {
    const r = a.refused;
    seen.push({
      at: r.at,
      make: () => ({ ...base, job: null, request: r.request, working: false, line: null, reply: r.error, mine: true }),
    });
  }
  for (const j of Object.values(a.jobs)) {
    if (j.project !== project) continue;
    seen.push({
      at: j.started,
      make: () => ({
        job: j.id,
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
      }),
    });
  }
  const last = a.thread?.project === project ? a.thread.turns[a.thread.turns.length - 1] : undefined;
  if (last && !a.jobs[last.job]) {
    seen.push({
      at: last.at,
      make: () => ({
        ...base,
        job: last.job,
        request: last.request,
        working: isLive(last.state),
        line: null,
        reply: isLive(last.state) ? null : (last.reply ?? endedWhy(last.state, last.error)),
        permission: last.state === 'awaiting' ? (last.permission ?? null) : null,
        brief: last.brief ?? null,
        flagged: new Map((last.briefWarnings ?? []).map((w) => [w.line, w.kind])),
        // (the host answers a permission only from the device that asked)
        mine: true,
        view: isLive(last.state) ? null : (last.view ?? null),
      }),
    });
  }
  if (!seen.length) return null;
  seen.sort((x, y) => y.at - x.at);
  return (seen[0] as Seen).make();
}

/** What the bar's button shows: a turning ring while a job of this device's works on the open song, a dot after. */
export function barSign(a: AgentState, project: string | null): 'busy' | 'done' | null {
  if (!isOn(a)) return null;
  const working =
    (a.sending !== null && a.sending.project === project) ||
    Object.values(a.jobs).some((j) => j.project === project && j.device === a.me && isLive(j.state));
  if (working) return 'busy';
  return a.unseen ? 'done' : null;
}

/** What a permission's one button says. */
const ALLOW: Record<PermissionKind, string> = {
  'install-pack': 'Install it',
  'send-creation': 'Send it',
  bounce: 'Bounce the song',
  render: 'Hear it as the creation plays it',
  screen: 'Share the screen',
  photo: 'Take a photo',
  microphone: 'Record',
};

/** A download's size, as the Library says it ("131 MB"). */
function diskSize(bytes: number): string {
  if (bytes >= 1e9) return `${(bytes / 1e9).toFixed(1)} GB`;
  if (bytes >= 1e6) return `${Math.round(bytes / 1e6)} MB`;
  return `${Math.max(1, Math.round(bytes / 1e3))} KB`;
}

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
  s: Pick<AppState, 'editor' | 'noteView' | 'mobileTab' | 'scanView' | 'printView'>,
  phone: boolean,
): string {
  if (s.scanView) return 'scan';
  if (s.printView) return 'print';
  if (phone) {
    if (s.mobileTab === 'editor') return s.noteView === 'score' ? 'score' : 'piano roll';
    return s.mobileTab;
  }
  if (s.editor === 'mixer') return 'tracks and mixer';
  if (s.editor === 'piano') return `tracks and ${s.noteView === 'score' ? 'score' : 'piano roll'}`;
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
 * open, its three tasks (read it in, check what was written, fix what was flagged); and starting a new
 * conversation on the song when nothing runs on it.
 */
export function agentCommands(
  o: { on: boolean; project: string | null; scan: string | null; busy: boolean },
  run: { scan: (task: ScanTask, scan: string) => void; reset: () => void },
): { suggest: Command[]; commands: Command[] } {
  if (!o.on || !o.project) return { suggest: [], commands: [] };
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
  return { suggest: o.busy ? [] : scanRows, commands: [...scanRows, reset] };
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
          typeof f.started === 'number',
      )
      .slice(-FOLLOW_MOST);
  } catch {
    return [];
  }
}

/**
 * Which of this device's requests are followed once the host has said how one goes: one that's
 * working, or that ended while the bar was closed (its reply not seen yet), stays or comes in; one
 * seen (the bar open as it ended, or opened since) goes. A page the browser let go (a phone in another
 * app) comes back to them: the bar's button turns while they work, and shows a reply is waiting after.
 */
export function followed(list: readonly Followed[], a: AgentState, e: AgentEvent): Followed[] {
  const of = (j: JobView): Followed => ({
    id: j.id,
    project: j.project,
    device: j.device,
    request: j.request,
    started: j.started,
  });
  const without = (id: string) => list.filter((f) => f.id !== id);
  switch (e.type) {
    case 'sent':
      return [...without(e.job.id), of(e.job)].slice(-FOLLOW_MOST);
    case 'status': {
      if (e.job.device !== a.me) return [...list];
      // (`a` is as it is now: a reply that came while the bar was closed has left it unseen)
      const seen = !isLive(e.job.state) && (e.barOpen || !a.unseen);
      return seen ? without(e.job.id) : [...without(e.job.id), of(e.job)].slice(-FOLLOW_MOST);
    }
    case 'seen':
      return list.filter((f) => a.jobs[f.id] && isLive(a.jobs[f.id]?.state ?? ''));
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

/** `idleMs`: given up only once nothing of the answer has come for that long (`patiently`). */
async function call<T>(
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

/** The open song's conversation, for the bar. */
export async function loadThread(project: string): Promise<void> {
  if (!isOn(state)) return;
  try {
    const r = await call<{ thread: { turns: Turn[] } | null; job?: JobView | null }>(
      'GET',
      `/api/agent/threads/${encodeURIComponent(project)}`,
    );
    agent.dispatch({ type: 'thread', project, turns: r.thread?.turns ?? [] });
    // the song's job that's working, or waiting for a click (after a reload, its button comes back)
    if (r.job) agent.dispatch({ type: 'status', job: r.job, barOpen: true });
  } catch {
    // the bar shows what it has
  }
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
  const at = Date.now();
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
  const at = Date.now();
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
      const was = state.jobs[job.id];
      agent.dispatch({ type: 'status', job, barOpen: studio.get().bar });
      const fx = statusEffects(state, job, was);
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
    case 'agent-removed':
      deviceRemoved();
      return { handled: true };
  }
  return { handled: false };
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
    let r: { thread: { turns: Turn[] } | null; job?: JobView | null };
    try {
      r = await call('GET', `/api/agent/threads/${encodeURIComponent(project)}`);
    } catch {
      continue;
    }
    for (const j of followed.filter((x) => x.project === project)) {
      const turn = r.thread?.turns.find((t) => t.job === j.id);
      const now = r.job?.id === j.id ? r.job : asEnded(j, turn);
      if (!now) continue;
      agent.dispatch({ type: 'status', job: now, barOpen: studio.get().bar });
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
    finished: Date.now(),
  };
}
