/**
 * Drum Machine: four synthesised kits in the manner of the classic analog drum machines, laid out
 * on the General MIDI drum keys like every kit here.
 *
 * - Analog Machine: a long, booming sine kick that falls in pitch, a snare of two tuned bodies and
 *   hissing noise, a clap of quick bursts and a little room, metallic hats and cymbals from six
 *   detuned square waves, a two-tone cowbell, and toms that drop as they ring.
 * - Punch Machine: a shorter, harder kick with a click on top, a brighter snare that snaps, and
 *   crisper hats: for house and techno.
 * - Lo-fi Machine: the analog kit through a few bits and a low sample rate, its top rolled off.
 * - Hand Machine: hand percussion: congas, bongos, claves, wood, shakers and a soft low drum.
 *
 * Its six knobs (SYNTH_MACROS) move while it plays: Tune, Decay, Snap (the noise and click in the
 * attack), Tone, Drive and Width (how far apart the pieces sit).
 */
import { macroValues } from '@holo/session';
import { Noise } from './dsp.ts';
import { type Controls, Instrument, type Voice } from './instrument.ts';

interface MachineParams {
  tune: number;
  decay: number;
  snap: number;
  tone: number;
  drive: number;
  width: number;
  /** 0 analog, 1 punch, 2 lo-fi, 3 hand. */
  kit: number;
  level: number;
}

const PRESETS: Record<string, Pick<MachineParams, 'kit' | 'level'>> = {
  'Analog Machine': { kit: 0, level: 1.1 },
  'Punch Machine': { kit: 1, level: 1.15 },
  'Lo-fi Machine': { kit: 2, level: 1.2 },
  'Hand Machine': { kit: 3, level: 1.1 },
};

export const MACHINE_PRESETS = Object.keys(PRESETS);

function resolve(preset: string, params?: Record<string, number>): MachineParams {
  const name = PRESETS[preset] ? preset : 'Analog Machine';
  return { ...(PRESETS[name] as MachineParams), ...macroValues(name, params) } as MachineParams;
}

/** What a piece is made of. */
const Kind = {
  Kick: 0,
  Snare: 1,
  Clap: 2,
  Rim: 3,
  Hat: 4,
  Cymbal: 5,
  Tom: 6,
  Cowbell: 7,
  Wood: 8,
  Hand: 9,
  Shaker: 10,
} as const;
type Kind = (typeof Kind)[keyof typeof Kind];

interface Piece {
  kind: Kind;
  /** The body's pitch (hertz), and how far it starts above it (a ratio) and how fast it falls (s). */
  freq: number;
  sweep: number;
  sweepTime: number;
  /** Seconds to fall 60 dB: the body and the noise. */
  decay: number;
  noiseDecay: number;
  /** Noise and click levels against the body. */
  noise: number;
  click: number;
  /** A band for the noise or metal: centre (hertz) and how narrow (0..1). */
  band: number;
  q: number;
  level: number;
  /** Where it sits, -1..1 (before Width). */
  pan: number;
  /** Open hats, which a closed or pedal hat cuts off. */
  open?: boolean;
  /** A closed or pedal hat. */
  closes?: boolean;
}

const METAL = [205.3, 304.4, 369.6, 522.7, 540.0, 800.0];

function piece(kit: number, key: number): Piece | null {
  const punch = kit === 1;
  const hand = kit === 3;
  const p = (o: Partial<Piece> & Pick<Piece, 'kind'>): Piece => ({
    freq: 100,
    sweep: 1,
    sweepTime: 0.02,
    decay: 0.3,
    noiseDecay: 0.1,
    noise: 0,
    click: 0,
    band: 5000,
    q: 0.3,
    level: 1,
    pan: 0,
    ...o,
  });
  if (hand) {
    switch (key) {
      case 35:
      case 36:
        return p({ kind: Kind.Tom, freq: 62, sweep: 1.4, sweepTime: 0.04, decay: 0.5, click: 0.15, level: 0.9 });
      case 60:
        return p({
          kind: Kind.Hand,
          freq: 400,
          sweep: 1.08,
          sweepTime: 0.01,
          decay: 0.16,
          click: 0.4,
          level: 0.6,
          pan: 0.3,
        });
      case 61:
        return p({
          kind: Kind.Hand,
          freq: 300,
          sweep: 1.08,
          sweepTime: 0.01,
          decay: 0.2,
          click: 0.35,
          level: 0.6,
          pan: 0.2,
        });
      case 62:
        return p({
          kind: Kind.Hand,
          freq: 330,
          sweep: 1.05,
          sweepTime: 0.01,
          decay: 0.07,
          click: 0.6,
          noise: 0.2,
          level: 0.55,
          pan: -0.25,
        });
      case 63:
        return p({
          kind: Kind.Hand,
          freq: 330,
          sweep: 1.06,
          sweepTime: 0.01,
          decay: 0.3,
          click: 0.35,
          level: 0.6,
          pan: -0.25,
        });
      case 64:
        return p({
          kind: Kind.Hand,
          freq: 220,
          sweep: 1.06,
          sweepTime: 0.012,
          decay: 0.38,
          click: 0.3,
          level: 0.65,
          pan: -0.4,
        });
      case 69:
      case 70:
        return p({
          kind: Kind.Shaker,
          decay: 0.07,
          noiseDecay: 0.07,
          noise: 1,
          band: 7500,
          q: 0.2,
          level: 0.35,
          pan: 0.45,
        });
      case 54:
        return p({
          kind: Kind.Shaker,
          decay: 0.2,
          noiseDecay: 0.2,
          noise: 1,
          band: 9000,
          q: 0.4,
          level: 0.35,
          pan: -0.4,
        });
      case 75:
        return p({ kind: Kind.Wood, freq: 2500, decay: 0.05, level: 0.45, pan: 0.5 });
      case 76:
        return p({ kind: Kind.Wood, freq: 1100, decay: 0.07, level: 0.5, pan: -0.15 });
      case 77:
        return p({ kind: Kind.Wood, freq: 760, decay: 0.08, level: 0.5, pan: 0.15 });
      case 56:
        return p({ kind: Kind.Cowbell, freq: 560, decay: 0.25, level: 0.4, pan: 0.35 });
      case 37:
      case 39:
        return p({ kind: Kind.Clap, noise: 1, noiseDecay: 0.12, band: 1400, q: 0.5, level: 0.55 });
      // the cymbal keys: a long cabasa, a tambourine and two agogo-like bells
      case 49:
      case 57:
        return p({
          kind: Kind.Shaker,
          decay: 0.45,
          noiseDecay: 0.45,
          noise: 1,
          band: 6500,
          q: 0.25,
          level: 0.3,
          pan: -0.5,
        });
      case 52:
      case 55:
        return p({
          kind: Kind.Shaker,
          decay: 0.3,
          noiseDecay: 0.3,
          noise: 1,
          band: 9500,
          q: 0.45,
          level: 0.3,
          pan: 0.5,
        });
      case 51:
      case 53:
        return p({ kind: Kind.Cowbell, freq: 880, decay: 0.3, level: 0.3, pan: 0.45 });
      case 59:
        return p({ kind: Kind.Cowbell, freq: 660, decay: 0.3, level: 0.3, pan: -0.45 });
      default:
        if (key >= 38 && key <= 53)
          return p({
            kind: Kind.Hand,
            freq: 180 * 2 ** ((key - 45) / 12),
            sweep: 1.06,
            sweepTime: 0.012,
            decay: 0.3,
            click: 0.3,
            level: 0.6,
          });
        return null;
    }
  }
  switch (key) {
    case 35:
    case 36:
      return punch
        ? p({
            kind: Kind.Kick,
            freq: 52,
            sweep: 5,
            sweepTime: 0.022,
            decay: 0.45,
            click: 0.5,
            noise: 0.08,
            noiseDecay: 0.01,
            band: 3500,
            level: 1,
          })
        : p({ kind: Kind.Kick, freq: 49, sweep: 2.6, sweepTime: 0.03, decay: 1.1, click: 0.15, level: 1 });
    case 37:
      return p({ kind: Kind.Rim, freq: 1700, decay: 0.03, click: 0.6, level: 0.5, pan: 0.1 });
    case 38:
    case 40:
      return punch
        ? p({
            kind: Kind.Snare,
            freq: 200,
            sweep: 1.4,
            sweepTime: 0.01,
            decay: 0.12,
            noise: 1.1,
            noiseDecay: 0.2,
            band: 5200,
            q: 0.25,
            level: 0.75,
          })
        : p({
            kind: Kind.Snare,
            freq: 180,
            sweep: 1.25,
            sweepTime: 0.012,
            decay: 0.16,
            noise: 0.85,
            noiseDecay: 0.18,
            band: 3800,
            q: 0.3,
            level: 0.75,
          });
    case 39:
      return p({
        kind: Kind.Clap,
        noise: 1,
        noiseDecay: punch ? 0.16 : 0.22,
        band: 1200,
        q: 0.55,
        level: 0.7,
        pan: -0.05,
      });
    case 42:
      return p({
        kind: Kind.Hat,
        decay: punch ? 0.045 : 0.06,
        band: punch ? 9500 : 8000,
        q: 0.35,
        level: 0.42,
        pan: 0.3,
        closes: true,
      });
    case 44:
      return p({ kind: Kind.Hat, decay: 0.035, band: 7500, q: 0.35, level: 0.32, pan: 0.3, closes: true });
    case 46:
      return p({
        kind: Kind.Hat,
        decay: punch ? 0.35 : 0.5,
        band: punch ? 9500 : 8000,
        q: 0.3,
        level: 0.38,
        pan: 0.3,
        open: true,
      });
    case 49:
    case 57:
      return p({
        kind: Kind.Cymbal,
        decay: 1.6,
        noise: 0.5,
        noiseDecay: 1.2,
        band: 7000,
        q: 0.15,
        level: 0.4,
        pan: key === 49 ? -0.45 : 0.5,
      });
    case 52:
    case 55:
      return p({
        kind: Kind.Cymbal,
        decay: key === 55 ? 0.6 : 1.2,
        noise: 0.7,
        noiseDecay: 0.8,
        band: 6000,
        q: 0.2,
        level: 0.35,
        pan: -0.6,
      });
    case 51:
    case 59:
      return p({
        kind: Kind.Cymbal,
        decay: 1.4,
        noise: 0.15,
        noiseDecay: 0.6,
        band: 9000,
        q: 0.45,
        level: 0.3,
        pan: 0.45,
      });
    case 53:
      return p({ kind: Kind.Cowbell, freq: 760, decay: 0.8, level: 0.25, pan: 0.45 });
    case 54:
      return p({
        kind: Kind.Shaker,
        decay: 0.25,
        noiseDecay: 0.25,
        noise: 1,
        band: 9000,
        q: 0.45,
        level: 0.32,
        pan: -0.35,
      });
    case 56:
      return p({ kind: Kind.Cowbell, freq: 540, decay: punch ? 0.2 : 0.3, level: 0.4, pan: 0.25 });
    case 69:
    case 70:
      return p({
        kind: Kind.Shaker,
        decay: 0.06,
        noiseDecay: 0.06,
        noise: 1,
        band: 8000,
        q: 0.2,
        level: 0.3,
        pan: 0.4,
      });
    case 75:
      return p({ kind: Kind.Wood, freq: 2500, decay: 0.05, level: 0.4, pan: 0.4 });
    case 76:
    case 77:
      return p({
        kind: Kind.Wood,
        freq: key === 76 ? 1100 : 800,
        decay: 0.07,
        level: 0.4,
        pan: key === 76 ? -0.2 : 0.2,
      });
    default: {
      if (key >= 60 && key <= 64)
        return p({
          kind: Kind.Hand,
          freq: [400, 300, 330, 330, 220][key - 60] as number,
          sweep: 1.08,
          sweepTime: 0.01,
          decay: 0.2,
          click: 0.3,
          level: 0.5,
        });
      // the toms, and any other key: a tom tuned by the key
      const step = key >= 41 && key <= 50 ? ([0, 0, 2, 0, 3, 0, 5, 7, 0, 9][key - 41] ?? 0) : (key - 45) / 2;
      const freq = (punch ? 95 : 85) * 2 ** (step / 8);
      return p({
        kind: Kind.Tom,
        freq,
        sweep: 1.5,
        sweepTime: 0.06,
        decay: punch ? 0.35 : 0.55,
        click: 0.1,
        noise: 0.06,
        noiseDecay: 0.03,
        band: 2500,
        level: 0.7,
        pan: Math.max(-0.6, Math.min(0.6, (step - 4) * 0.12)),
      });
    }
  }
}

const TAU = Math.PI * 2;

class MachineVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  readonly piece: Piece;
  private readonly p: MachineParams;
  private readonly sr: number;
  private readonly vel: number;
  private readonly noise: Noise;
  private ph = 0;
  private readonly mph = new Float64Array(6);
  private t = 0;
  private body = 1;
  private nz = 1;
  private bodyK = 1;
  private nzK = 1;
  private freq = 0;
  private sweepK = 1;
  private sweepNow = 1;
  // the noise and metal band-pass (state-variable, fixed for the hit)
  private bG = 0;
  private bK = 1;
  private b1 = 0;
  private b2 = 0;
  private choke = 1;
  private choking = false;
  private gl = 1;
  private gr = 1;

  constructor(p: MachineParams, key: number, velocity: number, sr: number, seed: number, piece: Piece) {
    this.p = p;
    this.sr = sr;
    this.key = key;
    this.piece = piece;
    this.vel = velocity / 127;
    this.noise = new Noise(seed * 3301 + key);
    for (let j = 0; j < 6; j++) this.mph[j] = ((seed * (j + 3)) % 17) / 17;
    this.setup();
  }

  private setup(): void {
    const p = this.p;
    const pc = this.piece;
    const sr = this.sr;
    const tune = 2 ** (p.tune / 12);
    this.freq = pc.freq * tune * (1 + (this.vel - 0.8) * 0.03);
    this.sweepNow = pc.sweep * (0.85 + 0.3 * this.vel);
    this.sweepK = Math.exp(-1 / (pc.sweepTime * sr));
    this.bodyK = Math.exp(-6.91 / (pc.decay * p.decay * sr));
    this.nzK = Math.exp(-6.91 / (pc.noiseDecay * Math.sqrt(p.decay) * sr));
    const band = Math.min(sr * 0.45, pc.band * tune * 2 ** ((p.tone - 0.5) * 1.6));
    this.bG = Math.tan((Math.PI * band) / sr);
    this.bK = 2 - 1.85 * pc.q;
    const pan = Math.max(-1, Math.min(1, pc.pan * p.width * 1.6));
    this.gl = Math.min(1, 1 - pan);
    this.gr = Math.min(1, 1 + pan);
  }

  retime(): void {
    this.setup();
  }

  release(): void {
    // a hit plays out whatever the key does
    this.released = true;
  }

  /** Cut off by a closed hat. */
  chokeNow(): void {
    this.choking = true;
  }

  kill(): void {
    this.released = true;
    this.choking = true;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const p = this.p;
    const pc = this.piece;
    const sr = this.sr;
    const noise = this.noise;
    const snap = 0.4 + 1.2 * p.snap;
    const gain = pc.level * p.level * (0.25 + 0.75 * this.vel * this.vel) * ctl.expression;
    const drive = 1 + p.drive * 5;
    const driveOut = 1 / (1 + p.drive * 1.6);
    const g = this.bG;
    const k = this.bK;
    const a1 = 1 / (1 + g * (g + k));
    for (let i = start; i < end; i++) {
      const t = this.t++;
      let x = 0;
      // the band-passed noise, shared by the snare, clap, hats, cymbals, shakers
      let n = 0;
      if (pc.noise > 0 || pc.kind === Kind.Hat || pc.kind === Kind.Cymbal) {
        noise.step();
        let src = noise.value;
        if (pc.kind === Kind.Hat || pc.kind === Kind.Cymbal) {
          // six detuned square waves: the metal
          let m = 0;
          for (let j = 0; j < 6; j++) {
            let ph =
              (this.mph[j] as number) +
              ((METAL[j] as number) * (pc.kind === Kind.Cymbal ? 1.47 : 1) * 2 ** (p.tune / 12)) / sr;
            if (ph >= 1) ph -= 1;
            this.mph[j] = ph;
            m += ph < 0.5 ? 1 : -1;
          }
          src = m / 6 + noise.value * pc.noise;
        }
        const v3 = src - this.b2;
        const v1 = a1 * this.b1 + g * a1 * v3;
        const v2 = this.b2 + g * v1;
        this.b1 = 2 * v1 - this.b1;
        this.b2 = 2 * v2 - this.b2;
        n = pc.kind === Kind.Hat || pc.kind === Kind.Cymbal ? src - k * v1 - v2 : v1;
      }
      switch (pc.kind) {
        case Kind.Kick:
        case Kind.Tom:
        case Kind.Hand: {
          this.sweepNow = 1 + (this.sweepNow - 1) * this.sweepK;
          this.ph += (this.freq * this.sweepNow) / sr;
          if (this.ph >= 1) this.ph -= 1;
          x = Math.sin(TAU * this.ph) * this.body;
          if (pc.click > 0 && t < sr * 0.004) x += (1 - t / (sr * 0.004)) * pc.click * snap * (t & 1 ? 0.6 : -0.6);
          x += n * pc.noise * this.nz * snap;
          break;
        }
        case Kind.Snare: {
          this.sweepNow = 1 + (this.sweepNow - 1) * this.sweepK;
          this.ph += (this.freq * this.sweepNow) / sr;
          if (this.ph >= 1) this.ph -= 1;
          const b = Math.sin(TAU * this.ph) * 0.6 + Math.sin(TAU * this.ph * 1.86) * 0.35;
          x = b * this.body + n * pc.noise * this.nz * snap * 1.4;
          break;
        }
        case Kind.Clap: {
          // three quick bursts, then the tail
          const ms = (t / sr) * 1000;
          const burst = ms < 30 ? (ms % 10 < 1.2 ? 1 : Math.exp(-(ms % 10) / 2.2)) : this.nz;
          x = n * burst * 2.2 * (0.5 + 0.5 * snap);
          break;
        }
        case Kind.Rim:
        case Kind.Wood: {
          this.ph += this.freq / sr;
          if (this.ph >= 1) this.ph -= 1;
          x = (Math.sin(TAU * this.ph) + (pc.kind === Kind.Rim ? 0.5 * Math.sin(TAU * this.ph * 0.29) : 0)) * this.body;
          break;
        }
        case Kind.Cowbell: {
          this.ph += this.freq / sr;
          if (this.ph >= 1) this.ph -= 1;
          let p2 = (this.mph[0] as number) + (this.freq * 1.48) / sr;
          if (p2 >= 1) p2 -= 1;
          this.mph[0] = p2;
          x = ((this.ph < 0.5 ? 1 : -1) + (p2 < 0.5 ? 1 : -1)) * 0.35 * this.body;
          break;
        }
        case Kind.Hat:
        case Kind.Cymbal:
          x = n * this.body * (0.6 + 0.6 * snap * (t < sr * 0.01 ? 1.5 : 1));
          break;
        case Kind.Shaker:
          x = n * this.nz * 1.8;
          break;
      }
      this.body *= this.bodyK;
      this.nz *= this.nzK;
      if (this.choking) {
        this.choke *= 0.992;
        if (this.choke < 1e-3) {
          this.done = true;
          return;
        }
      }
      // the machine's output stage: pushed, it rounds off
      let y = x * drive;
      y = (y < -3 ? -1 : y > 3 ? 1 : (y * (27 + y * y)) / (27 + 9 * y * y)) * driveOut;
      y *= gain * this.choke;
      l[i] = (l[i] as number) + y * this.gl;
      r[i] = (r[i] as number) + y * this.gr;
      if ((t & 127) === 0 && t > 256 && this.body < 1e-4 && this.nz < 1e-4) {
        this.done = true;
        return;
      }
    }
  }
}

/** Every kit's pieces, worked out once for every key. */
const KITS: (Piece | null)[][] = [0, 1, 2, 3].map((kit) => Array.from({ length: 128 }, (_, key) => piece(kit, key)));

export class DrumMachine extends Instrument {
  private readonly p: MachineParams;
  private readonly preset: string;
  private seed = 1;
  private dryL = new Float32Array(0);
  private dryR = new Float32Array(0);
  // the lo-fi kit's converter: held samples, few bits, the top rolled off
  private hold = 0;
  private holdL = 0;
  private holdR = 0;
  private lpL = 0;
  private lpR = 0;

  constructor(sr: number, preset: string, params?: Record<string, number>) {
    super(sr);
    this.preset = preset;
    this.p = resolve(preset, params);
    this.maxVoices = 48;
  }

  update(params?: Record<string, number>): void {
    Object.assign(this.p, resolve(this.preset, params));
    for (const v of this.voices as MachineVoice[]) if (!v.done) v.retime();
  }

  protected startVoice(key: number, velocity: number): Voice | null {
    const pc = (KITS[this.p.kit] as (Piece | null)[])[key];
    if (!pc) return null;
    if (pc.closes) {
      for (const v of this.voices as MachineVoice[]) if (!v.done && v.piece.open) v.chokeNow();
    }
    // a piece struck again cuts its last hit short (as a machine's voice does)
    for (const v of this.voices as MachineVoice[]) if (!v.done && v.key === key) v.chokeNow();
    return new MachineVoice(this.p, key, velocity, this.sr, this.seed++, pc);
  }

  override render(l: Float32Array, r: Float32Array, start: number, end: number): void {
    // the lo-fi converter only while there's something through it (its filters left running on
    // silence would decay into denormals, which are slow)
    if (this.p.kit !== 2 || (super.active === 0 && Math.abs(this.lpL) + Math.abs(this.lpR) < 1e-7)) {
      this.lpL = this.lpR = 0;
      super.render(l, r, start, end);
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
    // about 12 kHz and 8 bits, Tone opening the rate a little
    const every = Math.max(1, Math.round(this.sr / (9000 + 9000 * this.p.tone)));
    const steps = 128;
    const lp = 1 - Math.exp((-TAU * (4500 + 5000 * this.p.tone)) / this.sr);
    for (let i = start; i < end; i++) {
      if (this.hold++ % every === 0) {
        this.holdL = Math.round((dl[i] as number) * steps) / steps;
        this.holdR = Math.round((dr[i] as number) * steps) / steps;
      }
      this.lpL += (this.holdL - this.lpL) * lp;
      this.lpR += (this.holdR - this.lpR) * lp;
      l[i] = (l[i] as number) + this.lpL;
      r[i] = (r[i] as number) + this.lpR;
    }
  }
}
