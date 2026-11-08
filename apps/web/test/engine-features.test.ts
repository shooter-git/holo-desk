import { describe, expect, it } from 'vitest';
import { playsClickSounds } from '../src/audio/engine-features.ts';

describe('what an HO[LO] Engine can do', () => {
  it('plays the metronome’s sounds from 0.6.2', () => {
    for (const v of ['0.6.2', '0.6.10', '0.7.0', '1.0.0', '0.6.2-dev']) expect(playsClickSounds(v), v).toBe(true);
    for (const v of ['0.6.1', '0.6.0', '0.5.9', '', 'x']) expect(playsClickSounds(v), v).toBe(false);
  });
});
