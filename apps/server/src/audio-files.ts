/**
 * A song's audio files on the host (`data/audio/<song>/aud_<id>.<ext>`), kept as WAV. Every renderer
 * (the studio, a bounce, a headless render, a creation's build) reads WAV the same way, and none reads
 * FLAC or AIFF. So a FLAC or AIFF file sent here (the `holo audio` command sends FLAC) becomes a WAV
 * under the same id, and those kept before this was so are made WAV once, as the server starts: the
 * WAV replaces the file, never sits beside it (a file is found by its id, whatever its ending).
 *
 * A WAV is written beside its place under a hidden name (`.aud_<id>.wav.part`), then moved into it,
 * so nothing reads half of one.
 */
import { closeSync, existsSync, openSync, readdirSync, readFileSync, renameSync, rmSync, writeSync } from 'node:fs';
import { basename, dirname, join } from 'node:path';
import { decodeInput } from '@holo/music';

export interface AudioInfo {
  /** Frames a second, channels, and its length in frames and seconds. */
  rate: number;
  channels: number;
  frames: number;
  seconds: number;
}

/** The endings made WAV. */
export const TO_WAV = new Set(['.flac', '.aif', '.aiff']);

/** A stored file of the kind made WAV: `aud_<id>.flac`, `.aif` or `.aiff`. */
const CONVERTIBLE = /^(aud_[a-z0-9]+)\.(flac|aiff?)$/i;

const tag = (b: Uint8Array, at: number) => String.fromCharCode(...b.subarray(at, at + 4));

/**
 * A WAV file's format, read from its first bytes, when the engine's own reader (decodeWav) reads it:
 * PCM of 8, 16, 24 or 32 bits, or 32 or 64-bit float, plain or "extensible". Null otherwise: a
 * compressed WAV (ADPCM, µ-law), RF64, a header past `head`, or not a WAV at all.
 */
export function readableWav(head: Uint8Array, size: number): AudioInfo | null {
  if (head.length < 12 || tag(head, 0) !== 'RIFF' || tag(head, 8) !== 'WAVE') return null;
  const view = new DataView(head.buffer, head.byteOffset, head.byteLength);
  let at = 12;
  let format = 0;
  let channels = 0;
  let rate = 0;
  let bits = 0;
  while (at + 8 <= head.length) {
    const id = tag(head, at);
    const length = view.getUint32(at + 4, true);
    const body = at + 8;
    if (id === 'fmt ') {
      if (body + 16 > head.length) return null;
      format = view.getUint16(body, true);
      channels = view.getUint16(body + 2, true);
      rate = view.getUint32(body + 4, true);
      bits = view.getUint16(body + 14, true);
      if (format === 0xfffe && length >= 26 && body + 26 <= head.length) format = view.getUint16(body + 24, true);
    } else if (id === 'data') {
      const pcm = format === 1 && [8, 16, 24, 32].includes(bits);
      const float = format === 3 && (bits === 32 || bits === 64);
      if ((!pcm && !float) || !channels || !rate) return null;
      const frames = Math.floor(Math.min(length, size - body) / ((bits / 8) * channels));
      return frames > 0 ? { rate, channels, frames, seconds: frames / rate } : null;
    }
    at = body + length + (length & 1);
  }
  return null;
}

/** Where a WAV is written before it's moved into its place: a hidden name no id finds. */
const partOf = (path: string) => join(dirname(path), `.${basename(path)}.part`);

/**
 * Samples as a 32-bit float WAV file (lossless for any integer file up to 24 bits), written a piece
 * at a time, so the audio isn't held twice.
 */
export function writeWav(path: string, channels: Float32Array[], rate: number): AudioInfo {
  const count = channels.length;
  const frames = channels[0]?.length ?? 0;
  const bytes = frames * count * 4;
  const header = Buffer.alloc(44);
  header.write('RIFF', 0, 'latin1');
  header.writeUInt32LE(36 + bytes, 4);
  header.write('WAVEfmt ', 8, 'latin1');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(3, 20);
  header.writeUInt16LE(count, 22);
  header.writeUInt32LE(rate, 24);
  header.writeUInt32LE(rate * count * 4, 28);
  header.writeUInt16LE(count * 4, 32);
  header.writeUInt16LE(32, 34);
  header.write('data', 36, 'latin1');
  header.writeUInt32LE(bytes, 40);
  const part = partOf(path);
  const fd = openSync(part, 'w', 0o644);
  try {
    writeSync(fd, header);
    const step = 16384;
    const chunk = Buffer.alloc(step * count * 4);
    for (let i = 0; i < frames; i += step) {
      const n = Math.min(step, frames - i);
      let p = 0;
      for (let f = i; f < i + n; f++) {
        for (let c = 0; c < count; c++) {
          chunk.writeFloatLE((channels[c] as Float32Array)[f] as number, p);
          p += 4;
        }
      }
      writeSync(fd, chunk, 0, p);
    }
  } catch (err) {
    closeSync(fd);
    rmSync(part, { force: true });
    throw err;
  }
  closeSync(fd);
  renameSync(part, path);
  return { rate, channels: count, frames, seconds: frames / rate };
}

/** A FLAC or AIFF file (or a WAV) read and written to `to` as a 32-bit float WAV. */
export function convertToWav(from: string, to: string): AudioInfo {
  const decoded = decodeInput(new Uint8Array(readFileSync(from)));
  if (!decoded.channels.length || !decoded.channels[0]?.length) throw new Error('It holds no audio');
  return writeWav(to, decoded.channels, Math.round(decoded.rate));
}

/**
 * Every song's FLAC and AIFF files made WAV, each under its own id, the original removed (and any
 * half-written WAV left by a stop part-way through). A file that can't be read is left as it is, and
 * said so. One at a time, letting the server answer in between: how many were made WAV.
 */
export async function sweepAudio(
  dataDir: string,
  warn: (line: string) => void = (line) => console.warn(line),
): Promise<number> {
  const root = join(dataDir, 'audio');
  if (!existsSync(root)) return 0;
  let made = 0;
  for (const song of readdirSync(root, { withFileTypes: true })) {
    if (!song.isDirectory()) continue;
    const dir = join(root, song.name);
    for (const name of readdirSync(dir)) {
      if (name.startsWith('.aud_') && name.endsWith('.part')) {
        rmSync(join(dir, name), { force: true });
        continue;
      }
      const m = CONVERTIBLE.exec(name);
      if (!m) continue;
      const wav = join(dir, `${m[1]}.wav`);
      try {
        // a WAV of it already there (a sweep stopped before it removed the original): it stands
        if (!existsSync(wav)) {
          convertToWav(join(dir, name), wav);
          made++;
        }
        rmSync(join(dir, name), { force: true });
      } catch (err) {
        warn(`audio/${song.name}/${name} couldn't be made WAV (${err instanceof Error ? err.message : String(err)})`);
      }
      await new Promise((r) => setImmediate(r));
    }
  }
  return made;
}
