/**
 * HO[LO] Remote's side of the live channel: a phone (or a tablet) by the instruments that shows the
 * studio open on another device and drives it. It never starts audio of its own: the studio reports
 * what it's doing a few times a second (and its levels a dozen), and the remote's buttons, faders and
 * pads go back to it as commands and MIDI.
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
}

export interface RemoteState {
  connection: 'connecting' | 'online' | 'offline';
  /** Every open studio by its device's name, with when it last reported. */
  studios: Record<string, StudioEntry>;
  /** The studio this remote drives (null: the most recently active). */
  chosen: string | null;
  notice: { text: string; at: number } | null;
}

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

/** The studio being driven: the chosen one if it's open, else the one that reported last. */
export function activeStudio(s: RemoteState = state): StudioEntry | null {
  const chosen = s.chosen ? s.studios[s.chosen] : undefined;
  if (chosen) return chosen;
  let best: StudioEntry | null = null;
  for (const e of Object.values(s.studios)) if (!best || e.at > best.at) best = e;
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
  }
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
      set({ studios: { ...state.studios, [name]: { name, state: complete(msg.state), at: Date.now() } } });
      return;
    }
    case 'studio-gone': {
      const { [String(msg.name)]: _gone, ...rest } = state.studios;
      set({ studios: rest });
      return;
    }
    case 'meters': {
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

export function connectRemote(name: string): void {
  myName = name;
  started = true;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/live`);
  socket = ws;
  ws.onopen = () => {
    retry = 1000;
    set({ connection: 'online' });
    send({ type: 'hello', role: 'remote', name: myName });
  };
  ws.onmessage = (e) => {
    try {
      onMessage(JSON.parse(String(e.data)) as Record<string, unknown>);
    } catch {
      // not for us
    }
  };
  ws.onclose = () => {
    socket = null;
    set({ connection: 'offline', studios: {} });
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(() => connectRemote(myName), retry);
    retry = Math.min(4000, retry * 2);
  };
}

if (typeof window !== 'undefined') {
  const again = () => {
    if (socket || !started) return;
    window.clearTimeout(retryTimer);
    retry = 1000;
    connectRemote(myName);
  };
  window.addEventListener('online', again);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') again();
  });
}
