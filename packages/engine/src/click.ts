/**
 * The metronome's click: one voice, struck on each beat (higher and louder on the first of the bar).
 * The beep is the studio's first click, sample for sample; the others are a few ringing modes and a
 * breath of noise, so they cost next to nothing on the audio thread.
 */

export const CLICK_SOUNDS = ['beep', 'wood', 'stick', 'soft'] as const;
export type ClickSound = (typeof CLICK_SOUNDS)[number];

export function isClickSound(v: unknown): v is ClickSound {
  return typeof v === 'string' && (CLICK_SOUNDS as readonly string[]).includes(v);
}

/** A ringing mode: its pitch (Hz), its level, and how long it takes to fall by e (seconds). */
type Mode = [freq: number, amp: number, tau: number];

interface Voice {
  modes: Mode[];
  /** A burst of bright noise at the strike: its level and fall (seconds). */
  noise?: [amp: number, tau: number];
  /** A rounded start instead of a strike (seconds). */
  attack?: number;
  /** How far up the first beat of the bar is. */
  accent: number;
  /** Matches its loudness to the beep's. */
  gain: number;
}

const VOICES: Record<Exclude<ClickSound, 'beep'>, Voice> = {
  // a woodblock: a hollow knock, a fourth higher on the bar
  wood: {
    modes: [
      [880, 1, 0.03],
      [2380, 0.4, 0.012],
      [4050, 0.15, 0.005],
    ],
    noise: [0.3, 0.0008],
    accent: 4 / 3,
    gain: 0.75,
  },
  // drumsticks struck together: short and bright, cuts through a loud mix
  stick: {
    modes: [
      [2650, 0.55, 0.018],
      [4900, 0.35, 0.009],
      [7400, 0.2, 0.004],
    ],
    noise: [0.8, 0.004],
    accent: 1.2,
    gain: 1.12,
  },
  // a soft, round tick for quiet playing
  soft: {
    modes: [
      [660, 1, 0.05],
      [1320, 0.12, 0.025],
    ],
    attack: 0.0015,
    accent: 4 / 3,
    gain: 0.68,
  },
};

/** The beat's level against the bar's. */
const BEAT = 0.6;
/** Rings until it has fallen this far (-80 dB). */
const FLOOR = 1e-4;
const MAX_MODES = 3;

export class Click {
  private remaining = 0;
  // the beep
  private beep = false;
  private phase = 0;
  private env = 0;
  private freq = 1000;
  // the modes, each a turning phasor that shrinks as it rings
  private count = 0;
  private re = new Float64Array(MAX_MODES);
  private im = new Float64Array(MAX_MODES);
  private cr = new Float64Array(MAX_MODES);
  private ci = new Float64Array(MAX_MODES);
  private att = 1;
  private attK = 0;
  private noise = 0;
  private noiseK = 0;
  private seed = 1;
  private prev = 0;
  private readonly sr: number;

  constructor(sr: number) {
    this.sr = sr;
  }

  /** Whether it is still sounding. */
  get active(): boolean {
    return this.remaining > 0;
  }

  /** Strike it: `bar` for the first beat of a bar. */
  start(sound: ClickSound, bar: boolean): void {
    const level = bar ? 1 : BEAT;
    if (sound === 'beep') {
      this.beep = true;
      this.freq = bar ? 1760 : 1175;
      this.env = level;
      this.phase = 0;
      this.remaining = Number.POSITIVE_INFINITY;
      return;
    }
    const v = VOICES[sound];
    const up = bar ? v.accent : 1;
    this.beep = false;
    this.count = v.modes.length;
    let longest = 0;
    v.modes.forEach(([f, a, tau], k) => {
      const r = Math.exp(-1 / (tau * this.sr));
      const w = (2 * Math.PI * Math.min(f * up, this.sr * 0.45)) / this.sr;
      this.re[k] = a * level * v.gain;
      this.im[k] = 0;
      this.cr[k] = r * Math.cos(w);
      this.ci[k] = r * Math.sin(w);
      longest = Math.max(longest, tau);
    });
    this.att = v.attack ? 0 : 1;
    this.attK = v.attack ? 1 - Math.exp(-1 / (v.attack * this.sr)) : 0;
    this.noise = v.noise ? v.noise[0] * level * v.gain : 0;
    this.noiseK = v.noise ? Math.exp(-1 / (v.noise[1] * this.sr)) : 0;
    this.seed = 22222;
    this.prev = 0;
    this.remaining = Math.ceil(longest * this.sr * Math.log(1 / FLOOR));
  }

  /** The next sample (0 once it has rung out). */
  next(): number {
    if (this.remaining <= 0) return 0;
    if (this.beep) {
      if (this.env < FLOOR) {
        this.remaining = 0;
        return 0;
      }
      this.phase += this.freq / this.sr;
      const y = Math.sin(2 * Math.PI * this.phase) * this.env;
      this.env *= 0.9986;
      return y;
    }
    this.remaining--;
    let y = 0;
    for (let k = 0; k < this.count; k++) {
      const re = this.re[k] as number;
      const im = this.im[k] as number;
      const cr = this.cr[k] as number;
      const ci = this.ci[k] as number;
      this.re[k] = re * cr - im * ci;
      this.im[k] = re * ci + im * cr;
      y += this.im[k] as number;
    }
    if (this.attK) {
      this.att += (1 - this.att) * this.attK;
      y *= this.att;
    }
    if (this.noise > 1e-6) {
      this.seed = (Math.imul(this.seed, 1664525) + 1013904223) >>> 0;
      const v = this.seed / 2147483648 - 1;
      // only the top of the noise: a click, not a hiss
      y += (v - this.prev) * 0.5 * this.noise;
      this.prev = v;
      this.noise *= this.noiseK;
    }
    return y;
  }
}
