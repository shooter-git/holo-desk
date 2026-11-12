/**
 * Where a recording's sound sits in frequency: its power in octave and third-octave bands (through the
 * engine's FFT, fft.ts), the tilt of its spectrum, and where two tracks compete for the same band at
 * the same time (one masking the other).
 *
 * A band's level is its mean power in dB: a full-scale sine reads −3 dB in its band, as its mean
 * square does. The bands are the nominal ones (31.5 Hz, 63 Hz… for octaves; 25 Hz to 20 kHz for
 * thirds), each from 2^(−1/2) to 2^(1/2) of its exact centre (2^(±1/6) for a third).
 */
import { fft } from '../fft.ts';

export type BandKind = 'octave' | 'third';

/** The nominal centres (Hz). */
export const OCTAVE_BANDS = [31.5, 63, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
export const THIRD_BANDS = [
  25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000,
  5000, 6300, 8000, 10000, 12500, 16000, 20000,
];

export const bandCenters = (kind: BandKind): number[] => (kind === 'octave' ? OCTAVE_BANDS : THIRD_BANDS);

/** Each band's edges (Hz): from its exact centre (1 kHz times a power of 2), half an octave or a sixth either side. */
function bandEdges(kind: BandKind): [number, number][] {
  const step = kind === 'octave' ? 1 : 1 / 3;
  const first = kind === 'octave' ? -5 : -16;
  return bandCenters(kind).map((_, i) => {
    const c = 1000 * 2 ** ((first + i) * step);
    return [c * 2 ** (-step / 2), c * 2 ** (step / 2)];
  });
}

/** Which FFT bins (from, to) fall in each band at a size and rate; [0, 0] for a band with none. */
function binRanges(kind: BandKind, size: number, sampleRate: number): [number, number][] {
  const df = sampleRate / size;
  return bandEdges(kind).map(([lo, hi]) => {
    const a = Math.max(1, Math.ceil(lo / df));
    const b = Math.min(size / 2, Math.ceil(hi / df));
    return b > a && lo < sampleRate / 2 ? [a, b] : [0, 0];
  });
}

const hann = (size: number): Float64Array => {
  const w = new Float64Array(size);
  for (let i = 0; i < size; i++) w[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size);
  return w;
};

/**
 * The power in each band, frame by frame: frames of `size` (Hann-windowed) every `hop` frames, each
 * band's mean square over the channels. A recording shorter than a frame is one frame, padded.
 */
export function bandFrames(
  channels: readonly ArrayLike<number>[],
  sampleRate: number,
  kind: BandKind = 'third',
  size = 4096,
  hop = size / 2,
  range: [number, number] = [0, Number.POSITIVE_INFINITY],
): { hop: number; frames: Float64Array[] } {
  const n = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const start = Math.max(0, Math.floor(range[0]));
  const end = Math.min(n, Math.floor(range[1]));
  const bins = binRanges(kind, size, sampleRate);
  const w = hann(size);
  let w2 = 0;
  for (const v of w) w2 += v * v;
  const scale = 2 / (size * w2);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  const frames: Float64Array[] = [];
  const last = Math.max(start, end - size);
  for (let at = start; at <= last; at += hop) {
    const power = new Float64Array(bins.length);
    for (const ch of channels) {
      for (let i = 0; i < size; i++) {
        const j = at + i;
        re[i] = j < end && j < ch.length ? (ch[j] as number) * (w[i] as number) : 0;
        im[i] = 0;
      }
      fft(re, im);
      for (let b = 0; b < bins.length; b++) {
        const [lo, hi] = bins[b] as [number, number];
        let p = 0;
        for (let k = lo; k < hi; k++) p += (re[k] as number) ** 2 + (im[k] as number) ** 2;
        power[b] = (power[b] as number) + (p * scale) / channels.length;
      }
    }
    frames.push(power);
    if (end - start <= size) break;
  }
  return { hop: hop / sampleRate, frames };
}

const toDb = (p: number): number | null => (p > 1e-14 ? Math.round(10 * Math.log10(p) * 10) / 10 : null);

/**
 * Each band's level (dB, mean power over the recording, or over `range` frames of it); null for a
 * band that's silent, or above half the rate.
 */
export function bandLevels(
  channels: readonly ArrayLike<number>[],
  sampleRate: number,
  kind: BandKind = 'third',
  range?: [number, number],
): (number | null)[] {
  const { frames } = bandFrames(channels, sampleRate, kind, 8192, 4096, range);
  const total = new Float64Array(bandCenters(kind).length);
  for (const f of frames) for (let b = 0; b < total.length; b++) total[b] = (total[b] as number) + (f[b] as number);
  const edges = binRanges(kind, 8192, sampleRate);
  return [...total].map((p, b) =>
    (edges[b] as [number, number])[1] > 0 ? toDb(p / Math.max(1, frames.length)) : null,
  );
}

/**
 * A filter's gain in each band (dB), from its impulse response to an impulse of `amplitude`: the
 * whole response transformed at once (unwindowed, zero-padded), each band's mean power gain over the
 * channels. Null above half the rate, or where nothing comes through.
 */
export function bandResponse(
  response: readonly ArrayLike<number>[],
  sampleRate: number,
  amplitude = 1,
  kind: BandKind = 'third',
): (number | null)[] {
  const n = response.reduce((m, c) => Math.max(m, c.length), 0);
  let size = 1024;
  while (size < n) size *= 2;
  const bins = binRanges(kind, size, sampleRate);
  const gain = new Float64Array(bins.length);
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  for (const ch of response) {
    re.fill(0);
    im.fill(0);
    for (let i = 0; i < ch.length; i++) re[i] = (ch[i] as number) / amplitude;
    fft(re, im);
    bins.forEach(([lo, hi], b) => {
      let p = 0;
      for (let k = lo; k < hi; k++) p += (re[k] as number) ** 2 + (im[k] as number) ** 2;
      gain[b] = (gain[b] as number) + (hi > lo ? p / (hi - lo) : 0) / response.length;
    });
  }
  return [...gain].map((p, b) => ((bins[b] as [number, number])[1] > 0 ? toDb(p) : null));
}

/**
 * The spectrum's tilt, dB per octave, from third-octave levels (63 Hz to 10 kHz, a straight line
 * through them): 0 is pink noise (as much in each octave), +3 white noise; music is usually below 0.
 */
export function spectralTilt(thirds: readonly (number | null)[]): number | null {
  const xs: number[] = [];
  const ys: number[] = [];
  THIRD_BANDS.forEach((hz, i) => {
    const v = thirds[i];
    if (hz >= 63 && hz <= 10000 && typeof v === 'number' && v > -120) {
      xs.push(Math.log2(hz / 1000));
      ys.push(v);
    }
  });
  if (xs.length < 4) return null;
  const mx = xs.reduce((a, v) => a + v, 0) / xs.length;
  const my = ys.reduce((a, v) => a + v, 0) / ys.length;
  let num = 0;
  let den = 0;
  for (let i = 0; i < xs.length; i++) {
    num += ((xs[i] as number) - mx) * ((ys[i] as number) - my);
    den += ((xs[i] as number) - mx) ** 2;
  }
  return den > 0 ? Math.round((num / den) * 10) / 10 : null;
}

/** A band where two tracks compete. */
export interface MaskingBand {
  /** The band's nominal centre (Hz). */
  hz: number;
  /** Of the time either sounds in it, the share both do, within 10 dB of each other (0–1). */
  overlap: number;
  /** How much louder the first is there, on average (dB; below 0: the second is louder). */
  diff: number;
}

const percentile = (values: number[], p: number): number => {
  const s = [...values].sort((x, y) => x - y);
  return s[Math.min(s.length - 1, Math.max(0, Math.round((p / 100) * (s.length - 1))))] as number;
};

/**
 * Where two recordings (two tracks, each alone, at one rate) compete: third-octave bands, 50 Hz to
 * 16 kHz, in which both sound at once, within 10 dB of each other, for at least 25% of the time either
 * sounds there. A track sounds in a band, at a moment, within 20 dB of its own loud moments there
 * (and above −70 dB); a band is counted only if it's within 30 dB of the track's loudest. The most
 * contested first.
 */
export function masking(
  a: readonly ArrayLike<number>[],
  b: readonly ArrayLike<number>[],
  sampleRate: number,
): MaskingBand[] {
  const fa = bandFrames(a, sampleRate, 'third').frames;
  const fb = bandFrames(b, sampleRate, 'third').frames;
  const n = Math.min(fa.length, fb.length);
  if (!n) return [];
  const db = (p: number) => 10 * Math.log10(Math.max(p, 1e-14));
  const bands = THIRD_BANDS.map((hz, i) => ({ hz, i })).filter(({ hz }) => hz >= 50 && hz <= 16000);
  const loud = (frames: Float64Array[], i: number) =>
    percentile(
      frames.slice(0, n).map((f) => db(f[i] as number)),
      95,
    );
  const topA = Math.max(...bands.map(({ i }) => loud(fa, i)));
  const topB = Math.max(...bands.map(({ i }) => loud(fb, i)));
  const out: MaskingBand[] = [];
  for (const { hz, i } of bands) {
    const pa = loud(fa, i);
    const pb = loud(fb, i);
    if (pa < topA - 30 || pb < topB - 30) continue;
    let either = 0;
    let both = 0;
    let diff = 0;
    for (let k = 0; k < n; k++) {
      const la = db((fa[k] as Float64Array)[i] as number);
      const lb = db((fb[k] as Float64Array)[i] as number);
      const sa = la > -70 && la > pa - 20;
      const sb = lb > -70 && lb > pb - 20;
      if (!sa && !sb) continue;
      either++;
      if (sa && sb && Math.abs(la - lb) <= 10) {
        both++;
        diff += la - lb;
      }
    }
    const overlap = either ? both / either : 0;
    if (overlap >= 0.25)
      out.push({ hz, overlap: Math.round(overlap * 100) / 100, diff: Math.round((diff / both) * 10) / 10 });
  }
  return out.sort((x, y) => y.overlap - x.overlap);
}
