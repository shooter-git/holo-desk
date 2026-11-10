/**
 * Spelling: which letter and accidental a pitch is written with (F♯ or G♭), and which accidentals a
 * bar shows. A note's own spelling hint wins while it still spells the note's pitch; otherwise the
 * key decides, leaning sharp going up and flat going down, and a chord avoids two of one letter.
 */
import { fifthsOf, type KeyMode } from '@holo/session';

const LETTER_PC = [0, 2, 4, 5, 7, 9, 11];
const LETTERS = 'CDEFGAB';

export interface Spelling {
  /** 0 C … 6 B. */
  step: number;
  /** Semitones: −2 double flat … 2 double sharp. */
  alter: number;
  /** Scientific octave (C4 is middle C). */
  octave: number;
}

export const letterOf = (step: number): string => LETTERS[step] as string;

/** The pitch a spelling sounds. */
export const pitchOf = (s: Spelling): number => (s.octave + 1) * 12 + (LETTER_PC[s.step] as number) + s.alter;

/** A pitch spelled with a given letter (the octave follows: B♯3 is MIDI 60). */
export function spellAs(pitch: number, step: number): Spelling {
  const pc = (((Math.round(pitch) - (LETTER_PC[step] as number)) % 12) + 12) % 12;
  const alter = pc > 6 ? pc - 12 : pc;
  const octave = Math.round((Math.round(pitch) - alter - (LETTER_PC[step] as number)) / 12) - 1;
  return { step, alter, octave };
}

/** Every way to spell a pitch with at most a double accidental. */
export function spellings(pitch: number): Spelling[] {
  const out: Spelling[] = [];
  for (let step = 0; step < 7; step++) {
    const s = spellAs(pitch, step);
    if (Math.abs(s.alter) <= 2) out.push(s);
  }
  return out;
}

/** Where a spelling sits on the line of fifths (C 0, G 1, F −1, F♯ 6, B♭ −2). */
export const fifthsPos = (s: Pick<Spelling, 'step' | 'alter'>): number => fifthsOf(LETTERS[s.step] as string, s.alter);

/**
 * The spelling the key suggests: the one nearest the middle of the key's scale on the line of
 * fifths. Minor keys lean sharp (their raised sixth and seventh); `direction` (+1 rising to the next
 * note, −1 falling) tips a chromatic note toward a sharp or a flat.
 */
export function spellInKey(pitch: number, fifths: number, mode: KeyMode, direction = 0): Spelling {
  const center = fifths + (mode === 'minor' || mode === 'dorian' ? 3 : 2);
  const options = spellings(pitch)
    .map((s) => ({ s, dist: Math.abs(fifthsPos(s) - center) }))
    .sort((a, b) => a.dist - b.dist || Math.abs(a.s.alter) - Math.abs(b.s.alter));
  const best = options[0];
  if (!best) return spellAs(pitch, 0);
  const next = options[1];
  // only between a sharp and a flat: a natural is never respelled as E♯ or C♭ for the line's sake
  if (next && direction !== 0 && next.dist <= best.dist + 2 && best.s.alter !== 0 && Math.abs(next.s.alter) === 1) {
    const sharper = fifthsPos(next.s) > fifthsPos(best.s);
    if ((direction > 0 && sharper) || (direction < 0 && !sharper)) return next.s;
  }
  return best.s;
}

/**
 * Spell a chord's pitches (lowest first) so no letter repeats where another spelling avoids it:
 * C and C♯ together become C and D♭.
 */
export function spellChord(spelled: Spelling[], fifths: number, mode: KeyMode, fixed: boolean[]): Spelling[] {
  const out = spelled.slice();
  const center = fifths + (mode === 'minor' ? 3 : 2);
  for (let i = 1; i < out.length; i++) {
    const a = out[i - 1] as Spelling;
    const b = out[i] as Spelling;
    if (a.step !== b.step || a.octave !== b.octave) continue;
    // move whichever isn't fixed and lies further from the key, to the neighboring letter
    const moveB = !fixed[i] && (fixed[i - 1] || Math.abs(fifthsPos(b) - center) >= Math.abs(fifthsPos(a) - center));
    const idx = moveB ? i : i - 1;
    if (fixed[idx]) continue;
    const s = out[idx] as Spelling;
    const pitch = pitchOf(s);
    const step = moveB ? (s.step + 1) % 7 : (s.step + 6) % 7;
    const other = spellAs(pitch, step);
    if (Math.abs(other.alter) <= 1) out[idx] = other;
  }
  return out;
}

/** The accidental each letter carries in a key signature. */
export function keyAlters(fifths: number): number[] {
  const alters = [0, 0, 0, 0, 0, 0, 0];
  const sharps = [3, 0, 4, 1, 5, 2, 6]; // F C G D A E B
  const flats = [6, 2, 5, 1, 4, 0, 3]; // B E A D G C F
  for (let i = 0; i < Math.min(7, Math.abs(fifths)); i++) {
    if (fifths > 0) alters[sharps[i] as number] = 1;
    else alters[flats[i] as number] = -1;
  }
  return alters;
}

/** Accidentals shown in a bar: what each letter in each octave currently is. */
export class BarAccidentals {
  private state = new Map<number, number>();
  private alters: number[];
  constructor(alters: number[]) {
    this.alters = alters;
  }
  /** The accidental to show for this spelling (null for none), and remember it for the bar. */
  show(s: Spelling, tiedIn = false): number | null {
    const key = s.octave * 7 + s.step;
    const current = this.state.get(key) ?? (this.alters[s.step] as number);
    if (tiedIn) return null;
    if (current === s.alter) return null;
    this.state.set(key, s.alter);
    return s.alter;
  }
}

/** Transpose a spelling by an interval: `chromatic` semitones and `diatonic` letter steps. */
export function transposeSpelling(s: Spelling, chromatic: number, diatonic: number): Spelling {
  const steps = s.step + diatonic;
  const step = ((steps % 7) + 7) % 7;
  const octave = s.octave + Math.floor(steps / 7);
  const natural = (octave + 1) * 12 + (LETTER_PC[step] as number);
  return { step, octave, alter: pitchOf(s) + chromatic - natural };
}

/** How many fifths a transposition moves a key (a major second up: +2). */
export const fifthsShift = (chromatic: number, diatonic: number): number => 7 * chromatic - 12 * diatonic;

/** A key's fifths kept within seven sharps or flats (its enharmonic twin otherwise). */
export function normalFifths(f: number): number {
  let x = f;
  while (x > 7) x -= 12;
  while (x < -7) x += 12;
  return x;
}
