import { describe, expect, it } from 'vitest';
import { tapTempo } from '../src/ui/tap-tempo.ts';

/** Taps at these times, and the tempo after each. */
function run(times: number[]): (number | null)[] {
  const t = tapTempo();
  return times.map((ms) => t.tap(ms));
}

describe('tap tempo', () => {
  it('needs three taps in time before it gives a tempo', () => {
    expect(run([0, 500, 1000])).toEqual([null, null, 120]);
  });

  it('a single stray click after the first sets nothing', () => {
    expect(run([0, 1000])).toEqual([null, null]);
  });

  it('evens out an unsteady hand', () => {
    const out = run([0, 480, 1010, 1490, 2000, 2510]);
    expect(out.at(-1)).toBe(120);
  });

  it('ignores a double-click and a bounce', () => {
    expect(run([0, 120, 600, 1100])).toEqual([null, null, null, 109]);
    // (the 120 ms click is no beat: the gaps are 600 and 500)
  });

  it('starts over after a pause', () => {
    expect(run([0, 500, 1000, 5000, 5400, 5800])).toEqual([null, null, 120, null, null, 150]);
  });

  it('follows a new tempo instead of averaging it with the old one', () => {
    const out = run([0, 500, 1000, 1500, 1800, 2100, 2400]);
    expect(out.at(-1)).toBe(200);
  });

  it('a reset forgets the taps so far', () => {
    const t = tapTempo();
    t.tap(0);
    t.tap(500);
    t.reset();
    expect(t.tap(1000)).toBeNull();
    expect(t.tap(1500)).toBeNull();
    expect(t.tap(2000)).toBe(120);
  });
});
