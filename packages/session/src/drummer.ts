/**
 * Session Drummer's grooves: one bar of 4/4 for each part, a character a step. MIDI effects only
 * take numbers, so a session stores a style as its index here, and the engine reads the bars.
 *
 * Each step is:
 * - `X` an accent, `x` a full hit, `o` a lighter one, `g` a ghost note;
 * - `O` on the cymbal part: the hi-hat opened (or the cymbal struck harder, on a ride);
 * - a digit 1–9: a hit that only plays from that much Complexity up (5 is 50%);
 * - `.` nothing.
 *
 * Sixteenths (grid 4) or triplet eighths (grid 3, for brushes and shuffles); a bar of another
 * meter plays as many beats of it as it has.
 */

export interface Groove {
  name: string;
  /** Steps in a quarter note: 4 (sixteenths) or 3 (triplet eighths). */
  grid: 3 | 4;
  /** Kick & Snare's variations: the kick's and the snare's bars (taken in turn, each list's own length). */
  kick: string[];
  snare: string[];
  /** The cymbal hand (hi-hat or ride), the hi-hat foot, and the percussion player's part. */
  cymbal: string;
  foot?: string;
  perc: string;
  /** What Cymbals' Auto plays: the ride (jazz), else the hi-hat. */
  ride?: boolean;
  /** The snare part's key: the snare, or a clap (house). */
  snareKey?: number;
  /** Below this Complexity (%) the snare part is played on the side stick (a ballad's verse). */
  cross?: number;
  /** How hard this style plays, before Loudness. */
  level: number;
  /** Fills: around the toms, on the snare, or soft triplets with brushes. */
  fill: 'toms' | 'snare' | 'brush';
}

/** Kick & Snare's variations: each style's bars are taken in turn up to this many. */
export const GROOVE_VARIATIONS = 4;
/** What the cymbal hand plays: the style's own, or one chosen. */
export const DRUMMER_CYMBALS = ['Auto', 'Hi-hat', 'Open Hi-hat', 'Ride', 'Ride Bell'];
/** A percussion player alongside, and what they play. */
export const DRUMMER_PERCUSSION = ['None', 'Tambourine', 'Shaker', 'Cowbell', 'Clap'];

export const GROOVES: Groove[] = [
  {
    name: 'Rock',
    grid: 4,
    kick: ['X.......X.x.....', 'X.....x.X.......', 'X.x.....X.x.....', 'X......xX.x.....'],
    snare: ['....X..7....X...', '....X.......X.6.'],
    cymbal: 'x.o.x.o.x.o.x.o9',
    perc: '....x.......x...',
    level: 1,
    fill: 'toms',
  },
  {
    name: 'Pop',
    grid: 4,
    kick: ['X.......X.......', 'X......xX.......', 'X..x..x.X.......', 'X.....x...x.....'],
    snare: ['....X.......X...', '....X.......X..6'],
    cymbal: 'x6o6x6o6x6o6x6o6',
    perc: 'oxgxoxgxoxgxoxgx',
    level: 0.95,
    fill: 'toms',
  },
  {
    name: 'Funk',
    grid: 4,
    kick: ['X.x....x..x..x..', 'X..x..x...x..x..', 'X.x...x.x..x....', 'X..x.x....x...x.'],
    snare: ['.4..X..g.g4.X..g', '.g..X.5g.g..X.g5'],
    cymbal: 'xoxoxoxoxoxoxoOo',
    perc: 'x..x..x...x.x...',
    level: 1,
    fill: 'snare',
  },
  {
    name: 'Soul',
    grid: 4,
    kick: ['X.....x.X.......', 'X..x....X.x.....', 'X.......X..x..x.', 'X.x.....X.....x.'],
    snare: ['....X.......X...', 'g...X..5g...X...'],
    cymbal: 'x.o.x.o.x.o7x.o.',
    perc: 'o...X...o...X...',
    level: 0.95,
    fill: 'toms',
  },
  {
    name: 'Hip-hop',
    grid: 4,
    kick: ['X.....x...x.....', 'X..x......x..x..', 'X.x.......x....x', 'X......x.xx.....'],
    snare: ['....X.......X...', '....X..4....X.6.'],
    cymbal: 'x.o.x.o7x.o.x.o.',
    perc: '..x...x...x...x.',
    level: 0.95,
    fill: 'snare',
  },
  {
    name: 'House',
    grid: 4,
    kick: ['X...X...X...X...', 'X...X...X...X..x', 'X...X...X..xX...', 'X...X..xX...X...'],
    snare: ['....X.......X...', '....X.......X..o'],
    cymbal: 'g.O5g.O5g.O5g.O5',
    perc: 'gogxgogxgogxgogx',
    snareKey: 39,
    level: 1,
    fill: 'snare',
  },
  {
    name: 'Jazz Brushes',
    grid: 3,
    kick: ['g..g..g..g..', 'g..g..g..g.5', 'g..g.4g..g..', 'g.....g..g.4'],
    snare: ['g.4o.5g.4o.5', 'g..o.4g.5o..'],
    cymbal: 'x..X.ox..X.o',
    foot: '...x.....x..',
    perc: '............',
    ride: true,
    level: 0.7,
    fill: 'brush',
  },
  {
    name: 'Half-time',
    grid: 4,
    kick: ['X.........x.....', 'X.....x.......x.', 'X..x......x.....', 'X.x.......x..x..'],
    snare: ['........X.......', '...4....X..5..6.'],
    cymbal: 'x.o5x.o.x.o5x.o.',
    perc: '........x.......',
    level: 1,
    fill: 'toms',
  },
  {
    name: 'Ballad',
    grid: 4,
    kick: ['X.......X.......', 'X.....x.X.......', 'X.......X.x.....', 'X......xX.......'],
    snare: ['....X.......X...', '....X.......X..6'],
    cymbal: 'o.g.o.g.o.g.o.g.',
    perc: 'g.o.g.o.g.o.g.o.',
    cross: 50,
    level: 0.8,
    fill: 'toms',
  },
  {
    name: 'Shuffle',
    grid: 3,
    kick: ['X.....X.....', 'X....oX.....', 'X.....X....o', 'X..x..X..x..'],
    snare: ['...X.....X..', '.4.X.4.4.X.4'],
    cymbal: 'x.ox.ox.ox.o',
    perc: '...x.....x..',
    level: 1,
    fill: 'snare',
  },
];
