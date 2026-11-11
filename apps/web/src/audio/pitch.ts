/**
 * Listening to a recording: how long and how loud it is, a guess at its tempo, and, when it's one
 * line (a voice, a flute, a hummed tune), its notes. The pitch comes from YIN (de Cheveigné and
 * Kawahara, 2002): the period is where the signal best matches itself shifted. Plain functions over
 * samples, run in a worker (pitch.worker.ts) so a long recording never holds up the studio.
 */

/** Pitch is tracked at about this rate: plenty for a sung or played line up to C7, and quick. */
export const TRACK_RATE = 11025;
/** The lowest and highest pitches looked for (Hz): a low bass voice to a piccolo's top. */
const MIN_HZ = 50;
const MAX_HZ = 2100;
/** How sure YIN must be (its threshold on the normalized difference): lower is stricter. */
const THRESHOLD = 0.15;

/** A MIDI note number for a frequency (fractional: 69.5 is a quarter tone above A4). */
export function midiOf(hz: number): number {
  return 69 + 12 * Math.log2(hz / 440);
}

/**
 * The pitch of one frame by YIN: its frequency and how clear it is (1 a pure tone, near 0 noise), or
 * null when there's none. The frame must hold at least two periods of the lowest pitch looked for.
 */
export function yin(
  frame: Float32Array,
  sampleRate: number,
  threshold = THRESHOLD,
): { hz: number; clarity: number } | null {
  const half = Math.floor(frame.length / 2);
  const minTau = Math.max(2, Math.floor(sampleRate / MAX_HZ));
  const maxTau = Math.min(half - 1, Math.ceil(sampleRate / MIN_HZ));
  if (maxTau <= minTau) return null;
  // the difference function, then its cumulative mean normalized form
  const d = new Float32Array(maxTau + 1);
  for (let tau = 1; tau <= maxTau; tau++) {
    let sum = 0;
    for (let j = 0; j < half; j++) {
      const diff = (frame[j] as number) - (frame[j + tau] as number);
      sum += diff * diff;
    }
    d[tau] = sum;
  }
  const cmnd = new Float32Array(maxTau + 1);
  cmnd[0] = 1;
  let running = 0;
  for (let tau = 1; tau <= maxTau; tau++) {
    running += d[tau] as number;
    cmnd[tau] = running > 0 ? ((d[tau] as number) * tau) / running : 1;
  }
  // the first dip under the threshold, followed to its bottom; else the deepest dip, if it's clear enough
  let tau = -1;
  for (let t = minTau; t <= maxTau; t++) {
    if ((cmnd[t] as number) < threshold) {
      while (t + 1 <= maxTau && (cmnd[t + 1] as number) < (cmnd[t] as number)) t++;
      tau = t;
      break;
    }
  }
  if (tau < 0) return null;
  // between samples: a parabola through the dip and its neighbours
  const a = cmnd[tau - 1] as number;
  const b = cmnd[tau] as number;
  const c = tau + 1 <= maxTau ? (cmnd[tau + 1] as number) : b;
  const shift = a + c - 2 * b !== 0 ? (a - c) / (2 * (a + c - 2 * b)) : 0;
  const period = tau + Math.max(-1, Math.min(1, shift));
  return { hz: sampleRate / period, clarity: Math.max(0, Math.min(1, 1 - b)) };
}

/** The samples brought down to about TRACK_RATE (each new sample the average of those it stands for). */
export function downsample(samples: Float32Array, sampleRate: number): { samples: Float32Array; sampleRate: number } {
  const k = Math.max(1, Math.round(sampleRate / TRACK_RATE));
  if (k === 1) return { samples, sampleRate };
  const out = new Float32Array(Math.floor(samples.length / k));
  for (let i = 0; i < out.length; i++) {
    let sum = 0;
    for (let j = 0; j < k; j++) sum += samples[i * k + j] as number;
    out[i] = sum / k;
  }
  return { samples: out, sampleRate: sampleRate / k };
}

/** A note heard in a recording: when (s), how long (s), its pitch (MIDI) and a velocity from its loudness. */
export interface HeardNote {
  t: number;
  d: number;
  p: number;
  v: number;
}

/** The frame and hop the tracker reads with (at TRACK_RATE: 93 ms frames, every 23 ms). */
const FRAME = 1024;
const HOP = 256;
/** Shorter than this, a run of frames isn't a note (a slide, a consonant). */
const MIN_NOTE_S = 0.07;

/**
 * The pitch track of a recording: per hop, the MIDI pitch heard (null: none, or too quiet), its
 * clarity and its loudness (RMS).
 */
export function pitchTrack(
  samples: Float32Array,
  sampleRate: number,
): { hop: number; frames: { p: number | null; clarity: number; rms: number }[] } {
  const low = downsample(samples, sampleRate);
  const x = low.samples;
  const frames: { p: number | null; clarity: number; rms: number }[] = [];
  let loudest = 0;
  for (let at = 0; at + FRAME <= x.length; at += HOP) {
    const frame = x.subarray(at, at + FRAME);
    let sum = 0;
    for (const v of frame) sum += v * v;
    const rms = Math.sqrt(sum / FRAME);
    loudest = Math.max(loudest, rms);
    const found = yin(frame, low.sampleRate);
    frames.push({ p: found ? midiOf(found.hz) : null, clarity: found?.clarity ?? 0, rms });
  }
  // what's far quieter than the loudest is the room, not the line
  const floor = Math.max(0.005, loudest * 0.08);
  for (const f of frames) if (f.rms < floor) f.p = null;
  return { hop: HOP / low.sampleRate, frames };
}

/**
 * The notes of a line: runs of frames on one pitch (to the nearest semitone, a frame's wobble
 * allowed), each long enough to be a note, with a velocity from how loud it was.
 */
export function notesOf(track: ReturnType<typeof pitchTrack>): HeardNote[] {
  const { hop, frames } = track;
  const notes: HeardNote[] = [];
  let start = -1;
  // the note's pitch as it began, and how loud it got
  let ref = 0;
  let loud = 0;
  const end = (i: number) => {
    if (start >= 0 && (i - start) * hop >= MIN_NOTE_S) {
      const v = Math.max(1, Math.min(127, Math.round(Math.sqrt(loud) * 160)));
      notes.push({ t: start * hop, d: (i - start) * hop, p: ref, v });
    }
    start = -1;
  };
  for (let i = 0; i < frames.length; i++) {
    const f = frames[i] as (typeof frames)[number];
    if (f.p === null) {
      end(i);
      continue;
    }
    // a vibrato stays the note; a step of a semitone or more is the next
    if (start >= 0 && Math.abs(f.p - ref) > 0.6) end(i);
    if (start < 0) {
      start = i;
      ref = Math.round(f.p);
      loud = 0;
    }
    loud = Math.max(loud, f.rms);
  }
  end(frames.length);
  return notes;
}

/**
 * A tempo for a recording, from how its loudness rises (its onsets) repeat: the strongest period
 * between 60 and 180 beats a minute, or null when nothing repeats clearly enough.
 */
export function tempoOf(track: ReturnType<typeof pitchTrack>): number | null {
  const { hop, frames } = track;
  if (frames.length < 64) return null;
  const onset = frames.map((f, i) => Math.max(0, f.rms - (frames[i - 1]?.rms ?? f.rms)));
  const mean = onset.reduce((a, b) => a + b, 0) / onset.length;
  const o = onset.map((v) => v - mean);
  const energy = o.reduce((a, v) => a + v * v, 0);
  if (energy <= 0) return null;
  // each lag's match, per pair of frames compared (a long lag has fewer)
  const minLag = Math.round(60 / 180 / hop);
  const maxLag = Math.min(o.length - 1, Math.round(60 / 60 / hop));
  const score = (lag: number) => {
    let sum = 0;
    for (let i = lag; i < o.length; i++) sum += (o[i] as number) * (o[i - lag] as number);
    return (sum / (o.length - lag)) * o.length;
  };
  let best = 0;
  let bestLag = 0;
  for (let lag = minLag; lag <= maxLag; lag++) {
    const sc = score(lag);
    if (sc > best) {
      best = sc;
      bestLag = lag;
    }
  }
  // a beat repeats every two beats as well: the shorter, when it matches nearly as well, is the beat
  const half = Math.round(bestLag / 2);
  if (half >= minLag) {
    let near = 0;
    for (let lag = half - 1; lag <= half + 1; lag++) near = Math.max(near, score(lag));
    if (near >= 0.7 * best) {
      for (let lag = half - 1; lag <= half + 1; lag++)
        if (score(lag) === near) {
          bestLag = lag;
          best = near;
        }
    }
  }
  if (!bestLag || best / energy < 0.2) return null;
  return Math.round((60 / (bestLag * hop)) * 10) / 10;
}

/** What's measured of a recording, as the agent reads it (the attachment's meta). */
export interface AudioMeasure {
  seconds: number;
  peak: number;
  bpm: number | null;
  /** One line (most of its sounding frames have one clear pitch): its notes are worth reading. */
  monophonic: boolean;
  /** [start s, length s, MIDI pitch, velocity] each, when it's one line. */
  notes?: [number, number, number, number][];
}

/** Measure a recording (mono samples). */
export function measure(samples: Float32Array, sampleRate: number): AudioMeasure {
  let peak = 0;
  for (const v of samples) peak = Math.max(peak, Math.abs(v));
  const track = pitchTrack(samples, sampleRate);
  const sounding = track.frames.filter((f) => f.rms > 0);
  const clear = sounding.filter((f) => f.p !== null && f.clarity > 0.7).length;
  const voiced = track.frames.filter((f) => f.p !== null).length;
  const monophonic = voiced > 0 && clear / Math.max(1, voiced) > 0.6;
  const out: AudioMeasure = {
    seconds: Math.round((samples.length / sampleRate) * 100) / 100,
    peak: Math.round(peak * 1000) / 1000,
    bpm: tempoOf(track),
    monophonic,
  };
  if (monophonic) {
    const r = (v: number) => Math.round(v * 1000) / 1000;
    out.notes = notesOf(track)
      .slice(0, 2000)
      .map((n) => [r(n.t), r(n.d), n.p, n.v]);
  }
  return out;
}
