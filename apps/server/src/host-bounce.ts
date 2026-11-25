/**
 * Bounces made on the host. A studio renders its own bounce in the page, with every sample of every
 * instrument loaded there as floats: more than a phone's browser holds for a big song. The host has
 * the same engine and the same files, so a device can ask it for the bounce instead, and gets the
 * file the studio's own bounce would be: the song as the page sends it, the same range, the same
 * options (host-bounce-child.ts).
 *
 * One bounce at a time, each in a process of its own at the lowest priority, forked when its turn
 * comes and gone when it ends (its memory goes back to the system): a long render never holds up
 * the server, and a host with little to spare is slow at it and nothing worse. A few may wait
 * their turn; past that the host says no, and the device bounces as it always has.
 *
 * The child writes `data/bounces/<song>/.<job>.part`, a name nothing lists; the server names the
 * file as an uploaded bounce is named and moves it into place when it's whole.
 */
import { fork } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { setPriority } from 'node:os';
import { join } from 'node:path';
import { newId, type Project } from '@holo/session';
import type { ChildLike } from './agent/measure/runner.ts';

/** A bounce's file, named for when it was made and what it's of (as the studio's upload is). */
export function bounceFileName(name: string, now = new Date()): string {
  const stamp = now.toISOString().replace('T', ' ').replace(/:/g, '.').slice(0, 19);
  const title =
    name
      .replace(/[^\w .()'-]+/g, '')
      .trim()
      .slice(0, 80) || 'Bounce';
  return `${stamp} ${title}.wav`;
}

/** Where a song's bounces are kept. */
export const bounceDir = (dataDir: string, project: string) => join(dataDir, 'bounces', project.replace(/[^\w-]/g, ''));

/** A bounce the host was asked for, as a studio follows it. */
export interface BounceJob {
  id: string;
  project: string;
  name: string;
  state: 'waiting' | 'running' | 'done' | 'failed';
  /** How far it has got, as the engine says it. */
  line: string;
  started: number;
  finished: number | null;
  error: string | null;
  /**
   * It failed without the host having tried it through: the host was closing, or couldn't start it.
   * The device may as well bounce it itself. (One the host tried and couldn't make, for the song or
   * for want of memory or time, is said to have failed, with why.)
   */
  lost: boolean;
  /** Done: the file, where it's fetched, where it is in the data folder, and its length in seconds. */
  file: string | null;
  url: string | null;
  path: string | null;
  seconds: number | null;
}

/** What a bounce is of: the song, the stretch of it (ticks), and how long it rings on after (seconds). */
export interface BounceAsk {
  song: Project;
  from: number;
  to: number;
  tail: number;
  name: string;
}

export interface HostBouncesOptions {
  dataDir: string;
  /** Makes the rendering process (a test's stand-in; a fork of host-bounce-child.ts otherwise). */
  spawn?: () => ChildLike;
  /** How long one bounce may take (ms). */
  limitMs?: number;
  /** How many may wait their turn. */
  waiting?: number;
}

const CHILD = join(import.meta.dirname, 'host-bounce-child.ts');
const forkChild = (): ChildLike =>
  fork(CHILD, [], {
    execArgv: ['--disable-warning=ExperimentalWarning'],
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });

/** Finished bounces a studio can still ask about. */
const KEPT = 20;
const PART = /^\.bnc_[a-z0-9]+\.part$/;

export const BOUNCE_STOPPED = 'The bounce stopped before it finished (the host may have run out of memory)';

export class HostBounces {
  private readonly dataDir: string;
  private readonly spawn: () => ChildLike;
  private readonly limitMs: number;
  private readonly room: number;
  private readonly jobs = new Map<string, BounceJob>();
  private queue: { job: BounceJob; ask: BounceAsk }[] = [];
  private running: { job: BounceJob; child: ChildLike; limit: NodeJS.Timeout; part: string } | null = null;
  private closed = false;
  /** The device that asked for each (the agent's id for it, when it has one): never part of the job a studio is shown. */
  private readonly askedBy = new WeakMap<BounceJob, string>();
  /**
   * Told once when a bounce ends, done or failed, with the device that asked for it (null: none
   * known): its notice outside HO[LO] goes from here. Not for one the server's closing ended.
   */
  onEnd: ((job: BounceJob, device: string | null) => void) | null = null;
  /** Stops the rendering process should this one go without closing (set only while one runs). */
  private readonly onExit = () => this.running?.child.kill();

  constructor(options: HostBouncesOptions) {
    this.dataDir = options.dataDir;
    this.spawn = options.spawn ?? forkChild;
    this.limitMs = options.limitMs ?? 60 * 60 * 1000;
    this.room = options.waiting ?? 4;
  }

  /**
   * A bounce asked for: it runs when its turn comes. Null when too many wait already (or the host is
   * closing). `device`: who asked, to be told when it's done.
   */
  start(ask: BounceAsk, device: string | null = null): BounceJob | null {
    if (this.closed || this.queue.length >= this.room) return null;
    const job: BounceJob = {
      id: newId('bnc'),
      project: ask.song.id,
      name: ask.name,
      state: 'waiting',
      line: '',
      started: Date.now(),
      finished: null,
      error: null,
      lost: false,
      file: null,
      url: null,
      path: null,
      seconds: null,
    };
    this.jobs.set(job.id, job);
    if (device) this.askedBy.set(job, device);
    this.queue.push({ job, ask });
    this.forget();
    this.pump();
    return job;
  }

  get(id: string): BounceJob | null {
    return this.jobs.get(id) ?? null;
  }

  /** A bounce is waiting or under way: an update waits for it. */
  busy(): boolean {
    return this.running !== null || this.queue.length > 0;
  }

  /** The server is closing: nothing more runs, and what was running is stopped. */
  close(): void {
    this.closed = true;
    for (const { job } of this.queue) this.end(job, 'HO[LO] is closing', true);
    this.queue = [];
    const now = this.running;
    if (!now) return;
    this.finish();
    this.end(now.job, 'HO[LO] is closing', true);
    rmSync(now.part, { force: true });
    now.child.kill();
  }

  /** The next bounce's turn, when none is under way. */
  private pump(): void {
    if (this.running || this.closed) return;
    const next = this.queue.shift();
    if (!next) return;
    const { job, ask } = next;
    const dir = bounceDir(this.dataDir, job.project);
    const part = join(dir, `.${job.id}.part`);
    let child: ChildLike;
    try {
      mkdirSync(dir, { recursive: true });
      // (what an earlier bounce left half-written, stopped with the server)
      for (const f of readdirSync(dir)) if (PART.test(f)) rmSync(join(dir, f), { force: true });
      child = this.spawn();
    } catch (err) {
      this.end(job, `The host couldn't start the bounce (${err instanceof Error ? err.message : String(err)})`, true);
      this.pump();
      return;
    }
    try {
      if (child.pid) setPriority(child.pid, 19);
    } catch {
      // (the child lowers its own, where it may)
    }
    job.state = 'running';
    const limit = setTimeout(() => this.stop(job, 'The bounce took too long: the host stopped it'), this.limitMs);
    limit.unref();
    this.running = { job, child, limit, part };
    process.once('exit', this.onExit);
    child.on('message', (raw) => this.heard(job, raw));
    child.on('exit', () => {
      // gone before it said it was done
      if (this.running?.job === job) this.stop(job, BOUNCE_STOPPED);
    });
    child.send({
      type: 'run',
      id: job.id,
      input: { dataDir: this.dataDir, project: ask.song, from: ask.from, to: ask.to, tail: ask.tail, part },
    });
  }

  private heard(job: BounceJob, raw: unknown): void {
    const now = this.running;
    const msg = raw as { type?: string; id?: string; line?: unknown; seconds?: unknown; error?: unknown };
    if (!now || now.job !== job || msg.id !== job.id) return;
    if (msg.type === 'progress') {
      job.line = String(msg.line ?? '').slice(0, 120);
      return;
    }
    if (msg.type !== 'done' && msg.type !== 'failed') return;
    this.finish();
    if (msg.type === 'done' && existsSync(now.part)) {
      const file = bounceFileName(job.name);
      try {
        renameSync(now.part, join(bounceDir(this.dataDir, job.project), file));
        job.file = file;
        job.url = `/api/projects/${job.project}/bounces/${encodeURIComponent(file)}`;
        job.path = `bounces/${job.project}/${file}`;
        job.seconds = typeof msg.seconds === 'number' && Number.isFinite(msg.seconds) ? msg.seconds : 0;
        job.state = 'done';
        job.finished = Date.now();
        this.ended(job);
      } catch (err) {
        this.end(job, `The bounce couldn't be kept (${err instanceof Error ? err.message : String(err)})`, false);
      }
    } else {
      // what the render said was wrong with the song (a pack that isn't installed, a file it can't read)
      const said = msg.type === 'failed' ? String(msg.error ?? '').slice(0, 300) : '';
      this.end(job, said || 'The bounce came to nothing', false);
    }
    rmSync(now.part, { force: true });
    now.child.kill();
    this.pump();
  }

  /** The bounce under way stopped by the host (its process gone, too long): the next one's turn. */
  private stop(job: BounceJob, why: string): void {
    const now = this.running;
    if (!now || now.job !== job) return;
    this.finish();
    this.end(job, why, false);
    rmSync(now.part, { force: true });
    now.child.kill();
    this.pump();
  }

  /** Nothing is under way any more (its timer and this process's exit listener go with it). */
  private finish(): void {
    if (!this.running) return;
    clearTimeout(this.running.limit);
    process.removeListener('exit', this.onExit);
    this.running = null;
  }

  private end(job: BounceJob, error: string, lost: boolean): void {
    job.state = 'failed';
    job.error = error;
    job.lost = lost;
    job.finished = Date.now();
    this.ended(job);
  }

  /** A bounce has ended: whoever listens is told, once (and nothing it does is the bounce's trouble). */
  private ended(job: BounceJob): void {
    if (this.closed) return;
    try {
      this.onEnd?.(job, this.askedBy.get(job) ?? null);
    } catch {
      // (the notice is its own affair)
    }
  }

  /** The oldest finished bounces past the few kept are forgotten. */
  private forget(): void {
    let over = [...this.jobs.values()].filter((j) => j.finished !== null).length - KEPT;
    for (const [id, job] of this.jobs) {
      if (over <= 0) break;
      if (job.finished === null) continue;
      this.jobs.delete(id);
      over--;
    }
  }
}
