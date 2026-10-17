/**
 * Audio files for audio tracks: uploaded with the song, cached on the device, decoded at the
 * engine's rate, stretched when a region asks (in a worker), and handed to the audio thread. Each file
 * also gets its waveform peaks, for the regions to draw.
 */

import { encodeWav } from '@holo/engine';
import type { AudioClip, AudioFile } from '@holo/session';
import StretchWorker from './stretch.worker.ts?worker';

export { clipKey } from '@holo/engine';

const CACHE = 'holo-audio-v1';

export interface Peaks {
  /** Frames (at the decoded rate) per peak pair. */
  step: number;
  rate: number;
  min: Float32Array;
  max: Float32Array;
}

const fileUrl = (project: string, file: string) => `/api/projects/${project}/files/${file}`;

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

class AudioFiles {
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
    this.peaks.set(body.id, computePeaks(channelsOf(decoded), decoded.sampleRate));
    this.emit();
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
    this.peaks.set(body.id, computePeaks(channels, rate));
    this.emit();
    return { id: body.id, name, seconds: (channels[0]?.length ?? 0) / rate, rate, channels: channels.length };
  }

  /** A clip's audio at a context's rate (stretched if it asks), and its file's peaks on the way. */
  async load(
    project: string,
    clip: Pick<AudioClip, 'file' | 'stretch'>,
    ctx: BaseAudioContext,
  ): Promise<Float32Array[]> {
    const decoded = await ctx.decodeAudioData(await this.bytes(project, clip.file));
    if (!this.peaks.has(clip.file)) {
      this.peaks.set(clip.file, computePeaks(channelsOf(decoded), decoded.sampleRate));
      this.emit();
    }
    const channels = Array.from({ length: Math.min(2, decoded.numberOfChannels) }, (_, c) =>
      decoded.getChannelData(c).slice(),
    );
    if (Math.abs(clip.stretch - 1) < 1e-4) return channels;
    return stretchInWorker(channels, clip.stretch, decoded.sampleRate);
  }

  /** Peaks for drawing, fetching the file if this device hasn't yet. */
  ensurePeaks(project: string, file: string, ctx?: BaseAudioContext): void {
    if (this.peaks.has(file) || this.pending.has(file)) return;
    this.pending.add(file);
    const decoder = ctx ?? new OfflineAudioContext(1, 1, 48000);
    void this.bytes(project, file)
      .then((b) => decoder.decodeAudioData(b))
      .then((d) => {
        this.peaks.set(file, computePeaks(channelsOf(d), d.sampleRate));
        this.emit();
      })
      .catch(() => undefined)
      .finally(() => this.pending.delete(file));
  }
  private pending = new Set<string>();
}

export const audioFiles = new AudioFiles();
