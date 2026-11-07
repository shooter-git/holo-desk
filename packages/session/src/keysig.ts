/**
 * Key signatures. The song's `key` is text people and the AI read ("D minor", "A lydian"); the score
 * needs sharps or flats and a mode, and key changes through the song (`keys`). The two are kept the
 * same: the first key point is the `key`.
 */
import type { KeyMode, KeyPoint, Project } from './types.ts';

/** Where each mode's tonic sits on the line of fifths, from the major key with the same signature. */
const MODE_OFFSET: Record<KeyMode, number> = {
  lydian: -1,
  major: 0,
  mixolydian: 1,
  dorian: 2,
  minor: 3,
  phrygian: 4,
  locrian: 5,
};

export const KEY_MODES = Object.keys(MODE_OFFSET) as KeyMode[];

const FIFTHS_LETTERS = 'FCGDAEB';

/** A note name's place on the line of fifths (C 0, G 1, F −1, B♭ −2, F♯ 6). */
export function fifthsOf(letter: string, alter: number): number {
  return FIFTHS_LETTERS.indexOf(letter.toUpperCase()) - 1 + 7 * alter;
}

/** The note name at a place on the line of fifths: 0 "C", −2 "Bb", 6 "F#", 13 "F##". */
export function nameOnFifths(index: number): string {
  const letter = FIFTHS_LETTERS[(((index + 1) % 7) + 7) % 7] as string;
  const alter = Math.floor((index + 1) / 7);
  return letter + (alter > 0 ? '#'.repeat(alter) : 'b'.repeat(-alter));
}

/** The tonic of a key, as a note name ("D", "Bb"). */
export function keyTonic(k: Pick<KeyPoint, 'fifths' | 'mode'>): string {
  return nameOnFifths(k.fifths + MODE_OFFSET[k.mode]);
}

/** A key as text: "D minor", "Bb major", "A lydian". */
export function keyText(k: Pick<KeyPoint, 'fifths' | 'mode'>): string {
  return `${keyTonic(k)} ${k.mode}`;
}

function modeOf(words: string): KeyMode {
  const w = words.toLowerCase();
  for (const mode of ['dorian', 'phrygian', 'lydian', 'mixolydian', 'locrian'] as const)
    if (w.includes(mode)) return mode;
  if (/\b(minor|min|aeolian)\b|^m\b|^m$/.test(w)) return 'minor';
  return 'major';
}

/**
 * The key a text names, or null: "D minor", "Bb", "F# major", "Am", "A lydian", "E harmonic minor"
 * (as E minor). A key past seven sharps or flats comes back as its enharmonic twin (G# major as A♭).
 */
export function parseKey(text: string | null | undefined): Pick<KeyPoint, 'fifths' | 'mode'> | null {
  if (!text) return null;
  const m = /^\s*([A-Ga-g])([#b♯♭]*)(.*)$/.exec(text);
  if (!m) return null;
  const [, letter = 'C', accidentals = '', rest = ''] = m;
  // "b" alone after the letter is a flat; a word starting with b ("B blues") isn't
  let alter = 0;
  for (const a of accidentals) alter += a === '#' || a === '♯' ? 1 : -1;
  const mode = modeOf(rest.trim());
  let fifths = fifthsOf(letter, alter) - MODE_OFFSET[mode];
  while (fifths > 7) fifths -= 12;
  while (fifths < -7) fifths += 12;
  return { fifths, mode };
}

/** The song's key signatures: its `keys`, or the one its `key` text names, or none. */
export function keysOf(project: Pick<Project, 'key' | 'keys'>): KeyPoint[] {
  if (project.keys) return project.keys;
  const k = parseKey(project.key);
  return k ? [{ tick: 0, ...k }] : [];
}

/** The key signature at a tick (null where there is none). */
export function keyAt(keys: readonly KeyPoint[], tick: number): KeyPoint | null {
  let found: KeyPoint | null = null;
  for (const k of keys) {
    if (k.tick > tick) break;
    found = k;
  }
  return found;
}

/**
 * The `keys` that go with a new `key` text: its first point replaced by what the text names, the
 * key changes after it kept. A text that names no key leaves no signature at the start.
 */
export function keysForText(key: string | null, keys: readonly KeyPoint[] | undefined): KeyPoint[] {
  const later = (keys ?? []).filter((k) => k.tick > 0);
  const k = parseKey(key);
  return k ? [{ tick: 0, ...k }, ...later] : later;
}

/**
 * The `key` text that goes with `keys`: the old text when it still names the first key (so "E
 * harmonic minor" stays as written), else the first key's own name; null with no key at the start.
 */
export function textForKeys(keys: readonly KeyPoint[], old: string | null): string | null {
  const first = keys[0];
  if (!first || first.tick > 0) return null;
  const was = parseKey(old);
  return was && was.fifths === first.fifths && was.mode === first.mode ? old : keyText(first);
}
