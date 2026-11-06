/**
 * The sampler: plays recorded notes from a pack. Each note takes the zone that covers its key and
 * velocity (the nearest one if none does), shifted to pitch with Hermite interpolation from the
 * sample's measured root, so every note lands in tune. Round robins rotate; loops cross-fade.
 *
 * What a played instrument needs besides, each only where its pack asks for it (so the packs that
 * don't play exactly as before): choke groups (the closed hi-hat silences the open one), a limit on
 * how often one key sounds at once (a drum struck again, a piano key struck again under the pedal:
 * the oldest fades), release samples in parts that sound together (the damper falling on a piano
 * string, quieter the longer the note was held, and its key coming back up), the sustain pedal's own
 * sound going down and up, keys without dampers (a piano's top strings ring on when let go), and a
 * release time of a zone's own.
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
  /** How fast `killing` falls each sample: a kill's, or a choke's. */
  private killCoef = 0.995;
  private readonly xf: number;
  /** Let go by its key (or the pedal) since the sampler last looked: its release sample is due. */
  letGo = false;
  /** A release or pedal sample's voice (never counted against a key's notes, never let go by a key). */
  readonly isRelease: boolean;
  /** Letting it go stops it: false for a string without a damper. */
  private readonly damped: boolean;
  /** The velocity that struck it, and the sampler's frame it started on (for its release sample). */
  readonly velocity: number;
  readonly born: number;

  readonly zone: SampleZone;
  private readonly baseRatio: number;
  private readonly gain: number;
  private readonly loopLen: number;
  /** The sample read() made. */
  private y = 0;
  constructor(
    zone: SampleZone,
    key: number,
    baseRatio: number,
    gain: number,
    sr: number,
    spec: SamplerSpec,
    velocity = 127,
    born = 0,
    damped = true,
  ) {
    this.zone = zone;
    this.baseRatio = baseRatio;
    this.gain = gain;
    this.key = key;
    this.velocity = velocity;
    this.born = born;
    this.damped = damped;
    this.isRelease = zone.trigger !== undefined;
    // a release or pedal sample plays to its end: no key lets it go, and it's the first to go when notes run short
    if (this.isRelease) this.released = true;
    this.env = new Envelope(sr, spec.attack, zone.release ?? spec.release);
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
    // a string without a damper rings on to its end
    if (!this.damped) return;
    this.env.release();
    this.letGo = true;
  }

  kill(): void {
    this.released = true;
    this.killing = 1;
    this.killCoef = 0.995;
  }

  /** Fade out at `coef` a sample (a choke, or a key struck again): never slower than a fade already under way. */
  choke(coef: number): void {
    this.released = true;
    if (this.killing === 0) {
      this.killing = 1;
      this.killCoef = coef;
    } else if (coef < this.killCoef) this.killCoef = coef;
  }

  /** Fading out (killed or choked). */
  get choking(): boolean {
    return this.killing > 0;
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
        this.killing *= this.killCoef;
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

/** Zones to pick from, with their round-robin slots. */
class ZoneSet {
  readonly zones: SampleZone[];
  /**
   * Round robins: zones that tie for a note take turns, counted per slot (the first tied zone's key
   * and velocity floor). Each zone's slot is numbered once, so a note allocates nothing to pick.
   */
  private readonly slotOf: Int32Array;
  private readonly rr: Int32Array;

  constructor(zones: SampleZone[]) {
    this.zones = zones;
    const slots = new Map<string, number>();
    this.slotOf = new Int32Array(zones.length);
    zones.forEach((z, i) => {
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

  pick(key: number, velocity: number): SampleZone | null {
    const zones = this.zones;
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
}

export class Sampler extends Instrument {
  /** The zones a key strikes; those it plays when let go, a set per part; the pedal's own, going down and up. */
  private readonly struck: ZoneSet;
  private readonly releases: ZoneSet[];
  private readonly pedalDown: ZoneSet | null;
  private readonly pedalUp: ZoneSet | null;
  private readonly velocityRange: number;
  private readonly releaseVelocityRange: number;
  /** A choked or re-struck note's fade, a sample. */
  private readonly offCoef: number;
  /** Frames rendered: how long a note was held, for its release sample. */
  private frames = 0;
  /** The pedal as the sampler last saw it (for its own sound going down and up). */
  private pedal = false;

  private readonly spec: SamplerSpec;
  constructor(sr: number, spec: SamplerSpec) {
    super(sr);
    this.spec = spec;
    this.velocityRange = spec.velocityRange;
    this.releaseVelocityRange = spec.releaseVelocityRange ?? spec.velocityRange;
    const triggered = spec.zones.some((z) => z.trigger !== undefined);
    this.struck = new ZoneSet(triggered ? spec.zones.filter((z) => z.trigger === undefined) : spec.zones);
    const parts = new Map<number, SampleZone[]>();
    for (const z of spec.zones) {
      if (z.trigger !== 'release') continue;
      const part = z.part ?? 0;
      parts.set(part, [...(parts.get(part) ?? []), z]);
    }
    this.releases = [...parts.keys()].sort((a, b) => a - b).map((p) => new ZoneSet(parts.get(p) as SampleZone[]));
    const down = spec.zones.filter((z) => z.trigger === 'pedalDown');
    const up = spec.zones.filter((z) => z.trigger === 'pedalUp');
    this.pedalDown = down.length ? new ZoneSet(down) : null;
    this.pedalUp = up.length ? new ZoneSet(up) : null;
    this.offCoef = Math.exp(-6.9 / (Math.max(spec.offTime ?? 0.02, 0.001) * sr));
    if (spec.polyphony) this.maxVoices = spec.polyphony;
  }

  /** The gain a velocity adds over `range` dB: the layers already differ in timbre; this is a smooth curve. */
  private velocityGain(velocity: number, range = this.velocityRange): number {
    const db = -((127 - velocity) / 126) * range;
    return 10 ** (db / 20);
  }

  protected startVoice(key: number, velocity: number): Voice | null {
    const zone = this.struck.pick(key, velocity);
    if (!zone) return null;
    const spec = this.spec;
    // the same key struck again past its limit: its oldest notes fade
    const limit = spec.notePolyphony ?? 0;
    if (limit > 0) {
      for (;;) {
        let count = 0;
        let oldest: SampleVoice | null = null;
        for (const v of this.voices as SampleVoice[]) {
          if (v.done || v.key !== key || v.isRelease || v.choking) continue;
          count++;
          if (!oldest || v.age < oldest.age) oldest = v;
        }
        if (count < limit || !oldest) break;
        oldest.choke(this.offCoef);
      }
    }
    // a note of a choke group silences what it chokes (the closed hi-hat, the open one)
    if (zone.group) {
      for (const v of this.voices as SampleVoice[]) {
        if (!v.done && v.zone.offBy === zone.group) v.choke(this.offCoef);
      }
    }
    const ratio = spec.pitched ? 2 ** ((key - zone.root) / 12) : 1;
    const damped = spec.undamped === undefined || key < spec.undamped;
    return new SampleVoice(
      zone,
      key,
      ratio,
      zone.gain * this.velocityGain(velocity),
      this.sr,
      spec,
      velocity,
      this.frames,
      damped,
    );
  }

  /**
   * Each note let go since the last look starts its release samples, one of each part (quieter the
   * longer it was held, by each zone's decay).
   */
  private releaseSamples(): void {
    if (!this.releases.length) return;
    const n = this.voices.length;
    for (let i = 0; i < n; i++) {
      const v = this.voices[i] as SampleVoice;
      if (!v.letGo) continue;
      v.letGo = false;
      const held = (this.frames - v.born) / this.sr;
      for (const set of this.releases) {
        const zone = set.pick(v.key, v.velocity);
        if (!zone) continue;
        const db = -(zone.decay ?? this.spec.releaseDecay ?? 0) * held;
        const gain = zone.gain * this.velocityGain(v.velocity, this.releaseVelocityRange) * 10 ** (db / 20);
        if (gain < 1e-4) continue;
        const ratio = this.spec.pitched ? 2 ** ((v.key - zone.root) / 12) : 1;
        this.addVoice(new SampleVoice(zone, v.key, ratio, gain, this.sr, this.spec, v.velocity, this.frames));
      }
    }
  }

  /** The pedal's own sound, as it goes down or comes up (at its own pitch, whatever the keys). */
  private pedalSound(set: ZoneSet | null): void {
    const zone = set?.pick(0, 127);
    if (zone) this.addVoice(new SampleVoice(zone, -1, 1, zone.gain, this.sr, this.spec, 127, this.frames));
  }

  override noteOff(key: number): void {
    if (this.spec.oneShot) return;
    super.noteOff(key);
    this.releaseSamples();
  }

  override cc(num: number, value: number): void {
    super.cc(num, value);
    if (num === 64) {
      const down = value >= 64;
      if (down !== this.pedal) this.pedalSound(down ? this.pedalDown : this.pedalUp);
      this.pedal = down;
    }
    this.releaseSamples();
  }

  override allNotesOff(hard: boolean): void {
    super.allNotesOff(hard);
    this.pedal = false;
    if (hard) for (const v of this.voices as SampleVoice[]) v.letGo = false;
    else this.releaseSamples();
  }

  override render(l: Float32Array, r: Float32Array, start: number, end: number): void {
    super.render(l, r, start, end);
    this.frames += end - start;
  }
}
