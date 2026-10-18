/**
 * Sample packs: what the server has, and loading an instrument's samples into the audio thread.
 * Each file is fetched once and kept in the browser's cache storage, so the next session (or the
 * next device restart of the audio thread) loads from disk instead of the network.
 */

import type { SamplerSpec, SampleZone, ZoneManifest } from '@holo/engine';
import { engine } from './engine.ts';
import { channelData, instrumentManifest, packFileData } from './pack-files.ts';

export interface InstrumentSummary {
  name: string;
  title: string;
  category: string;
  zones: number;
  /** Megabytes the samples take on disk. */
  size: number;
}

export interface PackSummary {
  id: string;
  name: string;
  license: string;
  credit: string;
  instruments: InstrumentSummary[];
  /** Impulse responses for Space Designer. */
  impulses?: { name: string; title: string; seconds: number | null }[];
}

export type LoadState =
  | { state: 'loading'; done: number; total: number }
  | { state: 'ready' }
  | { state: 'error'; message: string };

export class SampleLibrary {
  packs: PackSummary[] = [];
  readonly states = new Map<string, LoadState>();
  private loading = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();

  constructor() {
    engine.onRestart((keys) => {
      for (const key of keys) {
        this.loading.delete(key);
        const [pack, ...rest] = key.split('/');
        void this.ensure(pack ?? '', rest.join('/'));
      }
    });
    // let go by the engine (no track plays them): loaded again when one does
    engine.onForget((keys) => {
      for (const key of keys) {
        this.states.delete(key);
        this.loading.delete(key);
      }
      this.emit();
    });
  }

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /** Goes up whenever anything here changes (for the screen to follow). */
  version = 0;

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  /** Once a frame at most: a load's progress comes file by file, and the screen needn't follow each. */
  private emitDue = false;
  private emitSoon(): void {
    if (this.emitDue) return;
    this.emitDue = true;
    const flush = () => {
      this.emitDue = false;
      this.emit();
    };
    if (typeof requestAnimationFrame === 'function') requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  async refresh(): Promise<void> {
    try {
      const res = await fetch('/api/packs');
      if (res.ok) this.packs = (await res.json()) as PackSummary[];
    } catch {
      this.packs = [];
    }
    this.emit();
  }

  state(pack: string, name: string): LoadState | undefined {
    return this.states.get(`${pack}/${name}`);
  }

  /**
   * Load an instrument into the audio thread unless it's there already (or on its way). Files are
   * fetched a few at a time the library over, the lowest `priority` first (0: the track about to be
   * played).
   */
  ensure(pack: string, name: string, priority = 1): Promise<void> {
    const key = `${pack}/${name}`;
    if (engine.hasSampler(key)) return Promise.resolve();
    let p = this.loading.get(key);
    if (!p) {
      p = this.load(pack, name, priority).catch((err: unknown) => {
        this.states.set(key, { state: 'error', message: err instanceof Error ? err.message : String(err) });
        this.loading.delete(key);
        this.emit();
      });
      this.loading.set(key, p);
    }
    return p;
  }

  private async load(pack: string, name: string, priority: number): Promise<void> {
    const key = `${pack}/${name}`;
    const ctx = engine.ctx;
    if (!ctx) throw new Error('Start the audio first');
    const spec = await this.build(
      pack,
      name,
      ctx,
      (done, total) => {
        this.states.set(key, { state: 'loading', done, total });
        this.emitSoon();
      },
      priority,
    );
    engine.addSampler(spec);
    this.states.set(key, { state: 'ready' });
    this.loading.delete(key);
    this.emit();
  }

  /**
   * An instrument's samples, decoded at a context's rate and trimmed to their measured start and
   * end (from the device's cache when it has them). Used for the live engine and for bouncing.
   */
  async build(
    pack: string,
    name: string,
    ctx: BaseAudioContext,
    progress?: (done: number, total: number) => void,
    priority = 1,
  ): Promise<SamplerSpec> {
    const key = `${pack}/${name}`;
    const manifest = await instrumentManifest(pack, name);
    const total = manifest.zones.length;
    let done = 0;
    progress?.(done, total);
    const zones: SampleZone[] = new Array(total);
    let next = 0;
    const worker = async () => {
      while (next < total) {
        const index = next++;
        const z = manifest.zones[index] as ZoneManifest;
        const audio = await ctx.decodeAudioData(await packFileData(pack, z.file, priority));
        // the decoder resampled to the context's rate: move the manifest's frames with it
        const k = audio.sampleRate / z.rate;
        const start = Math.max(0, Math.round(z.start * k));
        const end = Math.min(audio.length, z.end > 0 ? Math.round(z.end * k) : audio.length);
        // (in shared memory where the page has it: the audio thread and the workers play the one copy)
        const left = channelData(audio, 0, start, end);
        const right = audio.numberOfChannels > 1 ? channelData(audio, 1, start, end) : null;
        zones[index] = {
          left,
          right,
          root: z.root,
          lo: z.lo,
          hi: z.hi,
          lovel: z.lovel,
          hivel: z.hivel,
          gain: 10 ** (z.gain / 20),
          loopStart: z.loopEnd > z.loopStart ? Math.max(0, Math.round(z.loopStart * k) - start) : 0,
          loopEnd: z.loopEnd > z.loopStart ? Math.max(0, Math.round(z.loopEnd * k) - start) : 0,
          rr: z.rr,
        };
        done++;
        progress?.(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, total) }, worker));
    return {
      key,
      zones,
      release: manifest.release,
      oneShot: manifest.oneShot,
      pitched: manifest.pitched !== false,
      velocityRange: manifest.velocityRange,
      attack: manifest.attack,
    };
  }
}

export const library = new SampleLibrary();
