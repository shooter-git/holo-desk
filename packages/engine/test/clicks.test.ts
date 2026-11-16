import { describe, expect, it } from 'vitest';
import { findClicks } from '../src/analysis/clicks.ts';

// The click measure: transients a sound has that its own sound around it doesn't explain, and its
// references don't have at the same place.

const SR = 48000;

/** A sung note: harmonics falling 12 dB an octave, on a vibrato, over a little hiss (a seeded noise), `seconds` long. */
function sung(hz: number, seconds: number, level = 0.3): Float32Array {
  let seed = 7;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) % 2147483648;
    return seed / 1073741824 - 1;
  };
  let phase = 0;
  return Float32Array.from({ length: Math.round(seconds * SR) }, (_, i) => {
    const t = i / SR;
    phase += (2 * Math.PI * hz * 2 ** ((0.3 * Math.sin(2 * Math.PI * 5.5 * t)) / 12)) / SR;
    let v = 0;
    for (let h = 1; h <= 12; h++) v += Math.sin(h * phase) / (h * h);
    return level * 0.7 * v + 0.0005 * noise();
  });
}

/** `x` faded out over `n` frames from `at` (silent after), linearly. */
function cut(x: Float32Array, at: number, n: number): Float32Array {
  return x.map((v, i) => (i < at ? v : i >= at + n ? 0 : v * (1 - (i - at) / n)));
}

/** `x` faded in over `n` frames from `at` (silent before). */
function start(x: Float32Array, at: number, n: number): Float32Array {
  return x.map((v, i) => (i < at ? 0 : i >= at + n ? v : (v * (i - at)) / n));
}

const near = (clicks: { frame: number }[], at: number, ms = 4) =>
  clicks.some((c) => Math.abs(c.frame - at) <= (ms / 1000) * SR);

describe('the click measure', () => {
  const note = sung(330, 1);
  const at = Math.round(0.5 * SR);

  it('finds a held note cut short over a ms or two, its sound to go on (a takeover, a block lost)', () => {
    const clicks = findClicks(cut(note, at, 64), SR, [note]);
    expect(near(clicks, at)).toBe(true);
    expect(clicks[0]?.kind).toBe('jump');
    const gap = note.slice().fill(0, at, at + 128);
    expect(near(findClicks(gap, SR, [note]), at)).toBe(true);
  });

  it('finds a step and a lone spike, in high frequencies', () => {
    const step = note.map((v, i) => (i >= at ? v + 0.05 : v));
    const spike = note.slice();
    spike[at] = (spike[at] as number) + 0.2;
    for (const x of [step, spike]) {
      const clicks = findClicks(x, SR, [note]);
      expect(near(clicks, at)).toBe(true);
    }
  });

  it('finds a start in the middle of a sound faded in over a few ms, not over 10', () => {
    expect(near(findClicks(start(note, at, 96), SR, [note]), at)).toBe(true);
    expect(findClicks(start(note, at, 480), SR, [note])).toEqual([]);
  });

  it('doesn’t count a fade over 10 ms, a voice’s own pulses, or what the reference has too', () => {
    expect(findClicks(cut(note, at, 480), SR, [note])).toEqual([]);
    // a low voice, its pulses each period
    const low = sung(98, 1, 0.4);
    expect(findClicks(low, SR, [low.map((v) => v * 0.9)])).toEqual([]);
    // a consonant's burst, in the recording too
    const t = note.slice();
    for (let i = at; i < at + 200; i++) t[i] = (t[i] as number) + 0.2 * Math.sin(i * 1.7) * (1 - (i - at) / 200);
    expect(near(findClicks(t, SR, []), at)).toBe(true);
    expect(findClicks(t, SR, [t])).toEqual([]);
  });

  it('judges nothing where no reference says anything (NaN), and the rest as it is', () => {
    const x = cut(note, at, 64);
    const blind = note.slice().fill(Number.NaN, at - 2000, at + 2000);
    expect(findClicks(x, SR, [blind])).toEqual([]);
  });
});
