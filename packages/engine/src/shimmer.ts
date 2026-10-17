/**
 * Shimmer: a space (convolution, as Space Designer's), whose sound is sent an octave up into another
 * of its kind, and that one's into the next, a generation at a time, each darker and quieter. The
 * game's shimmer (hlaudio.effects.shimmer) as it plays: its granular octave (Hann grains of 4096
 * samples read at double speed, three-quarters overlapped, a little longer on the right for width)
 * behind its zero-phase 7 kHz low pass, its generations' filters and feedback.
 *
 * An octave made of grains read at double speed reads ahead of itself: each one is ready a grain
 * (and the low pass's half) after the sound it came from. With Look-ahead on, the plugin holds its
 * space and every generation back so each octave sounds with the sound it came from, as a shimmer
 * rendered whole does; the mix waits for it (plugin delay compensation). Off, nothing waits, and
 * each generation comes that much later.
 */
import { paramValue } from '@holo/session';
import { BLOCK, Convolver, type PreparedImpulse } from './convolver.ts';
import { Biquad, dbToGain } from './dsp.ts';
import type { Effect } from './fx.ts';
import { pluginImpulses, type SpaceHost } from './space.ts';

/** A fourth-order Butterworth low pass's two sections (the same poles scipy's butter(4) puts there). */
const BUTTER4_Q = [0.541196100146197, 1.3065629648763766];
const GRAIN_L = 4096;
const GRAIN_R = 4096 + 256;
const MAX_GENERATIONS = 4;

/**
 * The Butterworth run forwards and then backwards (zero phase), as one symmetric kernel: its impulse
 * response's autocorrelation, kept while it matters (to a millionth of a millionth).
 */
function zeroPhaseKernel(freq: number, sr: number): Float64Array {
  const sections = BUTTER4_Q.map((q) => {
    const f = new Biquad();
    f.set('lowpass', freq, q, 0, sr);
    return f;
  });
  const len = 4096;
  const h = new Float64Array(len);
  for (let i = 0; i < len; i++) {
    let v = i === 0 ? 1 : 0;
    for (const f of sections) v = f.tick(v);
    h[i] = v;
  }
  const r = new Float64Array(513);
  for (let k = 0; k < r.length; k++) {
    let acc = 0;
    for (let i = 0; i + k < len; i++) acc += (h[i] as number) * (h[i + k] as number);
    r[k] = acc;
  }
  let K = r.length - 1;
  while (K > 0 && Math.abs(r[K] as number) < 1e-12 * (r[0] as number)) K--;
  return r.slice(0, K + 1);
}

/** The low pass's two sections, transposed direct form II, with their state in hand. */
class Cascade {
  private readonly c: Float64Array;
  private readonly z = new Float64Array(4);
  constructor(freq: number, sr: number) {
    this.c = new Float64Array(10);
    BUTTER4_Q.forEach((q, s) => {
      const f = new Biquad();
      f.set('lowpass', freq, q, 0, sr);
      this.c.set([f.b0, f.b1, f.b2, f.a1, f.a2], s * 5);
    });
  }
  tick(x: number): number {
    const { c, z } = this;
    for (let s = 0; s < 2; s++) {
      const o = s * 5;
      const y = (c[o] as number) * x + (z[2 * s] as number);
      z[2 * s] = (c[o + 1] as number) * x - (c[o + 3] as number) * y + (z[2 * s + 1] as number);
      z[2 * s + 1] = (c[o + 2] as number) * x - (c[o + 4] as number) * y;
      x = y;
    }
    return x;
  }
  /** As if it had heard `v` for ever (scipy's sosfilt_zi, scaled by v): each section passes v whole. */
  settle(v: number): void {
    const { c, z } = this;
    for (let s = 0; s < 2; s++) {
      const o = s * 5;
      z[2 * s + 1] = ((c[o + 2] as number) - (c[o + 4] as number)) * v;
      z[2 * s] = ((c[o + 1] as number) - (c[o + 3] as number)) * v + (z[2 * s + 1] as number);
    }
  }
  clear(): void {
    this.z.fill(0);
  }
  copy(from: Cascade): void {
    this.z.set(from.z);
  }
}

/** scipy's sosfiltfilt pads each end of what it filters with this many frames (3 × (2 × sections + 1)). */
const PAD = 15;

/**
 * Octave up, one channel: the zero-phase low pass, then grains of `size` read at double speed,
 * overlapped by three-quarters; out `latency` frames after the game's (which reads ahead), with
 * `extra` more so both sides come out together.
 */
class OctaveUp {
  readonly latency: number;
  private readonly size: number;
  private readonly hop: number;
  private readonly win: Float64Array;
  private readonly kernel: Float64Array;
  private readonly raw: Float64Array;
  private readonly buf: Float64Array;
  /** Where each filtered frame falls in the loop (−1 when there's none), for the grains to count from. */
  private readonly pos: Float64Array;
  private readonly mask: number;
  private readonly rawMask: number;
  private readonly extra: number;
  /** Where the grains' grid starts: a generation's input is already that late, so its grains line up as the game's. */
  private readonly start: number;
  private t = 0;
  /**
   * In a loop, the game low-passes each turn on its own (scipy's sosfiltfilt over the turn: its ends
   * padded, each pass started as if what it first meets had sounded for ever), so a turn's first and
   * last frames come out a little otherwise than the sound running on would have them. These follow
   * the turn's sound forwards (as the game's forward pass meets it), and hold what the kernel's value
   * at a turn's ends becomes: added to it at the start, in place of it at the end.
   */
  private readonly fwd: Cascade;
  private readonly side: Cascade;
  private readonly back: Cascade;
  private readonly fwdOut: Float64Array;
  private readonly rhoIn: Float64Array;
  private readonly fixKind: Uint8Array;
  private readonly fixVal: Float64Array;
  private readonly delta: Float64Array;
  constructor(size: number, kernel: Float64Array, extra: number, start: number, freq: number, sr: number) {
    this.start = start;
    this.t = start;
    this.size = size;
    this.hop = size / 4;
    this.kernel = kernel;
    this.extra = extra;
    this.latency = size + (kernel.length - 1) + extra;
    this.win = new Float64Array(size);
    for (let j = 0; j < size; j++) this.win[j] = 0.5 - 0.5 * Math.cos((2 * Math.PI * j) / (size - 1));
    let len = 1;
    while (len < 2 * size + extra + 4) len <<= 1;
    this.buf = new Float64Array(len);
    this.pos = new Float64Array(len).fill(-1);
    this.mask = len - 1;
    let rawLen = 1;
    while (rawLen < 2 * kernel.length + 2) rawLen <<= 1;
    this.raw = new Float64Array(rawLen);
    this.rawMask = rawLen - 1;
    this.fwd = new Cascade(freq, sr);
    this.side = new Cascade(freq, sr);
    this.back = new Cascade(freq, sr);
    this.fwdOut = new Float64Array(rawLen);
    this.rhoIn = new Float64Array(rawLen).fill(-1);
    this.fixKind = new Uint8Array(rawLen);
    this.fixVal = new Float64Array(rawLen);
    this.delta = new Float64Array(kernel.length);
  }

  /** Whether frames t−count…t are a turn's frames in order, ending at loop position `last`. */
  private inOrder(t: number, count: number, last: number): boolean {
    for (let m = 0; m <= count; m++) if (this.rhoIn[(t - m) & this.rawMask] !== last - m) return false;
    return true;
  }

  /**
   * A turn's first frames, once the kernel's reach of them is in (frame t is the turn's K-th): the game's
   * forward pass from its padded start, less the running one, run backwards, is what its start adds.
   */
  private turnStart(t: number, K: number): void {
    const { raw, rawMask, side, back, delta, fwdOut } = this;
    const base = t - K;
    const x = (m: number) => raw[(base + m) & rawMask] as number;
    const x0 = x(0);
    side.settle(2 * x0 - x(PAD));
    for (let k = PAD; k >= 1; k--) side.tick(2 * x0 - x(k));
    for (let m = 0; m <= K; m++) delta[m] = side.tick(x(m)) - (fwdOut[(base + m) & rawMask] as number);
    back.clear();
    for (let m = K; m >= 0; m--) {
      const u = (base + m) & rawMask;
      this.fixKind[u] = 1;
      this.fixVal[u] = back.tick(delta[m] as number);
    }
  }

  /**
   * A turn's last frames, once its last is in (frame t): the game's forward pass on through the padded
   * end, then its backward pass from there (started as if the end had sounded for ever), in place of
   * the kernel's.
   */
  private turnEnd(t: number, K: number): void {
    const { raw, rawMask, fwd, side, back, delta, fwdOut } = this;
    const xl = raw[t & rawMask] as number;
    side.copy(fwd);
    for (let k = 1; k <= PAD; k++) delta[k] = side.tick(2 * xl - (raw[(t - k) & rawMask] as number));
    back.settle(delta[PAD] as number);
    for (let k = PAD; k >= 1; k--) back.tick(delta[k] as number);
    for (let m = 0; m <= K; m++) {
      const u = (t - m) & rawMask;
      this.fixKind[u] = 2;
      this.fixVal[u] = back.tick(fwdOut[u] as number);
    }
  }
  /**
   * `rho`, when there's a loop of `turn` frames: where each input frame falls in it. The grains then
   * start where the game's do, every `hop` from the loop's start, and those still sounding at its end
   * go on into its next turn.
   */
  process(x: Float32Array, y: Float32Array, n: number, rho: Float64Array | null = null, turn = 0): void {
    const { size, hop, win, buf, mask, raw, rawMask, kernel, pos } = this;
    const K = kernel.length - 1;
    const last = turn > 0 ? Math.floor(turn / hop) : 0;
    const edges = turn > 4 * (K + PAD);
    for (let i = 0; i < n; i++) {
      const t = this.t;
      raw[t & rawMask] = x[i] as number;
      // where this input frame falls in the loop; it reaches the grains K frames later, with the filter
      const r0 = rho ? (rho[i] as number) : -1;
      pos[(t + K) & mask] = r0;
      if (edges) {
        this.rhoIn[t & rawMask] = r0;
        this.fwdOut[t & rawMask] = this.fwd.tick(x[i] as number);
        if (r0 === K && this.inOrder(t, K, K)) this.turnStart(t, K);
        else if (r0 === turn - 1 && this.inOrder(t, K + PAD, turn - 1)) this.turnEnd(t, K);
      }
      // the low pass, centred K frames back: the filtered sound at u = t − K
      let v = (kernel[0] as number) * (raw[(t - K) & rawMask] as number);
      for (let k = 1; k <= K; k++) {
        v += (kernel[k] as number) * ((raw[(t - K - k) & rawMask] as number) + (raw[(t - K + k) & rawMask] as number));
      }
      const u = t - K;
      const fix = this.fixKind[u & rawMask];
      if (fix) {
        v = fix === 2 ? (this.fixVal[u & rawMask] as number) : v + (this.fixVal[u & rawMask] as number);
        this.fixKind[u & rawMask] = 0;
      }
      buf[u & mask] = v;
      // the output for frame `tau`, its grains reading ahead of it
      const tau = u - this.extra - size;
      let acc = 0;
      const r = turn > 0 ? (pos[(tau + K) & mask] as number) : -1;
      if (r >= 0) {
        // this turn's grains under it, and the last turn's that run on past the loop's end
        const kLo = Math.max(0, Math.ceil((r - size + 1) / hop));
        const kHi = Math.min(last, Math.floor(r / hop));
        for (let k = kLo; k <= kHi; k++) {
          const j = r - k * hop;
          acc += (win[j] as number) * (buf[(tau + j) & mask] as number);
        }
        const wLo = Math.max(0, Math.floor((r + turn - size) / hop) + 1);
        for (let k = wLo; k <= last; k++) {
          const j = r + turn - k * hop;
          if (j < size) acc += (win[j] as number) * (buf[(tau + j) & mask] as number);
        }
      } else if (tau >= 0) {
        // no loop: a grain every hop from the start, each one `size` long
        const kHi = Math.floor(tau / hop);
        const kLo = Math.max(0, Math.floor((tau - size) / hop) + 1);
        for (let k = kLo; k <= kHi; k++) {
          const j = tau - k * hop;
          acc += (win[j] as number) * (buf[(k * hop + 2 * j) & mask] as number);
        }
      }
      y[i] = acc * (2 / 3); // Hann at 75% overlap sums to 1.5
      this.t = t + 1;
    }
  }
  reset(): void {
    this.buf.fill(0);
    this.raw.fill(0);
    this.pos.fill(-1);
    this.fwd.clear();
    this.rhoIn.fill(-1);
    this.fixKind.fill(0);
    this.t = this.start;
  }
}

export class Shimmer implements Effect {
  gr = 0;
  private readonly host: SpaceHost & {
    lowLatency?: boolean;
    songFrame?(): number;
    loopRange?(): { start: number; end: number } | null;
  };
  private readonly rho = new Float64Array(BLOCK);
  private readonly rhoGen = new Float64Array(BLOCK);
  private keys: string[] = [];
  private convs: (Convolver | null)[] = [];
  private generations = 2;
  private feedback = 0.45;
  private cross = 0.55;
  private wet = 1;
  private dry = 0;
  private lookahead = false;
  private useLow = false;
  private readonly lowcut = new Biquad();
  private readonly octL: OctaveUp[] = [];
  private readonly octR: OctaveUp[] = [];
  private readonly genLp: Biquad[] = [];
  private readonly genHp: Biquad[] = [];
  /** One generation's delay: the right side's grain and the low pass's half. */
  private readonly stage: number;
  private readonly inL = new Float32Array(BLOCK);
  private readonly inR = new Float32Array(BLOCK);
  private readonly curL = new Float32Array(BLOCK);
  private readonly curR = new Float32Array(BLOCK);
  private readonly upL = new Float32Array(BLOCK);
  private readonly upR = new Float32Array(BLOCK);
  private readonly totL = new Float32Array(BLOCK);
  private readonly totR = new Float32Array(BLOCK);
  /** With look-ahead: what each generation adds, laid down as far ahead as it is early. */
  private readonly accL: Float64Array;
  private readonly accR: Float64Array;
  private readonly accMask: number;
  private accPos = 0;
  private aligned = false;

  constructor(
    host: SpaceHost & {
      lowLatency?: boolean;
      songFrame?(): number;
      loopRange?(): { start: number; end: number } | null;
    },
  ) {
    this.host = host;
    const kernel = zeroPhaseKernel(7000, host.sr);
    this.stage = GRAIN_R + kernel.length - 1;
    for (let g = 0; g < MAX_GENERATIONS; g++) {
      this.octL.push(new OctaveUp(GRAIN_L, kernel, GRAIN_R - GRAIN_L, -g * this.stage, 7000, host.sr));
      this.octR.push(new OctaveUp(GRAIN_R, kernel, 0, -g * this.stage, 7000, host.sr));
      const lp = new Biquad();
      lp.set('lowpass', 6500 - 1200 * g, 0.7, 0, host.sr);
      const hp = new Biquad();
      hp.set('highpass', 300, 0.7, 0, host.sr);
      this.genLp.push(lp);
      this.genHp.push(hp);
    }
    let size = 1;
    while (size < MAX_GENERATIONS * this.stage + 2 * BLOCK) size <<= 1;
    this.accL = new Float64Array(size);
    this.accR = new Float64Array(size);
    this.accMask = size - 1;
  }

  /** With look-ahead, the space and every generation wait for the last generation. */
  get latency(): number {
    return this.lookahead && !this.host.lowLatency ? this.generations * this.stage : 0;
  }

  setParams(p: Record<string, number>, settings?: Record<string, string>): void {
    const v = (id: string) => paramValue('shimmer', p, id);
    const keys = pluginImpulses('shimmer', p, settings, this.host.sr).map((x) => x.key);
    if (keys.join('|') !== this.keys.join('|')) {
      // generations that keep their space keep ringing
      this.convs = keys.map((k, i) => (this.keys[i] === k ? (this.convs[i] ?? null) : null));
      this.keys = keys;
      this.refresh();
    }
    this.generations = Math.round(v('generations'));
    this.feedback = v('feedback') / 100;
    this.cross = v('cross') / 100;
    this.wet = dbToGain(v('wet'));
    this.dry = v('dry') <= -60 ? 0 : dbToGain(v('dry'));
    this.lookahead = v('lookahead') >= 0.5;
    this.useLow = v('lowcut') > 20.5;
    if (this.useLow) this.lowcut.set('highpass', v('lowcut'), Math.SQRT1_2, 0, this.host.sr);
  }

  /** Responses that have arrived since: pick them up. */
  refresh(): void {
    this.keys.forEach((key, i) => {
      if (this.convs[i]) return;
      const prepared: PreparedImpulse | undefined = this.host.impulse(key);
      if (prepared) this.convs[i] = new Convolver(prepared);
    });
  }

  /** Adds a block `ahead` frames into the future of the look-ahead buffer. */
  private lay(l: Float32Array, r: Float32Array, gain: number, ahead: number): void {
    const { accL, accR, accMask } = this;
    const at = this.accPos + ahead;
    for (let i = 0; i < BLOCK; i++) {
      const w = (at + i) & accMask;
      accL[w] = (accL[w] as number) + (l[i] as number) * gain;
      accR[w] = (accR[w] as number) + (r[i] as number) * gain;
    }
  }

  process(l: Float32Array, r: Float32Array, n: number): void {
    if (this.convs.some((c) => !c)) this.refresh();
    const aligned = this.latency > 0;
    if (aligned !== this.aligned) {
      this.aligned = aligned;
      this.accL.fill(0);
      this.accR.fill(0);
    }
    for (let i = 0; i < BLOCK; i++) {
      this.inL[i] = i < n ? (l[i] as number) : 0;
      this.inR[i] = i < n ? (r[i] as number) : 0;
    }
    const first = this.convs[0];
    const gens = first ? Math.min(this.generations, this.convs.length - 1) : 0;
    const wait = aligned ? this.latency : 0;
    // in a loop, where each frame falls in it (the game's grains count from its start)
    const loop = this.host.loopRange?.() ?? null;
    const turn = loop ? loop.end - loop.start : 0;
    const at = loop ? (this.host.songFrame?.() ?? -1) - (loop?.start ?? 0) : -1;
    const looped = loop !== null && at >= 0 && at < turn;
    if (looped) for (let i = 0; i < BLOCK; i++) this.rho[i] = (at + i) % turn;
    if (first) {
      first.process(this.inL, this.inR, this.curL, this.curR, this.cross);
      if (aligned) this.lay(this.curL, this.curR, 1, wait);
      else {
        this.totL.set(this.curL);
        this.totR.set(this.curR);
      }
      for (let g = 0; g < gens; g++) {
        const conv = this.convs[g + 1];
        const octL = this.octL[g];
        const octR = this.octR[g];
        if (!conv || !octL || !octR) break;
        let rho: Float64Array | null = null;
        if (looped) {
          // generation g's input is g stages late: it falls that much earlier in the loop
          const back = g * this.stage;
          for (let i = 0; i < BLOCK; i++) this.rhoGen[i] = ((((this.rho[i] as number) - back) % turn) + turn) % turn;
          rho = this.rhoGen;
        }
        octL.process(this.curL, this.upL, BLOCK, rho, turn);
        octR.process(this.curR, this.upR, BLOCK, rho, turn);
        this.genLp[g]?.process(this.upL, this.upR, BLOCK);
        this.genHp[g]?.process(this.upL, this.upR, BLOCK);
        conv.process(this.upL, this.upR, this.curL, this.curR, this.cross);
        for (let i = 0; i < BLOCK; i++) {
          this.curL[i] = (this.curL[i] as number) * this.feedback;
          this.curR[i] = (this.curR[i] as number) * this.feedback;
        }
        if (aligned) this.lay(this.curL, this.curR, 1, wait - (g + 1) * this.stage);
        else {
          for (let i = 0; i < BLOCK; i++) {
            this.totL[i] = (this.totL[i] as number) + (this.curL[i] as number);
            this.totR[i] = (this.totR[i] as number) + (this.curR[i] as number);
          }
        }
      }
    } else if (!aligned) {
      this.totL.fill(0);
      this.totR.fill(0);
    }
    if (aligned) {
      // what's due now comes out of the buffer (the dry sound waits as long, below)
      const { accL, accR, accMask } = this;
      for (let i = 0; i < BLOCK; i++) {
        const w = (this.accPos + i) & accMask;
        this.totL[i] = accL[w] as number;
        this.totR[i] = accR[w] as number;
        accL[w] = 0;
        accR[w] = 0;
      }
    }
    if (this.useLow) this.lowcut.process(this.totL, this.totR, BLOCK);
    if (aligned) {
      this.delayDry(n);
      for (let i = 0; i < n; i++) {
        l[i] = (this.dryL[i] as number) * this.dry + (this.totL[i] as number) * this.wet;
        r[i] = (this.dryR[i] as number) * this.dry + (this.totR[i] as number) * this.wet;
      }
    } else {
      for (let i = 0; i < n; i++) {
        l[i] = (this.inL[i] as number) * this.dry + (this.totL[i] as number) * this.wet;
        r[i] = (this.inR[i] as number) * this.dry + (this.totR[i] as number) * this.wet;
      }
    }
    this.accPos = (this.accPos + BLOCK) & this.accMask;
  }

  /** The dry sound held back as long as the look-ahead (it comes out with the space). */
  private readonly dryBufL = new Float32Array(1 << 16);
  private readonly dryBufR = new Float32Array(1 << 16);
  private readonly dryL = new Float32Array(BLOCK);
  private readonly dryR = new Float32Array(BLOCK);
  private dryPos = 0;
  private delayDry(n: number): void {
    const mask = this.dryBufL.length - 1;
    const d = this.latency;
    for (let i = 0; i < n; i++) {
      const w = (this.dryPos + i) & mask;
      this.dryBufL[w] = this.inL[i] as number;
      this.dryBufR[w] = this.inR[i] as number;
      this.dryL[i] = this.dryBufL[(w - d) & mask] as number;
      this.dryR[i] = this.dryBufR[(w - d) & mask] as number;
    }
    this.dryPos = (this.dryPos + n) & mask;
  }

  reset(): void {
    this.convs = this.keys.map(() => null);
    for (const o of [...this.octL, ...this.octR]) o.reset();
    for (const f of [...this.genLp, ...this.genHp, this.lowcut]) f.reset();
    this.accL.fill(0);
    this.accR.fill(0);
    this.dryBufL.fill(0);
    this.dryBufR.fill(0);
    this.refresh();
  }
}
