import { describe, expect, it } from 'vitest';
import { fitColumns } from '../src/ui/view-fit.ts';

describe("a reply's controls laid out in their room", () => {
  it('keeps them on one line, as wide as their words, when they fit so', () => {
    expect(fitColumns([100, 120, 90], 330, 8)).toBe(0);
    expect(fitColumns([100, 120, 90], 326, 8)).toBe(0);
    expect(fitColumns([300], 300, 8)).toBe(0);
    expect(fitColumns([], 100, 8)).toBe(0);
  });

  it('puts them in the most equal columns the widest fits in that fill every row', () => {
    // four, three columns' worth of room: two rows of two, not three and one
    expect(fitColumns([90, 120, 115, 120], 380, 1)).toBe(2);
    expect(fitColumns([90, 120, 115, 120], 380, 8)).toBe(2);
    // six: two rows of three, or three of two
    expect(fitColumns([100, 100, 100, 100, 100, 100], 440, 8)).toBe(3);
    expect(fitColumns([100, 100, 100, 100, 100, 100], 600, 1)).toBe(3);
    expect(fitColumns([100, 100, 100, 100, 100, 100], 250, 8)).toBe(2);
    // the widest decides, not the sum
    expect(fitColumns([60, 60, 60, 200], 300, 8)).toBe(1);
  });

  it('never leaves a row short or one alone: three or five that don’t fit on a line go one under another', () => {
    // three, two fit beside each other: not two and one
    expect(fitColumns([150, 165, 160], 358, 8)).toBe(1);
    expect(fitColumns([150, 165, 160], 358, 1)).toBe(1);
    // five, four columns' worth: not three and two
    expect(fitColumns([80, 80, 80, 80, 80], 360, 8)).toBe(1);
  });

  it('puts them one under another when even two of the widest are too wide', () => {
    expect(fitColumns([200, 225, 214, 212, 203], 288, 8)).toBe(1);
    expect(fitColumns([200, 200], 300, 8)).toBe(1);
    expect(fitColumns([400], 288, 8)).toBe(1);
  });
});
