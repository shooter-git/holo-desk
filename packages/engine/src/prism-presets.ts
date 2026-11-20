/**
 * Prism's presets, each a whole patch in the keys a sound carries (see @holo/session's prism.ts),
 * over the blank patch. Each wires its six knobs (Macro 1…6, swinging either way about their
 * middle) where they matter, so a sound is as made with its knobs half way.
 */
import {
  PER_FX,
  PER_SOURCE,
  SRC_ENV,
  SRC_KEY,
  SRC_LFO,
  SRC_MACRO,
  SRC_SEQ,
  SRC_SHAPE,
  SRC_VELOCITY,
  SRC_WHEEL,
  TGT_ENV_TIME,
  TGT_F1_CUTOFF,
  TGT_F1_DRIVE,
  TGT_F1_RES,
  TGT_FX,
  TGT_LEVEL,
  TGT_LFO_RATE,
  TGT_PAN,
  TGT_PITCH,
  TGT_X,
  TGT_Y,
} from '@holo/session';

type Keys = Record<string, number>;

const prefixed = (head: string, o: Keys): Keys =>
  Object.fromEntries(Object.entries(o).map(([k, v]) => [`${head}:${k}`, v]));
const src = (n: number, o: Keys) => prefixed(`s${n}`, { on: 1, ...o });
const flt = (n: number, o: Keys) => prefixed(`f${n}`, { on: 1, ...o });
const lfo = (n: number, o: Keys) => prefixed(`lfo${n}`, o);
const env = (n: number, o: Keys) => prefixed(`env${n}`, o);
const fx = (n: number, o: Keys) => prefixed(`fx${n}`, o);
const voice = (o: Keys) => prefixed('voice', o);
const amp = (o: Keys) => prefixed('amp', o);
const xy = (o: Keys) => prefixed('xy', { on: 1, ...o });

/** A step sequencer: its settings and its steps' values (ties where `ties` has a 1). */
function seq(n: number, o: Keys, values: number[], ties: number[] = []): Keys {
  const out = prefixed(`seq${n}`, { steps: values.length, ...o });
  values.forEach((v, k) => {
    out[`seq${n}:v${k}`] = v;
    if (ties[k]) out[`seq${n}:t${k}`] = 1;
  });
  return out;
}

/** A drawn shape: its points [x, y, curve] and its settings. */
function shape(n: number, points: [number, number, number?][], o: Keys): Keys {
  const out = prefixed(`shape${n}`, { n: points.length, ...o });
  points.forEach(([x, y, c], k) => {
    out[`shape${n}:x${k}`] = x;
    out[`shape${n}:y${k}`] = y;
    if (c) out[`shape${n}:c${k}`] = c;
  });
  return out;
}

/** A link of the matrix. */
interface L {
  src: number;
  dst: number;
  depth: number;
  via?: number;
  viadepth?: number;
  curve?: number;
}

/** The links, numbered from 1 (the blank patch's velocity link is replaced by the first). */
function wire(list: L[]): Keys {
  const out: Keys = {};
  list.forEach((l, i) => {
    const h = `mod${i + 1}`;
    out[`${h}:src`] = l.src;
    out[`${h}:dst`] = l.dst;
    out[`${h}:depth`] = l.depth;
    if (l.via) {
      out[`${h}:via`] = l.via;
      out[`${h}:viadepth`] = l.viadepth ?? 0;
    }
    if (l.curve) out[`${h}:curve`] = l.curve;
  });
  return out;
}

/** Source s's target (field: 0 level … 15 resonance, PRISM_SOURCE_TARGETS). */
const S = (s: number, field: number) => (s - 1) * PER_SOURCE + field;
const LEVEL = 0;
const PAN = 1;
const POS = 3;
const DETUNE = 10;
const CUTOFF = 14;
const AMPMORPH = 6;
const SYM = 9;
const FX = (slot: number, j: number) => TGT_FX + (slot - 1) * PER_FX + j;
const ENV_A = (e: number) => TGT_ENV_TIME + (e - 1) * 3;
const ENV_D = (e: number) => TGT_ENV_TIME + (e - 1) * 3 + 1;
const M = (k: number) => SRC_MACRO + k - 1;
const LFO = (k: number) => SRC_LFO + k - 1;
const ENV = (k: number) => SRC_ENV + k - 1;
const SEQ = (k: number) => SRC_SEQ + k - 1;
const SHAPE = (k: number) => SRC_SHAPE + k - 1;

// the built-in data (PRISM_PARTIAL_SETS, PRISM_SAMPLES), counted from 1
const BAR = 1;
const GLASS = 2;
const BELL = 3;
const BOWL = 4;
const VOICE = 5;
const STRIKE = 6;
const AIR = 1;
const SHIMMER = 2;
const CHOIR = 3;
const CHIME = 4;

/** The usual room and echo, on slots 5 and 6, their mixes on Macro 5 (echo) and 6 (space). */
function room(echo: Keys, space: Keys): Keys {
  return {
    ...fx(5, { type: 1, sync: 1, time: 0.75, feedback: 0.35, cross: 0.5, lowcut: 250, highcut: 6000, ...echo }),
    ...fx(6, { type: 6, size: 0.7, decay: 3.5, damp: 0.45, predelay: 0.02, width: 1, ...space }),
  };
}
const roomLinks = (echoDepth = 0.25, spaceDepth = 0.3): L[] => [
  { src: M(5), dst: FX(5, 0), depth: echoDepth },
  { src: M(6), dst: FX(6, 0), depth: spaceDepth },
];

export const PRISM_PRESET_KEYS: Record<string, Keys> = {
  // ---- bell pulses ----
  'Pulse Bells': {
    // a struck tone restruck on every beat (its position swept by a synced ramp), a glass layer
    // an octave up on the half note, hopping between the sides
    ...src(1, { kind: 1, data: STRIKE, partials: 28, stereo: 1, pana: 3, width: 0.25, panmix: 0, level: 1 }),
    ...src(2, { kind: 1, data: GLASS, partials: 12, coarse: 12, stereo: 1, pana: 1, width: 0.6, level: 0.9 }),
    ...flt(1, { type: 0, cutoff: 4200, res: 0.12 }),
    ...lfo(1, { shape: 2, sync: 1, beats: 1, bipolar: 0 }),
    ...lfo(2, { shape: 2, sync: 1, beats: 2, bipolar: 0 }),
    ...lfo(3, { shape: 5, sync: 1, beats: 1, bipolar: 1 }),
    ...env(1, { a: 0.002, d: 0, s: 1, r: 1.6 }),
    ...amp({ level: 0.21 }),
    ...voice({ poly: 8 }),
    ...room({ time: 0.75, feedback: 0.4, mix: 0.25 }, { decay: 3.8, size: 0.75, mix: 0.3 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.55 },
      { src: LFO(1), dst: S(1, POS), depth: 0.38 },
      { src: LFO(2), dst: S(2, POS), depth: 0.22 },
      // Pulse: the strikes' pace, from half notes to eighths (a quarter at the middle)
      { src: M(2), dst: TGT_LFO_RATE, depth: 0.05 },
      { src: M(2), dst: TGT_LFO_RATE + 1, depth: 0.05 },
      { src: M(2), dst: TGT_LFO_RATE + 2, depth: 0.05 },
      { src: M(1), dst: TGT_F1_CUTOFF, depth: 0.16 },
      { src: SRC_VELOCITY, dst: TGT_F1_CUTOFF, depth: 0.08 },
      { src: M(3), dst: S(2, LEVEL), depth: 1 },
      { src: LFO(3), dst: TGT_PAN, depth: 0.35, via: M(4), viadepth: 0.35 },
      ...roomLinks(),
    ]),
  },
  'Glass Steps': {
    // mallet tones on a free bar's modes, accented by a sixteenth-note pattern, over a glass strike
    ...src(1, {
      kind: 0,
      wave: 0,
      count: 5,
      pitcha: 6,
      pitchb: 6,
      ampa: 6,
      ampb: 5,
      amp: 0.4,
      level: 0.55,
      stereo: 1,
      pana: 3,
      width: 0.2,
    }),
    ...src(2, { kind: 1, data: GLASS, partials: 12, stereo: 1, pana: 1, width: 0.5, level: 0.7 }),
    ...flt(1, { type: 0, cutoff: 5200, res: 0.1 }),
    ...seq(
      1,
      { beats: 0.25, attack: 0, gate: 0.15, release: 0.6 },
      [1, 0.25, 0.55, 0.25, 0.85, 0.25, 0.55, 0.4, 1, 0.25, 0.55, 0.25, 0.85, 0.4, 0.6, 0.3],
    ),
    ...lfo(1, { shape: 2, sync: 1, beats: 1, bipolar: 0 }),
    ...lfo(2, { shape: 5, sync: 1, beats: 0.5, bipolar: 1 }),
    ...env(1, { a: 0.002, d: 0, s: 1, r: 1.2 }),
    ...amp({ level: 0.31 }),
    ...room({ time: 0.5, feedback: 0.3, mix: 0.2 }, { decay: 3, mix: 0.25 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.5 },
      { src: SEQ(1), dst: S(1, LEVEL), depth: 0.85, via: M(2), viadepth: 0.15 },
      { src: LFO(1), dst: S(2, POS), depth: 0.3 },
      { src: M(1), dst: TGT_F1_CUTOFF, depth: 0.15 },
      { src: M(3), dst: S(2, LEVEL), depth: 1 },
      { src: LFO(2), dst: TGT_PAN, depth: 0.25, via: M(4), viadepth: 0.25 },
      ...roomLinks(),
    ]),
  },

  // ---- evolving pads ----
  'Drift Pad': {
    // a detuned saw stack, a voice of partials singing through its vowels, and grains of shimmer,
    // all morphing slowly about a point on the pad
    ...src(1, {
      kind: 0,
      wave: 2,
      count: 7,
      pitcha: 1,
      pitchb: 1,
      detune: 9,
      stereo: 1,
      pana: 1,
      width: 0.85,
      level: 0.3,
    }),
    ...src(2, {
      kind: 1,
      data: VOICE,
      partials: 24,
      speed: 0.35,
      loop: 1,
      stereo: 1,
      pana: 3,
      width: 0.35,
      level: 1.1,
    }),
    ...src(3, {
      kind: 3,
      data: SHIMMER,
      size: 0.2,
      density: 6,
      jitter: 0.5,
      spray: 0.8,
      stereo: 1,
      speed: 0.3,
      loop: 4,
      level: 1,
    }),
    ...src(4, { kind: 0, wave: 0, count: 1, coarse: -12, level: 0.4 }),
    ...xy({ x: 0.4, y: 0.4, power: 1 }),
    ...flt(1, { type: 0, cutoff: 1900, res: 0.18 }),
    ...lfo(1, { shape: 0, rate: 0.05, bipolar: 1, phase: 0.1 }),
    ...lfo(2, { shape: 1, rate: 0.071, bipolar: 1, phase: 0.6 }),
    ...lfo(3, { shape: 0, rate: 0.13, bipolar: 1 }),
    ...env(1, { a: 1.4, d: 0, s: 1, r: 3.5, ac: 0.3 }),
    ...env(2, { a: 2.5, d: 4, s: 0.55, r: 3 }),
    ...amp({ level: 0.4 }),
    ...voice({ poly: 8 }),
    ...fx(4, { type: 2, rate: 0.25, depth: 3, delay: 9, feedback: 0.15, width: 1, mix: 0.3 }),
    ...room({ time: 1.5, feedback: 0.35, mix: 0.12 }, { decay: 6, size: 0.9, damp: 0.5, mix: 0.32 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.3 },
      { src: LFO(1), dst: TGT_X, depth: 0.15, via: M(3), viadepth: 0.15 },
      { src: LFO(2), dst: TGT_Y, depth: 0.15, via: M(3), viadepth: 0.15 },
      { src: M(1), dst: TGT_X, depth: 0.3 },
      { src: M(1), dst: TGT_Y, depth: 0.25 },
      { src: LFO(3), dst: TGT_F1_CUTOFF, depth: 0.04, via: M(3), viadepth: 0.04 },
      { src: ENV(2), dst: TGT_F1_CUTOFF, depth: 0.12 },
      { src: M(2), dst: TGT_F1_CUTOFF, depth: 0.2 },
      { src: M(4), dst: S(3, LEVEL), depth: 1 },
      { src: M(5), dst: ENV_A(1), depth: 0.25 },
      ...roomLinks(0.1, 0.3),
    ]),
  },
  'Choir Bloom': {
    // grains of a small choir, a voice of partials moving through its vowels on a drawn shape, and
    // a soft saw underneath
    ...src(1, {
      kind: 3,
      data: CHOIR,
      size: 0.13,
      density: 8,
      jitter: 0.35,
      spray: 0.7,
      stereo: 1,
      speed: 0.6,
      loop: 4,
      level: 1.2,
    }),
    ...src(2, { kind: 1, data: VOICE, partials: 26, stereo: 1, pana: 3, width: 0.3, level: 1 }),
    ...src(3, {
      kind: 0,
      wave: 6,
      count: 3,
      pitcha: 1,
      pitchb: 1,
      detune: 7,
      stereo: 1,
      pana: 1,
      width: 0.7,
      level: 0.35,
    }),
    ...flt(1, { type: 0, cutoff: 3200, res: 0.1 }),
    ...shape(
      1,
      [
        [0, 0.2, 0.3],
        [3, 0.55, -0.2],
        [6, 0.85, 0.2],
        [9, 0.4],
        [12, 0.2],
      ],
      { loop: 1, ls: 0, le: 4 },
    ),
    ...lfo(1, { shape: 0, rate: 0.09, bipolar: 1 }),
    ...env(1, { a: 0.9, d: 0, s: 1, r: 2.8, ac: 0.4 }),
    ...amp({ level: 0.17 }),
    ...fx(4, { type: 2, rate: 0.18, depth: 2.5, delay: 12, width: 1, mix: 0.25 }),
    ...room({ time: 1, mix: 0.1 }, { decay: 5, size: 0.85, mix: 0.35 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.3 },
      { src: SHAPE(1), dst: S(2, POS), depth: 0.55 },
      { src: M(1), dst: S(2, POS), depth: 0.2 },
      { src: LFO(1), dst: S(1, PAN), depth: 0.3, via: M(2), viadepth: 0.2 },
      { src: M(3), dst: S(1, LEVEL), depth: 1 },
      { src: M(4), dst: TGT_F1_CUTOFF, depth: 0.15 },
      { src: M(2), dst: S(3, DETUNE), depth: 0.06 },
      ...roomLinks(0.1, 0.3),
    ]),
  },

  // ---- plucks ----
  'Glass Pluck': {
    // two detuned saws through a ladder snapping shut, with a struck bar an octave up
    ...src(1, {
      kind: 0,
      wave: 2,
      count: 2,
      pitcha: 1,
      pitchb: 1,
      detune: 7,
      stereo: 1,
      pana: 1,
      width: 0.5,
      level: 0.55,
    }),
    ...src(2, { kind: 1, data: BAR, partials: 12, coarse: 12, speed: 1, level: 1 }),
    ...flt(1, { type: 6, cutoff: 380, res: 0.28 }),
    ...env(1, { a: 0.001, d: 1.6, s: 0, r: 0.45, dc: 0.6, rc: 0.3 }),
    ...env(2, { a: 0.001, d: 0.32, s: 0, r: 0.3, dc: 0.6 }),
    ...amp({ level: 0.37 }),
    ...room({ time: 0.75, feedback: 0.35, mix: 0.2 }, { decay: 2.5, mix: 0.22 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.6 },
      { src: ENV(2), dst: TGT_F1_CUTOFF, depth: 0.42 },
      { src: SRC_VELOCITY, dst: TGT_F1_CUTOFF, depth: 0.12 },
      { src: SRC_KEY, dst: TGT_F1_CUTOFF, depth: 0.08 },
      { src: M(1), dst: TGT_F1_CUTOFF, depth: 0.16 },
      { src: M(2), dst: ENV_D(1), depth: 0.2 },
      { src: M(2), dst: ENV_D(2), depth: 0.2 },
      { src: M(3), dst: S(2, LEVEL), depth: 1 },
      { src: M(4), dst: S(1, DETUNE), depth: 0.08 },
      ...roomLinks(),
    ]),
  },
  'Wood Pluck': {
    // a struck bar's partials ringing out, a soft triangle body and a breath of mallet
    ...src(1, { kind: 1, data: BAR, partials: 16, speed: 1, level: 1.3 }),
    ...src(2, { kind: 0, wave: 1, count: 1, level: 0.5 }),
    ...src(3, { kind: 2, data: AIR, ftype: 3, cutoff: 2600, res: 0.5, level: 0.9 }),
    ...flt(1, { type: 0, cutoff: 5500, res: 0.05 }),
    ...env(1, { a: 0.001, d: 2.8, s: 0, r: 0.5, dc: 0.5 }),
    ...env(2, { a: 0.001, d: 0.45, s: 0, r: 0.2, dc: 0.6 }),
    ...env(3, { a: 0.0005, d: 0.04, s: 0, r: 0.03, dc: 0.6 }),
    ...amp({ level: 0.27 }),
    ...room({ time: 0.5, mix: 0.15 }, { decay: 2, size: 0.5, mix: 0.2 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.6 },
      { src: ENV(2), dst: S(2, LEVEL), depth: 1 },
      { src: ENV(3), dst: S(3, LEVEL), depth: 1 },
      { src: SRC_VELOCITY, dst: TGT_F1_CUTOFF, depth: 0.12 },
      { src: M(1), dst: TGT_F1_CUTOFF, depth: 0.16 },
      { src: M(2), dst: ENV_D(1), depth: 0.2 },
      { src: M(3), dst: S(3, LEVEL), depth: 1 },
      { src: M(4), dst: S(2, LEVEL), depth: 1 },
      ...roomLinks(),
    ]),
  },

  // ---- basses ----
  'Deep Bass': {
    // two saws and a sine an octave down through a growling diode filter; one note at a time, gliding
    ...src(1, { kind: 0, wave: 2, count: 2, pitcha: 1, pitchb: 1, detune: 5, level: 0.5 }),
    ...src(2, { kind: 0, wave: 0, count: 1, coarse: -12, level: 0.95 }),
    ...src(3, { kind: 0, wave: 3, count: 1, level: 0.3 }),
    ...flt(1, { type: 4, cutoff: 260, res: 0.35, drive: 0.3 }),
    ...env(1, { a: 0.002, d: 0, s: 1, r: 0.12 }),
    ...env(2, { a: 0.001, d: 0.28, s: 0.18, r: 0.2, dc: 0.5 }),
    ...amp({ level: 0.28 }),
    ...voice({ mono: 1, legato: 1, glide: 0.06, poly: 1 }),
    ...fx(1, { type: 3, drive: 0.35, tube: 0.4, output: 1, mix: 0.4 }),
    ...fx(2, { type: 5, amount: 0.3, release: 0.15, mix: 1 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.45 },
      { src: ENV(2), dst: TGT_F1_CUTOFF, depth: 0.3, via: M(4), viadepth: 0.15 },
      { src: SRC_VELOCITY, dst: TGT_F1_CUTOFF, depth: 0.08 },
      { src: SRC_KEY, dst: TGT_F1_CUTOFF, depth: 0.1 },
      { src: M(1), dst: TGT_F1_CUTOFF, depth: 0.18 },
      { src: M(2), dst: TGT_F1_RES, depth: 0.35 },
      { src: M(2), dst: TGT_F1_DRIVE, depth: 0.3 },
      { src: M(3), dst: S(2, LEVEL), depth: 1 },
      { src: M(5), dst: FX(1, 0), depth: 0.4 },
      { src: M(6), dst: S(3, LEVEL), depth: 1 },
    ]),
  },
  'Pulse Bass': {
    // a square whose symmetry sways (a pulse narrowing and widening) over a saw an octave down,
    // through a ladder's 24 dB slope
    ...src(1, { kind: 0, wave: 3, count: 1, sym: 0.5, level: 0.55 }),
    ...src(2, { kind: 0, wave: 2, count: 1, coarse: -12, level: 0.55 }),
    ...flt(1, { type: 6, cutoff: 240, res: 0.4 }),
    ...lfo(1, { shape: 0, rate: 0.35, bipolar: 1 }),
    ...env(1, { a: 0.002, d: 0, s: 1, r: 0.14 }),
    ...env(2, { a: 0.001, d: 0.3, s: 0.1, r: 0.25, dc: 0.5 }),
    ...amp({ level: 0.75 }),
    ...voice({ mono: 1, legato: 0, poly: 1 }),
    ...fx(1, { type: 3, drive: 0.3, tube: 0.2, mix: 0.3 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.45 },
      { src: ENV(2), dst: TGT_F1_CUTOFF, depth: 0.32, via: M(3), viadepth: 0.2 },
      { src: SRC_KEY, dst: TGT_F1_CUTOFF, depth: 0.1 },
      { src: M(1), dst: TGT_F1_CUTOFF, depth: 0.18 },
      { src: M(2), dst: TGT_F1_RES, depth: 0.4 },
      { src: LFO(1), dst: S(1, SYM), depth: 0.2, via: M(4), viadepth: 0.2 },
      { src: M(5), dst: S(2, LEVEL), depth: 1 },
      { src: M(6), dst: FX(1, 0), depth: 0.5 },
    ]),
  },

  // ---- keys ----
  'Silver Keys': {
    // sine partials, darker played softly and brighter hard, over a struck attack and a bell-like twelfth
    ...src(1, {
      kind: 0,
      wave: 0,
      count: 12,
      pitcha: 2,
      pitchb: 2,
      ampa: 6,
      ampb: 5,
      amp: 0.35,
      stereo: 1,
      pana: 3,
      width: 0.15,
      level: 0.7,
    }),
    ...src(2, { kind: 1, data: STRIKE, partials: 20, speed: 1, level: 0.55 }),
    ...src(3, { kind: 0, wave: 0, count: 1, coarse: 19, level: 0.35 }),
    ...flt(1, { type: 0, cutoff: 5200, res: 0.05 }),
    ...env(1, { a: 0.002, d: 4, s: 0, r: 0.4, dc: 0.55, rc: 0.3 }),
    ...env(3, { a: 0.001, d: 0.9, s: 0, r: 0.3, dc: 0.5 }),
    ...amp({ level: 0.19 }),
    ...fx(4, { type: 2, rate: 0.6, depth: 2, delay: 7, width: 1, mix: 0.25 }),
    ...room({ mix: 0.12 }, { decay: 2.4, size: 0.6, mix: 0.22 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.6 },
      { src: SRC_VELOCITY, dst: S(1, AMPMORPH), depth: 0.55 },
      { src: SRC_VELOCITY, dst: TGT_F1_CUTOFF, depth: 0.12 },
      { src: SRC_KEY, dst: ENV_D(1), depth: -0.12 },
      { src: ENV(3), dst: S(3, LEVEL), depth: 1 },
      { src: M(1), dst: S(1, AMPMORPH), depth: 0.3 },
      { src: M(1), dst: TGT_F1_CUTOFF, depth: 0.12 },
      { src: M(2), dst: S(2, LEVEL), depth: 1 },
      { src: M(3), dst: S(3, LEVEL), depth: 1 },
      { src: M(4), dst: ENV_D(1), depth: 0.2 },
      { src: M(5), dst: FX(4, 0), depth: 0.25 },
      { src: M(6), dst: FX(6, 0), depth: 0.3 },
    ]),
  },
  'Glow Keys': {
    // drawbar partials and a detuned sine body, glass ringing an octave up, a gentle tremolo
    ...src(1, { kind: 0, wave: 7, count: 1, level: 0.55 }),
    ...src(2, { kind: 1, data: GLASS, partials: 12, coarse: 12, speed: 1, stereo: 1, pana: 1, width: 0.5, level: 0.7 }),
    ...src(3, {
      kind: 0,
      wave: 0,
      count: 3,
      pitcha: 1,
      pitchb: 1,
      detune: 4,
      stereo: 1,
      pana: 1,
      width: 0.6,
      level: 0.4,
    }),
    ...flt(1, { type: 0, cutoff: 6000, res: 0.05 }),
    ...lfo(1, { shape: 0, rate: 5.2, bipolar: 1 }),
    ...env(1, { a: 0.004, d: 0, s: 1, r: 0.28 }),
    ...amp({ level: 0.29 }),
    ...fx(1, { type: 3, drive: 0.3, tube: 0.5, mix: 0.3 }),
    ...room({ mix: 0.1 }, { decay: 2, size: 0.55, mix: 0.2 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.4 },
      { src: M(1), dst: TGT_F1_CUTOFF, depth: 0.16 },
      { src: M(2), dst: S(2, LEVEL), depth: 1 },
      { src: LFO(1), dst: TGT_LEVEL, depth: 0.15, via: M(3), viadepth: 0.15 },
      { src: M(4), dst: S(3, LEVEL), depth: 1 },
      { src: M(5), dst: FX(1, 0), depth: 0.3 },
      { src: M(6), dst: FX(6, 0), depth: 0.3 },
    ]),
  },

  // ---- leads ----
  'Stack Lead': {
    // five detuned saws and a square an octave up, a ladder opening on each note, vibrato that waits
    ...src(1, {
      kind: 0,
      wave: 2,
      count: 5,
      pitcha: 1,
      pitchb: 1,
      detune: 7,
      stereo: 1,
      pana: 1,
      width: 0.6,
      level: 0.35,
    }),
    ...src(2, { kind: 0, wave: 3, count: 1, coarse: 12, level: 0.3 }),
    ...flt(1, { type: 5, cutoff: 2200, res: 0.25 }),
    ...lfo(1, { shape: 0, rate: 5.3, bipolar: 1, delay: 0.35, fade: 0.6 }),
    ...env(1, { a: 0.004, d: 0, s: 1, r: 0.25 }),
    ...env(2, { a: 0.001, d: 0.6, s: 0.4, r: 0.3 }),
    ...amp({ level: 0.66 }),
    ...voice({ mono: 1, legato: 1, glide: 0.07, poly: 1 }),
    ...room({ time: 0.75, mix: 0.18 }, { decay: 2.5, mix: 0.18 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.35 },
      { src: ENV(2), dst: TGT_F1_CUTOFF, depth: 0.14 },
      { src: M(1), dst: TGT_F1_CUTOFF, depth: 0.16 },
      { src: M(2), dst: S(1, DETUNE), depth: 0.08 },
      { src: LFO(1), dst: TGT_PITCH, depth: 0.0035, via: M(3), viadepth: 0.0035 },
      { src: LFO(1), dst: TGT_PITCH, depth: 0, via: SRC_WHEEL, viadepth: 0.008 },
      { src: M(4), dst: S(2, LEVEL), depth: 1 },
      ...roomLinks(0.2, 0.2),
    ]),
  },
  'Air Whistle': {
    // a sine with breath around it (grains of air through a band-pass that follows the key), a
    // breathy chiff on each note, and vibrato
    ...src(1, { kind: 0, wave: 0, count: 1, level: 0.7 }),
    ...src(2, {
      kind: 3,
      data: AIR,
      size: 0.05,
      density: 8,
      jitter: 1,
      speed: 1,
      loop: 4,
      ftype: 3,
      cutoff: 1800,
      res: 0.64,
      level: 1.4,
    }),
    ...src(3, { kind: 0, wave: 1, count: 1, coarse: 12, level: 0.12 }),
    ...lfo(1, { shape: 0, rate: 5, bipolar: 1, delay: 0.25, fade: 0.5 }),
    ...env(1, { a: 0.05, d: 0, s: 1, r: 0.3, ac: 0.3 }),
    ...env(2, { a: 0.02, d: 0.3, s: 0.25, r: 0.3 }),
    ...amp({ level: 0.56 }),
    ...voice({ mono: 1, legato: 1, glide: 0.05, poly: 1 }),
    ...room({ time: 0.75, mix: 0.18 }, { decay: 3, mix: 0.25 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.35 },
      { src: ENV(2), dst: S(2, LEVEL), depth: 1, via: M(1), viadepth: -0.3 },
      { src: SRC_KEY, dst: S(2, CUTOFF), depth: 0.35 },
      { src: M(2), dst: S(2, CUTOFF), depth: 0.12 },
      { src: LFO(1), dst: TGT_PITCH, depth: 0.003, via: M(3), viadepth: 0.003 },
      { src: LFO(1), dst: TGT_PITCH, depth: 0, via: SRC_WHEEL, viadepth: 0.006 },
      { src: M(4), dst: S(3, LEVEL), depth: 1 },
      ...roomLinks(0.2, 0.25),
    ]),
  },

  // ---- soundscapes ----
  'Tide Field': {
    // grains of air and of shimmer, a bowl's partials and a low sine, morphing on two slow tides,
    // with swells drawn across the filter
    ...src(1, {
      kind: 3,
      data: AIR,
      size: 0.3,
      density: 10,
      jitter: 1,
      spray: 1,
      stereo: 1,
      speed: 0.2,
      loop: 4,
      level: 1.1,
    }),
    ...src(2, {
      kind: 3,
      data: SHIMMER,
      size: 0.4,
      density: 6,
      jitter: 0.6,
      spray: 0.9,
      stereo: 1,
      speed: 0.12,
      loop: 4,
      level: 1.1,
    }),
    ...src(3, {
      kind: 1,
      data: BOWL,
      partials: 10,
      speed: 0.3,
      loop: 1,
      start: 0.1,
      end: 0.9,
      stereo: 1,
      pana: 3,
      width: 0.5,
      level: 1.2,
    }),
    ...src(4, { kind: 0, wave: 0, count: 1, coarse: -12, level: 0.5 }),
    ...xy({ x: 0.5, y: 0.5, power: 1 }),
    ...flt(1, { type: 0, cutoff: 2200, res: 0.2 }),
    ...lfo(1, { shape: 0, rate: 0.031, bipolar: 1 }),
    ...lfo(2, { shape: 1, rate: 0.047, bipolar: 1, phase: 0.3 }),
    ...shape(
      1,
      [
        [0, 0.2, 0.4],
        [5, 0.85, -0.3],
        [9, 0.35, 0.2],
        [14, 0.6],
        [18, 0.2],
      ],
      { loop: 1, ls: 0, le: 4 },
    ),
    ...env(1, { a: 2.5, d: 0, s: 1, r: 6, ac: 0.4 }),
    ...amp({ level: 0.6 }),
    ...fx(3, { type: 2, rate: 0.12, depth: 4, delay: 14, width: 1, mix: 0.3 }),
    ...room({ time: 1.5, feedback: 0.55, mix: 0.18 }, { decay: 9, size: 1, damp: 0.4, mix: 0.4 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.2 },
      { src: LFO(1), dst: TGT_X, depth: 0.35 },
      { src: LFO(2), dst: TGT_Y, depth: 0.35 },
      { src: M(1), dst: TGT_X, depth: 0.25 },
      { src: SHAPE(1), dst: TGT_F1_CUTOFF, depth: 0.12, via: M(2), viadepth: 0.1 },
      { src: M(3), dst: S(1, LEVEL), depth: 1 },
      { src: M(4), dst: S(2, LEVEL), depth: 1 },
      { src: M(5), dst: S(4, LEVEL), depth: 1 },
      { src: M(6), dst: FX(6, 0), depth: 0.35 },
    ]),
  },
  'Frozen Bells': {
    // a bell and a bowl held still at one moment of their ring, that moment wandering slowly, under
    // grains of chimes
    ...src(1, { kind: 1, data: BELL, partials: 10, speed: 0, pos: 0.08, stereo: 1, pana: 3, width: 0.4, level: 1.3 }),
    ...src(2, {
      kind: 1,
      data: BOWL,
      partials: 10,
      speed: 0,
      pos: 0.2,
      coarse: -12,
      stereo: 1,
      pana: 1,
      width: 0.5,
      level: 1.1,
    }),
    ...src(3, {
      kind: 3,
      data: CHIME,
      size: 0.25,
      density: 5,
      jitter: 0.8,
      spray: 1,
      stereo: 1,
      speed: 0.05,
      loop: 4,
      coarse: 12,
      level: 0.8,
    }),
    ...flt(1, { type: 0, cutoff: 5500, res: 0.1 }),
    ...lfo(1, { shape: 0, rate: 0.07, bipolar: 1 }),
    ...lfo(2, { shape: 1, rate: 0.05, bipolar: 1, phase: 0.4 }),
    ...lfo(3, { shape: 6, rate: 0.2, bipolar: 1 }),
    ...env(1, { a: 1.5, d: 0, s: 1, r: 7, ac: 0.3 }),
    ...amp({ level: 0.34 }),
    ...fx(3, { type: 2, rate: 0.15, depth: 3, delay: 10, width: 1, mix: 0.25 }),
    ...room({ time: 2, feedback: 0.45, mix: 0.15 }, { decay: 11, size: 1, damp: 0.35, mix: 0.45 }),
    ...wire([
      { src: SRC_VELOCITY, dst: TGT_LEVEL, depth: 0.25 },
      { src: LFO(1), dst: S(1, POS), depth: 0.03, via: M(2), viadepth: 0.03 },
      { src: LFO(2), dst: S(2, POS), depth: 0.05, via: M(2), viadepth: 0.05 },
      { src: M(1), dst: S(1, POS), depth: 0.06 },
      { src: M(1), dst: S(2, POS), depth: 0.1 },
      { src: M(3), dst: S(3, LEVEL), depth: 1 },
      { src: M(4), dst: TGT_F1_CUTOFF, depth: 0.16 },
      { src: LFO(3), dst: TGT_PAN, depth: 0.15, via: M(5), viadepth: 0.15 },
      { src: M(6), dst: FX(6, 0), depth: 0.35 },
    ]),
  },
};
