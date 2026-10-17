/**
 * The sampler: plays recorded notes from a pack. Each note takes the zone that covers its key and
 * velocity (the nearest one if none does), shifted to pitch with Hermite interpolation from the
 * sample's measured root, so every note lands in tune. Round robins rotate; loops cross-fade.
 */

import { hermite } from './dsp.ts';
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
  constructor(zone: SampleZone, key: number, baseRatio: number, gain: number, sr: number, spec: SamplerSpec) {
    this.zone = zone;
    this.baseRatio = baseRatio;
    this.gain = gain;
    this.key = key;
    this.env = new Envelope(sr, spec.attack, spec.release);
    const loop = zone.loopEnd - zone.loopStart;
    this.xf = loop > 0 ? Math.min(2048, Math.floor(loop / 4)) : 0;
  }

  release(): void {
    this.released = true;
    this.env.release();
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
  }

  private sample(data: Float32Array, p: number): number {
    const i = Math.floor(p);
    const t = p - i;
    const n = data.length;
    const a = i > 0 ? (data[i - 1] as number) : 0;
    const b = i < n ? (data[i] as number) : 0;
    const c = i + 1 < n ? (data[i + 1] as number) : 0;
    const d = i + 2 < n ? (data[i + 2] as number) : 0;
    return hermite(a, b, c, d, t);
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const z = this.zone;
    const left = z.left;
    const right = z.right ?? z.left;
    const ratio = this.baseRatio * 2 ** (ctl.bend / 12);
    const g = this.gain * ctl.expression;
    const len = left.length;
    const looped = z.loopEnd > z.loopStart && !this.released;
    const loopLen = z.loopEnd - z.loopStart;
    for (let i = start; i < end; i++) {
      let e = this.env.next();
      if (this.killing > 0) {
        this.killing *= 0.995;
        e *= this.killing;
        if (this.killing < 1e-3) {
          this.done = true;
          return;
        }
      }
      if (this.env.off || this.pos >= len - 1) {
        this.done = true;
        return;
      }
      let sl = this.sample(left, this.pos);
      let sr = right === left ? sl : this.sample(right, this.pos);
      if (looped && this.xf > 0 && this.pos > z.loopEnd - this.xf) {
        // cross-fade into the loop's start so the seam never clicks
        const a = (this.pos - (z.loopEnd - this.xf)) / this.xf;
        const back = this.pos - loopLen;
        sl = sl * (1 - a) + this.sample(left, back) * a;
        sr = sr * (1 - a) + (right === left ? this.sample(left, back) : this.sample(right, back)) * a;
      }
      l[i] = (l[i] as number) + sl * e * g;
      r[i] = (r[i] as number) + sr * e * g;
      this.pos += ratio;
      if (looped && this.pos >= z.loopEnd) this.pos -= loopLen;
    }
  }
}

export class Sampler extends Instrument {
  private rr = new Map<string, number>();
  private readonly velocityRange: number;

  private readonly spec: SamplerSpec;
  constructor(sr: number, spec: SamplerSpec) {
    super(sr);
    this.spec = spec;
    this.velocityRange = spec.velocityRange;
  }

  private pick(key: number, velocity: number): SampleZone | null {
    const zones = this.spec.zones;
    let best: SampleZone[] = [];
    let bestScore = Number.POSITIVE_INFINITY;
    for (const z of zones) {
      // distance outside the key range (semitones) weighs most, then velocity
      const kd = key < z.lo ? z.lo - key : key > z.hi ? key - z.hi : 0;
      const vd = velocity < z.lovel ? z.lovel - velocity : velocity > z.hivel ? velocity - z.hivel : 0;
      const score = kd * 1000 + vd;
      if (score < bestScore) {
        bestScore = score;
        best = [z];
      } else if (score === bestScore) best.push(z);
    }
    if (best.length === 0) return null;
    if (best.length === 1) return best[0] as SampleZone;
    const first = best[0] as SampleZone;
    const slot = `${first.lo}:${first.lovel}`;
    const n = (this.rr.get(slot) ?? 0) % best.length;
    this.rr.set(slot, n + 1);
    return best[n] as SampleZone;
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
