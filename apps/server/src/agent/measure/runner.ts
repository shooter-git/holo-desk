/**
 * Running the agent's measurements away from the server: in child processes (child.ts) at the lowest
 * priority, one measurement at a time in each of two lanes (files: a take, a bounce, a plugin's
 * response, quick; renders: the mix or a track rendered, slow), so a take is measured while a render
 * runs. A tool call can't last a minute (some harnesses cut it at 60 s), so a call waits for its
 * measurement up to a budget (40 s) and otherwise answers how far it has got and about how long is
 * left; the same call again (the same song, as it is now, and the same question) joins the
 * measurement under way, or gets its answer at once from the cache.
 *
 * A measurement belongs to the jobs that asked for it. When the last of them is stopped (the user
 * pressed Stop, it failed), it's cancelled; when the last one's turn just finished, it runs on for a
 * while (`orphanMs`), so the next turn can collect what the agent told the user was coming. A lane's
 * child is let go when it has had nothing to do for a minute, and when the server closes.
 */
import { fork } from 'node:child_process';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import type { ChildInput, MeasureResult } from './tasks.ts';

export type Lane = 'files' | 'render';

/** What a measuring call answers: the result, or how far it has got (0–1) and about how many seconds are left. */
export type MeasureAnswer =
  | { done: true; task: string; result: MeasureResult; cached?: boolean }
  | { done: false; task: string; progress: number; eta: number | null; stage: string };

/** A measuring process, as the runner sees one (a forked child, or a test's stand-in). */
export interface ChildLike {
  send(msg: unknown): unknown;
  on(event: 'message', fn: (msg: unknown) => void): unknown;
  on(event: 'exit', fn: () => void): unknown;
  kill(): unknown;
  pid?: number | undefined;
}

export interface RunnerOptions {
  /** How long a call waits for its measurement (ms). */
  budgetMs?: number;
  /** A lane's child is let go after this long with nothing to do (ms). */
  idleMs?: number;
  /** How long a measurement runs on once the turn that asked for it is over (ms). */
  orphanMs?: number;
  /** How many results are kept. */
  cacheSize?: number;
  /** Makes a child (a test's stand-in; a fork of child.ts otherwise). */
  spawn?: () => ChildLike;
}

export interface MeasureJob {
  /** The job asking, and its song. */
  job: string;
  project: string;
  /** What it is (the song's revision and the question): the same key is the same measurement. */
  key: string;
  lane: Lane;
  /** About how long it should take (s), until it says how far it has got. */
  estimate: number;
  input: ChildInput;
}

/** A measurement that failed or was cancelled: why. */
export class MeasureFailed extends Error {}

interface Task {
  id: string;
  key: string;
  lane: Lane;
  project: string;
  /** The live jobs it's for. */
  jobs: Set<string>;
  /** Running on after the turn that asked for it: when it gives up. */
  orphaned: NodeJS.Timeout | null;
  input: ChildInput | null;
  state: 'queued' | 'running' | 'done' | 'failed';
  progress: number;
  stage: string;
  started: number | null;
  estimate: number;
  result?: MeasureResult;
  error?: string;
  waiters: Set<() => void>;
}

interface LaneState {
  child: ChildLike | null;
  queue: Task[];
  running: Task | null;
  idle: NodeJS.Timeout | null;
}

const CHILD = join(import.meta.dirname, 'child.ts');

const forkChild = (): ChildLike =>
  fork(CHILD, [], {
    execArgv: ['--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

/** The finished tasks kept for `GET …/measure/:task`. */
const KEPT = 100;

export class MeasureRunner {
  readonly budgetMs: number;
  private readonly idleMs: number;
  private readonly orphanMs: number;
  private readonly cacheSize: number;
  private readonly spawn: () => ChildLike;
  private readonly tasks = new Map<string, Task>();
  /** Queued or running, by key. */
  private readonly live = new Map<string, Task>();
  /** Done, by key, the most recently used last. */
  private readonly cache = new Map<string, Task>();
  /** How long renders took against their estimates, by song (the next estimate is scaled by it). */
  private readonly pace = new Map<string, number>();
  private readonly lanes: Record<Lane, LaneState> = {
    files: { child: null, queue: [], running: null, idle: null },
    render: { child: null, queue: [], running: null, idle: null },
  };
  private counter = 0;
  private closed = false;

  constructor(o: RunnerOptions = {}) {
    this.budgetMs = o.budgetMs ?? 40_000;
    this.idleMs = o.idleMs ?? 60_000;
    this.orphanMs = o.orphanMs ?? 15 * 60_000;
    this.cacheSize = o.cacheSize ?? 32;
    this.spawn = o.spawn ?? forkChild;
  }

  /** An estimate (s) for a song's render, as its last renders went. */
  paced(project: string, seconds: number): number {
    return seconds * (this.pace.get(project) ?? 1);
  }

  /** Measure (or join the same measurement, or answer from the cache), waiting up to the budget. */
  request(m: MeasureJob, budgetMs = this.budgetMs): Promise<MeasureAnswer> {
    if (this.closed) return Promise.reject(new MeasureFailed('HO[LO] is closing'));
    const hit = this.cache.get(m.key);
    if (hit?.result) {
      this.cache.delete(m.key);
      this.cache.set(m.key, hit);
      return Promise.resolve({ done: true, task: hit.id, result: hit.result, cached: true });
    }
    let task = this.live.get(m.key);
    if (task) this.join(task, m.job);
    else {
      task = {
        id: `msr_${(++this.counter).toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        key: m.key,
        lane: m.lane,
        project: m.project,
        jobs: new Set([m.job]),
        orphaned: null,
        input: m.input,
        state: 'queued',
        progress: 0,
        stage: 'Waiting for another measurement to finish',
        started: null,
        estimate: Math.max(1, m.estimate),
        waiters: new Set(),
      };
      this.tasks.set(task.id, task);
      this.live.set(task.key, task);
      this.lanes[task.lane].queue.push(task);
      this.prune();
      this.pump(task.lane);
    }
    return this.wait(task, budgetMs);
  }

  /** A measurement by id, for a job of its song (null: none such), waiting up to the budget. */
  check(id: string, project: string, job: string, budgetMs = this.budgetMs): Promise<MeasureAnswer> | null {
    const task = this.tasks.get(id);
    if (!task || task.project !== project) return null;
    if (task.state === 'queued' || task.state === 'running') this.join(task, job);
    return this.wait(task, budgetMs);
  }

  /** A job ended: stopped (cancelled, failed) or its turn finished. Its measurements go, or run on a while. */
  jobEnded(job: string, stopped: boolean): void {
    for (const task of [...this.live.values()]) {
      if (!task.jobs.delete(job) || task.jobs.size) continue;
      if (stopped) this.fail(task, 'The request that asked for it was stopped', true);
      else {
        const t = setTimeout(() => this.fail(task, 'Nobody came back for it', true), this.orphanMs);
        t.unref?.();
        task.orphaned = t;
      }
    }
  }

  /** The server is closing: every child goes, and every call waiting is answered. */
  close(): void {
    this.closed = true;
    for (const task of [...this.live.values()]) this.fail(task, 'HO[LO] is closing', false);
    for (const lane of Object.values(this.lanes)) {
      if (lane.idle) clearTimeout(lane.idle);
      lane.idle = null;
      lane.child?.kill();
      lane.child = null;
      lane.running = null;
      lane.queue = [];
    }
  }

  /** What's going on, for tests and the curious: each lane's child, what runs and what waits. */
  status(): Record<Lane, { child: boolean; running: string | null; queued: number }> {
    const one = (l: LaneState) => ({ child: !!l.child, running: l.running?.id ?? null, queued: l.queue.length });
    return { files: one(this.lanes.files), render: one(this.lanes.render) };
  }

  // ---- inside ----

  private join(task: Task, job: string): void {
    task.jobs.add(job);
    if (task.orphaned) clearTimeout(task.orphaned);
    task.orphaned = null;
  }

  private wait(task: Task, budgetMs: number): Promise<MeasureAnswer> {
    return new Promise((resolve, reject) => {
      const settle = () => {
        clearTimeout(timer);
        task.waiters.delete(settle);
        if (task.state === 'failed') reject(new MeasureFailed(task.error ?? 'The measurement failed'));
        else resolve(this.answer(task));
      };
      const timer = setTimeout(settle, task.state === 'done' || task.state === 'failed' ? 0 : budgetMs);
      task.waiters.add(settle);
    });
  }

  private answer(task: Task): MeasureAnswer {
    if (task.state === 'done' && task.result) return { done: true, task: task.id, result: task.result };
    const eta = this.remaining(task);
    return {
      done: false,
      task: task.id,
      progress: Math.round(task.progress * 100) / 100,
      eta: Number.isFinite(eta) ? Math.max(1, Math.round(eta)) : null,
      stage: task.stage,
    };
  }

  /** About how many seconds are left: from how far it has got, or its estimate; for one waiting, those before it too. */
  private remaining(task: Task): number {
    if (task.state === 'running') {
      const elapsed = (Date.now() - (task.started ?? Date.now())) / 1000;
      if (task.progress >= 0.05) return (elapsed * (1 - task.progress)) / task.progress;
      return Math.max(1, task.estimate - elapsed);
    }
    const lane = this.lanes[task.lane];
    let ahead = lane.running && lane.running !== task ? this.remaining(lane.running) : 0;
    for (const t of lane.queue) {
      if (t === task) break;
      ahead += t.estimate;
    }
    return ahead + task.estimate;
  }

  private settle(task: Task): void {
    for (const w of [...task.waiters]) w();
  }

  /** A measurement fails (or is cancelled): a running one's child goes with it (a render can't be interrupted). */
  private fail(task: Task, why: string, pump: boolean): void {
    if (task.state === 'done' || task.state === 'failed') return;
    const lane = this.lanes[task.lane];
    if (task.orphaned) clearTimeout(task.orphaned);
    task.orphaned = null;
    lane.queue = lane.queue.filter((t) => t !== task);
    if (lane.running === task) {
      lane.child?.kill();
      lane.child = null;
      lane.running = null;
    }
    task.state = 'failed';
    task.error = why;
    task.input = null;
    this.live.delete(task.key);
    this.settle(task);
    if (pump) this.pump(task.lane);
  }

  private pump(name: Lane): void {
    const lane = this.lanes[name];
    if (this.closed || lane.running) return;
    // a live job's measurement before one running on after its turn
    const next = lane.queue.find((t) => t.jobs.size > 0) ?? lane.queue[0];
    if (!next) {
      this.idle(name);
      return;
    }
    if (lane.idle) clearTimeout(lane.idle);
    lane.idle = null;
    lane.queue = lane.queue.filter((t) => t !== next);
    const child = this.child(name);
    lane.running = next;
    next.state = 'running';
    next.started = Date.now();
    next.stage = 'Starting';
    child.send({ type: 'run', id: next.id, input: next.input });
    next.input = null;
  }

  private child(name: Lane): ChildLike {
    const lane = this.lanes[name];
    if (lane.child) return lane.child;
    const child = this.spawn();
    try {
      if (child.pid) setPriority(child.pid, 19);
    } catch {
      // (it lowers its own as it starts)
    }
    child.on('message', (msg) => this.message(name, child, msg));
    child.on('exit', () => this.exited(name, child));
    lane.child = child;
    return child;
  }

  private message(name: Lane, child: ChildLike, raw: unknown): void {
    const lane = this.lanes[name];
    const task = lane.running;
    const msg = raw as {
      type?: string;
      id?: string;
      fraction?: number;
      stage?: string;
      result?: MeasureResult;
      error?: string;
    };
    if (lane.child !== child || !task || msg.id !== task.id) return;
    if (msg.type === 'progress') {
      if (typeof msg.fraction === 'number' && Number.isFinite(msg.fraction))
        task.progress = Math.max(task.progress, Math.min(1, msg.fraction));
      if (typeof msg.stage === 'string') task.stage = msg.stage.slice(0, 120);
      return;
    }
    if (msg.type !== 'done' && msg.type !== 'failed') return;
    lane.running = null;
    if (task.orphaned) clearTimeout(task.orphaned);
    task.orphaned = null;
    this.live.delete(task.key);
    if (msg.type === 'done' && msg.result) {
      task.state = 'done';
      task.result = msg.result;
      task.progress = 1;
      this.cache.set(task.key, task);
      while (this.cache.size > this.cacheSize) this.cache.delete(this.cache.keys().next().value as string);
      if (name === 'render' && task.started) {
        const took = (Date.now() - task.started) / 1000;
        if (took > 5) this.pace.set(task.project, Math.max(0.2, Math.min(5, took / task.estimate)));
      }
    } else {
      task.state = 'failed';
      task.error = typeof msg.error === 'string' && msg.error ? msg.error.slice(0, 300) : 'The measurement failed';
    }
    this.settle(task);
    this.pump(name);
  }

  private exited(name: Lane, child: ChildLike): void {
    const lane = this.lanes[name];
    if (lane.child !== child) return;
    lane.child = null;
    const task = lane.running;
    if (task) {
      lane.running = null;
      task.state = 'failed';
      task.error = 'The measurement stopped before it finished (it may have run out of memory)';
      this.live.delete(task.key);
      this.settle(task);
    }
    this.pump(name);
  }

  private idle(name: Lane): void {
    const lane = this.lanes[name];
    if (lane.idle || !lane.child) return;
    const t = setTimeout(() => {
      lane.idle = null;
      if (lane.running || lane.queue.length || !lane.child) return;
      lane.child.kill();
      lane.child = null;
    }, this.idleMs);
    t.unref?.();
    lane.idle = t;
  }

  /** Finished tasks beyond the last hundred are forgotten. */
  private prune(): void {
    if (this.tasks.size <= KEPT) return;
    for (const [id, t] of this.tasks) {
      if (this.tasks.size <= KEPT) break;
      if (t.state === 'done' || t.state === 'failed') this.tasks.delete(id);
    }
  }
}
