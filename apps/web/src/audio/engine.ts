/**
 * The audio engine as the rest of the app sees it: starts the AudioContext and the audio thread,
 * keeps the audio thread's copy of the song in step with the session, plays, stops and records,
 * and answers "where is the playhead" and "how loud is this channel" without a round trip.
 */

import {
  type AheadPool,
  aheadPartGuess,
  aheadTrackGuess,
  clipKey,
  compileClips,
  compileGraph,
  compileTempo,
  compileTrack,
  EV_OFF,
  EV_ON,
  EVENT_INTS,
  EVENT_SIZE,
  type FromWorklet,
  frameToTick,
  type GraphSpec,
  type InputSpec,
  impulseBuffers,
  instrumentSpec,
  isPlanned,
  METER_CHANNELS,
  METER_FLOATS,
  meterTicks,
  type PerformanceManifest,
  type PreparedImpulse,
  partSamples,
  planTrack,
  RING_EVENTS,
  RING_HEADER,
  RING_INTS,
  type SamplerSpec,
  sharedImpulse,
  songClips,
  songImpulses,
  type TempoSegment,
  type ToWorklet,
  TR_FINE_CLOCK,
  TR_LOAD,
  TR_LOAD_PEAK,
  TR_OVERLOADS,
  TRANSPORT_FLOATS,
  tickToFrame,
  toShared,
} from '@holo/engine';
import type { CompanionDevice } from '@holo/engine/companion';
import { type Project, projectEnd, type Track } from '@holo/session';
import { aheadThreads, startAhead, warmAhead } from './ahead.ts';
import { companion } from './companion.ts';
import { audioFiles } from './files.ts';
import ImpulseWorker from './impulse.worker.ts?worker';
import { instrumentManifest, sampleFile } from './pack-files.ts';
import processorUrl from './worklet/processor.ts?worker&url';

export type LatencyMode = 'lowest' | 'balanced' | 'safe';

/** How long an instrument no track plays keeps its samples (an undo often brings it back). */
const FORGET_AFTER = 30_000;

/** The audio thread's and the workers' scripts into the browser's cache, so the Start click doesn't wait for them. */
export function warmEngine(): void {
  if (typeof fetch !== 'function') return;
  void fetch(processorUrl).catch(() => undefined);
  warmAhead();
}

let isolationWarned = false;

const HINT: Record<LatencyMode, AudioContextLatencyCategory | number> = {
  lowest: 0,
  balanced: 'interactive',
  safe: 'playback',
};

export interface LatencyInfo {
  /** The browser's own processing latency, ms. */
  base: number;
  /** From the audio thread to your ears (the device and the OS), ms. */
  output: number;
  sampleRate: number;
  /** Shared memory in use: live MIDI skips the message queue. */
  sharedMemory: boolean;
  /** HO[LO] Engine's device, while the companion plays (the browser's figures don't count then). */
  companion: CompanionDevice | null;
}

/** A take recorded on an audio track, ready to keep. */
export interface RecordedTake {
  trackId: string;
  /** Song frame of its first sample, before the round trip is taken off. */
  frame: number;
  channels: Float32Array[];
  sampleRate: number;
}

/** Where the audio thread's messages go: the worklet's port, or HO[LO] Engine. */
interface EnginePort {
  postMessage(msg: ToWorklet, transfer?: Transferable[]): void;
}

export class AudioEngine {
  ctx: AudioContext | null = null;
  private node: AudioWorkletNode | null = null;
  private port: EnginePort | null = null;
  /** HO[LO] Engine plays (this context then only decodes, at the companion's rate). */
  remote = false;
  private ring: Int32Array | null = null;
  private meters: Float32Array<ArrayBufferLike> = new Float32Array(METER_CHANNELS * METER_FLOATS);
  private transport: Float64Array<ArrayBufferLike> = new Float64Array(TRANSPORT_FLOATS);
  private nums = new Map<string, number>();
  private nextNum = 1;
  private sentTracks = new Map<string, Track['regions']>();
  /** The tempo and meter lists the audio thread has (the session shares what an edit leaves alone, so the same lists are the same tempo). */
  private sentTempo: { tempo: Project['tempo']; meter: Project['meter'] } | null = null;
  /** Goes up with each tempo map sent: the cycle's frames and the graph's automation depend on it. */
  private tempoGen = 0;
  private sentGraph = '';
  /** What the graph was last compiled from: the same lists make the same graph. */
  private graphFrom: {
    tracks: Project['tracks'];
    buses: Project['buses'];
    master: Project['master'];
    tempoGen: number;
  } | null = null;
  private sentCycle = '';
  /** The song last brought up to date (the same one again has nothing new). */
  private synced: Project | null = null;
  /** A gesture's sync left planned parts for its end. */
  private partsDeferred = false;
  private livePending: Project | null = null;
  private liveFrame = 0;
  segments: TempoSegment[] = [{ frame: 0, tick: 0, framesPerTick: 25 }];
  private project: Project | null = null;
  private liveFallback: number[] = [];
  private liveScheduled = false;
  private samplers = new Set<string>();
  /** Samplers whose samples are in shared memory: they outlive the threads, so a restart needn't load them again. */
  private kept = new Map<string, SamplerSpec>();
  /** Sampler keys the song's tracks play (as of the last graph). */
  private usedSamplers = new Set<string>();
  /** Samplers no track plays, and since when: let go after a grace. */
  private unused = new Map<string, number>();
  private unusedTimer: ReturnType<typeof setTimeout> | null = null;
  private restartListeners = new Set<(keys: string[]) => void>();
  private forgetListeners = new Set<(keys: string[]) => void>();
  private errorListeners = new Set<(message: string) => void>();
  latencyMode: LatencyMode = 'balanced';
  private lowLatency = true;
  /** The sound device to play through ('' = the system's default). */
  private output = '';
  private idleTick = 0;
  /** Clip audio the audio thread has (or is being given), by key. */
  private audioSent = new Set<string>();
  /** Space Designer responses the audio thread has (or is being given), by key. */
  private impulsesSent = new Set<string>();
  private impulseWorker: Worker | null = null;
  private sentInputs = '';
  /** The track list the inputs were last worked out from. */
  private inputTracks: Project['tracks'] | null = null;
  private inputDevice = '';
  private inputStream: MediaStream | null = null;
  private inputSource: MediaStreamAudioSourceNode | null = null;
  private inputWanted = false;
  private inputOpening: Promise<void> | null = null;
  private takes = new Map<string, { num: number; frame: number; chunks: Float32Array[][] }>();
  private takeListeners = new Set<(take: RecordedTake) => void>();
  private inputListeners = new Set<(message: string) => void>();
  /** Rendering ahead: workers on the other cores play the song ahead of the playhead (null: the audio thread plays it all). */
  private ahead: AheadPool | null = null;
  private aheadTimer: ReturnType<typeof setInterval> | null = null;

  get started(): boolean {
    return this.ctx !== null && (this.remote || this.ctx.state === 'running');
  }

  /** Must be called from a user gesture (a click or a key) the first time. */
  async start(mode: LatencyMode = this.latencyMode): Promise<void> {
    const remote = companion.device;
    if (
      this.ctx &&
      this.latencyMode === mode &&
      this.remote === (remote !== null) &&
      this.sampleRate === (remote?.rate ?? this.sampleRate)
    ) {
      if (!this.remote && this.ctx.state !== 'running') await this.ctx.resume();
      return;
    }
    // the playhead stays where it was (a link to a bar, or a restart with new latency settings)
    const keep = this.positionTick();
    if (this.ctx) await this.close();
    this.idleTick = keep;
    this.latencyMode = mode;
    if (remote) {
      // HO[LO] Engine plays: this context decodes the samples at its rate and plays nothing
      this.ctx = new AudioContext({ sampleRate: remote.rate });
      // (suspended, it holds no sound device: HO[LO] Engine may want it to itself)
      void this.ctx.suspend();
      this.remote = true;
      this.port = companion;
      companion.onmessage = (msg) => this.onMessage(msg);
      this.ring = null;
      this.meters = new Float32Array(METER_CHANNELS * METER_FLOATS);
      this.transport = new Float64Array(TRANSPORT_FLOATS);
      // (HO[LO] Engine renders ahead on its own threads, laid out by itself, from what it's sent)
      this.stallsSeen = 0;
      this.post({ type: 'init', ring: null, meters: null, transport: null });
      this.resend();
      this.locate(Math.max(0, keep));
      return;
    }
    const ctx = new AudioContext({ latencyHint: HINT[mode] });
    await ctx.audioWorklet.addModule(processorUrl);
    const node = new AudioWorkletNode(ctx, 'holo-engine', {
      // the input is for audio tracks: monitoring and recording
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    node.connect(ctx.destination);
    node.port.onmessage = (e: MessageEvent<FromWorklet>) => this.onMessage(e.data);
    const shared = globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined';
    if (!shared && window.isSecureContext && !isolationWarned) {
      isolationWarned = true;
      console.warn(
        '[engine] This page is not cross-origin isolated (no Cross-Origin-Opener-Policy / Cross-Origin-Embedder-Policy headers): without shared memory, live MIDI and the meters go by message, and the song is not rendered ahead on worker threads.',
      );
    }
    let ring: SharedArrayBuffer | null = null;
    let meters: SharedArrayBuffer | null = null;
    let transport: SharedArrayBuffer | null = null;
    if (shared) {
      ring = new SharedArrayBuffer(RING_INTS * 4);
      meters = new SharedArrayBuffer(METER_CHANNELS * METER_FLOATS * 4);
      transport = new SharedArrayBuffer(TRANSPORT_FLOATS * 8);
      this.ring = new Int32Array(ring);
      this.meters = new Float32Array(meters);
      this.transport = new Float64Array(transport);
    }
    this.ctx = ctx;
    this.node = node;
    // with shared memory, the song plays ahead on the other cores and only the master (and what's
    // played live) on the audio thread
    const threads = shared ? aheadThreads() : 0;
    if (threads > 0) {
      this.stallsSeen = 0;
      this.ahead = startAhead(threads, ctx.sampleRate, (message) => {
        for (const fn of this.errorListeners) fn(message);
      });
      // when a worker has too much to do (the first layout is a guess), the strips laid out again
      this.aheadTimer = setInterval(() => {
        for (const m of this.ahead?.check(this.playing, performance.now()) ?? []) this.post(m);
      }, 2000);
    }
    this.port = node.port;
    // (the workers have their own init: post() would hand them this one too)
    node.port.postMessage({ type: 'init', ring, meters, transport, ahead: this.ahead?.spec(-1) ?? null });
    this.resend();
    if (this.output) await this.setOutput(this.output).catch(() => undefined);
    this.locate(Math.max(0, keep));
    if (ctx.state !== 'running') await ctx.resume();
  }

  /** A new audio thread (or HO[LO] Engine) knows nothing yet: the whole song again. */
  private resend(): void {
    this.sentTracks.clear();
    this.sentParts.clear();
    this.perfSent.clear();
    this.sentTempo = null;
    this.graphFrom = null;
    this.synced = null;
    this.inputTracks = null;
    this.sentGraph = this.sentCycle = this.sentInputs = '';
    this.audioSent.clear();
    this.impulsesSent.clear();
    this.closeInput();
    // a new audio thread needs its samples again: those in shared memory are handed over as they
    // are (the memory outlives the threads); whoever loaded the rest loads them anew
    const again: string[] = [];
    const keys = [...this.samplers];
    this.samplers.clear();
    for (const key of keys) {
      const spec = this.kept.get(key);
      if (spec) this.addSampler(spec);
      else again.push(key);
    }
    if (again.length) for (const fn of this.restartListeners) fn(again);
    if (this.project) this.sync(this.project);
    this.post({ type: 'lowLatency', on: this.lowLatency });
  }

  async close(): Promise<void> {
    this.closeInput();
    if (this.aheadTimer) clearInterval(this.aheadTimer);
    this.aheadTimer = null;
    this.ahead?.close();
    this.ahead = null;
    this.node?.disconnect();
    if (this.remote) companion.onmessage = null;
    await this.ctx?.close();
    this.ctx = null;
    this.node = null;
    this.port = null;
    this.remote = false;
    this.ring = null;
  }

  onError(fn: (message: string) => void): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  private onMessage(msg: FromWorklet): void {
    if (msg.type === 'state') {
      this.transport.set(msg.transport);
      this.meters.set(msg.meters);
    } else if (msg.type === 'error') {
      for (const fn of this.errorListeners) fn(msg.message);
    } else if (msg.type === 'recorded') {
      this.onRecorded(msg);
    }
  }

  private onRecorded(msg: Extract<FromWorklet, { type: 'recorded' }>): void {
    const id = `${msg.num}:${msg.take}`;
    let take = this.takes.get(id);
    if (!take) {
      take = { num: msg.num, frame: msg.frame, chunks: [] };
      this.takes.set(id, take);
    }
    if (take.frame < 0) take.frame = msg.frame;
    if (msg.channels[0]?.length) take.chunks.push(msg.channels);
    if (!msg.last) return;
    this.takes.delete(id);
    const total = take.chunks.reduce((n, c) => n + (c[0]?.length ?? 0), 0);
    const trackId = [...this.nums].find(([, n]) => n === take.num)?.[0];
    if (!total || !trackId || take.frame < 0) return;
    const count = take.chunks[0]?.length ?? 1;
    const channels = Array.from({ length: count }, () => new Float32Array(total));
    let at = 0;
    for (const chunk of take.chunks) {
      for (let c = 0; c < count; c++) (channels[c] as Float32Array).set(chunk[c] as Float32Array, at);
      at += chunk[0]?.length ?? 0;
    }
    const done: RecordedTake = { trackId, frame: take.frame, channels, sampleRate: this.sampleRate };
    for (const fn of this.takeListeners) fn(done);
  }

  /** Audio takes, as each finishes. */
  onTake(fn: (take: RecordedTake) => void): () => void {
    this.takeListeners.add(fn);
    return () => this.takeListeners.delete(fn);
  }

  /** The input couldn't open (no permission, no device). */
  onInputError(fn: (message: string) => void): () => void {
    this.inputListeners.add(fn);
    return () => this.inputListeners.delete(fn);
  }

  private post(msg: ToWorklet, transfer: Transferable[] = []): void {
    if (this.ahead) {
      // every engine takes in the same messages, in the same order (samples and the like are in
      // shared memory, so nothing big is copied)
      this.ahead.post(msg);
      this.node?.port.postMessage(msg);
      return;
    }
    this.port?.postMessage(msg, transfer);
  }

  get sampleRate(): number {
    return this.ctx?.sampleRate ?? 48000;
  }

  /** A stable number for a track or bus: meters and live MIDI address channels by it. */
  numOf(id: string): number {
    let n = this.nums.get(id);
    if (n === undefined) {
      n = this.nextNum++;
      this.nums.set(id, n);
    }
    return n;
  }

  /** Bring the audio thread up to date with the session: only what changed is sent. */
  sync(project: Project): void {
    // (a full pass covers whatever a gesture still had waiting)
    this.livePending = null;
    this.syncNow(project, false);
  }

  /**
   * A gesture's change (a fader, a knob, the tempo being dragged): the audio thread follows once a
   * frame, with the slow work (planning parts) left for the gesture's end.
   */
  syncSoon(project: Project): void {
    this.project = project;
    this.livePending = project;
    if (this.liveFrame) return;
    this.liveFrame = nextFrame(() => {
      this.liveFrame = 0;
      const p = this.livePending;
      this.livePending = null;
      if (p) this.syncNow(p, true);
    });
  }

  /**
   * What changed is found by what the session shares: an edit keeps every list it leaves alone, so
   * the same tempo list, track list or regions are the same music, without reading through them.
   */
  private syncNow(project: Project, live: boolean): void {
    this.project = project;
    if (!this.port) return;
    const sr = this.sampleRate;
    if (project !== this.synced || (this.partsDeferred && !live)) {
      this.synced = project;
      if (!live) this.partsDeferred = false;
      if (!this.sentTempo || this.sentTempo.tempo !== project.tempo || this.sentTempo.meter !== project.meter) {
        const tick = this.sentTempo ? this.positionTick() : null;
        this.segments = compileTempo(project, sr);
        this.post({ type: 'tempo', segments: this.segments, ppq: 960, ...meterTicks(project) });
        this.sentTempo = { tempo: project.tempo, meter: project.meter };
        this.tempoGen++;
        this.sentTracks.clear();
        this.sentCycle = '';
        // the playhead keeps its place in the music (its frame alone would have moved with the tempo)
        if (tick !== null && tick >= 0 && Math.round(tickToFrame(this.segments, tick)) !== this.songFrame())
          this.locate(tick);
      }
      const from = this.graphFrom;
      if (
        !from ||
        from.tracks !== project.tracks ||
        from.buses !== project.buses ||
        from.master !== project.master ||
        from.tempoGen !== this.tempoGen
      ) {
        this.graphFrom = {
          tracks: project.tracks,
          buses: project.buses,
          master: project.master,
          tempoGen: this.tempoGen,
        };
        const graph = compileGraph(project, (id) => this.numOf(id), this.segments);
        // (the graph is built afresh each time: its text says whether anything in it changed)
        const graphKey = JSON.stringify(graph);
        if (graphKey !== this.sentGraph) {
          this.post({ type: 'graph', graph });
          this.sentGraph = graphKey;
          if (this.ahead) for (const m of this.ahead.layout(graph, this.playing)) this.post(m);
          this.pruneSamplers(graph);
        }
        this.syncAudio(project);
        this.syncImpulses(project);
      }
      for (const t of project.tracks) {
        const planned = isPlanned(t);
        if (planned && this.partChanged(t, project)) {
          if (live) this.partsDeferred = true;
          else void this.syncPart(t, project);
        }
        if (!planned && this.sentParts.has(t.id)) {
          this.sentParts.delete(t.id);
          this.post({ type: 'plans', num: this.numOf(t.id), plans: null });
        }
        if (this.sentTracks.get(t.id) === t.regions && this.sentArts.get(t.id) === t.articulations) continue;
        let events = compileTrack(t, this.segments);
        if (this.ahead && !planned) {
          const length = tickToFrame(this.segments, projectEnd(project));
          this.ahead.setPart(this.numOf(t.id), aheadTrackGuess(events, instrumentSpec(t.instrument), length, sr));
        }
        // a planned part's notes play as its plans; its sequence keeps only its controllers
        if (planned) events = withoutNotes(events);
        // rendering ahead, every engine reads the one copy in shared memory; else it's transferred
        if (this.ahead) this.post({ type: 'sequence', num: this.numOf(t.id), events: sharedEvents(events) });
        else this.post({ type: 'sequence', num: this.numOf(t.id), events }, [events.buffer]);
        if (t.kind === 'audio')
          this.post({ type: 'clips', num: this.numOf(t.id), clips: compileClips(t, this.segments, sr) });
        this.sentTracks.set(t.id, t.regions);
        this.sentArts.set(t.id, t.articulations);
      }
    }
    this.syncInputs(project);
    const c = project.cycle;
    const cycleKey = `${c.on}:${c.start}:${c.end}:${this.tempoGen}`;
    if (cycleKey !== this.sentCycle) {
      this.post({
        type: 'cycle',
        on: c.on && c.end > c.start,
        start: Math.round(tickToFrame(this.segments, c.start)),
        end: Math.round(tickToFrame(this.segments, c.end)),
      });
      this.sentCycle = cycleKey;
    }
  }
  private sentArts = new Map<string, Track['articulations']>();
  /** Planned parts: what they were planned from (the pieces, and their text), the newest planning, and the sample files sent. */
  private sentParts = new Map<string, { from: readonly unknown[]; key: string }>();
  private partVersion = new Map<string, number>();
  private perfSent = new Map<string, Set<number>>();

  /** Whether a part needs planning again: the pieces it's planned from have changed, by their text if not the same objects. */
  private partChanged(t: Track, project: Project): boolean {
    const sent = this.sentParts.get(t.id);
    if (!sent) return true;
    const from = partFrom(t, project);
    if (from.every((x, i) => x === sent.from[i])) return false;
    // other objects (a song opened again): their text says whether they're the same part
    if (sent.key !== partKey(t, project)) return true;
    sent.from = from;
    return false;
  }

  /**
   * Plan a part (a Performance instrument's or Glass's) and hand it over, with the sample files its
   * notes play; a newer change while it's planning takes over.
   */
  private async syncPart(t: Track, project: Project): Promise<void> {
    const ctx = this.ctx;
    if (!ctx) return;
    this.sentParts.set(t.id, { from: partFrom(t, project), key: partKey(t, project) });
    const version = (this.partVersion.get(t.id) ?? 0) + 1;
    this.partVersion.set(t.id, version);
    const current = () => this.partVersion.get(t.id) === version;
    try {
      const inst = t.instrument;
      let perf: PerformanceManifest | undefined;
      if (inst.type === 'performance') {
        perf = (await instrumentManifest(inst.pack, inst.name)).performance;
        if (!perf) throw new Error(`${inst.pack}/${inst.name} has no Performance data`);
        perf = atRate(perf, ctx.sampleRate);
      }
      if (!current()) return;
      const plans = planTrack(t, project, this.segments, ctx.sampleRate, perf);
      if (plans?.kind === 'performance' && perf && inst.type === 'performance') {
        const sent = this.perfSent.get(plans.key) ?? new Set<number>();
        this.perfSent.set(plans.key, sent);
        const wanted = partSamples(plans).filter((i) => !sent.has(i));
        const samples = await Promise.all(
          wanted.map(async (index) => {
            const [left, right] = await sampleFile(inst.pack, perf?.files[index] as string, ctx);
            const l = this.share(left);
            return { index, left: l, right: right === left ? l : this.share(right) };
          }),
        );
        if (!current()) return;
        for (const x of samples) sent.add(x.index);
        if (samples.length)
          this.post(
            { type: 'performance', key: plans.key, samples },
            transferable(samples.flatMap((x) => [x.left, x.right])),
          );
      }
      if (!current()) return;
      this.post({ type: 'plans', num: this.numOf(t.id), plans });
      const length = tickToFrame(this.segments, projectEnd(project));
      this.ahead?.setPart(this.numOf(t.id), plans ? aheadPartGuess(plans, length) : null);
    } catch (err) {
      this.sentParts.delete(t.id);
      for (const fn of this.errorListeners) fn(err instanceof Error ? err.message : String(err));
    }
  }

  /** Clip audio: load what the song's regions play, let go of what they no longer do. */
  private syncAudio(project: Project): void {
    const ctx = this.ctx;
    if (!ctx) return;
    const wanted = songClips(project);
    const keys = new Set(wanted.map(clipKey));
    for (const key of this.audioSent) {
      if (keys.has(key)) continue;
      this.audioSent.delete(key);
      this.post({ type: 'forgetAudio', key });
    }
    for (const clip of wanted) {
      const key = clipKey(clip);
      if (this.audioSent.has(key)) continue;
      this.audioSent.add(key);
      void audioFiles
        .load(project.id, clip, ctx)
        .then((channels) => {
          // still wanted, and still the same audio thread?
          if (this.ctx !== ctx || !this.audioSent.has(key)) return;
          if (this.ahead) this.post({ type: 'audio', key, channels: channels.map(toShared) });
          else
            this.post(
              { type: 'audio', key, channels },
              channels.map((c) => c.buffer as ArrayBuffer),
            );
        })
        .catch((err: unknown) => {
          this.audioSent.delete(key);
          for (const fn of this.errorListeners) fn(err instanceof Error ? err.message : String(err));
        });
    }
  }

  /** Space Designer's spaces: made (or read) in a worker, then handed to the audio thread. */
  private syncImpulses(project: Project): void {
    const ctx = this.ctx;
    if (!ctx) return;
    for (const { key, source } of songImpulses(project, ctx.sampleRate)) {
      if (this.impulsesSent.has(key)) continue;
      this.impulsesSent.add(key);
      if (!this.impulseWorker) {
        this.impulseWorker = new ImpulseWorker();
        this.impulseWorker.onmessage = (e: MessageEvent<{ key: string; data?: PreparedImpulse; error?: string }>) => {
          const { key: k, data, error } = e.data;
          if (data && this.impulsesSent.has(k)) {
            if (this.ahead) this.post({ type: 'impulse', key: k, data: sharedImpulse(data) });
            else this.post({ type: 'impulse', key: k, data }, impulseBuffers(data));
          }
          if (error) {
            this.impulsesSent.delete(k);
            for (const fn of this.errorListeners) fn(error);
          }
        };
      }
      this.impulseWorker.postMessage({ key, source, rate: ctx.sampleRate });
    }
  }

  /** Audio tracks that are armed or monitoring listen to this device's input. */
  private syncInputs(project: Project): void {
    if (project.tracks !== this.inputTracks) {
      this.inputTracks = project.tracks;
      const specs: InputSpec[] = project.tracks
        .filter((t) => t.kind === 'audio' && (t.armed || t.audioInput?.monitor))
        .map((t) => ({
          num: this.numOf(t.id),
          input: t.audioInput?.input ?? 0,
          channels: t.audioInput?.channels ?? 1,
          monitor: t.audioInput?.monitor ?? false,
          record: t.armed,
        }));
      const key = specs
        .map((s) => `${s.num}:${s.input}:${s.channels}:${s.monitor ? 1 : 0}:${s.record ? 1 : 0}`)
        .join(' ');
      if (key !== this.sentInputs) {
        this.post({ type: 'inputs', tracks: specs });
        this.sentInputs = key;
      }
      // (HO[LO] Engine records from the system's default input itself)
      this.inputWanted = specs.length > 0 && !this.remote;
    }
    if (this.inputWanted && !this.inputSource && !this.inputOpening && this.started) {
      this.inputOpening = this.openInput().finally(() => {
        this.inputOpening = null;
      });
    } else if (!this.inputWanted && this.inputSource) this.closeInput();
  }

  private async openInput(): Promise<void> {
    const ctx = this.ctx;
    const node = this.node;
    if (!ctx || !node) return;
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          ...(this.inputDevice ? { deviceId: { exact: this.inputDevice } } : {}),
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
          channelCount: { ideal: 2 },
        },
      });
      if (this.ctx !== ctx || !this.inputWanted) {
        for (const t of stream.getTracks()) t.stop();
        return;
      }
      this.inputStream = stream;
      this.inputSource = ctx.createMediaStreamSource(stream);
      this.inputSource.connect(node);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      for (const fn of this.inputListeners) fn(message);
    }
  }

  private closeInput(): void {
    this.inputSource?.disconnect();
    this.inputSource = null;
    for (const t of this.inputStream?.getTracks() ?? []) t.stop();
    this.inputStream = null;
  }

  /** The input audio tracks record from ('' = the system's default). */
  async setInput(deviceId: string): Promise<void> {
    this.inputDevice = deviceId;
    if (!this.inputSource) return;
    this.closeInput();
    if (this.inputWanted) await this.openInput();
  }

  /** The input's own latency as the browser reports it, ms (null when it doesn't). */
  inputLatency(): number | null {
    const settings = this.inputStream?.getAudioTracks()[0]?.getSettings() as
      | (MediaTrackSettings & { latency?: number })
      | undefined;
    return typeof settings?.latency === 'number' ? settings.latency * 1000 : null;
  }

  /** Whether the input is open (the browser shows its microphone light). */
  get inputOpen(): boolean {
    return this.inputSource !== null;
  }

  /** Punch in or out while playing: audio tracks start or end their takes. */
  setRecording(on: boolean): void {
    this.post({ type: 'record', on });
  }

  /**
   * Hand an instrument's samples to the audio thread. In shared memory (rendering ahead, or decoded
   * there to begin with) the audio thread and every worker play the one copy, and this side keeps
   * it for the next audio thread; otherwise they're transferred, and this side keeps no copy.
   */
  addSampler(spec: SamplerSpec): void {
    this.samplers.add(spec.key);
    if (this.usedSamplers.has(spec.key)) this.unused.delete(spec.key);
    else this.markUnused(spec.key);
    let sent = spec;
    if (this.ahead)
      sent = {
        ...spec,
        zones: spec.zones.map((z) => ({ ...z, left: toShared(z.left), right: z.right ? toShared(z.right) : null })),
      };
    const arrays = sent.zones.flatMap((z) => (z.right ? [z.left, z.right] : [z.left]));
    if (arrays.every(isShared)) this.kept.set(spec.key, sent);
    else this.kept.delete(spec.key);
    this.post({ type: 'sampler', spec: sent }, transferable(arrays));
  }

  /** In shared memory as it is, or as a copy there when rendering ahead; otherwise a copy to transfer. */
  private share(a: Float32Array): Float32Array {
    if (isShared(a)) return a;
    return this.ahead ? toShared(a) : a.slice();
  }

  /** Samplers the song's tracks no longer play are let go after a grace, in every thread. */
  private pruneSamplers(graph: GraphSpec): void {
    this.usedSamplers = new Set<string>();
    for (const t of graph.tracks)
      for (const i of [t.instrument, ...t.articulations]) if (i.kind === 'sampler') this.usedSamplers.add(i.key);
    for (const key of this.samplers) {
      if (this.usedSamplers.has(key)) this.unused.delete(key);
      else this.markUnused(key);
    }
  }

  private markUnused(key: string): void {
    if (!this.unused.has(key)) this.unused.set(key, Date.now());
    this.scheduleForget();
  }

  private scheduleForget(): void {
    if (this.unusedTimer || !this.unused.size) return;
    const due = Math.min(...this.unused.values()) + FORGET_AFTER - Date.now();
    this.unusedTimer = setTimeout(
      () => {
        this.unusedTimer = null;
        this.forgetUnused();
      },
      Math.max(0, due),
    );
  }

  private forgetUnused(): void {
    const now = Date.now();
    const gone: string[] = [];
    for (const [key, since] of this.unused) {
      if (now - since < FORGET_AFTER) continue;
      this.unused.delete(key);
      if (!this.samplers.delete(key)) continue;
      this.kept.delete(key);
      this.post({ type: 'forgetSampler', key });
      gone.push(key);
    }
    if (gone.length) for (const fn of this.forgetListeners) fn(gone);
    this.scheduleForget();
  }

  /** Called with the sampler keys a restarted audio thread needs again. */
  onRestart(fn: (keys: string[]) => void): () => void {
    this.restartListeners.add(fn);
    return () => this.restartListeners.delete(fn);
  }

  /** Called with the sampler keys let go because no track plays them any more. */
  onForget(fn: (keys: string[]) => void): () => void {
    this.forgetListeners.add(fn);
    return () => this.forgetListeners.delete(fn);
  }

  hasSampler(key: string): boolean {
    return this.samplers.has(key);
  }

  /**
   * Transport commands are numbered. Until the audio thread reports it has taken in the latest (it
   * can be a moment behind, for instance while a song is first handed to it), the playhead is where
   * the page last put it, so a Play pressed meanwhile starts from the right place.
   */
  private cmd = 0;
  private told = { frame: 0, playing: false };

  private caughtUp(): boolean {
    return (this.transport[5] ?? 0) >= this.cmd;
  }

  /** Frames the mix's sound is behind the song (its plugins' look-ahead, compensated): what's heard is that far back. */
  private lookahead(): number {
    return this.caughtUp() && this.transport[1] === 1 ? (this.transport[6] ?? 0) : 0;
  }

  /**
   * The audio thread's load: the share of each block's time the engine takes (smoothed), its recent
   * peak, how many blocks have overrun their time, and whether its clock can time a single block
   * (if not, the average is all there is).
   */
  dsp(): {
    load: number;
    peak: number;
    overloads: number;
    fine: boolean;
    ahead: { loads: number[]; stalls: number } | null;
  } {
    const t = this.transport;
    const ahead = this.aheadNow();
    return {
      load: (t[TR_LOAD] as number | undefined) ?? 0,
      peak: (t[TR_LOAD_PEAK] as number | undefined) ?? 0,
      overloads: (t[TR_OVERLOADS] as number | undefined) ?? 0,
      fine: t[TR_FINE_CLOCK] === 1,
      // (HO[LO] Engine's last stats may be from before its pool started afresh: never below zero)
      ahead: ahead ? { loads: ahead.loads, stalls: Math.max(0, ahead.stalls - this.stallsSeen) } : null,
    };
  }

  /** The workers rendering ahead: the page's own, or HO[LO] Engine's (as it last said). */
  private aheadNow(): { loads: number[]; stalls: number } | null {
    if (this.ahead) return { loads: this.ahead.loads(), stalls: this.ahead.stalls() };
    return this.remote ? (companion.snapshot().stats?.ahead ?? null) : null;
  }

  resetLoad(): void {
    this.post({ type: 'resetLoad' });
    this.stallsSeen = this.aheadNow()?.stalls ?? 0;
  }
  private stallsSeen = 0;

  private songFrame(): number {
    return this.caughtUp() ? (this.transport[0] as number) - this.lookahead() : this.told.frame;
  }

  play(fromTick: number, record = false, countInBars = 0): void {
    // starting: the strips laid out afresh by how long each has been taking, if that helps a good deal
    // (a strip that moves builds what it plays with as it starts)
    if (this.ahead && !this.playing) for (const m of this.ahead.rebalance(1.25)) this.post(m);
    const frame = Math.round(tickToFrame(this.segments, fromTick));
    const bar = this.project ? meterTicks(this.project).barTicks : 3840;
    const countIn = countInBars > 0 ? Math.round(countInBars * bar * (this.segments[0]?.framesPerTick ?? 25)) : 0;
    this.post({ type: 'play', frame, record, countIn, cmd: ++this.cmd });
    this.told = { frame: frame - countIn, playing: true };
  }

  stop(): void {
    const frame = this.songFrame();
    this.post({ type: 'stop', cmd: ++this.cmd });
    this.told = { frame, playing: false };
  }

  locate(tick: number): void {
    if (!this.port) {
      // before the audio starts the playhead is kept in ticks (the tempo map needs the device's rate)
      this.idleTick = tick;
      return;
    }
    const frame = Math.round(tickToFrame(this.segments, tick));
    const playing = this.playing;
    this.post({ type: 'locate', frame, cmd: ++this.cmd });
    this.told = { frame, playing };
  }

  /** Whether this browser can choose the sound device (Chrome and Edge can). */
  get canChooseOutput(): boolean {
    return typeof AudioContext !== 'undefined' && 'setSinkId' in AudioContext.prototype;
  }

  /** Play through a particular sound device (a USB interface, wired headphones); '' is the default. */
  async setOutput(deviceId: string): Promise<void> {
    this.output = deviceId;
    // (HO[LO] Engine plays through the system's default device)
    const ctx = (this.remote ? null : this.ctx) as
      | (AudioContext & { setSinkId?: (id: string) => Promise<void> })
      | null;
    if (ctx?.setSinkId) await ctx.setSinkId(deviceId);
  }

  /** Logic's Low Latency Mode: plugins that would delay what you play (the limiter's look-ahead) don't. */
  setLowLatency(on: boolean): void {
    this.lowLatency = on;
    this.post({ type: 'lowLatency', on });
  }

  /**
   * The real round trip on this device: clicks out of the speakers, heard again by the microphone
   * (echo cancellation, noise suppression and automatic gain off). Resolves with the median in ms,
   * the input's own latency where the browser reports it, and how many clicks were heard.
   */
  async measureRoundTrip(seconds = 5): Promise<{ roundTrip: number | null; input: number | null; heard: number }> {
    const ctx = this.ctx;
    if (!ctx) throw new Error('Start the studio first');
    // HO[LO] Engine measures its own device, with the system's default microphone
    if (this.remote) return companion.measure(seconds);
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
    });
    const source = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'holo-loopback', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      outputChannelCount: [2],
    });
    const echoes: number[] = [];
    node.port.onmessage = (e: MessageEvent<{ type: string; frames: number }>) => {
      if (e.data.type === 'echo') echoes.push((e.data.frames / ctx.sampleRate) * 1000);
    };
    source.connect(node);
    node.connect(ctx.destination);
    await new Promise((r) => setTimeout(r, seconds * 1000));
    node.disconnect();
    source.disconnect();
    const settings = stream.getAudioTracks()[0]?.getSettings() as MediaTrackSettings & { latency?: number };
    for (const t of stream.getTracks()) t.stop();
    echoes.sort((a, b) => a - b);
    return {
      roundTrip: echoes.length ? (echoes[Math.floor(echoes.length / 2)] as number) : null,
      input: typeof settings?.latency === 'number' ? settings.latency * 1000 : null,
      heard: echoes.length,
    };
  }

  setMetronome(on: boolean, level = 0.6): void {
    this.post({ type: 'metronome', on, level });
  }

  panic(): void {
    this.post({ type: 'panic' });
  }

  get playing(): boolean {
    return this.caughtUp() ? this.transport[1] === 1 : this.told.playing;
  }

  /** The playhead in ticks (negative during a count-in). */
  positionTick(): number {
    if (!this.port) return this.idleTick;
    const frame = this.songFrame();
    if (frame < 0) return frame / (this.segments[0]?.framesPerTick ?? 25);
    return frameToTick(this.segments, frame);
  }

  /**
   * The song tick that was being heard at a performance.now() time: what a played note lines up
   * with. HO[LO] Engine says itself which of its frames was being heard (`frame`).
   */
  heardTick(performanceTime: number, frame?: number): number | null {
    const ctx = this.ctx;
    if (!ctx || !this.playing) return null;
    if (!this.caughtUp()) return frameToTick(this.segments, Math.max(0, this.told.frame));
    let heardFrame: number;
    if (this.remote) heardFrame = frame !== undefined && frame >= 0 ? frame : (this.transport[2] as number);
    else {
      const ts = ctx.getOutputTimestamp();
      const contextTime = ts.contextTime ?? ctx.currentTime;
      const perf = ts.performanceTime ?? performance.now();
      heardFrame = (contextTime + (performanceTime - perf) / 1000) * ctx.sampleRate;
    }
    let song = (this.transport[0] as number) - this.lookahead() + (heardFrame - (this.transport[2] as number));
    const c = this.project?.cycle;
    if (c?.on && c.end > c.start) {
      const s = tickToFrame(this.segments, c.start);
      const e = tickToFrame(this.segments, c.end);
      if (song >= e) song = s + ((song - s) % (e - s));
      if (song < s && (this.transport[0] as number) >= s && heardFrame < (this.transport[2] as number)) {
        // heard before the last jump back: it belongs at the cycle's end
        song = e - (s - song);
      }
    }
    if (song < 0) return song / (this.segments[0]?.framesPerTick ?? 25);
    return frameToTick(this.segments, song);
  }

  /** Live MIDI to a track, straight into the audio thread (shared memory when there is). */
  live(status: number, d1: number, d2: number, trackId: string): void {
    this.liveNum(status, d1, d2, this.numOf(trackId));
  }

  liveNum(status: number, d1: number, d2: number, num: number): void {
    const word = (status & 0xff) | ((d1 & 0x7f) << 8) | ((d2 & 0x7f) << 16);
    const ring = this.ring;
    if (ring) {
      const w = Atomics.load(ring, 0);
      const next = (w + 1) % RING_EVENTS;
      if (next === Atomics.load(ring, 1)) return; // full: the audio thread has stopped reading
      const i = RING_HEADER + w * EVENT_INTS;
      ring[i] = word;
      ring[i + 1] = num;
      Atomics.store(ring, 0, next);
      return;
    }
    this.liveFallback.push(status, d1, d2, num);
    if (!this.liveScheduled) {
      this.liveScheduled = true;
      queueMicrotask(() => {
        this.liveScheduled = false;
        this.post({ type: 'live', events: this.liveFallback });
        this.liveFallback = [];
      });
    }
  }

  /** Play a note on a track for a moment (clicking a key or drawing a note). */
  audition(trackId: string, pitch: number, velocity = 96, ms = 300): void {
    if (!this.started) return;
    const p = Math.max(0, Math.min(127, Math.round(pitch)));
    this.live(0x90, p, velocity, trackId);
    setTimeout(() => this.live(0x80, p, 0, trackId), ms);
  }

  /** Peak left, peak right (0..1+) and gain reduction (dB) of a track, bus or "master". */
  meter(id: string): [number, number, number] {
    const num = id === 'master' ? 0 : this.nums.get(id);
    if (num === undefined) return [0, 0, 0];
    const at = num * METER_FLOATS;
    return [this.meters[at] ?? 0, this.meters[at + 1] ?? 0, this.meters[at + 2] ?? 0];
  }

  /** A plugin window opened: meter that plugin's own gain reduction (not the whole channel's). */
  watchPlugin(target: string, plugin: string): void {
    const num = target === 'master' ? 0 : this.numOf(target);
    this.post({ type: 'watch', num, plugin });
  }

  /** The watched plugin's gain reduction on a channel, dB. */
  pluginGr(target: string): number {
    const num = target === 'master' ? 0 : this.nums.get(target);
    if (num === undefined) return 0;
    return this.meters[num * METER_FLOATS + 3] ?? 0;
  }

  latency(): LatencyInfo {
    const ctx = this.ctx;
    const remote = this.remote ? companion.device : null;
    if (remote)
      return {
        base: 0,
        output: (remote.buffer / remote.rate) * 1000,
        sampleRate: remote.rate,
        sharedMemory: false,
        companion: remote,
      };
    return {
      base: (ctx?.baseLatency ?? 0) * 1000,
      output: ((ctx as AudioContext & { outputLatency?: number })?.outputLatency ?? 0) * 1000,
      sampleRate: this.sampleRate,
      sharedMemory: this.ring !== null,
      companion: null,
    };
  }
}

/** What a planned part is planned from: its notes, its instrument, the song's tempo and shared settings. */
function partFrom(t: Track, project: Project): readonly unknown[] {
  return [t.instrument, t.regions, project.tempo, project.performance ?? null];
}

function partKey(t: Track, project: Project): string {
  return JSON.stringify(partFrom(t, project));
}

function isShared(a: ArrayBufferView): boolean {
  return typeof SharedArrayBuffer !== 'undefined' && a.buffer instanceof SharedArrayBuffer;
}

/** The buffers to transfer with a message: shared memory goes by reference and can't be. */
function transferable(arrays: ArrayBufferView[]): Transferable[] {
  const out: Transferable[] = [];
  for (const a of arrays) if (!isShared(a) && !out.includes(a.buffer as ArrayBuffer)) out.push(a.buffer as ArrayBuffer);
  return out;
}

/** A sequence in shared memory (toShared, for events): every engine reads the one copy instead of taking its own. */
function sharedEvents(events: Float64Array): Float64Array {
  if (isShared(events)) return events;
  const s = new Float64Array(new SharedArrayBuffer(events.byteLength));
  s.set(events);
  return s;
}

/** Before the next frame is drawn (a timer where there are no frames). */
function nextFrame(fn: () => void): number {
  if (typeof requestAnimationFrame === 'function') return requestAnimationFrame(fn);
  return setTimeout(fn, 16) as unknown as number;
}

/** A sequence without its notes (its controllers stay). */
function withoutNotes(events: Float64Array): Float64Array {
  const kept: number[] = [];
  for (let i = 0; i < events.length; i += EVENT_SIZE) {
    const kind = events[i + 1] as number;
    if (kind === EV_ON || kind === EV_OFF) continue;
    for (let j = 0; j < EVENT_SIZE; j++) kept.push(events[i + j] as number);
  }
  return new Float64Array(kept);
}

/** A Performance instrument's measurements at another rate (the decoder resamples its files to the context's). */
function atRate(perf: PerformanceManifest, sr: number): PerformanceManifest {
  const k = sr / 44100;
  if (k === 1) return perf;
  const at = (x: number | undefined) => (x === undefined ? undefined : Math.round(x * k));
  return {
    ...perf,
    rows: perf.rows.map((r) => ({
      ...r,
      start: at(r.start) as number,
      attack: at(r.attack) as number,
      frames: at(r.frames) as number,
      cleanEnd: at(r.cleanEnd),
      loopStart: at(r.loopStart),
      loopEnd: at(r.loopEnd),
    })),
  };
}

export const engine = new AudioEngine();
