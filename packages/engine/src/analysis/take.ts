/**
 * Measuring a sung or played line (a vocal take, a solo): each note's pitch to a cent or two, how it
 * drifts and its vibrato, where it starts against the grid, and how loud its phrases are, on the
 * song's timeline.
 *
 * - The line is tracked with YIN (pitch.ts) at about 11 kHz, every 11 ms; then each 5 ms its period is
 *   found again at the full rate, near where YIN put it, with a short window (a few periods): precise
 *   (a pure tone to a fraction of a cent) and quick enough to follow a vibrato.
 * - Notes are runs of that pitch: a new one where the pitch moves away and stays, or the sound dips
 *   and comes back (the same note sung again). A slide into a note, or off its end, is part of it.
 * - A note's pitch is that of its held part (its first 60 ms, its attack, left out): the median, or
 *   with a vibrato the mean over whole cycles. Its drift is how far a straight line through the held
 *   part moves; its vibrato the rate and depth (±cents) of what swings around that line.
 * - It starts where its sound does (from silence), or where the pitch moves (out of the note before).
 *
 * The take's regions are placed on the timeline as the engine plays them (compile.ts compileClips):
 * each region's offset and stretch, the tempo map, and where takes overlap, the later one heard.
 * Pitches are measured against the song's key at each note (its nearest scale tone), against what a
 * reference track plays there, or against the nearest semitone.
 */
import { type KeyPoint, keyAt, keysOf, keyText, meterAt, type Project, type Track, ticksPerBar } from '@holo/session';
import { compileTempo, frameToTick, tickToFrame } from '../compile.ts';
import type { TempoSegment } from '../protocol.ts';
import { downsample, midiOf, yin } from './pitch.ts';

// ---- a line's notes, in its own time ----

/** A note of a line, its times in seconds from the start of the samples measured. */
export interface LineNote {
  start: number;
  end: number;
  /** It starts from silence (an attack), not straight out of the note before (legato). */
  attack: boolean;
  /** Its pitch: a MIDI number with cents (69.25 is A4 25 cents sharp). */
  pitch: number;
  /** Cents its held part moves, start to end (a straight line through it). */
  drift: number;
  /** Its vibrato: cycles a second and depth (± cents), or null for none. */
  vibrato: { rate: number; depth: number } | null;
  /** Mean square and peak of its samples. */
  power: number;
  peak: number;
  /** How many samples that was. */
  frames: number;
}

/** The coarse track's frame and hop at about 11 kHz (93 ms frames, every 11.6 ms). */
const FRAME = 1024;
const HOP = 128;
/** The fine track: every 5 ms. */
const FINE_S = 0.005;
/** A note's attack (left out of its pitch), and the end left out. */
const ATTACK_S = 0.06;
const RELEASE_S = 0.03;
/** Shorter than this, a note is part of the next (a slide into it) or the last (a fall off it), or nothing. */
const SLIDE_S = 0.1;
const MIN_NOTE_S = 0.06;
/** A pitch this far from the note's (semitones) for this long is the next note. */
const STEP = 0.7;
const STEP_S = 0.03;
/** A gap in the pitch this long ends a note. */
const GAP_S = 0.02;

/** The samples' channels as one (their mean). */
export function monoOf(channels: readonly Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0] as Float32Array;
  const n = channels.reduce((m, c) => Math.max(m, c.length), 0);
  const out = new Float32Array(n);
  for (const c of channels) for (let i = 0; i < c.length; i++) out[i] = (out[i] as number) + (c[i] as number);
  for (let i = 0; i < n; i++) out[i] = (out[i] as number) / channels.length;
  return out;
}

const median = (values: number[]): number => {
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

/**
 * The notes of one line (mono samples): their times, pitches, drift, vibrato and loudness. A level
 * 38 dB under the loudest is the room, not the line.
 */
export function lineNotes(samples: Float32Array, sampleRate: number): LineNote[] {
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
  if (firstVoiced < 0) return [];
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
  // the fine track smoothed (median of five) for finding notes
  const smooth = fineP.map((_, k) => {
    const near: number[] = [];
    for (let j = k - 2; j <= k + 2; j++) {
      const v = fineP[j];
      if (v !== undefined && !Number.isNaN(v)) near.push(v);
    }
    return !Number.isNaN(fineP[k] as number) && near.length >= 3 ? median(near) : Number.NaN;
  });
  // runs of pitch, split where it moves away and stays, or the sound dips and comes back
  const segs: { a: number; b: number }[] = [];
  const gapSteps = Math.round(GAP_S / FINE_S);
  const stepSteps = Math.round(STEP_S / FINE_S);
  let a = -1;
  let lastVoiced = -1;
  let away = 0;
  const close = (b: number) => {
    if (a >= 0 && b > a) segs.push({ a, b });
    a = -1;
    away = 0;
  };
  for (let k = 0; k < smooth.length; k++) {
    const v = smooth[k] as number;
    if (Number.isNaN(v)) {
      if (a >= 0 && k - lastVoiced > gapSteps) close(lastVoiced + 1);
      continue;
    }
    if (a < 0) {
      a = k;
      lastVoiced = k;
      continue;
    }
    // the note's pitch so far: the median of its last 150 ms before any move away
    const from = Math.max(a, k - away - 30);
    const ref: number[] = [];
    for (let j = from; j < k - away; j++) if (!Number.isNaN(smooth[j] as number)) ref.push(smooth[j] as number);
    if (ref.length && Math.abs(v - median(ref)) > STEP && (k - a) * FINE_S > 0.02) {
      away++;
      if (away >= stepSteps) {
        const b = k - away + 1;
        close(b);
        a = b;
      }
    } else away = 0;
    lastVoiced = k;
  }
  close(lastVoiced + 1);
  // a dip in the sound inside a note, with sound either side, is a new note on the same pitch
  const split: { a: number; b: number }[] = [];
  const reach = Math.round(0.15 / FINE_S);
  for (const s of segs) {
    let start = s.a;
    const env = (k: number) => envAt(fineT[k] as number);
    for (let k = s.a + reach; k < s.b - Math.round(0.05 / FINE_S); k++) {
      const e = env(k);
      if (e >= env(k - 1) || e > env(k + 1)) continue;
      let before = 0;
      let after = 0;
      for (let j = Math.max(start, k - reach); j < k; j++) before = Math.max(before, env(j));
      for (let j = k + 1; j < Math.min(s.b, k + reach); j++) after = Math.max(after, env(j));
      if (before > 6 * e && after > 6 * e && k - start > Math.round(0.08 / FINE_S)) {
        split.push({ a: start, b: k });
        start = k;
      }
    }
    split.push({ a: start, b: s.b });
  }
  // slides into a note, and falls off one, belong to it (a short run that moves half a semitone or
  // more; a short steady one is a quick note of its own)
  const time = (k: number) => (fineT[k] ?? end) as number;
  const moves = (s: { a: number; b: number }) => {
    let lo = Number.POSITIVE_INFINITY;
    let hi = Number.NEGATIVE_INFINITY;
    for (let k = s.a; k < s.b; k++) {
      const v = smooth[k] as number;
      if (Number.isNaN(v)) continue;
      lo = Math.min(lo, v);
      hi = Math.max(hi, v);
    }
    return hi - lo >= 0.5;
  };
  const merged: { a: number; b: number }[] = [];
  for (let i = 0; i < split.length; i++) {
    const s = split[i] as { a: number; b: number };
    const len = time(s.b) - time(s.a);
    const next = split[i + 1];
    const prev = merged[merged.length - 1];
    const slide = len < SLIDE_S && (moves(s) || len < MIN_NOTE_S);
    if (slide && next && next.a === s.b) {
      next.a = s.a;
      continue;
    }
    if (slide && prev && prev.b === s.a) {
      prev.b = s.b;
      continue;
    }
    if (len >= MIN_NOTE_S) merged.push({ ...s });
  }
  // each note's numbers
  const notes: LineNote[] = [];
  for (let i = 0; i < merged.length; i++) {
    const s = merged[i] as { a: number; b: number };
    const prev = merged[i - 1];
    const legato = !!prev && prev.b === s.a;
    let start = time(s.a);
    const stop = time(s.b);
    if (!legato) {
      // from silence: where the sound rises to 30% of its power in the note's first 80 ms
      const floorT = Math.max(prev ? time(prev.b) : 0, start - 0.15);
      let top = 0;
      let topT = start;
      for (let t = start; t < Math.min(stop, start + 0.08); t += 0.001) {
        const e = envAt(t, 0.0025);
        if (e > top) {
          top = e;
          topT = t;
        }
      }
      let t = topT;
      while (t - 0.001 > floorT && envAt(t - 0.001, 0.0025) >= 0.3 * top) t -= 0.001;
      const e0 = envAt(t - 0.001, 0.0025);
      const e1 = envAt(t, 0.0025);
      start = t - 0.001 + (e1 > e0 ? (0.001 * (0.3 * top - e0)) / (e1 - e0) : 0.001);
      start = Math.max(floorT, Math.min(topT, start));
    }
    const dur = stop - start;
    const attack = Math.min(ATTACK_S, dur * 0.25);
    const release = Math.min(RELEASE_S, dur * 0.1);
    const ht: number[] = [];
    const hp: number[] = [];
    for (let k = s.a; k < s.b; k++) {
      const t = fineT[k] as number;
      const p = fineP[k] as number;
      if (t >= start + attack && t <= stop - release && !Number.isNaN(p)) {
        ht.push(t);
        hp.push(p);
      }
    }
    if (hp.length < 3) {
      for (let k = s.a; k < s.b; k++)
        if (!Number.isNaN(fineP[k] as number)) {
          ht.push(fineT[k] as number);
          hp.push(fineP[k] as number);
        }
    }
    if (!hp.length) continue;
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
    // loudness, at the full rate
    const i0 = Math.max(0, Math.floor(start * sr));
    const i1 = Math.min(samples.length, Math.ceil(stop * sr));
    let power = 0;
    let peak = 0;
    for (let k = i0; k < i1; k++) {
      const v = samples[k] as number;
      power += v * v;
      if (Math.abs(v) > peak) peak = Math.abs(v);
    }
    notes.push({
      start,
      end: stop,
      attack: !legato,
      pitch,
      drift: held >= 0.25 ? fit.slope * held * 100 : 0,
      vibrato,
      power: i1 > i0 ? power / (i1 - i0) : 0,
      peak,
      frames: Math.max(0, i1 - i0),
    });
  }
  return notes;
}

// ---- a take's regions on the timeline ----

/** A stretch of a recording as the timeline plays it: what of the file, and where. */
export interface TakePiece {
  region: string;
  name: string;
  file: string;
  /** Seconds of the file. */
  fileStart: number;
  fileEnd: number;
  /** Seconds on the timeline (through the tempo map) where `fileStart` plays. */
  at: number;
  stretch: number;
  /** The region's gain (dB). */
  gain: number;
}

/**
 * What an audio track plays, piece by piece, as the engine does (compileClips): each region's audio
 * from its offset, stretched, the later region heard where two overlap; muted ones left out. Only
 * what falls in `from`–`to` (ticks), and only `region`'s pieces if it's given.
 */
export function takePieces(
  project: Project,
  track: Track,
  opts: { from?: number; to?: number; region?: string } = {},
): TakePiece[] {
  const seg = compileTempo(project, 1);
  const lo = opts.from !== undefined ? tickToFrame(seg, opts.from) : Number.NEGATIVE_INFINITY;
  const hi = opts.to !== undefined ? tickToFrame(seg, opts.to) : Number.POSITIVE_INFINITY;
  const out: TakePiece[] = [];
  const covered: [number, number][] = [];
  for (let i = track.regions.length - 1; i >= 0; i--) {
    const r = track.regions[i] as Track['regions'][number];
    const clip = r.audio;
    if (!clip || r.muted) continue;
    const start = tickToFrame(seg, r.start);
    const stop = tickToFrame(seg, r.start + r.length);
    let pieces: [number, number][] = [[start, stop]];
    for (const [c0, c1] of covered) {
      pieces = pieces.flatMap(([s, e]): [number, number][] =>
        c1 <= s || c0 >= e
          ? [[s, e]]
          : [...(c0 > s ? [[s, c0] as [number, number]] : []), ...(c1 < e ? [[c1, e] as [number, number]] : [])],
      );
    }
    covered.push([start, stop]);
    if (opts.region && r.id !== opts.region) continue;
    for (const [s0, e0] of pieces) {
      const s = Math.max(s0, lo);
      const e = Math.min(e0, hi);
      if (e - s < 1e-6) continue;
      const stretch = clip.stretch > 0 ? clip.stretch : 1;
      out.push({
        region: r.id,
        name: r.name,
        file: clip.file,
        fileStart: clip.offset + (s - start) / stretch,
        fileEnd: clip.offset + (e - start) / stretch,
        at: s,
        stretch,
        gain: clip.gain,
      });
    }
  }
  return out.sort((x, y) => x.at - y.at);
}

// ---- measuring a take ----

/** A note of a take, on the song's timeline (ticks and seconds), measured against what it should be. */
export interface TakeNote {
  /** Ticks where it starts and ends; null for a recording that isn't on the timeline (an attachment). */
  tick: number | null;
  end: number | null;
  /** Seconds where it starts (on the timeline, or into the recording) and how long it lasts. */
  at: number;
  length: number;
  /** Its pitch, as a MIDI number with cents. */
  pitch: number;
  /** The note it's measured against (MIDI), and how far off it is (cents; above 0 is sharp). */
  target: number;
  cents: number;
  /** Against the key: whether that note is in the key there. */
  inKey?: boolean;
  /** Against a track: the note it plays there (MIDI), null where it plays none. */
  ref?: number | null;
  drift: number;
  /** [cycles a second, ± cents]. */
  vibrato: [number, number] | null;
  /** ms from the nearest line of the grid (above 0: late); null off the timeline. */
  grid: number | null;
  attack: boolean;
  /** Level (RMS dBFS) and peak (dBFS), the region's gain included. */
  db: number;
  peak: number;
  region: string | null;
}

/** A phrase: notes with no breath (350 ms) between them. */
export interface TakePhrase {
  tick: number | null;
  end: number | null;
  at: number;
  length: number;
  notes: number;
  db: number;
  peak: number;
}

export interface TakeSummary {
  notes: number;
  /** Mean of how far off the notes are (cents, either way), and their lean (signed mean). */
  meanAbs: number;
  bias: number;
  /** Shares of notes within ±10 and ±25 cents. */
  within10: number;
  within25: number;
  /** Notes more than 25 cents sharp, and flat. */
  sharp: number;
  flat: number;
  /** Against the grid (ms): the mean and the spread (standard deviation), and notes more than 30 ms late or early. */
  timing: { mean: number; spread: number; late: number; early: number } | null;
  /** Notes with a vibrato, and its mean rate and depth. */
  vibrato: { notes: number; rate: number; depth: number } | null;
  /** Notes whose held part moves 15 cents or more. */
  drifting: number;
}

export type TakeAgainst = { kind: 'key'; keys: string[] } | { kind: 'track'; track: string } | { kind: 'none' };

export interface TakeReport {
  regions: string[];
  /** Seconds of recording measured. */
  seconds: number;
  against: TakeAgainst;
  /** The grid (ticks); 0 off the timeline. */
  grid: number;
  notes: TakeNote[];
  phrases: TakePhrase[];
  summary: TakeSummary;
}

export interface TakeOptions {
  from?: number;
  to?: number;
  region?: string;
  /** The key (the default), a reference track (an instrument track's notes), or the nearest semitone. */
  against?: 'key' | 'none' | Track;
  /** Ticks (a sixteenth, 240, by default). */
  grid?: number;
}

/** A decoded file: its rate and channels. */
export interface Decoded {
  rate: number;
  channels: Float32Array[];
}

/** The pitch classes of a key signature's scale. */
function scaleOf(k: KeyPoint): Set<number> {
  const out = new Set<number>();
  for (let i = -1; i < 6; i++) out.add(((((i + k.fifths) * 7) % 12) + 12) % 12);
  return out;
}

/** The note a pitch is measured against in a key: its nearest semitone, or the scale tone beside it if that's in the key and near. */
function keyTarget(pitch: number, key: KeyPoint | null): { target: number; inKey?: boolean } {
  const nearest = Math.round(pitch);
  if (!key) return { target: nearest };
  const scale = scaleOf(key);
  const pc = (n: number) => ((n % 12) + 12) % 12;
  if (scale.has(pc(nearest))) return { target: nearest, inKey: true };
  const other = pitch > nearest ? nearest + 1 : nearest - 1;
  if (scale.has(pc(other)) && Math.abs(pitch - other) <= 0.55) return { target: other, inKey: true };
  return { target: nearest, inKey: false };
}

/** The note a reference track plays at a tick that a pitch is nearest (octaves aside), or null. */
function refNote(track: Track, tick: number, pitch: number): number | null {
  let best: number | null = null;
  let dist = Number.POSITIVE_INFINITY;
  for (const r of track.regions) {
    if (r.muted || tick < r.start || tick >= r.start + r.length) continue;
    for (const n of r.notes) {
      const on = r.start + n.t;
      if (tick < on || tick >= Math.min(on + n.d, r.start + r.length)) continue;
      const d = Math.abs(((((pitch - n.p) % 12) + 18) % 12) - 6);
      if (d < dist) {
        dist = d;
        best = n.p;
      }
    }
  }
  return best;
}

const round = (v: number, places: number) => Math.round(v * 10 ** places) / 10 ** places;
const dbOf = (amp: number) => (amp > 0 ? 20 * Math.log10(amp) : -144);

/** Phrases of notes (sorted), with their levels: notes no more than a breath (350 ms) apart. */
function phrasesOf(notes: TakeNote[], power: number[], frames: number[]): TakePhrase[] {
  const out: TakePhrase[] = [];
  let first = 0;
  for (let i = 1; i <= notes.length; i++) {
    const prev = notes[i - 1] as TakeNote;
    const next = notes[i];
    if (next && next.at - (prev.at + prev.length) < 0.35) continue;
    const group = notes.slice(first, i);
    let p = 0;
    let f = 0;
    for (let k = first; k < i; k++) {
      p += (power[k] as number) * (frames[k] as number);
      f += frames[k] as number;
    }
    const a = group[0] as TakeNote;
    const z = group[group.length - 1] as TakeNote;
    out.push({
      tick: a.tick,
      end: z.end,
      at: round(a.at, 3),
      length: round(z.at + z.length - a.at, 3),
      notes: group.length,
      db: round(10 * Math.log10(Math.max(f ? p / f : 0, 1e-15)), 1),
      peak: round(Math.max(...group.map((n) => n.peak)), 1),
    });
    first = i;
  }
  return out;
}

function summaryOf(notes: TakeNote[]): TakeSummary {
  const n = notes.length;
  const cents = notes.map((x) => x.cents);
  const timed = notes.map((x) => x.grid).filter((g): g is number => g !== null);
  const vib = notes.filter((x) => x.vibrato);
  const mean = (a: number[]) => (a.length ? a.reduce((s, v) => s + v, 0) / a.length : 0);
  const tm = mean(timed);
  return {
    notes: n,
    meanAbs: round(mean(cents.map(Math.abs)), 1),
    bias: round(mean(cents), 1),
    within10: n ? round(cents.filter((c) => Math.abs(c) <= 10).length / n, 2) : 0,
    within25: n ? round(cents.filter((c) => Math.abs(c) <= 25).length / n, 2) : 0,
    sharp: cents.filter((c) => c > 25).length,
    flat: cents.filter((c) => c < -25).length,
    timing: timed.length
      ? {
          mean: round(tm, 1),
          spread: round(Math.sqrt(mean(timed.map((g) => (g - tm) ** 2))), 1),
          late: timed.filter((g) => g > 30).length,
          early: timed.filter((g) => g < -30).length,
        }
      : null,
    vibrato: vib.length
      ? {
          notes: vib.length,
          rate: round(mean(vib.map((x) => (x.vibrato as [number, number])[0])), 1),
          depth: round(mean(vib.map((x) => (x.vibrato as [number, number])[1])), 1),
        }
      : null,
    drifting: notes.filter((x) => Math.abs(x.drift) >= 15).length,
  };
}

/** Where the nearest line of the grid is to a tick, in the bar it's in. */
function gridLine(project: Project, tick: number, grid: number): number {
  const m = meterAt(project.meter, tick);
  const bar = ticksPerBar(m);
  const barStart = m.tick + Math.floor((tick - m.tick) / bar) * bar;
  return Math.min(barStart + bar, barStart + Math.round((tick - barStart) / grid) * grid);
}

/** A note's numbers against its target, as a take's note. */
function takeNote(
  n: LineNote,
  at: number,
  length: number,
  gain: number,
  target: { target: number; inKey?: boolean; ref?: number | null },
): TakeNote {
  return {
    tick: null,
    end: null,
    at: round(at, 3),
    length: round(length, 3),
    pitch: round(n.pitch, 3),
    target: target.target,
    cents: round((n.pitch - target.target) * 100, 1),
    ...(target.inKey !== undefined ? { inKey: target.inKey } : {}),
    ...(target.ref !== undefined ? { ref: target.ref } : {}),
    drift: round(n.drift, 1),
    vibrato: n.vibrato ? [round(n.vibrato.rate, 2), round(n.vibrato.depth, 1)] : null,
    grid: null,
    attack: n.attack,
    db: round(dbOf(Math.sqrt(n.power)) + gain, 1),
    peak: round(dbOf(n.peak) + gain, 1),
    region: null,
  };
}

/**
 * A take on an audio track, measured note by note on the timeline: each piece the track plays (its
 * regions, `from`–`to`), from the file `decode` gives for it.
 */
export function measureTake(
  project: Project,
  track: Track,
  decode: (file: string) => Decoded | null,
  opts: TakeOptions = {},
): TakeReport {
  const grid = Math.max(1, Math.round(opts.grid ?? 240));
  const pieces = takePieces(project, track, opts);
  const seg: TempoSegment[] = compileTempo(project, 1);
  const keys = keysOf(project);
  const against = opts.against ?? 'key';
  const notes: TakeNote[] = [];
  const power: number[] = [];
  const frames: number[] = [];
  let seconds = 0;
  const cache = new Map<string, { rate: number; mono: Float32Array } | null>();
  for (const piece of pieces) {
    if (!cache.has(piece.file)) {
      const d = decode(piece.file);
      cache.set(piece.file, d ? { rate: d.rate, mono: monoOf(d.channels) } : null);
    }
    const file = cache.get(piece.file);
    if (!file) continue;
    const i0 = Math.max(0, Math.round(piece.fileStart * file.rate));
    const i1 = Math.min(file.mono.length, Math.round(piece.fileEnd * file.rate));
    if (i1 - i0 < file.rate * 0.05) continue;
    seconds += (i1 - i0) / file.rate;
    for (const n of lineNotes(file.mono.subarray(i0, i1), file.rate)) {
      const at = piece.at + (n.start + i0 / file.rate - piece.fileStart) * piece.stretch;
      const length = (n.end - n.start) * piece.stretch;
      const tick = frameToTick(seg, at);
      const end = frameToTick(seg, at + length);
      const mid = tick + (end - tick) * 0.4;
      let target: { target: number; inKey?: boolean; ref?: number | null };
      if (against === 'none') target = { target: Math.round(n.pitch) };
      else if (against === 'key') target = keyTarget(n.pitch, keyAt(keys, mid));
      else {
        const ref = refNote(against, mid, n.pitch);
        target =
          ref === null
            ? { ...keyTarget(n.pitch, keyAt(keys, mid)), ref: null }
            : { target: ref + 12 * Math.round((n.pitch - ref) / 12), ref };
      }
      const note = takeNote(n, at, length, piece.gain, target);
      note.tick = Math.round(tick);
      note.end = Math.round(end);
      note.region = piece.region;
      const line = gridLine(project, tick, grid);
      note.grid = round((at - tickToFrame(seg, line)) * 1000, 1);
      notes.push(note);
      power.push(n.power * 10 ** (piece.gain / 10));
      frames.push(n.frames);
    }
  }
  const order = notes.map((_, i) => i).sort((x, y) => (notes[x] as TakeNote).at - (notes[y] as TakeNote).at);
  const sorted = order.map((i) => notes[i] as TakeNote);
  const lo = opts.from ?? 0;
  const hi = opts.to ?? Number.POSITIVE_INFINITY;
  const keysThere = keys.filter((k, i) => (keys[i + 1]?.tick ?? Number.POSITIVE_INFINITY) > lo && k.tick < hi);
  return {
    regions: [...new Set(pieces.map((p) => p.region))],
    seconds: round(seconds, 2),
    against:
      against === 'none'
        ? { kind: 'none' }
        : against === 'key'
          ? keys.length
            ? { kind: 'key', keys: keysThere.map((k) => keyText(k)) }
            : { kind: 'none' }
          : { kind: 'track', track: against.id },
    grid,
    notes: sorted,
    phrases: phrasesOf(
      sorted,
      order.map((i) => power[i] as number),
      order.map((i) => frames[i] as number),
    ),
    summary: summaryOf(sorted),
  };
}

/**
 * A recording that isn't on the timeline (an attachment): its notes against a key (the song's first,
 * or none), with times in seconds into it and no grid.
 */
export function measureRecording(
  channels: Float32Array[],
  sampleRate: number,
  key: KeyPoint | null,
  against: 'key' | 'none' = 'key',
): TakeReport {
  const mono = monoOf(channels);
  const found = lineNotes(mono, sampleRate);
  const notes = found.map((n) =>
    takeNote(
      n,
      n.start,
      n.end - n.start,
      0,
      against === 'key' ? keyTarget(n.pitch, key) : { target: Math.round(n.pitch) },
    ),
  );
  return {
    regions: [],
    seconds: round(mono.length / sampleRate, 2),
    against: against === 'key' && key ? { kind: 'key', keys: [keyText(key)] } : { kind: 'none' },
    grid: 0,
    notes,
    phrases: phrasesOf(
      notes,
      found.map((n) => n.power),
      found.map((n) => n.frames),
    ),
    summary: summaryOf(notes),
  };
}
