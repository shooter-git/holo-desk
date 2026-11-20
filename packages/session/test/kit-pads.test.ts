import { describe, expect, it } from 'vitest';
import {
  cleanPad,
  kitPadKnobs,
  padDefaults,
  padIsPlain,
  padKnobs,
  padLines,
  padParam,
  padProblems,
  padValues,
  padVelocityGain,
  parsePadParam,
  saturate,
} from '../src/index.ts';

const kit = { velocityRange: 28, oneShot: true };

describe('kit pads', () => {
  it('name a pad setting as a param, and read it back', () => {
    expect(padParam(38, 'drive')).toBe('pad:38:drive');
    expect(parsePadParam('pad:38:drive')).toEqual({ key: 38, field: 'drive' });
    for (const bad of ['pad:38', 'pad:200:level', 'pad:x:level', 'pad:38:volume', 'mic:room', 'tune'])
      expect(parsePadParam(bad), bad).toBeNull();
  });

  it("takes the song's setting, else the pack's, else the default, each in range", () => {
    const pad = { key: 38, name: 'Snare', drive: 40, character: 'hard' as const, curve: 'cubic' as const, level: 50 };
    const v = padValues(kit, pad, { [padParam(38, 'drive')]: 10, [padParam(36, 'drive')]: 90 }, 38);
    expect(v.drive).toBe(10);
    expect(v.character).toBe(1);
    expect(v.curve).toBe(1);
    // kept in range
    expect(v.level).toBe(12);
    // the kit's own range and one-shot are a pad's defaults
    expect(v.range).toBe(28);
    expect(v.play).toBe(0);
    expect(padValues({ velocityRange: 12, oneShot: false }, undefined, undefined, 38).play).toBe(1);
    expect(padDefaults(kit, pad).drive).toBe(40);
  });

  it('says which pads sound as the kit always did', () => {
    expect(padIsPlain(kit, padValues(kit, undefined, undefined, 36))).toBe(true);
    // settings that only count once something else is on
    expect(
      padIsPlain(kit, padValues(kit, { key: 36, name: 'Kick', output: -6, cutoff: 300, intensity: 40 }, {}, 36)),
    ).toBe(true);
    for (const set of [
      { level: -1 },
      { drive: 1 },
      { curve: 'linear' },
      { range: 20 },
      { pitchEnv: 3 },
      { play: 'gated' },
    ])
      expect(
        padIsPlain(kit, padValues(kit, { key: 36, name: 'Kick', ...set } as never, {}, 36)),
        JSON.stringify(set),
      ).toBe(false);
  });

  it('gives each velocity its gain on the curve', () => {
    expect(padVelocityGain(0, 28, 1, 127)).toBe(1);
    expect(padVelocityGain(0, 28, 1, 1)).toBeCloseTo(10 ** (-28 / 20), 12);
    expect(padVelocityGain(1, 0, 1, 64)).toBeCloseTo((64 / 127) ** 3, 12);
    expect(padVelocityGain(1, 0, 0, 1)).toBe(1);
    expect(padVelocityGain(2, 0, 0.5, 1)).toBeCloseTo(1 - 126 / 127 / 2, 12);
  });

  it('saturates: soft rounds, hard flattens, both lifting quiet sound 6 dB once fully in, and never past full scale', () => {
    for (const hard of [false, true]) {
      expect(saturate(0.001, 1, hard) / 0.001).toBeCloseTo(2, 2);
      // fully in (a drive of 1 and up), nothing passes full scale; mixed in, what's under it stays under
      for (const drive of [1, 2, 4])
        for (const x of [-3, -1, 1, 3]) expect(Math.abs(saturate(x, drive, hard))).toBeLessThanOrEqual(1);
      for (const x of [-1, -0.7, 0.7, 1]) expect(Math.abs(saturate(x, 0.5, hard))).toBeLessThanOrEqual(1);
      // odd: the negative half the positive's mirror
      expect(saturate(-0.3, 1.7, hard)).toBe(-saturate(0.3, 1.7, hard));
    }
    // soft: 2y - y² of the driven level; mixed in below a drive of 1, and the same either side of it
    expect(saturate(0.4, 1.625, false)).toBeCloseTo(2 * 0.65 - 0.65 ** 2, 12);
    expect(saturate(0.4, 0.5625, false)).toBeCloseTo(0.5625 * (0.8 - 0.16) + 0.4375 * 0.4, 12);
    expect(saturate(0.4, 1 - 1e-12, false)).toBeCloseTo(saturate(0.4, 1, false), 9);
    expect(saturate(0.3, 1, true)).toBe(0.6);
    expect(saturate(0.6, 1, true)).toBe(1);
    expect(saturate(0.25, 0, false)).toBe(0.25);
  });

  it("keeps a pack pad's valid settings only, and nothing for a pad without any", () => {
    expect(cleanPad({ key: 36, name: 'Kick' })).toBeNull();
    expect(cleanPad({ key: 36, name: 'Kick', tune: -30, filter: 'lowpass', resonance: 'lots', play: 'held' })).toEqual({
      key: 36,
      tune: -24,
      filter: 'lowpass',
    });
    expect(cleanPad({ key: 300, drive: 10 })).toBeNull();
  });

  it("tells a pack what's wrong with its pads' settings", () => {
    expect(padProblems({ key: 36, name: 'Kick' })).toEqual([]);
    expect(padProblems({ key: 36, name: 'Kick', drive: 30, curve: 'cubic', play: 'gated' })).toEqual([]);
    expect(padProblems({ key: 36, name: 'Kick', drive: 130, curve: 'log', gain: 3 })).toEqual([
      'pad 36: drive is 130, not 0 to 100',
      'pad 36: curve is "log", not one of db, cubic, linear',
      'pad 36: "gain" isn\'t a pad setting',
    ]);
  });

  it("names every pad's knobs by its pad, and lists the pads that sound their own way", () => {
    const pads = [
      { key: 36, name: 'Kick', curve: 'cubic' as const },
      { key: 38, name: 'Snare' },
    ];
    const defs = kitPadKnobs(kit, pads);
    expect(defs).toHaveLength(32);
    expect(defs.find((d) => d.id === 'pad:38:drive')?.name).toBe('Snare Drive');
    expect(padLines(kit, pads, { [padParam(38, 'drive')]: 40, [padParam(38, 'pan')]: -0.25 })).toEqual([
      '  pad 36 Kick: curve=Cubic',
      '  pad 38 Snare: pan=L 25 drive=40 %',
    ]);
    expect(padLines(kit, pads.slice(1), undefined)).toEqual([]);
  });

  it('has a knob for every setting, choices where it has them', () => {
    const defs = padKnobs(kit);
    expect(defs.map((d) => d.id)).toEqual([
      'level',
      'tune',
      'pan',
      'drive',
      'character',
      'output',
      'curve',
      'range',
      'intensity',
      'pitchEnv',
      'pitchDecay',
      'filter',
      'cutoff',
      'resonance',
      'filterVelocity',
      'play',
    ]);
    for (const d of defs) expect(d.default, d.id).toBeGreaterThanOrEqual(d.min);
    expect(defs.find((d) => d.id === 'curve')?.options).toEqual(['dB', 'Cubic', 'Linear']);
  });
});
