/**
 * Drawing scores: the engraver runs in a worker, started the first time a score is shown and stopped
 * after a minute with nothing to draw (it holds a good deal of memory). The newest request wins.
 */
import type { RenderReply, RenderRequest } from './score.worker.ts';
import ScoreWorker from './score.worker.ts?worker';

const IDLE_MS = 60_000;

/** One engraver for each place that draws (the Score, the scan review): neither skips the other's. */
interface Channel {
  worker: Worker | null;
  idle: number;
  waiting: Map<number, { resolve: (svg: string[] | null) => void; reject: (e: Error) => void }>;
}
const channels = new Map<string, Channel>();
let nextId = 1;

function channelOf(name: string): Channel {
  let c = channels.get(name);
  if (!c) {
    c = { worker: null, idle: 0, waiting: new Map() };
    channels.set(name, c);
  }
  return c;
}

function start(c: Channel): Worker {
  if (c.worker) return c.worker;
  const w = new ScoreWorker();
  w.onmessage = (e: MessageEvent<RenderReply>) => {
    const r = e.data;
    const p = c.waiting.get(r.id);
    if (!p) return;
    c.waiting.delete(r.id);
    if ('error' in r) p.reject(new Error(r.error));
    else if ('skipped' in r) p.resolve(null);
    else p.resolve(r.svg);
    if (!c.waiting.size) {
      clearTimeout(c.idle);
      c.idle = window.setTimeout(() => stopWorker(c), IDLE_MS);
    }
  };
  w.onerror = (e) => {
    for (const p of c.waiting.values()) p.reject(new Error(e.message || 'The score could not be drawn'));
    c.waiting.clear();
    stopWorker(c);
  };
  c.worker = w;
  return w;
}

function stopWorker(c: Channel): void {
  c.worker?.terminate();
  c.worker = null;
}

/**
 * Draw a score: its pages as SVG, or null when a newer drawing took its place before it was drawn.
 */
export function renderScore(
  mei: string,
  options: Record<string, unknown>,
  allPages = false,
  channel = 'score',
): Promise<string[] | null> {
  const c = channelOf(channel);
  clearTimeout(c.idle);
  const w = start(c);
  const id = nextId++;
  const req: RenderRequest = { id, mei, options, allPages };
  return new Promise((resolve, reject) => {
    c.waiting.set(id, { resolve, reject });
    w.postMessage(req);
  });
}

/** Several small scores drawn in turn on one channel (none skipped): the review's systems. */
export async function renderEach(meis: string[], options: Record<string, unknown>, channel: string): Promise<string[]> {
  const out: string[] = [];
  for (const mei of meis) {
    const pages = await renderScore(mei, options, false, channel);
    out.push(pages?.[0] ?? '');
  }
  return out;
}
