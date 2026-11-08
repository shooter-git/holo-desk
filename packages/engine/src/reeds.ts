/**
 * Reeds: sustained free reeds and the glass harmonica.
 *
 * - Harmonium: hand-pumped free reeds, two ranks a few cents apart (Detune: the celeste's beat) and
 *   a quieter rank an octave up, breathing with the bellows (Tremolo is how unsteady the pumping).
 * - Sheng: mouth-blown free reeds, bright, each note voiced with its fifth and octave as the
 *   instrument is usually played, with a light vibrato.
 * - Glass Harmonica: rubbed glass bowls: nearly pure tones, each with a twin a hair out of tune so it
 *   shimmers (Detune), a whisper of friction, a slow swell and a long ring after.
 *
 * Every tone is band-limited (a table per octave). Its six knobs (SYNTH_MACROS) move while it plays.
 */
import { macroValues } from '@holo/session';
import { Env } from './analog.ts';
import { Noise } from './dsp.ts';
import { Hall } from './ethereal.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';
import { buildTables, readTable, tableLevel } from './morph.ts';

interface ReedParams {
  // the knobs
  tone: number;
  swell: number;
  tremolo: number;
  detune: number;
  release: number;
  space: number;
  // the preset's
  table: number;
  /** The other ranks: an octave up, and a fifth up. */
  octave: number;
  fifth: number;
  /** Vibrato (pitch) as well as the bellows' wobble (level). */
  vibrato: number;
  friction: number;
  level: number;
}

const SPECTRA = [
  // a free reed: rich, a nasal hump around the fourth to eighth harmonics
  (n: number) => (0.5 + 0.7 * Math.exp(-(((n - 6) / 4) ** 2))) / n ** 0.8,
  // a brighter mouth-blown reed
  (n: number) => (0.6 + 0.6 * Math.exp(-(((n - 9) / 5) ** 2))) / n ** 0.6,
  // rubbed glass: almost a sine
  (n: number) => (n === 1 ? 1 : n === 2 ? 0.07 : n === 3 ? 0.025 : 0),
];
const TABLES = SPECTRA.map(buildTables);

type Preset = Omit<ReedParams, 'tone' | 'swell' | 'tremolo' | 'detune' | 'release' | 'space'>;

const PRESETS: Record<string, Preset> = {
  Harmonium: { table: 0, octave: 0.35, fifth: 0, vibrato: 0, friction: 0, level: 0.2 },
  Sheng: { table: 1, octave: 0.3, fifth: 0.4, vibrato: 1, friction: 0, level: 0.5 },
  'Glass Harmonica': { table: 2, octave: 0, fifth: 0, vibrato: 0, friction: 1, level: 0.1 },
};

export const REED_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): ReedParams {
  const name = PRESETS[preset] ? preset : 'Harmonium';
  return { ...(PRESETS[name] as Preset), ...macroValues(name, params) } as ReedParams;
}

const TAU = Math.PI * 2;

class ReedVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  /** The ranks: the note, its celeste twin, the octave, the fifth. */
  private readonly ph = new Float64Array(4);
  private readonly amp: Env;
  private readonly noise: Noise;
  private readonly p: ReedParams;
  private readonly sr: number;
  private readonly vel: number;
  private counter = 0;
  private inc = 0;
  private lv = 0;
  private lv2 = 0;
  private wobble = 1;
  private wobbleTo = 1;
  private vib = 0;
  private fric = 0;
  private fric2 = 0;
  private killing = 0;

  constructor(p: ReedParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.vel = velocity / 127;
    this.noise = new Noise(seed * 2741 + 3);
    this.amp = new Env(sr);
    for (let j = 0; j < 4; j++) this.ph[j] = ((seed * (j + 2)) % 43) / 43;
    this.vib = ((seed * 7) % 19) / 19;
    this.retime();
    this.amp.gate(true);
  }

  retime(): void {
    const p = this.p;
    this.amp.set(p.swell, 0.5, 0.95, p.release);
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
    const tables = TABLES[p.table] as Float32Array[];
    const gain = p.level * (0.7 + 0.3 * this.vel) * ctl.expression;
    const twin = 1 + (p.detune * 12) / 1731; // up to 12 cents
    const wobbleK = 1 - Math.exp(-16 / (0.12 * sr));
    for (let i = start; i < end; i++) {
      if ((this.counter++ & 15) === 0) {
        this.vib += (16 * 5.3) / sr;
        if (this.vib >= 1) this.vib -= 1;
        const vib = Math.sin(TAU * this.vib) * (p.vibrato * p.tremolo * 0.18 + ctl.mod * 0.25);
        const freq = 440 * 2 ** ((this.key - 69 + ctl.bend + vib) / 12);
        this.inc = freq / sr;
        this.lv = tableLevel(freq * 1.5, sr);
        this.lv2 = tableLevel(freq * 2, sr);
        // the bellows (or breath): the level wanders a little, more with Tremolo
        noise.step();
        if (Math.abs(noise.value) < 0.04) this.wobbleTo = 1 - p.tremolo * 0.35 * Math.abs(noise.value) * 25;
        this.wobble += (this.wobbleTo - this.wobble) * wobbleK;
      }
      amp.step();
      const ph = this.ph;
      const inc = this.inc;
      let a = (ph[0] as number) + inc;
      if (a >= 1) a -= 1;
      ph[0] = a;
      let b = (ph[1] as number) + inc * twin;
      if (b >= 1) b -= 1;
      ph[1] = b;
      const t = tables[this.lv] as Float32Array;
      let x = readTable(t, a) + readTable(t, b) * (0.35 + 0.6 * p.detune);
      if (p.octave > 0) {
        let c = (ph[2] as number) + inc * 2;
        if (c >= 1) c -= 1;
        ph[2] = c;
        x += readTable(tables[this.lv2] as Float32Array, c) * p.octave;
      }
      if (p.fifth > 0) {
        let d = (ph[3] as number) + inc * 1.4983;
        if (d >= 1) d -= 1;
        ph[3] = d;
        x += readTable(tables[this.lv2] as Float32Array, d) * p.fifth;
      }
      if (p.friction > 0) {
        // the wet finger on the glass: a faint band of noise round the note
        noise.step();
        this.fric += (noise.value - this.fric) * 0.08;
        this.fric2 += (this.fric - this.fric2) * 0.08;
        x += (this.fric - this.fric2) * 0.6 * p.friction * (1 - 0.7 * amp.level);
      }
      let g = amp.level * gain * this.wobble;
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
      const s = x * g;
      l[i] = (l[i] as number) + s;
      r[i] = (r[i] as number) + s;
    }
  }
}

export class ReedSynth extends Instrument {
  private readonly p: ReedParams;
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
    for (const v of this.voices as ReedVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice {
    return new ReedVoice(this.p, key, velocity, this.sr, this.seed++);
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
    const p = this.p;
    const space = p.space;
    const hall = this.hall;
    const dry = 1 - 0.4 * space;
    const wet = space * 0.85;
    const c = 1 - Math.exp((-TAU * 600 * 2 ** (p.tone * 4.4)) / this.sr);
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
