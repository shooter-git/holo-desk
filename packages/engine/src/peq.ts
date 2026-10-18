/**
 * Parametric EQ: eight free bands, each one RBJ-cookbook biquad (a cut, shelf, bell, notch or band
 * pass at any frequency and Q). The same filters as Hallowed Lanterns' `bq`, so a voice's EQ written
 * there as bands sounds the same here. The studio draws its curve from `bandsResponse`, the
 * coefficients the engine runs.
 */
import { PEQ_BANDS, paramValue } from '@holo/session';
import { Biquad, type BiquadKind, dbToGain } from './dsp.ts';
import type { Effect, Host } from './fx.ts';

/** PEQ_TYPES' order: Off, Low Cut, Low Shelf, Bell, Notch, Band Pass, High Shelf, High Cut. */
const KINDS: (BiquadKind | null)[] = [
  null,
  'highpass',
  'lowshelf',
  'peak',
  'notch',
  'bandpass',
  'highshelf',
  'lowpass',
];

export interface EqBand {
  kind: BiquadKind;
  freq: number;
  q: number;
  gain: number;
}

/** The bands a Parametric EQ's parameters turn on, in order. */
export function peqBands(params: Record<string, number>): EqBand[] {
  const out: EqBand[] = [];
  for (let b = 1; b <= PEQ_BANDS; b++) {
    const v = (id: string) => paramValue('peq', params, `${id}${b}`);
    const kind = KINDS[Math.round(v('t'))];
    if (!kind) continue;
    out.push({ kind, freq: v('f'), q: v('q'), gain: v('g') });
  }
  return out;
}

/** The bands' response in dB at each frequency, from the coefficients the engine runs at `sr`. */
export function bandsResponse(bands: EqBand[], freqs: ArrayLike<number>, sr: number): Float64Array {
  const out = new Float64Array(freqs.length);
  const f = new Biquad();
  for (const b of bands) {
    f.set(b.kind, b.freq, b.q, b.gain, sr);
    for (let i = 0; i < freqs.length; i++) {
      const w = (2 * Math.PI * (freqs[i] as number)) / sr;
      const c1 = Math.cos(w);
      const s1 = Math.sin(w);
      const c2 = Math.cos(2 * w);
      const s2 = Math.sin(2 * w);
      const nr = f.b0 + f.b1 * c1 + f.b2 * c2;
      const ni = -(f.b1 * s1 + f.b2 * s2);
      const dr = 1 + f.a1 * c1 + f.a2 * c2;
      const di = -(f.a1 * s1 + f.a2 * s2);
      out[i] = (out[i] as number) + 10 * Math.log10((nr * nr + ni * ni) / (dr * dr + di * di) + 1e-30);
    }
  }
  return out;
}

export class ParametricEq implements Effect {
  gr = 0;
  private readonly filters = Array.from({ length: PEQ_BANDS }, () => new Biquad());
  private count = 0;
  private out = 1;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const bands = peqBands(p);
    // a band keeps its filter's state while it's tuned; turning bands on or off shifts the rest
    bands.forEach((b, i) => {
      this.filters[i]?.set(b.kind, b.freq, b.q, b.gain, this.host.sr);
    });
    for (let i = bands.length; i < this.count; i++) this.filters[i]?.reset();
    this.count = bands.length;
    this.out = dbToGain(paramValue('peq', p, 'output'));
  }
  /**
   * One setting moved: its band's filter alone, from the same values setParams would give it (a
   * band's type changes which filters play which band: then the whole).
   */
  setParam(id: string, p: Record<string, number>): void {
    if (id === 'output') {
      this.out = dbToGain(paramValue('peq', p, 'output'));
      return;
    }
    const letter = id[0];
    const b = Number(id.slice(1));
    if ((letter !== 'f' && letter !== 'q' && letter !== 'g') || !(b >= 1 && b <= PEQ_BANDS)) {
      this.setParams(p);
      return;
    }
    // the band's filter: the bands on before it come first
    let i = 0;
    for (let k = 1; k < b; k++) if (KINDS[Math.round(paramValue('peq', p, `t${k}`))]) i++;
    const kind = KINDS[Math.round(paramValue('peq', p, `t${b}`))];
    if (!kind) return;
    const v = (x: string) => paramValue('peq', p, `${x}${b}`);
    this.filters[i]?.set(kind, v('f'), v('q'), v('g'), this.host.sr);
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < this.count; i++) this.filters[i]?.process(l, r, n);
    if (this.out !== 1) {
      for (let i = 0; i < n; i++) {
        l[i] = (l[i] as number) * this.out;
        r[i] = (r[i] as number) * this.out;
      }
    }
  }
  reset(): void {
    for (const f of this.filters) f.reset();
  }
}
