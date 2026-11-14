/**
 * Note edits' patches kept on the device. A patch is keyed by everything its sound depends on (the
 * recording, the stretch, the rate, the renderer's version and the notes around it: notes/plan.ts), so
 * one kept under its key is always the right one. Kept in the device's cache under the engine that
 * rendered them as well, a song opened again, or undone to an earlier state after a reload, plays its
 * edits at once instead of rendering them again.
 *
 * - **Read before rendering, written after**, the writing one at a time, off the way of anything played.
 * - **A budget.** Past it, the least lately used go first (an index of each patch's size and when it was
 *   last used is kept in the same cache, written a moment after it changes). Those another engine
 *   rendered go when the store opens, and so does anything the index doesn't know.
 * - **Never in the way.** A private window, storage that's full or refused, or no cache at all: every
 *   call is caught, and the store simply keeps nothing.
 */

const CACHE = 'holo-patches-v1';
/** "HPT1": a patch's bytes. */
const MAGIC = 0x48505431;
/** How long after a change the index is written, ms. */
const INDEX_AFTER = 1500;

/** A patch's channels as one run of bytes: the mark, how many channels, each one's length, then each end to end. */
export function packPatch(channels: readonly Float32Array[]): ArrayBuffer {
  const head = 8 + channels.length * 4;
  const total = channels.reduce((n, c) => n + c.length, 0);
  const out = new ArrayBuffer(head + total * 4);
  const view = new DataView(out);
  view.setUint32(0, MAGIC, true);
  view.setUint32(4, channels.length, true);
  let at = head;
  channels.forEach((c, i) => {
    view.setUint32(8 + i * 4, c.length, true);
    new Float32Array(out, at, c.length).set(c);
    at += c.length * 4;
  });
  return out;
}

/** The channels those bytes hold, each its own memory (null when they aren't a patch's, or are cut short). */
export function unpackPatch(bytes: ArrayBuffer): Float32Array[] | null {
  try {
    if (bytes.byteLength < 8) return null;
    const view = new DataView(bytes);
    if (view.getUint32(0, true) !== MAGIC) return null;
    const count = view.getUint32(4, true);
    const head = 8 + count * 4;
    if (count < 1 || count > 64 || head > bytes.byteLength) return null;
    const out: Float32Array[] = [];
    let at = head;
    for (let i = 0; i < count; i++) {
      const length = view.getUint32(8 + i * 4, true);
      if (at + length * 4 > bytes.byteLength) return null;
      out.push(new Float32Array(bytes.slice(at, at + length * 4)));
      at += length * 4;
    }
    return at === bytes.byteLength ? out : null;
  } catch {
    return null;
  }
}

/** What the store needs of the device's cache (the browser's CacheStorage; a stand-in in tests). */
export interface CacheLike {
  match(url: string): Promise<Response | undefined>;
  put(url: string, res: Response): Promise<void>;
  delete(req: string | { url: string }): Promise<boolean>;
  keys(): Promise<readonly { url: string }[]>;
}

export interface CachesLike {
  open(name: string): Promise<CacheLike>;
}

export interface PatchStoreOptions {
  /** The engine's fingerprint: patches another engine rendered are let go. None: nothing is kept. */
  engine: string;
  /** Bytes kept at most. */
  budget: number;
  /** The device's cache (the browser's own unless given; null: none). */
  caches?: CachesLike | null;
  /** How much the device lets the page keep (the budget is no more than a quarter of it). */
  estimate?: () => Promise<{ quota?: number }>;
  now?: () => number;
}

interface Entry {
  bytes: number;
  used: number;
}

/** Rendered patches kept on the device, by key, within a budget (patches.ts reads it before rendering one). */
export class PatchStore {
  /** Settles once the store has opened (or found it can't): it always resolves. */
  readonly ready: Promise<void>;
  /** Bytes kept, as the index counts them. */
  bytes = 0;
  budget: number;
  private cache: CacheLike | null = null;
  private opened = false;
  /** What's kept, by key: its size and when it was last used (in the order it was read). */
  private readonly index = new Map<string, Entry>();
  private writing: Promise<void> = Promise.resolve();
  private indexTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly opts: PatchStoreOptions;
  private readonly prefix: string;

  constructor(opts: PatchStoreOptions) {
    this.opts = opts;
    this.budget = opts.budget;
    this.prefix = `/patches/${encodeURIComponent(opts.engine)}/`;
    this.ready = this.open();
  }

  /** Whether it has opened (till then nothing is known to be kept). */
  get loaded(): boolean {
    return this.opened;
  }

  /** Whether a patch is kept (as far as the index knows: a read may still find it gone). */
  has(key: string): boolean {
    return this.index.has(key);
  }

  get size(): number {
    return this.index.size;
  }

  /** A kept patch's channels (null: not kept, or not readable). */
  async get(key: string): Promise<Float32Array[] | null> {
    const entry = this.index.get(key);
    const cache = this.cache;
    if (!entry || !cache) return null;
    try {
      const res = await cache.match(this.urlOf(key));
      const channels = res ? unpackPatch(await res.arrayBuffer()) : null;
      if (!channels) {
        this.forget(key);
        return null;
      }
      entry.used = this.now();
      this.indexSoon();
      return channels;
    } catch {
      return null;
    }
  }

  /** Keep a patch (in turn with the others being written; the channels are read when its turn comes). */
  put(key: string, channels: readonly Float32Array[]): void {
    if (this.opened && !this.cache) return;
    const entry = this.index.get(key);
    if (entry) {
      entry.used = this.now();
      this.indexSoon();
      return;
    }
    this.writing = this.writing.then(() => this.write(key, channels));
  }

  /** Everything being written, written, and the index with it. */
  async flush(): Promise<void> {
    await this.writing;
    if (this.indexTimer) clearTimeout(this.indexTimer);
    this.indexTimer = null;
    await this.writeIndex();
  }

  private now(): number {
    return (this.opts.now ?? Date.now)();
  }

  private urlOf(key: string): string {
    return `${this.prefix}${encodeURIComponent(key)}`;
  }

  private get indexUrl(): string {
    return `${this.prefix}index`;
  }

  private async open(): Promise<void> {
    try {
      const caches = this.opts.caches === undefined ? (globalThis as { caches?: CachesLike }).caches : this.opts.caches;
      if (!caches || !this.opts.engine) return;
      try {
        const quota = (await (this.opts.estimate ?? browserEstimate)()).quota;
        if (quota && quota > 0) this.budget = Math.min(this.budget, Math.floor(quota / 4));
      } catch {
        // (the budget as given)
      }
      const cache = await caches.open(CACHE);
      const kept = parseIndex(await (await cache.match(this.indexUrl))?.text());
      // what another engine rendered goes, and anything the index doesn't know (written as the page closed)
      const here = new Set<string>();
      for (const req of await cache.keys()) {
        const path = new URL(req.url, 'http://local').pathname;
        if (path === this.indexUrl) continue;
        const key = path.startsWith(this.prefix) ? decodeURIComponent(path.slice(this.prefix.length)) : null;
        if (key !== null && kept.has(key)) here.add(key);
        else await cache.delete(req);
      }
      // (the least lately used first)
      for (const [key, entry] of [...kept].sort((a, b) => a[1].used - b[1].used)) {
        if (!here.has(key)) continue;
        this.index.set(key, entry);
        this.bytes += entry.bytes;
      }
      this.cache = cache;
      if (this.bytes > this.budget) await this.evict();
      if (here.size !== kept.size) this.indexSoon();
    } catch {
      this.cache = null;
      this.index.clear();
      this.bytes = 0;
    } finally {
      this.opened = true;
    }
  }

  private async write(key: string, channels: readonly Float32Array[]): Promise<void> {
    await this.ready;
    const cache = this.cache;
    if (!cache || this.index.has(key)) return;
    try {
      const packed = packPatch(channels);
      if (packed.byteLength > this.budget) return;
      await cache.put(this.urlOf(key), new Response(packed));
      this.index.set(key, { bytes: packed.byteLength, used: this.now() });
      this.bytes += packed.byteLength;
      await this.evict();
      this.indexSoon();
    } catch {
      // full, or refused: not kept
    }
  }

  /** Past the budget, the least lately used go (the one just kept is the most lately used). */
  private async evict(): Promise<void> {
    const cache = this.cache;
    if (!cache || this.bytes <= this.budget) return;
    const order = [...this.index].sort((a, b) => a[1].used - b[1].used);
    for (const [key] of order) {
      if (this.bytes <= this.budget) break;
      this.forget(key);
      try {
        await cache.delete(this.urlOf(key));
      } catch {
        // (the index no longer has it: it goes when the store next opens)
      }
    }
  }

  private forget(key: string): void {
    const entry = this.index.get(key);
    if (!entry) return;
    this.index.delete(key);
    this.bytes -= entry.bytes;
    this.indexSoon();
  }

  private indexSoon(): void {
    if (this.indexTimer || !this.cache) return;
    this.indexTimer = setTimeout(() => {
      this.indexTimer = null;
      this.writing = this.writing.then(() => this.writeIndex());
    }, INDEX_AFTER);
  }

  private async writeIndex(): Promise<void> {
    const cache = this.cache;
    if (!cache) return;
    try {
      const kept = [...this.index].map(([key, e]) => [key, e.bytes, e.used]);
      await cache.put(this.indexUrl, new Response(JSON.stringify({ v: 1, kept })));
    } catch {
      // (written again with the next change)
    }
  }
}

/** The index as kept: each patch's key, size and when it was last used (none when it isn't one). */
function parseIndex(text: string | undefined): Map<string, Entry> {
  const out = new Map<string, Entry>();
  if (!text) return out;
  try {
    const v = JSON.parse(text) as { v?: number; kept?: unknown };
    if (v.v !== 1 || !Array.isArray(v.kept)) return out;
    for (const row of v.kept) {
      if (!Array.isArray(row)) continue;
      const [key, bytes, used] = row as unknown[];
      if (typeof key === 'string' && typeof bytes === 'number' && typeof used === 'number' && bytes > 0)
        out.set(key, { bytes, used });
    }
  } catch {
    // (an index that isn't one: nothing known)
  }
  return out;
}

async function browserEstimate(): Promise<{ quota?: number }> {
  const storage = (globalThis as { navigator?: { storage?: { estimate?: () => Promise<{ quota?: number }> } } })
    .navigator?.storage;
  return storage?.estimate ? storage.estimate() : {};
}
