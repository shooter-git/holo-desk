/**
 * Rhythm: which written values a stretch of time takes (a dotted quarter, two tied eighths…), where
 * tuplets are, and the grid music played in is shown on. All in ticks, 960 to a quarter.
 */
import { PPQ } from '@holo/session';
import { type Beats, STRONG, strength } from './meter.ts';

const WHOLE = PPQ * 4;

/** A written value: 1 whole, 2 half, 4 quarter… 128, and its dots (0–2). */
export interface Value {
  value: number;
  dots: number;
}

export const VALUES = [1, 2, 4, 8, 16, 32, 64, 128] as const;

/** Ticks a written value lasts. */
export function ticksOf(v: Value): number {
  const base = WHOLE / v.value;
  return base * (2 - 1 / 2 ** v.dots);
}

const EPS = 1e-6;

/** The single written value that lasts exactly this long, or null. */
export function valueFor(ticks: number, maxDots = 2): Value | null {
  for (const value of VALUES) {
    for (let dots = 0; dots <= maxDots; dots++) {
      if (Math.abs(ticksOf({ value, dots }) - ticks) < EPS) return { value, dots };
    }
  }
  if (Math.abs(ticks - WHOLE * 2) < EPS) return { value: 0.5, dots: 0 }; // a breve (4/2)
  return null;
}

/**
 * Split [s, e) (ticks from the bar's own start: `at` places it) into written values. A value may not
 * hide a place stronger than where it starts (a half on beat 2 of 4/4 becomes two tied quarters, a
 * half on beat 2 of 3/4 stays); rests in simple time aren't dotted; anything else splits at the
 * strongest place inside it.
 */
export function splitValues(b: Beats, s: number, e: number, rest: boolean): [number, number][] {
  if (e - s < EPS) return [];
  const at = strength(b, s);
  let inner = -1;
  let innerStrength = -1;
  // the strongest place strictly inside (the earliest of equals)
  for (const place of placesBetween(b, s, e)) {
    const st = strength(b, place);
    if (st > innerStrength) {
      inner = place;
      innerStrength = st;
    }
  }
  const v = valueFor(e - s);
  const dottedRest = rest && !b.compound && v && v.dots > 0;
  const fits = v && !dottedRest && !(inner >= 0 && innerStrength > at);
  if (fits) return [[s, e]];
  if (inner >= 0) return [...splitValues(b, s, inner, rest), ...splitValues(b, inner, e, rest)];
  // nothing inside to split at (an odd length on no grid): the largest value that fits, then the rest
  for (const value of VALUES) {
    const len = WHOLE / value;
    if (len <= e - s + EPS) return [[s, s + len], ...splitValues(b, s + len, e, rest)];
  }
  return [[s, e]];
}

/** Places on the bar's divisions strictly between s and e, down to 128ths (or their thirds). */
function placesBetween(b: Beats, s: number, e: number): number[] {
  const unit = b.compound ? b.beat / 3 / 16 : b.beat / 32;
  const out: number[] = [];
  const first = Math.floor(s / unit + EPS) + 1;
  for (let k = first; k * unit < e - EPS; k++) out.push(k * unit);
  // group starts that fall off that grid (odd groupings)
  let g = 0;
  for (const len of b.groups) {
    g += len;
    if (g > s + EPS && g < e - EPS && !out.some((x) => Math.abs(x - g) < EPS)) out.push(g);
  }
  return out;
}

/** A tuplet: `num` notes in the time of `numbase` (3:2 a triplet, 2:3 a duplet in 6/8). */
export interface Ratio {
  num: number;
  numbase: number;
}

/**
 * Whether times in a span (ticks from its start, `len` long) need a tuplet, and which: none when
 * they all sit on the span's plain divisions; a triplet (or a duplet in compound time) when they sit
 * on its thirds (halves); a quintuplet or septuplet likewise.
 */
export function tupletFor(times: readonly number[], len: number, compound: boolean): Ratio | null {
  const inner = times.filter((t) => t > EPS && t < len - EPS);
  if (!inner.length) return null;
  const on = (div: number) => inner.every((t) => isMultiple(t, len / div));
  // the coarsest plain division that fits; a tuplet wins only when it fits far more simply
  const plain = (compound ? [3, 6, 12, 24] : [2, 4, 8, 16, 32]).find(on) ?? Number.POSITIVE_INFINITY;
  const options: [number[], Ratio][] = compound
    ? [
        [[2], { num: 2, numbase: 3 }],
        [[4, 8], { num: 4, numbase: 6 }],
      ]
    : [
        [[3, 6, 12, 24], { num: 3, numbase: 2 }],
        [[5, 10, 20], { num: 5, numbase: 4 }],
        [[7, 14], { num: 7, numbase: 4 }],
        [[9, 18], { num: 9, numbase: 8 }],
      ];
  for (const [divs, ratio] of options) {
    const fit = divs.find(on);
    if (fit !== undefined && (plain === Number.POSITIVE_INFINITY || (inner.length >= 2 && fit * 3 <= plain)))
      return ratio;
  }
  return null;
}

export function isMultiple(t: number, unit: number): boolean {
  const k = t / unit;
  return Math.abs(k - Math.round(k)) < 1e-6;
}

/** The written length of a span under a tuplet (three triplet eighths: 1440 for 960 sounding). */
export const writtenLength = (len: number, r: Ratio | null): number => (r ? (len * r.num) / r.numbase : len);

/**
 * The grid each beat of played-in music is shown on: the plain or triplet division that fits its
 * notes' starts and ends best, a finer one only when it fits clearly better.
 */
export function beatGrid(times: readonly number[], beat: number, compound: boolean): number {
  if (!times.length) return beat;
  const divisions: [number, number][] = compound
    ? [
        [1, 0],
        [3, 0.02],
        [6, 0.04],
        [2, 0.06],
        [12, 0.08],
        [4, 0.1],
      ]
    : [
        [1, 0],
        [2, 0.01],
        [4, 0.02],
        [3, 0.04],
        [8, 0.05],
        [6, 0.06],
        [12, 0.1],
      ];
  let best = beat;
  let bestCost = Number.POSITIVE_INFINITY;
  for (const [div, penalty] of divisions) {
    const unit = beat / div;
    let err = 0;
    for (const t of times) err += Math.abs(t - Math.round(t / unit) * unit);
    const cost = err / beat + penalty * (times.length ? 1 : 0);
    if (cost < bestCost - 1e-9) {
      best = unit;
      bestCost = cost;
    }
  }
  return best;
}

/** Snap a time to a grid. */
export const snap = (t: number, grid: number): number => Math.round(t / grid) * grid;

/** A place's strength, for callers that need to compare (re-exported for tests). */
export { STRONG, strength };
