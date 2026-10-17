/**
 * MIDI effects: they sit before an instrument and change the notes on their way in. They are
 * what makes live harmonising possible: the AI (or you) sets a key, a scale and the voices, and
 * every note you play is harmonised in the audio thread, with no delay.
 */
import { paramValue, SCALES } from '@holo/session';
import { EV_OFF, EV_ON } from './protocol.ts';

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
}

export interface MidiEffect {
  setParams(p: Record<string, number>): void;
  /** Read `input`, write `output` (both for one block of n frames). */
  process(input: EventList, output: EventList, n: number): void;
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
  private p: Record<string, number> = {};
  private held = new Map<number, number[]>();
  setParams(p: Record<string, number>): void {
    this.p = p;
  }
  process(input: EventList, output: EventList): void {
    const { key, steps } = scaleOf(this.p, 'harmonizer');
    const voices = ['voice1', 'voice2', 'voice3'].map((v) => Math.round(paramValue('harmonizer', this.p, v)));
    const velScale = paramValue('harmonizer', this.p, 'velocity') / 100;
    const original = paramValue('harmonizer', this.p, 'original') >= 0.5;
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
  private p: Record<string, number> = {};
  private held = new Map<number, number>();
  setParams(p: Record<string, number>): void {
    this.p = p;
  }
  process(input: EventList, output: EventList): void {
    const { key, steps } = scaleOf(this.p, 'scale');
    const transpose = Math.round(paramValue('scale', this.p, 'transpose'));
    const snap = paramValue('scale', this.p, 'quantize') >= 0.5;
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
  private p: Record<string, number> = {};
  private seed = 12345;
  setParams(p: Record<string, number>): void {
    this.p = p;
  }
  process(input: EventList, output: EventList): void {
    const v = (id: string) => paramValue('velocity', this.p, id);
    const scale = v('scale') / 100;
    const offset = v('offset');
    const random = v('random');
    const lo = v('min');
    const hi = Math.max(lo, v('max'));
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
  private p: Record<string, number> = {};
  /** Keys held, in the order they were played. */
  private held: { key: number; vel: number }[] = [];
  private latched: { key: number; vel: number }[] = [];
  private physical = 0;
  private step = 0;
  private dir = 1;
  private sounding: number[] = [];
  private offAt = -1;
  private nextBeat = -1;
  private freeBeat = 0;
  private seed = 99;
  private readonly host: MidiHost;
  constructor(host: MidiHost) {
    this.host = host;
  }
  setParams(p: Record<string, number>): void {
    this.p = p;
  }
  private pattern(): { key: number; vel: number }[] {
    const v = (id: string) => paramValue('arpeggiator', this.p, id);
    const latch = v('latch') >= 0.5;
    const base = latch ? this.latched : this.held;
    if (!base.length) return [];
    const mode = Math.round(v('mode'));
    const octaves = Math.round(v('octaves'));
    const sorted = mode === 3 ? base.slice() : base.slice().sort((a, b) => a.key - b.key);
    const out: { key: number; vel: number }[] = [];
    for (let o = 0; o < octaves; o++) for (const n of sorted) out.push({ key: n.key + o * 12, vel: n.vel });
    return out;
  }
  process(input: EventList, output: EventList, n: number): void {
    const v = (id: string) => paramValue('arpeggiator', this.p, id);
    const latch = v('latch') >= 0.5;
    for (let i = 0; i < input.count; i++) {
      const kind = input.kind[i] as number;
      if (kind !== EV_ON && kind !== EV_OFF) {
        passOther(input, output, i);
        continue;
      }
      const key = input.a[i] as number;
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
        this.held = this.held.filter((x) => x.key !== key);
      }
    }
    const notes = this.pattern();
    const sr = this.host.sr;
    const beatSec = this.host.beatSeconds();
    const rate = ARP_BEATS[Math.round(v('rate'))] ?? 0.25;
    const gate = v('gate') / 100;
    const swing = v('swing') / 100;
    const playing = this.host.playing();
    const beat0 = playing ? this.host.beatAt() : this.freeBeat;
    const beatsPerFrame = 1 / (beatSec * sr);
    const beat1 = beat0 + n * beatsPerFrame;
    if (!playing) this.freeBeat = beat1;
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
      const mode = Math.round(v('mode'));
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
    this.nextBeat = -1;
  }
  busy(): boolean {
    const latch = paramValue('arpeggiator', this.p, 'latch') >= 0.5;
    return (latch ? this.latched : this.held).length > 0 || this.sounding.length > 0;
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
    default:
      return null;
  }
}
