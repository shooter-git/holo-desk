/**
 * The HO[LO] session: one song, everything the studio, the command line, the AI skill and a
 * creation's renderer share. It is plain JSON, so a creation can read and write it in any language.
 *
 * Every time is in ticks (PPQ per quarter note). Region note and controller times are relative to
 * the region's start.
 */

/** Ticks per quarter note. */
export const PPQ = 960;

export const SESSION_FORMAT = 'holo-session';
export const SESSION_VERSION = 1;

export interface Project {
  format: typeof SESSION_FORMAT;
  version: typeof SESSION_VERSION;
  id: string;
  title: string;
  /** Goes up by one with every saved change; a save against an older revision is a conflict. */
  revision: number;
  created: string;
  modified: string;
  /** Sorted by tick; the first point is at tick 0. */
  tempo: TempoPoint[];
  /** Sorted by tick; the first point is at tick 0, and every point sits on a bar line. */
  meter: MeterPoint[];
  /** e.g. "A lydian", "B minor"; free text, read by people and the AI. */
  key: string | null;
  markers: Marker[];
  chords: ChordMark[];
  tracks: Track[];
  buses: Bus[];
  master: Channel;
  cycle: Cycle;
  /** Where the song came from, when a creation sent it here. */
  origin: ProjectOrigin | null;
  /** Free notes for whoever opens the session next. */
  notes: string;
  /** Audio files the song's audio regions play (kept with the song on the host). */
  files?: AudioFile[];
  /** The rate the song renders at (bounces, headless renders, a creation's build); 48000 when unset. */
  sampleRate?: number;
  /** How its renders are finished (mastered); the live mix plays without it. */
  finish?: Finish;
  /**
   * Performance instruments' shared settings: the interpolator filter a creation made first for each
   * cut-off (to three places), so its filters are the creation's own.
   */
  performance?: { kernelCuts?: Record<string, number> };
  /** The song is a loop (a game's music, a menu's): rendered as it plays forever, one turn and a tail. */
  loop?: Loop;
}

/**
 * Mastering for bounces and headless renders: a low cut and a tilt, glue compression, loudness to a
 * target and a true-peak ceiling (the same arithmetic as Hallowed Lanterns' master).
 */
export interface Finish {
  /** Integrated loudness to reach (LUFS). */
  lufs: number;
  /** True-peak ceiling (dBTP). */
  ceiling: number;
  /** Glue compression on the loud parts (about 2 dB at 1.8:1). */
  glue: boolean;
  /** Low cut (Hz) and the tilt of a high shelf at 9 kHz (dB). */
  lowcut: number;
  tilt: number;
}

/**
 * A loop: from `start` to `end` (ticks), rendered as the steady state of playing it over and over,
 * so its end rings into its start; then `tail` seconds of its start again, for a player to cross into.
 */
export interface Loop {
  start: number;
  end: number;
  tail: number;
}

export interface AudioFile {
  id: string;
  /** The name it came with ("Vocal take 3.wav"). */
  name: string;
  seconds: number;
  /** Its own sample rate and channels. */
  rate: number;
  channels: number;
}

export interface TempoPoint {
  tick: number;
  /** Quarter notes per minute. */
  bpm: number;
}

export interface MeterPoint {
  tick: number;
  num: number;
  den: number;
  /** How the bar groups, in eighth notes: [3, 3, 2] is a 4/4 felt as 3+3+2. */
  groups?: number[];
}

export interface Marker {
  id: string;
  tick: number;
  name: string;
}

export interface ChordMark {
  tick: number;
  symbol: string;
}

export interface Cycle {
  on: boolean;
  start: number;
  end: number;
}

export interface ProjectOrigin {
  /** The creation's name, e.g. "my-game". */
  creation: string;
  /** The piece inside it, e.g. "theme". */
  piece: string;
  /** When the creation last sent it. */
  exportedAt: string;
  /** The creation's own fingerprint of what it sent, so a later send can tell what changed. */
  sourceHash?: string;
  /** Anything else the creation wants back untouched. */
  extra?: Record<string, unknown>;
}

export type Instrument =
  | { type: 'sampler'; pack: string; name: string }
  | { type: 'synth'; preset: string; params?: Record<string, number> }
  | { type: 'performance'; pack: string; name: string; play?: PerformancePlay }
  | { type: 'glass'; line?: boolean; options?: Record<string, number> }
  | { type: 'none' };

/**
 * How a Performance instrument plays its part: a pack instrument played as Hallowed Lanterns' sampler
 * plays it (its play() arguments). The part is planned whole (a note's legato depends on the next);
 * live playing goes to the pack's plain sampler.
 */
export interface PerformancePlay {
  /** The part's random choices (round robins, starts, how far velocities wander) come from it. */
  seed?: number;
  gainDb?: number;
  pan?: number;
  width?: number;
  legato?: boolean;
  legatoGap?: number;
  xf?: number;
  detune?: number;
  layerBias?: number;
  release?: number;
  tail?: number;
  panSpread?: number;
  humanizeV?: number;
  slide?: number;
  lag?: number;
  shape?: { attack?: number; swell?: number; taper?: number };
  /** Dynamics (a mod wheel, 0–1) through the song, for sustains: [tick, value], eased between points. */
  dyn?: [number, number][];
}

export interface Articulation {
  id: string;
  name: string;
  instrument: Instrument;
}

export interface Track {
  id: string;
  name: string;
  color: string;
  /** An instrument track plays notes; an audio track plays recordings. */
  kind: 'instrument' | 'audio';
  instrument: Instrument;
  /** Notes with `art` set play on that articulation's instrument instead. */
  articulations: Articulation[];
  /** Which live MIDI reaches this track: a port id or "*" for any, a channel 1–16 or 0 for all. */
  input: TrackInput;
  /** Record-armed: live MIDI is recorded here. */
  armed: boolean;
  /** MIDI effects (arpeggiator, harmonizer…), before the instrument. */
  midiFx: Plugin[];
  regions: Region[];
  channel: Channel;
  origin?: TrackOrigin;
  /** Audio tracks: what they record from. */
  audioInput?: AudioInput;
}

export interface AudioInput {
  /** The first input channel it records (0 = input 1); the device is each computer's own setting. */
  input: number;
  /** 1 records mono, 2 a stereo pair (input and the one after it). */
  channels: 1 | 2;
  /** Hear the input through the track while it's armed (wear headphones). */
  monitor: boolean;
}

export interface TrackInput {
  port: string;
  channel: number;
}

export interface TrackOrigin {
  /** The creation's own name for this voice. */
  voice: string;
  /** True once anyone changed its notes here: the creation then plays these notes, not its code's. */
  edited: boolean;
  /** The creation can't take changes to it back (notes written outside its score). */
  locked?: boolean;
  /** Anything else the creation wants back untouched. */
  extra?: Record<string, unknown>;
}

export interface Region {
  id: string;
  name: string;
  start: number;
  length: number;
  muted: boolean;
  color?: string;
  notes: Note[];
  /** Controller lanes, keyed "1".."127", "pb" (pitch bend) and "at" (channel pressure). */
  cc: Record<string, CCPoint[]>;
  /** On an audio track: the recording this region plays. */
  audio?: AudioClip;
}

export interface AudioClip {
  /** An id in the project's files. */
  file: string;
  /** Seconds into the file where the region starts. */
  offset: number;
  /** dB. */
  gain: number;
  /** Seconds. */
  fadeIn: number;
  fadeOut: number;
  /** 1 plays the file as recorded; 2 plays it twice as long at the same pitch. */
  stretch: number;
}

export interface Note {
  /** Start, in ticks from the region's start. */
  t: number;
  /** Length in ticks. */
  d: number;
  /** MIDI pitch; may be fractional. */
  p: number;
  /** Velocity 1–127. */
  v: number;
  /** Articulation id on the track. */
  art?: string;
  /** Extras a creation attached (bends, vibrato…); kept as they are. */
  x?: Record<string, unknown>;
}

/** [tick from the region's start, value]: 0–127, pitch bend −8192..8191. */
export type CCPoint = [number, number];

export interface Channel {
  /** Fader, in dB (−144 is silence). */
  volume: number;
  /** −1 (left) to 1 (right). */
  pan: number;
  mute: boolean;
  solo: boolean;
  inserts: Plugin[];
  sends: Send[];
  /** "master" or a bus id. */
  output: string;
  /** How the channel's settings move through the song. */
  automation?: AutomationLane[];
  /** Where it sits on a stage: a near seat, a far seat, and how far back between them. */
  stage?: Stage;
}

/**
 * A channel on a stage. Its sound (after the fader) is shared between a near and a far seat at equal
 * power: `distance` 0 is all near, 1 all far, and it can move through the song (automation
 * "distance"). Each seat sends to the rooms on its own, and its direct sound is set back by its depth.
 */
export interface Stage {
  distance: number;
  near: Seat;
  far: Seat;
}

export interface Seat {
  /**
   * 0 close … 1 far back: the seat's direct sound darker (a low pass from 18 kHz down to 10 kHz) and
   * quieter (to −7 dB). Its sends are of the sound as it reaches the seat, so further back is wetter.
   */
  depth: number;
  /** In dB, to buses (the rooms). */
  sends: { bus: string; level: number }[];
}

export interface AutomationLane {
  /** "volume", "pan", "mute", "distance", "send:<bus id>" or "fx:<plugin id>:<parameter id>". */
  param: string;
  /**
   * [tick, value], sorted by tick. Values are in the setting's own units: dB for volume and sends,
   * −1..1 for pan, 0 or 1 for mute, a plugin parameter's own range. Between points the value moves
   * in a straight line (mute steps); before the first and after the last it holds.
   */
  points: [number, number][];
  /** "read" plays it; "off" keeps it but leaves the setting where it is. */
  mode: 'read' | 'off';
  /** "smooth" eases between points (a cosine: slow out of one, slow into the next) instead of a straight line. */
  curve?: 'linear' | 'smooth';
}

export interface Send {
  bus: string;
  /** In dB. */
  level: number;
  /** Before the fader. */
  pre: boolean;
}

export interface Plugin {
  id: string;
  /** A type from the plugin registry, e.g. "eq", "compressor", "arpeggiator". */
  type: string;
  bypass: boolean;
  params: Record<string, number>;
  /** Settings that aren't numbers (a Space Designer's impulse response file: "pack/name"). */
  settings?: Record<string, string>;
}

export interface Bus {
  id: string;
  name: string;
  color: string;
  channel: Channel;
}
