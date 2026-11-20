/**
 * Prism's filters (a voice's, and each source's) and its effects rack (on everything the voices
 * make). Filters take a new cutoff, resonance and drive each control step and glide to it over the
 * block; the effects take theirs each block too.
 */
import { CTRL } from './prism-mod.ts';

const TAU = Math.PI * 2;

/** A cheap tanh (exact enough for saturation, and bounded). */
export function soft(x: number): number {
  if (x > 3) return 1;
  if (x < -3) return -1;
  const x2 = x * x;
  return (x * (27 + x2)) / (27 + 9 * x2);
}

// ---- filters ---------------------------------------------------------------------------------------

/**
 * One filter of PRISM_FILTERS, in stereo: 0 low-pass, 1 high-pass, 2 band-pass, 3 notch (12 dB
 * state-variable filters, steady however fast they move), 4 diode (a low-pass whose resonance
 * saturates, growling rather than whistling), 5 and 6 a transistor ladder's 12 and 24 dB outputs
 * (driven, run at twice the rate).
 */
export class PrismFilter {
  type = 0;
  // state-variable filter: the coefficients now, and their steps over the block
  private a1 = 0;
  private a2 = 0;
  private a3 = 0;
  private k = Math.SQRT2;
  private da1 = 0;
  private da2 = 0;
  private da3 = 0;
  private dk = 0;
  private l1 = 0;
  private l2 = 0;
  private r1 = 0;
  private r2 = 0;
  // ladder
  private g = 0;
  private dg = 0;
  private fb = 0;
  private dfb = 0;
  private readonly ls = new Float64Array(4);
  private readonly rs = new Float64Array(4);
  private drive = 1;
  private comp = 1;
  private started = false;

  reset(): void {
    this.l1 = this.l2 = this.r1 = this.r2 = 0;
    this.ls.fill(0);
    this.rs.fill(0);
    this.started = false;
  }

  /** Headed for: cutoff (Hz), resonance (0…1) and drive (0…1) by the end of the block. */
  set(type: number, hz: number, res: number, drive: number, sr: number): void {
    if (type !== this.type) {
      this.type = type;
      this.reset();
    }
    const f = Math.min(Math.max(hz, 10), sr * 0.45);
    this.drive = 1 + 3 * drive;
    if (type <= 4) {
      const g = Math.tan((Math.PI * f) / sr);
      const q = Math.SQRT1_2 * 70 ** (type === 4 ? res * 0.9 : res);
      const k = 1 / q;
      const a1 = 1 / (1 + g * (g + k));
      const a2 = g * a1;
      const a3 = g * a2;
      if (!this.started) {
        this.a1 = a1;
        this.a2 = a2;
        this.a3 = a3;
        this.k = k;
      }
      this.da1 = (a1 - this.a1) / CTRL;
      this.da2 = (a2 - this.a2) / CTRL;
      this.da3 = (a3 - this.a3) / CTRL;
      this.dk = (k - this.k) / CTRL;
      this.comp = type === 4 ? 1 / (1 + 1.5 * drive) : 1;
    } else {
      // at twice the rate: one pole's coefficient, and the feedback (the loss at the top worked in)
      const g = 1 - Math.exp((-TAU * f) / (2 * sr));
      const fb = 3.9 * res * (1 + 0.25 * (1 - g));
      if (!this.started) {
        this.g = g;
        this.fb = fb;
      }
      this.dg = (g - this.g) / CTRL;
      this.dfb = (fb - this.fb) / CTRL;
      this.comp = (1 + (type === 6 ? 0.55 : 0.3) * fb) / (1 + 0.6 * drive);
    }
    this.started = true;
  }

  /** n samples of l (and r) in place. */
  process(l: Float32Array, r: Float32Array, n: number, stereo: boolean): void {
    if (this.type <= 4) this.svf(l, r, n, stereo);
    else this.ladder(l, r, n, stereo);
  }

  private svf(l: Float32Array, r: Float32Array, n: number, stereo: boolean): void {
    let a1 = this.a1;
    let a2 = this.a2;
    let a3 = this.a3;
    let k = this.k;
    const { da1, da2, da3, dk } = this;
    let l1 = this.l1;
    let l2 = this.l2;
    let r1 = this.r1;
    let r2 = this.r2;
    const type = this.type;
    const drive = this.drive;
    const comp = this.comp;
    for (let i = 0; i < n; i++) {
      let x = l[i] as number;
      if (type === 4) x = soft(x * drive);
      let v3 = x - l2;
      let v1 = a1 * l1 + a2 * v3;
      let v2 = l2 + a2 * l1 + a3 * v3;
      l1 = 2 * v1 - l1;
      l2 = 2 * v2 - l2;
      if (type === 4) l1 = soft(l1 * 0.5) * 2;
      l[i] = type === 0 || type === 4 ? v2 * comp : type === 1 ? x - k * v1 - v2 : type === 2 ? v1 : x - k * v1;
      if (stereo) {
        x = r[i] as number;
        if (type === 4) x = soft(x * drive);
        v3 = x - r2;
        v1 = a1 * r1 + a2 * v3;
        v2 = r2 + a2 * r1 + a3 * v3;
        r1 = 2 * v1 - r1;
        r2 = 2 * v2 - r2;
        if (type === 4) r1 = soft(r1 * 0.5) * 2;
        r[i] = type === 0 || type === 4 ? v2 * comp : type === 1 ? x - k * v1 - v2 : type === 2 ? v1 : x - k * v1;
      }
      a1 += da1;
      a2 += da2;
      a3 += da3;
      k += dk;
    }
    this.a1 = a1;
    this.a2 = a2;
    this.a3 = a3;
    this.k = k;
    // (flushed when they've died away: no slow denormal arithmetic)
    this.l1 = Math.abs(l1) < 1e-20 ? 0 : l1;
    this.l2 = Math.abs(l2) < 1e-20 ? 0 : l2;
    this.r1 = Math.abs(r1) < 1e-20 ? 0 : r1;
    this.r2 = Math.abs(r2) < 1e-20 ? 0 : r2;
  }

  private ladder(l: Float32Array, r: Float32Array, n: number, stereo: boolean): void {
    const { dg, dfb } = this;
    const drive = this.drive;
    const comp = this.comp;
    const four = this.type === 6;
    for (let c = 0; c < (stereo ? 2 : 1); c++) {
      const buf = c === 0 ? l : r;
      const s = c === 0 ? this.ls : this.rs;
      let y1 = s[0] as number;
      let y2 = s[1] as number;
      let y3 = s[2] as number;
      let y4 = s[3] as number;
      let g = this.g;
      let fb = this.fb;
      for (let i = 0; i < n; i++) {
        const x = (buf[i] as number) * drive;
        let out = 0;
        for (let o = 0; o < 2; o++) {
          const u = soft(x - fb * y4);
          y1 += g * (u - y1);
          y2 += g * (y1 - y2);
          y3 += g * (y2 - y3);
          y4 += g * (y3 - y4);
          out += four ? y4 : y2;
        }
        buf[i] = out * 0.5 * comp;
        g += dg;
        fb += dfb;
      }
      s[0] = Math.abs(y1) < 1e-20 ? 0 : y1;
      s[1] = Math.abs(y2) < 1e-20 ? 0 : y2;
      s[2] = Math.abs(y3) < 1e-20 ? 0 : y3;
      s[3] = Math.abs(y4) < 1e-20 ? 0 : y4;
    }
    this.g += dg * n;
    this.fb += dfb * n;
  }
}

// ---- effects ------------------------------------------------------------------------------------------

/** An effect's settings for a block (read by name; each type takes its own). */
export type FxSettings = Record<string, number>;

interface Effect {
  /** New settings (every block: cheap when nothing changed). */
  set(s: FxSettings, beatSeconds: number): void;
  /** In place, start..end. */
  process(l: Float32Array, r: Float32Array, start: number, end: number): void;
  /** Its tail's level (0 when it has none or it has died away). */
  readonly ringing: number;
  reset(): void;
}

/** A one-pole filter's coefficient for a corner at hz. */
const onePole = (hz: number, sr: number) => 1 - Math.exp((-TAU * hz) / sr);

/** A triangle at phase p (0…1), −1…1: cheap, and it sweeps a chorus as evenly as a sine. */
function tri(p: number): number {
  return p < 0.5 ? 4 * p - 1 : 3 - 4 * p;
}

class Delay implements Effect {
  private readonly sr: number;
  private bl: Float32Array;
  private br: Float32Array;
  private w = 0;
  private tl = 1;
  private tr = 1;
  private targetL = 1;
  private targetR = 1;
  private fb = 0;
  private cross = 0;
  private mix = 0;
  private lc = 0;
  private hc = 1;
  private hpl = 0;
  private hpr = 0;
  private lpl = 0;
  private lpr = 0;
  ringing = 0;
  constructor(sr: number) {
    this.sr = sr;
    this.bl = new Float32Array(Math.round(sr * 2));
    this.br = new Float32Array(Math.round(sr * 2));
  }
  reset(): void {
    this.bl.fill(0);
    this.br.fill(0);
    this.hpl = this.hpr = this.lpl = this.lpr = 0;
  }
  set(s: FxSettings, beatSeconds: number): void {
    const sync = (s.sync ?? 0) >= 0.5;
    const tl = (s.time ?? 0.375) * (sync ? beatSeconds : 1);
    const trRaw = s.timer ?? 0;
    const tr = trRaw > 0 ? trRaw * (sync ? beatSeconds : 1) : tl;
    const need = Math.ceil(Math.max(tl, tr) * this.sr) + 4;
    if (need > this.bl.length && need < this.sr * 12) {
      // a longer delay than the line holds: a longer line (once, as the patch asks for it)
      const grow = (b: Float32Array) => {
        const out = new Float32Array(need);
        out.set(b.subarray(0, Math.min(b.length, need)));
        return out;
      };
      this.bl = grow(this.bl);
      this.br = grow(this.br);
    }
    this.targetL = Math.min(this.bl.length - 2, Math.max(1, tl * this.sr));
    this.targetR = Math.min(this.br.length - 2, Math.max(1, tr * this.sr));
    this.fb = Math.min(0.98, Math.max(0, s.feedback ?? 0.4));
    this.cross = s.cross ?? 0;
    this.mix = s.mix ?? 0.3;
    this.lc = onePole(s.lowcut ?? 20, this.sr);
    this.hc = onePole(Math.min(this.sr * 0.45, s.highcut ?? 20000), this.sr);
  }
  process(l: Float32Array, r: Float32Array, start: number, end: number): void {
    const bl = this.bl;
    const br = this.br;
    const n = bl.length;
    let w = this.w;
    let tl = this.tl;
    let tr = this.tr;
    const glide = 0.0015;
    const { fb, cross, mix, lc, hc } = this;
    let { hpl, hpr, lpl, lpr } = this;
    let peak = 0;
    for (let i = start; i < end; i++) {
      tl += (this.targetL - tl) * glide;
      tr += (this.targetR - tr) * glide;
      let rp = w - tl;
      if (rp < 0) rp += n;
      let j = rp | 0;
      let t = rp - j;
      const dl = (bl[j] as number) + t * ((bl[j + 1 < n ? j + 1 : 0] as number) - (bl[j] as number));
      rp = w - tr;
      if (rp < 0) rp += n;
      j = rp | 0;
      t = rp - j;
      const dr = (br[j] as number) + t * ((br[j + 1 < n ? j + 1 : 0] as number) - (br[j] as number));
      // the echoes fed back, through the low and high cuts
      let fl = (1 - cross) * dl + cross * dr;
      let fr = (1 - cross) * dr + cross * dl;
      lpl += (fl - lpl) * hc;
      lpr += (fr - lpr) * hc;
      hpl += (lpl - hpl) * lc;
      hpr += (lpr - hpr) * lc;
      fl = lpl - hpl;
      fr = lpr - hpr;
      const x = l[i] as number;
      const y = r[i] as number;
      bl[w] = x + fb * fl;
      br[w] = y + fb * fr;
      l[i] = x + mix * (dl - x);
      r[i] = y + mix * (dr - y);
      const a = dl < 0 ? -dl : dl;
      if (a > peak) peak = a;
      if (++w >= n) w = 0;
    }
    this.w = w;
    this.tl = tl;
    this.tr = tr;
    this.hpl = hpl;
    this.hpr = hpr;
    this.lpl = Math.abs(lpl) < 1e-20 ? 0 : lpl;
    this.lpr = Math.abs(lpr) < 1e-20 ? 0 : lpr;
    this.ringing = Math.max(peak, this.ringing * 0.9);
  }
}

class Chorus implements Effect {
  private readonly sr: number;
  private readonly bl: Float32Array;
  private readonly br: Float32Array;
  private w = 0;
  private ph = 0;
  private rate = 0;
  private base = 0;
  private depth = 0;
  private fb = 0;
  private offset = 0.25;
  private mix = 0;
  ringing = 0;
  constructor(sr: number) {
    this.sr = sr;
    this.bl = new Float32Array(Math.ceil(sr * 0.05) + 4);
    this.br = new Float32Array(Math.ceil(sr * 0.05) + 4);
  }
  reset(): void {
    this.bl.fill(0);
    this.br.fill(0);
  }
  set(s: FxSettings): void {
    this.rate = (s.rate ?? 0.5) / this.sr;
    this.base = ((s.delay ?? 8) / 1000) * this.sr;
    this.depth = ((s.depth ?? 2) / 1000) * this.sr;
    this.fb = Math.max(-0.95, Math.min(0.95, s.feedback ?? 0));
    this.offset = 0.5 * (s.width ?? 1);
    this.mix = s.mix ?? 0.5;
  }
  process(l: Float32Array, r: Float32Array, start: number, end: number): void {
    const bl = this.bl;
    const br = this.br;
    const n = bl.length;
    let w = this.w;
    let ph = this.ph;
    const { rate, base, depth, fb, offset, mix } = this;
    const max = n - 3;
    let peak = 0;
    for (let i = start; i < end; i++) {
      ph += rate;
      if (ph >= 1) ph -= 1;
      let pr = ph + offset;
      if (pr >= 1) pr -= 1;
      const dl = Math.min(max, base + depth * (0.5 + 0.5 * tri(ph)));
      const dr = Math.min(max, base + depth * (0.5 + 0.5 * tri(pr)));
      let rp = w - dl;
      if (rp < 0) rp += n;
      let j = rp | 0;
      let t = rp - j;
      const yl = (bl[j] as number) + t * ((bl[j + 1 < n ? j + 1 : 0] as number) - (bl[j] as number));
      rp = w - dr;
      if (rp < 0) rp += n;
      j = rp | 0;
      t = rp - j;
      const yr = (br[j] as number) + t * ((br[j + 1 < n ? j + 1 : 0] as number) - (br[j] as number));
      const x = l[i] as number;
      const y = r[i] as number;
      bl[w] = x + fb * yl;
      br[w] = y + fb * yr;
      l[i] = x + mix * (yl - x);
      r[i] = y + mix * (yr - y);
      const a = yl < 0 ? -yl : yl;
      if (a > peak) peak = a;
      if (++w >= n) w = 0;
    }
    this.w = w;
    this.ph = ph;
    this.ringing = Math.max(peak, this.ringing * 0.5);
  }
}

class Drive implements Effect {
  private pre = 1;
  private tube = 0;
  private steps = 0;
  private out = 1;
  private mix = 1;
  ringing = 0;
  reset(): void {}
  set(s: FxSettings): void {
    const d = s.drive ?? 0.3;
    this.pre = 1 + 30 * d * d;
    this.tube = s.tube ?? 0;
    const crush = s.crush ?? 0;
    this.steps = crush > 0 ? 2 ** (16 - 13 * crush) : 0;
    this.out = (s.output ?? 1) / Math.sqrt(this.pre) ** 0.6;
    this.mix = s.mix ?? 1;
  }
  process(l: Float32Array, r: Float32Array, start: number, end: number): void {
    const { pre, tube, steps, out, mix } = this;
    for (let c = 0; c < 2; c++) {
      const b = c === 0 ? l : r;
      for (let i = start; i < end; i++) {
        const x = b[i] as number;
        let y = x * pre;
        // the tube's lean: more push one way, so even harmonics come in
        y = soft(y + tube * 0.3 * y * y);
        if (steps) y = Math.round(y * steps) / steps;
        b[i] = x + mix * (y * out - x);
      }
    }
  }
}

/** A stereo biquad section (direct form I), its coefficients set when they change. */
class Section {
  b0 = 1;
  b1 = 0;
  b2 = 0;
  a1 = 0;
  a2 = 0;
  private x1 = new Float64Array(2);
  private x2 = new Float64Array(2);
  private y1 = new Float64Array(2);
  private y2 = new Float64Array(2);
  reset(): void {
    this.x1.fill(0);
    this.x2.fill(0);
    this.y1.fill(0);
    this.y2.fill(0);
  }
  design(high: boolean, hz: number, q: number, sr: number): void {
    const f = Math.min(Math.max(hz, 10), sr * 0.45);
    const w = (TAU * f) / sr;
    const cos = Math.cos(w);
    const alpha = Math.sin(w) / (2 * q);
    const a0 = 1 + alpha;
    this.b0 = (high ? (1 + cos) / 2 : (1 - cos) / 2) / a0;
    this.b1 = (high ? -(1 + cos) : 1 - cos) / a0;
    this.b2 = this.b0;
    this.a1 = (-2 * cos) / a0;
    this.a2 = (1 - alpha) / a0;
  }
  run(x: number, c: number): number {
    const y =
      this.b0 * x +
      this.b1 * (this.x1[c] as number) +
      this.b2 * (this.x2[c] as number) -
      this.a1 * (this.y1[c] as number) -
      this.a2 * (this.y2[c] as number);
    this.x2[c] = this.x1[c] as number;
    this.x1[c] = x;
    this.y2[c] = this.y1[c] as number;
    this.y1[c] = Math.abs(y) < 1e-20 ? 0 : y;
    return y;
  }
}

class Band implements Effect {
  private readonly sr: number;
  private readonly sec = [new Section(), new Section(), new Section(), new Section()];
  private low = -1;
  private high = -1;
  private lq = -1;
  private hq = -1;
  private reject = 0;
  private mix = 1;
  ringing = 0;
  constructor(sr: number) {
    this.sr = sr;
  }
  reset(): void {
    for (const s of this.sec) s.reset();
  }
  set(s: FxSettings): void {
    const low = s.low ?? 20;
    const high = s.high ?? 20000;
    const lq = 0.5 + 4 * (s.lowres ?? 0);
    const hq = 0.5 + 4 * (s.highres ?? 0);
    if (low !== this.low || high !== this.high || lq !== this.lq || hq !== this.hq) {
      this.low = low;
      this.high = high;
      this.lq = lq;
      this.hq = hq;
      (this.sec[0] as Section).design(true, low, lq, this.sr);
      (this.sec[1] as Section).design(true, low, lq, this.sr);
      (this.sec[2] as Section).design(false, high, hq, this.sr);
      (this.sec[3] as Section).design(false, high, hq, this.sr);
    }
    this.reject = s.reject ?? 0;
    this.mix = s.mix ?? 1;
  }
  process(l: Float32Array, r: Float32Array, start: number, end: number): void {
    const [a, b, c, d] = this.sec as [Section, Section, Section, Section];
    const { reject, mix } = this;
    for (let ch = 0; ch < 2; ch++) {
      const buf = ch === 0 ? l : r;
      for (let i = start; i < end; i++) {
        const x = buf[i] as number;
        const y = d.run(c.run(b.run(a.run(x, ch), ch), ch), ch);
        buf[i] = x + mix * (y + reject * (x - y) - x);
      }
    }
  }
}

class Compressor implements Effect {
  private readonly sr: number;
  private env = 0;
  private gain = 1;
  private makeup = 1;
  private fall = 0;
  private mix = 1;
  ringing = 0;
  constructor(sr: number) {
    this.sr = sr;
  }
  reset(): void {
    this.env = 0;
    this.gain = 1;
  }
  set(s: FxSettings): void {
    const a = Math.min(0.97, s.amount ?? 0.4);
    this.makeup = 1 / (1 - a);
    this.fall = 1 / Math.max(1, (s.release ?? 0.25) * this.sr);
    this.mix = s.mix ?? 1;
  }
  process(l: Float32Array, r: Float32Array, start: number, end: number): void {
    const { makeup, fall, mix } = this;
    let env = this.env;
    let gain = this.gain;
    for (let i = start; i < end; i += CTRL) {
      const stop = Math.min(end, i + CTRL);
      // the block's peak, followed: straight up, falling at the release's pace
      let peak = 0;
      for (let j = i; j < stop; j++) {
        const a = Math.max(Math.abs(l[j] as number), Math.abs(r[j] as number));
        if (a > peak) peak = a;
      }
      env = peak > env ? peak : Math.max(peak, env - fall * (stop - i));
      // brought up by the makeup, then above half way bent softly under full scale
      const e = env * makeup;
      const target = e > 0.5 ? (makeup * (0.5 + 0.5 * soft((e - 0.5) / 0.5))) / e : makeup;
      const step = (target - gain) / (stop - i);
      for (let j = i; j < stop; j++) {
        gain += step;
        const x = l[j] as number;
        const y = r[j] as number;
        l[j] = x + mix * (x * gain - x);
        r[j] = y + mix * (y * gain - y);
      }
    }
    this.env = env;
    this.gain = gain;
  }
}

class Reverb implements Effect {
  private readonly sr: number;
  private readonly lines: Float32Array[] = [];
  private readonly lens = new Float64Array(8);
  private readonly lensInt = new Int32Array(8);
  private readonly pos = new Int32Array(8);
  private readonly fbk = new Float64Array(8);
  private readonly lp = new Float64Array(8);
  private readonly aps: Float32Array[] = [];
  private readonly apPos = new Int32Array(4);
  private readonly pre: Float32Array;
  private preLen = 1;
  private prePos = 0;
  private damp = 0.5;
  private mix = 0.3;
  private width = 1;
  private size = -1;
  private decay = -1;
  private sway = 0;
  ringing = 0;
  constructor(sr: number) {
    this.sr = sr;
    const k = sr / 48000;
    // lines long enough for the largest room
    for (const n of [1693, 1889, 2153, 2417, 2731, 3049, 3343, 3637])
      this.lines.push(new Float32Array(Math.ceil(n * k * 1.7) + 16));
    for (const n of [142, 107, 379, 277]) this.aps.push(new Float32Array(Math.round((n * sr) / 29761) + 1));
    this.pre = new Float32Array(Math.ceil(0.26 * sr) + 1);
  }
  reset(): void {
    for (const l of this.lines) l.fill(0);
    for (const a of this.aps) a.fill(0);
    this.pre.fill(0);
    this.lp.fill(0);
  }
  set(s: FxSettings): void {
    const size = s.size ?? 0.5;
    const decay = s.decay ?? 2.5;
    if (size !== this.size || decay !== this.decay) {
      this.size = size;
      this.decay = decay;
      const k = (this.sr / 48000) * (0.45 + 1.2 * size);
      [1693, 1889, 2153, 2417, 2731, 3049, 3343, 3637].forEach((n, i) => {
        this.lens[i] = n * k;
        this.lensInt[i] = Math.round(n * k);
        this.fbk[i] = 10 ** ((-3 * n * k) / (Math.max(0.1, decay) * this.sr));
      });
    }
    this.damp = onePole(13000 - 11500 * (s.damp ?? 0.5), this.sr);
    this.preLen = Math.max(1, Math.round((s.predelay ?? 0.02) * this.sr));
    this.mix = s.mix ?? 0.3;
    this.width = s.width ?? 1;
  }
  process(l: Float32Array, r: Float32Array, start: number, end: number): void {
    const { lines, lens, lensInt, pos, fbk, lp, aps, apPos, pre, damp, mix, width } = this;
    const preN = pre.length;
    let peak = 0;
    for (let i = start; i < end; i++) {
      const inL = l[i] as number;
      const inR = r[i] as number;
      // pre-delay, then four diffusers
      let rp = this.prePos - this.preLen;
      if (rp < 0) rp += preN;
      let x = pre[rp] as number;
      pre[this.prePos] = (inL + inR) * 0.5;
      if (++this.prePos >= preN) this.prePos = 0;
      for (let a = 0; a < 4; a++) {
        const buf = aps[a] as Float32Array;
        const at = apPos[a] as number;
        const d = buf[at] as number;
        const v = x - 0.62 * d;
        buf[at] = v;
        x = d + 0.62 * v;
        apPos[a] = at + 1 >= buf.length ? 0 : at + 1;
      }
      // two of the lines sway a little, so it never rings metallic
      this.sway += 0.37 / this.sr;
      if (this.sway >= 1) this.sway -= 1;
      const swing = Math.sin(TAU * this.sway) * 5;
      let sum = 0;
      for (let k = 0; k < 8; k++) {
        const line = lines[k] as Float32Array;
        const n = line.length;
        let y: number;
        if (k === 1 || k === 5) {
          // the two swaying lines, read between samples
          let p = (pos[k] as number) - (lens[k] as number) - (k === 1 ? swing : -swing);
          while (p < 0) p += n;
          const j = p | 0;
          const t = p - j;
          y = (line[j] as number) + t * ((line[j + 1 < n ? j + 1 : 0] as number) - (line[j] as number));
        } else {
          let p = (pos[k] as number) - (lensInt[k] as number);
          if (p < 0) p += n;
          y = line[p] as number;
        }
        const f = (lp[k] as number) + (y - (lp[k] as number)) * damp;
        lp[k] = Math.abs(f) < 1e-20 ? 0 : f;
        sum += f;
      }
      const m = sum * 0.25;
      let ol = 0;
      let or = 0;
      for (let k = 0; k < 8; k++) {
        const f = lp[k] as number;
        const line = lines[k] as Float32Array;
        const at = pos[k] as number;
        line[at] = (k & 1 ? -x : x) * 0.5 + (f - m) * (fbk[k] as number);
        pos[k] = at + 1 >= line.length ? 0 : at + 1;
        if (k & 1) or += k & 2 ? -f : f;
        else ol += k & 2 ? -f : f;
      }
      ol *= 0.5;
      or *= 0.5;
      // width: the two sides toward their middle
      const mid = (ol + or) * 0.5;
      ol = mid + (ol - mid) * width;
      or = mid + (or - mid) * width;
      l[i] = inL + mix * (ol - inL);
      r[i] = inR + mix * (or - inR);
      const a = ol < 0 ? -ol : ol;
      if (a > peak) peak = a;
    }
    this.ringing = Math.max(peak, this.ringing * 0.95);
  }
}

/** An effect of type (PRISM_EFFECTS) 1…6. */
export function makeEffect(type: number, sr: number): Effect | null {
  switch (type) {
    case 1:
      return new Delay(sr);
    case 2:
      return new Chorus(sr);
    case 3:
      return new Drive();
    case 4:
      return new Band(sr);
    case 5:
      return new Compressor(sr);
    case 6:
      return new Reverb(sr);
    default:
      return null;
  }
}

export type { Effect };
