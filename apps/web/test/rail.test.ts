import { describe, expect, it } from 'vitest';
import { DRAWER_SWIPE, PEEK_SWIPE, pinchAxis, pinchedRow, pulledOut, RAIL_ROW, railRow } from '../src/ui/rail.ts';

describe("a phone's rows", () => {
  it('keep the height asked for within a finger and a few fingers', () => {
    expect(railRow(56)).toBe(56);
    expect(railRow(20)).toBe(RAIL_ROW.min);
    expect(railRow(400)).toBe(RAIL_ROW.max);
  });

  it('grow and shrink with two fingers spread up and down, from where they began', () => {
    // fingers 100 px apart over 56 px rows, spread to 150: the rows are half again as tall
    expect(pinchedRow(56, 100, 150)).toBe(84);
    expect(pinchedRow(56, 100, 50)).toBe(RAIL_ROW.min);
    expect(pinchedRow(56, 100, 1000)).toBe(RAIL_ROW.max);
    // a slow spread still moves them: each step is taken from the start, not the step before
    expect(pinchedRow(56, 100, 101)).toBe(57);
  });
});

describe('two fingers on the lanes', () => {
  it('set the rows when one is above the other', () => {
    expect(pinchAxis(20, 200)).toBe('y');
  });

  it('zoom in time side by side, and aslant', () => {
    expect(pinchAxis(200, 20)).toBe('x');
    expect(pinchAxis(120, 140)).toBe('x');
  });
});

describe('a finger drawn out of the rail', () => {
  it("pulls out nothing at first, then the track's buttons, then the drawer", () => {
    expect(pulledOut(PEEK_SWIPE - 1)).toBeNull();
    expect(pulledOut(-80)).toBeNull();
    expect(pulledOut(PEEK_SWIPE)).toBe('buttons');
    expect(pulledOut(DRAWER_SWIPE - 1)).toBe('buttons');
    expect(pulledOut(DRAWER_SWIPE)).toBe('drawer');
  });
});
