/**
 * Wind: end-blown and side-blown flutes and a set of bellows pipes.
 *
 * A flute's sound is its tone and its breath together. The tone here is band-limited (a table per
 * octave from each flute's spectrum); the breath is noise tuned into narrow bands on the note's
 * first harmonics (so the air itself has pitch, as it does across a real embouchure), plus a little
 * broadband hiss. Each note speaks with a chiff, a short puff of tuned noise, and vibrato arrives
 * only after the note has settled, as a player's does. Overblow pushes the tone toward its upper
 * harmonics and adds air.
 *
 * - Shakuhachi: breathy and hollow, each note scooping up into pitch from just below.
 * - Bansuri: sweet and soft, with a gentle, wide vibrato.
 * - Dizi: bright, with the buzz of its membrane.
 * - Celtic Pipes: a reedy chanter over two drones, which start on the first note of a phrase (the
 *   tonic) and sound until every key is let go.
 *
 * Its six knobs (SYNTH_MACROS) move while it plays.
 */
import { macroValues } from '@holo/session';
import { Env } from './analog.ts';
import { Noise } from './dsp.ts';
import { Hall } from './ethereal.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';
import { buildTables, readTable, tableLevel } from './morph.ts';

interface WindParams {
  // the knobs
  breath: number;
  overblow: number;
  vibrato: number;
  attack: number;
  release: number;
  space: number;
  // the preset's
  table: number;
  /** The scoop into pitch (semitones below, and seconds to arrive). */
  scoop: number;
  scoopTime: number;
  vibRate: number;
  /** The membrane's buzz (Dizi). */
  buzz: number;
  /** Drones under the chanter (Celtic Pipes). */
  drones: number;
  level: number;
}

const SPECTRA = [
  // shakuhachi: hollow, a strong fundamental, weak even harmonics
  (n: number) => (n === 1 ? 1 : n % 2 ? 0.35 / n ** 1.4 : 0.12 / n ** 1.6),
  // bansuri: sweet, falling smoothly
  (n: number) => (n === 1 ? 1 : 0.42 / n ** 1.5),
  // dizi: brighter
  (n: number) => (n === 1 ? 1 : 0.55 / n ** 1.05),
  // a reed chanter: nasal, a hump around the fourth to seventh harmonics
  (n: number) => (0.6 + 0.8 * Math.exp(-(((n - 5) / 3) ** 2))) / n ** 0.75,
  // the drones: a buzzy cylindrical reed (odd harmonics strong)
  (n: number) => (n % 2 ? 1 : 0.3) / n ** 0.9,
];
const TABLES = SPECTRA.map(buildTables);

type Preset = Omit<WindParams, 'breath' | 'overblow' | 'vibrato' | 'attack' | 'release' | 'space'>;

const PRESETS: Record<string, Preset> = {
  Shakuhachi: { table: 0, scoop: 0.9, scoopTime: 0.18, vibRate: 4.8, buzz: 0, drones: 0, level: 0.12 },
  Bansuri: { table: 1, scoop: 0.25, scoopTime: 0.08, vibRate: 5.2, buzz: 0, drones: 0, level: 0.13 },
  Dizi: { table: 2, scoop: 0.15, scoopTime: 0.06, vibRate: 5.8, buzz: 0.55, drones: 0, level: 0.11 },
  'Celtic Pipes': { table: 3, scoop: 0, scoopTime: 0.02, vibRate: 5.5, buzz: 0, drones: 1, level: 0.22 },
};

export const WIND_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): WindParams {
  const name = PRESETS[preset] ? preset : 'Bansuri';
  return { ...(PRESETS[name] as Preset), ...macroValues(name, params) } as WindParams;
}

const TAU = Math.PI * 2;

/** A narrow resonator for tuned breath: noise in, a breathing band of the note out. */
class Band {
  private y1 = 0;
  private y2 = 0;
  private c = 0;
  private rr = 0;
  private g = 0;
  set(freq: number, bw: number, sr: number): void {
    const f = Math.min(freq, sr * 0.45);
    const r = Math.exp((-Math.PI * bw) / sr);
    this.rr = r * r;
    this.c = 2 * r * Math.cos((TAU * f) / sr);
    this.g = Math.sqrt(1 - r * r) * 2 * Math.sin((TAU * f) / sr);
  }
  step(x: number): number {
    const y = this.c * this.y1 - this.rr * this.y2 + x * this.g;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
}

class WindVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private ph = 0;
  private ph2 = 0;
  private readonly amp: Env;
  private readonly noise: Noise;
  private readonly b1 = new Band();
  private readonly b2 = new Band();
  private readonly b3 = new Band();
  private readonly p: WindParams;
  private readonly sr: number;
  private readonly vel: number;
  private t = 0;
  private scoop: number;
  private chiff: number;
  private vib = 0;
  private hiss = 0;
  private counter = 0;
  private freq = 440;
  private inc = 0;
  private level = 0;
  private killing = 0;
  private buzzLp = 0;

  constructor(p: WindParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.vel = velocity / 127;
    this.noise = new Noise(seed * 5003 + 7);
    this.amp = new Env(sr);
    this.scoop = p.scoop * (0.6 + 0.4 * this.vel);
    this.chiff = 0.5 + 0.7 * this.vel;
    this.vib = ((seed * 13) % 29) / 29;
    this.retime();
    this.amp.gate(true);
  }

  retime(): void {
    const p = this.p;
    this.amp.set(p.attack, 0.4, 0.92, p.release);
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
    const noise = this.noise;
    const amp = this.amp;
    const tables = TABLES[p.table] as Float32Array[];
    const gain = p.level * (0.6 + 0.4 * this.vel) * ctl.expression;
    const air = 0.25 + 1.4 * p.breath + 0.6 * p.overblow;
    const over = p.overblow;
    const scoopK = Math.exp(-1 / (p.scoopTime * sr));
    const chiffK = Math.exp(-1 / (0.035 * sr));
    for (let i = start; i < end; i++) {
      const t = this.t++;
      if ((this.counter++ & 15) === 0) {
        // vibrato only once the note has settled (a third of a second in), easing in
        const settle = Math.min(1, Math.max(0, (t / sr - 0.3) / 0.4));
        this.vib += (16 * p.vibRate) / sr;
        if (this.vib >= 1) this.vib -= 1;
        const depth = (p.vibrato * settle + ctl.mod * 0.6) * 0.25;
        const vib = Math.sin(TAU * this.vib) * depth;
        this.freq = 440 * 2 ** ((this.key - 69 + ctl.bend + vib - this.scoop) / 12);
        this.inc = this.freq / sr;
        this.level = tableLevel(this.freq * (1 + over), sr);
        const bw = this.freq * (0.012 + 0.03 * p.breath);
        this.b1.set(this.freq, bw, sr);
        this.b2.set(this.freq * 2, bw * 1.6, sr);
        this.b3.set(this.freq * 3, bw * 2.2, sr);
      }
      this.scoop *= scoopK;
      amp.step();
      let ph = this.ph + this.inc;
      if (ph >= 1) ph -= 1;
      this.ph = ph;
      const table = tables[this.level] as Float32Array;
      let x = readTable(table, ph);
      if (over > 0) {
        // overblowing: the octave comes forward
        let p2 = this.ph2 + this.inc * 2;
        if (p2 >= 1) p2 -= 1;
        this.ph2 = p2;
        x += readTable(tables[Math.min(this.level + 1, tables.length - 1)] as Float32Array, p2) * over * 0.55;
      }
      noise.step();
      const n = noise.value;
      // the breath: tuned into the note's first harmonics, a little hiss over the top
      this.hiss += (n - this.hiss) * 0.6;
      const tuned = this.b1.step(n) * 0.7 + this.b2.step(n) * 0.4 + this.b3.step(n) * 0.25;
      const breath = (tuned * 0.55 + (n - this.hiss) * 0.05) * air;
      const chiff = this.chiff > 1e-3 ? this.chiff * tuned * 1.4 : 0;
      this.chiff *= chiffK;
      let y = x * (1 - 0.25 * p.breath) + breath + chiff;
      if (p.buzz > 0) {
        // the membrane: it buzzes on the loudest part of each cycle
        const b = y * (1 + p.buzz * 3);
        const c = b > 0.6 ? 0.6 + (b - 0.6) * 0.25 : b;
        this.buzzLp += (c - this.buzzLp) * 0.5;
        y = (c - this.buzzLp * 0.3) / (1 + p.buzz * 1.2);
      }
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
      const s = y * a;
      l[i] = (l[i] as number) + s;
      r[i] = (r[i] as number) + s;
    }
  }
}

export class WindSynth extends Instrument {
  private readonly p: WindParams;
  private readonly preset: string;
  private seed = 1;
  private dryL = new Float32Array(0);
  private dryR = new Float32Array(0);
  private readonly hall: Hall;
  private tail = 0;
  // the pipes' drones: the tonic, two octaves and one below it, sounding while any key is down
  private droneKey = -1;
  private droneLevel = 0;
  private dPh1 = 0;
  private dPh2 = 0;
  private readonly droneNoise = new Noise(4242);

  constructor(sr: number, preset: string, params?: Record<string, number>) {
    super(sr);
    this.preset = preset;
    this.p = resolve(preset, params);
    this.maxVoices = 12;
    this.hall = new Hall(sr);
    this.hall.setDecay(1.5 + 5 * this.p.space);
  }

  update(params?: Record<string, number>): void {
    Object.assign(this.p, resolve(this.preset, params));
    this.hall.setDecay(1.5 + 5 * this.p.space);
    for (const v of this.voices as WindVoice[]) if (!v.done) v.retime();
  }

  private held(): boolean {
    for (const v of this.voices) if (!v.done && !v.released) return true;
    return false;
  }

  protected startVoice(key: number, velocity: number): Voice {
    // a phrase's first note sets the drones (its note, two octaves and one down)
    if (this.p.drones > 0 && (!this.held() || this.droneKey < 0)) this.droneKey = key;
    return new WindVoice(this.p, key, velocity, this.sr, this.seed++);
  }

  override get active(): number {
    return super.active + (this.tail > 2e-5 || this.droneLevel > 1e-4 ? 1 : 0);
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
    const sr = this.sr;
    const space = p.space;
    const hall = this.hall;
    const dry = 1 - 0.4 * space;
    const wet = space * 0.85;
    const drones = p.drones > 0 && this.droneKey >= 0;
    const on = drones && this.held();
    const droneTo = on ? 1 : 0;
    const droneK = 1 - Math.exp(-1 / ((on ? 0.25 : 0.35) * sr));
    const dTable = TABLES[4] as Float32Array[];
    let f1 = 0;
    let f2 = 0;
    let lv1 = 0;
    let lv2 = 0;
    if (drones) {
      // the drones sit low: the tonic's pitch class in the octave below C3, and an octave under that
      const pc = (((this.droneKey % 12) + 12) % 12) + 36;
      f1 = (440 * 2 ** ((pc + 12 - 69) / 12)) / sr;
      f2 = (440 * 2 ** ((pc - 69) / 12)) / sr;
      lv1 = tableLevel(f1 * sr, sr);
      lv2 = tableLevel(f2 * sr, sr);
    }
    const dGain = p.level * 0.45 * this.controls.expression;
    let peak = 0;
    for (let i = start; i < end; i++) {
      let xl = dl[i] as number;
      let xr = dr[i] as number;
      if (drones || this.droneLevel > 1e-4) {
        this.droneLevel += (droneTo - this.droneLevel) * droneK;
        this.dPh1 += f1;
        if (this.dPh1 >= 1) this.dPh1 -= 1;
        this.dPh2 += f2 * 1.0004;
        if (this.dPh2 >= 1) this.dPh2 -= 1;
        this.droneNoise.step();
        const d =
          (readTable(dTable[lv1] as Float32Array, this.dPh1) * 0.6 +
            readTable(dTable[lv2] as Float32Array, this.dPh2) * 0.8) *
          (1 + this.droneNoise.value * 0.04) *
          this.droneLevel *
          dGain;
        xl += d * 0.9;
        xr += d * 1.1;
      }
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
    // faded out: silent, not a long tail of nothing
    if (!on && this.droneLevel < 1e-3) this.droneLevel = 0;
    if (!this.held() && this.droneLevel <= 1e-4) this.droneKey = -1;
    this.tail = Math.max(peak, this.tail * 0.9);
  }
}
