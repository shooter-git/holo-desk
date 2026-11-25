/**
 * A bounce made on the host (apps/server/src/host-bounce.ts), as a studio asks for one and follows
 * it. Nothing here touches the studio's state: actions.ts decides what a bounce is of and what's
 * shown, and bounces on the device when the host can't take it.
 */
import type { Project } from '@holo/session';

export interface HostBounceAsk {
  project: Project;
  /** The stretch of the song, ticks, and how long it rings on after, seconds. */
  from: number;
  to: number;
  tail: number;
  name: string;
}

/** A bounce the host took: its job, and when the host began it (by the host's clock, ms). */
export interface HostBounceStarted {
  id: string;
  started: number;
}

/** How a bounce the host took ended. */
export type HostBounced =
  | { state: 'done'; file: string; url: string; path: string; seconds: number }
  /** `lost`: the host gave it up without trying it through (it was closing), or no longer knows of it. */
  | { state: 'failed'; error: string; lost: boolean };

type Fetch = typeof fetch;

/**
 * Ask the host for a bounce of the song as the page has it. Its job, or null when the host can't
 * take it: one from before it made bounces, too many waiting already, or out of reach.
 */
export async function startHostBounce(ask: HostBounceAsk, fetcher: Fetch = fetch): Promise<HostBounceStarted | null> {
  try {
    const res = await fetcher(`/api/projects/${ask.project.id}/bounces/host`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: ask.project, from: ask.from, to: ask.to, tail: ask.tail, name: ask.name }),
    });
    if (res.status !== 202) return null;
    const { id, started } = (await res.json()) as { id?: unknown; started?: unknown };
    if (typeof id !== 'string' || !id) return null;
    // (a host that doesn't say when: this device's clock, for want of the host's)
    return { id, started: typeof started === 'number' && Number.isFinite(started) ? started : Date.now() };
  } catch {
    return null;
  }
}

/** How often the host is asked how far it has got. */
const EVERY_MS = 1500;

/**
 * Follow a bounce to its end, `onLine` told how far it has got. It has no deadline of its own (a
 * phone's page is put to sleep and woken: the host stops a bounce that takes too long), and a host
 * out of reach for a moment is asked again. A host that no longer knows the bounce was started
 * again meanwhile: lost.
 */
export async function watchHostBounce(
  id: string,
  o: { onLine?: (line: string) => void; fetch?: Fetch; wait?: (ms: number) => Promise<void> } = {},
): Promise<HostBounced> {
  const fetcher = o.fetch ?? fetch;
  const wait = o.wait ?? ((ms: number) => new Promise<void>((done) => setTimeout(done, ms)));
  for (;;) {
    let job: Record<string, unknown>;
    try {
      const res = await fetcher(`/api/bounce-jobs/${encodeURIComponent(id)}`);
      if (res.status === 404)
        return { state: 'failed', error: 'The host was started again while it bounced', lost: true };
      if (!res.ok) throw new Error(String(res.status));
      job = (await res.json()) as Record<string, unknown>;
    } catch {
      await wait(EVERY_MS);
      continue;
    }
    if (job.state === 'done' && typeof job.file === 'string' && typeof job.url === 'string')
      return {
        state: 'done',
        file: job.file,
        url: job.url,
        path: String(job.path ?? ''),
        seconds: typeof job.seconds === 'number' ? job.seconds : 0,
      };
    if (job.state === 'failed' || job.state === 'done')
      return { state: 'failed', error: String(job.error ?? 'The bounce came to nothing'), lost: job.lost === true };
    o.onLine?.(job.state === 'waiting' ? 'waiting its turn' : String(job.line ?? '') || 'starting');
    await wait(EVERY_MS);
  }
}

// ---- a bounce the host forgot (it was started again), found among the song's bounces ----

/** What the host makes of a bounce's name for its file (apps/server/src/host-bounce.ts, bounceFileName). */
export function bounceTitle(name: string): string {
  return (
    name
      .replace(/[^\w .()'-]+/g, '')
      .trim()
      .slice(0, 80) || 'Bounce'
  );
}

/** A moment as the host stamps a bounce's file with it: "2026-01-02 03.04.05" (UTC). */
const stamp = (ms: number) => new Date(ms).toISOString().replace('T', ' ').replace(/:/g, '.').slice(0, 19);

/**
 * The file of a bounce the host began at `started` (its clock) for `name`, among the song's
 * bounces: the first one named exactly for it and finished since. Null when there's none (it
 * didn't finish), or the host can't be asked.
 */
export async function findBounce(
  project: string,
  name: string,
  started: number,
  fetcher: Fetch = fetch,
): Promise<{ file: string; url: string; path: string } | null> {
  try {
    const res = await fetcher(`/api/projects/${encodeURIComponent(project)}/bounces`);
    if (!res.ok) return null;
    const list = (await res.json()) as { file?: unknown; url?: unknown }[];
    const wanted = `${bounceTitle(name)}.wav`;
    const since = stamp(started);
    const found = list
      .filter(
        (b): b is { file: string; url: string } =>
          typeof b.file === 'string' &&
          typeof b.url === 'string' &&
          // ("YYYY-MM-DD HH.MM.SS " and then the name: nothing more, nothing less)
          b.file.slice(20) === wanted &&
          b.file.slice(0, 19) >= since,
      )
      .sort((a, b) => a.file.localeCompare(b.file))[0];
    return found ? { file: found.file, url: found.url, path: `bounces/${project}/${found.file}` } : null;
  } catch {
    return null;
  }
}

// ---- a bounce kept: under way through a reload, and finished until it's saved ----

/**
 * A bounce this device asked for: enough to follow it again and finish as it would have, and, once
 * it's done on a device that saves by a tap, where its file is until it's saved or put away.
 */
export interface KeptBounce {
  id: string;
  /** The song's id ('' in a record from before this was kept). */
  project: string;
  name: string;
  download: boolean;
  /** When it was asked for (this device's clock), and when the host began it (the host's). */
  at: number;
  started: number;
  done?: { url: string; file: string; seconds: number | null };
}

type Shelf = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;

const KEY = 'holo:host-bounce';
/** A finished bounce nobody saved or put away is forgotten after this long (its file stays with the song). */
const KEPT_MS = 7 * 24 * 3600 * 1000;

export function keepBounce(kept: KeptBounce, storage: Shelf = sessionStorage): void {
  try {
    storage.setItem(KEY, JSON.stringify(kept));
  } catch {
    // (nowhere to keep it: a reload forgets the bounce, which is still made and kept with the song)
  }
}

/** What's kept, however long ago (null: nothing that is one). */
function read(storage: Pick<Shelf, 'getItem'>, now: number): KeptBounce | null {
  try {
    const kept = JSON.parse(storage.getItem(KEY) ?? 'null') as Partial<KeptBounce> | null;
    if (!kept || typeof kept.id !== 'string' || typeof kept.name !== 'string') return null;
    const at = typeof kept.at === 'number' ? kept.at : now;
    const done = kept.done;
    return {
      id: kept.id,
      project: typeof kept.project === 'string' ? kept.project : '',
      name: kept.name,
      download: kept.download === true,
      at,
      started: typeof kept.started === 'number' ? kept.started : at,
      ...(done && typeof done.url === 'string' && typeof done.file === 'string'
        ? { done: { url: done.url, file: done.file, seconds: typeof done.seconds === 'number' ? done.seconds : null } }
        : {}),
    };
  } catch {
    return null;
  }
}

/** The bounce kept, if it was asked for within the week. */
export function keptBounce(storage: Pick<Shelf, 'getItem'> = sessionStorage, now = Date.now()): KeptBounce | null {
  const kept = read(storage, now);
  return kept && now - kept.at <= KEPT_MS ? kept : null;
}

/** The kept bounce is done: where its file is. Only if it is still the one kept (another tab may have asked since). */
export function markBounced(id: string, done: NonNullable<KeptBounce['done']>, storage: Shelf = sessionStorage): void {
  const kept = read(storage, Date.now());
  if (kept?.id === id) keepBounce({ ...kept, done }, storage);
}

/** Let go of the kept bounce, if it is still this one. */
export function dropBounce(id: string, storage: Shelf = sessionStorage): void {
  try {
    if (read(storage, Date.now())?.id === id) storage.removeItem(KEY);
  } catch {
    // (nothing was kept)
  }
}
