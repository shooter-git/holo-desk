import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { archiveFormat, archiveNames, unpack } from '../src/archives.ts';
import { decodeBzip2 } from '../src/bzip2.ts';
import { fetchFiles, SampleCache, sha256 } from '../src/fetch.ts';
import { decodeFlac, pcmWav } from '../src/flac.ts';
import { decodeInput, mixFile } from '../src/mix.ts';
import type { PinnedPack } from '../src/packs.ts';
import { readTar, TarReader } from '../src/tar.ts';
import { decodeXz } from '../src/xz.ts';
import { bytesAccess, ZipFile } from '../src/zip.ts';

// made with GNU tar 1.34 (one archive in its own format, one in POSIX pax), bzip2 1.0.8, xz 5.4
// and Python's zipfile (the ZIP64 one by hand: every size and offset in its ZIP64 fields)
const FIXTURES = join(import.meta.dirname, 'fixtures');
const fixture = (name: string) => new Uint8Array(readFileSync(join(FIXTURES, name)));
const hex = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

/** runs.txt: runs of a byte of every length the run-length codings treat apart. */
const RUNS = Buffer.from([1, 3, 4, 5, 8, 250, 255, 259, 260, 300, 1000].map((n) => `${'a'.repeat(n)}b`).join(''));
const LONG = `samples/${'a-very-long-folder-name-for-a-tar-header/'.repeat(3)}note C4 é.txt`;
/** 2.6 MB: a kilobyte of noise, over and over (several bzip2 blocks, and past a small xz window). */
const BIG = '3f955203788b82bbec4fb94fc6cb085030ba8135846851dbc588196d9232b427';

const SAMPLES = {
  'samples/mono16.wav': fixture('mono16.wav'),
  'samples/stereo24-rs.flac': fixture('stereo24-rs.flac'),
  'samples/readme.txt': fixture('readme.txt'),
  'samples/runs.txt': new Uint8Array(RUNS),
};

describe('bzip2', () => {
  it('decodes blocks and streams written one after another, checking each CRC', () => {
    const out = decodeBzip2(fixture('big2.bz2'));
    expect(out.length).toBe(2_662_400);
    expect(hex(out)).toBe(BIG);
  });

  it('refuses what is damaged', () => {
    const bytes = fixture('big2.bz2');
    const flipped = bytes.slice();
    flipped[600] = (flipped[600] as number) ^ 0x04;
    expect(() => decodeBzip2(flipped)).toThrow(/bzip2/);
    expect(() => decodeBzip2(bytes.subarray(0, 5000))).toThrow(/ends early/);
    expect(() => decodeBzip2(fixture('readme.txt'))).toThrow(/Not a bzip2/);
  });
});

describe('xz', () => {
  it('decodes past a window smaller than its data, over several blocks', () => {
    // a 4 KiB dictionary, 1 MiB blocks: the window moves along as it fills
    expect(hex(decodeXz(fixture('big-window.xz')))).toBe(BIG);
  });

  it('decodes streams written one after another, with padding between', () => {
    // CRC64 then CRC32
    expect(hex(decodeXz(fixture('big-streams.xz')))).toBe(BIG);
  });

  it.each(['runs-sha256.xz', 'runs-none.xz'])('checks %s by its own check', (name) => {
    expect(Buffer.from(decodeXz(fixture(name)))).toEqual(RUNS);
  });

  it('refuses what is damaged', () => {
    const bytes = fixture('big-streams.xz');
    for (const at of [8, 30, 400, bytes.length - 6]) {
      const flipped = bytes.slice();
      flipped[at] = (flipped[at] as number) ^ 0x01;
      expect(() => decodeXz(flipped), `byte ${at}`).toThrow(/xz|LZMA/);
    }
    expect(() => decodeXz(bytes.subarray(0, 1000))).toThrow(/ends early/);
    expect(() => decodeXz(fixture('readme.txt'))).toThrow(/Not an xz/);
  });
});

describe('tar', () => {
  const check = (entries: { name: string; data: Uint8Array }[]) => {
    const got = Object.fromEntries(entries.map((e) => [e.name, e.data]));
    for (const [name, data] of Object.entries(SAMPLES)) expect(got[name], name).toEqual(data);
    expect(new TextDecoder().decode(got[LONG])).toBe('long name\n');
    expect(entries).toHaveLength(5);
  };

  it('reads GNU long names (bzip2) and POSIX pax ones (xz), files only', () => {
    check(readTar(decodeBzip2(fixture('notes.tar.bz2'))));
    check(readTar(decodeXz(fixture('notes.tar.xz'))));
  });

  it('keeps only what it is asked for, however the stream is cut up', () => {
    const tar = decodeXz(fixture('notes.tar.xz'));
    const reader = new TarReader((n) => n === 'samples/runs.txt');
    const got: { name: string; data: Uint8Array }[] = [];
    for (let at = 0; at < tar.length; at += 37) got.push(...reader.push(tar.subarray(at, at + 37)));
    reader.end();
    expect(got).toEqual([{ name: 'samples/runs.txt', data: new Uint8Array(RUNS) }]);
  });

  it('refuses a damaged header and an archive that stops in a file', () => {
    const tar = decodeBzip2(fixture('notes.tar.bz2')).slice();
    expect(() => readTar(tar.subarray(0, 3000))).toThrow(/ends early/);
    tar[600] = (tar[600] as number) ^ 0x01;
    expect(() => readTar(tar)).toThrow(/checksum/);
  });
});

describe('ZIP', () => {
  it('reads files stored and deflated, skipping folders', () => {
    const zip = new ZipFile(bytesAccess(fixture('notes.zip')));
    expect(zip.names()).toEqual([...Object.keys(SAMPLES), 'samples/café.txt']);
    for (const [name, data] of Object.entries(SAMPLES)) expect(zip.read(name)).toEqual(data);
  });

  it('reads ZIP64 sizes and offsets, and names in code page 437', () => {
    const zip = new ZipFile(bytesAccess(fixture('notes64.zip')));
    expect(zip.names()).toEqual(['samples/mono16.wav', 'samples/runs.txt', 'samples/café.txt']);
    expect(zip.read('samples/runs.txt')).toEqual(new Uint8Array(RUNS));
    expect(new TextDecoder().decode(zip.read('samples/café.txt'))).toBe('cafe\n');
  });

  it('refuses what is damaged', () => {
    const bytes = fixture('notes.zip').slice();
    expect(() => new ZipFile(bytesAccess(bytes.subarray(0, 4000)))).toThrow(/Not a ZIP/);
    bytes[200] = (bytes[200] as number) ^ 0x01;
    const zip = new ZipFile(bytesAccess(bytes));
    expect(() => zip.read('samples/mono16.wav')).toThrow(/damaged|invalid/);
    expect(() => zip.read('missing.wav')).toThrow(/isn't in the archive/);
  });
});

describe('unpacking an archive on disk', () => {
  const dir = mkdtempSync(join(tmpdir(), 'holo-unpack-'));

  it.each([
    ['notes.tar.bz2', 'tar.bz2'],
    ['notes.tar.xz', 'tar.xz'],
    ['notes.zip', 'zip'],
  ] as const)('%s: the files wanted, each as it is read', async (name, format) => {
    expect(archiveFormat(`https://example.org/x/${name}?download=1`)).toBe(format);
    const path = join(FIXTURES, name);
    const want = new Set(['samples/runs.txt', 'samples/stereo24-rs.flac']);
    const got = new Map<string, Uint8Array>();
    await unpack(path, format, want, (n, data) => {
      got.set(n, data);
    });
    expect(got.get('samples/runs.txt')).toEqual(new Uint8Array(RUNS));
    expect(got.get('samples/stereo24-rs.flac')).toEqual(SAMPLES['samples/stereo24-rs.flac']);
    await expect(unpack(path, format, new Set(['samples/nothing.wav']), () => undefined)).rejects.toThrow(
      /aren't in the archive/,
    );
    expect(await archiveNames(path, format)).toContain('samples/mono16.wav');
  });

  it('knows a 7z and a gzipped tar too', async () => {
    const tar = decodeXz(fixture('notes.tar.xz'));
    const { gzipSync } = await import('node:zlib');
    const gz = join(dir, 'notes.tgz');
    writeFileSync(gz, gzipSync(tar));
    const got: string[] = [];
    await unpack(gz, archiveFormat(gz), new Set(['samples/readme.txt']), (n) => {
      got.push(n);
    });
    expect(got).toEqual(['samples/readme.txt']);
    const seven = join(FIXTURES, 'lzma2.7z');
    await unpack(seven, archiveFormat(seven), new Set(['noise.flac']), (_, data) => {
      expect(data).toEqual(fixture('noise.flac'));
    });
    expect(() => archiveFormat('https://example.org/x.rar')).toThrow(/name its format/);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('installing from archives', () => {
  it('takes notes out of a tar.xz (FLAC decoded, WAV as it is) and mixes downloads out of a ZIP', async () => {
    const tarxz = fixture('notes.tar.xz');
    const zip = fixture('notes.zip');
    const server = createServer((req, res) => {
      if (req.url === '/lib/notes.tar.xz') res.end(Buffer.from(tarxz));
      else if (req.url === '/lib/download?id=7') res.end(Buffer.from(zip));
      else res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    const root = mkdtempSync(join(tmpdir(), 'holo-unpack-install-'));
    try {
      const port = (server.address() as { port: number }).port;
      const flacWav = pcmWav(decodeFlac(SAMPLES['samples/stereo24-rs.flac']), 'Lavf59.27.100');
      const wav = SAMPLES['samples/mono16.wav'];
      const archived: PinnedPack = {
        id: 'lib',
        name: 'Lib',
        license: 'CC0-1.0',
        credit: '',
        source: {
          kind: 'archive',
          url: `http://127.0.0.1:${port}/lib/notes.tar.xz`,
          sha256: sha256(tarxz),
          software: 'Lavf59.27.100',
          entries: { 'a.wav': 'samples/stereo24-rs.flac', 'b.wav': 'samples/mono16.wav' },
        },
        instruments: [],
        files: { 'a.wav': sha256(flacWav), 'b.wav': sha256(wav) },
      };
      // a stereo note out of the ZIP (a FLAC), half a frame late and played a little faster
      const flac = SAMPLES['samples/stereo24-rs.flac'];
      const recipe = {
        in: [['z:samples/stereo24-rs.flac', 0.5, 0.5, { start: -0.5, rate: 8100 }]] as [
          string,
          number,
          number,
          { start: number; rate: number },
        ][],
        start: 0,
        frames: 600,
        fadeIn: 0,
        fadeOut: 8,
      };
      const made = mixFile(recipe, new Map([['z:samples/stereo24-rs.flac', decodeInput(flac)]]), 16);
      const mixed: PinnedPack = {
        id: 'mixed',
        name: 'Mixed',
        license: 'CC0-1.0',
        credit: '',
        source: {
          kind: 'mix',
          bases: {},
          archives: { z: { url: `http://127.0.0.1:${port}/lib/download?id=7`, sha256: sha256(zip), format: 'zip' } },
          downloads: { 'z:samples/stereo24-rs.flac': sha256(flac) },
          bits: 16,
          files: { 'n.wav': recipe },
        },
        instruments: [],
        files: { 'n.wav': sha256(made) },
      };
      const cache = new SampleCache(root);
      const want = [
        ...Object.keys(archived.files).map((path) => ({
          pack: archived,
          path,
          sha256: archived.files[path] as string,
        })),
        { pack: mixed, path: 'n.wav', sha256: sha256(made) },
      ];
      const lines: string[] = [];
      await fetchFiles(want, { cache, log: (l) => lines.push(l) });
      expect(cache.read(sha256(flacWav), '.wav')).toEqual(flacWav);
      expect(cache.read(sha256(wav), '.wav')).toEqual(wav);
      expect(cache.read(sha256(made), '.wav')).toEqual(made);
      expect(cache.has(sha256(flac), '.flac')).toBe(false);
      // the archives go once what was wanted is out of them, and so does the download the mix used
      expect(cache.has(sha256(tarxz), '.tar.xz')).toBe(false);
      expect(cache.has(sha256(zip), '.zip')).toBe(false);
      expect(lines.some((l) => l.startsWith('Unpacking 1 file(s) of Mixed'))).toBe(true);
      // an archive that isn't the pinned one is refused, and not kept
      const wrong = { ...archived, source: { ...archived.source, sha256: '0'.repeat(64) } } as PinnedPack;
      const fresh = new SampleCache(join(root, 'fresh'));
      await expect(fetchFiles([{ pack: wrong, path: 'b.wav', sha256: sha256(wav) }], { cache: fresh })).rejects.toThrow(
        /isn't the file the engine was pinned with/,
      );
      expect(fresh.has('0'.repeat(64), '.tar.xz')).toBe(false);
    } finally {
      server.close();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
