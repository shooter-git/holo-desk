/**
 * Morph: a wavetable synthesiser that glides between two spectra. Each spectrum (soft, saw, hollow,
 * a narrow pulse, glassy partials, two sung vowels) is built once, by inverse FFT, into a table for
 * every octave with only the harmonics that fit below the Nyquist frequency, so nothing aliases at any
 * pitch. A voice reads both of its preset's tables and crossfades between them: Morph sets where,
 * and Motion sways it (and the voices' tuning) slowly. Up to three oscillators per voice, spread
 * across the stereo field, then a low-pass with its own envelope (Brightness), breath noise for
 * Texture, and a hall (Space).
 *
 * Its six knobs (SYNTH_MACROS) move while it plays.
 */
import { macroValues } from '@holo/session';
import { Env } from './analog.ts';
import { Noise } from './dsp.ts';
import { Hall } from './ethereal.ts';
import { ifft } from './fft.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

const N = 2048;
/** Tables per spectrum: the first has up to 512 harmonics, each next half as many. */
const LEVELS = 10;

/** Amplitude of harmonic n (from 1) for each spectrum. */
const SPECTRA: Record<string, (n: number) => number> = {
  soft: (n) => 1 / (n * n),
  saw: (n) => 1 / n,
  hollow: (n) => (n % 2 ? 1 / n : 0),
  pulse: (n) => Math.abs(Math.sin(n * Math.PI * 0.2)) / n,
  glass: (n) => {
    const peaks = [1, 4, 7, 11, 16, 23];
    const at = peaks.indexOf(n);
    return at >= 0 ? 0.9 ** at : 0.02 / n;
  },
  // two vowels, their formants placed for a voice around 220 Hz
  ah: (n) => vowel(n * 220, [700, 1220, 2600], [1, 0.5, 0.25]) / n ** 0.4,
  oo: (n) => vowel(n * 220, [300, 870, 2240], [1, 0.3, 0.1]) / n ** 0.4,
};

function vowel(f: number, formants: number[], gains: number[]): number {
  let a = 0.02;
  for (let k = 0; k < formants.length; k++) {
    const fc = formants[k] as number;
    const bw = 80 + fc * 0.06;
    a += (gains[k] as number) / (1 + ((f - fc) / bw) ** 2);
  }
  return a;
}

/**
 * A spectrum (amplitude of harmonic n, from 1) as band-limited tables, one per octave: the first
 * with up to 512 harmonics, each next half as many. Scaled so the fullest table peaks at 1.
 */
export function buildTables(amp: (n: number) => number): Float32Array[] {
  const t: Float32Array[] = [];
  let scale = 0;
  for (let lv = 0; lv < LEVELS; lv++) {
    const top = Math.max(1, 512 >> lv);
    const re = new Float64Array(N);
    const im = new Float64Array(N);
    for (let n = 1; n <= top; n++) {
      const a = amp(n);
      im[n] = (-a * N) / 2;
      im[N - n] = (a * N) / 2;
    }
    ifft(re, im);
    if (lv === 0) {
      for (let i = 0; i < N; i++) scale = Math.max(scale, Math.abs(re[i] as number));
      scale = scale > 0 ? 1 / scale : 1;
    }
    const out = new Float32Array(N + 1);
    for (let i = 0; i < N; i++) out[i] = (re[i] as number) * scale;
    out[N] = out[0] as number;
    t.push(out);
  }
  return t;
}

/** Which of a spectrum's tables to read for a frequency: every harmonic it has below Nyquist. */
export function tableLevel(freq: number, sr: number): number {
  const top = (0.45 * sr) / freq;
  let lv = 0;
  while (lv < LEVELS - 1 && 512 >> lv > top) lv++;
  return lv;
}

/** A table read at a phase (0..1), linearly interpolated. */
export function readTable(t: Float32Array, phase: number): number {
  const idx = phase * N;
  const j = idx | 0;
  return (t[j] as number) + ((t[j + 1] as number) - (t[j] as number)) * (idx - j);
}

const TABLES = new Map<string, Float32Array[]>();
function tables(name: string): Float32Array[] {
  let t = TABLES.get(name);
  if (t) return t;
  t = buildTables(SPECTRA[name] ?? (SPECTRA.saw as (n: number) => number));
  TABLES.set(name, t);
  return t;
}

// every table built when the engine loads, never while it plays
for (const name of Object.keys(SPECTRA)) tables(name);

interface MorphParams {
  // the knobs
  morph: number;
  brightness: number;
  motion: number;
  texture: number;
  release: number;
  space: number;
  // the preset's
  a: string;
  b: string;
  unison: number;
  /** Cents between the outer oscillators and the middle. */
  detune: number;
  attack: number;
  decay: number;
  sustain: number;
  /** Octaves the filter opens on the attack, and how fast it settles. */
  fEnv: number;
  fDecay: number;
  resonance: number;
  level: number;
}

type Preset = Omit<MorphParams, 'morph' | 'brightness' | 'motion' | 'texture' | 'release' | 'space'>;

const PRESETS: Record<string, Preset> = {
  'Morph Pad': {
    a: 'soft',
    b: 'glass',
    unison: 3,
    detune: 10,
    attack: 1.2,
    decay: 2,
    sustain: 0.85,
    fEnv: 0.6,
    fDecay: 2.5,
    resonance: 0.15,
    level: 0.15,
  },
  'Morph Lead': {
    a: 'saw',
    b: 'pulse',
    unison: 2,
    detune: 6,
    attack: 0.004,
    decay: 0.6,
    sustain: 0.8,
    fEnv: 1.2,
    fDecay: 0.35,
    resonance: 0.3,
    level: 0.2,
  },
  'Morph Pluck': {
    a: 'saw',
    b: 'soft',
    unison: 2,
    detune: 7,
    attack: 0.002,
    decay: 0.5,
    sustain: 0,
    fEnv: 3.2,
    fDecay: 0.18,
    resonance: 0.25,
    level: 0.26,
  },
  'Morph Bass': {
    a: 'hollow',
    b: 'saw',
    unison: 1,
    detune: 0,
    attack: 0.003,
    decay: 0.8,
    sustain: 0.75,
    fEnv: 1.6,
    fDecay: 0.22,
    resonance: 0.25,
    level: 0.18,
  },
  'Morph Choir': {
    a: 'ah',
    b: 'oo',
    unison: 3,
    detune: 9,
    attack: 0.5,
    decay: 1.5,
    sustain: 0.9,
    fEnv: 0.3,
    fDecay: 1.5,
    resonance: 0.05,
    level: 0.15,
  },
};

export const MORPH_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): MorphParams {
  const name = PRESETS[preset] ? preset : 'Morph Pad';
  return { ...(PRESETS[name] as Preset), ...macroValues(name, params) } as MorphParams;
}

const TAU = Math.PI * 2;

class MorphVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private readonly ph = new Float64Array(3);
  private readonly ta: Float32Array[];
  private readonly tb: Float32Array[];
  private readonly amp: Env;
  private readonly fenv: Env;
  private readonly noise: Noise;
  private readonly p: MorphParams;
  private readonly sr: number;
  private readonly vel: number;
  private lfo: number;
  private counter = 0;
  private inc = 0;
  private level = 0;
  private morph = 0;
  // the filter: a two-pole state-variable low-pass per side
  private g = 0.5;
  private k = 1.4;
  private l1 = 0;
  private l2 = 0;
  private r1 = 0;
  private r2 = 0;
  private killing = 0;

  constructor(p: MorphParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.vel = velocity / 127;
    this.ta = tables(p.a);
    this.tb = tables(p.b);
    this.noise = new Noise(seed * 7121 + 11);
    this.amp = new Env(sr);
    this.fenv = new Env(sr);
    this.lfo = ((seed * 31) % 100) / 100;
    for (let o = 0; o < 3; o++) this.ph[o] = ((seed * (o + 7)) % 61) / 61;
    this.retime();
    this.amp.gate(true);
    this.fenv.gate(true);
  }

  retime(): void {
    const p = this.p;
    this.amp.set(p.attack, p.decay, p.sustain, p.release);
    this.fenv.set(Math.min(p.attack, 0.5), p.fDecay, 0, p.release);
  }

  release(): void {
    this.released = true;
    this.amp.gate(false);
    this.fenv.gate(false);
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const p = this.p;
    const sr = this.sr;
    const n = Math.max(1, Math.min(3, Math.round(p.unison)));
    const ta = this.ta;
    const tb = this.tb;
    const amp = this.amp;
    const fenv = this.fenv;
    const ph = this.ph;
    const noise = this.noise;
    const gain = p.level * (0.55 + 0.45 * this.vel) * ctl.expression;
    const breath = p.texture * 0.22;
    // the oscillators' places: one in the middle, or two or three spread
    const spread = n === 1 ? 0 : 0.8;
    for (let i = start; i < end; i++) {
      if ((this.counter++ & 15) === 0) {
        this.lfo += (16 * 0.11) / sr;
        if (this.lfo >= 1) this.lfo -= 1;
        const sway = Math.sin(TAU * this.lfo);
        const vib = ctl.mod > 0 ? Math.sin(TAU * this.lfo * 45) * 0.25 * ctl.mod : 0;
        const freq = 440 * 2 ** ((this.key - 69 + ctl.bend + vib + sway * p.motion * 0.04) / 12);
        this.inc = freq / sr;
        // the table with every harmonic that fits below Nyquist
        const top = (0.45 * sr) / freq;
        let lv = 0;
        while (lv < LEVELS - 1 && 512 >> lv > top) lv++;
        this.level = lv;
        this.morph = Math.min(1, Math.max(0, p.morph + sway * p.motion * 0.35));
        const fe = fenv.level;
        const cutoff = Math.min(
          sr * 0.45,
          p.brightness * 2 ** (p.fEnv * fe + (this.key - 60) / 24 + (this.vel - 0.7) * 0.8),
        );
        this.g = Math.tan((Math.PI * cutoff) / sr);
        this.k = 2 - 1.9 * p.resonance;
      }
      amp.step();
      fenv.step();
      const A = ta[this.level] as Float32Array;
      const B = tb[this.level] as Float32Array;
      const m = this.morph;
      let sl = 0;
      let sr2 = 0;
      for (let o = 0; o < n; o++) {
        const det = n === 1 ? 1 : 1 + ((o - (n - 1) / 2) / ((n - 1) / 2)) * p.detune * 0.000578 * (1 + p.texture);
        let x = (ph[o] as number) + this.inc * det;
        if (x >= 1) x -= 1;
        ph[o] = x;
        const idx = x * N;
        const j = idx | 0;
        const f = idx - j;
        const a = (A[j] as number) + ((A[j + 1] as number) - (A[j] as number)) * f;
        const b = (B[j] as number) + ((B[j + 1] as number) - (B[j] as number)) * f;
        const y = a + (b - a) * m;
        const pan = n === 1 ? 0 : ((o / (n - 1)) * 2 - 1) * spread;
        sl += y * Math.min(1, 1 - pan);
        sr2 += y * Math.min(1, 1 + pan);
      }
      if (breath > 0) {
        noise.step();
        sl += noise.value * breath;
        noise.step();
        sr2 += noise.value * breath;
      }
      // the low-pass, both sides
      const g = this.g;
      const k = this.k;
      const a1 = 1 / (1 + g * (g + k));
      let v3 = sl - this.l2;
      let v1 = a1 * this.l1 + g * a1 * v3;
      let v2 = this.l2 + g * v1;
      this.l1 = 2 * v1 - this.l1;
      this.l2 = 2 * v2 - this.l2;
      const yl = v2;
      v3 = sr2 - this.r2;
      v1 = a1 * this.r1 + g * a1 * v3;
      v2 = this.r2 + g * v1;
      this.r1 = 2 * v1 - this.r1;
      this.r2 = 2 * v2 - this.r2;
      const yr = v2;
      let a = amp.level * gain;
      if (this.killing > 0) {
        this.killing *= 0.995;
        a *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      if (amp.off) {
        this.done = true;
        return;
      }
      l[i] = (l[i] as number) + yl * a;
      r[i] = (r[i] as number) + yr * a;
    }
  }
}

export class MorphSynth extends Instrument {
  private readonly p: MorphParams;
  private readonly preset: string;
  private seed = 1;
  private dryL = new Float32Array(0);
  private dryR = new Float32Array(0);
  private readonly hall: Hall;
  private tail = 0;

  constructor(sr: number, preset: string, params?: Record<string, number>) {
    super(sr);
    this.preset = preset;
    this.p = resolve(preset, params);
    this.maxVoices = 24;
    this.hall = new Hall(sr);
    this.hall.setDecay(2 + 6 * this.p.space);
  }

  update(params?: Record<string, number>): void {
    Object.assign(this.p, resolve(this.preset, params));
    this.hall.setDecay(2 + 6 * this.p.space);
    for (const v of this.voices as MorphVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice {
    return new MorphVoice(this.p, key, velocity, this.sr, this.seed++);
  }

  override get active(): number {
    return super.active + (this.tail > 2e-5 ? 1 : 0);
  }

  override render(l: Float32Array, r: Float32Array, start: number, end: number): void {
    const space = this.p.space;
    if (space <= 0 && this.tail <= 2e-5) {
      super.render(l, r, start, end);
      return;
    }
    if (end > this.dryL.length) {
      this.dryL = new Float32Array(end);
      this.dryR = new Float32Array(end);
    }
    const dl = this.dryL;
    const dr = this.dryR;
    dl.fill(0, start, end);
    dr.fill(0, start, end);
    super.render(dl, dr, start, end);
    const hall = this.hall;
    const dry = 1 - 0.4 * space;
    const wet = space * 0.8;
    let peak = 0;
    for (let i = start; i < end; i++) {
      const xl = dl[i] as number;
      const xr = dr[i] as number;
      hall.process(xl, xr);
      const a = (Math.abs(hall.outL) + Math.abs(hall.outR)) * wet;
      if (a > peak) peak = a;
      l[i] = (l[i] as number) + xl * dry + hall.outL * wet;
      r[i] = (r[i] as number) + xr * dry + hall.outR * wet;
    }
    this.tail = Math.max(peak, this.tail * 0.9);
  }
}
