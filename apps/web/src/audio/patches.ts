/**
 * Note edits heard as they're made. Each stretch of a recording a song's note edits change is a patch
 * (`@holo/engine`'s notes/plan.ts), keyed by what it sounds like; the studio renders each on a few
 * workers (patch.worker.ts) from the recording it's a part of, with the same function a bounce uses,
 * and hands it to the engines as it's ready. Until then the recording plays there as it was.
 *
 * - **What first.** The patches of the region the Audio Editor shows, then those the playhead comes to
 *   next, in the order it reaches them, then the rest. A patch no longer wanted (its note edited
 *   again) is dropped from the queue; one already rendering finishes, and is kept.
 * - **Kept.** Rendered patches are kept by the memory they take, the least lately used let go first,
 *   so an undo or a redo finds its sound at once; and those the song plays on the device too
 *   (patch-store.ts), read back before one is rendered again, so a song opened again plays its edits
 *   at once.
 * - **A note being dragged** (the Notes view, hearing it as it goes): the patches of the state the drag
 *   has got to come before anything else, one rendering at a time for each region and only the latest
 *   wanted after it, those passed over never rendered.
 * - **Recordings.** Each worker holds the recordings it renders from: the engines' own copy in shared
 *   memory (nothing is copied), else one worker holds a copy of each recording that has edits.
 */
import {
  clipKey,
  type PatchJob,
  type PatchSpec,
  regionPatches,
  songPatches,
  type TempoSegment,
  tickToFrame,
  toShared,
} from '@holo/engine';
import type { AudioClip, Project } from '@holo/session';

/** What a patch worker is told: a recording to hold or let go of, or a patch to render from one it holds. */
export type ToPatchWorker =
  | { type: 'recording'; key: string; channels: Float32Array[] }
  | { type: 'forget'; key: string }
  /** `shared`: its channels come back in shared memory (every engine reads that one copy). */
  | { type: 'render'; id: number; key: string; recording: string; sr: number; spec: PatchSpec; shared: boolean };

/** What it answers: the patch's channels and how long they took (ms), or why there are none. */
export type FromPatchWorker =
  | { id: number; key: string; channels: Float32Array[]; ms: number }
  | { id: number; key: string; error: string };

/** A worker as the renderer uses it: a Web Worker (a stand-in in tests). */
export interface PatchWorker {
  postMessage(msg: ToPatchWorker, transfer?: Transferable[]): void;
  onmessage: ((e: MessageEvent<FromPatchWorker>) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
  terminate(): void;
}

/** The recording a patch is rendered from (its key, as the engines have it). */
export const recordingOf = (job: PatchJob): string => clipKey(job.base);

// ---- what to render, and in what order ----

/** What the studio knows of the song's patches, besides the song. */
export interface PatchState {
  /** Whether a recording (by its clip key) is there to render from. */
  loaded: (key: string) => boolean;
  /** Whether a patch has been rendered (and is kept). */
  rendered: (key: string) => boolean;
  /** The patches the engines have. */
  sent: ReadonlySet<string>;
  /** The clip of the region the Audio Editor shows: its patches first. */
  focus?: AudioClip | null;
  /** The song frame the playhead is at (of the song as played). */
  playhead?: number;
}

export interface PatchPlan {
  /** Every patch the song plays, by key. */
  wanted: Map<string, PatchJob>;
  /** Those to render (their recording there, not rendered, not with the engines), first first. */
  render: PatchJob[];
  /** Rendered, and not yet with the engines: to hand over. */
  send: string[];
  /** With the engines, and no longer played: to let go of. */
  forget: string[];
}

/**
 * The song's patches (the song as played, its tempo compiled at the engines' rate): which to render,
 * first first, which to hand to the engines, and which the engines can let go of.
 */
export function planPatches(
  project: Project,
  segments: readonly TempoSegment[],
  sr: number,
  state: PatchState,
): PatchPlan {
  const jobs = songPatches(project, sr);
  const wanted = new Map(jobs.map((j) => [j.key, j]));
  const playhead = state.playhead ?? 0;
  // how far ahead of the playhead each first plays, in frames (Infinity: only behind it)
  const ahead = new Map<string, number>();
  for (const [key, { spans }] of patchSpans(project, segments, sr))
    for (const [from, to] of spans) {
      const d = to <= playhead ? Number.POSITIVE_INFINITY : Math.max(0, from - playhead);
      ahead.set(key, Math.min(ahead.get(key) ?? Number.POSITIVE_INFINITY, d));
    }
  const focus = new Set(state.focus ? regionPatches(state.focus, sr).map((j) => j.key) : []);
  const distance = (j: PatchJob) => ahead.get(j.key) ?? Number.POSITIVE_INFINITY;
  const rank = (j: PatchJob) => (focus.has(j.key) ? 0 : distance(j) < Number.POSITIVE_INFINITY ? 1 : 2);
  const render = jobs
    .filter((j) => !state.sent.has(j.key) && !state.rendered(j.key) && state.loaded(recordingOf(j)))
    // (a stable sort: the rest in the song's order)
    .sort((x, y) => rank(x) - rank(y) || order(distance(x), distance(y)));
  const send = jobs.filter((j) => !state.sent.has(j.key) && state.rendered(j.key)).map((j) => j.key);
  const forget = [...state.sent].filter((key) => !wanted.has(key));
  return { wanted, render, send, forget };
}

/**
 * Where each patch the song plays is heard: song frames from and to (the song's tempo compiled at the
 * engines' rate), once for each region playing it, by key.
 */
export function patchSpans(
  project: Project,
  segments: readonly TempoSegment[],
  sr: number,
): Map<string, { job: PatchJob; spans: [number, number][] }> {
  const wanted = new Set(songPatches(project, sr).map((j) => j.key));
  const out = new Map<string, { job: PatchJob; spans: [number, number][] }>();
  for (const t of project.tracks) {
    if (t.kind !== 'audio') continue;
    for (const r of t.regions) {
      const a = r.audio;
      if (!a?.notes || r.muted) continue;
      const start = tickToFrame(segments, r.start);
      const end = tickToFrame(segments, r.start + r.length);
      const source = a.offset * a.stretch * sr;
      for (const job of regionPatches(a, sr)) {
        if (!wanted.has(job.key)) continue;
        const from = Math.max(start, start + job.spec.a - source);
        const to = Math.min(end, start + job.spec.b - source);
        if (to <= from) continue;
        const at = out.get(job.key);
        if (at) at.spans.push([from, to]);
        else out.set(job.key, { job, spans: [[from, to]] });
      }
    }
  }
  return out;
}

/** The patches a song plays between two of its frames (to hear those bars as they're edited). */
export function patchesWithin(
  project: Project,
  segments: readonly TempoSegment[],
  sr: number,
  from: number,
  to: number,
): PatchJob[] {
  const out: PatchJob[] = [];
  for (const { job, spans } of patchSpans(project, segments, sr).values())
    if (spans.some(([a, b]) => b > from && a < to)) out.push(job);
  return out;
}

/** Nearer first, those only behind the playhead (Infinity) last, in the order they came. */
const order = (a: number, b: number) => (a === b ? 0 : a < b ? -1 : 1);

// ---- rendered patches, kept ----

const bytesOf = (channels: readonly Float32Array[]) => channels.reduce((n, c) => n + c.byteLength, 0);

/** Rendered patches, kept by the memory they take: past `budget` bytes, the least lately used go first. */
export class PatchCache {
  /** (in the order they were last used: the first is the least lately) */
  private readonly kept = new Map<string, Float32Array[]>();
  bytes = 0;
  constructor(readonly budget: number) {}

  get size(): number {
    return this.kept.size;
  }

  has(key: string): boolean {
    return this.kept.has(key);
  }

  /** A patch's channels, as they are (its place among the least lately used unchanged). */
  peek(key: string): Float32Array[] | undefined {
    return this.kept.get(key);
  }

  /** A patch's channels (it's used: the last to go). */
  get(key: string): Float32Array[] | undefined {
    const c = this.kept.get(key);
    if (c) {
      this.kept.delete(key);
      this.kept.set(key, c);
    }
    return c;
  }

  set(key: string, channels: Float32Array[]): void {
    const was = this.kept.get(key);
    if (was) {
      this.bytes -= bytesOf(was);
      this.kept.delete(key);
    }
    this.kept.set(key, channels);
    this.bytes += bytesOf(channels);
    // (the newest stays, whatever it takes)
    for (const [k, c] of this.kept) {
      if (this.bytes <= this.budget || k === key) break;
      this.kept.delete(k);
      this.bytes -= bytesOf(c);
    }
  }

  clear(): void {
    this.kept.clear();
    this.bytes = 0;
  }
}

// ---- rendering them ----

/** What the renderer asks of the patches kept on the device (patch-store.ts). */
export interface PatchStoreLike {
  /** Whether it has opened: until then nothing is rendered, in case it has it. */
  readonly loaded: boolean;
  readonly ready: Promise<void>;
  has(key: string): boolean;
  get(key: string): Promise<Float32Array[] | null>;
  put(key: string, channels: readonly Float32Array[]): void;
}

export interface PatchRendererOptions {
  /** How many workers render at once (one without shared memory: it holds the recordings' only copies). */
  workers: number;
  /** Bytes of rendered patches kept. */
  budget: number;
  /** Whether the recordings given are in shared memory (every worker reads the one copy), and patches come back there. */
  shared: boolean;
  make: () => PatchWorker;
  /** Patches kept on the device: read back before one is rendered, and each rendered one kept there. */
  store?: PatchStoreLike | null;
}

/** Patches rendered on a few workers, the most wanted first, and kept (planPatches says what's wanted). */
export class PatchRenderer {
  readonly cache: PatchCache;
  private readonly opts: PatchRendererOptions;
  private workers: { worker: PatchWorker; job: { id: number; key: string } | null }[] = [];
  /** The recordings the workers hold, by key. */
  private readonly recordings = new Set<string>();
  private queue: PatchJob[] = [];
  /** Patches a worker is rendering, by key. */
  private readonly running = new Set<string>();
  /** Patches that couldn't be rendered (not tried again). */
  private readonly failed = new Set<string>();
  private wanted = new Set<string>();
  private nextId = 0;
  private readonly listeners = new Set<(key: string) => void>();
  private readonly errorListeners = new Set<(message: string) => void>();
  /** How long the last patches took to render, ms (the newest last). */
  readonly times: number[] = [];
  /** Patches rendered, read back from the device, and rendered for a drag (of those rendered). */
  readonly stats = { rendered: 0, fromDevice: 0, previews: 0 };
  /**
   * A note being dragged, by region (or whatever groups them): the patches the latest state it has
   * got to wants, not yet begun, and the one being rendered for it.
   */
  private readonly previews = new Map<string, PatchJob[]>();
  private readonly previewing = new Map<string, string>();
  /** Patches about to be played besides the song's own (a version an A/B plays), by what asks for them. */
  private readonly readied = new Map<string, PatchJob[]>();
  private waitingStore = false;
  /** Patches the device has (read from it, or given to it). */
  private readonly onDevice = new Set<string>();

  constructor(opts: PatchRendererOptions) {
    this.opts = opts;
    this.cache = new PatchCache(opts.budget);
  }

  /** Each patch as it's rendered. */
  onRendered(fn: (key: string) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  onError(fn: (message: string) => void): () => void {
    this.errorListeners.add(fn);
    return () => this.errorListeners.delete(fn);
  }

  /** Whether the workers hold a recording. */
  holds(key: string): boolean {
    return this.recordings.has(key);
  }

  /** The recordings the workers hold. */
  held(): string[] {
    return [...this.recordings];
  }

  /**
   * A recording for the workers to render from (at the engines' rate, stretched as its regions play
   * it). Shared, every worker reads it; else it's handed to the one worker whole (the caller's copy).
   */
  hold(key: string, channels: Float32Array[]): void {
    this.start();
    this.recordings.add(key);
    for (const w of this.workers) {
      const transfer = this.opts.shared ? [] : channels.map((c) => c.buffer as ArrayBuffer);
      w.worker.postMessage({ type: 'recording', key, channels }, transfer);
    }
    this.pump();
  }

  /** A recording no patch is wanted from any more: the workers let it go. */
  release(key: string): void {
    if (!this.recordings.delete(key)) return;
    for (const w of this.workers) w.worker.postMessage({ type: 'forget', key });
    this.queue = this.queue.filter((j) => recordingOf(j) !== key);
  }

  /** The patches to render, first first: the queue becomes these (less those rendered or rendering). */
  want(jobs: readonly PatchJob[]): void {
    this.wanted = new Set(jobs.map((j) => j.key));
    this.queue = jobs.filter(
      (j) =>
        !this.cache.has(j.key) && !this.running.has(j.key) && !this.failed.has(j.key) && this.holds(recordingOf(j)),
    );
    this.pump();
  }

  /**
   * A note being dragged (`group`: its region): the patches of the state it has got to, rendered before
   * anything else. One renders at a time for each group, and only the latest wanted after it: those it
   * replaces, not yet begun, never are (one rendering finishes, and is kept). None: the drag is over.
   */
  preview(group: string, jobs: readonly PatchJob[]): void {
    const todo = jobs.filter((j) => !this.cache.has(j.key) && !this.failed.has(j.key) && this.holds(recordingOf(j)));
    if (todo.length) this.previews.set(group, todo);
    else this.previews.delete(group);
    this.pump();
  }

  /**
   * Patches about to be played that aren't the song's own (`group`: what asks for them, a version an
   * A/B is about to play): rendered after a drag's and before the song's, and not let go when the
   * song's patches change. None (or null): no longer wanted.
   */
  ready(group: string, jobs: readonly PatchJob[] | null): void {
    const todo = (jobs ?? []).filter(
      (j) => !this.cache.has(j.key) && !this.failed.has(j.key) && this.holds(recordingOf(j)),
    );
    if (todo.length) this.readied.set(group, todo);
    else this.readied.delete(group);
    this.pump();
  }

  /** Whether a patch is as done as it will be: rendered, or not to be had. */
  over(key: string): boolean {
    return this.cache.has(key) || this.failed.has(key);
  }

  /**
   * The patches the song plays (`keys`): those rendered and not yet on the device are kept there, a
   * drag's once the song plays where it landed (the states it passed through aren't kept).
   */
  keep(keys: Iterable<string>): void {
    const store = this.opts.store;
    if (!store) return;
    for (const key of keys) {
      if (this.onDevice.has(key)) continue;
      const channels = this.cache.peek(key);
      if (!channels) continue;
      this.onDevice.add(key);
      store.put(key, channels);
    }
  }

  /** How many of the patches wanted are still to come (queued or rendering). */
  get pending(): number {
    let n = 0;
    for (const key of this.wanted) if (!this.cache.has(key) && !this.failed.has(key)) n++;
    return n;
  }

  has(key: string): boolean {
    return this.cache.has(key);
  }

  get(key: string): Float32Array[] | undefined {
    return this.cache.get(key);
  }

  /** Every recording let go of and nothing queued (a new audio thread, perhaps at another rate); what's rendered is kept. */
  releaseAll(): void {
    for (const key of [...this.recordings]) this.release(key);
    this.queue = [];
    this.wanted.clear();
    this.previews.clear();
  }

  close(): void {
    for (const w of this.workers) w.worker.terminate();
    this.workers = [];
    this.recordings.clear();
    this.running.clear();
    this.queue = [];
    this.wanted.clear();
    this.previews.clear();
    this.previewing.clear();
  }

  /** The workers, started the first time a recording is given. */
  private start(): void {
    if (this.workers.length) return;
    const count = this.opts.shared ? Math.max(1, this.opts.workers) : 1;
    for (let i = 0; i < count; i++) {
      const worker = this.opts.make();
      const slot: (typeof this.workers)[number] = { worker, job: null };
      worker.onmessage = (e) => this.done(slot, e.data);
      worker.onerror = (e) => {
        // a worker that dies fails what it had, and leaves the pool
        e.preventDefault?.();
        if (slot.job) this.done(slot, { id: slot.job.id, key: slot.job.key, error: e.message || 'Rendering stopped' });
        worker.terminate();
        this.workers = this.workers.filter((w) => w !== slot);
      };
      this.workers.push(slot);
    }
  }

  /**
   * What's wanted, under way: those the device keeps read back (no worker needed), then each free worker
   * given a dragged note's patch if one is waiting, else the most wanted of the rest. Nothing is
   * rendered before the device's store has opened.
   */
  private pump(): void {
    const store = this.opts.store;
    if (store && !store.loaded) {
      if (!this.waitingStore) {
        this.waitingStore = true;
        void store.ready.then(() => {
          this.waitingStore = false;
          this.pump();
        });
      }
      return;
    }
    if (store) {
      for (const jobs of [...this.previews.values(), ...this.readied.values()])
        for (const j of jobs) if (store.has(j.key) && !this.running.has(j.key)) this.read(j, store);
      this.queue = this.queue.filter((j) => {
        if (!store.has(j.key)) return true;
        if (!this.running.has(j.key)) this.read(j, store);
        return false;
      });
    }
    for (const w of this.workers) {
      if (w.job) continue;
      const preview = this.takePreview();
      const job = preview ?? this.takeReadied() ?? this.takeQueued();
      if (!job) return;
      const id = ++this.nextId;
      w.job = { id, key: job.key };
      this.running.add(job.key);
      if (preview) this.stats.previews++;
      w.worker.postMessage({
        type: 'render',
        id,
        key: job.key,
        recording: recordingOf(job),
        sr: job.spec.sr,
        spec: job.spec,
        shared: this.opts.shared,
      });
    }
  }

  /** Whether a patch needs nothing doing (rendered, rendering, or not to be had). */
  private settled(key: string): boolean {
    return this.cache.has(key) || this.running.has(key) || this.failed.has(key);
  }

  /** A dragged note's patch to render next: of a group with none rendering, its first still to come. */
  private takePreview(): PatchJob | null {
    for (const [group, jobs] of this.previews) {
      const flying = this.previewing.get(group);
      if (flying && this.running.has(flying)) continue;
      // (one rendering already, for the song or another group, is this group's under way)
      const under = jobs.find((j) => this.running.has(j.key));
      if (under) {
        this.previewing.set(group, under.key);
        continue;
      }
      let job = jobs.shift();
      while (job && this.settled(job.key)) job = jobs.shift();
      if (!jobs.length) this.previews.delete(group);
      if (!job) continue;
      this.previewing.set(group, job.key);
      return job;
    }
    return null;
  }

  /** A patch about to be played to render next, of the first group with one still to come. */
  private takeReadied(): PatchJob | null {
    for (const [group, jobs] of this.readied) {
      let job = jobs.shift();
      while (job && this.settled(job.key)) job = jobs.shift();
      if (!jobs.length) this.readied.delete(group);
      if (job) return job;
    }
    return null;
  }

  private takeQueued(): PatchJob | null {
    let job = this.queue.shift();
    while (job && this.settled(job.key)) job = this.queue.shift();
    return job ?? null;
  }

  /** A patch the device keeps, read back (rendered after all if it can't be). */
  private read(job: PatchJob, store: PatchStoreLike): void {
    this.running.add(job.key);
    void store.get(job.key).then((channels) => {
      this.running.delete(job.key);
      if (channels) {
        this.cache.set(job.key, this.opts.shared ? channels.map((c) => toShared(c)) : channels);
        this.onDevice.add(job.key);
        this.stats.fromDevice++;
        this.dropPreviewing(job.key);
        for (const fn of this.listeners) fn(job.key);
      } else if (this.wanted.has(job.key) && this.holds(recordingOf(job))) this.queue.unshift(job);
      else this.dropPreviewing(job.key);
      this.pump();
    });
  }

  private dropPreviewing(key: string): void {
    for (const [group, k] of this.previewing) if (k === key) this.previewing.delete(group);
  }

  private done(slot: (typeof this.workers)[number], reply: FromPatchWorker): void {
    if (slot.job?.id !== reply.id) return;
    slot.job = null;
    this.running.delete(reply.key);
    this.dropPreviewing(reply.key);
    if ('error' in reply) {
      this.failed.add(reply.key);
      for (const fn of this.errorListeners) fn(`A note edit couldn’t be rendered: ${reply.error}`);
    } else {
      this.cache.set(reply.key, reply.channels);
      this.stats.rendered++;
      this.times.push(reply.ms);
      if (this.times.length > 32) this.times.shift();
      // (kept on the device when the song plays it; a drag's, once it lands there: keep)
      if (this.wanted.has(reply.key)) this.keep([reply.key]);
      for (const fn of this.listeners) fn(reply.key);
    }
    this.pump();
  }
}
