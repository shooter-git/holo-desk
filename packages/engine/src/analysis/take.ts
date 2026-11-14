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
 * - Out of the note before, it starts where the pitch moves. From silence, it starts where its voice
 *   does, as a singer counts it: going back from its loudest in its first 80 ms, the note goes on as
 *   long as its level (over one period) stays within 20 dB of that and the sound is still voiced (it
 *   repeats itself at a period within three semitones of the note's). So a soft or swelled attack, and
 *   a scoop up into the pitch, count from their beginning, not from where they reach full voice; a
 *   breath or an unvoiced consonant before it (an s, a t, an h) doesn't count: singers put those
 *   before the beat and the vowel on it.
 *
 * The take's regions are placed on the timeline as the engine plays them (compile.ts compileClips):
 * each region's offset and stretch, the tempo map, and where takes overlap, the later one heard.
 * Pitches are measured against the song's key at each note (its nearest scale tone), against what a
 * reference track plays there, or against the nearest semitone.
 */
import { type KeyPoint, keyAt, keysOf, keyText, meterAt, type Project, type Track, ticksPerBar } from '@holo/session';
import { compileTempo, frameToTick, tickToFrame } from '../compile.ts';
import type { TempoSegment } from '../protocol.ts';
import { FINE_S, heldPart, heldPitch, median, monoOf, trackOf, voiceStart } from './line.ts';

export { monoOf };

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

/** Shorter than this, a note is part of the next (a slide into it) or the last (a fall off it), or nothing. */
const SLIDE_S = 0.1;
const MIN_NOTE_S = 0.06;
/** A pitch this far from the note's (semitones) for this long is the next note. */
const STEP = 0.7;
const STEP_S = 0.03;
/** A gap in the pitch this long ends a note. */
const GAP_S = 0.02;

/**
 * A line's pitch every 5 ms (`FINE_STEP_S`), as note-finding hears it: at each step's time `t` (seconds
 * from the start of the samples), the pitch as MIDI with cents (NaN where it isn't voiced), and the
 * sound's power there (the mean square over 10 ms around it). It starts 30 ms before the first voiced
 * sound (empty when nothing is voiced) and runs to the end of the samples.
 */
export interface FineTrack {
  t: Float64Array;
  midi: Float64Array;
  power: Float64Array;
}

/** How far apart a fine track's steps are, seconds. */
export const FINE_STEP_S = FINE_S;

/** The pitch of one line (mono samples) every 5 ms, as `lineNotes` finds its notes by. */
export function fineTrack(samples: Float32Array, sampleRate: number): FineTrack {
  const tr = trackOf(samples, sampleRate);
  if (!tr) return { t: new Float64Array(0), midi: new Float64Array(0), power: new Float64Array(0) };
  return {
    t: Float64Array.from(tr.fineT),
    midi: Float64Array.from(tr.fineP),
    power: Float64Array.from(tr.fineT, (t) => tr.envAt(t)),
  };
}

/**
 * The notes of one line (mono samples): their times, pitches, drift, vibrato and loudness. A level
 * 38 dB under the loudest is the room, not the line.
 */
export function lineNotes(samples: Float32Array, sampleRate: number): LineNote[] {
  const sr = sampleRate;
  const tracked = trackOf(samples, sr);
  if (!tracked) return [];
  const { fineT, fineP, envAt } = tracked;
  const end = samples.length / sr;
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
      // from silence: where its voice starts (the header says how), back from its loudest in its first 80 ms
      const floorT = Math.max(prev ? time(prev.b) : 0, start - 0.15);
      const heard: number[] = [];
      for (let k = s.a; k < s.b; k++) if (!Number.isNaN(smooth[k] as number)) heard.push(smooth[k] as number);
      const period = heard.length ? 1 / (440 * 2 ** ((median(heard) - 69) / 12)) : 0.005;
      start = voiceStart(tracked, start, stop, floorT, period);
    }
    const { ht, hp } = heldPart(fineT, fineP, s.a, s.b, start, stop);
    if (!hp.length) continue;
    const { pitch, drift, vibrato } = heldPitch(ht, hp);
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
      drift,
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
 * A stretch of a line laid on the timeline: its samples, the timeline's seconds (through the tempo
 * map) where the first of them plays, how much it's stretched, its gain (dB), and the region each
 * note in it belongs to (null: none, and it's left out).
 */
interface Laid {
  samples: Float32Array;
  rate: number;
  at: number;
  stretch: number;
  gain: number;
  region: (at: number) => string | null;
}

/** Notes of stretches laid on the timeline, each measured against what it should be, as a take's report. */
function takeReport(
  project: Project,
  laid: readonly Laid[],
  regions: string[],
  seconds: number,
  opts: TakeOptions,
): TakeReport {
  const grid = Math.max(1, Math.round(opts.grid ?? 240));
  const seg: TempoSegment[] = compileTempo(project, 1);
  const keys = keysOf(project);
  const against = opts.against ?? 'key';
  const notes: TakeNote[] = [];
  const power: number[] = [];
  const frames: number[] = [];
  for (const piece of laid) {
    for (const n of lineNotes(piece.samples, piece.rate)) {
      const at = piece.at + n.start * piece.stretch;
      const region = piece.region(at);
      if (region === null) continue;
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
      note.region = region;
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
    regions,
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
 * A take on an audio track, measured note by note on the timeline: each piece the track plays (its
 * regions, `from`–`to`), from the file `decode` gives for it.
 */
export function measureTake(
  project: Project,
  track: Track,
  decode: (file: string) => Decoded | null,
  opts: TakeOptions = {},
): TakeReport {
  const pieces = takePieces(project, track, opts);
  const laid: Laid[] = [];
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
    laid.push({
      samples: file.mono.subarray(i0, i1),
      rate: file.rate,
      at: piece.at + (i0 / file.rate - piece.fileStart) * piece.stretch,
      stretch: piece.stretch,
      gain: piece.gain,
      region: () => piece.region,
    });
  }
  return takeReport(project, laid, [...new Set(pieces.map((p) => p.region))], seconds, opts);
}

/**
 * A take as it comes out of its track's plugins: the track rendered alone through them (`samples`,
 * mono, from `at` seconds on the timeline, the plugins' delay made up for), measured as `measureTake`
 * measures its recordings. A note counts where the track plays a region (`region`'s alone, if given,
 * `from`–`to`): a plugin's echo past a region's end isn't a note of the take. Levels are as the
 * plugins leave them (the regions' gain is in the render).
 */
export function measureRendered(
  project: Project,
  track: Track,
  samples: Float32Array,
  rate: number,
  at: number,
  opts: TakeOptions = {},
): TakeReport {
  const pieces = takePieces(project, track, opts);
  const spans = pieces.map((p) => ({ region: p.region, a: p.at, b: p.at + (p.fileEnd - p.fileStart) * p.stretch }));
  // a note a little before its region (a pre-delay's smear, rounding) is still its region's
  const regionAt = (t: number) => spans.find((s) => t >= s.a - 0.02 && t < s.b)?.region ?? null;
  const seconds = spans.reduce(
    (sum, s) => sum + Math.max(0, Math.min(s.b, at + samples.length / rate) - Math.max(s.a, at)),
    0,
  );
  return takeReport(
    project,
    [{ samples, rate, at, stretch: 1, gain: 0, region: regionAt }],
    [...new Set(pieces.map((p) => p.region))],
    seconds,
    opts,
  );
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
