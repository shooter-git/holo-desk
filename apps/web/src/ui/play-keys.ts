/**
 * The on-screen keyboard's sums, apart from the screen: the white keys a row shows, the note under a
 * finger and how hard it plays. Every row of keys asks the same (a phone held upright can show two),
 * each with its own size.
 */

/** Semitones from C of the black keys. */
export const BLACK = [1, 3, 6, 8, 10];
/** Semitones from C of the white keys in an octave. */
const WHITES = [0, 2, 4, 5, 7, 9, 11];

/** The highest octave whose keyboard of `whiteCount` keys stays within MIDI (G9 is note 127). */
export function topOctave(whiteCount: number): number {
  const last = whiteCount - 1;
  const span = 12 * Math.floor(last / 7) + (WHITES[last % 7] ?? 0);
  return Math.min(7, Math.floor((127 - span) / 12) - 1);
}

/** The white keys of a keyboard `count` keys wide, from the C of `octave` (octave 4 starts on note 60). */
export function whiteKeys(octave: number, count: number): number[] {
  const whites: number[] = [];
  for (let n = (octave + 1) * 12; whites.length < count; n++) if (!BLACK.includes(n % 12)) whites.push(n);
  return whites;
}

/** The note under a finger at (x, y) on keys `w` × `h` (CSS px from their top left); null off the keys. */
export function noteAt(whites: number[], x: number, y: number, w: number, h: number): number | null {
  const keyW = w / whites.length;
  const wi = Math.floor(x / keyW);
  const white = whites[wi];
  if (white === undefined) return null;
  if (y < h * 0.6) {
    // a black key's zone takes the edges between white keys
    const local = x - wi * keyW;
    const left = white - 1;
    const right = white + 1;
    if (local < keyW * 0.3 && BLACK.includes(((left % 12) + 12) % 12)) return left;
    if (local > keyW * 0.7 && BLACK.includes(right % 12)) return right;
  }
  return white;
}

/** How hard a finger `y` px down keys `h` tall plays: harder the higher up it touches. */
export function velocityAt(y: number, h: number): number {
  return Math.round(40 + 87 * Math.min(1, Math.max(0, 1 - y / h)) ** 0.8);
}

/** The upper row's octave: the one chosen for it, else an octave above the lower row's (never past the top). */
export function upperOctave(chosen: number | null, lower: number, top: number): number {
  return Math.min(chosen ?? lower + 1, top);
}
