/**
 * The Library's search: a query's words are matched one by one against the words of an item's
 * fields (its title, its category, the pack it comes from), and the items that match every word
 * come back best first.
 *
 * A word matches a field's word when it is that word, its singular or plural, the start of it
 * (what's typed so far), a word it stands for ("drums" for a kit, "strings" for a cello), a word
 * it's inside ("bass" in "Contrabass") or, when nothing matches so, that word with one slip of
 * the keys ("celo"; "bass" isn't "brass" while there are basses). A match in the title counts for
 * more than one in the category or the pack's name.
 */

/** A field of an item, and how much a match in it counts (the title 1, the pack's name less). */
export interface Field {
  text: string;
  weight: number;
}

/** How much a match in each kind of field counts. */
export const WEIGHT = { title: 1, category: 0.85, source: 0.5, note: 0.4 } as const;

/**
 * The words a query or field is made of: lower case, accents off, split at anything that isn't a
 * letter or a digit ("E-Piano" is "e" and "piano").
 */
export function words(text: string): string[] {
  return text
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** A word without its plural "s" ("drums" is "drum", "bass" stays "bass"). */
function stem(word: string): string {
  return word.length > 3 && word.endsWith('s') && !word.endsWith('ss') ? word.slice(0, -1) : word;
}

/**
 * Words a query word stands for as well as itself, by its singular: one way only ("strings" finds
 * a cello, "cello" doesn't find a violin).
 */
const ALSO: Record<string, readonly string[]> = {
  // not "kit" for "drum": "drum kit" is the kits, not every drum
  drum: ['kit', 'percussion'],
  percussion: ['drum', 'kit'],
  perc: ['percussion', 'drum', 'kit'],
  key: ['piano', 'keyboard'],
  keyboard: ['key', 'piano'],
  piano: ['key'],
  string: ['violin', 'viola', 'cello', 'contrabass', 'fiddle'],
  fiddle: ['violin'],
  violin: ['fiddle'],
  bass: ['contrabass'],
  brass: ['trumpet', 'trombone', 'horn', 'tuba', 'cornet', 'flugelhorn'],
  woodwind: ['flute', 'clarinet', 'oboe', 'bassoon', 'saxophone', 'sax', 'piccolo', 'recorder'],
  wind: ['flute', 'clarinet', 'oboe', 'bassoon', 'saxophone', 'sax', 'piccolo', 'recorder'],
  sax: ['saxophone'],
  saxophone: ['sax'],
  voice: ['vocal', 'choir', 'vox'],
  vocal: ['voice', 'choir', 'vox'],
  vox: ['voice', 'vocal', 'choir'],
  choir: ['voice', 'vocal', 'vox'],
  organ: ['tonewheel', 'harmonium'],
  mallet: ['marimba', 'vibraphone', 'xylophone', 'glockenspiel', 'celesta'],
  vibe: ['vibraphone'],
  synth: ['synthesizer'],
  synthesizer: ['synth'],
};

/** How far apart two words are: letters put in, taken out, changed or swapped, up to `max`. */
function distance(a: string, b: string, max: number): number {
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev2: number[] = [];
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    let least = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let d = Math.min((prev[j] as number) + 1, (row[j - 1] as number) + 1, (prev[j - 1] as number) + cost);
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1])
        d = Math.min(d, (prev2[j - 2] as number) + 1);
      row.push(d);
      least = Math.min(least, d);
    }
    if (least > max) return max + 1;
    prev2 = prev;
    prev = row;
  }
  return prev[b.length] as number;
}

/** How well a query word matches one word of a field: 1 is the word itself, 0 no match. */
function wordMatch(q: string, w: string, typos = false): number {
  if (q === w) return 1;
  const qs = stem(q);
  const ws = stem(w);
  if (qs === ws) return 0.95;
  // what's typed so far: the more of the word it is, the better
  if (w.startsWith(q)) return 0.6 + 0.3 * (q.length / w.length);
  if (ALSO[qs]?.some((a) => a === ws)) return 0.8;
  if (q.length >= 3 && w.includes(q)) return 0.5;
  if (typos && q.length >= 4 && ws.length >= 4 && distance(qs, ws, q.length >= 8 ? 2 : 1) <= (q.length >= 8 ? 2 : 1))
    return 0.45;
  return 0;
}

/** A field split into its words once, for every query word to look through. */
interface Split {
  words: string[];
  weight: number;
}

/**
 * How well a query's words match an item's fields: 0 when a word matches none of them, otherwise
 * more the better they match (an item every word names, in its title or as its category, the
 * best; then one whose category the words name as well, one whose title starts with the first
 * word, and a short title before a long one). No words match everything.
 */
export function score(query: readonly string[], fields: readonly Field[], typos = false): number {
  if (!query.length) return 1;
  const split: Split[] = fields.map((f) => ({ words: words(f.text), weight: f.weight }));
  let total = 0;
  let allNamed = true;
  // the words that name the category: "bass" finds a bass before "Bass Hits and Guitar", "piano"
  // a grand piano as soon as a piano named so
  let inCategory = 0;
  for (const q of query) {
    let best = 0;
    let inTitle = false;
    let category = false;
    for (const f of split) {
      for (const w of f.words) {
        const m = wordMatch(q, w, typos);
        if (!m) continue;
        if (m * f.weight > best) best = m * f.weight;
        if (f.weight >= WEIGHT.title) inTitle = true;
        if (f.weight === WEIGHT.category && m >= 0.95) category = true;
      }
    }
    if (!best) return 0;
    total += best;
    allNamed &&= inTitle || category;
    if (category) inCategory++;
  }
  const title = split.find((f) => f.weight >= WEIGHT.title)?.words ?? [];
  // the title starts with the first word as typed (not a word it stands for, or one like it)
  const first = title[0] && query[0] && (title[0].startsWith(query[0]) || stem(title[0]) === stem(query[0]));
  return (
    total / query.length +
    (allNamed ? 0.25 : 0) +
    0.2 * (inCategory / query.length) +
    (first ? 0.1 : 0) -
    // "Cello" before "Solo Cello (Pizzicato)"
    0.01 * Math.min(title.length, 10)
  );
}

/**
 * The items a query matches, best first (in their own order when they match as well), with how
 * well each does; only when none does, the ones it matches with a slip of the keys. An item can
 * have several sets of fields (a pack: each of its instruments), and matches as well as its best
 * one does.
 */
export function rank<T>(
  query: readonly string[],
  items: readonly T[],
  fields: (item: T) => readonly Field[] | readonly (readonly Field[])[],
): { item: T; score: number }[] {
  const sets = items.map(fields);
  const best = (f: readonly Field[] | readonly (readonly Field[])[], typos: boolean): number =>
    Array.isArray(f[0])
      ? Math.max(0, ...(f as readonly (readonly Field[])[]).map((x) => score(query, x, typos)))
      : score(query, f as readonly Field[], typos);
  const found = (typos: boolean) =>
    items
      .map((item, i) => ({ item, score: best(sets[i] as readonly Field[], typos), i }))
      .filter((x) => x.score > 0)
      .sort((a, b) => b.score - a.score || a.i - b.i)
      .map(({ item, score }) => ({ item, score }));
  const exact = found(false);
  return exact.length || !query.length ? exact : found(true);
}
