import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { decodeWav, encodeWav } from '@holo/engine';
import type { Project } from '@holo/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.ts';
import { PEAK_STEP, peaksOf, peaksPath, wavPeaks } from '../src/peaks.ts';

const work = mkdtempSync(join(tmpdir(), 'holo-peaks-test-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

/** A made-up take: a swell on the left, something quieter and offset on the right. */
const take = (frames: number, channels = 2): Float32Array[] =>
  Array.from({ length: channels }, (_, c) =>
    Float32Array.from({ length: frames }, (_, i) => Math.sin(i / (17 + c * 5)) * (i / frames) * (c ? 0.4 : 0.9)),
  );

/** The peaks the studio takes from a decoded file (computePeaks in apps/web/src/audio/files.ts). */
function studioPeaks(channels: Float32Array[], step: number): { min: number[]; max: number[] } {
  const length = channels[0]?.length ?? 0;
  const min: number[] = [];
  const max: number[] = [];
  for (let p = 0; p * step < length; p++) {
    let lo = 0;
    let hi = 0;
    for (const ch of channels) {
      for (let i = p * step; i < Math.min(length, (p + 1) * step); i++) {
        const v = ch[i] as number;
        if (v < lo) lo = v;
        if (v > hi) hi = v;
      }
    }
    min.push(lo);
    max.push(hi);
  }
  return { min, max };
}

/** Peak bytes as the studio reads them: [step, rate, count], the minima, the maxima. */
function read(bytes: Uint8Array) {
  const all = new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  const count = all[2] as number;
  return {
    step: all[0],
    rate: all[1],
    count,
    length: all.length,
    min: Array.from(all.subarray(3, 3 + count)),
    max: Array.from(all.subarray(3 + count)),
  };
}

/** A PCM WAV of 8, 16 or 32 bits (the engine's own writer makes 24-bit and float). */
function pcmWav(channels: Float32Array[], rate: number, bits: 8 | 16 | 32): Uint8Array {
  const width = bits / 8;
  const frames = channels[0]?.length ?? 0;
  const out = Buffer.alloc(44 + frames * channels.length * width);
  out.write('RIFF', 0, 'latin1');
  out.writeUInt32LE(out.length - 8, 4);
  out.write('WAVEfmt ', 8, 'latin1');
  out.writeUInt32LE(16, 16);
  out.writeUInt16LE(1, 20);
  out.writeUInt16LE(channels.length, 22);
  out.writeUInt32LE(rate, 24);
  out.writeUInt32LE(rate * channels.length * width, 28);
  out.writeUInt16LE(channels.length * width, 32);
  out.writeUInt16LE(bits, 34);
  out.write('data', 36, 'latin1');
  out.writeUInt32LE(out.length - 44, 40);
  let at = 44;
  for (let i = 0; i < frames; i++) {
    for (const ch of channels) {
      const v = ch[i] as number;
      if (bits === 8) out.writeUInt8(Math.round(v * 127) + 128, at);
      else if (bits === 16) out.writeInt16LE(Math.round(v * 32767), at);
      else out.writeInt32LE(Math.round(v * 2147483647), at);
      at += width;
    }
  }
  return new Uint8Array(out);
}

/** A chunk put between a WAV's format and its samples, as recorders and editors leave them. */
function withChunk(wav: Uint8Array, id: string, length: number): Uint8Array {
  const body = length + (length & 1);
  const out = Buffer.alloc(wav.length + 8 + body);
  out.set(wav.subarray(0, 36), 0);
  out.write(id, 36, 'latin1');
  out.writeUInt32LE(length, 40);
  out.set(wav.subarray(36), 44 + body);
  out.writeUInt32LE(out.length - 8, 4);
  return new Uint8Array(out);
}

const write = (name: string, bytes: Uint8Array) => {
  const path = join(work, name);
  writeFileSync(path, bytes);
  return path;
};

describe("a WAV file's peaks, made on the host", () => {
  // (longer than one read of the file, and not a whole number of peaks)
  const frames = PEAK_STEP * 300 + 77;
  const cases: [string, Uint8Array][] = [
    ['32-bit float, stereo', encodeWav(take(frames), 48000, 'float32')],
    ['24-bit, stereo', encodeWav(take(frames), 44100, 'pcm24')],
    ['24-bit, mono', encodeWav(take(frames, 1), 96000, 'pcm24')],
    ['16-bit, stereo', pcmWav(take(frames), 44100, 16)],
    ['8-bit, mono', pcmWav(take(frames, 1), 22050, 8)],
    ['32-bit, stereo', pcmWav(take(frames), 48000, 32)],
    ['with a chunk before its samples', withChunk(encodeWav(take(frames), 48000, 'pcm24'), 'LIST', 4097)],
  ];
  it.each(cases)('are the peaks the studio takes from the decoded file: %s', async (name, wav) => {
    const peaks = await wavPeaks(write(`${name.replace(/\W+/g, '-')}.wav`, wav));
    expect(peaks).not.toBeNull();
    const got = read(peaks as Uint8Array);
    const decoded = decodeWav(wav);
    const want = studioPeaks(decoded.channels, PEAK_STEP);
    expect(got.step).toBe(PEAK_STEP);
    expect(got.rate).toBe(decoded.rate);
    expect(got.count).toBe(Math.ceil(frames / PEAK_STEP));
    expect(got.length).toBe(3 + got.count * 2);
    expect(got.min).toEqual(want.min);
    expect(got.max).toEqual(want.max);
    // (something to draw: the take isn't silence)
    expect(Math.max(...got.max)).toBeGreaterThan(0.1);
  });

  it("has none for what isn't a WAV the engine reads", async () => {
    expect(await wavPeaks(write('not.wav', new TextEncoder().encode('ID3 an MP3 by another name')))).toBeNull();
    const empty = encodeWav([new Float32Array(0)], 48000, 'pcm24');
    expect(await wavPeaks(write('empty.wav', empty))).toBeNull();
    // a compressed WAV (µ-law)
    const mulaw = pcmWav(take(4000, 1), 8000, 8);
    new DataView(mulaw.buffer).setUint16(20, 7, true);
    expect(await wavPeaks(write('mulaw.wav', mulaw))).toBeNull();
  });

  it('draws a file cut short as far as it goes', async () => {
    const whole = encodeWav(take(PEAK_STEP * 40), 48000, 'float32');
    const cut = whole.subarray(0, 44 + PEAK_STEP * 10 * 8);
    const got = read((await wavPeaks(write('cut.wav', cut))) as Uint8Array);
    expect(got.count).toBe(10);
  });
});

describe("a file's peaks, kept beside it", () => {
  it('are made once, for everyone who asks meanwhile, and read from there after', async () => {
    const dir = join(work, 'kept');
    mkdirSync(dir);
    const audio = join(dir, 'aud_one.wav');
    writeFileSync(audio, encodeWav(take(PEAK_STEP * 50), 48000, 'float32'));
    const [a, b] = await Promise.all([peaksOf(audio), peaksOf(audio)]);
    expect(a).toBe(b);
    expect(peaksPath(audio)).toBe(join(dir, '.aud_one.peaks'));
    expect(new Uint8Array(readFileSync(peaksPath(audio)))).toEqual(a);
    expect(existsSync(`${peaksPath(audio)}.part`)).toBe(false);
    // kept: the file isn't read again (its samples gone, the peaks are still handed out)
    const made = statSync(peaksPath(audio)).mtimeMs;
    writeFileSync(audio, new Uint8Array(0));
    utimesSync(audio, new Date(made - 5000), new Date(made - 5000));
    expect(await peaksOf(audio)).toEqual(a);
  });

  it('are made again when the file is newer than they are, or they are not whole', async () => {
    const dir = join(work, 'again');
    mkdirSync(dir);
    const audio = join(dir, 'aud_two.wav');
    writeFileSync(audio, encodeWav(take(PEAK_STEP * 20), 48000, 'float32'));
    const first = read((await peaksOf(audio)) as Uint8Array);
    expect(first.count).toBe(20);
    // the file replaced by a longer one
    writeFileSync(audio, encodeWav(take(PEAK_STEP * 30), 48000, 'float32'));
    const later = Date.now() + 5000;
    utimesSync(audio, new Date(later), new Date(later));
    expect(read((await peaksOf(audio)) as Uint8Array).count).toBe(30);
    // its peaks cut short (a disk that filled)
    writeFileSync(peaksPath(audio), readFileSync(peaksPath(audio)).subarray(0, 40));
    utimesSync(peaksPath(audio), new Date(later + 5000), new Date(later + 5000));
    expect(read((await peaksOf(audio)) as Uint8Array).count).toBe(30);
  });
});

describe('the peaks of a song’s audio files, from the host', () => {
  let app: Awaited<ReturnType<typeof buildApp>>['app'];
  let song: Project;
  beforeAll(async () => {
    ({ app } = await buildApp({
      port: 0,
      host: '127.0.0.1',
      dataDir: join(work, 'data'),
      creationsDir: null,
      webDir: join(work, 'no-web'),
      repoDir: resolve(import.meta.dirname, '../../..'),
      networkMidi: null,
    }));
    song = (await app.inject({ method: 'POST', url: '/api/projects', payload: { title: 'Peaks' } })).json();
  }, 30_000);
  afterAll(async () => {
    await app.close();
  });

  const upload = async (bytes: Uint8Array, name: string) =>
    (
      await app.inject({
        method: 'POST',
        url: `/api/projects/${song.id}/files?name=${encodeURIComponent(name)}`,
        headers: { 'content-type': 'application/x-holo-audio' },
        payload: Buffer.from(bytes),
      })
    ).json() as { id: string };
  const peaks = (file: string, id = song.id) =>
    app.inject({ method: 'GET', url: `/api/projects/${id}/files/${file}/peaks` });

  it('hands out a WAV’s peaks, and the file itself as before', async () => {
    const wav = encodeWav(take(PEAK_STEP * 64 + 5), 48000, 'float32');
    const { id } = await upload(wav, 'take.wav');
    const res = await peaks(id);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/octet-stream');
    expect(res.headers['cache-control']).toContain('immutable');
    const got = read(new Uint8Array(res.rawPayload));
    expect(got).toMatchObject({ step: PEAK_STEP, rate: 48000, count: 65 });
    expect(got.max).toEqual(studioPeaks(decodeWav(wav).channels, PEAK_STEP).max);
    // kept beside the file, under a name no id finds: the file is still the file
    expect(existsSync(join(work, 'data', 'audio', song.id, `.${id}.peaks`))).toBe(true);
    const file = await app.inject({ method: 'GET', url: `/api/projects/${song.id}/files/${id}` });
    expect(file.statusCode).toBe(200);
    expect(file.headers['content-type']).toBe('audio/wav');
    expect(file.rawPayload.length).toBe(wav.length);
    // and asked again, the same
    expect(new Uint8Array((await peaks(id)).rawPayload)).toEqual(new Uint8Array(res.rawPayload));
  });

  it('has none for a file the host doesn’t read, or one that isn’t there', async () => {
    const { id } = await upload(new TextEncoder().encode('ID3 not really an MP3'), 'idea.mp3');
    expect((await peaks(id)).statusCode).toBe(404);
    expect((await peaks('aud_nosuchfile')).statusCode).toBe(404);
    expect((await peaks('..%2Fsecrets')).statusCode).toBe(404);
    expect((await peaks(id, 'prj_nosuchsong')).statusCode).toBe(404);
  });
});
