/**
 * Rendering ahead in HO[LO] Engine: a song too big for one thread is played a little ahead of the
 * playhead by worker threads on the other cores, as the studio's page does it in the browser
 * (@holo/engine's ahead.ts). This is the main thread's side: the threads, started (and warmed up)
 * with the app, take a studio's song when it starts its engine; every message goes to each of them
 * and the same to the render thread, in the same order; and who plays what is laid out here, from
 * what the messages say (each instrument's notes or plans) and how long each strip takes as it
 * plays. The studio sends only what it sends its own audio thread. The render thread plays the
 * master and every live note (renderer.ts).
 */
import { availableParallelism } from 'node:os';
import type { Worker } from 'node:worker_threads';
import {
  AheadPool,
  type AheadSpec,
  aheadPartGuess,
  aheadShared,
  aheadTrackGuess,
  aheadWorkersFor,
  EVENT_SIZE,
  type GraphSpec,
  type PartPlans,
  type ToWorklet,
} from '@holo/engine';
import type { ToRenderer } from './renderer.ts';

/** What a thread that renders ahead takes besides the song (ahead-thread.ts). */
export type ToAheadThread = { type: 'aheadStart'; sr: number; ahead: AheadSpec } | { type: 'aheadStop' };

/** Workers for this computer: as many as asked (at most six), or the studio's rule for its cores. */
export function aheadThreads(asked: number | null): number {
  return Math.max(0, Math.min(6, asked ?? aheadWorkersFor(availableParallelism())));
}

/** The studio's messages the render thread alone takes: its own, and live notes (heard in the next block). */
function renderOnly(msg: ToRenderer): boolean {
  return (
    msg.type === 'open' ||
    msg.type === 'close' ||
    msg.type === 'routes' ||
    msg.type === 'measure' ||
    msg.type === 'live' ||
    msg.type === 'init'
  );
}

/**
 * The threads, and where each of the studio's messages goes. A studio starting its engine (`init`)
 * gets a fresh pool at the sound device's rate (none while no device is open, or with no threads to
 * spare: the render thread then plays it all, as before).
 */
export class AheadRelay {
  /** The sound device's rate, as the render thread last opened it. */
  rate = 0;
  private pool: CompanionAhead | null = null;
  private readonly threads: Worker[];
  private readonly toRenderer: (msg: ToRenderer, transfer?: ArrayBuffer[]) => void;

  constructor(
    count: number,
    start: () => Worker,
    toRenderer: (msg: ToRenderer, transfer?: ArrayBuffer[]) => void,
    onError: (message: string) => void,
  ) {
    this.toRenderer = toRenderer;
    this.threads = Array.from({ length: count }, () => {
      const w = start();
      w.on('message', (m: { type: string; message?: string }) => {
        if (m?.type === 'error') onError(`Rendering ahead: ${m.message ?? ''}`);
      });
      w.on('error', (e) => onError(`Rendering ahead: ${e.message}`));
      return w;
    });
  }

  /** The pool playing now, if any. */
  get current(): CompanionAhead | null {
    return this.pool;
  }

  /** A message from the studio (or the server: `close`); `transfer` moves its bytes when it goes to one thread. */
  receive(msg: ToRenderer, transfer: ArrayBuffer[] = []): void {
    if (msg.type === 'init') {
      this.pool?.close();
      this.pool =
        this.threads.length && this.rate > 0 ? new CompanionAhead(this.threads, this.rate, this.toRenderer) : null;
      this.toRenderer({ ...msg, ahead: this.pool?.spec() ?? null });
      return;
    }
    if (msg.type === 'close') {
      this.pool?.close();
      this.pool = null;
    }
    if (this.pool && !renderOnly(msg)) this.pool.receive(msg as ToWorklet);
    else this.toRenderer(msg, transfer);
  }

  async close(): Promise<void> {
    this.pool?.close();
    this.pool = null;
    await Promise.all(this.threads.map((w) => w.terminate()));
  }
}

/** One studio's song on the threads: who plays what, and the guesses that lay it out before it's timed. */
export class CompanionAhead {
  readonly pool: AheadPool;
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly sr: number;
  private readonly toRenderer: (msg: ToRenderer) => void;
  private playing = false;
  private graph: GraphSpec | null = null;
  /** Each track's sequence and its planned part, as sent (what it will ask for), by channel number. */
  private notes = new Map<number, Float64Array>();
  private plans = new Map<number, PartPlans>();
  private guessed = true;

  constructor(threads: Worker[], sr: number, toRenderer: (msg: ToRenderer) => void) {
    this.sr = sr;
    this.toRenderer = toRenderer;
    this.pool = new AheadPool(threads.length, (ahead) => {
      const w = threads[ahead.self] as Worker;
      const start: ToAheadThread = { type: 'aheadStart', sr, ahead };
      w.postMessage(start);
      return {
        post: (msg) => w.postMessage(msg),
        close: () => w.postMessage({ type: 'aheadStop' } satisfies ToAheadThread),
      };
    });
    // when a worker has too much to do (the first layout is a guess), the strips laid out again; and
    // while the song is stopped, as soon as its parts' plans have come (they follow the graph), so
    // that it isn't laid out again as it starts (a strip that moves starts afresh: a stall then)
    this.timer = setInterval(() => {
      const fresh = !this.guessed;
      this.guess();
      if (fresh && !this.playing) this.send(this.pool.rebalance(1.25));
      this.send(this.pool.check(this.playing, performance.now()));
    }, 2000);
    this.timer.unref();
  }

  /** What the render thread needs to take part. */
  spec(): AheadSpec {
    return this.pool.spec(-1);
  }

  /** One of the studio's messages: to every engine, with what it changes about who plays what. */
  receive(msg: ToWorklet): void {
    if (msg.type === 'play' && !this.playing) {
      // starting: the strips laid out afresh by how long each has been taking, if that helps a good deal
      this.guess();
      this.send(this.pool.rebalance(1.25));
    }
    this.send([aheadShared(msg)]);
    switch (msg.type) {
      case 'graph':
        this.graph = msg.graph;
        this.guessed = false;
        this.guess();
        this.send(this.pool.layout(msg.graph, this.playing));
        break;
      case 'sequence':
        this.notes.set(msg.num, msg.events);
        this.guessed = false;
        break;
      case 'plans':
        if (msg.plans) this.plans.set(msg.num, msg.plans);
        else this.plans.delete(msg.num);
        this.guessed = false;
        break;
      case 'play':
        this.playing = true;
        break;
      case 'stop':
        this.playing = false;
        break;
    }
  }

  private send(msgs: ToWorklet[]): void {
    for (const m of msgs) {
      this.pool.post(m);
      this.toRenderer(m);
    }
  }

  /**
   * Each instrument's guess from its notes (aheadTrackGuess) or its plans (aheadPartGuess), as the
   * studio's page makes them from the song, the song's length taken from where its last event is.
   */
  private guess(): void {
    if (this.guessed || !this.graph) return;
    this.guessed = true;
    let length = 0;
    for (const events of this.notes.values())
      for (let i = 0; i < events.length; i += EVENT_SIZE) length = Math.max(length, events[i] as number);
    for (const t of this.graph.tracks) {
      const plans = this.plans.get(t.num);
      const events = this.notes.get(t.num);
      this.pool.setPart(
        t.num,
        plans ? aheadPartGuess(plans, length) : events ? aheadTrackGuess(events, t.instrument, length, this.sr) : null,
      );
    }
  }

  close(): void {
    clearInterval(this.timer);
    this.pool.close();
  }
}
