/**
 * Plucked: zithers and lutes, each a string (a delay line round which a pluck travels, losing a
 * little brightness each trip) through the body it's mounted on.
 *
 * - Koto, Guzheng, Gayageum: long zither strings plucked with a pick or the fingers, ringing through
 *   a long wooden body. After the pluck the left hand can press the string behind the bridge: here
 *   that's a slow, deep vibrato that arrives once the note has rung a moment (Vibrato), and pitch
 *   bend for slides.
 * - Shamisen, Pipa, Sitar: lutes. Their strings buzz against the bridge (Buzz): the string's swing
 *   is cut off on one side, which brightens it the harder it's plucked, then fades as it quietens.
 *   The pipa's held notes are played as a tremolo of quick plucks; the sitar has a set of
 *   sympathetic strings, tuned to the scale of the first note played, that ring along with it.
 * - Tanpura: a drone. Hold a key and it plays itself: the fifth below, the note twice, then the
 *   octave below, around and around, each string's buzz blooming as it rings.
 *
 * Its six knobs (SYNTH_MACROS) move while it plays.
 */
import { macroValues } from '@holo/session';
import { Noise } from './dsp.ts';
import { Hall } from './ethereal.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

interface PluckedParams {
  // the knobs
  tone: number;
  buzz: number;
  vibrato: number;
  decay: number;
  body: number;
  space: number;
  // the preset's
  /** Where along the string it's plucked (0..0.5). */
  position: number;
  /** Seconds to fall 60 dB at middle C. */
  ring: number;
  /** The body's two main resonances (hertz) and how much of them. */
  body1: number;
  body2: number;
  bodyAmt: number;
  vibRate: number;
  /** Plays held notes as a tremolo of plucks (per second), or not. */
  tremolo: number;
  /** Sympathetic strings (sitar), or not. */
  sympathetic: number;
  /** Plays itself as a drone (tanpura), or not. */
  drone: number;
  /** The pluck's own noise (a pick, a nail, a plectrum on skin). */
  pick: number;
  level: number;
}

type Preset = Omit<PluckedParams, 'tone' | 'buzz' | 'vibrato' | 'decay' | 'body' | 'space'>;

const base: Preset = {
  position: 0.18,
  ring: 3,
  body1: 220,
  body2: 560,
  bodyAmt: 0.3,
  vibRate: 4.5,
  tremolo: 0,
  sympathetic: 0,
  drone: 0,
  pick: 0.2,
  level: 0.5,
};

const PRESETS: Record<string, Preset> = {
  Koto: {
    ...base,
    position: 0.12,
    ring: 3.2,
    body1: 180,
    body2: 470,
    bodyAmt: 0.35,
    pick: 0.35,
    vibRate: 4.2,
    level: 0.28,
  },
  Guzheng: {
    ...base,
    position: 0.15,
    ring: 3.8,
    body1: 200,
    body2: 520,
    bodyAmt: 0.3,
    pick: 0.3,
    vibRate: 5.2,
    level: 0.3,
  },
  Gayageum: {
    ...base,
    position: 0.22,
    ring: 2.6,
    body1: 160,
    body2: 430,
    bodyAmt: 0.4,
    pick: 0.1,
    vibRate: 3.8,
    level: 0.32,
  },
  Shamisen: {
    ...base,
    position: 0.08,
    ring: 1.4,
    body1: 900,
    body2: 2200,
    bodyAmt: 0.45,
    pick: 0.6,
    vibRate: 5,
    level: 0.26,
  },
  Pipa: {
    ...base,
    position: 0.12,
    ring: 1.8,
    body1: 300,
    body2: 900,
    bodyAmt: 0.35,
    pick: 0.35,
    tremolo: 14,
    vibRate: 5.5,
    level: 0.22,
  },
  Sitar: {
    ...base,
    position: 0.1,
    ring: 4.5,
    body1: 240,
    body2: 700,
    bodyAmt: 0.3,
    pick: 0.4,
    sympathetic: 1,
    vibRate: 5,
    level: 0.28,
  },
  Tanpura: {
    ...base,
    position: 0.2,
    ring: 6,
    body1: 200,
    body2: 600,
    bodyAmt: 0.25,
    pick: 0.05,
    drone: 1,
    level: 0.32,
  },
};

export const PLUCKED_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): PluckedParams {
  const name = PRESETS[preset] ? preset : 'Koto';
  return { ...(PRESETS[name] as Preset), ...macroValues(name, params) } as PluckedParams;
}

const TAU = Math.PI * 2;
const hz = (key: number) => 440 * 2 ** ((key - 69) / 12);

/** One string: a delay line, its loss and brightness, an allpass for the tuning between samples. */
class PString {
  private readonly line: Float32Array;
  private pos = 0;
  private len = 2;
  private apCoef = 0;
  private ap = 0;
  private apIn = 0;
  private lp = 0;
  private loss = 0.999;
  private bright = 0.5;
  /** Where the bridge cuts the swing off (a buzzing bridge), relative to the pluck. */
  private clip = 1e9;
  private readonly sr: number;
  freq = 440;
  /** The level it was plucked at (the bridge's buzz follows it down). */
  plucked = 0;
  out = 0;

  constructor(sr: number, lowest: number) {
    this.sr = sr;
    this.line = new Float32Array(Math.ceil(sr / lowest) + 4);
  }

  /** Tune to a frequency; the length changes without clearing what's traveling. */
  tune(freq: number): void {
    this.freq = freq;
    const exact = Math.min(this.line.length - 3, Math.max(2, this.sr / freq - 0.5));
    this.len = Math.floor(exact);
    const frac = exact - this.len;
    this.apCoef = (1 - frac) / (1 + frac);
  }

  /** How long it rings (seconds to -60 dB), how bright, and how hard its bridge buzzes (0..1). */
  set(t60: number, bright: number, buzz: number): void {
    this.loss = 10 ** (-3 / (Math.max(0.05, t60) * this.freq));
    this.bright = bright;
    this.clip = buzz > 0 ? 0.9 - 0.75 * buzz : 1e9;
  }

  /**
   * A pluck at `position` along the string, `amp` loud, `noise` of it the pick's. `keep` is how much
   * of what's already ringing survives (a pick landing on a sounding string partly stops it).
   */
  pluck(amp: number, position: number, noise: Noise, pick: number, keep = 1): void {
    const n = this.len;
    const at = Math.max(1, Math.round(n * position));
    for (let i = 0; i < n; i++) {
      // a triangle peaking at the plucking point (the string pulled aside there), plus the pick
      const shape = i < at ? i / at : (n - i) / (n - at);
      noise.step();
      const idx = (this.pos + i) % n;
      this.line[idx] = (this.line[idx] as number) * keep + amp * (shape * 2 - 1 + noise.value * pick);
    }
    this.plucked = Math.max(this.plucked * 0.5, amp);
  }

  step(): number {
    const line = this.line;
    const at = this.pos;
    let y = line[at] as number;
    // the bridge: past a point (which follows the pluck's level) the swing is cut off on one side
    const c = this.clip * this.plucked;
    if (y > c) y = c + (y - c) * 0.2;
    this.lp += (y - this.lp) * this.bright;
    const fb = this.lp * this.loss;
    const out = this.apCoef * (fb - this.ap) + this.apIn;
    this.apIn = fb;
    this.ap = out;
    line[at] = out;
    this.pos = at + 1 >= this.len ? 0 : at + 1;
    this.out = y;
    return y;
  }

  /** The string's level now (for knowing when it's quiet). */
  get level(): number {
    return Math.abs(this.lp);
  }
}

/** A resonator driven by a signal (a body's resonance, a sympathetic string), unity gain at its peak. */
class Reso {
  private y1 = 0;
  private y2 = 0;
  private c = 0;
  private rr = 0;
  private g = 0;
  set(freq: number, t60: number, sr: number): void {
    const f = Math.min(freq, sr * 0.45);
    const r = Math.exp(-6.91 / Math.max(1, t60 * sr));
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

/** The sitar's sympathetic strings: a scale of narrow resonators on the first note's pitch. */
const SCALE = [0, 2, 4, 5, 7, 9, 11, 12, 14, 16, 19];

class PluckedVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private readonly strings: PString[];
  private readonly noise: Noise;
  private readonly p: PluckedParams;
  private readonly sr: number;
  private readonly vel: number;
  private t = 0;
  private vib = 0;
  private counter = 0;
  private trem = 0;
  private fade = 1;
  private fadeK = 1;
  private killing = 0;
  private quiet = 0;
  /** The tanpura's cycle: which string plucks next and when. */
  private next = 0;
  private nextAt = 0;
  private readonly gl: number;
  private readonly gr: number;

  constructor(p: PluckedParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.vel = velocity / 127;
    this.noise = new Noise(seed * 8191 + 13);
    const pan = Math.max(-0.6, Math.min(0.6, (key - 60) / 40));
    this.gl = Math.min(1, 1 - pan);
    this.gr = Math.min(1, 1 + pan);
    if (p.drone > 0) {
      // the fifth below, the note, the note, the octave below
      this.strings = [key - 5, key, key, key - 12].map((k) => {
        const s = new PString(sr, hz(k) * 0.97);
        s.tune(hz(k) * (1 + ((seed + k) % 5) * 0.0004));
        return s;
      });
    } else {
      const s = new PString(sr, hz(key) * 0.9);
      s.tune(hz(key));
      this.strings = [s];
    }
    this.retime();
    if (p.drone > 0) this.nextAt = 0;
    else (this.strings[0] as PString).pluck(this.amp(), p.position, this.noise, p.pick);
  }

  private amp(): number {
    return 0.25 + 0.75 * this.vel ** 1.3;
  }

  retime(): void {
    const p = this.p;
    for (const s of this.strings) {
      // higher strings ring for less time, as real ones do
      const t60 = p.ring * p.decay * 2 ** -(Math.log2(s.freq / 261.6) * 0.6);
      s.set(this.released && p.drone === 0 ? Math.min(t60, 0.6) : t60, 0.25 + 0.65 * p.tone, p.buzz);
    }
  }

  release(): void {
    this.released = true;
    // a let-go string is damped by the hand (the zithers ring on longer); the tanpura fades out
    this.fadeK = Math.exp(-1 / ((this.p.drone > 0 ? 0.8 : 0.25) * this.sr));
    this.retime();
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const p = this.p;
    const sr = this.sr;
    const strings = this.strings;
    const gain = p.level * ctl.expression;
    for (let i = start; i < end; i++) {
      const t = this.t++;
      if ((this.counter++ & 31) === 0) {
        // the left hand: a slow, deep vibrato once the note has rung a moment, and pitch bend
        const settle = Math.min(1, Math.max(0, (t / sr - 0.25) / 0.5));
        this.vib += (32 * p.vibRate) / sr;
        if (this.vib >= 1) this.vib -= 1;
        const vib = Math.sin(TAU * this.vib) * (p.vibrato * 0.45 * settle + ctl.mod * 0.3);
        const bend = 2 ** ((ctl.bend + vib) / 12);
        if (p.drone > 0) {
          const ks = [this.key - 5, this.key, this.key, this.key - 12];
          for (let j = 0; j < strings.length; j++) (strings[j] as PString).tune(hz(ks[j] as number) * bend);
        } else (strings[0] as PString).tune(hz(this.key) * bend);
        // the pipa's tremolo: while it's held, quick plucks
        if (p.tremolo > 0 && !this.released) {
          this.trem += (32 * p.tremolo) / sr;
          if (this.trem >= 1) {
            this.trem -= 1;
            (strings[0] as PString).pluck(this.amp() * 0.55, p.position, this.noise, p.pick, 0.45);
          }
        }
        // the tanpura's cycle: a pluck every 0.6 s, around the four strings
        if (p.drone > 0 && !this.released && t >= this.nextAt) {
          const s = strings[this.next] as PString;
          s.pluck(this.amp() * (this.next === 3 ? 0.9 : 0.7), p.position, this.noise, p.pick);
          this.next = (this.next + 1) % 4;
          this.nextAt = t + Math.round((this.next === 0 ? 0.9 : 0.6) * sr);
        }
      }
      let x = 0;
      for (let j = 0; j < strings.length; j++) x += (strings[j] as PString).step();
      let g = gain;
      if (this.released) {
        this.fade *= this.fadeK;
        g *= this.fade;
      }
      if (this.killing > 0) {
        this.killing *= 0.995;
        g *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      const s = x * g;
      l[i] = (l[i] as number) + s * this.gl;
      r[i] = (r[i] as number) + s * this.gr;
      this.quiet = Math.abs(x) > 1e-4 || (p.drone > 0 && !this.released) ? 0 : this.quiet + 1;
      if (this.quiet > sr * 0.1 || (this.released && this.fade < 1e-4)) {
        this.done = true;
        return;
      }
    }
  }
}

export class PluckedSynth extends Instrument {
  private readonly p: PluckedParams;
  private readonly preset: string;
  private seed = 1;
  private dryL = new Float32Array(0);
  private dryR = new Float32Array(0);
  private readonly hall: Hall;
  private tail = 0;
  // the body: two wooden (or skin) resonances, struck by the strings' sound
  private readonly bodyA = [new Reso(), new Reso()];
  private readonly bodyB = [new Reso(), new Reso()];
  private bodyIn = 0;
  // the sitar's sympathetic strings
  private readonly symp: Reso[] = [];
  private sympKey = -1;
  private sympLevel = 0;

  constructor(sr: number, preset: string, params?: Record<string, number>) {
    super(sr);
    this.preset = preset;
    this.p = resolve(preset, params);
    this.maxVoices = this.p.drone > 0 ? 4 : 24;
    this.hall = new Hall(sr);
    this.hall.setDecay(1.5 + 5 * this.p.space);
    for (let j = 0; j < SCALE.length; j++) this.symp.push(new Reso());
    this.tuneBody();
  }

  private tuneBody(): void {
    const p = this.p;
    const sr = this.sr;
    for (const m of [this.bodyA[0], this.bodyB[0]] as Reso[]) m.set(p.body1, 0.08, sr);
    for (const m of [this.bodyA[1], this.bodyB[1]] as Reso[]) m.set(p.body2, 0.05, sr);
  }

  update(params?: Record<string, number>): void {
    Object.assign(this.p, resolve(this.preset, params));
    this.hall.setDecay(1.5 + 5 * this.p.space);
    this.tuneBody();
    for (const v of this.voices as PluckedVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice {
    if (this.p.sympathetic > 0 && this.sympKey < 0) {
      // the sympathetic strings take the first note's scale (its Sa)
      this.sympKey = key;
      const root = (((key % 12) + 12) % 12) + 48;
      for (let j = 0; j < SCALE.length; j++) (this.symp[j] as Reso).set(hz(root + (SCALE[j] as number)), 3.5, this.sr);
    }
    return new PluckedVoice(this.p, key, velocity, this.sr, this.seed++);
  }

  override get active(): number {
    return super.active + (this.tail > 2e-5 || this.sympLevel > 2e-5 ? 1 : 0);
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
    const bodyAmt = p.bodyAmt * (0.3 + 1.4 * p.body);
    const symp = p.sympathetic > 0;
    let peak = 0;
    let sympPeak = 0;
    for (let i = start; i < end; i++) {
      let xl = dl[i] as number;
      let xr = dr[i] as number;
      // the body rings with what the strings give it (driven by the change, so the low end stays clean)
      const m = (xl + xr) * 0.5;
      const drive = m - this.bodyIn;
      this.bodyIn = m;
      const bl = (this.bodyA[0] as Reso).step(drive) + (this.bodyA[1] as Reso).step(drive);
      const br = (this.bodyB[0] as Reso).step(drive * 0.9) + (this.bodyB[1] as Reso).step(drive * 1.1);
      xl += bl * bodyAmt * 4;
      xr += br * bodyAmt * 4;
      if (symp) {
        let s = 0;
        for (let j = 0; j < this.symp.length; j++) s += (this.symp[j] as Reso).step(m);
        const a = Math.abs(s);
        if (a > sympPeak) sympPeak = a;
        xl += s * 0.6;
        xr += s * 0.7;
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
    this.tail = Math.max(peak, this.tail * 0.9);
    this.sympLevel = Math.max(sympPeak, this.sympLevel * 0.9);
    if (super.active === 0 && this.sympLevel < 2e-5) this.sympKey = -1;
  }
}
