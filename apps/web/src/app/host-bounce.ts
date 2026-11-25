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

/** How a bounce the host took ended. */
export type HostBounced =
  | { state: 'done'; file: string; url: string; path: string; seconds: number }
  /** `lost`: the host gave it up without trying it through (it was closing), or no longer knows of it. */
  | { state: 'failed'; error: string; lost: boolean };

type Fetch = typeof fetch;

/**
 * Ask the host for a bounce of the song as the page has it. The job's id, or null when the host
 * can't take it: one from before it made bounces, too many waiting already, or out of reach.
 */
export async function startHostBounce(ask: HostBounceAsk, fetcher: Fetch = fetch): Promise<string | null> {
  try {
    const res = await fetcher(`/api/projects/${ask.project.id}/bounces/host`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ doc: ask.project, from: ask.from, to: ask.to, tail: ask.tail, name: ask.name }),
    });
    if (res.status !== 202) return null;
    const { id } = (await res.json()) as { id?: unknown };
    return typeof id === 'string' && id ? id : null;
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

// ---- a bounce under way, kept through a reload ----

/** A bounce the host is making for this tab: enough to follow it again and finish as it would have. */
export interface KeptBounce {
  id: string;
  name: string;
  download: boolean;
}

const KEY = 'holo:host-bounce';

export function keepBounce(
  kept: KeptBounce | null,
  storage: Pick<Storage, 'setItem' | 'removeItem'> = sessionStorage,
): void {
  try {
    if (kept) storage.setItem(KEY, JSON.stringify(kept));
    else storage.removeItem(KEY);
  } catch {
    // (nowhere to keep it: a reload forgets the bounce, which is still made and kept with the song)
  }
}

export function keptBounce(storage: Pick<Storage, 'getItem'> = sessionStorage): KeptBounce | null {
  try {
    const kept = JSON.parse(storage.getItem(KEY) ?? 'null') as Partial<KeptBounce> | null;
    if (!kept || typeof kept.id !== 'string' || typeof kept.name !== 'string') return null;
    return { id: kept.id, name: kept.name, download: kept.download === true };
  } catch {
    return null;
  }
}
