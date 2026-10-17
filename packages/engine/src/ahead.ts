/**
 * Rendering ahead: a song too big for one audio thread is played by worker threads on the other
 * cores, a little ahead of the playhead, and handed to the audio thread through shared memory.
 *
 * Every engine (each worker's, and the audio thread's) holds the whole song and takes in the same
 * messages before the same block, so they agree on everything, block by block. Each plays its share
 * of the mixer's strips (tracks and buses) and hands what leaves them to whoever plays where it goes,
 * in a ring of blocks: the first worker (the leader) opens each block, saying how many messages come
 * before it; the others follow; the audio thread plays a block once every worker has finished it.
 * What reaches a strip from elsewhere is added in the engine's own order with the sender's own gains,
 * so the mix is the same numbers as one engine playing it all (a bounce).
 *
 * The audio thread plays the master, and every live note: each strip has a twin there that plays
 * only what comes in live (keys, the AI's notes, an input), and sleeps while nothing does. So the
 * song plays a little ahead of the playhead (the lead, below), and what you play doesn't.
 */
import type { PreparedImpulse } from './convolver.ts';
import type { EngineCore } from './core.ts';
import { type PartPlans, partVoices } from './parts.ts';
import {
  type AheadSpec,
  EV_OFF,
  EV_ON,
  EVENT_SIZE,
  type GraphSpec,
  type InstrumentSpec,
  METER_CHANNELS,
  METER_FLOATS,
  type ToWorklet,
} from './protocol.ts';

export const AHEAD_BLOCK = 128;
/** Workers at most. */
export const AHEAD_MAX_WORKERS = 8;
/**
 * Blocks in the ring by default (128 ms at 48 kHz). The workers play as far ahead as the lead, which
 * starts at AHEAD_LEAD (85 ms) and goes deeper each time they leave the audio thread waiting (and
 * back again after a quiet half minute): a song's changes, a stop or a jump are heard that much later.
 */
export const AHEAD_SLOTS = 48;
export const AHEAD_LEAD = 32;
/** Blocks the leader opens at a time once it's as far ahead as the lead. */
const LEADER_BATCH = 4;
/** Blocks ready before a song starts from a stop (the workers have just begun it). */
const PREROLL = 12;

// the control memory (Int32): counters, then each block's message count, then (Float32) loads and costs
const C_CONSUMED = 0;
const C_LEADER = 1;
const C_STALLS = 2;
const C_SLOTS = 3;
const C_LEAD = 4;
const C_DONE = 8;
const C_PROGRESS = C_DONE + AHEAD_MAX_WORKERS;
const C_HEADERS = C_PROGRESS + METER_CHANNELS;

const METERS = METER_CHANNELS * METER_FLOATS;
const SIGNAL = AHEAD_BLOCK * 2;

/** The counters and loads: allocated once, for as long as the workers run. */
export function aheadControl(slots = AHEAD_SLOTS): SharedArrayBuffer {
  const sab = new SharedArrayBuffer((C_HEADERS + slots + AHEAD_MAX_WORKERS + METER_CHANNELS) * 4);
  const ctl = new Int32Array(sab);
  ctl[C_SLOTS] = slots;
  ctl[C_LEAD] = Math.min(slots, AHEAD_LEAD);
  return sab;
}

/** Bytes a block takes in the ring: every strip's meters, then each connection's two channels, then its gains. */
const slotBytes = (edges: number) => METERS * 4 + edges * SIGNAL * 4 + edges * AHEAD_BLOCK * 8;

/** The ring's sound, with room for `edges` connections between engines. */
export function aheadData(edges: number, slots = AHEAD_SLOTS): SharedArrayBuffer {
  return new SharedArrayBuffer(slots * slotBytes(edges));
}

/** Room for at least this many connections, with some to spare (the data is replaced when it fills). */
export function aheadRoom(edges: number): number {
  let n = 64;
  while (n < edges * 1.5) n *= 2;
  return n;
}

/** One engine's view of the shared memory. */
export class AheadLink {
  readonly ctl: Int32Array;
  private readonly flt: Float32Array;
  readonly slots: number;
  f32: Float32Array = new Float32Array(0);
  f64: Float64Array = new Float64Array(0);
  edges = 0;
  private stride = 0;
  private readonly loadAt: number;
  private readonly costAt: number;

  constructor(control: SharedArrayBuffer, data: SharedArrayBuffer, edges: number) {
    this.ctl = new Int32Array(control);
    this.flt = new Float32Array(control);
    this.slots = this.ctl[C_SLOTS] as number;
    this.loadAt = C_HEADERS + this.slots;
    this.costAt = this.loadAt + AHEAD_MAX_WORKERS;
    this.setData(data, edges);
  }

  setData(data: SharedArrayBuffer, edges: number): void {
    this.f32 = new Float32Array(data);
    this.f64 = new Float64Array(data);
    this.edges = edges;
    this.stride = slotBytes(edges);
  }

  /** Where block k's meters start (in f32). */
  meterAt(k: number): number {
    return ((k % this.slots) * this.stride) / 4;
  }
  /** Where connection e's left channel starts in block k (in f32; the right follows a block later). */
  signalAt(k: number, e: number): number {
    return ((k % this.slots) * this.stride + METERS * 4 + e * SIGNAL * 4) / 4;
  }
  /** Where connection e's gains start in block k (in f64). */
  gainAt(k: number, e: number): number {
    return ((k % this.slots) * this.stride + METERS * 4 + this.edges * SIGNAL * 4 + e * AHEAD_BLOCK * 8) / 8;
  }

  /** Blocks the audio thread has played. */
  consumed(): number {
    return Atomics.load(this.ctl, C_CONSUMED);
  }
  setConsumed(v: number): void {
    Atomics.store(this.ctl, C_CONSUMED, v);
    Atomics.notify(this.ctl, C_CONSUMED);
  }
  /** How far ahead the leader may go (blocks). */
  lead(): number {
    return Atomics.load(this.ctl, C_LEAD);
  }
  setLead(blocks: number): void {
    Atomics.store(this.ctl, C_LEAD, Math.max(LEADER_BATCH * 2, Math.min(this.slots, blocks)));
  }
  /** Blocks the leader has opened. */
  leader(): number {
    return Atomics.load(this.ctl, C_LEADER);
  }
  /** Open block k: it plays after `messages` messages. */
  open(k: number, messages: number): void {
    this.ctl[C_HEADERS + (k % this.slots)] = messages;
    Atomics.store(this.ctl, C_LEADER, k + 1);
    Atomics.notify(this.ctl, C_LEADER);
  }
  /** The messages taken in before block k (once it's open). */
  messages(k: number): number {
    return Atomics.load(this.ctl, C_HEADERS + (k % this.slots));
  }
  done(worker: number): number {
    return Atomics.load(this.ctl, C_DONE + worker);
  }
  finish(worker: number, blocks: number): void {
    Atomics.store(this.ctl, C_DONE + worker, blocks);
    Atomics.notify(this.ctl, C_DONE + worker);
  }
  /** Block k is open and every worker has finished it. */
  ready(k: number, workers: number): boolean {
    if (this.leader() <= k) return false;
    for (let j = 0; j < workers; j++) if (this.done(j) <= k) return false;
    return true;
  }
  /** Blocks a strip's sound is out for. */
  progress(num: number): number {
    return Atomics.load(this.ctl, C_PROGRESS + num);
  }
  publish(num: number, blocks: number): void {
    Atomics.store(this.ctl, C_PROGRESS + num, blocks);
    Atomics.notify(this.ctl, C_PROGRESS + num);
  }
  /** Wait (a worker only: it blocks) until a strip's sound is out for `blocks` blocks. */
  await(num: number, blocks: number): void {
    for (;;) {
      const v = Atomics.load(this.ctl, C_PROGRESS + num);
      if (v >= blocks) return;
      Atomics.wait(this.ctl, C_PROGRESS + num, v, 100);
    }
  }
  stall(): void {
    Atomics.add(this.ctl, C_STALLS, 1);
  }
  /** Blocks the audio thread had to play silence for, waiting. */
  stalls(): number {
    return Atomics.load(this.ctl, C_STALLS);
  }
  load(worker: number): number {
    return this.flt[this.loadAt + worker] as number;
  }
  setLoad(worker: number, v: number): void {
    this.flt[this.loadAt + worker] = v;
  }
  /** A strip's share of a block's time where it's played (smoothed). */
  cost(num: number): number {
    return this.flt[this.costAt + num] as number;
  }
  setCost(num: number, v: number): void {
    this.flt[this.costAt + num] = v;
  }
}

// ---- the plan: who plays what, and what goes between them ----

/** A connection out of a strip: its output, a send, or a stage seat's send (as the mixer routes them). */
export interface AheadEdge {
  /** Strips by their place in the mix: the tracks, the buses in mix order, the master last. */
  from: number;
  to: number;
  kind: 0 | 1 | 2;
  /** Which send, or which seat's send. */
  index: number;
  /** Where it goes in the ring (when it goes from one engine to another), else -1. */
  slot: number;
}

export interface AheadPlan {
  /** Each strip's player, by place in the mix: a worker, or -1 for the audio thread. */
  owners: number[];
  /** Each strip's connections, by place in the mix. */
  edges: AheadEdge[][];
  /** Connections handed from one engine to another. */
  handed: number;
}

/** A strip's connections in the order the mixer adds them: its output, its sends, its seats' sends. */
function connections(
  graph: GraphSpec,
  i: number,
  busAt: Map<string, number>,
): { to: number; kind: 0 | 1 | 2; index: number }[] {
  const tracks = graph.tracks.length;
  const master = tracks + graph.buses.length;
  const spec = i < tracks ? graph.tracks[i] : graph.buses[i - tracks];
  if (!spec) return [];
  const out: { to: number; kind: 0 | 1 | 2; index: number }[] = [];
  const dest = !spec.output || spec.output === 'master' ? master : (busAt.get(spec.output) ?? master);
  if (dest !== i) out.push({ to: dest, kind: 0, index: 0 });
  spec.sends.forEach((s, index) => {
    const to = busAt.get(s.bus);
    if (to !== undefined && to !== i) out.push({ to, kind: 1, index });
  });
  if (spec.stage) {
    const buses = [...new Set([...spec.stage.near.sends, ...spec.stage.far.sends].map((s) => s.bus))];
    buses.forEach((bus, index) => {
      const to = busAt.get(bus);
      if (to !== undefined && to !== i) out.push({ to, kind: 2, index });
    });
  }
  return out;
}

/**
 * Who plays each strip and which connections cross between engines, from the owners the page chose
 * (by channel number). Whatever a strip the audio thread plays feeds is played there too (sound
 * can't go back to a worker in time).
 */
export function aheadPlan(graph: GraphSpec, owners: readonly number[]): AheadPlan {
  const tracks = graph.tracks.length;
  const strips = [...graph.tracks, ...graph.buses];
  const busAt = new Map(graph.buses.map((b, i) => [b.id, tracks + i]));
  const own = strips.map((s) => owners[s.num] ?? -1);
  own.push(-1);
  const edges = strips.map((_, i) => connections(graph, i, busAt).map((c) => ({ ...c, from: i, slot: -1 })));
  edges.push([]);
  for (let i = 0; i < strips.length; i++) {
    if (own[i] !== -1) continue;
    for (const e of edges[i] as AheadEdge[]) if (e.to > i) own[e.to] = -1;
  }
  let handed = 0;
  for (let i = 0; i < strips.length; i++) {
    for (const e of edges[i] as AheadEdge[]) {
      if (e.to > i && (own[i] as number) >= 0 && own[e.to] !== own[i]) e.slot = handed++;
    }
  }
  return { owners: own, edges, handed };
}

/**
 * A guess at a strip's share of a block before it has been timed (from timings on a 2014 server
 * core at 48 kHz): its plugins (the spaces' convolution above all) and its instrument, or for a
 * planned part what its plans ask for (aheadPartGuess).
 */
export function aheadGuess(spec: GraphSpec['tracks'][number] | GraphSpec['buses'][number], part?: number): number {
  let c = 0.003;
  for (const p of spec.inserts) {
    if (p.bypass) continue;
    c += p.type === 'shimmer' ? 0.5 : p.type === 'space' ? 0.13 : p.type === 'reverb' ? 0.04 : 0.005;
  }
  if ('instrument' in spec) {
    if (part !== undefined) c += part;
    else if (spec.instrument.kind === 'synth') c += 0.06;
    else if (spec.instrument.kind !== 'none') c += 0.03;
  }
  return c;
}

/**
 * A planned part's share of a block, from its plans and the song's length (frames): its voices
 * sounding together for a good part of the song (partVoices), a Performance sampler's (resampled
 * through long interpolators) far dearer than Glass's.
 */
export function aheadPartGuess(plans: PartPlans, length: number): number {
  return 0.003 + (plans.kind === 'performance' ? 0.027 : 0.002) * partVoices(plans, length);
}

/**
 * A sequenced track's instrument's share of a block, from its notes (a track's compiled events) and
 * the song's length (frames): the notes it holds together for a good part of the song (each with a
 * little release), a synth's voices dearer than a sampler's.
 */
export function aheadTrackGuess(events: Float64Array, instrument: InstrumentSpec, length: number, sr: number): number {
  const each = instrument.kind === 'synth' ? 0.025 : instrument.kind === 'none' ? 0 : 0.012;
  if (!each) return 0;
  const release = Math.round(0.3 * sr);
  const edges: [number, number][] = [];
  const held = new Map<number, number>();
  for (let i = 0; i < events.length; i += EVENT_SIZE) {
    const frame = events[i] as number;
    const kind = events[i + 1] as number;
    const key = (events[i + 2] as number) + 128 * (events[i + 4] as number);
    if (kind === EV_ON) held.set(key, frame);
    else if (kind === EV_OFF && held.has(key)) {
      edges.push([held.get(key) as number, 1], [frame + release, -1]);
      held.delete(key);
    }
  }
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const time = new Map<number, number>();
  let count = 0;
  let last = 0;
  for (const [at, d] of edges) {
    if (count > 0 && at > last) time.set(count, (time.get(count) ?? 0) + (at - last));
    count += d;
    last = at;
  }
  let left = Math.max(1, length) * 0.25;
  for (const c of [...time.keys()].sort((a, b) => b - a)) {
    left -= time.get(c) as number;
    if (left <= 0) return 0.003 + each * c;
  }
  return 0.003;
}

/**
 * Owners for the workers, so the busiest has as little as can be, and a worker only ever waits on
 * the ones before it (whatever a strip feeds is played by its own worker or a later one). Strips are
 * placed from where the sound ends up back to where it starts: each bus on the latest worker with
 * room for it (no later than whatever it feeds), then the tracks, heaviest first, likewise. `cost` is
 * a strip's share of a block.
 */
export function aheadOwners(graph: GraphSpec, workers: number, cost: (num: number) => number): number[] {
  const tracks = graph.tracks.length;
  const strips = [...graph.tracks, ...graph.buses];
  const busAt = new Map(graph.buses.map((b, i) => [b.id, tracks + i]));
  const feeds = strips.map((_, i) =>
    connections(graph, i, busAt)
      .map((c) => c.to)
      .filter((to) => to > i && to < strips.length),
  );
  const costs = strips.map((s) => Math.max(1e-4, cost(s.num)));
  const order = [
    ...graph.buses.map((_, i) => tracks + i).reverse(),
    ...graph.tracks.map((_, i) => i).sort((a, b) => (costs[b] as number) - (costs[a] as number) || a - b),
  ];
  const owners: number[] = [];
  const max = Math.max(0, ...strips.map((s) => s.num));
  for (let n = 0; n <= max; n++) owners.push(-1);
  if (!strips.length || workers < 1) return owners;
  /**
   * Pack with each worker holding at most `cap`: the workers by place, the busiest's load and how
   * unevenly the rest is spread (the sum of the loads' squares), or null when it doesn't fit.
   */
  const pack = (cap: number): { at: number[]; busiest: number; spread: number } | null => {
    const load = new Array<number>(workers).fill(0);
    const at = strips.map(() => workers - 1);
    for (const i of order) {
      let hi = workers - 1;
      for (const to of feeds[i] as number[]) hi = Math.min(hi, at[to] as number);
      const c = costs[i] as number;
      let w = hi;
      while (w >= 0 && (load[w] as number) + c > cap) w--;
      if (w < 0) return null;
      load[w] = (load[w] as number) + c;
      at[i] = w;
    }
    return { at, busiest: Math.max(...load), spread: load.reduce((a, x) => a + x * x, 0) };
  };
  // (a greedy packing isn't sure to fit at a cap because it fits at a lower one: try a range, keep the
  // one whose busiest worker is lightest, and of those as good, the most even)
  const lo = Math.max(...costs);
  const total = costs.reduce((a, b) => a + b, 0);
  let best = pack(total) as { at: number[]; busiest: number; spread: number };
  for (let step = 0; step < 96; step++) {
    const tried = pack(lo + ((total - lo) * step) / 96);
    if (!tried) continue;
    const near = Math.abs(tried.busiest - best.busiest) < 0.02;
    if ((near && tried.spread < best.spread) || (!near && tried.busiest < best.busiest)) best = tried;
  }
  const at = best.at;
  strips.forEach((s, i) => {
    owners[s.num] = at[i] as number;
  });
  return owners;
}

// ---- the pool: who plays what, as the song changes and as it's timed ----

/**
 * Workers to render ahead with on a computer with this many cores: the cores but two (the audio
 * thread's, and the page's or the companion's own), at most six.
 */
export function aheadWorkersFor(cores: number): number {
  return Math.max(0, Math.min(6, cores - 2));
}

/** A copy in shared memory (so every thread reads the same samples, and none holds its own). */
export function toShared(a: Float32Array): Float32Array {
  if (a.buffer instanceof SharedArrayBuffer) return a;
  const s = new Float32Array(new SharedArrayBuffer(a.byteLength));
  s.set(a);
  return s;
}

export function sharedImpulse(p: PreparedImpulse): PreparedImpulse {
  const opt = (a: Float32Array | null) => (a ? toShared(a) : null);
  return {
    ...p,
    head: p.head ? { ll: toShared(p.head.ll), rr: toShared(p.head.rr), lr: opt(p.head.lr), rl: opt(p.head.rl) } : null,
    segments: p.segments.map((s) => ({ ...s, ll: toShared(s.ll), rr: toShared(s.rr), lr: opt(s.lr), rl: opt(s.rl) })),
  };
}

/** A message with its samples, audio and halls in shared memory: the same for every engine, copied once. */
export function aheadShared(msg: ToWorklet): ToWorklet {
  switch (msg.type) {
    case 'sampler':
      return {
        ...msg,
        spec: {
          ...msg.spec,
          zones: msg.spec.zones.map((z) => ({
            ...z,
            left: toShared(z.left),
            right: z.right ? toShared(z.right) : null,
          })),
        },
      };
    case 'performance':
      return {
        ...msg,
        samples: msg.samples.map((x) => {
          const left = toShared(x.left);
          return { ...x, left, right: x.right === x.left ? left : toShared(x.right) };
        }),
      };
    case 'audio':
      return { ...msg, channels: msg.channels.map(toShared) };
    case 'impulse':
      return { ...msg, data: sharedImpulse(msg.data) };
    default:
      return msg;
  }
}

/** A worker as the pool sees it, wherever it runs (a page's Web Worker, a Node thread). */
export interface AheadThread {
  /** A message, in the order the audio thread gets it. */
  post(msg: ToWorklet): void;
  close(): void;
}

/** What the owners are laid out for: the strips and where each one's sound goes. */
function shapeOf(graph: GraphSpec): string {
  const strip = (s: GraphSpec['buses'][number]) => [
    s.num,
    s.output,
    s.sends.map((x) => x.bus),
    s.stage ? [...s.stage.near.sends, ...s.stage.far.sends].map((x) => x.bus) : [],
  ];
  return JSON.stringify([graph.tracks.map(strip), graph.buses.map(strip)]);
}

/**
 * The workers, the shared memory they and the audio thread hand sound over through, and which
 * worker plays which strip: laid out by how much work each strip is (timed as it plays), kept while
 * the song plays, and laid out afresh when it starts again. Whoever runs it (the studio's page,
 * HO[LO] Engine) starts the threads (`start`, given what each one needs to take part), gives every
 * message to `post` and the same to its audio thread, and the messages the pool returns likewise.
 */
export class AheadPool {
  readonly count: number;
  private readonly threads: AheadThread[];
  private readonly control: SharedArrayBuffer;
  private data: SharedArrayBuffer;
  private edges: number;
  readonly link: AheadLink;
  private owners: number[] = [];
  private shape = '';
  private graph: GraphSpec | null = null;
  private guesses = new Map<number, number>();
  /** Each strip's heaviest timing lately (a track idle while stopped still costs what it did playing). */
  private seen = new Map<number, number>();
  /** Instruments' guesses from their notes or plans, by channel number (what's to come is known). */
  private parts = new Map<number, number>();
  /** When the strips last moved (ms). */
  private moved = Number.NEGATIVE_INFINITY;

  constructor(count: number, start: (spec: AheadSpec) => AheadThread) {
    this.count = count;
    this.control = aheadControl();
    this.edges = aheadRoom(64);
    this.data = aheadData(this.edges);
    this.link = new AheadLink(this.control, this.data, this.edges);
    this.threads = Array.from({ length: count }, (_, self) => start(this.spec(self)));
  }

  /** What an engine needs to take part: the audio thread's is -1. */
  spec(self: number): AheadSpec {
    return { control: this.control, data: this.data, edges: this.edges, workers: this.count, self };
  }

  /** A message to every worker (the audio thread gets the same, in the same order). */
  post(msg: ToWorklet): void {
    for (const t of this.threads) t.post(msg);
  }

  close(): void {
    for (const t of this.threads) t.close();
  }

  /**
   * A strip's share of a block: as timed where it plays (its heaviest lately), or a guess until it
   * has played; a guess from an instrument's notes counts all along (it knows what's to come, and a
   * track times at next to nothing while the song is stopped).
   */
  private cost(num: number): number {
    const timed = Math.max(this.link.cost(num), this.seen.get(num) ?? 0);
    const guess = this.guesses.get(num) ?? 0.01;
    if (this.parts.has(num)) return Math.max(timed, guess);
    return timed > 0.002 ? timed : guess;
  }

  /** An instrument's guess from its notes or its plans (aheadTrackGuess, aheadPartGuess; null: none). */
  setPart(num: number, guess: number | null): void {
    if (guess === null) this.parts.delete(num);
    else this.parts.set(num, guess);
    const t = this.graph?.tracks.find((x) => x.num === num);
    if (t) this.guesses.set(num, aheadGuess(t, this.parts.get(num)));
  }

  /** Keep each strip's heaviest timing, fading by half in about half a minute: call every couple of seconds. */
  remember(): void {
    const graph = this.graph;
    if (!graph) return;
    for (const s of [...graph.tracks, ...graph.buses])
      this.seen.set(s.num, Math.max(this.link.cost(s.num), (this.seen.get(s.num) ?? 0) * 0.95));
  }

  /**
   * Every couple of seconds (`now` in ms): the timings kept, and when a worker has too much to do
   * (the first layout is a guess), the strips laid out again by how long each takes: while playing
   * only when it's falling behind, and not often (a strip that moves starts afresh).
   */
  check(playing: boolean, now: number): ToWorklet[] {
    this.remember();
    const busiest = Math.max(...this.loads());
    if (busiest < 0.75 || (playing && now - this.moved < 10_000)) return [];
    const msgs = this.rebalance(1.2);
    if (msgs.length) this.moved = now;
    return msgs;
  }

  /** How long the busiest worker would take a block for, with these owners. */
  private busiest(graph: GraphSpec, owners: number[]): number {
    const load = new Array<number>(this.count).fill(0);
    for (const s of [...graph.tracks, ...graph.buses]) {
      const o = owners[s.num] ?? -1;
      if (o >= 0) load[o] = (load[o] as number) + this.cost(s.num);
    }
    return Math.max(0, ...load);
  }

  /**
   * Messages for the graph as it now is: room for more connections if they need it, and new owners
   * when the strips or their routing change. While playing, the strips keep their players (a strip
   * that moves starts afresh where it lands); only new ones are laid out.
   */
  layout(graph: GraphSpec, playing: boolean): ToWorklet[] {
    this.graph = graph;
    for (const t of graph.tracks) this.guesses.set(t.num, aheadGuess(t, this.parts.get(t.num)));
    for (const b of graph.buses) this.guesses.set(b.num, aheadGuess(b));
    const shape = shapeOf(graph);
    if (shape === this.shape) return [];
    this.shape = shape;
    const fresh = aheadOwners(graph, this.count, (num) => this.cost(num));
    const kept =
      playing && this.owners.length
        ? fresh.map((o, num) => ((this.owners[num] ?? -1) >= 0 ? (this.owners[num] as number) : o))
        : fresh;
    return this.use(graph, kept);
  }

  /**
   * Lay the strips out afresh by how long each has been taking, when that lightens the busiest
   * worker by enough to be worth it (`gain`: by a quarter, say 1.25). Starting from a stop, 1.25
   * (a strip that moves builds what it plays with as it starts).
   */
  rebalance(gain: number): ToWorklet[] {
    const graph = this.graph;
    if (!graph || !this.owners.length) return [];
    const fresh = aheadOwners(graph, this.count, (num) => this.cost(num));
    if (this.busiest(graph, this.owners) < this.busiest(graph, fresh) * gain) return [];
    return this.use(graph, fresh);
  }

  private use(graph: GraphSpec, owners: number[]): ToWorklet[] {
    const out: ToWorklet[] = [];
    const needed = aheadPlan(graph, owners).handed;
    if (needed > this.edges) {
      this.edges = aheadRoom(needed);
      this.data = aheadData(this.edges);
      out.push({ type: 'aheadData', data: this.data, edges: this.edges });
    }
    if (owners.join() !== this.owners.join()) out.push({ type: 'ahead', owners });
    this.owners = owners;
    return out;
  }

  /** Each worker's load (its share of each block's time, smoothed). */
  loads(): number[] {
    return Array.from({ length: this.count }, (_, j) => this.link.load(j));
  }

  /** Blocks the audio thread waited for the workers (and played silence). */
  stalls(): number {
    return this.link.stalls();
  }
}

// ---- running it ----

/** Messages, taken in block by block. */
class Inbox {
  private items: (ToWorklet | undefined)[] = [];
  private head = 0;
  received = 0;
  applied = 0;
  push(msg: ToWorklet): void {
    this.items.push(msg);
    this.received++;
  }
  /** The first message of a type still to be taken in, as a count of messages (-1: none). */
  pending(type: ToWorklet['type']): number {
    for (let i = this.head; i < this.items.length; i++)
      if (this.items[i]?.type === type) return this.applied + (i - this.head);
    return -1;
  }
  /** Hand messages to the engine until `count` have been; false while some haven't arrived. */
  applyUpTo(core: EngineCore, count: number): boolean {
    while (this.applied < count) {
      if (this.head >= this.items.length) return false;
      const msg = this.items[this.head] as ToWorklet;
      this.items[this.head++] = undefined;
      this.applied++;
      core.receive(msg);
    }
    if (this.head > 256 && this.head * 2 > this.items.length) {
      this.items = this.items.slice(this.head);
      this.head = 0;
    }
    return true;
  }
}

/**
 * The audio thread's side: it plays block k once every worker has finished it, after the messages
 * the leader took in before it. Until then it plays silence (a stall), and the song waits.
 */
export class AheadPlayer {
  private block = 0;
  private readonly inbox = new Inbox();
  private readonly core: EngineCore;
  private readonly link: AheadLink;
  private readonly workers: number;
  /** Blocks played since the last stall (a quiet half minute brings the lead back). */
  private quiet = 0;
  private readonly settle: number;
  /** A block that must be ready, with a few after it, before anything plays (a song starting). */
  private preroll = 0;
  constructor(core: EngineCore, link: AheadLink, workers: number) {
    this.core = core;
    this.link = link;
    this.workers = workers;
    this.settle = Math.round((30 * core.sr) / AHEAD_BLOCK);
  }
  receive(msg: ToWorklet): void {
    this.inbox.push(msg);
  }
  /** Messages taken in so far (a block that took some in may have been slow for it: a song arriving). */
  get taken(): number {
    return this.inbox.applied;
  }
  /** One block out: false when it stalled (or waits for a song to start). */
  process(out0: Float32Array, out1: Float32Array, input: Float32Array[] | undefined, contextFrame: number): boolean {
    this.startSoon();
    const k = this.block;
    const link = this.link;
    const waiting = this.preroll > k && !link.ready(this.preroll, this.workers);
    if (waiting || !link.ready(k, this.workers) || !this.inbox.applyUpTo(this.core, link.messages(k))) {
      out0.fill(0);
      out1.fill(0);
      // (the wait before the first block is the workers starting, a song's start its pre-roll, and a
      // wait while stopped, the song loading, silence anyway: not stalls)
      if (k > 0 && !waiting && this.core.isPlaying) {
        link.stall();
        link.setLead(link.lead() + 8);
        this.quiet = 0;
      }
      return false;
    }
    this.core.aheadBlock(k);
    this.core.process(out0, out1, input, contextFrame);
    this.block = k + 1;
    link.setConsumed(k + 1);
    if (++this.quiet >= this.settle && link.lead() > AHEAD_LEAD) {
      link.setLead(link.lead() - 4);
      this.quiet = 0;
    }
    return true;
  }

  /**
   * Starting from a stop: the blocks already played ahead are only the stop going on (silence, and
   * what's still ringing), so the song starts as soon as the workers have played the block the start
   * lands in, not after them all.
   */
  private startSoon(): void {
    if (this.core.isPlaying) return;
    const at = this.inbox.pending('play');
    if (at < 0) return;
    const k = this.block;
    const leader = this.link.leader();
    for (let j = k; j < leader; j++) {
      const count = this.link.messages(j);
      if (count <= at) continue;
      // take in everything before it (stopped, nothing else moves), and skip there
      if (!this.inbox.applyUpTo(this.core, count)) return;
      this.block = j;
      this.preroll = j + PREROLL - 1;
      this.link.setConsumed(j);
      return;
    }
  }
}

type WaitAsync = (
  a: Int32Array,
  index: number,
  value: number,
  timeout?: number,
) => { async: boolean; value: Promise<string> | string };

/**
 * A worker's side: block after block as far ahead as the ring allows. The leader (worker 0) opens
 * each block with the messages it has; the others wait for it and take in as many.
 */
export class AheadWorker {
  private readonly inbox = new Inbox();
  private wake: (() => void) | null = null;
  private stopped = false;
  private load = 0;
  private readonly core: EngineCore;
  private readonly link: AheadLink;
  private readonly self: number;
  private readonly now: () => number;
  /** A moment for the thread's messages to arrive (a turn of its event loop). */
  private readonly pause: () => Promise<void>;

  constructor(core: EngineCore, link: AheadLink, self: number, now: () => number, pause: () => Promise<void>) {
    this.core = core;
    this.link = link;
    this.self = self;
    this.now = now;
    this.pause = pause;
  }

  receive(msg: ToWorklet): void {
    this.inbox.push(msg);
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  stop(): void {
    this.stopped = true;
    this.wake?.();
  }

  /** Until a counter moves off `value` (the event loop goes on meanwhile, so messages arrive). */
  private async waitWhile(index: number, value: number): Promise<void> {
    const waitAsync = (Atomics as unknown as { waitAsync?: WaitAsync }).waitAsync;
    if (waitAsync) {
      const r = waitAsync(this.link.ctl, index, value, 50);
      if (r.async) await r.value;
      return;
    }
    Atomics.wait(this.link.ctl, index, value, 2);
    await this.pause();
  }

  async run(): Promise<void> {
    const l = new Float32Array(AHEAD_BLOCK);
    const r = new Float32Array(AHEAD_BLOCK);
    const sr = this.core.sr;
    const budget = (AHEAD_BLOCK / sr) * 1000;
    const link = this.link;
    for (let k = 0; !this.stopped; k++) {
      if (this.self === 0) {
        // as far ahead as the lead, then wait for a few blocks' room: the others then play a few at a time
        if (k - link.consumed() >= link.lead()) {
          for (;;) {
            const c = link.consumed();
            if (k - c <= link.lead() - LEADER_BATCH) break;
            await this.waitWhile(C_CONSUMED, c);
            if (this.stopped) return;
          }
        }
        // a turn of the event loop now and then, for messages, when it never has to wait
        if ((k & 7) === 0) await this.pause();
        this.inbox.applyUpTo(this.core, this.inbox.received);
        link.open(k, this.inbox.applied);
      } else {
        while (link.leader() <= k) {
          await this.waitWhile(C_LEADER, k);
          if (this.stopped) return;
        }
        const need = link.messages(k);
        while (!this.inbox.applyUpTo(this.core, need)) {
          await new Promise<void>((res) => {
            this.wake = res;
          });
          if (this.stopped) return;
        }
      }
      this.core.aheadBlock(k);
      const t0 = this.now();
      this.core.process(l, r, undefined, 0);
      // the time it worked (not the time it waited for the others)
      const share = (this.now() - t0 - this.core.aheadWaited()) / budget;
      // about half a second to settle, as the audio thread's meter
      this.load += (share - this.load) * (2 / (sr / AHEAD_BLOCK));
      link.setLoad(this.self, this.load);
      link.finish(this.self, k + 1);
    }
  }
}
