/**
 * MIDI effects: they sit before an instrument and change the notes on their way in. They are
 * what makes live harmonising possible: the AI (or you) sets a key, a scale and the voices, and
 * every note you play is harmonised in the audio thread, with no delay.
 */
import { GROOVES, type Groove, paramValue, SCALES } from '@holo/session';
import { EV_OFF, EV_ON } from './protocol.ts';
import { positionRandom } from './random.ts';

/** A block's MIDI events in preallocated arrays, ordered by frame offset. */
export class EventList {
  count = 0;
  readonly offset: Int32Array;
  readonly kind: Uint8Array;
  readonly a: Float32Array;
  readonly b: Float32Array;
  readonly art: Uint8Array;
  readonly capacity: number;
  constructor(capacity = 2048) {
    this.capacity = capacity;
    this.offset = new Int32Array(capacity);
    this.kind = new Uint8Array(capacity);
    this.a = new Float32Array(capacity);
    this.b = new Float32Array(capacity);
    this.art = new Uint8Array(capacity);
  }
  clear(): void {
    this.count = 0;
  }
  push(offset: number, kind: number, a: number, b: number, art = 0): void {
    if (this.count >= this.capacity) return;
    // keep order by offset (events arrive almost sorted: insertion from the end)
    let i = this.count++;
    while (i > 0 && (this.offset[i - 1] as number) > offset) {
      this.offset[i] = this.offset[i - 1] as number;
      this.kind[i] = this.kind[i - 1] as number;
      this.a[i] = this.a[i - 1] as number;
      this.b[i] = this.b[i - 1] as number;
      this.art[i] = this.art[i - 1] as number;
      i--;
    }
    this.offset[i] = offset;
    this.kind[i] = kind;
    this.a[i] = a;
    this.b[i] = b;
    this.art[i] = art;
  }
}

export interface MidiHost {
  sr: number;
  beatSeconds(): number;
  /** The song's position in quarter notes at the block's start, and whether it is playing. */
  beatAt(): number;
  playing(): boolean;
  /** The bar the block starts in, counted from 0 by the song's meters, and how far into it (4.5: half way through the fifth). */
  barAt?(): number;
  /** Quarter notes in that bar (4 in 4/4, 3 in 3/4 and in 6/8). */
  barBeats?(): number;
}

export interface MidiEffect {
  setParams(p: Record<string, number>): void;
  /**
   * Read `input`, write `output` (both for one block of n frames). `song` is false where this engine
   * doesn't play the strip's song (the audio thread's twin of a strip a worker plays): only what comes
   * in live goes through, and nothing that plays along with the song is made.
   */
  process(input: EventList, output: EventList, n: number, song?: boolean): void;
  reset(): void;
  /** Still making notes with nothing coming in (an arpeggio over held or latched keys). */
  busy?(): boolean;
}

function scaleOf(p: Record<string, number>, type: string) {
  const key = Math.round(paramValue(type, p, 'key'));
  const steps = (SCALES[Math.round(paramValue(type, p, 'scale'))] ?? SCALES[0])?.steps ?? [0, 2, 4, 5, 7, 9, 11];
  return { key, steps };
}

/** Move a pitch `n` scale steps, keeping any chromatic offset from the scale it started with. */
export function scaleStep(pitch: number, n: number, key: number, steps: readonly number[]): number {
  const rel = pitch - key;
  const octave = Math.floor(rel / 12);
  const pc = rel - octave * 12;
  let degree = 0;
  for (let i = 0; i < steps.length; i++) if ((steps[i] as number) <= pc) degree = i;
  const chroma = pc - (steps[degree] as number);
  const total = degree + n;
  const len = steps.length;
  const o = Math.floor(total / len);
  const d = total - o * len;
  return key + (octave + o) * 12 + (steps[d] as number) + chroma;
}

function nearestInScale(pitch: number, key: number, steps: readonly number[]): number {
  let best = pitch;
  let dist = 99;
  for (let o = -1; o <= 1; o++) {
    for (const s of steps) {
      const base = Math.floor((pitch - key) / 12) * 12 + key + o * 12 + s;
      const d = Math.abs(base - pitch);
      if (d < dist || (d === dist && base < best)) {
        dist = d;
        best = base;
      }
    }
  }
  return best;
}

/** Passes everything that isn't a note through unchanged. */
function passOther(input: EventList, output: EventList, i: number): boolean {
  const k = input.kind[i] as number;
  if (k === EV_ON || k === EV_OFF) return false;
  output.push(input.offset[i] as number, k, input.a[i] as number, input.b[i] as number, input.art[i] as number);
  return true;
}

class Harmonizer implements MidiEffect {
  private key = 0;
  private steps: readonly number[] = [0, 2, 4, 5, 7, 9, 11];
  private voices = [2, 0, 0];
  private velScale = 0.8;
  private original = true;
  private held = new Map<number, number[]>();
  setParams(p: Record<string, number>): void {
    const { key, steps } = scaleOf(p, 'harmonizer');
    this.key = key;
    this.steps = steps;
    this.voices = ['voice1', 'voice2', 'voice3'].map((v) => Math.round(paramValue('harmonizer', p, v)));
    this.velScale = paramValue('harmonizer', p, 'velocity') / 100;
    this.original = paramValue('harmonizer', p, 'original') >= 0.5;
  }
  process(input: EventList, output: EventList): void {
    const { key, steps, voices, velScale, original } = this;
    for (let i = 0; i < input.count; i++) {
      if (passOther(input, output, i)) continue;
      const off = input.offset[i] as number;
      const pitch = input.a[i] as number;
      const art = input.art[i] as number;
      if (input.kind[i] === EV_ON) {
        const outs: number[] = [];
        if (original) outs.push(pitch);
        for (const v of voices) if (v !== 0) outs.push(scaleStep(Math.round(pitch), v, key, steps));
        const prev = this.held.get(pitch);
        if (prev) for (const o of prev) output.push(off, EV_OFF, o, 0, art);
        this.held.set(pitch, outs);
        for (const o of outs) {
          const vel =
            o === pitch && original
              ? (input.b[i] as number)
              : Math.max(1, Math.min(127, (input.b[i] as number) * velScale));
          output.push(off, EV_ON, o, vel, art);
        }
      } else {
        const outs = this.held.get(pitch);
        this.held.delete(pitch);
        for (const o of outs ?? [pitch]) output.push(off, EV_OFF, o, 0, art);
      }
    }
  }
  reset(): void {
    this.held.clear();
  }
}

class ScaleQuantizer implements MidiEffect {
  private key = 0;
  private steps: readonly number[] = [0, 2, 4, 5, 7, 9, 11];
  private transpose = 0;
  private snap = true;
  private held = new Map<number, number>();
  setParams(p: Record<string, number>): void {
    const { key, steps } = scaleOf(p, 'scale');
    this.key = key;
    this.steps = steps;
    this.transpose = Math.round(paramValue('scale', p, 'transpose'));
    this.snap = paramValue('scale', p, 'quantize') >= 0.5;
  }
  process(input: EventList, output: EventList): void {
    const { key, steps, transpose, snap } = this;
    for (let i = 0; i < input.count; i++) {
      if (passOther(input, output, i)) continue;
      const pitch = input.a[i] as number;
      if (input.kind[i] === EV_ON) {
        let out = pitch + transpose;
        if (snap) out = nearestInScale(Math.round(out), key, steps);
        this.held.set(pitch, out);
        output.push(input.offset[i] as number, EV_ON, out, input.b[i] as number, input.art[i] as number);
      } else {
        const out = this.held.get(pitch) ?? pitch + transpose;
        this.held.delete(pitch);
        output.push(input.offset[i] as number, EV_OFF, out, 0, input.art[i] as number);
      }
    }
  }
  reset(): void {
    this.held.clear();
  }
}

class VelocityProcessor implements MidiEffect {
  private scale = 1;
  private offset = 0;
  private random = 0;
  private lo = 1;
  private hi = 127;
  private seed = 12345;
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('velocity', p, id);
    this.scale = v('scale') / 100;
    this.offset = v('offset');
    this.random = v('random');
    this.lo = v('min');
    this.hi = Math.max(this.lo, v('max'));
  }
  process(input: EventList, output: EventList): void {
    const { scale, offset, random, lo, hi } = this;
    for (let i = 0; i < input.count; i++) {
      let b = input.b[i] as number;
      if (input.kind[i] === EV_ON) {
        this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
        const jitter = random ? ((this.seed / 0x7fffffff) * 2 - 1) * random : 0;
        b = Math.round(Math.min(hi, Math.max(lo, b * scale + offset + jitter)));
      }
      output.push(input.offset[i] as number, input.kind[i] as number, input.a[i] as number, b, input.art[i] as number);
    }
  }
  reset(): void {}
}

const ARP_BEATS = [1, 0.5, 1 / 3, 0.25, 1 / 6, 0.125];

class Arpeggiator implements MidiEffect {
  private latch = false;
  private mode = 0;
  private octaves = 1;
  private rate = 0.25;
  private gate = 0.8;
  private swing = 0;
  /** Keys held, in the order they were played. */
  private held: { key: number; vel: number }[] = [];
  private latched: { key: number; vel: number }[] = [];
  /** The notes the arpeggio runs over, worked out again when the keys or the settings change. */
  private notes: { key: number; vel: number }[] = [];
  private stale = true;
  private physical = 0;
  private step = 0;
  private dir = 1;
  private sounding: number[] = [];
  private offAt = -1;
  private nextBeat = -1;
  /** The clock while the song is stopped (the song's beats while it plays). */
  private freeBeat = 0;
  /** The beat the last block ended on, by the clock it kept (NaN: none yet), and whether that was the song's. */
  private lastBeat = Number.NaN;
  private wasPlaying = false;
  private seed = 99;
  private readonly host: MidiHost;
  constructor(host: MidiHost) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('arpeggiator', p, id);
    this.latch = v('latch') >= 0.5;
    this.mode = Math.round(v('mode'));
    this.octaves = Math.round(v('octaves'));
    this.rate = ARP_BEATS[Math.round(v('rate'))] ?? 0.25;
    this.gate = v('gate') / 100;
    this.swing = v('swing') / 100;
    this.stale = true;
  }
  private pattern(): { key: number; vel: number }[] {
    if (!this.stale) return this.notes;
    this.stale = false;
    const base = this.latch ? this.latched : this.held;
    const out: { key: number; vel: number }[] = [];
    this.notes = out;
    if (!base.length) return out;
    const { mode, octaves } = this;
    const sorted = mode === 3 ? base.slice() : base.slice().sort((a, b) => a.key - b.key);
    for (let o = 0; o < octaves; o++) for (const n of sorted) out.push({ key: n.key + o * 12, vel: n.vel });
    return out;
  }
  process(input: EventList, output: EventList, n: number): void {
    const { latch, mode, rate, gate, swing } = this;
    for (let i = 0; i < input.count; i++) {
      const kind = input.kind[i] as number;
      if (kind !== EV_ON && kind !== EV_OFF) {
        passOther(input, output, i);
        continue;
      }
      const key = input.a[i] as number;
      this.stale = true;
      if (kind === EV_ON) {
        if (latch && this.physical === 0) this.latched = [];
        this.physical++;
        this.held.push({ key, vel: input.b[i] as number });
        if (latch && !this.latched.some((x) => x.key === key)) this.latched.push({ key, vel: input.b[i] as number });
        if (this.held.length === 1 && !latch) {
          this.step = 0;
          this.dir = 1;
        }
      } else {
        this.physical = Math.max(0, this.physical - 1);
        // the key let go, out of the held (in place: nothing new to collect)
        const held = this.held;
        let kept = 0;
        for (const x of held) if (x.key !== key) held[kept++] = x;
        held.length = kept;
      }
    }
    const sr = this.host.sr;
    const beatSec = this.host.beatSeconds();
    const playing = this.host.playing();
    const beat0 = playing ? this.host.beatAt() : this.freeBeat;
    const beatsPerFrame = 1 / (beatSec * sr);
    const beat1 = beat0 + n * beatsPerFrame;
    if (!playing) this.freeBeat = beat1;
    // the song started, stopped or jumped (a locate, a cycle going round): the clock changed under
    // what's sounding (its end was due by the old one), so it ends here, and the steps start again
    // from where this clock is. A stop also lets a latched pattern go: Stop is silence.
    if (
      playing !== this.wasPlaying ||
      Number.isNaN(this.lastBeat) ||
      beat0 < this.lastBeat - 1e-6 ||
      beat0 > this.lastBeat + n * beatsPerFrame + 1e-6
    ) {
      for (const k of this.sounding) output.push(0, EV_OFF, k, 0);
      this.sounding = [];
      this.offAt = -1;
      this.nextBeat = -1;
      if (this.wasPlaying && !playing && this.latched.length) {
        this.latched = [];
        this.stale = true;
      }
    }
    this.wasPlaying = playing;
    this.lastBeat = beat1;
    const notes = this.pattern();
    // note-offs due in this block
    if (this.offAt >= 0 && this.offAt < beat1) {
      const off = Math.max(0, Math.min(n - 1, Math.round((this.offAt - beat0) / beatsPerFrame)));
      for (const k of this.sounding) output.push(off, EV_OFF, k, 0);
      this.sounding = [];
      this.offAt = -1;
    }
    if (!notes.length) {
      this.nextBeat = -1;
      return;
    }
    if (this.nextBeat < 0 || this.nextBeat < beat0 - rate) this.nextBeat = Math.ceil(beat0 / rate) * rate;
    while (this.nextBeat < beat1) {
      const index = Math.round(this.nextBeat / rate);
      const swingShift = index % 2 === 1 ? swing * rate * 0.5 : 0;
      const at = this.nextBeat + swingShift;
      const off = Math.max(0, Math.min(n - 1, Math.round((at - beat0) / beatsPerFrame)));
      for (const k of this.sounding) output.push(off, EV_OFF, k, 0);
      this.sounding = [];
      const chosen: { key: number; vel: number }[] = [];
      if (mode === 5) chosen.push(...notes);
      else if (mode === 4) {
        this.seed = (this.seed * 1103515245 + 12345) & 0x7fffffff;
        chosen.push(notes[this.seed % notes.length] as { key: number; vel: number });
      } else {
        const len = notes.length;
        let idx: number;
        if (mode === 1) idx = len - 1 - (this.step % len);
        else if (mode === 2 && len > 1) {
          const cycle = 2 * len - 2;
          const s = this.step % cycle;
          idx = s < len ? s : cycle - s;
        } else idx = this.step % len;
        chosen.push(notes[idx] as { key: number; vel: number });
      }
      this.step++;
      for (const c of chosen) {
        output.push(off, EV_ON, c.key, c.vel);
        this.sounding.push(c.key);
      }
      this.offAt = at + rate * gate;
      this.nextBeat += rate;
    }
    if (this.dir === 0) this.dir = 1;
  }
  reset(): void {
    this.held = [];
    this.latched = [];
    this.sounding = [];
    this.physical = 0;
    this.offAt = -1;
    this.nextBeat = -1;
    this.lastBeat = Number.NaN;
    this.stale = true;
  }
  busy(): boolean {
    return (this.latch ? this.latched : this.held).length > 0 || this.sounding.length > 0;
  }
}

/** What a groove's step says: how hard (0: nothing), by its character and the Complexity. */
function stepLevel(ch: number, complexity: number): number {
  switch (ch) {
    case 88: // X
      return 1;
    case 120: // x
      return 0.82;
    case 79: // O
      return 0.85;
    case 111: // o
      return 0.62;
    case 103: // g
      return 0.32;
    default:
      // a digit: from that tenth of Complexity up
      if (ch >= 49 && ch <= 57) return complexity * 10 >= ch - 48 - 1e-9 ? 0.5 : 0;
      return 0;
  }
}

const KICK = 36;
const SNARE = 38;
const SIDE_STICK = 37;
const CLOSED_HAT = 42;
const PEDAL_HAT = 44;
const OPEN_HAT = 46;
const CRASH = 49;
const RIDE = 51;
const RIDE_BELL = 53;
const TOMS = [50, 48, 45, 43];
/** Percussion's keys, by its option: none, tambourine, shaker, cowbell, clap. */
const PERC_KEYS = [0, 54, 70, 56, 39];
/** Parts, for the humanising draws. */
const P_KICK = 1;
const P_SNARE = 2;
const P_CYMBAL = 3;
const P_FOOT = 4;
const P_PERC = 5;
const P_FILL = 6;
const P_CRASH = 7;
/** Notes the drummer can have sounding at once (each ends a step after it starts). */
const DRUM_HELD = 64;

/**
 * Session Drummer: plays a style's groove while the song plays, a step at a time, in time with the
 * song (by its bars and meters). Complexity brings in the groove's busier notes (and from 60% the
 * kick varies its second and fourth bars); Loudness is how hard it plays; Fills is how often the
 * last bar of a four-bar phrase ends in a fill, and how long the fill is, with a crash into the next.
 * Kick & Snare picks the groove's variation, Cymbals what the cymbal hand plays, Percussion a part
 * for a second player.
 *
 * Every choice it makes by chance (which bars get fills, their shape, each hit's touch) is drawn
 * from where it falls in the song, so it plays the same each time from wherever it starts, and on
 * whichever thread. It plays only while the song does, and only where this engine plays the song;
 * its notes end when the song stops or jumps.
 */
class SessionDrummer implements MidiEffect {
  private groove: Groove = GROOVES[0] as Groove;
  private complexity = 0.4;
  private loudness = 0.6;
  private fills = 0.4;
  private swing = 0;
  private variation = 0;
  private cymbal = 0;
  private perc = 0;
  /** The song's beat up to which steps have been played (NaN: not playing). */
  private done = Number.NaN;
  private readonly offKey = new Int32Array(DRUM_HELD);
  private readonly offAt = new Float64Array(DRUM_HELD);
  private held = 0;
  /** The block being made: its first beat, beats a frame, and frames. */
  private beat0 = 0;
  private bpf = 0;
  private n = 0;
  private out: EventList | null = null;
  private readonly host: MidiHost;
  constructor(host: MidiHost) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('drummer', p, id);
    this.groove = GROOVES[Math.round(v('genre'))] ?? (GROOVES[0] as Groove);
    this.complexity = v('complexity') / 100;
    this.loudness = v('loudness') / 100;
    this.fills = v('fills') / 100;
    this.swing = v('swing') / 100;
    this.variation = Math.round(v('kick')) - 1;
    this.cymbal = Math.round(v('cymbal'));
    this.perc = Math.round(v('perc'));
  }
  process(input: EventList, output: EventList, n: number, song = true): void {
    // whatever comes in goes through: you can play over the drummer
    for (let i = 0; i < input.count; i++)
      output.push(
        input.offset[i] as number,
        input.kind[i] as number,
        input.a[i] as number,
        input.b[i] as number,
        input.art[i] as number,
      );
    if (!song || !this.host.playing()) {
      this.endAll(output, 0);
      this.done = Number.NaN;
      return;
    }
    const host = this.host;
    const bpf = 1 / (host.beatSeconds() * host.sr);
    const beat0 = host.beatAt();
    const beat1 = beat0 + n * bpf;
    // the song jumped (a locate, a cycle going round): what's sounding ends, and it plays on from here
    if (Number.isNaN(this.done) || beat0 < this.done - 1e-6 || beat0 > this.done + n * bpf + 1e-6) {
      this.endAll(output, 0);
      this.done = beat0;
    }
    this.beat0 = beat0;
    this.bpf = bpf;
    this.n = n;
    this.out = output;
    // notes whose step is over
    for (let k = 0; k < this.held; ) {
      if ((this.offAt[k] as number) < beat1) {
        output.push(this.offset(this.offAt[k] as number), EV_OFF, this.offKey[k] as number, 0);
        this.held--;
        this.offAt[k] = this.offAt[this.held] as number;
        this.offKey[k] = this.offKey[this.held] as number;
      } else k++;
    }
    const from = Math.max(0, this.done);
    this.done = beat1;
    if (beat1 <= 0) return;
    // the bars this block reaches into (a count-in plays nothing)
    const barBeats = host.barBeats?.() ?? 4;
    const at = host.barAt?.() ?? beat0 / 4;
    let bar = Math.floor(at);
    let barStart = beat0 - (at - bar) * barBeats;
    if (from < barStart && bar > 0) {
      bar--;
      barStart -= barBeats;
    }
    const g = this.groove;
    const grid = g.grid;
    const steps = Math.max(1, Math.round(barBeats * grid));
    for (; barStart < beat1; bar++, barStart += barBeats) {
      for (let s = 0; s < steps; s++) {
        // straight grooves swing their off sixteenths
        const shift = grid === 4 && s % 2 === 1 ? (this.swing * 0.5) / grid : 0;
        const sb = barStart + s / grid + shift;
        if (sb < from || sb >= beat1 || sb < 0) continue;
        this.step(bar, s, steps, sb);
      }
    }
    this.out = null;
  }

  /** The block's frame for a beat. */
  private offset(beat: number): number {
    return Math.max(0, Math.min(this.n - 1, Math.round((beat - this.beat0) / this.bpf)));
  }

  /** Whether a bar (the last of a four-bar phrase) ends in a fill, and its length in steps (0: none). */
  private fillSteps(bar: number, steps: number): number {
    if (bar < 0 || bar % 4 !== 3 || this.fills <= 0) return 0;
    const chance = Math.min(1, this.fills * (bar % 8 === 7 ? 1.6 : 1.1));
    if (positionRandom(bar, 0, P_FILL) >= chance) return 0;
    // a beat at the least, the whole bar at the most: longer the more Fills asks for
    const grid = this.groove.grid;
    const beats = 1 + Math.floor(this.fills * 2.5 + positionRandom(bar, 1, P_FILL) * 1.5);
    return Math.min(steps, beats * grid);
  }

  private step(bar: number, s: number, steps: number, sb: number): void {
    const g = this.groove;
    const grid = g.grid;
    const c = this.complexity;
    const p = s % (4 * grid);
    const fill = this.fillSteps(bar, steps);
    const inFill = fill > 0 && s >= steps - fill;
    const crash = s === 0 && this.fills > 0 && this.fillSteps(bar - 1, steps) > 0;
    // the hi-hat foot keeps time under everything
    const footLevel = g.foot ? stepLevel(g.foot.charCodeAt(p), c) : 0;
    const ride = this.cymbal === 0 ? g.ride === true : this.cymbal >= 3;
    if (footLevel > 0) this.hit(PEDAL_HAT, footLevel, bar, s, P_FOOT, sb);
    else if (ride && !g.foot && grid === 4 && (p === grid || p === 3 * grid))
      this.hit(PEDAL_HAT, 0.5, bar, s, P_FOOT, sb);
    if (crash) {
      this.hit(CRASH, 1, bar, s, P_CRASH, sb);
      this.hit(KICK, 1, bar, s, P_KICK, sb);
    }
    if (inFill) {
      this.fillHit(bar, s - (steps - fill), fill, s, sb);
      return;
    }
    // Kick & Snare: the chosen variation, and from 60% Complexity the next one in the second and fourth bars
    const vary = this.variation + (c >= 0.6 && bar % 2 === 1 ? 1 : 0);
    const kick = g.kick[vary % g.kick.length] as string;
    const snare = g.snare[vary % g.snare.length] as string;
    if (!crash) {
      const k = stepLevel(kick.charCodeAt(p), c);
      if (k > 0) this.hit(KICK, k, bar, s, P_KICK, sb);
    }
    const sn = stepLevel(snare.charCodeAt(p), c);
    if (sn > 0) {
      const key = g.cross !== undefined && c * 100 < g.cross ? SIDE_STICK : (g.snareKey ?? SNARE);
      this.hit(key, sn, bar, s, P_SNARE, sb);
    }
    const ch = g.cymbal.charCodeAt(p);
    const cy = stepLevel(ch, c);
    if (cy > 0 && !crash) {
      const open = ch === 79;
      let key: number;
      if (this.cymbal === 0) key = ride ? RIDE : open ? OPEN_HAT : CLOSED_HAT;
      else if (this.cymbal === 1) key = open ? OPEN_HAT : CLOSED_HAT;
      else if (this.cymbal === 2) key = OPEN_HAT;
      else key = this.cymbal === 3 ? RIDE : RIDE_BELL;
      this.hit(key, this.cymbal === 2 ? cy * 0.8 : cy, bar, s, P_CYMBAL, sb);
    }
    const pk = PERC_KEYS[this.perc] ?? 0;
    if (pk) {
      const pl = stepLevel(g.perc.charCodeAt(p), c);
      if (pl > 0) this.hit(pk, pl * 0.8, bar, s, P_PERC, sb);
    }
  }

  /** A fill's step `j` of `len`: around the toms, on the snare, or soft brush triplets; shaped by the bar. */
  private fillHit(bar: number, j: number, len: number, s: number, sb: number): void {
    const g = this.groove;
    const grid = g.grid;
    // fewer notes for a gentle fill: eighths
    if (grid === 4 && this.fills < 0.5 && j % 2 === 1) return;
    const pos = j / len;
    const shape = Math.floor(positionRandom(bar, 2, P_FILL) * 3);
    if (g.fill === 'brush') {
      this.hit(SNARE, 0.3 + 0.35 * pos, bar, s, P_FILL, sb);
      return;
    }
    let key = SNARE;
    if (g.fill === 'toms') {
      const tom = TOMS[Math.min(3, Math.floor(pos * 4))] as number;
      if (shape === 0) key = pos < 0.25 ? SNARE : tom;
      else if (shape === 1) key = pos < 0.5 ? SNARE : (TOMS[Math.min(3, 1 + Math.floor((pos - 0.5) * 6))] as number);
      else key = j % 2 === 0 ? SNARE : tom;
    } else if (shape === 2 && pos >= 0.75) key = TOMS[3] as number;
    const accent = j % grid === 0 ? 0.12 : 0;
    this.hit(key, Math.min(1, (key === SNARE ? 0.55 : 0.72) + 0.3 * pos + accent), bar, s, P_FILL, sb);
    // the kick under each beat of a fill around the toms
    if (g.fill === 'toms' && j % grid === 0) this.hit(KICK, 0.7, bar, s, P_KICK, sb);
  }

  /** A note now: how hard by the style, Loudness and a touch of its own; ended a step later. */
  private hit(key: number, level: number, bar: number, s: number, part: number, sb: number): void {
    const out = this.out;
    if (!out) return;
    const touch = 1 + (positionRandom(bar, s * 16 + part, key) - 0.5) * 0.12;
    const loud = 0.5 + 0.65 * this.loudness;
    const vel = Math.max(1, Math.min(127, Math.round(level * this.groove.level * loud * touch * 127)));
    // the same piece still held: it ends here, before it's struck again
    for (let k = 0; k < this.held; k++) {
      if (this.offKey[k] === key) {
        out.push(this.offset(sb), EV_OFF, key, 0);
        this.held--;
        this.offAt[k] = this.offAt[this.held] as number;
        this.offKey[k] = this.offKey[this.held] as number;
        break;
      }
    }
    out.push(this.offset(sb), EV_ON, key, vel);
    if (this.held < DRUM_HELD) {
      this.offKey[this.held] = key;
      this.offAt[this.held] = sb + 0.9 / this.groove.grid;
      this.held++;
    } else out.push(this.offset(sb), EV_OFF, key, 0);
  }

  private endAll(output: EventList, offset: number): void {
    for (let k = 0; k < this.held; k++) output.push(offset, EV_OFF, this.offKey[k] as number, 0);
    this.held = 0;
  }
  reset(): void {
    this.held = 0;
    this.done = Number.NaN;
  }
  busy(): boolean {
    return this.held > 0;
  }
}

export function createMidiEffect(type: string, host: MidiHost): MidiEffect | null {
  switch (type) {
    case 'harmonizer':
      return new Harmonizer();
    case 'scale':
      return new ScaleQuantizer();
    case 'velocity':
      return new VelocityProcessor();
    case 'arpeggiator':
      return new Arpeggiator(host);
    case 'drummer':
      return new SessionDrummer(host);
    default:
      return null;
  }
}
