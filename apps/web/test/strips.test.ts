import { PLUGINS } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { slotName } from '../src/ui/strips.ts';

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
