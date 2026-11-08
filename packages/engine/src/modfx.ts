/**
 * Movement and wear: a rotary speaker, a phaser, a tremolo that can pan instead, and a lo-fi
 * sampler-and-tape. Each reads its settings from the shared plugin table and runs a stereo block in
 * place, allocating nothing while it plays.
 */
import { paramValue } from '@holo/session';
import { Biquad, dbToGain, Noise } from './dsp.ts';
import { DIVISION_BEATS, type Effect, type Host } from './fx.ts';

const TAU = Math.PI * 2;

/** A one-pole's coefficient that gets about 63% of the way in `seconds`. */
const toward = (seconds: number, sr: number): number => 1 - Math.exp(-1 / Math.max(1, seconds * sr));

/** A delay line a power of two long, read anywhere between its samples (linearly). */
class Line {
  /** The last read (left here: a call that returns a double allocates when it isn't inlined). */
  out = 0;
  private readonly buf: Float32Array;
  private readonly mask: number;
  private w = 0;
  constructor(min: number) {
    let size = 16;
    while (size < min) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }
  write(x: number): void {
    this.buf[this.w] = x;
    this.w = (this.w + 1) & this.mask;
  }
  /** `d` frames before the last one written (≥ 1). */
  read(d: number): void {
    const pos = this.w - 1 - d;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = this.buf[i & this.mask] as number;
    const b = this.buf[(i + 1) & this.mask] as number;
    this.out = a + (b - a) * f;
  }
  clear(): void {
    this.buf.fill(0);
    this.w = 0;
  }
}

/**
 * A valve's soft clipping with a little bias (so it breaks up unevenly), set so a quiet sound keeps
 * its level however hard it's driven.
 */
function valve(x: number, pre: number, bias: number, biasOut: number, norm: number): number {
  const u = x * pre + bias;
  const s = u < -3 ? -1 : u > 3 ? 1 : (u * (27 + u * u)) / (27 + 9 * u * u);
  return (s - biasOut) * norm;
}

/**
 * Rotary speaker. The sound goes through a valve preamp, then a crossover at 800 Hz: the highs to a
 * horn and the lows to a drum, each turning at its own speed and taking its own time to get there
 * (the light horn in about a second, the heavy drum in several; Brake lets both stop where they are).
 * Two microphones either side hear each rotor come and go: its pitch moving as it turns towards and
 * away (a delay that sweeps), its level dipping and its top dulling facing away. Further off, the
 * microphones hear less of the swing and more of each other.
 */
export class RotarySpeaker implements Effect {
  gr = 0;
  private speed = 1;
  private hornSlow = 0.8;
  private hornFast = 6.8;
  private drumSlow = 0.7;
  private drumFast = 5.9;
  private hornUp = 0;
  private hornDown = 0;
  private drumUp = 0;
  private drumDown = 0;
  private pre = 1;
  private bias = 0;
  private biasOut = 0;
  private norm = 1;
  private drive = 0;
  private hornGain = 1;
  private drumGain = 1;
  private mix = 1;
  /** Microphone placement: half the angle between them, the level swing, and how much each hears of the other. */
  private half = 1.4;
  private hornAm = 0.5;
  private drumAm = 0.3;
  private cross = 0;
  private hornHz = Number.NaN;
  private drumHz = Number.NaN;
  private hornAngle = 0;
  private drumAngle = 1.3;
  private readonly horn: Line;
  private readonly drum: Line;
  private readonly lp1 = new Biquad();
  private readonly lp2 = new Biquad();
  private readonly hp1 = new Biquad();
  private readonly hp2 = new Biquad();
  /** Each microphone's dulling of the horn facing away (one pole each). */
  private dullL = 0;
  private dullR = 0;
  private readonly dullNear: number;
  private readonly dullFar: number;
  private readonly hornSwing: number;
  private readonly drumSwing: number;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    const sr = host.sr;
    // the horn's mouth swings about 15 cm towards and away; the drum's baffle less, for the lows
    this.hornSwing = 0.0009 * sr;
    this.drumSwing = 0.0005 * sr;
    this.horn = new Line(this.hornSwing + 8);
    this.drum = new Line(this.drumSwing + 8);
    this.dullNear = 1 - Math.exp((-TAU * 9000) / sr);
    this.dullFar = 1 - Math.exp((-TAU * 2600) / sr);
    for (const f of [this.lp1, this.lp2]) f.set('lowpass', 800, Math.SQRT1_2, 0, sr);
    for (const f of [this.hp1, this.hp2]) f.set('highpass', 800, Math.SQRT1_2, 0, sr);
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('rotary', p, id);
    const sr = this.host.sr;
    this.speed = Math.round(v('speed'));
    this.hornSlow = v('hornSlow');
    this.hornFast = v('hornFast');
    this.drumSlow = v('drumSlow');
    this.drumFast = v('drumFast');
    // a rotor gets most of the way in its ramp time, and takes a little longer to slow than to speed up
    this.hornUp = toward(v('hornRamp') / 3, sr);
    this.hornDown = toward((v('hornRamp') * 1.4) / 3, sr);
    this.drumUp = toward(v('drumRamp') / 3, sr);
    this.drumDown = toward((v('drumRamp') * 1.4) / 3, sr);
    const drive = v('drive') / 100;
    this.drive = drive;
    this.pre = 1 + drive * drive * 14;
    this.bias = 0.25 * drive;
    this.biasOut = valve(0, 1, this.bias, 0, 1);
    // a quiet sound's gain through the curve at the bias, taken back out
    const slope =
      (valve(1e-4, this.pre, this.bias, this.biasOut, 1) - valve(-1e-4, this.pre, this.bias, this.biasOut, 1)) / 2e-4;
    this.norm = 1 / Math.max(1e-3, slope);
    const balance = v('balance') / 100;
    this.hornGain = Math.min(1, 2 * balance);
    this.drumGain = Math.min(1, 2 * (1 - balance));
    this.mix = v('mix') / 100;
    const d = v('distance') / 100;
    this.half = (Math.PI / 2) * (1 - 0.45 * d);
    this.hornAm = 0.6 * (1 - 0.55 * d);
    this.drumAm = 0.35 * (1 - 0.55 * d);
    this.cross = 0.4 * d;
    if (Number.isNaN(this.hornHz)) {
      this.hornHz = this.target(this.hornSlow, this.hornFast);
      this.drumHz = this.target(this.drumSlow, this.drumFast);
    }
  }
  private target(slow: number, fast: number): number {
    return this.speed === 0 ? 0 : this.speed === 2 ? fast : slow;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const sr = this.host.sr;
    const hornTo = this.target(this.hornSlow, this.hornFast);
    const drumTo = this.target(this.drumSlow, this.drumFast);
    const hornCoef = hornTo > this.hornHz ? this.hornUp : this.hornDown;
    const drumCoef = drumTo > this.drumHz ? this.drumUp : this.drumDown;
    const { horn, drum, lp1, lp2, hp1, hp2, pre, bias, biasOut, norm, half, hornAm, drumAm, cross, mix } = this;
    const { hornSwing, drumSwing, dullNear, dullFar, hornGain, drumGain } = this;
    const driven = this.drive > 0;
    // the level lost to the swing on average, given back
    const hornMake = hornGain / (1 - hornAm * 0.5);
    const drumMake = drumGain / (1 - drumAm * 0.5);
    const keep = 1 - cross;
    let { hornHz, drumHz, hornAngle, drumAngle, dullL, dullR } = this;
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      let x = (a + b) * 0.5;
      if (driven) x = valve(x, pre, bias, biasOut, norm);
      hornHz += (hornTo - hornHz) * hornCoef;
      drumHz += (drumTo - drumHz) * drumCoef;
      hornAngle += (TAU * hornHz) / sr;
      if (hornAngle > TAU) hornAngle -= TAU;
      drumAngle += (TAU * drumHz) / sr;
      if (drumAngle > TAU) drumAngle -= TAU;
      // the crossover: two Butterworth sections each way (they add back to the whole, in phase)
      lp1.run(x);
      lp2.run(lp1.y);
      hp1.run(x);
      hp2.run(hp1.y);
      horn.write(hp2.y);
      drum.write(lp2.y);
      // the horn, as each microphone hears it
      const hfL = Math.cos(hornAngle + half);
      const hfR = Math.cos(hornAngle - half);
      horn.read(1 + hornSwing * (1 - hfL) * 0.5);
      const hl = horn.out * (1 - hornAm + hornAm * (0.5 + 0.5 * hfL));
      horn.read(1 + hornSwing * (1 - hfR) * 0.5);
      const hr = horn.out * (1 - hornAm + hornAm * (0.5 + 0.5 * hfR));
      dullL += (hl - dullL) * (dullFar + (dullNear - dullFar) * (0.5 + 0.5 * hfL));
      dullR += (hr - dullR) * (dullFar + (dullNear - dullFar) * (0.5 + 0.5 * hfR));
      // the drum
      const dfL = Math.cos(drumAngle + half);
      const dfR = Math.cos(drumAngle - half);
      drum.read(1 + drumSwing * (1 - dfL) * 0.5);
      const dl = drum.out * (1 - drumAm + drumAm * (0.5 + 0.5 * dfL));
      drum.read(1 + drumSwing * (1 - dfR) * 0.5);
      const dr = drum.out * (1 - drumAm + drumAm * (0.5 + 0.5 * dfR));
      const wl = dullL * hornMake + dl * drumMake;
      const wr = dullR * hornMake + dr * drumMake;
      l[i] = a * (1 - mix) + (wl * keep + wr * cross) * mix;
      r[i] = b * (1 - mix) + (wr * keep + wl * cross) * mix;
    }
    this.hornHz = hornHz;
    this.drumHz = drumHz;
    this.hornAngle = hornAngle;
    this.drumAngle = drumAngle;
    this.dullL = Math.abs(dullL) < 1e-20 ? 0 : dullL;
    this.dullR = Math.abs(dullR) < 1e-20 ? 0 : dullR;
  }
  reset(): void {
    this.horn.clear();
    this.drum.clear();
    for (const f of [this.lp1, this.lp2, this.hp1, this.hp2]) f.reset();
    this.dullL = this.dullR = 0;
  }
}

const PHASER_MAX = 12;

/**
 * Phaser: the sound through a chain of first-order all-passes whose corner sweeps between Low and
 * High (evenly in octaves, as far as Depth reaches), mixed with itself: each pair of stages makes a
 * notch that moves. Feedback deepens them (negative feedback moves them over), and the right side's
 * sweep runs a little behind the left's.
 */
export class Phaser implements Effect {
  gr = 0;
  private rate = 0.4;
  private depth = 0.8;
  private logMid = 0;
  private logSpan = 0;
  private feedback = 0.4;
  private stages = 4;
  private spread = 0.25;
  private mix = 0.5;
  private phase = 0;
  private readonly xl = new Float64Array(PHASER_MAX);
  private readonly yl = new Float64Array(PHASER_MAX);
  private readonly xr = new Float64Array(PHASER_MAX);
  private readonly yr = new Float64Array(PHASER_MAX);
  private lastL = 0;
  private lastR = 0;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('phaser', p, id);
    this.rate = v('rate');
    this.depth = v('depth') / 100;
    const lo = Math.min(v('low'), v('high'));
    const hi = Math.max(v('low'), v('high'));
    this.logMid = 0.5 * (Math.log(lo) + Math.log(hi));
    this.logSpan = Math.log(hi / lo);
    this.feedback = v('feedback') / 100;
    this.stages = [2, 4, 6, 8, 10, 12][Math.round(v('stages'))] ?? 4;
    this.spread = v('spread') / 100;
    this.mix = v('mix') / 100;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const sr = this.host.sr;
    const nyq = sr * 0.45;
    const { xl, yl, xr, yr, stages, feedback, mix, depth, logMid, logSpan } = this;
    const step = this.rate / sr;
    const offset = this.spread * 0.5;
    let { phase, lastL, lastR } = this;
    for (let i = 0; i < n; i++) {
      phase += step;
      if (phase >= 1) phase -= 1;
      const wl = 0.5 - 0.5 * Math.cos(TAU * phase);
      const wr = 0.5 - 0.5 * Math.cos(TAU * (phase + offset));
      const fl = Math.min(nyq, Math.exp(logMid + (wl - 0.5) * depth * logSpan));
      const fr = Math.min(nyq, Math.exp(logMid + (wr - 0.5) * depth * logSpan));
      const tl = Math.tan((Math.PI * fl) / sr);
      const tr = Math.tan((Math.PI * fr) / sr);
      const al = (tl - 1) / (tl + 1);
      const ar = (tr - 1) / (tr + 1);
      const a = l[i] as number;
      const b = r[i] as number;
      let sl = a + feedback * lastL;
      let sr2 = b + feedback * lastR;
      for (let k = 0; k < stages; k++) {
        const ol = al * sl + (xl[k] as number) - al * (yl[k] as number);
        xl[k] = sl;
        yl[k] = ol;
        sl = ol;
        const or = ar * sr2 + (xr[k] as number) - ar * (yr[k] as number);
        xr[k] = sr2;
        yr[k] = or;
        sr2 = or;
      }
      lastL = sl;
      lastR = sr2;
      l[i] = a * (1 - mix) + sl * mix;
      r[i] = b * (1 - mix) + sr2 * mix;
    }
    this.phase = phase;
    this.lastL = Math.abs(lastL) < 1e-20 ? 0 : lastL;
    this.lastR = Math.abs(lastR) < 1e-20 ? 0 : lastR;
    for (let k = 0; k < stages; k++) {
      if (Math.abs(yl[k] as number) < 1e-20) yl[k] = 0;
      if (Math.abs(yr[k] as number) < 1e-20) yr[k] = 0;
    }
  }
  reset(): void {
    this.xl.fill(0);
    this.yl.fill(0);
    this.xr.fill(0);
    this.yr.fill(0);
    this.lastL = this.lastR = 0;
  }
}

/**
 * Tremolo and auto-pan: a slow wave (sine, triangle or square, its corners rounded so it never
 * clicks) that turns the level down and up, or moves the sound between the sides at constant power.
 * In time with the song, the wave keeps to the beat while the song plays (its phase is the song's),
 * and runs on freely while it's stopped.
 */
export class Tremolo implements Effect {
  gr = 0;
  private pan = false;
  private sync = true;
  private division = 0.5;
  private rate = 4;
  private depth = 0.5;
  private shape = 0;
  private phase = 0;
  private lastBeat = Number.NaN;
  private w = Number.NaN;
  private readonly smooth: number;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    this.smooth = toward(0.0015, host.sr);
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('tremolo', p, id);
    this.pan = v('mode') >= 0.5;
    this.sync = v('sync') >= 0.5;
    this.division = DIVISION_BEATS[Math.round(v('division'))] ?? 0.5;
    this.rate = v('rate');
    this.depth = v('depth') / 100;
    this.shape = Math.round(v('shape'));
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const sr = this.host.sr;
    let hz = this.rate;
    if (this.sync) {
      const beatSec = this.host.beatSeconds();
      hz = 1 / Math.max(1e-3, this.division * beatSec);
      // the song moved since the last block (it plays, or the playhead was put elsewhere): its phase
      const beat = this.host.beatAt?.();
      if (beat !== undefined && beat !== this.lastBeat) {
        const turns = beat / this.division;
        this.phase = turns - Math.floor(turns);
      }
      this.lastBeat = beat ?? Number.NaN;
    }
    const step = hz / sr;
    const { depth, shape, smooth, pan } = this;
    let { phase, w } = this;
    if (Number.isNaN(w)) w = 1;
    for (let i = 0; i < n; i++) {
      // the wave from 0 to 1, starting at its top on the beat
      const target =
        shape === 0
          ? 0.5 + 0.5 * Math.cos(TAU * phase)
          : shape === 1
            ? phase < 0.5
              ? 1 - 2 * phase
              : 2 * phase - 1
            : phase < 0.5
              ? 1
              : 0;
      w += (target - w) * smooth;
      phase += step;
      if (phase >= 1) phase -= 1;
      if (pan) {
        const angle = ((1 + depth * (2 * w - 1)) * Math.PI) / 4;
        l[i] = (l[i] as number) * Math.cos(angle) * Math.SQRT2;
        r[i] = (r[i] as number) * Math.sin(angle) * Math.SQRT2;
      } else {
        const g = 1 - depth * (1 - w);
        l[i] = (l[i] as number) * g;
        r[i] = (r[i] as number) * g;
      }
    }
    this.phase = phase;
    this.w = w;
  }
  reset(): void {
    this.w = Number.NaN;
    this.lastBeat = Number.NaN;
  }
}

/** Lo-fi's wow at full: about 0.8% of pitch at its slowest swing. */
const LOFI_WOW = 0.008;
const LOFI_WOW_HZ = 0.55;

/**
 * Lo-fi: a worn tape's wow (a delay that drifts, two slow waves and a little flutter), then a cheap
 * sampler's lower rate (each sample held until the next is due, so what's above half the rate folds
 * back down) and fewer bits, a little hiss, and a tone control's low pass; mixed with the sound as it
 * came in.
 */
export class Lofi implements Effect {
  gr = 0;
  private levels = 2048;
  private rate = 22050;
  private wowTarget = 0;
  private wow = 0;
  private noise = 0;
  private useTone = false;
  private mix = 1;
  private readonly tone = new Biquad();
  private readonly line: Line;
  private readonly lineR: Line;
  private readonly hiss = new Noise(31337);
  private readonly wowSmooth: number;
  private t = 0;
  private hold = 1;
  private heldL = 0;
  private heldR = 0;
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    // room for the widest swing, and for a whole block (the dry sound is read back from it)
    const most = Math.max(2048, (LOFI_WOW / (TAU * LOFI_WOW_HZ)) * host.sr * 2.4 + 8);
    this.line = new Line(most);
    this.lineR = new Line(most);
    this.wowSmooth = toward(0.05, host.sr);
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('lofi', p, id);
    const sr = this.host.sr;
    this.levels = 2 ** (v('bits') - 1);
    this.rate = Math.min(sr, v('rate'));
    // the swing (frames) that moves the pitch by Wow at its slowest wave
    this.wowTarget = ((v('wow') / 100) * LOFI_WOW * sr) / (TAU * LOFI_WOW_HZ);
    this.noise = v('noise') <= -89.9 ? 0 : dbToGain(v('noise'));
    this.useTone = v('tone') < 19999;
    this.tone.set('lowpass', v('tone'), Math.SQRT1_2, 0, sr);
    this.mix = v('mix') / 100;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const sr = this.host.sr;
    const { line, lineR, levels, noise, hiss, mix, wowTarget, wowSmooth } = this;
    const crush = levels < 32768;
    const inc = this.rate / sr;
    const down = inc < 0.9999;
    const inv = 1 / levels;
    let { t, hold, heldL, heldR, wow } = this;
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      let yl = a;
      let yr = b;
      wow += (wowTarget - wow) * wowSmooth;
      if (wow > 1e-3) {
        const s = t / sr;
        const drift =
          0.75 * Math.sin(TAU * LOFI_WOW_HZ * s) + 0.25 * Math.sin(TAU * 1.37 * s + 1) + 0.06 * Math.sin(TAU * 6.3 * s);
        line.write(a);
        lineR.write(b);
        const d = 2 + wow * (1.1 + drift);
        line.read(d);
        lineR.read(d);
        yl = line.out;
        yr = lineR.out;
      } else {
        line.write(a);
        lineR.write(b);
      }
      t++;
      if (t >= 1e9) t -= 1e9;
      if (down) {
        hold += inc;
        if (hold >= 1) {
          hold -= 1;
          heldL = yl;
          heldR = yr;
        }
        yl = heldL;
        yr = heldR;
      }
      if (crush) {
        yl = Math.round(yl * levels) * inv;
        yr = Math.round(yr * levels) * inv;
      }
      if (noise > 0) {
        hiss.step();
        const h = hiss.value * noise;
        hiss.step();
        yl += h;
        yr += hiss.value * noise;
      }
      l[i] = yl;
      r[i] = yr;
    }
    this.t = t;
    this.hold = hold;
    this.heldL = heldL;
    this.heldR = heldR;
    this.wow = wow;
    if (this.useTone) this.tone.process(l, r, n);
    if (mix < 1) {
      // (the dry sound is the line's newest frames: what came in this block)
      for (let i = 0; i < n; i++) {
        line.read(n - 1 - i);
        lineR.read(n - 1 - i);
        l[i] = line.out * (1 - mix) + (l[i] as number) * mix;
        r[i] = lineR.out * (1 - mix) + (r[i] as number) * mix;
      }
    }
  }
  reset(): void {
    this.line.clear();
    this.lineR.clear();
    this.tone.reset();
    this.heldL = this.heldR = 0;
  }
}
