import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { newProject, newTrack } from '@holo/session';
import { describe, expect, it } from 'vitest';
import type { InstrumentMap } from '../src/audio/pack-files.ts';
import { GM_PADS, padsFor, padTrack, playsHits } from '../src/ui/pads.ts';

const MANIFESTS = resolve(import.meta.dirname, '../../../packs/manifests');
const opts = { wide: false, octave: 3, middleC: 'C4' as const };

/** Every instrument HO[LO] ships a map for. */
const shipped = readdirSync(MANIFESTS)
  .filter((f) => f.endsWith('.json'))
  .flatMap((f) => {
    const pack = JSON.parse(readFileSync(join(MANIFESTS, f), 'utf8')) as {
      id: string;
      instruments: InstrumentMap[];
    };
    return pack.instruments.map((i) => ({ ...i, pack: pack.id }));
  });

/** The pieces a key strikes (a kit's pieces are its sample folders). */
const struck = (m: InstrumentMap, key: number) =>
  new Set(m.zones.filter((z) => !z.trigger && z.lo <= key && key <= z.hi).map((z) => z.file.replace(/\/[^/]*$/, '')));

/** A pad's name says what it plays: every word of its piece's folder is in it (letters and digits). */
const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9¾]/g, '');
const WORDS: Record<string, string[]> = { 'hat-three-quarter': ['hat', '¾'] };

describe("the pads of every pack's instruments", () => {
  const kits = shipped.filter((m) => m.pads?.length);

  it('the kits name their pads, and each pad plays the one piece its name says', () => {
    expect(kits.map((m) => m.pack).sort()).toEqual(['jazz-kit', 'prog-kit', 'rock-kit']);
    for (const m of kits) {
      const pads = m.pads ?? [];
      const pieces = pads.map((p) => {
        const hit = [...struck(m, p.key)];
        expect(hit, `${m.pack} ${p.name} (${p.key})`).toHaveLength(1);
        const folder = (hit[0] as string).split('/').pop() as string;
        for (const w of WORDS[folder] ?? folder.split('-'))
          expect(flat(p.name), `${m.pack}: "${p.name}" plays ${folder}`).toContain(flat(w));
        return hit[0];
      });
      // every piece once: none twice, none left without a pad
      expect(new Set(pieces).size).toBe(pads.length);
      const all = new Set(m.zones.filter((z) => !z.trigger).map((z) => z.file.replace(/\/[^/]*$/, '')));
      expect([...all].sort()).toEqual([...pieces].sort());
    }
  });

  it('the kick, snare and hats sit where General MIDI has them', () => {
    for (const m of kits) {
      const grid = padsFor({ type: 'sampler', pack: m.pack, name: m.name }, m, opts);
      const at = (key: number) => grid.pads.find((p) => p.note === key)?.name;
      expect([at(36), at(38), at(42), at(46)]).toEqual(['Kick', 'Snare', 'Hi-hat closed', 'Hi-hat open']);
      expect(grid.cols).toBe(4);
      expect(grid.chromatic).toBe(false);
    }
  });

  it('every other instrument is played by pitch, or is one sound (its one pad named by it)', () => {
    for (const m of shipped.filter((x) => !x.pads?.length)) {
      const grid = padsFor({ type: 'sampler', pack: m.pack, name: m.name }, m, opts);
      if (m.pitched === false) {
        expect(grid.pads, `${m.pack}/${m.name}`).toEqual([{ note: 60, name: m.title }]);
      } else {
        expect(grid.chromatic, `${m.pack}/${m.name}`).toBe(true);
      }
    }
  });
});

describe('pads for what plays them', () => {
  it('has the General MIDI drums for the Drum Synth, and for a track with nothing on it', () => {
    const gm = padsFor({ type: 'synth', preset: 'Drum Synth' }, null, opts);
    expect(gm.pads.map((p) => p.note)).toEqual(GM_PADS);
    expect(gm.pads.find((p) => p.note === 56)?.name).toBe('Cowbell');
    expect(padsFor({ type: 'none' }, null, opts).pads.map((p) => p.note)).toEqual(GM_PADS);
  });

  it('plays notes by pitch for a synth, the lowest at the bottom left', () => {
    const g = padsFor({ type: 'synth', preset: 'Fat Mono' }, null, opts);
    expect(g.chromatic).toBe(true);
    expect(g.pads).toHaveLength(16);
    // four rows of four, from C3 (octave 3): the bottom row first in pitch, the top row last
    expect(g.pads[12]).toEqual({ note: 48, name: 'C3' });
    expect(g.pads[15]?.note).toBe(51);
    expect(g.pads[0]?.note).toBe(60);
    expect(g.pads[3]).toEqual({ note: 63, name: 'D#4' });
    // two rows of eight when wide
    const w = padsFor({ type: 'synth', preset: 'Fat Mono' }, null, { ...opts, wide: true });
    expect([w.cols, w.pads[8]?.note, w.pads[0]?.note, w.pads[7]?.note]).toEqual([8, 48, 56, 63]);
    // never past MIDI's top
    const top = padsFor({ type: 'synth', preset: 'Soft Keys' }, null, { ...opts, octave: 9 });
    expect(Math.max(...top.pads.map((p) => p.note))).toBe(127);
  });

  it("names an imported kit's sounds by their notes when it has no names of its own", () => {
    const zone = (lo: number, hi: number) => ({ file: `s${lo}.wav`, lo, hi, root: lo, lovel: 1, hivel: 127 });
    const m = {
      name: 'kit',
      pitched: false,
      zones: [zone(36, 36), zone(38, 38), zone(42, 42)],
    } as unknown as InstrumentMap;
    const g = padsFor({ type: 'sampler', pack: 'mine', name: 'kit' }, m, opts);
    expect(g.pads).toEqual([
      { note: 36, name: 'C2' },
      { note: 38, name: 'D2' },
      { note: 42, name: 'F#2' },
    ]);
    expect(g.cols).toBe(3);
  });
});

describe('the track the pads play', () => {
  it('is the first armed track that listens, else the selected one', () => {
    const p = newProject('t');
    const keys = p.tracks[0] as (typeof p.tracks)[number];
    const drums = newTrack('Drums', { type: 'sampler', pack: 'rock-kit', name: 'kit' });
    p.tracks.push(drums);
    // a new song's Keys track is armed: the pads play it, whichever track is selected
    expect(padTrack(p, drums.id, 'On-screen', 10)?.id).toBe(keys.id);
    keys.armed = false;
    expect(padTrack(p, drums.id, 'On-screen', 10)?.id).toBe(drums.id);
    // a track listening to another channel or device isn't played by the pads
    drums.input = { port: '*', channel: 1 };
    expect(padTrack(p, drums.id, 'On-screen', 10)).toBeNull();
    drums.input = { port: 'My pads', channel: 0 };
    expect(padTrack(p, drums.id, 'On-screen', 10)).toBeNull();
  });
});

describe('an instrument that plays each key as its own hit', () => {
  it('is a kit, the Drum Synth or a single unpitched sound, not a pitched instrument', () => {
    const map = (name: string) => shipped.find((m) => m.name === name) as InstrumentMap;
    const sampler = (m: InstrumentMap) => ({ type: 'sampler' as const, pack: m.pack, name: m.name });
    expect(shipped.filter((m) => m.pads?.length).every((m) => playsHits(sampler(m), m))).toBe(true);
    expect(playsHits(sampler(map('bongo_hi')), map('bongo_hi'))).toBe(true);
    expect(playsHits(sampler(map('grand')), map('grand'))).toBe(false);
    expect(playsHits({ type: 'synth', preset: 'Drum Synth' }, null)).toBe(true);
    expect(playsHits({ type: 'synth', preset: 'Fat Mono' }, null)).toBe(false);
    // not known until its map comes
    expect(playsHits(sampler(map('kit')), null)).toBe(false);
  });
});
