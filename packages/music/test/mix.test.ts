import { readFileSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { decodeWav } from '@holo/engine';
import { describe, expect, it } from 'vitest';
import { fetchFiles, SampleCache, sha256 } from '../src/fetch.ts';
import { pcmWav } from '../src/flac.ts';
import { type DecodedInput, decodeInput, type MixRecipe, mixFile, mixUrl } from '../src/mix.ts';
import type { PinnedPack } from '../src/packs.ts';

const FIXTURES = join(import.meta.dirname, 'fixtures');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));

/** A WAV of integer samples (16-bit). */
const wav16 = (channels: number[][], rate = 44100) =>
  pcmWav({ rate, bits: 16, channels: channels.map((c) => Int32Array.from(c)) });

describe('a file made from recordings', () => {
  const close = decodeInput(wav16([[0, 16384, -16384, 8192, 0, 0, 0, 0]]));
  const oh = decodeInput(
    wav16([
      [0, 0, 8192, 8192, 8192, 8192, 8192, 8192],
      [0, 0, -8192, -8192, -8192, -8192, -8192, -8192],
    ]),
  );
  const inputs = new Map<string, DecodedInput>([
    ['k:close.wav', close],
    ['k:oh.wav', oh],
  ]);

  it('mixes a mono microphone to both sides and a stereo pair side to side, at their gains', () => {
    const recipe: MixRecipe = {
      in: [
        ['k:close.wav', 1, 0.5],
        ['k:oh.wav', 0.5, 0.5],
      ],
      start: 1,
      frames: 4,
      fadeIn: 0,
      fadeOut: 0,
    };
    const out = decodeWav(mixFile(recipe, inputs, 16));
    expect(out.rate).toBe(44100);
    expect([...(out.channels[0] as Float32Array)].map((x) => x * 32768)).toEqual([
      16384,
      -16384 + 4096,
      8192 + 4096,
      4096,
    ]);
    expect([...(out.channels[1] as Float32Array)].map((x) => x * 32768)).toEqual([
      8192,
      -8192 - 4096,
      4096 - 4096,
      -4096,
    ]);
  });

  it('fades in straight and out along an S curve, and keeps to full scale', () => {
    const loud = decodeInput(wav16([Array(8).fill(30000)]));
    const recipe: MixRecipe = { in: [['k:loud.wav', 2, 2]], start: 0, frames: 8, fadeIn: 1, fadeOut: 4 };
    const out = decodeWav(mixFile(recipe, new Map([['k:loud.wav', loud]]), 16));
    const l = [...(out.channels[0] as Float32Array)].map((x) => Math.round(x * 32768));
    // doubled past full scale, it's held there; the first frame half in; the last four along the S
    expect(l.slice(1, 4)).toEqual([32767, 32767, 32767]);
    expect(l[0]).toBe(30000);
    const s = (t: number) => 1 - t * t * (3 - 2 * t);
    expect(l.slice(4)).toEqual([0.25, 0.5, 0.75, 1].map((t) => Math.min(32767, Math.round(60000 * s(t)))));
    expect(l[7]).toBe(0);
  });

  it('reads a download from its base, by name', () => {
    expect(mixUrl({ bases: { lib: 'https://example.org/x/' } }, 'lib:Samples/D#4 v1.wav')).toBe(
      'https://example.org/x/Samples/D%234%20v1.wav',
    );
    expect(() => mixUrl({ bases: {} }, 'lib:a.wav')).toThrow(/no base/);
  });

  it('makes a pack’s files from the downloads it fetches, checking each download and each file made', async () => {
    const flac = fixture('stereo16-ms.flac');
    const mono = wav16([[100, 200, 300, 400, 500]], 8000);
    const server = createServer((req, res) => {
      if (req.url === '/lib/a.flac') res.end(Buffer.from(flac));
      else if (req.url === '/lib/b.wav') res.end(Buffer.from(mono));
      else res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const dir = join(import.meta.dirname, '../../../node_modules/.cache/holo-music-test-mix');
    rmSync(dir, { recursive: true, force: true });
    try {
      const port = (server.address() as { port: number }).port;
      const recipe: MixRecipe = {
        in: [
          ['lib:a.flac', 0.5, 0.5],
          ['lib:b.wav', 1, -1],
        ],
        start: 0,
        frames: 4,
        fadeIn: 0,
        fadeOut: 2,
      };
      const decoded = new Map([
        ['lib:a.flac', decodeInput(flac)],
        ['lib:b.wav', decodeInput(mono)],
      ]);
      const made = mixFile(recipe, decoded, 24);
      const pack: PinnedPack = {
        id: 'lib',
        name: 'Lib',
        license: 'CC0-1.0',
        credit: '',
        source: {
          kind: 'mix',
          bases: { lib: `http://127.0.0.1:${port}/lib/` },
          downloads: { 'lib:a.flac': sha256(flac), 'lib:b.wav': sha256(mono) },
          bits: 24,
          files: { 'kit/hit.wav': recipe },
        },
        instruments: [],
        files: { 'kit/hit.wav': sha256(made) },
      };
      const cache = new SampleCache(dir);
      await fetchFiles([{ pack, path: 'kit/hit.wav', sha256: sha256(made) }], { cache });
      expect(cache.read(sha256(made), '.wav')).toEqual(made);
      // the downloads are let go once every file made from them is made
      expect(cache.has(sha256(flac), '.flac')).toBe(false);
      // a download that isn't the pinned one is refused
      const wrong = {
        ...pack,
        source: { ...pack.source, downloads: { 'lib:a.flac': '0'.repeat(64), 'lib:b.wav': sha256(mono) } },
      } as PinnedPack;
      await expect(
        fetchFiles([{ pack: wrong, path: 'kit/hit.wav', sha256: sha256(made) }], {
          cache: new SampleCache(join(dir, 'x')),
        }),
      ).rejects.toThrow(/isn't the file the engine was pinned with/);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
