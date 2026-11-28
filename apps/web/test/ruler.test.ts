import { describe, expect, it } from 'vitest';
import { drawnCycle, JOG_PX, jog, rulerHold } from '../src/ui/ruler.ts';

describe('a press on the tracks ruler', () => {
  // a ruler 40 px tall; the cycle drawn from 100 to 300 px
  const cycle = { x0: 100, x1: 300 };
  const top = 10;
  const bottom = 30;

  it('takes the playhead in the bottom half, the cycle in the top half', () => {
    expect(rulerHold(50, bottom, 40, cycle)).toBe('playhead');
    expect(rulerHold(200, bottom, 40, cycle)).toBe('playhead');
    expect(rulerHold(104, top, 40, cycle)).toBe('start');
    expect(rulerHold(295, top, 40, cycle)).toBe('end');
    expect(rulerHold(200, top, 40, cycle)).toBe('move');
    expect(rulerHold(50, top, 40, cycle)).toBe('new');
    expect(rulerHold(400, top, 40, cycle)).toBe('new');
  });

  it('gives a finger on a phone the playhead anywhere but at the cycle’s edges', () => {
    expect(rulerHold(200, top, 40, cycle, true)).toBe('playhead');
    expect(rulerHold(50, top, 40, cycle, true)).toBe('playhead');
    expect(rulerHold(400, top, 40, cycle, true)).toBe('playhead');
    expect(rulerHold(200, bottom, 40, cycle, true)).toBe('playhead');
    // a finger's edge is wider than a mouse's
    expect(rulerHold(112, top, 40, cycle, true)).toBe('start');
    expect(rulerHold(112, top, 40, cycle)).toBe('move');
    expect(rulerHold(288, top, 40, cycle, true)).toBe('end');
    // (only in the cycle's strip)
    expect(rulerHold(104, bottom, 40, cycle, true)).toBe('playhead');
  });

  it('gives a finger the nearer edge of a cycle drawn narrow', () => {
    const narrow = { x0: 100, x1: 110 };
    expect(rulerHold(102, top, 40, narrow, true)).toBe('start');
    expect(rulerHold(108, top, 40, narrow, true)).toBe('end');
  });
});

describe('a cycle drawn on the ruler', () => {
  it('runs from where the drag began to where it is, whichever way it went', () => {
    expect(drawnCycle(960, 2880, 480)).toEqual({ start: 960, end: 2880 });
    expect(drawnCycle(2880, 960, 480)).toEqual({ start: 960, end: 3360 });
  });

  it('is a grid step long at the least, and never starts before the song does', () => {
    expect(drawnCycle(960, 960, 480)).toEqual({ start: 960, end: 1440 });
    expect(drawnCycle(960, 1000, 480)).toEqual({ start: 960, end: 1440 });
    expect(drawnCycle(0, -480, 480)).toEqual({ start: 0, end: 480 });
  });
});

describe('a drag on the position display', () => {
  it('moves a bar for each bar’s worth of travel, keeping the rest', () => {
    expect(jog(JOG_PX * 4 + 3)).toEqual({ bars: 4, rest: 3 });
    expect(jog(-JOG_PX * 2 - 5)).toEqual({ bars: -2, rest: -5 });
    expect(jog(JOG_PX - 1)).toEqual({ bars: 0, rest: JOG_PX - 1 });
    expect(jog(-3)).toEqual({ bars: 0, rest: -3 });
  });
});
