/**
 * A synthesised drum kit on the General MIDI drum map, so drum pads play something the moment
 * they're plugged in: kicks, snares, claps, hats (the closed hat chokes the open one), toms,
 * cymbals, a cowbell, hand drums and wood.
 */
import { Biquad, Noise } from './dsp.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

type Kind =
  | 'kick'
  | 'snare'
  | 'stick'
  | 'clap'
  | 'hat'
  | 'tom'
  | 'cymbal'
  | 'ride'
  | 'bell'
  | 'tamb'
  | 'cowbell'
  | 'hand'
  | 'wood'
  | 'shaker';

interface Hit {
  kind: Kind;
  freq: number;
  decay: number;
  level: number;
}

function hitFor(key: number): Hit {
  switch (key) {
    case 35:
      return { kind: 'kick', freq: 42, decay: 0.5, level: 1 };
    case 36:
      return { kind: 'kick', freq: 50, decay: 0.42, level: 1 };
    case 37:
      return { kind: 'stick', freq: 420, decay: 0.05, level: 0.6 };
    case 38:
      return { kind: 'snare', freq: 190, decay: 0.2, level: 0.8 };
    case 40:
      return { kind: 'snare', freq: 220, decay: 0.16, level: 0.8 };
    case 39:
      return { kind: 'clap', freq: 1200, decay: 0.18, level: 0.7 };
    case 42:
      return { kind: 'hat', freq: 1, decay: 0.05, level: 0.35 };
    case 44:
      return { kind: 'hat', freq: 1, decay: 0.09, level: 0.3 };
    case 46:
      return { kind: 'hat', freq: 1, decay: 0.5, level: 0.32 };
    case 41:
    case 43:
    case 45:
    case 47:
    case 48:
    case 50: {
      const index = [41, 43, 45, 47, 48, 50].indexOf(key);
      return { kind: 'tom', freq: 75 * 1.2 ** index, decay: 0.45 - index * 0.04, level: 0.85 };
    }
    case 49:
    case 57:
      return { kind: 'cymbal', freq: 1, decay: 1.8, level: 0.3 };
    case 52:
      return { kind: 'cymbal', freq: 1.3, decay: 1.2, level: 0.32 };
    case 55:
      return { kind: 'cymbal', freq: 1.5, decay: 0.7, level: 0.28 };
    case 51:
    case 59:
      return { kind: 'ride', freq: 1, decay: 1.4, level: 0.22 };
    case 53:
      return { kind: 'bell', freq: 1, decay: 1.1, level: 0.25 };
    case 54:
      return { kind: 'tamb', freq: 1, decay: 0.22, level: 0.3 };
    case 56:
      return { kind: 'cowbell', freq: 540, decay: 0.3, level: 0.35 };
    case 60:
    case 61:
    case 62:
    case 63:
    case 64:
      return { kind: 'hand', freq: [400, 300, 330, 260, 190][key - 60] ?? 300, decay: 0.2, level: 0.6 };
    case 69:
    case 70:
      return { kind: 'shaker', freq: 1, decay: 0.08, level: 0.25 };
    case 75:
      return { kind: 'wood', freq: 2500, decay: 0.04, level: 0.45 };
    case 76:
      return { kind: 'wood', freq: 1500, decay: 0.06, level: 0.5 };
    case 77:
      return { kind: 'wood', freq: 1100, decay: 0.07, level: 0.5 };
    default:
      return { kind: 'tom', freq: 110 * 2 ** ((key - 45) / 24), decay: 0.25, level: 0.6 };
  }
}

const TAU = Math.PI * 2;
const METAL = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];

class DrumVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private t = 0;
  private phase = 0;
  private metal = new Float64Array(6);
  private readonly noise: Noise;
  private readonly filter = new Biquad();
  private readonly filter2 = new Biquad();
  private readonly decayCoef: number;
  private env = 1;
  private choke = 0;
  private readonly gain: number;

  private hit: Hit;
  private sr: number;
  constructor(key: number, velocity: number, hit: Hit, sr: number, seed: number) {
    this.hit = hit;
    this.sr = sr;
    this.key = key;
    this.noise = new Noise(seed * 2654435761);
    this.decayCoef = Math.exp(-6.9 / (hit.decay * sr));
    this.gain = hit.level * (0.15 + 0.85 * (velocity / 127) ** 1.6);
    const k = hit.kind;
    if (k === 'snare') this.filter.set('bandpass', 3200, 0.7, 0, sr);
    else if (k === 'clap') this.filter.set('bandpass', 1100, 1.2, 0, sr);
    else if (k === 'hat' || k === 'tamb' || k === 'shaker') this.filter.set('highpass', 7000, 0.7, 0, sr);
    else if (k === 'cymbal' || k === 'ride' || k === 'bell') this.filter.set('highpass', 4200 * hit.freq, 0.6, 0, sr);
    else if (k === 'cowbell') this.filter.set('bandpass', 800, 2, 0, sr);
    else if (k === 'stick') this.filter.set('bandpass', 2200, 1.5, 0, sr);
    else this.filter.set('highpass', 3000, 0.7, 0, sr);
    this.filter2.set('lowpass', 11000, 0.7, 0, sr);
  }

  release(): void {
    this.released = true;
  }
  kill(): void {
    this.released = true;
    this.choke = 1;
  }
  /** The closed hat stops an open one. */
  chokeHat(): void {
    if (this.hit.kind === 'hat' && this.hit.decay > 0.2) this.choke = 1;
  }

  private metallic(scale: number): number {
    let s = 0;
    for (let i = 0; i < 6; i++) {
      let p = (this.metal[i] as number) + ((METAL[i] as number) * scale * 2.1) / this.sr;
      p -= Math.floor(p);
      this.metal[i] = p;
      s += p < 0.5 ? 1 : -1;
    }
    return s / 6;
  }

  private sample(): number {
    const h = this.hit;
    const t = this.t / this.sr;
    const n = this.noise.next();
    switch (h.kind) {
      case 'kick': {
        const f = h.freq + 110 * Math.exp(-t / 0.035);
        this.phase += f / this.sr;
        const click = t < 0.003 ? n * (1 - t / 0.003) * 0.4 : 0;
        return Math.sin(TAU * this.phase) * 1.1 + click;
      }
      case 'tom':
      case 'hand': {
        const f = h.freq * (1 + 0.6 * Math.exp(-t / 0.03));
        this.phase += f / this.sr;
        return Math.sin(TAU * this.phase) + (t < 0.004 ? n * 0.2 : 0);
      }
      case 'snare': {
        this.phase += (h.freq * (1 + 0.3 * Math.exp(-t / 0.02))) / this.sr;
        const tone = Math.sin(TAU * this.phase) * Math.exp(-t / 0.05);
        return tone * 0.7 + this.filter.tick(n) * 1.3;
      }
      case 'stick': {
        this.phase += h.freq / this.sr;
        return Math.sin(TAU * this.phase) * 0.5 + this.filter.tick(n) * 1.5;
      }
      case 'clap': {
        const bursts = t < 0.03 ? Math.exp(-((t * 1000) % 10) / 2.5) : 1;
        return this.filter.tick(n) * 2 * bursts;
      }
      case 'hat':
      case 'cymbal':
      case 'ride':
        return this.filter.tick(this.metallic(h.freq) * 0.8 + n * 0.5) * 1.6;
      case 'bell':
        return this.filter.tick(this.metallic(1.8)) * 1.6;
      case 'tamb':
      case 'shaker':
        return this.filter.tick(n) * (1 + 0.5 * Math.sin(TAU * t * 40));
      case 'cowbell': {
        this.phase += h.freq / this.sr;
        const p2 = (this.phase * 800) / 540;
        const sq = (this.phase % 1 < 0.5 ? 1 : -1) + (p2 % 1 < 0.5 ? 1 : -1);
        return this.filter.tick(sq) * 1.2;
      }
      case 'wood': {
        this.phase += h.freq / this.sr;
        return Math.sin(TAU * this.phase) * 1.2;
      }
    }
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const g = this.gain * ctl.expression;
    for (let i = start; i < end; i++) {
      this.env *= this.decayCoef;
      if (this.choke > 0) {
        this.choke *= 0.99;
        this.env *= this.choke;
      }
      if (this.env < 1e-4) {
        this.done = true;
        return;
      }
      const attack = this.t < 48 ? this.t / 48 : 1;
      const y = this.filter2.tick(this.sample()) * this.env * attack * g;
      this.t++;
      l[i] = (l[i] as number) + y;
      r[i] = (r[i] as number) + y;
    }
  }
}

export class DrumSynth extends Instrument {
  private seed = 1;
  constructor(sr: number) {
    super(sr);
    this.maxVoices = 48;
  }
  protected startVoice(key: number, velocity: number): Voice {
    if (key === 42 || key === 44) for (const v of this.voices) (v as DrumVoice).chokeHat?.();
    return new DrumVoice(key, velocity, hitFor(key), this.sr, this.seed++);
  }
  override noteOff(): void {
    // drums ring out whatever the pad does
  }
}
