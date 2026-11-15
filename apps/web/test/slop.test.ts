import { describe, expect, it } from 'vitest';
import { pastSlop } from '../src/ui/slop.ts';

/** What a control moves by, in all, for a run of a finger's moves. */
const moved = (moves: number[], slop?: number) => {
  const past = pastSlop(slop);
  return moves.reduce((sum, d) => sum + past(d), 0);
};

describe('a finger’s first pixels on a control it could also be scrolling past', () => {
  it('move nothing', () => {
    expect(moved([1, 2, 1])).toBe(0);
    expect(moved([-2, -3])).toBe(0);
  });

  it('a wobble up and down while swiping sideways moves nothing either', () => {
    expect(moved([2, -3, 2, -1, 3, -2])).toBe(0);
  });

  it('past them, the control moves by what is past them, without a jump', () => {
    expect(moved([2, 2, 4])).toBe(2);
    expect(moved([-4, -4])).toBe(-2);
  });

  it('and from then on by all of each move, either way', () => {
    expect(moved([10, 5, -3])).toBe(6);
    expect(moved([-10, -5, 20])).toBe(11);
  });

  it('with the slop its caller names', () => {
    expect(moved([5, 5], 20)).toBe(0);
    expect(moved([15, 10], 20)).toBe(5);
  });
});
