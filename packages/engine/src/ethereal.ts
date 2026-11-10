/**
 * Ethereal: a synthesizer for pads and glowing keys. Each voice is stereo: five saws spread across
 * the field (a supersaw), two sines an octave up tuned a few cents apart (one leaning left, one
 * right, so they shimmer against each other), a bell partial an octave and a fifth up, a sine an
 * octave down, and breath (noise tuned to the note). A gentle low-pass per side blooms open as the
 * note swells and drifts on a slow wave of its own.
 *
 * Then the air it plays in, the instrument's own: an ensemble chorus, a long, softly moving hall (eight
 * delays feeding each other through a Householder matrix, damped, two of them swaying), and a shimmer
 * (the hall's sound an octave up, fed back into it, so every note leaves a rising halo). The hall
 * rings on after the last voice; the instrument counts as sounding until it's quiet.
 *
 * Its six knobs (SYNTH_MACROS) move while it plays.
 */
import { macroValues } from '@holo/session';
import { Env } from './analog.ts';
import { Noise } from './dsp.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

interface AetherParams {
  // the knobs
  brightness: number;
  bloom: number;
  release: number;
  motion: number;
  shimmer: number;
  space: number;
  // the preset's
  /** The supersaw's level, its spread (cents) and how wide it sits (0 to 1). */
  saws: number;
  spread: number;
  width: number;
  /** The octave-up sines, the bell partial, the octave-down sine, the breath. */
  sine: number;
  bell: number;
  sub: number;
  breath: number;
  aD: number;
  aS: number;
  /** Seconds the sines and the bell take to fade under the note (long on a pad, short on keys). */
  partialDecay: number;
  /** Octaves the filter opens as the note blooms. */
  bloomAmt: number;
  keytrack: number;
  velBright: number;
  velAmp: number;
  lfoRate: number;
  level: number;
}

type Knobs = 'brightness' | 'bloom' | 'release' | 'motion' | 'shimmer' | 'space';

const PRESETS: Record<string, Omit<AetherParams, Knobs>> = {
  'Ethereal Pad': {
    saws: 1,
    spread: 17,
    width: 0.9,
    sine: 0.32,
    bell: 0.05,
    sub: 0.22,
    breath: 0.035,
    aD: 3,
    aS: 0.9,
    partialDecay: 8,
    bloomAmt: 1.3,
    keytrack: 0.4,
    velBright: 0.8,
    velAmp: 0.35,
    lfoRate: 0.11,
    level: 0.14,
  },
  'Ethereal Keys': {
    saws: 0.42,
    spread: 11,
    width: 0.75,
    sine: 0.62,
    bell: 0.24,
    sub: 0.16,
    breath: 0.025,
    aD: 3.2,
    aS: 0.16,
    partialDecay: 1.8,
    bloomAmt: 0.5,
    keytrack: 0.5,
    velBright: 1.2,
    velAmp: 0.55,
    lfoRate: 0.17,
    level: 0.32,
  },
};

export const ETHEREAL_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): AetherParams {
  const name = PRESETS[preset] ? preset : 'Ethereal Pad';
  return { ...(PRESETS[name] as AetherParams), ...macroValues(name, params) } as AetherParams;
}

const TAU = Math.PI * 2;
/** The supersaw's five detunes (as parts of its spread) and places across the field. */
const SAW_CENTS = [-1, -0.44, 0.03, 0.41, 0.97];
const SAW_PANS = [-1, -0.5, 0, 0.5, 1];

class AetherVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private readonly vel: number;
  private readonly saw = new Float64Array(5);
  private readonly sawL = new Float64Array(5);
  private readonly sawR = new Float64Array(5);
  private readonly ratio = new Float64Array(5);
  /**
   * The four sines, each a pair turning by a small angle a sample (the "magic circle": two multiplies,
   * its size steady), retuned every sixteenth sample: the octave-up pair, the bell, the octave down.
   */
  private sA = 0;
  private cA = 1;
  private sB = 0;
  private cB = 1;
  private sBell = 0;
  private cBell = 1;
  private sSub = 0;
  private cSub = 1;
  private eA = 0;
  private eB = 0;
  private eBell = 0;
  private eSub = 0;
  private readonly amp: Env;
  private readonly bloomEnv: Env;
  private part = 1;
  private partCoef = 1;
  private lfo: number;
  private drift = 0;
  private driftTo = 0;
  private freq = 440;
  private counter = 0;
  private killing = 0;
  // the two sides' filters (state-variable low-pass) and the breath's band-pass
  private l1 = 0;
  private l2 = 0;
  private r1 = 0;
  private r2 = 0;
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private b1 = 0;
  private b2 = 0;
  private ba1 = 0;
  private ba2 = 0;
  private ba3 = 0;
  private readonly noise: Noise;
  private readonly p: AetherParams;
  private readonly sr: number;

  constructor(p: AetherParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.vel = velocity / 127;
    this.noise = new Noise(seed * 104729 + 3);
    this.amp = new Env(sr);
    // it only moves the filter, which is worked out every sixteenth sample: it runs at that rate
    this.bloomEnv = new Env(sr / 16);
    this.retime();
    this.amp.gate(true);
    this.bloomEnv.gate(true);
    for (let j = 0; j < 5; j++) {
      this.saw[j] = ((seed * (j + 7)) % 101) / 101;
      this.ratio[j] = 2 ** (((SAW_CENTS[j] as number) * p.spread) / 1200);
      const theta = (((SAW_PANS[j] as number) * p.width + 1) * Math.PI) / 4;
      this.sawL[j] = Math.cos(theta);
      this.sawR[j] = Math.sin(theta);
    }
    this.lfo = ((seed * 37) % 100) / 100;
    const pa = (TAU * ((seed * 13) % 50)) / 50;
    const pb = (TAU * ((seed * 29) % 50)) / 50;
    this.sA = Math.sin(pa);
    this.cA = Math.cos(pa);
    this.sB = Math.sin(pb);
    this.cB = Math.cos(pb);
  }

  /** The envelopes' times from the knobs (as they are now). */
  retime(): void {
    const p = this.p;
    this.amp.set(p.bloom, p.aD, p.aS, p.release);
    // the filter opens over a little longer than the note swells
    this.bloomEnv.set(p.bloom * 1.4 + 0.05, 30, 1, p.release);
    this.partCoef = Math.exp(-6.9 / (Math.max(0.05, p.partialDecay) * this.sr));
  }

  release(): void {
    this.released = true;
    this.amp.gate(false);
    this.bloomEnv.gate(false);
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const p = this.p;
    const sr = this.sr;
    const amp = this.amp;
    const bloom = this.bloomEnv;
    const noise = this.noise;
    const saw = this.saw;
    const ratio = this.ratio;
    const sawL = this.sawL;
    const sawR = this.sawR;
    const velGain = 1 - p.velAmp + p.velAmp * this.vel * this.vel;
    const gain = p.level * velGain * ctl.expression;
    const sawGain = p.saws * 0.45;
    const sine = p.sine;
    const bellLevel = p.bell;
    const subLevel = p.sub;
    const breathLevel = p.breath * 3;
    const partCoef = this.partCoef;
    // the state the loop runs on, in locals (a field read and written each sample costs more than the sums)
    let dt = this.freq / sr;
    let sA = this.sA;
    let cA = this.cA;
    let sB = this.sB;
    let cB = this.cB;
    let sBell = this.sBell;
    let cBell = this.cBell;
    let sSub = this.sSub;
    let cSub = this.cSub;
    let eA = this.eA;
    let eB = this.eB;
    let eBell = this.eBell;
    let eSub = this.eSub;
    let part = this.part;
    let l1 = this.l1;
    let l2 = this.l2;
    let r1 = this.r1;
    let r2 = this.r2;
    let b1 = this.b1;
    let b2 = this.b2;
    let a1 = this.a1;
    let a2 = this.a2;
    let a3 = this.a3;
    let ba1 = this.ba1;
    let ba2 = this.ba2;
    let ba3 = this.ba3;
    let i = start;
    for (; i < end; i++) {
      amp.step();
      part *= partCoef;
      if ((this.counter++ & 15) === 0) {
        // every sixteenth sample: the bloom, the slow wave, the drift, the pitch, the filters
        bloom.step();
        this.lfo += (16 * p.lfoRate) / sr;
        if (this.lfo >= 1) this.lfo -= 1;
        const wave = Math.sin(TAU * this.lfo);
        if ((this.counter & 4095) < 8) {
          noise.step();
          this.driftTo = noise.value * (1 + 5 * p.motion);
        }
        this.drift += (this.driftTo - this.drift) * (16 / (1.5 * sr));
        const vib = ctl.mod > 0 ? Math.sin(TAU * this.lfo * 40) * 0.25 * ctl.mod : 0;
        this.freq = 440 * 2 ** ((this.key - 69 + ctl.bend + vib + this.drift / 100) / 12);
        dt = this.freq / sr;
        const w = Math.PI * dt;
        eA = 2 * Math.sin(w * 2.0035);
        eB = 2 * Math.sin(w * 1.9965);
        eBell = 2 * Math.sin(Math.min(w * 3.0012, 1.5));
        eSub = 2 * Math.sin(w * 0.5);
        const cutoff =
          p.brightness *
          2 **
            (p.bloomAmt * (bloom.level - 1) +
              p.motion * 0.9 * wave +
              (p.keytrack * (this.key - 60)) / 12 +
              p.velBright * (this.vel - 0.7) +
              ctl.mod * 0.8);
        const g = Math.tan((Math.PI * Math.min(Math.max(cutoff, 30), sr * 0.45)) / sr);
        const k = 2 - 2 * 0.14;
        a1 = 1 / (1 + g * (g + k));
        a2 = g * a1;
        a3 = g * a2;
        // the breath: a band around the note's second harmonic
        const gb = Math.tan((Math.PI * Math.min(this.freq * 2, sr * 0.4)) / sr);
        ba1 = 1 / (1 + gb * (gb + 1.2));
        ba2 = gb * ba1;
        ba3 = gb * ba2;
      }
      // the supersaw, band-limited (polyBLEP), each saw at its place
      let sl = 0;
      let sr2 = 0;
      for (let j = 0; j < 5; j++) {
        const d = dt * (ratio[j] as number);
        let ph = (saw[j] as number) + d;
        if (ph >= 1) ph -= 1;
        saw[j] = ph;
        let b: number;
        if (ph < d) {
          const t = ph / d;
          b = t + t - t * t - 1;
        } else if (ph > 1 - d) {
          const t = (ph - 1) / d;
          b = t * t + t + t + 1;
        } else b = 0;
        const v = 2 * ph - 1 - b;
        sl += v * (sawL[j] as number);
        sr2 += v * (sawR[j] as number);
      }
      // the octave-up pair, a few cents apart, one each side; the bell; the octave down
      sA += eA * cA;
      cA -= eA * sA;
      sB += eB * cB;
      cB -= eB * sB;
      sBell += eBell * cBell;
      cBell -= eBell * sBell;
      sSub += eSub * cSub;
      cSub -= eSub * sSub;
      const a = sA * sine * part;
      const c = sB * sine * part;
      const bell = sBell * bellLevel * part * part;
      const sub = sSub * subLevel;
      noise.step();
      const nv = noise.value - b2;
      const nb1 = ba1 * b1 + ba2 * nv;
      const nb2 = b2 + ba2 * b1 + ba3 * nv;
      b1 = 2 * nb1 - b1;
      b2 = 2 * nb2 - b2;
      const breath = nb1 * breathLevel;
      const xl = sl * sawGain + a * 0.85 + c * 0.35 + bell + sub + breath;
      const xr = sr2 * sawGain + a * 0.35 + c * 0.85 + bell + sub + breath;
      // the two sides' low-passes
      let v3 = xl - l2;
      let v1 = a1 * l1 + a2 * v3;
      let v2 = l2 + a2 * l1 + a3 * v3;
      l1 = 2 * v1 - l1;
      l2 = 2 * v2 - l2;
      const yl = v2;
      v3 = xr - r2;
      v1 = a1 * r1 + a2 * v3;
      v2 = r2 + a2 * r1 + a3 * v3;
      r1 = 2 * v1 - r1;
      r2 = 2 * v2 - r2;
      let e = amp.level;
      if (this.killing > 0) {
        this.killing *= 0.995;
        e *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          break;
        }
      }
      if (amp.off) {
        this.done = true;
        break;
      }
      l[i] = (l[i] as number) + yl * e * gain;
      r[i] = (r[i] as number) + v2 * e * gain;
    }
    this.sA = sA;
    this.cA = cA;
    this.sB = sB;
    this.cB = cB;
    this.sBell = sBell;
    this.cBell = cBell;
    this.sSub = sSub;
    this.cSub = cSub;
    this.eA = eA;
    this.eB = eB;
    this.eBell = eBell;
    this.eSub = eSub;
    this.part = part;
    this.l1 = l1;
    this.l2 = l2;
    this.r1 = r1;
    this.r2 = r2;
    this.b1 = b1;
    this.b2 = b2;
    this.a1 = a1;
    this.a2 = a2;
    this.a3 = a3;
    this.ba1 = ba1;
    this.ba2 = ba2;
    this.ba3 = ba3;
  }
}

/** The hall: eight delays through a Householder matrix, damped, two swaying, after four diffusers. */
/** A small, swaying hall (eight lines, fed back through each other): Ethereal's, and the other synths that carry their own space. */
export class Hall {
  private readonly lines: Float32Array[] = [];
  private readonly lens: Int32Array;
  private readonly pos = new Int32Array(8);
  private readonly fb = new Float64Array(8);
  private readonly lp = new Float64Array(8);
  private readonly aps: Float32Array[] = [];
  private readonly apPos = new Int32Array(4);
  private readonly pre: Float32Array;
  private prePos = 0;
  private readonly preLen: number;
  private damp: number;
  private sway = 0;
  private swing = 0;
  private tick = 0;
  private readonly swayStep: number;
  private readonly sr: number;
  /** What process() made. */
  outL = 0;
  outR = 0;

  constructor(sr: number) {
    this.sr = sr;
    const k = sr / 48000;
    this.lens = Int32Array.from([1693, 1889, 2153, 2417, 2731, 3049, 3343, 3637], (n) => Math.round(n * k * 1.15));
    for (const n of this.lens) this.lines.push(new Float32Array(n + 16));
    for (const n of [142, 107, 379, 277]) this.aps.push(new Float32Array(Math.round((n * sr) / 29761)));
    this.preLen = Math.round(0.022 * sr);
    this.pre = new Float32Array(this.preLen);
    this.damp = 1 - Math.exp((-TAU * 5200) / sr);
    this.swayStep = 0.31 / sr;
    this.setDecay(6);
  }

  /** Seconds to fall 60 dB. */
  setDecay(t60: number): void {
    for (let i = 0; i < 8; i++) this.fb[i] = 10 ** ((-3 * (this.lens[i] as number)) / (t60 * this.sr));
  }

  process(inL: number, inR: number): void {
    // pre-delay, then the diffusers
    let x = this.pre[this.prePos] as number;
    this.pre[this.prePos] = (inL + inR) * 0.5;
    if (++this.prePos >= this.preLen) this.prePos = 0;
    for (let a = 0; a < 4; a++) {
      const buf = this.aps[a] as Float32Array;
      const at = this.apPos[a] as number;
      const d = buf[at] as number;
      const w = x - 0.62 * d;
      buf[at] = w;
      x = d + 0.62 * w;
      this.apPos[a] = at + 1 >= buf.length ? 0 : at + 1;
    }
    // the sway is slow: worked out every sixteenth sample
    if ((this.tick++ & 15) === 0) {
      this.sway += this.swayStep * 16;
      if (this.sway >= 1) this.sway -= 1;
      this.swing = Math.sin(TAU * this.sway) * 6 * (this.sr / 48000);
    }
    const swing = this.swing;
    // read each line (two swaying, read between samples), damp it, and sum for the matrix
    let sum = 0;
    for (let i = 0; i < 8; i++) {
      const line = this.lines[i] as Float32Array;
      const n = line.length;
      let y: number;
      if (i === 1 || i === 5) {
        const back = (this.lens[i] as number) + (i === 1 ? swing : -swing);
        let rp = (this.pos[i] as number) - back;
        while (rp < 0) rp += n;
        const j = Math.floor(rp);
        const t = rp - j;
        y = (line[j] as number) * (1 - t) + (line[j + 1 >= n ? 0 : j + 1] as number) * t;
      } else {
        let rp = (this.pos[i] as number) - (this.lens[i] as number);
        if (rp < 0) rp += n;
        y = line[rp] as number;
      }
      const lp = (this.lp[i] as number) + (y - (this.lp[i] as number)) * this.damp;
      this.lp[i] = lp;
      sum += lp;
    }
    const m = sum * 0.25;
    let ol = 0;
    let or = 0;
    for (let i = 0; i < 8; i++) {
      const lp = this.lp[i] as number;
      const line = this.lines[i] as Float32Array;
      const at = this.pos[i] as number;
      line[at] = (i & 1 ? -x : x) * 0.5 + (lp - m) * (this.fb[i] as number);
      this.pos[i] = at + 1 >= line.length ? 0 : at + 1;
      if (i & 1) or += i & 2 ? -lp : lp;
      else ol += i & 2 ? -lp : lp;
    }
    this.outL = ol * 0.5;
    this.outR = or * 0.5;
  }
}

/** An octave up: two read heads sweeping a short delay twice as fast as it's written, cross-faded. */
class Octave {
  private readonly buf = new Float32Array(8192);
  private w = 0;
  private p = 0;
  private readonly win: number;
  private lp = 0;
  private readonly lpCoef: number;
  /** What process() made. */
  out = 0;
  constructor(sr: number) {
    this.win = Math.round(0.045 * sr);
    this.lpCoef = 1 - Math.exp((-TAU * 6000) / sr);
  }
  process(x: number): void {
    const buf = this.buf;
    buf[this.w] = x;
    this.p += 1 / this.win;
    if (this.p >= 1) this.p -= 1;
    let y = 0;
    for (let h = 0; h < 2; h++) {
      const ph = h === 0 ? this.p : this.p + 0.5 >= 1 ? this.p - 0.5 : this.p + 0.5;
      const back = (1 - ph) * this.win + 2;
      let rp = this.w - back;
      if (rp < 0) rp += 8192;
      const j = Math.floor(rp);
      const t = rp - j;
      const s = (buf[j] as number) * (1 - t) + (buf[(j + 1) & 8191] as number) * t;
      y += s * (1 - Math.abs(2 * ph - 1));
    }
    this.w = (this.w + 1) & 8191;
    this.lp += (y - this.lp) * this.lpCoef;
    this.out = this.lp;
  }
}

export class EtherealSynth extends Instrument {
  private readonly p: AetherParams;
  private readonly preset: string;
  private seed = 1;
  // the air: the voices' sound before it, the chorus, the hall and its shimmer
  private dryL = new Float32Array(1024);
  private dryR = new Float32Array(1024);
  private readonly chL = new Float32Array(4096);
  private readonly chR = new Float32Array(4096);
  private chPos = 0;
  private chPh = 0;
  private chTick = 0;
  private dA = 0;
  private dB = 0;
  private readonly chStep: number;
  private readonly hall: Hall;
  private readonly octave: Octave;
  private shimmerBack = 0;
  /** How loud the hall still is (it rings on after the last voice). */
  private tail = 0;

  constructor(sr: number, preset: string, params?: Record<string, number>) {
    super(sr);
    this.preset = preset;
    this.p = resolve(preset, params);
    this.maxVoices = 24;
    this.chStep = 0.23 / sr;
    this.hall = new Hall(sr);
    this.octave = new Octave(sr);
    this.hall.setDecay(3 + 9 * this.p.space);
  }

  update(params?: Record<string, number>): void {
    Object.assign(this.p, resolve(this.preset, params));
    this.hall.setDecay(3 + 9 * this.p.space);
    for (const v of this.voices as AetherVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice {
    return new AetherVoice(this.p, key, velocity, this.sr, this.seed++);
  }

  override get active(): number {
    return super.active + (this.tail > 2e-5 ? 1 : 0);
  }

  override render(l: Float32Array, r: Float32Array, start: number, end: number): void {
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
    const hall = this.hall;
    const octave = this.octave;
    const space = p.space;
    const dryGain = 1 - 0.45 * space;
    const wetGain = space * 0.9;
    const back = p.shimmer * 0.55;
    const base = 0.014 * sr;
    const depth = 0.003 * sr;
    let peak = 0;
    for (let i = start; i < end; i++) {
      const xl = dl[i] as number;
      const xr = dr[i] as number;
      // the ensemble: each side heard again a moment later from the other, swaying (the sway worked
      // out every eighth sample)
      if ((this.chTick++ & 7) === 0) {
        this.chPh += this.chStep * 8;
        if (this.chPh >= 1) this.chPh -= 1;
        this.dA = base + depth * Math.sin(TAU * this.chPh);
        this.dB = base * 1.13 + depth * Math.sin(TAU * (this.chPh + 0.37));
      }
      const at = this.chPos;
      this.chL[at] = xl;
      this.chR[at] = xr;
      this.chPos = (at + 1) & 4095;
      const dA = this.dA;
      const dB = this.dB;
      let ra = at - dA;
      if (ra < 0) ra += 4096;
      let rb = at - dB;
      if (rb < 0) rb += 4096;
      const ja = Math.floor(ra);
      const ta = ra - ja;
      const jb = Math.floor(rb);
      const tb = rb - jb;
      const fromR = (this.chR[ja] as number) * (1 - ta) + (this.chR[(ja + 1) & 4095] as number) * ta;
      const fromL = (this.chL[jb] as number) * (1 - tb) + (this.chL[(jb + 1) & 4095] as number) * tb;
      const cl = xl * 0.85 + fromR * 0.4;
      const cr = xr * 0.85 + fromL * 0.4;
      // the hall, with the shimmer's octave fed back into it
      hall.process(cl + this.shimmerBack, cr + this.shimmerBack);
      octave.process((hall.outL + hall.outR) * 0.5);
      // fed back softly saturated: however far the knobs go, the halo can't run away
      const sb = octave.out * back;
      this.shimmerBack = sb < -3 ? -1 : sb > 3 ? 1 : (sb * (27 + sb * sb)) / (27 + 9 * sb * sb);
      const wl = hall.outL;
      const wr = hall.outR;
      // the tail as it's heard (with Space down, the hall isn't)
      const a = (Math.abs(wl) + Math.abs(wr)) * wetGain;
      if (a > peak) peak = a;
      l[i] = (l[i] as number) + cl * dryGain + wl * wetGain;
      r[i] = (r[i] as number) + cr * dryGain + wr * wetGain;
    }
    this.tail = Math.max(peak, this.tail * 0.9);
  }
}
