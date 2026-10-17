/**
 * What every instrument does: notes on and off, controllers, and rendering into a stereo buffer.
 * The sustain pedal (CC 64), the mod wheel (CC 1), expression (CC 11), volume (CC 7) and pitch
 * bend are handled here once, for all of them.
 */

export interface Voice {
  /** The key that started it (for note-off). */
  key: number;
  /** Released by its key, but held by the sustain pedal. */
  sustained: boolean;
  released: boolean;
  /** Finished: free to reuse. */
  done: boolean;
  /** When it started, for stealing the oldest. */
  age: number;
  release(): void;
  /** Fast fade for a stolen voice or a hard stop. */
  kill(): void;
  /** Add this voice's sound to l/r from start to end. */
  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void;
}

export interface Controls {
  /** Pitch-bend in semitones (±2 by default). */
  bend: number;
  /** Mod wheel 0..1. */
  mod: number;
  /** Expression × volume, 0..1. */
  expression: number;
  pressure: number;
}

export abstract class Instrument {
  protected voices: Voice[] = [];
  protected readonly controls: Controls = { bend: 0, mod: 0, expression: 1, pressure: 0 };
  protected sustain = false;
  protected bendRange = 2;
  private volume = 1;
  private expr = 1;
  private clock = 0;
  maxVoices = 64;

  protected readonly sr: number;
  constructor(sr: number) {
    this.sr = sr;
  }

  /** Start a voice (velocity 1..127); `art` picks an articulation where the instrument has them. */
  protected abstract startVoice(key: number, velocity: number, art: number): Voice | null;

  noteOn(key: number, velocity: number, art = 0): void {
    if (velocity <= 0) {
      this.noteOff(key);
      return;
    }
    const v = this.startVoice(key, velocity, art);
    if (!v) return;
    v.age = this.clock++;
    const free = this.voices.findIndex((x) => x.done);
    if (free < 0 && this.voices.length >= this.maxVoices) {
      // steal: the oldest released voice, else the oldest
      let oldest = -1;
      for (let i = 0; i < this.voices.length; i++) {
        const x = this.voices[i] as Voice;
        if (oldest < 0) oldest = i;
        const o = this.voices[oldest] as Voice;
        if ((x.released && !o.released) || (x.released === o.released && x.age < o.age)) oldest = i;
      }
      (this.voices[oldest] as Voice).kill();
      this.voices.push(v);
      return;
    }
    if (free < 0) this.voices.push(v);
    else this.voices[free] = v;
  }

  noteOff(key: number): void {
    for (const v of this.voices) {
      if (v.key === key && !v.released && !v.done) {
        if (this.sustain) v.sustained = true;
        else v.release();
      }
    }
  }

  cc(num: number, value: number): void {
    switch (num) {
      case 1:
        this.controls.mod = value / 127;
        break;
      case 7:
        this.volume = (value / 127) ** 2;
        this.controls.expression = this.volume * this.expr;
        break;
      case 11:
        this.expr = (value / 127) ** 1.5;
        this.controls.expression = this.volume * this.expr;
        break;
      case 64: {
        const down = value >= 64;
        if (this.sustain && !down) {
          for (const v of this.voices) {
            if (v.sustained && !v.done) {
              v.sustained = false;
              v.release();
            }
          }
        }
        this.sustain = down;
        break;
      }
      case 120:
        this.allNotesOff(true);
        break;
      case 121:
        this.reset();
        break;
      case 123:
        this.allNotesOff(false);
        break;
    }
  }

  /** −8192..8191 */
  pitchBend(value: number): void {
    this.controls.bend = (value / 8192) * this.bendRange;
  }

  pressure(value: number): void {
    this.controls.pressure = value / 127;
  }

  allNotesOff(hard: boolean): void {
    this.sustain = false;
    for (const v of this.voices) {
      if (v.done) continue;
      v.sustained = false;
      if (hard) v.kill();
      else v.release();
    }
  }

  reset(): void {
    this.controls.bend = 0;
    this.controls.mod = 0;
    this.controls.pressure = 0;
    this.volume = 1;
    this.expr = 1;
    this.controls.expression = 1;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number): void {
    for (const v of this.voices) if (!v.done) v.render(l, r, start, end, this.controls);
  }

  get active(): number {
    let n = 0;
    for (const v of this.voices) if (!v.done) n++;
    return n;
  }
}

/** A linear attack and an exponential release, per sample. */
export class Envelope {
  level = 0;
  private stage: 0 | 1 | 2 | 3 = 0; // attack, hold, release, off
  private attackStep: number;
  private releaseCoef: number;
  constructor(sr: number, attack: number, release: number) {
    this.attackStep = attack > 0 ? 1 / (attack * sr) : 1;
    this.releaseCoef = Math.exp(-6.9 / (Math.max(release, 0.005) * sr));
  }
  setRelease(sr: number, release: number): void {
    this.releaseCoef = Math.exp(-6.9 / (Math.max(release, 0.005) * sr));
  }
  release(): void {
    if (this.stage < 2) this.stage = 2;
  }
  get off(): boolean {
    return this.stage === 3;
  }
  next(): number {
    switch (this.stage) {
      case 0:
        this.level += this.attackStep;
        if (this.level >= 1) {
          this.level = 1;
          this.stage = 1;
        }
        break;
      case 2:
        this.level *= this.releaseCoef;
        if (this.level < 1e-4) {
          this.level = 0;
          this.stage = 3;
        }
        break;
    }
    return this.level;
  }
}

/** Attack, decay, sustain, release: the synth's envelopes. Times in seconds. */
export class Adsr {
  level = 0;
  stage: 0 | 1 | 2 | 3 | 4 = 0; // attack, decay, sustain, release, off
  private readonly s: number;
  /** Each stage's step, worked out once (the same expressions, per envelope rather than per sample). */
  private readonly attackStep: number;
  private readonly decayCoef: number;
  private readonly releaseCoef: number;
  constructor(sr: number, a: number, d: number, s: number, r: number) {
    this.s = s;
    this.attackStep = 1 / Math.max(1, a * sr);
    this.decayCoef = Math.exp(-5 / Math.max(1, d * sr));
    this.releaseCoef = Math.exp(-6.9 / Math.max(1, r * sr));
  }
  gate(on: boolean): void {
    if (on) this.stage = 0;
    else if (this.stage < 3) this.stage = 3;
  }
  get off(): boolean {
    return this.stage === 4;
  }
  next(): number {
    switch (this.stage) {
      case 0:
        this.level += this.attackStep;
        if (this.level >= 1) {
          this.level = 1;
          this.stage = 1;
        }
        break;
      case 1:
        this.level = this.s + (this.level - this.s) * this.decayCoef;
        if (Math.abs(this.level - this.s) < 1e-4) this.stage = 2;
        break;
      case 3:
        this.level *= this.releaseCoef;
        if (this.level < 1e-4) {
          this.level = 0;
          this.stage = 4;
        }
        break;
    }
    return this.level;
  }
}
