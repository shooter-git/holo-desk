/**
 * String Resonance: a grand's strings with their dampers lifted, ringing in sympathy with whatever
 * the track plays. Every string from C8 down to A0 is there, and with Bass Strings up to nine more
 * below it, the longer strings of an extended grand (down to C0): they're rarely struck, but their
 * many low partials ring with almost anything, a dark warmth under the sound.
 *
 * Each string is a waveguide: a delay as long as one period, with an all-pass for the fraction of a
 * frame, a low pass for the top that dies sooner (Brightness), and a loss each time round that sets
 * how long it rings (Damping; longer in the bass, as a piano's strings do). From the tenor up a note
 * has two strings a little apart, as a piano's unisons are, so the ring beats gently and still takes
 * a note whose tuning is a few cents off equal. The strings follow a grand's stretched tuning (its
 * octaves a little wide towards the ends), and sit across the stereo image as the player hears them,
 * the bass on the left.
 *
 * Each string's input is scaled so that, rung at its own pitch for long enough, it rings as loudly
 * as what rings it: what comes out is a halo that builds under held notes and goes on after them.
 */
import { BASS_STRINGS, paramValue } from '@holo/session';
import { Biquad } from './dsp.ts';
import type { Effect, Host } from './fx.ts';

/** C8, the highest string, and A0, the lowest of an ordinary grand. */
const TOP = 108;
const A0 = 21;
const LOWEST = A0 - BASS_STRINGS;
/** From here up a note has a pair of strings, cents apart. */
const PAIRS_FROM = 36;
const UNISON_CENTS = 1.4;
/** Quieter than this for a whole block, in and out: asleep until something comes in. */
const SILENT = 1e-7;
/** The strings' sum at full Amount (set by ear and by measure: a halo under the sound, not a second one). */
const RING_LEVEL = 0.09;

/** A grand's stretch from equal temperament, in cents (wider octaves towards both ends). */
function stretch(midi: number): number {
  const s = (midi - 69) / 12;
  return s > 0 ? 0.9 * s ** 2.4 : -0.25 * (-s) ** 3;
}

export class StringResonance implements Effect {
  gr = 0;
  private amount = 0.3;
  private damping = 0.4;
  private brightness = 0.5;
  private lowest = A0;
  /** One entry per string (two for a paired note): its key, its delay and filters' settings and state. */
  private readonly count: number;
  private readonly key: Int32Array;
  private readonly freq: Float64Array;
  private readonly bufs: Float32Array[];
  private readonly masks: Int32Array;
  private readonly delay: Int32Array;
  private readonly ap: Float64Array;
  private readonly apX: Float64Array;
  private readonly apY: Float64Array;
  private readonly lpC: Float64Array;
  private readonly lpY: Float64Array;
  private readonly loss: Float64Array;
  private readonly gain: Float64Array;
  /** The strings in octaves (from the lowest), where each octave's sum is placed across the image. */
  private readonly groupStart: Int32Array;
  private readonly panL: Float64Array;
  private readonly panR: Float64Array;
  /** The first string playing (Bass Strings leaves those below it out). */
  private first = 0;
  private w = 0;
  private quiet = 0;
  private readonly inHp = new Biquad();
  private readonly outHp = new Biquad();
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    const sr = host.sr;
    const keys: number[] = [];
    const cents: number[] = [];
    for (let m = LOWEST; m <= TOP; m++) {
      if (m < PAIRS_FROM) {
        keys.push(m);
        cents.push(0);
      } else {
        keys.push(m, m);
        cents.push(-UNISON_CENTS / 2, UNISON_CENTS / 2);
      }
    }
    const count = keys.length;
    this.count = count;
    this.key = Int32Array.from(keys);
    this.freq = new Float64Array(count);
    this.bufs = [];
    this.masks = new Int32Array(count);
    this.delay = new Int32Array(count);
    this.ap = new Float64Array(count);
    this.apX = new Float64Array(count);
    this.apY = new Float64Array(count);
    this.lpC = new Float64Array(count);
    this.lpY = new Float64Array(count);
    this.loss = new Float64Array(count);
    this.gain = new Float64Array(count);
    const groups = Math.ceil((TOP - LOWEST + 1) / 12);
    this.groupStart = new Int32Array(groups + 1);
    this.panL = new Float64Array(groups);
    this.panR = new Float64Array(groups);
    for (let g = 0; g < groups; g++) {
      this.groupStart[g] = keys.findIndex((m) => m >= LOWEST + g * 12);
      // the bass on the left, as the player hears it
      const middle = Math.min(TOP, LOWEST + g * 12 + 6);
      const angle = (Math.PI / 4) * (1 + 0.7 * (2 * ((middle - LOWEST) / (TOP - LOWEST)) - 1));
      this.panL[g] = Math.cos(angle) * Math.SQRT2;
      this.panR[g] = Math.sin(angle) * Math.SQRT2;
    }
    this.groupStart[groups] = count;
    for (let k = 0; k < count; k++) {
      const m = keys[k] as number;
      const f = 440 * 2 ** ((m - 69 + (stretch(m) + (cents[k] as number)) / 100) / 12);
      this.freq[k] = f;
      let size = 16;
      while (size < sr / f + 8) size <<= 1;
      this.bufs.push(new Float32Array(size));
      this.masks[k] = size - 1;
    }
    this.inHp.set('highpass', 28, Math.SQRT1_2, 0, sr);
    this.outHp.set('highpass', 24, Math.SQRT1_2, 0, sr);
    this.tune();
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('resonance', p, id);
    this.amount = v('amount') / 100;
    const damping = v('damping') / 100;
    const brightness = v('brightness') / 100;
    const lowest = A0 - Math.round(v('bass'));
    if (damping !== this.damping || brightness !== this.brightness) {
      this.damping = damping;
      this.brightness = brightness;
      this.tune();
    }
    if (lowest !== this.lowest) {
      // strings coming in start still (whatever they held from before is let go)
      for (let k = 0; k < this.count; k++) {
        const m = this.key[k] as number;
        if (m < this.lowest !== m < lowest) this.still(k);
      }
      this.lowest = lowest;
    }
    let first = 0;
    while (first < this.count && (this.key[first] as number) < this.lowest) first++;
    this.first = first;
  }
  /** Each string's delay, all-pass, low pass, loss and input from the damping and brightness. */
  private tune(): void {
    const sr = this.host.sr;
    // how long A4 rings (60 dB): from 14 s undamped to under a second
    const ring = 14 * 0.06 ** this.damping;
    // the top's low pass: from 1.5 kHz dark to 24 kHz bright (never below a few of the string's own partials)
    const corner = 1500 * 2 ** (this.brightness * 4);
    for (let k = 0; k < this.count; k++) {
      const f = this.freq[k] as number;
      const w = (2 * Math.PI * f) / sr;
      const fc = Math.min(sr * 0.45, Math.max(corner, f * 6));
      const c = 1 - Math.exp((-2 * Math.PI * fc) / sr);
      const z = 1 - c;
      // the low pass's delay and level at the string's pitch
      const lpDelay = Math.atan2(z * Math.sin(w), 1 - z * Math.cos(w)) / w;
      const lpGain = c / Math.sqrt(1 - 2 * z * Math.cos(w) + z * z);
      // the rest of the period: whole frames, and a fraction (kept between 0.1 and 1.1 for the all-pass)
      const period = sr / f - lpDelay;
      const whole = Math.max(2, Math.floor(period - 0.1));
      const frac = period - whole;
      this.delay[k] = whole;
      this.ap[k] = (1 - frac) / (1 + frac);
      this.lpC[k] = c;
      // lower strings ring longer (half again for every octave down), up to half a minute
      const t60 = Math.min(30, Math.max(0.3, ring * 2 ** ((-0.5 * ((this.key[k] as number) - 69)) / 12)));
      const loop = Math.min(0.99995, 10 ** ((-3 * (sr / f)) / (sr * t60)));
      // (the low pass passes everything at full at DC: the loop must stay under unity there too)
      this.loss[k] = Math.min(0.99995, loop / lpGain);
      this.gain[k] = 1 - loop;
    }
  }
  private still(k: number): void {
    (this.bufs[k] as Float32Array).fill(0);
    this.apX[k] = 0;
    this.apY[k] = 0;
    this.lpY[k] = 0;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    if (this.inBuf.length < n) {
      this.inBuf = new Float32Array(n);
      this.octave = new Float32Array(n);
      this.sumL = new Float32Array(n);
      this.sumR = new Float32Array(n);
    }
    const { inBuf, sumL, sumR } = this;
    // what comes in, in the middle
    let loud = 0;
    for (let i = 0; i < n; i++) {
      const x = ((l[i] as number) + (r[i] as number)) * 0.5;
      inBuf[i] = x;
      const a = Math.abs(x);
      if (a > loud) loud = a;
    }
    // nothing in, and the strings died away blocks ago: asleep until something comes
    if (loud < SILENT && this.quiet > 2) return;
    // without its lowest lows (every string's loop rings at nothing too: no rumble may feed it)
    const ihp = this.inHp;
    for (let i = 0; i < n; i++) {
      ihp.run(inBuf[i] as number);
      inBuf[i] = ihp.y;
    }
    sumL.fill(0, 0, n);
    sumR.fill(0, 0, n);
    // the strings an octave at a time, each string over the whole block (its state stays in registers)
    const w0 = this.w;
    const octave = this.octave;
    const groups = this.groupStart.length - 1;
    for (let gi = 0; gi < groups; gi++) {
      const from = Math.max(this.first, this.groupStart[gi] as number);
      const to = this.groupStart[gi + 1] as number;
      if (from >= to) continue;
      octave.fill(0, 0, n);
      // two strings at a time: their loops are independent, so the processor works on both at once
      for (let k = from; k < to; k += 2) {
        const k2 = k + 1 < to ? k + 1 : -1;
        if (k2 < 0) {
          this.ring(k, w0, n, octave, inBuf);
          continue;
        }
        const buf = this.bufs[k] as Float32Array;
        const mask = this.masks[k] as number;
        const d = this.delay[k] as number;
        const a = this.ap[k] as number;
        const c = this.lpC[k] as number;
        const loss = this.loss[k] as number;
        const g = this.gain[k] as number;
        let ax = this.apX[k] as number;
        let ay = this.apY[k] as number;
        let ly = this.lpY[k] as number;
        const buf2 = this.bufs[k2] as Float32Array;
        const mask2 = this.masks[k2] as number;
        const d2 = this.delay[k2] as number;
        const a2 = this.ap[k2] as number;
        const c2 = this.lpC[k2] as number;
        const loss2 = this.loss[k2] as number;
        const g2 = this.gain[k2] as number;
        let ax2 = this.apX[k2] as number;
        let ay2 = this.apY[k2] as number;
        let ly2 = this.lpY[k2] as number;
        let w = w0;
        for (let i = 0; i < n; i++) {
          const x = inBuf[i] as number;
          const back = buf[(w - d) & mask] as number;
          const back2 = buf2[(w - d2) & mask2] as number;
          const y = a * back + ax - a * ay;
          const y2 = a2 * back2 + ax2 - a2 * ay2;
          ax = back;
          ay = y;
          ax2 = back2;
          ay2 = y2;
          ly += (y - ly) * c;
          ly2 += (y2 - ly2) * c2;
          const out = ly * loss;
          const out2 = ly2 * loss2;
          buf[w & mask] = x * g + out;
          buf2[w & mask2] = x * g2 + out2;
          octave[i] = (octave[i] as number) + out + out2;
          w++;
        }
        this.apX[k] = Math.abs(ax) < 1e-20 ? 0 : ax;
        this.apY[k] = Math.abs(ay) < 1e-20 ? 0 : ay;
        this.lpY[k] = Math.abs(ly) < 1e-20 ? 0 : ly;
        this.apX[k2] = Math.abs(ax2) < 1e-20 ? 0 : ax2;
        this.apY[k2] = Math.abs(ay2) < 1e-20 ? 0 : ay2;
        this.lpY[k2] = Math.abs(ly2) < 1e-20 ? 0 : ly2;
      }
      const pl = this.panL[gi] as number;
      const pr = this.panR[gi] as number;
      for (let i = 0; i < n; i++) {
        const o = octave[i] as number;
        sumL[i] = (sumL[i] as number) + o * pl;
        sumR[i] = (sumR[i] as number) + o * pr;
      }
    }
    this.w = (w0 + n) & 0x3fffffff;
    this.outHp.process(sumL, sumR, n);
    const level = this.amount * RING_LEVEL;
    let peak = 0;
    for (let i = 0; i < n; i++) {
      const yl = (sumL[i] as number) * level;
      const yr = (sumR[i] as number) * level;
      const m = Math.max(Math.abs(yl), Math.abs(yr));
      if (m > peak) peak = m;
      l[i] = (l[i] as number) + yl;
      r[i] = (r[i] as number) + yr;
    }
    this.quiet = loud < SILENT && peak < SILENT ? this.quiet + 1 : 0;
  }
  private inBuf = new Float32Array(256);
  private octave = new Float32Array(256);
  private sumL = new Float32Array(256);
  private sumR = new Float32Array(256);
  /** One string over the block, its ring added into `into`. */
  private ring(k: number, w0: number, n: number, into: Float32Array, inBuf: Float32Array): void {
    const buf = this.bufs[k] as Float32Array;
    const mask = this.masks[k] as number;
    const d = this.delay[k] as number;
    const a = this.ap[k] as number;
    const c = this.lpC[k] as number;
    const loss = this.loss[k] as number;
    const g = this.gain[k] as number;
    let ax = this.apX[k] as number;
    let ay = this.apY[k] as number;
    let ly = this.lpY[k] as number;
    let w = w0;
    for (let i = 0; i < n; i++) {
      const back = buf[(w - d) & mask] as number;
      const y = a * back + ax - a * ay;
      ax = back;
      ay = y;
      ly += (y - ly) * c;
      const out = ly * loss;
      buf[w & mask] = (inBuf[i] as number) * g + out;
      into[i] = (into[i] as number) + out;
      w++;
    }
    this.apX[k] = Math.abs(ax) < 1e-20 ? 0 : ax;
    this.apY[k] = Math.abs(ay) < 1e-20 ? 0 : ay;
    this.lpY[k] = Math.abs(ly) < 1e-20 ? 0 : ly;
  }
  reset(): void {
    for (let k = 0; k < this.count; k++) this.still(k);
    this.inHp.reset();
    this.outHp.reset();
    this.quiet = 0;
  }
}
