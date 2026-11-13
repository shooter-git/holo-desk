/**
 * Rendering ahead, as the page runs it: worker threads on the other cores that play the song a
 * little ahead of the playhead (@holo/engine's ahead.ts, whose AheadPool lays out who plays what).
 */
import { AheadPool, type AheadScale, type AheadTiming, aheadWorkersFor } from '@holo/engine';
import AheadWorkerScript from './ahead.worker.ts?worker';
import aheadWorkerUrl from './ahead.worker.ts?worker&url';

/** Workers to render ahead with on this device (aheadWorkersFor). */
export function aheadThreads(): number {
  return aheadWorkersFor(typeof navigator !== 'undefined' ? navigator.hardwareConcurrency || 2 : 2);
}

/** The workers' script, fetched into the browser's cache before the studio starts (its file is hashed: it won't go stale). */
export function warmAhead(): void {
  if (aheadThreads() > 0) void fetch(aheadWorkerUrl).catch(() => undefined);
}

/** The pool, its workers Web Workers. */
export function startAhead(count: number, sr: number, onError: (message: string) => void): AheadPool {
  return new AheadPool(count, (ahead) => {
    const w = new AheadWorkerScript();
    w.onmessage = (e: MessageEvent<{ type: string; message?: string }>) => {
      if (e.data?.type === 'error') onError(`Rendering ahead: ${e.data.message ?? ''}`);
    };
    w.onerror = (e) => onError(`Rendering ahead: ${e.message}`);
    w.postMessage({ type: 'aheadStart', sr, ahead });
    return {
      post: (msg) => w.postMessage(msg),
      close: () => {
        w.postMessage({ type: 'aheadQuit' });
        w.terminate();
      },
    };
  });
}

// ---- what this device has learned about its own speed, kept between visits ----

// (the 2: what was kept before it could come from timings taken while a song loaded or the workers
// fell behind, several times too high; those keys are cleared away)
const SCALE_KEY = 'holo:ahead2:scale';
const SONG_KEY = 'holo:ahead2:song:';
const SONGS_KEY = 'holo:ahead2:songs';

/** What an earlier build kept under other names: gone the first time this one looks. */
function clearEarlier(): void {
  try {
    for (const key of Object.keys(localStorage)) if (key.startsWith('holo:ahead:')) localStorage.removeItem(key);
  } catch {
    // (no storage: nothing to clear)
  }
}
/** Songs whose strips' timings are kept (the most lately played). */
const SONGS_KEPT = 24;

function read<T>(key: string): T | null {
  try {
    const text = localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : null;
  } catch {
    return null;
  }
}

function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // (no storage, or no room: the layout starts from guesses next time, as it always did)
  }
}

/** How far this device's timings run from the engine's guesses, as last learned here (null: never). */
export function loadAheadScale(): Partial<AheadScale> | null {
  clearEarlier();
  return read<Partial<AheadScale>>(SCALE_KEY);
}

/**
 * A song's strips as they were last timed playing on this device, by track or bus id (null: never,
 * or at another sample rate, where a block is another length of time).
 */
export function loadAheadTimings(project: string, rate: number): Map<string, AheadTiming> | null {
  const kept = read<{ rate: number; strips: Record<string, AheadTiming> }>(SONG_KEY + project);
  if (!kept || kept.rate !== rate || !kept.strips || typeof kept.strips !== 'object') return null;
  const out = new Map<string, AheadTiming>();
  for (const [id, t] of Object.entries(kept.strips))
    if (t && typeof t.share === 'number' && typeof t.made === 'string') out.set(id, t);
  return out;
}

/** Keep what a song's strips took as it played here, and how this device runs against the guesses. */
export function saveAhead(project: string, rate: number, strips: Map<string, AheadTiming>, scale: AheadScale): void {
  write(SCALE_KEY, scale);
  if (!strips.size) return;
  write(SONG_KEY + project, { rate, strips: Object.fromEntries(strips) });
  const songs = [project, ...(read<string[]>(SONGS_KEY) ?? []).filter((id) => id !== project)];
  for (const old of songs.slice(SONGS_KEPT)) {
    try {
      localStorage.removeItem(SONG_KEY + old);
    } catch {
      // (as above)
    }
  }
  write(SONGS_KEY, songs.slice(0, SONGS_KEPT));
}
