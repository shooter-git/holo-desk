/**
 * Six-operator FM: six oscillators wired by a free matrix, so any operator can swing the phase of
 * any other (itself included: feedback), and each is heard at its own level and place. Every
 * operator has a waveform (eight drawn from their harmonics, or one a sound brings), a frequency
 * (a ratio to the note's, or fixed, plus an offset in hertz), velocity sensitivity, a level curve
 * across the keyboard and an envelope of up to eight points that can hold or loop while the key is
 * down. Two state-variable filters sit in the matrix too: operators feed them, and what comes out
 * is heard or swings operators in turn. Unison stacks detuned copies of each note, an LFO moves
 * pitch, cutoff and level, and a four-tap chorus/delay spreads the result.
 *
 * Every modulation is taken from the operators' previous sample, so any wiring is one pass and a
 * loop is just a loop. Envelopes, pitch and the filter's cutoff move every CTRL samples; operator
 * levels glide sample by sample between those steps.
 *
 * A sound may carry a whole patch in its params (the format is in @holo/session's fm6.ts), over the
 * preset it names. Its six knobs (SYNTH_MACROS) move while it plays, over any patch: Brightness
 * scales every modulation, Velocity every velocity sensitivity, Attack, Decay and Release every
 * envelope's times, and Chorus the chorus/delay.
 *
 * Voices are counted as oscillator voices, unison copies each one: when a new note needs more than
 * are free it takes the copies with the highest unison number (the oldest first), so chords thin
 * their unison rather than cutting notes. A note is over once the envelopes of the operators heard
 * (directly or through the filter) are, and, where the filter is heard, a second later: it may still
 * ring, and the note keeps its voice until then.
 */
import { FM6_ENV_POINTS, FM6_KEY_POINTS, FM6_OPS, type Fm6Key, fm6Key, macroValues } from '@holo/session';
import { ifft } from './fft.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

const OPS = FM6_OPS;
/** Envelopes: the six operators', then the filter's, then pitch's. */
const ENVS = OPS + 2;
const ENV_FILTER = OPS;
const ENV_PITCH = OPS + 1;
const POINTS = FM6_ENV_POINTS;
const MAX_UNISON = 8;
/** Samples between control steps. */
const CTRL = 32;
const TAU = Math.PI * 2;

// ---- waveforms -------------------------------------------------------------------------------

/** Points in a cycle (each table has two more: the first two again, so reading never wraps). */
const TABLE = 4096;
/** Band limits: a table with at most 512 harmonics, then 256, … 1. */
const LEVELS = 10;
/** A waveform at each band limit (LEVELS tables). */
type Mips = Float32Array[];

/** Tables for every band limit from a waveform's harmonics (a: cosine, b: sine amplitudes, from 1). */
function mipsFrom(a: Float64Array, b: Float64Array, normalize: boolean): Mips {
  let top = 0;
  for (let h = 1; h < a.length; h++) if ((a[h] as number) !== 0 || (b[h] as number) !== 0) top = h;
  const out: Mips = [];
  let scale = 1;
  let made = -1;
  for (let lv = 0; lv < LEVELS; lv++) {
    const hmax = Math.min(top, 512 >> lv);
    if (hmax === made) {
      out.push(out[lv - 1] as Float32Array);
      continue;
    }
    const re = new Float64Array(TABLE);
    const im = new Float64Array(TABLE);
    for (let h = 1; h <= hmax; h++) {
      re[h] = ((a[h] as number) * TABLE) / 2;
      im[h] = (-(b[h] as number) * TABLE) / 2;
      re[TABLE - h] = re[h] as number;
      im[TABLE - h] = -(im[h] as number);
    }
    ifft(re, im);
    if (lv === 0 && normalize) {
      let peak = 0;
      for (let i = 0; i < TABLE; i++) peak = Math.max(peak, Math.abs(re[i] as number));
      scale = peak > 0 ? 1 / peak : 1;
    }
    const t = new Float32Array(TABLE + 2);
    for (let i = 0; i < TABLE; i++) t[i] = (re[i] as number) * scale;
    t[TABLE] = t[0] as number;
    t[TABLE + 1] = t[1] as number;
    out.push(t);
    made = hmax;
  }
  return out;
}

/** The built-in waveforms (FM6_WAVES), each from its harmonics: peak 1 with every harmonic in. */
function builtInHarmonics(w: number): [Float64Array, Float64Array] {
  const a = new Float64Array(513);
  const b = new Float64Array(513);
  const pi = Math.PI;
  for (let h = 1; h <= 512; h++) {
    const odd = h % 2 === 1;
    switch (w) {
      case 1: // triangle (rising through zero at the start, as the sine does)
        if (odd) b[h] = ((8 / (pi * pi)) * (((h - 1) / 2) % 2 ? -1 : 1)) / (h * h);
        break;
      case 2: // saw, rising
        b[h] = ((2 / pi) * (odd ? 1 : -1)) / h;
        break;
      case 3: // square
        if (odd) b[h] = 4 / (pi * h);
        break;
      case 4: // pulse, a quarter of the cycle up
        a[h] = (2 / (pi * h)) * Math.sin((pi * h) / 2);
        b[h] = (2 / (pi * h)) * (1 - Math.cos((pi * h) / 2));
        break;
      case 5: // half sine: the lower half of each cycle flattened
        if (h === 1) b[h] = 0.5;
        else if (!odd) a[h] = -2 / (pi * (h * h - 1));
        break;
      case 6: // soft saw: every harmonic, falling as 1/h²
        b[h] = 1 / (h * h);
        break;
      case 7: // octave sine
        if (h === 1) b[h] = 1;
        else if (h === 2) b[h] = 0.5;
        break;
      default: // sine
        if (h === 1) b[h] = 1;
    }
  }
  return [a, b];
}

const builtIns: (Mips | undefined)[] = [];
function builtIn(w: number): Mips {
  let m = builtIns[w];
  if (!m) {
    const [a, b] = builtInHarmonics(w);
    m = mipsFrom(a, b, true);
    builtIns[w] = m;
  }
  return m;
}

/** A waveform a sound brings: one cycle of points, taken apart into harmonics and played band-limited. */
function customMips(points: number[]): Mips {
  const n = points.length;
  const top = Math.min(512, Math.floor((n - 1) / 2));
  const a = new Float64Array(top + 1);
  const b = new Float64Array(top + 1);
  for (let h = 1; h <= top; h++) {
    let re = 0;
    let im = 0;
    for (let i = 0; i < n; i++) {
      const w = (TAU * h * i) / n;
      re += (points[i] as number) * Math.cos(w);
      im += (points[i] as number) * Math.sin(w);
    }
    a[h] = (2 * re) / n;
    b[h] = (2 * im) / n;
  }
  return mipsFrom(a, b, false);
}

/** The band limit for a tone of `hz`: the most harmonics that stay below half the sample rate. */
function mipLevel(hz: number, sr: number): number {
  const room = (0.5 * sr) / Math.max(1e-6, Math.abs(hz));
  const lv = 9 - Math.floor(Math.log2(room));
  return lv < 0 ? 0 : lv > LEVELS - 1 ? LEVELS - 1 : lv;
}

// ---- the patch ---------------------------------------------------------------------------------

interface OpPatch {
  on: number;
  wave: number;
  custom: number;
  ratio: number;
  fixed: number;
  hz: number;
  offset: number;
  level: number;
  vel: number;
  out: number;
  pan: number;
  filter: number;
  phase: number;
  free: number;
  /** A level curve across the keyboard: keys (NaN where a point is unused), dB, curves. */
  k: number[];
  kv: number[];
  kc: number[];
}

interface EnvPatch {
  n: number;
  start: number;
  t: number[];
  l: number[];
  c: number[];
  sus: number;
  loop: number;
  kt: number;
  vt: number;
}

interface FilterPatch {
  cutoff: number;
  spread: number;
  res1: number;
  res2: number;
  mode1: number;
  mode2: number;
  serial: number;
  mix: number;
  key: number;
  k: number[];
  kv: number[];
  kc: number[];
  env: number;
  vel: number;
  out: number;
  pan: number;
}

interface Patch {
  ops: OpPatch[];
  /** The matrix: [source × 6 + target], source 6 the filter; radians per unit of the source. */
  mod: number[];
  env: EnvPatch[];
  flt: FilterPatch;
  pitch: { env: number };
  lfo: {
    wave: number;
    rate: number;
    velrate: number;
    phase: number;
    fade: number;
    pitch: number;
    wheel: number;
    cutoff: number;
    amp: number;
  };
  voice: { transpose: number; tune: number; poly: number; level: number; drift: number };
  uni: { voices: number; detune: number; pan: number };
  fx: {
    dry: number;
    wet: number;
    time: number;
    spread: number;
    /** Each tap's multiple of `time`, or NaN to follow `spread`. */
    tap: number[];
    depth: number;
    rate: number;
    /** Each tap's LFO rate, or NaN to follow `rate`. */
    rates: number[];
    feedback: number;
    lowcut: number;
    highcut: number;
  };
  /** Waveforms the sound brings (one cycle each), or empty. */
  waves: number[][];
}

const noCurve = () => [Number.NaN, Number.NaN, Number.NaN, Number.NaN];
const zeros = (n: number) => new Array<number>(n).fill(0);

function blankOp(): OpPatch {
  return {
    on: 0,
    wave: 0,
    custom: 0,
    ratio: 1,
    fixed: 0,
    hz: 440,
    offset: 0,
    level: 1,
    vel: 0,
    out: 0,
    pan: 0,
    filter: 0,
    phase: 0,
    free: 0,
    k: noCurve(),
    kv: zeros(FM6_KEY_POINTS),
    kc: zeros(FM6_KEY_POINTS),
  };
}

function blankEnv(): EnvPatch {
  // held at full until let go, then a short fall
  return {
    n: 2,
    start: 0,
    t: [0.002, 0.1, 0, 0, 0, 0, 0, 0],
    l: [1, 0, 0, 0, 0, 0, 0, 0],
    c: zeros(POINTS),
    sus: 0,
    loop: -1,
    kt: 0,
    vt: 0,
  };
}

function blankPatch(): Patch {
  return {
    ops: Array.from({ length: OPS }, blankOp),
    mod: zeros((OPS + 1) * OPS),
    env: Array.from({ length: ENVS }, blankEnv),
    flt: {
      cutoff: 2000,
      spread: 0,
      res1: 0,
      res2: 0,
      mode1: 0,
      mode2: 0,
      serial: 0,
      mix: 0,
      key: 0,
      k: noCurve(),
      kv: zeros(FM6_KEY_POINTS),
      kc: zeros(FM6_KEY_POINTS),
      env: 0,
      vel: 0,
      out: 0,
      pan: 0,
    },
    pitch: { env: 0 },
    lfo: { wave: 0, rate: 5, velrate: 0, phase: 0, fade: 0, pitch: 0, wheel: 0.5, cutoff: 0, amp: 0 },
    voice: { transpose: 0, tune: 0, poly: 32, level: 0.2, drift: 0 },
    uni: { voices: 1, detune: 0, pan: 0 },
    fx: {
      dry: 1,
      wet: 0,
      time: 0.01,
      spread: 0.5,
      tap: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
      depth: 0.002,
      rate: 0.5,
      rates: [Number.NaN, Number.NaN, Number.NaN, Number.NaN],
      feedback: 0,
      lowcut: 20,
      highcut: 20000,
    },
    waves: [[], [], [], []],
  };
}

/** A copy of a patch (plain objects, arrays and numbers: an AudioWorklet's scope has no structuredClone). */
function clonePatch(p: Patch): Patch {
  return copy(p) as Patch;
}

function copy(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(copy);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, copy(x)]));
  return v;
}

/** Fields that only take whole numbers. */
const WHOLE = new Set(['wave', 'custom', 'n', 'sus', 'loop', 'voices', 'poly']);
/** Fields that are switches. */
const SWITCH = new Set(['on', 'fixed', 'free']);

/** One patch key's value into the patch (already a key of the format: see fm6Key). */
function applyKey(p: Patch, k: Fm6Key, raw: number): void {
  let v = Math.min(k.max, Math.max(k.min, raw));
  if (WHOLE.has(k.field)) v = Math.round(v);
  if (SWITCH.has(k.field)) v = v >= 0.5 ? 1 : 0;
  const set = (o: object, field: string) => {
    (o as Record<string, number>)[field] = v;
  };
  switch (k.part) {
    case 'op': {
      const op = p.ops[k.index] as OpPatch;
      if (k.field === 'k' || k.field === 'kv' || k.field === 'kc') op[k.field][k.sub] = v;
      else set(op, k.field);
      break;
    }
    case 'mod':
      p.mod[k.index * OPS + k.sub] = v;
      break;
    case 'env': {
      const e = p.env[k.index] as EnvPatch;
      if (k.field === 't' || k.field === 'l' || k.field === 'c') e[k.field][k.sub] = v;
      else set(e, k.field);
      break;
    }
    case 'flt':
      if (k.field === 'k' || k.field === 'kv' || k.field === 'kc') p.flt[k.field][k.sub] = v;
      else set(p.flt, k.field);
      break;
    case 'fx':
      if (k.field === 'tap') p.fx.tap[k.sub] = v;
      else if (k.field === 'rate' && k.sub >= 0) p.fx.rates[k.sub] = v;
      else set(p.fx, k.field);
      break;
    case 'wave':
      (p.waves[k.index] as number[])[k.sub] = v;
      break;
    case 'patch':
      // (where it starts was decided before any key was applied)
      break;
    default:
      set(p[k.part], k.field);
  }
}

// ---- the presets -----------------------------------------------------------------------------

type Point = [time: number, level: number, curve?: number];
interface EnvSpec {
  points: Point[];
  sus?: number;
  loop?: number;
  kt?: number;
  vt?: number;
  start?: number;
}
type OpSpec = Partial<Omit<OpPatch, 'k' | 'kv' | 'kc'>> & {
  /** Its level across the keyboard: [key, dB, curve] points. */
  keys?: [number, number, number?][];
  env: EnvSpec;
};
interface PresetSpec {
  /** Operators 1… (the rest are off). */
  ops: OpSpec[];
  /** [from (1…6, or 'f' the filter), to (1…6), radians]. */
  mod: [number | 'f', number, number][];
  filter?: Partial<Omit<FilterPatch, 'k' | 'kv' | 'kc'>> & { env?: number; contour?: EnvSpec };
  pitch?: { env: number; contour: EnvSpec };
  lfo?: Partial<Patch['lfo']>;
  voice?: Partial<Patch['voice']>;
  uni?: Partial<Patch['uni']>;
  fx?: Partial<Omit<Patch['fx'], 'tap' | 'rates'>>;
}

function envFrom(s: EnvSpec): EnvPatch {
  const e = blankEnv();
  e.n = Math.min(POINTS, s.points.length);
  s.points.slice(0, POINTS).forEach(([t, l, c], k) => {
    e.t[k] = t;
    e.l[k] = l;
    e.c[k] = c ?? 0;
  });
  e.sus = s.sus ?? -1;
  e.loop = s.loop ?? -1;
  e.kt = s.kt ?? 0;
  e.vt = s.vt ?? 0;
  e.start = s.start ?? 0;
  return e;
}

function build(s: PresetSpec): Patch {
  const p = blankPatch();
  s.ops.forEach((o, i) => {
    const op = p.ops[i] as OpPatch;
    const { keys, env, ...rest } = o;
    Object.assign(op, { on: 1 }, rest);
    (keys ?? []).forEach(([key, db, c], j) => {
      op.k[j] = key;
      op.kv[j] = db;
      op.kc[j] = c ?? 0;
    });
    p.env[i] = envFrom(env);
  });
  for (const [from, to, amount] of s.mod) p.mod[(from === 'f' ? OPS : from - 1) * OPS + (to - 1)] = amount;
  if (s.filter) {
    const { contour, ...rest } = s.filter;
    Object.assign(p.flt, rest);
    if (contour) p.env[ENV_FILTER] = envFrom(contour);
  }
  if (s.pitch) {
    p.pitch.env = s.pitch.env;
    p.env[ENV_PITCH] = envFrom(s.pitch.contour);
  }
  Object.assign(p.lfo, s.lfo);
  Object.assign(p.voice, s.voice);
  Object.assign(p.uni, s.uni);
  Object.assign(p.fx, s.fx);
  return p;
}

/**
 * A struck shape: up in `a`, then down to nothing over `d` (most of the way early, 20 dB in its first
 * quarter, as a struck string falls), staying there while the key is down; `r` once let go.
 */
const struck = (a: number, d: number, r: number, more: Partial<EnvSpec> = {}): EnvSpec => ({
  points: [
    [a, 1],
    [d, 0, 0.85],
    [r, 0, 0.6],
  ],
  sus: 1,
  ...more,
});
/** Up in `a`, down to `s` over `d`, held there, `r` once let go. */
const held = (a: number, d: number, s: number, r: number, more: Partial<EnvSpec> = {}): EnvSpec => ({
  points: [
    [a, 1],
    [d, s, 0.6],
    [r, 0, 0.7],
  ],
  sus: 1,
  ...more,
});
/** Modulators ease off up the keyboard (dB less at the top), so high notes stay sweet. */
const easeUp = (db: number): [number, number, number?][] => [
  [60, 0],
  [108, -db],
];

const SPECS: Record<string, PresetSpec> = {
  'Bright Tines': {
    ops: [
      { ratio: 1, out: 1, pan: -0.25, vel: 0.35, env: struck(0.002, 7, 0.28, { kt: 0.6 }) },
      { ratio: 14, vel: 0.85, keys: easeUp(12), env: struck(0.001, 1, 0.1, { kt: 0.5 }) },
      { ratio: 1, offset: 0.7, out: 0.7, pan: 0.25, vel: 0.3, env: struck(0.002, 6, 0.28, { kt: 0.6 }) },
      { ratio: 1, vel: 0.7, keys: easeUp(6), env: held(0.002, 2.5, 0.25, 0.3) },
      { ratio: 1, out: 0.3, vel: 0.8, env: struck(0.002, 2.5, 0.2, { kt: 0.6 }) },
      { ratio: 1, vel: 1, keys: easeUp(9), env: struck(0.002, 1.2, 0.1) },
    ],
    mod: [
      [2, 1, 1.5],
      [4, 3, 1.3],
      [4, 4, 0.5],
      [6, 5, 2.2],
    ],
    voice: { level: 0.14 },
    fx: { wet: 0.3, time: 0.008, spread: 0.5, depth: 0.0025, rate: 0.5, lowcut: 150 },
  },
  'Velvet Tines': {
    ops: [
      { ratio: 1, out: 1, pan: -0.2, vel: 0.35, env: struck(0.003, 7.5, 0.35, { kt: 0.5 }) },
      { ratio: 1, vel: 0.6, keys: easeUp(6), env: held(0.003, 2, 0.2, 0.3) },
      { ratio: 1, offset: -0.3, out: 0.6, pan: 0.2, vel: 0.35, env: struck(0.003, 6.5, 0.35, { kt: 0.5 }) },
      { ratio: 7, vel: 0.95, keys: easeUp(12), env: struck(0.001, 0.5, 0.05) },
    ],
    mod: [
      [2, 1, 1.1],
      [2, 2, 0.25],
      [4, 3, 0.55],
    ],
    lfo: { rate: 4.6, amp: 0.15 },
    voice: { level: 0.16 },
    fx: { wet: 0.22, time: 0.01, spread: 0.5, depth: 0.002, rate: 0.4, lowcut: 150 },
  },
  'Glass Keys': {
    ops: [
      { ratio: 1, out: 0.9, pan: -0.3, vel: 0.3, env: held(0.002, 2.5, 0.25, 0.6) },
      { ratio: 3.5, vel: 0.7, keys: easeUp(9), env: held(0.002, 1.2, 0.2, 0.5) },
      { ratio: 2, out: 0.5, pan: 0.3, vel: 0.35, env: held(0.002, 1.6, 0.1, 0.6) },
      { ratio: 7, vel: 0.8, keys: easeUp(12), env: struck(0.001, 1.5, 0.3) },
      { ratio: 1, offset: 0.4, out: 0.6, vel: 0.25, env: held(0.004, 4, 0.3, 0.6) },
    ],
    mod: [
      [2, 1, 1.3],
      [4, 3, 0.9],
    ],
    uni: { voices: 2, detune: 6, pan: 0.9 },
    voice: { level: 0.14 },
    fx: { wet: 0.28, time: 0.009, spread: 0.6, depth: 0.0025, rate: 0.45, lowcut: 150 },
  },
  'Crystal Bells': {
    ops: [
      { ratio: 1, out: 1, pan: -0.2, vel: 0.3, env: struck(0.001, 12, 1.5, { kt: 0.7 }) },
      { ratio: 3.5, vel: 0.7, keys: easeUp(12), env: struck(0.001, 5, 1, { kt: 0.6 }) },
      { ratio: 2.76, out: 0.45, pan: 0.3, vel: 0.35, env: struck(0.001, 8, 1.2, { kt: 0.7 }) },
      { ratio: 1.41, vel: 0.6, keys: easeUp(9), env: struck(0.001, 4, 0.8) },
      { ratio: 0.5, out: 0.3, vel: 0.2, env: struck(0.003, 14, 1.8, { kt: 0.7 }) },
      { ratio: 7.07, vel: 0.9, keys: easeUp(12), env: struck(0.001, 1, 0.2) },
    ],
    mod: [
      [2, 1, 2.2],
      [4, 3, 1.5],
      [6, 1, 0.5],
    ],
    uni: { voices: 2, detune: 3, pan: 0.5 },
    voice: { level: 0.12 },
    fx: {
      wet: 0.16,
      time: 0.32,
      spread: 0.5,
      depth: 0.0008,
      rate: 0.3,
      feedback: 0.3,
      lowcut: 300,
      highcut: 9000,
    },
  },
  'Music Box': {
    ops: [
      { ratio: 1, out: 1, vel: 0.35, env: struck(0.001, 3.5, 0.4, { kt: 1 }) },
      { ratio: 5, vel: 0.6, keys: easeUp(9), env: struck(0.001, 0.6, 0.1, { kt: 0.8 }) },
      { ratio: 3, out: 0.25, vel: 0.4, env: struck(0.001, 1.5, 0.2, { kt: 1 }) },
      { ratio: 7, vel: 0.6, keys: easeUp(12), env: struck(0.001, 0.5, 0.1) },
    ],
    mod: [
      [2, 1, 0.9],
      [4, 3, 0.7],
    ],
    voice: { level: 0.18 },
    fx: {
      wet: 0.14,
      time: 0.18,
      spread: 0.3,
      depth: 0.0006,
      rate: 0.35,
      feedback: 0.2,
      lowcut: 300,
      highcut: 10000,
    },
  },
  'Solid Bass': {
    ops: [
      { ratio: 1, out: 1, vel: 0.3, env: held(0.002, 1.2, 0.75, 0.08, { kt: 0.3 }) },
      { ratio: 1, vel: 0.6, keys: easeUp(8), env: held(0.001, 0.35, 0.35, 0.08) },
      { ratio: 3, vel: 0.7, keys: easeUp(8), env: struck(0.001, 0.06, 0.05) },
      { ratio: 1, out: 0.4, vel: 0.2, env: held(0.002, 1.5, 0.8, 0.08) },
    ],
    mod: [
      [2, 1, 2.2],
      [2, 2, 0.9],
      [3, 2, 1.2],
    ],
    voice: { level: 0.12 },
    fx: { wet: 0.08, time: 0.007, spread: 0.4, depth: 0.0015, rate: 0.6, lowcut: 400 },
  },
  'Rubber Bass': {
    ops: [
      { ratio: 1, filter: 1, vel: 0.3, env: held(0.002, 0.9, 0.6, 0.1) },
      { ratio: 1, wave: 3, level: 0.6, filter: 1, vel: 0.3, env: held(0.002, 0.9, 0.6, 0.1) },
      { ratio: 2, vel: 0.6, env: held(0.001, 0.2, 0.2, 0.1) },
    ],
    mod: [
      [1, 1, 1.6],
      [3, 1, 0.8],
    ],
    filter: {
      cutoff: 220,
      spread: 12,
      res1: 0.55,
      res2: 0.3,
      serial: 1,
      mix: 1,
      key: 0.5,
      env: 40,
      vel: 0.5,
      out: 1,
      contour: {
        points: [
          [0.001, 1],
          [0.28, 0, 0.7],
          [0.2, 0],
        ],
        sus: 1,
      },
    },
    voice: { level: 0.16 },
    fx: { wet: 0.06, time: 0.007, spread: 0.4, depth: 0.0015, rate: 0.6, lowcut: 400 },
  },
  'Silk Pad': {
    ops: [
      { ratio: 1, filter: 1, pan: -0.3, vel: 0.2, env: held(1.4, 3, 0.8, 2.5) },
      { ratio: 2, vel: 0.3, env: held(2.2, 4, 0.6, 2.5) },
      { ratio: 1, offset: 0.3, filter: 1, pan: 0.3, vel: 0.2, env: held(1.4, 3, 0.8, 2.5) },
      { ratio: 1, vel: 0.3, env: held(1.8, 4, 0.7, 2.5) },
      { ratio: 2, filter: 0.3, vel: 0.2, env: held(2.5, 3, 0.6, 2.5) },
    ],
    mod: [
      [2, 1, 1],
      [4, 3, 0.9],
      [4, 4, 0.35],
    ],
    filter: { cutoff: 1600, res1: 0.25, key: 0.5, out: 1 },
    lfo: { rate: 0.12, cutoff: 10 },
    uni: { voices: 3, detune: 9, pan: 0.8 },
    voice: { level: 0.08, drift: 2 },
    fx: { wet: 0.35, time: 0.014, spread: 0.6, depth: 0.003, rate: 0.35, feedback: 0.15, lowcut: 150 },
  },
  'Halo Pad': {
    ops: [
      { ratio: 1, out: 0.8, pan: -0.4, vel: 0.2, env: held(1.2, 2, 0.85, 3) },
      {
        ratio: 3,
        vel: 0.3,
        env: {
          points: [
            [1.5, 0.9],
            [2.6, 0.25, 0.3],
            [2.2, 0.9, -0.3],
            [3, 0, 0.6],
          ],
          sus: 2,
          loop: 0,
        },
      },
      { ratio: 2, out: 0.4, pan: 0.4, vel: 0.2, env: held(1.5, 2, 0.8, 3) },
      {
        ratio: 5,
        vel: 0.3,
        env: {
          points: [
            [1, 0.3],
            [1.7, 0.9, -0.2],
            [3.1, 0.2, 0.3],
            [3, 0, 0.6],
          ],
          sus: 2,
          loop: 0,
        },
      },
    ],
    mod: [
      [2, 1, 1.1],
      [4, 3, 0.8],
    ],
    uni: { voices: 2, detune: 7, pan: 1 },
    voice: { level: 0.18 },
    fx: {
      wet: 0.22,
      time: 0.42,
      spread: 0.4,
      depth: 0.002,
      rate: 0.2,
      feedback: 0.35,
      lowcut: 250,
      highcut: 9000,
    },
  },
  'Wire Lead': {
    ops: [
      { ratio: 1, out: 1, vel: 0.25, env: held(0.004, 0.6, 0.85, 0.18) },
      { ratio: 1, vel: 0.5, keys: easeUp(6), env: held(0.003, 0.4, 0.7, 0.18) },
      { ratio: 2, out: 0.35, vel: 0.25, env: held(0.004, 0.6, 0.85, 0.18) },
      { ratio: 1, vel: 0.5, env: held(0.003, 0.5, 0.6, 0.18) },
    ],
    mod: [
      [2, 1, 1.8],
      [2, 2, 1.2],
      [4, 3, 1],
    ],
    lfo: { rate: 5.4, pitch: 0.08, wheel: 0.6, fade: 0.5 },
    uni: { voices: 2, detune: 8, pan: 0.4 },
    voice: { level: 0.12 },
    fx: { wet: 0.15, time: 0.27, spread: 0.3, depth: 0.001, rate: 0.3, feedback: 0.25, lowcut: 250 },
  },
  'Hollow Lead': {
    ops: [
      {
        ratio: 1,
        out: 1,
        vel: 0.25,
        env: {
          points: [
            [0.02, 1, -0.2],
            [0.5, 0.9],
            [0.2, 0, 0.6],
          ],
          sus: 1,
        },
      },
      {
        ratio: 2,
        vel: 0.4,
        env: {
          points: [
            [0.04, 1, -0.3],
            [0.6, 0.8],
            [0.2, 0, 0.6],
          ],
          sus: 1,
        },
      },
      { ratio: 3, out: 0.15, vel: 0.3, env: held(0.02, 0.5, 0.8, 0.2) },
    ],
    mod: [[2, 1, 1.4]],
    lfo: { rate: 5.2, pitch: 0.12, wheel: 0.5, fade: 0.6 },
    voice: { level: 0.12 },
    fx: { wet: 0.12, time: 0.3, spread: 0.3, depth: 0.001, rate: 0.3, feedback: 0.2, lowcut: 250 },
  },
  'Harp Pluck': {
    ops: [
      { ratio: 1, out: 1, pan: -0.15, vel: 0.35, env: struck(0.001, 4, 0.35, { kt: 0.8 }) },
      { ratio: 1, vel: 0.6, keys: easeUp(6), env: held(0.001, 0.12, 0.1, 0.2) },
      { ratio: 2, out: 0.35, pan: 0.15, vel: 0.35, env: struck(0.001, 2.5, 0.3, { kt: 0.8 }) },
      { ratio: 3, vel: 0.6, keys: easeUp(9), env: struck(0.001, 0.25, 0.1) },
    ],
    mod: [
      [2, 1, 1.3],
      [4, 3, 0.6],
    ],
    voice: { level: 0.22 },
    fx: { wet: 0.16, time: 0.012, spread: 0.5, depth: 0.002, rate: 0.4, lowcut: 150 },
  },
  'Spark Pluck': {
    ops: [
      { ratio: 1, out: 1, vel: 0.35, env: struck(0.001, 1, 0.15, { kt: 0.4 }) },
      { ratio: 3, vel: 0.6, keys: easeUp(9), env: struck(0.001, 0.35, 0.1) },
      { ratio: 1, vel: 0.5, env: struck(0.001, 0.6, 0.1) },
    ],
    mod: [
      [2, 1, 2.4],
      [3, 1, 0.6],
      [3, 3, 0.8],
    ],
    uni: { voices: 2, detune: 6, pan: 0.6 },
    voice: { level: 0.2 },
    fx: {
      wet: 0.2,
      time: 0.188,
      spread: 0.35,
      depth: 0.0007,
      rate: 0.4,
      feedback: 0.32,
      lowcut: 300,
      highcut: 8000,
    },
  },
};

const PRESETS: Record<string, Patch> = Object.fromEntries(Object.entries(SPECS).map(([k, s]) => [k, build(s)]));

export const FM6_PRESETS = Object.keys(PRESETS);

// ---- resolved for playing ------------------------------------------------------------------------

/** An envelope curve (-1…1) as the ratio its segment moves by: level = A + (start - A)·r^(t/T). */
function curveRatio(c: number): number {
  const s = Math.min(0.999, Math.max(0.001, (c + 1) / 2));
  const x = s > 0.5 ? s * (4 - 2 * s) - 1 : 2 * s * s;
  return (1 / x - 1) ** 2;
}

/** A level curve's value at `pitch`: between its points along each stretch's curve, flat beyond them. */
function keyCurve(k: number[], v: number[], c: number[], pitch: number): number {
  const at: number[] = [];
  for (let j = 0; j < k.length; j++) if (Number.isFinite(k[j])) at.push(j);
  if (!at.length) return 0;
  if (at.length === 1) return v[at[0] as number] as number;
  let i = 1;
  while (i < at.length - 1 && pitch > (k[at[i] as number] as number)) i++;
  const j0 = at[i - 1] as number;
  const j1 = at[i] as number;
  const k0 = k[j0] as number;
  const k1 = k[j1] as number;
  const fr = k1 === k0 ? 0 : Math.min(1, Math.max(0, (pitch - k0) / (k1 - k0)));
  const v0 = v[j0] as number;
  const v1 = v[j1] as number;
  const r = curveRatio(c[j1] as number);
  return Math.abs(r - 1) < 1e-5 ? v0 + fr * (v1 - v0) : v0 + ((v1 - v0) * (r ** fr - 1)) / (r - 1);
}

/** How strongly velocity `v` (1…127) plays something of sensitivity `s`: (v/127)^(2.45·s), turned over below 0. */
function velocityGain(s: number, v: number): number {
  if (s >= 0) return (v / 127) ** (2.45 * s);
  return ((128 - v) / 127) ** (-2.45 * s);
}

interface Fm6Params {
  // the knobs
  brightness: number;
  velocity: number;
  attack: number;
  decay: number;
  release: number;
  chorus: number;
  patch: Patch;
  /** Each operator's waveform. */
  tables: Mips[];
  /** The operators that run (those heard, through the output, the filter, or another that is). */
  act: Int8Array;
  nAct: number;
  /** The operators heard directly or through the filter: the note is over once these are. */
  audible: Int8Array;
  nAudible: number;
  /** The filter is heard: a note holds on a second after its operators, for the filter to ring out. */
  filterHeard: boolean;
  /** Operator-to-operator modulation (cycles of phase per unit), Brightness in. */
  routeSrc: Int8Array;
  routeDst: Int8Array;
  routeAmt: Float64Array;
  routes: number;
  /** The filter's swing on each operator (cycles per unit), and whether there is any. */
  fAmt: Float64Array;
  fMod: boolean;
  /** The operators heard directly, and those sent into the filter. */
  heard: Int8Array;
  nHeard: number;
  sent: Int8Array;
  nSent: number;
  /** Each operator's gains to the output and into the filter, left and right. */
  oL: Float64Array;
  oR: Float64Array;
  zL: Float64Array;
  zR: Float64Array;
  filterOn: boolean;
  foL: number;
  foR: number;
  /** Filter 1's and 2's damping, input gains and blend of low/band/high-pass; filter 2's ratio. */
  k1: number;
  k2: number;
  gin1: number;
  gin2: number;
  m1: Float64Array;
  m2: Float64Array;
  spread: number;
  envTop: number;
  /** Every envelope point's curve ratio: [envelope × POINTS + point]. */
  curve: Float64Array;
  /** Envelopes whose held part is silent (holding or looping at nothing). */
  quietHold: Uint8Array;
}

/** A filter's mode (0 low, 1 band, 2 high-pass) as its blend of the three. */
function modeGains(m: number): Float64Array {
  return m < 1 ? Float64Array.of(1 - m, m, 0) : Float64Array.of(0, 2 - m, m - 1);
}

function derive(patch: Patch, knobs: Record<string, number>, waveCache: Map<string, Mips>): Fm6Params {
  const ops = patch.ops;
  const on = (i: number) => (ops[i] as OpPatch).on >= 0.5;
  const amount = (s: number, t: number) => patch.mod[s * OPS + t] as number;
  const f = patch.flt;
  // what is heard: operators with an output, and through the filter if it has one
  const relevant = new Uint8Array(OPS);
  let filterUsed = false;
  for (let pass = 0; pass <= OPS + 1; pass++) {
    let modHeard = false;
    for (let t = 0; t < OPS; t++) if (relevant[t] && on(t) && amount(OPS, t) !== 0) modHeard = true;
    filterUsed = f.out !== 0 || modHeard;
    for (let i = 0; i < OPS; i++) {
      if (!on(i) || relevant[i]) continue;
      const o = ops[i] as OpPatch;
      if (o.out !== 0 || (o.filter !== 0 && filterUsed)) relevant[i] = 1;
      for (let t = 0; t < OPS; t++) if (t !== i && relevant[t] && amount(i, t) !== 0) relevant[i] = 1;
    }
  }
  const filterOn = filterUsed && ops.some((o, i) => relevant[i] && o.filter !== 0);
  const act: number[] = [];
  const audible: number[] = [];
  for (let i = 0; i < OPS; i++) {
    if (!relevant[i]) continue;
    act.push(i);
    const o = ops[i] as OpPatch;
    if (o.out !== 0 || (o.filter !== 0 && filterOn && f.out !== 0)) audible.push(i);
  }
  // with nothing heard through the filter but operators swung by it, they still are
  if (!audible.length && filterOn) for (const i of act) if ((ops[i] as OpPatch).filter !== 0) audible.push(i);
  const b = knobs.brightness ?? 1;
  const src: number[] = [];
  const dst: number[] = [];
  const amt: number[] = [];
  for (const s of act)
    for (const t of act) {
      const a = amount(s, t);
      if (a === 0) continue;
      src.push(s);
      dst.push(t);
      amt.push((a * b) / TAU);
    }
  const fAmt = new Float64Array(OPS);
  let fMod = false;
  if (filterOn)
    for (const t of act) {
      fAmt[t] = (amount(OPS, t) * b) / TAU;
      if (fAmt[t] !== 0) fMod = true;
    }
  const oL = new Float64Array(OPS);
  const oR = new Float64Array(OPS);
  const zL = new Float64Array(OPS);
  const zR = new Float64Array(OPS);
  const heard = act.filter((i) => (ops[i] as OpPatch).out !== 0);
  const sent = filterOn ? act.filter((i) => (ops[i] as OpPatch).filter !== 0) : [];
  for (const i of act) {
    const o = ops[i] as OpPatch;
    oL[i] = o.out * Math.min(1, 1 - o.pan);
    oR[i] = o.out * Math.min(1, 1 + o.pan);
    if (filterOn) {
      zL[i] = o.filter * Math.min(1, 1 - o.pan);
      zR[i] = o.filter * Math.min(1, 1 + o.pan);
    }
  }
  const tables = ops.map((o) => {
    const own = o.custom > 0 ? (patch.waves[o.custom - 1] as number[]) : [];
    let n = 0;
    while (n < own.length && Number.isFinite(own[n])) n++;
    if (n >= 4) {
      const pts = own.slice(0, n);
      const sig = pts.join(',');
      let m = waveCache.get(sig);
      if (!m) {
        m = customMips(pts);
        waveCache.set(sig, m);
      }
      return m;
    }
    return builtIn(o.wave);
  });
  const k1 = 2 - 2 * f.res1;
  const k2 = 2 - 2 * f.res2;
  const spread = 2 ** (f.spread / 12);
  const lift = Math.min(0.1, Math.max(0, (spread - 1) * 0.3));
  const curve = new Float64Array(ENVS * POINTS);
  const quietHold = new Uint8Array(ENVS);
  patch.env.forEach((e, i) => {
    e.n = Math.min(POINTS, Math.max(1, e.n));
    e.sus = Math.min(e.n - 1, e.sus);
    e.loop = Math.min(e.sus, e.loop);
    for (let k = 0; k < POINTS; k++) curve[i * POINTS + k] = curveRatio(e.c[k] as number);
    if (e.sus >= 0) {
      let loud = Math.abs(e.l[e.sus] as number);
      if (e.loop >= 0 && e.loop < e.sus)
        for (let k = e.loop + 1; k <= e.sus; k++) loud = Math.max(loud, Math.abs(e.l[k] as number));
      quietHold[i] = loud < 1e-5 ? 1 : 0;
    }
  });
  return {
    brightness: b,
    velocity: knobs.velocity ?? 1,
    attack: knobs.attack ?? 1,
    decay: knobs.decay ?? 1,
    release: knobs.release ?? 1,
    chorus: knobs.chorus ?? 1,
    patch,
    tables,
    act: Int8Array.from(act),
    nAct: act.length,
    audible: Int8Array.from(audible),
    nAudible: audible.length,
    filterHeard: filterOn && f.out !== 0,
    routeSrc: Int8Array.from(src),
    routeDst: Int8Array.from(dst),
    routeAmt: Float64Array.from(amt),
    routes: src.length,
    fAmt,
    fMod,
    heard: Int8Array.from(heard),
    nHeard: heard.length,
    sent: Int8Array.from(sent),
    nSent: sent.length,
    oL,
    oR,
    zL,
    zR,
    filterOn,
    foL: f.out * Math.min(1, 1 - f.pan),
    foR: f.out * Math.min(1, 1 + f.pan),
    k1,
    k2,
    gin1: Math.sqrt(k1 + lift),
    gin2: Math.sqrt(k2 + lift),
    m1: modeGains(f.mode1),
    m2: modeGains(f.mode2),
    spread,
    envTop: 2 ** (f.env / 12),
    curve,
    quietHold,
  };
}

const DEFAULT = 'Bright Tines';

function resolve(preset: string, params: Record<string, number> | undefined, waveCache: Map<string, Mips>): Fm6Params {
  const name = PRESETS[preset] ? preset : DEFAULT;
  // a whole patch may start from nothing rather than from the preset it names
  const patch = (params?.['patch:blank'] ?? 0) >= 0.5 ? blankPatch() : clonePatch(PRESETS[name] as Patch);
  if (params)
    for (const [id, v] of Object.entries(params)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const k = fm6Key(id);
      if (k) applyKey(patch, k, v);
    }
  return derive(patch, macroValues(name, params), waveCache);
}

// ---- envelopes ---------------------------------------------------------------------------------------

/**
 * A release starting from `y0` toward `to` takes this share of its time: its time is for a fall from
 * just above full, so from lower it has less of the way to go (along its own curve where it bends
 * toward its end, in proportion otherwise).
 */
function releaseShare(y0: number, to: number, r: number): number {
  const top = 1.05;
  if (y0 > to) {
    if (top <= y0) return 1;
    return r >= 1 ? (y0 - to) / (top - to) : 1 - Math.log(((r - 1) * (y0 - top)) / (to - top) + 1) / Math.log(r);
  }
  if (y0 === to) return 0;
  if (y0 > 0 && to > 0) return r >= 1 ? (to - y0) / to : 1 - Math.log(((r - 1) * y0) / to + 1) / Math.log(r);
  return 1;
}

/** One multi-point envelope, stepped every CTRL samples: each segment y ← a·y + b. */
class Contour {
  y: number;
  done = false;
  holding = false;
  private a = 1;
  private b = 0;
  private left = 0;
  private carry = 0;
  private seg = -1;
  private released = false;
  private readonly p: Fm6Params;
  private readonly e: number;
  private readonly rate: number;
  private readonly scale: number;

  constructor(p: Fm6Params, e: number, rate: number, scale: number) {
    this.p = p;
    this.e = e;
    this.rate = rate;
    this.scale = scale;
    this.y = (p.patch.env[e] as EnvPatch).start;
    this.next();
  }

  tick(): void {
    if (this.done || this.holding) return;
    this.y = this.a * this.y + this.b;
    if (--this.left <= 0) this.next();
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const E = this.p.patch.env[this.e] as EnvPatch;
    if (E.sus < 0 || this.done || this.seg > E.sus) return;
    // from where it is: the release starts at the next step
    this.seg = E.sus;
    this.holding = false;
    this.left = 1;
  }

  /** Over, or holding (or looping) at nothing: it adds no more. */
  get quiet(): boolean {
    if (this.done) return true;
    if (Math.abs(this.y) >= 1e-5 || this.released || !this.p.quietHold[this.e]) return false;
    const E = this.p.patch.env[this.e] as EnvPatch;
    return this.holding || (E.loop >= 0 && this.seg > E.loop && this.seg <= E.sus);
  }

  private next(): void {
    const p = this.p;
    const E = p.patch.env[this.e] as EnvPatch;
    let k = this.seg + 1;
    if (this.seg === E.sus && !this.released) {
      if (E.loop >= 0 && E.loop < E.sus) k = E.loop + 1;
      else {
        this.holding = true;
        return;
      }
    }
    if (k >= E.n) {
      this.done = true;
      return;
    }
    this.seg = k;
    const to = E.l[k] as number;
    let r = p.curve[this.e * POINTS + k] as number;
    const knob = k === 0 ? p.attack : E.sus < 0 || k <= E.sus ? p.decay : p.release;
    let time = (E.t[k] as number) * this.scale * knob;
    if (E.sus >= 0 && k === E.sus + 1) time *= releaseShare(this.y, to, r);
    // whole steps, the rounding carried on so long envelopes keep their time
    const want = Math.max(0, time * this.rate - this.carry);
    const n = Math.max(1, Math.round(want));
    this.carry = n - want;
    const y0 = this.y;
    if (Math.abs(r - 1) < 1e-5) {
      this.a = 1;
      this.b = (to - y0) / n;
    } else {
      if (r * y0 > 1000) r = 1000 / y0;
      else if (r * y0 < -1000) r = -1000 / y0;
      const A = (to - r * y0) / (1 - r);
      this.a = r ** (1 / n);
      this.b = A * (1 - this.a);
      if (Math.abs(this.b) < 1e-30) this.b = 0;
    }
    this.left = n;
  }
}

// ---- a note --------------------------------------------------------------------------------------

/** A unison copy's place in the stack (in detune steps): ±0.5, ±1.5… for an even count, 0, ±1… for odd. */
function unisonOffset(k: number, n: number): number {
  if (n % 2 === 0) return k % 2 === 0 ? Math.floor(k / 2) + 0.5 : -0.5 - Math.floor(k / 2);
  return k % 2 === 0 ? -Math.floor(k / 2) : (k + 1) / 2;
}

class Fm6Voice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  /** Unison copies: how many, each one's unison number, sounding, fading out (taken by another note). */
  readonly copies: number;
  readonly unison: Int8Array;
  readonly live: Uint8Array;
  private readonly dropping: Uint8Array;
  private readonly fade: Float64Array;
  private readonly cl: Float64Array;
  private readonly cr: Float64Array;
  /** Each copy's frequency over the note's. */
  private readonly dr: Float64Array;
  // per copy and operator: [copy × OPS + operator]
  private readonly ph: Float64Array;
  private readonly inc: Float64Array;
  private readonly out: Float64Array;
  private readonly mods: Float64Array;
  // per operator (shared by the copies)
  private readonly amp = new Float64Array(OPS);
  private readonly ampInc = new Float64Array(OPS);
  private readonly fac = new Float64Array(OPS);
  private readonly tabs: Float32Array[];
  private readonly env: (Contour | null)[] = [];
  // the filter: [instance × 8 + lane × 2 + (0, 1)], lanes left 1, left 2, right 1, right 2
  private readonly fs: Float64Array;
  private readonly zMono: Float64Array;
  private fa1 = new Float64Array(2);
  private fa2 = new Float64Array(2);
  private fa3 = new Float64Array(2);
  private fyl = 0;
  private fyr = 0;
  private fFac = 1;
  // the LFO
  private lfoPh = 0;
  private lfoInc = 0;
  private lfoHeld = 0;
  private ticks = 0;
  private gain = 0;
  private gainInc = 0;
  private left = 0;
  private killing = 0;
  /** Control steps since everything heard went quiet, and how many the filter may ring for. */
  private hold = 0;
  private readonly holdTicks: number;
  /** The operators are silent and only the filter rings out; it has died away. */
  private ringing = false;
  private rung = false;
  private readonly p: Fm6Params;
  private readonly sr: number;
  private readonly vel: number;
  private readonly pitch: number;
  private seed: number;
  private readonly dropK: number;

  constructor(p: Fm6Params, key: number, velocity: number, sr: number, ks: number[], n: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.vel = velocity;
    this.seed = seed * 2654435761 || 1;
    const P = p.patch;
    const U = ks.length;
    this.copies = U;
    this.unison = Int8Array.from(ks);
    this.live = new Uint8Array(U).fill(1);
    this.dropping = new Uint8Array(U);
    this.fade = new Float64Array(U).fill(1);
    this.cl = new Float64Array(U);
    this.cr = new Float64Array(U);
    this.dr = new Float64Array(U);
    this.ph = new Float64Array(U * OPS);
    this.inc = new Float64Array(U * OPS);
    this.out = new Float64Array(U * OPS);
    this.mods = new Float64Array(U * OPS);
    this.dropK = Math.exp(-6.9 / (0.005 * sr));
    this.holdTicks = Math.round(sr / CTRL);
    const half = (n - 1) / 2;
    for (let c = 0; c < U; c++) {
      const off = unisonOffset(ks[c] as number, n);
      const cents = off * P.uni.detune + P.voice.drift * this.random();
      this.dr[c] = 2 ** (cents / 1200);
      const pan = half > 0 ? (P.uni.pan * off) / half : 0;
      this.cl[c] = Math.min(1, 1 - pan);
      this.cr[c] = Math.min(1, 1 + pan);
      for (let o = 0; o < OPS; o++) {
        const op = P.ops[o] as OpPatch;
        this.ph[c * OPS + o] = op.free ? (this.random() + 1) / 2 : op.phase;
      }
    }
    this.pitch = key + P.voice.transpose + P.voice.tune / 100;
    this.tabs = p.tables.map((m) => m[0] as Float32Array);
    const instances = p.filterOn ? (p.fMod ? U : 1) : 0;
    this.fs = new Float64Array(instances * 8);
    this.zMono = new Float64Array(U);
    this.retime();
    // the envelopes: each operator that runs, the filter's if it moves the cutoff, pitch's if it moves pitch
    const rate = sr / CTRL;
    for (let e = 0; e < ENVS; e++) {
      const E = P.env[e] as EnvPatch;
      const used = e < OPS ? p.act.includes(e) : e === ENV_FILTER ? p.filterOn && P.flt.env !== 0 : P.pitch.env !== 0;
      const scale = 2 ** ((-E.kt * (this.pitch - 60)) / 12) * 2 ** ((-E.vt * (velocity - 64)) / 63);
      this.env.push(used ? new Contour(p, e, rate, scale) : null);
    }
    const L = P.lfo;
    this.lfoPh = L.phase;
    this.lfoInc = (L.rate * 2 ** ((L.velrate * (velocity - 64)) / 63 / 12) * CTRL) / sr;
    this.lfoHeld = this.random();
  }

  /** A draw from the note's own sequence, −1…1. */
  private random(): number {
    let s = this.seed;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.seed = s;
    return (s | 0) / 2147483648;
  }

  /** What depends on the knobs and is fixed for the note: each operator's level, the filter's tracking. */
  retime(): void {
    const p = this.p;
    const P = p.patch;
    for (let o = 0; o < OPS; o++) {
      const op = P.ops[o] as OpPatch;
      const g =
        op.level * velocityGain(op.vel * p.velocity, this.vel) * 10 ** (keyCurve(op.k, op.kv, op.kc, this.pitch) / 20);
      this.fac[o] = Math.min(16, Math.max(-16, g));
    }
    const f = P.flt;
    this.fFac =
      2 ** ((f.key * (this.pitch - 60) + keyCurve(f.k, f.kv, f.kc, this.pitch)) / 12) *
      velocityGain(f.vel * p.velocity, this.vel);
  }

  /** The unison copy with the highest number still sounding, or -1. */
  highest(): number {
    let k = -1;
    for (let c = 0; c < this.copies; c++)
      if (this.live[c] && !this.dropping[c]) k = Math.max(k, this.unison[c] as number);
    return k;
  }

  /** Copies sounding (not fading out). */
  get sounding(): number {
    let n = 0;
    for (let c = 0; c < this.copies; c++) if (this.live[c] && !this.dropping[c]) n++;
    return n;
  }

  /** Give up a unison copy to another note: it fades out in a few milliseconds. */
  drop(k: number): void {
    for (let c = 0; c < this.copies; c++) if ((this.unison[c] as number) === k && this.live[c]) this.dropping[c] = 1;
  }

  release(): void {
    this.released = true;
    for (const e of this.env) e?.release();
  }

  kill(): void {
    this.released = true;
    if (this.killing === 0) this.killing = 1;
  }

  /** The control step: envelopes, the LFO, pitch, levels, the cutoff. */
  private tick(ctl: Controls): void {
    const p = this.p;
    const P = p.patch;
    const sr = this.sr;
    const env = this.env;
    for (let e = 0; e < ENVS; e++) env[e]?.tick();
    // (only the hold is left to count)
    if (this.rung) {
      this.over();
      return;
    }
    // the LFO
    const L = P.lfo;
    let ph = this.lfoPh + this.lfoInc;
    if (ph >= 1) {
      ph -= Math.floor(ph);
      this.lfoHeld = this.random();
    }
    this.lfoPh = ph;
    let w: number;
    switch (L.wave) {
      case 1:
        w = ph < 0.25 ? 4 * ph : ph < 0.75 ? 2 - 4 * ph : 4 * ph - 4;
        break;
      case 2:
        w = 2 * ph - 1;
        break;
      case 3:
        w = ph < 0.5 ? 1 : -1;
        break;
      case 4:
        w = this.lfoHeld;
        break;
      default:
        w = Math.sin(TAU * ph);
    }
    const depth = L.fade > 0 ? Math.min(1, (this.ticks * CTRL) / (sr * L.fade)) : 1;
    this.ticks++;
    const up = (0.5 + 0.5 * w) * depth;
    // pitch, and each operator's step through its wave
    let semis = this.pitch + ctl.bend + w * depth * (L.pitch + L.wheel * ctl.mod);
    const pe = env[ENV_PITCH];
    if (pe) semis += P.pitch.env * pe.y;
    const f0 = 440 * 2 ** ((semis - 69) / 12);
    const act = p.act;
    for (let j = 0; j < p.nAct; j++) {
      const o = act[j] as number;
      const op = P.ops[o] as OpPatch;
      const base = op.fixed ? op.hz : op.ratio * f0;
      this.tabs[o] = (p.tables[o] as Mips)[mipLevel(base + op.offset, sr)] as Float32Array;
      for (let c = 0; c < this.copies; c++) {
        const hz = (op.fixed ? op.hz : op.ratio * f0 * (this.dr[c] as number)) + op.offset;
        this.inc[c * OPS + o] = Math.min(0.49, Math.max(-0.49, hz / sr));
      }
      const e = env[o];
      const target = (this.fac[o] as number) * (e ? e.y : 0);
      this.ampInc[o] = (target - (this.amp[o] as number)) / CTRL;
    }
    // the filter's cutoffs
    if (p.filterOn) {
      const fe = env[ENV_FILTER];
      const f = P.flt;
      let hz = f.cutoff * this.fFac * (fe ? 1 + (p.envTop - 1) * fe.y : 1);
      if (L.cutoff !== 0) hz *= 2 ** ((L.cutoff * up) / 12);
      for (let i = 0; i < 2; i++) {
        const fc = Math.min(sr * 0.45, Math.max(1, i === 0 ? hz : hz * p.spread));
        const g = Math.tan((Math.PI * fc) / sr);
        const k = i === 0 ? p.k1 : p.k2;
        const a1 = 1 / (1 + g * (g + k));
        this.fa1[i] = a1;
        this.fa2[i] = g * a1;
        this.fa3[i] = g * g * a1;
      }
      // (tiny states flushed: no slow denormal arithmetic in a ringing-out filter)
      const fs = this.fs;
      let most = 0;
      for (let i = 0; i < fs.length; i++) {
        const v = Math.abs(fs[i] as number);
        if (v < 1e-18) fs[i] = 0;
        else if (v > most) most = v;
      }
      // with nothing more going in, once it has died away there is nothing left to run
      this.rung = this.ringing && most < 1e-6;
    }
    const target = P.voice.level * ctl.expression * (1 - L.amp * up);
    this.gainInc = (target - this.gain) / CTRL;
    this.over();
  }

  /** Over once everything heard is, and a second later where the filter is heard (it may still ring). */
  private over(): void {
    const p = this.p;
    const env = this.env;
    if (this.killing === 0) {
      let quiet = true;
      for (let j = 0; j < p.nAudible; j++) {
        const e = env[p.audible[j] as number];
        if (e && !e.quiet) {
          quiet = false;
          break;
        }
      }
      if (!quiet) {
        this.hold = 0;
        this.ringing = false;
        this.rung = false;
      } else {
        let loud = 0;
        for (let j = 0; j < p.nAudible; j++)
          loud = Math.max(loud, Math.abs(this.amp[p.audible[j] as number] as number));
        if (p.filterHeard && this.hold < this.holdTicks) {
          this.hold++;
          this.ringing = loud < 1e-4;
        } else if (loud < 1e-4) this.done = true;
        else this.killing = 1;
      }
    }
  }

  /** One sample through filter instance `s`: the result in fyl/fyr. */
  private filter(s: number, xl: number, xr: number): void {
    const p = this.p;
    const fs = this.fs;
    const a1 = this.fa1[0] as number;
    const a2 = this.fa2[0] as number;
    const a3 = this.fa3[0] as number;
    const b1 = this.fa1[1] as number;
    const b2 = this.fa2[1] as number;
    const b3 = this.fa3[1] as number;
    const m1 = p.m1;
    const m2 = p.m2;
    const k1 = p.k1;
    const k2 = p.k2;
    const serial = p.patch.flt.serial;
    const mix = p.patch.flt.mix;
    const o = s * 8;
    for (let side = 0; side < 2; side++) {
      const q = o + side * 4;
      const x = side === 0 ? xl : xr;
      // filter 1
      let ic1 = fs[q] as number;
      let ic2 = fs[q + 1] as number;
      let u = x * p.gin1;
      let v3 = u - ic2;
      let v1 = a1 * ic1 + a2 * v3;
      let v2 = ic2 + a2 * ic1 + a3 * v3;
      fs[q] = 2 * v1 - ic1;
      fs[q + 1] = 2 * v2 - ic2;
      const y1 = (m1[0] as number) * v2 + (m1[1] as number) * v1 + (m1[2] as number) * (u - k1 * v1 - v2);
      // filter 2: side by side, or fed by filter 1
      ic1 = fs[q + 2] as number;
      ic2 = fs[q + 3] as number;
      u = (1 - serial) * p.gin2 * x + serial * y1;
      v3 = u - ic2;
      v1 = b1 * ic1 + b2 * v3;
      v2 = ic2 + b2 * ic1 + b3 * v3;
      fs[q + 2] = 2 * v1 - ic1;
      fs[q + 3] = 2 * v2 - ic2;
      const y2 = (m2[0] as number) * v2 + (m2[1] as number) * v1 + (m2[2] as number) * (u - k2 * v1 - v2);
      const y = mix * y2 + (1 - mix) * y1;
      if (side === 0) this.fyl = y;
      else this.fyr = y;
    }
  }

  /** One sample of the filter ringing out with nothing going in, added at `i`; true once the voice is over. */
  private ring(l: Float32Array, r: Float32Array, i: number): boolean {
    let yl = 0;
    let yr = 0;
    for (let s = 0, n = this.fs.length >> 3; s < n; s++) {
      this.filter(s, 0, 0);
      yl += this.fyl;
      yr += this.fyr;
    }
    this.gain += this.gainInc;
    let g = this.gain;
    if (this.killing > 0) {
      this.killing *= 0.995;
      g *= this.killing;
      if (this.killing < 1e-3) {
        this.done = true;
        return true;
      }
    }
    l[i] = (l[i] as number) + yl * this.p.foL * g;
    r[i] = (r[i] as number) + yr * this.p.foR * g;
    return false;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const p = this.p;
    const U = this.copies;
    const act = p.act;
    const nAct = p.nAct;
    const rs = p.routeSrc;
    const rd = p.routeDst;
    const ra = p.routeAmt;
    const nr = p.routes;
    const fAmt = p.fAmt;
    const fMod = p.fMod;
    // (a filter switched on while the note plays waits for the next note: this one has no room for it)
    const filterOn = p.filterOn && this.fs.length > 0;
    const perCopy = filterOn && fMod && this.fs.length >= U * 8;
    const heard = p.heard;
    const nHeard = p.nHeard;
    const sent = p.sent;
    const nSent = filterOn ? p.nSent : 0;
    const oL = p.oL;
    const oR = p.oR;
    const zL = p.zL;
    const zR = p.zR;
    const ph = this.ph;
    const inc = this.inc;
    const out = this.out;
    const amp = this.amp;
    const ampInc = this.ampInc;
    const mods = this.mods;
    const tabs = this.tabs;
    const live = this.live;
    const fade = this.fade;
    const cl = this.cl;
    const cr = this.cr;
    const zMono = this.zMono;
    for (let i = start; i < end; i++) {
      if (this.left-- <= 0) {
        this.tick(ctl);
        this.left = CTRL - 1;
        if (this.done) return;
      }
      if (this.ringing) {
        // the operators are silent: only the filter, ringing out on nothing, until it has; then
        // nothing to do but wait for the next control step
        if (this.rung) {
          if (this.killing > 0) {
            this.done = true;
            return;
          }
          const k = Math.min(this.left, end - 1 - i);
          i += k;
          this.left -= k;
        } else if (this.ring(l, r, i)) return;
        continue;
      }
      for (let j = 0; j < nAct; j++) {
        const o = act[j] as number;
        amp[o] = (amp[o] as number) + (ampInc[o] as number);
      }
      // each operator's swing in every copy, from the last sample's outputs
      for (let j = 0; j < nAct; j++) {
        const o = act[j] as number;
        const a = fMod ? (fAmt[o] as number) : 0;
        for (let c = 0; c < U; c++) mods[c * OPS + o] = a * (zMono[c] as number);
      }
      for (let k = 0; k < nr; k++) {
        const s = rs[k] as number;
        const d = rd[k] as number;
        const a = ra[k] as number;
        for (let c = 0, b = 0; c < U; c++, b += OPS) mods[b + d] = (mods[b + d] as number) + a * (out[b + s] as number);
      }
      // each operator, through every copy
      for (let j = 0; j < nAct; j++) {
        const o = act[j] as number;
        const t = tabs[o] as Float32Array;
        const a = amp[o] as number;
        for (let c = 0, q = o; c < U; c++, q += OPS) {
          if (live[c] === 0) continue;
          let x = (ph[q] as number) + (inc[q] as number);
          if (x >= 1) x -= 1;
          else if (x < 0) x += 1;
          ph[q] = x;
          const y = x + (mods[q] as number);
          const f = (y - Math.floor(y)) * TABLE;
          const n = f | 0;
          const t0 = t[n] as number;
          out[q] = (t0 + ((t[n + 1] as number) - t0) * (f - n)) * a;
        }
      }
      let sumL = 0;
      let sumR = 0;
      let fl = 0;
      let fr = 0;
      for (let c = 0; c < U; c++) {
        if (live[c] === 0) continue;
        const b = c * OPS;
        let xl = 0;
        let xr = 0;
        for (let j = 0; j < nHeard; j++) {
          const o = heard[j] as number;
          const v = out[b + o] as number;
          xl += (oL[o] as number) * v;
          xr += (oR[o] as number) * v;
        }
        let yl = 0;
        let yr = 0;
        for (let j = 0; j < nSent; j++) {
          const o = sent[j] as number;
          const v = out[b + o] as number;
          yl += (zL[o] as number) * v;
          yr += (zR[o] as number) * v;
        }
        let g = fade[c] as number;
        if (this.dropping[c]) {
          g *= this.dropK;
          fade[c] = g;
          if (g < 1e-3) live[c] = 0;
        }
        const gl = (cl[c] as number) * g;
        const gr = (cr[c] as number) * g;
        if (perCopy) {
          this.filter(c, yl * gl, yr * gr);
          zMono[c] = 0.5 * (this.fyl + this.fyr);
          sumL += xl * gl + this.fyl * p.foL;
          sumR += xr * gr + this.fyr * p.foR;
        } else {
          sumL += xl * gl;
          sumR += xr * gr;
          fl += yl * gl;
          fr += yr * gr;
        }
      }
      if (filterOn && !perCopy) {
        this.filter(0, fl, fr);
        sumL += this.fyl * p.foL;
        sumR += this.fyr * p.foR;
      }
      this.gain += this.gainInc;
      let g = this.gain;
      if (this.killing > 0) {
        this.killing *= 0.995;
        g *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      l[i] = (l[i] as number) + sumL * g;
      r[i] = (r[i] as number) + sumR * g;
    }
    let any = false;
    for (let c = 0; c < U; c++) if (live[c]) any = true;
    if (!any) this.done = true;
  }
}

// ---- the chorus/delay -----------------------------------------------------------------------------

/** Each tap's LFO rate over the patch's, unless the patch sets them: a little apart, so they never line up. */
const TAP_RATES = [1, 1.13, 0.89, 1.07];

/**
 * Four taps on a delay line, two reading the left input and two the right, each swung by a slow
 * triangle; the left output takes the right's taps (and a little of the left's), the right the
 * left's, and each output feeds back into its side's input. What goes in is band-limited first.
 */
class ChorusDelay {
  on = false;
  private bufL = new Float32Array(0);
  private bufR = new Float32Array(0);
  private mask = 0;
  private pos = 0;
  private readonly tap = new Float64Array(4);
  private readonly cur = new Float64Array(4);
  private readonly step = new Float64Array(4);
  private readonly lfo = new Float64Array(4);
  private readonly lfoInc = new Float64Array(4);
  private depth = 0;
  private dry = 1;
  private wet = 0;
  private feedback = 0;
  private lc = 0;
  private hc = 1;
  private lcL = 0;
  private lcR = 0;
  private hcL = 0;
  private hcR = 0;
  private fbL = 0;
  private fbR = 0;
  private left = 0;
  private fresh = true;
  /** How loud its last block's output was, for knowing when it has rung out. */
  peak = 0;
  private readonly sr: number;

  constructor(sr: number) {
    this.sr = sr;
  }

  configure(fx: Patch['fx'], chorus: number): void {
    const sr = this.sr;
    this.dry = fx.dry;
    this.wet = fx.wet * chorus;
    this.on = this.wet !== 0;
    this.feedback = fx.feedback;
    this.depth = fx.depth * sr;
    this.lc = 1 - Math.exp((-TAU * fx.lowcut) / sr);
    this.hc = fx.highcut >= 20000 ? 1 : 1 - Math.exp((-TAU * fx.highcut) / sr);
    const s = fx.spread;
    const lay = [1 - s / 2, 1 + s / 2, 1, 1 + s];
    let longest = 0;
    for (let i = 0; i < 4; i++) {
      const m = Number.isFinite(fx.tap[i]) ? (fx.tap[i] as number) : (lay[i] as number);
      this.tap[i] = m * fx.time * sr;
      longest = Math.max(longest, this.tap[i] as number);
      const rate = Number.isFinite(fx.rates[i]) ? (fx.rates[i] as number) : fx.rate * (TAP_RATES[i] as number);
      this.lfoInc[i] = (4 * rate * CTRL) / sr;
    }
    const need = longest + this.depth + 4;
    let size = 1024;
    while (size < need) size *= 2;
    if (size > this.bufL.length) {
      this.bufL = new Float32Array(size);
      this.bufR = new Float32Array(size);
      this.mask = size - 1;
      this.pos = 0;
    }
    const lo = this.depth + 1;
    const hi = this.bufL.length - 2 - this.depth;
    for (let i = 0; i < 4; i++) this.tap[i] = Math.min(hi, Math.max(lo, this.tap[i] as number));
    if (this.fresh) {
      this.cur.set(this.tap);
      this.fresh = false;
    }
  }

  /** dl/dr (the voices) through it, added into l/r. */
  process(dl: Float32Array, dr: Float32Array, l: Float32Array, r: Float32Array, start: number, end: number): void {
    const bl = this.bufL;
    const br = this.bufR;
    const mask = this.mask;
    const cur = this.cur;
    const step = this.step;
    const dry = this.dry;
    const wet = this.wet;
    const fb = this.feedback;
    const lc = this.lc;
    const hc = this.hc;
    let pos = this.pos;
    let peak = 0;
    for (let i = start; i < end; i++) {
      if (this.left-- <= 0) {
        this.left = CTRL - 1;
        for (let t = 0; t < 4; t++) {
          let ph = (this.lfo[t] as number) + (this.lfoInc[t] as number);
          if (ph >= 3) ph -= 4;
          this.lfo[t] = ph;
          const tri = Math.min(2 - ph, ph);
          step[t] = (this.depth * tri + (this.tap[t] as number) - (cur[t] as number)) / CTRL;
        }
      }
      const inL = dl[i] as number;
      const inR = dr[i] as number;
      const xl = inL + fb * this.fbL;
      const xr = inR + fb * this.fbR;
      // band-limited into the line: low-passed at the high cut, less its own low-passed self
      this.hcL += hc * (xl - this.hcL);
      this.hcR += hc * (xr - this.hcR);
      this.lcL += lc * (this.hcL - this.lcL);
      this.lcR += lc * (this.hcR - this.lcR);
      bl[pos] = this.hcL - this.lcL;
      br[pos] = this.hcR - this.lcR;
      let t0 = 0;
      let t1 = 0;
      let t2 = 0;
      let t3 = 0;
      for (let t = 0; t < 4; t++) {
        const c = (cur[t] as number) + (step[t] as number);
        cur[t] = c;
        const k = Math.floor(c);
        const fr = c - k;
        const buf = t < 2 ? bl : br;
        const a = buf[(pos - k) & mask] as number;
        const v = a + ((buf[(pos - k - 1) & mask] as number) - a) * fr;
        if (t === 0) t0 = v;
        else if (t === 1) t1 = v;
        else if (t === 2) t2 = v;
        else t3 = v;
      }
      pos = (pos + 1) & mask;
      const oL = t2 + 0.95 * t3 + 0.05 * t1;
      const oR = t0 + 0.95 * t1 + 0.05 * t3;
      this.fbL = oL;
      this.fbR = oR;
      const a = Math.abs(oL) + Math.abs(oR);
      if (a > peak) peak = a;
      l[i] = (l[i] as number) + dry * inL + wet * oL;
      r[i] = (r[i] as number) + dry * inR + wet * oR;
    }
    this.pos = pos;
    this.peak = peak * Math.abs(wet);
    if (Math.abs(this.hcL) + Math.abs(this.hcR) + Math.abs(this.fbL) + Math.abs(this.fbR) < 1e-20) {
      this.hcL = this.hcR = this.lcL = this.lcR = this.fbL = this.fbR = 0;
    }
  }
}

// ---- the instrument --------------------------------------------------------------------------------

export class Fm6Synth extends Instrument {
  private readonly p: Fm6Params;
  private readonly preset: string;
  private readonly waves = new Map<string, Mips>();
  private readonly fx: ChorusDelay;
  private seed = 1;
  private dryL = new Float32Array(0);
  private dryR = new Float32Array(0);
  private tail = 0;
  /** The DC blocker's memory and pole (an offset feedback can leave, gone in a fraction of a second). */
  private dcxL = 0;
  private dcxR = 0;
  private dcyL = 0;
  private dcyR = 0;
  private readonly dcPole: number;

  constructor(sr: number, preset: string, params?: Record<string, number>) {
    super(sr);
    this.preset = preset;
    this.p = resolve(preset, params, this.waves);
    this.maxVoices = 64;
    this.dcPole = 1 - (TAU * 2) / sr;
    this.fx = new ChorusDelay(sr);
    this.fx.configure(this.p.patch.fx, this.p.chorus);
  }

  update(params?: Record<string, number>): void {
    Object.assign(this.p, resolve(this.preset, params, this.waves));
    this.fx.configure(this.p.patch.fx, this.p.chorus);
    for (const v of this.voices as Fm6Voice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice | null {
    const P = this.p.patch;
    const budget = Math.round(P.voice.poly);
    const n = Math.min(budget, Math.round(P.uni.voices), MAX_UNISON);
    const voices = this.voices as Fm6Voice[];
    let used = 0;
    for (const v of voices) if (!v.done) used += v.sounding;
    const ks: number[] = [];
    for (let k = 0; k < n; k++) {
      if (used < budget) {
        ks.push(k);
        used++;
        continue;
      }
      // none free: the copy with the highest unison number (at least this one's), the oldest's first
      let best: Fm6Voice | null = null;
      let bestK = -1;
      for (const v of voices) {
        if (v.done) continue;
        const h = v.highest();
        if (h < k) continue;
        if (h > bestK || (h === bestK && best && v.age < best.age)) {
          best = v;
          bestK = h;
        }
      }
      if (!best) break;
      best.drop(bestK);
      ks.push(k);
    }
    if (!ks.length) return null;
    return new Fm6Voice(this.p, key, velocity, this.sr, ks, n, this.seed++);
  }

  override get active(): number {
    return super.active + (this.tail > 2e-5 ? 1 : 0);
  }

  override render(l: Float32Array, r: Float32Array, start: number, end: number): void {
    // nothing sounding and the delay quiet: nothing to do
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
    const pole = this.dcPole;
    let xl = this.dcxL;
    let xr = this.dcxR;
    let yl = this.dcyL;
    let yr = this.dcyR;
    for (let i = start; i < end; i++) {
      const a = dl[i] as number;
      const b = dr[i] as number;
      yl = a - xl + pole * yl;
      yr = b - xr + pole * yr;
      xl = a;
      xr = b;
      dl[i] = yl;
      dr[i] = yr;
    }
    // (flushed when they've died away: no slow denormal arithmetic)
    this.dcxL = xl;
    this.dcxR = xr;
    this.dcyL = Math.abs(yl) < 1e-20 ? 0 : yl;
    this.dcyR = Math.abs(yr) < 1e-20 ? 0 : yr;
    const fx = this.fx;
    if (fx.on) {
      fx.process(dl, dr, l, r, start, end);
      this.tail = Math.max(fx.peak, this.tail * 0.9);
    } else {
      const dry = this.p.patch.fx.dry;
      for (let i = start; i < end; i++) {
        l[i] = (l[i] as number) + dry * (dl[i] as number);
        r[i] = (r[i] as number) + dry * (dr[i] as number);
      }
      this.tail = 0;
    }
  }
}
