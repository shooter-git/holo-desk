/**
 * A line's pitch as note-finding hears it, shared by a take's measurement (take.ts `lineNotes`) and
 * the notes found for editing (notes/detect.ts): the coarse track, the fine track through it, where a
 * note's voice starts from silence, and the pitch, drift and vibrato of a note's held part. Plain
 * functions over samples that need nothing else of the engine (a worker can load them alone); take.ts
 * says how each works.
 */
import { downsample, midiOf, yin } from './pitch.ts';

/** The coarse track's frame and hop at about 11 kHz (93 ms frames, every 11.6 ms). */
const FRAME = 1024;
const HOP = 128;
/** The fine track: every 5 ms. */
export const FINE_S = 0.005;
/** A note's attack (left out of its pitch), and the end left out. */
const ATTACK_S = 0.06;
const RELEASE_S = 0.03;
/** A note from silence starts where its level comes within this much of its attack's loudest (dB). */
const ONSET_DB = 20;
/** How far around the note's period its start is still the note (a scoop up into it: three semitones). */
const ONSET_RANGE = 2 ** (3 / 12);
/** The most a voiced sound's normalized difference at its period may be (noise is near 1). */
const VOICED = 0.35;

/** The samples' channels as one (their mean). */
export function monoOf(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0] as Float32Array;
  const n = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < c.length; i++) out[i] = (out[i] as number) + (c[i] as number);
  for (let i = 0; i < n; i++) out[i] = (out[i] as number) / channels.length;
  return out;
}

export const median = (values: number[]): number => {
  const s = [...values].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

/** A straight line through (t, y): its slope and its value at t̄; and t̄. */
function line(t: number[], y: number[]): { slope: number; mid: number; tm: number } {
  const n = t.length;
  const tm = t.reduce((a, v) => a + v, 0) / n;
  const ym = y.reduce((a, v) => a + v, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += ((t[i] as number) - tm) * ((y[i] as number) - ym);
    den += ((t[i] as number) - tm) ** 2;
  }
  return { slope: den > 0 ? num / den : 0, mid: ym, tm };
}

/**
 * The period near `p0` (samples) of the sound around `center`, at the full rate: the shift where a
 * few periods of it best match themselves (the squared difference over the energy), between samples
 * by a parabola. Null where nothing near `p0` matches well.
 */
function refinePeriod(x: Float32Array, sr: number, center: number, p0: number): number | null {
  const w = Math.round(Math.min(0.035 * sr, Math.max(0.008 * sr, 2.5 * p0)));
  const lo = Math.max(2, Math.floor(p0 * 0.92));
  const hi = Math.ceil(p0 * 1.08);
  const a = Math.round(center - (w + p0) / 2);
  if (a < 0 || a + w + hi + 1 >= x.length) return null;
  const memo = new Map<number, number>();
  const nd = (tau: number): number => {
    let v = memo.get(tau);
    if (v !== undefined) return v;
    let d = 0;
    let m = 0;
    for (let j = 0; j < w; j++) {
      const u = x[a + j] as number;
      const s = x[a + j + tau] as number;
      d += (u - s) * (u - s);
      m += u * u + s * s;
    }
    v = m > 0 ? d / m : 1;
    memo.set(tau, v);
    return v;
  };
  // downhill from where YIN put it
  let t = Math.min(hi - 1, Math.max(lo + 1, Math.round(p0)));
  for (let guard = 0; guard < hi - lo + 2; guard++) {
    if (nd(t - 1) < nd(t) && t - 1 > lo) t--;
    else if (nd(t + 1) < nd(t) && t + 1 < hi) t++;
    else break;
  }
  const b = nd(t);
  if (b > 0.3 || t <= lo || t >= hi) return null;
  const p = nd(t - 1);
  const q = nd(t + 1);
  const den = p - 2 * b + q;
  const shift = den > 0 ? (p - q) / (2 * den) : 0;
  return t + Math.max(-1, Math.min(1, shift));
}

/**
 * Whether the sound around `center` (samples of `x`) is voiced near a period of `p0` samples: it
 * repeats itself (its normalized squared difference under VOICED) at some shift within ONSET_RANGE of
 * it, over a window of two and a half periods (5 ms at least; kept inside the samples). Noise, and
 * silence, don't.
 */
function voicedNear(x: Float32Array, rate: number, center: number, p0: number): boolean {
  const lo = Math.max(2, Math.floor(p0 / ONSET_RANGE));
  const hi = Math.ceil(p0 * ONSET_RANGE);
  const w = Math.round(Math.max(0.005 * rate, 2.5 * p0));
  const a = Math.max(0, Math.min(x.length - w - hi - 1, Math.round(center - (w + p0) / 2)));
  if (a < 0) return false;
  for (let tau = lo; tau <= hi; tau++) {
    let d = 0;
    let m = 0;
    for (let j = 0; j < w; j++) {
      const u = x[a + j] as number;
      const s = x[a + j + tau] as number;
      d += (u - s) * (u - s);
      m += u * u + s * s;
    }
    if (m > 0 && d / m < VOICED) return true;
  }
  return false;
}

/** The vibrato in what swings around a note's line (cents, every FINE_S): rate (Hz) and depth (± cents), or null. */
function vibratoOf(residual: number[]): { rate: number; depth: number } | null {
  const fs = 1 / FINE_S;
  const minLag = Math.round(fs / 9);
  const maxLag = Math.round(fs / 3);
  const n = residual.length;
  if (n < Math.max(0.3 * fs, 2 * minLag)) return null;
  const ac = (lag: number): number => {
    let xy = 0;
    let xx = 0;
    let yy = 0;
    for (let k = 0; k + lag < n; k++) {
      const u = residual[k] as number;
      const v = residual[k + lag] as number;
      xy += u * v;
      xx += u * u;
      yy += v * v;
    }
    return xx > 0 && yy > 0 ? xy / Math.sqrt(xx * yy) : 0;
  };
  let best = -1;
  let bestLag = 0;
  for (let lag = minLag; lag <= Math.min(maxLag, Math.floor(n * 0.7)); lag++) {
    const v = ac(lag);
    if (v > best) {
      best = v;
      bestLag = lag;
    }
  }
  if (best < 0.4 || bestLag <= minLag || bestLag >= Math.min(maxLag, Math.floor(n * 0.7))) return null;
  const p = ac(bestLag - 1);
  const q = ac(bestLag + 1);
  const den = p - 2 * best + q;
  const lag = bestLag + (den < 0 ? (p - q) / (2 * den) : 0);
  const rms = Math.sqrt(residual.reduce((s, v) => s + v * v, 0) / n);
  const depth = Math.SQRT2 * rms;
  if (depth < 8) return null;
  return { rate: fs / lag, depth };
}

/** What note-finding works from: the fine track, and the sound at the low rate it measures loudness at. */
export interface Tracked {
  /** The samples at the low rate, and their running sum of squares (for loudness). */
  x: Float32Array;
  lr: number;
  sq: Float64Array;
  fineT: number[];
  fineP: number[];
  /** The power around a time (half of 5 ms either side, unless said). */
  envAt: (t: number, half?: number) => number;
}

/** The coarse track, then the fine track through it (null when nothing is voiced). */
export function trackOf(samples: Float32Array, sampleRate: number): Tracked | null {
  const sr = sampleRate;
  const low = downsample(samples, sr);
  const x = low.samples;
  const lr = low.sampleRate;
  // the coarse track: each frame's loudness, then YIN where it's loud enough
  const count = Math.max(0, Math.floor((x.length - FRAME) / HOP) + 1);
  const sq = new Float64Array(x.length + 1);
  for (let i = 0; i < x.length; i++) sq[i + 1] = (sq[i] as number) + (x[i] as number) ** 2;
  let loudest = 0;
  const rms = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const at = i * HOP;
    rms[i] = Math.sqrt(((sq[at + FRAME] as number) - (sq[at] as number)) / FRAME);
    loudest = Math.max(loudest, rms[i] as number);
  }
  const floor = Math.max(1e-4, loudest * 0.0126);
  const coarse = new Float64Array(count).fill(Number.NaN);
  const centers = new Float64Array(count);
  for (let i = 0; i < count; i++) {
    const at = i * HOP;
    centers[i] = (at + FRAME / 4) / lr;
    if ((rms[i] as number) < floor) continue;
    const found = yin(x.subarray(at, at + FRAME), lr);
    if (!found) continue;
    coarse[i] = midiOf(found.hz);
    centers[i] = (at + FRAME / 4 + lr / found.hz / 2) / lr;
  }
  // a frame an octave off both sides of it is put back; a lone frame is dropped
  for (let i = 1; i + 1 < count; i++) {
    const v = coarse[i] as number;
    const a = coarse[i - 1] as number;
    const b = coarse[i + 1] as number;
    if (Number.isNaN(v)) continue;
    if (Number.isNaN(a) && Number.isNaN(b)) {
      coarse[i] = Number.NaN;
      continue;
    }
    const near = Number.isNaN(a) ? b : Number.isNaN(b) ? a : (a + b) / 2;
    const off = Math.round((near - v) / 12) * 12;
    if (off !== 0 && Math.abs(v + off - near) < 1) coarse[i] = v + off;
  }
  // the fine track, every 5 ms through the voiced frames
  const fineT: number[] = [];
  const fineP: number[] = [];
  const firstVoiced = coarse.findIndex((v) => !Number.isNaN(v));
  if (firstVoiced < 0) return null;
  const coarseAt = (t: number): number => {
    // the coarse pitch at a time: between the two frames around it, if both have one; else the nearer's
    let i = Math.max(0, Math.min(count - 1, Math.floor((t * lr - FRAME / 4) / HOP)));
    while (i > 0 && (centers[i] as number) > t) i--;
    const a = coarse[i] as number;
    const b = i + 1 < count ? (coarse[i + 1] as number) : Number.NaN;
    const ta = centers[i] as number;
    const tb = i + 1 < count ? (centers[i + 1] as number) : ta;
    if (!Number.isNaN(a) && !Number.isNaN(b) && Math.abs(a - b) < 1 && tb > ta)
      return a + ((b - a) * (t - ta)) / (tb - ta);
    if (!Number.isNaN(a) && t - ta < (1.5 * HOP) / lr) return a;
    if (!Number.isNaN(b) && tb - t < (1.5 * HOP) / lr) return b;
    return Number.NaN;
  };
  const end = samples.length / sr;
  for (let t = Math.max(0, (centers[firstVoiced] as number) - 0.03); t < end; t += FINE_S) {
    const c = coarseAt(t);
    fineT.push(t);
    if (Number.isNaN(c)) {
      fineP.push(Number.NaN);
      continue;
    }
    const p0 = sr / (440 * 2 ** ((c - 69) / 12));
    const period = refinePeriod(samples, sr, t * sr, p0);
    fineP.push(period ? midiOf(sr / period) : Number.NaN);
  }
  // its loudness at each step (10 ms around it, at the low rate)
  const envAt = (t: number, half = 0.005): number => {
    const a = Math.max(0, Math.round((t - half) * lr));
    const b = Math.min(x.length, Math.round((t + half) * lr));
    return b > a ? ((sq[b] as number) - (sq[a] as number)) / (b - a) : 0;
  };
  return { x, lr, sq, fineT, fineP, envAt };
}

/**
 * Where a note's voice starts, for a note from silence first heard at `start` (it lasts to `stop`;
 * its period `period` seconds, and nothing before `floorT` is its): going back from its loudest in
 * its first 80 ms, as long as its level (over one period) stays within ONSET_DB of that and the
 * sound is still voiced near its period (take.ts says why).
 */
export function voiceStart(tr: Tracked, start: number, stop: number, floorT: number, period: number): number {
  const { x, lr, envAt } = tr;
  // the level over one period (2 ms at least), so it doesn't dip inside a wave
  const half = Math.max(0.001, period / 2);
  const level = (t: number) => envAt(t, half);
  let top = 0;
  let topT = start;
  for (let t = start; t < Math.min(stop, start + 0.08); t += 0.001) {
    const e = level(t);
    if (e > top) {
      top = e;
      topT = t;
    }
  }
  const quiet = top * 10 ** (-ONSET_DB / 10);
  const voiced = (t: number) => voicedNear(x, lr, t * lr, period * lr);
  let t = topT;
  while (t - 0.001 > floorT && level(t - 0.001) >= quiet && voiced(t - 0.001)) t -= 0.001;
  // where the level crosses, between the last millisecond in and the first out
  const e0 = level(t - 0.001);
  const e1 = level(t);
  const at = t - 0.001 > floorT && e0 < quiet && e1 > e0 ? t - 0.001 + (0.001 * (quiet - e0)) / (e1 - e0) : t;
  return Math.max(floorT, Math.min(topT, at));
}

/**
 * A note's held part, from a pitch track (`t`, `p`: NaN where it isn't voiced) over its steps `a` to
 * `b`: what's voiced between `start` and `stop` with its attack and its end left out, or (when that's
 * under three steps) everything voiced in it.
 */
export function heldPart(
  t: ArrayLike<number>,
  p: ArrayLike<number>,
  a: number,
  b: number,
  start: number,
  stop: number,
): { ht: number[]; hp: number[] } {
  const dur = stop - start;
  const attack = Math.min(ATTACK_S, dur * 0.25);
  const release = Math.min(RELEASE_S, dur * 0.1);
  const ht: number[] = [];
  const hp: number[] = [];
  for (let k = a; k < b; k++) {
    const tk = t[k] as number;
    const pk = p[k] as number;
    if (tk >= start + attack && tk <= stop - release && !Number.isNaN(pk)) {
      ht.push(tk);
      hp.push(pk);
    }
  }
  if (hp.length < 3) {
    for (let k = a; k < b; k++)
      if (!Number.isNaN(p[k] as number)) {
        ht.push(t[k] as number);
        hp.push(p[k] as number);
      }
  }
  return { ht, hp };
}

/**
 * The pitch of a note's held part (times `ht`, pitches `hp`, at least one): the median, or with a
 * vibrato the mean over whole cycles; the cents a straight line through it moves (0 under 250 ms);
 * and its vibrato.
 */
export function heldPitch(
  ht: number[],
  hp: number[],
): { pitch: number; drift: number; vibrato: { rate: number; depth: number } | null } {
  const fit = line(ht, hp);
  const held = (ht[ht.length - 1] as number) - (ht[0] as number);
  const residual = hp.map((p, k) => (p - (fit.mid + fit.slope * ((ht[k] as number) - fit.tm))) * 100);
  const vibrato = vibratoOf(residual);
  let pitch: number;
  if (vibrato) {
    // the mean over whole cycles
    const cycle = Math.round(1 / vibrato.rate / FINE_S);
    const whole = Math.max(cycle, Math.floor(hp.length / cycle) * cycle);
    pitch = hp.slice(0, whole).reduce((acc, v) => acc + v, 0) / Math.min(whole, hp.length);
  } else pitch = median(hp);
  return { pitch, drift: held >= 0.25 ? fit.slope * held * 100 : 0, vibrato };
}
