import { describe, expect, it } from 'vitest';
import { type Field, rank, score, WEIGHT, words } from '../src/ui/search.ts';

/** Instruments as the Library lists them: a title, a category and the pack they come from. */
const LIBRARY = [
  ['Upright Piano', 'Piano', 'Upright Piano Pack'],
  ['Concert Grand', 'Piano', 'Concert Grand Piano'],
  ['Concert Grand, Close', 'Piano', 'Concert Grand Piano'],
  ['Electric Piano', 'Keys', 'Built-in'],
  ['Stage Electric Grand', 'Keys', 'Vintage Keys'],
  ['Cello', 'Strings', 'Orchestra'],
  ['Solo Cello (Pizzicato)', 'Strings', 'Solo Strings'],
  ['Cellos', 'Strings', 'Orchestra'],
  ['Solo Violin', 'Strings', 'Solo Strings'],
  ['Contrabass', 'Strings', 'Orchestra'],
  ['Solo Double Bass', 'Bass', 'Solo Strings'],
  ['Bassoon', 'Woodwinds', 'Clarinet and Bassoon'],
  ['Clarinet', 'Woodwinds', 'Clarinet and Bassoon'],
  ['Jazz Kit', 'Drums', 'Jazz Kit Pack'],
  ['Rock Kit', 'Drums', 'Rock Kit Pack'],
  ['Snare Drum', 'Drums', 'Hand Drums'],
  ['Turtle Drum', 'Percussion', 'Odd Things'],
  ['Marimba', 'Percussion', 'Mallets'],
  ['Gendèr Barung', 'Percussion', 'Gamelan'],
  ['Wurlitzer EP200', 'Keys', 'E-Pianos'],
].map(([title, category, pack]) => ({ title, category, pack }) as { title: string; category: string; pack: string });

type Item = (typeof LIBRARY)[number];
const fields = (i: Item): Field[] => [
  { text: i.title, weight: WEIGHT.title },
  { text: i.category, weight: WEIGHT.category },
  { text: i.pack, weight: WEIGHT.source },
];
const search = (q: string) => rank(words(q), LIBRARY, fields).map((r) => r.item.title);

describe('words', () => {
  it('splits at anything but letters and digits, in lower case without accents', () => {
    expect(words("  E-Piano, Gendèr (Pelog) 8'")).toEqual(['e', 'piano', 'gender', 'pelog', '8']);
    expect(words('   ')).toEqual([]);
  });
});

describe('search', () => {
  it('finds everything when nothing is typed, in its own order', () => {
    expect(search('')).toEqual(LIBRARY.map((i) => i.title));
  });

  it('matches words in any order, across fields', () => {
    expect(search('grand concert')).toEqual(['Concert Grand', 'Concert Grand, Close']);
    expect(search('drum kit')).toEqual(['Jazz Kit', 'Rock Kit']);
    expect(search('jazz drums')).toEqual(['Jazz Kit']);
    expect(search('piano upright')[0]).toBe('Upright Piano');
  });

  it("doesn't match across the gap between two fields or words", () => {
    // "Close" then "Piano" once read "…close piano"
    expect(search('e piano')).not.toContain('Concert Grand, Close');
    expect(search('e piano')[0]).toBe('Electric Piano');
  });

  it('puts whole words in the title first, and short titles before long ones', () => {
    expect(search('cello').slice(0, 3)).toEqual(['Cello', 'Cellos', 'Solo Cello (Pizzicato)']);
    const bass = search('bass');
    expect(bass[0]).toBe('Solo Double Bass');
    expect(bass.indexOf('Contrabass')).toBeGreaterThan(-1);
    expect(bass.indexOf('Bassoon')).toBeGreaterThan(0);
  });

  it('finds a plural from its singular and a singular from its plural', () => {
    expect(search('pianos')).toContain('Upright Piano');
    expect(search('cellos')[0]).toBe('Cellos');
    expect(search('drums')).toEqual(expect.arrayContaining(['Snare Drum', 'Turtle Drum', 'Jazz Kit']));
  });

  it('finds what is typed so far', () => {
    expect(search('vio')).toEqual(['Solo Violin']);
    expect(search('mari')).toEqual(['Marimba']);
    expect(search('ep')).toContain('Wurlitzer EP200');
  });

  it('finds what a word stands for, one way only', () => {
    expect(search('strings')).toEqual(expect.arrayContaining(['Cello', 'Solo Violin', 'Contrabass']));
    expect(search('cello')).not.toContain('Solo Violin');
    expect(search('keyboard')).toEqual(expect.arrayContaining(['Upright Piano', 'Electric Piano']));
  });

  it('forgives one slip of the keys in a longer word', () => {
    expect(search('celo')[0]).toBe('Cello');
    expect(search('marimab')).toEqual(['Marimba']);
    expect(search('clarient')[0]).toBe('Clarinet');
    // but not in a short one
    expect(search('kot')).toEqual([]);
  });

  it('looks for slips only when nothing matches as typed', () => {
    const brass = { title: 'Big Brass', category: 'Brass', pack: 'Orchestra' };
    expect(rank(words('bass'), [...LIBRARY, brass], fields).map((r) => r.item.title)).not.toContain('Big Brass');
    expect(rank(words('bass'), [brass], fields).map((r) => r.item.title)).toEqual(['Big Brass']);
  });

  it('matches accented titles without the accent', () => {
    expect(search('gender')).toEqual(['Gendèr Barung']);
  });

  it('finds nothing when a word matches nothing', () => {
    expect(search('cello zebra')).toEqual([]);
    expect(score(['zebra'], fields(LIBRARY[0] as Item))).toBe(0);
  });

  it('puts an instrument of the category a word names before one that only has the word', () => {
    const order = rank(
      words('bass'),
      [
        { title: 'Bass Hits and Guitar', category: 'Other', pack: 'Samples' },
        { title: 'Electric Bass', category: 'Bass', pack: 'Bass Guitar' },
      ],
      fields,
    ).map((r) => r.item.title);
    expect(order).toEqual(['Electric Bass', 'Bass Hits and Guitar']);
  });

  it('ranks a match in the title above one in the pack name', () => {
    const order = search('clarinet');
    expect(order[0]).toBe('Clarinet');
    expect(order).toContain('Bassoon');
  });
});
