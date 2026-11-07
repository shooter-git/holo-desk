/**
 * Tablature: which string and fret each note is played on. A note's own choice (`n.tb`, kept while
 * its pitch is the one it was made for) wins; the rest are worked out chord by chord so the hand
 * moves as little as it can: a dynamic-programming pass over the chords in order, each way of playing
 * a chord scored by how far the hand moves to it, how wide it stretches, and how far up the neck.
 */
import type { Track, TrackScore } from '@holo/session';

/** Open strings (sounding pitches), the highest string first. */
export const TUNINGS: Record<string, number[]> = {
  guitar: [64, 59, 55, 50, 45, 40],
  'drop d': [64, 59, 55, 50, 45, 38],
  dadgad: [62, 57, 55, 50, 45, 38],
  'open g': [62, 59, 55, 50, 43, 38],
  bass: [43, 38, 33, 28],
  'bass 5': [43, 38, 33, 28, 23],
  ukulele: [69, 64, 60, 67],
  mandolin: [76, 69, 62, 55],
  banjo: [62, 59, 55, 50, 67],
};

/** The tuning a part named so most likely has. */
export function tuningFor(name: string): number[] {
  if (/\bbass\b/i.test(name)) return TUNINGS.bass as number[];
  if (/ukulele|\buke\b/i.test(name)) return TUNINGS.ukulele as number[];
  if (/mandolin/i.test(name)) return TUNINGS.mandolin as number[];
  if (/banjo/i.test(name)) return TUNINGS.banjo as number[];
  return TUNINGS.guitar as number[];
}

/** A note's place: its string (1 the highest) and fret (from the capo, when there is one). */
export type Fingering = [number, number];

const FRETS = 24;
const KEEP = 48;

interface Way {
  /** The fingering of each of the chord's pitches (null: it can't be played). */
  places: (Fingering | null)[];
  /** Where the hand is (the fretted notes' middle; open strings leave it where it was). */
  at: number | null;
  cost: number;
}

/** Every way to play a chord's pitches on different strings, the likeliest first. */
function waysFor(pitches: readonly number[], tuning: readonly number[], capo: number, fixed: (number | null)[]): Way[] {
  const out: Way[] = [];
  const order = pitches.map((_, i) => i).sort((a, b) => (pitches[b] as number) - (pitches[a] as number));
  const places: (Fingering | null)[] = pitches.map(() => null);
  const used = new Set<number>();
  const visit = (k: number) => {
    if (out.length > 400) return;
    if (k === order.length) {
      const frets = places.filter((x): x is Fingering => x !== null && x[1] > 0).map((x) => x[1]);
      const missing = places.filter((x) => x === null).length;
      const span = frets.length ? Math.max(...frets) - Math.min(...frets) : 0;
      const at = frets.length ? (Math.max(...frets) + Math.min(...frets)) / 2 : null;
      const cost =
        missing * 100 + Math.max(0, span - 3) * 12 + span * 0.5 + (at ?? 0) * 0.15 + (frets.length ? 0 : -0.5);
      out.push({ places: places.slice(), at, cost });
      return;
    }
    const i = order[k] as number;
    const p = Math.round(pitches[i] as number);
    let any = false;
    tuning.forEach((open, s) => {
      const string = s + 1;
      const want = fixed[i];
      if (want != null && want !== string) return;
      if (used.has(string)) return;
      const fret = p - open - capo;
      if (fret < 0 || fret > FRETS) return;
      any = true;
      used.add(string);
      places[i] = [string, fret];
      visit(k + 1);
      used.delete(string);
      places[i] = null;
    });
    // a note no string can play (or no string left for): left out of the tab
    if (!any) visit(k + 1);
  };
  visit(0);
  return out.sort((a, b) => a.cost - b.cost).slice(0, KEEP);
}

/**
 * Strings and frets for chords in the order they're played (a chord: the pitches that start
 * together). `fixed[c][i]` is a string a pitch must be on (its own choice), or null.
 */
export function fretChords(
  chords: readonly (readonly number[])[],
  tuning: readonly number[],
  capo = 0,
  fixed: readonly (readonly (number | null)[])[] = [],
): (Fingering | null)[][] {
  if (!chords.length) return [];
  let ways = chords.map((c, i) => {
    const own = fixed[i] ?? c.map(() => null);
    const w = waysFor(c, tuning, capo, [...own]);
    // a choice that can't be kept (a string too low for the note now) gives way
    return w.length && w[0]?.places.every((x) => x !== null)
      ? w
      : waysFor(
          c,
          tuning,
          capo,
          c.map(() => null),
        );
  });
  ways = ways.map((w, i) => (w.length ? w : [{ places: (chords[i] ?? []).map(() => null), at: null, cost: 0 }]));
  // best[i][k]: the least cost to play chords 0…i ending with way k, and where the hand then is
  let best = (ways[0] as Way[]).map((w) => ({ cost: w.cost, at: w.at, from: -1 }));
  const back: { cost: number; at: number | null; from: number }[][] = [best];
  for (let i = 1; i < ways.length; i++) {
    const row = (ways[i] as Way[]).map((w) => {
      let pick = { cost: Number.POSITIVE_INFINITY, at: w.at, from: 0 };
      best.forEach((b, k) => {
        const hand = b.at;
        const move = w.at === null || hand === null ? 0 : Math.abs(w.at - hand);
        const cost = b.cost + w.cost + move;
        if (cost < pick.cost) pick = { cost, at: w.at ?? hand, from: k };
      });
      return pick;
    });
    back.push(row);
    best = row;
  }
  // the cheapest way through, read back from the end
  const out: (Fingering | null)[][] = new Array(ways.length);
  let k = best.reduce((m, b, j) => (b.cost < (best[m] as { cost: number }).cost ? j : m), 0);
  for (let i = ways.length - 1; i >= 0; i--) {
    out[i] = ((ways[i] as Way[])[k] as Way).places;
    k = (back[i] as { from: number }[])[k]?.from ?? 0;
  }
  return out;
}

/** Tab for a part: under its staff, on its own, or none; its tuning ("drop d", or pitches) and capo. */
export function withTab(
  track: Pick<Track, 'name' | 'score'>,
  mode: 'under' | 'only' | 'off',
  tuning?: string | number[],
  capo?: number,
): TrackScore {
  const score: TrackScore = { ...(track.score ?? {}) };
  if (mode === 'off') {
    delete score.tab;
    return score;
  }
  const named = typeof tuning === 'string' ? TUNINGS[tuning.toLowerCase().replace(/[-_]/g, ' ')] : tuning;
  if (typeof tuning === 'string' && !named)
    throw new Error(`No tuning "${tuning}": ${Object.keys(TUNINGS).join(', ')}`);
  const strings = named?.length ? named : score.tab?.tuning?.length ? score.tab.tuning : tuningFor(track.name);
  const tab: NonNullable<TrackScore['tab']> = { tuning: [...strings] };
  const c = capo ?? score.tab?.capo;
  if (c && c > 0) tab.capo = c;
  if (mode === 'only') tab.only = true;
  score.tab = tab;
  return score;
}
