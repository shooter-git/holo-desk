/**
 * Prism's sources: an oscillator bank (one band-limited waveform read by up to 64 oscillators, each
 * at its own pitch, level and place), partials (sine partials following data that changes over
 * time), a sample and grains. Also the partial-set file format packs bring, and the data and
 * recordings built in (made here from formulas, so they cost nothing to ship).
 *
 * The sources render CTRL samples at most at a time. Their control step sets where each oscillator
 * or partial is headed by the end of the block, and the block glides there sample by sample, so a
 * pitch or level moved by modulation never steps.
 */
import { PRISM_MAX_OSCS, PRISM_MAX_PARTIALS } from '@holo/session';
import { fft, ifft } from './fft.ts';
import { CTRL } from './prism-mod.ts';
import type { SampleFrames, SampleZone } from './protocol.ts';

const TAU = Math.PI * 2;

// ---- waveforms ------------------------------------------------------------------------------------

/** Points in a cycle (each table has two more, the first two again, so reading never wraps). */
export const TABLE = 2048;
/** Band limits: a table with at most 512 harmonics, then 256, … 1. */
const LEVELS = 10;
/** A waveform at each band limit. */
export type Mips = Float32Array[];

/** Tables for every band limit from harmonic amplitudes (sine terms a, cosine terms b, from 1). */
function mipsFrom(a: Float64Array, b: Float64Array): Mips {
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
      re[h] = ((b[h] as number) * TABLE) / 2;
      im[h] = (-(a[h] as number) * TABLE) / 2;
      re[TABLE - h] = re[h] as number;
      im[TABLE - h] = -(im[h] as number);
    }
    ifft(re, im);
    if (made < 0) {
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

/** The built-in waveforms' harmonics (PRISM_WAVES): sine terms and cosine terms. */
function builtInHarmonics(w: number): [Float64Array, Float64Array] {
  const a = new Float64Array(513);
  const b = new Float64Array(513);
  for (let h = 1; h <= 512; h++) {
    const odd = h % 2 === 1;
    switch (w) {
      case 0:
        if (h === 1) a[h] = 1;
        break;
      case 1:
        if (odd) a[h] = ((h - 1) / 2) % 2 ? -1 / (h * h) : 1 / (h * h);
        break;
      case 2:
        a[h] = 1 / h;
        break;
      case 3:
        if (odd) a[h] = 1 / h;
        break;
      case 4:
        b[h] = Math.sin(Math.PI * h * 0.25) / h;
        break;
      case 5:
        b[h] = Math.sin(Math.PI * h * 0.1) / h;
        break;
      case 6:
        a[h] = 1 / (h * h);
        break;
      case 7: {
        // drawbars: the fundamental and its octaves, twelfth and seventeenth
        const bars: Record<number, number> = {
          1: 1,
          2: 0.85,
          3: 0.6,
          4: 0.55,
          6: 0.32,
          8: 0.3,
          10: 0.12,
          12: 0.1,
          16: 0.08,
        };
        a[h] = bars[h] ?? 0;
        break;
      }
      case 8:
        a[h] = odd ? 1 / h ** 1.5 : 0.12 / (h * h);
        break;
      case 9:
        a[h] = (1 / h ** 0.6) * Math.max(0, 1 - h / 700);
        break;
    }
  }
  return [a, b];
}

const builtIns: (Mips | undefined)[] = [];
/** A built-in waveform's tables, made once. */
export function builtInWave(w: number): Mips {
  let m = builtIns[w];
  if (!m) {
    const [a, b] = builtInHarmonics(w);
    m = mipsFrom(a, b);
    builtIns[w] = m;
  }
  return m;
}

/** Tables from one cycle's points (at least four), offset taken out. */
export function customWave(points: ArrayLike<number>): Mips {
  const n = points.length;
  const re = new Float64Array(TABLE);
  const im = new Float64Array(TABLE);
  for (let i = 0; i < TABLE; i++) {
    const x = (i * n) / TABLE;
    const j = Math.floor(x);
    const t = x - j;
    re[i] = (points[j % n] as number) * (1 - t) + (points[(j + 1) % n] as number) * t;
  }
  fft(re, im);
  const a = new Float64Array(513);
  const b = new Float64Array(513);
  for (let h = 1; h <= 512; h++) {
    b[h] = ((re[h] as number) * 2) / TABLE;
    a[h] = (-(im[h] as number) * 2) / TABLE;
  }
  return mipsFrom(a, b);
}

/** The band limit for an oscillator at hz: the fullest table whose harmonics all stay below ~0.47 sr. */
export function mipLevel(hz: number, sr: number): number {
  const room = (0.47 * sr) / Math.max(hz, 1);
  if (room >= 512) return 0;
  if (room < 1) return LEVELS - 1;
  const lv = Math.ceil(Math.log2(512 / room));
  return lv < 0 ? 0 : lv >= LEVELS ? LEVELS - 1 : lv;
}

// ---- spreads ------------------------------------------------------------------------------------------

/** Oscillator (or partial) k's level in amplitude spread `shape` (PRISM_AMP_SPREADS). */
export function ampSpread(shape: number, k: number): number {
  switch (shape) {
    case 1:
      return k === 0 ? 1 : 0;
    case 2:
      return k === 0 ? 0 : 1;
    case 3:
      return k % 2 === 0 ? 1 : 0;
    case 4:
      return k % 2 === 1 ? 1 : 0;
    case 5:
      return 1 / (k + 1);
    case 6:
      return 1 / ((k + 1) * (k + 1));
    case 7: {
      const d = (k + 1 - 5) / 2.5;
      return Math.exp(-d * d) + 0.15 / (k + 1);
    }
    default:
      return 1;
  }
}

/** Oscillator k's frequency over the note's in pitch spread `shape` (PRISM_PITCH_SPREADS). */
export function pitchSpread(shape: number, k: number, detuneCents: number): number {
  switch (shape) {
    case 1:
      // every other one a step further down, the others a step further up
      return k === 0 ? 1 : 2 ** (((k % 2 ? -1 : 1) * k * detuneCents) / 1200);
    case 2:
      return k + 1;
    case 3:
      return 2 * k + 1;
    case 4:
      return 2 ** k;
    case 5: {
      // a stiff string's partials, each a little sharp of whole
      const B = 0.0008;
      const h = k + 1;
      return (h * Math.sqrt(1 + B * h * h)) / Math.sqrt(1 + B);
    }
    case 6: {
      // a free bar's modes
      const beta = k === 0 ? 4.73 : (k + 1.5) * Math.PI;
      return (beta / 4.73) ** 2;
    }
    case 7:
      return 1.5 ** k;
    default:
      return 1;
  }
}

/** Oscillator k's place (−1…1) in pan spread `shape` (PRISM_PAN_SPREADS), of `n` heard. */
export function panSpread(shape: number, k: number, n: number, width: number): number {
  switch (shape) {
    case 1:
    case 2: {
      if (k === 0) return 0;
      const pairs = Math.max(1, Math.ceil((n - 1) / 2));
      const p = (Math.min(Math.ceil(k / 2), pairs) / pairs) * width * (k % 2 ? 1 : -1);
      return shape === 1 ? p : -p;
    }
    case 3:
      return (k % 2 ? 1 : -1) * width;
    case 4:
      return (k % 2 ? -1 : 1) * width;
    default:
      return 0;
  }
}

/** cos θ for θ in 0…π/2, by its series (within 0.1%: a pan law needs no more, and it's cheap). */
function cosQuarter(t: number): number {
  const t2 = t * t;
  return 1 - (t2 / 2) * (1 - (t2 / 12) * (1 - t2 / 30));
}

/** Equal-power gains for a place −1…1 (each 1/√2 in the middle). */
export function panLeft(p: number): number {
  return cosQuarter((p < -1 ? 0 : p > 1 ? 2 : p + 1) * (Math.PI / 4));
}
export function panRight(p: number): number {
  return cosQuarter((p < -1 ? 2 : p > 1 ? 0 : 1 - p) * (Math.PI / 4));
}

// ---- partial sets -----------------------------------------------------------------------------------------

/** One partial: its start phase (cycles) and breakpoints in time (seconds). */
export interface Partial {
  phase: number;
  t: Float32Array;
  /** Linear level. */
  amp: Float32Array;
  /** Frequency over the note's (2.003: a little sharp of the octave). */
  ratio: Float32Array;
  /** −1…1, or null: in the middle. */
  pan: Float32Array | null;
}

/** A sound as partials over time: what a Partials source plays. */
export interface PartialSet {
  /** Seconds. */
  length: number;
  /** Its own loop in seconds (end ≤ start: none). */
  loopStart: number;
  loopEnd: number;
  /** Semitones every partial is moved by over time (null: none). */
  pitch: { t: Float32Array; st: Float32Array } | null;
  partials: Partial[];
}

const MAGIC = 0x4c545250; // "PRTL", little-endian

/**
 * A partial set as bytes, the file a pack brings (".partials"). Little-endian throughout:
 *
 *   "PRTL"  u32 version (1)
 *   f32 length (s)   f32 loopStart (s)   f32 loopEnd (s; ≤ loopStart: no loop)
 *   u32 p           f32 t[p]  f32 semitones[p]          (the pitch over time; p may be 0)
 *   u32 count
 *   per partial:    f32 phase (cycles)  u32 n  u32 flags (1: it has pans)
 *                   f32 t[n]  f32 amp[n]  f32 ratio[n]  [f32 pan[n]]
 *
 * Times rise; a partial's level is linear, its ratio is its frequency over the note's, and its pan
 * is −1…1.
 */
export function writePartials(set: PartialSet): Uint8Array {
  let size = 4 * 5 + 4 + (set.pitch ? set.pitch.t.length * 8 : 0) + 4;
  for (const p of set.partials) size += 12 + p.t.length * (p.pan ? 16 : 12);
  const buf = new ArrayBuffer(size);
  const v = new DataView(buf);
  let o = 0;
  const u32 = (x: number) => {
    v.setUint32(o, x, true);
    o += 4;
  };
  const f32 = (x: number) => {
    v.setFloat32(o, x, true);
    o += 4;
  };
  u32(MAGIC);
  u32(1);
  f32(set.length);
  f32(set.loopStart);
  f32(set.loopEnd);
  const np = set.pitch ? set.pitch.t.length : 0;
  u32(np);
  for (let i = 0; i < np; i++) f32(set.pitch?.t[i] as number);
  for (let i = 0; i < np; i++) f32(set.pitch?.st[i] as number);
  u32(set.partials.length);
  for (const p of set.partials) {
    f32(p.phase);
    u32(p.t.length);
    u32(p.pan ? 1 : 0);
    for (const arr of p.pan ? [p.t, p.amp, p.ratio, p.pan] : [p.t, p.amp, p.ratio]) for (const x of arr) f32(x);
  }
  return new Uint8Array(buf);
}

/** A partial set from its bytes (writePartials), or null when they aren't one. */
export function readPartials(bytes: Uint8Array): PartialSet | null {
  if (bytes.byteLength < 28) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let o = 0;
  const left = () => bytes.byteLength - o;
  const u32 = () => {
    const x = v.getUint32(o, true);
    o += 4;
    return x;
  };
  const floats = (n: number) => {
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = v.getFloat32(o + i * 4, true);
    o += n * 4;
    return a;
  };
  if (u32() !== MAGIC || u32() !== 1) return null;
  const head = floats(3);
  const np = u32();
  if (np * 8 > left()) return null;
  const pt = floats(np);
  const pst = floats(np);
  const count = u32();
  const partials: Partial[] = [];
  for (let k = 0; k < count && k < PRISM_MAX_PARTIALS * 4; k++) {
    if (left() < 12) return null;
    const phase = v.getFloat32(o, true);
    o += 4;
    const n = u32();
    const flags = u32();
    const per = flags & 1 ? 16 : 12;
    if (n * per > left()) return null;
    const t = floats(n);
    const amp = floats(n);
    const ratio = floats(n);
    const pan = flags & 1 ? floats(n) : null;
    partials.push({ phase, t, amp, ratio, pan });
  }
  return {
    length: head[0] as number,
    loopStart: head[1] as number,
    loopEnd: head[2] as number,
    pitch: np ? { t: pt, st: pst } : null,
    partials,
  };
}

/** A partial that rings: up in `attack`, then falling by 60 dB in `decay` (seconds). */
function ringing(ratio: number, amp: number, attack: number, decay: number, length: number, beat = 0): Partial {
  const n = 28;
  const t = new Float32Array(n);
  const a = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    // points closer together near the start, where it changes fastest
    const x = i === 0 ? 0 : attack + (length - attack) * ((i - 1) / (n - 2)) ** 2.2;
    t[i] = i === 1 ? attack : x;
    const time = t[i] as number;
    a[i] = i === 0 ? 0 : amp * 10 ** ((-3 * Math.max(0, time - attack)) / decay);
    // a doublet's slow beating, as a gently swaying frequency
    r[i] = ratio * (1 + beat * Math.sin(TAU * 0.7 * time));
  }
  a[n - 1] = 0;
  return { phase: 0, t, amp: a, ratio: r, pan: null };
}

function partialSet(length: number, partials: Partial[], loop: [number, number] = [0, 0]): PartialSet {
  return { length, loopStart: loop[0], loopEnd: loop[1], pitch: null, partials };
}

/** A sung "ah" moving to "oo" and "ee", with vibrato: formants placed for a voice around 220 Hz. */
function voiceSet(): PartialSet {
  const length = 3;
  const steps = 76;
  const vowels: [number, number[], number[]][] = [
    [0, [700, 1220, 2600], [1, 0.5, 0.25]],
    [1.2, [300, 870, 2240], [1, 0.3, 0.1]],
    [2.4, [280, 2250, 3000], [1, 0.35, 0.3]],
    [3, [700, 1220, 2600], [1, 0.5, 0.25]],
  ];
  const partials: Partial[] = [];
  for (let k = 0; k < 28; k++) {
    const h = k + 1;
    const t = new Float32Array(steps);
    const amp = new Float32Array(steps);
    const ratio = new Float32Array(steps);
    for (let i = 0; i < steps; i++) {
      const time = (i / (steps - 1)) * length;
      t[i] = time;
      let v = 0;
      while (v < vowels.length - 2 && time >= (vowels[v + 1] as (typeof vowels)[number])[0]) v++;
      const [t0, f0, g0] = vowels[v] as (typeof vowels)[number];
      const [t1, f1, g1] = vowels[v + 1] as (typeof vowels)[number];
      const x = Math.min(1, Math.max(0, (time - t0) / (t1 - t0)));
      const f = h * 220;
      let a = 0.015;
      for (let j = 0; j < 3; j++) {
        const fc = (f0[j] as number) + ((f1[j] as number) - (f0[j] as number)) * x;
        const g = (g0[j] as number) + ((g1[j] as number) - (g0[j] as number)) * x;
        const bw = 70 + fc * 0.07;
        a += g / (1 + ((f - fc) / bw) ** 2);
      }
      const onset = Math.min(1, time / 0.08);
      amp[i] = (0.5 * a * onset) / h ** 0.3;
      ratio[i] = h * (1 + 0.004 * Math.sin(TAU * 5.3 * time) * Math.min(1, time / 0.6));
    }
    partials.push({ phase: (k * 0.37) % 1, t, amp, ratio, pan: null });
  }
  return partialSet(length, partials, [0.5, 2.9]);
}

/** A struck string or tine: every harmonic, the high ones dying first. */
function strikeSet(): PartialSet {
  const partials: Partial[] = [];
  const B = 0.00015;
  for (let k = 0; k < 40; k++) {
    const h = k + 1;
    const ratio = h * Math.sqrt(1 + B * h * h);
    const amp = (0.55 / h ** 0.9) * (1 + 0.6 * Math.exp(-((h - 6) ** 2) / 8));
    partials.push(ringing(ratio, amp, 0.0015, 2.2 / (1 + 0.22 * k), 2.5));
  }
  return partialSet(2.5, partials);
}

function makePartialSet(i: number): PartialSet {
  switch (i) {
    case 0: {
      // a struck bar tuned 1 : 4 : 10, and the mallet's short knock above
      const modes: [number, number, number][] = [
        [1, 1, 2.4],
        [3.99, 0.32, 0.7],
        [9.94, 0.14, 0.28],
        [17.3, 0.06, 0.12],
      ];
      const parts = modes.map(([r, a, d]) => ringing(r, a * 0.7, 0.001, d, 3));
      for (let j = 0; j < 8; j++) parts.push(ringing(6 + j * 1.37, 0.05, 0.0005, 0.025 + 0.004 * j, 0.2));
      return partialSet(3, parts);
    }
    case 1: {
      const modes = [1, 2.32, 4.25, 6.63, 9.38, 12.6];
      return partialSet(
        5,
        modes.flatMap((r, j) => [
          ringing(r, 0.5 / (j + 1) ** 0.8, 0.003, 4.5 / (1 + 0.6 * j), 5, 0.0012),
          ringing(r * 1.0016, 0.3 / (j + 1), 0.003, 3.5 / (1 + 0.6 * j), 5),
        ]),
      );
    }
    case 2: {
      // a bell's hum, prime, minor third, fifth, nominal and the partials above
      const modes: [number, number, number][] = [
        [0.5, 0.55, 7],
        [1, 0.6, 5],
        [1.19, 0.45, 3.5],
        [1.5, 0.3, 3],
        [2, 0.5, 3.2],
        [2.5, 0.25, 1.8],
        [2.67, 0.2, 1.5],
        [3.01, 0.18, 1.2],
        [4.03, 0.12, 0.9],
        [5.33, 0.08, 0.6],
      ];
      return partialSet(
        6,
        modes.map(([r, a, d], j) => ringing(r, a * 0.6, 0.002, d, 6, j % 3 === 0 ? 0.0008 : 0)),
      );
    }
    case 3: {
      const modes = [1, 2.71, 5.15, 8.17, 11.7];
      return partialSet(
        8,
        modes.flatMap((r, j) => [
          ringing(r, 0.45 / (j + 1) ** 0.7, 0.03, 9 / (1 + 0.5 * j), 8),
          ringing(r * (1 + 0.003 * (j + 1)), 0.35 / (j + 1) ** 0.7, 0.03, 8 / (1 + 0.5 * j), 8),
        ]),
      );
    }
    case 4:
      return voiceSet();
    default:
      return strikeSet();
  }
}

const partialSets: (PartialSet | undefined)[] = [];
/** A built-in partial set (PRISM_PARTIAL_SETS[i]), made once. */
export function builtInPartials(i: number): PartialSet {
  let s = partialSets[i];
  if (!s) {
    s = makePartialSet(i);
    partialSets[i] = s;
  }
  return s;
}

// ---- recordings built in -------------------------------------------------------------------------------------

/** A recording a Sample or Grains source plays: frames at `rate`, its pitch and its loop (frames). */
export interface Recording {
  left: SampleFrames;
  right: SampleFrames | null;
  /** Frames a second. */
  rate: number;
  /** Its pitch (MIDI). */
  root: number;
  gain: number;
  loopStart: number;
  loopEnd: number;
}

const BUILT_RATE = 48000;

/** The last `fade` frames crossed into the first, so it loops without a seam (the result is shorter). */
function seamless(x: Float32Array, fade: number): Float32Array {
  const n = x.length - fade;
  const out = x.slice(0, n);
  for (let i = 0; i < fade; i++) {
    const g = i / fade;
    out[i] = (x[n + i] as number) * Math.cos(g * (Math.PI / 2)) + (x[i] as number) * Math.sin(g * (Math.PI / 2));
  }
  return out;
}

/** A two-pole resonator's coefficients at f Hz and a bandwidth in Hz. */
function resonator(f: number, bw: number, sr: number): [number, number, number] {
  const r = Math.exp((-Math.PI * bw) / sr);
  return [2 * r * Math.cos((TAU * f) / sr), -r * r, 1 - r];
}

function makeRecording(i: number): Recording {
  const sr = BUILT_RATE;
  let seed = 12345 + i * 777;
  const noise = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return (seed | 0) / 2147483648;
  };
  switch (i) {
    case 0: {
      // air: noise, gently band-limited, its level breathing slowly
      const n = 3 * sr;
      const x = new Float32Array(n);
      let lp = 0;
      let lp2 = 0;
      let hp = 0;
      for (let j = 0; j < n; j++) {
        const w = noise();
        lp += (w - lp) * 0.35;
        lp2 += (lp - lp2) * 0.35;
        hp += (lp2 - hp) * 0.02;
        x[j] = (lp2 - hp) * (0.75 + 0.25 * Math.sin((TAU * j) / (1.5 * sr))) * 1.6;
      }
      const loop = seamless(x, Math.round(0.4 * sr));
      return { left: loop, right: null, rate: sr, root: 60, gain: 1, loopStart: 0, loopEnd: loop.length };
    }
    case 1: {
      // shimmer: a few partials of middle C, each beating slowly against a twin
      const n = 3 * sr;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      const f0 = 261.6256;
      const parts: [number, number][] = [
        [1, 0.5],
        [2, 0.35],
        [3, 0.25],
        [4, 0.2],
        [5, 0.12],
        [6, 0.1],
        [8, 0.08],
      ];
      for (const [h, a] of parts) {
        // (each a pair of rotations, a sine read sample by sample costs ten times as much)
        const ea = 2 * Math.sin((Math.PI * f0 * h * 2 ** (1.5 / 1200)) / sr);
        const eb = 2 * Math.sin((Math.PI * f0 * h * 2 ** (-1.5 / 1200)) / sr);
        const es = 2 * Math.sin((Math.PI * 0.13 * h) / sr);
        let xa = 1;
        let ya = 0;
        let xb = Math.cos(h);
        let yb = Math.sin(h);
        let xs = Math.cos(h);
        let ys = Math.sin(h);
        for (let j = 0; j < n; j++) {
          xa -= ea * ya;
          ya += ea * xa;
          xb -= eb * yb;
          yb += eb * xb;
          xs -= es * ys;
          ys += es * xs;
          const g = a * (0.7 + 0.3 * ys) * 0.5;
          l[j] = (l[j] as number) + g * ya;
          r[j] = (r[j] as number) + g * yb;
        }
      }
      const fade = Math.round(0.5 * sr);
      const ll = seamless(l, fade);
      const rr = seamless(r, fade);
      return { left: ll, right: rr, rate: sr, root: 60, gain: 1, loopStart: 0, loopEnd: ll.length };
    }
    case 2: {
      // a small choir: three saws around A3, each its own vibrato, through the formants of "ah"
      const n = 3 * sr;
      const x = new Float32Array(n);
      const saw = builtInWave(2)[mipLevel(230, sr)] as Float32Array;
      for (let v = 0; v < 3; v++) {
        let ph = v * 0.31;
        const det = [0, 7, -6][v] as number;
        const rate = 5 + v * 0.4;
        for (let j = 0; j < n; j++) {
          const f = 220 * 2 ** ((det + 25 * Math.sin((TAU * rate * j) / sr + v)) / 1200);
          ph += f / sr;
          if (ph >= 1) ph -= 1;
          const p = ph * TABLE;
          const k = p | 0;
          x[j] = (x[j] as number) + ((saw[k] as number) + (p - k) * ((saw[k + 1] as number) - (saw[k] as number))) / 3;
        }
      }
      const y = new Float32Array(n);
      for (const [f, bw, g] of [
        [700, 110, 1],
        [1220, 120, 0.5],
        [2600, 160, 0.25],
      ] as [number, number, number][]) {
        const [a1, a2, b0] = resonator(f, bw, sr);
        let y1 = 0;
        let y2 = 0;
        for (let j = 0; j < n; j++) {
          const o = b0 * (x[j] as number) + a1 * y1 + a2 * y2;
          y2 = y1;
          y1 = o;
          y[j] = (y[j] as number) + o * g * 2.2;
        }
      }
      const loop = seamless(y, Math.round(0.4 * sr));
      return { left: loop, right: null, rate: sr, root: 57, gain: 1, loopStart: 0, loopEnd: loop.length };
    }
    default: {
      // a chime: a struck bar's modes on C5 over a short knock
      const n = 3 * sr;
      const x = new Float32Array(n);
      const f0 = 523.2511;
      const modes: [number, number, number][] = [
        [1, 0.6, 2.6],
        [2.756, 0.3, 1.2],
        [5.404, 0.15, 0.5],
        [8.933, 0.08, 0.25],
      ];
      for (const [r, a, d] of modes) {
        const e = 2 * Math.sin((Math.PI * f0 * r) / sr);
        const fall = 10 ** (-3 / (d * sr));
        let c = 1;
        let y = 0;
        let g = a;
        for (let j = 0; j < n; j++) {
          c -= e * y;
          y += e * c;
          x[j] = (x[j] as number) + g * y;
          g *= fall;
        }
      }
      for (let j = 0; j < 0.01 * sr; j++) x[j] = (x[j] as number) + noise() * 0.3 * (1 - j / (0.01 * sr));
      return { left: x, right: null, rate: sr, root: 72, gain: 1, loopStart: 0, loopEnd: 0 };
    }
  }
}

const recordings: (Recording | undefined)[] = [];
/** A built-in recording (PRISM_SAMPLES[i]), made once. */
export function builtInRecording(i: number): Recording {
  let r = recordings[i];
  if (!r) {
    r = makeRecording(i);
    recordings[i] = r;
  }
  return r;
}

/** A pack zone as a recording (its frames are already at the engine's rate). */
export function zoneRecording(z: SampleZone, sr: number): Recording {
  return {
    left: z.left,
    right: z.right,
    rate: sr,
    root: z.root,
    gain: z.gain,
    loopStart: z.loopStart,
    loopEnd: z.loopEnd,
  };
}

// ---- the oscillator bank -----------------------------------------------------------------------------------

/** What a source's control step works out for its oscillators or partials. */
export interface Spreads {
  amp: Float64Array;
  ratio: Float64Array;
  pan: Float64Array;
}

export function spreads(n: number): Spreads {
  return { amp: new Float64Array(n), ratio: new Float64Array(n), pan: new Float64Array(n) };
}

export class OscBank {
  private readonly ph = new Float64Array(PRISM_MAX_OSCS);
  private readonly inc = new Float64Array(PRISM_MAX_OSCS);
  private readonly dinc = new Float64Array(PRISM_MAX_OSCS);
  private readonly gl = new Float64Array(PRISM_MAX_OSCS);
  private readonly gr = new Float64Array(PRISM_MAX_OSCS);
  private readonly dgl = new Float64Array(PRISM_MAX_OSCS);
  private readonly dgr = new Float64Array(PRISM_MAX_OSCS);
  private readonly tables: (Float32Array | null)[] = new Array(PRISM_MAX_OSCS).fill(null);
  /** Oscillators to run (those heard, and those fading out). */
  private live = 0;
  private started = false;
  private symA = 1;
  private symB = 1;
  private split = 0.5;
  private warp = false;
  /** Sines as drawn: the recursion plays them (cheaper than reading a table). */
  private sines: SineBank | null = null;

  /** Where each starts: `phase` for all, or (free) anywhere. `sine`: they're plain sines all along. */
  start(phase: number, free: boolean, rand: () => number, sine = false): void {
    for (let k = 0; k < PRISM_MAX_OSCS; k++) this.ph[k] = free ? Math.abs(rand()) % 1 : phase;
    this.started = false;
    if (sine) {
      this.sines ??= new SineBank();
      this.sines.start(this.ph);
    } else this.sines = null;
  }

  /**
   * Headed for: `count` oscillators of `mips` at f0 times each one's ratio, with each one's level
   * and place (`sp`), all times `level`. `stereo`: left and right differ.
   */
  control(
    mips: Mips,
    f0: number,
    count: number,
    sp: Spreads,
    level: number,
    stereo: boolean,
    sym: number,
    sr: number,
  ): void {
    if (this.sines) {
      this.sines.control(f0, count, sp, level, stereo, sr);
      return;
    }
    const whole = Math.min(PRISM_MAX_OSCS, Math.ceil(count));
    const nyq = 0.48 * sr;
    const first = !this.started;
    this.started = true;
    for (let k = 0; k < Math.max(whole, this.live); k++) {
      let gl = 0;
      let gr = 0;
      let inc = this.inc[k] as number;
      if (k < whole) {
        const f = f0 * (sp.ratio[k] as number);
        let a = level * (sp.amp[k] as number);
        if (k === whole - 1 && count < whole) a *= count - (whole - 1);
        // fade out what would go past the top
        if (f >= nyq || f <= 0) a = 0;
        else if (f > nyq * 0.85) a *= (nyq - f) / (nyq * 0.15);
        if (stereo) {
          const p = sp.pan[k] as number;
          gl = a * panLeft(p) * Math.SQRT2;
          gr = a * panRight(p) * Math.SQRT2;
        } else gl = a;
        if (f > 0 && f < nyq) {
          inc = f / sr;
          this.tables[k] = mips[mipLevel(f, sr)] as Float32Array;
        }
      }
      if (first || (this.gl[k] === 0 && this.gr[k] === 0)) this.inc[k] = inc;
      const di = (inc - (this.inc[k] as number)) / CTRL;
      this.dinc[k] = Math.abs(di) < 1e-15 ? 0 : di;
      this.dgl[k] = (gl - (this.gl[k] as number)) / CTRL;
      this.dgr[k] = (gr - (this.gr[k] as number)) / CTRL;
    }
    // (one still fading out stays live until its gain reaches nothing)
    let live = whole;
    for (let k = whole; k < this.live; k++) if (this.gl[k] !== 0 || this.gr[k] !== 0 || this.dgl[k] !== 0) live = k + 1;
    this.live = live;
    const s = sym < 0.02 ? 0.02 : sym > 0.98 ? 0.98 : sym;
    this.warp = Math.abs(s - 0.5) > 1e-4;
    this.split = s;
    this.symA = 0.5 / s;
    this.symB = 0.5 / (1 - s);
  }

  /** n samples (≤ CTRL) into l (and r when stereo), added. */
  render(l: Float32Array, r: Float32Array, n: number, stereo: boolean): void {
    if (this.sines) {
      this.sines.render(l, r, n, stereo);
      return;
    }
    const T = TABLE;
    const warp = this.warp;
    const split = this.split;
    const symA = this.symA;
    const symB = this.symB;
    for (let k = 0; k < this.live; k++) {
      const t = this.tables[k];
      let gl = this.gl[k] as number;
      let gr = this.gr[k] as number;
      const dgl = this.dgl[k] as number;
      const dgr = this.dgr[k] as number;
      let inc = this.inc[k] as number;
      const dinc = this.dinc[k] as number;
      let ph = this.ph[k] as number;
      if (!t || (gl === 0 && gr === 0 && dgl === 0 && dgr === 0)) {
        this.ph[k] = (ph + inc * n) % 1;
        this.inc[k] = inc + dinc * n;
        continue;
      }
      if (warp) {
        for (let i = 0; i < n; i++) {
          ph += inc;
          if (ph >= 1) ph -= 1;
          const q = ph < split ? ph * symA : 0.5 + (ph - split) * symB;
          const x = q * T;
          const j = x | 0;
          const a = t[j] as number;
          const v = a + (x - j) * ((t[j + 1] as number) - a);
          l[i] = (l[i] as number) + v * gl;
          if (stereo) r[i] = (r[i] as number) + v * gr;
          gl += dgl;
          gr += dgr;
          inc += dinc;
        }
      } else if (stereo) {
        for (let i = 0; i < n; i++) {
          ph += inc;
          if (ph >= 1) ph -= 1;
          const x = ph * T;
          const j = x | 0;
          const a = t[j] as number;
          const v = a + (x - j) * ((t[j + 1] as number) - a);
          l[i] = (l[i] as number) + v * gl;
          r[i] = (r[i] as number) + v * gr;
          gl += dgl;
          gr += dgr;
          inc += dinc;
        }
      } else if (dinc === 0) {
        for (let i = 0; i < n; i++) {
          ph += inc;
          if (ph >= 1) ph -= 1;
          const x = ph * T;
          const j = x | 0;
          const a = t[j] as number;
          l[i] = (l[i] as number) + (a + (x - j) * ((t[j + 1] as number) - a)) * gl;
          gl += dgl;
        }
      } else {
        for (let i = 0; i < n; i++) {
          ph += inc;
          if (ph >= 1) ph -= 1;
          const x = ph * T;
          const j = x | 0;
          const a = t[j] as number;
          l[i] = (l[i] as number) + (a + (x - j) * ((t[j + 1] as number) - a)) * gl;
          gl += dgl;
          inc += dinc;
        }
      }
      // (tiny leftovers of a ramp to nothing are nothing)
      this.gl[k] = Math.abs(gl) < 1e-9 ? 0 : gl;
      this.gr[k] = Math.abs(gr) < 1e-9 ? 0 : gr;
      this.inc[k] = inc;
      this.ph[k] = ph;
    }
  }
}

// ---- partials ---------------------------------------------------------------------------------------------

/** A breakpoint list's value at time x, from the segment found from `hint` (returned in `PartialCursor.at`). */
function seek(t: Float32Array, x: number, hint: number): number {
  const n = t.length;
  const i = hint < 0 ? 0 : hint >= n - 1 ? n - 2 : hint;
  if ((t[i] as number) <= x && (t[i + 1] as number) > x) return i;
  if (i + 2 < n && (t[i + 1] as number) <= x && (t[i + 2] as number) > x) return i + 1;
  let lo = 0;
  let hi = n - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if ((t[mid] as number) <= x) lo = mid;
    else hi = mid;
  }
  return lo;
}

/**
 * Sine oscillators by a two-multiply recursion (a rotation, kept on its circle): partials, and an
 * oscillator bank of sines. Each glides to its next frequency and gains over the block.
 */
class Rotors {
  protected readonly x: Float64Array;
  protected readonly y: Float64Array;
  /** 2 sin(π f / sr): the step of the rotation. */
  protected readonly e: Float64Array;
  protected readonly de: Float64Array;
  protected readonly gl: Float64Array;
  protected readonly gr: Float64Array;
  protected readonly dgl: Float64Array;
  protected readonly dgr: Float64Array;
  protected live = 0;
  constructor(n: number) {
    this.x = new Float64Array(n);
    this.y = new Float64Array(n);
    this.e = new Float64Array(n);
    this.de = new Float64Array(n);
    this.gl = new Float64Array(n);
    this.gr = new Float64Array(n);
    this.dgl = new Float64Array(n);
    this.dgr = new Float64Array(n);
  }

  /** Oscillator k starts at `phase` (cycles), silent. */
  protected begin(k: number, phase: number): void {
    this.x[k] = Math.cos(TAU * phase);
    this.y[k] = Math.sin(TAU * phase);
    this.gl[k] = 0;
    this.gr[k] = 0;
  }

  /** Oscillator k headed for `hz` and gains `a` (and `b` on the right), with what it was owed. */
  protected head(k: number, hz: number, a: number, b: number, sr: number, first: boolean): void {
    let e = this.e[k] as number;
    if (hz > 0 && hz < 0.48 * sr) {
      // 2 sin(π f / sr), by its series (to well under a cent below the top)
      const w = (Math.PI * hz) / sr;
      const w2 = w * w;
      e = 2 * w * (1 - (w2 / 6) * (1 - (w2 / 20) * (1 - w2 / 42)));
    }
    // (the recursion's swing grows a little with its frequency: taken back out)
    const fix = 1 - (e * e) / 8;
    if (first || (this.gl[k] === 0 && this.gr[k] === 0)) this.e[k] = e;
    const d = (e - (this.e[k] as number)) / CTRL;
    this.de[k] = Math.abs(d) < 1e-13 ? 0 : d;
    this.dgl[k] = (a * fix - (this.gl[k] as number)) / CTRL;
    this.dgr[k] = (b * fix - (this.gr[k] as number)) / CTRL;
  }

  /** Those still fading out past `whole` stay live until their gains reach nothing. */
  protected settle(whole: number): void {
    let live = whole;
    for (let k = whole; k < this.live; k++) if (this.gl[k] !== 0 || this.gr[k] !== 0 || this.dgl[k] !== 0) live = k + 1;
    this.live = live;
  }

  render(l: Float32Array, r: Float32Array, n: number, stereo: boolean): void {
    let k = 0;
    // two steady partials at a time, where they come in pairs: one pass over the buffers for both
    for (; k + 1 < this.live; k += 2) {
      if (this.de[k] !== 0 || this.de[k + 1] !== 0) break;
      if (this.gl[k] === 0 && this.dgl[k] === 0 && this.gr[k] === 0 && this.dgr[k] === 0) break;
      if (this.gl[k + 1] === 0 && this.dgl[k + 1] === 0 && this.gr[k + 1] === 0 && this.dgr[k + 1] === 0) break;
      this.pair(l, r, n, stereo, k);
    }
    for (; k < this.live; k++) {
      let x = this.x[k] as number;
      let y = this.y[k] as number;
      let e = this.e[k] as number;
      const de = this.de[k] as number;
      let gl = this.gl[k] as number;
      let gr = this.gr[k] as number;
      const dgl = this.dgl[k] as number;
      const dgr = this.dgr[k] as number;
      if (gl === 0 && gr === 0 && dgl === 0 && dgr === 0) {
        // silent: its phase runs on cheaply (a few steps of the same recursion would cost as much)
        this.e[k] = e + de * n;
        continue;
      }
      if (stereo && de === 0) {
        for (let i = 0; i < n; i++) {
          x -= e * y;
          y += e * x;
          l[i] = (l[i] as number) + y * gl;
          r[i] = (r[i] as number) + y * gr;
          gl += dgl;
          gr += dgr;
        }
      } else if (stereo) {
        for (let i = 0; i < n; i++) {
          x -= e * y;
          y += e * x;
          l[i] = (l[i] as number) + y * gl;
          r[i] = (r[i] as number) + y * gr;
          e += de;
          gl += dgl;
          gr += dgr;
        }
      } else if (de === 0) {
        for (let i = 0; i < n; i++) {
          x -= e * y;
          y += e * x;
          l[i] = (l[i] as number) + y * gl;
          gl += dgl;
        }
      } else {
        for (let i = 0; i < n; i++) {
          x -= e * y;
          y += e * x;
          l[i] = (l[i] as number) + y * gl;
          e += de;
          gl += dgl;
        }
      }
      // keep the recursion on its circle (rounding would let it drift over minutes)
      const m = x * x + y * y - e * x * y;
      if (m > 0) {
        const s = 1 / Math.sqrt(m);
        x *= s;
        y *= s;
      }
      this.x[k] = x;
      this.y[k] = y;
      this.e[k] = e;
      this.gl[k] = Math.abs(gl) < 1e-9 ? 0 : gl;
      this.gr[k] = Math.abs(gr) < 1e-9 ? 0 : gr;
    }
  }

  /** Partials k and k + 1, both steady in frequency, together. */
  private pair(l: Float32Array, r: Float32Array, n: number, stereo: boolean, k: number): void {
    let x0 = this.x[k] as number;
    let y0 = this.y[k] as number;
    let x1 = this.x[k + 1] as number;
    let y1 = this.y[k + 1] as number;
    const e0 = this.e[k] as number;
    const e1 = this.e[k + 1] as number;
    let a0 = this.gl[k] as number;
    let b0 = this.gr[k] as number;
    let a1 = this.gl[k + 1] as number;
    let b1 = this.gr[k + 1] as number;
    const da0 = this.dgl[k] as number;
    const db0 = this.dgr[k] as number;
    const da1 = this.dgl[k + 1] as number;
    const db1 = this.dgr[k + 1] as number;
    if (stereo) {
      for (let i = 0; i < n; i++) {
        x0 -= e0 * y0;
        y0 += e0 * x0;
        x1 -= e1 * y1;
        y1 += e1 * x1;
        l[i] = (l[i] as number) + y0 * a0 + y1 * a1;
        r[i] = (r[i] as number) + y0 * b0 + y1 * b1;
        a0 += da0;
        b0 += db0;
        a1 += da1;
        b1 += db1;
      }
    } else {
      for (let i = 0; i < n; i++) {
        x0 -= e0 * y0;
        y0 += e0 * x0;
        x1 -= e1 * y1;
        y1 += e1 * x1;
        l[i] = (l[i] as number) + y0 * a0 + y1 * a1;
        a0 += da0;
        a1 += da1;
      }
    }
    const m0 = x0 * x0 + y0 * y0 - e0 * x0 * y0;
    const m1 = x1 * x1 + y1 * y1 - e1 * x1 * y1;
    const s0 = m0 > 0 ? 1 / Math.sqrt(m0) : 1;
    const s1 = m1 > 0 ? 1 / Math.sqrt(m1) : 1;
    this.x[k] = x0 * s0;
    this.y[k] = y0 * s0;
    this.x[k + 1] = x1 * s1;
    this.y[k + 1] = y1 * s1;
    this.gl[k] = Math.abs(a0) < 1e-9 ? 0 : a0;
    this.gr[k] = Math.abs(b0) < 1e-9 ? 0 : b0;
    this.gl[k + 1] = Math.abs(a1) < 1e-9 ? 0 : a1;
    this.gr[k + 1] = Math.abs(b1) < 1e-9 ? 0 : b1;
  }
}

/** An oscillator bank of plain sines, by the recursion. */
class SineBank extends Rotors {
  private started = false;
  constructor() {
    super(PRISM_MAX_OSCS);
  }

  start(phases: Float64Array): void {
    for (let k = 0; k < PRISM_MAX_OSCS; k++) this.begin(k, phases[k] as number);
    this.live = 0;
    this.started = false;
  }

  control(f0: number, count: number, sp: Spreads, level: number, stereo: boolean, sr: number): void {
    const whole = Math.min(PRISM_MAX_OSCS, Math.ceil(count));
    const nyq = 0.48 * sr;
    const first = !this.started;
    this.started = true;
    for (let k = 0; k < Math.max(whole, this.live); k++) {
      let gl = 0;
      let gr = 0;
      let hz = 0;
      if (k < whole) {
        hz = f0 * (sp.ratio[k] as number);
        let a = level * (sp.amp[k] as number);
        if (k === whole - 1 && count < whole) a *= count - (whole - 1);
        if (hz >= nyq || hz <= 0) a = 0;
        else if (hz > nyq * 0.85) a *= (nyq - hz) / (nyq * 0.15);
        if (stereo) {
          const p = sp.pan[k] as number;
          gl = a * panLeft(p) * Math.SQRT2;
          gr = a * panRight(p) * Math.SQRT2;
        } else gl = a;
      }
      this.head(k, hz, gl, gr, sr, first);
    }
    this.settle(whole);
  }
}

export class PartialPlayer extends Rotors {
  private readonly hint = new Int32Array(PRISM_MAX_PARTIALS);
  private started = false;
  set: PartialSet | null = null;

  constructor() {
    super(PRISM_MAX_PARTIALS);
  }

  start(set: PartialSet | null): void {
    this.set = set;
    this.started = false;
    this.live = 0;
    if (!set) return;
    for (let k = 0; k < Math.min(PRISM_MAX_PARTIALS, set.partials.length); k++) {
      this.begin(k, (set.partials[k] as Partial).phase);
      this.hint[k] = 0;
    }
  }

  /** The set's pitch (semitones) at time x. */
  private pitchAt(x: number): number {
    const p = this.set?.pitch;
    if (!p || p.t.length === 0) return 0;
    const t = p.t;
    if (x <= (t[0] as number)) return p.st[0] as number;
    if (x >= (t[t.length - 1] as number)) return p.st[t.length - 1] as number;
    const i = seek(t, x, 0);
    const u = (x - (t[i] as number)) / ((t[i + 1] as number) - (t[i] as number));
    return (p.st[i] as number) + ((p.st[i + 1] as number) - (p.st[i] as number)) * u;
  }

  /** Headed for: the data at time `at` (seconds), `count` partials of it at f0, times `level` and the spreads. */
  control(f0: number, at: number, count: number, sp: Spreads, level: number, stereo: boolean, sr: number): void {
    const set = this.set;
    if (!set) return;
    const total = Math.min(PRISM_MAX_PARTIALS, set.partials.length);
    const whole = Math.min(total, Math.ceil(count));
    const f = f0 * 2 ** (this.pitchAt(at) / 12);
    const nyq = 0.48 * sr;
    const first = !this.started;
    this.started = true;
    for (let k = 0; k < Math.max(whole, this.live); k++) {
      let gl = 0;
      let gr = 0;
      let hz = 0;
      if (k < whole) {
        const p = set.partials[k] as Partial;
        const t = p.t;
        const n = t.length;
        let a = 0;
        let ratio = 1;
        let pan = 0;
        if (n === 1) {
          a = p.amp[0] as number;
          ratio = p.ratio[0] as number;
          pan = p.pan ? (p.pan[0] as number) : 0;
        } else if (n > 1 && at >= (t[0] as number) && at <= (t[n - 1] as number)) {
          const i = seek(t, at, this.hint[k] as number);
          this.hint[k] = i;
          const t0 = t[i] as number;
          const dt = (t[i + 1] as number) - t0;
          const u = dt > 0 ? (at - t0) / dt : 0;
          a = (p.amp[i] as number) + ((p.amp[i + 1] as number) - (p.amp[i] as number)) * u;
          ratio = (p.ratio[i] as number) + ((p.ratio[i + 1] as number) - (p.ratio[i] as number)) * u;
          if (p.pan) pan = (p.pan[i] as number) + ((p.pan[i + 1] as number) - (p.pan[i] as number)) * u;
        }
        a *= level * (sp.amp[k] as number);
        if (k === whole - 1 && count < whole) a *= count - (whole - 1);
        hz = f * ratio;
        if (hz >= nyq || hz <= 0) a = 0;
        else if (hz > nyq * 0.85) a *= (nyq - hz) / (nyq * 0.15);
        if (stereo) {
          const q = Math.max(-1, Math.min(1, pan + (sp.pan[k] as number)));
          gl = a * panLeft(q) * Math.SQRT2;
          gr = a * panRight(q) * Math.SQRT2;
        } else gl = a;
      }
      this.head(k, hz, gl, gr, sr, first);
    }
    this.settle(whole);
  }
}

// ---- a sample ----------------------------------------------------------------------------------------------

/** Where a sample or grains move along a recording, and how they loop (frames). */
export interface Span {
  start: number;
  end: number;
  /** PRISM_LOOPS */
  mode: number;
}

/** A recording's loop for a source: its own (start and end both 0), the share asked for, or the whole. */
export function loopSpan(
  rec: { left: SampleFrames; loopStart: number; loopEnd: number },
  start: number,
  end: number,
  mode: number,
): Span {
  const len = rec.left.length;
  if (mode === 4) return { start: 0, end: len, mode };
  if (start === 0 && end === 0) {
    if (rec.loopEnd > rec.loopStart + 1) return { start: rec.loopStart, end: Math.min(len, rec.loopEnd), mode };
    return { start: 0, end: len, mode };
  }
  const a = Math.round(Math.min(start, end) * len);
  const b = Math.round(Math.max(start, end) * len);
  return b - a > 2 ? { start: a, end: b, mode } : { start: 0, end: len, mode };
}

export class SamplePlayer {
  rec: Recording | null = null;
  private pos = 0;
  private dir = 1;
  private rate = 0;
  private drate = 0;
  private gl = 0;
  private gr = 0;
  private dgl = 0;
  private dgr = 0;
  private started = false;
  private released = false;
  done = false;
  span: Span = { start: 0, end: 0, mode: 0 };

  start(rec: Recording | null, pos: number, span: Span): void {
    this.rec = rec;
    this.span = span;
    this.pos = rec ? Math.max(0, Math.min(rec.left.length - 2, pos * rec.left.length)) : 0;
    this.dir = 1;
    this.started = false;
    this.released = false;
    this.done = !rec;
    this.gl = this.gr = 0;
  }

  release(): void {
    this.released = true;
  }

  control(f0: number, level: number, pan: number, stereo: boolean, sr: number): void {
    const rec = this.rec;
    if (!rec) return;
    const rootHz = 440 * 2 ** ((rec.root - 69) / 12);
    const rate = (f0 / rootHz) * (rec.rate / sr);
    if (!this.started) this.rate = rate;
    this.started = true;
    this.drate = (rate - this.rate) / CTRL;
    const a = level * rec.gain;
    const gl = stereo && rec.right ? a : a * panLeft(pan) * Math.SQRT2;
    const gr = stereo && rec.right ? a : a * panRight(pan) * Math.SQRT2;
    this.dgl = ((this.done ? 0 : gl) - this.gl) / CTRL;
    this.dgr = ((this.done ? 0 : gr) - this.gr) / CTRL;
  }

  render(l: Float32Array, r: Float32Array, n: number): void {
    const rec = this.rec;
    if (!rec || (this.done && this.gl === 0 && this.gr === 0)) return;
    const L = rec.left;
    const R = rec.right ?? rec.left;
    const len = L.length;
    const scale = L instanceof Int16Array ? 1 / 32768 : 1;
    const { start, end } = this.span;
    const mode = this.span.mode;
    const looping = mode === 1 || mode === 3 || mode === 4 || (mode === 2 && !this.released);
    let pos = this.pos;
    let rate = this.rate;
    let gl = this.gl;
    let gr = this.gr;
    for (let i = 0; i < n; i++) {
      if (this.done) break;
      const j = pos | 0;
      const t = pos - j;
      const j1 = j + 1 < len ? j + 1 : j;
      const a = (L[j] as number) * scale;
      const b = (L[j1] as number) * scale;
      const vl = a + (b - a) * t;
      l[i] = (l[i] as number) + vl * gl;
      if (R !== L) {
        const c = (R[j] as number) * scale;
        const d = (R[j1] as number) * scale;
        r[i] = (r[i] as number) + (c + (d - c) * t) * gr;
      } else r[i] = (r[i] as number) + vl * gr;
      pos += rate * this.dir;
      rate += this.drate;
      gl += this.dgl;
      gr += this.dgr;
      if (looping && end - start > 2) {
        if (mode === 3) {
          if (pos >= end - 1) {
            pos = end - 1 - (pos - (end - 1));
            this.dir = -1;
          } else if (pos < start && this.dir < 0) {
            pos = start + (start - pos);
            this.dir = 1;
          }
        } else if (pos >= end) pos -= end - start;
      } else if (pos >= len - 1 || pos < 0) {
        this.done = true;
      }
    }
    this.pos = pos;
    this.rate = rate;
    this.gl = this.done ? 0 : gl;
    this.gr = this.done ? 0 : gr;
  }
}

// ---- grains --------------------------------------------------------------------------------------------------

const GRAINS = 16;
const WINDOW = 2048;
/** A grain's window (raised cosine), with one point more so reading never wraps. */
const HANN = Float32Array.from({ length: WINDOW + 1 }, (_, i) => 0.5 - 0.5 * Math.cos((TAU * i) / WINDOW));

export class GrainCloud {
  rec: Recording | null = null;
  private readonly gpos = new Float64Array(GRAINS);
  private readonly grate = new Float64Array(GRAINS);
  private readonly gw = new Float64Array(GRAINS);
  private readonly gdw = new Float64Array(GRAINS);
  private readonly ggl = new Float64Array(GRAINS);
  private readonly ggr = new Float64Array(GRAINS);
  private readonly on = new Uint8Array(GRAINS);
  /** Where the cloud is along the recording (frames), and which way it moves. */
  private scan = 0;
  private dir = 1;
  /** Samples to the next grain. */
  private wait = 0;
  private interval = 1;
  private grainLen = 1;
  private rate = 1;
  private level = 0;
  private speed = 1;
  private jitter = 0;
  private spray = 0;
  private pan = 0;
  private stereo = false;
  private released = false;
  span: Span = { start: 0, end: 0, mode: 0 };

  start(rec: Recording | null, pos: number, span: Span): void {
    this.rec = rec;
    this.span = span;
    this.scan = rec ? pos * rec.left.length : 0;
    this.dir = 1;
    this.wait = 0;
    this.released = false;
    this.on.fill(0);
  }

  release(): void {
    this.released = true;
  }

  control(
    f0: number,
    level: number,
    pan: number,
    stereo: boolean,
    size: number,
    density: number,
    speed: number,
    jitter: number,
    spray: number,
    sr: number,
  ): void {
    const rec = this.rec;
    if (!rec) return;
    const rootHz = 440 * 2 ** ((rec.root - 69) / 12);
    this.rate = (f0 / rootHz) * (rec.rate / sr);
    this.grainLen = Math.max(16, size * sr);
    const d = Math.max(1, Math.min(GRAINS, density));
    this.interval = this.grainLen / d;
    // overlapping grains add up: a level that stays about the same however many there are
    this.level = (level * rec.gain) / Math.sqrt(d);
    this.speed = speed * (rec.rate / sr);
    this.jitter = jitter * 0.05 * rec.rate;
    this.spray = spray;
    this.pan = pan;
    this.stereo = stereo;
  }

  private spawn(rand: { next(): number }): void {
    const rec = this.rec as Recording;
    let g = -1;
    for (let i = 0; i < GRAINS; i++)
      if (!this.on[i]) {
        g = i;
        break;
      }
    if (g < 0) return;
    const len = rec.left.length;
    let at = this.scan + rand.next() * this.jitter;
    at = Math.max(0, Math.min(len - 2, at));
    this.gpos[g] = at;
    this.grate[g] = this.rate;
    this.gw[g] = 0;
    this.gdw[g] = WINDOW / this.grainLen;
    const p = Math.max(-1, Math.min(1, this.pan + rand.next() * this.spray));
    this.ggl[g] = this.level * panLeft(p) * Math.SQRT2;
    this.ggr[g] = this.level * panRight(p) * Math.SQRT2;
    this.on[g] = 1;
  }

  render(l: Float32Array, r: Float32Array, n: number, rand: { next(): number }): void {
    const rec = this.rec;
    if (!rec) return;
    const L = rec.left;
    const R = this.stereo && rec.right ? rec.right : null;
    const len = L.length;
    const scale = L instanceof Int16Array ? 1 / 32768 : 1;
    // the cloud moves along, looping as asked
    const { start, end, mode } = this.span;
    const looping = mode === 1 || mode === 3 || mode === 4 || (mode === 2 && !this.released);
    this.scan += this.speed * n * this.dir;
    if (looping && end - start > 2) {
      if (mode === 3) {
        if (this.scan >= end) {
          this.scan = end - (this.scan - end);
          this.dir = -1;
        } else if (this.scan < start && this.dir < 0) {
          this.scan = start + (start - this.scan);
          this.dir = 1;
        }
      } else if (this.scan >= end) this.scan = start + ((this.scan - start) % (end - start));
    } else if (this.scan >= len - 1) this.scan = len - 2;
    // new grains in this stretch
    this.wait -= n;
    while (this.wait <= 0) {
      this.spawn(rand);
      this.wait += this.interval;
    }
    for (let g = 0; g < GRAINS; g++) {
      if (!this.on[g]) continue;
      let pos = this.gpos[g] as number;
      const rate = this.grate[g] as number;
      let w = this.gw[g] as number;
      const dw = this.gdw[g] as number;
      const gl = this.ggl[g] as number;
      const gr = this.ggr[g] as number;
      for (let i = 0; i < n; i++) {
        if (w >= WINDOW || pos >= len - 1) {
          this.on[g] = 0;
          break;
        }
        const win = HANN[w | 0] as number;
        const j = pos | 0;
        const t = pos - j;
        const a = (L[j] as number) * scale;
        const v = (a + ((L[j + 1] as number) * scale - a) * t) * win;
        if (R) {
          const c = (R[j] as number) * scale;
          const rv = (c + ((R[j + 1] as number) * scale - c) * t) * win;
          l[i] = (l[i] as number) + v * gl;
          r[i] = (r[i] as number) + rv * gr;
        } else {
          l[i] = (l[i] as number) + v * gl;
          r[i] = (r[i] as number) + v * gr;
        }
        pos += rate;
        w += dw;
      }
      this.gpos[g] = pos;
      this.gw[g] = w;
    }
  }
}
