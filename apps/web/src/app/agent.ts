/**
 * The in-app agent, as the studio sees it (docs/agent.md): whether it's on for this device, its
 * settings and devices, the open song's conversation, and the jobs asked for here. While it's off, or
 * this device isn't allowed, nothing of it shows, reports or asks anything.
 *
 * The device's token is kept apart from the view this device remembers (`holo:view`), in a key of its
 * own, and goes only to HO[LO]'s host: as the bearer of the agent's routes, and in each live hello.
 */
import { useSyncExternalStore } from 'react';
import { selectionSpan } from './commands.ts';
import { type AppState, store as studio } from './store.ts';

export type HarnessId = 'claude' | 'codex' | 'cursor';

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
  reason?: string;
  models?: string[];
  efforts?: string[];
}

export interface AgentSettings {
  enabled: boolean;
  harness: HarnessId | null;
  model: string;
  effort: string;
  harnesses: HarnessInfo[];
}

/** What the host says of the agent, to anyone: on or off, this device allowed, the first device still to pair. */
export interface AgentInfo {
  enabled: boolean;
  allowed: boolean;
  pairing: boolean;
  runner: { connected: boolean; keyed: boolean };
}

export type JobState = 'waiting' | 'running' | 'awaiting' | 'done' | 'failed' | 'cancelled';
export type PermissionKind = 'install-pack' | 'send-creation' | 'screen' | 'photo';

export interface Permission {
  kind: PermissionKind;
  detail: string;
  pack?: string;
}

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
  briefWarnings?: { line: number; kind: 'command' | 'url' }[];
  error?: string;
  started: number;
  finished?: number;
}

/** A request and its reply, as the song's conversation keeps them. */
export interface Turn {
  job: string;
  request: string;
  reply: string | null;
  label: string | null;
  state: string;
  at: number;
}

/** How a harness's sign-in, update or new look goes, from the runner (`agent-harness`). */
export interface HarnessEvent {
  harness: HarnessId;
  kind: 'login' | 'update' | 'refresh';
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
    case 'settings':
      return { ...a, settings: e.settings };
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

/** What the studio does when the host says how one of its jobs goes: whether it runs, and its step's final name. */
export function statusEffects(a: AgentState, job: JobView): { running: boolean; label?: string } | null {
  if (job.device !== a.me) return null;
  const running = isLive(job.state);
  return !running && job.label ? { running, label: job.label } : { running };
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
  flagged: Map<number, 'command' | 'url'>;
  /** Asked for here: only this device answers a permission. */
  mine: boolean;
  listening: boolean;
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
  const base = { permission: null, brief: null, flagged: new Map(), mine: false, listening: false };
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
        reply: isLive(last.state) ? null : (last.reply ?? endedWhy(last.state)),
        mine: true,
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

// ---- the store ----

let state: AgentState = { ...EMPTY, me: (() => storage()?.getItem(DEVICE_KEY) ?? null)() };
const listeners = new Set<() => void>();

export const agent = {
  get: (): AgentState => state,
  dispatch(e: AgentEvent): void {
    const next = reduce(state, e);
    if (next === state) return;
    state = next;
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
  constructor(
    message: string,
    readonly status: number,
    readonly reason?: string,
  ) {
    super(message);
  }
}

async function call<T>(method: 'GET' | 'POST' | 'PUT' | 'DELETE', path: string, body?: unknown): Promise<T> {
  const t = token();
  const res = await fetch(path, {
    method,
    headers: {
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
      ...(t ? { authorization: `Bearer ${t}` } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  const data = (await res.json().catch(() => ({}))) as Record<string, unknown>;
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

/** Ask the host how the agent stands (at start, on reconnecting, from Settings). */
export async function refreshAgent(): Promise<AgentInfo | null> {
  let info: AgentInfo;
  try {
    info = await call<AgentInfo>('GET', '/api/agent');
  } catch {
    return null;
  }
  // a token the host no longer takes (the device was removed while away) is let go
  if (token() && !info.allowed) {
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

/** The first device: the runner prints a code on the host. */
export async function startPairing(): Promise<number> {
  return (await call<{ expires: number }>('POST', '/api/agent/pairing')).expires;
}

/** Pair with the runner's code: this device is allowed, and the agent turns on. */
export async function pair(code: string, name: string): Promise<void> {
  const r = await call<{ token: string; device: { id: string } }>('POST', '/api/agent/pair', { code, name });
  allowedNow(r.token, r.device.id);
  await refreshAgent();
}

function allowedNow(t: string, device: string): void {
  keepToken(t, device);
  agent.dispatch({ type: 'me', id: device });
  tokenChanged();
}

/** A later device asks to join: an allowed one approves it. */
export async function askToJoin(name: string): Promise<{ id: string; secret: string; code: string }> {
  return call('POST', '/api/agent/devices/requests', { name });
}

/** How the request stands; once approved, this device is allowed. */
export async function pollJoin(id: string, secret: string): Promise<'pending' | 'approved' | 'denied' | 'lapsed'> {
  let r: { state: 'pending' | 'approved' | 'denied'; token?: string; device?: { id: string } };
  try {
    r = await call('GET', `/api/agent/devices/requests/${encodeURIComponent(id)}?secret=${encodeURIComponent(secret)}`);
  } catch (err) {
    if (err instanceof AgentError && err.status === 404) return 'lapsed';
    throw err;
  }
  if (r.state === 'approved' && r.token && r.device) {
    allowedNow(r.token, r.device.id);
    await refreshAgent();
  }
  return r.state;
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

export async function harnessAction(harness: HarnessId, action: 'login' | 'update'): Promise<void> {
  await call('POST', `/api/agent/harnesses/${harness}/${action}`);
}

export async function sendLoginCode(harness: HarnessId, code: string): Promise<void> {
  await call('POST', `/api/agent/harnesses/${harness}/login/code`, { code });
}

export async function lookForHarnesses(): Promise<void> {
  await call('POST', '/api/agent/harnesses/refresh');
}

/** The open song's conversation, for the bar. */
export async function loadThread(project: string): Promise<void> {
  if (!isOn(state)) return;
  try {
    const r = await call<{ thread: { turns: Turn[] } | null }>(
      'GET',
      `/api/agent/threads/${encodeURIComponent(project)}`,
    );
    agent.dispatch({ type: 'thread', project, turns: r.thread?.turns ?? [] });
  } catch {
    // the bar shows what it has
  }
}

/** Send a request about the open song: the bar shows it, then the reply. */
export async function ask(text: string, project: string, context: RequestContext): Promise<void> {
  const request = text.trim();
  if (!request || !isOn(state)) return;
  const at = Date.now();
  agent.dispatch({ type: 'sending', project, request, at });
  try {
    const { job } = await call<{ job: string }>('POST', '/api/agent/requests', { project, text: request, context });
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

/** The user's answer to what a job asked: allowed (with what happened), or not. */
export async function permit(job: string, grant: boolean, result: string): Promise<void> {
  await call('POST', `/api/agent/jobs/${encodeURIComponent(job)}/permission`, { grant, result });
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
export function agentMessage(msg: Record<string, unknown>): {
  handled: boolean;
  effects?: { job: string; running: boolean; label?: string };
} {
  switch (msg.type) {
    case 'agent-status': {
      const job = msg.job as JobView | undefined;
      if (!job || typeof job.id !== 'string' || !isOn(state)) return { handled: true };
      agent.dispatch({ type: 'status', job, barOpen: studio.get().bar });
      const fx = statusEffects(state, job);
      return { handled: true, ...(fx ? { effects: { job: job.id, ...fx } } : {}) };
    }
    case 'agent-listen':
      if (typeof msg.job === 'string') agent.dispatch({ type: 'listen', job: msg.job, on: msg.state === 'on' });
      return { handled: true };
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
    case 'agent-look':
    case 'agent-compare':
      // a look at the screen or a photo (step C13), and A/B (step C14)
      return { handled: true };
  }
  return { handled: false };
}
