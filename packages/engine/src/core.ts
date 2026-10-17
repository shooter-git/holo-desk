/**
 * The engine: the whole studio's sound in one object, the same code wherever it runs (the studio's
 * audio thread, its bounces, and headless renders on a server or the command line). Live MIDI is read from shared
 * memory at the start of every render quantum, so a key you press sounds in the very next block.
 * The song plays from event lists the main thread compiles; tracks run their MIDI effects, their
 * instruments and their channel strips; buses and the master follow.
 */

import { AHEAD_BLOCK, type AheadEdge, AheadLink, aheadPlan } from './ahead.ts';
import type { PreparedImpulse } from './convolver.ts';
import { DrumSynth } from './drums.ts';
import { Biquad, dbToGain, Smooth } from './dsp.ts';
import { createEffect, type Effect, type Host } from './fx.ts';
import { GlassLineVoice, GlassVoice } from './glass.ts';
import type { Instrument } from './instrument.ts';
import { createMidiEffect, EventList, type MidiEffect, type MidiHost } from './midifx.ts';
import type { PartPlans } from './parts.ts';
import { PlanVoice, type SampleData } from './performance.ts';
import {
  type ChannelSpec,
  type ClipSpec,
  EV_BEND,
  EV_CC,
  EV_OFF,
  EV_ON,
  EV_PRESSURE,
  EVENT_INTS,
  EVENT_SIZE,
  type FromWorklet,
  type GraphSpec,
  type InputSpec,
  type InstrumentSpec,
  METER_CHANNELS,
  METER_FLOATS,
  type PluginSpec,
  RING_EVENTS,
  RING_HEADER,
  type SamplerSpec,
  type SeatSpec,
  type TempoSegment,
  type ToWorklet,
  TR_FINE_CLOCK,
  TR_LOAD,
  TR_LOAD_PEAK,
  TR_OVERLOADS,
  TRANSPORT_FLOATS,
  type TrackSpec,
} from './protocol.ts';
import { Sampler } from './sampler.ts';
import { Synth } from './synth.ts';

const MAX_BLOCK = 1024;
/**
 * Frames faded where a clip cuts into its audio (not where the audio itself starts or ends), even
 * without a fade, so a cut mid-wave never clicks; a whole recording plays untouched, so a loop's
 * audio meets itself at the seam.
 */
const DECLICK = 64;
const METER_FALL = 0.9939; // about 20 dB a second at 48 kHz, 128-frame blocks

/**
 * Rendering ahead (ahead.ts): how an engine plays a strip. Its own: all of it (the song, and live
 * notes on the audio thread). A twin (on the audio thread, for a strip a worker plays): only what
 * comes in live. Not at all (on a worker, a strip another engine plays).
 */
const ROLE_OWN = 0;
const ROLE_TWIN = 1;
const ROLE_NONE = 2;

/**
 * What an engine does with one of a strip's connections: nothing; add it here; hand it to the engine
 * that plays where it goes; take it in from the engine that played it; take it in and add the twin's
 * sound; or add the twin's sound only.
 */
const EDGE_SKIP = 0;
const EDGE_LOCAL = 1;
const EDGE_HAND = 2;
const EDGE_TAKE = 3;
const EDGE_TAKE_TWIN = 4;
const EDGE_TWIN = 5;

/** A twin falls asleep after this long without a sound (longer than any delay's echo, or a hall's pre-delay). */
const TWIN_HOLD_SECONDS = 4;
/** Quieter than this is silence, for a twin (-140 dB). */
const TWIN_SILENT = 1e-7;

interface EdgePlan {
  kind: 0 | 1 | 2;
  /** The send (kind 1) or seat send (kind 2) it is. */
  index: number;
  dest: Strip;
  mode: number;
  slot: number;
}

interface Insert {
  id: string;
  type: string;
  bypass: boolean;
  effect: Effect;
  json: string;
  /** The parameters as set (automation changes one at a time on top of them). */
  params: Record<string, number>;
  settings: Record<string, string> | undefined;
}

interface Lane {
  param: string;
  points: number[];
  stepped: boolean;
  smooth: boolean;
  /** The last value applied, so a plugin is only re-tuned when its value moves. */
  last: number;
}

/** A lane's value at a frame: a straight line (or a cosine ease) between points, held outside them. */
function laneAt(points: number[], frame: number, stepped: boolean, smooth = false): number {
  if (frame <= (points[0] as number)) return points[1] as number;
  for (let i = 2; i < points.length; i += 2) {
    const f1 = points[i] as number;
    if (frame < f1) {
      const f0 = points[i - 2] as number;
      const v0 = points[i - 1] as number;
      if (stepped || f1 === f0) return v0;
      let u = (frame - f0) / (f1 - f0);
      if (smooth) u = 0.5 - 0.5 * Math.cos(Math.PI * u);
      return v0 + ((points[i + 1] as number) - v0) * u;
    }
  }
  return points[points.length - 1] as number;
}

/**
 * A lane's value at every frame of a block, into `out`: through the block's spans of the song (two
 * across a cycle jump), or held where the playhead stands when there are none.
 */
function fillLane(lane: Lane, spans: Float64Array, count: number, n: number, at: number, out: Float64Array): void {
  const { points, stepped, smooth } = lane;
  if (count === 0) {
    out.fill(laneAt(points, at, stepped, smooth), 0, n);
    return;
  }
  for (let s = 0; s < count; s++) {
    const o = spans[s * 3] as number;
    const f = spans[s * 3 + 1] as number;
    const c = spans[s * 3 + 2] as number;
    // the segment the span starts in, then forward
    let lo = 0;
    let hi = points.length / 2 - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if ((points[mid * 2] as number) <= f) lo = mid;
      else hi = mid - 1;
    }
    let seg = lo;
    for (let i = 0; i < c; i++) {
      const frame = f + i;
      while (seg * 2 + 2 < points.length && frame >= (points[seg * 2 + 2] as number)) seg++;
      const f0 = points[seg * 2] as number;
      const v0 = points[seg * 2 + 1] as number;
      if (frame <= f0 || seg * 2 + 2 >= points.length) {
        out[o + i] = frame <= (points[0] as number) ? (points[1] as number) : v0;
        continue;
      }
      const f1 = points[seg * 2 + 2] as number;
      if (stepped || f1 === f0) {
        out[o + i] = v0;
        continue;
      }
      let u = (frame - f0) / (f1 - f0);
      if (smooth) u = 0.5 - 0.5 * Math.cos(Math.PI * u);
      out[o + i] = v0 + ((points[seg * 2 + 3] as number) - v0) * u;
    }
  }
  // frames outside the spans (before the song starts, in a count-in) hold the first value
  if (count && (spans[0] as number) > 0) out.fill(points[1] as number, 0, spans[0] as number);
}

/**
 * One connection's share of plugin delay compensation: a stereo delay that holds a path back by as
 * much as the slowest path into the same place is behind it, so everything arrives together.
 */
class Compensation {
  delay = 0;
  private bl = new Float32Array(0);
  private br = new Float32Array(0);
  private w = 0;
  readonly l = new Float32Array(MAX_BLOCK);
  readonly r = new Float32Array(MAX_BLOCK);
  set(delay: number): void {
    if (delay === this.delay) return;
    this.delay = delay;
    let size = 1;
    while (size < delay + MAX_BLOCK) size <<= 1;
    if (this.bl.length < size) {
      this.bl = new Float32Array(size);
      this.br = new Float32Array(size);
    } else {
      this.bl.fill(0);
      this.br.fill(0);
    }
    this.w = 0;
  }
  /** `n` frames in; the same many, `delay` frames older, out in l and r. */
  run(inL: Float32Array, inR: Float32Array, n: number): void {
    const mask = this.bl.length - 1;
    for (let i = 0; i < n; i++) {
      const w = (this.w + i) & mask;
      this.bl[w] = inL[i] as number;
      this.br[w] = inR[i] as number;
      const rd = (w - this.delay) & mask;
      this.l[i] = this.bl[rd] as number;
      this.r[i] = this.br[rd] as number;
    }
    this.w = (this.w + n) & mask;
  }
}

/** One seat of a stage, running: its depth filter and gain, and its sends. */
interface SeatNode {
  lp: Biquad;
  gain: number;
  sends: Map<string, number>;
}

/** A send from a stage's seats to a bus: both seats' levels for it, and its gain at each frame. */
interface SeatSend {
  bus: string;
  near: number;
  far: number;
  gain: Float64Array;
  comp: Compensation;
}

const seatDepth = (s: SeatSpec, sr: number): SeatNode => {
  const lp = new Biquad();
  lp.set('lowpass', 18000 - 8000 * s.depth, 0.6, 0, sr);
  return { lp, gain: 10 ** ((-7 * s.depth) / 20), sends: new Map(s.sends.map((x) => [x.bus, dbToGain(x.level)])) };
};

class Strip {
  readonly l = new Float32Array(MAX_BLOCK);
  readonly r = new Float32Array(MAX_BLOCK);
  readonly preL = new Float32Array(MAX_BLOCK);
  readonly preR = new Float32Array(MAX_BLOCK);
  /** With a stage: the sound after the fader, before the seats set it back (what sends hear). */
  readonly postL = new Float32Array(MAX_BLOCK);
  readonly postR = new Float32Array(MAX_BLOCK);
  num = 0;
  id = '';
  vol: Smooth;
  panL: Smooth;
  panR: Smooth;
  mute = false;
  audible = true;
  inserts: Insert[] = [];
  sends: {
    bus: string;
    gain: Smooth;
    pre: boolean;
    comp: Compensation;
    lane: Lane | null;
    frames: Float64Array;
    /** A lane's last value and its gain (worked out again only when it moves). */
    lastDb: number;
    lastGain: number;
  }[] = [];
  output = 'master';
  /** The delay compensation on the way to the output. */
  readonly outComp = new Compensation();
  /** Frames this strip's sound is behind the song when it leaves (plugin delays on the way, its own too). */
  outLatency = 0;
  gr = 0;
  /** The plugin whose window is open, and its own gain reduction. */
  watch = '';
  watchGr = 0;
  /** Lanes taken once a block (mute, plugins); the fader, balance, sends and distance move every frame. */
  lanes: Lane[] = [];
  private autoMute = false;
  private volLane: Lane | null = null;
  private panLane: Lane | null = null;
  private distLane: Lane | null = null;
  private readonly volFrames = new Float64Array(MAX_BLOCK);
  private readonly panFrames = new Float64Array(MAX_BLOCK);
  private readonly distFrames = new Float64Array(MAX_BLOCK);
  /** A stage: its two seats, the distance between them, and what they send. */
  private near: SeatNode | null = null;
  private far: SeatNode | null = null;
  private distance: Smooth;
  seatSends: SeatSend[] = [];
  /** Rendering ahead: how this engine plays the strip, its connections' plans, and its twin's state. */
  role = ROLE_OWN;
  plan: EdgePlan[] = [];
  /** Connections it hands to another engine (its progress is published once they're out). */
  hands = false;
  /** It has been played here (its plugins' state is its own), and for how many blocks it has been timed. */
  ran = false;
  timed = 0;
  /** The block its twin last made a sound, and whether a twin's sound reached it this block. */
  twinSeen = -1e9;
  twinIn = false;
  private stageKey = '';
  private readonly nearL = new Float32Array(MAX_BLOCK);
  private readonly nearR = new Float32Array(MAX_BLOCK);
  private readonly farL = new Float32Array(MAX_BLOCK);
  private readonly farR = new Float32Array(MAX_BLOCK);
  private readonly cn = new Float64Array(MAX_BLOCK);
  private readonly cf = new Float64Array(MAX_BLOCK);

  readonly sr: number;
  constructor(sr: number) {
    this.sr = sr;
    this.vol = new Smooth(1, sr);
    this.panL = new Smooth(1, sr);
    this.panR = new Smooth(1, sr);
    this.distance = new Smooth(0, sr);
  }

  apply(spec: ChannelSpec, host: Host): void {
    this.num = spec.num;
    this.id = spec.id;
    this.vol.set(dbToGain(spec.volume));
    // balance: the centre is unity; turning left fades the right side out, and the reverse
    this.panL.set(Math.min(1, 1 - spec.pan));
    this.panR.set(Math.min(1, 1 + spec.pan));
    this.mute = spec.mute;
    this.output = spec.output || 'master';
    this.inserts = reconcile(this.inserts, spec.inserts, host);
    const lanes = spec.automation.map((a) => ({ ...a, smooth: a.smooth ?? false, last: Number.NaN }));
    const take = (param: string) => lanes.find((l) => l.param === param) ?? null;
    this.volLane = take('volume');
    this.panLane = take('pan');
    this.distLane = spec.stage ? take('distance') : null;
    this.sends = spec.sends.map((s) => {
      const old = this.sends.find((x) => x.bus === s.bus);
      const gain = old?.gain ?? new Smooth(dbToGain(s.level), this.sr);
      gain.set(dbToGain(s.level));
      return {
        bus: s.bus,
        gain,
        pre: s.pre,
        comp: old?.comp ?? new Compensation(),
        lane: take(`send:${s.bus}`),
        frames: old?.frames ?? new Float64Array(MAX_BLOCK),
        lastDb: Number.NaN,
        lastGain: 0,
      };
    });
    this.lanes = lanes.filter(
      (l) => l.param !== 'volume' && l.param !== 'pan' && l.param !== 'distance' && !l.param.startsWith('send:'),
    );
    this.autoMute = false;
    this.applyStage(spec);
  }

  /** The stage's seats, kept (filters and all) while they stay as they are. */
  private applyStage(spec: ChannelSpec): void {
    const st = spec.stage;
    if (!st) {
      this.near = this.far = null;
      this.seatSends = [];
      this.stageKey = '';
      return;
    }
    this.distance.set(Math.max(0, Math.min(1, st.distance)), !this.near);
    const key = JSON.stringify([st.near, st.far]);
    if (key === this.stageKey && this.near) return;
    this.stageKey = key;
    this.near = seatDepth(st.near, this.sr);
    this.far = seatDepth(st.far, this.sr);
    const buses = [...new Set([...this.near.sends.keys(), ...this.far.sends.keys()])];
    this.seatSends = buses.map((bus) => ({
      bus,
      near: this.near?.sends.get(bus) ?? 0,
      far: this.far?.sends.get(bus) ?? 0,
      gain: new Float64Array(MAX_BLOCK),
      comp: this.seatSends.find((x) => x.bus === bus)?.comp ?? new Compensation(),
    }));
  }

  /** Automation in Read: the settings at the playhead (playing or not, as Logic does). */
  automate(frame: number): void {
    this.autoMute = false;
    for (const lane of this.lanes) {
      const v = laneAt(lane.points, frame, lane.stepped, lane.smooth);
      const p = lane.param;
      if (p === 'mute') this.autoMute = v >= 0.5;
      else if (p.startsWith('fx:') && v !== lane.last) {
        const [, id, param] = p.split(':');
        const ins = this.inserts.find((x) => x.id === id);
        if (ins && param) {
          ins.params = { ...ins.params, [param]: v };
          ins.effect.setParams(ins.params, ins.settings);
        }
      }
      lane.last = v;
    }
  }

  /** The lanes that move every frame (fader, balance, sends, distance), across this block's spans of the song. */
  automateFrames(spans: Float64Array, count: number, n: number, at: number): void {
    if (this.volLane) fillLane(this.volLane, spans, count, n, at, this.volFrames);
    if (this.panLane) fillLane(this.panLane, spans, count, n, at, this.panFrames);
    if (this.distLane) fillLane(this.distLane, spans, count, n, at, this.distFrames);
    for (const s of this.sends) if (s.lane) fillLane(s.lane, spans, count, n, at, s.frames);
  }

  /** A send's gain at frame i of the block. */
  sendGain(s: Strip['sends'][number], i: number): number {
    if (!s.lane) return s.gain.next();
    const d = s.frames[i] as number;
    if (d !== s.lastDb) {
      s.lastDb = d;
      s.lastGain = dbToGain(d);
    }
    return s.lastGain;
  }

  /** Frames the strip's plugins delay its sound by. */
  latency(): number {
    let total = 0;
    for (const ins of this.inserts) if (!ins.bypass) total += ins.effect.latency ?? 0;
    return total;
  }

  /** Inserts, then fader and balance (and a stage's seats); fills the pre-fader copy for pre sends. */
  run(n: number): void {
    let gr = 0;
    this.watchGr = 0;
    for (const ins of this.inserts) {
      if (ins.bypass) continue;
      ins.effect.process(this.l, this.r, n);
      if (ins.effect.gr < gr) gr = ins.effect.gr;
      if (ins.id === this.watch) this.watchGr = ins.effect.gr;
    }
    this.gr = gr;
    this.preL.set(this.l.subarray(0, n));
    this.preR.set(this.r.subarray(0, n));
    const on = this.audible && !this.mute && !this.autoMute ? 1 : 0;
    const { volLane, panLane, volFrames, panFrames } = this;
    // a lane's gain, worked out again only when its value moves
    let lastDb = Number.NaN;
    let lastGain = 0;
    for (let i = 0; i < n; i++) {
      let g: number;
      if (volLane) {
        const d = volFrames[i] as number;
        if (d !== lastDb) {
          lastDb = d;
          lastGain = dbToGain(d);
        }
        g = lastGain;
      } else g = this.vol.next();
      const v = g * on;
      let pl: number;
      let pr: number;
      if (panLane) {
        const pan = Math.max(-1, Math.min(1, panFrames[i] as number));
        pl = Math.min(1, 1 - pan);
        pr = Math.min(1, 1 + pan);
      } else {
        pl = this.panL.next();
        pr = this.panR.next();
      }
      this.l[i] = (this.l[i] as number) * v * pl;
      this.r[i] = (this.r[i] as number) * v * pr;
    }
    if (this.near && this.far) this.seat(this.near, this.far, n);
  }

  /**
   * The stage: the sound shared between the seats at equal power by distance, each seat's share set
   * back by its depth (darker, quieter) and the two summed for the direct sound; the seats' sends take
   * the sound before that, each at its seats' levels.
   */
  private seat(near: SeatNode, far: SeatNode, n: number): void {
    const { l, r, cn, cf, nearL, nearR, farL, farR } = this;
    this.postL.set(l.subarray(0, n));
    this.postR.set(r.subarray(0, n));
    for (let i = 0; i < n; i++) {
      const d = this.distLane ? Math.max(0, Math.min(1, this.distFrames[i] as number)) : this.distance.next();
      const a = Math.cos((d * Math.PI) / 2);
      const b = Math.sin((d * Math.PI) / 2);
      cn[i] = a;
      cf[i] = b;
      nearL[i] = (l[i] as number) * a;
      nearR[i] = (r[i] as number) * a;
      farL[i] = (l[i] as number) * b;
      farR[i] = (r[i] as number) * b;
    }
    near.lp.process(nearL, nearR, n);
    far.lp.process(farL, farR, n);
    for (let i = 0; i < n; i++) {
      l[i] = (nearL[i] as number) * near.gain + (farL[i] as number) * far.gain;
      r[i] = (nearR[i] as number) * near.gain + (farR[i] as number) * far.gain;
    }
    for (const s of this.seatSends) {
      for (let i = 0; i < n; i++) s.gain[i] = (cn[i] as number) * s.near + (cf[i] as number) * s.far;
    }
  }

  /** What a post-fader send hears: with a stage, the sound before its seats set it back. */
  get sendL(): Float32Array {
    return this.near ? this.postL : this.l;
  }
  get sendR(): Float32Array {
    return this.near ? this.postR : this.r;
  }

  clear(n: number): void {
    this.l.fill(0, 0, n);
    this.r.fill(0, 0, n);
  }
}

function reconcile(old: Insert[], specs: PluginSpec[], host: Host): Insert[] {
  const out: Insert[] = [];
  for (const s of specs) {
    const json = JSON.stringify([s.params, s.settings ?? null]);
    let ins = old.find((x) => x.id === s.id && x.type === s.type);
    if (!ins) {
      const effect = createEffect(s.type, host);
      if (!effect) continue;
      effect.setParams(s.params, s.settings);
      ins = { id: s.id, type: s.type, bypass: s.bypass, effect, json, params: s.params, settings: s.settings };
    } else if (ins.json !== json) {
      ins.effect.setParams(s.params, s.settings);
      ins.json = json;
      ins.params = s.params;
      ins.settings = s.settings;
    }
    ins.bypass = s.bypass;
    out.push(ins);
  }
  return out;
}

interface MidiFxSlot {
  id: string;
  type: string;
  bypass: boolean;
  fx: MidiEffect;
  json: string;
}

/** A take being recorded on an audio track, sent to the page a second at a time. */
interface Capture {
  take: number;
  /** Song frame of the chunk's first sample. */
  frame: number;
  left: Float32Array;
  right: Float32Array | null;
  fill: number;
  done: boolean;
}

/** A note of a planned part, sounding. */
interface Sounding {
  done: boolean;
  skip(count: number): void;
  play(l: Float32Array, r: Float32Array, offset: number, count: number): boolean;
}

/** A track's planned part: what starts when, the next to start, and what's sounding. */
interface PartRuntime {
  plans: PartPlans;
  /** Each plan's start and length (frames), in start order, and a voice for it. */
  entries: { at: number; length: number; make: () => Sounding | null }[];
  next: number;
  voices: Sounding[];
  /** The song frame it has played up to: a span that starts elsewhere has jumped (round a cycle). */
  until: number;
}

class TrackNode extends Strip {
  clips: ClipSpec[] = [];
  part: PartRuntime | null = null;
  input: InputSpec | null = null;
  capture: Capture | null = null;
  instKey = '';
  instruments: (Instrument | null)[] = [];
  midiFx: MidiFxSlot[] = [];
  seq: Float64Array<ArrayBufferLike> = new Float64Array(0);
  cursor = 0;
  /** Notes the song started and hasn't ended: ended on stop, locate or a cycle jump. */
  readonly seqHeld = new Set<number>();
  readonly events = new EventList();
  readonly work = new EventList();
  spec: TrackSpec | null = null;
}

/** What the engine says back: to the page's thread in the studio, to the caller elsewhere. */
export type EnginePost = (msg: FromWorklet, transfer?: ArrayBuffer[]) => void;

/** Rendering ahead: this engine (a worker, or -1 for the audio thread) among the others. */
interface Split {
  self: number;
  link: AheadLink;
  /** As the page sent them, by channel number. */
  owners: number[];
  /** The block being played: its place in the ring. */
  block: number;
  warned: boolean;
}

export class EngineCore implements Host {
  readonly sr: number;
  lowLatency = false;
  private tracks = new Map<number, TrackNode>();
  private trackOrder: TrackNode[] = [];
  private buses: Strip[] = [];
  /** The tracks and buses in mix order (and with the master), kept with the graph. */
  private mixStrips: Strip[] = [];
  private allStrips: Strip[] = [];
  private busById = new Map<string, Strip>();
  private master: Strip;
  private samplers = new Map<string, SamplerSpec>();
  private ring: Int32Array | null = null;
  private meters: Float32Array | null = null;
  private transport: Float64Array | null = null;
  private fallbackMeters = new Float32Array(METER_CHANNELS * METER_FLOATS);
  private fallbackTransport = new Float64Array(TRANSPORT_FLOATS);
  private liveQueue: number[] = [];
  private playing = false;
  private recording = false;
  private pos = 0;
  private cycle = { on: false, start: 0, end: 0, wrap: false };
  private tempo: TempoSegment[];
  private ppq = 960;
  private beatTicks = 960;
  private barTicks = 3840;
  private metronome = false;
  private clickLevel = 0.5;
  private clickPhase = 0;
  private clickEnv = 0;
  private clickFreq = 1000;
  private clickNext = 1;
  private sendCounter = 0;
  private failed = false;
  /** Audio for clips, by key. */
  private audio = new Map<string, Float32Array[]>();
  /** Space Designer responses, prepared, by key. */
  private impulses = new Map<string, PreparedImpulse>();
  /** Performance instruments' sample files, by instrument and file index. */
  private perfData = new Map<string, Map<number, SampleData>>();
  private takes = 0;
  /** This block on the song's timeline: up to two spans (two across a cycle jump) of [block offset, song frame, frames]. */
  private spans = new Float64Array(6);
  private spanCount = 0;
  /** The last transport command taken in (the page waits for it before trusting the playhead). */
  private lastCmd = 0;
  /** Frames the mix's sound is behind the song (plugin delays, compensated across every path). */
  latency = 0;
  /** Rendering ahead (ahead.ts): this engine's share of the mix, and the memory it hands sound over through. */
  private split: Split | null = null;
  /** While a strip this engine doesn't play is set up: its plugins don't build what only playing needs. */
  private dormant = false;
  /** A connection's gains for a block, and twins' meters (rendering ahead). */
  private readonly gains = new Float64Array(MAX_BLOCK);
  private readonly twinMeters = new Float32Array(METER_CHANNELS * METER_FLOATS);

  private readonly send: EnginePost;
  private readonly midiHost: MidiHost;

  constructor(sr: number, post: EnginePost) {
    this.sr = sr;
    this.send = post;
    this.master = new Strip(sr);
    this.allStrips = [this.master];
    this.tempo = [{ frame: 0, tick: 0, framesPerTick: sr / 960 / 2 }];
    this.midiHost = {
      sr,
      beatSeconds: () => this.beatSeconds(),
      beatAt: () => this.beatAt(),
      playing: () => this.playing,
    };
    this.post({ type: 'ready' });
  }

  /** A message from the page (or the renderer): a failing one is reported, and the ones after it still arrive. */
  receive(msg: ToWorklet): void {
    try {
      this.onMessage(msg);
    } catch (err) {
      this.post({
        type: 'error',
        message: `${msg.type}: ${err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err)}`,
      });
    }
  }

  private post(msg: FromWorklet, transfer?: ArrayBuffer[]): void {
    this.send(msg, transfer);
  }

  // ---- hosts for plugins ----

  private segmentAt(frame: number): TempoSegment {
    let seg = this.tempo[0] as TempoSegment;
    for (const s of this.tempo) {
      if (s.frame > frame) break;
      seg = s;
    }
    return seg;
  }
  private tickAt(frame: number): number {
    const s = this.segmentAt(frame);
    return s.tick + (frame - s.frame) / s.framesPerTick;
  }
  impulse(key: string): PreparedImpulse | undefined {
    return this.dormant ? undefined : this.impulses.get(key);
  }
  songFrame(): number {
    return this.pos;
  }
  /** The cycle, while it's on: plugins that keep time with a loop (Shimmer's grains) count from its start. */
  loopRange(): { start: number; end: number } | null {
    const c = this.cycle;
    return c.on && c.end > c.start ? { start: c.start, end: c.end } : null;
  }
  clip(key: string): Float32Array[] | undefined {
    return this.audio.get(key);
  }

  beatSeconds(): number {
    return (this.segmentAt(this.pos).framesPerTick * this.ppq) / this.sr;
  }
  beatAt(): number {
    return this.tickAt(this.pos) / this.ppq;
  }
  private tickAtSigned(frame: number): number {
    return frame < 0 ? frame / (this.tempo[0] as TempoSegment).framesPerTick : this.tickAt(frame);
  }
  private frameAtSigned(tick: number): number {
    if (tick < 0) return tick * (this.tempo[0] as TempoSegment).framesPerTick;
    let seg = this.tempo[0] as TempoSegment;
    for (const s of this.tempo) {
      if (s.tick > tick) break;
      seg = s;
    }
    return seg.frame + (tick - seg.tick) * seg.framesPerTick;
  }

  // ---- messages ----

  private onMessage(msg: ToWorklet): void {
    switch (msg.type) {
      case 'init': {
        this.ring = msg.ring ? new Int32Array(msg.ring) : null;
        this.meters = msg.meters ? new Float32Array(msg.meters) : null;
        this.transport = msg.transport ? new Float64Array(msg.transport) : null;
        const a = msg.ahead;
        this.split = a
          ? {
              self: a.self,
              link: new AheadLink(a.control, a.data, a.edges),
              owners: [],
              block: 0,
              warned: false,
            }
          : null;
        if (this.split) this.planSplit();
        break;
      }
      case 'ahead':
        if (this.split) {
          this.split.owners = msg.owners;
          this.planSplit();
        }
        break;
      case 'aheadData':
        this.split?.link.setData(msg.data, msg.edges);
        break;
      case 'graph':
        this.applyGraph(msg.graph);
        break;
      case 'sequence': {
        const t = this.tracks.get(msg.num);
        if (t) {
          t.seq = msg.events;
          this.seek(t, this.pos);
        }
        break;
      }
      case 'tempo':
        this.tempo = msg.segments.length ? msg.segments : this.tempo;
        this.ppq = msg.ppq;
        this.beatTicks = msg.beatTicks;
        this.barTicks = msg.barTicks;
        break;
      case 'audio':
        this.audio.set(msg.key, msg.channels);
        break;
      case 'impulse': {
        this.impulses.set(msg.key, msg.data);
        // the plugins waiting for it pick it up (those this engine plays)
        for (const s of [...this.trackOrder, ...this.buses, this.master])
          if (s.role !== ROLE_NONE) for (const ins of s.inserts) ins.effect.refresh?.();
        break;
      }
      case 'forgetAudio':
        this.audio.delete(msg.key);
        break;
      case 'clips': {
        const t = this.tracks.get(msg.num);
        if (t) t.clips = msg.clips;
        break;
      }
      case 'plans': {
        const t = this.tracks.get(msg.num);
        if (t) {
          t.part = msg.plans ? this.partRuntime(msg.plans) : null;
          if (t.part && this.playsSong(t)) this.seekPart(t.part, Math.max(0, this.pos), this.playing);
        }
        break;
      }
      case 'performance': {
        let files = this.perfData.get(msg.key);
        if (!files) {
          files = new Map();
          this.perfData.set(msg.key, files);
        }
        for (const x of msg.samples) files.set(x.index, [x.left, x.right]);
        break;
      }
      case 'inputs':
        for (const t of this.trackOrder) {
          const spec = msg.tracks.find((x) => x.num === t.num) ?? null;
          if (t.capture && !spec?.record) this.finishCapture(t);
          t.input = spec;
          if (spec?.record && this.recording && !t.capture) this.beginCapture(t);
        }
        break;
      case 'record':
        if (msg.on && !this.recording) {
          this.recording = true;
          for (const t of this.trackOrder) if (t.input?.record) this.beginCapture(t);
        } else if (!msg.on && this.recording) {
          this.recording = false;
          for (const t of this.trackOrder) this.finishCapture(t);
        }
        break;
      case 'sampler':
        this.samplers.set(msg.spec.key, msg.spec);
        for (const t of this.trackOrder)
          if (t.spec && usesSampler(t.spec, msg.spec.key)) this.buildInstruments(t, t.spec, true);
        break;
      case 'play':
        this.lastCmd = msg.cmd ?? this.lastCmd;
        this.pos = msg.frame - msg.countIn;
        this.playing = true;
        this.recording = msg.record;
        for (const t of this.trackOrder) {
          this.seek(t, Math.max(0, this.pos));
          if (msg.record && t.input?.record) this.beginCapture(t);
        }
        break;
      case 'stop':
        this.lastCmd = msg.cmd ?? this.lastCmd;
        this.playing = false;
        this.recording = false;
        for (const t of this.trackOrder) {
          if (this.playsSong(t)) this.endSeqNotes(t, 0);
          this.finishCapture(t);
          if (t.part) t.part.voices = [];
        }
        break;
      case 'locate':
        this.lastCmd = msg.cmd ?? this.lastCmd;
        for (const t of this.trackOrder) {
          if (this.playsSong(t)) this.endSeqNotes(t, 0);
          this.seek(t, msg.frame);
        }
        this.pos = msg.frame;
        break;
      case 'cycle':
        this.cycle = { on: msg.on, start: msg.start, end: msg.end, wrap: msg.wrap ?? false };
        break;
      case 'metronome':
        this.metronome = msg.on;
        this.clickLevel = msg.level;
        break;
      case 'live':
        this.liveQueue.push(...msg.events);
        break;
      case 'ping':
        this.post({ type: 'pong', id: msg.id });
        break;
      case 'lowLatency':
        this.lowLatency = msg.on;
        break;
      case 'resetLoad':
        this.overloads = 0;
        this.loadPeak = 0;
        break;
      case 'watch': {
        const strip =
          msg.num === 0 ? this.master : (this.tracks.get(msg.num) ?? this.buses.find((b) => b.num === msg.num));
        if (strip) strip.watch = msg.plugin;
        break;
      }
      case 'panic':
        for (const t of this.trackOrder) {
          for (const inst of t.instruments) inst?.allNotesOff(true);
          for (const m of t.midiFx) m.fx.reset();
          t.seqHeld.clear();
        }
        break;
    }
  }

  private applyGraph(g: GraphSpec): void {
    const soloed = g.soloed ? new Set(g.soloed) : null;
    const next = new Map<number, TrackNode>();
    const order: TrackNode[] = [];
    for (const spec of g.tracks) {
      const node = this.tracks.get(spec.num) ?? new TrackNode(this.sr);
      this.dormant = !this.mayPlay(spec.num);
      node.apply(spec, this);
      this.dormant = false;
      node.audible = !soloed || soloed.has(spec.id);
      this.buildInstruments(node, spec, false);
      node.midiFx = spec.midiFx.flatMap((s): MidiFxSlot[] => {
        const json = JSON.stringify(s.params);
        const old = node.midiFx.find((x) => x.id === s.id && x.type === s.type);
        if (old) {
          if (old.json !== json) old.fx.setParams(s.params);
          old.json = json;
          old.bypass = s.bypass;
          return [old];
        }
        const fx = createMidiEffect(s.type, this.midiHost);
        if (!fx) return [];
        fx.setParams(s.params);
        return [{ id: s.id, type: s.type, bypass: s.bypass, fx, json }];
      });
      node.spec = spec;
      next.set(spec.num, node);
      order.push(node);
    }
    // tracks that left: silence them
    for (const [num, node] of this.tracks) if (!next.has(num)) for (const i of node.instruments) i?.allNotesOff(true);
    this.tracks = next;
    this.trackOrder = order;
    this.buses = g.buses.map((spec) => {
      const strip = this.busById.get(spec.id) ?? new Strip(this.sr);
      this.dormant = !this.mayPlay(spec.num);
      strip.apply(spec, this);
      this.dormant = false;
      strip.audible = true;
      return strip;
    });
    this.busById = new Map(this.buses.map((b) => [b.id, b]));
    this.master.apply(g.master, this);
    this.mixStrips = [...this.trackOrder, ...this.buses];
    this.allStrips = [...this.mixStrips, this.master];
    this.latencyGraph++;
    this.graph = g;
    if (this.split) this.planSplit();
  }
  private graph: GraphSpec | null = null;

  private makeInstrument(spec: InstrumentSpec): Instrument | null {
    switch (spec.kind) {
      case 'synth':
        return new Synth(this.sr, spec.preset, spec.params);
      case 'drums':
        return new DrumSynth(this.sr);
      case 'sampler': {
        const s = this.samplers.get(spec.key);
        return s ? new Sampler(this.sr, s) : null;
      }
      default:
        return null;
    }
  }

  private buildInstruments(node: TrackNode, spec: TrackSpec, force: boolean): void {
    const key = JSON.stringify([spec.instrument, spec.articulations]);
    if (!force && key === node.instKey && node.instruments.every((x) => x !== null)) return;
    for (const i of node.instruments) i?.allNotesOff(false);
    node.instruments = [spec.instrument, ...spec.articulations].map((s) => this.makeInstrument(s));
    node.instKey = key;
  }

  // ---- the song ----

  /** A planned part's voices, made as they're due (a Performance note needs its sample loaded). */
  private partRuntime(plans: PartPlans): PartRuntime {
    const sr = this.sr;
    const entries: PartRuntime['entries'] = [];
    if (plans.kind === 'performance') {
      for (const p of plans.notes) {
        entries.push({
          at: p.at,
          length: p.length,
          make: () => {
            const data = this.perfData.get(plans.key)?.get(p.row.sample);
            return data ? new PlanVoice(p, data, sr) : null;
          },
        });
      }
    } else {
      for (const p of plans.glass) entries.push({ at: p.at, length: p.n, make: () => new GlassVoice(p, sr) });
      for (const p of plans.lines) entries.push({ at: p.at, length: p.n, make: () => new GlassLineVoice(p, sr) });
    }
    entries.sort((a, b) => a.at - b.at);
    return { plans, entries, next: 0, voices: [], until: 0 };
  }

  /** From a frame: what's due next, and (playing) what should already be sounding, joined late. */
  private seekPart(part: PartRuntime, frame: number, late: boolean): void {
    part.voices = [];
    part.until = frame;
    let lo = 0;
    let hi = part.entries.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((part.entries[mid] as PartRuntime['entries'][number]).at < frame) lo = mid + 1;
      else hi = mid;
    }
    part.next = lo;
    if (!late) return;
    for (let i = 0; i < lo; i++) {
      const e = part.entries[i] as PartRuntime['entries'][number];
      if (e.at + e.length <= frame) continue;
      const v = e.make();
      if (!v) continue;
      v.skip(frame - e.at);
      part.voices.push(v);
    }
  }

  /** A planned part over this block: what's sounding plays on; what's due starts at its frame. */
  private playPart(t: TrackNode, part: PartRuntime): void {
    for (let s = 0; s < this.spanCount; s++) {
      const out = this.spans[s * 3] as number;
      const song = this.spans[s * 3 + 1] as number;
      const count = this.spans[s * 3 + 2] as number;
      // round a cycle's jump, the part goes on from its start (what's sounding rings on)
      if (song !== part.until) {
        const keep = part.voices;
        this.seekPart(part, song, false);
        part.voices = keep;
      }
      part.until = song + count;
      for (const v of part.voices) v.play(t.l, t.r, out, count);
      while (part.next < part.entries.length) {
        const e = part.entries[part.next] as PartRuntime['entries'][number];
        if (e.at >= song + count) break;
        part.next++;
        if (e.at + e.length <= song) continue;
        const v = e.make();
        if (!v) continue;
        if (e.at < song) {
          v.skip(song - e.at);
          v.play(t.l, t.r, out, count);
        } else v.play(t.l, t.r, out + (e.at - song), count - (e.at - song));
        part.voices.push(v);
      }
      part.voices = part.voices.filter((v) => !v.done);
    }
  }

  /** The track's place in its events from a frame (and its planned part's, unless `part` is false). */
  private seek(t: TrackNode, frame: number, part = true): void {
    if (t.part && part && this.playsSong(t)) this.seekPart(t.part, frame, this.playing);
    const ev = t.seq;
    let lo = 0;
    let hi = ev.length / EVENT_SIZE;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if ((ev[mid * EVENT_SIZE] as number) < frame) lo = mid + 1;
      else hi = mid;
    }
    t.cursor = lo;
  }

  private endSeqNotes(t: TrackNode, offset: number): void {
    for (const key of t.seqHeld) t.events.push(offset, EV_OFF, key, 0);
    t.seqHeld.clear();
    // controllers back to rest so a jump never leaves the pedal down
    t.events.push(offset, EV_CC, 64, 0);
    t.events.push(offset, EV_BEND, 0, 0);
  }

  /** The song's events between two frames, at block offsets from `base`. */
  private gather(t: TrackNode, from: number, to: number, base: number): void {
    const ev = t.seq;
    const count = ev.length / EVENT_SIZE;
    while (t.cursor < count) {
      const i = t.cursor * EVENT_SIZE;
      const frame = ev[i] as number;
      if (frame >= to) break;
      t.cursor++;
      if (frame < from) continue;
      const kind = ev[i + 1] as number;
      const a = ev[i + 2] as number;
      const b = ev[i + 3] as number;
      const art = ev[i + 4] as number;
      if (kind === EV_ON) t.seqHeld.add(a);
      else if (kind === EV_OFF) t.seqHeld.delete(a);
      t.events.push(base + Math.floor(frame - from), kind, a, b, art);
    }
  }

  private readLive(): void {
    const push = (word: number, num: number) => {
      const t = this.tracks.get(num);
      if (!t) return;
      const status = word & 0xff;
      const d1 = (word >> 8) & 0x7f;
      const d2 = (word >> 16) & 0x7f;
      const kind = status & 0xf0;
      if (kind === 0x90 && d2 > 0) t.events.push(0, EV_ON, d1, d2);
      else if (kind === 0x80 || kind === 0x90) t.events.push(0, EV_OFF, d1, 0);
      else if (kind === 0xb0) t.events.push(0, EV_CC, d1, d2);
      else if (kind === 0xe0) t.events.push(0, EV_BEND, ((d2 << 7) | d1) - 8192, 0);
      else if (kind === 0xd0) t.events.push(0, EV_PRESSURE, d1, 0);
    };
    const ring = this.ring;
    if (ring) {
      let read = Atomics.load(ring, 1);
      const write = Atomics.load(ring, 0);
      while (read !== write) {
        const i = RING_HEADER + read * EVENT_INTS;
        push(ring[i] as number, ring[i + 1] as number);
        read = (read + 1) % RING_EVENTS;
      }
      Atomics.store(ring, 1, read);
    }
    const q = this.liveQueue;
    // a worker plays no live notes: the audio thread does, at once
    if (this.split && this.split.self >= 0) q.length = 0;
    for (let i = 0; i + 3 < q.length; i += 4) {
      push(
        ((q[i] as number) & 0xff) | (((q[i + 1] as number) & 0x7f) << 8) | (((q[i + 2] as number) & 0x7f) << 16),
        q[i + 3] as number,
      );
    }
    q.length = 0;
  }

  private dispatch(inst: Instrument, kind: number, a: number, b: number): void {
    switch (kind) {
      case EV_ON:
        inst.noteOn(a, b);
        break;
      case EV_OFF:
        inst.noteOff(a);
        break;
      case EV_CC:
        inst.cc(a, b);
        break;
      case EV_BEND:
        inst.pitchBend(a);
        break;
      case EV_PRESSURE:
        inst.pressure(a);
        break;
    }
  }

  // ---- audio tracks ----

  private beginCapture(t: TrackNode): void {
    this.finishCapture(t);
    // a worker hears no input: the audio thread records
    if (this.split && this.split.self >= 0) return;
    const stereo = t.input?.channels === 2;
    t.capture = {
      take: ++this.takes,
      frame: -1,
      left: new Float32Array(this.sr),
      right: stereo ? new Float32Array(this.sr) : null,
      fill: 0,
      done: false,
    };
  }

  private flushCapture(t: TrackNode, last: boolean): void {
    const c = t.capture;
    if (!c) return;
    const channels = [c.left.slice(0, c.fill), ...(c.right ? [c.right.slice(0, c.fill)] : [])];
    this.post(
      { type: 'recorded', num: t.num, take: c.take, frame: c.frame, channels, last },
      channels.map((x) => x.buffer as ArrayBuffer),
    );
    c.frame = c.frame < 0 ? -1 : c.frame + c.fill;
    c.fill = 0;
  }

  private finishCapture(t: TrackNode): void {
    if (!t.capture) return;
    this.flushCapture(t, true);
    t.capture = null;
  }

  /** The input this track listens to, for this block (null when nothing is plugged in). */
  private inputOf(t: TrackNode, input: Float32Array[] | undefined): [Float32Array, Float32Array] | null {
    const spec = t.input;
    if (!spec || !input?.length) return null;
    const a = input[spec.input] ?? (input[0] as Float32Array);
    const b = spec.channels === 2 ? (input[spec.input + 1] ?? a) : a;
    return [a, b];
  }

  private record(t: TrackNode, src: [Float32Array, Float32Array], n: number): void {
    const c = t.capture;
    if (!c || c.done || !this.playing || this.spanCount === 0) return;
    // the first span only: a cycle jump ends the take (it plays back from where it began)
    const from = this.spans[0] as number;
    const song = this.spans[1] as number;
    const count = Math.min(this.spans[2] as number, n - from);
    if (c.frame < 0) c.frame = song;
    for (let i = 0; i < count; i++) {
      c.left[c.fill] = src[0][from + i] as number;
      if (c.right) c.right[c.fill] = src[1][from + i] as number;
      if (++c.fill === c.left.length) this.flushCapture(t, false);
    }
    if (this.spanCount > 1) {
      c.done = true;
      this.finishCapture(t);
    }
  }

  /** The track's audio regions over this block. */
  private playClips(t: TrackNode): void {
    for (let s = 0; s < this.spanCount; s++) {
      const out = this.spans[s * 3] as number;
      const song = this.spans[s * 3 + 1] as number;
      const count = this.spans[s * 3 + 2] as number;
      const songEnd = song + count;
      for (const clip of t.clips) {
        if (clip.start >= songEnd) break;
        if (clip.end <= song) continue;
        const data = this.audio.get(clip.key);
        const L = data?.[0];
        if (!L) continue;
        const R = data[1] ?? L;
        const f0 = Math.max(song, clip.start);
        const f1 = Math.min(songEnd, clip.end);
        const cutIn = clip.source > 0;
        const cutOut = clip.source + (clip.end - clip.start) < L.length;
        for (let f = f0; f < f1; f++) {
          const i = clip.source + (f - clip.start);
          if (i < 0 || i >= L.length) continue;
          let g = clip.gain;
          // the region's fades, then a short ramp wherever this piece starts or stops
          const fromStart = f - clip.regionStart;
          const toEnd = clip.regionEnd - f;
          if (fromStart < clip.fadeIn) g *= fromStart / clip.fadeIn;
          if (toEnd < clip.fadeOut) g *= toEnd / clip.fadeOut;
          const a = f - clip.start;
          const b = clip.end - f;
          if (cutIn && a < DECLICK) g *= a / DECLICK;
          if (cutOut && b < DECLICK) g *= b / DECLICK;
          const o = out + (f - song);
          t.l[o] = (t.l[o] as number) + (L[i] as number) * g;
          t.r[o] = (t.r[o] as number) + (R[i] as number) * g;
        }
      }
    }
  }

  private renderTrack(t: TrackNode, n: number, input: Float32Array[] | undefined, song = true): void {
    t.clear(n);
    let list = t.events;
    let spare = t.work;
    for (const slot of t.midiFx) {
      if (slot.bypass) continue;
      spare.clear();
      slot.fx.process(list, spare, n);
      const tmp = list;
      list = spare;
      spare = tmp;
    }
    let at = 0;
    const insts = t.instruments;
    for (let e = 0; e <= list.count; e++) {
      const off = e < list.count ? Math.min(n, Math.max(0, list.offset[e] as number)) : n;
      if (off > at) {
        for (const inst of insts) inst?.render(t.l, t.r, at, off);
        at = off;
      }
      if (e === list.count) break;
      const kind = list.kind[e] as number;
      const art = list.art[e] as number;
      if (kind === EV_ON || kind === EV_OFF) {
        const inst = insts[art] ?? insts[0];
        if (inst) this.dispatch(inst, kind, list.a[e] as number, list.b[e] as number);
      } else {
        for (const inst of insts) if (inst) this.dispatch(inst, kind, list.a[e] as number, list.b[e] as number);
      }
    }
    t.events.clear();
    t.work.clear();
    if (t.clips.length && this.playing && song) this.playClips(t);
    if (t.part && this.playing && song) this.playPart(t, t.part);
    if (t.input) {
      const src = this.inputOf(t, input);
      if (src) {
        if (t.capture) this.record(t, src, n);
        if (t.input.monitor) {
          for (let i = 0; i < n; i++) {
            t.l[i] = (t.l[i] as number) + (src[0][i] as number);
            t.r[i] = (t.r[i] as number) + (src[1][i] as number);
          }
        }
      }
    }
    t.run(n);
  }

  private destOf(s: Strip): Strip {
    return s.output === 'master' || !s.output ? this.master : (this.busById.get(s.output) ?? this.master);
  }

  /**
   * Plugin delay compensation: how far behind the song each strip's sound is when it leaves, and
   * how long each connection waits so that whatever meets in a bus (or the master) meets in time.
   * Buses are taken in the order they're mixed in. In Low Latency Mode nothing waits.
   */
  measureLatency(): number {
    // as it was, while nothing it depends on has changed (the routing, Low Latency Mode, the plugins' delays)
    const strips = this.mixStrips;
    const key = this.latencyKey;
    let same = this.latencyKeyGraph === this.latencyGraph && key.length === strips.length + 2;
    if (same) {
      if (key[strips.length] !== this.master.latency() || key[strips.length + 1] !== (this.lowLatency ? 1 : 0))
        same = false;
      else
        for (let i = 0; i < strips.length; i++)
          if ((strips[i] as Strip).latency() !== key[i]) {
            same = false;
            break;
          }
    }
    if (same) return this.latency;
    if (key.length !== strips.length + 2) this.latencyKey = new Float64Array(strips.length + 2);
    strips.forEach((s, i) => {
      this.latencyKey[i] = s.latency();
    });
    this.latencyKey[strips.length] = this.master.latency();
    this.latencyKey[strips.length + 1] = this.lowLatency ? 1 : 0;
    this.latencyKeyGraph = this.latencyGraph;
    const into = new Map<Strip, number>();
    const arrive = (dest: Strip, at: number) => into.set(dest, Math.max(into.get(dest) ?? 0, at));
    for (const s of strips) {
      s.outLatency = (into.get(s) ?? 0) + (this.lowLatency ? 0 : s.latency());
      const dest = this.destOf(s);
      if (dest !== s) arrive(dest, s.outLatency);
      for (const send of [...s.sends, ...s.seatSends]) {
        const bus = this.busById.get(send.bus);
        if (bus && bus !== s) arrive(bus, s.outLatency);
      }
    }
    for (const s of strips) {
      const dest = this.destOf(s);
      s.outComp.set(this.lowLatency || dest === s ? 0 : (into.get(dest) ?? 0) - s.outLatency);
      for (const send of [...s.sends, ...s.seatSends]) {
        const bus = this.busById.get(send.bus);
        send.comp.set(this.lowLatency || !bus || bus === s ? 0 : (into.get(bus) ?? 0) - s.outLatency);
      }
    }
    this.latency = (into.get(this.master) ?? 0) + (this.lowLatency ? 0 : this.master.latency());
    return this.latency;
  }

  /** What the delay compensation was last worked out from: the graph, then each strip's delay and Low Latency Mode. */
  private latencyGraph = 0;
  private latencyKeyGraph = -1;
  private latencyKey = new Float64Array(0);

  private route(s: Strip, n: number): void {
    const dest = this.destOf(s);
    if (dest !== s) {
      let l = s.l;
      let r = s.r;
      if (s.outComp.delay) {
        s.outComp.run(l, r, n);
        l = s.outComp.l;
        r = s.outComp.r;
      }
      for (let i = 0; i < n; i++) {
        dest.l[i] = (dest.l[i] as number) + (l[i] as number);
        dest.r[i] = (dest.r[i] as number) + (r[i] as number);
      }
    }
    for (const send of s.sends) {
      const bus = this.busById.get(send.bus);
      if (!bus || bus === s) continue;
      let srcL = send.pre ? s.preL : s.sendL;
      let srcR = send.pre ? s.preR : s.sendR;
      if (send.comp.delay) {
        send.comp.run(srcL, srcR, n);
        srcL = send.comp.l;
        srcR = send.comp.r;
      }
      for (let i = 0; i < n; i++) {
        const g = s.sendGain(send, i);
        bus.l[i] = (bus.l[i] as number) + (srcL[i] as number) * g;
        bus.r[i] = (bus.r[i] as number) + (srcR[i] as number) * g;
      }
    }
    for (const seat of s.seatSends) {
      const bus = this.busById.get(seat.bus);
      if (!bus || bus === s) continue;
      let srcL = s.postL;
      let srcR = s.postR;
      if (seat.comp.delay) {
        seat.comp.run(srcL, srcR, n);
        srcL = seat.comp.l;
        srcR = seat.comp.r;
      }
      const g = seat.gain;
      for (let i = 0; i < n; i++) {
        bus.l[i] = (bus.l[i] as number) + (srcL[i] as number) * (g[i] as number);
        bus.r[i] = (bus.r[i] as number) + (srcR[i] as number) * (g[i] as number);
      }
    }
  }

  private meter(s: Strip, n: number): void {
    const m = this.meters ?? this.fallbackMeters;
    const at = s.num * METER_FLOATS;
    if (at + 3 >= m.length) return;
    let pl = 0;
    let pr = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(s.l[i] as number);
      const b = Math.abs(s.r[i] as number);
      if (a > pl) pl = a;
      if (b > pr) pr = b;
    }
    m[at] = Math.max(pl, (m[at] as number) * METER_FALL);
    m[at + 1] = Math.max(pr, (m[at + 1] as number) * METER_FALL);
    m[at + 2] = s.gr;
    m[at + 3] = s.watchGr;
  }

  /** Clicks on the beats (an accent on each bar); during a count-in they play whatever the metronome says. */
  private clicks(out0: Float32Array, out1: Float32Array, n: number): void {
    let startAt = -1;
    if (this.playing && (this.metronome || this.pos < 0)) {
      const t0 = this.tickAtSigned(this.pos);
      const t1 = this.tickAtSigned(this.pos + n);
      const beat = Math.ceil(t0 / this.beatTicks - 1e-9) * this.beatTicks;
      if (beat < t1 && (this.metronome || beat < 0)) {
        startAt = Math.max(0, Math.min(n - 1, Math.round(this.frameAtSigned(beat) - this.pos)));
        const bar = Math.round(beat) % this.barTicks === 0;
        this.clickFreq = bar ? 1760 : 1175;
        this.clickNext = bar ? 1 : 0.6;
      }
    }
    if (startAt < 0 && this.clickEnv < 1e-4) return;
    for (let i = 0; i < n; i++) {
      if (i === startAt) {
        this.clickEnv = this.clickNext;
        this.clickPhase = 0;
      }
      if (this.clickEnv < 1e-4) continue;
      this.clickPhase += this.clickFreq / this.sr;
      const y = Math.sin(2 * Math.PI * this.clickPhase) * this.clickEnv * this.clickLevel * 0.5;
      this.clickEnv *= 0.9986;
      out0[i] = (out0[i] as number) + y;
      out1[i] = (out1[i] as number) + y;
    }
  }

  /**
   * One block of the mix into two channels: `input` is the audio input (for audio tracks), and
   * `contextFrame` the audio clock's frame at the block's start (the studio reads where the playhead
   * was heard from it).
   */
  process(out0: Float32Array, out1: Float32Array, input: Float32Array[] | undefined, contextFrame: number): void {
    const n = Math.min(out0.length, MAX_BLOCK);
    this.contextFrame = contextFrame;
    if (this.failed) {
      this.handSilence();
      return;
    }
    const t0 = this.clock ? this.clock() : 0;
    try {
      this.block(out0, out1, n, input);
    } catch (err) {
      this.failed = true;
      this.post({ type: 'error', message: err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err) });
      this.handSilence();
    }
    if (this.clock) this.measure(this.clock() - t0, n);
  }
  private contextFrame = 0;

  /**
   * The audio thread's clock (milliseconds), when it has one: then the engine times every block
   * against the time it has (its frames at the rate). A renderer leaves it unset and pays nothing.
   */
  clock: (() => number) | null = null;
  /** Whether that clock resolves well under a block (else only its averages mean anything). */
  fineClock = false;
  private load = 0;
  private loadPeak = 0;
  private overloads = 0;

  private measure(ms: number, n: number): void {
    const budget = (n / this.sr) * 1000;
    const share = ms / budget;
    // about half a second to settle; the peak falls back over about a second and a half
    const blocksPerSecond = this.sr / n;
    this.load += (share - this.load) * (2 / blocksPerSecond);
    this.loadPeak = Math.max(share, this.loadPeak * Math.exp(-1 / (1.5 * blocksPerSecond)));
    if (share > 1 && this.fineClock) this.overloads++;
    const tr = this.transport ?? this.fallbackTransport;
    tr[TR_LOAD] = this.load;
    tr[TR_LOAD_PEAK] = this.fineClock ? this.loadPeak : this.load;
    tr[TR_OVERLOADS] = this.overloads;
    tr[TR_FINE_CLOCK] = this.fineClock ? 1 : 0;
  }

  // ---- rendering ahead ----

  /** Whether this engine plays a track's song (every engine plays all of its own; a twin none of it). */
  private playsSong(t: TrackNode): boolean {
    return !this.split || t.role === ROLE_OWN;
  }

  /** Whether this engine may play a strip, by channel number (the audio thread plays every twin). */
  private mayPlay(num: number): boolean {
    const sp = this.split;
    if (!sp || sp.self < 0) return true;
    return (sp.owners[num] ?? -1) === sp.self;
  }

  get isPlaying(): boolean {
    return this.playing;
  }

  /** Rendering ahead: the block about to be played (its place in the ring). */
  aheadBlock(k: number): void {
    if (this.split) this.split.block = k;
  }

  /** Milliseconds this engine has spent waiting for other engines' sound (since it was last asked). */
  aheadWaited(): number {
    const w = this.waited;
    this.waited = 0;
    return w;
  }
  private waited = 0;

  /** Each strip's role here and what this engine does with its connections, from the graph and the owners. */
  private planSplit(): void {
    const sp = this.split;
    if (!sp) return;
    const strips: Strip[] = [...this.trackOrder, ...this.buses, this.master];
    const g = this.graph;
    const plan = g ? aheadPlan(g, sp.owners) : null;
    if (plan && plan.handed > sp.link.edges && !sp.warned) {
      sp.warned = true;
      this.post({
        type: 'error',
        message: `Rendering ahead: ${plan.handed} connections between threads, room for ${sp.link.edges}`,
      });
    }
    const owner = (i: number) => (plan ? (plan.owners[i] ?? -1) : -1);
    strips.forEach((s, i) => {
      const o = owner(i);
      const role = o === sp.self ? ROLE_OWN : sp.self < 0 ? ROLE_TWIN : ROLE_NONE;
      if (role !== s.role) {
        const was = s.role;
        s.role = role;
        this.recast(s, was);
      }
    });
    strips.forEach((s, i) => {
      s.plan = (plan?.edges[i] ?? []).map((e) => ({
        kind: e.kind,
        index: e.index,
        dest: strips[e.to] as Strip,
        mode: this.edgeMode(e, owner(e.from), owner(e.to), sp),
        slot: e.slot,
      }));
      s.hands = s.role === ROLE_OWN && s.plan.some((e) => e.mode === EDGE_HAND);
    });
  }

  private edgeMode(e: AheadEdge, from: number, to: number, sp: Split): number {
    const self = sp.self;
    const room = e.slot >= 0 && e.slot < sp.link.edges;
    // into a strip already mixed this block: lost, as in one engine
    if (e.to < e.from) return from === self && to === self ? EDGE_LOCAL : EDGE_SKIP;
    if (self >= 0) {
      if (from === self) return to === self ? EDGE_LOCAL : room ? EDGE_HAND : EDGE_SKIP;
      return to === self && room ? EDGE_TAKE : EDGE_SKIP;
    }
    if (from === -1) return to === -1 ? EDGE_LOCAL : EDGE_SKIP;
    return to === -1 && room ? EDGE_TAKE_TWIN : EDGE_TWIN;
  }

  /** A strip changes hands: what it was playing here stops; what it now plays here starts where the song is. */
  private recast(s: Strip, was: number): void {
    const t = s instanceof TrackNode ? s : null;
    if (was === ROLE_OWN && t) {
      for (const inst of t.instruments) inst?.allNotesOff(true);
      t.seqHeld.clear();
      if (t.part) t.part.voices = [];
    }
    s.timed = 0;
    if (s.role === ROLE_OWN) {
      if (s.ran) for (const ins of s.inserts) ins.effect.reset();
      if (t) {
        t.events.clear();
        this.seek(t, Math.max(0, this.pos));
      }
    }
    s.twinSeen = -1e9;
  }

  /**
   * One block of this engine's share: the strips it owns played in full, what other engines played
   * taken in where it goes, and (on the audio thread) the twins that have something live to play.
   */
  private mixSplit(
    out0: Float32Array,
    out1: Float32Array,
    n: number,
    input: Float32Array[] | undefined,
    sp: Split,
  ): void {
    if (n !== AHEAD_BLOCK) throw new Error(`Rendering ahead plays blocks of ${AHEAD_BLOCK} frames, not ${n}`);
    const k = sp.block;
    const live = sp.self < 0;
    this.measureLatency();
    this.master.clear(n);
    for (const b of this.buses) {
      b.clear(n);
      b.twinIn = false;
    }
    const at = Math.max(0, this.pos);
    for (const t of this.trackOrder) if (t.role === ROLE_OWN && t.lanes.length) t.automate(at);
    for (const b of this.buses) if (b.role === ROLE_OWN && b.lanes.length) b.automate(at);
    if (this.master.role === ROLE_OWN && this.master.lanes.length) this.master.automate(at);
    for (const s of this.allStrips) if (s.role === ROLE_OWN) s.automateFrames(this.spans, this.spanCount, n, at);
    const hold = Math.round((TWIN_HOLD_SECONDS * this.sr) / n);
    const clock = live ? null : this.clock;
    for (const t of this.trackOrder) {
      const t0 = clock ? clock() : 0;
      if (t.role === ROLE_OWN) {
        this.renderTrack(t, n, input);
        this.meter(t, n);
        this.routeSplit(t, n, sp, true);
        t.ran = true;
        if (clock) this.timeStrip(sp, t, clock() - t0);
      } else if (t.role === ROLE_TWIN) {
        const awake = this.twinAwake(t, k, hold);
        if (awake) {
          if (t.lanes.length) t.automate(at);
          t.automateFrames(this.spans, this.spanCount, n, at);
          this.renderTrack(t, n, input, false);
          this.twinMeter(t, n, k);
          t.ran = true;
        } else this.twinRest(t);
        this.routeSplit(t, n, sp, awake);
      } else {
        t.events.clear();
        this.routeSplit(t, n, sp, false);
      }
    }
    for (const b of this.buses) {
      const t0 = clock ? clock() : 0;
      if (b.role === ROLE_OWN) {
        b.run(n);
        this.meter(b, n);
        this.routeSplit(b, n, sp, true);
        b.ran = true;
        if (clock) this.timeStrip(sp, b, clock() - t0);
      } else if (b.role === ROLE_TWIN) {
        const awake = b.twinIn || k - b.twinSeen < hold;
        if (awake) {
          if (b.lanes.length) b.automate(at);
          b.automateFrames(this.spans, this.spanCount, n, at);
          b.run(n);
          this.twinMeter(b, n, k);
          b.ran = true;
        } else this.twinRest(b);
        this.routeSplit(b, n, sp, awake);
      } else this.routeSplit(b, n, sp, false);
    }
    if (this.master.role === ROLE_OWN) {
      this.master.run(n);
      this.meter(this.master, n);
      for (let i = 0; i < n; i++) {
        out0[i] = this.master.l[i] as number;
        out1[i] = this.master.r[i] as number;
      }
      this.clicks(out0, out1, n);
    }
    if (live) this.takeMeters(sp);
    else this.handMeters(sp);
  }

  /** A twin plays while something live comes in or still sounds (its voices, its plugins' tails). */
  private twinAwake(t: TrackNode, k: number, hold: number): boolean {
    if (t.events.count > 0 || t.input || k - t.twinSeen < hold) return true;
    for (const inst of t.instruments) if (inst && inst.active > 0) return true;
    for (const m of t.midiFx) if (!m.bypass && m.fx.busy?.()) return true;
    return false;
  }

  /**
   * A strip's connections this block, as this engine plays its part in them, in the order one engine
   * adds them (so whatever meets in a bus adds up in the same order, to the same numbers).
   */
  private routeSplit(s: Strip, n: number, sp: Split, active: boolean): void {
    const link = sp.link;
    const k = sp.block;
    let waited = false;
    for (const e of s.plan) {
      switch (e.mode) {
        case EDGE_LOCAL:
          if (active) this.addInto(e.dest, this.produce(s, e, n), n);
          break;
        case EDGE_HAND:
          this.hand(link, k, e, this.produce(s, e, n), n);
          break;
        case EDGE_TAKE:
          if (!waited) {
            if (link.progress(s.num) <= k) {
              const t0 = this.clock ? this.clock() : 0;
              link.await(s.num, k + 1);
              if (this.clock) this.waited += this.clock() - t0;
            }
            waited = true;
          }
          this.take(link, k, e, n);
          break;
        case EDGE_TAKE_TWIN:
          this.take(link, k, e, n);
          if (active) this.addInto(e.dest, this.produce(s, e, n), n);
          break;
        case EDGE_TWIN:
          if (active) {
            this.addInto(e.dest, this.produce(s, e, n), n);
            e.dest.twinIn = true;
          }
          break;
      }
    }
    if (s.hands) link.publish(s.num, k + 1);
  }

  /** The channels of the connection `produce` worked out last. */
  private pL: Float32Array<ArrayBufferLike> = new Float32Array(0);
  private pR: Float32Array<ArrayBufferLike> = new Float32Array(0);

  /**
   * One of a strip's connections for this block, as the mixer sends it: its channels (after delay
   * compensation) in pL and pR, and its gains (null: as they are).
   */
  private produce(s: Strip, e: EdgePlan, n: number): Float64Array | null {
    if (e.kind === 0) {
      let l = s.l;
      let r = s.r;
      if (s.outComp.delay) {
        s.outComp.run(l, r, n);
        l = s.outComp.l;
        r = s.outComp.r;
      }
      this.pL = l;
      this.pR = r;
      return null;
    }
    if (e.kind === 1) {
      const send = s.sends[e.index] as Strip['sends'][number];
      let srcL = send.pre ? s.preL : s.sendL;
      let srcR = send.pre ? s.preR : s.sendR;
      if (send.comp.delay) {
        send.comp.run(srcL, srcR, n);
        srcL = send.comp.l;
        srcR = send.comp.r;
      }
      const g = this.gains;
      for (let i = 0; i < n; i++) g[i] = s.sendGain(send, i);
      this.pL = srcL;
      this.pR = srcR;
      return g;
    }
    const seat = s.seatSends[e.index] as SeatSend;
    let srcL = s.postL;
    let srcR = s.postR;
    if (seat.comp.delay) {
      seat.comp.run(srcL, srcR, n);
      srcL = seat.comp.l;
      srcR = seat.comp.r;
    }
    this.pL = srcL;
    this.pR = srcR;
    return seat.gain;
  }

  private addInto(dest: Strip, g: Float64Array | null, n: number): void {
    const { pL, pR } = this;
    const { l, r } = dest;
    if (g) {
      for (let i = 0; i < n; i++) {
        l[i] = (l[i] as number) + (pL[i] as number) * (g[i] as number);
        r[i] = (r[i] as number) + (pR[i] as number) * (g[i] as number);
      }
    } else {
      for (let i = 0; i < n; i++) {
        l[i] = (l[i] as number) + (pL[i] as number);
        r[i] = (r[i] as number) + (pR[i] as number);
      }
    }
  }

  /** A connection handed to the engine that plays where it goes: its channels and gains, as they are. */
  private hand(link: AheadLink, k: number, e: EdgePlan, g: Float64Array | null, n: number): void {
    const f = link.f32;
    const o = link.signalAt(k, e.slot);
    const { pL, pR } = this;
    for (let i = 0; i < n; i++) {
      f[o + i] = pL[i] as number;
      f[o + AHEAD_BLOCK + i] = pR[i] as number;
    }
    if (g) {
      const d = link.f64;
      const go = link.gainAt(k, e.slot);
      for (let i = 0; i < n; i++) d[go + i] = g[i] as number;
    }
  }

  /** A connection another engine played, added where it goes (the same sums as adding it here). */
  private take(link: AheadLink, k: number, e: EdgePlan, n: number): void {
    const f = link.f32;
    const o = link.signalAt(k, e.slot);
    const { l, r } = e.dest;
    if (e.kind === 0) {
      for (let i = 0; i < n; i++) {
        l[i] = (l[i] as number) + (f[o + i] as number);
        r[i] = (r[i] as number) + (f[o + AHEAD_BLOCK + i] as number);
      }
      return;
    }
    const d = link.f64;
    const go = link.gainAt(k, e.slot);
    for (let i = 0; i < n; i++) {
      l[i] = (l[i] as number) + (f[o + i] as number) * (d[go + i] as number);
      r[i] = (r[i] as number) + (f[o + AHEAD_BLOCK + i] as number) * (d[go + i] as number);
    }
  }

  /** A failed worker still hands over every block (silence), so the others don't wait on it. */
  private handSilence(): void {
    const sp = this.split;
    if (!sp || sp.self < 0) return;
    const k = sp.block;
    for (const s of this.mixStrips) {
      if (!s.hands) continue;
      for (const e of s.plan) {
        if (e.mode !== EDGE_HAND) continue;
        const o = sp.link.signalAt(k, e.slot);
        sp.link.f32.fill(0, o, o + AHEAD_BLOCK * 2);
      }
      sp.link.publish(s.num, k + 1);
    }
  }

  /**
   * A strip's share of a block's time, smoothed over a second or two (the page divides the work by
   * it): from its 64th block here on (the first ones build what it plays with, and warm up).
   */
  private timeStrip(sp: Split, s: Strip, ms: number): void {
    if (++s.timed < 64) return;
    const share = ms / ((AHEAD_BLOCK / this.sr) * 1000);
    const prev = sp.link.cost(s.num);
    sp.link.setCost(s.num, s.timed > 64 ? prev + (share - prev) * (2 / ((2 * this.sr) / AHEAD_BLOCK)) : share);
  }

  /** A twin's meter (its own, on top of what the strip's player meters). */
  private twinMeter(s: Strip, n: number, k: number): void {
    const m = this.twinMeters;
    const at = s.num * METER_FLOATS;
    if (at + 3 >= m.length) return;
    let pl = 0;
    let pr = 0;
    for (let i = 0; i < n; i++) {
      const a = Math.abs(s.l[i] as number);
      const b = Math.abs(s.r[i] as number);
      if (a > pl) pl = a;
      if (b > pr) pr = b;
    }
    if (pl > TWIN_SILENT || pr > TWIN_SILENT) s.twinSeen = k;
    m[at] = Math.max(pl, (m[at] as number) * METER_FALL);
    m[at + 1] = Math.max(pr, (m[at + 1] as number) * METER_FALL);
    m[at + 2] = s.gr;
  }

  private twinRest(s: Strip): void {
    const m = this.twinMeters;
    const at = s.num * METER_FLOATS;
    if (at + 3 >= m.length) return;
    m[at] = (m[at] as number) * METER_FALL;
    m[at + 1] = (m[at + 1] as number) * METER_FALL;
    m[at + 2] = 0;
  }

  /** A worker's meters for the strips it plays, into the block's place in the ring. */
  private handMeters(sp: Split): void {
    const f = sp.link.f32;
    const base = sp.link.meterAt(sp.block);
    const m = this.fallbackMeters;
    for (const s of this.mixStrips) {
      if (s.role !== ROLE_OWN) continue;
      const at = s.num * METER_FLOATS;
      if (at + 3 >= m.length) continue;
      for (let j = 0; j < METER_FLOATS; j++) f[base + at + j] = m[at + j] as number;
    }
  }

  /** The audio thread's meters: each strip as its player metered it, with its twin's sound on top. */
  private takeMeters(sp: Split): void {
    const f = sp.link.f32;
    const base = sp.link.meterAt(sp.block);
    const m = this.meters ?? this.fallbackMeters;
    const tm = this.twinMeters;
    for (const s of this.mixStrips) {
      if (s.role !== ROLE_TWIN) continue;
      const at = s.num * METER_FLOATS;
      if (at + 3 >= m.length) continue;
      m[at] = Math.max(f[base + at] as number, tm[at] as number);
      m[at + 1] = Math.max(f[base + at + 1] as number, tm[at + 1] as number);
      m[at + 2] = Math.min(f[base + at + 2] as number, tm[at + 2] as number);
      m[at + 3] = f[base + at + 3] as number;
    }
  }

  private span(i: number, out: number, song: number, count: number): void {
    this.spans[i * 3] = out;
    this.spans[i * 3 + 1] = song;
    this.spans[i * 3 + 2] = count;
    this.spanCount = i + 1;
  }

  private block(out0: Float32Array, out1: Float32Array, n: number, input: Float32Array[] | undefined): void {
    this.readLive();
    const cyc = this.cycle;
    if (this.playing && cyc.on && cyc.end > cyc.start && this.pos === cyc.end) {
      // the last block ended right on the cycle's end: round to its start before this one plays
      for (const t of this.trackOrder) {
        if (!cyc.wrap && this.playsSong(t)) this.endSeqNotes(t, 0);
        this.seek(t, cyc.start, false);
        if (t.capture && !t.capture.done) {
          t.capture.done = true;
          this.finishCapture(t);
        }
      }
      this.pos = cyc.start;
    }
    const startPos = this.pos;
    this.spanCount = 0;
    if (this.playing) {
      // the song's events for this block, through a cycle jump if there is one
      const c = this.cycle;
      const end = this.pos + n;
      if (this.pos >= 0) {
        if (c.on && c.end > c.start && this.pos < c.end && end > c.end) {
          const first = c.end - this.pos;
          this.span(0, 0, this.pos, first);
          this.span(1, first, c.start, n - first);
          for (const t of this.trackOrder) if (this.playsSong(t)) this.gather(t, this.pos, c.end, 0);
          for (const t of this.trackOrder) {
            const song = this.playsSong(t);
            if (!c.wrap && song) this.endSeqNotes(t, first);
            // (a planned part goes round in playPart, where what's sounding rings on)
            this.seek(t, c.start, false);
            if (song) this.gather(t, c.start, c.start + (n - first), first);
          }
        } else {
          this.span(0, 0, this.pos, n);
          for (const t of this.trackOrder) if (this.playsSong(t)) this.gather(t, this.pos, end, 0);
        }
      } else if (end > 0) {
        this.span(0, -this.pos, 0, end);
        for (const t of this.trackOrder) if (this.playsSong(t)) this.gather(t, 0, end, -this.pos);
      }
    }
    if (this.split) {
      this.mixSplit(out0, out1, n, input, this.split);
      this.advance(startPos, n);
      return;
    }

    this.measureLatency();
    this.master.clear(n);
    for (const b of this.buses) b.clear(n);
    const at = Math.max(0, this.pos);
    for (const t of this.trackOrder) if (t.lanes.length) t.automate(at);
    for (const b of this.buses) if (b.lanes.length) b.automate(at);
    if (this.master.lanes.length) this.master.automate(at);
    for (const s of [...this.trackOrder, ...this.buses, this.master])
      s.automateFrames(this.spans, this.spanCount, n, at);
    for (const t of this.trackOrder) {
      this.renderTrack(t, n, input);
      this.meter(t, n);
      this.route(t, n);
    }
    for (const b of this.buses) {
      b.run(n);
      this.meter(b, n);
      this.route(b, n);
    }
    this.master.run(n);
    this.meter(this.master, n);
    for (let i = 0; i < n; i++) {
      out0[i] = this.master.l[i] as number;
      out1[i] = this.master.r[i] as number;
    }
    this.clicks(out0, out1, n);
    this.advance(startPos, n);
  }

  /** The playhead past this block (round the cycle), and the transport as it now stands. */
  private advance(startPos: number, n: number): void {
    if (this.playing) {
      this.pos = startPos + n;
      const c = this.cycle;
      // (a block that ends right on the cycle's end leaves the jump to the next, before it plays)
      if (c.on && c.end > c.start && startPos < c.end && this.pos > c.end) this.pos = c.start + (this.pos - c.end);
    }
    const tr = this.transport ?? this.fallbackTransport;
    tr[0] = this.pos;
    tr[1] = this.playing ? 1 : 0;
    tr[2] = this.contextFrame + n;
    tr[3] = this.recording ? 1 : 0;
    tr[4] = this.sr;
    tr[5] = this.lastCmd;
    tr[6] = this.latency;
    if (!this.transport && (!this.split || this.split.self < 0) && ++this.sendCounter % 8 === 0) {
      this.post({ type: 'state', transport: this.fallbackTransport.slice(), meters: this.fallbackMeters.slice() });
    }
  }
}

function usesSampler(spec: TrackSpec, key: string): boolean {
  return [spec.instrument, ...spec.articulations].some((i) => i.kind === 'sampler' && i.key === key);
}
