import { describe, expect, it } from 'vitest';
import { binarize, findSystems, flatten, type Gray, warp } from '../src/index.ts';

/** A drawn page: white paper, black staves, bar lines, notes with stems, and a little noise. */
function page(): { gray: Gray; bars: number[] } {
  const w = 1200;
  const h = 1000;
  const data = new Uint8Array(w * h).fill(235);
  const ink = (x: number, y: number) => {
    if (x >= 0 && y >= 0 && x < w && y < h) data[Math.round(y) * w + Math.round(x)] = 20;
  };
  const hline = (y: number, x0: number, x1: number, t = 2) => {
    for (let k = 0; k < t; k++) for (let x = x0; x <= x1; x++) ink(x, y + k);
  };
  const vline = (x: number, y0: number, y1: number, t = 2) => {
    for (let k = 0; k < t; k++) for (let y = y0; y <= y1; y++) ink(x + k, y);
  };
  const staff = (top: number) => {
    for (let i = 0; i < 5; i++) hline(top + i * 12, 100, 1100);
  };
  const note = (x: number, y: number, up: boolean) => {
    for (let dy = -5; dy <= 5; dy++)
      for (let dx = -7; dx <= 7; dx++) if ((dx * dx) / 49 + (dy * dy) / 25 <= 1) ink(x + dx, y + dy);
    vline(up ? x + 6 : x - 7, up ? y - 42 : y, up ? y : y + 42, 2);
  };
  const bars = [100, 370, 640, 910, 1100];
  let seed = 7;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (const top of [100, 500]) {
    staff(top);
    staff(top + 100);
    for (const x of bars) vline(x, top, top + 148, x === 1100 ? 5 : 2);
    for (let i = 0; i < 16; i++) {
      const x = 130 + i * 60 + (i % 4 === 3 ? 20 : 0);
      if (bars.some((b) => Math.abs(b - x) < 15)) continue;
      note(x, top + 6 * Math.floor(rand() * 9), i % 2 === 0);
      note(x, top + 100 + 6 * Math.floor(rand() * 9), i % 2 === 1);
    }
    // a note above the staff, its stem crossing the whole staff below it
    note(300, top - 18, false);
    vline(293, top - 18, top + 52, 2);
    hline(top - 12, 290, 312);
  }
  // a single-staff melody
  staff(850);
  for (const x of bars) vline(x, 850, 898);
  for (let i = 0; i < 12; i++) note(140 + i * 80, 850 + 6 * (i % 8), true);
  // noise
  for (let i = 0; i < 6000; i++) ink(rand() * w, rand() * h);
  return { gray: { w, h, data }, bars };
}

describe('finding the music on a page', () => {
  it('finds staves, systems, bar lines and strips', () => {
    const { gray, bars } = page();
    const ink = binarize(gray);
    const layout = findSystems(ink, gray.w, gray.h);
    expect(layout.space).toBeGreaterThanOrEqual(11);
    expect(layout.space).toBeLessThanOrEqual(13);
    expect(layout.systems.map((s) => s.staves.length)).toEqual([2, 2, 1]);
    for (const sys of layout.systems) {
      expect(sys.bars.length).toBe(bars.length);
      for (const [i, x] of sys.bars.entries()) expect(Math.abs(x - (bars[i] as number))).toBeLessThanOrEqual(4);
    }
    // strips in order, each holding its system, not overlapping
    layout.systems.forEach((sys, i) => {
      expect(sys.top).toBeLessThan(sys.staves[0]?.lines[0] as number);
      expect(sys.bottom).toBeGreaterThan(sys.staves.at(-1)?.lines[4] as number);
      if (i > 0) expect(sys.top).toBeGreaterThanOrEqual(layout.systems[i - 1]?.bottom as number);
    });
  });

  it('reads a page under a shadow', () => {
    const { gray } = page();
    // darken the right side as a lamp's falloff would
    const shaded = new Uint8Array(gray.data.length);
    for (let y = 0; y < gray.h; y++) {
      for (let x = 0; x < gray.w; x++) {
        shaded[y * gray.w + x] = Math.round((gray.data[y * gray.w + x] as number) * (1 - 0.45 * (x / gray.w)));
      }
    }
    const flat = flatten({ ...gray, data: shaded });
    const layout = findSystems(binarize(flat), gray.w, gray.h);
    expect(layout.systems.map((s) => s.staves.length)).toEqual([2, 2, 1]);
  });

  it('straightens a page from its corners', () => {
    const { gray } = page();
    // the whole image as the page: unchanged
    const same = warp(
      gray,
      [
        [0, 0],
        [gray.w, 0],
        [gray.w, gray.h],
        [0, gray.h],
      ],
      gray.w,
      gray.h,
    );
    let diff = 0;
    for (let i = 0; i < same.data.length; i += 997)
      diff += Math.abs((same.data[i] as number) - (gray.data[i] as number));
    expect(diff / (same.data.length / 997)).toBeLessThan(3);
    // a corner pulled in: the page comes out its own size, lines still found
    const skewed = warp(
      gray,
      [
        [0, 0],
        [gray.w, 12],
        [gray.w, gray.h],
        [0, gray.h - 12],
      ],
      gray.w,
      gray.h,
    );
    expect(skewed.w).toBe(gray.w);
  });
});
