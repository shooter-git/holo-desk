/**
 * A song's conversation with the agent: one current thread per song, carrying on the harness's own
 * session from request to request. It keeps the song as the agent last saw it (when its reply was
 * done and the studio had saved), and what the user did since (undo, redo, their own steps), so the
 * next request starts with "since your last reply". A new harness, or "start over", starts a new
 * thread.
 */
import { randomBytes } from 'node:crypto';
import { type Project, parseProject } from '@holo/session';
import type { AgentStore, HarnessId, ThreadEvent, ThreadRow } from './store.ts';

/** At most this many of the user's doings are kept for the next reply (the latest). */
const KEEP_EVENTS = 20;

export class Threads {
  private readonly store: AgentStore;

  constructor(store: AgentStore) {
    this.store = store;
  }

  current(project: string): ThreadRow | null {
    return this.store.currentThread(project);
  }

  get(id: string): ThreadRow | null {
    return this.store.thread(id);
  }

  /** The thread a request on a song goes on: the current one, or a new one when there's none or the harness changed. */
  forRequest(project: string, harness: HarnessId): ThreadRow {
    const current = this.store.currentThread(project);
    if (current && current.harness === harness) return current;
    const now = Date.now();
    return this.store.addThread({
      id: `agt_${randomBytes(6).toString('hex')}`,
      project,
      harness,
      session: null,
      seen_doc: null,
      seen_revision: null,
      events_json: '[]',
      created: now,
      updated: now,
    });
  }

  events(thread: ThreadRow): ThreadEvent[] {
    try {
      const list = JSON.parse(thread.events_json) as unknown;
      return Array.isArray(list) ? (list as ThreadEvent[]) : [];
    } catch {
      return [];
    }
  }

  /** Something the user did on a song, for its current thread's next reply (none yet: nothing to tell). */
  addEvent(project: string, event: ThreadEvent): void {
    const thread = this.store.currentThread(project);
    if (!thread) return;
    this.addEventTo(thread.id, event);
  }

  addEventTo(threadId: string, event: ThreadEvent): void {
    const thread = this.store.thread(threadId);
    if (!thread) return;
    const events = [...this.events(thread), event].slice(-KEEP_EVENTS);
    this.store.updateThread(thread.id, { events_json: JSON.stringify(events) });
  }

  /** The events were told to the agent: they start again from none. */
  clearEvents(threadId: string): void {
    this.store.updateThread(threadId, { events_json: '[]' });
  }

  /** The song as the agent last saw it, or null (a new thread, or one whose song couldn't be read). */
  seenSong(thread: ThreadRow): Project | null {
    if (!thread.seen_doc) return null;
    try {
      return parseProject(JSON.parse(thread.seen_doc));
    } catch {
      return null;
    }
  }

  /** The agent's reply is done: the song as saved now is what it last saw. */
  seen(threadId: string, song: Project): void {
    this.store.updateThread(threadId, { seen_doc: JSON.stringify(song), seen_revision: song.revision });
  }

  setSession(threadId: string, session: string): void {
    this.store.updateThread(threadId, { session });
  }

  /** "Start over": the song's next request starts a new thread. */
  reset(project: string): void {
    this.store.endThreads(project);
  }

  /** The current thread as the bar shows it: its requests and replies. */
  view(project: string): {
    id: string;
    harness: HarnessId;
    turns: { job: string; request: string; reply: string | null; label: string | null; state: string; at: number }[];
  } | null {
    const thread = this.store.currentThread(project);
    if (!thread) return null;
    return {
      id: thread.id,
      harness: thread.harness,
      turns: this.store
        .turns(thread.id)
        .map((t) => ({ job: t.job, request: t.request, reply: t.reply, label: t.label, state: t.state, at: t.at })),
    };
  }
}
