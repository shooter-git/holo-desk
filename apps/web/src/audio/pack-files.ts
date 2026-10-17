/**
 * Pack files the studio fetches outside a whole instrument: an instrument's manifest (with its
 * Performance data), and single sample files, decoded once each at the context's rate.
 */
import type { InstrumentManifest } from '@holo/engine';

const CACHE = 'holo-samples-v1';

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

/** A pack's sample file, decoded (the decoder resamples it to the context's rate). */
export function sampleFile(pack: string, file: string, ctx: BaseAudioContext): Promise<[Float32Array, Float32Array]> {
  const key = `${pack}/${file}@${ctx.sampleRate}`;
  let d = decoded.get(key);
  if (!d) {
    d = (async () => {
      const url = `/packs/${encodeURIComponent(pack)}/files/${file.split('/').map(encodeURIComponent).join('/')}`;
      const cache = 'caches' in globalThis ? await caches.open(CACHE).catch(() => null) : null;
      let response = cache ? await cache.match(url) : undefined;
      if (!response) {
        response = await fetch(url);
        if (!response.ok) throw new Error(`Missing sample ${file}`);
        if (cache) await cache.put(url, response.clone()).catch(() => undefined);
      }
      const audio = await ctx.decodeAudioData(await response.arrayBuffer());
      const left = audio.getChannelData(0).slice();
      const right = audio.numberOfChannels > 1 ? audio.getChannelData(1).slice() : left;
      return [left, right] as [Float32Array, Float32Array];
    })();
    d.catch(() => decoded.delete(key));
    decoded.set(key, d);
  }
  return d;
}
