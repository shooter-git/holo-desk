/**
 * HO[LO] Remote's side of the live channel: a phone (or a tablet) by the instruments that shows the
 * studio open on another device and drives it. It never starts audio of its own: the studio reports
 * what it's doing when it changes (a few times a second while it plays) and its levels a dozen times a
 * second, and the remote's buttons, faders and pads go back to it as commands and MIDI.
 */
import type { MeterPoint, MiddleC, TempoPoint } from '@holo/session';
import { useSyncExternalStore } from 'react';

export interface StudioTrack {
  id: string;
  name: string;
  color: string;
  kind: 'instrument' | 'audio';
  sub: string;
  armed: boolean;
  mute: boolean;
  solo: boolean;
  volume: number;
  pan: number;
}

export interface StudioState {
  project: string | null;
  title: string | null;
  playing: boolean;
  recording: boolean;
  tick: number;
  position: string;
  bpm: number;
  selection: { track: string | null };
  cycle: { on: boolean; start: number; end: number };
  middleC: MiddleC;
  device: string;
  audio: boolean;
  seconds: number;
  sig: string;
  key: string | null;
  metronome: boolean;
  countIn: number;
  canUndo: boolean;
  canRedo: boolean;
  saveState: string;
  markers: { tick: number; name: string; at: string }[];
  tracks: StudioTrack[];
  master: { volume: number } | null;
  tempo?: TempoPoint[];
  meter?: MeterPoint[];
}

export interface StudioEntry {
  name: string;
  state: StudioState;
  /** When it last reported (this device's clock). */
  at: number;
  /**
   * The host's clock when that report was made. The host repeats a studio's last report to a remote
   * that says hello (on connecting, and when checking the socket is alive): the same value again is
   * that repeat, not news from the studio.
   */
  updated?: number;
}

export interface RemoteState {
  connection: 'connecting' | 'online' | 'offline';
  /** Every open studio by its device's name, with when it last reported. */
  studios: Record<string, StudioEntry>;
  /** The studio this remote drives (null: the most recently active). */
  chosen: string | null;
  /**
   * Whole seconds since the driven studio was last heard from, once that silence means something
   * (it was playing, or its audio was running, so it should be heard from steadily); null while it
   * is in touch, or quiet because it has nothing to report.
   */
  stale: number | null;
  notice: { text: string; at: number } | null;
}

/** After this long without a word from a studio that should be talking, what's shown is stale. */
export const STALE_MS = 2000;

let state: RemoteState = {
  connection: 'connecting',
  studios: {},
  chosen: (() => {
    try {
      return localStorage.getItem('holo:remote-studio');
    } catch {
      return null;
    }
  })(),
  stale: null,
  notice: null,
};
const listeners = new Set<() => void>();

function set(patch: Partial<RemoteState>): void {
  state = { ...state, ...patch };
  for (const fn of listeners) fn();
}

export const remote = {
  get: () => state,
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useRemote<T>(pick: (s: RemoteState) => T): T {
  return useSyncExternalStore(remote.subscribe, () => pick(state));
}

/**
 * When each studio was last heard from at all, by name: a state report or its levels, which keep
 * coming while its audio runs. Kept out of React: the levels arrive a dozen times a second.
 */
const heard = new Map<string, number>();

/** How long ago the studio was heard from (its last report, when it has sent no levels since). */
export function silence(entry: StudioEntry, now = Date.now()): number {
  return now - Math.max(entry.at, heard.get(entry.name) ?? 0);
}

/**
 * Whether the studio has gone quiet for longer than it could while talking: a studio reports only
 * what changes, so an idle one is rightly silent, but one that was playing reports its position
 * steadily and one with its audio running sends levels steadily.
 */
export function isStale(entry: StudioEntry, now = Date.now()): boolean {
  const s = entry.state;
  const talking = s.playing || (s.audio && s.project !== null);
  return talking && silence(entry, now) > STALE_MS;
}

/** The studio being driven: the chosen one if it's open, else the one heard from last. */
export function activeStudio(s: RemoteState = state): StudioEntry | null {
  const chosen = s.chosen ? s.studios[s.chosen] : undefined;
  if (chosen) return chosen;
  let best: StudioEntry | null = null;
  for (const e of Object.values(s.studios)) if (!best || silence(e) < silence(best)) best = e;
  return best;
}

export function chooseStudio(name: string | null): void {
  try {
    if (name) localStorage.setItem('holo:remote-studio', name);
    else localStorage.removeItem('holo:remote-studio');
  } catch {
    // remembered for this visit only
  }
  set({ chosen: name });
}

/** Levels by track id (and "master"): read every frame, so kept out of React. */
export const levels = new Map<string, [number, number]>();

let socket: WebSocket | null = null;
let retry = 1000;
let retryTimer = 0;
let myName = 'Remote';
let started = false;

function send(msg: unknown): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(msg));
  return true;
}

/** A button, fader or setting, for the studio to carry out. */
export function command(action: string, args: Record<string, unknown> = {}): void {
  const studio = activeStudio();
  if (!send({ type: 'command', action, studio: studio?.name ?? null, ...args })) {
    notify('Not connected to HO[LO]. Trying again…');
    return;
  }
  // a studio that should be talking but isn't: make sure the socket itself is still alive
  if (studio && isStale(studio)) probe();
}

/**
 * Show a change at once, before the studio confirms it (its next report, a fraction of a second
 * later, replaces this either way).
 */
export function optimistic(change: (s: StudioState) => StudioState): void {
  const active = activeStudio();
  if (!active) return;
  set({ studios: { ...state.studios, [active.name]: { ...active, state: change(active.state) } } });
}

/** Notes from the keyboard and pads: the studio hears them as a MIDI device named after this remote. */
export function sendMidi(data: number[]): void {
  send({ type: 'midi', data, sent: Date.now() });
}

export function notify(text: string): void {
  set({ notice: { text, at: Date.now() } });
}

/** A studio's report with every field there (a studio on an older version leaves some out). */
function complete(raw: unknown): StudioState {
  const s = (raw ?? {}) as Partial<StudioState>;
  return {
    project: s.project ?? null,
    title: s.title ?? null,
    playing: s.playing === true,
    recording: s.recording === true,
    tick: typeof s.tick === 'number' ? s.tick : 0,
    position: s.position ?? '',
    bpm: typeof s.bpm === 'number' ? s.bpm : 120,
    selection: { track: s.selection?.track ?? null },
    cycle: s.cycle ?? { on: false, start: 0, end: 0 },
    middleC: s.middleC ?? 'C3',
    device: s.device ?? '',
    audio: s.audio !== false,
    seconds: s.seconds ?? 0,
    sig: s.sig ?? '4/4',
    key: s.key ?? null,
    metronome: s.metronome === true,
    countIn: s.countIn ?? 0,
    canUndo: s.canUndo === true,
    canRedo: s.canRedo === true,
    saveState: s.saveState ?? 'saved',
    markers: Array.isArray(s.markers) ? s.markers : [],
    tracks: Array.isArray(s.tracks) ? s.tracks : [],
    master: s.master ?? null,
    tempo: Array.isArray(s.tempo) ? s.tempo : [],
    meter: Array.isArray(s.meter) ? s.meter : [],
  };
}

function onMessage(msg: Record<string, unknown>): void {
  switch (msg.type) {
    case 'studio': {
      const name = String(msg.name);
      const updated = (msg.state as { updated?: unknown } | null)?.updated;
      const known = state.studios[name];
      if (known && typeof updated === 'number' && known.updated === updated) return;
      const now = Date.now();
      heard.set(name, now);
      const entry: StudioEntry = { name, state: complete(msg.state), at: now };
      if (typeof updated === 'number') entry.updated = updated;
      set({ studios: { ...state.studios, [name]: entry } });
      return;
    }
    case 'studio-gone': {
      const name = String(msg.name);
      heard.delete(name);
      const { [name]: _gone, ...rest } = state.studios;
      set({ studios: rest });
      return;
    }
    case 'peers': {
      // the host's own list of who is connected: a studio kept through a dropped connection that
      // closed meanwhile is not coming back
      if (!Array.isArray(msg.peers)) return;
      const open = new Set<string>();
      for (const p of msg.peers as { role?: string; name?: string }[])
        if (p.role === 'editor' && p.name) open.add(p.name);
      const studios: Record<string, StudioEntry> = {};
      let dropped = false;
      for (const [name, e] of Object.entries(state.studios)) {
        if (open.has(name)) studios[name] = e;
        else {
          heard.delete(name);
          dropped = true;
        }
      }
      if (dropped) set({ studios });
      return;
    }
    case 'meters': {
      heard.set(String(msg.name), Date.now());
      const active = activeStudio();
      if (!active || active.name !== msg.name || !Array.isArray(msg.levels)) return;
      for (const [id, l, r] of msg.levels as [string, number, number][]) levels.set(id, [l, r]);
      return;
    }
    case 'notice':
      notify(String(msg.text ?? ''));
      return;
  }
}

/**
 * Whether the socket is really alive: a connection that died while the phone slept, or on a network
 * that dropped quietly, still says it is open, and everything sent into it is lost. The host answers
 * a hello straight away (with who is connected, then every open studio, so the display catches up as
 * well); if nothing at all arrives for a moment, the socket is closed so the usual retry runs.
 */
let probeTimer = 0;
function probe(): void {
  if (probeTimer || socket?.readyState !== WebSocket.OPEN) return;
  const ws = socket;
  probeTimer = window.setTimeout(() => {
    probeTimer = 0;
    if (socket !== ws) return;
    retry = 1000;
    ws.close();
  }, 1500);
  send({ type: 'hello', role: 'remote', name: myName });
}

function heardFromHost(): void {
  if (!probeTimer) return;
  window.clearTimeout(probeTimer);
  probeTimer = 0;
}

/**
 * Twice a second: whether the driven studio has gone quiet while it should be talking. Published only
 * as the whole seconds change, so a studio in touch costs nothing; the first silence also checks the
 * socket, which is the usual reason.
 */
let watchTimer = 0;
function watch(): void {
  const active = activeStudio();
  const stale = active && isStale(active) ? Math.floor(silence(active) / 1000) : null;
  if (stale !== null && state.stale === null && state.connection === 'online') probe();
  if (stale !== state.stale) set({ stale });
}

export function connectRemote(name: string): void {
  myName = name;
  started = true;
  if (!watchTimer) watchTimer = window.setInterval(watch, 500);
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/live`);
  socket = ws;
  ws.onopen = () => {
    retry = 1000;
    set({ connection: 'online' });
    send({ type: 'hello', role: 'remote', name: myName });
  };
  ws.onmessage = (e) => {
    heardFromHost();
    try {
      onMessage(JSON.parse(String(e.data)) as Record<string, unknown>);
    } catch {
      // not for us
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    heardFromHost();
    // the studios stay as last seen (shown as out of touch) rather than the display going blank
    // for every reconnection; the host says who is still there once we are back
    set({ connection: 'offline' });
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => connectRemote(myName), retry);
    retry = Math.min(4000, retry * 2);
  };
}

if (typeof window !== 'undefined') {
  const again = () => {
    if (!started) return;
    // a socket that looks open may have died while the phone slept: ask the host, and reconnect
    // if it doesn't answer
    if (socket) {
      probe();
      return;
    }
    window.clearTimeout(retryTimer);
    retry = 1000;
    connectRemote(myName);
  };
  window.addEventListener('online', again);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') again();
  });
}
