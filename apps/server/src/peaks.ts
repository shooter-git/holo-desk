/**
 * A recording's waveform peaks, made on the host. The studio draws a recording from them, where it
 * used to decode the whole file to find them: a long take is tens of megabytes decoded, on a phone
 * too, and before its audio has even started.
 *
 * They're read from the WAV a piece at a time, so the file is never held whole, one file at a time,
 * and kept beside it under a hidden name (`.aud_<id>.peaks`, which no id finds), so each file is read
 * once.
 *
 * The bytes are the ones the studio keeps on a device (apps/web/src/audio/files.ts, peaksFromBytes):
 * 32-bit floats, [the frames a peak covers, the file's rate, how many peaks], then each peak's lowest
 * value, then each one's highest, over every channel. The values are those the engine's own reader
 * (decodeWav) makes of the file.
 */
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { type FileHandle, open } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';

/** Frames a peak covers: the studio's own step (5 ms at 48 kHz). */
export const PEAK_STEP = 256;
/** Peaks read from the file at once (a stereo float file: a quarter of a megabyte). */
const PEAKS_A_READ = 128;

interface WavData {
  /** 1: PCM, 3: floating point. */
  format: number;
  channels: number;
  rate: number;
  bits: number;
  /** Where the samples start in the file, and how many bytes of them there are. */
  start: number;
  bytes: number;
}

/** A WAV file's format and where its samples are, walked chunk by chunk as decodeWav walks it (null: not a WAV it reads). */
async function wavData(file: FileHandle, size: number): Promise<WavData | null> {
  const head = Buffer.alloc(26);
  const read = async (at: number, length: number) => (await file.read(head, 0, length, at)).bytesRead === length;
  if (!(await read(0, 12)) || head.toString('latin1', 0, 4) !== 'RIFF' || head.toString('latin1', 8, 12) !== 'WAVE')
    return null;
  let at = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  let data: [number, number] | null = null;
  while (at + 8 <= size && (await read(at, 8))) {
    const id = head.toString('latin1', 0, 4);
    const length = head.readUInt32LE(4);
    const body = at + 8;
    if (id === 'fmt ') {
      const extensible = length >= 26;
      if (!(await read(body, extensible ? 26 : 16))) return null;
      format = head.readUInt16LE(0);
      channels = head.readUInt16LE(2);
      rate = head.readUInt32LE(4);
      bits = head.readUInt16LE(14);
      // WAVE_FORMAT_EXTENSIBLE: the real format is the sub-format's first two bytes
      if (format === 0xfffe && extensible) format = head.readUInt16LE(24);
    } else if (id === 'data') {
      data = [body, Math.min(length, size - body)];
    }
    at = body + length + (length & 1);
  }
  const pcm = format === 1 && [8, 16, 24, 32].includes(bits);
  const float = format === 3 && (bits === 32 || bits === 64);
  if (!data || !channels || !rate || (!pcm && !float)) return null;
  return { format, channels, rate, bits, start: data[0], bytes: data[1] };
}

/** One sample at a byte of the piece read, as decodeWav makes it (a 32-bit float's worth). */
function reader(piece: Buffer, wav: WavData): (at: number) => number {
  if (wav.format === 3)
    return wav.bits === 64 ? (at) => Math.fround(piece.readDoubleLE(at)) : (at) => piece.readFloatLE(at);
  if (wav.bits === 16) return (at) => piece.readInt16LE(at) / 32768;
  if (wav.bits === 24) return (at) => piece.readIntLE(at, 3) / 8388608;
  if (wav.bits === 32) return (at) => Math.fround(piece.readInt32LE(at) / 2147483648);
  return (at) => ((piece[at] as number) - 128) / 128;
}

/**
 * The peaks of the WAV at `path`, as their bytes (see above). Null when it isn't a WAV the engine
 * reads, or holds no audio.
 */
export async function wavPeaks(path: string, step = PEAK_STEP): Promise<Uint8Array | null> {
  const file = await open(path, 'r');
  try {
    const wav = await wavData(file, (await file.stat()).size);
    if (!wav) return null;
    const width = wav.bits / 8;
    const frame = width * wav.channels;
    const frames = Math.floor(wav.bytes / frame);
    if (frames <= 0) return null;
    const count = Math.ceil(frames / step);
    const out = new Float32Array(3 + count * 2);
    out[0] = step;
    out[1] = wav.rate;
    out[2] = count;
    const most = step * PEAKS_A_READ;
    const piece = Buffer.alloc(most * frame);
    const sample = reader(piece, wav);
    for (let first = 0; first < frames; first += most) {
      const wanted = Math.min(most, frames - first);
      // (awaited: the server answers others between the pieces)
      const { bytesRead } = await file.read(piece, 0, wanted * frame, wav.start + first * frame);
      const got = Math.floor(bytesRead / frame);
      for (let i = 0; i < got; i += step) {
        let lo = 0;
        let hi = 0;
        const end = Math.min(got, i + step) * frame;
        for (let at = i * frame; at < end; at += width) {
          const v = sample(at);
          if (v < lo) lo = v;
          if (v > hi) hi = v;
        }
        const peak = (first + i) / step;
        out[3 + peak] = lo;
        out[3 + count + peak] = hi;
      }
      // (a file shorter than it says: what's missing is drawn as silence)
      if (got < wanted) break;
    }
    return new Uint8Array(out.buffer);
  } finally {
    await file.close();
  }
}

/** Where a file's peaks are kept: beside it, under a hidden name no id finds. */
export const peaksPath = (audio: string) => join(dirname(audio), `.${basename(audio).replace(/\.[^.]+$/, '')}.peaks`);

/** Peaks as kept, when they're whole and no older than their file (null otherwise). */
function kept(audio: string): Uint8Array | null {
  const path = peaksPath(audio);
  try {
    if (!existsSync(path) || statSync(path).mtimeMs < statSync(audio).mtimeMs) return null;
    const bytes = readFileSync(path);
    if (bytes.length < 12 || bytes.length % 4) return null;
    const count = bytes.readFloatLE(8);
    return bytes.length === (3 + count * 2) * 4 ? new Uint8Array(bytes) : null;
  } catch {
    return null;
  }
}

/** Files whose peaks are being made (or wait their turn), and the turn they wait for. */
const making = new Map<string, Promise<Uint8Array | null>>();
let turn: Promise<unknown> = Promise.resolve();

/**
 * A stored audio file's peaks: as kept beside it, else made now (one file at a time, and once for
 * everyone who asks meanwhile) and kept. Null when the file isn't a WAV the engine reads. Where they
 * can't be kept (a folder that can't be written), they're made again the next time.
 */
export function peaksOf(audio: string): Promise<Uint8Array | null> {
  const have = kept(audio);
  if (have) return Promise.resolve(have);
  let job = making.get(audio);
  if (!job) {
    job = turn
      .then(async () => {
        const bytes = await wavPeaks(audio);
        if (!bytes) return null;
        const path = peaksPath(audio);
        // (written whole under a name the server's start sweeps away, then moved into place)
        const part = `${path}.part`;
        try {
          writeFileSync(part, bytes, { mode: 0o644 });
          renameSync(part, path);
        } catch {
          rmSync(part, { force: true });
        }
        return bytes;
      })
      .finally(() => making.delete(audio));
    making.set(audio, job);
    turn = job.catch(() => undefined);
  }
  return job;
}
