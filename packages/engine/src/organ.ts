/**
 * Tonewheel: an electromechanical drawbar organ and its rotating speaker.
 *
 * Every key picks up nine tonewheels, one for each drawbar (16′ to 1′), each a nearly pure sine. The
 * wheels are tuned to the tempered scale (the 1⅗′ and 1⅓′ drawbars take the nearest tempered wheel, so
 * the organ's third and fifth are tempered, not pure), with the small errors a gearbox leaves. The
 * wheels turn all the time: two keys sharing a wheel share its phase, so chords lock together rather
 * than chorus. Above the top wheel the drawbars fold back an octave, and below the bottom one they fold
 * up. A little of every wheel leaks into every key.
 *
 * A key's nine contacts close one after another over a couple of milliseconds, and that (with a
 * spark of noise) is the click. Percussion is a decaying second or third harmonic that only strikes
 * when no other key is held (play legato and it stays quiet), and takes the 1′ drawbar's place. The
 * organ goes through the scanner (vibrato, or vibrato mixed with the dry sound for the chorus), a
 * preamp that overdrives as it's pushed (the expression pedal pushes it too), then the rotating
 * speaker: a horn for the highs and a drum for the lows, each turning at its own speed and taking its
 * own time to speed up and slow down, picked up by two microphones. The mod wheel switches the rotors
 * between slow and fast.
 *
 * Its six knobs (SYNTH_MACROS) move while it plays.
 */
import { macroValues, ORGAN_REGISTRATIONS } from '@holo/session';
import { Noise } from './dsp.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

interface OrganParams {
  // the knobs
  drawbars: number;
  percussion: number;
  click: number;
  vibrato: number;
  rotor: number;
  drive: number;
  // the preset's
  level: number;
}

const PRESETS: Record<string, Pick<OrganParams, 'level'>> = {
  'Tonewheel Jazz': { level: 1 },
  'Tonewheel Gospel': { level: 0.9 },
  'Tonewheel Rock': { level: 0.9 },
  'Tonewheel Ballad': { level: 0.75 },
};

export const ORGAN_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): OrganParams {
  const name = PRESETS[preset] ? preset : 'Tonewheel Jazz';
  return { ...(PRESETS[name] as OrganParams), ...macroValues(name, params) } as OrganParams;
}

/** Semitones from the key to each drawbar's wheel: 16′, 5⅓′, 8′, 4′, 2⅔′, 2′, 1⅗′, 1⅓′, 1′. */
const FOOTAGE = [-12, 7, 0, 12, 19, 24, 28, 31, 36];
/** The lowest and highest wheels (C1 and F#7, as MIDI notes). */
const WHEEL_LO = 24;
const WHEEL_HI = 114;

/** Each wheel's tuning error from its gear ratio: a fraction of a cent, the same on every organ. */
const WHEEL_HZ = new Float64Array(128);
for (let w = 0; w < 128; w++) {
  const err = Math.sin(w * 12.9898) * 0.35; // cents
  WHEEL_HZ[w] = 440 * 2 ** ((w - 69 + err / 100) / 12);
}

function wheelFor(key: number, footage: number): number {
  let w = key + footage;
  while (w > WHEEL_HI) w -= 12;
  while (w < WHEEL_LO) w += 12;
  return w;
}

const TABLE = 4096;
const SINE = new Float32Array(TABLE + 1);
for (let i = 0; i <= TABLE; i++) SINE[i] = Math.sin((2 * Math.PI * i) / TABLE);

/** The registration's nine drawbars as gains: each step on a drawbar is 3 dB. */
function drawbarGains(index: number): number[] {
  const reg = (ORGAN_REGISTRATIONS[index] ?? ORGAN_REGISTRATIONS[0] ?? '888000000').replace(/\s/g, '');
  const out: number[] = [];
  for (let j = 0; j < 9; j++) {
    const n = Number(reg[j] ?? 0);
    out.push(n > 0 ? 10 ** ((-3 * (8 - n)) / 20) : 0);
  }
  return out;
}

/** How loud a wheel that isn't drawn still is (leakage). */
const LEAK = 0.0035;

class OrganVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private readonly ph = new Float64Array(9);
  private readonly inc = new Float64Array(9);
  private readonly gain = new Float64Array(9);
  private readonly gate = new Float64Array(9);
  /** When each contact closes (and opens, once let go), in samples from the start. */
  private readonly openAt = new Int32Array(9);
  private readonly closeAt = new Int32Array(9);
  private t = 0;
  private ramp = 1;
  private perc = 0;
  private percDecay = 1;
  private percGain = 0;
  /** Which drawbar's wheel the percussion sounds (the 4′ or the 2⅔′). */
  private percBar = 3;
  private clickEnv = 0;
  private clickLp = 0;
  private clickHp = 0;
  private readonly clickCoef: number;
  private readonly noise: Noise;
  private readonly p: OrganParams;
  private readonly sr: number;
  private readonly stagger: Float64Array;
  private killing = 0;

  constructor(p: OrganParams, key: number, sr: number, time: number, seed: number, strike: boolean) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.noise = new Noise(seed * 4447 + 3);
    this.clickCoef = Math.exp(-1 / (0.0012 * sr));
    this.stagger = new Float64Array(9);
    for (let j = 0; j < 9; j++) {
      this.noise.step();
      this.stagger[j] = 0.5 + 0.5 * this.noise.value;
      const f = WHEEL_HZ[wheelFor(key, FOOTAGE[j] as number)] as number;
      this.inc[j] = f / sr;
      // the wheels never stop: where this one is now
      const at = (f * time) / sr;
      this.ph[j] = at - Math.floor(at);
    }
    this.retime();
    for (let j = 0; j < 9; j++) this.openAt[j] = Math.round((this.stagger[j] as number) * this.p.click * 0.0025 * sr);
    this.perc = strike && this.p.percussion > 0 ? 1 : 0;
    this.clickEnv = this.p.click;
  }

  /** The drawbars, percussion and click from the knobs (as they are now). */
  retime(): void {
    const p = this.p;
    const gains = drawbarGains(Math.round(p.drawbars));
    const perc = Math.round(p.percussion);
    for (let j = 0; j < 9; j++) {
      // percussion takes the 1′ drawbar's place
      const g = perc > 0 && j === 8 ? 0 : (gains[j] as number);
      this.gain[j] = Math.max(g, LEAK);
    }
    // a hard click is a sudden contact; with Click down, the contacts close softly
    this.ramp = 1 / Math.max(1, (0.004 - 0.0037 * p.click) * this.sr);
    this.percBar = perc === 2 || perc === 4 ? 4 : 3;
    // fast or slow, as the original's (to a sixtieth of its level in about 0.6 s or 2 s)
    const tau = perc >= 3 ? 0.3 : 0.09;
    this.percDecay = Math.exp(-1 / (tau * this.sr));
    this.percGain = perc > 0 ? 0.9 : 0;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    for (let j = 0; j < 9; j++) {
      this.closeAt[j] = this.t + Math.round((this.stagger[j] as number) * this.p.click * 0.0015 * this.sr);
    }
    this.clickEnv = Math.max(this.clickEnv, this.p.click * 0.45);
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
    for (let j = 0; j < 9; j++) this.closeAt[j] = this.t;
  }

  render(l: Float32Array, _r: Float32Array, start: number, end: number, _ctl: Controls): void {
    const ph = this.ph;
    const inc = this.inc;
    const gain = this.gain;
    const gate = this.gate;
    const ramp = this.ramp;
    const released = this.released;
    const percBar = this.percBar;
    const noise = this.noise;
    for (let i = start; i < end; i++) {
      const t = this.t++;
      let x = 0;
      let open = 0;
      for (let j = 0; j < 9; j++) {
        let g = gate[j] as number;
        const shut = released && t >= (this.closeAt[j] as number);
        if (shut) {
          if (g > 0) g = Math.max(0, g - ramp);
        } else if (t >= (this.openAt[j] as number) && g < 1) g = Math.min(1, g + ramp);
        gate[j] = g;
        let p = (ph[j] as number) + (inc[j] as number);
        if (p >= 1) p -= 1;
        ph[j] = p;
        if (g <= 0) continue;
        open++;
        const idx = p * TABLE;
        const k = idx | 0;
        const s = (SINE[k] as number) + ((SINE[k + 1] as number) - (SINE[k] as number)) * (idx - k);
        x += s * (gain[j] as number) * g;
        if (j === percBar && this.perc > 1e-4) x += s * this.perc * this.percGain * g;
      }
      this.perc *= this.percDecay;
      // the spark: noise, band-limited around 2-5 kHz, gone in a few milliseconds
      if (this.clickEnv > 1e-4) {
        noise.step();
        this.clickLp += (noise.value - this.clickLp) * 0.45;
        this.clickHp += (this.clickLp - this.clickHp) * 0.08;
        x += (this.clickLp - this.clickHp) * this.clickEnv * 0.5;
        this.clickEnv *= this.clickCoef;
      }
      if (this.killing > 0) {
        this.killing *= 0.995;
        x *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      l[i] = (l[i] as number) + x;
      if (released && open === 0 && this.clickEnv <= 1e-4) {
        this.done = true;
        return;
      }
    }
  }
}

/** Depths of the scanner's three settings (seconds of delay swing) and whether it's the chorus. */
const SCANNER = [
  { depth: 0, chorus: false },
  { depth: 0.00011, chorus: false },
  { depth: 0.0002, chorus: false },
  { depth: 0.00034, chorus: false },
  { depth: 0.00011, chorus: true },
  { depth: 0.0002, chorus: true },
  { depth: 0.00034, chorus: true },
];

const TAU = Math.PI * 2;

/** The rotating speaker: a horn and a drum, each with its own speed, inertia and two microphones. */
class Rotor {
  private readonly buf = new Float32Array(2048);
  private pos = 0;
  angle = 0;
  speed: number;
  /** Seconds of delay swing (the Doppler), how much the level dips facing away, and the mics' angles. */
  private readonly swing: number;
  private readonly am: number;
  private readonly micR: number;
  private readonly sr: number;
  outL = 0;
  outR = 0;
  constructor(sr: number, swing: number, am: number, micR: number, speed: number, phase: number) {
    this.sr = sr;
    this.swing = swing * sr;
    this.am = am;
    this.micR = micR;
    this.speed = speed;
    this.angle = phase;
  }
  process(x: number): void {
    const buf = this.buf;
    buf[this.pos] = x;
    this.angle += (TAU * this.speed) / this.sr;
    if (this.angle > TAU) this.angle -= TAU;
    const a = this.angle;
    this.outL = this.tap(a);
    this.outR = this.tap(a - this.micR);
    this.pos = (this.pos + 1) & 2047;
  }
  private tap(a: number): number {
    const facing = Math.cos(a);
    const d = 2 + this.swing * (1 - facing) * 0.5;
    let rp = this.pos - d;
    if (rp < 0) rp += 2048;
    const j = Math.floor(rp);
    const f = rp - j;
    const s = (this.buf[j] as number) * (1 - f) + (this.buf[(j + 1) & 2047] as number) * f;
    return s * (1 - this.am + this.am * (0.5 + 0.5 * facing));
  }
}

export class TonewheelOrgan extends Instrument {
  private readonly p: OrganParams;
  private readonly preset: string;
  private seed = 1;
  /** Samples since it was made: where the wheels are. */
  private time = 0;
  private dry = new Float32Array(0);
  private readonly scan = new Float32Array(1024);
  private scanPos = 0;
  private scanPh = 0;
  private xA = 0;
  private xB = 0;
  private readonly horn: Rotor;
  private readonly drum: Rotor;
  private hornHz = 0.8;
  private drumHz = 0.7;
  private tick = 0;
  private toneLp = 0;
  private hornLp = 0;
  private dcIn = 0;
  private dcOut = 0;

  constructor(sr: number, preset: string, params?: Record<string, number>) {
    super(sr);
    this.preset = preset;
    this.p = resolve(preset, params);
    this.maxVoices = 40;
    this.horn = new Rotor(sr, 0.00045, 0.45, Math.PI * 0.65, 0.8, 0);
    this.drum = new Rotor(sr, 0.00018, 0.3, Math.PI * 0.65, 0.7, 1.3);
    const rotor = Math.round(this.p.rotor);
    if (rotor === 2) {
      this.hornHz = 6.8;
      this.drumHz = 5.9;
      this.horn.speed = 6.8;
      this.drum.speed = 5.9;
    }
  }

  update(params?: Record<string, number>): void {
    Object.assign(this.p, resolve(this.preset, params));
    for (const v of this.voices as OrganVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number): Voice {
    // percussion strikes only when no other key is down (single trigger)
    let held = false;
    for (const v of this.voices) {
      if (!v.done && !v.released) {
        held = true;
        break;
      }
    }
    return new OrganVoice(this.p, key, this.sr, this.time, this.seed++, !held);
  }

  override render(l: Float32Array, r: Float32Array, start: number, end: number): void {
    if (end > this.dry.length) this.dry = new Float32Array(end);
    const dry = this.dry;
    dry.fill(0, start, end);
    super.render(dry, dry, start, end);
    this.time += end - start;
    const p = this.p;
    const sr = this.sr;
    const scanner = SCANNER[Math.round(p.vibrato)] ?? (SCANNER[0] as (typeof SCANNER)[number]);
    const depth = scanner.depth * sr;
    const scanStep = 6.86 / sr;
    const rotor = Math.round(p.rotor);
    // the mod wheel swaps slow for fast
    const fast = rotor === 2 ? this.controls.mod < 0.5 : rotor === 1 && this.controls.mod >= 0.5;
    const hornTo = fast ? 6.8 : 0.8;
    const drumTo = fast ? 5.9 : 0.7;
    // the horn is light and gets there in about a second; the drum takes several
    const hornCoef = 1 - Math.exp(-8 / ((hornTo > this.hornHz ? 0.7 : 1.1) * sr));
    const drumCoef = 1 - Math.exp(-8 / ((drumTo > this.drumHz ? 3.5 : 4.5) * sr));
    const pre = (0.13 + p.drive * 1.3) * p.level * this.controls.expression;
    // out of the preamp, set so its level holds roughly steady as it's driven harder
    const post = 0.2 / (0.75 + p.drive * 1.1);
    const bias = 0.18 * p.drive;
    const biasOut = Math.tanh(bias);
    const toneCoef = 1 - Math.exp((-TAU * (5200 - 2400 * p.drive)) / sr);
    const hornCoefLp = 1 - Math.exp((-TAU * 6500) / sr);
    const dcCoef = 1 - (TAU * 25) / sr;
    const xCoef = 1 - Math.exp((-TAU * 800) / sr);
    for (let i = start; i < end; i++) {
      let x = dry[i] as number;
      // the scanner
      if (depth > 0) {
        this.scan[this.scanPos] = x;
        this.scanPh += scanStep;
        if (this.scanPh >= 1) this.scanPh -= 1;
        const tri = this.scanPh < 0.5 ? this.scanPh * 4 - 1 : 3 - this.scanPh * 4;
        let rp = this.scanPos - (24 + depth * (1 + tri));
        if (rp < 0) rp += 1024;
        const j = Math.floor(rp);
        const f = rp - j;
        const wet = (this.scan[j] as number) * (1 - f) + (this.scan[(j + 1) & 1023] as number) * f;
        this.scanPos = (this.scanPos + 1) & 1023;
        x = scanner.chorus ? (x + wet) * 0.6 : wet;
      }
      // the preamp: pushed harder it breaks up, a little unevenly, as valves do
      const u = x * pre * 3 + bias;
      const sat = u < -3 ? -1 : u > 3 ? 1 : (u * (27 + u * u)) / (27 + 9 * u * u);
      let y = (sat - biasOut) * post;
      // its tone falls off as it's driven; then a block of any DC the bias left
      this.toneLp += (y - this.toneLp) * toneCoef;
      y = this.toneLp;
      const dc = y - this.dcIn + dcCoef * this.dcOut;
      this.dcIn = y;
      this.dcOut = dc;
      y = dc;
      if (rotor === 0) {
        l[i] = (l[i] as number) + y;
        r[i] = (r[i] as number) + y;
        continue;
      }
      if ((this.tick++ & 7) === 0) {
        this.hornHz += (hornTo - this.hornHz) * hornCoef;
        this.drumHz += (drumTo - this.drumHz) * drumCoef;
        this.horn.speed = this.hornHz;
        this.drum.speed = this.drumHz;
      }
      // the crossover: two gentle poles at 800 Hz, the highs what's left (so the two add back exactly)
      this.xA += (y - this.xA) * xCoef;
      this.xB += (this.xA - this.xB) * xCoef;
      const low = this.xB;
      this.hornLp += (y - low - this.hornLp) * hornCoefLp;
      this.horn.process(this.hornLp);
      this.drum.process(low);
      l[i] = (l[i] as number) + (this.horn.outL + this.drum.outL) * 1.15;
      r[i] = (r[i] as number) + (this.horn.outR + this.drum.outR) * 1.15;
    }
  }
}
