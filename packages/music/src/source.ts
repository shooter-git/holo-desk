/**
 * What an experience's songs play, as the engine asks for it: the pinned libraries' instruments, their
 * samples from the cache (fetched first, or on demand), and each song's own audio files, kept beside
 * it in the sessions folder (<piece>.audio/).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import type { InstrumentManifest, RenderSource } from '@holo/engine';
import { type FetchOptions, fetchFiles } from './fetch.ts';
import type { PinnedPack, PinnedPacks } from './packs.ts';

/** The folder of a song's own recordings and audio files, beside its session. */
export const audioFolder = (sessions: string, piece: string) => join(sessions, `${piece}.audio`);

export function experienceSource(packs: PinnedPacks, audioDir: string | null, fetch: FetchOptions): RenderSource {
  const byId = new Map(packs.packs.map((p) => [p.id, p]));
  const pack = (id: string): PinnedPack => {
    const p = byId.get(id);
    if (!p) throw new Error(`"${id}" isn't one of the sample libraries this engine pins`);
    return p;
  };
  const file = async (p: PinnedPack, path: string): Promise<Uint8Array> => {
    const sha256 = p.files[path];
    if (!sha256) throw new Error(`${p.id}/${path} isn't in the pinned libraries`);
    const ext = extname(path);
    if (!fetch.cache.has(sha256, ext)) await fetchFiles([{ pack: p, path, sha256 }], fetch);
    return fetch.cache.read(sha256, ext);
  };
  return {
    async instrument(id, name): Promise<InstrumentManifest> {
      const found = pack(id).instruments.find((i) => i.name === name);
      if (!found) throw new Error(`No instrument ${id}/${name} in the pinned libraries`);
      return { ...found, pack: id };
    },
    sample: (id, path) => file(pack(id), path),
    async impulse(id, name) {
      const p = pack(id);
      const found = p.impulses?.find((r) => r.name === name);
      if (!found) throw new Error(`No impulse response ${id}/${name} in the pinned libraries`);
      return file(p, found.file);
    },
    async audio(id) {
      if (!/^aud_[a-z0-9]+$/.test(id)) throw new Error(`No audio file ${id}`);
      const found = audioDir && existsSync(audioDir) ? readdirSync(audioDir).find((f) => f.startsWith(`${id}.`)) : null;
      if (!audioDir || !found)
        throw new Error(`The song's audio file ${id} isn't in ${audioDir ?? 'its folder'}: send the song again`);
      return new Uint8Array(readFileSync(join(audioDir, found)));
    },
  };
}
