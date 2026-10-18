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
  /** The kind as a number, for the per-sample switch. */
  k: number;
  freq: number;
  decay: number;
  level: number;
}

const KIND_NUMBERS: Record<Kind, number> = {
  kick: 0,
  snare: 1,
  stick: 2,
  clap: 3,
  hat: 4,
  tom: 5,
  cymbal: 6,
  ride: 7,
  bell: 8,
  tamb: 9,
  cowbell: 10,
  hand: 11,
  wood: 12,
  shaker: 13,
};

function hitFor(key: number): Hit {
  const h = describe(key);
  return { ...h, k: KIND_NUMBERS[h.kind] };
}

/** Every key's hit, made once: a hit on the audio thread allocates nothing. */
const HITS: Hit[] = Array.from({ length: 128 }, (_, key) => hitFor(key));

function describe(key: number): Omit<Hit, 'k'> {
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
/** Works out each voice's filter coefficients (set() only: no sample ever runs through it). */
const COEF = new Biquad();

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
  private readonly decayCoef: number;
  private env = 1;
  private choke = 0;
  private readonly gain: number;
  /**
   * Its two filters (the hit's colour, then a low-pass), as coefficients and state in the voice: run
   * in line each sample, since a call V8 doesn't inline boxes every double it passes or returns.
   */
  private readonly fb0: number;
  private readonly fb1: number;
  private readonly fb2: number;
  private readonly fa1: number;
  private readonly fa2: number;
  private fz1 = 0;
  private fz2 = 0;
  private readonly gb0: number;
  private readonly gb1: number;
  private readonly gb2: number;
  private readonly ga1: number;
  private readonly ga2: number;
  private gz1 = 0;
  private gz2 = 0;

  private hit: Hit;
  private readonly kind: number;
  /** The metal's pitch scale (hats and cymbals: the hit's; the bell's own). */
  private readonly metalScale: number;
  private sr: number;
  /** The last sample sample() made, and the last mean metallic() made (fields: a returned double is boxed unless inlined). */
  private y = 0;
  private m = 0;
  constructor(key: number, velocity: number, hit: Hit, sr: number, seed: number) {
    this.hit = hit;
    this.kind = hit.k;
    this.metalScale = hit.kind === 'bell' ? 1.8 : hit.freq;
    this.sr = sr;
    this.key = key;
    this.noise = new Noise(seed * 2654435761);
    this.decayCoef = Math.exp(-6.9 / (hit.decay * sr));
    this.gain = hit.level * (0.15 + 0.85 * (velocity / 127) ** 1.6);
    const k = hit.kind;
    // the coefficients come from one scratch Biquad (a hit allocates only its voice)
    const filter = COEF;
    if (k === 'snare') filter.set('bandpass', 3200, 0.7, 0, sr);
    else if (k === 'clap') filter.set('bandpass', 1100, 1.2, 0, sr);
    else if (k === 'hat' || k === 'tamb' || k === 'shaker') filter.set('highpass', 7000, 0.7, 0, sr);
    else if (k === 'cymbal' || k === 'ride' || k === 'bell') filter.set('highpass', 4200 * hit.freq, 0.6, 0, sr);
    else if (k === 'cowbell') filter.set('bandpass', 800, 2, 0, sr);
    else if (k === 'stick') filter.set('bandpass', 2200, 1.5, 0, sr);
    else filter.set('highpass', 3000, 0.7, 0, sr);
    this.fb0 = filter.b0;
    this.fb1 = filter.b1;
    this.fb2 = filter.b2;
    this.fa1 = filter.a1;
    this.fa2 = filter.a2;
    const filter2 = COEF;
    filter2.set('lowpass', 11000, 0.7, 0, sr);
    this.gb0 = filter2.b0;
    this.gb1 = filter2.b1;
    this.gb2 = filter2.b2;
    this.ga1 = filter2.a1;
    this.ga2 = filter2.a2;
  }

  /** The hit's filter on one sample (Biquad.tick): `fx` in, `fy` out. */
  private fx = 0;
  private fy = 0;
  private filter(): void {
    const x = this.fx;
    const y = this.fb0 * x + this.fz1;
    this.fz1 = this.fb1 * x - this.fa1 * y + this.fz2;
    this.fz2 = this.fb2 * x - this.fa2 * y;
    this.fy = y;
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

  /** Six square-wave partials at the metal's ratios: their mean, into `m`. */
  private metallic(): void {
    const scale = this.metalScale;
    let s = 0;
    for (let i = 0; i < 6; i++) {
      let p = (this.metal[i] as number) + ((METAL[i] as number) * scale * 2.1) / this.sr;
      p -= Math.floor(p);
      this.metal[i] = p;
      s += p < 0.5 ? 1 : -1;
    }
    this.m = s / 6;
  }

  /** One sample of the hit before its envelope, into `y` (the kinds in KIND_NUMBERS' order). */
  private sample(): void {
    const h = this.hit;
    const t = this.t / this.sr;
    const noise = this.noise;
    noise.step();
    const n = noise.value;
    switch (this.kind) {
      case 0: {
        // kick
        const f = h.freq + 110 * Math.exp(-t / 0.035);
        this.phase += f / this.sr;
        const click = t < 0.003 ? n * (1 - t / 0.003) * 0.4 : 0;
        this.y = Math.sin(TAU * this.phase) * 1.1 + click;
        return;
      }
      case 5:
      case 11: {
        // tom, hand
        const f = h.freq * (1 + 0.6 * Math.exp(-t / 0.03));
        this.phase += f / this.sr;
        this.y = Math.sin(TAU * this.phase) + (t < 0.004 ? n * 0.2 : 0);
        return;
      }
      case 1: {
        // snare
        this.phase += (h.freq * (1 + 0.3 * Math.exp(-t / 0.02))) / this.sr;
        const tone = Math.sin(TAU * this.phase) * Math.exp(-t / 0.05);
        this.fx = n;
        this.filter();
        this.y = tone * 0.7 + this.fy * 1.3;
        return;
      }
      case 2: {
        // stick
        this.phase += h.freq / this.sr;
        const tone = Math.sin(TAU * this.phase) * 0.5;
        this.fx = n;
        this.filter();
        this.y = tone + this.fy * 1.5;
        return;
      }
      case 3: {
        // clap
        const bursts = t < 0.03 ? Math.exp(-((t * 1000) % 10) / 2.5) : 1;
        this.fx = n;
        this.filter();
        this.y = this.fy * 2 * bursts;
        return;
      }
      case 4:
      case 6:
      case 7:
        // hat, cymbal, ride
        this.metallic();
        this.fx = this.m * 0.8 + n * 0.5;
        this.filter();
        this.y = this.fy * 1.6;
        return;
      case 8:
        // bell
        this.metallic();
        this.fx = this.m;
        this.filter();
        this.y = this.fy * 1.6;
        return;
      case 9:
      case 13:
        // tamb, shaker
        this.fx = n;
        this.filter();
        this.y = this.fy * (1 + 0.5 * Math.sin(TAU * t * 40));
        return;
      case 10: {
        // cowbell
        this.phase += h.freq / this.sr;
        const p2 = (this.phase * 800) / 540;
        const sq = (this.phase % 1 < 0.5 ? 1 : -1) + (p2 % 1 < 0.5 ? 1 : -1);
        this.fx = sq;
        this.filter();
        this.y = this.fy * 1.2;
        return;
      }
      default: {
        // wood
        this.phase += h.freq / this.sr;
        this.y = Math.sin(TAU * this.phase) * 1.2;
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
      this.sample();
      // the low-pass (Biquad.tick, in line)
      const x = this.y;
      const f = this.gb0 * x + this.gz1;
      this.gz1 = this.gb1 * x - this.ga1 * f + this.gz2;
      this.gz2 = this.gb2 * x - this.ga2 * f;
      const y = f * this.env * attack * g;
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
    return new DrumVoice(key, velocity, HITS[key] ?? hitFor(key), this.sr, this.seed++);
  }
  override noteOff(): void {
    // drums ring out whatever the pad does
  }
}
