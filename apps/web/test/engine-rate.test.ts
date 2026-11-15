import { describe, expect, it } from 'vitest';
import { chosenRate, engineRate } from '../src/audio/engine-rate.ts';

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

  it('is the rate chosen in Settings, whatever the device runs at', () => {
    expect(engineRate(48000, undefined, 44100)).toBe(44100);
    expect(engineRate(96000, 96000, 48000)).toBe(48000);
    expect(engineRate(44100, undefined, null)).toBe(44100);
  });
});

describe('the rate chosen in Settings › Audio', () => {
  it('is 44.1 kHz on a phone or a tablet when Automatic, and the device’s own elsewhere', () => {
    expect(chosenRate('auto', true)).toBe(44100);
    expect(chosenRate('auto', false)).toBeNull();
  });

  it('is the one chosen, on any device', () => {
    expect(chosenRate(48000, true)).toBe(48000);
    expect(chosenRate(44100, false)).toBe(44100);
  });

  it('is Automatic for anything else a device remembered', () => {
    expect(chosenRate(96000 as never, true)).toBe(44100);
    expect(chosenRate('fast' as never, false)).toBeNull();
  });
});
