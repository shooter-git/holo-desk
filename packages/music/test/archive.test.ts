import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { fetchFiles, SampleCache, sha256 } from '../src/fetch.ts';
import { decodeFlac, pcmWav } from '../src/flac.ts';
import { decodeLzma } from '../src/lzma.ts';
import type { PinnedPack } from '../src/packs.ts';
import { SevenZip } from '../src/sevenzip.ts';

// made by ffmpeg 5.1 (its libavformat 59.27.100) from short deterministic tones: each FLAC with the
// WAV ffmpeg decodes it to, then the FLACs and a text file as 7z writes them (Deflate in one solid
// block, as FreePats' archive is, and its default LZMA2); every 7z header is LZMA
const FIXTURES = join(import.meta.dirname, 'fixtures');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const FLACS = ['mono16', 'stereo16-ms', 'stereo16-ls', 'stereo24-rs', 'noise'];
const SOFTWARE = 'Lavf59.27.100';

describe('LZMA', () => {
  it('decodes a stream closed by an end marker (xz --format=lzma: five property bytes, a size, the data)', () => {
    const text =
      'the rain in spain stays mainly in the plain; the rain in spain stays mainly in the plain. ' +
      `${Array.from({ length: 40 }, (_, i) => i + 1).join(' ')} `;
    const lzma = new Uint8Array(
      Buffer.from(
        'XQAAgAD//////////wA6GgjOdtB1Qo2XY+IcDkC7NYlyLqZxiRq2P024AV7V8Iiz/kpjX3xwI8EtmJvgbvdi+Jt9vqBt1hEGI0ONUt5SJAUse7Sh1MiQ' +
          'g0TIYPgnmn1uHW23KvTuzIFITKndbmH59HgPBsN20ScO5HoEd+6Zev+3RaAA',
        'base64',
      ),
    );
    const out = decodeLzma(lzma, 13, lzma.length, lzma.subarray(0, 5), text.length);
    expect(Buffer.from(out).toString('latin1')).toBe(text);
    expect(() => decodeLzma(lzma, 13, lzma.length, lzma.subarray(0, 5), text.length + 1)).toThrow(/ends early/);
    expect(() => decodeLzma(lzma, 14, lzma.length, lzma.subarray(0, 5), text.length)).toThrow(/Not an LZMA/);
  });
});

describe('a 7z archive', () => {
  it.each(['deflate.7z', 'lzma2.7z'])('%s lists its files and reads each one, checked', (name) => {
    const z = new SevenZip(fixture(name));
    expect(z.names()).toEqual([...FLACS.map((f) => `${f}.flac`), 'readme.txt'].sort());
    for (const f of z.names()) expect(z.read(f)).toEqual(fixture(f));
    expect(z.has('readme.txt')).toBe(true);
    expect(() => z.read('missing.flac')).toThrow(/isn't in the archive/);
  });

  it('refuses what is damaged', () => {
    const bytes = fixture('deflate.7z');
    expect(() => new SevenZip(bytes.subarray(0, 100))).toThrow(/ends early/);
    const flipped = bytes.slice();
    flipped[200] = (flipped[200] as number) ^ 0xff;
    expect(() => new SevenZip(flipped).read('mono16.flac')).toThrow(
      /CRC differs|unpacks to the wrong size|Corrupt|zlib|invalid/i,
    );
    expect(() => new SevenZip(new Uint8Array(40))).toThrow(/Not a 7z/);
  });
});

describe('FLAC', () => {
  it.each(FLACS)('%s decodes to the samples ffmpeg writes, in the WAV ffmpeg writes', (name) => {
    const pcm = decodeFlac(fixture(`${name}.flac`));
    expect(pcm.rate).toBe(8000);
    expect(pcm.bits).toBe(name.startsWith('stereo24') ? 24 : 16);
    expect(pcm.channels).toHaveLength(name.startsWith('stereo') ? 2 : 1);
    expect(pcmWav(pcm, SOFTWARE)).toEqual(fixture(`${name}.wav`));
  });

  it('notices a damaged frame', () => {
    const bytes = fixture('mono16.flac').slice();
    bytes[bytes.length - 40] = (bytes[bytes.length - 40] as number) ^ 0x10;
    expect(() => decodeFlac(bytes)).toThrow(/damaged|MD5|ends early|out of sync/);
    expect(() => decodeFlac(fixture('readme.txt'))).toThrow(/Not a FLAC/);
  });

  it("writes a WAV as ffmpeg does: fmt, the software's INFO tag, data", () => {
    const wav = pcmWav({ rate: 44100, bits: 16, channels: [Int32Array.from([0, 1, -1, 32767, -32768])] }, SOFTWARE);
    const text = (at: number, n: number) => Buffer.from(wav.subarray(at, at + n)).toString('latin1');
    expect(wav.length).toBe(78 + 10);
    expect(text(0, 4)).toBe('RIFF');
    expect(text(36, 4)).toBe('LIST');
    expect(text(44, 4)).toBe('INFO');
    expect(text(48, 4)).toBe('ISFT');
    expect(text(56, 14)).toBe('Lavf59.27.100\0');
    expect(text(70, 4)).toBe('data');
    expect(Array.from(new Int16Array(wav.buffer, wav.byteOffset + 78, 5))).toEqual([0, 1, -1, 32767, -32768]);
    // a bare one, as the engine reads it
    const bare = pcmWav({ rate: 44100, bits: 16, channels: [Int32Array.from([5])] });
    expect(bare.length).toBe(46);
    expect(Buffer.from(bare.subarray(36, 40)).toString('latin1')).toBe('data');
  });
});

describe('fetching samples from an archive', () => {
  it("decodes a library's notes from the archive it downloads, checking the archive and every note", async () => {
    const archive = fixture('deflate.7z');
    const server = createServer((req, res) => {
      if (req.url === '/Guitar/Lib-20190618.7z') res.end(Buffer.from(archive));
      else res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const port = (server.address() as { port: number }).port;
      const note = fixture('mono16.wav');
      const other = fixture('stereo16-ms.wav');
      const pack: PinnedPack = {
        id: 'lib',
        name: 'Lib',
        license: 'CC0-1.0',
        credit: '',
        source: {
          kind: 'archive',
          url: `http://127.0.0.1:${port}/Guitar/Lib-20190618.7z`,
          sha256: sha256(archive),
          software: SOFTWARE,
          entries: { 'Guitar/A1.wav': 'mono16.flac', 'Guitar/A2.wav': 'stereo16-ms.flac' },
        },
        instruments: [],
        files: { 'Guitar/A1.wav': sha256(note), 'Guitar/A2.wav': sha256(other) },
      };
      const cache = new SampleCache(join(import.meta.dirname, '../../../node_modules/.cache/holo-music-test-archive'));
      const want = Object.keys(pack.files).map((path) => ({ pack, path, sha256: pack.files[path] as string }));
      await fetchFiles(want, { cache });
      expect(cache.read(sha256(note), '.wav')).toEqual(note);
      expect(cache.read(sha256(other), '.wav')).toEqual(other);
      // the archive itself is kept, by its checksum
      expect(cache.has(sha256(archive), '.7z')).toBe(true);
      // another archive than the pinned one isn't used
      const wrong = { ...pack, source: { ...pack.source, sha256: '0'.repeat(64) } } as PinnedPack;
      const fresh = new SampleCache(join(cache.dir, 'fresh'));
      await expect(
        fetchFiles([{ pack: wrong, path: 'Guitar/A1.wav', sha256: sha256(note) }], { cache: fresh }),
      ).rejects.toThrow(/isn't the file the engine was pinned with/);
      // nor a file whose entry isn't named
      const unnamed = { ...pack, files: { ...pack.files, 'Guitar/A3.wav': sha256(note) } };
      await expect(
        fetchFiles([{ pack: unnamed, path: 'Guitar/A3.wav', sha256: sha256(note) }], { cache: fresh }),
      ).rejects.toThrow(/has no entry/);
    } finally {
      server.close();
    }
  });
});
