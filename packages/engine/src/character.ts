/**
 * The finishing touches Hallowed Lanterns gives its voices, as plugins: a transient softener, stereo
 * width with a constant-power position, tape warmth, and wow and flutter. Each is the game's own
 * arithmetic (hlaudio.effects: soften, width, saturate, wow_flutter; orch.tape) run as it plays,
 * one sample after another, so the same settings give the same sound in both.
 */
import { paramValue } from '@holo/session';
import { clipKey } from './compile.ts';
import { Biquad, dbToGain, gainToDb } from './dsp.ts';
import type { Effect, Host } from './fx.ts';
import { Random } from './spaces.ts';

const coef = (seconds: number, sr: number): number => Math.exp(-1 / (seconds * sr));

/**
 * Transient softener: a fast and a slow peak follower on the louder side; where the fast one runs
 * ahead (the first milliseconds of an attack) the gain dips by their ratio, to −14 dB at most, raised
 * to the amount, and smoothed over 0.7 ms.
 */
export class Softener implements Effect {
  gr = 0;
  private amount = 0.5;
  private fast = 0;
  private slow = 0;
  private release = 0;
  private smooth = 0;
  private ef = 0;
  private es = 0;
  private g = 1;
  /** The smoothed gain starts at the first sample's own (as the game's one-pole does). */
  private fresh = true;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('softener', p, id);
    const sr = this.host.sr;
    this.amount = v('amount') / 100;
    this.fast = coef(v('fast') / 1000, sr);
    this.slow = coef(v('slow') / 1000, sr);
    this.release = coef(v('release') / 1000, sr);
    this.smooth = coef(0.0007, sr);
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    let { ef, es, g } = this;
    const { fast, slow, release, smooth, amount } = this;
    let least = 1;
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      const m = Math.max(Math.abs(a), Math.abs(b));
      ef = m > ef ? fast * ef + (1 - fast) * m : release * ef + (1 - release) * m;
      es = m > es ? slow * es + (1 - slow) * m : release * es + (1 - release) * m;
      const ratio = Math.min(1, Math.max(0.2, (es + 1e-6) / (ef + 1e-6)));
      const target = ratio ** amount;
      if (this.fresh) {
        g = target;
        this.fresh = false;
      }
      g = smooth * g + (1 - smooth) * target;
      if (g < least) least = g;
      l[i] = a * g;
      r[i] = b * g;
    }
    this.ef = ef;
    this.es = es;
    this.g = g;
    this.gr = gainToDb(least);
  }
  reset(): void {
    this.ef = 0;
    this.es = 0;
    this.g = 1;
    this.fresh = true;
  }
}

/**
 * Stereo width: the side scaled against the mid; a position that moves the image at constant power
 * (unity in the centre, a side up to +3 dB as it turns towards it); and the lows below a frequency
 * summed to mono (a 12 dB/octave low pass splits them off).
 */
export class StereoWidth implements Effect {
  gr = 0;
  private width = 1;
  private gl = 1;
  private gR = 1;
  private mono = false;
  private readonly low = new Biquad();
  private lowL = new Float32Array(128);
  private lowR = new Float32Array(128);
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('width', p, id);
    this.width = v('width') / 100;
    const pos = v('position') / 100;
    const a = ((pos + 1) * Math.PI) / 4;
    this.gl = pos === 0 ? 1 : Math.cos(a) * Math.SQRT2;
    this.gR = pos === 0 ? 1 : Math.sin(a) * Math.SQRT2;
    const mono = v('mono') >= 0.5;
    if (mono && !this.mono) this.low.reset();
    this.mono = mono;
    this.low.set('lowpass', v('monoFreq'), 0.7, 0, this.host.sr);
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const w = this.width;
    const { gl, gR } = this;
    if (w !== 1 || gl !== 1 || gR !== 1) {
      for (let i = 0; i < n; i++) {
        const a = l[i] as number;
        const b = r[i] as number;
        const mid = 0.5 * (a + b);
        const side = 0.5 * (a - b) * w;
        l[i] = (mid + side) * gl;
        r[i] = (mid - side) * gR;
      }
    }
    if (!this.mono) return;
    if (this.lowL.length < n) {
      this.lowL = new Float32Array(n);
      this.lowR = new Float32Array(n);
    }
    this.lowL.set(l.subarray(0, n));
    this.lowR.set(r.subarray(0, n));
    this.low.process(this.lowL, this.lowR, n);
    for (let i = 0; i < n; i++) {
      // each side loses its own lows and gets both sides' lows, averaged
      const d = 0.5 * ((this.lowL[i] as number) - (this.lowR[i] as number));
      l[i] = (l[i] as number) - d;
      r[i] = (r[i] as number) + d;
    }
  }
  reset(): void {
    this.low.reset();
  }
}

/**
 * Tape warmth: tanh saturation with a touch of even harmonics, normalised so a full-scale peak stays
 * at full scale (`tanh(drive · (x + even · x²)) / tanh(drive)`), mixed with the dry sound; the input
 * level sets where it bites (and is given back after); then a little low-mid body (a bell at 180 Hz)
 * and a rounded top (a shelf at 9.5 kHz). DC Block takes the offset the even harmonics lean the
 * saturated sound by out below 5 Hz; off, it is the game's saturation exactly (which takes out only
 * that constant, as any low cut after it does).
 */
export class TapeWarmth implements Effect {
  gr = 0;
  private drive = 1.5;
  private norm = 1;
  private even = 0.08;
  private mix = 1;
  private input = 1;
  private readonly body = new Biquad();
  private readonly top = new Biquad();
  private useBody = false;
  private useTop = false;
  private dcBlock = true;
  private dcR = 0.9993;
  /** The saturated sound's average over a whole loop, taken away (as a creation that centres it does). */
  private centreL = 0;
  private centreR = 0;
  private xl = 0;
  private yl = 0;
  private xr = 0;
  private yr = 0;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>, settings?: Record<string, string>): void {
    const v = (id: string) => paramValue('tape', p, id);
    const [cl = 0, cr = cl] = (settings?.centre ?? '').split(',').filter(Boolean).map(Number);
    this.centreL = Number.isFinite(cl) ? cl : 0;
    this.centreR = Number.isFinite(cr) ? cr : 0;
    const sr = this.host.sr;
    this.drive = v('drive');
    this.norm = 1 / Math.tanh(this.drive);
    this.even = v('even') / 100;
    this.mix = v('mix') / 100;
    this.input = dbToGain(v('input'));
    this.useBody = Math.abs(v('body')) > 1e-4;
    this.useTop = Math.abs(v('top')) > 1e-4;
    this.body.set('peak', 180, 0.8, v('body'), sr);
    this.top.set('highshelf', 9500, 0.7, v('top'), sr);
    this.dcBlock = v('dcBlock') >= 0.5;
    this.dcR = 1 - (2 * Math.PI * 5) / sr;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const { drive, norm, even, mix, input, dcBlock, centreL, centreR } = this;
    const dcR = dcBlock ? this.dcR : 0;
    const back = 1 / input;
    let { xl, yl, xr, yr } = this;
    for (let i = 0; i < n; i++) {
      const a = (l[i] as number) * input;
      const b = (r[i] as number) * input;
      const sa = Math.tanh(drive * (a + even * a * a)) * norm - centreL;
      const sb = Math.tanh(drive * (b + even * b * b)) * norm - centreR;
      // the DC blocker, on the saturated sound only (its even harmonics lean it off centre)
      if (dcBlock) {
        yl = sa - xl + dcR * yl;
        xl = sa;
        yr = sb - xr + dcR * yr;
        xr = sb;
      } else {
        yl = sa;
        yr = sb;
      }
      l[i] = ((1 - mix) * a + mix * yl) * back;
      r[i] = ((1 - mix) * b + mix * yr) * back;
    }
    this.xl = xl;
    this.yl = Math.abs(yl) < 1e-20 ? 0 : yl;
    this.xr = xr;
    this.yr = Math.abs(yr) < 1e-20 ? 0 : yr;
    if (this.useBody) this.body.process(l, r, n);
    if (this.useTop) this.top.process(l, r, n);
  }
  reset(): void {
    this.xl = this.yl = this.xr = this.yr = 0;
    this.body.reset();
    this.top.reset();
  }
}

/** A slow random wobble (std about 0.5): normal points cosine-joined, about 2.2 points per cycle of `rate`. */
class SmoothRandom {
  private step = 2;
  private pos = 0;
  private p0 = 0;
  private p1 = 0;
  private readonly r: Random;
  constructor(r: Random) {
    this.r = r;
    this.p0 = r.normal();
    this.p1 = r.normal();
  }
  setRate(rate: number, sr: number): void {
    this.step = Math.max(2, Math.floor(sr / (rate * 2.2)));
  }
  next(): number {
    const u = 0.5 - 0.5 * Math.cos((Math.PI * this.pos) / this.step);
    const x = (this.p0 * (1 - u) + this.p1 * u) * (0.5 / 0.8);
    if (++this.pos >= this.step) {
      this.pos = 0;
      this.p0 = this.p1;
      this.p1 = this.r.normal();
    }
    return x;
  }
}

const WOW_SIZE = 16384;
/** How long the delay's drift is remembered (it leaks back towards its centre over this time). */
const WOW_LEAK_S = 2;

/**
 * Wow and flutter: the sound read through a delay whose length drifts, so its pitch wavers by the
 * delay's rate of change. Wow is a slow random drift plus a sine; flutter a quicker sine plus a little
 * quick randomness. Both sides move together. Reads are four-point Lagrange, as the game's are.
 *
 * Or the drift is a curve in the song's files (settings.curve: a file whose every frame is the delay,
 * in seconds, at that frame of the song: its first channel, plus its second when it has one, a fine
 * part for precision), read where the playhead is: a creation's own drift, played exactly.
 */
export class WowFlutter implements Effect {
  gr = 0;
  private wow = 0.0007;
  private flutter = 0.0002;
  private wr = 0.55;
  private fr = 6.5;
  private seed = -1;
  private phi = 0;
  private wowPhase = 0;
  private flutterPhase = 0;
  private slowRand: SmoothRandom;
  private quickRand: SmoothRandom;
  private d = 0;
  private leak = 0;
  private bound = 0;
  private base = Number.NaN;
  private baseTarget = 16;
  private readonly bufL = new Float64Array(WOW_SIZE);
  private readonly bufR = new Float64Array(WOW_SIZE);
  private w = 0;
  private curveKey = '';
  /** The drift curve's channels: the delay in seconds is their sum (a coarse and a fine part, for precision). */
  private curve: Float32Array[] | null = null;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    const r = new Random('wow:0');
    this.slowRand = new SmoothRandom(r);
    this.quickRand = new SmoothRandom(r);
  }
  setParams(p: Record<string, number>, settings?: Record<string, string>): void {
    const v = (id: string) => paramValue('wow', p, id);
    const sr = this.host.sr;
    this.wow = v('wow') / 100;
    this.flutter = v('flutter') / 100;
    this.wr = v('wowRate');
    this.fr = v('flutterRate');
    const seed = Math.round(v('seed'));
    if (seed !== this.seed) {
      this.seed = seed;
      this.reseed();
    }
    this.slowRand.setRate((0.4 / 0.55) * this.wr, sr);
    this.quickRand.setRate((12 / 6.5) * this.fr, sr);
    this.leak = coef(WOW_LEAK_S, sr);
    // the drift's reach: the random wander (about wow · sr · √leak), the wow sine's and the flutter's swings
    const wander = this.wow * sr * Math.sqrt(WOW_LEAK_S) * 4;
    const swing = (0.6 * this.wow * sr) / (2 * Math.PI * this.wr) + (1.4 * this.flutter * sr) / (2 * Math.PI * this.fr);
    this.bound = Math.min(WOW_SIZE / 2 - 64, wander + swing);
    this.baseTarget = 16 + Math.ceil(this.bound);
    if (Number.isNaN(this.base)) this.base = this.baseTarget;
    const key = settings?.curve ? clipKey({ file: settings.curve, stretch: 1 }) : '';
    if (key !== this.curveKey) {
      this.curveKey = key;
      this.curve = null;
    }
  }
  private reseed(): void {
    const r = new Random(`wow:${this.seed}`);
    this.phi = r.uniform() * 6;
    this.slowRand = new SmoothRandom(r);
    this.quickRand = new SmoothRandom(r);
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    if (this.curveKey) {
      if (!this.curve) this.curve = this.host.clip(this.curveKey) ?? null;
      if (this.curve?.[0]) {
        this.followCurve(this.curve, l, r, n);
        return;
      }
    }
    const sr = this.host.sr;
    const mask = WOW_SIZE - 1;
    const { wow, flutter, leak, bound, bufL, bufR } = this;
    const wInc = this.wr / sr;
    const fInc = this.fr / sr;
    for (let i = 0; i < n; i++) {
      const dev =
        wow * (2 * this.slowRand.next() + 0.6 * Math.sin(2 * Math.PI * this.wowPhase)) +
        flutter * (Math.sin(2 * Math.PI * this.flutterPhase + this.phi) + 0.4 * this.quickRand.next());
      this.wowPhase += wInc;
      if (this.wowPhase >= 1) this.wowPhase -= 1;
      this.flutterPhase += fInc;
      if (this.flutterPhase >= 1) this.flutterPhase -= 1;
      this.d = Math.max(-bound, Math.min(bound, this.d * leak + dev));
      // a changed setting moves the centre slowly (at most 0.05% of pitch), so it never jumps
      if (this.base !== this.baseTarget) {
        const step = this.baseTarget - this.base;
        this.base += Math.abs(step) < 0.0005 ? step : Math.sign(step) * 0.0005;
      }
      bufL[this.w] = l[i] as number;
      bufR[this.w] = r[i] as number;
      this.read(l, r, i, Math.max(2, this.base + this.d), mask);
      this.w = (this.w + 1) & mask;
    }
  }
  /** The drift from the song's curve, at the playhead (held at its ends). */
  private followCurve(curve: Float32Array[], l: Float32Array, r: Float32Array, n: number): void {
    const sr = this.host.sr;
    const mask = WOW_SIZE - 1;
    const { bufL, bufR } = this;
    const at = this.host.songFrame();
    const coarse = curve[0] as Float32Array;
    const fine = curve[1] && curve[1] !== coarse ? curve[1] : null;
    const last = coarse.length - 1;
    for (let i = 0; i < n; i++) {
      bufL[this.w] = l[i] as number;
      bufR[this.w] = r[i] as number;
      const f = Math.min(last, Math.max(0, at + i));
      const seconds = (coarse[f] as number) + (fine ? (fine[f] as number) : 0);
      const delay = Math.min(WOW_SIZE - 4, Math.max(2, seconds * sr));
      this.read(l, r, i, delay, mask);
      this.w = (this.w + 1) & mask;
    }
  }

  /** Four-point Lagrange read `delay` frames back from the write head, into sample i. */
  private read(l: Float32Array, r: Float32Array, i: number, delay: number, mask: number): void {
    const { bufL, bufR } = this;
    const rp = this.w - delay;
    const ip = Math.floor(rp);
    const fr = rp - ip;
    const c0 = (-fr * (fr - 1) * (fr - 2)) / 6;
    const c1 = ((fr + 1) * (fr - 1) * (fr - 2)) / 2;
    const c2 = (-(fr + 1) * fr * (fr - 2)) / 2;
    const c3 = ((fr + 1) * fr * (fr - 1)) / 6;
    const i0 = (ip - 1) & mask;
    const i1 = ip & mask;
    const i2 = (ip + 1) & mask;
    const i3 = (ip + 2) & mask;
    l[i] =
      c0 * (bufL[i0] as number) + c1 * (bufL[i1] as number) + c2 * (bufL[i2] as number) + c3 * (bufL[i3] as number);
    r[i] =
      c0 * (bufR[i0] as number) + c1 * (bufR[i1] as number) + c2 * (bufR[i2] as number) + c3 * (bufR[i3] as number);
  }

  reset(): void {
    this.bufL.fill(0);
    this.bufR.fill(0);
    this.w = 0;
    this.d = 0;
    this.wowPhase = 0;
    this.flutterPhase = 0;
    this.base = this.baseTarget;
    this.reseed();
  }
}
