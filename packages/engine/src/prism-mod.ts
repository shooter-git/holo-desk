/**
 * Prism's modulators and its matrix: LFOs, envelopes, drawn shapes, step sequencers and curves, and
 * the links that let any of them (or a key, a knob, the mod wheel) move any target. Everything here
 * runs at the control rate: a voice asks for new values every CTRL samples and glides its sound
 * between them, so the cost is per block, never per sample.
 */
import {
  PRISM_CONTROLS,
  PRISM_ENVS,
  PRISM_LFOS,
  PRISM_MOD_SOURCES,
  PRISM_MOD_TARGETS,
  PRISM_SEQS,
  PRISM_SHAPES,
  SRC_BEND,
  SRC_CONTROL,
  SRC_ENV,
  SRC_GATE,
  SRC_KEY,
  SRC_LFO,
  SRC_MACRO,
  SRC_PRESSURE,
  SRC_RANDOM,
  SRC_SEQ,
  SRC_SHAPE,
  SRC_VELOCITY,
  SRC_WHEEL,
} from '@holo/session';

/** Samples between control steps. */
export const CTRL = 32;
const TAU = Math.PI * 2;

// ---- curves ---------------------------------------------------------------------------------------

/**
 * A stretch from 0 to 1 bent by `c` (−1…1): 0 is straight, above 0 it rises quickly and settles,
 * below 0 it starts slowly and speeds up. The same tension curve everywhere (envelopes' drawn
 * shapes, curves in the matrix).
 */
export function bend(t: number, c: number): number {
  if (c === 0) return t;
  if (c >= 0.999) return t > 0 ? 1 : 0;
  if (c <= -0.999) return t >= 1 ? 1 : 0;
  const a = (1 - c) / (1 + c);
  const d = t + (1 - t) * a;
  return d > 0 ? t / d : 0;
}

/** Points (x rising) with a curve on each stretch: a curve in the matrix, or a drawn shape. */
export interface PointList {
  n: number;
  x: Float64Array;
  y: Float64Array;
  c: Float64Array;
}

export function pointList(max: number): PointList {
  return { n: 0, x: new Float64Array(max), y: new Float64Array(max), c: new Float64Array(max) };
}

/** The value of a point list at x (flat before the first point and after the last). */
export function pointsAt(p: PointList, x: number): number {
  const n = p.n;
  if (n === 0) return x;
  const X = p.x;
  const Y = p.y;
  if (x <= (X[0] as number)) return Y[0] as number;
  if (x >= (X[n - 1] as number)) return Y[n - 1] as number;
  let i = 0;
  while (i < n - 2 && x >= (X[i + 1] as number)) i++;
  const x0 = X[i] as number;
  const dx = (X[i + 1] as number) - x0;
  const y0 = Y[i] as number;
  if (dx < 1e-9) return Y[i + 1] as number;
  return y0 + ((Y[i + 1] as number) - y0) * bend((x - x0) / dx, p.c[i] as number);
}

// ---- patches of the modulators -----------------------------------------------------------------------

export interface LfoPatch {
  shape: number;
  custom: number;
  rate: number;
  sync: number;
  beats: number;
  bipolar: number;
  delay: number;
  fade: number;
  phase: number;
  mode: number;
}

export interface EnvPatch {
  a: number;
  h: number;
  d: number;
  s: number;
  r: number;
  ac: number;
  dc: number;
  rc: number;
}

export interface ShapePatch extends PointList {
  loop: number;
  ls: number;
  le: number;
  sync: number;
}

export interface SeqPatch {
  steps: number;
  beats: number;
  swing: number;
  attack: number;
  gate: number;
  release: number;
  v: Float64Array;
  t: Float64Array;
}

/** A link of the matrix, worked out for playing. */
export interface Link {
  src: number;
  dst: number;
  depth: number;
  /** Index into the curves, -1 for none. */
  curve: number;
  via: number;
  viaDepth: number;
  viaCurve: number;
}

// ---- shapes -------------------------------------------------------------------------------------------

/** An LFO's shape at phase p (0…1), −1…1 (the random ones are drawn elsewhere). */
function lfoWave(shape: number, p: number, custom: Float32Array | null): number {
  if (custom) {
    const n = custom.length;
    const x = p * n;
    const i = Math.floor(x);
    const t = x - i;
    const a = custom[i % n] as number;
    const b = custom[(i + 1) % n] as number;
    return a + (b - a) * t;
  }
  switch (shape) {
    case 0:
      return Math.sin(TAU * p);
    case 1:
      return p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
    case 2:
      return 2 * p - 1;
    case 3:
      return 1 - 2 * p;
    case 4:
      return p < 0.5 ? 1 : -1;
    default:
      return 0;
  }
}

/** A seeded draw, −1…1 (each voice its own: renders are the same every time). */
export class Rand {
  private s: number;
  constructor(seed: number) {
    this.s = (seed * 2654435761) >>> 0 || 1;
  }
  next(): number {
    let s = this.s;
    s ^= s << 13;
    s ^= s >>> 17;
    s ^= s << 5;
    this.s = s >>> 0;
    return (this.s / 4294967296) * 2 - 1;
  }
}

// ---- LFO ----------------------------------------------------------------------------------------------

export class Lfo {
  /** The value at the end of the last step: 0…1, or −1…1 when bipolar. */
  value = 0;
  phase = 0;
  private t = 0;
  private from = 0;
  private to = 0;
  private held = 0;
  private lastBeat = Number.NaN;

  trigger(p: LfoPatch, rand: Rand): void {
    this.t = 0;
    this.phase = p.phase;
    this.from = rand.next();
    this.to = rand.next();
    this.held = this.from;
    this.lastBeat = Number.NaN;
  }

  /**
   * One control step of `dt` seconds at `hz` cycles a second. `beat`: the song's position in quarter
   * notes when it keeps to the song (NaN otherwise).
   */
  step(p: LfoPatch, hz: number, dt: number, rand: Rand, custom: Float32Array | null, beat: number): void {
    this.t += dt;
    let wrapped = false;
    if (!Number.isNaN(beat) && p.sync >= 0.5 && p.beats > 0) {
      // kept to the song: the phase is where the song is in the cycle
      const turns = beat / p.beats + p.phase;
      const ph = turns - Math.floor(turns);
      wrapped = ph < this.phase || (!Number.isNaN(this.lastBeat) && beat - this.lastBeat > p.beats);
      this.phase = ph;
      this.lastBeat = beat;
    } else if (this.t >= p.delay) {
      this.phase += hz * dt;
      if (this.phase >= 1) {
        this.phase -= Math.floor(this.phase);
        wrapped = true;
      }
    }
    let w: number;
    if (p.custom === 0 && p.shape >= 5) {
      if (wrapped) {
        if (p.shape === 5) this.held = rand.next();
        else {
          this.from = this.to;
          this.to = rand.next();
        }
      }
      w = p.shape === 5 ? this.held : this.from + (this.to - this.from) * this.phase;
    } else w = lfoWave(p.shape, this.phase, custom);
    // its delay, then its depth coming in
    let depth = 1;
    if (p.delay > 0 && this.t < p.delay) depth = 0;
    else if (p.fade > 0 && this.t < p.delay + p.fade) depth = (this.t - p.delay) / p.fade;
    this.value = p.bipolar >= 0.5 ? w * depth : (0.5 + 0.5 * w) * depth;
  }
}

// ---- envelope ---------------------------------------------------------------------------------------------

/** How hard a curve value (−1…1) bends a stretch: the power it's raised to. */
export function envPower(c: number): number {
  return c >= 0 ? 4 ** -c : 1 - 2 * c;
}

export class Ahdsr {
  value = 0;
  /** 0 attack, 1 hold, 2 decay, 3 sustain, 4 release, 5 done. */
  stage = 5;
  private t = 0;
  private from = 0;

  trigger(legato: boolean): void {
    // (legato: the level carries on from where it is, up again from there)
    this.from = legato ? this.value : 0;
    this.stage = 0;
    this.t = 0;
  }

  release(): void {
    if (this.stage >= 4) return;
    this.from = this.value;
    this.stage = 4;
    this.t = 0;
  }

  get done(): boolean {
    return this.stage === 5;
  }

  /** One step of dt seconds; `ka`, `kd`, `kr` scale the attack, decay and release times. */
  step(p: EnvPatch, dt: number, ka = 1, kd = 1, kr = 1): void {
    this.t += dt;
    const A = p.a * ka;
    const D = p.d * kd;
    const R = p.r * kr;
    for (;;) {
      switch (this.stage) {
        case 0:
          if (this.t < A) {
            const x = (this.t / A) ** envPower(p.ac);
            this.value = this.from + (1 - this.from) * x;
            return;
          }
          this.t -= A;
          this.stage = 1;
          continue;
        case 1:
          if (this.t < p.h) {
            this.value = 1;
            return;
          }
          this.t -= p.h;
          this.stage = 2;
          continue;
        case 2:
          if (this.t < D) {
            const x = (1 - this.t / D) ** envPower(-p.dc);
            this.value = p.s + (1 - p.s) * x;
            return;
          }
          this.stage = 3;
          continue;
        case 3:
          this.value = p.s;
          return;
        case 4:
          if (this.t < R) {
            const x = (1 - this.t / R) ** envPower(-p.rc);
            this.value = this.from * x;
            return;
          }
          this.stage = 5;
          this.value = 0;
          return;
        default:
          this.value = 0;
          return;
      }
    }
  }
}

// ---- drawn shape ------------------------------------------------------------------------------------------

export class Shape {
  value = 0;
  private x = 0;
  private dir = 1;
  private released = false;

  trigger(p: ShapePatch): void {
    this.x = p.n > 0 ? (p.x[0] as number) : 0;
    this.dir = 1;
    this.released = false;
    this.value = p.n > 0 ? (p.y[0] as number) : 0;
  }

  release(): void {
    this.released = true;
  }

  /** `scale`: units a second (1, or quarter notes a second with sync). */
  step(p: ShapePatch, dt: number, scale: number): void {
    const n = p.n;
    if (n < 2) {
      this.value = n ? (p.y[0] as number) : 0;
      return;
    }
    const ls = Math.min(n - 1, Math.round(p.ls));
    const le = Math.min(n - 1, Math.round(p.le));
    const x0 = p.x[ls] as number;
    const x1 = p.x[le] as number;
    const looping = p.loop === 1 || p.loop === 3 || (p.loop === 2 && !this.released);
    this.x += dt * scale * this.dir;
    if (looping && x1 > x0) {
      if (p.loop === 3) {
        if (this.x > x1) {
          this.x = x1 - (this.x - x1);
          this.dir = -1;
        } else if (this.x < x0 && this.dir < 0) {
          this.x = x0 + (x0 - this.x);
          this.dir = 1;
        }
      } else if (this.x >= x1) this.x = x0 + ((this.x - x0) % (x1 - x0));
    } else if (this.dir < 0) this.dir = 1;
    this.value = pointsAt(p, this.x);
  }
}

// ---- step sequencer -----------------------------------------------------------------------------------------

export class Steps {
  value = 0;
  private pos = 0;

  trigger(p: SeqPatch): void {
    this.pos = 0;
    this.value = 0;
    this.at(p);
  }

  /** `stepsPerSecond`: how fast it moves. */
  step(p: SeqPatch, dt: number, stepsPerSecond: number): void {
    const n = Math.max(1, Math.round(p.steps));
    this.pos += dt * stepsPerSecond;
    if (this.pos >= n) this.pos -= n * Math.floor(this.pos / n);
    this.at(p);
  }

  private at(p: SeqPatch): void {
    const n = Math.max(1, Math.round(p.steps));
    // swing: each pair of steps split later than half way
    const pair = Math.floor(this.pos / 2) * 2;
    const into = this.pos - pair;
    const split = 1 + 0.5 * p.swing;
    let i: number;
    let u: number;
    if (into < split) {
      i = pair;
      u = into / split;
    } else {
      i = pair + 1;
      u = (into - split) / (2 - split);
    }
    i %= n;
    const v = p.v[i] as number;
    const prev = p.v[(i + n - 1) % n] as number;
    const tiedIn = (p.t[(i + n - 1) % n] as number) >= 0.5;
    const tiedOut = (p.t[i] as number) >= 0.5;
    let a = p.attack;
    let g = p.gate;
    let r = p.release;
    const sum = a + g + r;
    if (sum > 1) {
      a /= sum;
      g /= sum;
      r /= sum;
    }
    const start = tiedIn ? prev : 0;
    if (u < a) this.value = start + (v - start) * (u / a);
    else if (tiedOut || u < a + g) this.value = v;
    else if (u < a + g + r) this.value = v * (1 - (u - a - g) / r);
    else this.value = 0;
  }
}

// ---- the matrix ---------------------------------------------------------------------------------------------

export const SOURCES = PRISM_MOD_SOURCES.length;
export const TARGETS = PRISM_MOD_TARGETS.length;

/** For each target: its range worked out once (in octaves where it is log). */
export const TARGET_LO = new Float64Array(TARGETS);
export const TARGET_SPAN = new Float64Array(TARGETS);
export const TARGET_LOG = new Uint8Array(TARGETS);
export const TARGET_MUL = new Uint8Array(TARGETS);
for (let t = 0; t < TARGETS; t++) {
  const d = PRISM_MOD_TARGETS[t];
  if (!d) continue;
  TARGET_LOG[t] = d.log ? 1 : 0;
  TARGET_MUL[t] = d.kind === 'mul' ? 1 : 0;
  TARGET_LO[t] = d.log ? Math.log2(d.min) : d.min;
  TARGET_SPAN[t] = (d.log ? Math.log2(d.max) : d.max) - (TARGET_LO[t] as number);
}

/** Target t's value from its base and what its links added (normalized) or multiplied. */
export function applyTarget(t: number, base: number, add: number, mul: number): number {
  if (TARGET_MUL[t]) return base * mul;
  if (add === 0) return base;
  const lo = TARGET_LO[t] as number;
  const span = TARGET_SPAN[t] as number;
  let u = ((TARGET_LOG[t] ? Math.log2(Math.max(base, 1e-9)) : base) - lo) / span + add;
  u = u < 0 ? 0 : u > 1 ? 1 : u;
  const x = lo + u * span;
  return TARGET_LOG[t] ? 2 ** x : x;
}

/**
 * One voice's (or the shared) modulation: its modulators' state, the sources' values, and what
 * the links did to each target this step.
 */
export class ModState {
  readonly src = new Float64Array(SOURCES);
  /** Bipolar sources swing −1…1 (Key, Bend, LFOs set so). */
  readonly bipolar = new Uint8Array(SOURCES);
  readonly add = new Float64Array(TARGETS);
  readonly mul = new Float64Array(TARGETS).fill(1);
  readonly lfos: Lfo[] = Array.from({ length: PRISM_LFOS }, () => new Lfo());
  readonly envs: Ahdsr[] = Array.from({ length: PRISM_ENVS }, () => new Ahdsr());
  readonly shapes: Shape[] = Array.from({ length: PRISM_SHAPES }, () => new Shape());
  readonly seqs: Steps[] = Array.from({ length: PRISM_SEQS }, () => new Steps());
  readonly rand: Rand;
  constructor(seed: number) {
    this.rand = new Rand(seed);
    this.bipolar[SRC_KEY] = 1;
    this.bipolar[SRC_BEND] = 1;
    for (let i = 0; i < 6; i++) this.bipolar[SRC_MACRO + i] = 1;
  }

  /** The links, applied to the targets they move (`used`: those targets, reset first). */
  apply(links: readonly Link[], used: Int32Array, curves: readonly PointList[], only?: Uint8Array): void {
    const add = this.add;
    const mul = this.mul;
    for (let i = 0; i < used.length; i++) {
      const t = used[i] as number;
      add[t] = 0;
      mul[t] = 1;
    }
    const src = this.src;
    const bip = this.bipolar;
    for (let i = 0; i < links.length; i++) {
      const k = links[i] as Link;
      if (only && !only[k.dst]) continue;
      let s = src[k.src] as number;
      const b = bip[k.src] as number;
      if (k.curve >= 0) {
        const c = curves[k.curve] as PointList;
        s = b ? 2 * pointsAt(c, 0.5 + 0.5 * s) - 1 : pointsAt(c, s);
      }
      let d = k.depth;
      if (k.via > 0) {
        let v = src[k.via] as number;
        if (k.viaCurve >= 0) {
          const c = curves[k.viaCurve] as PointList;
          v = bip[k.via] ? 2 * pointsAt(c, 0.5 + 0.5 * v) - 1 : pointsAt(c, v);
        }
        d += k.viaDepth * v;
        d = d < -1 ? -1 : d > 1 ? 1 : d;
      }
      if (TARGET_MUL[k.dst]) {
        const u = b ? 0.5 + 0.5 * s : s;
        const a = d < 0 ? -d : d;
        mul[k.dst] = (mul[k.dst] as number) * (1 - a + a * (d >= 0 ? u : 1 - u));
      } else add[k.dst] = (add[k.dst] as number) + d * s;
    }
  }
}

/** What's the same for every note at a moment: the knobs, the wheel, pressure and bend. */
export interface Performance {
  macros: Float64Array;
  controls: Float64Array;
  wheel: number;
  pressure: number;
  /** −1…1 */
  bend: number;
}

/** A note's own sources, and the shared ones, into a state's source values. */
export function fillPlayed(m: ModState, key: number, velocity: number, random: number, gate: number, p: Performance) {
  const s = m.src;
  s[SRC_VELOCITY] = velocity / 127;
  s[SRC_KEY] = (key - 60) / 60;
  s[SRC_RANDOM] = random;
  s[SRC_WHEEL] = p.wheel;
  s[SRC_PRESSURE] = p.pressure;
  s[SRC_BEND] = p.bend;
  s[SRC_GATE] = gate;
  // (the knobs swing either way about their middle)
  for (let i = 0; i < 6; i++) s[SRC_MACRO + i] = 2 * (p.macros[i] as number) - 1;
  for (let i = 0; i < PRISM_CONTROLS; i++) s[SRC_CONTROL + i] = p.controls[i] as number;
}

/** The modulators' values, into a state's source values (the LFOs marked shared from `shared`). */
export function fillModulators(m: ModState, shared: ModState | null, lfoShared: Uint8Array | null) {
  const s = m.src;
  for (let i = 0; i < PRISM_LFOS; i++)
    s[SRC_LFO + i] = (lfoShared?.[i] && shared ? (shared.lfos[i] as Lfo) : (m.lfos[i] as Lfo)).value;
  for (let i = 0; i < PRISM_ENVS; i++) s[SRC_ENV + i] = (m.envs[i] as Ahdsr).value;
  for (let i = 0; i < PRISM_SHAPES; i++) s[SRC_SHAPE + i] = (m.shapes[i] as Shape).value;
  for (let i = 0; i < PRISM_SEQS; i++) s[SRC_SEQ + i] = (m.seqs[i] as Steps).value;
}
