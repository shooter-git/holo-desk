/// <reference lib="webworker" />
/**
 * Bouncing off the page's thread, with the same renderer (and the same sample decoding) as a
 * headless render: the studio's bounce and the server's render of a song are the same numbers.
 */

import { encodeWav, type RenderSource, renderSession } from '@holo/engine';
import type { Project } from '@holo/session';

interface Job {
  project: Project;
  sampleRate: number;
  from: number;
  to: number;
  tail: number;
  format: 'pcm24' | 'float32';
}

const SAMPLES = 'holo-samples-v1';
const AUDIO = 'holo-audio-v1';

async function cached(cacheName: string, url: string): Promise<Uint8Array> {
  const cache = await caches.open(cacheName).catch(() => null);
  let res = cache ? await cache.match(url) : undefined;
  if (!res) {
    res = await fetch(url);
    if (!res.ok) throw new Error(`${url}: ${res.status}`);
    if (cache) await cache.put(url, res.clone()).catch(() => undefined);
  }
  return new Uint8Array(await res.arrayBuffer());
}

const path = (s: string) => s.split('/').map(encodeURIComponent).join('/');

self.onmessage = async (e: MessageEvent<Job>) => {
  const job = e.data;
  const source: RenderSource = {
    async instrument(pack, name) {
      const res = await fetch(`/api/packs/${encodeURIComponent(pack)}/instruments/${encodeURIComponent(name)}`);
      if (!res.ok) throw new Error(`No instrument ${pack}/${name}`);
      return res.json();
    },
    sample: (pack, file) => cached(SAMPLES, `/packs/${encodeURIComponent(pack)}/files/${path(file)}`),
    audio: (file) => cached(AUDIO, `/api/projects/${job.project.id}/files/${file}`),
    impulse: (pack, name) =>
      cached(SAMPLES, `/api/packs/${encodeURIComponent(pack)}/impulses/${encodeURIComponent(name)}`),
  };
  try {
    const out = await renderSession(job.project, source, {
      sampleRate: job.sampleRate,
      from: job.from,
      to: job.to,
      tail: job.tail,
      onProgress: (text) => postMessage({ type: 'progress', text }),
    });
    const wav = encodeWav(out.channels, out.sampleRate, job.format);
    postMessage({ type: 'done', wav, seconds: (out.channels[0]?.length ?? 0) / out.sampleRate, errors: out.errors }, [
      wav.buffer,
    ]);
  } catch (err) {
    postMessage({ type: 'failed', message: err instanceof Error ? err.message : String(err) });
  }
};
