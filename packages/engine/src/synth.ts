/**
 * The built-in synthesiser: two band-limited oscillators (polyBLEP) or a two-operator FM pair, a
 * resonant state-variable filter with its own envelope, and an amp envelope. Presets cover keys,
 * pads, basses, leads and bells, so there is always something to play.
 */
import { Noise } from './dsp.ts';
import { Adsr, type Controls, Instrument, type Voice } from './instrument.ts';

export interface SynthParams {
  /** 0 subtractive, 1 FM. */
  mode: number;
  /** 0 saw, 1 square, 2 triangle, 3 sine. */
  wave1: number;
  wave2: number;
  detune: number;
  octave2: number;
  mix2: number;
  sub: number;
  noise: number;
  /** 1 or 3 oscillator stacks, spread by `spread` cents. */
  unison: number;
  spread: number;
  cutoff: number;
  res: number;
  envAmt: number;
  keytrack: number;
  fA: number;
  fD: number;
  fS: number;
  fR: number;
  aA: number;
  aD: number;
  aS: number;
  aR: number;
  velAmp: number;
  velFilter: number;
  fmRatio: number;
  fmIndex: number;
  fmDecay: number;
  vibRate: number;
  vibDepth: number;
  level: number;
}

const BASE: SynthParams = {
  mode: 0,
  wave1: 0,
  wave2: 0,
  detune: 0,
  octave2: 0,
  mix2: 0,
  sub: 0,
  noise: 0,
  unison: 1,
  spread: 0,
  cutoff: 4000,
  res: 0.1,
  envAmt: 0,
  keytrack: 0.5,
  fA: 0.005,
  fD: 0.3,
  fS: 0.5,
  fR: 0.3,
  aA: 0.005,
  aD: 0.3,
  aS: 0.8,
  aR: 0.3,
  velAmp: 0.7,
  velFilter: 0.5,
  fmRatio: 1,
  fmIndex: 0,
  fmDecay: 1,
  vibRate: 5.5,
  vibDepth: 0.3,
  level: 0.35,
};

export const PRESETS: Record<string, Partial<SynthParams>> = {
  'Soft Keys': {
    wave1: 2,
    wave2: 3,
    octave2: 1,
    mix2: 0.25,
    sub: 0.3,
    cutoff: 1800,
    res: 0.05,
    envAmt: 1.5,
    fA: 0.002,
    fD: 0.6,
    fS: 0.2,
    aA: 0.003,
    aD: 1.6,
    aS: 0.2,
    aR: 0.45,
    level: 0.45,
  },
  'Electric Piano': {
    mode: 1,
    fmRatio: 1,
    fmIndex: 1.8,
    fmDecay: 0.9,
    cutoff: 9000,
    aA: 0.002,
    aD: 2.2,
    aS: 0.25,
    aR: 0.35,
    velAmp: 0.8,
    level: 0.4,
  },
  'Warm Pad': {
    wave1: 0,
    wave2: 0,
    detune: 7,
    mix2: 0.8,
    unison: 3,
    spread: 10,
    cutoff: 1100,
    res: 0.2,
    envAmt: 1.2,
    fA: 1.2,
    fD: 1.5,
    fS: 0.6,
    fR: 1.5,
    aA: 0.9,
    aD: 1,
    aS: 0.85,
    aR: 1.8,
    velAmp: 0.3,
    level: 0.22,
  },
  'Glass Bells': {
    mode: 1,
    fmRatio: 3.5,
    fmIndex: 2.4,
    fmDecay: 1.6,
    cutoff: 12000,
    aA: 0.001,
    aD: 3,
    aS: 0,
    aR: 2.2,
    level: 0.3,
  },
  'Analog Bass': {
    wave1: 0,
    wave2: 1,
    octave2: -1,
    mix2: 0.5,
    cutoff: 500,
    res: 0.45,
    envAmt: 3,
    keytrack: 0.3,
    fA: 0.001,
    fD: 0.22,
    fS: 0.15,
    fR: 0.1,
    aA: 0.002,
    aD: 0.3,
    aS: 0.75,
    aR: 0.08,
    level: 0.4,
  },
  'Sub Bass': {
    wave1: 3,
    wave2: 2,
    mix2: 0.15,
    cutoff: 400,
    envAmt: 0.5,
    aA: 0.004,
    aD: 0.2,
    aS: 1,
    aR: 0.12,
    level: 0.55,
  },
  'Bright Lead': {
    wave1: 1,
    wave2: 0,
    detune: 9,
    mix2: 0.6,
    cutoff: 3800,
    res: 0.3,
    envAmt: 1,
    fA: 0.01,
    fD: 0.4,
    fS: 0.6,
    aA: 0.01,
    aD: 0.2,
    aS: 0.9,
    aR: 0.2,
    vibDepth: 0.4,
    level: 0.26,
  },
  Pluck: {
    wave1: 0,
    wave2: 1,
    detune: 5,
    mix2: 0.3,
    cutoff: 900,
    res: 0.25,
    envAmt: 4,
    fA: 0.001,
    fD: 0.16,
    fS: 0,
    fR: 0.2,
    aA: 0.001,
    aD: 0.5,
    aS: 0,
    aR: 0.3,
    level: 0.38,
  },
  'Strings Ensemble': {
    wave1: 0,
    wave2: 0,
    detune: -6,
    mix2: 0.7,
    unison: 3,
    spread: 14,
    cutoff: 3200,
    res: 0.1,
    envAmt: 0.5,
    fA: 0.4,
    fD: 1,
    fS: 0.8,
    aA: 0.35,
    aD: 0.6,
    aS: 0.9,
    aR: 0.9,
    velAmp: 0.4,
    vibDepth: 0.15,
    level: 0.2,
  },
};

const TAU = Math.PI * 2;

class SynthVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private phases = new Float64Array(7);
  private sub = 0;
  private modPhase = 0;
  private vib = 0;
  private amp: Adsr;
  private fenv: Adsr;
  private ic1 = 0;
  private ic2 = 0;
  private g = 0;
  private k = 2;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private counter = 0;
  private killing = 0;
  private fmEnv = 1;
  private readonly fmCoef: number;
  private readonly vel: number;
  private readonly noise: Noise;
  private readonly pan: number;

  private p: SynthParams;
  private sr: number;
  /** Each unison stack's two oscillators as ratios of the note's frequency (the same powers, made once). */
  private readonly k1: Float64Array;
  private readonly k2: Float64Array;
  constructor(p: SynthParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    const stacks = p.unison > 1 ? 3 : 1;
    this.k1 = new Float64Array(stacks);
    this.k2 = new Float64Array(stacks);
    for (let s = 0; s < stacks; s++) {
      const spread = stacks > 1 ? (s - 1) * p.spread : 0;
      this.k1[s] = 2 ** (spread / 1200);
      this.k2[s] = 2 ** ((p.detune + spread * 0.7) / 1200 + p.octave2);
    }
    this.key = key;
    this.vel = velocity / 127;
    this.amp = new Adsr(sr, p.aA, p.aD, p.aS, p.aR);
    this.fenv = new Adsr(sr, p.fA, p.fD, p.fS, p.fR);
    this.amp.gate(true);
    this.fenv.gate(true);
    this.fmCoef = Math.exp(-1 / (Math.max(0.01, p.fmDecay) * sr));
    this.noise = new Noise(seed * 7919 + 1);
    this.pan = p.unison > 1 ? ((seed % 5) - 2) * 0.06 : 0;
    for (let i = 0; i < this.phases.length; i++) this.phases[i] = ((seed * (i + 3)) % 97) / 97;
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
    const velGain = 1 - p.velAmp + p.velAmp * this.vel * this.vel;
    const gain = p.level * velGain * ctl.expression;
    const gl = gain * (1 - Math.max(0, this.pan));
    const gr = gain * (1 + Math.min(0, this.pan));
    const stacks = p.unison > 1 ? 3 : 1;
    const norm = 1 / Math.sqrt(stacks);
    // with the mod wheel at rest the pitch holds through the block: worked out once
    const still = ctl.mod === 0;
    const held = still ? 440 * 2 ** ((this.key - 69 + ctl.bend + 0) / 12) : 0;
    const vibStep = p.vibRate / sr;
    const mix1 = 1 - p.mix2 * 0.5;
    const fenv = this.fenv;
    const amp = this.amp;
    const noise = this.noise;
    const phases = this.phases;
    const k1 = this.k1;
    const k2 = this.k2;
    for (let i = start; i < end; i++) {
      // vibrato from the mod wheel
      this.vib += vibStep;
      if (this.vib >= 1) this.vib -= 1;
      const freq = still
        ? held
        : 440 * 2 ** ((this.key - 69 + ctl.bend + Math.sin(TAU * this.vib) * p.vibDepth * ctl.mod) / 12);
      fenv.step();
      const fe = fenv.level;
      if ((this.counter++ & 15) === 0) {
        const cutoff =
          p.cutoff *
          2 **
            (p.envAmt * fe + (p.keytrack * (this.key - 60)) / 12 + p.velFilter * (this.vel - 0.7) * 2 + ctl.mod * 0.5);
        this.g = Math.tan((Math.PI * Math.min(Math.max(cutoff, 20), sr * 0.45)) / sr);
        this.k = 2 - 2 * Math.min(p.res, 0.97);
        this.a1 = 1 / (1 + this.g * (this.g + this.k));
        this.a2 = this.g * this.a1;
        this.a3 = this.g * this.a2;
      }
      let x = 0;
      if (p.mode === 1) {
        // two-operator FM: the modulator's index decays like a struck tine
        this.fmEnv *= this.fmCoef;
        const dm = (freq * p.fmRatio) / sr;
        this.modPhase += dm;
        if (this.modPhase >= 1) this.modPhase -= 1;
        const mod = Math.sin(TAU * this.modPhase) * p.fmIndex * this.fmEnv * (0.4 + 0.6 * this.vel);
        const ph = (phases[0] as number) + freq / sr;
        phases[0] = ph - Math.floor(ph);
        x = Math.sin(TAU * (phases[0] as number) + mod);
      } else {
        for (let s = 0; s < stacks; s++) {
          const d1 = (freq * (k1[s] as number)) / sr;
          const d2 = (freq * (k2[s] as number)) / sr;
          let ph1 = (phases[s * 2] as number) + d1;
          ph1 -= Math.floor(ph1);
          let ph2 = (phases[s * 2 + 1] as number) + d2;
          ph2 -= Math.floor(ph2);
          phases[s * 2] = ph1;
          phases[s * 2 + 1] = ph2;
          // the two oscillators, in line: a call V8 doesn't inline (this loop is big) boxes every
          // double it passes or returns, a heap allocation each sample
          let o1 = 0;
          let o2 = 0;
          for (let o = 0; o < 2; o++) {
            const wave = o === 0 ? p.wave1 : p.wave2;
            const ph = o === 0 ? ph1 : ph2;
            const dt = o === 0 ? d1 : d2;
            let v: number;
            switch (wave) {
              case 0: {
                // saw, its drop at phase 0 smoothed by the polyBLEP residual
                let b: number;
                if (ph < dt) {
                  const x = ph / dt;
                  b = x + x - x * x - 1;
                } else if (ph > 1 - dt) {
                  const x = (ph - 1) / dt;
                  b = x * x + x + x + 1;
                } else b = 0;
                v = 2 * ph - 1 - b;
                break;
              }
              case 1: {
                // square: a residual at each edge
                v = ph < 0.5 ? 1 : -1;
                let b: number;
                if (ph < dt) {
                  const x = ph / dt;
                  b = x + x - x * x - 1;
                } else if (ph > 1 - dt) {
                  const x = (ph - 1) / dt;
                  b = x * x + x + x + 1;
                } else b = 0;
                v += b;
                const t = (ph + 0.5) % 1;
                if (t < dt) {
                  const x = t / dt;
                  b = x + x - x * x - 1;
                } else if (t > 1 - dt) {
                  const x = (t - 1) / dt;
                  b = x * x + x + x + 1;
                } else b = 0;
                v -= b;
                break;
              }
              case 2:
                v = 1 - 4 * Math.abs(ph - 0.5);
                break;
              default:
                v = Math.sin(TAU * ph);
            }
            if (o === 0) o1 = v;
            else o2 = v;
          }
          x += (o1 * mix1 + o2 * p.mix2) * norm;
        }
        if (p.sub > 0) {
          this.sub += freq / 2 / sr;
          if (this.sub >= 1) this.sub -= 1;
          x += Math.sin(TAU * this.sub) * p.sub;
        }
        if (p.noise > 0) {
          noise.step();
          x += noise.value * p.noise;
        }
      }
      // state-variable low-pass
      const v3 = x - this.ic2;
      const v1 = this.a1 * this.ic1 + this.a2 * v3;
      const v2 = this.ic2 + this.a2 * this.ic1 + this.a3 * v3;
      this.ic1 = 2 * v1 - this.ic1;
      this.ic2 = 2 * v2 - this.ic2;
      amp.step();
      let a = amp.level;
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
      const y = v2 * a;
      l[i] = (l[i] as number) + y * gl;
      r[i] = (r[i] as number) + y * gr;
    }
  }
}

export class Synth extends Instrument {
  private params: SynthParams;
  private seed = 1;
  constructor(sr: number, preset: string, overrides?: Record<string, number>) {
    super(sr);
    this.params = { ...BASE, ...(PRESETS[preset] ?? PRESETS['Soft Keys']), ...(overrides ?? {}) } as SynthParams;
    this.maxVoices = 32;
  }
  protected startVoice(key: number, velocity: number): Voice {
    return new SynthVoice(this.params, key, velocity, this.sr, this.seed++);
  }
}
