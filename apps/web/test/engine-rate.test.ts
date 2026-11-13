import { describe, expect, it } from 'vitest';
import { engineRate } from '../src/audio/engine-rate.ts';

describe('the rate the engine plays at', () => {
  it("is the device's own up to 48 kHz", () => {
    expect(engineRate(44100)).toBe(44100);
    expect(engineRate(48000)).toBe(48000);
    expect(engineRate(32000, 48000)).toBe(32000);
  });

  it('is 48 kHz on a device running faster, for a song made at 48 or less', () => {
    expect(engineRate(96000)).toBe(48000);
    expect(engineRate(192000, 48000)).toBe(48000);
    expect(engineRate(88200, 44100)).toBe(48000);
  });

  it("goes up to the song's own rate when the song asks for more, and never past the device's", () => {
    expect(engineRate(96000, 96000)).toBe(96000);
    expect(engineRate(192000, 96000)).toBe(96000);
    expect(engineRate(96000, 192000)).toBe(96000);
  });
});
