import { describe, expect, it } from 'vitest';
import { DRUM_PIECES, defaultParams, GROOVE_VARIATIONS, GROOVES, pluginDef } from '../src/index.ts';

describe("Session Drummer's grooves", () => {
  it('are each a bar long, part by part, in the characters the engine reads', () => {
    for (const g of GROOVES) {
      const bar = g.grid * 4;
      const parts = [...g.kick, ...g.snare, g.cymbal, g.perc, ...(g.foot ? [g.foot] : [])];
      for (const part of parts) {
        expect(part, `${g.name}: ${part}`).toHaveLength(bar);
        expect(part, `${g.name}: ${part}`).toMatch(/^[XxOog1-9.]+$/);
      }
      expect(g.kick.length).toBeLessThanOrEqual(GROOVE_VARIATIONS);
      // a groove starts on the downbeat
      expect(g.kick.every((k) => k[0] !== '.')).toBe(true);
    }
  });

  it('are offered by name, as the table stores them (their index)', () => {
    const def = pluginDef('drummer');
    expect(def?.kind).toBe('midi');
    expect(def?.params.find((p) => p.id === 'genre')?.options).toEqual(GROOVES.map((g) => g.name));
    expect(defaultParams('drummer').genre).toBe(0);
    // and a Drum Replacer's pieces are each on their own key
    expect(new Set(DRUM_PIECES.map((p) => p.key)).size).toBe(DRUM_PIECES.length);
  });
});
