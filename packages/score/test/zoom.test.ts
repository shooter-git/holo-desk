import { describe, expect, it } from 'vitest';
import { fewColours, type Gray, overview, placeName, type Rgb, stavesOf, zoomSystem } from '../src/index.ts';

/** A strip of paper with staves drawn on it: each staff's top line, how far its lines fall across it. */
function strip(w: number, h: number, tops: number[], gap = 12, fall = 0): Gray {
  const data = new Uint8Array(w * h).fill(240);
  for (const top of tops) {
    for (let i = 0; i < 5; i++) {
      for (let x = 20; x < w - 20; x++) {
        const y = Math.round(top + i * gap + (fall * x) / w);
        data[y * w + x] = 20;
        data[(y + 1) * w + x] = 20;
      }
    }
    // a bar line down the staff's left edge, and a few noteheads on its lines and spaces
    for (let y = top; y <= top + 4 * gap; y++) data[y * w + 20] = data[y * w + 21] = 20;
    for (let x = 120; x < w - 60; x += 140) {
      const cy = top + ((x / 140) % 9) * (gap / 2);
      for (let dy = -4; dy <= 4; dy++)
        for (let dx = -6; dx <= 6; dx++) if (dx * dx + dy * dy * 2 <= 36) data[Math.round(cy + dy) * w + x + dx] = 20;
    }
  }
  return { w, h, data };
}

const BLUE = [40, 110, 255];
const isBlue = (img: Rgb, x: number, y: number) => {
  const i = (Math.round(y) * img.w + Math.round(x)) * 3;
  return img.data[i] === BLUE[0] && img.data[i + 1] === BLUE[1] && img.data[i + 2] === BLUE[2];
};
const margin = 58;

describe('a system zoomed for the agent', () => {
  it('is enlarged in overlapping parts, none bigger than a model is shown', () => {
    const s = strip(1900, 260, [60, 160]);
    const z = zoomSystem(s, { clefs: ['treble', 'bass'] });
    expect(z.staves).toHaveLength(2);
    expect(z.scale).toBeCloseTo(34 / z.space, 1);
    expect(z.parts.length).toBeGreaterThan(1);
    for (const p of z.parts) {
      expect(Math.max(p.img.w, p.img.h)).toBeLessThanOrEqual(1560);
      expect(p.img.w * p.img.h).toBeLessThanOrEqual(1_150_000);
    }
    // left to right, each repeating the end of the one before, the last reaching the strip's end
    expect(z.parts[0]?.x0).toBe(0);
    expect(z.parts.at(-1)?.x1).toBe(s.w);
    for (let i = 1; i < z.parts.length; i++) expect(z.parts[i]?.x0).toBeLessThan(z.parts[i - 1]?.x1 as number);
    expect(z.pitches).toBe(true);
  });

  it('draws every staff line over in blue, following the page as it bends', () => {
    // the lines fall 8 px across the strip, as a curled page bends them
    const s = strip(1900, 260, [60, 160], 12, 8);
    const z = zoomSystem(s, {});
    expect(z.staves).toHaveLength(2);
    for (const p of z.parts) {
      for (const top of [60, 160]) {
        for (let i = 0; i < 5; i++) {
          // near the part's left and right edges, where the page's line is there (it's drawn 2 px thick)
          for (const x of [p.x0 + 30, p.x1 - 30]) {
            const pageY = top + i * 12 + 0.5 + (8 * x) / s.w;
            const near = [-3, -2, -1, 0, 1, 2, 3].some((d) =>
              isBlue(p.img, margin + (x - p.x0) * z.scale, (pageY - p.y0) * z.scale + d),
            );
            expect(near, `line ${i} of the staff at ${top}, x ${x}`).toBe(true);
          }
        }
      }
    }
  });

  it('marks ledger lines out to the sixth above and below a staff on its own', () => {
    const s = strip(1900, 300, [120]);
    const z = zoomSystem(s, {});
    const p = z.parts[0] as (typeof z.parts)[number];
    const orange = (y: number) => {
      let n = 0;
      for (let x = margin; x < p.img.w - margin; x++) {
        const i = (Math.round(y) * p.img.w + x) * 3;
        if (p.img.data[i] === 235 && p.img.data[i + 1] === 130 && p.img.data[i + 2] === 20) n++;
      }
      return n;
    };
    // the sixth ledger line above (six spaces over the top line) and below (six under the bottom)
    for (const pageY of [120 - 6 * 12 + 0.5, 120 + 4 * 12 + 6 * 12 + 0.5]) {
      const y = (pageY - p.y0) * z.scale;
      expect(Math.max(...[-2, -1, 0, 1, 2].map((d) => orange(y + d)))).toBeGreaterThan(50);
    }
  });

  it('names lines and spaces by place, not pitch, when the clefs given don’t match the staves found', () => {
    const s = strip(1900, 260, [60, 160]);
    expect(zoomSystem(s, { clefs: ['treble'] }).pitches).toBe(false);
    expect(zoomSystem(s, { clefs: ['treble', 'bass', 'bass'] }).pitches).toBe(false);
    expect(zoomSystem(s, {}).pitches).toBe(false);
  });

  it('draws nothing over the music without guides', () => {
    const z = zoomSystem(strip(1900, 260, [60, 160]), { guides: false });
    const p = z.parts[0] as (typeof z.parts)[number];
    let blue = 0;
    for (let i = 0; i < p.img.data.length; i += 3)
      if (p.img.data[i] === BLUE[0] && p.img.data[i + 2] === BLUE[2]) blue++;
    expect(blue).toBe(0);
  });

  it('cuts a tall system across too, a group of staves to a part', () => {
    const tops = [40, 140, 240, 340, 440, 540, 640, 740];
    const z = zoomSystem(strip(1400, 840, tops), {});
    expect(z.staves).toHaveLength(8);
    const rows = new Set(z.parts.map((p) => p.y0));
    expect(rows.size).toBeGreaterThan(1);
    // every staff is in some part
    expect(new Set(z.parts.flatMap((p) => p.staves))).toEqual(new Set([0, 1, 2, 3, 4, 5, 6, 7]));
    for (const p of z.parts) expect(Math.max(p.img.w, p.img.h)).toBeLessThanOrEqual(1560);
  });

  it('keeps all of a tall system in its parts: far above its first staff, below its last, between two far apart', () => {
    // eight staves, the first with notes up to eight spaces over it, two of them 14 spaces apart
    const tops = [120, 220, 320, 420, 520, 620, 788, 888];
    const z = zoomSystem(strip(1400, 1050, tops), {});
    expect(z.staves).toHaveLength(8);
    expect(new Set(z.parts.map((p) => p.y0)).size).toBeGreaterThan(1);
    const covered = new Uint8Array(1050);
    for (const p of z.parts) covered.fill(1, p.y0, p.y1);
    // every row from eight spaces over the first staff to six under the last is in some part
    expect(covered.subarray(120 - 8 * 12, 888 + 48 + 6 * 12).every((v) => v === 1)).toBe(true);
  });

  it('shows a closer look twice as large, music printed small too', () => {
    for (const gap of [6, 8, 12]) {
      const s = strip(1200, 30 + 4 * gap + 30, [30], gap);
      const first = zoomSystem(s, {});
      const closer = zoomSystem(s, { space: 68 });
      expect(first.staves).toHaveLength(1);
      expect(closer.scale / first.scale, `staff space ${gap}`).toBeCloseTo(2, 1);
    }
  });

  it('gives no parts for a strip with no staff on it', () => {
    const blank: Gray = { w: 2400, h: 700, data: new Uint8Array(2400 * 700).fill(240) };
    expect(zoomSystem(blank, {}).parts).toEqual([]);
  });

  it('cuts narrower parts when asked, each still repeating a notehead’s width of the one before', () => {
    const s = strip(1900, 260, [60, 160]);
    const wide = zoomSystem(s, {});
    const narrow = zoomSystem(s, { maxWidth: 380 });
    expect(narrow.parts.length).toBeGreaterThan(wide.parts.length);
    for (const p of narrow.parts) expect(p.img.w).toBeLessThanOrEqual(380);
    expect(narrow.parts[0]?.x0).toBe(0);
    expect(narrow.parts.at(-1)?.x1).toBe(s.w);
    // two staff spaces of the strip at least, where a share of so narrow a part would be less
    for (let i = 1; i < narrow.parts.length; i++) {
      const lap = (narrow.parts[i - 1]?.x1 as number) - (narrow.parts[i]?.x0 as number);
      expect(lap).toBeGreaterThanOrEqual(2 * narrow.space - 1);
    }
    // parts cut no narrower repeat a share of each, as they did: a closer look's pieces too, though that's
    // under two of its staff spaces
    const lap = (wide.parts[0]?.x1 as number) - (wide.parts[1]?.x0 as number);
    expect(lap).toBeGreaterThan(4 * wide.space);
    // (a closer look's pieces too: as many as a share of each makes, though that's under two of its spaces)
    const closer = zoomSystem(strip(600, 260, [60, 160]), { space: 68 });
    const span = (closer.parts[0]?.x1 as number) - (closer.parts[0]?.x0 as number);
    const rows = new Set(closer.parts.map((p) => p.y0)).size;
    expect(span * 0.12).toBeLessThan(2 * closer.space);
    expect(closer.parts).toHaveLength(rows * (Math.ceil((600 - span) / Math.floor(span * 0.88)) + 1));
  });

  it('puts a part in a few flat colours: paper white under a shadow, ink dark, the guides their own', () => {
    // a page darker toward its right edge, as under a lamp
    const s = strip(1900, 260, [60, 160]);
    for (let y = 0; y < s.h; y++)
      for (let x = 0; x < s.w; x++)
        s.data[y * s.w + x] = Math.round((s.data[y * s.w + x] as number) * (1 - 0.4 * (x / s.w)));
    const z = zoomSystem(s, { clefs: ['treble', 'bass'] });
    const part = z.parts.at(-1) as (typeof z.parts)[number];
    for (const greys of [4, 2] as const) {
      const few = fewColours(part.img, greys, part.margin);
      expect(few.palette).toHaveLength(greys + 3);
      expect(few.palette[0]).toEqual([255, 255, 255]);
      expect(few.palette.slice(-3)).toEqual([
        [40, 110, 255],
        [30, 160, 70],
        [235, 130, 20],
      ]);
      const count = new Array(few.palette.length).fill(0);
      for (const v of few.data) count[v]++;
      // mostly paper, though the page there is two thirds as light; some ink; every guide colour
      expect(count[0] / few.data.length).toBeGreaterThan(0.6);
      expect(count[greys - 1]).toBeGreaterThan(200);
      for (const guide of [greys, greys + 1, greys + 2]) expect(count[guide]).toBeGreaterThan(100);
      // a guide's pixel stays that guide's colour
      for (let i = 0; i < few.data.length; i += 97) {
        const px = [part.img.data[i * 3], part.img.data[i * 3 + 1], part.img.data[i * 3 + 2]];
        if (isBlue(part.img, i % part.img.w, Math.floor(i / part.img.w)))
          expect(few.palette[few.data[i] as number]).toEqual(px);
      }
    }
  });

  it('takes a strip’s staves as given, where a stretch of it is too narrow to find them by', () => {
    const s = strip(1900, 260, [60, 160], 12, 8);
    const found = stavesOf(s);
    expect(found.staves).toHaveLength(2);
    const whole = zoomSystem(s, {});
    expect(whole.curves).toHaveLength(2);
    // 90 columns from the strip's right, where its lines have fallen most: the staves moved there
    const x0 = 1700;
    const crop: Gray = { w: 90, h: s.h, data: new Uint8Array(90 * s.h) };
    for (let y = 0; y < s.h; y++) crop.data.set(s.data.subarray(y * s.w + x0, y * s.w + x0 + 90), y * 90);
    const staves = found.staves.map((staff, i) => ({
      lines: staff.lines.map((y) => y + ((whole.curves[i] as Float32Array)[x0 + 45] as number)),
      left: 0,
      right: 89,
    }));
    const near = zoomSystem(crop, { clefs: ['treble', 'bass'], found: { staves, space: found.space }, space: 68 });
    expect(near.staves).toHaveLength(2);
    expect(near.pitches).toBe(true);
    // each staff's top line drawn over where the page has it in the stretch (within a row of the strip)
    [60, 160].forEach((top, staff) => {
      const p = near.parts.find((q) => q.staves.includes(staff)) as (typeof near.parts)[number];
      const pageY = top + 0.5 + (8 * (x0 + 45)) / s.w;
      const y = (pageY - p.y0 + 0.5) * near.scale - 0.5;
      const x = p.margin + (45 - p.x0) * near.scale;
      const reach = Math.ceil(near.scale * 1.5);
      const drawn = Array.from({ length: reach * 2 + 1 }, (_, k) => k - reach).some((d) => isBlue(p.img, x, y + d));
      expect(drawn, `staff ${staff}`).toBe(true);
    });
  });

  it('keeps a dark edge ink, not paper', () => {
    // a band along the strip's right end with no paper in it (the desk under the page's edge)
    const s = strip(1900, 260, [60, 160]);
    let seed = 5;
    for (let y = 0; y < s.h; y++)
      for (let x = s.w - 70; x < s.w; x++) {
        seed = (seed * 1103515245 + 12345) & 0x7fffffff;
        s.data[y * s.w + x] = 20 + (seed % 40);
      }
    const z = zoomSystem(s, {});
    const part = z.parts.at(-1) as (typeof z.parts)[number];
    const few = fewColours(part.img, 4, part.margin);
    // the band's pixels, at the part's right end before its margin: ink and the darker grey, no paper
    let light = 0;
    let all = 0;
    for (let y = 0; y < few.h; y += 3)
      for (let x = few.w - part.margin - 100; x < few.w - part.margin - 10; x += 3) {
        const v = few.data[y * few.w + x] as number;
        if (v > 3) continue;
        all++;
        if (v < 2) light++;
      }
    expect(light / all).toBeLessThan(0.02);
  });

  it('shows a strip whole and small', () => {
    const s = strip(1900, 260, [60, 160]);
    const small = overview(s, 640);
    expect(small.w).toBeLessThanOrEqual(640);
    expect(small.w / small.h).toBeCloseTo(s.w / s.h, 0);
    // (a strip narrower than asked stays as it is)
    expect(overview(s, 4000).w).toBe(1900);
    // no guide on it: only the shades in its palette
    expect(fewColours(small, 2).palette).toEqual([
      [255, 255, 255],
      [0, 0, 0],
    ]);
    expect(fewColours(small, 4).palette).toHaveLength(4);
  });

  it('names a staff’s lines and spaces as written, by clef', () => {
    expect(placeName(0, 'treble')).toBe('E4');
    expect(placeName(8, 'treble')).toBe('F5');
    expect(placeName(10, 'treble')).toBe('A5');
    // a treble clef with an 8 under it is written as a treble staff (the score text's pitches are written)
    expect(placeName(0, 'treble8')).toBe('E4');
    expect(placeName(0, 'bass')).toBe('G2');
    expect(placeName(-2, 'bass')).toBe('E2');
    expect(placeName(4, 'alto')).toBe('C4');
    expect(placeName(6, 'tenor')).toBe('C4');
    expect(placeName(3, undefined)).toBe('S2');
    expect(placeName(12, undefined)).toBe('+2');
    expect(placeName(11, undefined)).toBe('');
  });
});
