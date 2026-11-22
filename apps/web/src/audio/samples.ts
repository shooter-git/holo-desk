/**
 * Sample packs: what the server has, and loading an instrument's samples into the audio thread.
 * Each file is fetched once and kept in the browser's cache storage, so the next session (or the
 * next device restart of the audio thread) loads from disk instead of the network.
 */

import {
  fadeTail,
  partialZone,
  playingExtras,
  type SampleFrames,
  type SamplerSpec,
  type SampleZone,
  synthExtras,
  type ZoneManifest,
  zoneExtras,
} from '@holo/engine';
import { type Instrument, type PackSound, type ParamDef, type SampleMic, samplerKnobs } from '@holo/session';
import { engine } from './engine.ts';
import { Turns } from './files.ts';
import { channelData, channelPcm, instrumentManifest, packFileData, pcm16, pcmChannel } from './pack-files.ts';
import { zonesForKeys } from './song-samples.ts';

/**
 * Sample files the decoder works on at once, the whole library over. Each leaves its decoded file
 * behind for the browser to clear away when it gets round to it, and a song opens many instruments
 * at once: unchecked, what's left over can be more than the samples kept (a phone's browser closes
 * the page).
 */
const decodes = new Turns(4);

export interface InstrumentSummary {
  name: string;
  title: string;
  category: string;
  zones: number;
  /** Megabytes the samples take on disk. */
  size: number;
  /** A kit (pads of its pieces, or one sound): it has Tune and Decay knobs. */
  kit?: boolean;
  /** The microphones it was recorded with: a level knob for each. */
  mics?: SampleMic[];
  /** It plays through a built-in synth (Prism): that synth's window, not the sampler's. */
  synth?: string;
}

export interface PackSummary {
  id: string;
  name: string;
  license: string;
  credit: string;
  /** Where its samples came from: `imported` for a pack of your own. */
  source?: { kind: string };
  /** Its folder's size on disk (what removing it frees). */
  bytes?: number;
  instruments: InstrumentSummary[];
  /** Impulse responses for Space Designer. */
  impulses?: { name: string; title: string; seconds: number | null }[];
  /** A palette's ready-made sounds, the packs they play, and what it is in a line. */
  sounds?: PackSound[];
  requires?: string[];
  description?: string;
}

export type LoadState =
  | { state: 'loading'; done: number; total: number }
  | { state: 'ready' }
  | { state: 'error'; message: string };

/**
 * An instrument loaded in part (a song's samples first, on a phone): the zones that have come, by
 * their place in the instrument, and the rate they were loaded at.
 */
interface Part {
  rate: number;
  zones: Map<number, SampleZone>;
  spec: Omit<SamplerSpec, 'zones'>;
  /** Zones that came while the song played, not yet handed over (that would cut what rings). */
  waiting: boolean;
}

export class SampleLibrary {
  packs: PackSummary[] = [];
  readonly states = new Map<string, LoadState>();
  private loading = new Map<string, Promise<void>>();
  private listeners = new Set<() => void>();
  /** Instruments loaded in part, and the keys asked of each (null: the whole of it). */
  private parts = new Map<string, Part>();
  private asked = new Map<string, Set<number> | null>();

  constructor() {
    engine.onRestart((keys) => {
      for (const key of keys) {
        this.loading.delete(key);
        // (samples are at the rate they came at: at another, the song's are loaded again)
        const part = this.parts.get(key);
        if (part && part.rate !== engine.sampleRate) this.parts.delete(key);
        const asked = this.asked.get(key);
        this.asked.delete(key);
        const [pack, ...rest] = key.split('/');
        void this.ensure(pack ?? '', rest.join('/'), 1, asked ?? undefined);
      }
    });
    // let go by the engine (no track plays them): loaded again when one does
    engine.onForget((keys) => {
      for (const key of keys) {
        this.states.delete(key);
        this.loading.delete(key);
        this.parts.delete(key);
        this.asked.delete(key);
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
   * played). With `keys`, only the samples that play them (each key's own and those beside it):
   * more come as more keys are asked for, and a key not loaded plays the nearest samples there are.
   */
  ensure(pack: string, name: string, priority = 1, keys?: ReadonlySet<number>): Promise<void> {
    const key = `${pack}/${name}`;
    const asked = this.asked.get(key);
    // nothing new asked of what's there or on its way
    if (asked === null || (asked && keys && [...keys].every((k) => asked.has(k))))
      return this.loading.get(key) ?? Promise.resolve();
    if (asked === undefined && !keys && engine.hasSampler(key) && !this.parts.has(key)) return Promise.resolve();
    this.asked.set(key, keys ? new Set([...(asked ?? []), ...keys]) : null);
    // (one load at a time for an instrument: a later ask waits for the one before)
    const before = this.loading.get(key) ?? Promise.resolve();
    const p: Promise<void> = before
      .then(() => this.load(pack, name, priority))
      .catch((err: unknown) => {
        this.states.set(key, { state: 'error', message: err instanceof Error ? err.message : String(err) });
        this.emit();
      })
      .finally(() => {
        if (this.loading.get(key) === p) this.loading.delete(key);
        // (what's still on its way is read from here: say so once this one isn't)
        this.emitSoon();
      });
    this.loading.set(key, p);
    return p;
  }

  private async load(pack: string, name: string, priority: number): Promise<void> {
    const key = `${pack}/${name}`;
    const ctx = engine.ctx;
    if (!ctx) throw new Error('Start the audio first');
    const asked = this.asked.get(key);
    if (asked === undefined) return;
    let part = this.parts.get(key);
    if (part && part.rate !== ctx.sampleRate) {
      this.parts.delete(key);
      part = undefined;
    }
    // (there whole already: nothing to come)
    if (asked === null && !part && engine.hasSampler(key)) return;
    // the zones still to come: those of the keys asked for (all of them, for the whole instrument)
    const manifest = await instrumentManifest(pack, name);
    const want = asked === null ? manifest.zones.map((_, i) => i) : [...zonesForKeys(manifest.zones, asked)];
    const only = want.filter((i) => !part?.zones.has(i));
    // nothing new to fetch: done, unless it has no samples at all (a synth's patch, all its sources
    // drawn) and the audio thread hasn't had it yet: it goes over as it is, its patch in its params
    if (!only.length && (manifest.zones.length > 0 || engine.hasSampler(key))) return;
    const had = part?.zones.size ?? 0;
    const progress = (done: number, total: number) => {
      this.states.set(key, { state: 'loading', done: had + done, total: had + total });
      this.emitSoon();
    };
    const { indices, zones, ...rest } = await this.build(pack, name, ctx, progress, priority, only);
    // what came joins what had (if any), in the instrument's order
    let all = zones;
    if (part || asked !== null) {
      const p = part ?? { rate: ctx.sampleRate, zones: new Map<number, SampleZone>(), spec: rest, waiting: false };
      for (const [i, at] of indices.entries()) p.zones.set(at, zones[i] as SampleZone);
      all = [...p.zones.keys()].sort((x, y) => x - y).map((i) => p.zones.get(i) as SampleZone);
      if (asked === null) this.parts.delete(key);
      else this.parts.set(key, p);
      // (handing an instrument over again starts it afresh: while the song plays, what rings would stop)
      if (asked !== null && engine.hasSampler(key) && engine.playing) {
        this.handOverLater(key);
        return;
      }
    }
    // (the audio thread's rate changed while they came: they're on their way again, at the new one)
    if (!engine.addSampler({ ...rest, zones: all }, ctx.sampleRate)) return;
    this.states.set(key, { state: 'ready' });
    this.emit();
  }

  /** Instruments whose samples are on their way. */
  get pending(): number {
    return this.loading.size;
  }

  /** A part's new zones handed over once the song stops. */
  private handOverLater(key: string): void {
    const part = this.parts.get(key);
    if (!part || part.waiting) return;
    part.waiting = true;
    const look = () => {
      const p = this.parts.get(key);
      if (p !== part) return;
      if (engine.playing) {
        setTimeout(look, 500);
        return;
      }
      part.waiting = false;
      if (part.rate !== engine.sampleRate) return;
      const zones = [...part.zones.keys()].sort((a, b) => a - b).map((i) => part.zones.get(i) as SampleZone);
      if (engine.addSampler({ ...part.spec, zones }, part.rate)) this.states.set(key, { state: 'ready' });
      this.emit();
    };
    setTimeout(look, 500);
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
    only?: readonly number[],
  ): Promise<SamplerSpec & { indices: number[] }> {
    const key = `${pack}/${name}`;
    const manifest = await instrumentManifest(pack, name);
    // (`only`: those zones, by their place in the instrument; the spec lists them in that order)
    const indices = only ? [...only].sort((a, b) => a - b) : manifest.zones.map((_, i) => i);
    const total = indices.length;
    let done = 0;
    progress?.(done, total);
    const zones: SampleZone[] = new Array(total);
    // zones that play the same stretch of the same file (a drum on two pads) share one copy
    const shared = new Map<string, Promise<{ left: SampleFrames; right: SampleFrames | null; k: number }>>();
    const load = (z: ZoneManifest) => {
      const key = `${z.file}|${z.start}|${z.end}|${z.fadeOut ?? 0}`;
      let p = shared.get(key);
      if (!p) {
        p = (async () => {
          const bytes = await packFileData(pack, z.file, priority);
          // (read before decoding: the decoder takes the bytes)
          const wav = pcm16(bytes);
          let left: SampleFrames;
          let right: SampleFrames | null;
          let k: number;
          if (wav && wav.rate === ctx.sampleRate && z.rate === wav.rate) {
            // 16-bit at the context's own rate: its frames as they are, with nothing decoded (and
            // nothing left over for the browser to clear away)
            k = 1;
            const start = Math.max(0, Math.round(z.start));
            const end = Math.min(wav.frames, z.end > 0 ? Math.round(z.end) : wav.frames);
            left = pcmChannel(bytes, wav, 0, start, end);
            right = wav.channels > 1 ? pcmChannel(bytes, wav, 1, start, end) : null;
          } else {
            const audio = await decodes.run(() => ctx.decodeAudioData(bytes));
            // the decoder resampled to the context's rate: move the manifest's frames with it
            k = audio.sampleRate / z.rate;
            const start = Math.max(0, Math.round(z.start * k));
            const end = Math.min(audio.length, z.end > 0 ? Math.round(z.end * k) : audio.length);
            // (in shared memory where the page has it: the audio thread and the workers play the one
            // copy; a sample that was 16-bit stays 16-bit, at half a float's memory)
            const take = wav ? channelPcm : channelData;
            left = take(audio, 0, start, end);
            right = audio.numberOfChannels > 1 ? take(audio, 1, start, end) : null;
          }
          if (z.fadeOut) {
            fadeTail(left, Math.round(z.fadeOut * k));
            if (right) fadeTail(right, Math.round(z.fadeOut * k));
          }
          return { left, right, k };
        })();
        shared.set(key, p);
      }
      return p;
    };
    let next = 0;
    const worker = async () => {
      while (next < total) {
        const index = next++;
        const z = manifest.zones[indices[index] as number] as ZoneManifest;
        if (z.partials) {
          // a partial set for a synth's source: data, not audio
          const zone = partialZone(z, new Uint8Array(await packFileData(pack, z.file, priority)));
          if (!zone) throw new Error(`${z.file} isn't a partial set`);
          zones[index] = zone;
          done++;
          progress?.(done, total);
          continue;
        }
        const { left, right, k } = await load(z);
        const start = Math.max(0, Math.round(z.start * k));
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
          ...zoneExtras(z),
        };
        done++;
        progress?.(done, total);
      }
    };
    await Promise.all(Array.from({ length: Math.min(8, total) }, worker));
    return {
      key,
      zones,
      indices,
      release: manifest.release,
      oneShot: manifest.oneShot,
      pitched: manifest.pitched !== false,
      velocityRange: manifest.velocityRange,
      attack: manifest.attack,
      ...playingExtras(manifest),
      ...synthExtras(manifest),
    };
  }
}

export const library = new SampleLibrary();

/**
 * A sampler instrument's knobs (a level for each microphone it was recorded with, a kit's tune and
 * decay), from what the library knows of it: none for one without them, or not installed.
 */
export function samplerKnobDefs(i: Instrument, packs: PackSummary[] = library.packs): ParamDef[] | null {
  if (i.type !== 'sampler') return null;
  const summary = packs.find((p) => p.id === i.pack)?.instruments.find((x) => x.name === i.name);
  if (!summary || (!summary.kit && !summary.mics?.length)) return null;
  return samplerKnobs(summary.mics);
}
