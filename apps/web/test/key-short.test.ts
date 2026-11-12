import { describe, expect, it } from 'vitest';
import { keyShort } from '../src/ui/key-short.ts';

describe('a key written short', () => {
  it('writes it as a chord chart does', () => {
    expect(['D major', 'F# minor', 'Bb', 'Am', 'A lydian', 'E harmonic minor', 'G# major'].map(keyShort)).toEqual([
      'D',
      'F#m',
      'Bb',
      'Am',
      'A lyd',
      'Em',
      'G#',
    ]);
    expect(keyShort('no key')).toBe('no key');
  });
});
