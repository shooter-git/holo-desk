import {
  type AudioClip,
  type AudioNote,
  type AudioNotes,
  newAudioTrack,
  newProject,
  newRegion,
  PPQ,
  type Project,
  parseAudioNotes,
} from '@holo/session';
import { describe, expect, it } from 'vitest';
import { fineTrack } from '../src/analysis/take.ts';
import { compileClips, compileTempo } from '../src/compile.ts';
import { editedPitch, formantShift, noteGain, pitchSpan, targetShift } from '../src/notes/curve.ts';
import { assembleClip, renderNotePatch } from '../src/notes/patch.ts';
import { type PatchJob, regionPatches } from '../src/notes/plan.ts';
import { renderSession } from '../src/render.ts';
import { resample } from '../src/resample.ts';
import { stretchAudio } from '../src/stretch.ts';
import { encodeWav } from '../src/wav.ts';

const SR = 48000;

/**
 * A sung note: from `t` for `d` seconds at a MIDI pitch, with a vibrato ([Hz, ± cents]) if asked, a
 * drift (the cents its pitch moves through it, in line) and, into the next note where they touch, a
 * glide this long (s; 40 ms if not said).
 */
interface Sung {
  t: number;
  d: number;
  midi: number;
  vibrato?: [number, number];
  drift?: number;
  glide?: number;
}

/**
 * A synthetic voice: a band-limited pulse train (its harmonics up to 8 kHz) at the notes' pitches,
 * through three formant resonators (an "ah": 700, 1220 and 2600 Hz), with 20 ms attacks and releases.
 * Notes that touch are sung legato: the voice goes on, its pitch gliding where they meet.
 */
function voice(notes: Sung[], seconds: number): Float32Array {
  const n = Math.round(seconds * SR);
  const f0 = new Float64Array(n);
  const env = new Float64Array(n);
  notes.forEach((s, k) => {
    const prev = notes[k - 1];
    const next = notes[k + 1];
    const fromPrev = prev && Math.abs(prev.t + prev.d - s.t) < 1e-6 ? prev : null;
    const intoNext = next && Math.abs(s.t + s.d - next.t) < 1e-6 ? next : null;
    const into = (fromPrev?.glide ?? 0.04) / 2;
    const out = (s.glide ?? 0.04) / 2;
    for (let i = Math.round(s.t * SR); i < Math.round((s.t + s.d) * SR); i++) {
      const t = i / SR - s.t;
      let m = s.midi;
      if (s.vibrato) m += (s.vibrato[1] / 100) * Math.sin(2 * Math.PI * s.vibrato[0] * t);
      if (s.drift) m += (s.drift / 100) * (t / s.d - 0.5);
      if (fromPrev && t < into) {
        const u = 0.5 + t / (2 * into);
        m = fromPrev.midi + (m - fromPrev.midi) * u * u * (3 - 2 * u);
      }
      if (intoNext && s.d - t < out) {
        const u = 0.5 - (s.d - t) / (2 * out);
        m += (intoNext.midi - m) * u * u * (3 - 2 * u);
      }
      f0[i] = 440 * 2 ** ((m - 69) / 12);
      env[i] = Math.min(fromPrev ? 1 : Math.min(1, t / 0.02), intoNext ? 1 : Math.min(1, (s.d - t) / 0.02));
    }
  });
  const pulses = new Float64Array(n);
  let phase = 0;
  for (let i = 0; i < n; i++) {
    const f = f0[i] as number;
    if (f <= 0) continue;
    phase += f / SR;
    const top = Math.floor(8000 / f);
    let v = 0;
    for (let h = 1; h <= top; h++) v += Math.cos(2 * Math.PI * h * phase);
    pulses[i] = (v / top) * (env[i] as number);
  }
  const out = new Float32Array(n);
  for (const [hz, q, g] of [
    [700, 6, 1],
    [1220, 8, 0.5],
    [2600, 10, 0.25],
  ] as const) {
    // a band pass, 0 dB at its centre
    const w = (2 * Math.PI * hz) / SR;
    const alpha = Math.sin(w) / (2 * q);
    const b0 = alpha / (1 + alpha);
    const a1 = (-2 * Math.cos(w)) / (1 + alpha);
    const a2 = (1 - alpha) / (1 + alpha);
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < n; i++) {
      const x = pulses[i] as number;
      const y = b0 * (x - x2) - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = x;
      y2 = y1;
      y1 = y;
      out[i] = (out[i] as number) + 0.5 * g * y;
    }
  }
  return out;
}

/**
 * A low voice for hearing formants: a band-limited pulse train at a pitch (with a vibrato of ±30
 * cents at 5.5 Hz) through a cascade of all-pole resonators ([Hz, bandwidth Hz]): the envelope linear
 * prediction models exactly, its harmonics close enough together to show it.
 */
function lowVoice(midi: number, t0: number, d: number, seconds: number, formants: [number, number][]): Float32Array {
  const n = Math.round(seconds * SR);
  const x = new Float64Array(n);
  let phase = 0;
  for (let i = Math.round(t0 * SR); i < Math.round((t0 + d) * SR); i++) {
    const t = i / SR - t0;
    const f = 440 * 2 ** ((midi + 0.3 * Math.sin(2 * Math.PI * 5.5 * t) - 69) / 12);
    phase += f / SR;
    const top = Math.floor(8000 / f);
    let v = 0;
    for (let h = 1; h <= top; h++) v += Math.cos(2 * Math.PI * h * phase);
    x[i] = (v / top) * Math.min(1, t / 0.02, (d - t) / 0.02);
  }
  for (const [hz, bw] of formants) {
    const r = Math.exp((-Math.PI * bw) / SR);
    const a1 = -2 * r * Math.cos((2 * Math.PI * hz) / SR);
    const a2 = r * r;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < n; i++) {
      const y = (1 + a1 + a2) * (x[i] as number) - a1 * y1 - a2 * y2;
      y2 = y1;
      y1 = y;
      x[i] = y;
    }
  }
  return Float32Array.from(x, (v) => 0.3 * v);
}

/** Solves a small linear system (Gaussian elimination, in place). */
function solve(a: number[][], y: number[]): number[] {
  const n = y.length;
  for (let c = 0; c < n; c++)
    for (let r = c + 1; r < n; r++) {
      const f = (a[r] as number[])[c] as number;
      const g = f / ((a[c] as number[])[c] as number);
      for (let j = c; j < n; j++)
        (a[r] as number[])[j] = ((a[r] as number[])[j] as number) - g * ((a[c] as number[])[j] as number);
      y[r] = (y[r] as number) - g * (y[c] as number);
    }
  const x = new Array<number>(n).fill(0);
  for (let r = n - 1; r >= 0; r--) {
    let v = y[r] as number;
    for (let j = r + 1; j < n; j++) v -= ((a[r] as number[])[j] as number) * (x[j] as number);
    x[r] = v / ((a[r] as number[])[r] as number);
  }
  return x;
}

/**
 * A held note's pitch as the fine track hears it from `from` to `to` (s): its mean (MIDI), its drift
 * (the cents a line through it moves) and its vibrato's depth (± cents), from a line and a sinusoid at
 * `rate` Hz fitted together (least squares: the track loses a step here and there where a deep
 * vibrato moves fastest, which a fit doesn't mind).
 */
function heldOf(x: Float32Array, from: number, to: number, rate = 5.5): { mean: number; drift: number; depth: number } {
  const start = Math.max(0, Math.round((from - 0.2) * SR));
  const track = fineTrack(x.subarray(start, Math.round((to + 0.2) * SR)), SR);
  const rows: number[][] = [];
  const ys: number[] = [];
  for (let k = 0; k < track.t.length; k++) {
    const t = (track.t[k] as number) + start / SR;
    if (t < from || t > to || Number.isNaN(track.midi[k] as number)) continue;
    rows.push([1, t - (from + to) / 2, Math.sin(2 * Math.PI * rate * t), Math.cos(2 * Math.PI * rate * t)]);
    ys.push(track.midi[k] as number);
  }
  const a = [0, 1, 2, 3].map((i) =>
    [0, 1, 2, 3].map((j) => rows.reduce((s, r) => s + (r[i] as number) * (r[j] as number), 0)),
  );
  const y = [0, 1, 2, 3].map((i) => rows.reduce((s, r, k) => s + (r[i] as number) * (ys[k] as number), 0));
  const [mean, slope, sin, cos] = solve(a, y) as [number, number, number, number];
  return { mean, drift: slope * (to - from) * 100, depth: Math.hypot(sin, cos) * 100 };
}

/** A sound's fundamental alone: a band pass at `hz` (Q 2), twice, each forward and backward (no delay). */
function fundamental(x: Float32Array, hz: number): Float64Array {
  const w = (2 * Math.PI * hz) / SR;
  const alpha = Math.sin(w) / 4;
  const b0 = alpha / (1 + alpha);
  const a1 = (-2 * Math.cos(w)) / (1 + alpha);
  const a2 = (1 - alpha) / (1 + alpha);
  let y = Float64Array.from(x);
  const pass = () => {
    let x1 = 0;
    let x2 = 0;
    let y1 = 0;
    let y2 = 0;
    for (let i = 0; i < y.length; i++) {
      const u = y[i] as number;
      const v = b0 * (u - x2) - a1 * y1 - a2 * y2;
      x2 = x1;
      x1 = u;
      y2 = y1;
      y1 = v;
      y[i] = v;
    }
    y = y.reverse();
  };
  for (let k = 0; k < 4; k++) pass();
  return y;
}

/** A sound's periods from `from` to `to` (s), between rising zero crossings of its fundamental (near `hz`): each one's middle (s) and length (samples). */
function periodsOf(x: Float32Array, hz: number, from: number, to: number): { t: number[]; len: number[] } {
  const y = fundamental(x, hz);
  const ups: number[] = [];
  for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) {
    const a = y[i - 1] as number;
    const b = y[i] as number;
    if (a < 0 && b >= 0) ups.push(i - 1 + a / (a - b));
  }
  const t: number[] = [];
  const len: number[] = [];
  for (let k = 0; k + 1 < ups.length; k++) {
    t.push(((ups[k] as number) + (ups[k + 1] as number)) / 2 / SR);
    len.push((ups[k + 1] as number) - (ups[k] as number));
  }
  return { t, len };
}

/** How long (s) a glide from pitch a to b takes, from 10% of the way to 90%, measured period by period around `near` (s). */
function glideOf(x: Float32Array, a: number, b: number, near: number): number {
  const { t, len } = periodsOf(x, 440 * 2 ** (((a + b) / 2 - 69) / 12), near - 0.4, near + 0.4);
  const share = len.map((l) => (69 + 12 * Math.log2(SR / l / 440) - a) / (b - a));
  const cross = (k: number, level: number) => {
    const u = (share[k] as number) - level;
    const v = (share[k + 1] as number) - level;
    return u <= 0 !== v <= 0
      ? (t[k] as number) + (((t[k + 1] as number) - (t[k] as number)) * u) / (u - v)
      : Number.NaN;
  };
  let half = -1;
  let t50 = Number.NaN;
  for (let k = 0; k + 1 < t.length; k++) {
    const c = cross(k, 0.5);
    if (!Number.isNaN(c) && (Number.isNaN(t50) || Math.abs(c - near) < Math.abs(t50 - near))) {
      t50 = c;
      half = k;
    }
  }
  let t10 = Number.NaN;
  let t90 = Number.NaN;
  for (let k = half; k >= 0 && Number.isNaN(t10); k--) t10 = cross(k, 0.1);
  for (let k = half; k + 1 < t.length && Number.isNaN(t90); k++) t90 = cross(k, 0.9);
  return t90 - t10;
}

/**
 * The formant peaks of a sound from `from` to `to` (s), near each of `near` (Hz): its envelope by
 * linear prediction (at 16 kHz, order 14, the autocorrelation summed over 30 ms frames), its highest
 * point within −15% and +18% of each, between hertz by a parabola.
 */
function formantsOf(x: Float32Array, from: number, to: number, near: number[]): number[] {
  const rate = 16000;
  const order = 14;
  const y = resample(x.subarray(Math.round(from * SR), Math.round(to * SR)), SR, rate);
  const frame = 480;
  const r = new Float64Array(order + 1);
  for (let a = 0; a + frame <= y.length; a += 160) {
    const f = Float64Array.from(
      { length: frame },
      (_, i) => (y[a + i] as number) * (0.5 - 0.5 * Math.cos((2 * Math.PI * i) / frame)),
    );
    for (let l = 0; l <= order; l++)
      for (let i = l; i < frame; i++) r[l] = (r[l] as number) + (f[i] as number) * (f[i - l] as number);
  }
  const c = new Float64Array(order + 1);
  c[0] = 1;
  let err = r[0] as number;
  for (let i = 1; i <= order; i++) {
    let acc = r[i] as number;
    for (let j = 1; j < i; j++) acc += (c[j] as number) * (r[i - j] as number);
    const k = -acc / err;
    const prev = Float64Array.from(c);
    for (let j = 1; j < i; j++) c[j] = (prev[j] as number) + k * (prev[i - j] as number);
    c[i] = k;
    err *= 1 - k * k;
  }
  const env = (hz: number) => {
    const w = (2 * Math.PI * hz) / rate;
    let re = 0;
    let im = 0;
    for (let j = 0; j <= order; j++) {
      re += (c[j] as number) * Math.cos(w * j);
      im -= (c[j] as number) * Math.sin(w * j);
    }
    return -10 * Math.log10(re * re + im * im);
  };
  return near.map((hz) => {
    let best = Math.ceil(hz * 0.85);
    for (let f = best; f <= Math.floor(hz * 1.18); f++) if (env(f) > env(best)) best = f;
    const p = env(best - 1);
    const q = env(best);
    const s2 = env(best + 1);
    return best + (p - s2) / (2 * (p - 2 * q + s2));
  });
}

/** A line's notes, canonical, as the song keeps them. */
const line = (n: Partial<AudioNote>[]): AudioNotes =>
  parseAudioNotes({ mode: 'mono', v: 1, n: n.map((x) => ({ d: 0.3, p: 60, ...x })) }) as AudioNotes;

const clip = (notes: AudioNotes, more: Partial<AudioClip> = {}): AudioClip => ({
  file: 'aud_voice',
  offset: 0,
  gain: 0,
  fadeIn: 0,
  fadeOut: 0,
  stretch: 1,
  notes,
  ...more,
});

/** A recording with a region's patches rendered and played in place. */
function edited(base: Float32Array[], notes: AudioNotes): { out: Float32Array[]; patches: PatchJob[] } {
  const patches = regionPatches(clip(notes), SR);
  const rendered = patches.map((p) => ({ spec: p.spec, channels: renderNotePatch(base, SR, p.spec) }));
  return { out: assembleClip(base, rendered), patches };
}

/** The mean pitch (MIDI) the fine track hears from `from` to `to` (s; it listens from 200 ms before to 200 ms after). */
function pitchOf(x: Float32Array, from: number, to: number): number {
  const start = Math.max(0, Math.round((from - 0.2) * SR));
  const track = fineTrack(x.subarray(start, Math.round((to + 0.2) * SR)), SR);
  let sum = 0;
  let count = 0;
  for (let k = 0; k < track.t.length; k++) {
    const t = (track.t[k] as number) + start / SR;
    if (t < from || t > to || Number.isNaN(track.midi[k] as number)) continue;
    sum += track.midi[k] as number;
    count++;
  }
  return sum / count;
}

/** The RMS from `from` to `to` (s). */
function rmsOf(x: Float32Array, from: number, to: number): number {
  let sum = 0;
  const a = Math.round(from * SR);
  const b = Math.round(to * SR);
  for (let i = a; i < b; i++) sum += (x[i] as number) ** 2;
  return Math.sqrt(sum / (b - a));
}

/** The stretches where two recordings differ, [first, after the last] (closer than 40 ms: one). */
function differing(x: Float32Array, y: Float32Array): [number, number][] {
  const out: [number, number][] = [];
  for (let i = 0; i < x.length; i++) {
    if (x[i] === y[i]) continue;
    const last = out[out.length - 1];
    if (last && i - last[1] < 0.04 * SR) last[1] = i + 1;
    else out.push([i, i + 1]);
  }
  return out;
}

/** The largest step from one sample to the next within 5 ms of `at`. */
function maxStep(x: Float32Array, at: number): number {
  let m = 0;
  const w = Math.round(0.005 * SR);
  for (let i = Math.max(1, at - w); i < Math.min(x.length, at + w); i++)
    m = Math.max(m, Math.abs((x[i] as number) - (x[i - 1] as number)));
  return m;
}

const bytes = (c: Float32Array | undefined) =>
  Buffer.from(c?.buffer ?? new ArrayBuffer(0), c?.byteOffset, c?.byteLength);

// a held note on its own (with a vibrato), and three sung legato, the middle one edited
const ALONE: Sung = { t: 0.5, d: 1, midi: 57, vibrato: [5.5, 25] };
const LEGATO: Sung[] = [
  { t: 0.3, d: 0.6, midi: 57, vibrato: [5.5, 25] },
  { t: 0.9, d: 0.6, midi: 60, vibrato: [5.5, 25] },
  { t: 1.5, d: 0.6, midi: 59, vibrato: [5.5, 25] },
];
const alone = voice([ALONE], 2);
const legato = voice(LEGATO, 2.4);
const legatoNotes = (middle: Partial<AudioNote>) =>
  line([
    { t: 0.3, d: 0.6, p: 57 },
    { t: 0.9, d: 0.6, p: 60, ...middle },
    { t: 1.5, d: 0.6, p: 59 },
  ]);

describe('the shift and the level a line’s notes make', () => {
  const times = Float64Array.from({ length: 2000 }, (_, i) => i / 1000);
  const at = (curve: Float64Array, s: number) => curve[Math.round(s * 1000)] as number;

  it('moves a note by where it was moved to, with 10 ms edges, and nothing anywhere else', () => {
    const shift = targetShift(line([{ t: 0.5, d: 0.5, p: 60.2, to: 62 }]).n, times);
    expect(at(shift, 0.7)).toBeCloseTo(1.8, 12);
    expect(at(shift, 0.5)).toBeCloseTo(0.9, 12);
    expect(at(shift, 0.494)).toBe(0);
    expect(at(shift, 1.006)).toBe(0);
    expect([...shift.subarray(0, 494), ...shift.subarray(1006)].every((s) => s === 0)).toBe(true);
  });

  it('crosses from one note’s shift to the next where they touch, over the shorter of 120 ms and 40% of the shorter note', () => {
    const notes = line([
      { t: 0.4, d: 0.5, p: 60, to: 62 },
      { t: 0.9, d: 0.2, p: 64, to: 63 },
      { t: 1.1, d: 0.5, p: 62 },
    ]).n;
    const shift = targetShift(notes, times);
    // between the first two, 80 ms (40% of 0.2 s) centred at 0.9 s: halfway at the middle
    expect(at(shift, 0.86)).toBeCloseTo(2, 12);
    expect(at(shift, 0.9)).toBeCloseTo(0.5, 12);
    expect(at(shift, 0.94)).toBeCloseTo(-1, 12);
    // into the unedited third: back to nothing by 1.14 s
    expect(at(shift, 1.1)).toBeCloseTo(-0.5, 12);
    expect(at(shift, 1.14)).toBe(0);
    expect(at(shift, 1.3)).toBe(0);
  });

  it('moves nothing where the sound isn’t voiced', () => {
    const midi = Float64Array.from(times, (t) => (t > 0.6 && t < 0.7 ? Number.NaN : 60));
    const shift = targetShift(line([{ t: 0.5, d: 0.5, p: 60, to: 61 }]).n, times, { t: times, midi });
    expect(at(shift, 0.65)).toBe(0);
    expect(at(shift, 0.75)).toBe(1);
  });

  it('changes the level over 10 ms edges, from one note’s to the next where they touch, and is exactly 1 elsewhere', () => {
    const gain = noteGain(
      line([
        { t: 0.4, d: 0.5, g: 6 },
        { t: 0.9, d: 0.3, m: true },
        { t: 1.5, d: 0.3 },
      ]).n,
      times,
    );
    expect(at(gain, 0.6)).toBeCloseTo(10 ** (6 / 20), 12);
    expect(at(gain, 1)).toBe(0);
    expect(at(gain, 0.9)).toBeCloseTo(10 ** (6 / 20) / 2, 12);
    expect([...gain.subarray(0, 395), ...gain.subarray(1206)].every((g) => g === 1)).toBe(true);
  });
});

describe('a note’s drift, vibrato and formant, as drawn', () => {
  // the pitch as found every 5 ms: a note from 0.5 s for 1 s, found 10 cents sharp of its centre (60),
  // drifting down 30 cents through it, with a vibrato of ±40 cents at 5.5 Hz
  const t = Float64Array.from({ length: 400 }, (_, k) => k * 0.005);
  const drift = (x: number) => -0.3 * ((x - 0.5) / 1 - 0.5);
  const vib = (x: number) => 0.4 * Math.sin(2 * Math.PI * 5.5 * (x - 0.5));
  const midi = Float64Array.from(t, (x) => (x >= 0.5 && x < 1.5 ? 60.1 + drift(x) + vib(x) : Number.NaN));
  const track = { t, midi };
  const note = (edit: Partial<AudioNote>) => line([{ t: 0.5, d: 1, p: 60, ...edit }]).n;
  const held = (k: number) => (t[k] as number) >= 0.66 && (t[k] as number) <= 1.34;

  it('moves a note by exactly to − p with its drift and vibrato kept (dr and mo 1, or not set)', () => {
    for (const edit of [{ to: 62 }, { to: 62, dr: 1, mo: 1 }]) {
      const drawn = editedPitch(note(edit), track);
      for (let k = 0; k < t.length; k++) {
        const x = t[k] as number;
        if (x > 0.506 && x < 1.494) expect(drawn[k]).toBeCloseTo((midi[k] as number) + 2, 9);
        if (Number.isNaN(midi[k] as number)) expect(drawn[k]).toBeNaN();
      }
    }
  });

  it('sits it on where it was moved to with no drift and no vibrato, wherever its centre was found', () => {
    const drawn = editedPitch(note({ to: 62, dr: 0, mo: 0 }), track);
    for (let k = 0; k < t.length; k++) if (held(k)) expect(Math.abs((drawn[k] as number) - 62)).toBeLessThan(0.01);
  });

  it('keeps its drift by dr and its vibrato by mo', () => {
    const half = editedPitch(note({ dr: 0.5 }), track);
    const twice = editedPitch(note({ mo: 2 }), track);
    for (let k = 0; k < t.length; k++) {
      if (!held(k)) continue;
      const x = t[k] as number;
      // the drift found takes in its offset from the centre too (10 cents)
      expect(Math.abs((half[k] as number) - (60 + 0.5 * (0.1 + drift(x)) + vib(x)))).toBeLessThan(0.01);
      expect(Math.abs((twice[k] as number) - (60.1 + drift(x) + 2 * vib(x)))).toBeLessThan(0.01);
    }
  });

  it('moves its attack with it, the shape of it kept', () => {
    // a scoop into the note: 80 cents under, rising over its first 50 ms
    const scooped = Float64Array.from(midi, (m, k) => {
      const x = t[k] as number;
      return x < 0.55 ? m - 0.8 * (1 - (x - 0.5) / 0.05) : m;
    });
    const shift = targetShift(note({ to: 62, dr: 0, mo: 0 }), t, { t, midi: scooped });
    // the attack (after the note's 10 ms edge, before its held part) moves as one: the scoop is kept
    const attack = [...shift].filter((_, k) => (t[k] as number) > 0.506 && (t[k] as number) < 0.56);
    expect(attack.length).toBeGreaterThan(5);
    for (const v of attack) expect(v).toBeCloseTo(attack[0] as number, 9);
  });

  it('moves the formant by fo with the pitch’s weights, not over a consonant, and says where anything moves', () => {
    const times = Float64Array.from({ length: 2000 }, (_, i) => i / 1000);
    const at = (curve: Float64Array, s: number) => curve[Math.round(s * 1000)] as number;
    const fo = formantShift(line([{ t: 0.5, d: 0.5, u: 0.05, p: 60, fo: 3 }]).n, times);
    expect(at(fo, 0.52)).toBe(0);
    expect(at(fo, 0.55)).toBeCloseTo(1.5, 12);
    expect(at(fo, 0.8)).toBe(3);
    expect(pitchSpan(line([{ t: 0.5, d: 0.5, p: 60, g: 6 }]).n)).toBeNull();
    const span = pitchSpan(line([{ t: 0.5, d: 0.5, u: 0.05, p: 60, fo: -2 }]).n) as [number, number];
    expect(span[0]).toBeCloseTo(0.545, 9);
    expect(span[1]).toBeCloseTo(1.005, 9);
    // a glide made again reaches back into the note before
    const glide = pitchSpan(
      line([
        { t: 0.3, d: 0.6, p: 57 },
        { t: 0.9, d: 0.6, p: 59, tr: 2 },
      ]).n,
    ) as [number, number];
    expect(glide[0]).toBeCloseTo(0.72, 9);
  });
});

describe('a line’s note moved in pitch', () => {
  it('sounds where it was moved to: +100 cents to within 3', () => {
    const { out } = edited([alone], line([{ t: 0.5, d: 1, p: 57, to: 58 }]));
    const held: [number, number] = [ALONE.t + 0.06, ALONE.t + ALONE.d - 0.06];
    const moved = pitchOf(out[0] as Float32Array, ...held) - pitchOf(alone, ...held);
    expect(Math.abs(moved * 100 - 100)).toBeLessThan(3);
  });

  it('to within 3 cents up to 7 semitones either way, and 5 up to 12', () => {
    const plain = voice([{ t: 0.5, d: 1, midi: 57 }], 2);
    const before = pitchOf(plain, 0.56, 1.44);
    const errors: number[] = [];
    for (let semis = -12; semis <= 12; semis++) {
      if (semis === 0) continue;
      const { out } = edited([plain], line([{ t: 0.5, d: 1, p: 57, to: 57 + semis }]));
      const error = Math.abs((pitchOf(out[0] as Float32Array, 0.56, 1.44) - before - semis) * 100);
      errors.push(error);
      expect(error).toBeLessThan(Math.abs(semis) <= 7 ? 3 : 5);
    }
    expect(errors).toHaveLength(24);
  }, 30_000);

  it('in a stretched region: the note where the stretch has put it', () => {
    const stretch = 1.25;
    const [base] = stretchAudio([alone], stretch, SR) as [Float32Array];
    const notes = line([{ t: 0.5, d: 1, p: 57, to: 55 }]);
    const patches = regionPatches(clip(notes, { stretch }), SR);
    const out = assembleClip(
      [base],
      patches.map((p) => ({ spec: p.spec, channels: renderNotePatch([base], SR, p.spec) })),
    )[0] as Float32Array;
    const held: [number, number] = [0.56 * stretch, 1.44 * stretch];
    expect(Math.abs((pitchOf(out, ...held) - pitchOf(base, ...held) + 2) * 100)).toBeLessThan(3);
    const [first, last] = differing(base, out)[0] as [number, number];
    expect(first).toBeGreaterThan(0.48 * stretch * SR);
    expect(last).toBeLessThan(1.56 * stretch * SR);
  });

  it('copies the recording to the bit outside what it changes, its patch’s first and last frames too', () => {
    for (const [base, notes, from, to] of [
      [alone, line([{ t: 0.5, d: 1, p: 57, to: 59 }]), 0.49, 1.56],
      [alone, line([{ t: 0.5, d: 1, p: 57, mo: 0, dr: 0.5 }]), 0.49, 1.56],
      [alone, line([{ t: 0.5, d: 1, p: 57, fo: 3 }]), 0.49, 1.56],
      [legato, legatoNotes({ to: 62 }), 0.83, 1.62],
      [legato, legatoNotes({ to: 57 }), 0.83, 1.62],
      [legato, legatoNotes({ tr: 2, mo: 1.5, fo: -2 }), 0.71, 1.71],
    ] as const) {
      const { out, patches } = edited([base], notes);
      const o = out[0] as Float32Array;
      const [patch] = patches;
      if (!patch) throw new Error('no patch');
      const { a, b } = patch.spec;
      const rendered = renderNotePatch([base], SR, patch.spec)[0] as Float32Array;
      expect(rendered.length).toBe(b - a);
      expect(rendered[0]).toBe(base[a]);
      expect(rendered[rendered.length - 1]).toBe(base[b - 1]);
      const changed = differing(base, o);
      expect(changed).toHaveLength(1);
      const [first, last] = changed[0] as [number, number];
      expect(first).toBeGreaterThan(from * SR);
      expect(last).toBeLessThan(to * SR);
      expect(first).toBeGreaterThan(a);
      expect(last).toBeLessThan(b);
    }
  });

  it('doesn’t click where it leaves the recording or locks back onto it', () => {
    for (const [base, notes] of [
      [alone, line([{ t: 0.5, d: 1, p: 57, to: 59 }])],
      [alone, line([{ t: 0.5, d: 1, p: 57, to: 52 }])],
      [legato, legatoNotes({ to: 62 })],
      [legato, legatoNotes({ to: 57 })],
      [legato, legatoNotes({ to: 65 })],
      [alone, line([{ t: 0.5, d: 1, p: 57, mo: 0, fo: 4 }])],
      [legato, legatoNotes({ to: 61, tr: 0.25, dr: 0, fo: -3 })],
    ] as const) {
      const { out, patches } = edited([base], notes);
      const o = out[0] as Float32Array;
      const edges = [...differing(base, o).flat(), ...patches.flatMap((p) => [p.spec.a, p.spec.b])];
      for (const e of edges) expect(maxStep(o, e)).toBeLessThanOrEqual(1.5 * maxStep(base, e));
    }
  });

  it('keeps a stereo image: every channel moved by the same marks', () => {
    const left = legato;
    const right = Float32Array.from(legato, (v) => v * 0.5);
    const { out } = edited([left, right], legatoNotes({ to: 62, mo: 0.5, fo: 2, tr: 1.5 }));
    const [l, r] = out as [Float32Array, Float32Array];
    let worst = 0;
    for (let i = 0; i < l.length; i++) worst = Math.max(worst, Math.abs((r[i] as number) - 0.5 * (l[i] as number)));
    expect(worst).toBeLessThan(1e-6);
    expect(differing(legato, l).length).toBe(1);
  });

  it('renders the same twice, to the byte', () => {
    const right = Float32Array.from(legato, (v, i) => v * 0.7 + 0.01 * Math.sin(i / 10));
    const [job] = regionPatches(clip(legatoNotes({ to: 63.5, g: -3, dr: 0.3, mo: 1.7, tr: 0.5, fo: 1.5 })), SR);
    if (!job) throw new Error('no patch');
    const one = renderNotePatch([legato, right], SR, job.spec);
    const two = renderNotePatch([legato, right], SR, job.spec);
    expect(bytes(one[0]).equals(bytes(two[0]))).toBe(true);
    expect(bytes(one[1]).equals(bytes(two[1]))).toBe(true);
    expect(bytes(one[0]).equals(bytes(legato.subarray(job.spec.a, job.spec.b)))).toBe(false);
  });

  it('leaves the notes of chords and hits as they were (not rendered yet)', () => {
    for (const mode of ['poly', 'perc'] as const) {
      const notes = parseAudioNotes({ mode, v: 1, n: [{ t: 0.9, d: 0.6, p: 60, to: 62, g: 6 }] }) as AudioNotes;
      const [job] = regionPatches(clip(notes), SR);
      if (!job) throw new Error('no patch');
      const [c] = renderNotePatch([legato], SR, job.spec);
      expect(bytes(c).equals(bytes(legato.subarray(job.spec.a, job.spec.b)))).toBe(true);
    }
  });
});

describe('a line’s note’s drift, vibrato and glide, rendered', () => {
  const held: [number, number] = [0.45, 2.15];

  it('keeps as much of its vibrato as asked: none, twice as deep, or as it was when only moved', () => {
    const sung = voice([{ t: 0.3, d: 2, midi: 57, vibrato: [5.5, 40] }], 2.6);
    const before = heldOf(sung, ...held).depth;
    const depth = (edit: Partial<AudioNote>) =>
      heldOf(edited([sung], line([{ t: 0.3, d: 2, p: 57, ...edit }])).out[0] as Float32Array, ...held).depth;
    expect(Math.abs(before - 40)).toBeLessThan(2);
    expect(depth({ mo: 0 })).toBeLessThan(8);
    expect(Math.abs(depth({ mo: 2 }) / before - 2)).toBeLessThan(0.2);
    expect(Math.abs(depth({ to: 59 }) / before - 1)).toBeLessThan(0.05);
  }, 30_000);

  it('keeps as much of its drift as asked, and with none sits on where it was moved to', () => {
    const sung = voice([{ t: 0.3, d: 2, midi: 57, drift: -30 }], 2.6);
    const before = heldOf(sung, ...held).drift;
    expect(Math.abs(before + 25.5)).toBeLessThan(1.5);
    // (its centre found 10 cents off what it sang: the drift takes that in too)
    for (const p of [57, 57.1]) {
      const flat = heldOf(edited([sung], line([{ t: 0.3, d: 2, p, to: 58, dr: 0 }])).out[0] as Float32Array, ...held);
      expect(Math.abs(flat.drift)).toBeLessThan(5);
      expect(Math.abs(flat.mean - 58) * 100).toBeLessThan(3);
    }
    const half = heldOf(edited([sung], line([{ t: 0.3, d: 2, p: 57, dr: 0.5 }])).out[0] as Float32Array, ...held);
    expect(Math.abs(half.drift / before - 0.5)).toBeLessThan(0.1);
  }, 30_000);

  it('makes the glide into a note tr times as long as it was sung: a quarter, or three times', () => {
    // two notes a whole tone apart, sung legato with a 100 ms glide
    const sing = (glide: number) =>
      voice(
        [
          { t: 0.3, d: 0.8, midi: 64, glide },
          { t: 1.1, d: 0.8, midi: 66 },
        ],
        2.2,
      );
    const sung = sing(0.1);
    const asSung = glideOf(sung, 64, 66, 1.1);
    const remade = (tr: number) =>
      glideOf(
        edited(
          [sung],
          line([
            { t: 0.3, d: 0.8, p: 64 },
            { t: 1.1, d: 0.8, p: 66, tr },
          ]),
        ).out[0] as Float32Array,
        64,
        66,
        1.1,
      );
    const quicker = remade(0.25);
    const slower = remade(3);
    // a period at a time hears a glide under 15 ms or so as longer than it is: the glide sung that long, measured alike
    expect(quicker / asSung).toBeGreaterThan(0.2);
    expect(quicker / asSung).toBeLessThan(0.33);
    expect(Math.abs(quicker / glideOf(sing(0.025), 64, 66, 1.1) - 1)).toBeLessThan(0.1);
    expect(Math.abs(slower / asSung - 3)).toBeLessThan(0.3);
    expect(Math.abs(slower / glideOf(sing(0.3), 64, 66, 1.1) - 1)).toBeLessThan(0.1);
  }, 30_000);
});

describe('a line’s note’s formant', () => {
  it('moves the envelope’s peaks by 2^(fo/12) to within 4%, the pitch where it was to within 3 cents', () => {
    const peaks: [number, number][] = [
      [700, 130],
      [1220, 150],
      [2600, 200],
    ];
    const sung = lowVoice(45, 0.3, 1.4, 2.2, peaks);
    const before = formantsOf(sung, 0.45, 1.6, [700, 1220, 2600]);
    for (const fo of [3, -3]) {
      const scale = 2 ** (fo / 12);
      const out = edited([sung], line([{ t: 0.3, d: 1.4, p: 45, fo }])).out[0] as Float32Array;
      const after = formantsOf(
        out,
        0.45,
        1.6,
        before.map((hz) => hz * scale),
      );
      for (let i = 0; i < 3; i++)
        expect(Math.abs((after[i] as number) / (before[i] as number) / scale - 1)).toBeLessThan(0.04);
      expect(Math.abs(pitchOf(out, 0.5, 1.5) - pitchOf(sung, 0.5, 1.5)) * 100).toBeLessThan(3);
    }
  }, 30_000);
});

describe('a line’s note moved, its level and its edges', () => {
  it('keeps its level as it moves: ±3 and ±7 semitones to within 0.3 dB, held part', () => {
    const plain = voice([{ t: 0.5, d: 1, midi: 57 }], 2);
    for (const semis of [-7, -3, 3, 7]) {
      const out = edited([plain], line([{ t: 0.5, d: 1, p: 57, to: 57 + semis }])).out[0] as Float32Array;
      expect(Math.abs(20 * Math.log10(rmsOf(out, 0.56, 1.44) / rmsOf(plain, 0.56, 1.44)))).toBeLessThan(0.3);
    }
  });

  it('locks back onto the recording gently where the voice goes on: no period off its neighbours by 1%', () => {
    // one long note sung, found as two that don't touch: the first moved up
    const sung = voice([{ t: 0.3, d: 2, midi: 57 }], 2.6);
    const out = edited(
      [sung],
      line([
        { t: 0.3, d: 0.8, p: 57, to: 59 },
        { t: 1.15, d: 1.15, p: 57 },
      ]),
    ).out[0] as Float32Array;
    const [, end] = differing(sung, out).at(-1) as [number, number];
    expect(end / SR).toBeGreaterThan(1.15);
    const { len } = periodsOf(out, 220, 1.11, end / SR + 0.03);
    const steady = SR / (440 * 2 ** ((57 - 69) / 12));
    for (let k = 1; k < len.length; k++)
      expect(Math.abs((len[k] as number) / (len[k - 1] as number) - 1)).toBeLessThan(0.01);
    for (const l of len) expect(Math.abs(l / steady - 1)).toBeLessThan(0.0125);
  });

  it('leaves unvoiced sound where it was: a consonant in a moved note, its lead, a breath between moved notes', () => {
    /** Noise (first differences of white noise, from a fixed seed) from..to (s), added in. */
    const noise = (x: Float32Array, from: number, to: number, level: number, seed: number) => {
      let s = seed;
      let prev = 0;
      for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) {
        s ^= s << 13;
        s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5;
        s >>>= 0;
        const w = s / 4294967296 - 0.5;
        const t = i / SR;
        x[i] = (x[i] as number) + level * Math.min(1, (t - from) / 0.01, (to - t) / 0.01) * (w - prev);
        prev = w;
      }
    };
    const same = (x: Float32Array, y: Float32Array, from: number, to: number) => {
      for (let i = Math.round(from * SR); i < Math.round(to * SR); i++) if (x[i] !== y[i]) return false;
      return true;
    };
    // a consonant: the voice stops for 40 ms in the middle of a note moved up
    const word = voice(
      [
        { t: 0.3, d: 0.45, midi: 57 },
        { t: 0.79, d: 0.5, midi: 57 },
      ],
      1.6,
    );
    noise(word, 0.75, 0.79, 0.08, 7);
    const moved = edited([word], line([{ t: 0.3, d: 1, p: 57, to: 59 }])).out[0] as Float32Array;
    expect(same(word, moved, 0.75, 0.79)).toBe(true);
    expect(Math.abs(pitchOf(moved, 0.85, 1.2) - 59) * 100).toBeLessThan(3);
    // its lead: the consonant it starts with
    const sung = voice([{ t: 0.38, d: 0.6, midi: 57 }], 1.4);
    noise(sung, 0.3, 0.385, 0.08, 3);
    expect(
      same(sung, edited([sung], line([{ t: 0.3, d: 0.68, u: 0.08, p: 57, to: 60 }])).out[0] as Float32Array, 0.3, 0.38),
    ).toBe(true);
    // a breath between two moved notes, from 5 ms after the voice stops
    const phrase = voice(
      [
        { t: 0.3, d: 0.5, midi: 57 },
        { t: 1, d: 0.5, midi: 59 },
      ],
      1.8,
    );
    noise(phrase, 0.82, 0.98, 0.05, 1);
    const notes = line([
      { t: 0.3, d: 0.5, p: 57, to: 59 },
      { t: 0.8, d: 0.2, p: null },
      { t: 1, d: 0.5, p: 59, to: 57 },
    ]);
    expect(same(phrase, edited([phrase], notes).out[0] as Float32Array, 0.805, 1)).toBe(true);
  });
});

describe('a line’s note’s level', () => {
  it('changes by its gain: +6 dB to within 0.2, held part', () => {
    const { out } = edited([alone], line([{ t: 0.5, d: 1, p: 57, g: 6 }]));
    const db = 20 * Math.log10(rmsOf(out[0] as Float32Array, 0.56, 1.44) / rmsOf(alone, 0.56, 1.44));
    expect(Math.abs(db - 6)).toBeLessThan(0.2);
    // and not a sample changed 5 ms past its edges
    const [first, last] = differing(alone, out[0] as Float32Array)[0] as [number, number];
    expect(first).toBeGreaterThanOrEqual(Math.floor(0.495 * SR));
    expect(last).toBeLessThanOrEqual(Math.ceil(1.505 * SR));
  });

  it('is gone muted: 80 dB down at least', () => {
    const { out } = edited([legato], legatoNotes({ m: true }));
    const left = rmsOf(out[0] as Float32Array, 0.96, 1.44);
    expect(left === 0 || 20 * Math.log10(left / rmsOf(legato, 0.96, 1.44)) < -80).toBe(true);
  });

  it('moves with the pitch, both at once', () => {
    const { out } = edited([alone], line([{ t: 0.5, d: 1, p: 57, to: 60, g: -6 }]));
    const o = out[0] as Float32Array;
    expect(Math.abs((pitchOf(o, 0.56, 1.44) - pitchOf(alone, 0.56, 1.44) - 3) * 100)).toBeLessThan(3);
    // the level against the pitch moved alone
    const moved = edited([alone], line([{ t: 0.5, d: 1, p: 57, to: 60 }])).out[0] as Float32Array;
    const db = 20 * Math.log10(rmsOf(o, 0.56, 1.44) / rmsOf(moved, 0.56, 1.44));
    expect(Math.abs(db + 6)).toBeLessThan(0.2);
  });
});

describe('a song with a line’s notes edited, rendered', () => {
  const take = voice(LEGATO, 2.4);
  const source = {
    instrument: () => Promise.reject(new Error('no packs here')),
    sample: () => Promise.reject(new Error('no packs here')),
    audio: async () => encodeWav([take], SR),
    impulse: () => Promise.reject(new Error('no packs here')),
  };
  const song = (notes?: AudioNotes): Project => {
    const p = newProject('Edited');
    p.tempo = [{ tick: 0, bpm: 120 }];
    const audio = { ...clip(legatoNotes({}), { offset: 0.1, gain: -2 }) };
    if (notes) audio.notes = notes;
    else delete audio.notes;
    p.tracks = [{ ...newAudioTrack('Vocal'), id: 'trk_v', regions: [{ ...newRegion(PPQ, PPQ * 6), audio }] }];
    return p;
  };

  it('plays the recording to the bit outside its patches and the edits within them, the same every time', async () => {
    const notes = line([
      { t: 0.3, d: 0.6, p: 57, g: -6 },
      { t: 0.9, d: 0.6, p: 60 },
      { t: 1.5, d: 0.6, p: 59, to: 61 },
    ]);
    const plain = await renderSession(song(), source, { sampleRate: SR, tail: 0.5, finish: false });
    const withEdits = await renderSession(song(notes), source, { sampleRate: SR, tail: 0.5, finish: false });
    expect(withEdits.errors).toEqual([]);
    const pieces = compileClips(song(notes).tracks[0] as Project['tracks'][number], compileTempo(song(notes), SR), SR);
    const patched = pieces.filter((c) => c.key.includes('#'));
    expect(patched).toHaveLength(2);
    const inPatch = (i: number) => patched.some((c) => i >= c.start && i < c.end);
    for (const ch of [0, 1]) {
      const x = plain.channels[ch] as Float32Array;
      const y = withEdits.channels[ch] as Float32Array;
      let outside = 0;
      for (let i = 0; i < x.length; i++) if (!inPatch(i) && x[i] !== y[i]) outside++;
      expect(outside).toBe(0);
      for (const c of patched) expect(differing(x.subarray(c.start, c.end), y.subarray(c.start, c.end)).length).toBe(1);
    }
    // and the same again
    const again = await renderSession(song(notes), source, { sampleRate: SR, tail: 0.5, finish: false });
    expect(bytes(again.channels[0]).equals(bytes(withEdits.channels[0]))).toBe(true);
    expect(bytes(again.channels[1]).equals(bytes(withEdits.channels[1]))).toBe(true);
  });
});
