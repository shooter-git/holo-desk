import { describe, expect, it } from 'vitest';
import { centredRange, drawMiniNotes, rangeOf } from '../src/ui/mini-notes.ts';

/** Where drawMiniNotes puts each note: the y of the bar it fills. */
function ys(notes: { t: number; d: number; p: number }[], range: { lo: number; hi: number }, h = 36): number[] {
  const out: number[] = [];
  const ctx = { fillRect: (_x: number, y: number) => out.push(y) } as unknown as CanvasRenderingContext2D;
  drawMiniNotes(ctx, notes, 960, { x: 0, y: 4, w: 300, h }, range);
  return out;
}

describe('a reply’s strip of notes', () => {
  it('draws a line on one pitch across its middle, not along its floor', () => {
    const held = [{ t: 0, d: 960, p: 36 }];
    const [low] = ys(held, rangeOf(held));
    const [mid] = ys(held, centredRange(rangeOf(held)));
    // (1 is the half-height of a note's bar: its middle is where the pitch is)
    expect(low).toBeGreaterThan(4 + 36 * 0.9);
    expect((mid ?? 0) + 1).toBeCloseTo(4 + 36 / 2, 5);
  });

  it('keeps notes an octave or more apart, and none at all, as they are', () => {
    expect(centredRange({ lo: 36, hi: 37 })).toEqual({ lo: 31, hi: 42 });
    expect(centredRange({ lo: 40, hi: 60 })).toEqual({ lo: 40, hi: 60 });
    expect(centredRange({ lo: 48, hi: 59 })).toEqual({ lo: 48, hi: 59 });
    expect(centredRange(rangeOf([]))).toEqual(rangeOf([]));
  });
});
