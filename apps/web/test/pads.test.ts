import { newProject, newTrack } from '@holo/session';
import { describe, expect, it } from 'vitest';
import type { InstrumentMap } from '../src/audio/pack-files.ts';
import { GM_PADS, padsFor, padTrack, playsHits } from '../src/ui/pads.ts';

const opts = { wide: false, octave: 3, middleC: 'C4' as const };

const zone = (file: string, lo: number, hi = lo) => ({ file, lo, hi, root: lo, lovel: 1, hivel: 127 });

/**
 * Instruments as packs map them: a kit (its pads named, each piece a folder), one unpitched sound and
 * a piano. (Every real pack's pads are checked in the packs repository, with this code.)
 */
const shipped = [
  {
    pack: 'test-kit',
    name: 'kit',
    title: 'Test Kit',
    pitched: false,
    zones: [
      zone('kit/kick/kick_v1.wav', 36),
      zone('kit/snare/snare_v1.wav', 38),
      zone('kit/hat-closed/hat_v1.wav', 42),
      zone('kit/hat-open/hat_v1.wav', 46),
    ],
    pads: [
      { key: 36, name: 'Kick' },
      { key: 38, name: 'Snare' },
      { key: 42, name: 'Hi-hat closed' },
      { key: 46, name: 'Hi-hat open' },
    ],
  },
  { pack: 'test', name: 'bongo_hi', title: 'Bongo High', pitched: false, zones: [zone('bongo/hi.wav', 0, 127)] },
  { pack: 'test', name: 'grand', title: 'Grand', pitched: true, zones: [zone('piano/c4.wav', 0, 127)] },
] as unknown as (InstrumentMap & { pack: string })[];

describe("the pads of a pack's instruments", () => {
  const kits = shipped.filter((m) => m.pads?.length);

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
    // and for the drum machines
    for (const preset of ['Analog Machine', 'Punch Machine', 'Lo-fi Machine', 'Hand Machine'])
      expect(padsFor({ type: 'synth', preset }, null, opts).pads.map((p) => p.note)).toEqual(GM_PADS);
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
    expect(playsHits({ type: 'synth', preset: 'Analog Machine' }, null)).toBe(true);
    expect(playsHits({ type: 'synth', preset: 'Tine Piano' }, null)).toBe(false);
    expect(playsHits({ type: 'synth', preset: 'Fat Mono' }, null)).toBe(false);
    // not known until its map comes
    expect(playsHits(sampler(map('kit')), null)).toBe(false);
  });
});
