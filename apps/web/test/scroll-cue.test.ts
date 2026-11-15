import { describe, expect, it } from 'vitest';
import { scrollCue } from '../src/ui/scroll-cue.ts';

describe('which edges of a scrolled box have more', () => {
  it('neither, when everything shows', () => {
    expect(scrollCue(0, 120, 120)).toEqual({ before: false, after: false });
  });

  it('after at the start, both in the middle, before at the end', () => {
    expect(scrollCue(0, 400, 120)).toEqual({ before: false, after: true });
    expect(scrollCue(100, 400, 120)).toEqual({ before: true, after: true });
    expect(scrollCue(280, 400, 120)).toEqual({ before: true, after: false });
  });

  it('a pixel’s rounding isn’t more', () => {
    expect(scrollCue(0.5, 120.6, 120)).toEqual({ before: false, after: false });
  });
});
