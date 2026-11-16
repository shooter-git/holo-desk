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
  /**
   * Key signatures through the song, sorted by tick. The first, at tick 0, is the song's `key` (the
   * two are kept the same); no points means no key signature.
   */
  keys?: KeyPoint[];
  /** Repeats and jumps, as written: the timeline holds the music once, playback follows these. */
  form?: FormMark[];
  /** How the song is written out as a score: credits, layout, and how the parts are grouped. */
  score?: ScoreSettings;
}

/** A key signature from a tick on: sharps (+) or flats (−), and the mode its tonic names. */
export interface KeyPoint {
  tick: number;
  /** −7 (seven flats) … 7 (seven sharps). */
  fifths: number;
  mode: KeyMode;
}

export type KeyMode = 'major' | 'minor' | 'dorian' | 'phrygian' | 'lydian' | 'mixolydian' | 'locrian';

/**
 * A repeat sign, ending or jump, at a tick (usually a bar line; one inside a bar splits it into two
 * partial bars on the score, as a repeat after a pickup does).
 */
export interface FormMark {
  tick: number;
  /**
   * `start` and `end`: a repeated passage. `ending`: a first or second ending (a volta) from here to
   * `e`. `segno`, `coda`: places a jump goes to. `toCoda`: after a jump, go on at the coda.
   * `fine`: after a jump, stop here. `dc`, `ds`: jump to the start (da capo) or the segno (dal segno).
   */
  k: 'start' | 'end' | 'ending' | 'segno' | 'coda' | 'toCoda' | 'fine' | 'dc' | 'ds';
  /** `end`: how many times the passage plays in all (2 when unset). */
  times?: number;
  /** `ending`: where it ends, and the passes that take it ([1], [2], [1, 2]…). */
  e?: number;
  passes?: number[];
  /** `dc`, `ds`: al Fine or al Coda (unset plays on to the end after the jump). */
  al?: 'fine' | 'coda';
  /** `dc`, `ds`: play the repeats again after the jump (most scores don't). */
  repeats?: boolean;
}

/** The score's credits and layout. */
export interface ScoreSettings {
  subtitle?: string;
  composer?: string;
  lyricist?: string;
  arranger?: string;
  copyright?: string;
  /** Parts joined on the left: [first track id, last track id, how]. */
  groups?: [string, string, 'bracket' | 'brace' | 'line'][];
  /** Where a new system or page starts (ticks), when not left to the layout. */
  breaks?: [number, 'system' | 'page'][];
  /** Paper and size: `staff` is the staff height in millimeters (7 is usual). */
  page?: { size?: 'letter' | 'a4' | 'a3' | 'tabloid'; landscape?: boolean; staff?: number };
  /** Show transposing instruments at sounding pitch (a concert score). */
  concert?: boolean;
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
  /** What the score says here: "Allegro", "rit.", "a tempo". */
  text?: string;
  /** Show the metronome mark (♩ = 120) on the score. */
  mm?: boolean;
  /** A gradual change (rit., accel.) from here until this tick, arriving at `to` bpm. */
  ramp?: number;
  to?: number;
  /** Made by the score from a ramp or a fermata, and made again when that changes; never drawn. */
  gen?: boolean;
}

export interface MeterPoint {
  tick: number;
  num: number;
  den: number;
  /** How the bar groups, in eighth notes: [3, 3, 2] is a 4/4 felt as 3+3+2. */
  groups?: number[];
  /**
   * On the first point only: the song starts with a pickup (an upbeat). The first bar is a full bar
   * on the timeline, but only its last `pickup` ticks are written on the score, and it is bar 0.
   */
  pickup?: number;
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
  /** `params`: its own knobs (samplerKnobs: each microphone's level, tune, decay), where they're moved. */
  | { type: 'sampler'; pack: string; name: string; params?: Record<string, number> }
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
  /** How the track is written on the score. */
  score?: TrackScore;
}

/** A track as a part on the score. Everything is optional: the score works out what isn't set. */
export interface TrackScore {
  /** Name on the score, when not the track's own; and the short name on later systems ("Vln. I"). */
  name?: string;
  abbr?: string;
  /** How many staves: 1, 2 (a grand staff) or 3. */
  staves?: number;
  /** On a grand staff: the lowest pitch drawn on the upper staff when the score places notes itself. */
  split?: number;
  /**
   * Clefs: [tick, staff (1…), clef], the first of each staff at tick 0. Clefs: "G", "F", "C3"
   * (alto), "C4" (tenor), "G8vb" (tenor voice, guitar), "G8va", "F8vb", "perc", "tab".
   */
  clefs?: [number, number, string][];
  /**
   * A transposing instrument: its part is written this many semitones and letter steps above how it
   * sounds (a B♭ clarinet [2, 1], a horn in F [7, 4], a guitar [12, 7]).
   */
  tr?: [number, number];
  /** A drum staff: pitch → [place on the staff (0 the middle line, 1 the space above…), notehead]. */
  drums?: Record<string, [number, string]>;
  /** Tablature: the open strings' pitches, highest string first; the capo's fret; tab alone. */
  tab?: { tuning: number[]; capo?: number; only?: boolean };
  /** The grid music played in is shown on, in ticks (unset: worked out bar by bar). */
  grid?: number;
  /** Left out of the full score (still printed as a part). */
  hidden?: boolean;
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
  /** Score markings over its notes (dynamics, hairpins, slurs, text…), sorted by tick. */
  marks?: Mark[];
}

/** A marking on the score that isn't one note's: ticks from the region's start, like its notes. */
export interface Mark {
  t: number;
  k: MarkKind;
  /** Where a line ends (hairpins, slurs, octave lines, glissandos), ticks from the region's start. */
  e?: number;
  /** The staff (1…) and voice (1–4) it belongs to. */
  st?: number;
  vo?: number;
  /** The dynamic ("mf", "sfz"), the words ("pizz.", "dolce"), the octave shift (8, 15, −8). */
  v?: string | number;
}

/**
 * `dyn` a dynamic; `cresc` and `dim` hairpins; `slur`; `text` technique words above the staff
 * ("pizz.", "con sord."); `expr` expression words below it ("dolce"); `oct` an 8va or 8vb line;
 * `breath`, `caesura`; `gliss` a glissando from the note here to the note at `e`.
 */
export type MarkKind = 'dyn' | 'cresc' | 'dim' | 'slur' | 'text' | 'expr' | 'oct' | 'breath' | 'caesura' | 'gliss';

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
  /** The recording's notes as this region plays them, and how each is edited (audio-notes.ts). */
  notes?: AudioNotes;
}

/** How a recording's notes were found: one line at a time, the notes of chords, or hits. */
export type AudioNotesMode = 'mono' | 'poly' | 'perc';

/**
 * A recording's notes as a region plays them: what was found in it (times in seconds of the file,
 * before the region's stretch) and how each is edited. They're kept in the song, so it plays the same
 * wherever it's rendered, from the song and the file alone.
 */
export interface AudioNotes {
  mode: AudioNotesMode;
  /** The version of the detection that found them (they're never found again unasked). */
  v: number;
  /** The notes, by start (then pitch). */
  n: AudioNote[];
  /** Edits kept, but not played (to hear the recording as it was). */
  off?: true;
  /** The pitch A4 is tuned to, Hz (440 when absent). */
  a4?: number;
  /** How readily the notes of chords were found (0–1). */
  sens?: number;
}

/** A note found in a recording, and how it's edited (each edit absent while it's untouched). */
export interface AudioNote {
  /** Start and length, seconds of the file. */
  t: number;
  d: number;
  /** Its pitch as found: MIDI with cents (64.18 is E4, 18 cents sharp); null for none (a breath, a lone consonant, a hit). */
  p: number | null;
  /** How long its unvoiced start lasts (a consonant: s, t, k), seconds: it keeps its length when the note is stretched, and the note's beat is after it. */
  u?: number;
  /** Its pitch moved to (MIDI with cents). */
  to?: number;
  /** How much of its drift is kept (0–1), and of its vibrato (0–2). */
  dr?: number;
  mo?: number;
  /** How long the glide into it from the note before takes, against as it was sung (0–3). */
  tr?: number;
  /** Its formant moved, semitones (−12 to 12), its pitch where it is. */
  fo?: number;
  /** Its level changed, dB (−60 to 24); or muted. */
  g?: number;
  m?: true;
  /** Where it starts and ends now (seconds of the file, before the region's stretch). */
  ts?: number;
  te?: number;
  /** Its attack's length against as it was sung (0.25–4: 0.5 plays it in half the time). */
  at?: number;
  /** Pasted: it plays what's found from `s` to `s + d` in the file. */
  s?: number;
  /** A chord's note left out by hand: its sound stays as it is, part of the rest. */
  off?: true;
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
  /** How it's written on the score. */
  n?: NoteNotation;
}

/**
 * How a note is written: hints the score keeps. The note's own time, length, pitch and velocity are
 * what plays (and what the piano roll shows); a hint that depends on one of them carries the value it
 * was made for, and once the note changes (dragged in the piano roll, say) the score works that hint
 * out afresh instead.
 */
export interface NoteNotation {
  /** Spelling: [letter 0–6 (C D E F G A B), accidental in semitones (−2…2), the pitch it spells]. */
  sp?: [number, number, number];
  /** [written length, the length it sounds]: e.g. a staccato quarter [960, 480]. */
  w?: [number, number];
  /** Voice 1–4 on its staff, and the staff (1…) it's on. */
  vo?: number;
  st?: number;
  /**
   * Articulations and ornaments: "stacc", "staccis", "ten", "acc", "marc", "ferm", "tr", "mord",
   * "pmord", "turn", "trem1"…"trem4", "arp", "up", "down" (bowings), "open", "stop", "harm", "snap".
   */
  a?: string[];
  /** A grace note before the beat: "a" acciaccatura (slashed), "p" appoggiatura. */
  g?: 'a' | 'p';
  /** The velocity the dynamics last gave it; they set it again only while it's still this. */
  dv?: number;
  /** Lyric syllables, one per verse; "-" at the end joins to the next syllable, "_" holds the word. */
  ly?: string[];
  /** Tablature: [string (1 is the highest), the pitch it was placed for]. */
  tb?: [number, number];
  /** A tuplet the timing alone doesn't say: [notes, in the time of] (5:4, 7:8…). */
  tu?: [number, number];
  /** Notehead: "x", "diamond", "slash", "triangle", "circle-x", "square". */
  hd?: string;
  stem?: 'up' | 'down';
  /** Fingering. */
  fi?: string;
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
