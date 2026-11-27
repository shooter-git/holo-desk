/** Quantizing to a grid that swings: what the studio's Quantize and the agent's `regions quantize` both do. */
import { DIVISIONS, type MeterPoint, PPQ, quantize } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { MAX_SWING, swings, swung, swungAt } from '../src/edits/timing.ts';

const S = PPQ / 4; // a sixteenth
const E = PPQ / 2; // an eighth

describe('which grids swing', () => {
  it('the straight ones do, triplets and dotted ones do not', () => {
    const straight = ['1/1', '1/2', '1/4', '1/8', '1/16', '1/32'];
    for (const [name, ticks] of Object.entries(DIVISIONS))
      expect([name, swings(ticks)]).toEqual([name, straight.includes(name)]);
  });
});

describe('swung', () => {
  it('with no swing is quantize itself, strength and all', () => {
    for (const t of [0, 7, 119, 121, 250, 479, 3839, -30])
      for (const strength of [1, 0.5, 0]) expect(swung(t, S, strength, 0)).toBe(quantize(t, S, strength));
  });

  it('leaves the steps on the beat where they are and brings the off-steps late', () => {
    // sixteenths at 50 %: an off-step is a quarter of a step late
    expect(swung(5, S, 1, 0.5)).toBe(0);
    expect(swung(S - 10, S, 1, 0.5)).toBe(S + S / 4);
    expect(swung(S + 20, S, 1, 0.5)).toBe(S + S / 4);
    expect(swung(2 * S + 9, S, 1, 0.5)).toBe(2 * S);
    expect(swung(3 * S, S, 1, 0.5)).toBe(3 * S + S / 4);
  });

  it('a note already on a swung off-step stays there', () => {
    const late = S + (2 / 3) * S * 0.5;
    expect(swung(Math.round(late), S, 1, 2 / 3)).toBe(Math.round(late));
  });

  it('at two thirds, eighths fall as the first and last of a triplet', () => {
    // the off-eighth lands a third of an eighth late: two thirds of the way through the beat
    expect(swung(E, E, 1, 2 / 3)).toBe(Math.round(E + E / 3));
    expect(swung(E, E, 1, 2 / 3)).toBe(DIVISIONS['1/8T'] * 2);
  });

  it('goes part of the way at a strength under 100 %', () => {
    // 40 ticks before a swung off-step (at 300): half way there
    expect(swung(260, S, 0.5, 0.5)).toBe(280);
    expect(swung(260, S, 0, 0.5)).toBe(260);
  });

  it('never swings more than the engine’s own swings, nor a grid that has no off-steps', () => {
    expect(swung(S, S, 1, 5)).toBe(S + MAX_SWING * S * 0.5);
    expect(swung(S, S, 1, -1)).toBe(S);
    const triplet = DIVISIONS['1/8T'] as number;
    expect(swung(triplet + 9, triplet, 1, 0.6)).toBe(triplet);
  });

  it('counts its steps from the bar line, before it too', () => {
    expect(swung(-S + 4, S, 1, 0.5)).toBe(-S + S / 4);
    expect(swung(-2 * S - 4, S, 1, 0.5)).toBe(-2 * S);
  });
});

describe('swungAt', () => {
  it('counts the off-steps from the bar the note is in', () => {
    // 3/8 then 4/4: a bar of three eighths puts the next bar's first eighth on an odd eighth of the song
    const meter: MeterPoint[] = [
      { tick: 0, num: 3, den: 8 },
      { tick: 3 * E, num: 4, den: 4 },
    ];
    // the second bar's downbeat stays; its second eighth swings
    expect(swungAt(meter, 3 * E + 6, E, 1, 0.5)).toBe(3 * E);
    expect(swungAt(meter, 4 * E - 6, E, 1, 0.5)).toBe(4 * E + E / 4);
    // the first bar's second eighth swings, its third doesn't
    expect(swungAt(meter, E, E, 1, 0.5)).toBe(E + E / 4);
    expect(swungAt(meter, 2 * E + 3, E, 1, 0.5)).toBe(2 * E);
  });
});
