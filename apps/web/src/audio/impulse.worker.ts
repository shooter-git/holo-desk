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

interface Job {
  key: string;
  source: ImpulseSource;
  rate: number;
}

self.onmessage = async (e: MessageEvent<Job>) => {
  const { key, source, rate } = e.data;
  try {
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
    postMessage({ key, data }, impulseBuffers(data));
  } catch (err) {
    postMessage({ key, error: err instanceof Error ? err.message : String(err) });
  }
};
