/**
 * Reading a sound between its samples, for a grain placed between them (psola.ts): a sinc under a
 * Kaiser window (β 6), 16 taps, 8 zero crossings either side. Flat to within a hundredth of a dB up
 * to 18 kHz at 48 kHz, at worst (half a sample), and its taps add to one, so a steady level reads as
 * it is. A grain is read at one offset all through, so each grain makes its taps once.
 *
 * A grain read faster or slower than it was recorded (its formants moved) is read at a new point each
 * sample, from a table of taps made once (`cutoffTable`). Read faster, what was under half the rate
 * would land above it and fold back: its sinc's cutoff is lowered by as much as it's sped up.
 */
import { besselI0 } from '../resample.ts';

/** How many samples a point between samples is read from. */
export const INTERP_TAPS = 16;
const HALF = INTERP_TAPS / 2;
const BETA = 6;
const I0_BETA = besselI0(BETA);
/** A table of taps has a row every 1/PHASES of a sample (and one more, for the next sample), read between rows in line. */
const PHASES = 512;

/**
 * The taps that read a sound `frac` (0 to 1) of a sample past sample i: tap m weighs sample
 * `i − 7 + m`. Written into `out` (16 long), which is returned.
 */
export function fractionalTaps(frac: number, out: Float64Array = new Float64Array(INTERP_TAPS)): Float64Array {
  let sum = 0;
  for (let m = 0; m < INTERP_TAPS; m++) {
    const d = m - (HALF - 1) - frac; // the tap's distance from the point, in samples
    const sinc = d === 0 ? 1 : Math.sin(Math.PI * d) / (Math.PI * d);
    const r = d / HALF;
    const w = Math.abs(r) >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - r * r)) / I0_BETA;
    out[m] = sinc * w;
    sum += sinc * w;
  }
  for (let m = 0; m < INTERP_TAPS; m++) out[m] = (out[m] as number) / sum;
  return out;
}

/** The first sample a point `frac` past sample i reads (with `fractionalTaps`): i − 7. */
export const FIRST_TAP = -(HALF - 1);

/** The Kaiser window under each tap of each row of a cutoff table: the same whatever the cutoff. */
let windows: Float64Array | null = null;

/**
 * Taps with the sinc's cutoff at `cutoff` (a share of half the rate, 1 at most), every 1/512 of a
 * sample from 0 to 1: row r (16 taps, adding to one) reads a point r/512 past a sample, as
 * `fractionalTaps` does at a cutoff of 1. Read with `tableTaps`.
 */
export function cutoffTable(cutoff: number): Float64Array {
  if (!windows) {
    windows = new Float64Array((PHASES + 1) * INTERP_TAPS);
    for (let r = 0; r <= PHASES; r++)
      for (let m = 0; m < INTERP_TAPS; m++) {
        const d = (m - (HALF - 1) - r / PHASES) / HALF;
        windows[r * INTERP_TAPS + m] = Math.abs(d) >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - d * d)) / I0_BETA;
      }
  }
  const table = new Float64Array((PHASES + 1) * INTERP_TAPS);
  for (let r = 0; r <= PHASES; r++) {
    let sum = 0;
    for (let m = 0; m < INTERP_TAPS; m++) {
      const x = cutoff * (m - (HALF - 1) - r / PHASES);
      const w = (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x)) * (windows[r * INTERP_TAPS + m] as number);
      table[r * INTERP_TAPS + m] = w;
      sum += w;
    }
    for (let m = 0; m < INTERP_TAPS; m++) table[r * INTERP_TAPS + m] = (table[r * INTERP_TAPS + m] as number) / sum;
  }
  return table;
}

/** The taps of a cutoff table for a point `frac` (0 to 1) past a sample, between its rows in line, into `out` (16 long). */
export function tableTaps(table: Float64Array, frac: number, out: Float64Array): Float64Array {
  const at = frac * PHASES;
  const r = Math.min(PHASES - 1, Math.floor(at));
  const u = at - r;
  const a = r * INTERP_TAPS;
  const b = a + INTERP_TAPS;
  for (let m = 0; m < INTERP_TAPS; m++) {
    const v = table[a + m] as number;
    out[m] = v + ((table[b + m] as number) - v) * u;
  }
  return out;
}
