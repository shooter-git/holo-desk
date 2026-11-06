/**
 * Voices: which notes on a staff are written together as chords and which as a second line. A note's
 * own voice hint wins; otherwise notes starting and ending together are one chord, the line on top is
 * voice 1, a part held under it is voice 2, and a note played a little legato is cut back to the next
 * note rather than starting a voice of its own.
 */

/** A note on a staff, in display time (after the grid). */
export interface Placed {
  t: number;
  end: number;
  p: number;
  /** Its voice hint, if any. */
  vo?: number;
}

export interface Chord<T extends Placed> {
  t: number;
  end: number;
  items: T[];
}

/** Voices (index 0 is voice 1), each a list of non-overlapping chords in time order. */
export function assignVoices<T extends Placed>(items: readonly T[], grid = 0): Chord<T>[][] {
  const voices: Chord<T>[][] = [[], []];
  const hinted = items.filter((i) => i.vo);
  const free = items.filter((i) => !i.vo);

  // hinted notes go straight to their voice, grouped by start and end
  for (const i of hinted) {
    const v = (i.vo as number) - 1;
    while (voices.length <= v) voices.push([]);
    addTo(voices[v] as Chord<T>[], i);
  }

  // the rest: chords by start and end, the higher first at each start
  const chords = groupChords(free).sort((a, b) => a.t - b.t || top(b) - top(a));
  for (const c of chords) {
    const v1 = voices[0] as Chord<T>[];
    const v2 = voices[1] as Chord<T>[];
    const last1 = v1.at(-1);
    const last2 = v2.at(-1);
    if (last1 && last1.t === c.t) {
      // a second chord at the same start with another length: under it, in voice 2
      if (!last2 || last2.end <= c.t) v2.push(c);
      else mergeInto(last1, c);
      continue;
    }
    if (!last1 || last1.end <= c.t) {
      v1.push(c);
      continue;
    }
    // voice 1 still sounds: a small overlap is legato (cut it back); a held note makes room for voice 2
    const overlap = last1.end - c.t;
    const small = overlap <= Math.max(grid, (last1.end - last1.t) * 0.25);
    if (small || (last2 && last2.end > c.t)) {
      last1.end = c.t;
      v1.push(c);
    } else if (top(c) > top(last1)) {
      // the new line is above the held one: the held chord moves under it
      v1.pop();
      v2.push(last1);
      v1.push(c);
    } else {
      v2.push(c);
    }
  }
  for (const v of voices) {
    v.sort((a, b) => a.t - b.t);
    // a voice never overlaps itself: a chord ends where the next starts
    for (let k = 0; k + 1 < v.length; k++) {
      const a = v[k] as Chord<T>;
      const b = v[k + 1] as Chord<T>;
      if (a.end > b.t) a.end = b.t;
    }
  }
  while (voices.length > 1 && !(voices.at(-1) as Chord<T>[]).length) voices.pop();
  return voices;
}

const top = (c: Chord<Placed>): number => Math.max(...c.items.map((i) => i.p));

function groupChords<T extends Placed>(items: readonly T[]): Chord<T>[] {
  const map = new Map<string, Chord<T>>();
  for (const i of items) {
    const key = `${i.t}:${i.end}`;
    const c = map.get(key);
    if (c) c.items.push(i);
    else map.set(key, { t: i.t, end: i.end, items: [i] });
  }
  return [...map.values()];
}

function addTo<T extends Placed>(voice: Chord<T>[], i: T): void {
  const c = voice.find((x) => x.t === i.t);
  if (c) {
    c.items.push(i);
    c.end = Math.max(c.end, i.end);
  } else voice.push({ t: i.t, end: i.end, items: [i] });
}

function mergeInto<T extends Placed>(into: Chord<T>, c: Chord<T>): void {
  into.items.push(...c.items);
  into.end = Math.min(into.end, c.end);
}
