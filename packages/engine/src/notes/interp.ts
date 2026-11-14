/**
 * Reading a sound between its samples, for a grain placed between them (psola.ts): a sinc under a
 * Kaiser window (β 6), 16 taps, 8 zero crossings either side. Flat to within a hundredth of a dB up
 * to 18 kHz at 48 kHz, at worst (half a sample), and its taps add to one, so a steady level reads as
 * it is. A grain is read at one offset all through, so each grain makes its taps once.
 */
import { besselI0 } from '../resample.ts';

/** How many samples a point between samples is read from. */
export const INTERP_TAPS = 16;
const HALF = INTERP_TAPS / 2;
const BETA = 6;
const I0_BETA = besselI0(BETA);

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
