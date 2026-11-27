/**
 * Quantizing to a grid that swings: the studio's Quantize and the agent's `regions quantize` both
 * come here, so a swing is the same swing wherever it's asked for.
 *
 * A swing pushes every other step of a grid late: the off-steps, counted from the bar line (the
 * second step of a bar, the fourth…). It's written as the Arpeggiator's and the Session Drummer's
 * is: a share of half a step, up to 75 %. At 0 nothing swings; near 67 % two steps fall as the first
 * and the last of a triplet.
 */
import { barToTick, type MeterPoint, PPQ, quantize, tickToBarBeat } from '@holo/session';

/** The most a grid swings (as the engine's own swings do). */
export const MAX_SWING = 0.75;

/**
 * Whether a grid can swing: the straight ones, a whole note halved over and over (1/4, 1/8, 1/16…).
 * A triplet or a dotted grid has no off-step to push.
 */
export function swings(grid: number): boolean {
  let g = PPQ * 4;
  while (g > grid + 1e-6) g /= 2;
  return Math.abs(g - grid) < 1e-6;
}

/**
 * A place, in ticks from its bar line, quantized to `grid`: moved `strength` (0 to 1) of the way to
 * the nearest step, the off-steps late by `swing` (0 to 0.75) of half a step. With no swing, or on
 * a grid that doesn't swing, it is `quantize` itself.
 */
export function swung(offset: number, grid: number, strength = 1, swing = 0): number {
  const late = swings(grid) ? Math.max(0, Math.min(MAX_SWING, swing)) * grid * 0.5 : 0;
  if (!late) return quantize(offset, grid, strength);
  const pair = grid * 2;
  const base = Math.floor(offset / pair) * pair;
  // the step before, the swung off-step between, the step after
  let target = base;
  for (const t of [base + grid + late, base + pair]) if (Math.abs(offset - t) < Math.abs(offset - target)) target = t;
  return Math.round(offset + (target - offset) * strength);
}

/** A tick of the song quantized the same way: its steps are counted from the bar line it's in. */
export function swungAt(meter: readonly MeterPoint[], tick: number, grid: number, strength = 1, swing = 0): number {
  const bar = barToTick(meter, tickToBarBeat(meter, tick).bar);
  return bar + swung(tick - bar, grid, strength, swing);
}
