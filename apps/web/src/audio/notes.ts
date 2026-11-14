/**
 * A recording's notes, as the Audio Editor's Notes view shows them: found once per file, in a worker
 * (notes.worker.ts), and kept in memory while the studio is open. Whoever asks while a file's notes
 * are being found waits for the same answer; nothing is found twice.
 */
import type { AudioNote } from '@holo/session';

/** A recording's pitch every 5 ms (MIDI with cents, NaN where it isn't voiced) and its power there, at times in seconds of the file. */
export interface NoteCurve {
  t: Float64Array;
  midi: Float64Array;
  power: Float64Array;
}

export interface FoundNotes {
  /** The notes found, by start (times in seconds of the file). */
  notes: AudioNote[];
  curve: NoteCurve;
  /** The curve's loudest power: what a note's level is drawn against. */
  loudest: number;
}

export type NotesState =
  | { state: 'finding' }
  | { state: 'found'; found: FoundNotes }
  | { state: 'failed'; error: string };

/** What the worker is asked: a song's file. */
export interface NotesRequest {
  id: number;
  project: string;
  file: string;
}

/** What it answers: the notes and the curve they were found by, or why there are none. */
export type NotesReply = { id: number; notes: AudioNote[]; curve: NoteCurve } | { id: number; error: string };

/** The largest power on a curve (0 for none). */
export function loudestOf(power: ArrayLike<number>): number {
  let most = 0;
  for (let i = 0; i < power.length; i++) {
    const p = power[i] as number;
    if (p > most) most = p;
  }
  return most;
}

export class RecordingNotes {
  private readonly known = new Map<string, NotesState>();
  private readonly listeners = new Set<() => void>();

  constructor(
    private readonly find: (project: string, file: string) => Promise<{ notes: AudioNote[]; curve: NoteCurve }>,
  ) {}

  /** What's known of a file's notes: the first to ask sets them being found. */
  of(project: string, file: string): NotesState {
    const known = this.known.get(file);
    if (known) return known;
    const finding: NotesState = { state: 'finding' };
    this.known.set(file, finding);
    this.find(project, file).then(
      ({ notes, curve }) =>
        this.settle(file, { state: 'found', found: { notes, curve, loudest: loudestOf(curve.power) } }),
      (err: unknown) => this.settle(file, { state: 'failed', error: err instanceof Error ? err.message : String(err) }),
    );
    return finding;
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private settle(file: string, state: NotesState): void {
    this.known.set(file, state);
    for (const fn of this.listeners) fn();
  }
}

let worker: Worker | null = null;
let asked = 0;
const waiting = new Map<
  number,
  { ok: (r: { notes: AudioNote[]; curve: NoteCurve }) => void; fail: (e: Error) => void }
>();

/** A file's notes found in the worker (one, started the first time, finding one file after another). */
function inWorker(project: string, file: string): Promise<{ notes: AudioNote[]; curve: NoteCurve }> {
  if (!worker) {
    const w = new Worker(new URL('./notes.worker.ts', import.meta.url), { type: 'module' });
    w.onmessage = (e: MessageEvent<NotesReply>) => {
      const job = waiting.get(e.data.id);
      waiting.delete(e.data.id);
      if (!job) return;
      if ('error' in e.data) job.fail(new Error(e.data.error));
      else job.ok({ notes: e.data.notes, curve: e.data.curve });
    };
    // a worker that fails to start or dies fails what it had, and the next ask starts another
    w.onerror = () => {
      for (const job of waiting.values()) job.fail(new Error('Note finding stopped'));
      waiting.clear();
      w.terminate();
      if (worker === w) worker = null;
    };
    worker = w;
  }
  const id = ++asked;
  const request: NotesRequest = { id, project, file };
  return new Promise((ok, fail) => {
    waiting.set(id, { ok, fail });
    worker?.postMessage(request);
  });
}

export const recordingNotes = new RecordingNotes(inWorker);
