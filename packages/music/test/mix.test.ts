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

/** A WAV of any number of channels of integer samples (16-bit), written by hand. */
function wavMulti(channels: number[][], rate = 48000): Uint8Array {
  const n = channels.length;
  const frames = (channels[0] as number[]).length;
  const out = new Uint8Array(44 + frames * n * 2);
  const v = new DataView(out.buffer);
  const tag = (at: number, s: string) => {
    for (let i = 0; i < s.length; i++) v.setUint8(at + i, s.charCodeAt(i));
  };
  tag(0, 'RIFF');
  v.setUint32(4, 36 + frames * n * 2, true);
  tag(8, 'WAVE');
  tag(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true);
  v.setUint16(22, n, true);
  v.setUint32(24, rate, true);
  v.setUint32(28, rate * n * 2, true);
  v.setUint16(32, n * 2, true);
  v.setUint16(34, 16, true);
  tag(36, 'data');
  v.setUint32(40, frames * n * 2, true);
  for (let i = 0; i < frames; i++)
    for (let c = 0; c < n; c++) v.setInt16(44 + (i * n + c) * 2, (channels[c] as number[])[i] as number, true);
  return out;
}

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

  it('takes one channel of a multichannel recording alone, as a mono microphone', () => {
    // a hit's four microphones in one file (as a DrumGizmo kit keeps them)
    const four = decodeInput(
      wavMulti([
        [1000, 2000, 3000],
        [4000, 5000, 6000],
        [7000, 8000, 9000],
        [-100, -200, -300],
      ]),
    );
    const decoded = new Map([['k:hit.wav', four]]);
    const recipe: MixRecipe = {
      in: [
        ['k:hit.wav', 1, 0.5, { channel: 2 }],
        ['k:hit.wav', 0, 1, { channel: 3 }],
      ],
      start: 0,
      frames: 3,
      fadeIn: 0,
      fadeOut: 0,
    };
    const out = decodeWav(mixFile(recipe, decoded, 16));
    const side = (c: number) => [...(out.channels[c] as Float32Array)].map((x) => Math.round(x * 32768));
    expect(side(0)).toEqual([7000, 8000, 9000]);
    expect(side(1)).toEqual([3500 - 100, 4000 - 200, 4500 - 300]);
    // without a channel, its first two are its left and right, as before
    const plain = decodeWav(mixFile({ ...recipe, in: [['k:hit.wav', 1, 1]] }, decoded, 16));
    expect([...(plain.channels[1] as Float32Array)].map((x) => Math.round(x * 32768))).toEqual([4000, 5000, 6000]);
    expect(() => mixFile({ ...recipe, in: [['k:hit.wav', 1, 1, { channel: 4 }]] }, decoded, 16)).toThrow(
      /4 channel\(s\), not a channel 4/,
    );
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

describe('downloads shared by the files made from them', () => {
  it('keeps a download two names share (the same bytes) until both files are made, and lets it go after', async () => {
    const same = wav16([[100, 200, 300, 400]], 8000);
    const server = createServer((req, res) => {
      if (req.url === '/lib/a.wav' || req.url === '/lib/b.wav') res.end(Buffer.from(same));
      else res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const dir = join(import.meta.dirname, '../../../node_modules/.cache/holo-music-test-shared');
    rmSync(dir, { recursive: true, force: true });
    try {
      const port = (server.address() as { port: number }).port;
      const decoded = new Map([
        ['lib:a.wav', decodeInput(same)],
        ['lib:b.wav', decodeInput(same)],
      ]);
      // one file from each name, and one from the same download twice over
      const x: MixRecipe = { in: [['lib:a.wav', 1, 1]], start: 0, frames: 4, fadeIn: 0, fadeOut: 0 };
      const y: MixRecipe = { in: [['lib:b.wav', 0.5, 0.5]], start: 0, frames: 4, fadeIn: 0, fadeOut: 0 };
      const z: MixRecipe = {
        in: [
          ['lib:a.wav', 0.5, 0.5],
          ['lib:a.wav', 0.25, 0.25, { start: -1 }],
        ],
        start: 0,
        frames: 4,
        fadeIn: 0,
        fadeOut: 0,
      };
      const made = [x, y, z].map((r) => mixFile(r, decoded, 16));
      const pack: PinnedPack = {
        id: 'lib',
        name: 'Lib',
        license: 'CC0-1.0',
        credit: '',
        source: {
          kind: 'mix',
          bases: { lib: `http://127.0.0.1:${port}/lib/` },
          downloads: { 'lib:a.wav': sha256(same), 'lib:b.wav': sha256(same) },
          bits: 16,
          files: { 'x.wav': x, 'y.wav': y, 'z.wav': z },
        },
        instruments: [],
        files: {
          'x.wav': sha256(made[0] as Uint8Array),
          'y.wav': sha256(made[1] as Uint8Array),
          'z.wav': sha256(made[2] as Uint8Array),
        },
      };
      const cache = new SampleCache(dir);
      const want = Object.keys(pack.files).map((path) => ({ pack, path, sha256: pack.files[path] as string }));
      await fetchFiles(want, { cache, parallel: 1 });
      for (const [i, f] of ['x.wav', 'y.wav', 'z.wav'].entries())
        expect(cache.read(pack.files[f] as string, '.wav')).toEqual(made[i]);
      expect(cache.has(sha256(same), '.wav')).toBe(false);
    } finally {
      server.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('recordings lined up and resampled', () => {
  /** A float input: one channel. */
  const input = (samples: number[] | Float32Array, rate = 44100) => ({
    rate,
    channels: [Float32Array.from(samples)],
  });
  const left = (bytes: Uint8Array) =>
    [...(decodeWav(bytes).channels[0] as Float32Array)].map((x) => Math.round(x * 32768));

  it('starts each input at its own frame: later, earlier, or before the file starts', () => {
    const a = input([0, 0, 0.25, 0.5, 0, 0]);
    const b = input([0.125, 0.25, 0, 0, 0, 0]);
    const inputs = new Map([
      ['k:a.wav', a],
      ['k:b.wav', b],
    ]);
    // a's hit is two frames in: start it there; b's is at its first frame, so it comes in one late
    const recipe: MixRecipe = {
      in: [
        ['k:a.wav', 1, 1, { start: 2 }],
        ['k:b.wav', 1, 1, { start: -1 }],
      ],
      start: 0,
      frames: 4,
      fadeIn: 0,
      fadeOut: 0,
    };
    expect(left(mixFile(recipe, inputs, 16))).toEqual([8192, 16384 + 4096, 8192, 0]);
    // without its own start, an input starts at the recipe's
    const same: MixRecipe = { ...recipe, in: [['k:a.wav', 1, 1]], start: 2 };
    expect(left(mixFile(same, inputs, 16))).toEqual([8192, 16384, 0, 0]);
  });

  it('resamples to the file’s rate: a tone comes out the tone it was, to within -90 dB', () => {
    const tone = (rate: number, n: number, hz = 1000, phase = 0) =>
      Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin(2 * Math.PI * hz * (i / rate) + phase));
    for (const [from, to] of [
      [44100, 48000],
      [48000, 44100],
      [96000, 48000],
    ] as const) {
      const recipe: MixRecipe = { in: [['k:t.wav', 1, 1]], start: 0, frames: to / 2, fadeIn: 0, fadeOut: 0, rate: to };
      const out = decodeWav(mixFile(recipe, new Map([['k:t.wav', input(tone(from, from), from)]]), 24));
      expect(out.rate).toBe(to);
      const want = tone(to, to / 2);
      let err = 0;
      // away from the ends, where the kernel runs off the input
      for (let i = 200; i < to / 2 - 200; i++)
        err = Math.max(err, Math.abs(((out.channels[0] as Float32Array)[i] as number) - (want[i] as number)));
      expect(20 * Math.log10(err / 0.5), `${from} to ${to}`).toBeLessThan(-90);
    }
  });

  it('plays an input at another rate (higher) and a fraction of a frame late', () => {
    const rate = 8000;
    const n = 4000;
    const src = Float32Array.from({ length: n }, (_, i) => 0.5 * Math.sin((2 * Math.PI * 400 * i) / rate));
    const recipe: MixRecipe = {
      in: [['k:t.wav', 1, 1, { rate: 8800, start: -0.5 }]],
      start: 0,
      frames: 2000,
      fadeIn: 0,
      fadeOut: 0,
    };
    const out = decodeWav(mixFile(recipe, new Map([['k:t.wav', input(src, rate)]]), 24)).channels[0] as Float32Array;
    // 400 Hz played 10% fast is 440 Hz; the input's frame -0.5 is heard first (half its frame late)
    for (const i of [500, 777, 1500]) {
      const want = 0.5 * Math.sin((2 * Math.PI * 400 * (i * 1.1 - 0.5)) / rate);
      expect(Math.abs((out[i] as number) - want)).toBeLessThan(1e-4);
    }
  });

  it('makes the same bytes every time, on every computer (its sums by hand: no library math)', () => {
    let seed = 1;
    const noise = Float32Array.from({ length: 3000 }, () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return Math.round(((seed / 2 ** 31) * 2 - 1) * 20000) / 32768;
    });
    const recipe: MixRecipe = {
      in: [['k:n.wav', 0.7, 0.6, { start: 3.25, rate: 44000 }]],
      start: 0,
      frames: 2900,
      fadeIn: 10,
      fadeOut: 100,
      rate: 48000,
    };
    const made = mixFile(recipe, new Map([['k:n.wav', input(noise)]]), 24);
    expect(sha256(made)).toBe(PINNED);
  });

  it('writes one channel when the recipe says it is mono', () => {
    const recipe: MixRecipe = { in: [['k:a.wav', 0.5, 0.5]], start: 1, frames: 3, fadeIn: 0, fadeOut: 0, mono: true };
    const out = decodeWav(mixFile(recipe, new Map([['k:a.wav', input([0, 0.5, -0.5, 0.25])]]), 16));
    expect(out.channels).toHaveLength(1);
    expect(left(mixFile(recipe, new Map([['k:a.wav', input([0, 0.5, -0.5, 0.25])]]), 16))).toEqual([8192, -8192, 4096]);
  });

  it('says the file’s rate when its inputs’ rates differ', () => {
    const recipe: MixRecipe = {
      in: [
        ['k:a.wav', 1, 1],
        ['k:b.wav', 1, 1],
      ],
      start: 0,
      frames: 4,
      fadeIn: 0,
      fadeOut: 0,
    };
    const inputs = new Map([
      ['k:a.wav', input([0, 0, 0, 0], 44100)],
      ['k:b.wav', input([0, 0, 0, 0], 48000)],
    ]);
    expect(() => mixFile(recipe, inputs, 16)).toThrow(/say the file's rate/);
    expect(decodeWav(mixFile({ ...recipe, rate: 48000 }, inputs, 16)).rate).toBe(48000);
  });

  it('reads an AIFF download (big-endian, as Iowa publishes them)', () => {
    // FORM AIFF: COMM (2 channels, 3 frames, 16 bits, 44100 Hz as an 80-bit float), SSND
    const bytes = new Uint8Array(54 + 12);
    const v = new DataView(bytes.buffer);
    const tag = (at: number, s: string) => {
      for (let i = 0; i < 4; i++) bytes[at + i] = s.charCodeAt(i);
    };
    tag(0, 'FORM');
    v.setUint32(4, bytes.length - 8);
    tag(8, 'AIFF');
    tag(12, 'COMM');
    v.setUint32(16, 18);
    v.setUint16(20, 2);
    v.setUint32(22, 3);
    v.setUint16(26, 16);
    v.setUint16(28, 0x400e);
    v.setUint32(30, 0xac440000);
    tag(38, 'SSND');
    v.setUint32(42, 8 + 12);
    for (const [i, x] of [16384, -16384, 0, 8192, -32768, 32767].entries()) v.setInt16(54 + i * 2, x);
    const d = decodeInput(bytes);
    expect(d.rate).toBe(44100);
    expect([...(d.channels[0] as Float32Array)].map((x) => x * 32768)).toEqual([16384, 0, -32768]);
    expect([...(d.channels[1] as Float32Array)].map((x) => x * 32768)).toEqual([-16384, 8192, 32767]);
  });
});

const PINNED = '1ad31f08715e60c8e5d9c96bc49b22ac768656b9ebe5571949fc3664a7b6bf13';
