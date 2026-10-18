/**
 * The stock audio plugins. Each one reads its parameters from the shared plugin table (so the
 * ranges match the knobs on screen) and processes a stereo block in place.
 */
import { paramValue } from '@holo/session';
import { Softener, StereoWidth, TapeWarmth, WowFlutter } from './character.ts';
import type { PreparedImpulse } from './convolver.ts';
import { Biquad, dbToGain } from './dsp.ts';
import { ParametricEq } from './peq.ts';
import { Shimmer } from './shimmer.ts';
import { SpaceDesigner } from './space.ts';

export interface Host {
  sr: number;
  /** A prepared impulse response by key (Space Designer's), once it has been handed over. */
  impulse(key: string): PreparedImpulse | undefined;
  /** Low Latency Mode: plugins that delay the sound (the limiter's look-ahead) don't, while it's on. */
  lowLatency: boolean;
  /** Seconds per quarter note at the playhead. */
  beatSeconds(): number;
  /** The song frame this block starts at (where the playhead stands, stopped). */
  songFrame(): number;
  /** The cycle, while it's on (song frames). */
  loopRange?(): { start: number; end: number } | null;
  /** Audio the song has loaded, by key (a clip's, or a plugin's data: a drift curve). */
  clip(key: string): Float32Array[] | undefined;
}

export interface Effect {
  setParams(params: Record<string, number>, settings?: Record<string, string>): void;
  /**
   * One parameter has moved (a lane): only what it changes is worked out again, to the same numbers
   * as setParams with the whole. Plugins without it take the whole.
   */
  setParam?(id: string, params: Record<string, number>, settings?: Record<string, string>): void;
  /** Something it was waiting for (an impulse response) may have arrived. */
  refresh?(): void;
  process(l: Float32Array, r: Float32Array, n: number): void;
  reset(): void;
  /** Gain reduction now, in dB (≤ 0), for meters. */
  gr: number;
  /** Frames the plugin delays its sound by (a look-ahead); the mixer delays every other path to match. */
  latency?: number;
}

const DIVISION_BEATS = [2, 1, 1.5, 0.5, 0.75, 1 / 3, 0.25];

/** `n` frames of one block into another (no view made on the way). */
function copy(dst: Float32Array, src: Float32Array, n: number): void {
  for (let i = 0; i < n; i++) dst[i] = src[i] as number;
}

/**
 * A delay line with fractional (linear) reads: dsp.ts's DelayLine with its wraps as compares, not
 * remainders. It keeps the length it is asked for and runs its write index over it as the DelayLine
 * does: a fractional read's fraction comes from that index less the delay, and would come out other
 * with a longer line, so the samples read are the same.
 */
class Ring {
  /** What a read holds in `out` after peek() (left here: a call that returns a double allocates when it isn't inlined). */
  out = 0;
  private readonly buf: Float32Array;
  private readonly len: number;
  private w = 0;
  constructor(size: number) {
    this.len = Math.max(4, size);
    this.buf = new Float32Array(this.len);
  }
  write(x: number): void {
    this.buf[this.w] = x;
    const w = this.w + 1;
    this.w = w === this.len ? 0 : w;
  }
  /** `d` samples ago (≥ 1), into `out`. */
  peek(d: number): void {
    const len = this.len;
    const pos = this.w - d;
    const i = Math.floor(pos);
    const f = pos - i;
    let ia = i;
    let ib = i + 1;
    if (i > -len && i < len - 1) {
      // a delay within the line: the wrap is one add
      if (ia < 0) ia += len;
      if (ib < 0) ib += len;
    } else {
      ia = ((i % len) + len) % len;
      ib = (((i + 1) % len) + len) % len;
    }
    const a = this.buf[ia] as number;
    const b = this.buf[ib] as number;
    this.out = a + (b - a) * f;
  }
  clear(): void {
    this.buf.fill(0);
  }
}

class Eq implements Effect {
  gr = 0;
  private hp = [new Biquad(), new Biquad()];
  private lp = [new Biquad(), new Biquad()];
  private bands = [new Biquad(), new Biquad(), new Biquad(), new Biquad(), new Biquad()];
  private active = [false, false, false, false, false];
  private hpOn = false;
  private lpOn = false;
  private out = 1;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('eq', p, id);
    const sr = this.host.sr;
    this.hpOn = v('hpOn') >= 0.5;
    this.lpOn = v('lpOn') >= 0.5;
    for (const f of this.hp) f.set('highpass', v('hpFreq'), Math.SQRT1_2, 0, sr);
    for (const f of this.lp) f.set('lowpass', v('lpFreq'), Math.SQRT1_2, 0, sr);
    this.band(0, 'lowshelf', v('lsFreq'), Math.SQRT1_2, v('lsGain'));
    this.band(1, 'peak', v('b1Freq'), v('b1Q'), v('b1Gain'));
    this.band(2, 'peak', v('b2Freq'), v('b2Q'), v('b2Gain'));
    this.band(3, 'peak', v('b3Freq'), v('b3Q'), v('b3Gain'));
    this.band(4, 'highshelf', v('hsFreq'), Math.SQRT1_2, v('hsGain'));
    this.out = dbToGain(v('output'));
  }
  /** One setting moved: the filter it belongs to, from the same values setParams would give it. */
  setParam(id: string, p: Record<string, number>): void {
    const v = (x: string) => paramValue('eq', p, x);
    const sr = this.host.sr;
    switch (id) {
      case 'hpOn':
        this.hpOn = v('hpOn') >= 0.5;
        break;
      case 'lpOn':
        this.lpOn = v('lpOn') >= 0.5;
        break;
      case 'hpFreq':
        for (const f of this.hp) f.set('highpass', v('hpFreq'), Math.SQRT1_2, 0, sr);
        break;
      case 'lpFreq':
        for (const f of this.lp) f.set('lowpass', v('lpFreq'), Math.SQRT1_2, 0, sr);
        break;
      case 'lsFreq':
      case 'lsGain':
        this.band(0, 'lowshelf', v('lsFreq'), Math.SQRT1_2, v('lsGain'));
        break;
      case 'b1Freq':
      case 'b1Q':
      case 'b1Gain':
        this.band(1, 'peak', v('b1Freq'), v('b1Q'), v('b1Gain'));
        break;
      case 'b2Freq':
      case 'b2Q':
      case 'b2Gain':
        this.band(2, 'peak', v('b2Freq'), v('b2Q'), v('b2Gain'));
        break;
      case 'b3Freq':
      case 'b3Q':
      case 'b3Gain':
        this.band(3, 'peak', v('b3Freq'), v('b3Q'), v('b3Gain'));
        break;
      case 'hsFreq':
      case 'hsGain':
        this.band(4, 'highshelf', v('hsFreq'), Math.SQRT1_2, v('hsGain'));
        break;
      case 'output':
        this.out = dbToGain(v('output'));
        break;
      default:
        this.setParams(p);
    }
  }
  private band(i: number, kind: Parameters<Biquad['set']>[0], freq: number, q: number, gain: number): void {
    this.bands[i]?.set(kind, freq, q, gain, this.host.sr);
    this.active[i] = Math.abs(gain) > 0.01;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    if (this.hpOn) for (const f of this.hp) f.process(l, r, n);
    for (let i = 0; i < 5; i++) if (this.active[i]) this.bands[i]?.process(l, r, n);
    if (this.lpOn) for (const f of this.lp) f.process(l, r, n);
    if (this.out !== 1) {
      for (let i = 0; i < n; i++) {
        l[i] = (l[i] as number) * this.out;
        r[i] = (r[i] as number) * this.out;
      }
    }
  }
  reset(): void {
    for (const f of [...this.hp, ...this.lp, ...this.bands]) f.reset();
  }
}

/**
 * A feed-forward compressor. Its detector follows the peak in decibels (Log), or follows the peak's
 * amplitude and reads it in decibels after (Linear: Hallowed Lanterns' compressor, which lets go of a
 * note's tail more gently).
 */
class Compressor implements Effect {
  gr = 0;
  private env = -120;
  private linear = false;
  private amp = 0;
  private threshold = -18;
  private ratio = 3;
  private knee = 6;
  private makeup = 1;
  private mix = 1;
  private att = 0;
  private rel = 0;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('compressor', p, id);
    const sr = this.host.sr;
    this.threshold = v('threshold');
    this.ratio = v('ratio');
    this.knee = v('knee');
    this.makeup = dbToGain(v('makeup'));
    this.mix = v('mix') / 100;
    this.att = Math.exp(-1 / ((v('attack') / 1000) * sr));
    this.rel = Math.exp(-1 / ((v('release') / 1000) * sr));
    this.linear = v('detector') >= 0.5;
  }
  private curve(x: number): number {
    const t = this.threshold;
    const k = this.knee;
    const slope = 1 / this.ratio - 1;
    if (k > 0 && x > t - k / 2 && x < t + k / 2) return (slope * (x - t + k / 2) ** 2) / (2 * k);
    return x >= t + k / 2 ? slope * (x - t) : 0;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    let maxGr = 0;
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      const peak = Math.max(Math.abs(a), Math.abs(b));
      if (this.linear) {
        const coef = peak > this.amp ? this.att : this.rel;
        this.amp = coef * this.amp + (1 - coef) * peak;
        this.env = 20 * Math.log10(this.amp + 1e-9);
      } else {
        const x = peak > 1e-6 ? 20 * Math.log10(peak) : -120;
        const coef = x > this.env ? this.att : this.rel;
        this.env = x + (this.env - x) * coef;
      }
      const gdb = this.curve(this.env);
      if (gdb < maxGr) maxGr = gdb;
      const g = 10 ** (gdb / 20) * this.makeup;
      const wet = this.mix;
      l[i] = a * (1 - wet) + a * g * wet;
      r[i] = b * (1 - wet) + b * g * wet;
    }
    this.gr = maxGr;
  }
  reset(): void {
    this.amp = 0;
    this.env = -120;
  }
}

class Gate implements Effect {
  gr = 0;
  private env = 0;
  private gain = 0;
  private hold = 0;
  private holdLeft = 0;
  private open = 0;
  private range = 0;
  private att = 0;
  private rel = 0;
  private follow = 0;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('gate', p, id);
    const sr = this.host.sr;
    this.open = dbToGain(v('threshold'));
    this.range = dbToGain(v('range'));
    this.att = 1 - Math.exp(-1 / ((v('attack') / 1000) * sr));
    this.rel = 1 - Math.exp(-1 / ((v('release') / 1000) * sr));
    this.hold = Math.round((v('hold') / 1000) * sr);
    this.follow = Math.exp(-1 / (0.002 * sr));
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      const x = Math.max(Math.abs(a), Math.abs(b));
      this.env = Math.max(x, this.env * this.follow);
      let target = this.range;
      if (this.env >= this.open) {
        this.holdLeft = this.hold;
        target = 1;
      } else if (this.holdLeft > 0) {
        this.holdLeft--;
        target = 1;
      }
      this.gain += (target - this.gain) * (target > this.gain ? this.att : this.rel);
      l[i] = a * this.gain;
      r[i] = b * this.gain;
    }
    this.gr = this.gain > 1e-6 ? 20 * Math.log10(this.gain) : -90;
  }
  reset(): void {
    this.env = this.gain = 0;
  }
}

/** Look-ahead limiter: the gain needed over the next few milliseconds, reached smoothly in time. */
class Limiter implements Effect {
  gr = 0;
  private ceiling = 0.89;
  private input = 1;
  private look = 0;
  private dl = new Ring(1);
  private dr = new Ring(1);
  /** The gain each of the last `look` + 1 frames asks for, and the frames whose gain still counts (a monotonic queue): rings with a mask each. */
  private need = new Float32Array(1);
  private needMask = 0;
  private dq = new Int32Array(1);
  private dqMask = 0;
  private dqHead = 0;
  private dqTail = 0;
  private counter = 0;
  private gain = 1;
  private rel = 0;
  private att = 0;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('limiter', p, id);
    const sr = this.host.sr;
    this.ceiling = dbToGain(v('ceiling'));
    this.input = dbToGain(v('gain'));
    const look = Math.max(1, Math.round((v('lookahead') / 1000) * sr));
    if (look !== this.look) {
      this.look = look;
      this.dl = new Ring(look + 2);
      this.dr = new Ring(look + 2);
      let size = 4;
      while (size < look + 2) size <<= 1;
      this.need = new Float32Array(size).fill(1);
      this.needMask = size - 1;
      this.dq = new Int32Array(size);
      this.dqMask = size - 1;
      this.dqHead = this.dqTail = 0;
      this.counter = 0;
    }
    this.rel = Math.exp(-1 / ((v('release') / 1000) * sr));
    this.att = Math.exp(-1 / (look / 3));
  }
  /** The look-ahead: the sound comes out this many frames late (none in Low Latency Mode). */
  get latency(): number {
    return this.host.lowLatency ? 0 : this.look - 1;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    if (this.host.lowLatency) {
      this.processNow(l, r, n);
      return;
    }
    // the window: this frame and the `look` before it
    const W = this.look + 1;
    const { need, needMask, dq, dqMask, dl, dr, input, att, rel, look } = this;
    const c = this.ceiling;
    let { dqHead, dqTail, gain } = this;
    let minG = 1;
    for (let i = 0; i < n; i++) {
      const a = (l[i] as number) * input;
      const b = (r[i] as number) * input;
      const peak = Math.max(Math.abs(a), Math.abs(b));
      const req = peak > c ? c / peak : 1;
      // sliding minimum of the required gain over the look-ahead window (monotonic queue)
      const idx = this.counter++;
      need[idx & needMask] = req;
      while (dqTail !== dqHead) {
        const last = dq[(dqTail - 1) & dqMask] as number;
        if ((need[last & needMask] as number) >= req && idx - last < W) dqTail = (dqTail - 1) & dqMask;
        else break;
      }
      dq[dqTail] = idx;
      dqTail = (dqTail + 1) & dqMask;
      while (idx - (dq[dqHead] as number) >= W) dqHead = (dqHead + 1) & dqMask;
      const target = need[(dq[dqHead] as number) & needMask] as number;
      gain = target < gain ? target + (gain - target) * att : target + (gain - target) * rel;
      if (gain < minG) minG = gain;
      dl.write(a);
      dr.write(b);
      dl.peek(look);
      dr.peek(look);
      const ya = dl.out * gain;
      const yb = dr.out * gain;
      l[i] = ya > c ? c : ya < -c ? -c : ya;
      r[i] = yb > c ? c : yb < -c ? -c : yb;
    }
    this.dqHead = dqHead;
    this.dqTail = dqTail;
    this.gain = gain;
    this.gr = 20 * Math.log10(Math.max(minG, 1e-6));
  }
  /** Low Latency Mode: no look-ahead, so nothing is delayed; the gain drops at once and recovers smoothly. */
  private processNow(l: Float32Array, r: Float32Array, n: number): void {
    let minG = 1;
    const c = this.ceiling;
    for (let i = 0; i < n; i++) {
      const a = (l[i] as number) * this.input;
      const b = (r[i] as number) * this.input;
      const peak = Math.max(Math.abs(a), Math.abs(b));
      const req = peak > c ? c / peak : 1;
      this.gain = req < this.gain ? req : req + (this.gain - req) * this.rel;
      if (this.gain < minG) minG = this.gain;
      const ya = a * this.gain;
      const yb = b * this.gain;
      l[i] = ya > c ? c : ya < -c ? -c : ya;
      r[i] = yb > c ? c : yb < -c ? -c : yb;
    }
    this.gr = 20 * Math.log10(Math.max(minG, 1e-6));
  }

  reset(): void {
    this.dl.clear();
    this.dr.clear();
    this.gain = 1;
  }
}

/** Eight delay lines mixed through a Hadamard matrix: a dense, smooth hall. */
class Reverb implements Effect {
  gr = 0;
  private static readonly BASE = [1031, 1327, 1523, 1811, 2053, 2371, 2633, 2963];
  private lines: Ring[];
  private lengths = new Float64Array(8);
  private gains = new Float64Array(8);
  private lp = new Float64Array(8);
  private damp = 0;
  private pre: Ring;
  private preL: Ring;
  private preSamples = 0;
  private inHp = new Biquad();
  private mix = 0.3;
  private width = 1;
  private scratchL = new Float32Array(256);
  private scratchR = new Float32Array(256);
  private x = new Float64Array(8);
  private lfo = 0;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    const max = Math.ceil(host.sr * 0.25);
    this.lines = Reverb.BASE.map(() => new Ring(max));
    this.pre = new Ring(Math.ceil(host.sr * 0.26));
    this.preL = new Ring(Math.ceil(host.sr * 0.26));
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('reverb', p, id);
    const sr = this.host.sr;
    const size = 0.35 + (v('size') / 100) * 1.4;
    const decay = v('decay');
    for (let i = 0; i < 8; i++) {
      const len = ((Reverb.BASE[i] as number) * size * sr) / 44100;
      this.lengths[i] = len;
      this.gains[i] = 10 ** ((-3 * len) / (sr * decay));
    }
    this.damp = Math.exp((-2 * Math.PI * v('damping')) / sr);
    this.preSamples = Math.max(1, Math.round((v('predelay') / 1000) * sr));
    this.inHp.set('highpass', v('lowcut'), Math.SQRT1_2, 0, sr);
    this.mix = v('mix') / 100;
    this.width = v('width') / 100;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    if (this.scratchL.length < n) {
      this.scratchL = new Float32Array(n);
      this.scratchR = new Float32Array(n);
    }
    const il = this.scratchL;
    const ir = this.scratchR;
    copy(il, l, n);
    copy(ir, r, n);
    this.inHp.process(il, ir, n);
    const { x, lines, lengths, gains, lp, damp, pre, preL, preSamples, mix, width } = this;
    const sr = this.host.sr;
    let lfo = this.lfo;
    const s = 1 / Math.sqrt(8);
    for (let i = 0; i < n; i++) {
      pre.write(il[i] as number);
      preL.write(ir[i] as number);
      pre.peek(preSamples);
      preL.peek(preSamples);
      const inL = pre.out;
      const inR = preL.out;
      lfo += 0.7 / sr;
      if (lfo > 1) lfo -= 1;
      const wob = Math.sin(lfo * 2 * Math.PI) * 6;
      for (let k = 0; k < 8; k++) {
        const d = (lengths[k] as number) + (k < 2 ? (k === 0 ? wob : -wob) : 0);
        const line = lines[k] as Ring;
        line.peek(d);
        let y = line.out;
        // damping: a one-pole low-pass in each line's loop
        y = y * (1 - damp) + (lp[k] as number) * damp;
        lp[k] = y;
        x[k] = y * (gains[k] as number);
      }
      // Hadamard 8×8, in place
      for (let h = 1; h < 8; h <<= 1) {
        for (let a = 0; a < 8; a += h << 1) {
          for (let b = a; b < a + h; b++) {
            const u = x[b] as number;
            const w = x[b + h] as number;
            x[b] = u + w;
            x[b + h] = u - w;
          }
        }
      }
      for (let k = 0; k < 8; k++) {
        (lines[k] as Ring).write((x[k] as number) * s + (k & 1 ? inR : inL) * 0.5);
      }
      const wl = ((lp[0] as number) + (lp[2] as number) + (lp[4] as number) + (lp[6] as number)) * 0.5;
      const wr = ((lp[1] as number) + (lp[3] as number) + (lp[5] as number) + (lp[7] as number)) * 0.5;
      const mid = (wl + wr) * 0.5;
      const side = (wl - wr) * 0.5 * width;
      l[i] = (l[i] as number) * (1 - mix) + (mid + side) * mix;
      r[i] = (r[i] as number) * (1 - mix) + (mid - side) * mix;
    }
    this.lfo = lfo;
  }
  reset(): void {
    for (const line of this.lines) line.clear();
    this.lp.fill(0);
  }
}

class Delay implements Effect {
  gr = 0;
  private dl: Ring;
  private dr: Ring;
  private sync = false;
  private division = 0.5;
  private time = 0.375;
  private feedback = 0.35;
  private ping = false;
  private mix = 0.3;
  /** The feedback's filters: the coefficients, with their state kept here (they run a sample at a time). */
  private hpL = new Biquad();
  private lpL = new Biquad();
  private readonly z = new Float64Array(8);
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    this.dl = new Ring(Math.ceil(host.sr * 4.1));
    this.dr = new Ring(Math.ceil(host.sr * 4.1));
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('delay', p, id);
    this.hpL.set('highpass', v('lowcut'), Math.SQRT1_2, 0, this.host.sr);
    this.lpL.set('lowpass', v('highcut'), Math.SQRT1_2, 0, this.host.sr);
    this.sync = v('sync') >= 0.5;
    this.division = DIVISION_BEATS[Math.round(v('division'))] ?? 0.5;
    this.time = v('time') / 1000;
    this.feedback = v('feedback') / 100;
    this.ping = v('pingpong') >= 0.5;
    this.mix = v('mix') / 100;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const sr = this.host.sr;
    const seconds = this.sync ? this.division * this.host.beatSeconds() : this.time;
    const d = Math.min(sr * 4, Math.max(1, seconds * sr));
    const { dl, dr, feedback, ping, mix, z } = this;
    const { b0: hb0, b1: hb1, b2: hb2, a1: ha1, a2: ha2 } = this.hpL;
    const { b0: lb0, b1: lb1, b2: lb2, a1: la1, a2: la2 } = this.lpL;
    let h1l = z[0] as number;
    let h2l = z[1] as number;
    let h1r = z[2] as number;
    let h2r = z[3] as number;
    let p1l = z[4] as number;
    let p2l = z[5] as number;
    let p1r = z[6] as number;
    let p2r = z[7] as number;
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      dl.peek(d);
      dr.peek(d);
      const yl = dl.out;
      const yr = dr.out;
      // feedback, filtered each time round so repeats darken like tape: the two biquads (transposed
      // direct form II) each on one frame, as a filter takes a block of one, through single precision
      // between them, their state flushed of denormals after each frame
      let xl = Math.fround(yl);
      let xr = Math.fround(yr);
      let ol = hb0 * xl + h1l;
      h1l = hb1 * xl - ha1 * ol + h2l;
      h2l = hb2 * xl - ha2 * ol;
      let or = hb0 * xr + h1r;
      h1r = hb1 * xr - ha1 * or + h2r;
      h2r = hb2 * xr - ha2 * or;
      if (Math.abs(h1l) < 1e-20) h1l = 0;
      if (Math.abs(h2l) < 1e-20) h2l = 0;
      if (Math.abs(h1r) < 1e-20) h1r = 0;
      if (Math.abs(h2r) < 1e-20) h2r = 0;
      xl = Math.fround(ol);
      xr = Math.fround(or);
      ol = lb0 * xl + p1l;
      p1l = lb1 * xl - la1 * ol + p2l;
      p2l = lb2 * xl - la2 * ol;
      or = lb0 * xr + p1r;
      p1r = lb1 * xr - la1 * or + p2r;
      p2r = lb2 * xr - la2 * or;
      if (Math.abs(p1l) < 1e-20) p1l = 0;
      if (Math.abs(p2l) < 1e-20) p2l = 0;
      if (Math.abs(p1r) < 1e-20) p1r = 0;
      if (Math.abs(p2r) < 1e-20) p2r = 0;
      const fl = Math.fround(ol) * feedback;
      const fr = Math.fround(or) * feedback;
      if (ping) {
        dl.write((a + b) * 0.5 + fr);
        dr.write(fl);
      } else {
        dl.write(a + fl);
        dr.write(b + fr);
      }
      l[i] = a * (1 - mix * 0.5) + yl * mix;
      r[i] = b * (1 - mix * 0.5) + yr * mix;
    }
    z[0] = h1l;
    z[1] = h2l;
    z[2] = h1r;
    z[3] = h2r;
    z[4] = p1l;
    z[5] = p2l;
    z[6] = p1r;
    z[7] = p2r;
  }
  reset(): void {
    this.dl.clear();
    this.dr.clear();
  }
}

class Chorus implements Effect {
  gr = 0;
  private dl: Ring;
  private dr: Ring;
  private phase = 0;
  private rate = 0.6;
  private depth = 0.4;
  private base = 12;
  private mix = 0.5;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    this.dl = new Ring(Math.ceil(host.sr * 0.06));
    this.dr = new Ring(Math.ceil(host.sr * 0.06));
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('chorus', p, id);
    this.rate = v('rate');
    this.depth = v('depth') / 100;
    this.base = v('delay');
    this.mix = v('mix') / 100;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const sr = this.host.sr;
    const baseS = (this.base / 1000) * sr;
    const depthS = baseS * 0.5 * this.depth;
    const { dl, dr, rate, mix } = this;
    let phase = this.phase;
    for (let i = 0; i < n; i++) {
      phase += rate / sr;
      if (phase >= 1) phase -= 1;
      const a = l[i] as number;
      const b = r[i] as number;
      dl.write(a);
      dr.write(b);
      dl.peek(baseS + depthS * Math.sin(2 * Math.PI * phase));
      dr.peek(baseS + depthS * Math.cos(2 * Math.PI * phase));
      const ml = dl.out;
      const mr = dr.out;
      l[i] = a * (1 - mix * 0.5) + ml * mix;
      r[i] = b * (1 - mix * 0.5) + mr * mix;
    }
    this.phase = phase;
  }
  reset(): void {
    this.dl.clear();
    this.dr.clear();
  }
}

class Saturator implements Effect {
  gr = 0;
  private drive = 2;
  private out = 1;
  private mix = 1;
  private tone = new Biquad();
  private dry = new Float32Array(256);
  private dryR = new Float32Array(256);
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('saturator', p, id);
    this.drive = dbToGain(v('drive'));
    this.out = dbToGain(v('output'));
    this.mix = v('mix') / 100;
    this.tone.set('lowpass', v('tone'), Math.SQRT1_2, 0, this.host.sr);
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    if (this.dry.length < n) {
      this.dry = new Float32Array(n);
      this.dryR = new Float32Array(n);
    }
    copy(this.dry, l, n);
    copy(this.dryR, r, n);
    // soft clipping, normalised so a quiet signal keeps its level
    const drive = this.drive;
    const norm = 1 / Math.tanh(drive);
    const level = Math.min(norm, 1 / drive + 0.5);
    for (let i = 0; i < n; i++) {
      l[i] = Math.tanh((l[i] as number) * drive) * level;
      r[i] = Math.tanh((r[i] as number) * drive) * level;
    }
    this.tone.process(l, r, n);
    for (let i = 0; i < n; i++) {
      l[i] = ((l[i] as number) * this.mix + (this.dry[i] as number) * (1 - this.mix)) * this.out;
      r[i] = ((r[i] as number) * this.mix + (this.dryR[i] as number) * (1 - this.mix)) * this.out;
    }
  }
  reset(): void {
    this.tone.reset();
  }
}

export function createEffect(type: string, host: Host): Effect | null {
  switch (type) {
    case 'eq':
      return new Eq(host);
    case 'compressor':
      return new Compressor(host);
    case 'gate':
      return new Gate(host);
    case 'limiter':
      return new Limiter(host);
    case 'reverb':
      return new Reverb(host);
    case 'delay':
      return new Delay(host);
    case 'chorus':
      return new Chorus(host);
    case 'saturator':
      return new Saturator(host);
    case 'space':
      return new SpaceDesigner(host);
    case 'peq':
      return new ParametricEq(host);
    case 'softener':
      return new Softener(host);
    case 'width':
      return new StereoWidth(host);
    case 'tape':
      return new TapeWarmth(host);
    case 'wow':
      return new WowFlutter(host);
    case 'shimmer':
      return new Shimmer(host);
    default:
      return null;
  }
}
