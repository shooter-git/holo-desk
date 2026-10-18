/**
 * Rendering ahead, as the page runs it: worker threads on the other cores that play the song a
 * little ahead of the playhead (@holo/engine's ahead.ts, whose AheadPool lays out who plays what).
 */
import { AheadPool, aheadWorkersFor } from '@holo/engine';
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
