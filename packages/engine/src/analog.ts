/**
 * Fat: a synthesizer in the manner of the classic American monosynths. Three oscillators (two saws a
 * few cents apart and a square or saw an octave down, each drifting a little, as an analog's do) are
 * mixed hot into a four-pole transistor-ladder low-pass: solved with no delay in its feedback (so it
 * stays in tune and stable up to self-oscillation), its input saturating like the transistors, and
 * its resonance thinning the bass as the real one does (a little made up). A snappy filter contour
 * and an amp envelope that starts from where it is (a note struck again never clicks).
 *
 * "Fat Mono" plays one note, the last one held: played legato it glides and the envelopes carry on
 * (one trigger, as the originals), let go it falls back to the note still held. "Fat Poly" plays
 * chords, each voice a little to one side; with Glide up, each new note slides in from the last.
 *
 * Its six knobs (SYNTH_MACROS) move while it plays: a knob turned changes what's sounding.
 */
import { macroValues } from '@holo/session';
import { Noise } from './dsp.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

interface FatParams {
  mono: number;
  // the knobs
  cutoff: number;
  emphasis: number;
  contour: number;
  decay: number;
  glide: number;
  drive: number;
  // the preset's
  /** Cents between the two saws. */
  detune: number;
  mix1: number;
  mix2: number;
  mix3: number;
  /** The third oscillator: octaves from the note, and its wave (0 saw, 1 square). */
  oct3: number;
  wave3: number;
  noise: number;
  /** Cents each oscillator wanders. */
  drift: number;
  fA: number;
  fS: number;
  fR: number;
  aA: number;
  aD: number;
  aS: number;
  aR: number;
  keytrack: number;
  /** Octaves the filter opens between a soft and a hard note. */
  velFilter: number;
  velAmp: number;
  /** How far apart a chord's voices sit (Fat Poly). */
  spread: number;
  level: number;
}

const PRESETS: Record<string, Omit<FatParams, 'cutoff' | 'emphasis' | 'contour' | 'decay' | 'glide' | 'drive'>> = {
  'Fat Mono': {
    mono: 1,
    detune: 7,
    mix1: 1,
    mix2: 0.85,
    mix3: 0.8,
    oct3: -1,
    wave3: 1,
    noise: 0,
    drift: 2.5,
    fA: 0.0015,
    fS: 0.16,
    fR: 0.12,
    aA: 0.0015,
    aD: 0.7,
    aS: 0.86,
    aR: 0.07,
    keytrack: 0.5,
    velFilter: 1.4,
    velAmp: 0.3,
    spread: 0,
    level: 0.5,
  },
  'Fat Poly': {
    mono: 0,
    detune: 9,
    mix1: 1,
    mix2: 0.9,
    mix3: 0.35,
    oct3: -1,
    wave3: 0,
    noise: 0,
    drift: 3,
    fA: 0.004,
    fS: 0.32,
    fR: 0.5,
    aA: 0.005,
    aD: 1.4,
    aS: 0.78,
    aR: 0.45,
    keytrack: 0.6,
    velFilter: 1.1,
    velAmp: 0.45,
    spread: 0.35,
    level: 0.24,
  },
};

export const FAT_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): FatParams {
  const base = PRESETS[preset] ?? (PRESETS['Fat Mono'] as FatParams);
  return { ...base, ...macroValues(PRESETS[preset] ? preset : 'Fat Mono', params) } as FatParams;
}

/** Attack, decay, sustain, release, with times that can change while it plays. */
export class Env {
  level = 0;
  /** 0 attack, 1 decay, 2 sustain, 3 release, 4 off. */
  stage = 4;
  private attack = 0;
  private decay = 0;
  private releaseCoef = 0;
  private sustain = 0;
  private readonly sr: number;
  constructor(sr: number) {
    this.sr = sr;
  }
  set(a: number, d: number, s: number, r: number): void {
    // an analog attack: charging toward a little past full, so it arrives with a snap
    this.attack = 1 - Math.exp(-1 / Math.max(1, a * this.sr * 0.6));
    this.decay = Math.exp(-4.6 / Math.max(1, d * this.sr));
    this.releaseCoef = Math.exp(-6.9 / Math.max(1, r * this.sr));
    this.sustain = s;
  }
  /** From where it is: a note struck again never jumps. */
  gate(on: boolean): void {
    if (on) this.stage = 0;
    else if (this.stage < 3) this.stage = 3;
  }
  get off(): boolean {
    return this.stage === 4;
  }
  step(): void {
    switch (this.stage) {
      case 0:
        this.level += (1.25 - this.level) * this.attack;
        if (this.level >= 1) {
          this.level = 1;
          this.stage = 1;
        }
        break;
      case 1:
        this.level = this.sustain + (this.level - this.sustain) * this.decay;
        if (Math.abs(this.level - this.sustain) < 1e-4) this.stage = 2;
        break;
      case 2:
        this.level = this.sustain;
        break;
      case 3:
        this.level *= this.releaseCoef;
        if (this.level < 1e-4) {
          this.level = 0;
          this.stage = 4;
        }
        break;
    }
  }
}

const TAU = Math.PI * 2;

class FatVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  /** The pitch sounding (MIDI, fractional while it glides) and where it's going. */
  private pitch: number;
  private target: number;
  private vel: number;
  private readonly phase = new Float64Array(3);
  /** Each oscillator's wander (cents) and where it's wandering to. */
  private readonly drift = new Float64Array(3);
  private readonly driftTo = new Float64Array(3);
  private readonly amp: Env;
  private readonly fenv: Env;
  // the ladder's four stages
  private s1 = 0;
  private s2 = 0;
  private s3 = 0;
  private s4 = 0;
  private G = 0.5;
  private k = 0;
  private freq = 440;
  private vib = 0;
  private counter = 0;
  private killing = 0;
  private readonly noise: Noise;
  private readonly p: FatParams;
  private readonly sr: number;
  private readonly pan: number;
  private readonly driftCoef: number;
  /** Ratios of the second and third oscillators to the first. */
  private r2 = 1;
  private r3 = 0.5;

  constructor(p: FatParams, key: number, from: number, velocity: number, sr: number, seed: number, pan: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.target = key;
    this.pitch = from;
    this.vel = velocity / 127;
    this.pan = pan;
    this.noise = new Noise(seed * 7919 + 17);
    this.amp = new Env(sr);
    this.fenv = new Env(sr);
    this.retime();
    this.amp.gate(true);
    this.fenv.gate(true);
    this.driftCoef = 1 - Math.exp(-1 / (0.4 * sr));
    for (let i = 0; i < 3; i++) {
      this.phase[i] = ((seed * (i + 5)) % 89) / 89;
      this.noise.step();
      this.drift[i] = this.noise.value * p.drift;
      this.driftTo[i] = this.drift[i] as number;
    }
  }

  /** The envelopes' times from the knobs (as they are now). */
  retime(): void {
    const p = this.p;
    this.amp.set(p.aA, p.aD, p.aS, p.aR);
    this.fenv.set(p.fA, p.decay, p.fS, Math.max(p.fR, p.aR));
  }

  /** Played legato: on to another note, gliding if it may, the envelopes carrying on. */
  glideTo(key: number, glide: boolean): void {
    this.key = key;
    this.target = key;
    this.sustained = false;
    if (!glide) this.pitch = key;
  }

  /** Struck again while it rings out: from where its envelopes are, at the new note. */
  retrigger(key: number, velocity: number): void {
    this.key = key;
    this.target = key;
    this.pitch = key;
    this.vel = velocity / 127;
    this.released = false;
    this.sustained = false;
    // a hard stop's fade (all notes off) gives way to the note played
    this.killing = 0;
    this.amp.gate(true);
    this.fenv.gate(true);
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
    const amp = this.amp;
    const fenv = this.fenv;
    const noise = this.noise;
    const phase = this.phase;
    const velGain = 1 - p.velAmp + p.velAmp * this.vel * this.vel;
    const gain = p.level * velGain * ctl.expression;
    const gl = gain * Math.min(1, 1 - this.pan);
    const gr = gain * Math.min(1, 1 + this.pan);
    const glideCoef = p.glide > 0 ? 1 - Math.exp(-3 / (p.glide * sr)) : 1;
    const driveGain = (0.6 + p.drive * 3.4) * 0.4;
    const m3 = p.wave3;
    const ln2c = Math.LN2 / 1200;
    for (let i = start; i < end; i++) {
      // glide in pitch, not in hertz
      if (this.pitch !== this.target) {
        this.pitch += (this.target - this.pitch) * glideCoef;
        if (Math.abs(this.target - this.pitch) < 1e-4) this.pitch = this.target;
      }
      fenv.step();
      if ((this.counter++ & 7) === 0) {
        // every eighth sample: the pitch (vibrato from the mod wheel), the drift, the filter
        this.vib += (8 * 5.5) / sr;
        if (this.vib >= 1) this.vib -= 1;
        const vib = ctl.mod > 0 ? Math.sin(TAU * this.vib) * 0.35 * ctl.mod : 0;
        this.freq = 440 * 2 ** ((this.pitch - 69 + ctl.bend + vib) / 12);
        if ((this.counter & 1023) < 8) {
          for (let o = 0; o < 3; o++) {
            noise.step();
            this.driftTo[o] = noise.value * p.drift;
          }
        }
        for (let o = 0; o < 3; o++) {
          const d = this.drift[o] as number;
          this.drift[o] = d + ((this.driftTo[o] as number) - d) * this.driftCoef * 8;
        }
        // small detunes: 2^(c/1200) is 1 + c ln2/1200 to well within a hundredth of a cent
        const d0 = 1 + (this.drift[0] as number) * ln2c;
        this.r2 = (1 + (p.detune + (this.drift[1] as number)) * ln2c) / d0;
        this.r3 = (2 ** p.oct3 * (1 + (this.drift[2] as number) * ln2c)) / d0;
        this.freq *= d0;
        const fe = fenv.level;
        const cutoff =
          p.cutoff *
          2 ** (p.contour * 6 * fe + (p.keytrack * (this.pitch - 60)) / 12 + p.velFilter * (this.vel - 0.75));
        const g = Math.tan((Math.PI * Math.min(Math.max(cutoff, 20), sr * 0.45)) / sr);
        this.G = g / (1 + g);
        this.k = p.emphasis * 3.96;
      }
      // the three oscillators: band-limited (polyBLEP) saws and square
      let x = 0;
      for (let o = 0; o < 3; o++) {
        const dt = (this.freq * (o === 0 ? 1 : o === 1 ? this.r2 : this.r3)) / sr;
        let ph = (phase[o] as number) + dt;
        ph -= Math.floor(ph);
        phase[o] = ph;
        let b: number;
        if (ph < dt) {
          const t = ph / dt;
          b = t + t - t * t - 1;
        } else if (ph > 1 - dt) {
          const t = (ph - 1) / dt;
          b = t * t + t + t + 1;
        } else b = 0;
        let v: number;
        if (o === 2 && m3 === 1) {
          v = (ph < 0.5 ? 1 : -1) + b;
          const h = ph < 0.5 ? ph + 0.5 : ph - 0.5;
          let c: number;
          if (h < dt) {
            const t = h / dt;
            c = t + t - t * t - 1;
          } else if (h > 1 - dt) {
            const t = (h - 1) / dt;
            c = t * t + t + t + 1;
          } else c = 0;
          v -= c;
        } else v = 2 * ph - 1 - b;
        x += v * (o === 0 ? p.mix1 : o === 1 ? p.mix2 : p.mix3);
      }
      if (p.noise > 0) {
        noise.step();
        x += noise.value * p.noise;
      }
      x *= driveGain;
      // the ladder: four one-pole stages, the feedback solved at once (no delay), its input saturating
      const G = this.G;
      const k = this.k;
      const one = 1 - G;
      const G2 = G * G;
      const G4 = G2 * G2;
      const S = (G2 * G * this.s1 + G2 * this.s2 + G * this.s3 + this.s4) * one;
      let u = x - (k * (G4 * x + S)) / (1 + k * G4);
      // tanh, as a rational curve (the transistors)
      u = u < -3 ? -1 : u > 3 ? 1 : (u * (27 + u * u)) / (27 + 9 * u * u);
      let v = (u - this.s1) * G;
      const y1 = v + this.s1;
      this.s1 = y1 + v;
      v = (y1 - this.s2) * G;
      const y2 = v + this.s2;
      this.s2 = y2 + v;
      v = (y2 - this.s3) * G;
      const y3 = v + this.s3;
      this.s3 = y3 + v;
      v = (y3 - this.s4) * G;
      const y4 = v + this.s4;
      this.s4 = y4 + v;
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
      // the resonance thins the bass, as the ladder's does: a third of it made up
      const y = y4 * (1 + 0.33 * k) * a;
      l[i] = (l[i] as number) + y * gl;
      r[i] = (r[i] as number) + y * gr;
    }
  }
}

export class FatSynth extends Instrument {
  private readonly p: FatParams;
  private readonly preset: string;
  private seed = 1;
  /** Fat Mono: the keys held, the last on top, and its one voice. */
  private readonly held: number[] = [];
  private mono: FatVoice | null = null;
  /** Fat Poly: the last note played (a new one glides from it). */
  private last = -1;

  constructor(sr: number, preset: string, params?: Record<string, number>) {
    super(sr);
    this.preset = preset;
    this.p = resolve(preset, params);
    this.maxVoices = this.p.mono ? 4 : 16;
  }

  /** New settings from the knobs: the voices sounding follow them. */
  update(params?: Record<string, number>): void {
    const next = resolve(this.preset, params);
    Object.assign(this.p, next);
    for (const v of this.voices as FatVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice {
    const p = this.p;
    const from = p.glide > 0 && this.last >= 0 ? this.last : key;
    this.last = key;
    const pan = p.spread * (((this.seed % 3) - 1) * 0.5);
    return new FatVoice(p, key, from, velocity, this.sr, this.seed++, pan);
  }

  override noteOn(key: number, velocity: number, art = 0): void {
    if (!this.p.mono) {
      super.noteOn(key, velocity, art);
      return;
    }
    if (velocity <= 0) {
      this.noteOff(key);
      return;
    }
    const at = this.held.indexOf(key);
    if (at >= 0) this.held.splice(at, 1);
    this.held.push(key);
    const v = this.mono;
    if (v && !v.done && !v.released) {
      v.glideTo(key, this.p.glide > 0);
      return;
    }
    if (v && !v.done) {
      v.retrigger(key, velocity);
      return;
    }
    const voice = new FatVoice(this.p, key, key, velocity, this.sr, this.seed++, 0);
    this.mono = voice;
    this.addVoice(voice);
  }

  override noteOff(key: number): void {
    if (!this.p.mono) {
      super.noteOff(key);
      return;
    }
    const at = this.held.indexOf(key);
    if (at >= 0) this.held.splice(at, 1);
    const v = this.mono;
    if (!v || v.done || v.released || v.key !== key) return;
    // back to the note still held, as the originals do
    const back = this.held[this.held.length - 1];
    if (back !== undefined) v.glideTo(back, this.p.glide > 0);
    else if (this.sustain) v.sustained = true;
    else v.release();
  }

  override allNotesOff(hard: boolean): void {
    this.held.length = 0;
    super.allNotesOff(hard);
  }
}
