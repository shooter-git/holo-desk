/**
 * Note names and a small text notation for writing notes quickly (the AI uses it, and so can you):
 *
 *     "D5:1 | B5:2 A5:1 F#5:1 A5:2 | r:3 (D4 F#4 A4):3"
 *
 *  - NOTE:DUR is a note, r:DUR a rest, (A B C):DUR a chord; "|" is only for reading
 *  - a suffix ! accents the note, ? makes it a ghost (soft), ~ ties it into the next same pitch
 *  - durations count a unit you choose (an eighth, a sixteenth…) and may be 1/2 or 1.5
 *  - a velocity can be given per note: E4:2@96
 *
 * Note names are scientific pitch (middle C, MIDI 60, is C4) unless you ask for Logic's naming,
 * where middle C is C3.
 */
import type { Note } from './types.ts';

const SHARPS = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
const LETTER: Record<string, number> = { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 };

export type MiddleC = 'C4' | 'C3';

const octaveShift = (middleC: MiddleC) => (middleC === 'C3' ? 2 : 1);

export function noteName(pitch: number, middleC: MiddleC = 'C4'): string {
  const p = Math.round(pitch);
  const cents = Math.round((pitch - p) * 100);
  const name = `${SHARPS[((p % 12) + 12) % 12]}${Math.floor(p / 12) - octaveShift(middleC)}`;
  return cents ? `${name}${cents > 0 ? '+' : ''}${cents}c` : name;
}

/** "C#4", "Db4", "Bb-1", "E4+25c"; or a plain MIDI number "61". */
export function parseNoteName(text: string, middleC: MiddleC = 'C4'): number {
  if (/^\d+(\.\d+)?$/.test(text)) return Number(text);
  const m = /^([A-Ga-g])([#b♯♭]*)(-?\d+)(?:([+-]\d+)c)?$/.exec(text.trim());
  if (!m) throw new Error(`Not a note name: "${text}"`);
  const [, letter = 'C', accidentals = '', octave = '4', cents] = m;
  let pc = LETTER[letter.toUpperCase()] ?? 0;
  for (const a of accidentals) pc += a === '#' || a === '♯' ? 1 : -1;
  return (Number(octave) + octaveShift(middleC)) * 12 + pc + (cents ? Number(cents) / 100 : 0);
}

function parseDuration(s: string): number {
  if (s.includes('/')) {
    const [a = '0', b = '1'] = s.split('/');
    return Number(a) / Number(b);
  }
  return Number(s);
}

export interface ParseOptions {
  /** Ticks per notation unit (e.g. 480 for eighths at 960 PPQ). */
  unit: number;
  /** Tick of the first note. */
  start?: number;
  /** Velocity of an unmarked note. */
  velocity?: number;
  middleC?: MiddleC;
  /** Fraction of each duration a note sounds (1 = legato). */
  gate?: number;
}

export function parseNotation(text: string, options: ParseOptions): Note[] {
  const { unit, start = 0, velocity = 90, middleC = 'C4', gate = 1 } = options;
  const notes: Note[] = [];
  const open = new Map<number, Note>();
  let t = start;
  const tokens = text.match(/\([^)]*\)\S*|\S+/g) ?? [];
  for (const raw of tokens) {
    if (raw === '|') continue;
    let token = raw;
    let accent = 0;
    let tie = false;
    let vel = velocity;
    const velMatch = /@(\d+)$/.exec(token);
    if (velMatch) {
      vel = Number(velMatch[1]);
      token = token.slice(0, velMatch.index);
    }
    while (/[!?~]$/.test(token)) {
      const c = token[token.length - 1];
      if (c === '!') accent += 20;
      else if (c === '?') accent -= 35;
      else tie = true;
      token = token.slice(0, -1);
    }
    const colon = token.lastIndexOf(':');
    if (colon < 0) throw new Error(`"${raw}" needs a duration, like ${raw}:1`);
    const head = token.slice(0, colon);
    const d = parseDuration(token.slice(colon + 1)) * unit;
    if (!Number.isFinite(d) || d <= 0) throw new Error(`Bad duration in "${raw}"`);
    if (head !== 'r') {
      const pitches = head.startsWith('(') ? head.slice(1, -1).trim().split(/\s+/) : [head];
      for (const name of pitches) {
        const p = parseNoteName(name, middleC);
        const v = Math.max(1, Math.min(127, vel + accent));
        const held = open.get(p);
        if (held && held.t + held.d === t) {
          held.d += d;
          if (!tie) open.delete(p);
          continue;
        }
        const note: Note = { t, d, p, v };
        notes.push(note);
        if (tie) open.set(p, note);
      }
    }
    t += d;
  }
  if (gate < 1) for (const n of notes) n.d = Math.max(1, Math.round(n.d * gate));
  return notes;
}

/** Notes back to the notation (chords grouped, rests filled), in a unit of `unit` ticks. */
export function formatNotation(notes: readonly Note[], unit: number, start = 0, middleC: MiddleC = 'C4'): string {
  const sorted = notes.slice().sort((a, b) => a.t - b.t || a.p - b.p);
  const out: string[] = [];
  let t = start;
  const fmt = (ticks: number) => {
    const n = ticks / unit;
    return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
  };
  for (let i = 0; i < sorted.length; ) {
    const first = sorted[i] as Note;
    const group: Note[] = [];
    while (i < sorted.length && (sorted[i] as Note).t === first.t) group.push(sorted[i++] as Note);
    if (first.t > t) out.push(`r:${fmt(first.t - t)}`);
    const d = Math.min(...group.map((n) => n.d));
    const names = group.map((n) => noteName(n.p, middleC));
    out.push(group.length > 1 ? `(${names.join(' ')}):${fmt(d)}` : `${names[0]}:${fmt(d)}`);
    t = Math.max(t, first.t + d);
  }
  return out.join(' ');
}
