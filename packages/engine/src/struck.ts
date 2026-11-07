/**
 * Struck: big drums and struck metal, each a set of modes (the shapes a membrane, a plate or a bar
 * rings in, at their own frequencies and rates of decay), struck by a stick whose hardness decides
 * how much of the upper modes it wakes.
 *
 * - Taiko: a deep barrel drum: a stretched skin's modes, the pitch falling as the skin settles after
 *   the blow, and the slap of the stick.
 * - War Drums: several big low drums struck together, a little apart in time and tuning (Ensemble),
 *   for a massed thunder.
 * - Frame Drum: a shallow skin drum, more skin and less boom.
 * - Opera Gongs: hand gongs whose pitch slides after the strike: down for the low gongs, up for the
 *   small high ones, as the opera's gongs do.
 * - Anvil: a struck steel block: a hard ring of high inharmonic modes.
 *
 * Every key plays the instrument at that pitch. Its six knobs (SYNTH_MACROS) move while it plays.
 */
import { macroValues } from '@holo/session';
import { Noise } from './dsp.ts';
import { Hall } from './ethereal.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

interface StruckParams {
  // the knobs
  tune: number;
  decay: number;
  hardness: number;
  tone: number;
  ensemble: number;
  space: number;
  // the preset's
  ratios: number[];
  /** Each mode's level when struck at middle hardness. */
  amps: number[];
  /** Seconds the lowest mode rings (to -60 dB); higher modes die faster by `damping`. */
  ring: number;
  damping: number;
  /** Pitch glide after the strike: semitones (signed: up is positive) and seconds; `glideByKey`
   * flips it to fall below middle C and rise above (the opera gongs). */
  glide: number;
  glideTime: number;
  glideByKey: number;
  /** The stick's slap: noise level and its band (hertz). */
  slap: number;
  slapBand: number;
  level: number;
}

const MEMBRANE = [1, 1.594, 2.136, 2.296, 2.653, 2.918, 3.156, 3.501];

type Preset = Omit<StruckParams, 'tune' | 'decay' | 'hardness' | 'tone' | 'ensemble' | 'space'>;

const PRESETS: Record<string, Preset> = {
  Taiko: {
    ratios: MEMBRANE,
    amps: [1, 0.55, 0.35, 0.25, 0.2, 0.14, 0.1, 0.08],
    ring: 1.6,
    damping: 2.2,
    glide: -2,
    glideTime: 0.09,
    glideByKey: 0,
    slap: 0.35,
    slapBand: 1800,
    level: 0.15,
  },
  'War Drums': {
    ratios: MEMBRANE,
    amps: [1, 0.6, 0.35, 0.3, 0.2, 0.15, 0.1, 0.08],
    ring: 2.4,
    damping: 2.5,
    glide: -2.5,
    glideTime: 0.12,
    glideByKey: 0,
    slap: 0.25,
    slapBand: 1200,
    level: 0.24,
  },
  'Frame Drum': {
    ratios: MEMBRANE,
    amps: [0.7, 0.6, 0.5, 0.45, 0.4, 0.3, 0.25, 0.2],
    ring: 0.7,
    damping: 2,
    glide: -1,
    glideTime: 0.05,
    glideByKey: 0,
    slap: 0.6,
    slapBand: 2600,
    level: 0.15,
  },
  'Opera Gongs': {
    ratios: [1, 1.42, 2.11, 2.73, 3.42, 4.31, 5.12, 6.03],
    amps: [1, 0.5, 0.45, 0.3, 0.25, 0.18, 0.12, 0.1],
    ring: 3.5,
    damping: 1.3,
    glide: 3,
    glideTime: 0.35,
    glideByKey: 1,
    slap: 0.2,
    slapBand: 4000,
    level: 0.2,
  },
  Anvil: {
    ratios: [1, 2.756, 5.404, 8.933, 13.34, 18.64, 1.009, 2.77],
    amps: [0.7, 1, 0.8, 0.55, 0.4, 0.25, 0.5, 0.6],
    ring: 2.2,
    damping: 1.1,
    glide: 0,
    glideTime: 0.1,
    glideByKey: 0,
    slap: 0.5,
    slapBand: 6000,
    level: 0.1,
  },
};

export const STRUCK_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): StruckParams {
  const name = PRESETS[preset] ? preset : 'Taiko';
  return { ...(PRESETS[name] as Preset), ...macroValues(name, params) } as StruckParams;
}

const TAU = Math.PI * 2;
const MODES = 8;
const MAX_PLAYERS = 4;

class StruckVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  // every player's modes: two-pole resonators struck once each
  private readonly y1 = new Float64Array(MAX_PLAYERS * MODES);
  private readonly y2 = new Float64Array(MAX_PLAYERS * MODES);
  private readonly c = new Float64Array(MAX_PLAYERS * MODES);
  private readonly rr = new Float64Array(MAX_PLAYERS * MODES);
  private readonly strikeAmp = new Float64Array(MAX_PLAYERS * MODES);
  /** Each player's moment (samples after the note), tuning and place. */
  private readonly at = new Int32Array(MAX_PLAYERS);
  private readonly detune = new Float64Array(MAX_PLAYERS);
  private readonly panL = new Float64Array(MAX_PLAYERS);
  private readonly panR = new Float64Array(MAX_PLAYERS);
  private readonly slapEnv = new Float64Array(MAX_PLAYERS);
  private readonly noise: Noise;
  private readonly p: StruckParams;
  private readonly sr: number;
  private readonly vel: number;
  private readonly players: number;
  private t = 0;
  private counter = 0;
  private glide = 0;
  private bp1 = 0;
  private bp2 = 0;
  private quiet = 0;
  private killing = 0;

  constructor(p: StruckParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.vel = velocity / 127;
    this.noise = new Noise(seed * 1999 + 23);
    this.players = 1 + Math.round(p.ensemble * (MAX_PLAYERS - 1));
    for (let j = 0; j < this.players; j++) {
      this.noise.step();
      this.at[j] = j === 0 ? 0 : Math.round((0.006 + 0.012 * j + Math.abs(this.noise.value) * 0.008) * sr);
      this.noise.step();
      this.detune[j] = j === 0 ? 1 : 1 + this.noise.value * 0.03;
      const pan = this.players === 1 ? 0 : ((j / (this.players - 1)) * 2 - 1) * 0.6;
      this.panL[j] = Math.min(1, 1 - pan);
      this.panR[j] = Math.min(1, 1 + pan);
    }
    // the glide's direction: the opera gongs fall below middle C and rise above
    const dir = p.glideByKey > 0 ? (key < 60 ? -1 : 1) : 1;
    this.glide = p.glide * dir * (0.6 + 0.4 * this.vel);
    this.retune();
  }

  /** The modes' frequencies and decays (as the glide stands now). */
  private retune(): void {
    const p = this.p;
    const sr = this.sr;
    const base = 440 * 2 ** ((this.key - 69 + p.tune + this.glide) / 12);
    for (let j = 0; j < this.players; j++) {
      for (let m = 0; m < MODES; m++) {
        const k = j * MODES + m;
        const ratio = p.ratios[m] ?? m + 1;
        const f = Math.min(base * ratio * (this.detune[j] as number), sr * 0.45);
        const t60 = (p.ring * p.decay) / ratio ** (p.damping * 0.5);
        const r = Math.exp(-6.91 / Math.max(1, t60 * sr));
        this.rr[k] = r * r;
        this.c[k] = 2 * r * Math.cos((TAU * f) / sr);
        if (f >= sr * 0.45) this.c[k] = 0;
      }
    }
  }

  retime(): void {
    this.retune();
  }

  release(): void {
    // a struck instrument rings on (a let-go note doesn't stop a drum)
    this.released = true;
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  /** A player's stick lands: every mode struck, the upper ones more as it's harder. */
  private strike(j: number): void {
    const p = this.p;
    const hard = 0.2 + 1.6 * p.hardness * (0.5 + 0.5 * this.vel);
    const amp = 0.3 + 0.7 * this.vel ** 1.2;
    for (let m = 0; m < MODES; m++) {
      const k = j * MODES + m;
      const ratio = p.ratios[m] ?? m + 1;
      const a = (p.amps[m] ?? 0) * amp * Math.min(1.5, hard ** Math.log2(Math.max(1, ratio)));
      // an impulse into the resonator: a·sin(ω), so the mode rings at about `a`
      const cosw = (this.c[k] as number) / (2 * Math.sqrt(this.rr[k] as number));
      this.y1[k] = (this.y1[k] as number) + a * Math.sqrt(Math.max(0, 1 - cosw * cosw));
    }
    this.slapEnv[j] = p.slap * (0.3 + 0.7 * p.hardness) * amp;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const p = this.p;
    const sr = this.sr;
    const noise = this.noise;
    const gain = p.level * ctl.expression;
    const glideK = Math.exp(-16 / (p.glideTime * sr));
    const slapK = Math.exp(-1 / (0.012 * sr));
    const bw = Math.exp((-Math.PI * p.slapBand * 0.8) / sr);
    const bc = 2 * bw * Math.cos((TAU * Math.min(p.slapBand, sr * 0.45)) / sr);
    const bg = (1 - bw) * 2;
    const players = this.players;
    for (let i = start; i < end; i++) {
      const t = this.t++;
      for (let j = 0; j < players; j++) if (t === (this.at[j] as number)) this.strike(j);
      if ((this.counter++ & 15) === 0 && this.glide !== 0) {
        this.glide *= glideK;
        if (Math.abs(this.glide) < 0.002) this.glide = 0;
        this.retune();
      }
      let xl = 0;
      let xr = 0;
      let slap = 0;
      for (let j = 0; j < players; j++) {
        let s = 0;
        const o = j * MODES;
        for (let m = 0; m < MODES; m++) {
          const k = o + m;
          const y = (this.c[k] as number) * (this.y1[k] as number) - (this.rr[k] as number) * (this.y2[k] as number);
          this.y2[k] = this.y1[k] as number;
          this.y1[k] = y;
          s += y;
        }
        const e = this.slapEnv[j] as number;
        if (e > 1e-5) {
          slap += e;
          this.slapEnv[j] = e * slapK;
        }
        xl += s * (this.panL[j] as number);
        xr += s * (this.panR[j] as number);
      }
      if (slap > 0) {
        // the stick's slap: a band of noise
        noise.step();
        const y = bc * this.bp1 - bw * bw * this.bp2 + noise.value * bg;
        this.bp2 = this.bp1;
        this.bp1 = y;
        xl += y * slap;
        xr += y * slap;
      }
      let g = gain / Math.sqrt(players);
      if (this.killing > 0) {
        this.killing *= 0.995;
        g *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      l[i] = (l[i] as number) + xl * g;
      r[i] = (r[i] as number) + xr * g;
      const a = Math.abs(xl) + Math.abs(xr);
      this.quiet = a > 2e-5 || t < (this.at[players - 1] as number) + 64 ? 0 : this.quiet + 1;
      if (this.quiet > 512) {
        this.done = true;
        return;
      }
    }
  }
}

export class StruckSynth extends Instrument {
  private readonly p: StruckParams;
  private readonly preset: string;
  private seed = 1;
  private dryL = new Float32Array(0);
  private dryR = new Float32Array(0);
  private readonly hall: Hall;
  private tail = 0;
  private toneL = 0;
  private toneR = 0;

  constructor(sr: number, preset: string, params?: Record<string, number>) {
    super(sr);
    this.preset = preset;
    this.p = resolve(preset, params);
    this.maxVoices = 24;
    this.hall = new Hall(sr);
    this.hall.setDecay(1.5 + 6 * this.p.space);
  }

  update(params?: Record<string, number>): void {
    Object.assign(this.p, resolve(this.preset, params));
    this.hall.setDecay(1.5 + 6 * this.p.space);
    for (const v of this.voices as StruckVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice {
    return new StruckVoice(this.p, key, velocity, this.sr, this.seed++);
  }

  override get active(): number {
    return super.active + (this.tail > 2e-5 ? 1 : 0);
  }

  override render(l: Float32Array, r: Float32Array, start: number, end: number): void {
    if (end > this.dryL.length) {
      this.dryL = new Float32Array(end);
      this.dryR = new Float32Array(end);
    }
    const dl = this.dryL;
    const dr = this.dryR;
    dl.fill(0, start, end);
    dr.fill(0, start, end);
    super.render(dl, dr, start, end);
    const p = this.p;
    const space = p.space;
    const hall = this.hall;
    const dry = 1 - 0.4 * space;
    const wet = space * 0.85;
    const c = 1 - Math.exp((-TAU * 500 * 2 ** (p.tone * 5)) / this.sr);
    let peak = 0;
    for (let i = start; i < end; i++) {
      this.toneL += ((dl[i] as number) - this.toneL) * c;
      this.toneR += ((dr[i] as number) - this.toneR) * c;
      const xl = this.toneL;
      const xr = this.toneR;
      if (space > 0) {
        hall.process(xl, xr);
        const a = (Math.abs(hall.outL) + Math.abs(hall.outR)) * wet;
        if (a > peak) peak = a;
        l[i] = (l[i] as number) + xl * dry + hall.outL * wet;
        r[i] = (r[i] as number) + xr * dry + hall.outR * wet;
      } else {
        l[i] = (l[i] as number) + xl;
        r[i] = (r[i] as number) + xr;
      }
    }
    this.tail = Math.max(peak, this.tail * 0.9);
  }
}
