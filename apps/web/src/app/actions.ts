/**
 * Everything the studio does to a song goes through here: edits as operations (each an undo
 * step), saving, opening, the transport, tracks and regions. Buttons, key commands, the piano roll
 * and the AI all call these.
 */

import { frameToTick } from '@holo/engine';
import type { LiveRoute } from '@holo/engine/companion';
import {
  applyOps,
  barToTick,
  type ChannelPatch,
  DIVISIONS,
  type Instrument,
  meterAt,
  type Note,
  newAudioTrack,
  newBus,
  newId,
  newPlugin,
  newRegion,
  newTrack,
  type Op,
  PPQ,
  type Project,
  projectEnd,
  quantize,
  type Region,
  secondsToTick,
  TRACK_COLORS,
  type Track,
  type TrackPatch,
  ticksPerBar,
  tickToBarBeat,
  tickToSeconds,
} from '@holo/session';
import { bounce, bounceRange } from '../audio/bounce.ts';
import { companion } from '../audio/companion.ts';
import { engine, type RecordedTake } from '../audio/engine.ts';
import { audioFiles } from '../audio/files.ts';
import { midi } from '../audio/midi.ts';
import { library } from '../audio/samples.ts';
import { ApiError, api } from './api.ts';
import { store, toast } from './store.ts';

const MAX_UNDO = 300;

// ---- editing ----

/** Apply operations as one undo step. Returns the new song, or null if they didn't apply. */
export function apply(ops: Op[], label: string): Project | null {
  const s = store.get();
  if (!s.project || ops.length === 0) return null;
  let next: Project;
  try {
    next = applyOps(s.project, ops);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
    return null;
  }
  store.set({
    project: next,
    undo: [...s.undo.slice(-(MAX_UNDO - 1)), { project: s.project, label }],
    redo: [],
    saveState: 'dirty',
  });
  changed(next);
  return next;
}

function changed(project: Project): void {
  engine.sync(project);
  loadInstruments(project);
  refreshRouting();
  scheduleSave();
}

export function undo(): void {
  const s = store.get();
  const step = s.undo[s.undo.length - 1];
  if (!step || !s.project) return;
  store.set({
    project: step.project,
    undo: s.undo.slice(0, -1),
    redo: [...s.redo, { project: s.project, label: step.label }],
    selectedNotes: [],
    saveState: 'dirty',
  });
  changed(step.project);
  toast(`Undo ${step.label}`);
}

export function redo(): void {
  const s = store.get();
  const step = s.redo[s.redo.length - 1];
  if (!step || !s.project) return;
  store.set({
    project: step.project,
    redo: s.redo.slice(0, -1),
    undo: [...s.undo, { project: s.project, label: step.label }],
    selectedNotes: [],
    saveState: 'dirty',
  });
  changed(step.project);
  toast(`Redo ${step.label}`);
}

// ---- saving ----

let saveTimer = 0;
let saving = false;
let saveAgain = false;

export function scheduleSave(delay = 700): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), delay);
}

/** Save now. Resolves with the saved revision (or null if it couldn't). */
export async function saveNow(): Promise<number | null> {
  const s = store.get();
  const project = s.project;
  if (!project) return null;
  if (saving) {
    saveAgain = true;
    return null;
  }
  if (s.saveState === 'saved' || s.saveState === 'conflict') return s.serverRevision;
  saving = true;
  store.set({ saveState: 'saving' });
  try {
    const r = await api.save(project, s.serverRevision);
    const now = store.get();
    store.set({ serverRevision: r.revision, saveState: now.project === project ? 'saved' : 'dirty' });
    // the host answered: the live channel needn't wait for its next retry
    if (now.connection === 'offline') void import('./live.ts').then((m) => m.reconnectSoon());
    if (now.project !== project) scheduleSave(200);
    return r.revision;
  } catch (err) {
    if (err instanceof ApiError && err.status === 409) {
      store.set({ saveState: 'conflict' });
      toast('This song was changed somewhere else. Choose which version to keep.', 'error', 8000);
    } else {
      store.set({ saveState: 'offline' });
      scheduleSave(5000);
    }
    return null;
  } finally {
    saving = false;
    if (saveAgain) {
      saveAgain = false;
      scheduleSave(100);
    }
  }
}

/** After a conflict: keep this studio's version (it becomes the newest) or take the saved one. */
export async function resolveConflict(keep: 'mine' | 'theirs'): Promise<void> {
  const s = store.get();
  if (!s.project) return;
  const theirs = await api.project(s.project.id);
  if (keep === 'theirs') {
    load(theirs);
    return;
  }
  store.set({ serverRevision: theirs.revision, saveState: 'dirty' });
  await saveNow();
}

// ---- opening ----

export function load(project: Project): void {
  store.set({
    project,
    serverRevision: project.revision,
    undo: [],
    redo: [],
    saveState: 'saved',
    selectedTrack: project.tracks[0]?.id ?? null,
    selectedRegions: [],
    selectedNotes: [],
    plugin: null,
  });
  try {
    localStorage.setItem('holo:last', project.id);
  } catch {
    // remembered next time if storage allows
  }
  engine.stop();
  engine.sync(project);
  engine.locate(0);
  loadInstruments(project);
  refreshRouting();
  document.title = `${project.title} · HO[LO] Desk`;
}

export async function openProject(id: string): Promise<void> {
  try {
    load(await api.project(id));
    store.set({ dialog: null });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
}

export async function createProject(title = 'Untitled'): Promise<void> {
  load(await api.create(title));
  store.set({ dialog: null });
}

export async function importMidiFile(file: File): Promise<void> {
  try {
    load(await api.importMidi(file));
    store.set({ dialog: null });
    toast(`Imported ${file.name}`);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
}

export function exportMidi(): void {
  const p = store.get().project;
  if (!p) return;
  void saveNow().then(() => {
    const a = document.createElement('a');
    a.href = `/api/projects/${p.id}/midi`;
    a.click();
  });
}

export async function startup(): Promise<void> {
  void library.refresh();
  void api
    .settings()
    .then((s) => store.set({ middleC: s.middleC }))
    .catch(() => undefined);
  let id: string | null = null;
  try {
    id = new URLSearchParams(location.search).get('project') ?? localStorage.getItem('holo:last');
  } catch {
    id = null;
  }
  try {
    if (id) {
      load(await api.project(id));
      goToLinkedBar();
      return;
    }
  } catch {
    // gone: fall through to the newest one
  }
  try {
    const list = await api.projects();
    const first = list[0];
    if (first) load(await api.project(first.id));
    else load(await api.create('My First Song'));
  } catch {
    toast('Can’t reach the HO[LO] server. Is it running?', 'error', 10000);
  }
}

/** A link may name a bar (?at=9): the playhead goes there, and the tracks area shows it. */
function goToLinkedBar(): void {
  const p = store.get().project;
  const at = Number(new URLSearchParams(location.search).get('at'));
  if (!p || !(at > 0)) return;
  const tick = barToTick(p.meter, at);
  locate(tick);
  linkedTick = tick;
}

/** Where a link asked the views to start (read once by the tracks area). */
export let linkedTick: number | null = null;
export function takeLinkedTick(): number | null {
  const t = linkedTick;
  linkedTick = null;
  return t;
}

// ---- audio ----

let starting: Promise<void> | null = null;

/** Start the audio (browsers only allow it after a click or a key press). */
export function ensureAudio(): Promise<void> {
  if (engine.started) return Promise.resolve();
  if (!starting) {
    starting = (async () => {
      try {
        await engine.start(store.get().latencyMode);
        store.set({ audioReady: true });
        await engine.setInput(store.get().inputDevice);
        const p = store.get().project;
        if (p) {
          engine.sync(p);
          loadInstruments(p);
        }
        engine.setMetronome(store.get().metronome);
        engine.setLowLatency(store.get().lowLatency);
        if (store.get().outputDevice)
          void engine.setOutput(store.get().outputDevice).catch(() => store.set({ outputDevice: '' }));
        void enableMidi();
      } catch (err) {
        toast(`Audio couldn’t start: ${err instanceof Error ? err.message : String(err)}`, 'error', 8000);
      } finally {
        starting = null;
      }
    })();
  }
  return starting;
}

export async function setLatencyMode(mode: AppStateLatency): Promise<void> {
  store.set({ latencyMode: mode, roundTrip: null });
  if (engine.ctx) {
    await engine.start(mode);
    engine.setMetronome(store.get().metronome);
  }
}
type AppStateLatency = ReturnType<typeof store.get>['latencyMode'];

export async function enableMidi(): Promise<void> {
  const status = await midi.enable();
  store.set({ midiStatus: status, midiPorts: midi.ports });
}

// ---- HO[LO] Engine ----

/**
 * Look for HO[LO] Engine on this device. When it has opened its sound device the studio plays
 * through it (and needs no click to start: it isn't the browser's audio); when it goes, the browser's
 * audio and MIDI take over again, as if it had never been there.
 */
export function findCompanion(): void {
  midi.onPorts(() => store.set({ midiPorts: midi.ports }));
  companion.onmidi = (events) => midi.nativeEvents(events);
  let ports = companion.snapshot().ports;
  companion.subscribe(() => {
    const snap = companion.snapshot();
    if (snap.ports !== ports) {
      ports = snap.ports;
      midi.setNativePorts(ports);
    }
    const remote = snap.device !== null;
    const rate = snap.device?.rate ?? 0;
    // the browser let go of its audio for it, and it couldn't open the device: the browser plays again
    const released = !remote && !engine.ctx && store.get().audioReady;
    if (!released && remote === engine.remote && (!remote || rate === engine.sampleRate)) return;
    midi.setNative(remote);
    void switchEngine(remote);
  });
  companion.beforeOpen = async () => {
    if (!engine.ctx || engine.remote) return;
    if (store.get().playing) stop();
    await engine.close();
  };
  void companion.find(!store.get().shareDevice);
}

async function switchEngine(remote: boolean): Promise<void> {
  if (!remote && !engine.ctx) {
    // it went before the studio had started: nothing plays yet
    void enableMidi();
    return;
  }
  const playing = store.get().playing;
  if (playing) stop();
  starting = null;
  try {
    await engine.start(store.get().latencyMode);
    store.set({ audioReady: true });
    engine.setMetronome(store.get().metronome);
    engine.setLowLatency(store.get().lowLatency);
    const p = store.get().project;
    if (p) loadInstruments(p);
    refreshRouting();
    await enableMidi();
    toast(
      remote
        ? 'HO[LO] Engine is playing: native sound and MIDI on this device'
        : 'HO[LO] Engine has stopped: the browser plays again',
      'info',
    );
  } catch (err) {
    toast(`Audio couldn’t start: ${err instanceof Error ? err.message : String(err)}`, 'error', 8000);
  }
}

/** HO[LO] Engine shares the sound device (other apps can play too) or has it to itself (the lowest latency). */
export function setShareDevice(on: boolean): void {
  store.set({ shareDevice: on, roundTrip: null });
  companion.setExclusive(!on);
}

export function loadInstruments(project: Project): void {
  if (!engine.ctx) return;
  for (const t of project.tracks) {
    for (const i of [t.instrument, ...t.articulations.map((a) => a.instrument)]) {
      // a Performance instrument's live notes play on its pack's plain sampler
      if (i.type === 'sampler' || i.type === 'performance') void library.ensure(i.pack, i.name);
    }
  }
}

// ---- live routing ----

/** Live MIDI goes to the armed tracks whose input matches; with none armed, to the selected track. */
export function refreshRouting(): void {
  const s = store.get();
  const tracks = s.project?.tracks ?? [];
  const route = (t: Track): LiveRoute => ({ num: engine.numOf(t.id), port: t.input.port, channel: t.input.channel });
  const selected = tracks.find((t) => t.id === s.selectedTrack);
  midi.setRoutes({ armed: tracks.filter((t) => t.armed).map(route), selected: selected ? route(selected) : null });
}

// ---- transport ----

export function playheadTick(): number {
  return engine.positionTick();
}

export async function togglePlay(): Promise<void> {
  await ensureAudio();
  if (store.get().playing) stop();
  else play(false);
}

export function play(record: boolean): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  let from = Math.max(0, engine.positionTick());
  if (p.cycle.on && !record && (from < p.cycle.start || from >= p.cycle.end)) from = p.cycle.start;
  engine.play(from, record, record ? s.countIn : 0);
  store.set({ playing: true, recording: record });
  if (record) startRecording();
}

export function stop(): void {
  const s = store.get();
  if (!s.playing) {
    locate(0);
    return;
  }
  const end = engine.positionTick();
  engine.stop();
  store.set({ playing: false, recording: false });
  if (s.recording) finishRecording();
  engine.locate(Math.max(0, end));
}

export async function toggleRecord(): Promise<void> {
  await ensureAudio();
  const s = store.get();
  if (s.recording) {
    store.set({ recording: false });
    engine.setRecording(false);
    finishRecording();
    return;
  }
  if (s.playing) {
    // punch in
    store.set({ recording: true });
    engine.setRecording(true);
    startRecording();
    return;
  }
  play(true);
}

export function locate(tick: number): void {
  engine.locate(Math.max(0, Math.round(tick)));
  store.set({}); // let the position display catch up
}

export function moveBars(bars: number): void {
  const p = store.get().project;
  if (!p) return;
  const now = Math.max(0, engine.positionTick());
  const pos = tickToBarBeat(p.meter, now);
  const target = barToTick(
    p.meter,
    Math.max(1, pos.bar + bars + (bars < 0 && pos.beat + pos.div + pos.tick > 3 ? 1 : 0)),
  );
  locate(target);
}

export function toggleCycle(): void {
  const p = store.get().project;
  if (!p) return;
  apply([{ op: 'setProject', patch: { cycle: { ...p.cycle, on: !p.cycle.on } } }], 'Cycle');
}

export function setCycle(start: number, end: number): void {
  if (end <= start) return;
  apply([{ op: 'setProject', patch: { cycle: { on: true, start, end } } }], 'Set Cycle');
}

/** The studio full screen (on the computer you look at while playing), and back. */
export function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  void document.documentElement
    .requestFullscreen({ navigationUI: 'hide' })
    .catch(() => toast('This browser won’t go full screen here: try F11', 'info'));
}

export function toggleMetronome(): void {
  const on = !store.get().metronome;
  store.set({ metronome: on });
  engine.setMetronome(on);
}

// ---- recording ----

interface Take {
  track: string;
  notes: Note[];
  held: Map<number, Note>;
  cc: Map<string, [number, number][]>;
}

let takes = new Map<string, Take>();
let offRecord: (() => void) | null = null;

/** Notes being recorded right now, for the screen to draw as they're played. */
export function liveTakes(): ReadonlyMap<string, Take> {
  return takes;
}

function startRecording(): void {
  takes = new Map();
  offRecord?.();
  offRecord = midi.onEvent((e) => {
    const s = store.get();
    if (!s.recording || !s.project) return;
    const tick = engine.heardTick(e.time, e.frame);
    if (tick === null || tick < 0) return;
    const channel = (e.status & 0x0f) + 1;
    const project = s.project;
    const armed = project.tracks.filter(
      (t) =>
        t.armed &&
        (t.input.port === '*' || t.input.port === e.port) &&
        (t.input.channel === 0 || t.input.channel === channel),
    );
    const targets = armed.length ? armed : project.tracks.filter((t) => t.id === s.selectedTrack);
    const kind = e.status & 0xf0;
    for (const t of targets) {
      let take = takes.get(t.id);
      if (!take) {
        take = { track: t.id, notes: [], held: new Map(), cc: new Map() };
        takes.set(t.id, take);
      }
      if (kind === 0x90 && e.d2 > 0) {
        const n: Note = { t: Math.round(tick), d: 1, p: e.d1, v: e.d2 };
        take.notes.push(n);
        take.held.set(e.d1, n);
      } else if (kind === 0x80 || kind === 0x90) {
        const n = take.held.get(e.d1);
        if (n) {
          n.d = Math.max(1, Math.round(tick) - n.t);
          take.held.delete(e.d1);
        }
      } else if (kind === 0xb0 || kind === 0xe0 || kind === 0xd0) {
        const lane = kind === 0xb0 ? String(e.d1) : kind === 0xe0 ? 'pb' : 'at';
        const value = kind === 0xb0 ? e.d2 : kind === 0xe0 ? ((e.d2 << 7) | e.d1) - 8192 : e.d1;
        const list = take.cc.get(lane) ?? [];
        list.push([Math.round(tick), value]);
        take.cc.set(lane, list);
      }
    }
  });
}

function finishRecording(): void {
  offRecord?.();
  offRecord = null;
  const s = store.get();
  const p = s.project;
  if (!p) return;
  const end = engine.positionTick();
  const ops: Op[] = [];
  for (const take of takes.values()) {
    for (const n of take.held.values()) n.d = Math.max(1, Math.round(end) - n.t);
    if (!take.notes.length && !take.cc.size) continue;
    const ticks = [...take.notes.map((n) => n.t), ...[...take.cc.values()].flatMap((l) => l.map((x) => x[0]))];
    const ends = [...take.notes.map((n) => n.t + n.d), ...ticks];
    const m = meterAt(p.meter, Math.min(...ticks));
    const bar = ticksPerBar(m);
    const start = Math.floor(Math.min(...ticks) / bar) * bar;
    const stop = Math.max(start + bar, Math.ceil(Math.max(...ends) / bar) * bar);
    const region = newRegion(start, stop - start, 'Recording');
    region.notes = take.notes.map((n) => ({ ...n, t: n.t - start }));
    region.cc = Object.fromEntries(
      [...take.cc].map(([k, pts]) => [k, pts.map(([t, v]): [number, number] => [t - start, v])]),
    );
    ops.push({ op: 'addRegion', track: take.track, region });
  }
  takes = new Map();
  if (ops.length) {
    apply(ops, 'Record');
    const n = ops.reduce((c, o) => c + (o.op === 'addRegion' ? o.region.notes.length : 0), 0);
    toast(`Recorded ${n} note${n === 1 ? '' : 's'}`);
  }
}

// ---- audio recording ----

/**
 * How far behind a recording is: the sound you played along to took the output's time to reach you,
 * and your playing took the input's time to come back. Measured on this device when it has been
 * (Audio & MIDI settings), otherwise worked out from what the browser reports.
 */
export function roundTripFrames(sr: number): number {
  const measured = store.get().roundTrip;
  if (measured && measured > 0) return Math.round((measured / 1000) * sr);
  const l = engine.latency();
  const input = engine.inputLatency() ?? 10;
  return Math.round(((l.base + l.output + input) / 1000) * sr) + 128;
}

async function keepTake(take: RecordedTake): Promise<void> {
  const p = store.get().project;
  const track = p?.tracks.find((t) => t.id === take.trackId);
  const first = take.channels[0];
  if (!p || !track || !first) return;
  const sr = take.sampleRate;
  const skip = Math.min(roundTripFrames(sr), first.length - 1);
  const n = track.regions.filter((r) => r.audio).length + 1;
  const name = `${track.name} #${String(n).padStart(2, '0')}`;
  try {
    const file = await audioFiles.uploadRecording(p.id, take.channels, sr, `${name}.wav`);
    const start = Math.max(0, Math.round(frameToTick(engine.segments, take.frame)));
    const end = Math.round(frameToTick(engine.segments, take.frame + first.length - skip));
    const region = newRegion(start, Math.max(1, end - start), name);
    region.audio = { file: file.id, offset: skip / sr, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
    apply(
      [
        { op: 'addFile', file },
        { op: 'addRegion', track: track.id, region },
      ],
      'Record Audio',
    );
    toast(`Recorded ${name} (${file.seconds.toFixed(1)} s)`);
  } catch (err) {
    toast(`The recording couldn’t be kept: ${err instanceof Error ? err.message : String(err)}`, 'error', 8000);
  }
}

engine.onTake((take) => void keepTake(take));
engine.onError((message) => {
  console.error(`[engine] ${message}`);
  toast(`The audio engine hit a problem: ${message.split('\n')[0]}`, 'error', 8000);
});
engine.onInputError((message) =>
  toast(
    `The audio input couldn’t open: ${message}. Allow the microphone for this site, or choose another input in Audio & MIDI settings.`,
    'error',
    9000,
  ),
);

/** An empty audio track below the selected one. */
export function addAudioTrack(name?: string): string | null {
  const s = store.get();
  const p = s.project;
  if (!p) return null;
  const color = TRACK_COLORS[p.tracks.length % TRACK_COLORS.length];
  const count = p.tracks.filter((t) => t.kind === 'audio').length + 1;
  const track = newAudioTrack(name ?? `Audio ${count}`, color);
  const index = s.selectedTrack ? p.tracks.findIndex((t) => t.id === s.selectedTrack) + 1 : p.tracks.length;
  apply([{ op: 'addTrack', track, index }], 'New Audio Track');
  selectTrack(track.id);
  return track.id;
}

const AUDIO_FILE = /\.(wav|flac|mp3|ogg|oga|m4a|aac|aif|aiff)$/i;
export const isAudioFile = (f: File) => AUDIO_FILE.test(f.name) || f.type.startsWith('audio/');

/**
 * Audio files into the song (dropped or chosen): each becomes a region at the tick, the first on the
 * audio track it was dropped on (if it was), the rest on new audio tracks.
 */
export async function importAudio(files: File[], trackId?: string | null, tick?: number): Promise<void> {
  const list = files.filter(isAudioFile);
  if (!list.length) {
    if (files.length) toast('Those aren’t audio files (WAV, FLAC, MP3, Ogg, AIFF or M4A)', 'error');
    return;
  }
  const ctx = engine.ctx ?? new OfflineAudioContext(1, 1, 48000);
  const at = Math.max(0, Math.round(tick ?? engine.positionTick()));
  let target = trackId
    ? store.get().project?.tracks.find((t) => t.id === trackId && t.kind === 'audio')?.id
    : undefined;
  for (const f of list) {
    const p = store.get().project;
    if (!p) return;
    store.set({ bouncing: `Importing ${f.name}…` });
    try {
      const file = await audioFiles.upload(p.id, f, f.name, ctx);
      const name = f.name.replace(/\.[^.]+$/, '');
      const id = target ?? addAudioTrack(name);
      if (!id) return;
      const startSec = tickToSeconds(p.tempo, at);
      const end = Math.round(secondsToTick(p.tempo, startSec + file.seconds));
      const region = newRegion(at, Math.max(1, end - at), name);
      region.audio = { file: file.id, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
      apply(
        [
          { op: 'addFile', file },
          { op: 'addRegion', track: id, region },
        ],
        'Import Audio',
      );
      store.set({ selectedRegions: [region.id], selectedTrack: id });
      target = undefined;
    } catch (err) {
      toast(`${f.name}: ${err instanceof Error ? err.message : String(err)}`, 'error', 8000);
    } finally {
      store.set({ bouncing: null });
    }
  }
}

/** An audio region's gain set so its loudest peak reaches −1 dB. */
export function normalizeRegion(trackId: string, regionId: string): void {
  const p = store.get().project;
  const region = p?.tracks.find((t) => t.id === trackId)?.regions.find((r) => r.id === regionId);
  const clip = region?.audio;
  const peaks = clip ? audioFiles.peaks.get(clip.file) : undefined;
  if (!p || !region || !clip || !peaks) return;
  const seconds = secondsBetween(p, region.start, region.start + region.length) / clip.stretch;
  const perPeak = peaks.rate / peaks.step;
  const i0 = Math.max(0, Math.floor(clip.offset * perPeak));
  const i1 = Math.min(peaks.max.length, Math.ceil((clip.offset + seconds) * perPeak));
  let peak = 0;
  for (let i = i0; i < i1; i++)
    peak = Math.max(peak, Math.abs(peaks.min[i] as number), Math.abs(peaks.max[i] as number));
  if (peak < 1e-6) return;
  const gain = Math.round((-1 - 20 * Math.log10(peak)) * 10) / 10;
  apply([{ op: 'updateRegion', track: trackId, region: regionId, patch: { audio: { ...clip, gain } } }], 'Normalize');
  toast(`${region.name || 'Region'}: ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`);
}

/** Seconds of song between two ticks. */
export function secondsBetween(project: Project, from: number, to: number): number {
  return tickToSeconds(project.tempo, to) - tickToSeconds(project.tempo, from);
}

// ---- tracks ----

export function selectTrack(id: string | null): void {
  store.set({ selectedTrack: id, selectedNotes: [] });
  refreshRouting();
}

export function addTrack(instrument: Instrument, name?: string): string | null {
  const s = store.get();
  const p = s.project;
  if (!p) return null;
  const color = TRACK_COLORS[p.tracks.length % TRACK_COLORS.length];
  const track = newTrack(name ?? defaultName(instrument), instrument, color);
  const reverb = p.buses[0];
  if (reverb) track.channel.sends.push({ bus: reverb.id, level: -18, pre: false });
  const index = s.selectedTrack ? p.tracks.findIndex((t) => t.id === s.selectedTrack) + 1 : p.tracks.length;
  apply([{ op: 'addTrack', track, index }], 'New Track');
  selectTrack(track.id);
  return track.id;
}

export function defaultName(i: Instrument): string {
  if (i.type === 'sampler' || i.type === 'performance')
    return i.name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (i.type === 'synth') return i.preset;
  if (i.type === 'glass') return i.line ? 'Glass Line' : 'Glass';
  return 'Instrument';
}

export function deleteTrack(id: string): void {
  const p = store.get().project;
  if (!p) return;
  const index = p.tracks.findIndex((t) => t.id === id);
  apply([{ op: 'removeTrack', track: id }], 'Delete Track');
  const next = store.get().project?.tracks[Math.max(0, index - 1)];
  selectTrack(next?.id ?? null);
}

export function setInstrument(trackId: string, instrument: Instrument, rename = false): void {
  const p = store.get().project;
  const t = p?.tracks.find((x) => x.id === trackId);
  if (!t) return;
  const patch: TrackPatch = { instrument };
  if (rename) patch.name = defaultName(instrument);
  apply([{ op: 'updateTrack', track: trackId, patch }], 'Instrument');
}

export function updateTrack(trackId: string, patch: TrackPatch, label = 'Track'): void {
  apply([{ op: 'updateTrack', track: trackId, patch }], label);
}

export function updateChannel(target: string, patch: ChannelPatch, label = 'Mixer'): void {
  apply([{ op: 'updateChannel', target, patch }], label);
}

/** Mixer moves while dragging: applied live, one undo step per gesture. */
let gesture: { label: string; before: Project } | null = null;
export function beginGesture(label: string): void {
  const p = store.get().project;
  if (p) gesture = { label, before: p };
}
export function gestureChange(ops: Op[]): void {
  const s = store.get();
  if (!s.project) return;
  try {
    const next = applyOps(s.project, ops);
    store.set({ project: next, saveState: 'dirty' });
    engine.sync(next);
  } catch {
    // ignore a change that no longer applies mid-drag
  }
}
export function endGesture(): void {
  const s = store.get();
  if (gesture && s.project && gesture.before !== s.project) {
    store.set({
      undo: [...s.undo.slice(-(MAX_UNDO - 1)), { project: gesture.before, label: gesture.label }],
      redo: [],
    });
    changed(s.project);
  }
  gesture = null;
}

export function addPlugin(target: string, type: string, slot: 'inserts' | 'midiFx'): void {
  const plugin = newPlugin(type);
  apply([{ op: 'addPlugin', target, slot, plugin }], 'Add Plugin');
  store.set({ plugin: { target, id: plugin.id } });
}

export function addBus(name = 'Bus'): string | null {
  const bus = newBus(name);
  return apply([{ op: 'addBus', bus }], 'New Bus') ? bus.id : null;
}

// ---- regions ----

export function findRegion(project: Project, regionId: string): { track: Track; region: Region } | null {
  for (const track of project.tracks) {
    const region = track.regions.find((r) => r.id === regionId);
    if (region) return { track, region };
  }
  return null;
}

/** A region covering a bar, on a track, at a tick (Logic: click with the pencil). */
export function createRegionAt(trackId: string, tick: number, bars = 1): Region | null {
  const p = store.get().project;
  if (!p) return null;
  const m = meterAt(p.meter, tick);
  const bar = ticksPerBar(m);
  const start = Math.floor(tick / bar) * bar;
  const region = newRegion(start, bar * bars, '');
  apply([{ op: 'addRegion', track: trackId, region }], 'New Region');
  store.set({ selectedRegions: [region.id], selectedTrack: trackId });
  return region;
}

export function deleteSelection(): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  if (s.selectedNotes.length) {
    deleteNotes(s.selectedNotes);
    return;
  }
  const ops: Op[] = [];
  for (const id of s.selectedRegions) {
    const found = findRegion(p, id);
    if (found) ops.push({ op: 'removeRegion', track: found.track.id, region: id });
  }
  if (ops.length) {
    apply(ops, ops.length > 1 ? 'Delete Regions' : 'Delete Region');
    store.set({ selectedRegions: [] });
  }
}

export function splitAtPlayhead(): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  const at = Math.round(engine.positionTick());
  const ops: Op[] = [];
  const ids = s.selectedRegions.length
    ? s.selectedRegions
    : (p.tracks.find((t) => t.id === s.selectedTrack)?.regions.map((r) => r.id) ?? []);
  for (const id of ids) {
    const found = findRegion(p, id);
    if (!found) continue;
    const { track, region } = found;
    if (at <= region.start || at >= region.start + region.length) continue;
    const cut = at - region.start;
    const left: Region = { ...region, length: cut, notes: region.notes.filter((n) => n.t < cut) };
    const right: Region = {
      ...region,
      id: newId('rgn'),
      start: at,
      length: region.length - cut,
      notes: region.notes.filter((n) => n.t >= cut).map((n) => ({ ...n, t: n.t - cut })),
      cc: Object.fromEntries(
        Object.entries(region.cc).map(([k, v]) => [
          k,
          v.filter((x) => x[0] >= cut).map(([t, y]): [number, number] => [t - cut, y]),
        ]),
      ),
    };
    left.cc = Object.fromEntries(Object.entries(region.cc).map(([k, v]) => [k, v.filter((x) => x[0] < cut)]));
    if (region.audio) {
      // the right half plays on from where the cut fell in the recording
      const a = region.audio;
      left.audio = { ...a, fadeOut: 0 };
      right.audio = { ...a, fadeIn: 0, offset: a.offset + secondsBetween(p, region.start, at) / a.stretch };
    }
    ops.push(
      { op: 'removeRegion', track: track.id, region: region.id },
      { op: 'addRegion', track: track.id, region: left },
      { op: 'addRegion', track: track.id, region: right },
    );
  }
  if (ops.length) apply(ops, 'Split');
}

export function repeatRegions(): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  const ops: Op[] = [];
  const newIds: string[] = [];
  for (const id of s.selectedRegions) {
    const found = findRegion(p, id);
    if (!found) continue;
    const copy = {
      ...structuredClone(found.region),
      id: newId('rgn'),
      start: found.region.start + found.region.length,
    };
    newIds.push(copy.id);
    ops.push({ op: 'addRegion', track: found.track.id, region: copy });
  }
  if (ops.length) {
    apply(ops, 'Repeat');
    store.set({ selectedRegions: newIds });
  }
}

// ---- notes ----

/** Where a note lives: its track and region, found by object identity. */
export function locateNote(project: Project, note: Note): { track: Track; region: Region } | null {
  for (const track of project.tracks)
    for (const region of track.regions) if (region.notes.includes(note)) return { track, region };
  return null;
}

export function deleteNotes(notes: readonly Note[]): void {
  const p = store.get().project;
  if (!p) return;
  const doomed = new Set(notes);
  const ops: Op[] = [];
  for (const track of p.tracks) {
    for (const region of track.regions) {
      if (!region.notes.some((n) => doomed.has(n))) continue;
      ops.push({
        op: 'setNotes',
        track: track.id,
        region: region.id,
        notes: region.notes.filter((n) => !doomed.has(n)),
      });
    }
  }
  if (ops.length) {
    apply(ops, notes.length > 1 ? 'Delete Notes' : 'Delete Note');
    store.set({ selectedNotes: [] });
  }
}

/** Replace some notes with changed copies (moved, stretched, re-velocitied), keeping them selected. */
export function replaceNotes(changes: Map<Note, Note>, label: string, keepSelected = true): void {
  const p = store.get().project;
  if (!p || !changes.size) return;
  const ops: Op[] = [];
  for (const track of p.tracks) {
    for (const region of track.regions) {
      if (!region.notes.some((n) => changes.has(n))) continue;
      ops.push({
        op: 'setNotes',
        track: track.id,
        region: region.id,
        notes: region.notes.map((n) => changes.get(n) ?? n),
      });
    }
  }
  if (apply(ops, label) && keepSelected) store.set({ selectedNotes: [...changes.values()] });
}

export function quantizeSelection(): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  const grid = DIVISIONS[s.grid] ?? PPQ / 4;
  let notes = s.selectedNotes;
  if (!notes.length) {
    const regions = s.selectedRegions.length
      ? s.selectedRegions.map((id) => findRegion(p, id)?.region).filter((r): r is Region => !!r)
      : (p.tracks.find((t) => t.id === s.selectedTrack)?.regions ?? []);
    notes = regions.flatMap((r) => r.notes);
  }
  const changes = new Map<Note, Note>();
  for (const n of notes) {
    const where = locateNote(p, n);
    if (!where) continue;
    const abs = where.region.start + n.t;
    changes.set(n, { ...n, t: quantize(abs, grid) - where.region.start });
  }
  replaceNotes(changes, 'Quantize', s.selectedNotes.length > 0);
}

export function transposeSelection(semitones: number): void {
  const notes = store.get().selectedNotes;
  if (!notes.length) return;
  replaceNotes(new Map(notes.map((n) => [n, { ...n, p: Math.max(0, Math.min(127, n.p + semitones)) }])), 'Transpose');
}

export function selectAll(): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  if (s.editor === 'piano' && s.selectedTrack) {
    const t = p.tracks.find((x) => x.id === s.selectedTrack);
    store.set({ selectedNotes: t?.regions.flatMap((r) => r.notes) ?? [] });
  } else {
    store.set({ selectedRegions: p.tracks.flatMap((t) => t.regions.map((r) => r.id)) });
  }
}

// ---- creations ----

/**
 * The creation renders this song itself (its samples, halls and mastering, with the edits made here),
 * through the creation runner on the host; its render comes back as a soloed audio track.
 */
export async function renderInCreation(): Promise<void> {
  const p = store.get().project;
  if (!p?.origin) return;
  await saveNow();
  try {
    const res = await fetch(`/api/projects/${p.id}/render`, { method: 'POST' });
    const body = (await res.json()) as { ok?: boolean; error?: string; already?: boolean };
    if (!res.ok) throw new Error(body.error ?? 'The render could not start');
    store.set({ dialog: null, bouncing: `${p.origin.creation} is rendering ${p.title}…` });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error', 10000);
  }
}

export async function sendToCreation(): Promise<void> {
  const p = store.get().project;
  if (!p?.origin) return;
  await saveNow();
  try {
    const r = await api.send(p.id);
    toast(
      r.edited.length
        ? `Sent to ${p.origin.creation}: ${r.edited.length} edited track${r.edited.length === 1 ? '' : 's'} (${r.path})`
        : `Sent to ${p.origin.creation} (${r.path})`,
    );
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error', 8000);
  }
}

export async function openPiece(creation: string, piece: string): Promise<void> {
  try {
    load(await api.openPiece(creation, piece));
    store.set({ dialog: null });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error', 8000);
  }
}

// ---- bouncing ----

/**
 * Render the song (or the cycle, when it's on) to a WAV file, keep a copy with the song on the host,
 * and download it on this device when asked.
 */
export async function bounceSong(
  download = true,
): Promise<{ file: string; url: string; path: string; seconds: number } | null> {
  const p = store.get().project;
  if (!p || store.get().bouncing) return null;
  const range = bounceRange(p, projectEnd(p));
  const name = p.cycle.on ? `${p.title} (cycle)` : p.title;
  store.set({ bouncing: 'Starting…' });
  try {
    const { wav, seconds } = await bounce(p, {
      ...range,
      tail: 3,
      onProgress: (text) => store.set({ bouncing: text }),
    });
    store.set({ bouncing: 'Saving…' });
    const res = await fetch(`/api/projects/${p.id}/bounces?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav,
    });
    const saved = res.ok ? ((await res.json()) as { file: string; url: string; path: string }) : null;
    if (download) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(wav);
      a.download = `${name}.wav`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
    const m = Math.floor(seconds / 60);
    toast(
      `Bounced ${m}:${String(Math.round(seconds % 60)).padStart(2, '0')} of “${name}” (24-bit WAV${saved ? ', kept with the song' : ''})`,
    );
    return saved ? { ...saved, seconds } : null;
  } catch (err) {
    toast(`The bounce failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 8000);
    return null;
  } finally {
    store.set({ bouncing: null });
  }
}

/** How long the song runs, in ticks, plus a few empty bars to write into. */
export function songLength(project: Project): number {
  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  return projectEnd(project) + ticksPerBar(m) * 8;
}
