/**
 * The studio's undo history, as plain functions over its two stacks. Most edits are a step each;
 * the agent's changes during one request (a job) merge into one step, so one Undo takes all of it
 * back, those it saved on the host while the studio was away included (`pickUp`). And the queue its
 * changes wait in while the user is in the middle of a gesture or a drag.
 */
import type { Project } from '@holo/session';
import { mergeSongs, same } from './merge-songs.ts';
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
 *
 * A job that carries an earlier go at the same request on (`continues`: Try again) joins that go's
 * step while it's still on top: the request stays one step, which keeps the song from before the
 * request, and is this job's from then on (undoing it stops this one).
 */
export function pushOrMergeJob(
  h: History,
  before: Project,
  label: string,
  job: string,
  running: boolean,
  at = Date.now(),
  continues: string | null = null,
): History {
  const top = h.undo[h.undo.length - 1];
  // (a redo step would bring back a song without this batch)
  if (running && top?.job === job) return h.redo.length ? { undo: h.undo, redo: [] } : h;
  // (by the request's first go, which the step remembers through every go that follows)
  if (running && continues && top && (top.job === continues || top.first === continues))
    return { undo: [...h.undo.slice(0, -1), { ...top, job, first: continues }], redo: [] };
  return push(h, { project: before, label, job, at });
}

/** What picking up the agent's changes made of the song: how they came in. */
export interface PickedUp extends History {
  project: Project;
  /**
   * `exact`: the song is the host's as they left it (nothing of this studio's own was left to keep);
   * `merged`: this studio's own changes were put onto it; `theirs`: they couldn't be, so the song is
   * the host's, and the step's Undo brings this studio's back.
   */
  how: 'exact' | 'merged' | 'theirs';
  /**
   * Why not, with `theirs`: `clash`, they and the agent's changed the same thing or the song would
   * point at what it doesn't have; `unknown`, what they were made on isn't known here (never guessed).
   */
  why?: 'clash' | 'unknown';
}

/** This studio's own changes the host doesn't have: its song (`song`), and the song they were made on (`base`). */
export interface OwnChanges {
  /** The song as the host had it at the revision the studio carries on from; null when it isn't known. */
  base: Project | null;
  song: Project;
}

/**
 * The agent's changes saved on the host while this studio was away (a phone in another app, a closed
 * tab), taken in as if they had come while it was there: they join the job's step on top, or open one
 * of their own, whose Undo goes back to `now`, this studio's song. The song becomes the host's as they
 * left it (`theirs`); with changes of this studio's own not saved yet (`mine`), those are put onto it
 * (mergeSongs), so the agent's stay as the host has them, ids and all. Where both changed the same thing
 * (or what they were made on isn't known), the song is the host's, and a step of its own holds `now`
 * for Undo.
 */
export function pickUp(
  h: History,
  now: Project,
  theirs: Project,
  mine: OwnChanges | null,
  label: string,
  job: string,
  at = Date.now(),
): PickedUp {
  // (only the history's own fields: merged into the step on top, `h` comes back as it was given)
  const joined = (): History => {
    const { undo, redo } = pushOrMergeJob(h, now, label, job, true, at);
    return { undo, redo };
  };
  if (!mine) return { project: theirs, ...joined(), how: 'exact' };
  const merged = mine.base && mergeSongs(mine.base, mine.song, theirs);
  if (!merged)
    return {
      project: theirs,
      ...push(h, { project: now, label, job, at }),
      how: 'theirs',
      why: mine.base ? 'clash' : 'unknown',
    };
  // (all of this studio's own were the host's already: a save of them got there, its answer lost)
  if (same(merged, theirs)) return { project: theirs, ...joined(), how: 'exact' };
  return { project: merged, ...joined(), how: 'merged' };
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

/** The same step the other way: the song it takes you to, under the same name, job and time. */
function across(step: Step, project: Project): Step {
  const { label, at } = step;
  if (step.job === undefined) return { project, label, at };
  return { project, label, job: step.job, ...(step.first === undefined ? {} : { first: step.first }), at };
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

/**
 * Several Undos (`n` below 0) or Redos (above 0) at once, from the song as it is now, as far as the
 * history goes: the steps crossed, in the order they were undone or redone, the song they lead to,
 * and the history after. Null when there's nothing that way.
 */
export function travel(
  h: History,
  now: Project,
  n: number,
): { steps: Step[]; project: Project; history: History } | null {
  const move = n < 0 ? undo : redo;
  const steps: Step[] = [];
  let at = h;
  let song = now;
  for (let i = 0; i < Math.abs(n); i++) {
    const r = move(at, song);
    if (!r) break;
    steps.push(r.step);
    at = r.history;
    song = r.step.project;
  }
  return steps.length ? { steps, project: song, history: at } : null;
}

/**
 * How far a step is from the song as it is: below 0, the Undos that take it back (it and everything
 * after it); above 0, the Redos that bring it back (everything up to it). 0 when it's no longer in
 * the history (it was dropped, or moved across since it was shown).
 */
export function distance(h: History, step: Step): number {
  const back = h.undo.lastIndexOf(step);
  if (back >= 0) return back - h.undo.length;
  const ahead = h.redo.lastIndexOf(step);
  return ahead >= 0 ? h.redo.length - ahead : 0;
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
  private readonly most: number;
  private readonly holds = new Set<symbol>();
  private readonly queue: { item: T; answers: ((r: JobResult) => void)[] }[] = [];
  /** Batches that went in, oldest first (a Map keeps the order they were added in). */
  private readonly applied = new Map<string, JobResult>();
  private draining = false;

  constructor(run: (item: T) => JobResult, remember = 500) {
    this.run = run;
    this.most = remember;
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

  /** Whether a batch has gone in. */
  done(batch: string): boolean {
    return this.applied.has(batch);
  }

  /** Batches that went in another way (picked up from the host): sent again, they're answered, not applied. */
  remember(batches: readonly string[]): void {
    for (const batch of batches) this.applied.set(batch, { ok: true });
    this.forget();
  }

  /** Only the latest batches are remembered. */
  private forget(): void {
    for (const old of this.applied.keys()) {
      if (this.applied.size <= this.most) break;
      this.applied.delete(old);
    }
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
        // (one that went in another way while it waited is answered as it went)
        let result = this.applied.get(next.item.batch);
        if (!result) {
          try {
            result = this.run(next.item);
          } catch (err) {
            result = { ok: false, error: err instanceof Error ? err.message : String(err) };
          }
          if (result.ok) {
            this.applied.set(next.item.batch, result);
            this.forget();
          }
        }
        for (const answer of next.answers) answer(result);
      }
    } finally {
      this.draining = false;
    }
  }
}
