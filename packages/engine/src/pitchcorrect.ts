/**
 * Pitch Correction: hears the pitch of one voice as it sings and pulls it to the nearest note of a key
 * and scale, as Logic's does.
 *
 * Hearing the pitch: the voice (the middle of the two sides) through a sixth-order Butterworth low pass
 * at 0.3 of the detector's rate, then every fourth frame of it at 48 kHz (about 12 kHz at any rate).
 * Every 64 of those frames (256 at 48 kHz), YIN (de Cheveigné and Kawahara, 2002) reads the latest
 * stretch: the period is the first dip of the normalized difference under a threshold, followed to its
 * bottom, between the shortest and longest periods the Range looks for. A parabola through the dip
 * places it between frames, and the difference at the full rate, a few frames either side, places it
 * again to a hundredth of a frame (a cent or so, where the low rate gives only a few). A dip far from
 * the last one, an octave either way, gives way to one near the last when that one is nearly as deep
 * (a voice's strong second harmonic, a noisy period). A voice is heard once the dip is deep and the
 * sound loud enough, and stays heard until the dip is shallow or the sound quiet (hysteresis).
 *
 * Moving the pitch: pitch-synchronous overlap-add (TD-PSOLA, simplified). Analysis marks lie one
 * period apart through what's been heard (a period read at their time; 4 ms apart where nothing is
 * voiced). Synthesis marks lie a period divided by the ratio apart; each takes the grain of the
 * analysis mark nearest it. A grain is the sound read at its analysis mark's offset under a Hann window
 * reaching from the synthesis mark before to the one after (about two periods), so the windows of
 * neighbouring grains always add to one: under each frame, one grain fades out as the next fades in.
 * Where nothing is voiced, the synthesis marks are the analysis marks and every grain reads the sound
 * where it is: it passes exactly as it came (only later), and a voice's start and end are crossfades,
 * never clicks.
 *
 * The correction: the target is the scale's note nearest the pitch heard, kept while the pitch stays
 * within a fifth of a semitone past halfway to the next (so it doesn't flip between neighbours), let go
 * after 60 ms of nothing voiced. The correction (the target less the pitch, in semitones) is followed
 * with the Response as its time constant, once a synthesis mark (0 ms: at once, the hard sound; slower:
 * vibrato and slides faster than it come through), and Amount scales it.
 *
 * Latency: the sound comes out a constant 1024 frames late at 48 kHz (in proportion at other rates),
 * which the mixer compensates: a period and a half of the lowest voice, so that every synthesis mark
 * finds the analysis marks either side of it, and the pitch it is given was heard around the very
 * moment it plays.
 *
 * In Low Latency Mode it reports no latency and reads only what has been heard: a voiced grain is the
 * analysis mark's right on its synthesis mark, or else the last one at least two frames before it (a
 * grain read between frames reads two ahead), so the voice comes out up to a period late (about 2.5 ms
 * on average for a 200 Hz voice, up to 14 ms for a low voice's lowest notes), and the pitch it is
 * given is the detector's latest, heard some 12 ms before
 * what plays (lower quality: each new note's first moments are corrected as the last note was, more so
 * for a low voice, whose detector reads the longest stretch). Unvoiced sound and silence pass with no
 * delay at all.
 */
import { PITCH_RANGES, paramValue, SCALES } from '@holo/session';
import { Biquad } from './dsp.ts';
import type { Effect, Host } from './fx.ts';

/** The lowest pitch any Range looks for (Hz): the latency is made to hold its period and a half. */
const LOWEST_HZ = PITCH_RANGES.reduce((lo, r) => Math.min(lo, r.low), Infinity);
/** The latency at 48 kHz, in frames (other rates in proportion). */
const LATENCY_48K = 1024;
/** The detector's rate, about (it takes every n-th frame, n a whole number). */
const DETECT_RATE = 12000;
/** Detector frames between readings (256 frames at 48 kHz). */
const HOP = 64;
/** YIN's threshold on the normalized difference to hear a voice, and how far it may rise while one sounds. */
const ON_DIP = 0.2;
const STAY_DIP = 0.35;
/** How loud (the low-passed middle's RMS) a voice must be to be heard, and how quiet to be let go. */
const ON_LEVEL = 10 ** (-55 / 20);
const OFF_LEVEL = 10 ** (-60 / 20);
/** How far past halfway to another scale tone the pitch must go for the target to move to it (semitones). */
const HYSTERESIS = 0.2;
/** A target further than this from the pitch is chosen again (semitones). */
const KEEP_WITHIN = 1.5;
/** A target is let go after this long with nothing voiced (s). */
const RELEASE_S = 0.06;
/** Analysis marks kept, and readings kept (a ring each). */
const MARKS = 128;
const READINGS = 16;
/** The sixth-order Butterworth's sections' Qs. */
const BUTTER6_Q = [0.5176380902050415, Math.SQRT1_2, 1.9318516525781366];

function pow2(n: number): number {
  let s = 1;
  while (s < n) s <<= 1;
  return s;
}

export class PitchCorrection implements Effect {
  gr = 0;
  private readonly host: Host;
  private readonly sr: number;
  /** Frames the sound comes out late (Low Latency Mode off). */
  private readonly lat: number;
  /** How far behind the input the analysis marks are laid (Low Latency Mode off). */
  private readonly lag: number;
  /** The detector takes every q-th frame, at `rate`. */
  private readonly q: number;
  private readonly rate: number;
  /** The analysis marks' spacing where nothing is voiced. */
  private readonly unvoiced: number;
  private readonly release: number;
  /** The periods a reading is kept within (frames). */
  private readonly pMin: number;
  private readonly pMax: number;

  // the settings
  private readonly inScale = new Uint8Array(12);
  private amount = 1;
  private response = 0;
  private log2Tune = Math.log2(440);
  private range = -1;
  private tauMin = 2;
  private tauMax = 2;
  private win = 2;
  /** How far the detector's window's middle is behind its newest frame (frames). */
  private middle = 0;

  // the sound heard, both sides
  private readonly inL: Float32Array;
  private readonly inR: Float32Array;
  private readonly inMask: number;
  /** Frames heard. */
  private t = 0;

  // the detector
  private readonly aa = new Float64Array(15);
  private readonly aaz = new Float64Array(6);
  /** The low-passed middle at the full rate, and every q-th frame of it. */
  private readonly full: Float64Array;
  private readonly fullMask: number;
  private readonly dec: Float64Array;
  private readonly decMask: number;
  private dw = 0;
  private qc = 0;
  private hc = 0;
  private readonly frame: Float64Array;
  private readonly cmnd: Float64Array;
  private readonly near = new Float64Array(7);
  private voiced = false;
  private lastTau = 0;

  // the readings: when (the window's middle), the period, its pitch (log2 Hz) and whether a voice was heard
  private readonly readAt = new Float64Array(READINGS);
  private readonly readP = new Float64Array(READINGS);
  private readonly readLog = new Float64Array(READINGS);
  private readonly readVoiced = new Uint8Array(READINGS);
  private reads = 0;

  // the analysis marks: where, and the period from each to the next
  private readonly markAt = new Float64Array(MARKS);
  private readonly markP = new Float64Array(MARKS);
  private marks = 0;
  /** Where the next mark will be (known once the last is laid). */
  private nextMark = 0;
  /** The mark last given to a grain, and the place of the one pick() found. */
  private chosen = 0;
  private picked = 0;

  // the two grains under the output: A fades out from synthesis mark sA as B fades in to sB
  private sA = 0;
  private sB = 0;
  private span = 1;
  /** Each grain's read offset: whole frames, and its fraction's four Catmull-Rom (Hermite) weights. */
  private oA = 0;
  private exA = true;
  private a0 = 0;
  private a1 = 1;
  private a2 = 0;
  private a3 = 0;
  private fA = 0;
  private oB = 0;
  private exB = true;
  private b0 = 0;
  private b1 = 1;
  private b2 = 0;
  private b3 = 0;
  private fB = 0;
  private same = true;
  /** B's analysis mark. */
  private jB = -1;

  // the correction
  private target = -1;
  private cs = 0;
  private quiet = 0;
  /** The mode the grains are laid out for (Low Latency Mode or not). */
  private live: boolean;

  constructor(host: Host) {
    this.host = host;
    const sr = host.sr;
    this.sr = sr;
    this.lat = Math.round((LATENCY_48K * sr) / 48000);
    const longest = sr / LOWEST_HZ;
    this.lag = Math.max(0, this.lat - Math.ceil(1.1 * longest) - 4);
    this.q = Math.max(1, Math.round(sr / DETECT_RATE));
    this.rate = sr / this.q;
    this.unvoiced = Math.round(sr * 0.004);
    this.release = RELEASE_S * sr;
    this.pMin = sr / 2000;
    this.pMax = sr / (LOWEST_HZ - 2);
    const tauCap = Math.ceil(this.rate / LOWEST_HZ) + 1;
    const winCap = Math.max(tauCap, Math.round(this.rate * 0.01));
    this.frame = new Float64Array(winCap + tauCap + 1);
    this.cmnd = new Float64Array(tauCap + 2);
    const decSize = pow2(winCap + tauCap + 2);
    this.dec = new Float64Array(decSize);
    this.decMask = decSize - 1;
    const fullSize = pow2((winCap + tauCap) * this.q + 8);
    this.full = new Float64Array(fullSize);
    this.fullMask = fullSize - 1;
    const inSize = pow2(this.lat + Math.ceil(2.5 * this.pMax) + 16);
    this.inL = new Float32Array(inSize);
    this.inR = new Float32Array(inSize);
    this.inMask = inSize - 1;
    BUTTER6_Q.forEach((qv, s) => {
      const f = new Biquad();
      f.set('lowpass', 0.3 * this.rate, qv, 0, sr);
      this.aa.set([f.b0, f.b1, f.b2, f.a1, f.a2], s * 5);
    });
    this.setRange(1);
    this.setScale(0, SCALES.length - 1);
    this.live = host.lowLatency;
    this.restart();
  }

  /** The sound comes out this late, compensated by the mixer (none in Low Latency Mode). */
  get latency(): number {
    return this.host.lowLatency ? 0 : this.lat;
  }

  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('pitch', p, id);
    this.setScale(v('key'), v('scale'));
    this.response = (v('response') / 1000) * this.sr;
    this.amount = v('amount') / 100;
    this.setRange(v('range'));
    this.log2Tune = Math.log2(v('tune'));
  }

  /** One setting moved: what it alone sets, as setParams would. */
  setParam(id: string, p: Record<string, number>): void {
    const v = (x: string) => paramValue('pitch', p, x);
    switch (id) {
      case 'key':
      case 'scale':
        this.setScale(v('key'), v('scale'));
        break;
      case 'response':
        this.response = (v('response') / 1000) * this.sr;
        break;
      case 'amount':
        this.amount = v('amount') / 100;
        break;
      case 'range':
        this.setRange(v('range'));
        break;
      case 'tune':
        this.log2Tune = Math.log2(v('tune'));
        break;
      default:
        this.setParams(p);
    }
  }

  /** Which pitch classes the key's scale holds. */
  private setScale(key: number, scale: number): void {
    const steps = SCALES[Math.round(scale)]?.steps ?? (SCALES[SCALES.length - 1] as (typeof SCALES)[number]).steps;
    const k = Math.round(key);
    this.inScale.fill(0);
    for (let i = 0; i < steps.length; i++) this.inScale[(k + (steps[i] as number)) % 12] = 1;
  }

  /** The periods the detector looks between, and the stretch it reads. */
  private setRange(index: number): void {
    const k = Math.round(index);
    if (k === this.range) return;
    this.range = k;
    const r = PITCH_RANGES[k] ?? (PITCH_RANGES[1] as (typeof PITCH_RANGES)[number]);
    const tauCap = this.cmnd.length - 2;
    this.tauMin = Math.max(2, Math.floor(this.rate / r.high));
    this.tauMax = Math.min(tauCap, Math.ceil(this.rate / r.low) + 1);
    this.win = Math.max(this.tauMax, Math.round(this.rate * 0.01));
    this.middle = ((this.win + this.tauMax) * this.q) / 2;
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    const live = this.host.lowLatency;
    if (live !== this.live) {
      this.live = live;
      this.restart();
    }
    const { inL, inR, inMask, full, fullMask, dec, decMask, aa, aaz, q } = this;
    const lat = live ? 0 : this.lat;
    const lag = live ? 0 : this.lag;
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      const t = this.t;
      inL[t & inMask] = a;
      inR[t & inMask] = b;
      // the detector's low pass on the middle (three sections, transposed direct form II)
      let x = (a + b) * 0.5;
      for (let s = 0; s < 3; s++) {
        const c = s * 5;
        const y = (aa[c] as number) * x + (aaz[2 * s] as number);
        aaz[2 * s] = (aa[c + 1] as number) * x - (aa[c + 3] as number) * y + (aaz[2 * s + 1] as number);
        aaz[2 * s + 1] = (aa[c + 2] as number) * x - (aa[c + 4] as number) * y;
        x = y;
      }
      full[t & fullMask] = x;
      if (++this.qc === q) {
        this.qc = 0;
        dec[this.dw & decMask] = x;
        this.dw++;
        if (++this.hc === HOP) {
          this.hc = 0;
          this.detect(t);
        }
      }
      // the analysis marks, laid up to `lag` behind what's heard
      const at = t - lag;
      while (at >= this.nextMark) this.mark();
      // the output frame: the grains under it
      const o = t - lat;
      while (o >= this.sB) this.step();
      let la: number;
      let ra: number;
      const ia = o + this.oA;
      if (this.exA) {
        la = inL[ia & inMask] as number;
        ra = inR[ia & inMask] as number;
      } else {
        const m1 = (ia - 1) & inMask;
        const m0 = ia & inMask;
        const p1 = (ia + 1) & inMask;
        const p2 = (ia + 2) & inMask;
        la =
          this.a0 * (inL[m1] as number) +
          this.a1 * (inL[m0] as number) +
          this.a2 * (inL[p1] as number) +
          this.a3 * (inL[p2] as number);
        ra =
          this.a0 * (inR[m1] as number) +
          this.a1 * (inR[m0] as number) +
          this.a2 * (inR[p1] as number) +
          this.a3 * (inR[p2] as number);
      }
      if (this.same) {
        l[i] = la;
        r[i] = ra;
      } else {
        let lb: number;
        let rb: number;
        const ib = o + this.oB;
        if (this.exB) {
          lb = inL[ib & inMask] as number;
          rb = inR[ib & inMask] as number;
        } else {
          const m1 = (ib - 1) & inMask;
          const m0 = ib & inMask;
          const p1 = (ib + 1) & inMask;
          const p2 = (ib + 2) & inMask;
          lb =
            this.b0 * (inL[m1] as number) +
            this.b1 * (inL[m0] as number) +
            this.b2 * (inL[p1] as number) +
            this.b3 * (inL[p2] as number);
          rb =
            this.b0 * (inR[m1] as number) +
            this.b1 * (inR[m0] as number) +
            this.b2 * (inR[p1] as number) +
            this.b3 * (inR[p2] as number);
        }
        const w = 0.5 - 0.5 * Math.cos((Math.PI * (o - this.sA)) / this.span);
        l[i] = la + (lb - la) * w;
        r[i] = ra + (rb - ra) * w;
      }
      this.t = t + 1;
    }
  }

  /** YIN on the detector's latest stretch, as frame `t` is heard: a reading. */
  private detect(t: number): void {
    const { frame, cmnd, dec, decMask, tauMin, tauMax, win } = this;
    const len = win + tauMax;
    let energy = 0;
    for (let i = 0; i < len; i++) {
      const v = dec[(this.dw - len + i) & decMask] as number;
      frame[i] = v;
      energy += v * v;
    }
    // the difference at each lag, and its cumulative mean normalized form
    cmnd[0] = 1;
    let running = 0;
    for (let tau = 1; tau <= tauMax; tau++) {
      let s = 0;
      for (let j = 0; j < win; j++) {
        const d = (frame[j] as number) - (frame[j + tau] as number);
        s += d * d;
      }
      running += s;
      cmnd[tau] = running > 0 ? (s * tau) / running : 1;
    }
    // the first dip under the threshold, followed to its bottom
    let best = -1;
    for (let k = tauMin; k <= tauMax; k++) {
      if ((cmnd[k] as number) < ON_DIP) {
        while (k < tauMax && (cmnd[k + 1] as number) < (cmnd[k] as number)) k++;
        best = k;
        break;
      }
    }
    if (best < 0) {
      // none: the deepest, or the period it's a multiple of when that's nearly as deep
      best = tauMin;
      for (let k = tauMin + 1; k <= tauMax; k++) if ((cmnd[k] as number) < (cmnd[best] as number)) best = k;
      for (let m = 2; m <= 3; m++) {
        const c = this.dipNear(best / m);
        if (c >= tauMin && (cmnd[c] as number) < (cmnd[best] as number) + 0.1) {
          best = c;
          break;
        }
      }
    }
    // an octave from the last period: the last period's dip, when it's nearly as deep
    const last = this.lastTau;
    if (
      this.voiced &&
      last > 0 &&
      (Math.abs(best - 2 * last) < 0.12 * last || Math.abs(best - last / 2) < 0.06 * last)
    ) {
      const c = this.dipNear(last);
      if (c >= tauMin && (cmnd[c] as number) < STAY_DIP && (cmnd[c] as number) < (cmnd[best] as number) + 0.05)
        best = c;
    }
    // between frames: a parabola through the dip and its neighbours
    const dip = cmnd[best] as number;
    const before = best > 1 ? (cmnd[best - 1] as number) : dip;
    const after = best < tauMax ? (cmnd[best + 1] as number) : dip;
    const den = before + after - 2 * dip;
    const shift = den > 0 ? Math.max(-0.5, Math.min(0.5, (before - after) / (2 * den))) : 0;
    const tauF = best + shift;
    // again at the full rate: the difference a few frames either side, and a parabola through its least
    const { full, fullMask, near, q } = this;
    const around = Math.round(tauF * q);
    const span = win * q;
    let least = 0;
    for (let k = 0; k < 7; k++) {
      const lag = Math.max(2, around + k - 3);
      let s = 0;
      for (let j = 0; j < span; j++) {
        const d = (full[(t - j) & fullMask] as number) - (full[(t - j - lag) & fullMask] as number);
        s += d * d;
      }
      near[k] = s;
      if (s < (near[least] as number)) least = k;
    }
    let period = Math.max(2, around + least - 3);
    if (least > 0 && least < 6) {
      const u = near[least - 1] as number;
      const m = near[least] as number;
      const v = near[least + 1] as number;
      const dd = u + v - 2 * m;
      if (dd > 0) period += Math.max(-0.5, Math.min(0.5, (u - v) / (2 * dd)));
    }
    // (a sound that wasn't a number: no period, and nothing heard)
    period = period > 0 ? Math.min(this.pMax, Math.max(this.pMin, period)) : this.unvoiced;
    // heard, with hysteresis on the dip and the level
    const rms = Math.sqrt(energy / len);
    this.voiced = this.voiced ? dip < STAY_DIP && rms > OFF_LEVEL : dip < ON_DIP && rms > ON_LEVEL;
    this.lastTau = this.voiced ? tauF : 0;
    // its time: the window's middle (later than the reading before, whatever the Range did)
    const h = this.reads;
    const slot = h & (READINGS - 1);
    const prev = h > 0 ? (this.readAt[(h - 1) & (READINGS - 1)] as number) : -Infinity;
    this.readAt[slot] = Math.max(t - this.middle, prev + 1);
    this.readP[slot] = period;
    this.readLog[slot] = Math.log2(this.sr / period);
    this.readVoiced[slot] = this.voiced ? 1 : 0;
    this.reads = h + 1;
    // (the low pass's state, kept out of the denormals, and cleared of anything that isn't a number)
    for (let k = 0; k < 6; k++) {
      const z = Math.abs(this.aaz[k] as number);
      if (!(z > 1e-20 && z < 1e10)) this.aaz[k] = 0;
    }
  }

  /** The deepest dip within a frame of lag `x` (a whole lag; −1 out of range). */
  private dipNear(x: number): number {
    const c = Math.round(x);
    if (c < this.tauMin || c > this.tauMax) return -1;
    let best = c;
    if (c - 1 >= this.tauMin && (this.cmnd[c - 1] as number) < (this.cmnd[best] as number)) best = c - 1;
    if (c + 1 <= this.tauMax && (this.cmnd[c + 1] as number) < (this.cmnd[best] as number)) best = c + 1;
    return best;
  }

  /** The reading nearest time `x` (its slot; −1 before the first). */
  private readingAt(x: number): number {
    const n = this.reads;
    if (n === 0) return -1;
    const mask = READINGS - 1;
    const lo = n > READINGS ? n - READINGS : 0;
    let h = n - 1;
    while (
      h > lo &&
      Math.abs((this.readAt[(h - 1) & mask] as number) - x) <= Math.abs((this.readAt[h & mask] as number) - x)
    )
      h--;
    return h & mask;
  }

  /** The next analysis mark: its period the reading's at its time (unvoiced: a fixed 4 ms). */
  private mark(): void {
    const j = this.marks;
    const at = this.nextMark;
    const h = this.readingAt(at);
    const p = h >= 0 && this.readVoiced[h] === 1 ? (this.readP[h] as number) : this.unvoiced;
    this.markAt[j & (MARKS - 1)] = at;
    this.markP[j & (MARKS - 1)] = p;
    this.marks = j + 1;
    this.nextMark = at + p;
  }

  /**
   * The analysis mark nearest `s` among those known (the ones laid, and the next), that lies at most
   * `ahead` after it: its index, its place left in `picked`.
   */
  private pick(s: number, ahead: number): number {
    const known = this.marks;
    const oldest = known > MARKS - 1 ? known - MARKS + 1 : 0;
    let j = this.chosen;
    if (j < oldest) j = oldest;
    if (j > known) j = known;
    const mask = MARKS - 1;
    while (j > oldest && (j < known ? (this.markAt[j & mask] as number) : this.nextMark) - s > ahead) j--;
    while (j < known) {
      const cur = this.markAt[j & mask] as number;
      const next = j + 1 < known ? (this.markAt[(j + 1) & mask] as number) : this.nextMark;
      if (next - s > ahead || Math.abs(next - s) > Math.abs(cur - s)) break;
      j++;
    }
    this.picked = j < known ? (this.markAt[j & mask] as number) : this.nextMark;
    return j;
  }

  /** The output has reached synthesis mark sB: B fades out from it, and the next grain is chosen. */
  private step(): void {
    const dt = this.sB - this.sA;
    const sA = this.sB;
    this.sA = sA;
    this.oA = this.oB;
    this.exA = this.exB;
    this.a0 = this.b0;
    this.a1 = this.b1;
    this.a2 = this.b2;
    this.a3 = this.b3;
    this.fA = this.fB;
    const mask = MARKS - 1;
    const jB = this.jB;
    const known = this.marks;
    const p =
      jB >= 0 && jB < known && jB > known - MARKS
        ? (this.markP[jB & mask] as number)
        : known > 0
          ? (this.markP[(known - 1) & mask] as number)
          : this.unvoiced;
    const h = this.readingAt(sA + p);
    const k = this.response > 0 ? Math.exp(-dt / this.response) : 0;
    // grains read at most this far ahead of where they're laid (what's been heard by then)
    const ahead = this.live ? -2 : this.lat - 2;
    let s: number;
    let j: number;
    let d: number;
    if (h >= 0 && this.readVoiced[h] === 1) {
      this.quiet = 0;
      const pitch = 69 + 12 * ((this.readLog[h] as number) - this.log2Tune);
      this.retarget(pitch);
      const c = this.target - pitch;
      this.cs = c + (this.cs - c) * k;
      const ratio = Math.exp(this.cs * this.amount * (Math.LN2 / 12));
      s = sA + p / ratio;
      // (live, a grain read where it's laid needs nothing ahead: one that isn't must be two frames back)
      j = this.pick(s, this.live ? 0 : ahead);
      if (this.live && this.picked !== s) j = this.pick(s, ahead);
      d = this.picked - s;
    } else {
      this.cs *= k;
      this.quiet += dt;
      if (this.quiet > this.release) this.target = -1;
      // the analysis mark about a period on becomes the synthesis mark: the sound read where it is
      s = sA + p;
      j = this.pick(s, Infinity);
      if (this.picked >= sA + 0.5 * p && this.picked <= sA + 1.5 * p) {
        s = this.picked;
        d = 0;
      } else {
        j = this.pick(s, ahead);
        d = this.picked - s;
      }
    }
    this.chosen = j;
    this.jB = j;
    this.sB = s;
    this.span = s - sA;
    const whole = Math.floor(d);
    const f = d - whole;
    this.oB = whole;
    this.fB = f;
    this.exB = f === 0;
    this.b0 = f * (-0.5 + f * (1 - 0.5 * f));
    this.b1 = 1 + f * f * (-2.5 + 1.5 * f);
    this.b2 = f * (0.5 + f * (2 - 1.5 * f));
    this.b3 = f * f * (-0.5 + 0.5 * f);
    this.same = this.oA === this.oB && this.fA === this.fB;
  }

  /** The target for a pitch heard (MIDI, fractional): the nearest scale tone, unless the last one still holds. */
  private retarget(pitch: number): void {
    const base = Math.floor(pitch);
    let nearest = -1;
    let dist = 99;
    for (let m = base - 2; m <= base + 3; m++) {
      if (this.inScale[((m % 12) + 12) % 12] !== 1) continue;
      const dd = Math.abs(m - pitch);
      if (dd < dist) {
        dist = dd;
        nearest = m;
      }
    }
    const t = this.target;
    if (t >= 0 && this.inScale[t % 12] === 1) {
      const held = Math.abs(t - pitch);
      if (held < KEEP_WITHIN && held <= dist + HYSTERESIS) return;
    }
    this.target = nearest;
  }

  /** The grains laid out again where the output stands, each reading the sound where it is. */
  private restart(): void {
    const o = this.t - (this.live ? 0 : this.lat);
    if (this.marks === 0) this.nextMark = o;
    this.chosen = 0;
    const j = this.pick(o, Infinity);
    this.chosen = j;
    this.jB = j;
    this.sB = this.picked;
    this.sA = this.picked - this.unvoiced;
    this.span = this.unvoiced;
    this.oA = this.oB = 0;
    this.fA = this.fB = 0;
    this.exA = this.exB = true;
    this.a0 = this.a2 = this.a3 = this.b0 = this.b2 = this.b3 = 0;
    this.a1 = this.b1 = 1;
    this.same = true;
  }

  reset(): void {
    this.inL.fill(0);
    this.inR.fill(0);
    this.full.fill(0);
    this.dec.fill(0);
    this.aaz.fill(0);
    this.t = 0;
    this.dw = this.qc = this.hc = 0;
    this.voiced = false;
    this.lastTau = 0;
    this.reads = 0;
    this.marks = 0;
    this.nextMark = 0;
    this.target = -1;
    this.cs = 0;
    this.quiet = 0;
    this.live = this.host.lowLatency;
    this.restart();
  }
}
