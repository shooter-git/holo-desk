/**
 * The studio's side of the live channel. It reports what the studio is doing (so the AI knows the
 * playhead, the selection and the song), applies the AI's changes as undo steps, follows transport
 * commands, plays the AI's notes and passes on notes from other devices.
 */
import { type ChannelPatch, formatBarBeat, newId, type Op, type Project, tickToSeconds } from '@holo/session';
import { engine } from '../audio/engine.ts';
import { midi } from '../audio/midi.ts';
import { library, type PackSummary } from '../audio/samples.ts';
import { inputLabel, instrumentLabel } from '../ui/Tracks.tsx';
import {
  apply,
  applyJob,
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
  relabelJob,
  saveNow,
  saveSoon,
  selectTrack,
  setCycle,
  setJobRunning,
  stop,
  toggleCycle,
  toggleMetronome,
  toggleRecord,
  undo,
  updateChannel,
  updateTrack,
} from './actions.ts';
import { agentMessage, helloFields, onTokenChange, refreshAgent, viewName } from './agent.ts';
import { type AiJobStatus, store, toast } from './store.ts';

/** Scans this studio has heard of (so a phone's new one is offered once). */
const seenScans = new Set<string>();

let socket: WebSocket | null = null;
let retry = 1000;
let stateTimer = 0;
let lastSent = '';
let listening = 0;
const played: { tick: number | null; status: number; d1: number; d2: number; port: string }[] = [];

function send(msg: unknown): void {
  if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(msg));
}

/** What kind of device this is, from the browser's own description. */
function deviceKind(): 'phone' | 'tablet' | 'computer' {
  const ua = navigator.userAgent;
  return /iPhone|Android.+Mobile/.test(ua) ? 'phone' : /iPad|Android/.test(ua) ? 'tablet' : 'computer';
}

/** This device's name for the others: the one set in Audio & MIDI settings, or the browser and kind. */
export function device(): string {
  const named = store.get().deviceName.trim();
  if (named) return named;
  const ua = navigator.userAgent;
  const kind = deviceKind();
  const browser = /Edg\//.test(ua)
    ? 'Edge'
    : /Firefox\//.test(ua)
      ? 'Firefox'
      : /Chrome\//.test(ua)
        ? 'Chrome'
        : 'Safari';
  return `${browser} on a ${kind}`;
}

/**
 * The song's shape as reported: its markers and tracks, worked out again only when the song (or
 * the pack list the labels come from) has changed, since the report goes out a few times a second.
 */
let shape: { project: Project | null; packs: PackSummary[]; markers: unknown[]; tracks: unknown[] } | null = null;
function songShape(p: Project | null): { markers: unknown[]; tracks: unknown[] } {
  if (shape && shape.project === p && shape.packs === library.packs) return shape;
  shape = {
    project: p,
    packs: library.packs,
    markers: (p?.markers ?? []).map((m) => ({ tick: m.tick, name: m.name, at: formatBarBeat(p?.meter ?? [], m.tick) })),
    tracks: (p?.tracks ?? []).map((t) => ({
      id: t.id,
      name: t.name,
      color: t.color,
      kind: t.kind,
      sub: t.kind === 'audio' ? inputLabel(t) : instrumentLabel(t.instrument),
      instrument: t.instrument,
      armed: t.armed,
      mute: t.channel.mute,
      solo: t.channel.solo,
      volume: t.channel.volume,
      pan: t.channel.pan,
    })),
  };
  return shape;
}

function report(): void {
  if (socket?.readyState !== WebSocket.OPEN) return;
  const s = store.get();
  const p = s.project;
  const tick = engine.positionTick();
  const lat = engine.latency();
  const { markers, tracks } = songShape(p);
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
    markers,
    tracks,
    master: p ? { volume: p.master.volume } : null,
    tempo: p?.tempo ?? [],
    meter: p?.meter ?? [],
    // what the agent's request is about: the view, and the scan open in it
    view: viewName(s, document.documentElement.dataset.layout?.startsWith('phone') ?? false),
    scan: s.scanView?.id ?? null,
  };
  // (the one text is both the comparison and what's sent)
  const json = JSON.stringify({ type: 'state', state });
  if (json !== lastSent) {
    socket.send(json);
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
      // (the command line's: not the user's own step)
      const next = apply(msg.ops as Op[], `${author}: ${label}`, false);
      if (!next) {
        ack(false, { error: 'The changes did not apply' });
        return;
      }
      toast(`${author}: ${label}`, 'ai');
      // (a burst of changes is saved as one, and each is answered with that save's revision)
      const revision = await saveSoon();
      ack(true, revision === null ? {} : { revision });
      return;
    }
    case 'agent-ops': {
      // the in-app agent's changes: one undo step per request, answered as soon as they're in the song
      const s = store.get();
      if (!s.project || s.project.id !== msg.project) {
        ack(false, { error: 'That song is not open in the studio' });
        return;
      }
      const job = typeof msg.job === 'string' ? msg.job : '';
      const batch = typeof msg.batch === 'string' ? msg.batch : '';
      // (a batch is applied once by its id: without one, a second would pass for the first)
      if (!job || !batch) {
        ack(false, { error: 'The changes came without their job and batch' });
        return;
      }
      const ops = Array.isArray(msg.ops) ? (msg.ops as Op[]) : [];
      const r = await applyJob(ops, job, batch, String(msg.label ?? 'Changes'));
      if (r.ok) ack(true, { revision: store.get().serverRevision });
      else ack(false, { error: r.error ?? 'The changes did not apply' });
      return;
    }
    case 'agent-flush': {
      // the agent's turn is over: the host reads the song once it's saved (a save already going
      // on is waited for, and the song as it is now saved after it)
      const revision = await saveSoon(0);
      if (revision === null) ack(false, { error: 'The studio could not save the song' });
      else ack(true, { revision });
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
    case 'peers': {
      // a session the host hasn't yet seen go (a reload's) would show a device twice
      const seen = new Set<string>();
      const peers = ((msg.peers as { role: string; name: string }[]) ?? []).filter((x) => {
        const key = `${x.role}\n${x.name}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
      store.set({ peers });
      metersWhileRemotes();
      offerRemote(peers);
      return;
    }
    case 'command':
      await command(msg);
      return;
    case 'scan': {
      store.set({ scanTick: store.get().scanTick + 1 });
      // a scan this studio didn't make (a phone's): offer to review it, once
      const id = String(msg.id ?? '');
      const s = store.get();
      const making = s.scanView !== null && s.scanView.id === null;
      if (id && !seenScans.has(id) && msg.project === s.project?.id && !making && s.scanView?.id !== id) {
        toast('Pages scanned on another device arrived', 'info', 12000, {
          label: 'Review',
          run: () => store.set({ scanView: { id } }),
        });
      }
      seenScans.add(id);
      return;
    }
    case 'ai-status': {
      const job = msg.job as AiJobStatus;
      const was = store.get().aiJob;
      store.set({ aiJob: job });
      if (job.state === 'done' && was?.state !== 'done') toast(`AI: ${job.summary || 'done'}`, 'ai', 8000);
      if (job.state === 'failed' && was?.state !== 'failed') toast(`The AI stopped: ${job.error ?? ''}`, 'error', 8000);
      return;
    }
    case 'agent-status':
    case 'agent-listen':
    case 'agent-harness':
    case 'agent-devices':
    case 'agent-removed':
    case 'agent-look':
    case 'agent-compare': {
      const r = agentMessage(msg);
      // this device's job: its changes merge into one step while it runs, and the step takes its name after
      if (r.effects) {
        setJobRunning(r.effects.job, r.effects.running);
        if (r.effects.label) relabelJob(r.effects.job, r.effects.label);
      }
      return;
    }
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

/**
 * Another studio open while this one is on a phone or tablet: its name, else null. Each studio runs
 * its own transport, so Play here wouldn't move that one; HO[LO] Remote is the way to drive it.
 */
export function otherStudioToDrive(peers: { role: string; name: string }[]): string | null {
  if (deviceKind() === 'computer') return null;
  const me = device();
  return peers.find((p) => p.role === 'editor' && p.name !== me)?.name ?? null;
}

/**
 * Said once a visit, when another studio turns up after this one has started (before then the
 * Start the studio card says it).
 */
let remoteOffered = false;
function offerRemote(peers: { role: string; name: string }[]): void {
  if (remoteOffered || !store.get().audioReady) return;
  const other = otherStudioToDrive(peers);
  if (!other) return;
  remoteOffered = true;
  try {
    if (sessionStorage.getItem('holo:remote-offered')) return;
    sessionStorage.setItem('holo:remote-offered', '1');
  } catch {
    // (no storage: said once for this page)
  }
  toast(
    `HO[LO] is also open on ${other}. Play here runs this ${deviceKind()}'s own studio; to control that one, use HO[LO] Remote.`,
    'info',
    12_000,
    { label: 'Open Remote', run: () => location.assign('/remote') },
  );
}

/**
 * Tell the host the user undid or redid a step, or made one of their own while this device's request
 * runs (the agent hears of it before its next reply).
 */
export function reportHistory(action: 'undo' | 'redo' | 'step', label: string, job?: string): void {
  send({ type: 'history', action, label, job });
}

/** Who this studio is: each hello carries the agent's token too, or the host takes it as no longer allowed. */
function hello(): void {
  send({ type: 'hello', role: 'editor', name: device(), ...helloFields() });
}

// the token came or went (paired, approved, removed): the host hears at once
onTokenChange(hello);

/** Rename this device (the others see it at once). */
export function renameDevice(name: string): void {
  store.set({ deviceName: name.trim().slice(0, 40) });
  hello();
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

/**
 * The studio the server handed out when this page loaded. A host that updates itself (tools/update.mjs)
 * comes back with another: this page's code would then talk to a newer server, so it asks for a reload.
 */
let loadedBuild: string | null | undefined;
let updateSaid = false;
async function checkBuild(): Promise<void> {
  try {
    const { build } = (await (await fetch('/api/health', { cache: 'no-store' })).json()) as { build?: string | null };
    if (loadedBuild === undefined) loadedBuild = build ?? null;
    else if (build && loadedBuild && build !== loadedBuild && !updateSaid) {
      updateSaid = true;
      toast(
        'HO[LO] was updated on its host: reload this page (your song is saved) to use the new version.',
        'info',
        60_000,
      );
    }
  } catch {
    // the host is away: asked again when it's back
  }
}

export function connectLive(): void {
  enabled = true;
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  const ws = new WebSocket(`${proto}://${location.host}/api/live`);
  socket = ws;
  ws.onopen = () => {
    retry = 1000;
    lastSent = '';
    store.set({ connection: 'online' });
    void checkBuild();
    hello();
    report();
    // how the agent stands now (turned on or off, this device let go, while away)
    void refreshAgent();
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
