import { describe, expect, it } from 'vitest';
import { landing } from '../src/ui/reorder.ts';

// four tracks of 56 px, one under another
const starts = [0, 56, 112, 168];
const sizes = [56, 56, 56, 56];

describe('where a dragged track lands', () => {
  it('stays put until it has moved half a place', () => {
    expect(landing(starts, sizes, 1, 0)).toBe(1);
    expect(landing(starts, sizes, 1, 27)).toBe(1);
    expect(landing(starts, sizes, 1, -27)).toBe(1);
  });

  it('passes a neighbor once past half a place, either way', () => {
    expect(landing(starts, sizes, 1, 29)).toBe(2);
    expect(landing(starts, sizes, 1, -29)).toBe(0);
    expect(landing(starts, sizes, 0, 2.2 * 56)).toBe(2);
  });

  it('takes the end places when held against the ends (where the drag stops)', () => {
    // the drag stops with the item lying exactly on the last place, or the first
    expect(landing(starts, sizes, 2, 56)).toBe(3);
    expect(landing(starts, sizes, 0, 168)).toBe(3);
    expect(landing(starts, sizes, 3, -168)).toBe(0);
  });
});
