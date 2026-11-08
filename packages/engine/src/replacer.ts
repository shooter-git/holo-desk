/**
 * Drum Replacer: hears each hit on its own track and plays a kit piece in its place, as hard as the
 * hit was.
 *
 * Hearing a hit: the sound, in the middle and filtered to the band the piece lives in (Detect Low and
 * High keep a kick's mic from hearing the snare), is followed two ways: a fast follower that jumps
 * to each peak, and a slow one that keeps to what's been ringing. A hit is where the fast one rises
 * past the threshold and well past the slow one (Sensitivity: how far past), at least the
 * Retrigger time after the last. It began where its wave last crossed zero before that, and its
 * loudest moment in the next four milliseconds is how hard it was.
 *
 * Playing it: the hit's level above the threshold, through the dynamics curve, is a velocity, and the
 * kit plays the piece at that velocity. With Look-ahead the track is held back a few milliseconds
 * (the mixer keeps everything else in time with it) so that each hit is measured before it sounds and
 * the piece lands on the very attack; in Low Latency Mode nothing is held back and each piece comes
 * those few milliseconds late. Mix goes from the recording alone through both at full to the kit alone.
 *
 * The kit is the plugin's settings.kit: a pack's kit by its instrument key (`pack/name`), a drum
 * machine (`synth:Analog Machine`), or with none the built-in Drum Synth.
 */
import { DRUM_PIECES, paramValue } from '@holo/session';
import { DrumSynth } from './drums.ts';
import { Biquad, dbToGain } from './dsp.ts';
import type { Effect, Host } from './fx.ts';
import type { Instrument } from './instrument.ts';
import { DrumMachine, MACHINE_PRESETS } from './machine.ts';
import type { SamplerSpec } from './protocol.ts';
import { Sampler } from './sampler.ts';

/** Milliseconds a hit is measured over once heard (long enough to reach a 60 Hz kick's first peak). */
const MEASURE_MS = 4;
/** How far back a hit can have begun before it was heard (a low drum rises over its first quarter wave). */
const BACK_MS = 2;
/** The longest look-ahead (the table's Look-ahead goes to 10 ms). */
const MAX_LOOK_MS = 10;
/** Hits waiting to sound at once, at most. */
const PENDING = 32;

/** What `kit` names: '' the Drum Synth, `synth:` and a preset a drum machine, else a pack kit. */
export function kitSource(kit: string | undefined): { kind: 'synth'; preset: string } | { kind: 'pack'; key: string } {
  const k = (kit ?? '').trim();
  if (!k || k === 'synth:Drum Synth') return { kind: 'synth', preset: 'Drum Synth' };
  if (k.startsWith('synth:')) return { kind: 'synth', preset: k.slice(6) };
  return { kind: 'pack', key: k };
}

/**
 * Hears hits, a frame at a time (the effect and Hits to MIDI run the very same one). After each
 * frame, `fired` says whether a hit has just been measured: it began `ago` frames before the next
 * one (where its wave rose from nothing or last crossed zero before it was heard), and `level` was
 * its loudest.
 */
export class HitDetector {
  fired = false;
  ago = 0;
  level = 0;
  /** The frames it's measured over once heard, and the most it can have begun before. */
  readonly measure: number;
  readonly back: number;
  private readonly lo = new Biquad();
  private readonly hi = new Biquad();
  private threshold = 0.03;
  private ratio = 2.7;
  private hold = 0;
  private readonly fastRel: number;
  private readonly slowAtt: number;
  private readonly slowRel: number;
  private fast = 0;
  private slow = 0;
  private wait = 0;
  private measuring = -1;
  private began = 0;
  private peak = 0;
  /** The band's last frames, to find where a hit began. */
  private readonly past: Float32Array;
  private readonly mask: number;
  private w = 0;
  private readonly sr: number;
  constructor(sr: number) {
    this.sr = sr;
    this.measure = Math.max(1, Math.round((MEASURE_MS / 1000) * sr));
    this.back = Math.round((BACK_MS / 1000) * sr);
    let size = 16;
    while (size < this.back + 4) size <<= 1;
    this.past = new Float32Array(size);
    this.mask = size - 1;
    this.fastRel = Math.exp(-1 / (0.01 * sr));
    this.slowAtt = 1 - Math.exp(-1 / (0.015 * sr));
    this.slowRel = 1 - Math.exp(-1 / (0.03 * sr));
  }
  set(p: Record<string, number>): void {
    const v = (id: string) => paramValue('replacer', p, id);
    const sr = this.sr;
    this.threshold = dbToGain(v('threshold'));
    // how far the attack must rise over what's ringing: 4× at the least sensitive, 1.15× at the most
    this.ratio = 1.15 + (1 - v('sensitivity') / 100) * 2.85;
    this.hold = Math.max(this.measure, Math.round((v('hold') / 1000) * sr));
    const lo = Math.min(v('lowcut'), v('highcut') * 0.5);
    this.lo.set('highpass', lo, Math.SQRT1_2, 0, sr);
    this.hi.set('lowpass', v('highcut'), Math.SQRT1_2, 0, sr);
  }
  step(a: number, b: number): void {
    this.fired = false;
    const mid = (a + b) * 0.5;
    this.lo.run(mid);
    this.hi.run(this.lo.y);
    // (the band says what's a hit; the sound itself where it began and how loud: a low cut leads a
    // kick's wave by milliseconds, and takes its first peak down)
    this.past[this.w] = mid;
    const x = Math.abs(this.hi.y);
    this.fast = x > this.fast ? x : this.fast * this.fastRel;
    // what was ringing until now (before this frame raises it)
    const ringing = this.slow;
    this.slow += (x - this.slow) * (x > this.slow ? this.slowAtt : this.slowRel);
    if (this.wait > 0) this.wait--;
    if (this.measuring >= 0) {
      const level = Math.max(Math.abs(a), Math.abs(b));
      if (level > this.peak) this.peak = level;
      if (++this.measuring >= this.measure) this.fire();
    } else if (this.wait === 0 && this.fast > this.threshold && this.fast > ringing * this.ratio) {
      this.wait = this.hold;
      this.peak = Math.max(Math.abs(a), Math.abs(b));
      this.measuring = 1;
      // where it began: back to where its wave rose from (near) nothing, or last crossed zero
      const floor = Math.max(this.threshold, ringing * this.ratio) * 0.15;
      const sign = mid >= 0;
      let k = 0;
      while (k < this.back) {
        const y = this.past[(this.w - k - 1) & this.mask] as number;
        if (y >= 0 !== sign || Math.abs(y) < floor) break;
        k++;
      }
      this.began = k;
      if (this.measure === 1) this.fire();
    }
    this.w = (this.w + 1) & this.mask;
  }
  private fire(): void {
    this.fired = true;
    this.ago = this.measure + this.began;
    this.level = this.peak;
    this.measuring = -1;
  }
  reset(): void {
    this.lo.reset();
    this.hi.reset();
    this.fast = this.slow = 0;
    this.wait = 0;
    this.measuring = -1;
    this.past.fill(0);
  }
}

/** The dynamics curve's settings: the threshold (dB), the curve's power and how much of the range it uses. */
interface Dynamics {
  threshold: number;
  power: number;
  dynamics: number;
}

function dynamicsOf(p: Record<string, number>): Dynamics {
  const v = (id: string) => paramValue('replacer', p, id);
  return { threshold: v('threshold'), power: 2 ** (v('curve') / 50), dynamics: v('dynamics') / 100 };
}

/** A hit's velocity (1–127) from its level: how far above the threshold it was, towards full scale, through the curve. */
function velocityOf(level: number, d: Dynamics): number {
  const db = level > 1e-9 ? 20 * Math.log10(level) : -180;
  const u = Math.min(1, Math.max(0, (db - d.threshold) / Math.max(1, -d.threshold)));
  const shaped = u ** d.power;
  return Math.max(1, Math.min(127, Math.round(127 * (1 - d.dynamics + d.dynamics * shaped))));
}

/** A hit's velocity (1–127) from its level, by the plugin's threshold, dynamics and curve. */
export function hitVelocity(level: number, p: Record<string, number>): number {
  return velocityOf(level, dynamicsOf(p));
}

/** A hit heard in a recording: where it began (frames from the start) and how hard it was. */
export interface DetectedHit {
  frame: number;
  velocity: number;
}

/** Every hit in a recording, as a Drum Replacer with these settings hears it (Hits to MIDI). */
export function detectHits(channels: Float32Array[], sr: number, params: Record<string, number>): DetectedHit[] {
  const left = channels[0];
  if (!left) return [];
  const right = channels[1] ?? left;
  const det = new HitDetector(sr);
  det.set(params);
  const dyn = dynamicsOf(params);
  const out: DetectedHit[] = [];
  for (let i = 0; i < left.length; i++) {
    det.step(left[i] as number, right[i] as number);
    if (det.fired) out.push({ frame: i + 1 - det.ago, velocity: velocityOf(det.level, dyn) });
  }
  return out;
}

export class DrumReplacer implements Effect {
  gr = 0;
  private readonly det: HitDetector;
  private readonly dyn: Dynamics = { threshold: -30, power: 1, dynamics: 0.8 };
  private key = 36;
  private look = 0;
  private keepGain = 0;
  private kitGain = 1;
  private kitKey = '';
  private kitSpec: SamplerSpec | null = null;
  private kit: Instrument | null = null;
  /** The track held back by the look-ahead. */
  private readonly delayL: Float32Array;
  private readonly delayR: Float32Array;
  private readonly mask: number;
  private w = 0;
  /** Frames heard so far, and the hits measured but not yet played (when, how hard). */
  private t = 0;
  private readonly dueAt = new Float64Array(PENDING);
  private readonly dueVel = new Float64Array(PENDING);
  private head = 0;
  private count = 0;
  private kitL = new Float32Array(256);
  private kitR = new Float32Array(256);
  private readonly host: Host;
  constructor(host: Host) {
    this.host = host;
    this.det = new HitDetector(host.sr);
    let size = 16;
    while (size < (MAX_LOOK_MS / 1000) * host.sr + 4) size <<= 1;
    this.delayL = new Float32Array(size);
    this.delayR = new Float32Array(size);
    this.mask = size - 1;
  }
  setParams(p: Record<string, number>, settings?: Record<string, string>): void {
    const v = (id: string) => paramValue('replacer', p, id);
    Object.assign(this.dyn, dynamicsOf(p));
    this.det.set(p);
    this.key = DRUM_PIECES[Math.round(v('piece'))]?.key ?? 36;
    this.look = Math.round((v('lookahead') / 1000) * this.host.sr);
    const mix = v('mix') / 100;
    this.keepGain = Math.min(1, 2 * (1 - mix));
    this.kitGain = Math.min(1, 2 * mix) * dbToGain(v('level'));
    const kit = settings?.kit ?? '';
    if (kit !== this.kitKey || !this.kit) {
      this.kitKey = kit;
      this.kitSpec = null;
      this.kit = null;
      this.refresh();
    }
  }
  /** The look-ahead the track is held back by (none in Low Latency Mode). */
  get latency(): number {
    return this.host.lowLatency ? 0 : this.look;
  }
  /** The kit, made once what it plays is here (a pack kit's samples come when they've loaded). */
  refresh(): void {
    const src = kitSource(this.kitKey);
    if (src.kind === 'synth') {
      if (this.kit) return;
      this.kit = MACHINE_PRESETS.includes(src.preset)
        ? new DrumMachine(this.host.sr, src.preset)
        : new DrumSynth(this.host.sr);
      return;
    }
    const spec = this.host.sampler?.(src.key) ?? null;
    if (spec === this.kitSpec && (this.kit || !spec)) return;
    this.kitSpec = spec;
    this.kit = spec ? new Sampler(this.host.sr, spec) : null;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    if (!this.kit && this.kitKey) this.refresh();
    if (this.kitL.length < n) {
      this.kitL = new Float32Array(n);
      this.kitR = new Float32Array(n);
    }
    const { det, delayL, delayR, mask } = this;
    const live = this.host.lowLatency;
    const look = live ? 0 : this.look;
    // a hit plays where it began, once it's been measured: on time when the look-ahead covers the measuring
    const t0 = this.t;
    let w = this.w;
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      det.step(a, b);
      if (det.fired) this.queue(Math.max(t0 + i + 1 - det.ago + look, t0 + i + 1), velocityOf(det.level, this.dyn));
      if (look > 0) {
        delayL[w] = a;
        delayR[w] = b;
        const rd = (w - look) & mask;
        l[i] = delayL[rd] as number;
        r[i] = delayR[rd] as number;
        w = (w + 1) & mask;
      }
    }
    this.w = w;
    this.t = t0 + n;
    // the kit, its hits started on their frames
    const { kitL, kitR } = this;
    kitL.fill(0, 0, n);
    kitR.fill(0, 0, n);
    const kit = this.kit;
    let at = 0;
    while (this.count > 0) {
      const due = this.dueAt[this.head] as number;
      if (due >= t0 + n) break;
      const off = Math.max(0, Math.min(n, due - t0));
      if (kit && off > at) {
        kit.render(kitL, kitR, at, off);
        at = off;
      }
      kit?.noteOn(this.key, this.dueVel[this.head] as number);
      this.head = (this.head + 1) % PENDING;
      this.count--;
    }
    if (kit && n > at) kit.render(kitL, kitR, at, n);
    const keep = this.keepGain;
    const gain = this.kitGain;
    for (let i = 0; i < n; i++) {
      l[i] = (l[i] as number) * keep + (kitL[i] as number) * gain;
      r[i] = (r[i] as number) * keep + (kitR[i] as number) * gain;
    }
  }
  private queue(at: number, velocity: number): void {
    if (this.count >= PENDING) return;
    const i = (this.head + this.count) % PENDING;
    this.dueAt[i] = at;
    this.dueVel[i] = velocity;
    this.count++;
  }
  silence(): void {
    this.kit?.allNotesOff(true);
    this.count = 0;
  }
  reset(): void {
    this.det.reset();
    this.delayL.fill(0);
    this.delayR.fill(0);
    this.count = 0;
    this.kit?.allNotesOff(true);
  }
}
