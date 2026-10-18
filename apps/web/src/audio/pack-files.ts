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

/** An instrument's manifest (with its Performance data), fetched once. */
const manifests = new Map<string, Promise<InstrumentManifest>>();

export function instrumentManifest(pack: string, name: string): Promise<InstrumentManifest> {
  const key = `${pack}/${name}`;
  let m = manifests.get(key);
  if (!m) {
    m = fetch(`/api/packs/${encodeURIComponent(pack)}/instruments/${encodeURIComponent(name)}`).then((res) => {
      if (!res.ok) throw new Error(`No instrument ${key} (${res.status})`);
      return res.json() as Promise<InstrumentManifest>;
    });
    m.catch(() => manifests.delete(key));
    manifests.set(key, m);
  }
  return m;
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
