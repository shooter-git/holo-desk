/**
 * Verovio, the engraver, on a thread of its own: it takes a score as MEI and gives back SVG. Only the
 * newest request is drawn; one that went stale while another was drawing is answered as skipped.
 */
import { VerovioToolkit } from 'verovio/esm';
import createVerovioModule from 'verovio/wasm';

export interface RenderRequest {
  id: number;
  mei: string;
  options: Record<string, unknown>;
  /** Draw every page (for printing), not only the first. */
  allPages?: boolean;
}

export type RenderReply =
  | { id: number; svg: string[]; log: string }
  | { id: number; skipped: true }
  | { id: number; error: string };

let toolkit: Promise<VerovioToolkit> | null = null;
let pending: RenderRequest | null = null;
let busy = false;

const post = (m: RenderReply) => (self as unknown as Worker).postMessage(m);

async function drain(): Promise<void> {
  if (busy) return;
  busy = true;
  try {
    while (pending) {
      const req = pending;
      pending = null;
      try {
        toolkit ??= createVerovioModule().then((m) => new VerovioToolkit(m));
        const tk = await toolkit;
        if (pending) {
          post({ id: req.id, skipped: true });
          continue;
        }
        tk.setOptions(req.options);
        if (!tk.loadData(req.mei)) {
          post({ id: req.id, error: tk.getLog() || 'Verovio could not read the score' });
          continue;
        }
        const pages = req.allPages ? tk.getPageCount() : 1;
        const svg: string[] = [];
        for (let p = 1; p <= pages; p++) svg.push(tk.renderToSVG(p));
        post({ id: req.id, svg, log: tk.getLog() });
      } catch (e) {
        post({ id: req.id, error: String(e) });
      }
    }
  } finally {
    busy = false;
  }
}

self.onmessage = (e: MessageEvent<RenderRequest>) => {
  if (pending) post({ id: pending.id, skipped: true });
  pending = e.data;
  void drain();
};
