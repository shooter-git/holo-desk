import { prismPatch } from '@holo/engine';
import { SRC_LFO, SRC_MACRO, TGT_F1_CUTOFF, TGT_FX, TGT_LEVEL, TGT_PITCH } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  depthText,
  envPoints,
  freeSlot,
  hitOverview,
  lfoPoints,
  linkRows,
  overviewLayout,
  padWeights,
  shapePoints,
  sourceFamily,
  sourceSummary,
} from '../src/ui/prism-view.ts';

describe("Prism's window", () => {
  it('hears each corner of the pad by how near the point is, all of it at a corner', () => {
    expect(padWeights(0, 0, false)).toEqual([1, 0, 0, 0]);
    expect(padWeights(1, 1, false)).toEqual([0, 0, 0, 1]);
    const mid = padWeights(0.5, 0.5, false);
    expect(mid.reduce((a, b) => a + b)).toBeCloseTo(1, 9);
    // equal power: the squares add up to one
    const p = padWeights(0.3, 0.7, true);
    expect(p.reduce((a, b) => a + b * b, 0)).toBeCloseTo(1, 9);
  });

  it('lays the four tiles around the pad on a desktop, and under each other on a phone, and finds what a point is on', () => {
    for (const width of [610, 360]) {
      const L = overviewLayout(width);
      expect(L.tiles).toHaveLength(4);
      for (const [i, t] of L.tiles.entries()) {
        expect(t.x + t.w).toBeLessThanOrEqual(width + 0.01);
        expect(hitOverview(L, t.x + t.w / 2, t.y + t.h / 2)).toEqual({ tile: i });
      }
      const hit = hitOverview(L, L.pad.x + L.pad.s * 0.25, L.pad.y + L.pad.s * 0.75);
      expect(hit && 'pad' in hit ? hit.pad.map((v) => +v.toFixed(2)) : null).toEqual([0.25, 0.75]);
      // the pad is between the tiles side by side, or under them
      if (width > 470) expect(L.pad.x).toBeGreaterThan(L.tiles[0]?.w ?? 0);
      else expect(L.pad.y).toBeGreaterThan((L.tiles[2]?.y ?? 0) + (L.tiles[2]?.h ?? 0));
    }
  });

  it('says what each source is in a few words', () => {
    const p = prismPatch('Drift Pad');
    expect(sourceSummary(p, 0)).toBe('7 saws, detuned');
    expect(sourceSummary(p, 1)).toBe('Voice partials');
    expect(sourceSummary(p, 2)).toBe('Grains of shimmer');
    expect(sourceSummary(p, 3)).toBe('One sine');
    expect(sourceSummary(prismPatch('Pulse Bells'), 2)).toBe('Off');
  });

  it('draws the LFO shapes in range, a ramp rising across each cycle', () => {
    for (let shape = 0; shape <= 6; shape++) {
      const pts = lfoPoints(shape, null, 2, 101);
      expect(pts).toHaveLength(101);
      for (const v of pts) expect(Math.abs(v)).toBeLessThanOrEqual(1);
    }
    const ramp = lfoPoints(2, null, 1, 11);
    expect(ramp[0]).toBeCloseTo(-1, 9);
    expect(ramp[5]).toBeCloseTo(0, 9);
    // a shape a sound brings, read straight across its points
    expect(lfoPoints(0, [0, 1, 0, -1], 1, 5).map((v) => +v.toFixed(3))).toEqual([0, 1, 0, -1, 0]);
  });

  it('draws an envelope rising, falling to its sustain, holding, and released to nothing', () => {
    const pts = envPoints({ a: 0.1, h: 0, d: 0.2, s: 0.5, r: 0.3, ac: 0, dc: 0, rc: 0 }, 0.4, 8);
    expect(pts[0]).toEqual([0, 0]);
    const at = (t: number) => pts.find(([x]) => Math.abs(x - t) < 1e-9)?.[1];
    expect(at(0.1)).toBeCloseTo(1, 9);
    expect(at(0.3)).toBeCloseTo(0.5, 9);
    expect(at(0.7)).toBeCloseTo(0.5, 9);
    expect(pts[pts.length - 1]?.[0]).toBeCloseTo(1, 9);
    expect(pts[pts.length - 1]?.[1]).toBeCloseTo(0, 9);
    // a shaped attack starts quickly
    const quick = envPoints({ a: 1, h: 0, d: 0, s: 1, r: 0, ac: 1, dc: 0, rc: 0 }, 0, 4);
    expect(quick[1]?.[1]).toBeGreaterThan(0.5);
  });

  it('bends a drawn shape between its points as the engine does, straight at no curve', () => {
    const pts = shapePoints([0, 1], [0, 1], [0, 0], 2, 4);
    expect(pts.map(([, y]) => y)).toEqual([0, 0.25, 0.5, 0.75, 1]);
    const bent = shapePoints([0, 1], [0, 1], [0.5, 0], 2, 4);
    expect(bent[2]?.[1]).toBeGreaterThan(0.5);
  });

  it('lists the links that do something, named for their effects, with their depth in the target’s terms', () => {
    const p = prismPatch('Pulse Bells');
    const rows = linkRows(p);
    expect(rows.length).toBeGreaterThan(5);
    expect(rows[0]).toMatchObject({ srcName: 'Velocity', dstName: 'Level' });
    expect(rows.some((r) => r.dstName === 'Reverb 6 mix')).toBe(true);
    expect(sourceFamily(SRC_LFO)).toBe('lfo');
    expect(sourceFamily(SRC_MACRO + 2)).toBe('macro');
    expect(depthText(TGT_PITCH, 1 / 8)).toBe('+12 st');
    expect(depthText(TGT_LEVEL, -0.5)).toBe('−50% of the way');
    expect(depthText(TGT_F1_CUTOFF, 0.25)).toMatch(/^\+2\.\d oct$/);
    expect(depthText(TGT_FX, 0.3)).toBe('+30%');
    expect(freeSlot(p)).toBe(rows.length);
  });
});
