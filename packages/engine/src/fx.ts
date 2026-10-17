/**
 * The stock audio plugins. Each one reads its parameters from the shared plugin table (so the
 * ranges match the knobs on screen) and processes a stereo block in place.
 */
import { paramValue } from '@holo/session';
import { Softener, StereoWidth, TapeWarmth, WowFlutter } from './character.ts';
import type { PreparedImpulse } from './convolver.ts';
import { Biquad, DelayLine, dbToGain } from './dsp.ts';
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
    const specs: [Parameters<Biquad['set']>[0], number, number, number][] = [
      ['lowshelf', v('lsFreq'), Math.SQRT1_2, v('lsGain')],
      ['peak', v('b1Freq'), v('b1Q'), v('b1Gain')],
      ['peak', v('b2Freq'), v('b2Q'), v('b2Gain')],
      ['peak', v('b3Freq'), v('b3Q'), v('b3Gain')],
      ['highshelf', v('hsFreq'), Math.SQRT1_2, v('hsGain')],
    ];
    specs.forEach(([kind, freq, q, gain], i) => {
      this.bands[i]?.set(kind, freq, q, gain, sr);
      this.active[i] = Math.abs(gain) > 0.01;
    });
    this.out = dbToGain(v('output'));
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
  private dl = new DelayLine(1);
  private dr = new DelayLine(1);
  private need = new Float32Array(1);
  private dq = new Int32Array(1);
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
      this.dl = new DelayLine(look + 2);
      this.dr = new DelayLine(look + 2);
      this.need = new Float32Array(look + 1).fill(1);
      this.dq = new Int32Array(look + 2);
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
    const W = this.need.length;
    let minG = 1;
    for (let i = 0; i < n; i++) {
      const a = (l[i] as number) * this.input;
      const b = (r[i] as number) * this.input;
      const peak = Math.max(Math.abs(a), Math.abs(b));
      const req = peak > this.ceiling ? this.ceiling / peak : 1;
      // sliding minimum of the required gain over the look-ahead window (monotonic queue)
      const idx = this.counter++;
      this.need[idx % W] = req;
      const Q = this.dq.length;
      while (this.dqTail !== this.dqHead) {
        const last = this.dq[(this.dqTail - 1 + Q) % Q] as number;
        if ((this.need[last % W] as number) >= req && idx - last < W) this.dqTail = (this.dqTail - 1 + Q) % Q;
        else break;
      }
      this.dq[this.dqTail] = idx;
      this.dqTail = (this.dqTail + 1) % Q;
      while (idx - (this.dq[this.dqHead] as number) >= W) this.dqHead = (this.dqHead + 1) % Q;
      const target = this.need[(this.dq[this.dqHead] as number) % W] as number;
      this.gain =
        target < this.gain ? target + (this.gain - target) * this.att : target + (this.gain - target) * this.rel;
      if (this.gain < minG) minG = this.gain;
      this.dl.write(a);
      this.dr.write(b);
      const c = this.ceiling;
      const ya = this.dl.read(this.look) * this.gain;
      const yb = this.dr.read(this.look) * this.gain;
      l[i] = ya > c ? c : ya < -c ? -c : ya;
      r[i] = yb > c ? c : yb < -c ? -c : yb;
    }
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
  private lines: DelayLine[];
  private lengths = new Float64Array(8);
  private gains = new Float64Array(8);
  private lp = new Float64Array(8);
  private damp = 0;
  private pre: DelayLine;
  private preL = new DelayLine(1);
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
    this.lines = Reverb.BASE.map(() => new DelayLine(max));
    this.pre = new DelayLine(Math.ceil(host.sr * 0.26));
    this.preL = new DelayLine(Math.ceil(host.sr * 0.26));
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
    il.set(l.subarray(0, n));
    ir.set(r.subarray(0, n));
    this.inHp.process(il, ir, n);
    const x = this.x;
    const s = 1 / Math.sqrt(8);
    for (let i = 0; i < n; i++) {
      this.pre.write(il[i] as number);
      this.preL.write(ir[i] as number);
      const inL = this.pre.read(this.preSamples);
      const inR = this.preL.read(this.preSamples);
      this.lfo += 0.7 / this.host.sr;
      if (this.lfo > 1) this.lfo -= 1;
      const wob = Math.sin(this.lfo * 2 * Math.PI) * 6;
      for (let k = 0; k < 8; k++) {
        const d = (this.lengths[k] as number) + (k < 2 ? (k === 0 ? wob : -wob) : 0);
        let y = (this.lines[k] as DelayLine).read(d);
        // damping: a one-pole low-pass in each line's loop
        y = y * (1 - this.damp) + (this.lp[k] as number) * this.damp;
        this.lp[k] = y;
        x[k] = y * (this.gains[k] as number);
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
        (this.lines[k] as DelayLine).write((x[k] as number) * s + (k & 1 ? inR : inL) * 0.5);
      }
      const wl =
        ((this.lp[0] as number) + (this.lp[2] as number) + (this.lp[4] as number) + (this.lp[6] as number)) * 0.5;
      const wr =
        ((this.lp[1] as number) + (this.lp[3] as number) + (this.lp[5] as number) + (this.lp[7] as number)) * 0.5;
      const mid = (wl + wr) * 0.5;
      const side = (wl - wr) * 0.5 * this.width;
      l[i] = (l[i] as number) * (1 - this.mix) + (mid + side) * this.mix;
      r[i] = (r[i] as number) * (1 - this.mix) + (mid - side) * this.mix;
    }
  }
  reset(): void {
    for (const line of this.lines) line.clear();
    this.lp.fill(0);
  }
}

class Delay implements Effect {
  gr = 0;
  private dl: DelayLine;
  private dr: DelayLine;
  private p: Record<string, number> = {};
  private hpL = new Biquad();
  private lpL = new Biquad();
  private fb = new Float32Array(2);
  private scratch = new Float32Array(2);
  private scratch2 = new Float32Array(2);
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    this.dl = new DelayLine(Math.ceil(host.sr * 4.1));
    this.dr = new DelayLine(Math.ceil(host.sr * 4.1));
  }
  setParams(p: Record<string, number>): void {
    this.p = p;
    const v = (id: string) => paramValue('delay', p, id);
    this.hpL.set('highpass', v('lowcut'), Math.SQRT1_2, 0, this.host.sr);
    this.lpL.set('lowpass', v('highcut'), Math.SQRT1_2, 0, this.host.sr);
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const v = (id: string) => paramValue('delay', this.p, id);
    const sync = v('sync') >= 0.5;
    const seconds = sync
      ? (DIVISION_BEATS[Math.round(v('division'))] ?? 0.5) * this.host.beatSeconds()
      : v('time') / 1000;
    const d = Math.min(this.host.sr * 4, Math.max(1, seconds * this.host.sr));
    const feedback = v('feedback') / 100;
    const ping = v('pingpong') >= 0.5;
    const mix = v('mix') / 100;
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      const yl = this.dl.read(d);
      const yr = this.dr.read(d);
      // feedback, filtered each time round so repeats darken like tape
      this.scratch[0] = yl;
      this.scratch2[0] = yr;
      this.hpL.process(this.scratch, this.scratch2, 1);
      this.lpL.process(this.scratch, this.scratch2, 1);
      const fl = (this.scratch[0] as number) * feedback;
      const fr = (this.scratch2[0] as number) * feedback;
      if (ping) {
        this.dl.write((a + b) * 0.5 + fr);
        this.dr.write(fl);
      } else {
        this.dl.write(a + fl);
        this.dr.write(b + fr);
      }
      l[i] = a * (1 - mix * 0.5) + yl * mix;
      r[i] = b * (1 - mix * 0.5) + yr * mix;
    }
    this.fb[0] = 0;
  }
  reset(): void {
    this.dl.clear();
    this.dr.clear();
  }
}

class Chorus implements Effect {
  gr = 0;
  private dl: DelayLine;
  private dr: DelayLine;
  private phase = 0;
  private rate = 0.6;
  private depth = 0.4;
  private base = 12;
  private mix = 0.5;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    this.dl = new DelayLine(Math.ceil(host.sr * 0.06));
    this.dr = new DelayLine(Math.ceil(host.sr * 0.06));
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
    for (let i = 0; i < n; i++) {
      this.phase += this.rate / sr;
      if (this.phase >= 1) this.phase -= 1;
      const a = l[i] as number;
      const b = r[i] as number;
      this.dl.write(a);
      this.dr.write(b);
      const ml = this.dl.read(baseS + depthS * Math.sin(2 * Math.PI * this.phase));
      const mr = this.dr.read(baseS + depthS * Math.cos(2 * Math.PI * this.phase));
      l[i] = a * (1 - this.mix * 0.5) + ml * this.mix;
      r[i] = b * (1 - this.mix * 0.5) + mr * this.mix;
    }
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
    this.dry.set(l.subarray(0, n));
    this.dryR.set(r.subarray(0, n));
    // soft clipping, normalised so a quiet signal keeps its level
    const norm = 1 / Math.tanh(this.drive);
    for (let i = 0; i < n; i++) {
      l[i] = Math.tanh((l[i] as number) * this.drive) * Math.min(norm, 1 / this.drive + 0.5);
      r[i] = Math.tanh((r[i] as number) * this.drive) * Math.min(norm, 1 / this.drive + 0.5);
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
