/**
 * Files made from published recordings: each from one download or several (the microphones of a drum
 * hit, or recordings of one note layered into a section), each lined up where its sound starts and
 * resampled if its rate isn't the file's, mixed at fixed gains, trimmed to the stretch that sounds,
 * faded at its ends and written as a PCM WAV. Every step is plain arithmetic on the decoded samples
 * (no library maths, no dither: even the resampler's sines are summed out by hand), so the same
 * downloads make the same bytes on any computer, and each file's sha256 is pinned like any other.
 */
import { decodeWav } from '@holo/engine';
import type { ArchiveFormat } from './archives.ts';
import { decodeAiff } from './cut.ts';
import { decodeFlac, pcmWav } from './flac.ts';

/** The downloads a pack's files are made from, and how each file is made. */
export interface MixSource {
  kind: 'mix';
  note?: string;
  /** Prefixes of the downloads' addresses, by name: a download "<name>:<path>" is at the prefix and the path. */
  bases: Record<string, string>;
  /**
   * Archives some downloads are taken out of, by name: a download "<name>:<path>" is the file at that
   * path in the archive (its own sha256 pinned in downloads, as any download's is).
   */
  archives?: Record<string, MixArchive>;
  /** Each download and its sha256. */
  downloads: Record<string, string>;
  /** Bits a sample of the files made (16 or 24). */
  bits: 16 | 24;
  /** Each file made, by its path under the pack's root. */
  files: Record<string, MixRecipe>;
}

/** A published archive downloads are taken out of. */
export interface MixArchive {
  url: string;
  sha256: string;
  /** What it is, if its address's ending doesn't say. */
  format?: ArchiveFormat;
}

/**
 * One input: a download, and its gain into the left and the right. A mono download goes to both sides
 * at those gains; a stereo one keeps its sides, each at its gain (a negative gain turns it upside down).
 * Where it starts and how fast it plays can be its own.
 */
export type MixInput = [download: string, left: number, right: number, at?: MixAt];

export interface MixAt {
  /**
   * Its frame (its own, counted at its own rate) heard at the file's first frame, if not the recipe's
   * start: below 0 it comes in that many frames late. A fraction falls between two frames.
   */
  start?: number;
  /** The rate it's played at, if not its own: a little faster plays it a little higher. */
  rate?: number;
}

export interface MixRecipe {
  in: MixInput[];
  /** The inputs' first frame kept, and how many (past an input's end it adds nothing). */
  start: number;
  frames: number;
  /** Frames a second of the file made, if not its first input's rate (any input at another is resampled). */
  rate?: number;
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

/** Where a download in an archive is: the archive's name and the file's path in it (null if it isn't). */
export function mixArchive(source: Pick<MixSource, 'archives'>, download: string): [string, string] | null {
  const at = download.indexOf(':');
  const name = download.slice(0, Math.max(0, at));
  return at > 0 && source.archives?.[name] ? [name, download.slice(at + 1)] : null;
}

/** A WAV, FLAC or AIFF download's samples, each as the exact fraction of full scale its integer is. */
export function decodeInput(bytes: Uint8Array): DecodedInput {
  if (bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'FORM') return decodeAiff(bytes);
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

// ---- resampling, by plain arithmetic ----

/** Zero crossings of the resampler's kernel each side, and its table's steps between two. */
const TAPS = 32;
const STEPS = 512;
/** The Kaiser window's shape (about 90 dB down outside the band). */
const BETA = 9;

/** sin(πx), from its series (after folding x into ±½): the same bits on every computer. */
function sinPi(x: number): number {
  let r = x - 2 * Math.floor((x + 1) / 2);
  if (r > 0.5) r = 1 - r;
  else if (r < -0.5) r = -1 - r;
  const y = Math.PI * r;
  const y2 = y * y;
  let term = y;
  let sum = y;
  for (let k = 1; k < 14; k++) {
    term = (-term * y2) / (2 * k * (2 * k + 1));
    sum += term;
  }
  return sum;
}

/** The modified Bessel function I0, from its series. */
function besselI0(x: number): number {
  const q = (x * x) / 4;
  let term = 1;
  let sum = 1;
  for (let k = 1; k < 60; k++) {
    term = (term * q) / (k * k);
    sum += term;
  }
  return sum;
}

let kernelTable: Float64Array | null = null;

/** A Kaiser-windowed sinc from 0 to TAPS crossings, STEPS a crossing (made once). */
function kernel(): Float64Array {
  if (kernelTable) return kernelTable;
  const t = new Float64Array(TAPS * STEPS + 2);
  const norm = besselI0(BETA);
  for (let i = 0; i <= TAPS * STEPS; i++) {
    const u = i / STEPS;
    const sinc = i === 0 ? 1 : sinPi(u) / (Math.PI * u);
    const w = u / TAPS;
    t[i] = (sinc * besselI0(BETA * Math.sqrt(1 - w * w))) / norm;
  }
  kernelTable = t;
  return t;
}

/**
 * One channel's samples at fractional places: position i is `first + i * step` of the input, its band
 * held under the output's Nyquist (`cutoff`, a fraction of the input's).
 */
function resampled(x: Float32Array, first: number, step: number, n: number, cutoff: number): Float64Array {
  const h = kernel();
  const out = new Float64Array(n);
  const reach = TAPS / cutoff;
  const scale = cutoff * STEPS;
  for (let i = 0; i < n; i++) {
    const pos = first + i * step;
    const lo = Math.max(0, Math.ceil(pos - reach));
    const hi = Math.min(x.length - 1, Math.floor(pos + reach));
    let sum = 0;
    for (let j = lo; j <= hi; j++) {
      const u = Math.abs(pos - j) * scale;
      const k = Math.floor(u);
      if (k >= TAPS * STEPS) continue;
      const f = u - k;
      const w = (h[k] as number) + ((h[k + 1] as number) - (h[k] as number)) * f;
      sum += (x[j] as number) * w;
    }
    out[i] = sum * cutoff;
  }
  return out;
}

/** One file, from its inputs (decoded), as the recipe says. */
export function mixFile(recipe: MixRecipe, inputs: Map<string, DecodedInput>, bits: 16 | 24): Uint8Array {
  const { start, frames, fadeIn, fadeOut } = recipe;
  const left = new Float64Array(frames);
  const right = new Float64Array(frames);
  let rate = recipe.rate ?? 0;
  for (const [name, gl, gr, at] of recipe.in) {
    const d = inputs.get(name);
    if (!d) throw new Error(`${name} wasn't fetched`);
    if (!recipe.rate && rate && d.rate !== rate)
      throw new Error(`${name} is at ${d.rate} Hz, its file's other inputs at ${rate}: say the file's rate`);
    if (!rate) rate = d.rate;
    const a = d.channels[0] as Float32Array;
    const b = (d.channels[1] ?? a) as Float32Array;
    const from = at?.start ?? start;
    const plays = at?.rate ?? d.rate;
    if (plays === rate && Number.isInteger(from)) {
      // frame for frame
      const first = Math.max(0, -from);
      const end = Math.min(frames, a.length - from);
      for (let i = first; i < end; i++) {
        left[i] = (left[i] as number) + (a[from + i] as number) * gl;
        right[i] = (right[i] as number) + (b[from + i] as number) * gr;
      }
      continue;
    }
    const step = plays / rate;
    const cutoff = Math.min(1, 1 / step);
    const la = resampled(a, from, step, frames, cutoff);
    const lb = b === a ? la : resampled(b, from, step, frames, cutoff);
    for (let i = 0; i < frames; i++) {
      left[i] = (left[i] as number) + (la[i] as number) * gl;
      right[i] = (right[i] as number) + (lb[i] as number) * gr;
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
