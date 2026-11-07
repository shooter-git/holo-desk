/**
 * Drone: evolving textures from a note. A voice is a bank of ten narrow resonators tuned to the
 * note's partials (harmonic for a field of tone or breath, the inharmonic modes of a struck bar for
 * metal, high harmonics for glass), all excited by noise, so each partial is a slowly breathing band
 * of sound rather than a fixed sine. Each partial wanders in level on its own (Motion), and with
 * Density up the partials break into grains: short swells that come and go at random, a sparkle
 * rather than a sustained wash. The partials sit across the stereo field (Width), swell in slowly
 * (Swell) and ring into a hall (Space).
 *
 * Its six knobs (SYNTH_MACROS) move while it plays.
 */
import { macroValues } from '@holo/session';
import { Noise } from './dsp.ts';
import { Hall } from './ethereal.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

interface DroneParams {
  // the knobs
  tone: number;
  motion: number;
  density: number;
  swell: number;
  width: number;
  space: number;
  // the preset's
  ratios: number[];
  /** Each partial's bandwidth in hertz at middle C (narrow rings; wide breathes). */
  bandwidth: number;
  /** How the partials fall off going up (amplitude ∝ 1/n^tilt). */
  tilt: number;
  level: number;
}

type Preset = Omit<DroneParams, 'tone' | 'motion' | 'density' | 'swell' | 'width' | 'space'>;

const PRESETS: Record<string, Preset> = {
  'Drone Field': { ratios: [1, 2, 3, 4, 5, 6, 8, 10, 12, 16], bandwidth: 2.5, tilt: 0.9, level: 1.4 },
  'Drone Metal': {
    ratios: [1, 1.51, 2.76, 3.97, 5.4, 6.9, 8.93, 11.2, 13.34, 17.0],
    bandwidth: 0.8,
    tilt: 0.6,
    level: 1.05,
  },
  'Drone Breath': { ratios: [1, 2, 3, 4, 5, 6, 7, 8, 10, 12], bandwidth: 22, tilt: 0.7, level: 1.05 },
  'Drone Glass': { ratios: [2, 3, 4, 6, 8, 9, 12, 16, 18, 24], bandwidth: 1.2, tilt: 0.35, level: 0.9 },
};

export const DRONE_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): DroneParams {
  const name = PRESETS[preset] ? preset : 'Drone Field';
  return { ...(PRESETS[name] as Preset), ...macroValues(name, params) } as DroneParams;
}

const PARTIALS = 10;
const TAU = Math.PI * 2;

class DroneVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  // each partial: a two-pole resonator (its coefficients and state), its level now and where it's going
  private readonly c = new Float64Array(PARTIALS);
  private readonly rr = new Float64Array(PARTIALS);
  private readonly norm = new Float64Array(PARTIALS);
  private readonly y1 = new Float64Array(PARTIALS);
  private readonly y2 = new Float64Array(PARTIALS);
  private readonly lv = new Float64Array(PARTIALS);
  private readonly to = new Float64Array(PARTIALS);
  private readonly base = new Float64Array(PARTIALS);
  private readonly panL = new Float64Array(PARTIALS);
  private readonly panR = new Float64Array(PARTIALS);
  /** A grain's remaining length (samples) per partial, when Density has them come and go. */
  private readonly grain = new Int32Array(PARTIALS);
  private readonly noise: Noise;
  private readonly p: DroneParams;
  private readonly sr: number;
  private readonly vel: number;
  private env = 0;
  private envUp = 0;
  private envDown = 0;
  private counter = 0;
  private killing = 0;

  constructor(p: DroneParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.vel = velocity / 127;
    this.noise = new Noise(seed * 6007 + 29);
    this.retime();
    for (let j = 0; j < PARTIALS; j++) {
      this.noise.step();
      this.lv[j] = this.to[j] = 0.6 + 0.4 * Math.abs(this.noise.value);
    }
  }

  retime(): void {
    const p = this.p;
    const sr = this.sr;
    const f0 = 440 * 2 ** ((this.key - 69) / 12);
    for (let j = 0; j < PARTIALS; j++) {
      const ratio = p.ratios[j] ?? j + 1;
      const f = f0 * ratio;
      const audible = f < sr * 0.42;
      // narrower bands up high would ring for ever: the bandwidth grows a little with the frequency
      const bw = p.bandwidth * (1 + f / 2000);
      const rad = Math.exp((-Math.PI * bw) / sr);
      this.rr[j] = rad * rad;
      this.c[j] = 2 * rad * Math.cos((TAU * Math.min(f, sr * 0.45)) / sr);
      // noise in, about the same level out whatever the bandwidth or frequency (a two-pole
      // resonator's gain to white noise grows as 1/((1 - r²)·4 sin²ω))
      const w = (TAU * Math.min(f, sr * 0.45)) / sr;
      this.norm[j] = audible ? Math.sqrt(1 - rad * rad) * 2 * Math.sin(w) : 0;
      // Tone tilts the partials: dark keeps the low ones, bright lifts the top
      const tilt = p.tilt + (0.5 - p.tone) * 1.6;
      this.base[j] = 1 / Math.max(1, ratio) ** Math.max(0, tilt);
      const side = (j % 2 ? 1 : -1) * p.width * (0.4 + (0.6 * j) / PARTIALS);
      this.panL[j] = Math.min(1, 1 - side);
      this.panR[j] = Math.min(1, 1 + side);
    }
    this.envUp = 1 - Math.exp(-1 / (Math.max(0.01, p.swell) * sr * 0.4));
    this.envDown = Math.exp(-1 / (Math.max(0.3, p.swell * 0.8 + 0.5) * sr * 0.3));
  }

  release(): void {
    this.released = true;
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const p = this.p;
    const sr = this.sr;
    const noise = this.noise;
    const gain = p.level * (0.5 + 0.5 * this.vel) * ctl.expression * 0.12;
    // levels wander slowly; grains come and go quickly (Density moves between the two)
    const wander = (0.25 + 2.5 * (1 - p.motion)) * (1 - p.density) + 0.025 * p.density;
    const glide = 1 - Math.exp(-64 / (sr * wander));
    for (let i = start; i < end; i++) {
      if ((this.counter++ & 63) === 0) {
        // every 64 samples: each partial's level wanders, and with Density up, grains come and go
        for (let j = 0; j < PARTIALS; j++) {
          noise.step();
          if (p.density > 0.02) {
            let g = this.grain[j] as number;
            if (g > 0) {
              this.grain[j] = g - 64;
            } else if (Math.abs(noise.value) < 0.004 + 0.06 * (1 - p.density)) {
              noise.step();
              g = Math.round((0.05 + 0.4 * Math.abs(noise.value) * (1.2 - p.density)) * sr);
              this.grain[j] = g;
            }
            const on = (this.grain[j] as number) > 0 ? 1 : 1 - p.density;
            noise.step();
            this.to[j] = on * (1 - p.motion * 0.6 + p.motion * 0.6 * Math.abs(noise.value));
          } else if (Math.abs(noise.value) < 0.05) {
            noise.step();
            this.to[j] = 1 - p.motion * 0.8 * Math.abs(noise.value);
          }
          const lv = this.lv[j] as number;
          this.lv[j] = lv + ((this.to[j] as number) - lv) * glide;
        }
      }
      if (this.released) this.env *= this.envDown;
      else this.env += (1 - this.env) * this.envUp;
      noise.step();
      const x = noise.value;
      let sl = 0;
      let sr2 = 0;
      for (let j = 0; j < PARTIALS; j++) {
        const y =
          (this.c[j] as number) * (this.y1[j] as number) -
          (this.rr[j] as number) * (this.y2[j] as number) +
          x * (this.norm[j] as number);
        this.y2[j] = this.y1[j] as number;
        this.y1[j] = y;
        const a = y * (this.lv[j] as number) * (this.base[j] as number);
        sl += a * (this.panL[j] as number);
        sr2 += a * (this.panR[j] as number);
      }
      let g = this.env * gain;
      if (this.killing > 0) {
        this.killing *= 0.995;
        g *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      l[i] = (l[i] as number) + sl * g;
      r[i] = (r[i] as number) + sr2 * g;
      if (this.released && this.env < 1e-4) {
        this.done = true;
        return;
      }
    }
  }
}

export class DroneSynth extends Instrument {
  private readonly p: DroneParams;
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
    this.maxVoices = 12;
    this.hall = new Hall(sr);
    this.hall.setDecay(3 + 9 * this.p.space);
  }

  update(params?: Record<string, number>): void {
    Object.assign(this.p, resolve(this.preset, params));
    this.hall.setDecay(3 + 9 * this.p.space);
    for (const v of this.voices as DroneVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice {
    return new DroneVoice(this.p, key, velocity, this.sr, this.seed++);
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
    const space = this.p.space;
    const hall = this.hall;
    const dry = 1 - 0.45 * space;
    const wet = space * 0.9;
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
