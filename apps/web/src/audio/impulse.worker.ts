/// <reference lib="webworker" />
/**
 * Spaces for Space Designer, made away from the page: a generated hall (a few seconds of work for a
 * long one) or a pack's response file, prepared for the audio thread and handed back without copying.
 */
import {
  decodeWav,
  generateSpace,
  type ImpulseSource,
  impulseBuffers,
  impulseFromAudio,
  prepareImpulse,
} from '@holo/engine';
import { keepImpulse, keptImpulse, packImpulse } from './impulse-cache.ts';

interface Job {
  key: string;
  source: ImpulseSource;
  rate: number;
  /** The studio's engine: a generated hall is kept on the device under it (none: nothing kept). */
  engine: string;
}

self.onmessage = async (e: MessageEvent<Job>) => {
  const { key, source, rate, engine } = e.data;
  try {
    // a generated hall as it was made the last time, when this device kept it
    const kept = source.kind === 'space' ? await keptImpulse(engine, key) : null;
    if (kept) {
      postMessage({ key, data: kept }, impulseBuffers(kept));
      return;
    }
    const ir =
      source.kind === 'space'
        ? generateSpace(source.name, source.seed, source.decay, rate)
        : await fetch(`/api/packs/${encodeURIComponent(source.pack)}/impulses/${encodeURIComponent(source.name)}`)
            .then((r) => {
              if (!r.ok) throw new Error(`No impulse response ${source.pack}/${source.name}`);
              return r.arrayBuffer();
            })
            .then((b) => impulseFromAudio(decodeWav(new Uint8Array(b)), rate));
    const data = prepareImpulse(ir);
    // (packed before it's handed over: its arrays go with the message)
    const packed = source.kind === 'space' && engine ? packImpulse(data) : null;
    postMessage({ key, data }, impulseBuffers(data));
    if (packed) void keepImpulse(engine, key, packed);
  } catch (err) {
    postMessage({ key, error: err instanceof Error ? err.message : String(err) });
  }
};
