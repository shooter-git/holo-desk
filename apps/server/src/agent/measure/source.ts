/**
 * Where a measurement reads the song's sound from: HO[LO]'s data folder (`dataFolderSource`: the packs'
 * samples, the song's audio files), with the song's recordings decoded whatever they are, WAV, FLAC
 * or AIFF (`decodeInput`, the same arithmetic a pack's files are made with). A render takes them as WAV,
 * so a FLAC or AIFF clip is handed to it as one.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { encodeWav, type RenderSource } from '@holo/engine';
import { dataFolderSource } from '@holo/engine/node';
import { decodeInput } from '@holo/music';

/** A decoded recording: its rate and channels. */
export interface Decoded {
  rate: number;
  channels: Float32Array[];
}

export interface MeasureSource extends RenderSource {
  /** One of the song's audio files decoded (null: it has none by that id). Each is decoded once. */
  decodeAudio(file: string): Decoded | null;
}

const isWav = (b: Uint8Array) =>
  b.length >= 12 &&
  (String.fromCharCode(...b.subarray(0, 4)) === 'RIFF' || String.fromCharCode(...b.subarray(0, 4)) === 'RF64') &&
  String.fromCharCode(...b.subarray(8, 12)) === 'WAVE';

/** A file's samples, whatever it is of WAV, FLAC or AIFF (an error for anything else). */
export function decodeFile(path: string): Decoded {
  return decodeBytes(new Uint8Array(readFileSync(path)));
}

export function decodeBytes(bytes: Uint8Array): Decoded {
  const head = String.fromCharCode(...bytes.subarray(0, 4));
  if (!isWav(bytes) && head !== 'fLaC' && head !== 'FORM')
    throw new Error('Only WAV, FLAC and AIFF recordings are measured here');
  const d = decodeInput(bytes);
  return { rate: d.rate, channels: d.channels };
}

/** The data folder's packs and the song's files, its recordings decoded (and, for a render, as WAV). */
export function measureSource(dataDir: string, project: string): MeasureSource {
  const base = dataFolderSource(dataDir, project);
  const decoded = new Map<string, Decoded | null>();
  const decodeAudio = (file: string): Decoded | null => {
    if (decoded.has(file)) return decoded.get(file) ?? null;
    let out: Decoded | null = null;
    try {
      // (read as dataFolderSource's audio() reads it, but at once)
      out = decodeBytes(readAudio(dataDir, project, file));
    } catch {
      out = null;
    }
    decoded.set(file, out);
    return out;
  };
  return {
    instrument: (pack, name) => base.instrument(pack, name),
    sample: (pack, file) => base.sample(pack, file),
    impulse: (pack, name) => base.impulse(pack, name),
    async audio(file) {
      const bytes = await base.audio(file);
      if (isWav(bytes)) return bytes;
      const d = decodeAudio(file);
      if (!d) throw new Error(`The audio file ${file} isn't a recording HO[LO] reads`);
      return encodeWav(d.channels, d.rate, 'float32');
    },
    decodeAudio,
  };
}

/** An audio file of the song's, as it's kept (data/audio/<song>/<id>.<ext>). */
function readAudio(dataDir: string, project: string, file: string): Uint8Array {
  if (!/^aud_[a-z0-9]+$/.test(file)) throw new Error(`No audio file ${file}`);
  const dir = join(dataDir, 'audio', project.replace(/[^\w-]/g, ''));
  const found = existsSync(dir) ? readdirSync(dir).find((f) => f.startsWith(`${file}.`)) : undefined;
  if (!found) throw new Error(`No audio file ${file} for this song`);
  return new Uint8Array(readFileSync(join(dir, found)));
}
