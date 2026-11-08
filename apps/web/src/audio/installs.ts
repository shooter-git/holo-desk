/**
 * The packs HO[LO] pins and installing them, for the Library: More packs installs one, a palette's
 * sound installs the packs it plays. The server installs one pack at a time; this queues them, follows
 * each while its samples come in, and tells the Library when they're in.
 */
import type { PackSound } from '@holo/session';
import { useSyncExternalStore } from 'react';
import { toast } from '../app/store.ts';
import { library } from './samples.ts';

export interface AvailablePack {
  id: string;
  name: string;
  license: string;
  credit: string;
  /** Its samples' size on disk: what installing it takes. */
  bytes: number | null;
  /** How many files it has (none for a palette). */
  files?: number;
  instruments: { name?: string; title: string; category: string }[];
  /** A palette's: the packs its sounds play, and the sounds. */
  requires?: string[];
  sounds?: PackSound[];
  description?: string;
  installed: boolean;
  current: boolean;
}

export interface InstallJob {
  id: string;
  name: string;
  state: 'running' | 'done' | 'error';
  line: string;
  done: number;
  total: number;
  error?: string;
}

/** Packs being brought in for one thing (a sound): which, and how far it has got. */
export interface InstallQueue {
  /** What they're for ("Low Brass"). */
  label: string;
  ids: string[];
  /** The one installing now, its place in `ids`. */
  at: number;
}

interface State {
  /** null until the server has answered. */
  packs: AvailablePack[] | null;
  job: InstallJob | null;
  queue: InstallQueue | null;
  offline: boolean;
}

const sleep = (ms: number) => new Promise((ok) => setTimeout(ok, ms));

class Installs {
  state: State = { packs: null, job: null, queue: null, offline: false };
  private listeners = new Set<() => void>();
  private following = false;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private set(patch: Partial<State>): void {
    this.state = { ...this.state, ...patch };
    for (const fn of this.listeners) fn();
  }

  /** The packs HO[LO] pins, and the install the server is running (one started elsewhere is followed too). */
  async load(): Promise<void> {
    try {
      const res = await fetch('/api/packs/available');
      if (!res.ok) return;
      const body = (await res.json()) as { packs: AvailablePack[]; job: InstallJob | null; offline?: boolean };
      this.set({ packs: body.packs, job: body.job, offline: !!body.offline });
      if (body.job?.state === 'running' && !this.state.queue) void this.follow();
    } catch {
      // offline: the installed packs still play
    }
  }

  pack(id: string): AvailablePack | undefined {
    return this.state.packs?.find((p) => p.id === id);
  }

  /** Follow the running install until it's done (or failed), then bring the Library up to date. */
  private async follow(): Promise<InstallJob | null> {
    if (this.following) {
      while (this.following) await sleep(250);
      return this.state.job;
    }
    this.following = true;
    try {
      for (;;) {
        await sleep(1000);
        let next: InstallJob | null;
        try {
          next = (await (await fetch('/api/packs/install')).json()) as InstallJob | null;
        } catch {
          // the host is away for a moment: ask again
          continue;
        }
        this.set({ job: next });
        if (next?.state !== 'running') {
          await library.refresh();
          await this.load();
          return next;
        }
      }
    } finally {
      this.following = false;
    }
  }

  /**
   * Install packs one at a time (those installed already are skipped), following each. True once all
   * are in; on a failure, says so and stops.
   */
  async install(ids: string[], label?: string): Promise<boolean> {
    const want = ids.filter((id) => !library.packs.some((p) => p.id === id));
    if (!want.length) return true;
    if (this.state.queue || this.state.job?.state === 'running') {
      toast(`${this.state.job?.name ?? 'A pack'} is installing: one at a time`, 'error', 6000);
      return false;
    }
    try {
      for (let at = 0; at < want.length; at++) {
        const id = want[at] as string;
        if (label) this.set({ queue: { label, ids: want, at } });
        const res = await fetch(`/api/packs/${encodeURIComponent(id)}/install`, { method: 'POST' });
        const body = (await res.json()) as InstallJob & { error?: string };
        if (!res.ok) throw new Error(body.error ?? 'The pack could not be installed');
        this.set({ job: body });
        const done = await this.follow();
        if (done?.state !== 'done') throw new Error(`${done?.name ?? id}: ${done?.error ?? 'the install failed'}`);
        if (!label) toast(`${done.name} is installed`);
      }
      return true;
    } catch (err) {
      toast(err instanceof Error ? err.message : String(err), 'error', 10000);
      return false;
    } finally {
      this.set({ queue: null });
    }
  }
}

export const installs = new Installs();

/** The pinned packs and the install in progress, for the screen to follow. */
export function useInstalls(): State {
  return useSyncExternalStore(
    (fn) => installs.subscribe(fn),
    () => installs.state,
  );
}
