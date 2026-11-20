import { Fm6Synth, fm6Patch } from '@holo/engine';
import { describe, expect, it } from 'vitest';
import {
  along,
  amountToUnit,
  COL_FILTER,
  COL_OUT,
  cellAt,
  cellCenter,
  cellKey,
  type EnvShape,
  envLayout,
  envPath,
  envY,
  filterResponse,
  hitCell,
  insertPoint,
  levelAt,
  matrixLayout,
  ROW_FILTER,
  removePoint,
  segWidth,
  timeOf,
  unitToAmount,
} from '../src/ui/fm6-view.ts';

describe("the six-operator window's matrix", () => {
  it('puts each operator where its row meets its column, the outputs and the filter beside them', () => {
    expect(cellAt(2, 2)).toEqual({ kind: 'node', op: 2 });
    expect(cellKey(cellAt(2, 2))).toBe('mod:3>3');
    expect(cellKey(cellAt(1, 0))).toBe('mod:2>1');
    expect(cellKey(cellAt(0, 5))).toBe('mod:1>6');
    expect(cellKey(cellAt(3, COL_OUT))).toBe('op4:out');
    expect(cellKey(cellAt(5, COL_FILTER))).toBe('op6:filter');
    expect(cellKey(cellAt(ROW_FILTER, 2))).toBe('mod:f>3');
    expect(cellKey(cellAt(ROW_FILTER, COL_OUT))).toBe('flt:out');
    expect(cellKey(cellAt(ROW_FILTER, COL_FILTER))).toBeNull();
  });

  it('finds the cell under a point, at a desktop width and a phone width', () => {
    for (const width of [570, 360]) {
      const L = matrixLayout(width);
      for (const [r, c] of [
        [0, 0],
        [4, 1],
        [6, 7],
      ] as const) {
        const [x, y] = cellCenter(L, r, c);
        expect(hitCell(L, x, y)).toEqual([r, c]);
        expect(hitCell(L, x + L.cw * 0.45, y - L.ch * 0.45)).toEqual([r, c]);
      }
      expect(hitCell(L, L.x0 - 2, L.y0 + 2)).toBeNull();
      expect(L.x0 * 2 + L.cw * 8).toBeLessThanOrEqual(width);
    }
  });

  it("gives a drag's travel to the small amounts, and comes back to the same amount", () => {
    for (const a of [0, 0.1, 1, 1.5, 7, 32]) expect(unitToAmount(amountToUnit(a, 32), 32)).toBeCloseTo(a, 6);
    // half the travel is 4 radians of 32
    expect(unitToAmount(0.5, 32)).toBeCloseTo(4, 6);
  });
});

describe("the six-operator window's envelopes", () => {
  const e: EnvShape = {
    n: 4,
    start: 0,
    t: [0.002, 0.4, 2, 0.3, 0, 0, 0, 0],
    l: [1, 0.5, 0.2, 0, 0, 0, 0, 0],
    c: [0, 0.6, -0.4, 0.7, 0, 0, 0, 0],
    sus: 2,
    loop: -1,
  };

  it('lays the points out left to right, each stretch as wide as its time, the held part after the sustain point', () => {
    const L = envLayout(e, 500, 130, false);
    const xs = L.points.map(([x]) => x);
    for (let k = 1; k < xs.length; k++) expect(xs[k] as number).toBeGreaterThan(xs[k - 1] as number);
    expect(L.held?.[0]).toBeCloseTo(xs[2] as number);
    expect(xs[3] as number).toBeLessThanOrEqual(500);
    // the longer stretch is the wider
    expect((xs[2] as number) - (xs[1] as number)).toBeGreaterThan((xs[1] as number) - (xs[0] as number));
    // and a level comes back from its height
    for (const v of [0, 0.25, 1]) expect(levelAt(L, envY(L, v))).toBeCloseTo(v, 6);
    for (const t of [0.001, 0.5, 30]) expect(timeOf(segWidth(t))).toBeCloseTo(t, 6);
  });

  it('draws each stretch along its curve, from one point to the next', () => {
    expect(along(0, 1, 0.6, 0)).toBeCloseTo(0);
    expect(along(0, 1, 0.6, 1)).toBeCloseTo(1);
    // bent up: past halfway at the middle; straight: halfway
    expect(along(0, 1, 0.6, 0.5)).toBeGreaterThan(0.5);
    expect(along(0, 1, 0, 0.5)).toBeCloseTo(0.5);
    const L = envLayout(e, 500, 130, false);
    const path = envPath(e, L);
    expect(path[0]).toEqual(L.start);
    expect(path[path.length - 1]).toEqual(L.points[3]);
  });

  it('adds a point halfway along a stretch, and takes one out, keeping the sustain point on its point', () => {
    const add = insertPoint(e, 0, 'env1');
    expect(add?.['env1:n']).toBe(5);
    expect(add?.['env1:t1']).toBeCloseTo(0.2);
    expect(add?.['env1:t2']).toBeCloseTo(0.2);
    expect(add?.['env1:sus']).toBe(3);
    const cut = removePoint(e, 1, 'env1');
    expect(cut?.['env1:n']).toBe(3);
    // its time goes to the stretch after it
    expect(cut?.['env1:t1']).toBeCloseTo(2.4);
    expect(cut?.['env1:sus']).toBe(1);
    expect(removePoint({ ...e, n: 1 }, 0, 'env1')).toBeNull();
  });
});

describe("the six-operator window's filter", () => {
  it('draws the response the engine plays', () => {
    const SR = 48000;
    const flt = { 'flt:cutoff': 1000, 'flt:res1': 0.6 };
    const level = (key: number) => {
      const s = new Fm6Synth(SR, 'Bright Tines', {
        'patch:blank': 1,
        'op1:on': 1,
        'op1:filter': 1,
        'flt:out': 1,
        'env1:sus': 0,
        ...flt,
      });
      s.noteOn(key, 100);
      const n = SR * 0.5;
      const l = new Float32Array(n);
      const r = new Float32Array(n);
      for (let at = 0; at < n; at += 128) s.render(l, r, at, Math.min(n, at + 128));
      let sum = 0;
      for (let i = SR * 0.25; i < n; i++) sum += (l[i] as number) ** 2;
      return Math.sqrt(sum / (n - SR * 0.25));
    };
    const hz = (key: number) => 440 * 2 ** ((key - 69) / 12);
    const p = fm6Patch('Bright Tines', { 'patch:blank': 1, 'flt:out': 1, ...flt });
    for (const key of [81, 93]) {
      const heard = 20 * Math.log10(level(key) / level(57));
      const [a, b] = filterResponse(p.flt, [hz(57), hz(key)], SR) as [number, number];
      expect(Math.abs(heard - (b - a)), `key ${key}`).toBeLessThan(0.5);
    }
  });
});
