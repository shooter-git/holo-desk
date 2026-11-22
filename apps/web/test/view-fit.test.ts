import { describe, expect, it } from 'vitest';
import { fitColumns } from '../src/ui/view-fit.ts';

describe("a reply's controls laid out in their room", () => {
  it('keeps them on one line, as wide as their words, when they fit so', () => {
    expect(fitColumns([100, 120, 90], 330, 8)).toBe(0);
    expect(fitColumns([100, 120, 90], 326, 8)).toBe(0);
    expect(fitColumns([300], 300, 8)).toBe(0);
    expect(fitColumns([], 100, 8)).toBe(0);
  });

  it('puts them in as many equal columns as the widest fits in, balanced over the rows', () => {
    // four that don't fit on a line, three columns' worth of room: two rows of two, not three and one
    expect(fitColumns([90, 120, 115, 120], 380, 1)).toBe(2);
    // three buttons, two fit beside each other: two, then one as wide as they are
    expect(fitColumns([150, 165, 160], 358, 8)).toBe(2);
    // six, four columns' worth: two rows of three
    expect(fitColumns([100, 100, 100, 100, 100, 100], 440, 8)).toBe(3);
    // five, four columns' worth: three and two
    expect(fitColumns([80, 80, 80, 80, 80], 360, 8)).toBe(3);
    // the widest decides, not the sum
    expect(fitColumns([60, 60, 60, 200], 300, 8)).toBe(1);
  });

  it('puts them one under another when even two of the widest are too wide', () => {
    expect(fitColumns([200, 225, 214, 212, 203], 288, 8)).toBe(1);
    expect(fitColumns([400], 288, 8)).toBe(1);
  });

  it("fills every row of a choice's columns, or puts its options one under another", () => {
    expect(fitColumns([90, 120, 115, 120], 380, 1, true)).toBe(2);
    expect(fitColumns([150, 165, 160], 358, 1, true)).toBe(1);
    expect(fitColumns([80, 80, 80, 80, 80], 360, 1, true)).toBe(1);
    expect(fitColumns([100, 100, 100, 100, 100, 100], 420, 1, true)).toBe(3);
    expect(fitColumns([100, 100, 100, 100, 100, 100], 250, 1, true)).toBe(2);
    expect(fitColumns([100, 100, 100, 100, 100, 100], 600, 1, true)).toBe(3);
  });
});
