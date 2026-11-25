/**
 * Rendering on a computer rather than in a browser: the songs, packs and audio files HO[LO] keeps in
 * its data folder, read straight from disk (the server and the `holo` command use this).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, normalize, resolve, sep } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { InstrumentManifest, RenderSource, RenderSplit } from './render.ts';

interface PackFile {
  id: string;
  root?: string;
  instruments: Omit<InstrumentManifest, 'pack'>[];
  /** Impulse responses (Space Designer), as files under the root. */
  impulses?: { name: string; title?: string; file: string }[];
}

/** A render's source in a data folder: data/packs/<pack>/holo-pack.json and data/audio/<song>/. */
export function dataFolderSource(dataDir: string, projectId: string): RenderSource {
  const packs = new Map<string, { pack: PackFile; root: string }>();
  const packsDir = join(dataDir, 'packs');
  if (existsSync(packsDir)) {
    for (const entry of readdirSync(packsDir, { withFileTypes: true })) {
      const file = join(packsDir, entry.name, 'holo-pack.json');
      if (!entry.isDirectory() || !existsSync(file)) continue;
      const pack = JSON.parse(readFileSync(file, 'utf8')) as PackFile;
      packs.set(pack.id, { pack, root: resolve(packsDir, entry.name, pack.root || 'samples') });
    }
  }
  const inside = (root: string, rel: string) => {
    const path = normalize(join(root, rel));
    if (!path.startsWith(root + sep)) throw new Error(`${rel} is outside its folder`);
    return path;
  };
  const audioDir = join(dataDir, 'audio', projectId.replace(/[^\w-]/g, ''));
  return {
    async instrument(pack, name) {
      const found = packs.get(pack)?.pack.instruments.find((i) => i.name === name);
      if (!found) throw new Error(`No instrument ${pack}/${name} in ${packsDir}`);
      return { ...found, pack };
    },
    async sample(pack, file) {
      const p = packs.get(pack);
      if (!p) throw new Error(`No pack ${pack}`);
      return new Uint8Array(readFileSync(inside(p.root, file)));
    },
    async impulse(pack, name) {
      const p = packs.get(pack);
      const found = p?.pack.impulses?.find((i) => i.name === name);
      if (!p || !found) throw new Error(`No impulse response ${pack}/${name}`);
      return new Uint8Array(readFileSync(inside(p.root, found.file)));
    },
    async audio(file) {
      if (!/^aud_[a-z0-9]+$/.test(file)) throw new Error(`No audio file ${file}`);
      const found = existsSync(audioDir) ? readdirSync(audioDir).find((f) => f.startsWith(`${file}.`)) : undefined;
      if (!found) throw new Error(`No audio file ${file} for this song`);
      return new Uint8Array(readFileSync(join(audioDir, found)));
    },
  };
}

/** How long a render thread has to say it has stopped before it's stopped anyway. */
const END_MS = 5000;

/**
 * A render split over this many threads of this process (render.ts, RenderOptions.split): the same
 * file as on one, sooner, on a computer with cores to spare. Under two, the render stays on one.
 * `entry`: what each thread runs (render-thread.ts).
 */
export function renderThreads(
  workers: number,
  entry: URL = new URL('./render-thread.ts', import.meta.url),
): RenderSplit {
  return {
    workers,
    start(spec, sampleRate, failed) {
      const worker = new Worker(entry, {
        workerData: { sr: sampleRate, ahead: spec },
      });
      let over = false;
      let ended: ((error: string | null) => void) | null = null;
      const end = (error: string | null) => {
        if (over) return;
        over = true;
        if (error !== null) failed(error);
        ended?.(error);
        void worker.terminate();
      };
      worker.on('message', (msg: { type?: string; message?: string; error?: string | null }) => {
        if (msg.type === 'renderError') failed(msg.message ?? 'A render thread’s engine failed');
        else if (msg.type === 'renderEnded') end(msg.error ?? null);
      });
      worker.on('error', (err) => end(`A render thread failed: ${err instanceof Error ? err.message : String(err)}`));
      worker.on('exit', () => end('A render thread stopped by itself'));
      return {
        post: (msg) => worker.postMessage(msg),
        go: () => worker.postMessage({ type: 'renderGo' }),
        end: () =>
          new Promise<string | null>((done) => {
            if (over) return done(null);
            const late = setTimeout(() => end('A render thread didn’t stop when asked'), END_MS);
            ended = (error) => {
              clearTimeout(late);
              done(error);
            };
            worker.postMessage({ type: 'renderEnd' });
          }),
      };
    },
  };
}

/**
 * How many threads a render is split over on a computer with this many cores to itself: one fewer
 * than its cores (this thread mixes what they play, and waits for most of it), six at most, and
 * none with fewer than three cores, where a split costs more than it saves. `most`: a ceiling from
 * whoever runs the computer (1: one engine, as before there were threads).
 */
export function renderWorkersFor(cores: number, most = Number.POSITIVE_INFINITY): number {
  const n = Math.min(6, Math.floor(cores) - 1, Number.isFinite(most) ? Math.floor(most) : 6);
  return n >= 2 ? n : 0;
}
