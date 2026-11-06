/**
 * A song laid out as a score: bars, parts, staves, voices, and what's written in them. Made by
 * `notate`, read by the MEI writer (for drawing) and the text writer (for the AI). Times are ticks
 * on the song's timeline, so anything drawn maps back to where it plays.
 */
import type { ChordMark, KeyPoint, Note, ScoreSettings, TempoPoint } from '@holo/session';
import type { Ratio } from './rhythm.ts';

export interface ScoreDoc {
  title: string;
  credits: ScoreSettings;
  bars: Bar[];
  parts: Part[];
  /** Every drawn notehead's id → the note it is (a tied note's pieces share one note). */
  refs: Map<string, NoteRef>;
  /** Things the layout couldn't write as they are (a note before a pickup, say). */
  warnings: string[];
}

export interface NoteRef {
  track: string;
  region: string;
  note: Note;
  /** 0 for the note's first written piece, 1… for the pieces tied on from it. */
  piece: number;
}

export interface Bar {
  index: number;
  /** The number shown: 0 for a pickup; a bar split by a repeat keeps one number for both halves. */
  number: number;
  /** Where it starts on the timeline, and how long it is written. */
  start: number;
  length: number;
  /** Where its start falls in its timeline bar (a pickup's or a split bar's second half's offset). */
  offset: number;
  meter: { num: number; den: number; groups?: number[] };
  /** Show the time signature (it changes here, or it's the first bar). */
  showMeter: boolean;
  key: KeyPoint | null;
  showKey: boolean;
  left: 'single' | 'start';
  right: 'single' | 'end' | 'double' | 'final' | 'start-end';
  /** A repeat played more than twice says so. */
  times?: number;
  /** A first or second ending begins here and runs `bars` bars. */
  ending?: { label: string; passes: number[]; bars: number };
  /** Segno, coda signs, Fine, To Coda, D.C./D.S. words written at this bar. */
  jumps: { k: 'segno' | 'coda' | 'toCoda' | 'fine' | 'dc' | 'ds'; text: string; at: number }[];
  tempos: TempoPoint[];
  chords: ChordMark[];
  break?: 'system' | 'page';
  /** Markings over the bar's notes, for every staff. */
  controls: Control[];
}

export interface Part {
  track: string;
  name: string;
  abbr?: string;
  staves: Staff[];
  /** Written above sounding by [semitones, letter steps]; null at sounding pitch. */
  tr: [number, number] | null;
  drums: boolean;
  /** Comfortable range (sounding), for the checks. */
  range?: [number, number];
  /**
   * Tablature under the part's staff: the same notes as strings and frets (drawn only; the notes
   * are the staff's). A part written only as tab has its staff as tab instead.
   */
  tab?: Staff;
}

export interface Staff {
  /** Its number in the whole score, from 1. */
  n: number;
  /** Its number in its part, from 1. */
  local: number;
  /** Clef changes: [tick, clef]; the first at the start. */
  clefs: [number, string][];
  /** One per bar, in step with the score's bars. */
  bars: StaffBar[];
  /** A tab staff: its open strings (sounding, the highest first) and capo. */
  tab?: { tuning: number[]; capo: number };
}

export interface StaffBar {
  /** Voice 1 always (a whole-bar rest when empty); more only where they have notes. */
  voices: Voice[];
}

export interface Voice {
  n: number;
  events: ScoreEvent[];
}

interface EventBase {
  id: string;
  /** Where it starts on the timeline, and how long it lasts there (sounding time, after tuplets). */
  tick: number;
  dur: number;
  /** The written value. */
  value: number;
  dots: number;
  tuplet?: TupletGroup;
  /** Beam group id within the voice's bar; events sharing one are beamed together. */
  beam?: number;
}

export interface ChordEvent extends EventBase {
  kind: 'chord';
  heads: Head[];
  grace?: 'a' | 'p';
  /** Articulations and ornaments of its notes, merged. */
  artic: string[];
  /** Lyric syllables by verse (from its top note). */
  lyrics?: string[];
  stem?: 'up' | 'down';
  fingering?: string;
}

export interface RestEvent extends EventBase {
  kind: 'rest';
  /** A whole-bar rest (drawn centred, whatever the meter). */
  full?: boolean;
}

export type ScoreEvent = ChordEvent | RestEvent;

export interface Head {
  id: string;
  /** Sounding pitch. */
  pitch: number;
  /** As written (transposed, under any octave line or octave clef): letter 0–6, accidental, octave. */
  step: number;
  alter: number;
  octave: number;
  /** The accidental to show (−2…2), when one is shown. */
  accid?: number;
  /** Tie: "i" starts one, "m" continues it, "t" ends it. */
  tie?: 'i' | 'm' | 't';
  /** A drum: its notehead. */
  head?: string;
  /** Tablature: string (1 the highest) and fret. */
  tab?: [number, number];
  ref: NoteRef;
}

export interface TupletGroup {
  id: number;
  ratio: Ratio;
  /** Timeline ticks it spans. */
  start: number;
  end: number;
}

export type Control =
  | { kind: 'dyn'; staff: number; tick: number; value: string }
  | { kind: 'hairpin'; staff: number; tick: number; end: number; form: 'cres' | 'dim' }
  | { kind: 'slur'; staff: number; start: string; end: string }
  | { kind: 'words'; staff: number; tick: number; text: string; place: 'above' | 'below' }
  | { kind: 'octave'; staff: number; start: string; end: string; dis: 8 | 15; place: 'above' | 'below' }
  | { kind: 'breath' | 'caesura'; staff: number; tick: number }
  | { kind: 'gliss'; staff: number; start: string; end: string }
  | { kind: 'fermata' | 'trill' | 'turn'; staff: number; start: string }
  | { kind: 'mordent'; staff: number; start: string; form: 'lower' | 'upper' }
  | { kind: 'arpeg'; staff: number; start: string }
  | { kind: 'pedal'; staff: number; tick: number; dir: 'down' | 'up' };
