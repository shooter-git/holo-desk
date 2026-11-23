import { describe, expect, it } from 'vitest';
import {
  binarize,
  type FoundSystem,
  findPage,
  findSystems,
  flatten,
  type Gray,
  homography,
  level,
  skewAngle,
  warp,
} from '../src/index.ts';

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

/** Draws on a page: a straight stroke t pixels thick, in ink, or in paper to rub out. */
function stroke(g: Gray, from: [number, number], to: [number, number], t = 2, value = 20) {
  const steps = Math.max(1, Math.abs(to[0] - from[0]), Math.abs(to[1] - from[1]));
  for (let i = 0; i <= steps; i++) {
    const x = Math.round(from[0] + ((to[0] - from[0]) * i) / steps);
    const y = Math.round(from[1] + ((to[1] - from[1]) * i) / steps);
    for (let dy = 0; dy < t; dy++) for (let dx = 0; dx < t; dx++) g.data[(y + dy) * g.w + x + dx] = value;
  }
}
const paper = 235;

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

  it('finds a staff whose faint line the photo lost', () => {
    const { gray } = page();
    // rub out the second line of the very first staff (it's at y 112, two pixels thick)
    for (let y = 112; y < 114; y++) for (let x = 0; x < gray.w; x++) gray.data[y * gray.w + x] = 235;
    const layout = findSystems(binarize(gray), gray.w, gray.h);
    expect(layout.systems.map((s) => s.staves.length)).toEqual([2, 2, 1]);
    expect(Math.round(layout.systems[0]?.staves[0]?.lines[1] ?? 0)).toBeGreaterThanOrEqual(111);
  });

  it('finds staves past stray strokes among and near their lines', () => {
    const { gray } = page();
    // a long stroke between the first staff's second and third lines (at 112 and 124)
    stroke(gray, [300, 117], [900, 117]);
    // a dash two spaces above the second system's lower staff
    stroke(gray, [300, 576], [900, 576]);
    // the melody's fourth line caught at two heights, as on curled paper: its right half lower
    stroke(gray, [600, 886], [1100, 886], 2, paper);
    stroke(gray, [600, 891], [1100, 891]);
    const layout = findSystems(binarize(gray), gray.w, gray.h);
    expect(layout.systems.map((s) => s.staves.length)).toEqual([2, 2, 1]);
    const found = layout.systems.flatMap((s) => s.staves.map((st) => st.lines));
    [100, 200, 500, 600, 850].forEach((top, i) => {
      for (const [k, y] of (found[i] as number[]).entries())
        expect(Math.abs(y - (top + k * 12))).toBeLessThanOrEqual(1.5);
    });
  });

  it('joins a grand staff whose joining line slants or breaks', () => {
    const { gray, bars } = page();
    // the first system's line between its staves, slanting as a photo of curled paper bends it
    stroke(gray, [100, 150], [100, 198], 2, paper);
    stroke(gray, [100, 148], [107, 200]);
    // the second's broken by a faint print: two rows in every ten gone
    for (let y = 550; y < 600; y++) if (y % 10 >= 8) stroke(gray, [100, y], [101, y], 1, paper);
    const layout = findSystems(binarize(gray), gray.w, gray.h);
    expect(layout.systems.map((s) => s.staves.length)).toEqual([2, 2, 1]);
    for (const sys of layout.systems) expect(sys.bars.length).toBe(bars.length);
  });

  it('keeps apart two systems with only a stem and a word between them', () => {
    const { gray } = page();
    // the second system's line between its staves rubbed out: two staves on their own
    stroke(gray, [100, 549], [100, 599], 2, paper);
    // at the left between them: a note on the upper staff's bottom line, its stem down three and
    // a half spaces; a stem up from the lower staff; a scribbled word
    stroke(gray, [106, 546], [116, 546], 5);
    stroke(gray, [105, 548], [105, 590]);
    stroke(gray, [94, 600], [94, 574]);
    stroke(gray, [62, 566], [70, 580]);
    stroke(gray, [70, 580], [78, 566]);
    stroke(gray, [80, 572], [90, 572]);
    const layout = findSystems(binarize(gray), gray.w, gray.h);
    expect(layout.systems.map((s) => s.staves.length)).toEqual([2, 1, 1, 1]);
  });

  it('finds a short last system, stopping well before the right margin', () => {
    const w = 1200;
    const h = 600;
    const data = new Uint8Array(w * h).fill(235);
    const gray: Gray = { w, h, data };
    // a full system, then the last: a staff a third as wide, at the left, with its notes and bar lines
    for (const [top, right] of [
      [150, 1100],
      [400, 480],
    ] as const) {
      for (let i = 0; i < 5; i++) stroke(gray, [100, top + i * 12], [right, top + i * 12]);
      for (const x of [100, (100 + right) / 2, right]) stroke(gray, [x, top], [x, top + 48]);
      for (let x = 140; x < right - 20; x += 50) stroke(gray, [x, top + 18], [x + 9, top + 18], 8);
    }
    const layout = findSystems(binarize(gray), w, h);
    expect(layout.systems.map((s) => s.staves.length)).toEqual([1, 1]);
    expect(Math.round((layout.systems[1]?.staves[0]?.lines[0] ?? 0) - 400)).toBeLessThanOrEqual(2);
  });

  it('finds a short last system on a curled page, its lines sloping', () => {
    const w = 1200;
    const h = 600;
    const gray: Gray = { w, h, data: new Uint8Array(w * h).fill(235) };
    // the full system level; the short one (a quarter of the page) its lines dropping 10 px, as curl bends them
    for (let i = 0; i < 5; i++) stroke(gray, [100, 150 + i * 12], [1100, 150 + i * 12]);
    for (let i = 0; i < 5; i++) stroke(gray, [100, 400 + i * 12], [400, 410 + i * 12]);
    for (const x of [100, 250, 400]) stroke(gray, [x, 400 + ((x - 100) / 300) * 10], [x, 448 + ((x - 100) / 300) * 10]);
    const layout = findSystems(binarize(gray), w, h);
    expect(layout.systems.map((s) => s.staves.length)).toEqual([1, 1]);
  });

  it('gives the first and last strips room for notes on many ledger lines, up to clear paper', () => {
    const w = 1200;
    const h = 900;
    const gray: Gray = { w, h, data: new Uint8Array(w * h).fill(235) };
    // two single staves, a melody climbing seven ledger lines above the first and falling seven below
    // the last; a title further up, clear paper between
    for (const top of [300, 560]) {
      for (let i = 0; i < 5; i++) stroke(gray, [100, top + i * 12], [1100, top + i * 12]);
      for (const x of [100, 600, 1100]) stroke(gray, [x, top], [x, top + 48]);
    }
    for (let k = 1; k <= 7; k++) {
      // a note on the k-th ledger line, every ledger line under it drawn
      const x = 150 + k * 50;
      for (let j = 1; j <= k; j++) {
        stroke(gray, [x - 9, 300 - j * 12], [x + 9, 300 - j * 12]);
        stroke(gray, [x - 9, 608 + j * 12], [x + 9, 608 + j * 12]);
      }
      stroke(gray, [x - 5, 300 - k * 12 - 3], [x + 5, 300 - k * 12 - 3], 6);
      stroke(gray, [x - 5, 608 + k * 12 - 3], [x + 5, 608 + k * 12 - 3], 6);
    }
    stroke(gray, [400, 120], [800, 120], 14);
    const layout = findSystems(binarize(gray), w, h);
    expect(layout.systems.map((s) => s.staves.length)).toEqual([1, 1]);
    const [first, last] = layout.systems as [FoundSystem, FoundSystem];
    // the highest note's head (rows 213–219) and the lowest's (689–695) are in; the title isn't
    expect(first.top).toBeLessThan(210);
    expect(first.top).toBeGreaterThan(134);
    expect(last.bottom).toBeGreaterThan(698);
  });

  it('keeps apart two systems with a stroke slanting across the gap at their left', () => {
    const { gray } = page();
    stroke(gray, [100, 549], [100, 599], 2, paper);
    // a slur's end, or a scribble, from the upper staff down to the lower one: at 45°, and at 30°
    // from upright
    stroke(gray, [100, 548], [152, 600]);
    stroke(gray, [104, 548], [134, 600]);
    const layout = findSystems(binarize(gray), gray.w, gray.h);
    expect(layout.systems.map((s) => s.staves.length)).toEqual([2, 1, 1, 1]);
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

/** A photo of a page: the page seen in perspective on a gray table, a shadow over part of it. */
function photograph(paper: Gray, quad: [number, number][], w: number, h: number): Gray {
  // the page's corners land on the quad: for each pixel of the photo, where on the page it is
  const H = homography(
    quad as [[number, number], [number, number], [number, number], [number, number]],
    paper.w,
    paper.h,
  );
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, k = 0] = H;
  // invert the 3×3 (photo → page)
  const det = a * (e - f * k) - b * (d - f * g) + c * (d * k - e * g);
  const inv = [
    [(e - f * k) / det, (c * k - b) / det, (b * f - c * e) / det],
    [(f * g - d) / det, (a - c * g) / det, (c * d - a * f) / det],
    [(d * k - e * g) / det, (b * g - a * k) / det, (a * e - b * d) / det],
  ] as [number, number, number][];
  const [r0, r1, r2] = inv as [[number, number, number], [number, number, number], [number, number, number]];
  const data = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const z = r2[0] * x + r2[1] * y + r2[2];
      const u = Math.round((r0[0] * x + r0[1] * y + r0[2]) / z);
      const v = Math.round((r1[0] * x + r1[1] * y + r1[2]) / z);
      const on = u >= 0 && v >= 0 && u < paper.w && v < paper.h;
      let value = on ? (paper.data[v * paper.w + u] as number) : 150;
      if (x > w * 0.7) value = Math.round(value * 0.72);
      data[y * w + x] = value;
    }
  }
  return { w, h, data };
}

describe('a photographed page', () => {
  it('is found, straightened and read', () => {
    const { gray, bars } = page();
    const photo = photograph(
      gray,
      [
        [90, 60],
        [1250, 25],
        [1290, 1080],
        [40, 1110],
      ],
      1340,
      1160,
    );
    const corners = findPage(photo);
    expect(corners).not.toBeNull();
    const quad = corners as [[number, number], [number, number], [number, number], [number, number]];
    const expected: [number, number][] = [
      [90, 60],
      [1250, 25],
      [1290, 1080],
      [40, 1110],
    ];
    expected.forEach(([x, y], i) => {
      const [qx, qy] = quad[i] as [number, number];
      expect(Math.hypot(qx - x, qy - y)).toBeLessThan(12);
    });
    let straight = flatten(warp(photo, quad, 1200, 1000));
    straight = level(straight, skewAngle(binarize(straight), 1200, 1000));
    const layout = findSystems(binarize(straight), 1200, 1000);
    expect(layout.systems.map((s) => s.staves.length)).toEqual([2, 2, 1]);
    for (const sys of layout.systems) expect(sys.bars.length).toBe(bars.length);
  });
});
