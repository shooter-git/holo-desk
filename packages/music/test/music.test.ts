import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeWav, encodeWav, renderSession } from '@holo/engine';
import { newProject, newRegion, newTrack, PPQ, type Project, parseProject } from '@holo/session';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { buildMusic, checkNode, listSongs, openExperience } from '../src/build.ts';
import { distance } from '../src/compare.ts';
import { cutNote, decodeAiff, floatWav } from '../src/cut.ts';
import { fetchFiles, SampleCache, sha256 } from '../src/fetch.ts';
import {
  type EngineIdentity,
  engineChanged,
  engineCode,
  engineLabel,
  engineRelation,
  engineSource,
  liveSource,
} from '../src/identity.ts';
import { type ExperienceManifest, readManifest, slug, titleOf, writeManifest } from '../src/manifest.ts';
import { formatLock, manifestOf, packSha256, parseLock } from '../src/pack-lock.ts';
import {
  formatChecksums,
  formatPinnedPacks,
  type PinnedPack,
  packPaths,
  parseChecksums,
  parsePinnedPacks,
  pinPack,
  songFiles,
  songPacks,
} from '../src/packs.ts';
import { experienceSource } from '../src/source.ts';
import { describePackChange, syncPinnedPacks } from '../src/sync.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-music-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));
const REPO = resolve(import.meta.dirname, '../../..');

/** A tone as a 16-bit WAV. */
function toneWav(seconds = 0.5, rate = 44100, hz = 440): Uint8Array {
  const n = Math.round(seconds * rate);
  const x = new Float32Array(n);
  for (let i = 0; i < n; i++) x[i] = 0.5 * Math.sin((2 * Math.PI * hz * i) / rate) * Math.exp(-i / rate);
  return encodeWav([x], rate, 'pcm24');
}

/** A run of samples as a 16-bit big-endian mono AIFF, as the Iowa downloads are. */
function aiff(samples: Int16Array, rate = 44100): Uint8Array {
  const comm = Buffer.alloc(8 + 18);
  comm.write('COMM', 0);
  comm.writeUInt32BE(18, 4);
  comm.writeUInt16BE(1, 8);
  comm.writeUInt32BE(samples.length, 10);
  comm.writeUInt16BE(16, 14);
  // 44100 as an 80-bit extended float
  const exp = 16383 + Math.floor(Math.log2(rate));
  comm.writeUInt16BE(exp, 16);
  const mant = rate * 2 ** (63 - Math.floor(Math.log2(rate)));
  comm.writeUInt32BE(Math.floor(mant / 2 ** 32), 18);
  comm.writeUInt32BE(mant % 2 ** 32, 22);
  const ssnd = Buffer.alloc(8 + 8 + samples.length * 2);
  ssnd.write('SSND', 0);
  ssnd.writeUInt32BE(8 + samples.length * 2, 4);
  for (let i = 0; i < samples.length; i++) ssnd.writeInt16BE(samples[i] as number, 16 + i * 2);
  const form = Buffer.alloc(12);
  form.write('FORM', 0);
  form.writeUInt32BE(4 + comm.length + ssnd.length, 4);
  form.write('AIFF', 8);
  return new Uint8Array(Buffer.concat([form, comm, ssnd]));
}

const identity = (over: Partial<EngineIdentity>): EngineIdentity => ({
  version: '0.1.0',
  source: 'a'.repeat(64),
  commit: '1'.repeat(40),
  date: '2026-10-01T00:00:00.000Z',
  ...over,
});

describe('the engine an experience is built with', () => {
  it('is a fingerprint of its sources, the same for the same files and line endings', () => {
    const a = join(work, 'id-a');
    const write = (root: string, text: string) => {
      mkdirSync(join(root, 'packages/engine/src'), { recursive: true });
      writeFileSync(join(root, 'packages/engine/src/x.ts'), text);
      mkdirSync(join(root, 'packs/manifests'), { recursive: true });
      writeFileSync(join(root, 'packs/manifests/p.json'), '{}\n');
    };
    write(a, 'export const x = 1;\n');
    const b = join(work, 'id-b');
    write(b, 'export const x = 1;\r\n');
    expect(engineSource(a)).toBe(engineSource(b));
    write(b, 'export const x = 2;\n');
    expect(engineSource(a)).not.toBe(engineSource(b));
    expect(engineSource(REPO)).toMatch(/^[0-9a-f]{64}$/);
  });

  it("fingerprints what plays live (HO[LO] Engine's engine) apart from the rest", () => {
    const root = join(work, 'live');
    const put = (path: string, text: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    put('packages/engine/src/core.ts', 'export const a = 1;\n');
    put('packages/session/src/ops.ts', 'export const b = 1;\n');
    put('packages/music/src/fetch.ts', 'export const c = 1;\n');
    put('packs/manifests/p.json', '{}\n');
    const first = liveSource(root);
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    // a pack's map or the build's fetching don't change how an Engine plays...
    put('packs/manifests/p.json', '{"x":1}\n');
    put('packages/music/src/fetch.ts', 'export const c = 2;\n');
    expect(liveSource(root)).toBe(first);
    // ...the engine and the session format do
    put('packages/session/src/ops.ts', 'export const b = 2;\n');
    expect(liveSource(root)).not.toBe(first);
    expect(liveSource(REPO)).not.toBe(engineSource(REPO));
  });

  it('fingerprints the packs it plays by its lock, and its code apart from them', () => {
    const root = join(work, 'locked');
    const put = (path: string, text: string) => {
      mkdirSync(join(root, path, '..'), { recursive: true });
      writeFileSync(join(root, path), text);
    };
    const lock = (hash: string) =>
      formatLock({
        format: 'holo-packs-lock',
        version: 1,
        repo: 'test/packs',
        commit: 'c'.repeat(40),
        packs: { tones: hash.repeat(64) },
      });
    put('packages/engine/src/core.ts', 'export const a = 1;\n');
    put('packs.lock.json', lock('a'));
    const source = engineSource(root);
    const code = engineCode(root);
    // a pack's map moved on: another engine, the same code
    put('packs.lock.json', lock('b'));
    expect(engineSource(root)).not.toBe(source);
    expect(engineCode(root)).toBe(code);
    // the code changed
    put('packages/engine/src/core.ts', 'export const a = 2;\n');
    expect(engineCode(root)).not.toBe(code);
    expect(parseLock(lock('a')).packs.tones).toBe('a'.repeat(64));
    expect(() => parseLock(lock('a').replace('test/packs', 'not a repo'))).toThrow(/owner\/name/);
  });

  it("is the same sound when only packs its experience doesn't play changed", () => {
    const catalog = { tones: 'a'.repeat(64), drums: 'b'.repeat(64) };
    const pinned = identity({ code: 'c'.repeat(64), date: '2026-10-01T00:00:00.000Z' });
    const studio = {
      ...identity({ source: 'f'.repeat(64), code: 'c'.repeat(64), date: '2026-11-01T00:00:00.000Z' }),
      packs: { tones: 'a'.repeat(64), drums: 'd'.repeat(64), strings: 'e'.repeat(64) },
    };
    // it plays the tones only: the drums changed and the strings arrived, neither matters
    expect(engineRelation({ ...pinned, catalog, pinned: ['tones'] }, studio)).toBe('same');
    // it plays the drums: they changed
    expect(engineRelation({ ...pinned, catalog, pinned: ['drums', 'tones'] }, studio)).toBe('older');
    // the code changed
    expect(engineRelation({ ...pinned, catalog, pinned: ['tones'] }, { ...studio, code: 'd'.repeat(64) })).toBe(
      'older',
    );
    // pinned before the catalog: the whole engine, as before
    expect(engineRelation(pinned, studio)).toBe('older');
  });

  it('puts two engines in order by their commits, and says when it cannot', () => {
    const studio = identity({ source: 'b'.repeat(64), date: '2026-10-17T00:00:00.000Z' });
    expect(engineRelation(identity({ source: studio.source }), studio)).toBe('same');
    expect(engineRelation(identity({}), studio)).toBe('older');
    expect(engineRelation(identity({ date: '2026-11-01T00:00:00.000Z' }), studio)).toBe('newer');
    expect(engineRelation(identity({ date: null }), studio)).toBe('different');
    // the studio's own uncommitted changes come after its commit
    expect(engineRelation(identity({ date: studio.date }), { ...studio, changed: true })).toBe('older');
    expect(engineLabel(identity({ commit: 'abcdef1234' }))).toBe('0.1.0+abcdef1');
    expect(engineLabel({ ...studio, commit: null })).toBe('0.1.0+bbbbbbb');
  });

  it('names things as the studio does', () => {
    expect(slug('Night Window')).toBe('night-window');
    expect(slug('Ça va? — Theme #2')).toBe('ca-va-theme-2');
    expect(slug('!!!')).toBe('song');
    expect(titleOf('night-window')).toBe('Night Window');
  });
});

describe('notes cut from a recorded run', () => {
  it('reads AIFF as ffmpeg does (int16 / 32768) and finds its rate', () => {
    const run = new Int16Array([0, 16384, -32768, 32767, 100]);
    const d = decodeAiff(aiff(run));
    expect(d.rate).toBe(44100);
    expect(Array.from(d.channels[0] as Float32Array)).toEqual([0, 0.5, -1, 32767 / 32768, 100 / 32768]);
  });

  it("fades as numpy's linspace does and writes scipy's float WAV, byte for byte", () => {
    const x = new Float32Array(1000).fill(0.5);
    const y = cutNote(x, 100, 400, 88);
    expect(y.length).toBe(400);
    expect(y[0]).toBe(0);
    expect(y[87]).toBe(0.5);
    expect(y[1]).toBe(Math.fround(0.5 * (1 / 87)));
    expect(y[399]).toBe(0);
    expect(y[200]).toBe(0.5);
    const wav = floatWav(y, 44100);
    // RIFF, fmt (18 bytes, with cbSize), fact, data: 58 bytes before the samples
    expect(wav.length).toBe(58 + 400 * 4);
    expect(Buffer.from(wav.subarray(36, 42)).toString('latin1')).toBe('\0\0fact');
    const back = decodeWav(wav);
    expect(back.rate).toBe(44100);
    expect(Array.from(back.channels[0] as Float32Array)).toEqual(Array.from(y));
    expect(() => cutNote(x, 900, 400, 88)).toThrow(/past the end/);
  });
});

describe('the pinned libraries', () => {
  const zone = (file: string) => ({
    file,
    root: 69,
    lo: 0,
    hi: 127,
    lovel: 1,
    hivel: 127,
    gain: 0,
    start: 0,
    end: 0,
    loopStart: 0,
    loopEnd: 0,
    rate: 44100,
    rr: 1,
  });
  const manifest = {
    format: 'holo-pack' as const,
    version: 1 as const,
    id: 'tones',
    name: 'Tones',
    license: 'CC0-1.0',
    credit: 'test',
    source: { kind: 'local' as const, note: 'test' },
    root: 'samples',
    instruments: [
      {
        name: 'tone',
        title: 'Tone',
        release: 0.2,
        attack: 0,
        oneShot: false,
        velocityRange: 12,
        zones: [zone('a/tone.wav')],
      },
    ],
  };

  it('lists every file a pack plays and pins each by checksum', () => {
    expect(packPaths(manifest)).toEqual(['a/tone.wav']);
    const sums = { 'a/tone.wav': 'f'.repeat(64) };
    expect(parseChecksums(formatChecksums(sums))).toEqual(sums);
    const pinned = pinPack(manifest, sums);
    expect(pinned.files).toEqual(sums);
    expect(() => pinPack(manifest, {})).toThrow(/no checksum/);
    const text = formatPinnedPacks([pinned]);
    expect(parsePinnedPacks(text).packs[0]?.id).toBe('tones');
    expect(text.split('\n').length).toBe(4);
  });

  it("says what a song needs, and what isn't pinned", () => {
    const pinned = pinPack(manifest, { 'a/tone.wav': 'f'.repeat(64) });
    const song = newProject('t');
    song.tracks = [
      newTrack('A', { type: 'sampler', pack: 'tones', name: 'tone' }, '#fff'),
      newTrack('B', { type: 'sampler', pack: 'nope', name: 'x' }, '#fff'),
      newTrack('C', { type: 'sampler', pack: 'tones', name: 'missing' }, '#fff'),
      newTrack('D', { type: 'synth', preset: 'Warm Pad' }, '#fff'),
    ];
    const { files, problems } = songFiles(song, { format: 'holo-packs', version: 1, packs: [pinned] });
    expect(files.map((f) => f.path)).toEqual(['a/tone.wav']);
    expect(problems).toHaveLength(2);
    expect(problems[0]).toMatch(/isn't one of the sample libraries/);
    expect(problems[1]).toMatch(/no instrument "missing"/);
    // the packs it plays, whatever's pinned: what an experience pins for it
    expect(songPacks(song)).toEqual(['nope', 'tones']);
    // a pack its engine knows that the project doesn't pin yet says how to get it
    const known = songFiles(song, { format: 'holo-packs', version: 1, packs: [pinned] }, { nope: 'a'.repeat(64) });
    expect(known.problems[0]).toMatch(/isn't pinned for this project yet: Send the song from the studio/);
  });
});

describe('fetching samples', () => {
  it('keeps only files whose checksum is the pinned one', async () => {
    const cache = new SampleCache(join(work, 'cache-a'));
    expect(() => cache.put('0'.repeat(64), '.wav', new Uint8Array([1]), 'x')).toThrow(/isn't the file/);
    const from = join(work, 'from');
    const bytes = toneWav();
    mkdirSync(join(from, 'tones/samples/a'), { recursive: true });
    writeFileSync(join(from, 'tones/samples/a/tone.wav'), bytes);
    const pack: PinnedPack = {
      id: 'tones',
      name: 'Tones',
      license: 'CC0-1.0',
      credit: '',
      source: { kind: 'local' },
      root: 'samples',
      instruments: [],
      files: { 'a/tone.wav': sha256(bytes) },
    };
    const want = [{ pack, path: 'a/tone.wav', sha256: sha256(bytes) }];
    await expect(fetchFiles(want, { cache })).rejects.toThrow(/can't be downloaded/);
    await fetchFiles(want, { cache, from: [from] });
    expect(cache.read(sha256(bytes), '.wav')).toEqual(bytes);
  });

  it('cuts notes from a run it downloads, checking the run and every note', async () => {
    const run = new Int16Array(44100);
    for (let i = 0; i < run.length; i++) run[i] = Math.round(8000 * Math.sin(i / 7));
    const download = aiff(run);
    const server = createServer((req, res) => {
      if (req.url === '/files/Run%20One.aiff') res.end(Buffer.from(download));
      else res.writeHead(404).end();
    });
    await new Promise<void>((ok) => server.listen(0, '127.0.0.1', ok));
    try {
      const port = (server.address() as { port: number }).port;
      const note = floatWav(cutNote(decodeAiff(download).channels[0] as Float32Array, 441, 4410, 88), 44100);
      const pack: PinnedPack = {
        id: 'runs',
        name: 'Runs',
        license: 'test',
        credit: '',
        source: {
          kind: 'cut',
          base: `http://127.0.0.1:${port}/files/`,
          rate: 44100,
          fade: 88,
          downloads: { 'Run One.aiff': sha256(download) },
          cuts: { 'Note/A4.wav': ['Run One.aiff', 441, 4410] },
        },
        instruments: [],
        files: { 'Note/A4.wav': sha256(note) },
      };
      const cache = new SampleCache(join(work, 'cache-b'));
      await fetchFiles([{ pack, path: 'Note/A4.wav', sha256: sha256(note) }], { cache });
      expect(cache.read(sha256(note), '.wav')).toEqual(note);
      // a recipe that cuts elsewhere makes another file, which isn't kept
      const wrong = { ...pack, source: { ...pack.source, cuts: { 'Note/A4.wav': ['Run One.aiff', 882, 4410] } } };
      const other = new SampleCache(join(work, 'cache-c'));
      await expect(
        fetchFiles([{ pack: wrong as PinnedPack, path: 'Note/A4.wav', sha256: sha256(note) }], { cache: other }),
      ).rejects.toThrow(/isn't the file the engine was pinned with/);
    } finally {
      server.close();
    }
  });

  it("fetches a GitHub library's files at the pinned commit", async () => {
    const bytes = toneWav(0.1);
    const seen: string[] = [];
    vi.stubGlobal('fetch', async (url: string) => {
      seen.push(url);
      return new Response(bytes);
    });
    try {
      const pack: PinnedPack = {
        id: 'gh',
        name: 'GH',
        license: 'CC0-1.0',
        credit: '',
        source: { kind: 'git', url: 'https://github.com/someone/Some-Lib.git', commit: 'c'.repeat(40) },
        instruments: [],
        files: { 'Keys/A #1.wav': sha256(bytes) },
      };
      const cache = new SampleCache(join(work, 'cache-d'));
      await fetchFiles([{ pack, path: 'Keys/A #1.wav', sha256: sha256(bytes) }], { cache });
      expect(seen).toEqual([`https://raw.githubusercontent.com/someone/Some-Lib/${'c'.repeat(40)}/Keys/A%20%231.wav`]);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});

describe('how far two renders are apart', () => {
  it('knows identical, quieter differences and changed lengths', () => {
    const a = [new Float32Array([0.5, -0.5, 0.25, 0])];
    expect(distance(a, [Float32Array.from(a[0] as Float32Array)]).identical).toBe(true);
    const d = distance(a, [new Float32Array([0.5, -0.5, 0.25, 0.001])]);
    expect(d.identical).toBe(false);
    expect(d.firstFrame).toBe(3);
    expect(d.peakDb).toBeCloseTo(-60, 3);
    expect(distance(a, [new Float32Array([0.5, -0.5, 0.25])]).frames).toEqual([4, 3]);
  });
});

/** An experience pinned by hand (no bundle): a manifest, a libraries file, a song or two. */
function experience(
  name: string,
  songs: Record<string, Project>,
): { root: string; cache: SampleCache; tone: Uint8Array } {
  const root = join(work, name);
  const tone = toneWav();
  const pack = pinPack(
    {
      format: 'holo-pack',
      version: 1,
      id: 'tones',
      name: 'Tones',
      license: 'CC0-1.0',
      credit: '',
      source: { kind: 'local' },
      root: 'samples',
      instruments: [
        {
          name: 'tone',
          release: 0.2,
          attack: 0,
          oneShot: false,
          velocityRange: 12,
          zones: [
            {
              file: 'tone.wav',
              root: 69,
              lo: 0,
              hi: 127,
              lovel: 1,
              hivel: 127,
              gain: 0,
              start: 0,
              end: 0,
              loopStart: 0,
              loopEnd: 0,
              rate: 44100,
              rr: 1,
            },
          ],
        },
      ],
    },
    { 'tone.wav': sha256(tone) },
  );
  const packsText = formatPinnedPacks([pack]);
  mkdirSync(join(root, 'music/holo'), { recursive: true });
  writeFileSync(join(root, 'music/holo/packs.json'), packsText);
  const manifest: ExperienceManifest = {
    format: 'holo-creation',
    version: 1,
    name,
    title: titleOf(name),
    sessions: 'music/sessions',
    engine: {
      version: '0.1.0',
      source: 'e'.repeat(64),
      commit: null,
      date: null,
      node: process.versions.node,
      file: 'music/holo/holo-music.mjs',
      sha256: '0'.repeat(64),
      packs: 'music/holo/packs.json',
      packsSha256: sha256(Buffer.from(packsText)),
    },
    build: { out: 'music/build', format: 'wav', tail: 1 },
  };
  writeManifest(root, manifest);
  mkdirSync(join(root, 'music/sessions'), { recursive: true });
  for (const [piece, p] of Object.entries(songs))
    writeFileSync(join(root, 'music/sessions', `${piece}.holo.json`), JSON.stringify(p));
  const cache = new SampleCache(join(work, `${name}-cache`));
  cache.put(sha256(tone), '.wav', tone, 'tone');
  return { root, cache, tone };
}

function song(title: string, pitch = 69): Project {
  const p = newProject(title);
  const t = newTrack('Tone', { type: 'sampler', pack: 'tones', name: 'tone' }, '#fff');
  t.regions = [{ ...newRegion(0, PPQ * 4, ''), notes: [{ t: 0, d: PPQ, p: pitch, v: 100 }] }];
  const s = newTrack('Pad', { type: 'synth', preset: 'Warm Pad' }, '#fff');
  s.regions = [{ ...newRegion(0, PPQ * 4, ''), notes: [{ t: PPQ, d: PPQ * 2, p: 57, v: 80 }] }];
  p.tracks = [t, s];
  return p;
}

describe("building an experience's music", () => {
  it('renders each song exactly as the engine does, and only again when it changed', async () => {
    const { root, cache, tone } = experience('quiet-garden', { theme: song('Theme'), ending: song('Ending', 72) });
    const exp = openExperience(root);
    expect(listSongs(exp).map((s) => s.piece)).toEqual(['ending', 'theme']);
    const lines: string[] = [];
    const opts = { fetch: { cache }, log: (l: string) => lines.push(l) };
    const first = await buildMusic(exp, opts);
    expect(first.built.map((b) => b.piece)).toEqual(['ending', 'theme']);
    const out = join(root, 'music/build/theme.wav');
    // the same numbers as the engine's own render, as `holo render-audio` makes them
    const project = JSON.parse(readFileSync(join(root, 'music/sessions/theme.holo.json'), 'utf8'));
    const direct = await renderSession(
      parseProject(project),
      {
        instrument: async () => ({ ...exp.packs.packs[0]?.instruments[0], pack: 'tones' }) as never,
        sample: async () => tone,
        audio: async () => {
          throw new Error('none');
        },
        impulse: async () => {
          throw new Error('none');
        },
      },
      { sampleRate: 48000, tail: 1 },
    );
    expect(readFileSync(out)).toEqual(Buffer.from(encodeWav(direct.channels, 48000, 'float32')));

    expect((await buildMusic(exp, opts)).fresh).toEqual(['ending', 'theme']);
    const changed = song('Theme', 64);
    writeFileSync(join(root, 'music/sessions/theme.holo.json'), JSON.stringify(changed));
    const second = await buildMusic(exp, opts);
    expect(second.built.map((b) => b.piece)).toEqual(['theme']);
    expect(second.fresh).toEqual(['ending']);
    rmSync(join(root, 'music/sessions/ending.holo.json'));
    expect((await buildMusic(exp, opts)).removed).toEqual(['ending']);
    expect(() => statSync(join(root, 'music/build/ending.wav'))).toThrow();
  }, 60_000);

  it('plays a song’s own audio files, kept beside it', async () => {
    const p = song('With audio');
    p.files = [{ id: 'aud_abc123', name: 'take.wav', seconds: 0.5, rate: 44100, channels: 1 }];
    const audio = newTrack('Take', { type: 'none' }, '#fff');
    audio.kind = 'audio';
    const region = newRegion(0, PPQ * 2, 'take');
    region.audio = { file: 'aud_abc123', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
    audio.regions = [region];
    p.tracks.push(audio);
    const { root, cache } = experience('with-audio', { take: p });
    const exp = openExperience(root);
    await expect(buildMusic(exp, { fetch: { cache }, log: () => undefined })).rejects.toThrow(/isn't in/);
    mkdirSync(join(root, 'music/sessions/take.audio'), { recursive: true });
    writeFileSync(join(root, 'music/sessions/take.audio/aud_abc123.wav'), toneWav(0.5, 44100, 880));
    const built = await buildMusic(exp, { fetch: { cache }, log: () => undefined });
    expect(built.built).toHaveLength(1);
    const source = experienceSource(exp.packs, join(root, 'music/sessions/take.audio'), { cache });
    expect((await source.audio('aud_abc123')).length).toBeGreaterThan(44);
  });

  it('refuses another Node.js unless told, and a libraries file that changed', () => {
    const { root } = experience('strict', {});
    const exp = openExperience(root);
    const other = { ...exp, engine: { ...exp.engine, node: '0.0.1' } };
    expect(() => checkNode(other, false, () => undefined)).toThrow(/builds with Node.js 0.0.1/);
    const warned: string[] = [];
    checkNode(other, true, (l) => warned.push(l));
    expect(warned[0]).toMatch(/--any-node/);
    writeFileSync(join(root, 'music/holo/packs.json'), `${readFileSync(join(root, 'music/holo/packs.json'), 'utf8')} `);
    expect(() => openExperience(root)).toThrow(/isn't the file the engine was pinned with/);
  });
});

/** The lock HEAD has (pins are made from commits), or null for a commit from before the lock. */
function headLock() {
  try {
    return parseLock(execFileSync('git', ['-C', REPO, 'show', 'HEAD:packs.lock.json'], { encoding: 'utf8' }));
  } catch {
    return null;
  }
}

describe('the packs an experience pins', () => {
  /** An experience whose engine knows the tones and the drums (from a packs repository at a commit). */
  function pinnedExperience(name: string) {
    const made = experience(name, { a: song('A') });
    const file = join(made.root, 'music/holo/packs.json');
    const tones = parsePinnedPacks(readFileSync(file, 'utf8')).packs[0] as PinnedPack;
    const drums: PinnedPack = { ...tones, id: 'drums', name: 'Drums' };
    const catalog = { drums: packSha256(drums), tones: packSha256(tones) };
    const m = readManifest(made.root);
    const engine = { ...(m.engine as NonNullable<ExperienceManifest['engine']>) };
    writeManifest(made.root, {
      ...m,
      engine: { ...engine, catalog, pinned: ['tones'], packsAt: { repo: 'test/packs', commit: 'c'.repeat(40) } },
    });
    // the packs repository at that commit
    const files = new Map([
      ['packs/drums/pack.json', JSON.stringify(manifestOf(drums), null, 1)],
      ['packs/drums/files.sha256', formatChecksums(drums.files)],
    ]);
    const asked: string[] = [];
    const fetch = async (url: string) => {
      asked.push(url);
      const text = files.get(url.replace(`https://raw.githubusercontent.com/test/packs/${'c'.repeat(40)}/`, ''));
      return { ok: text !== undefined, status: text ? 200 : 404, text: async () => text ?? '' };
    };
    const self = { version: engine.version, source: engine.source, commit: null, date: null, catalog };
    return { ...made, file, catalog, fetch, asked, self };
  }
  const playing = (title: string, pack: string) => {
    const p = song(title);
    p.tracks = [newTrack('Kit', { type: 'sampler', pack, name: 'tone' }, '#fff')];
    return p;
  };
  const sessions = (root: string) => join(root, 'music/sessions');

  it('are the ones its songs play: added as its engine knows them, let go when no song plays them', async () => {
    const x = pinnedExperience('pins');
    writeFileSync(join(sessions(x.root), 'b.holo.json'), JSON.stringify(playing('B', 'drums')));
    const added = await syncPinnedPacks(x.root, { mapsDir: null, fetch: x.fetch, studioPacks: x.catalog });
    expect(added).toEqual({ added: ['drums'], dropped: [], missing: [] });
    // from the packs repository at the engine's own commit, checked against its catalog
    expect(x.asked.every((u) => u.includes(`/test/packs/${'c'.repeat(40)}/packs/drums/`))).toBe(true);
    const exp = openExperience(x.root, x.self);
    expect(exp.packs.packs.map((p) => p.id)).toEqual(['drums', 'tones']);
    expect(readManifest(x.root).engine?.pinned).toEqual(['drums', 'tones']);

    // played but not sent yet ("Hear it as…"): added only, nothing let go
    rmSync(join(sessions(x.root), 'b.holo.json'));
    expect((await syncPinnedPacks(x.root, { mapsDir: null, fetch: x.fetch, addOnly: true })).dropped).toEqual([]);
    // sent: no song plays the drums now
    expect(await syncPinnedPacks(x.root, { mapsDir: null, fetch: x.fetch })).toEqual({
      added: [],
      dropped: ['drums'],
      missing: [],
    });
    expect(openExperience(x.root, x.self).packs.packs.map((p) => p.id)).toEqual(['tones']);
  });

  it("says what it can't pin: a pack newer than its engine, or one of your own", async () => {
    const x = pinnedExperience('cant');
    writeFileSync(join(sessions(x.root), 'c.holo.json'), JSON.stringify(playing('C', 'strings')));
    writeFileSync(join(sessions(x.root), 'd.holo.json'), JSON.stringify(playing('D', 'mine')));
    const before = readFileSync(x.file, 'utf8');
    const change = await syncPinnedPacks(x.root, {
      mapsDir: null,
      fetch: x.fetch,
      studioPacks: { ...x.catalog, strings: 'e'.repeat(64) },
    });
    expect(change.missing).toEqual([
      { id: 'mine', why: 'imported' },
      { id: 'strings', why: 'newer' },
    ]);
    expect(readFileSync(x.file, 'utf8')).toBe(before);
    const said = describePackChange('Cant', change, (id) => (id === 'strings' ? 'Strings' : id));
    expect(said).toMatch(/can't play Strings with its engine: holo update-engine/);
    expect(said).toMatch(/mine is a pack of your own/);
    // its map couldn't be fetched: said so, nothing written
    writeFileSync(join(sessions(x.root), 'e.holo.json'), JSON.stringify(playing('E', 'drums')));
    const away = await syncPinnedPacks(x.root, {
      mapsDir: null,
      fetch: async () => {
        throw new Error('offline');
      },
    });
    expect(away.missing.find((m) => m.id === 'drums')?.why).toBe('unreachable');
    expect(readFileSync(x.file, 'utf8')).toBe(before);
  });

  it("are played only as the engine's catalog has them", () => {
    const x = pinnedExperience('edited');
    const doc = parsePinnedPacks(readFileSync(x.file, 'utf8'));
    const edited = formatPinnedPacks(doc.packs.map((p) => ({ ...p, credit: 'edited by hand' })));
    writeFileSync(x.file, edited);
    const m = readManifest(x.root);
    writeManifest(x.root, {
      ...m,
      engine: { ...(m.engine as NonNullable<ExperienceManifest['engine']>), packsSha256: sha256(Buffer.from(edited)) },
    });
    expect(() => openExperience(x.root, x.self)).toThrow(/tones isn't the map this engine pins/);
  });
});

describe('a pinned engine', () => {
  it('bundles into one file, the same every time, that knows which engine it is', async () => {
    const { pinEngine } = await import('../src/pin.ts');
    const a = await pinEngine({ repo: REPO, dir: join(work, 'pin-a') });
    const b = await pinEngine({ repo: REPO, dir: join(work, 'pin-b') });
    expect(a.sha256).toBe(b.sha256);
    expect(a.packsSha256).toBe(b.packsSha256);
    const file = join(work, 'pin-a', 'holo-music.mjs');
    expect(sha256(readFileSync(file))).toBe(a.sha256);
    const said = JSON.parse(execFileSync(process.execPath, [file, 'version', '--json'], { encoding: 'utf8' }));
    expect(said.source).toBe(a.identity.source);
    // a commit with a lock: the renderer knows every pack it pins, and plays only those maps (none
    // asked for here); one from before the lock plays the one libraries file it was pinned with
    const lock = headLock();
    if (lock) {
      expect(said.code).toBe(a.identity.code);
      expect(said.catalog).toEqual(lock.packs);
      expect(said.packsSha256).toBeUndefined();
      expect(a.pinned).toEqual([]);
    } else expect(said.packsSha256).toBe(a.packsSha256);
    expect(readFileSync(join(work, 'pin-a', 'LICENSE'), 'utf8')).toMatch(/MIT License/);
  }, 60_000);

  it.skipIf(engineChanged(REPO))(
    'builds a song exactly as the engine here renders it, and only with its own libraries file',
    async () => {
      const { pinEngine } = await import('../src/pin.ts');
      const synth = newProject('Synth');
      const pad = newTrack('Pad', { type: 'synth', preset: 'Warm Pad' }, '#fff');
      pad.regions = [{ ...newRegion(0, PPQ * 4, ''), notes: [{ t: 0, d: PPQ * 2, p: 57, v: 90 }] }];
      synth.tracks = [pad];
      const { root, cache } = experience('pinned', { synth });
      const pin = await pinEngine({ repo: REPO, dir: join(root, 'music/holo') });
      const m = JSON.parse(readFileSync(join(root, 'holo.creation.json'), 'utf8')) as ExperienceManifest;
      writeManifest(root, {
        ...m,
        engine: {
          ...(m.engine as NonNullable<ExperienceManifest['engine']>),
          ...pin.identity,
          sha256: pin.sha256,
          packsSha256: pin.packsSha256,
          ...(pin.catalog ? { catalog: pin.catalog, pinned: pin.pinned } : {}),
          ...(pin.packsAt ? { packsAt: pin.packsAt } : {}),
        },
      });
      const bundle = join(root, 'music/holo/holo-music.mjs');
      const run = () =>
        execFileSync(process.execPath, [bundle, 'build', '--root', root], {
          encoding: 'utf8',
          stdio: 'pipe',
          env: { ...process.env, HOLO_MUSIC_CACHE: cache.dir },
        });
      run();
      const none = async (): Promise<never> => {
        throw new Error('none');
      };
      const direct = await renderSession(
        parseProject(JSON.parse(JSON.stringify(synth))),
        { instrument: none, sample: none, audio: none, impulse: none },
        { sampleRate: 48000, tail: 1 },
      );
      expect(readFileSync(join(root, 'music/build/synth.wav'))).toEqual(
        Buffer.from(encodeWav(direct.channels, 48000, 'float32')),
      );
      expect(run()).toMatch(/Nothing to build/);
      writeFileSync(
        join(root, 'music/holo/packs.json'),
        `${readFileSync(join(root, 'music/holo/packs.json'), 'utf8')}\n`,
      );
      expect(() => run()).toThrow(/isn't the file the engine was pinned with/);
    },
    60_000,
  );
});
