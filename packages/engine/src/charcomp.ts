/**
 * Character Compressor: one compressor with four circuits, each its own way of hearing the level and
 * of moving the gain.
 *
 * - Clean: feed-forward. A detector that holds peaks (or averages the power, RMS) over about 150 ms,
 *   a gain computer with a quadratic knee, and the reduction eased in and out in decibels. Even and
 *   transparent.
 * - FET: feedback. It listens to its own output, so the harder it works the less it hears; the ratio
 *   comes from that loop (a reduction of ratio − 1 times the output's overshoot). Its gain cell runs
 *   out of range gently, near 20 dB of reduction. Fast and forward.
 * - VCA: feed-forward and even in decibels, with a quick detector, so attack and release are what
 *   shape it: punchy, the bus's glue.
 * - Opto: slow to grab and slower to let go after long, deep compression (the cell remembers): a
 *   wide knee and a release that stretches with how hard it has been working.
 *
 * After the circuit: make-up (or auto gain, which gives a full-scale signal back its level), a
 * limiter, an output stage that rounds peaks off (Soft, Hard) or clips them, and a parallel mix.
 * Times are stated as compressors state them: the time to cover 90% of a step.
 */
import { paramValue } from '@holo/session';
import type { Effect, Host } from './fx.ts';

/** COMP_CIRCUITS' order (VCA, 2, is the plain feed-forward path with a quick detector). */
const CLEAN = 0;
const FET = 1;
const OPTO = 3;

/** A one-pole's coefficient that covers 90% of a step in `ms` milliseconds. */
export function settle(ms: number, sr: number): number {
  return ms <= 0 ? 1 : 1 - Math.exp(-Math.LN10 / ((ms / 1000) * sr));
}

/** The most an FET circuit holds back (dB): its gain cell runs out of range there, gently. */
const FET_RANGE = 20;
/** The Hard output stage's x⁷ term: the curve is flat at full scale, at 7/6. */
const HARD = (6 / 7) ** 6 / 7;
/** The built-in limiter's knee (dB): it starts to hold back this far below its level, halved. */
const LIMIT_KNEE = 6;
/** dB per natural-log unit: 20 / ln 10. */
const DB = 20 / Math.LN10;

/** Character Compressor's settings, worked out once (the engine's and the transfer curve's). */
export interface CompShape {
  circuit: number;
  threshold: number;
  ratio: number;
  /** The knee's width (dB): each circuit spreads the Knee setting over its own range. */
  knee: number;
  /** Make-up in dB, with auto gain's share. */
  makeup: number;
  limiter: boolean;
  limit: number;
  saturation: number;
  mix: number;
}

export function compShape(params: Record<string, number>): CompShape {
  const v = (id: string) => paramValue('charcomp', params, id);
  const circuit = Math.round(v('circuit'));
  const k = v('knee') / 100;
  const knee = circuit === CLEAN ? 30 * k : circuit === OPTO ? 6 + 24 * k : 12 * k;
  const s: CompShape = {
    circuit,
    threshold: v('threshold'),
    ratio: v('ratio'),
    knee,
    makeup: v('makeup'),
    limiter: v('limiter') >= 0.5,
    limit: v('limit'),
    saturation: Math.round(v('saturation')),
    mix: v('mix') / 100,
  };
  // auto gain: what the circuit takes from a full-scale signal, given back
  if (v('autoGain') >= 0.5) s.makeup += reduction(s, 0);
  return s;
}

/** Decibels over the threshold, eased over a knee `w` dB wide (a quadratic join, half each side). */
function over(x: number, w: number): number {
  if (w <= 0) return x > 0 ? x : 0;
  const h = w / 2;
  if (x <= -h) return 0;
  if (x >= h) return x;
  const y = x + h;
  return (y * y) / (2 * w);
}

/** The circuit's reduction (dB, ≥ 0) once its detector has settled on a steady level `x` dB. */
export function reduction(s: CompShape, x: number): number {
  const { threshold: t, ratio: r, knee: w } = s;
  if (s.circuit !== FET) return over(x - t, w) * (1 - 1 / r);
  // feedback: the reduction it makes is the one its own output asks for (one root: what it asks
  // for falls as the reduction grows)
  let lo = 0;
  let hi = Math.max(0, x - t) + w + 1;
  for (let i = 0; i < 40; i++) {
    const gr = (lo + hi) / 2;
    const asked = FET_RANGE * Math.tanh(((r - 1) * over(x - gr - t, w)) / FET_RANGE);
    if (asked > gr) lo = gr;
    else hi = gr;
  }
  return (lo + hi) / 2;
}

/** The output stage on one sample (unity for small signals; full scale at most). */
function saturate(mode: number, x: number): number {
  if (mode === 1) {
    // a cubic that reaches full scale, flat, at +3.5 dB
    if (x >= 1.5) return 1;
    if (x <= -1.5) return -1;
    return x - (4 / 27) * x * x * x;
  }
  if (mode === 2) {
    // a seventh-order curve: straight for longer, then round quickly, full scale at 7/6
    if (x >= 7 / 6) return 1;
    if (x <= -7 / 6) return -1;
    const x2 = x * x;
    return x - HARD * x2 * x2 * x2 * x;
  }
  return x > 1 ? 1 : x < -1 ? -1 : x;
}

/** The limiter's gain for a level `x` dB against its own level `l`: none below its knee, the limit at and over it. */
function limitGain(x: number, l: number): number {
  const o = over(x - l, LIMIT_KNEE);
  return o > 0 ? Math.exp(-o / DB) : 1;
}

/**
 * The steady output level (dB) for each steady input level (dB): the circuit, make-up, the limiter,
 * the output stage and the mix, as the window draws them.
 */
export function compressorCurve(params: Record<string, number>, inputs: ArrayLike<number>): Float64Array {
  const s = compShape(params);
  const out = new Float64Array(inputs.length);
  for (let i = 0; i < inputs.length; i++) {
    const x = inputs[i] as number;
    let y = x - reduction(s, x) + s.makeup;
    if (s.limiter) y += DB * Math.log(limitGain(y, s.limit));
    let a = Math.exp(y / DB);
    if (s.saturation > 0) a = Math.abs(saturate(s.saturation, a));
    const mixed = (1 - s.mix) * Math.exp(x / DB) + s.mix * a;
    out[i] = mixed > 1e-9 ? DB * Math.log(mixed) : -180;
  }
  return out;
}

export class CharacterCompressor implements Effect {
  gr = 0;
  private s: CompShape = compShape({});
  private rms = false;
  private att = 0;
  private rel = 0;
  /** Opto: its release once it has been working hard for a while. */
  private relSlow = 0;
  /** The detector's own time (how fast its held level falls, or its power average moves). */
  private det = 0;
  private memUp = 0;
  private memDown = 0;
  private limRel = 0;
  private makeupGain = 1;
  /** The detector's level (linear), its mean square, the reduction (dB), the gain last sample (FET hears through it), the limiter's gain. */
  private level = 0;
  private power = 0;
  private env = 0;
  private gain = 1;
  private mem = 0;
  private limG = 1;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('charcomp', p, id);
    const sr = this.host.sr;
    const s = compShape(p);
    this.s = s;
    this.makeupGain = Math.exp(s.makeup / DB);
    const attack = v('attack');
    const release = v('release');
    this.rms = v('detector') >= 0.5;
    if (s.circuit === OPTO) {
      // the cell can't grab faster than a few milliseconds, and its release has two speeds
      this.att = settle(Math.max(5, attack), sr);
      this.rel = settle(release, sr);
      this.relSlow = settle(release * 8, sr);
      this.det = settle(30, sr);
      this.memUp = settle(1500, sr);
      this.memDown = settle(5000, sr);
    } else {
      this.att = settle(attack, sr);
      this.rel = settle(release, sr);
      this.relSlow = this.rel;
      this.det = settle(s.circuit === CLEAN ? 150 : 8, sr);
    }
    this.limRel = settle(release, sr);
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const s = this.s;
    const { circuit, threshold: t, knee: w, limiter, limit, saturation, mix } = s;
    const slope = circuit === FET ? s.ratio - 1 : 1 - 1 / s.ratio;
    const { att, rel, relSlow, det, makeupGain, memUp, memDown, limRel } = this;
    const rms = this.rms && circuit !== FET;
    // below these (linear) nothing is over the knee: no logarithm is needed to know it
    const quiet = Math.exp((t - w / 2) / DB);
    const limQuiet = Math.exp((limit - LIMIT_KNEE / 2) / DB);
    let { level, power, env, gain, mem, limG } = this;
    let most = 0;
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      let peak = Math.abs(a) > Math.abs(b) ? Math.abs(a) : Math.abs(b);
      // FET hears its own output
      if (circuit === FET) peak *= gain;
      let lvl: number;
      if (rms || circuit === OPTO) {
        // (read as a sine's peak: a steady tone sits where the curve shows it in either detector)
        power += (2 * peak * peak - power) * det;
        lvl = Math.sqrt(power);
      } else if (circuit === FET) {
        lvl = peak;
      } else {
        level = peak > level ? peak : level + (peak - level) * det;
        lvl = level;
      }
      const want = lvl > quiet ? over(DB * Math.log(lvl) - t, w) * slope : 0;
      let c: number;
      if (want > env) c = att;
      else if (circuit === OPTO) c = rel + (relSlow - rel) * mem;
      else c = rel;
      env += (want - env) * c;
      if (circuit === OPTO) {
        const deep = env > 12 ? 1 : env / 12;
        mem += (deep - mem) * (deep > mem ? memUp : memDown);
      }
      const gr = env <= 0 ? 0 : circuit === FET ? FET_RANGE * Math.tanh(env / FET_RANGE) : env;
      gain = gr === 0 ? 1 : Math.exp(-gr / DB);
      const g = gain * makeupGain;
      let ya = a * g;
      let yb = b * g;
      let total = gr;
      if (limiter) {
        const lp = Math.abs(ya) > Math.abs(yb) ? Math.abs(ya) : Math.abs(yb);
        const need = lp > limQuiet ? limitGain(DB * Math.log(lp), limit) : 1;
        limG = need < limG ? need : limG + (need - limG) * limRel;
        // (let go all the way once it's within a hundred-thousandth of a decibel)
        if (limG > 0.999999) limG = 1;
        if (limG !== 1) {
          ya *= limG;
          yb *= limG;
          total -= DB * Math.log(limG);
        }
      }
      if (saturation > 0) {
        ya = saturate(saturation, ya);
        yb = saturate(saturation, yb);
      }
      if (total > most) most = total;
      l[i] = mix >= 1 ? ya : a + (ya - a) * mix;
      r[i] = mix >= 1 ? yb : b + (yb - b) * mix;
    }
    this.level = level;
    this.power = power < 1e-30 ? 0 : power;
    this.env = env < 1e-9 ? 0 : env;
    this.gain = gain;
    this.mem = mem;
    this.limG = limG;
    this.gr = -most;
  }
  reset(): void {
    this.level = this.power = this.env = this.mem = 0;
    this.gain = this.limG = 1;
  }
}
