import { describe, expect, it } from 'vitest';
import { type Gray, type Rgb, zoomSystem } from '../src/index.ts';

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
});
