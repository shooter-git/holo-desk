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
 *
 * Microphones: a kit recorded on several (a close one on each drum, overheads, a room) keeps each
 * one's recording, and a hit sounds every microphone's zone for its key, velocity and round robin
 * together, each at the level of its own knob. The hit is one voice, so chokes, polyphony and a
 * key's limit count hits, not microphones. Its knobs (each microphone's level, the kit's tune and
 * decay) move while it plays: a level glides over a block, tune takes the next hit, decay shortens
 * what's ringing.
 */

import { MIC_OFF, micParam } from '@holo/session';
import { type Controls, Envelope, Instrument, type Voice } from './instrument.ts';
import type { SamplerSpec, SampleZone } from './protocol.ts';

/** What a sampler's voices read as they play: its knobs, and the envelope buffer they share. */
class SamplerState {
  /** Each microphone's gain (linear), by its index in the instrument's mics. */
  readonly mic: Float64Array;
  /** The kit's tune as a ratio, taken by each hit as it starts. */
  tune = 1;
  /** How much of each hit's ring it keeps (1: all of it). */
  decay = 1;
  /**
   * A voice's envelope over the frames it renders (killed, choked and decayed): its microphones
   * read it in turn. Voices render one after another, so one buffer serves them all.
   */
  env = new Float64Array(128);
  constructor(mics: number) {
    this.mic = new Float64Array(mics).fill(1);
  }
}

/** One microphone of a hit (or the hit's one sample): its zone, where it's read, its level and place. */
class SampleLayer {
  readonly zone: SampleZone;
  /** Its microphone, by index (-1: none, always at full level). */
  readonly mic: number;
  /** Read past its end (the hit may ring on in its other microphones). */
  ended = false;
  private pos = 0;
  private readonly baseRatio: number;
  /** Its gains into left and right: the zone's level and the hit's velocity, by its pan. */
  private readonly gl: number;
  private readonly gr: number;
  /** Where its loop ends (never past its last frame), and how long it is (0: no loop). */
  private readonly loopEnd: number;
  private readonly loopLen: number;
  /** Frames of cross-fade at the seam: no more than the sample has before its loop starts. */
  private readonly xf: number;
  /** Reading while it loops: past its last frame is the loop's start again. */
  private wrap = false;
  /** The microphone's gain it last played at: a knob's new level is reached over a block. */
  private m: number;
  /** The sample read() made. */
  private y = 0;

  constructor(zone: SampleZone, mic: number, pan: number, baseRatio: number, gain: number, micGain: number) {
    this.zone = zone;
    this.mic = mic;
    this.baseRatio = baseRatio;
    this.m = micGain;
    if (pan === 0) {
      this.gl = gain;
      this.gr = gain;
    } else if (zone.right) {
      // a stereo sample: its balance
      this.gl = gain * Math.min(1, 1 - pan);
      this.gr = gain * Math.min(1, 1 + pan);
    } else {
      // a mono one: constant power, as loud as both sides in the center
      const theta = ((pan + 1) * Math.PI) / 4;
      this.gl = gain * Math.cos(theta) * Math.SQRT2;
      this.gr = gain * Math.sin(theta) * Math.SQRT2;
    }
    // a loop that runs to the sample's end (or past it) loops the whole of what's there
    const loopEnd = Math.min(zone.loopEnd, zone.left.length);
    const loop = Math.max(0, loopEnd - zone.loopStart);
    this.loopEnd = loop > 0 ? loopEnd : 0;
    this.loopLen = loop;
    // the cross-fade reads a loop's length back, so it can be no longer than what comes before the
    // loop: a loop from the first frame has none, and joins at its seam as it was cut to
    this.xf = loop > 0 ? Math.min(2048, Math.floor(loop / 4), Math.floor(zone.loopStart)) : 0;
  }

  /** Frames it sounds for, played straight through at its pitch (what the kit's decay is a share of). */
  get frames(): number {
    return this.zone.left.length / Math.max(1e-6, this.baseRatio);
  }

  /**
   * The sample at the read position (a loop's length back, for the cross-fade), by four-point
   * Hermite interpolation, zero past either end (or, while it loops, the loop's start again past its
   * last frame), into `y`. The position comes from the fields and the sample goes to one: a call V8
   * doesn't inline boxes every double it passes or returns, a heap allocation each sample.
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
      // at an edge: nothing before the first frame; past the last, the loop's start or nothing
      const k = this.wrap ? this.loopLen : 0;
      let j = i - 1;
      xm1 = j >= 0 && j < n ? (data[j] as number) : k > 0 && j >= n && j - k >= 0 ? (data[j - k] as number) : 0;
      j = i;
      x0 = j >= 0 && j < n ? (data[j] as number) : k > 0 && j >= n && j - k >= 0 ? (data[j - k] as number) : 0;
      j = i + 1;
      x1 = j >= 0 && j < n ? (data[j] as number) : k > 0 && j >= n && j - k >= 0 ? (data[j - k] as number) : 0;
      j = i + 2;
      x2 = j >= 0 && j < n ? (data[j] as number) : k > 0 && j >= n && j - k >= 0 ? (data[j - k] as number) : 0;
    }
    const c = (x1 - xm1) * 0.5;
    const v = x0 - x1;
    const w = c + v;
    const a = w + v + (x2 - x0) * 0.5;
    const b = w + a;
    this.y = ((a * t - b) * t + c) * t + x0;
  }

  /**
   * The hit's only sample, from `start` to `end`, at its microphone's level as it was (a level on
   * the move takes render()). It steps the voice's envelope itself, a sample at a time, as the
   * sampler always played one sample: nothing to fill first or read back.
   */
  renderAlone(l: Float32Array, r: Float32Array, start: number, end: number, voice: SampleVoice, ctl: Controls): void {
    const z = this.zone;
    const left = z.left;
    const right = z.right ?? z.left;
    const ratio = this.baseRatio * 2 ** (ctl.bend / 12);
    const len = left.length;
    const loopLen = this.loopLen;
    const loopEnd = this.loopEnd;
    const looped = loopLen > 0 && !voice.released;
    this.wrap = looped;
    const xf = this.xf;
    const fadeFrom = loopEnd - xf;
    const fading = looped && xf > 0;
    // (at full level, as without microphones, exactly the gain it always had)
    const gl = this.gl * ctl.expression * this.m;
    const gr = this.gr * ctl.expression * this.m;
    for (let i = start; i < end; i++) {
      if (!voice.step()) {
        voice.over = true;
        break;
      }
      const e = voice.e;
      // (a loop that ends at the last frame goes around before it gets there)
      if (this.pos >= len - 1 && !(looped && this.pos < loopEnd)) {
        this.ended = true;
        break;
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
      l[i] = (l[i] as number) + sl * e * gl;
      r[i] = (r[i] as number) + sr * e * gr;
      this.pos += ratio;
      if (looped && this.pos >= loopEnd) this.pos -= loopLen;
    }
  }

  /** The microphone's level it plays at now (it glides to a new one in render()). */
  get level(): number {
    return this.m;
  }

  /**
   * Add `n` frames from `start` under the hit's envelope (`env`, from 0), at `micGain` (reached from
   * where it was by the last frame), looping while `looped`.
   */
  render(
    l: Float32Array,
    r: Float32Array,
    start: number,
    n: number,
    env: Float64Array,
    ctl: Controls,
    looped: boolean,
    micGain: number,
  ): void {
    const z = this.zone;
    const left = z.left;
    const right = z.right ?? z.left;
    const ratio = this.baseRatio * 2 ** (ctl.bend / 12);
    const gl = this.gl * ctl.expression;
    const gr = this.gr * ctl.expression;
    const len = left.length;
    const loopLen = this.loopLen;
    const loopEnd = this.loopEnd;
    const loops = looped && loopLen > 0;
    this.wrap = loops;
    const xf = this.xf;
    const fadeFrom = loopEnd - xf;
    const fading = loops && xf > 0;
    // a microphone's level moved since the last block: it glides there, a step a sample
    let m = this.m;
    const ramp = m !== micGain && n > 0;
    const dm = ramp ? (micGain - m) / n : 0;
    let kl = gl * m;
    let kr = gr * m;
    for (let k = 0; k < n; k++) {
      const e = env[k] as number;
      // (a loop that ends at the last frame goes around before it gets there)
      if (this.pos >= len - 1 && !(loops && this.pos < loopEnd)) {
        this.ended = true;
        break;
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
      if (ramp) {
        m += dm;
        kl = gl * m;
        kr = gr * m;
      }
      const i = start + k;
      l[i] = (l[i] as number) + sl * e * kl;
      r[i] = (r[i] as number) + sr * e * kr;
      this.pos += ratio;
      if (loops && this.pos >= loopEnd) this.pos -= loopLen;
    }
    this.m = micGain;
  }
}

/** A hit (or a release or pedal sample): every microphone's sample of it, under one envelope. */
class SampleVoice implements Voice {
  key = 0;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private readonly env: Envelope;
  private killing = 0;
  /** How fast `killing` falls each sample: a kill's, or a choke's. */
  private killCoef = 0.995;
  /** The kit's decay as it has fallen so far (1: untouched), and how fast it falls a sample now. */
  private tail = 1;
  private decayCoef = 1;
  /** The envelope's level step() made (killed, choked and decayed). */
  e = 0;
  /** Its envelope has ended, or a kill or the kit's decay has faded it away. */
  over = false;
  /** Let go by its key (or the pedal) since the sampler last looked: its release sample is due. */
  letGo = false;
  /** A release or pedal sample's voice (never counted against a key's notes, never let go by a key). */
  readonly isRelease: boolean;
  /** Letting it go stops it: false for a string without a damper. */
  private readonly damped: boolean;
  /** The velocity that struck it, and the sampler's frame it started on (for its release sample). */
  readonly velocity: number;
  readonly born: number;
  /** Its first microphone's zone: the choke group it belongs to and is silenced by. */
  readonly zone: SampleZone;
  private readonly layers: SampleLayer[];
  private readonly state: SamplerState;
  /** Frames it sounds for at most, played straight through (the kit's decay is a share of it). */
  private readonly frames: number;

  constructor(
    layers: SampleLayer[],
    key: number,
    sr: number,
    spec: SamplerSpec,
    state: SamplerState,
    velocity = 127,
    born = 0,
    damped = true,
  ) {
    const zone = (layers[0] as SampleLayer).zone;
    this.zone = zone;
    this.layers = layers;
    this.state = state;
    this.key = key;
    this.velocity = velocity;
    this.born = born;
    this.damped = damped;
    this.isRelease = zone.trigger !== undefined;
    // a release or pedal sample plays to its end: no key lets it go, and it's the first to go when notes run short
    if (this.isRelease) this.released = true;
    this.env = new Envelope(sr, spec.attack, zone.release ?? spec.release);
    let frames = 0;
    for (const layer of layers) frames = Math.max(frames, layer.frames);
    this.frames = frames;
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

  /**
   * The envelope a sample on, into `e`: false once it's over. A field rather than a returned double,
   * which a call V8 doesn't inline would box.
   */
  step(): boolean {
    const env = this.env;
    env.step();
    let e = env.level;
    if (this.killing > 0) {
      this.killing *= this.killCoef;
      e *= this.killing;
      if (this.killing < 1e-3) return false;
    }
    if (this.decayCoef !== 1) {
      this.tail *= this.decayCoef;
      if (this.tail < 1e-4) return false;
    }
    if (this.tail !== 1) e *= this.tail;
    if (env.off) return false;
    this.e = e;
    return true;
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    const state = this.state;
    // the kit's decay: what's left of the hit falls 69 dB over that share of its length
    this.decayCoef = state.decay < 1 ? Math.exp(-6.9 / Math.max(1, state.decay * this.frames)) : 1;
    const looped = !this.released;
    const layers = this.layers;
    const first = layers[0] as SampleLayer;
    if (layers.length === 1 && (first.mic < 0 || first.level === state.mic[first.mic])) {
      // one sample at a level that isn't moving (as every hit of a pack without microphones is)
      first.renderAlone(l, r, start, end, this, ctl);
      if (this.over || first.ended) this.done = true;
      return;
    }
    // several microphones (or one whose level is gliding): the envelope once, read by each
    const want = end - start;
    if (state.env.length < want) state.env = new Float64Array(want);
    const out = state.env;
    let n = 0;
    for (let k = 0; k < want; k++) {
      if (!this.step()) {
        this.over = true;
        break;
      }
      out[k] = this.e;
      n = k + 1;
    }
    let sounding = false;
    for (const layer of layers) {
      if (layer.ended) continue;
      const gain = layer.mic >= 0 ? (state.mic[layer.mic] as number) : 1;
      layer.render(l, r, start, n, out, ctl, looped, gain);
      if (!layer.ended) sounding = true;
    }
    if (this.over || !sounding) this.done = true;
  }
}

/** Zones to pick from, with their round-robin slots and their microphones. */
class ZoneSet {
  readonly zones: SampleZone[];
  /**
   * Round robins: zones that tie for a note take turns, counted per slot (the first tied zone's key
   * and velocity floor). Each zone's slot is numbered once, so a note allocates nothing to pick.
   */
  private readonly slotOf: Int32Array;
  private readonly rr: Int32Array;
  /** Each zone's microphone (its index in the instrument's mics; one past the last for none), or null without mics. */
  private readonly micOf: Int32Array | null;
  /** How many zones of each microphone tie for the note being picked, and how many have been passed. */
  private readonly tied: Int32Array;
  private readonly passed: Int32Array;
  /** What pick() chose: one zone a microphone, `count` of them. */
  readonly out: SampleZone[];
  count = 0;

  constructor(zones: SampleZone[], micIndex: Map<string, number>) {
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
    const mics = micIndex.size;
    const any = mics > 0 && zones.some((z) => z.mic !== undefined && micIndex.has(z.mic));
    this.micOf = any
      ? Int32Array.from(zones, (z) => (z.mic !== undefined ? (micIndex.get(z.mic) ?? mics) : mics))
      : null;
    this.tied = new Int32Array(mics + 1);
    this.passed = new Int32Array(mics + 1);
    this.out = new Array<SampleZone>(mics + 1).fill(zones[0] as SampleZone);
  }

  /** How far a zone is from a note: semitones outside its keys weigh most, then velocity. */
  private score(z: SampleZone, key: number, velocity: number): number {
    const kd = key < z.lo ? z.lo - key : key > z.hi ? key - z.hi : 0;
    const vd = velocity < z.lovel ? z.lovel - velocity : velocity > z.hivel ? velocity - z.hivel : 0;
    return kd * 1000 + vd;
  }

  /**
   * The zones a note sounds into `out` (how many in `count`, 0 for none): the one that fits best,
   * tied ones in turn; with microphones, one of each, the round robin chosen once and matched across
   * them by its number.
   */
  pick(key: number, velocity: number): number {
    const zones = this.zones;
    let bestScore = Number.POSITIVE_INFINITY;
    let first = -1;
    let ties = 0;
    for (let i = 0; i < zones.length; i++) {
      const score = this.score(zones[i] as SampleZone, key, velocity);
      if (score < bestScore) {
        bestScore = score;
        first = i;
        ties = 1;
      } else if (score === bestScore) ties++;
    }
    this.count = 0;
    if (first < 0) return 0;
    const micOf = this.micOf;
    if (micOf === null) {
      this.out[0] = this.single(first, ties, bestScore, key, velocity);
      this.count = 1;
      return 1;
    }
    // with microphones: the first tied zone's microphone leads, its turn taken as a single zone's is
    const tied = this.tied;
    const passed = this.passed;
    tied.fill(0);
    passed.fill(0);
    for (let i = first; i < zones.length; i++) {
      if (this.score(zones[i] as SampleZone, key, velocity) !== bestScore) continue;
      const g = micOf[i] as number;
      tied[g] = (tied[g] as number) + 1;
    }
    const lead = micOf[first] as number;
    const slot = this.slotOf[first] as number;
    const turn = this.rr[slot] as number;
    this.rr[slot] = (turn % (tied[lead] as number)) + 1;
    const want = turn % (tied[lead] as number);
    let chosen: SampleZone | null = null;
    for (let i = first; i < zones.length && !chosen; i++) {
      if (micOf[i] !== lead || this.score(zones[i] as SampleZone, key, velocity) !== bestScore) continue;
      if (passed[lead] === want) chosen = zones[i] as SampleZone;
      passed[lead] = (passed[lead] as number) + 1;
    }
    const leadZone = chosen ?? (zones[first] as SampleZone);
    this.out[0] = leadZone;
    this.count = 1;
    // each other microphone: its zone of the same round robin, else the one in the same turn
    for (let m = 0; m < tied.length; m++) {
      if (m === lead || tied[m] === 0) continue;
      const nth = turn % (tied[m] as number);
      let same: SampleZone | null = null;
      let inTurn: SampleZone | null = null;
      let seen = 0;
      for (let i = first; i < zones.length; i++) {
        if (micOf[i] !== m) continue;
        const z = zones[i] as SampleZone;
        if (this.score(z, key, velocity) !== bestScore) continue;
        if (z.rr === leadZone.rr) {
          same = z;
          break;
        }
        if (seen === nth) inTurn = z;
        seen++;
      }
      const z = same ?? inTurn;
      if (z) this.out[this.count++] = z;
    }
    return this.count;
  }

  /** The tied zone whose turn it is (the only one when nothing ties). */
  private single(first: number, ties: number, bestScore: number, key: number, velocity: number): SampleZone {
    const zones = this.zones;
    if (ties === 1) return zones[first] as SampleZone;
    const slot = this.slotOf[first] as number;
    const n = (this.rr[slot] as number) % ties;
    this.rr[slot] = n + 1;
    // the n-th of the tied zones, in their order
    let seen = 0;
    for (let i = first; i < zones.length; i++) {
      const z = zones[i] as SampleZone;
      if (this.score(z, key, velocity) !== bestScore) continue;
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
  /** Its knobs, as its voices read them. */
  private readonly state: SamplerState;
  /** Each microphone's index by id, and where its mono samples sit. */
  private readonly micIndex: Map<string, number>;
  private readonly micPans: Float64Array;

  private readonly spec: SamplerSpec;
  constructor(sr: number, spec: SamplerSpec, params?: Record<string, number>) {
    super(sr);
    this.spec = spec;
    this.velocityRange = spec.velocityRange;
    this.releaseVelocityRange = spec.releaseVelocityRange ?? spec.velocityRange;
    const mics = spec.mics ?? [];
    this.micIndex = new Map(mics.map((m, i) => [m.id, i]));
    this.micPans = Float64Array.from(mics, (m) => Math.max(-1, Math.min(1, m.pan ?? 0)));
    this.state = new SamplerState(mics.length);
    const set = (zones: SampleZone[]) => new ZoneSet(zones, this.micIndex);
    const triggered = spec.zones.some((z) => z.trigger !== undefined);
    this.struck = set(triggered ? spec.zones.filter((z) => z.trigger === undefined) : spec.zones);
    const parts = new Map<number, SampleZone[]>();
    for (const z of spec.zones) {
      if (z.trigger !== 'release') continue;
      const part = z.part ?? 0;
      parts.set(part, [...(parts.get(part) ?? []), z]);
    }
    this.releases = [...parts.keys()].sort((a, b) => a - b).map((p) => set(parts.get(p) as SampleZone[]));
    const down = spec.zones.filter((z) => z.trigger === 'pedalDown');
    const up = spec.zones.filter((z) => z.trigger === 'pedalUp');
    this.pedalDown = down.length ? set(down) : null;
    this.pedalUp = up.length ? set(up) : null;
    this.offCoef = Math.exp(-6.9 / (Math.max(spec.offTime ?? 0.02, 0.001) * sr));
    if (spec.polyphony) this.maxVoices = spec.polyphony;
    this.update(params);
  }

  /**
   * Its knobs (each microphone's level in dB, its default where the params have none; tune in
   * semitones; decay in percent): taken as it plays.
   */
  update(params?: Record<string, number>): void {
    const state = this.state;
    (this.spec.mics ?? []).forEach((m, i) => {
      const db = params?.[micParam(m.id)] ?? m.level ?? 0;
      state.mic[i] = !Number.isFinite(db) || db <= MIC_OFF ? 0 : 10 ** (Math.min(12, db) / 20);
    });
    const tune = params?.tune ?? 0;
    state.tune = Number.isFinite(tune) ? 2 ** (Math.max(-12, Math.min(12, tune)) / 12) : 1;
    const decay = params?.decay ?? 100;
    state.decay = Number.isFinite(decay) ? Math.max(0.05, Math.min(1, decay / 100)) : 1;
  }

  /** The gain a velocity adds over `range` dB: the layers already differ in timbre; this is a smooth curve. */
  private velocityGain(velocity: number, range = this.velocityRange): number {
    const db = -((127 - velocity) / 126) * range;
    return 10 ** (db / 20);
  }

  /** One microphone's sample of a hit (or a release sample), at its gain, its pitch and the kit's tune. */
  private layer(zone: SampleZone, key: number, gain: number): SampleLayer {
    const mic = zone.mic !== undefined ? (this.micIndex.get(zone.mic) ?? -1) : -1;
    const pan = zone.pan ?? (mic >= 0 ? (this.micPans[mic] as number) : 0);
    const ratio = (this.spec.pitched ? 2 ** ((key - zone.root) / 12) : 1) * this.state.tune;
    return new SampleLayer(zone, mic, pan, ratio, gain, mic >= 0 ? (this.state.mic[mic] as number) : 1);
  }

  protected startVoice(key: number, velocity: number): Voice | null {
    const set = this.struck;
    const count = set.pick(key, velocity);
    if (!count) return null;
    const zone = set.out[0] as SampleZone;
    const spec = this.spec;
    // the same key struck again past its limit: its oldest notes fade
    const limit = spec.notePolyphony ?? 0;
    if (limit > 0) {
      for (;;) {
        let n = 0;
        let oldest: SampleVoice | null = null;
        for (const v of this.voices as SampleVoice[]) {
          if (v.done || v.key !== key || v.isRelease || v.choking) continue;
          n++;
          if (!oldest || v.age < oldest.age) oldest = v;
        }
        if (n < limit || !oldest) break;
        oldest.choke(this.offCoef);
      }
    }
    // a note of a choke group silences what it chokes (the closed hi-hat, the open one)
    if (zone.group) {
      for (const v of this.voices as SampleVoice[]) {
        if (!v.done && v.zone.offBy === zone.group) v.choke(this.offCoef);
      }
    }
    const damped = spec.undamped === undefined || key < spec.undamped;
    const layers: SampleLayer[] = [];
    for (let i = 0; i < count; i++) {
      const z = set.out[i] as SampleZone;
      layers.push(this.layer(z, key, z.gain * this.velocityGain(velocity)));
    }
    return new SampleVoice(layers, key, this.sr, spec, this.state, velocity, this.frames, damped);
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
        const count = set.pick(v.key, v.velocity);
        let layers: SampleLayer[] | null = null;
        for (let k = 0; k < count; k++) {
          const zone = set.out[k] as SampleZone;
          const db = -(zone.decay ?? this.spec.releaseDecay ?? 0) * held;
          const gain = zone.gain * this.velocityGain(v.velocity, this.releaseVelocityRange) * 10 ** (db / 20);
          if (gain < 1e-4) continue;
          if (!layers) layers = [];
          layers.push(this.layer(zone, v.key, gain));
        }
        if (layers)
          this.addVoice(new SampleVoice(layers, v.key, this.sr, this.spec, this.state, v.velocity, this.frames));
      }
    }
  }

  /** The pedal's own sound, as it goes down or comes up (at its own pitch, whatever the keys). */
  private pedalSound(set: ZoneSet | null): void {
    const count = set?.pick(0, 127) ?? 0;
    if (!set || !count) return;
    const layers: SampleLayer[] = [];
    for (let k = 0; k < count; k++) {
      const zone = set.out[k] as SampleZone;
      const mic = zone.mic !== undefined ? (this.micIndex.get(zone.mic) ?? -1) : -1;
      const pan = zone.pan ?? (mic >= 0 ? (this.micPans[mic] as number) : 0);
      layers.push(new SampleLayer(zone, mic, pan, 1, zone.gain, mic >= 0 ? (this.state.mic[mic] as number) : 1));
    }
    this.addVoice(new SampleVoice(layers, -1, this.sr, this.spec, this.state, 127, this.frames));
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
