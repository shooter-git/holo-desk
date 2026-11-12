/**
 * How loud a recording or a render is, as a loudness meter reads it (EBU R128, ITU-R BS.1770-4):
 * momentary (400 ms), short-term (3 s) and integrated loudness in LUFS, the loudness range (EBU Tech
 * 3342) in LU, the true peak (4× oversampled, dBTP) and the sample peak (dBFS), and the samples that
 * reach full scale. The K-weighting and the true-peak interpolator are the finish's own (master.ts),
 * so a song measured here reads as its bounce's mastering measured it.
 *
 * It reads a long render in pieces (a few seconds of it in memory at a time, besides the render), and
 * keeps each 100 ms's K-weighted power: every loudness is worked out from those, over the whole or a
 * part of it (a section's). The true peak is read where it can be the highest: in the seconds whose
 * samples come within 6 dB of the loudest sample.
 */
import { kWeight, truePeakEnv } from '../master.ts';

/** What's measured of a recording's loudness. Levels are null where it's silent. */
export interface LoudnessReport {
  seconds: number;
  /** Integrated loudness (gated: −70 LUFS, then 10 LU under the ungated), LUFS. */
  integrated: number | null;
  /** The loudest 400 ms and the loudest 3 s, LUFS. */
  momentaryMax: number | null;
  shortTermMax: number | null;
  /** Loudness range (EBU Tech 3342): how far the short-term loudness moves, 10th to 95th percentile, LU. */
  range: number | null;
  /** dBTP and dBFS. */
  truePeak: number | null;
  samplePeak: number | null;
  /** Samples at full scale or past it (every channel's), and the runs they come in (each a clip). */
  over: number;
  overRuns: number;
}

/** A sample this close to full scale counts as at it (a 16-bit file's top is 32767/32768). */
export const FULL_SCALE = 0.9999;
/** Read this many seconds at a time; each piece's K-weighting starts this long before it (the filters settle). */
const PIECE_S = 8;
const WARM_S = 0.5;
/** Frames on each side of a piece that its true peak looks at (the interpolator reaches 10). */
const TP_MARGIN = 16;

const lufs = (power: number): number | null => (power > 0 ? -0.691 + 10 * Math.log10(power) : null);
const dbOf = (amp: number): number | null => (amp > 0 ? 20 * Math.log10(amp) : null);
const r2 = (v: number | null) => (v === null ? null : Math.round(v * 100) / 100);

/** Each 100 ms of a recording's K-weighted power, and its peaks, read once. */
export class LoudnessMeter {
  readonly sampleRate: number;
  readonly frames: number;
  /** The 100 ms steps loudness is read in, in frames (a 400 ms block is four, 3 s thirty). */
  readonly hop: number;
  /** Each step's K-weighted mean square, the channels summed (BS.1770's weights are 1 for left and right). */
  readonly steps: Float64Array;
  readonly samplePeak: number;
  readonly truePeak: number;
  readonly over: number;
  readonly overRuns: number;

  constructor(channels: readonly ArrayLike<number>[], sampleRate: number) {
    this.sampleRate = sampleRate;
    const n = channels.reduce((m, c) => Math.max(m, c.length), 0);
    this.frames = n;
    const hop = Math.max(1, Math.round(0.1 * sampleRate));
    this.hop = hop;
    const count = Math.ceil(n / hop);
    const sums = new Float64Array(count);
    let peak = 0;
    let tp = 0;
    let over = 0;
    let runs = 0;
    const piece = Math.max(hop, Math.round(PIECE_S * sampleRate));
    const warm = Math.round(WARM_S * sampleRate);
    const second = Math.max(1, Math.round(sampleRate));
    /** Each channel's sample peak, a second at a time. */
    const peaks = channels.map(() => new Float64Array(Math.ceil(n / second)));
    channels.forEach((ch, c) => {
      const secs = peaks[c] as Float64Array;
      let inRun = false;
      for (let c0 = 0; c0 < n; c0 += piece) {
        const c1 = Math.min(n, c0 + piece);
        // K-weighting, from a little before the piece (from silence at the very start, as the finish's)
        const w0 = Math.max(0, c0 - warm);
        const x = new Float64Array(c1 - w0);
        for (let i = w0; i < c1; i++) x[i - w0] = i < ch.length ? (ch[i] as number) : 0;
        const y = kWeight(x, sampleRate);
        for (let i = c0; i < c1; i++) {
          const v = y[i - w0] as number;
          const s = Math.floor(i / hop);
          sums[s] = (sums[s] as number) + v * v;
          const a = Math.abs(i < ch.length ? (ch[i] as number) : 0);
          const k = Math.floor(i / second);
          if (a > (secs[k] as number)) secs[k] = a;
          if (a >= FULL_SCALE) {
            over++;
            if (!inRun) runs++;
            inRun = true;
          } else inRun = false;
        }
      }
      for (const v of secs) if (v > peak) peak = v;
    });
    // the true peak, through the finish's interpolator, of the seconds that come within 6 dB of the
    // loudest sample (between samples a signal rises at most a few dB over them), each with the frames
    // around it its interpolator reaches
    channels.forEach((ch, c) => {
      const secs = peaks[c] as Float64Array;
      for (let k = 0; k < secs.length; k++) {
        if ((secs[k] as number) < peak / 2 || peak === 0) continue;
        const c0 = k * second;
        const c1 = Math.min(n, c0 + second);
        const t0 = Math.max(0, c0 - TP_MARGIN);
        const t1 = Math.min(n, c1 + TP_MARGIN);
        const seg = new Float64Array(t1 - t0);
        for (let i = t0; i < t1; i++) seg[i - t0] = i < ch.length ? (ch[i] as number) : 0;
        const env = truePeakEnv([seg]);
        for (let i = c0; i < c1; i++) {
          const v = env[i - t0] as number;
          if (v > tp) tp = v;
        }
      }
    });
    this.steps = sums;
    this.samplePeak = peak;
    this.truePeak = Math.max(tp, peak);
    this.over = over;
    this.overRuns = runs;
  }

  get seconds(): number {
    return this.frames / this.sampleRate;
  }

  /** The step a time (s) falls in, kept inside the recording. */
  private step(seconds: number): number {
    return Math.max(0, Math.min(this.steps.length, Math.round((seconds * this.sampleRate) / this.hop)));
  }

  /**
   * The mean K-weighted power of each window of `size` steps, every step (`from` to `to`, in steps),
   * over whole windows only; a stretch shorter than one window is one, as if silence followed it.
   */
  private windows(size: number, from: number, to: number): number[] {
    const out: number[] = [];
    const len = size * this.hop;
    const whole = this.frames >= len;
    for (let s = from; s + size <= to; s++) {
      // the last step is whole only if the recording runs to its end
      if ((s + size) * this.hop > this.frames) break;
      let total = 0;
      for (let k = s; k < s + size; k++) total += this.steps[k] as number;
      out.push(total / len);
    }
    if (!out.length && (!whole || to - from < size)) {
      let total = 0;
      for (let k = from; k < to; k++) total += this.steps[k] as number;
      out.push(total / len);
    }
    return out;
  }

  /** Integrated loudness from `from` to `to` (s; the whole by default), gated as BS.1770-4 gates it. */
  integrated(from = 0, to = this.seconds): number | null {
    const blocks = this.windows(4, this.step(from), this.step(to));
    const loud = blocks.filter((p) => (lufs(p) ?? -Infinity) > -70);
    if (!loud.length) return null;
    const mean = (a: number[]) => a.reduce((s, v) => s + v, 0) / a.length;
    const rel = (lufs(mean(loud)) as number) - 10;
    const kept = blocks.filter((p) => (lufs(p) ?? -Infinity) > rel);
    return kept.length ? lufs(mean(kept)) : null;
  }

  /** The loudest momentary (400 ms) and short-term (3 s) loudness from `from` to `to` (s). */
  maxima(from = 0, to = this.seconds): { momentary: number | null; shortTerm: number | null } {
    const a = this.step(from);
    const b = this.step(to);
    const most = (ps: number[]) => (ps.length ? lufs(Math.max(...ps)) : null);
    return { momentary: most(this.windows(4, a, b)), shortTerm: most(this.windows(30, a, b)) };
  }

  /** Loudness range (EBU Tech 3342): short-term loudness gated at −70 LUFS and 20 LU under its mean, P95 − P10. */
  range(from = 0, to = this.seconds): number | null {
    const st = this.windows(30, this.step(from), this.step(to)).filter((p) => (lufs(p) ?? -Infinity) > -70);
    if (st.length < 2) return null;
    const mean = st.reduce((s, v) => s + v, 0) / st.length;
    const gate = (lufs(mean) as number) - 20;
    const kept = st
      .map((p) => lufs(p) as number)
      .filter((l) => l > gate)
      .sort((x, y) => x - y);
    if (kept.length < 2) return null;
    const pct = (p: number) => {
      const pos = (p / 100) * (kept.length - 1);
      const i = Math.floor(pos);
      const f = pos - i;
      return i + 1 < kept.length ? (kept[i] as number) * (1 - f) + (kept[i + 1] as number) * f : (kept[i] as number);
    };
    return pct(95) - pct(10);
  }

  report(): LoudnessReport {
    const { momentary, shortTerm } = this.maxima();
    return {
      seconds: Math.round(this.seconds * 100) / 100,
      integrated: r2(this.integrated()),
      momentaryMax: r2(momentary),
      shortTermMax: r2(shortTerm),
      range: r2(this.range()),
      truePeak: r2(dbOf(this.truePeak)),
      samplePeak: r2(dbOf(this.samplePeak)),
      over: this.over,
      overRuns: this.overRuns,
    };
  }
}

/** A recording's loudness, peaks and clips (each channel an array of samples, at `sampleRate`). */
export function measureLoudness(channels: readonly ArrayLike<number>[], sampleRate: number): LoudnessReport {
  return new LoudnessMeter(channels, sampleRate).report();
}
