import type { PreparedImpulse } from './convolver.ts';

/**
 * What the main thread and the audio thread say to each other.
 *
 * Live MIDI and the meters don't go through messages: they share memory (SharedArrayBuffer), so a
 * note you play reaches the audio thread within one render quantum (128 frames, under 3 ms) even
 * while the screen is busy. Everything else (the song, the mixer, samples) goes by message.
 */

/** The live-MIDI ring: a write and a read index, then EVENT_INTS ints per event. */
export const RING_EVENTS = 4096;
export const EVENT_INTS = 4;
export const RING_HEADER = 2;
/** [status | d1 << 8 | d2 << 16, target track number, flags, spare] */
export const RING_INTS = RING_HEADER + RING_EVENTS * EVENT_INTS;

/** Meters: METER_FLOATS floats per channel number (0 is the master). */
export const METER_CHANNELS = 512;
export const METER_FLOATS = 4; // peak L, peak R, gain reduction (dB, ≤ 0), the watched plugin's gain reduction

/**
 * Transport: song frame, playing (0/1), the context frame it was written at, recording (0/1), the
 * sample rate, the number of the last transport command the audio thread has taken in, and how many
 * frames the mix's sound is behind the song (plugin delays, compensated). Then the DSP load: the
 * share of each block's time the engine takes (smoothed), its peak over the last second or so, how
 * many blocks have overrun their time, and 1 when the audio thread's clock is fine-grained enough to
 * time a block (0: averages only).
 */
export const TRANSPORT_FLOATS = 12;
export const TR_LOAD = 7;
export const TR_LOAD_PEAK = 8;
export const TR_OVERLOADS = 9;
export const TR_FINE_CLOCK = 10;

/** Sequenced events: EVENT_SIZE numbers each, sorted by frame. */
export const EVENT_SIZE = 5;
export const EV_OFF = 0;
export const EV_ON = 1;
export const EV_CC = 2;
export const EV_BEND = 3;
export const EV_PRESSURE = 4;

export type InstrumentSpec =
  | { kind: 'sampler'; key: string }
  | { kind: 'synth'; preset: string; params?: Record<string, number> }
  | { kind: 'drums' }
  | { kind: 'none' };

export interface PluginSpec {
  id: string;
  type: string;
  bypass: boolean;
  params: Record<string, number>;
  settings?: Record<string, string>;
}

export interface ChannelSpec {
  /** Stable number: meters and live MIDI use it. 0 is the master. */
  num: number;
  id: string;
  volume: number;
  pan: number;
  mute: boolean;
  inserts: PluginSpec[];
  sends: { bus: string; level: number; pre: boolean }[];
  output: string;
  /** Lanes to play: flat [frame, value, frame, value…], frames on the song's timeline. */
  automation: { param: string; points: number[]; stepped: boolean; smooth?: boolean }[];
  /** A stage: near and far seats and the distance between them (see the session's Stage). */
  stage?: { distance: number; near: SeatSpec; far: SeatSpec };
}

export interface SeatSpec {
  depth: number;
  sends: { bus: string; level: number }[];
}

export interface TrackSpec extends ChannelSpec {
  instrument: InstrumentSpec;
  /** Articulation instruments, by index (1, 2…) as notes' `art` field. */
  articulations: InstrumentSpec[];
  midiFx: PluginSpec[];
}

export interface GraphSpec {
  tracks: TrackSpec[];
  buses: ChannelSpec[];
  master: ChannelSpec;
  /** Ids of channels heard because something is soloed (the soloed ones and what they feed). */
  soloed: string[] | null;
}

/** One instrument's samples. Channel data is transferred, not copied. */
export interface SampleZone {
  left: Float32Array;
  right: Float32Array | null;
  /** The sample's true pitch (MIDI, fractional). */
  root: number;
  lo: number;
  hi: number;
  lovel: number;
  hivel: number;
  /** Linear gain that levels this sample with its neighbours. */
  gain: number;
  /** Loop in frames (at the context's rate); loopEnd 0 = no loop. */
  loopStart: number;
  loopEnd: number;
  /** Round-robin slot (0 = always). */
  rr: number;
}

export interface SamplerSpec {
  key: string;
  zones: SampleZone[];
  /** Seconds a released note takes to fade. */
  release: number;
  /** Notes play to their end whatever the key does (drums, plucks that ring). */
  oneShot: boolean;
  /** False for unpitched sounds (drums): every key plays the sample at its own pitch. */
  pitched: boolean;
  /** dB between the softest and the hardest velocity inside one layer. */
  velocityRange: number;
  /** Seconds to fade a note in: just enough to avoid a click, the sample keeps its own attack. */
  attack: number;
}

/**
 * Audio heard from one region on an audio track, in frames of the song's timeline. Where regions
 * overlap only the top one plays, so a region may be heard in pieces.
 */
export interface ClipSpec {
  /** The audio it plays (a file, or a file stretched). */
  key: string;
  /** The stretch of song this piece plays. */
  start: number;
  end: number;
  /** The frame in that audio heard at `start`. */
  source: number;
  /** The whole region (fades are measured from its edges). */
  regionStart: number;
  regionEnd: number;
  /** Linear. */
  gain: number;
  fadeIn: number;
  fadeOut: number;
}

/** An audio track's input: what it monitors and records. */
export interface InputSpec {
  num: number;
  /** First input channel, and how many. */
  input: number;
  channels: 1 | 2;
  monitor: boolean;
  record: boolean;
}

export interface TempoSegment {
  frame: number;
  tick: number;
  framesPerTick: number;
}

/** A planned part (a Performance instrument's, Glass's), from the compiler. */
export type { PartPlans } from './parts.ts';

/**
 * Rendering ahead (ahead.ts): the shared memory the engines hand sound over through, how many
 * connections its data holds, how many workers there are, and which one this engine is (-1: the
 * audio thread).
 */
export interface AheadSpec {
  control: SharedArrayBuffer;
  data: SharedArrayBuffer;
  edges: number;
  workers: number;
  self: number;
}

export type ToWorklet =
  | {
      type: 'init';
      ring: SharedArrayBuffer | null;
      meters: SharedArrayBuffer | null;
      transport: SharedArrayBuffer | null;
      ahead?: AheadSpec | null;
    }
  /**
   * Rendering ahead: who plays each strip, by channel number (a worker's index, or -1 for the
   * audio thread; the master is always the audio thread's).
   */
  | { type: 'ahead'; owners: number[] }
  /** Rendering ahead: room for more connections, from the block this is taken in at. */
  | { type: 'aheadData'; data: SharedArrayBuffer; edges: number }
  | { type: 'graph'; graph: GraphSpec }
  | { type: 'sequence'; num: number; events: Float64Array }
  | { type: 'tempo'; segments: TempoSegment[]; ppq: number; beatTicks: number; barTicks: number }
  | { type: 'sampler'; spec: SamplerSpec }
  /** A Space Designer's response, prepared (transferred). */
  | { type: 'impulse'; key: string; data: PreparedImpulse }
  /** Audio for clips: one or two channels at the context's rate (transferred). */
  | { type: 'audio'; key: string; channels: Float32Array[] }
  | { type: 'forgetAudio'; key: string }
  | { type: 'clips'; num: number; clips: ClipSpec[] }
  | { type: 'inputs'; tracks: InputSpec[] }
  /** Punching in and out while playing. */
  | { type: 'record'; on: boolean }
  /** `cmd` numbers transport commands, so the page knows when the audio thread has caught up. */
  | { type: 'play'; frame: number; record: boolean; countIn: number; cmd?: number }
  | { type: 'stop'; cmd?: number }
  | { type: 'locate'; frame: number; cmd?: number }
  /** `wrap`: a loop being rendered, whose notes ring on across the jump (their ends come round again). */
  | { type: 'cycle'; on: boolean; start: number; end: number; wrap?: boolean }
  /** A track's planned part (null: it has none). */
  | { type: 'plans'; num: number; plans: import('./parts.ts').PartPlans | null }
  /** Sample files of a Performance instrument (`pack/name`), by their index in its manifest. */
  | { type: 'performance'; key: string; samples: { index: number; left: Float32Array; right: Float32Array }[] }
  | { type: 'metronome'; on: boolean; level: number }
  /** Live MIDI without shared memory (and the AI's played notes): [status, d1, d2, track num]… */
  | { type: 'live'; events: number[] }
  | { type: 'panic' }
  /** Answered with a pong once everything sent before it has been taken in. */
  | { type: 'ping'; id: number }
  | { type: 'lowLatency'; on: boolean }
  /** Count overloads from zero again. */
  | { type: 'resetLoad' }
  /** A plugin window is open: report that plugin's own gain reduction in its channel's meter. */
  | { type: 'watch'; num: number; plugin: string };

export type FromWorklet =
  | { type: 'ready' }
  /** Without shared memory: the transport and meters, a few times a second. */
  | { type: 'state'; transport: Float64Array; meters: Float32Array }
  | { type: 'error'; message: string }
  | { type: 'pong'; id: number }
  /**
   * Audio recorded on a track, a second at a time: `frame` is the song frame its first sample was
   * captured at (the round trip not yet taken off); `last` ends the take.
   */
  | { type: 'recorded'; num: number; take: number; frame: number; channels: Float32Array[]; last: boolean };
