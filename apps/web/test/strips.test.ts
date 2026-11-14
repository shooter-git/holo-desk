import { PLUGINS } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { scrollCue, slotName } from '../src/ui/strips.ts';

describe('a plugin’s name on a strip’s slot', () => {
  it('goes by a mixer’s word where the whole name wouldn’t fit', () => {
    expect(slotName('eq', 'Channel EQ')).toBe('EQ');
    expect(slotName('compressor', 'Compressor')).toBe('Comp');
    expect(slotName('drummer', 'Session Drummer')).toBe('Drummer');
  });

  it('is the name itself where that fits, and for a plugin it doesn’t know', () => {
    expect(slotName('chorus', 'Chorus')).toBe('Chorus');
    expect(slotName('something-new', 'Something New')).toBe('Something New');
  });

  it('fits the slot for every plugin there is: nine letters at most', () => {
    for (const p of PLUGINS) expect(slotName(p.type, p.name).length, p.name).toBeLessThanOrEqual(9);
  });
});

describe('which edges of a scrolled box have more', () => {
  it('neither, when everything shows', () => {
    expect(scrollCue(0, 120, 120)).toEqual({ above: false, below: false });
  });

  it('below at the top, both in the middle, above at the end', () => {
    expect(scrollCue(0, 400, 120)).toEqual({ above: false, below: true });
    expect(scrollCue(100, 400, 120)).toEqual({ above: true, below: true });
    expect(scrollCue(280, 400, 120)).toEqual({ above: true, below: false });
  });

  it('a pixel’s rounding isn’t more', () => {
    expect(scrollCue(0.5, 120.6, 120)).toEqual({ above: false, below: false });
  });
});
