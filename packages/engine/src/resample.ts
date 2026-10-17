/**
 * Sample-rate conversion for renders: a Kaiser-windowed sinc, the same arithmetic everywhere, so a
 * 44.1 kHz sample becomes the same 48 kHz numbers in the studio's bounce and in a headless render.
 * Polyphase: the rates' ratio is exact (48000/44100 = 160/147), so each output sample uses one of
 * a few hundred precomputed filters. 32 zero crossings each side (64 taps), the pass band to 95% of
 * the lower Nyquist frequency, about 120 dB of stop-band rejection.
 */

const ZEROS = 32;
const TAPS = ZEROS * 2;
const BETA = 12;

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 64; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

function gcd(a: number, b: number): number {
  while (b) [a, b] = [b, a % b];
  return a;
}

const tables = new Map<string, Float64Array>();

/** The filters for `phases` sub-sample positions (phase p sits p/phases of a sample past its base). */
function polyphase(phases: number, cutoff: number): Float64Array {
  const key = `${phases}:${cutoff}`;
  let t = tables.get(key);
  if (t) return t;
  t = new Float64Array(phases * TAPS);
  const i0 = besselI0(BETA);
  for (let p = 0; p < phases; p++) {
    const frac = p / phases;
    for (let j = 0; j < TAPS; j++) {
      const x = j - ZEROS + 1 - frac; // the tap's distance from the point, in input samples
      const arg = x * cutoff;
      const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
      const r = x / ZEROS;
      const w = Math.abs(r) >= 1 ? 0 : besselI0(BETA * Math.sqrt(1 - r * r)) / i0;
      t[p * TAPS + j] = sinc * w * cutoff;
    }
  }
  tables.set(key, t);
  return t;
}

export function resample(x: Float32Array, from: number, to: number): Float32Array {
  if (from === to) return x.slice();
  const g = gcd(Math.round(from), Math.round(to));
  const up = Math.round(to) / g; // phases
  const down = Math.round(from) / g; // input samples per `up` outputs
  const t = polyphase(up, Math.min(1, to / from) * 0.95);
  // the input with silence either side, so the filter never reads past its ends
  const padded = new Float64Array(x.length + TAPS * 2);
  padded.set(x, TAPS);
  const out = new Float32Array(Math.round((x.length * to) / from));
  let base = 0;
  let phase = 0;
  for (let i = 0; i < out.length; i++) {
    const row = phase * TAPS;
    const first = base - ZEROS + 1 + TAPS;
    let acc = 0;
    for (let j = 0; j < TAPS; j++) acc += (padded[first + j] as number) * (t[row + j] as number);
    out[i] = acc;
    phase += down;
    while (phase >= up) {
      phase -= up;
      base++;
    }
  }
  return out;
}
