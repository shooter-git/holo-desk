/**
 * Electric keys, modelled: three electromechanical keyboards, each a struck or plucked vibrating body
 * read by a pickup, with the pickup's own nonlinearity doing most of the work.
 *
 * - Tine Piano: a hammer strikes a thin tine bolted to a heavy tone bar. The tine's bright overtone
 *   (about six and a quarter times the fundamental, as a clamped bar's is) rings for a moment and
 *   dies; the tone bar keeps the fundamental singing. An electromagnetic pickup sits a little off the
 *   tine's centre, so the louder it's played the more the tine swings across the uneven field: soft,
 *   it's round and bell-like; hard, it barks. Tremolo pans it between the sides.
 * - Reed Piano: a hammer strikes a steel reed in front of an electrostatic pickup. The reed's motion
 *   changes the gap, and the gap's response is lopsided: soft notes are sweet, hard ones snarl. Its
 *   tremolo is in the level, as the originals'.
 * - Clav Keys: a key presses a hammer that pins a string against an anvil; the string rings between
 *   the anvil and its yarn damper, and is read by pickups part-way along it (their position shapes
 *   the tone, as a guitar's do). Let go, and the yarn stops it with a thump.
 *
 * Its six knobs (SYNTH_MACROS) move while it plays.
 */
import { macroValues } from '@holo/session';
import { Noise } from './dsp.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

interface KeysParams {
  // the knobs
  tone: number;
  bark: number;
  decay: number;
  tremolo: number;
  pickup: number;
  stereo: number;
  // the preset's
  /** 0 tine, 1 reed, 2 string. */
  kind: number;
  level: number;
  /** Tremolo: hertz, and whether it pans (rather than swelling the level). */
  tremRate: number;
  tremPan: number;
}

const PRESETS: Record<string, Pick<KeysParams, 'kind' | 'level' | 'tremRate' | 'tremPan'>> = {
  'Tine Piano': { kind: 0, level: 0.34, tremRate: 4.6, tremPan: 1 },
  'Reed Piano': { kind: 1, level: 0.36, tremRate: 5.6, tremPan: 0 },
  'Clav Keys': { kind: 2, level: 0.42, tremRate: 5.2, tremPan: 0 },
};

export const KEYS_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): KeysParams {
  const name = PRESETS[preset] ? preset : 'Tine Piano';
  return { ...(PRESETS[name] as KeysParams), ...macroValues(name, params) } as KeysParams;
}

const TAU = Math.PI * 2;
const hz = (key: number) => 440 * 2 ** ((key - 69) / 12);

/** A decaying sinusoid (a mode), as a two-pole resonator: one multiply-add a sample. */
export class Mode {
  private y1 = 0;
  private y2 = 0;
  private c = 0;
  private r = 0;
  set(freq: number, t60: number, sr: number): void {
    this.r = Math.exp(-6.91 / Math.max(1, t60 * sr));
    this.c = 2 * this.r * Math.cos((TAU * Math.min(freq, sr * 0.45)) / sr);
  }
  /** Damp it (its T60 now `t60`) without losing where it is. */
  damp(freq: number, t60: number, sr: number): void {
    this.set(freq, t60, sr);
  }
  /** Struck: from rest, an impulse of `amp` (its first sample `amp·sin(w)`). */
  strike(amp: number, freq: number, sr: number): void {
    this.y1 = amp * Math.sin((TAU * Math.min(freq, sr * 0.45)) / sr);
    this.y2 = 0;
  }
  step(): number {
    const y = this.c * this.y1 - this.r * this.r * this.y2;
    this.y2 = this.y1;
    this.y1 = y;
    return y;
  }
  get level(): number {
    return Math.abs(this.y1) + Math.abs(this.y2);
  }
}

class TineVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  /** The tone bar (fundamental), the tine's overtone, its second and the hammer's knock. */
  private readonly fund = new Mode();
  private readonly over = new Mode();
  private readonly over2 = new Mode();
  private readonly knock = new Mode();
  private readonly f: number;
  private readonly amp: number;
  private readonly p: KeysParams;
  private readonly sr: number;
  private readonly gl: number;
  private readonly gr: number;
  private dcIn = 0;
  private dcOut = 0;
  private killing = 0;
  private t = 0;

  constructor(p: KeysParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.f = hz(key) * (1 + ((seed * 37) % 11) * 0.00004);
    const v = velocity / 127;
    this.amp = v ** 1.4;
    const pan = Math.max(-1, Math.min(1, ((key - 64) / 30) * p.stereo));
    this.gl = Math.min(1, 1 - pan);
    this.gr = Math.min(1, 1 + pan);
    this.retime();
    this.fund.strike(this.amp, this.f, sr);
    // the overtone is struck harder in the treble and by a harder hammer blow
    this.over.strike(this.amp * (0.25 + 0.5 * v) * (key > 84 ? 0.4 : 1), this.f * 6.267, sr);
    this.over2.strike(this.amp * 0.12 * v, this.f * 17.55, sr);
    this.knock.strike(this.amp * 0.18 * v, 1200 + key * 12, sr);
  }

  retime(): void {
    const p = this.p;
    const sr = this.sr;
    const f = this.f;
    // a long singing tone bar, shorter up the keyboard
    if (this.released) return;
    const t60 = p.decay * 9 * 2 ** (-(this.key - 40) / 26);
    this.fund.set(f, t60, sr);
    this.over.set(f * 6.267, Math.min(0.9, t60 * 0.08), sr);
    this.over2.set(f * 17.55, 0.05, sr);
    this.knock.set(1200 + this.key * 12, 0.012, sr);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    // the felt damper: quick, with less of a grip on the top notes (they have none)
    const t60 = this.key > 92 ? 2 : 0.16 + 0.004 * Math.max(0, this.key - 40);
    this.fund.damp(this.f, t60, this.sr);
    this.over.damp(this.f * 6.267, Math.min(0.05, t60), this.sr);
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, _ctl: Controls): void {
    const p = this.p;
    // the pickup's field is lopsided (its offset is Pickup) and saturates as the tine swings across
    // it (how far: velocity, and Bark)
    const off = 0.12 + 0.5 * p.pickup;
    const push = 1 + 2.2 * p.bark;
    const gain = p.level / Math.sqrt(push);
    for (let i = start; i < end; i++) {
      const u = (this.fund.step() + this.over.step() + this.over2.step()) * push;
      const v = u - off * Math.min(u * u, 2);
      let y = v < -3 ? -1 : v > 3 ? 1 : (v * (27 + v * v)) / (27 + 9 * v * v);
      y += this.knock.step();
      // the even term leaves a level shift: take it out
      const dc = y - this.dcIn + 0.9995 * this.dcOut;
      this.dcIn = y;
      this.dcOut = dc;
      let s = dc * gain;
      if (this.killing > 0) {
        this.killing *= 0.995;
        s *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      l[i] = (l[i] as number) + s * this.gl;
      r[i] = (r[i] as number) + s * this.gr;
      if ((++this.t & 255) === 0 && this.fund.level + this.over.level < 2e-5) {
        this.done = true;
        return;
      }
    }
  }
}

class ReedVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  /** The reed's fundamental and its first two (not quite harmonic) bending modes. */
  private readonly fund = new Mode();
  private readonly m2 = new Mode();
  private readonly m3 = new Mode();
  private readonly knock = new Mode();
  private readonly f: number;
  private readonly amp: number;
  private readonly vel: number;
  private readonly p: KeysParams;
  private readonly sr: number;
  private readonly gl: number;
  private readonly gr: number;
  private dcIn = 0;
  private dcOut = 0;
  private killing = 0;
  private t = 0;

  constructor(p: KeysParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.f = hz(key) * (1 + ((seed * 53) % 13) * 0.00005);
    this.vel = velocity / 127;
    this.amp = this.vel ** 1.3;
    const pan = Math.max(-1, Math.min(1, ((key - 64) / 30) * p.stereo));
    this.gl = Math.min(1, 1 - pan);
    this.gr = Math.min(1, 1 + pan);
    this.retime();
    this.fund.strike(this.amp, this.f, sr);
    this.m2.strike(this.amp * 0.3 * this.vel, this.f * 6.1, sr);
    this.m3.strike(this.amp * 0.08 * this.vel, this.f * 16.9, sr);
    this.knock.strike(this.amp * 0.1 * this.vel, 900 + key * 10, sr);
  }

  retime(): void {
    const p = this.p;
    const sr = this.sr;
    if (this.released) return;
    const t60 = p.decay * 5 * 2 ** (-(this.key - 40) / 22);
    this.fund.set(this.f, t60, sr);
    this.m2.set(this.f * 6.1, Math.min(0.5, t60 * 0.06), sr);
    this.m3.set(this.f * 16.9, 0.03, sr);
    this.knock.set(900 + this.key * 10, 0.01, sr);
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    const t60 = this.key > 90 ? 1.5 : 0.12;
    this.fund.damp(this.f, t60, this.sr);
    this.m2.damp(this.f * 6.1, 0.04, this.sr);
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, _ctl: Controls): void {
    const p = this.p;
    // the electrostatic gap: 1/(1 - c·x) bends one side of the swing harder than the other
    const c = 0.25 + 0.45 * p.pickup;
    const drive = 1 + p.bark * 3 * this.vel;
    const gain = p.level / drive ** 0.6;
    for (let i = start; i < end; i++) {
      const x = (this.fund.step() + this.m2.step() + this.m3.step()) * drive;
      const d = 1 - c * Math.max(-0.95, Math.min(0.95, x));
      let y = x / d;
      // then the preamp, rounding off what's left
      y = y < -3 ? -1 : y > 3 ? 1 : (y * (27 + y * y)) / (27 + 9 * y * y);
      y += this.knock.step();
      const dc = y - this.dcIn + 0.9995 * this.dcOut;
      this.dcIn = y;
      this.dcOut = dc;
      let s = dc * gain;
      if (this.killing > 0) {
        this.killing *= 0.995;
        s *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      l[i] = (l[i] as number) + s * this.gl;
      r[i] = (r[i] as number) + s * this.gr;
      if ((++this.t & 255) === 0 && this.fund.level + this.m2.level < 2e-5) {
        this.done = true;
        return;
      }
    }
  }
}

/** The longest string (in samples) a clav voice needs: its lowest note at 96 kHz. */
const STRING_MAX = 4096;

class ClavVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private readonly line = new Float32Array(STRING_MAX);
  private pos = 0;
  private readonly len: number;
  /** The loop's loss filter (one-pole) and its loss per trip. */
  private lp = 0;
  private loss = 0.999;
  private bright = 0.5;
  private ap = 0;
  private apIn = 0;
  private readonly apCoef: number;
  private readonly p: KeysParams;
  private readonly f: number;
  private readonly vel: number;
  private thump = 0;
  private thumpLp = 0;
  private readonly noise: Noise;
  private killing = 0;
  private quiet = 0;

  constructor(p: KeysParams, key: number, velocity: number, sr: number, seed: number) {
    this.p = p;
    this.key = key;
    this.f = hz(key);
    this.vel = velocity / 127;
    this.noise = new Noise(seed * 9973 + 5);
    // the string's length in samples: whole samples, the rest by a first-order allpass
    const exact = Math.min(STRING_MAX - 2, sr / this.f - 0.5);
    this.len = Math.max(2, Math.floor(exact));
    const frac = exact - this.len;
    this.apCoef = (1 - frac) / (1 + frac);
    this.retime();
    // pinned by the hammer: a short, bright, slightly lopsided bump spread over part of the string
    const n = this.len;
    const width = Math.max(2, Math.round(n * (0.12 - 0.06 * this.vel)));
    const amp = this.vel ** 1.2;
    for (let i = 0; i < n; i++) {
      const u = i / width;
      this.noise.step();
      const bump = u < 1 ? Math.sin(Math.PI * u) : 0;
      this.line[i] = amp * (bump * 0.9 + this.noise.value * 0.12 * this.vel);
    }
  }

  retime(): void {
    const p = this.p;
    const t60 = this.released ? 0.025 : p.decay * 3.2 * 2 ** (-(this.key - 40) / 30);
    // per trip round the string: so that it falls 60 dB in t60
    this.loss = 10 ** (-3 / (t60 * this.f));
    this.bright = 0.25 + 0.6 * p.tone;
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.retime();
    // the yarn closing on the string
    this.thump = 0.12 * this.vel;
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, _ctl: Controls): void {
    const p = this.p;
    const line = this.line;
    const n = this.len;
    // two pickups: Pickup slides from the neck (round) to the bridge (thin and nasal)
    const tapA = Math.max(1, Math.round(n * (0.5 - 0.42 * p.pickup)));
    const tapB = Math.max(1, Math.round(n * 0.08));
    const gain = p.level * (1 + p.bark);
    const loss = this.loss;
    const b = this.bright;
    const ap = this.apCoef;
    for (let i = start; i < end; i++) {
      const at = this.pos;
      const out = line[at] as number;
      // the loop: loss, brightness, and the allpass that tunes it between whole samples
      this.lp += (out - this.lp) * b;
      const fb = this.lp * loss;
      const y = ap * (fb - this.ap) + this.apIn;
      this.apIn = fb;
      this.ap = y;
      line[at] = y;
      this.pos = at + 1 >= n ? 0 : at + 1;
      let ia = at - tapA;
      if (ia < 0) ia += n;
      let ib = at - tapB;
      if (ib < 0) ib += n;
      // a pickup hears the string's motion under it, a difference across its width
      let s = out - (line[ia] as number) * 0.85 + ((line[ib] as number) - out) * 0.35;
      // Bark: the pickups and preamp pushed into a bite
      if (p.bark > 0) {
        const u = s * (1 + p.bark * 4);
        s = (u < -3 ? -1 : u > 3 ? 1 : (u * (27 + u * u)) / (27 + 9 * u * u)) / (1 + p.bark * 2.5);
      }
      if (this.thump > 1e-4) {
        this.noise.step();
        this.thumpLp += (this.noise.value - this.thumpLp) * 0.05;
        s += this.thumpLp * this.thump;
        this.thump *= 0.997;
      }
      s *= gain;
      if (this.killing > 0) {
        this.killing *= 0.995;
        s *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      l[i] = (l[i] as number) + s;
      r[i] = (r[i] as number) + s;
      const a = Math.abs(out);
      this.quiet = a > 3e-5 ? 0 : this.quiet + 1;
      if (this.quiet > n * 2 && this.thump <= 1e-4) {
        this.done = true;
        return;
      }
    }
  }
}

type KeysVoice = TineVoice | ReedVoice | ClavVoice;

export class ElectricKeys extends Instrument {
  private readonly p: KeysParams;
  private readonly preset: string;
  private seed = 1;
  private dryL = new Float32Array(0);
  private dryR = new Float32Array(0);
  private tremPh = 0;
  private toneL = 0;
  private toneR = 0;
  private tone2L = 0;
  private tone2R = 0;

  constructor(sr: number, preset: string, params?: Record<string, number>) {
    super(sr);
    this.preset = preset;
    this.p = resolve(preset, params);
    this.maxVoices = 48;
  }

  update(params?: Record<string, number>): void {
    Object.assign(this.p, resolve(this.preset, params));
    for (const v of this.voices as KeysVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice {
    const p = this.p;
    const seed = this.seed++;
    if (p.kind === 1) return new ReedVoice(p, key, velocity, this.sr, seed);
    if (p.kind === 2) return new ClavVoice(p, key, velocity, this.sr, seed);
    return new TineVoice(p, key, velocity, this.sr, seed);
  }

  override render(l: Float32Array, r: Float32Array, start: number, end: number): void {
    // nothing sounding and the tone filter settled: nothing to do
    if (super.active === 0 && Math.abs(this.tone2L) + Math.abs(this.tone2R) < 1e-7) {
      this.toneL = this.toneR = this.tone2L = this.tone2R = 0;
      return;
    }
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
    // Tone: the amp's treble, a gentle two-pole roll-off from dark to open
    const cutoff = 700 * 2 ** (p.tone * 4.2);
    const c = 1 - Math.exp((-TAU * cutoff) / sr);
    const depth = p.tremolo;
    const step = p.tremRate / sr;
    const pan = p.tremPan > 0;
    const expr = this.controls.expression;
    for (let i = start; i < end; i++) {
      this.toneL += ((dl[i] as number) - this.toneL) * c;
      this.tone2L += (this.toneL - this.tone2L) * c;
      this.toneR += ((dr[i] as number) - this.toneR) * c;
      this.tone2R += (this.toneR - this.tone2R) * c;
      let gl = expr;
      let gr = expr;
      if (depth > 0) {
        this.tremPh += step;
        if (this.tremPh >= 1) this.tremPh -= 1;
        const s = Math.sin(TAU * this.tremPh);
        if (pan) {
          gl *= 1 - depth * 0.5 * (1 + s);
          gr *= 1 - depth * 0.5 * (1 - s);
        } else {
          const g = 1 - depth * 0.5 * (1 + s);
          gl *= g;
          gr *= g;
        }
      }
      l[i] = (l[i] as number) + this.tone2L * gl;
      r[i] = (r[i] as number) + this.tone2R * gr;
    }
  }
}
