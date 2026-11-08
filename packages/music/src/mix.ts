/**
 * Files made from published recordings: each from one download or several (the microphones of a drum
 * hit), mixed at fixed gains, trimmed to the stretch that sounds, faded at its ends and written as a
 * PCM WAV. Every step is plain arithmetic on the decoded samples (no library maths, no dither), so the
 * same downloads make the same bytes on any computer, and each file's sha256 is pinned like any other.
 */
import { decodeWav } from '@holo/engine';
import { decodeFlac, pcmWav } from './flac.ts';

/** The downloads a pack's files are made from, and how each file is made. */
export interface MixSource {
  kind: 'mix';
  note?: string;
  /** Prefixes of the downloads' addresses, by name: a download "<name>:<path>" is at the prefix and the path. */
  bases: Record<string, string>;
  /** Each download and its sha256. */
  downloads: Record<string, string>;
  /** Bits a sample of the files made (16 or 24). */
  bits: 16 | 24;
  /** Each file made, by its path under the pack's root. */
  files: Record<string, MixRecipe>;
}

/**
 * One input: a download, and its gain into the left and the right. A mono download goes to both sides
 * at those gains; a stereo one keeps its sides, each at its gain (a negative gain turns it upside down).
 */
export type MixInput = [download: string, left: number, right: number];

export interface MixRecipe {
  in: MixInput[];
  /** The inputs' first frame kept, and how many (past an input's end it adds nothing). */
  start: number;
  frames: number;
  /** One channel, the left's (a mono recording kept mono: half the size). */
  mono?: boolean;
  /** Frames faded in (straight) and out (an S curve) at the ends. */
  fadeIn: number;
  fadeOut: number;
}

const encodePath = (path: string) => path.split('/').map(encodeURIComponent).join('/');

/** Where a download is fetched from. */
export function mixUrl(source: Pick<MixSource, 'bases'>, download: string): string {
  const at = download.indexOf(':');
  const base = at > 0 ? source.bases[download.slice(0, at)] : undefined;
  if (base === undefined) throw new Error(`${download}: no base of that name in the pack's recipe`);
  return `${base}${encodePath(download.slice(at + 1))}`;
}

/** A download's extension (what it is: .wav or .flac). */
export function mixExtension(download: string): string {
  const m = /\.[A-Za-z0-9]+$/.exec(download);
  return m ? m[0].toLowerCase() : '';
}

export interface DecodedInput {
  rate: number;
  channels: Float32Array[];
}

/** A WAV or FLAC download's samples, each as the exact fraction of full scale its integer is. */
export function decodeInput(bytes: Uint8Array): DecodedInput {
  if (bytes.length >= 4 && String.fromCharCode(...bytes.subarray(0, 4)) === 'fLaC') {
    const pcm = decodeFlac(bytes);
    const scale = 1 / 2 ** (pcm.bits - 1);
    return {
      rate: pcm.rate,
      channels: pcm.channels.map((c) => {
        const out = new Float32Array(c.length);
        for (let i = 0; i < c.length; i++) out[i] = (c[i] as number) * scale;
        return out;
      }),
    };
  }
  // up to 24 bits a WAV's integers are exact in a float
  return decodeWav(bytes);
}

/** The out-fade's gain at t (0 to 1): an S curve from 1 to 0. */
function fadeOutGain(t: number): number {
  return 1 - t * t * (3 - 2 * t);
}

/** One file, from its inputs (decoded), as the recipe says. */
export function mixFile(recipe: MixRecipe, inputs: Map<string, DecodedInput>, bits: 16 | 24): Uint8Array {
  const { start, frames, fadeIn, fadeOut } = recipe;
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  let rate = 0;
  for (const [name, gl, gr] of recipe.in) {
    const d = inputs.get(name);
    if (!d) throw new Error(`${name} wasn't fetched`);
    if (rate && d.rate !== rate) throw new Error(`${name} is at ${d.rate} Hz, its file's other inputs at ${rate}`);
    rate = d.rate;
    const a = d.channels[0] as Float32Array;
    const b = (d.channels[1] ?? a) as Float32Array;
    const end = Math.min(frames, a.length - start);
    for (let i = 0; i < end; i++) {
      left[i] = (left[i] as number) + (a[start + i] as number) * gl;
      right[i] = (right[i] as number) + (b[start + i] as number) * gr;
    }
  }
  for (let i = 0; i < fadeIn && i < frames; i++) {
    const g = (i + 1) / (fadeIn + 1);
    left[i] = (left[i] as number) * g;
    right[i] = (right[i] as number) * g;
  }
  for (let i = 0; i < fadeOut && i < frames; i++) {
    const j = frames - fadeOut + i;
    if (j < 0) continue;
    const g = fadeOutGain((i + 1) / fadeOut);
    left[j] = (left[j] as number) * g;
    right[j] = (right[j] as number) * g;
  }
  const full = 2 ** (bits - 1);
  const quantize = (x: Float64Array) => {
    const out = new Int32Array(x.length);
    for (let i = 0; i < x.length; i++) {
      const v = Math.round((x[i] as number) * full);
      out[i] = v > full - 1 ? full - 1 : v < -full ? -full : v;
    }
    return out;
  };
  return pcmWav({ rate, bits, channels: recipe.mono ? [quantize(left)] : [quantize(left), quantize(right)] });
}
