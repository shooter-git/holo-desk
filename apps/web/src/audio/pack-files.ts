/**
 * Pack files the studio fetches: an instrument's manifest (with its Performance data), and sample
 * files, each fetched once and kept in the browser's cache storage (so the next session, or the
 * next restart of the audio thread, loads from disk instead of the network), decoded once each at
 * the context's rate.
 */
import type { InstrumentManifest } from '@holo/engine';

const CACHE = 'holo-samples-v1';

/** Sample files on their way at once, the whole library over (a song opens many instruments at once). */
const IN_FLIGHT = 6;

/** A sample file decoded at a context's rate, by pack and file (Performance instruments share them). */
const decoded = new Map<string, Promise<[Float32Array, Float32Array]>>();

/** An instrument's map as the studio reads it: what the engine plays, and what the studio shows of it. */
export type InstrumentMap = InstrumentManifest & {
  /** Its name in the Library ("Rock Kit"). */
  title?: string;
};

/** An instrument's manifest (with its Performance data), fetched once. */
const manifests = new Map<string, Promise<InstrumentMap>>();

export function instrumentManifest(pack: string, name: string): Promise<InstrumentMap> {
  const key = `${pack}/${name}`;
  let m = manifests.get(key);
  if (!m) {
    m = fetch(`/api/packs/${encodeURIComponent(pack)}/instruments/${encodeURIComponent(name)}`).then((res) => {
      if (!res.ok) throw new Error(`No instrument ${key} (${res.status})`);
      return res.json() as Promise<InstrumentMap>;
    });
    m.then(
      (map) => known.set(key, map),
      () => manifests.delete(key),
    );
    manifests.set(key, m);
  }
  return m;
}

/** The manifests that have come, for what can't wait for one. */
const known = new Map<string, InstrumentMap>();

/** An instrument's manifest if it has been fetched already (null: not yet, or never asked for). */
export function instrumentManifestNow(pack: string, name: string): InstrumentMap | null {
  return known.get(`${pack}/${name}`) ?? null;
}

let inFlight = 0;
const waiting: { priority: number; start: () => void }[] = [];

/** A turn to fetch a file, the lowest priority number first; the turn is given back by calling what resolves. */
function turn(priority: number): Promise<() => void> {
  return new Promise((resolve) => {
    const release = () => {
      inFlight--;
      if (inFlight >= IN_FLIGHT || !waiting.length) return;
      let best = 0;
      for (let i = 1; i < waiting.length; i++)
        if ((waiting[i] as { priority: number }).priority < (waiting[best] as { priority: number }).priority) best = i;
      waiting.splice(best, 1)[0]?.start();
    };
    const start = () => {
      inFlight++;
      resolve(release);
    };
    if (inFlight < IN_FLIGHT) start();
    else waiting.push({ priority, start });
  });
}

/** A pack's file, from the device's cache when it has it (else fetched and kept there). */
/** Let go of a pack's files kept on this device (it was removed): how many went. */
export async function forgetPackFiles(pack: string): Promise<number> {
  if (!('caches' in globalThis)) return 0;
  try {
    const cache = await caches.open(CACHE);
    const prefix = `/packs/${encodeURIComponent(pack)}/`;
    let n = 0;
    for (const req of await cache.keys()) {
      if (new URL(req.url).pathname.startsWith(prefix) && (await cache.delete(req))) n++;
    }
    return n;
  } catch {
    return 0;
  }
}

export async function packFileData(pack: string, file: string, priority = 1): Promise<ArrayBuffer> {
  const url = `/packs/${encodeURIComponent(pack)}/files/${file.split('/').map(encodeURIComponent).join('/')}`;
  const release = await turn(priority);
  try {
    const cache = 'caches' in globalThis ? await caches.open(CACHE).catch(() => null) : null;
    let response = cache ? await cache.match(url) : undefined;
    if (!response) {
      response = await fetch(url);
      if (!response.ok) throw new Error(`Missing sample ${file}`);
      if (cache) await cache.put(url, response.clone()).catch(() => undefined);
    }
    return await response.arrayBuffer();
  } finally {
    release();
  }
}

/** Where a 16-bit PCM WAV keeps its frames (null for any other file). */
export interface Pcm16 {
  rate: number;
  channels: number;
  /** The byte its first frame starts at. */
  offset: number;
  frames: number;
}

/**
 * A 16-bit PCM WAV's layout, read from its header (plain or "extensible"): its frames can be taken
 * as they are, with nothing decoded.
 */
export function pcm16(data: ArrayBuffer): Pcm16 | null {
  const bytes = new Uint8Array(data);
  const view = new DataView(data);
  const tag = (at: number) => String.fromCharCode(...bytes.subarray(at, at + 4));
  if (bytes.length < 12 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let at = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let body: [number, number] | null = null;
  while (at + 8 <= bytes.length) {
    const id = tag(at);
    const size = view.getUint32(at + 4, true);
    const start = at + 8;
    if (id === 'fmt ' && start + 16 <= bytes.length) {
      format = view.getUint16(start, true);
      channels = view.getUint16(start + 2, true);
      rate = view.getUint32(start + 4, true);
      bits = view.getUint16(start + 14, true);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format's first two bytes
      if (format === 0xfffe && size >= 26 && start + 26 <= bytes.length) format = view.getUint16(start + 24, true);
    } else if (id === 'data') {
      body = [start, Math.min(size, bytes.length - start)];
      break;
    }
    at = start + size + (size & 1);
  }
  if (format !== 1 || bits !== 16 || !body || channels < 1 || !rate) return null;
  return { rate, channels, offset: body[0], frames: Math.floor(body[1] / (2 * channels)) };
}

/** Frames as 16-bit PCM: in shared memory where the page has it (every thread plays the one copy). */
function int16(frames: number): Int16Array {
  const n = Math.max(0, frames);
  return globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined'
    ? new Int16Array(new SharedArrayBuffer(n * 2))
    : new Int16Array(n);
}

/** One channel's frames from `start` to `end`, taken straight from a 16-bit WAV's bytes. */
export function pcmChannel(data: ArrayBuffer, wav: Pcm16, channel: number, start: number, end: number): Int16Array {
  const from = Math.max(0, Math.min(start, wav.frames));
  const to = Math.max(from, Math.min(end, wav.frames));
  const out = int16(to - from);
  const view = new DataView(data);
  const stride = wav.channels * 2;
  let p = wav.offset + from * stride + channel * 2;
  for (let i = 0; i < out.length; i++, p += stride) out[i] = view.getInt16(p, true);
  return out;
}

/**
 * A stretch of a decoded channel as 16-bit PCM, for a sample that was 16-bit before the decoder
 * brought it to the context's rate: half a float's memory, and the rounding no louder than the
 * file's own.
 */
export function channelPcm(audio: AudioBuffer, channel: number, start: number, end: number): Int16Array {
  const data = audio.getChannelData(channel);
  const from = Math.max(0, Math.min(start, data.length));
  const to = Math.max(from, Math.min(end, data.length));
  const out = int16(to - from);
  for (let i = 0; i < out.length; i++) {
    const v = Math.round((data[from + i] as number) * 32768);
    out[i] = v > 32767 ? 32767 : v < -32768 ? -32768 : v;
  }
  return out;
}

/**
 * A stretch of a decoded channel: in shared memory where the page has it (the audio thread and the
 * workers then play the one copy, which outlives them), else a copy of its own.
 */
export function channelData(audio: AudioBuffer, channel: number, start: number, end: number): Float32Array {
  const data = audio.getChannelData(channel);
  if (globalThis.crossOriginIsolated === true && typeof SharedArrayBuffer !== 'undefined') {
    const out = new Float32Array(new SharedArrayBuffer(Math.max(0, end - start) * 4));
    out.set(data.subarray(start, end));
    return out;
  }
  return data.slice(start, end);
}

/** Lets go of a pack's decoded sample files, at every rate (a Performance instrument no part plays any more). */
export function forgetSampleFiles(pack: string, files: Iterable<string>): void {
  const names = new Set([...files].map((f) => `${pack}/${f}`));
  for (const key of [...decoded.keys()]) if (names.has(key.slice(0, key.lastIndexOf('@')))) decoded.delete(key);
}

/** A pack's sample file, decoded (the decoder resamples it to the context's rate). */
export function sampleFile(pack: string, file: string, ctx: BaseAudioContext): Promise<[Float32Array, Float32Array]> {
  const key = `${pack}/${file}@${ctx.sampleRate}`;
  let d = decoded.get(key);
  if (!d) {
    d = (async () => {
      const audio = await ctx.decodeAudioData(await packFileData(pack, file));
      const left = channelData(audio, 0, 0, audio.length);
      const right = audio.numberOfChannels > 1 ? channelData(audio, 1, 0, audio.length) : left;
      return [left, right] as [Float32Array, Float32Array];
    })();
    d.catch(() => decoded.delete(key));
    decoded.set(key, d);
  }
  return d;
}
