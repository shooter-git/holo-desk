/**
 * Audio files for audio tracks: uploaded with the song, cached on the device, decoded at the
 * engine's rate, stretched when a region asks (in a worker), and handed to the audio thread. Each file
 * also gets its waveform peaks, for the regions to draw.
 */

import { encodeWav } from '@holo/engine';
import type { AudioClip, AudioFile } from '@holo/session';
import StretchWorker from './stretch.worker.ts?worker';

export { clipKey } from '@holo/engine';

export const CACHE = 'holo-audio-v1';

export interface Peaks {
  /** Frames (at the decoded rate) per peak pair. */
  step: number;
  rate: number;
  min: Float32Array;
  max: Float32Array;
}

const fileUrl = (project: string, file: string) => `/api/projects/${project}/files/${file}`;
/** Where a file's peaks are kept in the device's cache (never fetched: no such address on the server). */
const peaksUrl = (project: string, file: string) => `${fileUrl(project, file)}?peaks=1`;

let worker: Worker | null = null;
let jobs = 0;
const waiting = new Map<number, (c: Float32Array[]) => void>();

function stretchInWorker(channels: Float32Array[], ratio: number, sr: number): Promise<Float32Array[]> {
  if (!worker) {
    worker = new StretchWorker();
    worker.onmessage = (e: MessageEvent<{ id: number; channels: Float32Array[] }>) => {
      waiting.get(e.data.id)?.(e.data.channels);
      waiting.delete(e.data.id);
    };
  }
  const id = ++jobs;
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker?.postMessage(
      { id, channels, ratio, sr },
      channels.map((c) => c.buffer as ArrayBuffer),
    );
  });
}

function computePeaks(chans: Float32Array[], rate: number, step = 256): Peaks {
  const length = chans[0]?.length ?? 0;
  const n = Math.ceil(length / step);
  const min = new Float32Array(n);
  const max = new Float32Array(n);
  for (let p = 0; p < n; p++) {
    let lo = 0;
    let hi = 0;
    const end = Math.min(length, (p + 1) * step);
    for (const ch of chans) {
      for (let i = p * step; i < end; i++) {
        const v = ch[i] as number;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min[p] = lo;
    max[p] = hi;
  }
  return { step, rate, min, max };
}

const channelsOf = (b: AudioBuffer) => Array.from({ length: b.numberOfChannels }, (_, c) => b.getChannelData(c));

/**
 * How much audio is decoded at once, in seconds of one channel: about five stereo minutes. A file
 * being decoded is held several times over for a moment (its bytes, its samples, the engine's copy),
 * and a song may have dozens: short clips go many at a time, long takes one or two.
 */
const DECODING_AT_ONCE = 1000;

/** Jobs as many at a time as their weights allow (one at least, whatever it weighs), in the order they came. */
export class Turns {
  private running = 0;
  private weight = 0;
  private readonly waiting: { weight: number; start: () => void }[] = [];
  private readonly room: number;
  constructor(room: number) {
    this.room = room;
  }
  run<T>(job: () => Promise<T>, weight = 1): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const start = () => {
        this.running++;
        this.weight += weight;
        (async () => job())()
          .then(resolve, reject)
          .finally(() => {
            this.running--;
            this.weight -= weight;
            this.next();
          });
      };
      this.waiting.push({ weight, start });
      this.next();
    });
  }
  private next(): void {
    while (this.waiting.length) {
      const first = this.waiting[0] as { weight: number; start: () => void };
      if (this.running > 0 && this.weight + first.weight > this.room) return;
      this.waiting.shift();
      first.start();
    }
  }
}

/** Peaks as bytes, to keep beside the file on the device: [step, rate, count], the minima, the maxima. */
export function peaksToBytes(p: Peaks): ArrayBuffer {
  const out = new Float32Array(3 + p.min.length * 2);
  out[0] = p.step;
  out[1] = p.rate;
  out[2] = p.min.length;
  out.set(p.min, 3);
  out.set(p.max, 3 + p.min.length);
  return out.buffer;
}

/** The peaks those bytes hold (null when they aren't peaks). */
export function peaksFromBytes(bytes: ArrayBuffer): Peaks | null {
  if (bytes.byteLength < 12 || bytes.byteLength % 4) return null;
  const all = new Float32Array(bytes);
  const step = all[0] as number;
  const rate = all[1] as number;
  const n = all[2] as number;
  if (!(step >= 1) || !(rate > 0) || !Number.isInteger(n) || all.length !== 3 + n * 2) return null;
  return { step, rate, min: all.slice(3, 3 + n), max: all.slice(3 + n) };
}

/** A channel copied once, into shared memory when every engine is to read the one copy. */
function copyOf(c: Float32Array, shared: boolean): Float32Array {
  if (!shared) return c.slice();
  const out = new Float32Array(new SharedArrayBuffer(c.byteLength));
  out.set(c);
  return out;
}

export class AudioFiles {
  readonly peaks = new Map<string, Peaks>();
  private listeners = new Set<() => void>();
  version = 0;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  private emit(): void {
    this.version++;
    for (const fn of this.listeners) fn();
  }

  private async bytes(project: string, file: string): Promise<ArrayBuffer> {
    const url = fileUrl(project, file);
    const cache = 'caches' in globalThis ? await caches.open(CACHE).catch(() => null) : null;
    let res = cache ? await cache.match(url) : undefined;
    if (!res) {
      res = await fetch(url);
      if (!res.ok) throw new Error(`Missing audio file ${file}`);
      if (cache) await cache.put(url, res.clone()).catch(() => undefined);
    }
    return res.arrayBuffer();
  }

  /**
   * Upload a file to the song. It's decoded first (to know its length and draw it), and its bytes go
   * straight into this device's cache, so it never needs fetching back.
   */
  async upload(project: string, blob: Blob, name: string, ctx: BaseAudioContext): Promise<AudioFile> {
    let data = await blob.arrayBuffer();
    const decoded = await ctx.decodeAudioData(data.slice(0)).catch(() => {
      throw new Error(`This browser can’t read ${name}: try WAV, FLAC, MP3 or Ogg`);
    });
    // a song keeps its audio as WAV, so every renderer (here, a bounce, a headless render) reads the
    // same numbers; anything else is kept as this browser decoded it, in 32-bit float
    const isWav = new TextDecoder().decode(new Uint8Array(data, 0, Math.min(12, data.byteLength))).startsWith('RIFF');
    let stored = name;
    if (!isWav) {
      data = encodeWav(channelsOf(decoded), decoded.sampleRate, 'float32').buffer as ArrayBuffer;
      stored = `${name.replace(/\.[^.]+$/, '')}.wav`;
    }
    const res = await fetch(`/api/projects/${project}/files?name=${encodeURIComponent(stored)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-holo-audio' },
      body: data,
    });
    // WAV and FLAC come back with their own length, rate and channels (decoding gives the device's rate)
    const body = (await res.json()) as {
      id?: string;
      error?: string;
      seconds?: number;
      rate?: number;
      channels?: number;
    };
    if (!res.ok || !body.id) throw new Error(body.error ?? 'The upload failed');
    try {
      const cache = await caches.open(CACHE);
      await cache.put(fileUrl(project, body.id), new Response(data));
    } catch {
      // fetched again when needed
    }
    const peaks = computePeaks(channelsOf(decoded), decoded.sampleRate);
    this.peaks.set(body.id, peaks);
    this.emit();
    void this.keepPeaks(project, body.id, peaks);
    return {
      id: body.id,
      name,
      seconds: body.seconds ?? decoded.duration,
      rate: body.rate ?? decoded.sampleRate,
      channels: body.channels ?? decoded.numberOfChannels,
    };
  }

  /** A recording, uploaded as it was captured (32-bit float, nothing lost). */
  async uploadRecording(project: string, channels: Float32Array[], rate: number, name: string): Promise<AudioFile> {
    const wav = new Blob([encodeWav(channels, rate, 'float32') as BlobPart], { type: 'audio/wav' });
    const res = await fetch(`/api/projects/${project}/files?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-holo-audio' },
      body: wav,
    });
    const body = (await res.json()) as { id?: string; error?: string };
    if (!res.ok || !body.id) throw new Error(body.error ?? 'The recording couldn’t be saved');
    try {
      const cache = await caches.open(CACHE);
      await cache.put(fileUrl(project, body.id), new Response(wav));
    } catch {
      // fetched again when needed
    }
    const peaks = computePeaks(channels, rate);
    this.peaks.set(body.id, peaks);
    this.emit();
    void this.keepPeaks(project, body.id, peaks);
    return { id: body.id, name, seconds: (channels[0]?.length ?? 0) / rate, rate, channels: channels.length };
  }

  /**
   * A file decoded at a context's rate: once for everyone who asks while it's on its way (the engine
   * for its clips, the screen for its waveform), a few files at a time, and not kept afterwards (the
   * engine has its copy). Its peaks are taken on the way, and kept on the device.
   */
  private decode(project: string, file: string, ctx: BaseAudioContext): Promise<AudioBuffer> {
    const key = `${file}@${ctx.sampleRate}`;
    let job = this.decoding.get(key);
    if (!job) {
      // (a file of unknown length waits for the others and goes alone)
      job = this.turns
        .run(async () => {
          const decoded = await ctx.decodeAudioData(await this.bytes(project, file));
          if (!this.peaks.has(file)) {
            const peaks = computePeaks(channelsOf(decoded), decoded.sampleRate);
            this.peaks.set(file, peaks);
            this.emitSoon();
            void this.keepPeaks(project, file, peaks);
          }
          return decoded;
        }, this.sizes.get(file) ?? DECODING_AT_ONCE)
        .finally(() => this.decoding.delete(key));
      this.decoding.set(key, job);
    }
    return job;
  }
  private readonly decoding = new Map<string, Promise<AudioBuffer>>();
  private readonly turns = new Turns(DECODING_AT_ONCE);
  /** Each file's length in seconds of one channel, as the song says (know). */
  private readonly sizes = new Map<string, number>();

  /** The song's files and how long each is: what decides how many are decoded at once. */
  know(files: readonly AudioFile[]): void {
    for (const f of files) this.sizes.set(f.id, Math.max(1, f.seconds * f.channels));
  }

  /** Tell whoever draws that peaks have come: once for those that arrive together. */
  private emitSoon(): void {
    if (this.emitting) return;
    this.emitting = true;
    setTimeout(() => {
      this.emitting = false;
      this.emit();
    }, 60);
  }
  private emitting = false;

  /**
   * A clip's audio at a context's rate (stretched if it asks), and its file's peaks on the way.
   * `shared`: in shared memory, copied there straight from the decoder (for engines that all read
   * the one copy).
   */
  async load(
    project: string,
    clip: Pick<AudioClip, 'file' | 'stretch'>,
    ctx: BaseAudioContext,
    shared = false,
  ): Promise<Float32Array[]> {
    const decoded = await this.decode(project, clip.file, ctx);
    const plain = Math.abs(clip.stretch - 1) < 1e-4;
    const channels = Array.from({ length: Math.min(2, decoded.numberOfChannels) }, (_, c) =>
      copyOf(decoded.getChannelData(c), shared && plain),
    );
    if (plain) return channels;
    return stretchInWorker(channels, clip.stretch, decoded.sampleRate);
  }

  /**
   * Peaks for drawing: as kept on this device from the last time, else taken from the file (the
   * engine's own decoding of it when that's on its way or can be; before the audio starts, one of
   * its own).
   */
  ensurePeaks(project: string, file: string, ctx?: BaseAudioContext): void {
    if (this.peaks.has(file) || this.pending.has(file)) return;
    this.pending.add(file);
    void this.keptPeaks(project, file)
      .then(async (kept) => {
        if (this.peaks.has(file)) return;
        if (kept) {
          this.peaks.set(file, kept);
          this.emitSoon();
          return;
        }
        // (decode takes the peaks on its way)
        await this.decode(project, file, ctx ?? new OfflineAudioContext(1, 1, 48000));
      })
      .catch(() => undefined)
      .finally(() => this.pending.delete(file));
  }
  private pending = new Set<string>();

  private async keptPeaks(project: string, file: string): Promise<Peaks | null> {
    if (!('caches' in globalThis)) return null;
    try {
      const res = await (await caches.open(CACHE)).match(peaksUrl(project, file));
      return res ? peaksFromBytes(await res.arrayBuffer()) : null;
    } catch {
      return null;
    }
  }

  private async keepPeaks(project: string, file: string, peaks: Peaks): Promise<void> {
    if (!('caches' in globalThis)) return;
    try {
      await (await caches.open(CACHE)).put(peaksUrl(project, file), new Response(peaksToBytes(peaks)));
    } catch {
      // taken from the file again next time
    }
  }
}

export const audioFiles = new AudioFiles();
