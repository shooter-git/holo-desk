/**
 * FM: four sine operators, each with its own envelope, frequency ratio and level, wired in one of
 * eight ways (an operator either modulates the phase of others or is heard), the top one fed back
 * into itself. A modulator's level is its index: how far it swings the carrier's phase, so how many
 * sidebands (how bright). Velocity reaches the modulators more than the carriers, so playing harder
 * brightens a note rather than only making it louder, and the modulators ease off up the keyboard so
 * the top stays sweet.
 *
 * Its six knobs (SYNTH_MACROS) move while it plays: Brightness scales every modulator's index; Ratio
 * picks the main modulator's ratio (whole numbers keep it harmonic, the others ring like bells);
 * Feedback is the top operator's; Attack, Decay and Release stretch every envelope together.
 */
import { FM_RATIOS, macroValues } from '@holo/session';
import { Env } from './analog.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

/**
 * The eight wirings. Operators are 0-3 (the fourth, 3, is the one fed back); `mods[j]` lists who
 * modulates operator j (always higher-numbered, so one pass from the top works), `out` who is heard.
 */
const ALGORITHMS: { mods: number[][]; out: number[] }[] = [
  { mods: [[1], [2], [3], []], out: [0] }, // 4→3→2→1
  { mods: [[1], [2, 3], [], []], out: [0] }, // (3+4)→2→1
  { mods: [[1, 2], [], [3], []], out: [0] }, // (2 + 4→3)→1
  { mods: [[1], [], [3], []], out: [0, 2] }, // 2→1 and 4→3
  { mods: [[3], [3], [3], []], out: [0, 1, 2] }, // 4→(1, 2, 3)
  { mods: [[], [], [3], []], out: [0, 1, 2] }, // 4→3, with 1 and 2
  { mods: [[], [], [], []], out: [0, 1, 2, 3] }, // all heard
  { mods: [[], [2], [3], []], out: [0, 1] }, // 4→3→2, with 1
];

interface Op {
  ratio: number;
  /** Cents. */
  detune: number;
  /** A carrier's level, or a modulator's index (radians of swing). */
  level: number;
  /** 0..1: how much velocity scales it. */
  vel: number;
  a: number;
  d: number;
  s: number;
  r: number;
  /** A carrier's place, -1..1. */
  pan: number;
}

interface FmParams {
  brightness: number;
  ratio: number;
  feedback: number;
  attack: number;
  decay: number;
  release: number;
  algorithm: number;
  ops: Op[];
  /** Which operator the Ratio knob sets. */
  ratioOp: number;
  /** The preset's own attack, decay and release (the knobs stretch every envelope by their ratio to these). */
  a0: number;
  d0: number;
  r0: number;
  level: number;
  /** How far up the keyboard the modulators ease off (octaves above middle C to halve). */
  keyscale: number;
}

const op = (o: Partial<Op> & Pick<Op, 'ratio' | 'level'>): Op => ({
  detune: 0,
  vel: 0.5,
  a: 0.002,
  d: 1,
  s: 0.5,
  r: 0.3,
  pan: 0,
  ...o,
});

type Preset = Omit<FmParams, 'brightness' | 'ratio' | 'feedback' | 'attack' | 'decay' | 'release'>;

const PRESETS: Record<string, Preset> = {
  'FM Keys': {
    algorithm: 3,
    ops: [
      op({ ratio: 1, level: 1, vel: 0.6, d: 3.5, s: 0, r: 0.35, pan: -0.15 }),
      op({ ratio: 14, level: 1.3, vel: 0.9, a: 0.001, d: 0.35, s: 0, r: 0.2 }),
      op({ ratio: 1, detune: 3, level: 0.75, vel: 0.5, d: 2.5, s: 0, r: 0.35, pan: 0.15 }),
      op({ ratio: 1, level: 1.1, vel: 0.85, d: 1.6, s: 0.05, r: 0.3 }),
    ],
    ratioOp: 1,
    a0: 0.002,
    d0: 3.5,
    r0: 0.35,
    level: 0.34,
    keyscale: 2,
  },
  'FM Bells': {
    algorithm: 3,
    ops: [
      op({ ratio: 1, level: 1, vel: 0.4, d: 6, s: 0, r: 2.5, pan: -0.3 }),
      op({ ratio: 3.5, level: 2.2, vel: 0.7, d: 3, s: 0, r: 2 }),
      op({ ratio: 2, detune: 5, level: 0.5, vel: 0.4, d: 4, s: 0, r: 2, pan: 0.3 }),
      op({ ratio: 7.07, level: 1.4, vel: 0.7, d: 1.2, s: 0, r: 1 }),
    ],
    ratioOp: 1,
    a0: 0.002,
    d0: 6,
    r0: 2.5,
    level: 0.4,
    keyscale: 1.5,
  },
  'FM Bass': {
    algorithm: 0,
    ops: [
      op({ ratio: 1, level: 1, vel: 0.4, d: 1.5, s: 0.7, r: 0.08 }),
      op({ ratio: 1, level: 2.4, vel: 0.8, a: 0.001, d: 0.25, s: 0.35, r: 0.08 }),
      op({ ratio: 2, level: 0.6, vel: 0.6, d: 0.12, s: 0.1, r: 0.08 }),
      op({ ratio: 1, level: 0.5, vel: 0.3, d: 0.4, s: 0.3, r: 0.1 }),
    ],
    ratioOp: 1,
    a0: 0.002,
    d0: 1.5,
    r0: 0.08,
    level: 0.19,
    keyscale: 3,
  },
  'FM Brass': {
    algorithm: 1,
    ops: [
      op({ ratio: 1, level: 1, vel: 0.5, a: 0.06, d: 1, s: 0.85, r: 0.25 }),
      op({ ratio: 1, level: 2, vel: 0.7, a: 0.09, d: 0.6, s: 0.6, r: 0.2 }),
      op({ ratio: 1, detune: 4, level: 0.7, vel: 0.6, a: 0.12, d: 0.8, s: 0.5, r: 0.2 }),
      op({ ratio: 2, level: 0.3, vel: 0.5, a: 0.05, d: 0.4, s: 0.2, r: 0.2 }),
    ],
    ratioOp: 1,
    a0: 0.06,
    d0: 1,
    r0: 0.25,
    level: 0.15,
    keyscale: 2.5,
  },
  'FM Pluck': {
    algorithm: 0,
    ops: [
      op({ ratio: 1, level: 1, vel: 0.5, d: 0.9, s: 0, r: 0.25 }),
      op({ ratio: 2, level: 2.6, vel: 0.85, a: 0.001, d: 0.18, s: 0, r: 0.2 }),
      op({ ratio: 3, level: 0.8, vel: 0.6, d: 0.08, s: 0, r: 0.1 }),
      op({ ratio: 1, level: 0.3, vel: 0.3, d: 0.1, s: 0, r: 0.1 }),
    ],
    ratioOp: 1,
    a0: 0.002,
    d0: 0.9,
    r0: 0.25,
    level: 0.24,
    keyscale: 2.5,
  },
  'FM Pad': {
    algorithm: 3,
    ops: [
      op({ ratio: 1, detune: -6, level: 1, vel: 0.2, a: 0.9, d: 3, s: 0.8, r: 2.5, pan: -0.6 }),
      op({ ratio: 2, level: 0.9, vel: 0.4, a: 1.6, d: 4, s: 0.6, r: 2.5 }),
      op({ ratio: 1, detune: 6, level: 1, vel: 0.2, a: 1.1, d: 3, s: 0.8, r: 2.5, pan: 0.6 }),
      op({ ratio: 1, detune: 2, level: 0.7, vel: 0.4, a: 2.2, d: 4, s: 0.5, r: 2.5 }),
    ],
    ratioOp: 1,
    a0: 0.9,
    d0: 3,
    r0: 2.5,
    level: 0.22,
    keyscale: 1.5,
  },
};

export const FM_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): FmParams {
  const name = PRESETS[preset] ? preset : 'FM Keys';
  const base = PRESETS[name] as Preset;
  return {
    ...base,
    ops: base.ops.map((o) => ({ ...o })),
    ...macroValues(name, params),
  } as FmParams;
}

const TABLE = 4096;
const SINE = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) SINE[i] = Math.sin((2 * Math.PI * i) / TABLE);
const TAU = Math.PI * 2;

/** sin(2π·x) by table, any x. */
function sin1(x: number): number {
  const f = x - Math.floor(x);
  const idx = f * TABLE;
  const k = idx | 0;
  return (SINE[k] as number) + ((SINE[k + 1] as number) - (SINE[k] as number)) * (idx - k);
}

class FmVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private readonly ph = new Float64Array(4);
  private readonly out = new Float64Array(4);
  private readonly env: Env[];
  /** Each operator's level for this note (velocity and key scaling in). */
  private readonly lv = new Float64Array(4);
  private readonly fb = new Float64Array(2);
  private readonly p: FmParams;
  private readonly sr: number;
  private readonly vel: number;
  private freq = 440;
  private vib = 0;
  private counter = 0;
  private killing = 0;
  /** Each carrier's gains to the left and right. */
  private readonly cl = new Float64Array(4);
  private readonly cr = new Float64Array(4);

  constructor(p: FmParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.vel = velocity / 127;
    this.env = [new Env(sr), new Env(sr), new Env(sr), new Env(sr)];
    for (let j = 0; j < 4; j++) this.ph[j] = ((seed * (j + 3)) % 97) / 97;
    this.retime();
    for (const e of this.env) e.gate(true);
  }

  /** Levels, envelopes and ratios from the knobs (as they are now). */
  retime(): void {
    const p = this.p;
    const alg = ALGORITHMS[Math.round(p.algorithm)] ?? (ALGORITHMS[0] as (typeof ALGORITHMS)[number]);
    const ka = p.attack / p.a0;
    const kd = p.decay / p.d0;
    const kr = p.release / p.r0;
    const ease = 2 ** (-Math.max(0, this.key - 60) / 12 / p.keyscale);
    const n = alg.out.length;
    for (let j = 0; j < 4; j++) {
      const o = p.ops[j] as Op;
      const carrier = alg.out.includes(j);
      const v = 1 - o.vel + o.vel * this.vel * this.vel;
      this.lv[j] = carrier ? o.level * v : o.level * v * p.brightness * ease;
      (this.env[j] as Env).set(o.a * ka, o.d * kd, o.s, o.r * kr);
      // each carrier where its pan puts it, the carriers sharing the level between them
      this.cl[j] = carrier ? (Math.min(1, 1 - o.pan) * p.level) / n : 0;
      this.cr[j] = carrier ? (Math.min(1, 1 + o.pan) * p.level) / n : 0;
    }
  }

  release(): void {
    this.released = true;
    for (const e of this.env) e.gate(false);
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const p = this.p;
    const sr = this.sr;
    const alg = ALGORITHMS[Math.round(p.algorithm)] ?? (ALGORITHMS[0] as (typeof ALGORITHMS)[number]);
    const mods = alg.mods;
    const outs = alg.out;
    const ratioStep = FM_RATIOS[Math.round(p.ratio)] ?? 1;
    const ops = p.ops;
    const ph = this.ph;
    const out = this.out;
    const env = this.env;
    const lv = this.lv;
    const fbAmt = p.feedback * 0.9;
    const gain = ctl.expression;
    for (let i = start; i < end; i++) {
      if ((this.counter++ & 15) === 0) {
        this.vib += (16 * 5.2) / sr;
        if (this.vib >= 1) this.vib -= 1;
        const vib = ctl.mod > 0 ? Math.sin(TAU * this.vib) * 0.3 * ctl.mod : 0;
        this.freq = 440 * 2 ** ((this.key - 69 + ctl.bend + vib) / 12);
      }
      let alive = false;
      for (let j = 3; j >= 0; j--) {
        const o = ops[j] as Op;
        const e = env[j] as Env;
        e.step();
        if (!e.off) alive = true;
        const ratio = j === p.ratioOp ? ratioStep : o.ratio;
        const dt = (this.freq * ratio * (1 + o.detune * 0.000578)) / sr;
        let x = (ph[j] as number) + dt;
        if (x >= 1) x -= 1;
        ph[j] = x;
        // the modulation in, in cycles (a level of 1 swings the phase one radian)
        let m = 0;
        const from = mods[j] as number[];
        for (let k = 0; k < from.length; k++) m += out[from[k] as number] as number;
        if (j === 3 && fbAmt > 0) m += ((this.fb[0] as number) + (this.fb[1] as number)) * 0.5 * fbAmt;
        const y = sin1(x + m / TAU) * e.level * (lv[j] as number);
        out[j] = y;
        if (j === 3) {
          this.fb[1] = this.fb[0] as number;
          this.fb[0] = y;
        }
      }
      let hl = 0;
      let hr = 0;
      for (let k = 0; k < outs.length; k++) {
        const c = outs[k] as number;
        const y = out[c] as number;
        hl += y * (this.cl[c] as number);
        hr += y * (this.cr[c] as number);
      }
      let g = gain;
      if (this.killing > 0) {
        this.killing *= 0.995;
        g *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      l[i] = (l[i] as number) + hl * g;
      r[i] = (r[i] as number) + hr * g;
      if (!alive || (this.released && carriersOff(env, outs))) {
        this.done = true;
        return;
      }
    }
  }
}

function carriersOff(env: Env[], outs: number[]): boolean {
  for (let k = 0; k < outs.length; k++) if (!(env[outs[k] as number] as Env).off) return false;
  return true;
}

export class FmSynth extends Instrument {
  private readonly p: FmParams;
  private readonly preset: string;
  private seed = 1;

  constructor(sr: number, preset: string, params?: Record<string, number>) {
    super(sr);
    this.preset = preset;
    this.p = resolve(preset, params);
    this.maxVoices = 32;
  }

  update(params?: Record<string, number>): void {
    const next = resolve(this.preset, params);
    this.p.brightness = next.brightness;
    this.p.ratio = next.ratio;
    this.p.feedback = next.feedback;
    this.p.attack = next.attack;
    this.p.decay = next.decay;
    this.p.release = next.release;
    for (const v of this.voices as FmVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice {
    return new FmVoice(this.p, key, velocity, this.sr, this.seed++);
  }
}
