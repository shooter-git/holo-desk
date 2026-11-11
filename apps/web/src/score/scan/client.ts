/**
 * Scanning from the studio (or a phone's Remote): photos or PDFs in, pages straightened and their
 * systems found in a worker, and the scan sent to the host, to be read in: by you, the recognition
 * engines, or the agent (from the bar).
 */
import type { FoundSystem, Point, Scan, SystemState } from '@holo/score';
import type { Op } from '@holo/session';
import type { PrepReply, PrepRequest } from './prep.worker.ts';
import PrepWorker from './prep.worker.ts?worker';

/** A page as picked: its pixels (no bigger than needed), and where its corners are. */
export interface PickedPage {
  name: string;
  w: number;
  h: number;
  /** For showing it. */
  url: string;
  rgba: Uint8ClampedArray;
  corners: [Point, Point, Point, Point];
}

export interface PreparedPage {
  page: Blob;
  w: number;
  h: number;
  space: number;
  systems: FoundSystem[];
  strips: Blob[];
}

/** Photos are read at this size at most: plenty for a page, kind to a phone's memory. */
const MAX_SIDE = 3600;

let worker: Worker | null = null;
let next = 1;
const waiting = new Map<number, (r: PrepReply) => void>();

/** A request without its id (each kind on its own). */
type Unnumbered<T> = T extends unknown ? Omit<T, 'id'> : never;

function prep(req: Unnumbered<PrepRequest>, transfer: Transferable[]): Promise<PrepReply> {
  if (!worker) {
    worker = new PrepWorker();
    worker.onmessage = (e: MessageEvent<PrepReply>) => {
      waiting.get(e.data.id)?.(e.data);
      waiting.delete(e.data.id);
    };
  }
  const id = next++;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker?.postMessage({ ...req, id }, transfer);
  });
}

async function pixels(
  source: CanvasImageSource,
  w: number,
  h: number,
): Promise<{ rgba: Uint8ClampedArray; url: string }> {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) throw new Error('This browser can’t draw images');
  ctx.drawImage(source, 0, 0, w, h);
  const rgba = ctx.getImageData(0, 0, w, h).data;
  const blob: Blob = await new Promise((r, j) =>
    canvas.toBlob((b) => (b ? r(b) : j(new Error('No image'))), 'image/jpeg', 0.85),
  );
  return { rgba, url: URL.createObjectURL(blob) };
}

/** A photo: turned as the camera meant it, made no bigger than needed, its corners guessed. */
async function fromImage(file: File): Promise<PickedPage> {
  const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
  const w = Math.round(bitmap.width * scale);
  const h = Math.round(bitmap.height * scale);
  const { rgba, url } = await pixels(bitmap, w, h);
  bitmap.close();
  return { name: file.name, w, h, url, rgba, corners: await guess(rgba, w, h) };
}

/** A PDF's pages, drawn at a reading size (pdf.js loads only when a PDF is picked). */
async function fromPdf(file: File): Promise<PickedPage[]> {
  const pdfjs = await import('pdfjs-dist');
  const workerUrl = (await import('pdfjs-dist/build/pdf.worker.min.mjs?url')).default;
  pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
  const doc = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
  const pages: PickedPage[] = [];
  for (let n = 1; n <= Math.min(doc.numPages, 60); n++) {
    const page = await doc.getPage(n);
    const base = page.getViewport({ scale: 1 });
    const viewport = page.getViewport({ scale: Math.min(4, 2400 / Math.max(base.width, base.height)) });
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(viewport.width);
    canvas.height = Math.round(viewport.height);
    const ctx = canvas.getContext('2d');
    if (!ctx) continue;
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    await page.render({ canvas, canvasContext: ctx, viewport }).promise;
    const { rgba, url } = await pixels(canvas, canvas.width, canvas.height);
    const w = canvas.width;
    const h = canvas.height;
    // a PDF's page is already straight: its corners are its own
    pages.push({
      name: `${file.name} p${n}`,
      w,
      h,
      url,
      rgba,
      corners: [
        [0, 0],
        [w, 0],
        [w, h],
        [0, h],
      ],
    });
  }
  return pages;
}

async function guess(rgba: Uint8ClampedArray, w: number, h: number): Promise<[Point, Point, Point, Point]> {
  const copy = rgba.slice().buffer;
  const r = await prep({ type: 'guess', rgba: copy, w, h }, [copy]);
  if ('corners' in r) return r.corners;
  return [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
}

/** Files picked (photos or PDFs) as pages. */
export async function readPages(files: FileList | File[]): Promise<PickedPage[]> {
  const out: PickedPage[] = [];
  for (const f of files) {
    if (f.type === 'application/pdf' || f.name.toLowerCase().endsWith('.pdf')) out.push(...(await fromPdf(f)));
    else if (f.type.startsWith('image/')) out.push(await fromImage(f));
  }
  return out;
}

/** A page straightened, cleaned, and its systems found. */
export async function preparePage(p: PickedPage, enhance: boolean): Promise<PreparedPage> {
  const copy = p.rgba.slice().buffer;
  const r = await prep({ type: 'prepare', rgba: copy, w: p.w, h: p.h, corners: p.corners, enhance }, [copy]);
  if ('error' in r) throw new Error(r.error);
  if (!('page' in r)) throw new Error('The page could not be prepared');
  return r;
}

/** A refusal from the host: what it said, and why in a word when it gave one. */
class Refused extends Error {
  constructor(
    message: string,
    readonly reason: string | null,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, init);
  const body = (await res.json().catch(() => ({}))) as T & { error?: string; reason?: string };
  if (!res.ok) throw new Refused(body.error ?? `${res.status}`, typeof body.reason === 'string' ? body.reason : null);
  return body;
}

const json = (method: string, body: unknown): RequestInit => ({
  method,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

/** Send a scan to the host: the pages, a strip a system, and where they all are. */
export async function saveScan(
  project: string,
  track: string | null,
  title: string,
  pages: PreparedPage[],
): Promise<Scan> {
  const scan = await call<Scan>('/api/scans', json('POST', { project, ...(track ? { track } : {}), title }));
  for (const [n, p] of pages.entries()) {
    await call(`/api/scans/${scan.id}/pages/${n}`, {
      method: 'PUT',
      headers: { 'content-type': 'image/png' },
      body: p.page,
    });
    for (const [k, strip] of p.strips.entries()) {
      await call(`/api/scans/${scan.id}/strips/${n}/${k}`, {
        method: 'PUT',
        headers: { 'content-type': 'image/png' },
        body: strip,
      });
    }
  }
  const record: Scan = {
    ...scan,
    pages: pages.map((p, n) => ({
      n,
      w: p.w,
      h: p.h,
      type: 'png',
      systems: p.systems.map((s, k) => ({
        k,
        top: s.top,
        bottom: s.bottom,
        left: s.left,
        right: s.right,
        staves: s.staves.length,
        bars: s.bars,
        state: 'new',
      })),
    })),
  };
  return call<Scan>(`/api/scans/${scan.id}`, json('PUT', record));
}

export const getScan = (id: string) => call<Scan>(`/api/scans/${id}`);
export const listScans = (project: string) =>
  call<{ id: string; title: string; created: string; pages: number; progress: Record<string, number> }[]>(
    `/api/scans?project=${encodeURIComponent(project)}`,
  );
export const setSystem = (id: string, page: number, k: number, body: Record<string, unknown>) =>
  call(`/api/scans/${id}/systems/${page}/${k}`, json('PATCH', body));
export const deleteScan = (id: string) => call(`/api/scans/${id}`, { method: 'DELETE' });
export const omrStatus = () => call<{ available: boolean; engines: string[] }>('/api/omr');
export const compareEngines = (id: string) =>
  call<{ summary: string[]; flagged: number }>(`/api/scans/${id}/engines`, { method: 'POST' });

/**
 * What the recognition engines read of a scan's systems not read yet, worked out from the song as the
 * host has it saved: `ops` to apply as one undo step labelled `label`, then each system's new state to
 * set (only once they're applied). Nothing on the host changes until then.
 */
export interface EngineReading {
  ops: Op[];
  label: string;
  /** The song's saved revision it was worked out from. */
  revision: number;
  systems: { page: number; system: number; state: SystemState; written?: [number, number]; flags?: string[] }[];
  pages: { page: number; engine: string; others: string[] }[];
  written: number[];
  errors: string[];
  warnings: string[];
}

const reading = (id: string) => call<EngineReading>(`/api/scans/${id}/engines/reading`);

/**
 * The engines' reading of a scan. When they haven't read its pages yet, they read them first (as
 * Compare with the engines has them do), and `running` is told.
 */
export async function readWithEngines(id: string, running?: () => void): Promise<EngineReading> {
  try {
    return await reading(id);
  } catch (e) {
    if (!(e instanceof Refused) || e.reason !== 'no-readings') throw e;
  }
  running?.();
  const ran = await compareEngines(id);
  try {
    return await reading(id);
  } catch (e) {
    // they ran but read nothing: what they said is why
    const said = ran.summary.filter((line) => !/ read it$/.test(line));
    if (e instanceof Refused && e.reason === 'no-readings' && said.length) throw new Error(said.join('; '));
    throw e;
  }
}
