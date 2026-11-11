/**
 * The studio's undo history, as plain functions over its two stacks. Most edits are a step each;
 * the agent's changes during one request (a job) merge into one step, so one Undo takes all of it
 * back. And the queue its changes wait in while the user is in the middle of a gesture or a drag.
 */
import type { Project } from '@holo/session';
import type { Step } from './store.ts';

/** How many steps Undo can go back. */
export const MAX_UNDO = 300;

export interface History {
  undo: Step[];
  redo: Step[];
}

/** A new step on top (the oldest goes past MAX_UNDO); what was undone can no longer be redone. */
export function push(h: History, step: Step): History {
  return { undo: [...h.undo.slice(-(MAX_UNDO - 1)), step], redo: [] };
}

/**
 * A batch of the agent's changes, made to the song `before`. While its job runs and the job's step
 * is still on top, the batch joins that step, which keeps the song from before the job. Otherwise
 * (the user edited meanwhile, or the job had finished) it opens a step of its own.
 */
export function pushOrMergeJob(h: History, before: Project, label: string, job: string, running: boolean): History {
  const top = h.undo[h.undo.length - 1];
  // (a redo step would bring back a song without this batch)
  if (running && top?.job === job) return h.redo.length ? { undo: h.undo, redo: [] } : h;
  return push(h, { project: before, label, job });
}

/** A job's steps take its final name, undone or not. */
export function relabelJob(h: History, job: string, label: string): History {
  const named = (s: Step): Step => (s.job === job && s.label !== label ? { ...s, label } : s);
  return { undo: h.undo.map(named), redo: h.redo.map(named) };
}

/** The job's steps in the song as it is (not those undone), oldest first: the first holds the song from before it. */
export function jobSteps(h: History, job: string): Step[] {
  return h.undo.filter((s) => s.job === job);
}

/** The same step the other way: the song it takes you to, under the same name and job. */
function across(step: Step, project: Project): Step {
  return step.job === undefined ? { project, label: step.label } : { project, label: step.label, job: step.job };
}

/** Undo from the song as it is now: the step undone (its song is the one to go back to), and the history after. */
export function undo(h: History, now: Project): { step: Step; history: History } | null {
  const step = h.undo[h.undo.length - 1];
  if (!step) return null;
  return { step, history: { undo: h.undo.slice(0, -1), redo: [...h.redo, across(step, now)] } };
}

/** Redo from the song as it is now: the step redone (its song is the one to go to), and the history after. */
export function redo(h: History, now: Project): { step: Step; history: History } | null {
  const step = h.redo[h.redo.length - 1];
  if (!step) return null;
  return { step, history: { undo: [...h.undo, across(step, now)], redo: h.redo.slice(0, -1) } };
}

/** What became of a batch of the agent's changes. */
export interface JobResult {
  ok: boolean;
  error?: string;
}

/**
 * The agent's batches on their way into the song. While anything holds the queue (a gesture or a
 * drag the user is in the middle of) they wait, and go in, in order, once the last hold lets go, so
 * the user's own step lands first. A batch goes in once, however often it's sent (the host sends
 * it again when an answer was lost); one that was refused may be tried again.
 */
export class JobQueue<T extends { batch: string }> {
  private readonly run: (item: T) => JobResult;
  private readonly remember: number;
  private readonly holds = new Set<symbol>();
  private readonly queue: { item: T; answers: ((r: JobResult) => void)[] }[] = [];
  /** Batches that went in, oldest first (a Map keeps the order they were added in). */
  private readonly applied = new Map<string, JobResult>();
  private draining = false;

  constructor(run: (item: T) => JobResult, remember = 500) {
    this.run = run;
    this.remember = remember;
  }

  get held(): boolean {
    return this.holds.size > 0;
  }

  /** Hold the queue until the function returned is called (calling it again does nothing). */
  hold(): () => void {
    const token = Symbol('hold');
    this.holds.add(token);
    return () => {
      if (this.holds.delete(token)) this.drain();
    };
  }

  /** Let the batches in whatever holds the queue (a hold that never let go); those holds' release does nothing. */
  letThrough(): void {
    this.holds.clear();
    this.drain();
  }

  /** Whether a batch is waiting for the holds to let go. */
  waiting(batch: string): boolean {
    return this.queue.some((w) => w.item.batch === batch);
  }

  /** Apply a batch now, or once the queue isn't held: resolves with what became of it. */
  submit(item: T): Promise<JobResult> {
    return new Promise((resolve) => {
      const done = this.applied.get(item.batch);
      const queued = this.queue.find((w) => w.item.batch === item.batch);
      if (done) resolve(done);
      else if (queued) queued.answers.push(resolve);
      else {
        this.queue.push({ item, answers: [resolve] });
        this.drain();
      }
    });
  }

  private drain(): void {
    // (a batch that lets a hold go as it's applied doesn't start a second drain inside this one)
    if (this.draining) return;
    this.draining = true;
    try {
      while (!this.held) {
        const next = this.queue.shift();
        if (!next) break;
        let result: JobResult;
        try {
          result = this.run(next.item);
        } catch (err) {
          result = { ok: false, error: err instanceof Error ? err.message : String(err) };
        }
        if (result.ok) {
          this.applied.set(next.item.batch, result);
          for (const old of this.applied.keys()) {
            if (this.applied.size <= this.remember) break;
            this.applied.delete(old);
          }
        }
        for (const answer of next.answers) answer(result);
      }
    } finally {
      this.draining = false;
    }
  }
}
