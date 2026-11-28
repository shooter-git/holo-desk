/**
 * A song's conversation with the agent: one current thread per song, carried on from request to
 * request whichever harness runs it. Each harness has its own part in it (a leg): its own session
 * there, the song as it last saw it (when its reply was done and the studio had saved), and the folder
 * its runs work in. The thread's own `harness`, `session` and `seen_doc` are those of the harness that
 * ran last (or is about to), so a request reads them as ever; a request with another harness switches
 * the thread to that one's leg, and going back to one carries its own session on. The thread keeps
 * what the user did since the last reply (undo, redo, their own steps). "Start over" starts a new
 * thread.
 */
import { randomBytes } from 'node:crypto';
import { type Project, parseProject } from '@holo/session';
import type { AgentStore, HarnessId, LegRow, ThreadEvent, ThreadRow, TurnExtra } from './store.ts';

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

  /**
   * The thread a request on a song goes on, as the harness it'll run with has it: the current one
   * (switched to that harness's leg when another ran last), or a new one when there's none.
   */
  forRequest(project: string, harness: HarnessId): ThreadRow {
    const current = this.store.currentThread(project);
    if (current) return current.harness === harness ? current : this.switchTo(current, harness);
    const now = Date.now();
    const thread = this.store.addThread({
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
    this.leg(thread);
    return thread;
  }

  /** A thread as another harness has it: that one's own session and what it last saw (none, the first time). */
  private switchTo(thread: ThreadRow, harness: HarnessId): ThreadRow {
    // (the leg the thread stood for is kept as it is: its harness may be gone back to)
    this.leg(thread);
    const leg = this.store.leg(thread.id, harness);
    this.store.updateThread(thread.id, {
      harness,
      session: leg?.session ?? null,
      seen_doc: leg?.seen_doc ?? null,
      seen_revision: leg?.seen_revision ?? null,
    });
    const next = this.store.thread(thread.id) ?? thread;
    this.leg(next);
    return next;
  }

  /**
   * The leg of the harness a thread runs with now, made if it isn't there: as the thread has it. The
   * first of a conversation from before legs works in the thread's own folder (the migration made
   * it); every other in one of its own, named for the thread and the harness (two harnesses can't
   * share a folder: each keeps its own files there).
   */
  leg(thread: ThreadRow): LegRow {
    const known = this.store.leg(thread.id, thread.harness);
    if (known) return known;
    return this.store.putLeg({
      thread: thread.id,
      harness: thread.harness,
      session: thread.session,
      seen_doc: thread.seen_doc,
      seen_revision: thread.seen_revision,
      workspace: `${thread.id}_${thread.harness}`,
    });
  }

  /** The harnesses that have a session of their own in a thread. */
  sessions(threadId: string): HarnessId[] {
    return this.store
      .legs(threadId)
      .filter((l) => l.session)
      .map((l) => l.harness);
  }

  /** Change a harness's leg in a thread, and the thread itself when that's the harness it runs with now. */
  private setLeg(
    threadId: string,
    harness: HarnessId,
    patch: Partial<Pick<LegRow, 'session' | 'seen_doc' | 'seen_revision'>>,
  ): void {
    const thread = this.store.thread(threadId);
    if (!thread) return;
    const leg = this.store.leg(threadId, harness) ?? {
      thread: threadId,
      harness,
      session: null,
      seen_doc: null,
      seen_revision: null,
      workspace: `${threadId}_${harness}`,
    };
    this.store.putLeg({ ...leg, ...patch });
    if (thread.harness === harness) this.store.updateThread(threadId, patch);
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

  /** A harness's reply is done: the song as saved now is what it last saw. */
  seen(threadId: string, harness: HarnessId, song: Project): void {
    this.setLeg(threadId, harness, { seen_doc: JSON.stringify(song), seen_revision: song.revision });
  }

  setSession(threadId: string, harness: HarnessId, session: string): void {
    this.setLeg(threadId, harness, { session });
  }

  /**
   * A harness's session isn't carried on: its next request on the thread starts a new conversation of
   * its own. That one never saw the song, so the song it last saw goes too: what changed since means
   * nothing to it (it's told what was asked and answered so far instead).
   */
  forgetSession(threadId: string, harness: HarnessId): void {
    this.setLeg(threadId, harness, { session: null, seen_doc: null, seen_revision: null });
  }

  /** "Start over": the song's next request starts a new thread. */
  reset(project: string): void {
    this.store.endThreads(project);
  }

  /**
   * The current thread as the bar shows it: its requests and replies, each with what it asked the user
   * to allow, the brief it wrote (its commands and links flagged), and why it stopped.
   */
  view(project: string): { id: string; harness: HarnessId; turns: TurnView[] } | null {
    const thread = this.store.currentThread(project);
    if (!thread) return null;
    return {
      id: thread.id,
      harness: thread.harness,
      turns: this.store.turns(thread.id).map((t) => {
        const extra = parseExtra(t.extra);
        return {
          job: t.job,
          request: t.request,
          reply: t.reply,
          label: t.label,
          state: t.state,
          at: t.at,
          ...(extra.permission ? { permission: extra.permission } : {}),
          ...(extra.brief ? { brief: extra.brief } : {}),
          ...(extra.briefWarnings ? { briefWarnings: extra.briefWarnings } : {}),
          ...(extra.view ? { view: extra.view } : {}),
          ...(extra.go ? { go: extra.go } : {}),
          ...(extra.error ? { error: extra.error } : {}),
          ...(extra.harness ? { harness: extra.harness } : {}),
          ...(extra.stop ? { stop: extra.stop } : {}),
          ...(extra.continues ? { continues: extra.continues } : {}),
        };
      }),
    };
  }
}

/** A turn as the bar shows it. */
export interface TurnView {
  job: string;
  request: string;
  reply: string | null;
  label: string | null;
  state: string;
  at: number;
  permission?: TurnExtra['permission'];
  brief?: string;
  briefWarnings?: TurnExtra['briefWarnings'];
  view?: TurnExtra['view'];
  go?: TurnExtra['go'];
  error?: string;
  /** The harness it ran with, why it didn't go on (when known), and the earlier go it carries on. */
  harness?: HarnessId;
  stop?: TurnExtra['stop'];
  continues?: string;
}

/** A turn's extra (JSON), or nothing when it has none or can't be read. */
export function parseExtra(text: string | null): TurnExtra {
  if (!text) return {};
  try {
    const v = JSON.parse(text) as unknown;
    return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as TurnExtra) : {};
  } catch {
    return {};
  }
}
