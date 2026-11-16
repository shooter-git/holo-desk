import { describe, expect, it } from 'vitest';
import { BLACK, noteAt, topOctave, upperOctave, velocityAt, whiteKeys } from '../src/ui/play-keys.ts';

describe('the on-screen keyboard', () => {
  it('shows its white keys from the C of its octave', () => {
    expect(whiteKeys(4, 10)).toEqual([60, 62, 64, 65, 67, 69, 71, 72, 74, 76]);
    expect(whiteKeys(0, 3)).toEqual([12, 14, 16]);
  });

  it('goes no higher than MIDI reaches, at every width it takes', () => {
    for (const count of [10, 14, 21]) {
      const whites = whiteKeys(topOctave(count), count);
      const last = whites[whites.length - 1] ?? 0;
      expect(last).toBeLessThanOrEqual(127);
      // (the top is as high as it gets: the next octave up would pass 127, or it's the highest offered)
      const higher = whiteKeys(topOctave(count) + 1, count);
      expect(topOctave(count) === 7 || higher.some((n) => n > 127)).toBe(true);
    }
    expect(topOctave(10)).toBe(7);
    expect(topOctave(21)).toBe(6);
  });

  // ten keys 400 px wide (40 a key) and 300 tall: the black keys are the top 60%
  const whites = whiteKeys(4, 10);
  const at = (x: number, y: number) => noteAt(whites, x, y, 400, 300);

  it('plays the white key under a finger low down, and a black one at its edges up high', () => {
    expect(at(20, 250)).toBe(60);
    expect(at(41, 250)).toBe(62);
    // the edge between C and D, up high: C♯
    expect(at(38, 100)).toBe(61);
    expect(at(42, 100)).toBe(61);
    // E and F have no black key between them
    expect(at(118, 100)).toBe(64);
    expect(at(122, 100)).toBe(65);
    // the middle of a key, up high, is still the white key
    expect(at(60, 100)).toBe(62);
    expect(BLACK.includes((at(38, 100) ?? 0) % 12)).toBe(true);
  });

  it('plays nothing off the keys, sideways', () => {
    expect(at(-1, 250)).toBeNull();
    expect(at(400, 250)).toBeNull();
  });

  it('measures each row by its own size', () => {
    // the same point is low on a short row and high on a tall one
    expect(noteAt(whites, 38, 100, 400, 120)).toBe(60);
    expect(noteAt(whites, 38, 100, 400, 600)).toBe(61);
    expect(velocityAt(100, 120)).toBeLessThan(velocityAt(100, 600));
  });

  it('plays harder the higher the finger, within 40 and 127', () => {
    expect(velocityAt(0, 300)).toBe(127);
    expect(velocityAt(300, 300)).toBe(40);
    expect(velocityAt(-50, 300)).toBe(127);
    expect(velocityAt(400, 300)).toBe(40);
    expect(velocityAt(100, 300)).toBeGreaterThan(velocityAt(200, 300));
  });

  it('puts the upper row an octave above the lower until it has its own', () => {
    expect(upperOctave(null, 4, 7)).toBe(5);
    expect(upperOctave(null, 7, 7)).toBe(7);
    expect(upperOctave(2, 4, 7)).toBe(2);
    expect(upperOctave(8, 4, 7)).toBe(7);
  });
});
