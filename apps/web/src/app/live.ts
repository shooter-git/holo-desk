/**
 * The studio's side of the live channel. It reports what the studio is doing (so the AI knows the
 * playhead, the selection and the song), applies the AI's changes as undo steps, follows transport
 * commands, plays the AI's notes and passes on notes from other devices.
 */
import { type ChannelPatch, formatBarBeat, newId, type Op, tickToSeconds } from '@holo/session';
import { engine } from '../audio/engine.ts';
import { midi } from '../audio/midi.ts';
import { inputLabel, instrumentLabel } from '../ui/Tracks.tsx';
import {
  apply,
  beginGesture,
  bounceSong,
  endGesture,
  ensureAudio,
  gestureChange,
  locate,
  moveBars,
  openProject,
  play,
  redo,
  saveNow,
  selectTrack,
  setCycle,
  stop,
  toggleCycle,
  toggleMetronome,
  toggleRecord,
  undo,
  updateChannel,
  updateTrack,
} from './actions.ts';
import { store, toast } from './store.ts';

let socket: WebSocket | null = null;
let retry = 1000;
let stateTimer = 0;
let lastSent = '';
let listening = 0;
const played: { tick: number | null; status: number; d1: number; d2: number; port: string }[] = [];

function send(msg: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

/** This device's name for the others: the one set in Audio & MIDI settings, or the browser and kind. */
export function device(): string {
  const named = store.get().deviceName.trim();
  if (named) return named;
  const ua = navigator.userAgent;
  const kind = /iPhone|Android.+Mobile/.test(ua) ? 'phone' : /iPad|Android/.test(ua) ? 'tablet' : 'computer';
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : 'Safari';
  return `${browser} on a ${kind}`;
}

function report(): void {
  const s = store.get();
  const p = s.project;
  const tick = engine.positionTick();
  const lat = engine.latency();
  const state = {
    project: p?.id ?? null,
    title: p?.title ?? null,
    revision: s.serverRevision,
    playing: s.playing,
    recording: s.recording,
    tick: Math.round(tick),
    position: p ? formatBarBeat(p.meter, Math.max(0, tick), true) : '',
    bpm: p?.tempo[0]?.bpm ?? 120,
    selection: { track: s.selectedTrack, regions: s.selectedRegions, notes: s.selectedNotes.length },
    cycle: p?.cycle ?? { on: false, start: 0, end: 0 },
    middleC: s.middleC,
    midiPorts: s.midiPorts.map((x) => x.name),
    latencyMs: engine.ctx ? Math.round((lat.base + lat.output) * 10) / 10 : null,
    device: device(),
    // for remotes: what a phone by the instruments shows and controls
    audio: engine.started,
    seconds: p ? Math.round(tickToSeconds(p.tempo, Math.max(0, tick)) * 10) / 10 : 0,
    sig: p ? `${p.meter[0]?.num ?? 4}/${p.meter[0]?.den ?? 4}` : '4/4',
    key: p?.key ?? null,
    metronome: s.metronome,
    countIn: s.countIn,
    canUndo: s.undo.length > 0,
    canRedo: s.redo.length > 0,
    saveState: s.saveState,
    markers: (p?.markers ?? []).map((m) => ({ tick: m.tick, name: m.name, at: formatBarBeat(p?.meter ?? [], m.tick) })),
    tracks: (p?.tracks ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      kind: t.kind,
      sub: t.kind === 'audio' ? inputLabel(t) : instrumentLabel(t.instrument),
      armed: t.armed,
      mute: t.channel.mute,
      solo: t.channel.solo,
      volume: t.channel.volume,
      pan: t.channel.pan,
    })),
    master: p ? { volume: p.master.volume } : null,
    tempo: p?.tempo ?? [],
    meter: p?.meter ?? [],
  };
  const json = JSON.stringify(state);
  if (json !== lastSent) {
    send({ type: 'state', state });
    lastSent = json;
  }
}

async function onMessage(msg: Record<string, unknown>): Promise<void> {
  const id = msg.id;
  const ack = (ok: boolean, extra: Record<string, unknown> = {}) => send({ type: 'ack', id, ok, ...extra });
  switch (msg.type) {
    case 'ops': {
      const s = store.get();
      if (!s.project || s.project.id !== msg.project) {
        ack(false, { error: 'That song is not open in the studio' });
        return;
      }
      const author = String(msg.author ?? 'AI');
      const label = String(msg.label ?? 'Changes');
      const next = apply(msg.ops as Op[], `${author}: ${label}`);
      if (!next) {
        ack(false, { error: 'The changes did not apply' });
        return;
      }
      toast(`${author}: ${label}`, 'ai');
      const revision = await saveNow();
      ack(true, revision === null ? {} : { revision });
      return;
    }
    case 'transport': {
      if (!(await audioAllowed())) {
        ack(false, { error: `The studio on ${device()} hasn't started its audio yet: click Start the studio there` });
        return;
      }
      const s = store.get();
      const p = s.project;
      switch (msg.action) {
        case 'play':
          if (typeof msg.at === 'number') locate(msg.at);
          if (!s.playing) play(false);
          break;
        case 'stop':
          if (s.playing) stop();
          break;
        case 'record':
          void toggleRecord();
          break;
        case 'locate':
          locate(Number(msg.at ?? 0));
          break;
        case 'cycle':
          if (p && typeof msg.start === 'number' && typeof msg.end === 'number') setCycle(msg.start, msg.end);
          break;
      }
      ack(true);
      return;
    }
    case 'open':
      await openProject(String(msg.project));
      ack(true);
      return;
    case 'bounce': {
      const r = await bounceSong(false);
      ack(r !== null, r ?? { error: 'The bounce failed in the studio' });
      return;
    }
    case 'play-notes': {
      // the AI plays: [delay ms, status, d1, d2] each, on a track (or wherever live MIDI goes)
      const events = (msg.events as number[][]) ?? [];
      const port = String(msg.port ?? 'AI');
      const track = msg.track ? String(msg.track) : null;
      midi.addVirtualPort(port, 'ai');
      const p = store.get().project;
      const target =
        track && p
          ? (p.tracks.find((t) => t.id === track || t.name.toLowerCase() === track.toLowerCase())?.id ?? null)
          : null;
      const start = performance.now();
      for (const [delay = 0, status = 0x90, d1 = 60, d2 = 0] of events) {
        window.setTimeout(() => {
          if (target) engine.live(status, d1, d2, target);
          else midi.receive(port, [status, d1, d2], start + delay);
        }, delay);
      }
      return;
    }
    case 'midi': {
      const port = String(msg.port ?? 'Network');
      midi.addVirtualPort(port, 'remote');
      const data = msg.data as number[];
      if (Array.isArray(data)) midi.receive(port, data, performance.now());
      return;
    }
    case 'listening':
      listening = Date.now() + Number(msg.ms ?? 0);
      toast('The AI is listening: play something', 'ai', Number(msg.ms ?? 4000));
      return;
    case 'saved': {
      const s = store.get();
      if (s.project?.id === msg.project && Number(msg.revision) > s.serverRevision && s.saveState === 'saved') {
        // saved somewhere else (another device, or a creation) while this one had nothing unsaved
        void openProject(String(msg.project));
      }
      return;
    }
    case 'peers':
      store.set({ peers: (msg.peers as { role: string; name: string }[]) ?? [] });
      metersWhileRemotes();
      return;
    case 'command':
      await command(msg);
      return;
    case 'render-status': {
      // a creation rendering this song on the host (its result arrives as operations, an undo step)
      const job = msg.job as RenderStatus;
      window.clearInterval(renderTimer);
      if (job.state === 'waiting' || job.state === 'running') {
        // the renderer can be quiet for minutes: the time counts here, between its lines
        const show = () => {
          const secs = Math.round((Date.now() - job.started) / 1000);
          const time = secs >= 60 ? `${Math.floor(secs / 60)} min ${secs % 60} s` : `${secs} s`;
          const line = job.lines[job.lines.length - 1]?.trim().slice(0, 80) ?? '';
          store.set({ bouncing: `${job.title} is rendering ${job.piece} (${time})${line ? `: ${line}` : ''}` });
        };
        show();
        renderTimer = window.setInterval(show, 1000);
      } else {
        store.set({ bouncing: null });
        if (job.state === 'failed')
          toast(`${job.title} couldn’t render ${job.piece}: ${job.error ?? ''}`, 'error', 12000);
      }
      return;
    }
  }
}

interface RenderStatus {
  title: string;
  piece: string;
  state: string;
  lines: string[];
  error: string | null;
  started: number;
}
let renderTimer = 0;

/**
 * Audio can start without a click here only if this page has been clicked or typed in before (the
 * browser's rule); otherwise a remote's Play waits for someone to press Start the studio.
 */
async function audioAllowed(): Promise<boolean> {
  if (engine.started) return true;
  const active = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation;
  if (!active?.hasBeenActive) return false;
  await ensureAudio().catch(() => undefined);
  return engine.started;
}

/** A remote's button, fader or pad setting, carried out here as if pressed here. */
async function command(msg: Record<string, unknown>): Promise<void> {
  const s = store.get();
  const p = s.project;
  const from = String(msg.from ?? 'Remote');
  const track = typeof msg.track === 'string' ? msg.track : '';
  const needsAudio = ['play', 'record'].includes(String(msg.action));
  if (needsAudio && !(await audioAllowed())) {
    toast(`${from} pressed ${String(msg.action)}: click Start the studio first`, 'info', 6000);
    return;
  }
  switch (msg.action) {
    case 'play':
      if (!s.playing) play(false);
      return;
    case 'stop':
      stop();
      return;
    case 'record':
      await toggleRecord();
      return;
    case 'toStart':
      if (s.playing) stop();
      locate(0);
      return;
    case 'back':
      moveBars(-1);
      return;
    case 'forward':
      moveBars(1);
      return;
    case 'locate':
      locate(Number(msg.tick ?? 0));
      return;
    case 'cycle':
      toggleCycle();
      return;
    case 'cycleRange':
      setCycle(Number(msg.start), Number(msg.end));
      return;
    case 'metronome':
      toggleMetronome();
      return;
    case 'countIn':
      store.set({ countIn: Math.max(0, Math.min(2, Number(msg.bars ?? 0))) });
      return;
    case 'undo':
      undo();
      return;
    case 'redo':
      redo();
      return;
    case 'save':
      void saveNow();
      return;
    case 'select':
      if (p?.tracks.some((t) => t.id === track)) selectTrack(track);
      return;
    case 'arm': {
      const t = p?.tracks.find((x) => x.id === track);
      if (t) updateTrack(t.id, { armed: !t.armed }, 'Arm');
      return;
    }
    case 'mute':
    case 'solo': {
      const t = p?.tracks.find((x) => x.id === track);
      if (t) updateChannel(t.id, { [msg.action]: !t.channel[msg.action] }, msg.action === 'mute' ? 'Mute' : 'Solo');
      return;
    }
    case 'channel': {
      // faders and pan from a remote: one undo step per touch, as here
      const target = String(msg.target ?? '');
      const patch: ChannelPatch = {};
      if (typeof msg.volume === 'number') patch.volume = Math.max(-144, Math.min(6, msg.volume));
      if (typeof msg.pan === 'number') patch.pan = Math.max(-1, Math.min(1, msg.pan));
      if (msg.phase === 'begin') beginGesture(typeof msg.pan === 'number' ? 'Pan' : 'Volume');
      if (Object.keys(patch).length) gestureChange([{ op: 'updateChannel', target, patch }]);
      if (msg.phase === 'end') endGesture();
      return;
    }
    case 'marker': {
      if (!p) return;
      const tick = Math.max(0, Math.round(engine.positionTick()));
      const name =
        typeof msg.name === 'string' && msg.name.trim()
          ? msg.name.trim().slice(0, 40)
          : `Marker ${p.markers.length + 1}`;
      const markers = [...p.markers.filter((m) => m.tick !== tick), { id: newId('mrk'), tick, name }].sort(
        (a, b) => a.tick - b.tick,
      );
      apply([{ op: 'setProject', patch: { markers } }], `${from}: Marker`);
      return;
    }
  }
}

/** Levels for remotes, a dozen times a second, while any is connected. */
let metersTimer = 0;
function metersWhileRemotes(): void {
  const remotes = store.get().peers.some((x) => x.role === 'remote');
  if (remotes && !metersTimer) {
    metersTimer = window.setInterval(() => {
      const p = store.get().project;
      if (!p || !engine.started) return;
      const r3 = (v: number) => Math.round(v * 1000) / 1000;
      const levels = [...p.tracks.map((t) => t.id), 'master'].map((id) => {
        const [l, r] = engine.meter(id);
        return [id, r3(l), r3(r)];
      });
      send({ type: 'meters', levels });
    }, 80);
  } else if (!remotes && metersTimer) {
    window.clearInterval(metersTimer);
    metersTimer = 0;
  }
}

/** Rename this device (the others see it at once). */
export function renameDevice(name: string): void {
  store.set({ deviceName: name.trim().slice(0, 40) });
  send({ type: 'hello', role: 'editor', name: device() });
}

/** Send MIDI to the studios open on other devices (they hear it as a network device). */
export function sendMidi(data: number[]): boolean {
  if (socket?.readyState !== WebSocket.OPEN) return false;
  send({ type: 'midi', data, sent: Date.now() });
  return true;
}

/** Other studios open right now (on other devices). */
export function otherStudios(): number {
  return Math.max(0, store.get().peers.filter((p) => p.role === 'editor').length - 1);
}

let retryTimer = 0;

/** Try the host again now (it answered something else, or the device came back online). */
export function reconnectSoon(): void {
  // only a studio connects (HO[LO] Remote has its own channel)
  if (socket || !enabled) return;
  window.clearTimeout(retryTimer);
  retry = 1000;
  connectLive();
}

if (typeof window !== 'undefined') {
  window.addEventListener('online', reconnectSoon);
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') reconnectSoon();
  });
}

let enabled = false;

export function connectLive(): void {
  enabled = true;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/live`);
  socket = ws;
  ws.onopen = () => {
    retry = 1000;
    lastSent = '';
    store.set({ connection: 'online' });
    send({ type: 'hello', role: 'editor', name: device() });
    report();
  };
  ws.onmessage = (e) => {
    try {
      void onMessage(JSON.parse(String(e.data)) as Record<string, unknown>);
    } catch {
      // not for us
    }
  };
  ws.onclose = () => {
    socket = null;
    store.set({ connection: 'offline' });
    window.clearTimeout(retryTimer);
    retryTimer = window.setTimeout(connectLive, retry);
    retry = Math.min(4000, retry * 2);
  };
  if (!stateTimer) stateTimer = window.setInterval(report, 250);
}

// what's played goes to the AI while it listens (and only then)
midi.onEvent((e) => {
  if (Date.now() > listening) return;
  // notes from other devices are reported by the server, which relayed them
  if (midi.ports.some((p) => p.name === e.port && p.source === 'remote')) return;
  played.push({
    tick: store.get().playing ? Math.round(engine.heardTick(e.time, e.frame) ?? 0) : null,
    status: e.status,
    d1: e.d1,
    d2: e.d2,
    port: e.port,
  });
  queueMicrotask(() => {
    if (!played.length) return;
    send({ type: 'played', events: played.splice(0) });
  });
});
