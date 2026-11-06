/**
 * Drawing scores: the engraver runs in a worker, started the first time a score is shown and stopped
 * after a minute with nothing to draw (it holds a good deal of memory). The newest request wins.
 */
import type { RenderReply, RenderRequest } from './score.worker.ts';
import ScoreWorker from './score.worker.ts?worker';

const IDLE_MS = 60_000;

let worker: Worker | null = null;
let idle = 0;
let nextId = 1;
const waiting = new Map<number, { resolve: (svg: string[] | null) => void; reject: (e: Error) => void }>();

function start(): Worker {
  if (worker) return worker;
  const w = new ScoreWorker();
  w.onmessage = (e: MessageEvent<RenderReply>) => {
    const r = e.data;
    const p = waiting.get(r.id);
    if (!p) return;
    waiting.delete(r.id);
    if ('error' in r) p.reject(new Error(r.error));
    else if ('skipped' in r) p.resolve(null);
    else p.resolve(r.svg);
    if (!waiting.size) {
      clearTimeout(idle);
      idle = window.setTimeout(stopWorker, IDLE_MS);
    }
  };
  w.onerror = (e) => {
    for (const p of waiting.values()) p.reject(new Error(e.message || 'The score could not be drawn'));
    waiting.clear();
    stopWorker();
  };
  worker = w;
  return w;
}

function stopWorker(): void {
  worker?.terminate();
  worker = null;
}

/**
 * Draw a score: its pages as SVG, or null when a newer drawing took its place before it was drawn.
 */
export function renderScore(mei: string, options: Record<string, unknown>, allPages = false): Promise<string[] | null> {
  clearTimeout(idle);
  const w = start();
  const id = nextId++;
  const req: RenderRequest = { id, mei, options, allPages };
  return new Promise((resolve, reject) => {
    waiting.set(id, { resolve, reject });
    w.postMessage(req);
  });
}
