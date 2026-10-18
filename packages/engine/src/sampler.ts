/**
 * The sampler: plays recorded notes from a pack. Each note takes the zone that covers its key and
 * velocity (the nearest one if none does), shifted to pitch with Hermite interpolation from the
 * sample's measured root, so every note lands in tune. Round robins rotate; loops cross-fade.
 */

import { type Controls, Envelope, Instrument, type Voice } from './instrument.ts';
import type { SamplerSpec, SampleZone } from './protocol.ts';

class SampleVoice implements Voice {
  key = 0;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private pos = 0;
  private readonly env: Envelope;
  private killing = 0;
  private readonly xf: number;

  private readonly zone: SampleZone;
  private readonly baseRatio: number;
  private readonly gain: number;
  private readonly loopLen: number;
  /** The sample read() made. */
  private y = 0;
  constructor(zone: SampleZone, key: number, baseRatio: number, gain: number, sr: number, spec: SamplerSpec) {
    this.zone = zone;
    this.baseRatio = baseRatio;
    this.gain = gain;
    this.key = key;
    this.env = new Envelope(sr, spec.attack, spec.release);
    const loop = zone.loopEnd - zone.loopStart;
    this.loopLen = loop;
    this.xf = loop > 0 ? Math.min(2048, Math.floor(loop / 4)) : 0;
  }

  /**
   * The sample at the read position (a loop's length back, for the cross-fade), by four-point
   * Hermite interpolation, zero past either end, into `y`. The position comes from the fields and
   * the sample goes to one: a call V8 doesn't inline boxes every double it passes or returns, a
   * heap allocation each sample.
   */
  private read(data: Float32Array, back: boolean): void {
    const p = back ? this.pos - this.loopLen : this.pos;
    const i = Math.floor(p);
    const t = p - i;
    const n = data.length;
    let xm1: number;
    let x0: number;
    let x1: number;
    let x2: number;
    if (i > 0 && i + 2 < n) {
      // inside the sample, as almost every read is: no bounds to check
      xm1 = data[i - 1] as number;
      x0 = data[i] as number;
      x1 = data[i + 1] as number;
      x2 = data[i + 2] as number;
    } else {
      xm1 = i > 0 ? (data[i - 1] as number) : 0;
      x0 = i < n ? (data[i] as number) : 0;
      x1 = i + 1 < n ? (data[i + 1] as number) : 0;
      x2 = i + 2 < n ? (data[i + 2] as number) : 0;
    }
    const c = (x1 - xm1) * 0.5;
    const v = x0 - x1;
    const w = c + v;
    const a = w + v + (x2 - x0) * 0.5;
    const b = w + a;
    this.y = ((a * t - b) * t + c) * t + x0;
  }

  release(): void {
    this.released = true;
    this.env.release();
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const z = this.zone;
    const left = z.left;
    const right = z.right ?? z.left;
    const ratio = this.baseRatio * 2 ** (ctl.bend / 12);
    const g = this.gain * ctl.expression;
    const len = left.length;
    const looped = z.loopEnd > z.loopStart && !this.released;
    const loopLen = this.loopLen;
    const env = this.env;
    const xf = this.xf;
    const fadeFrom = z.loopEnd - xf;
    const fading = looped && xf > 0;
    for (let i = start; i < end; i++) {
      env.step();
      let e = env.level;
      if (this.killing > 0) {
        this.killing *= 0.995;
        e *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      if (env.off || this.pos >= len - 1) {
        this.done = true;
        return;
      }
      this.read(left, false);
      let sl = this.y;
      let sr = sl;
      if (right !== left) {
        this.read(right, false);
        sr = this.y;
      }
      if (fading && this.pos > fadeFrom) {
        // cross-fade into the loop's start so the seam never clicks
        const a = (this.pos - fadeFrom) / xf;
        this.read(left, true);
        sl = sl * (1 - a) + this.y * a;
        if (right !== left) this.read(right, true);
        sr = sr * (1 - a) + this.y * a;
      }
      l[i] = (l[i] as number) + sl * e * g;
      r[i] = (r[i] as number) + sr * e * g;
      this.pos += ratio;
      if (looped && this.pos >= z.loopEnd) this.pos -= loopLen;
    }
  }
}

export class Sampler extends Instrument {
  /**
   * Round robins: zones that tie for a note take turns, counted per slot (the first tied zone's key
   * and velocity floor). Each zone's slot is numbered once, so a note allocates nothing to pick.
   */
  private readonly slotOf: Int32Array;
  private readonly rr: Int32Array;
  private readonly velocityRange: number;

  private readonly spec: SamplerSpec;
  constructor(sr: number, spec: SamplerSpec) {
    super(sr);
    this.spec = spec;
    this.velocityRange = spec.velocityRange;
    const slots = new Map<string, number>();
    this.slotOf = new Int32Array(spec.zones.length);
    spec.zones.forEach((z, i) => {
      const key = `${z.lo}:${z.lovel}`;
      let n = slots.get(key);
      if (n === undefined) {
        n = slots.size;
        slots.set(key, n);
      }
      this.slotOf[i] = n;
    });
    this.rr = new Int32Array(Math.max(1, slots.size));
  }

  private pick(key: number, velocity: number): SampleZone | null {
    const zones = this.spec.zones;
    let bestScore = Number.POSITIVE_INFINITY;
    let first = -1;
    let ties = 0;
    for (let i = 0; i < zones.length; i++) {
      const z = zones[i] as SampleZone;
      // distance outside the key range (semitones) weighs most, then velocity
      const kd = key < z.lo ? z.lo - key : key > z.hi ? key - z.hi : 0;
      const vd = velocity < z.lovel ? z.lovel - velocity : velocity > z.hivel ? velocity - z.hivel : 0;
      const score = kd * 1000 + vd;
      if (score < bestScore) {
        bestScore = score;
        first = i;
        ties = 1;
      } else if (score === bestScore) ties++;
    }
    if (first < 0) return null;
    if (ties === 1) return zones[first] as SampleZone;
    const slot = this.slotOf[first] as number;
    const n = (this.rr[slot] as number) % ties;
    this.rr[slot] = n + 1;
    // the n-th of the tied zones, in their order
    let seen = 0;
    for (let i = first; i < zones.length; i++) {
      const z = zones[i] as SampleZone;
      const kd = key < z.lo ? z.lo - key : key > z.hi ? key - z.hi : 0;
      const vd = velocity < z.lovel ? z.lovel - velocity : velocity > z.hivel ? velocity - z.hivel : 0;
      if (kd * 1000 + vd !== bestScore) continue;
      if (seen === n) return z;
      seen++;
    }
    return zones[first] as SampleZone;
  }

  protected startVoice(key: number, velocity: number): Voice | null {
    const zone = this.pick(key, velocity);
    if (!zone) return null;
    const ratio = this.spec.pitched ? 2 ** ((key - zone.root) / 12) : 1;
    // the layers already differ in loudness; velocity adds a smooth curve over `velocityRange` dB
    const db = -((127 - velocity) / 126) * this.velocityRange;
    return new SampleVoice(zone, key, ratio, zone.gain * 10 ** (db / 20), this.sr, this.spec);
  }

  override noteOff(key: number): void {
    if (this.spec.oneShot) return;
    super.noteOff(key);
  }
}
