/**
 * Choir: wordless voices on a vowel. Each note is sung by a few singers, each a glottal tone (a
 * band-limited pulse falling off as a voice's does) with its own vibrato, a slow drift in tuning and
 * a little breath. The singers on each side share a vocal tract: four formants, the resonances
 * that make a vowel, glide from "ah" through "oh" to "oo" with the Vowel knob. Ensemble is how many
 * singers and how loosely they agree.
 *
 * - Choir Ahh: a mixed choir, open and bright.
 * - Male Choir: low, dark voices, formants lower and fuller: for chant.
 *
 * Its six knobs (SYNTH_MACROS) move while it plays.
 */
import { macroValues } from '@holo/session';
import { Env } from './analog.ts';
import { Noise } from './dsp.ts';
import { Hall } from './ethereal.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';
import { buildTables, readTable, tableLevel } from './morph.ts';

interface ChoirParams {
  // the knobs
  vowel: number;
  breath: number;
  vibrato: number;
  ensemble: number;
  release: number;
  space: number;
  // the preset's
  /** Formant frequencies scaled (a smaller or larger vocal tract). */
  tract: number;
  attack: number;
  level: number;
}

/** A glottal pulse's spectrum: the voice's own fall-off, a little steeper at the top. */
const GLOTTAL = buildTables((n) => 1 / n ** 1.15 / (1 + (n / 40) ** 2));

/** Formants (hertz) and their levels for "ah", "oh", "oo". */
const VOWELS = [
  { f: [800, 1150, 2900, 3900], a: [1, 0.5, 0.25, 0.1] },
  { f: [450, 800, 2830, 3800], a: [1, 0.32, 0.1, 0.06] },
  { f: [325, 700, 2530, 3500], a: [1, 0.18, 0.05, 0.03] },
];
const BANDWIDTH = [80, 90, 120, 130];

type Preset = Omit<ChoirParams, 'vowel' | 'breath' | 'vibrato' | 'ensemble' | 'release' | 'space'>;

const PRESETS: Record<string, Preset> = {
  'Choir Ahh': { tract: 1, attack: 0.35, level: 0.8 },
  'Male Choir': { tract: 0.86, attack: 0.3, level: 0.55 },
};

export const CHOIR_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): ChoirParams {
  const name = PRESETS[preset] ? preset : 'Choir Ahh';
  return { ...(PRESETS[name] as Preset), ...macroValues(name, params) } as ChoirParams;
}

const TAU = Math.PI * 2;
const MAX_SINGERS = 4;

/** A formant: a resonator driven by the voice, unity gain at its peak. */
class Formant {
  private y1 = 0;
  private y2 = 0;
  private c = 0;
  private rr = 0;
  private g = 0;
  set(freq: number, bw: number, sr: number): void {
    const f = Math.min(freq, sr * 0.45);
    const r = Math.exp((-Math.PI * bw) / sr);
    const w = (TAU * f) / sr;
    this.rr = r * r;
    this.c = 2 * r * Math.cos(w);
    this.g = (1 - r) * 2 * Math.sin(w);
  }
  step(x: number): number {
    const y = this.c * this.y1 - this.rr * this.y2 + x * this.g;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class ChoirVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private readonly ph = new Float64Array(MAX_SINGERS);
  private readonly vib = new Float64Array(MAX_SINGERS);
  private readonly vibRate = new Float64Array(MAX_SINGERS);
  private readonly drift = new Float64Array(MAX_SINGERS);
  private readonly driftTo = new Float64Array(MAX_SINGERS);
  private readonly inc = new Float64Array(MAX_SINGERS);
  private readonly fl: Formant[] = [new Formant(), new Formant(), new Formant(), new Formant()];
  private readonly fr: Formant[] = [new Formant(), new Formant(), new Formant(), new Formant()];
  private readonly fa = new Float64Array(4);
  private readonly amp: Env;
  private readonly noise: Noise;
  private readonly p: ChoirParams;
  private readonly sr: number;
  private readonly vel: number;
  private counter = 0;
  private t = 0;
  private lv = 0;
  private killing = 0;

  constructor(p: ChoirParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.vel = velocity / 127;
    this.noise = new Noise(seed * 1597 + 31);
    this.amp = new Env(sr);
    for (let s = 0; s < MAX_SINGERS; s++) {
      this.ph[s] = ((seed * (s + 3)) % 53) / 53;
      this.vib[s] = ((seed * (s + 5)) % 37) / 37;
      this.noise.step();
      this.vibRate[s] = 5.2 + 0.7 * this.noise.value;
      this.noise.step();
      this.drift[s] = this.driftTo[s] = this.noise.value * 6;
    }
    this.retime();
    this.amp.gate(true);
  }

  retime(): void {
    const p = this.p;
    this.amp.set(p.attack, 0.5, 0.95, p.release);
    this.shape();
  }

  /** The formants for where the Vowel knob is (between "ah", "oh" and "oo"). */
  private shape(): void {
    const p = this.p;
    const x = Math.min(1, Math.max(0, p.vowel)) * 2;
    const i = Math.min(1, Math.floor(x));
    const t = x - i;
    const a = VOWELS[i] as (typeof VOWELS)[number];
    const b = VOWELS[i + 1] as (typeof VOWELS)[number];
    for (let k = 0; k < 4; k++) {
      const f = ((a.f[k] as number) + ((b.f[k] as number) - (a.f[k] as number)) * t) * p.tract;
      const bw = BANDWIDTH[k] as number;
      (this.fl[k] as Formant).set(f, bw, this.sr);
      (this.fr[k] as Formant).set(f * 1.035, bw, this.sr);
      this.fa[k] = (a.a[k] as number) + ((b.a[k] as number) - (a.a[k] as number)) * t;
    }
  }

  release(): void {
    this.released = true;
    this.amp.gate(false);
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const p = this.p;
    const sr = this.sr;
    const amp = this.amp;
    const noise = this.noise;
    const singers = 1 + Math.round(p.ensemble * (MAX_SINGERS - 1));
    const loose = 0.3 + p.ensemble;
    const gain = (p.level * (0.6 + 0.4 * this.vel) * ctl.expression) / Math.sqrt(singers);
    const breath = 0.02 + p.breath * 0.25;
    const driftK = 1 - Math.exp(-32 / (0.8 * sr));
    const fl = this.fl;
    const fr = this.fr;
    const fa = this.fa;
    for (let i = start; i < end; i++) {
      const t = this.t++;
      if ((this.counter++ & 31) === 0) {
        // each singer's vibrato (it grows in after the note starts), drift and pitch
        const settle = Math.min(1, t / (sr * 0.6));
        let top = 0;
        for (let s = 0; s < singers; s++) {
          this.vib[s] = (this.vib[s] as number) + (32 * (this.vibRate[s] as number)) / sr;
          if ((this.vib[s] as number) >= 1) this.vib[s] = (this.vib[s] as number) - 1;
          noise.step();
          if (Math.abs(noise.value) < 0.03) this.driftTo[s] = noise.value * 300 * loose;
          this.drift[s] =
            (this.drift[s] as number) + ((this.driftTo[s] as number) - (this.drift[s] as number)) * driftK;
          const vib = Math.sin(TAU * (this.vib[s] as number)) * (p.vibrato * 0.35 * settle + ctl.mod * 0.3);
          const cents = (this.drift[s] as number) + (s - (singers - 1) / 2) * 7 * loose;
          const f = 440 * 2 ** ((this.key - 69 + ctl.bend + vib + cents / 100) / 12);
          this.inc[s] = f / sr;
          if (f > top) top = f;
        }
        this.lv = tableLevel(top, sr);
      }
      amp.step();
      const table = GLOTTAL[this.lv] as Float32Array;
      let left = 0;
      let right = 0;
      for (let s = 0; s < singers; s++) {
        let ph = (this.ph[s] as number) + (this.inc[s] as number);
        if (ph >= 1) ph -= 1;
        this.ph[s] = ph;
        const g = readTable(table, ph);
        if (s % 2) right += g;
        else left += g;
      }
      if (singers === 1) right = left;
      noise.step();
      const nl = noise.value * breath;
      noise.step();
      const nr = noise.value * breath;
      // through the vocal tract: four formants a side
      let yl = 0;
      let yr = 0;
      for (let k = 0; k < 4; k++) {
        const a = fa[k] as number;
        yl += (fl[k] as Formant).step(left + nl) * a;
        yr += (fr[k] as Formant).step(right + nr) * a;
      }
      let g = amp.level * gain;
      if (this.killing > 0) {
        this.killing *= 0.995;
        g *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      if (amp.off) {
        this.done = true;
        return;
      }
      l[i] = (l[i] as number) + yl * g;
      r[i] = (r[i] as number) + yr * g;
    }
  }
}

export class ChoirSynth extends Instrument {
  private readonly p: ChoirParams;
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
    this.maxVoices = 16;
    this.hall = new Hall(sr);
    this.hall.setDecay(2 + 7 * this.p.space);
  }

  update(params?: Record<string, number>): void {
    Object.assign(this.p, resolve(this.preset, params));
    this.hall.setDecay(2 + 7 * this.p.space);
    for (const v of this.voices as ChoirVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice {
    return new ChoirVoice(this.p, key, velocity, this.sr, this.seed++);
  }

  override get active(): number {
    return super.active + (this.tail > 2e-5 ? 1 : 0);
  }

  override render(l: Float32Array, r: Float32Array, start: number, end: number): void {
    // nothing sounding and the hall quiet: nothing to do (and nothing left to decay into denormals)
    if (this.active === 0) return;
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
    const dry = 1 - 0.4 * space;
    const wet = space * 0.85;
    let peak = 0;
    for (let i = start; i < end; i++) {
      const xl = dl[i] as number;
      const xr = dr[i] as number;
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
