/**
 * The arithmetic of the Audio Editor's Notes view (AudioNotes.tsx): where a time in a recording plays
 * on the song's timeline, where a pitch sits on the semitone lanes as they're scrolled and zoomed, and
 * how a note is outlined: a capsule as thick as it's loud.
 */
import {
  type AudioClip,
  type AudioNote,
  type NotesPlacing,
  tickToFile as placedFile,
  fileToTicks as placedTicks,
  type TempoPoint,
} from '@holo/session';

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

// ---- time: seconds of the file and ticks of the song ----

/** Where a region places its recording: the second of the file it starts at, how it's stretched, and its notes' moves. */
type Placing = Pick<AudioClip, 'offset' | 'stretch'> & Partial<Pick<AudioClip, 'notes'>>;

const placing = (regionStart: number, clip: Placing): NotesPlacing => ({ start: regionStart, audio: clip });

/**
 * Where times in a region's recording play on the song's timeline: seconds of the file as recorded
 * to ticks, by the session's own reckoning (audio-notes.ts: a note moved in time is drawn where it now
 * plays). The region's start is worked out once, for drawing many points. `played`: the seconds are
 * as the region plays them already (a note's `ts` and `te`), past its notes' moves.
 */
export function fileToTicks(
  tempo: readonly TempoPoint[],
  regionStart: number,
  clip: Placing,
  played = false,
): (seconds: number) => number {
  return placedTicks({ tempo }, placing(regionStart, clip), played);
}

/** Where a time in a region's recording (seconds of the file as recorded) plays on the song's timeline, in ticks. */
export function fileToTick(
  tempo: readonly TempoPoint[],
  regionStart: number,
  clip: Placing,
  seconds: number,
  played = false,
): number {
  return fileToTicks(tempo, regionStart, clip, played)(seconds);
}

/**
 * The time in a region's recording (seconds of the file as recorded) that plays at a tick: `fileToTick`
 * the other way. `played`: as the region plays it, past its notes' moves.
 */
export function tickToFile(
  tempo: readonly TempoPoint[],
  regionStart: number,
  clip: Placing,
  tick: number,
  played = false,
): number {
  return placedFile({ tempo }, placing(regionStart, clip), tick, played);
}

// ---- pitch: the semitone lanes, scrolled and zoomed ----

/** How tall a semitone may be drawn, pixels. */
export const KEY_HEIGHT = { min: 5, max: 40 } as const;
/** The lanes there are: MIDI 0 to 127, the highest at the top. */
const LANES = 128;

/** How the lanes are shown: a semitone's height, and how far they're scrolled down (pixels from the top of 127's lane). */
export interface PitchView {
  keyHeight: number;
  y: number;
}

/** The top of a semitone's lane. */
export const laneTop = (pitch: number, keyHeight: number, y: number): number => (127 - pitch) * keyHeight - y;
/** Where a pitch (with its cents) is drawn: a whole semitone on its lane's middle. */
export const pitchY = (pitch: number, keyHeight: number, y: number): number => (127.5 - pitch) * keyHeight - y;
/** The pitch (with cents) at a height on screen: `pitchY` the other way. */
export const pitchAtY = (at: number, keyHeight: number, y: number): number => 127.5 - (at + y) / keyHeight;
/** How far the lanes scroll down, in a view `h` pixels tall. */
export const maxPitchScroll = (keyHeight: number, h: number): number => Math.max(0, LANES * keyHeight - h);

/** The lanes zoomed by a factor around a height on screen, so the pitch there stays where it is. */
export function zoomPitch(v: PitchView, factor: number, at: number, h: number): PitchView {
  const pitch = pitchAtY(at, v.keyHeight, v.y);
  const keyHeight = clamp(v.keyHeight * factor, KEY_HEIGHT.min, KEY_HEIGHT.max);
  return { keyHeight, y: clamp((127.5 - pitch) * keyHeight - at, 0, maxPitchScroll(keyHeight, h)) };
}

/**
 * The lanes fitted round the pitches from `lo` to `hi` in a view `h` pixels tall: an octave at least,
 * with two semitones of room either side, as tall as fits between `min` and `max` a semitone.
 */
export function fitPitches(lo: number, hi: number, h: number, min = 8, max = 22): PitchView {
  const span = Math.max(12, hi - lo + 4);
  const keyHeight = clamp(h / span, Math.max(KEY_HEIGHT.min, min), Math.min(KEY_HEIGHT.max, max));
  const mid = (lo + hi) / 2;
  return { keyHeight, y: clamp((127.5 - mid) * keyHeight - h / 2, 0, maxPitchScroll(keyHeight, h)) };
}

/** The pitch a note is drawn at: where it was moved to, else as it was found (null: it has none). */
export const shownPitch = (n: Pick<AudioNote, 'p' | 'to'>): number | null => (n.p === null ? null : (n.to ?? n.p));

/**
 * Where a note with no pitch (a breath, a lone consonant) is drawn: at the pitch of the nearest note
 * in time that has one (the one before, when two are as near); null when none has.
 */
export function restingPitch(notes: readonly Pick<AudioNote, 't' | 'd' | 'p' | 'to'>[], i: number): number | null {
  const at = notes[i];
  if (!at) return null;
  let best: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (let j = i - 1; j >= 0; j--) {
    const n = notes[j] as AudioNote;
    const p = shownPitch(n);
    if (p === null) continue;
    best = p;
    bestGap = Math.max(0, at.t - (n.t + n.d));
    break;
  }
  for (let j = i + 1; j < notes.length; j++) {
    const n = notes[j] as AudioNote;
    const p = shownPitch(n);
    if (p === null) continue;
    if (Math.max(0, n.t - (at.t + at.d)) < bestGap) best = p;
    break;
  }
  return best;
}

// ---- a note's outline ----

/** The quietest a note is drawn thicker than its thinnest for, dB under the recording's loudest. */
const LEVEL_RANGE_DB = 42;

/** How thick a note is drawn where its power (a mean square) is this, between `thin` and `thick` pixels: by its level under the loudest. */
export function levelThickness(power: number, loudest: number, thin: number, thick: number): number {
  if (!(power > 0) || !(loudest > 0)) return thin;
  const k = clamp(1 + (10 * Math.log10(power / loudest)) / LEVEL_RANGE_DB, 0, 1);
  return thin + (thick - thin) * k;
}

/** The first index whose time is at or after `t`, in times that only go up (their length when none is). */
export function firstAt(times: ArrayLike<number>, t: number): number {
  let lo = 0;
  let hi = times.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((times[mid] as number) < t) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/**
 * Points closer together than `minPx` (x going up) taken as one: the first's x, the largest value
 * among them. So a zoomed-out view draws a point a pixel or two, not one per 5 ms.
 */
export function thinPoints(
  xs: readonly number[],
  values: readonly number[],
  minPx: number,
): { x: number[]; value: number[] } {
  const x: number[] = [];
  const value: number[] = [];
  for (let i = 0; i < xs.length; i++) {
    const xi = xs[i] as number;
    const vi = values[i] as number;
    const last = x.length - 1;
    if (last >= 0 && xi - (x[last] as number) < minPx) {
      if (vi > (value[last] as number)) value[last] = vi;
    } else {
      x.push(xi);
      value.push(vi);
    }
  }
  return { x, value };
}

/** The middle of up to five numbers. */
function median(values: number[]): number {
  values.sort((a, b) => a - b);
  const n = values.length;
  return n % 2 ? (values[n >> 1] as number) : ((values[n / 2 - 1] as number) + (values[n / 2] as number)) / 2;
}

/**
 * A stretch of a pitch curve as it's drawn, from index `i0` up to `i1`: its voiced runs (where it
 * isn't voiced, NaN, it breaks), each point the median of the five round it in its run (so a lone
 * slip of 5 ms doesn't draw a spike), and points closer than `minPx` taken as one at their mean (so a
 * zoomed-out view draws one a pixel or two, not one every 5 ms). Each run ends on its last point.
 */
export function curveRuns(
  midi: ArrayLike<number>,
  i0: number,
  i1: number,
  xOf: (i: number) => number,
  minPx: number,
): { x: number[]; p: number[] }[] {
  const runs: { x: number[]; p: number[] }[] = [];
  let k = i0;
  while (k < i1) {
    while (k < i1 && Number.isNaN(midi[k] as number)) k++;
    const a = k;
    while (k < i1 && !Number.isNaN(midi[k] as number)) k++;
    const b = k;
    if (b - a < 2) continue;
    const x: number[] = [];
    const p: number[] = [];
    let sum = 0;
    let count = 0;
    let lastX = 0;
    let lastP = 0;
    for (let j = a; j < b; j++) {
      const around: number[] = [];
      for (let q = Math.max(a, j - 2); q < Math.min(b, j + 3); q++) around.push(midi[q] as number);
      lastP = median(around);
      lastX = xOf(j);
      if (count && lastX - (x[x.length - 1] as number) < minPx) {
        sum += lastP;
        count++;
        p[p.length - 1] = sum / count;
      } else {
        x.push(lastX);
        p.push(lastP);
        sum = lastP;
        count = 1;
      }
    }
    if (x[x.length - 1] !== lastX) {
      x.push(lastX);
      p.push(lastP);
    }
    runs.push({ x, p });
  }
  return runs;
}

/**
 * How thick, at most, half a note is drawn: within its lane (a little under half a semitone), and no
 * more than a fifth of its length (the whole of it two fifths), so a short note in a zoomed-out view
 * is a slim pill along its time, never a round bubble. A pixel at least.
 */
export function capsuleHalf(keyHeight: number, lengthPx: number): number {
  return Math.max(1, Math.min(Math.max(2, keyHeight * 0.475), lengthPx * 0.2));
}

/** How many steps round each end of a capsule. */
const CAP_STEPS = 6;

/**
 * A note's outline as a capsule from `x0` to `x1`: its top edge as points (x, half its thickness),
 * the bottom mirroring it. The body follows the samples given (x going up, each with its half
 * thickness); each end is rounded off as a half circle as thick as the body is there.
 */
export function capsule(
  xs: readonly number[],
  halves: readonly number[],
  x0: number,
  x1: number,
): { x: number[]; half: number[] } {
  const span = Math.max(0, x1 - x0);
  const first = halves[0] ?? 0;
  const last = halves[halves.length - 1] ?? first;
  const rs = Math.min(first, span / 2);
  const re = Math.min(last, span / 2);
  const x: number[] = [];
  const half: number[] = [];
  for (let k = 0; k <= CAP_STEPS; k++) {
    const a = (Math.PI / 2) * (k / CAP_STEPS);
    x.push(x0 + rs * (1 - Math.cos(a)));
    half.push(rs * Math.sin(a));
  }
  for (let i = 0; i < xs.length; i++) {
    const xi = xs[i] as number;
    if (xi <= x0 + rs || xi >= x1 - re) continue;
    x.push(xi);
    half.push(halves[i] as number);
  }
  for (let k = CAP_STEPS; k >= 0; k--) {
    const a = (Math.PI / 2) * (k / CAP_STEPS);
    x.push(x1 - re * (1 - Math.cos(a)));
    half.push(re * Math.sin(a));
  }
  return { x, half };
}
