import { describe, expect, it } from 'vitest';
import { GlassLineVoice, GlassVoice, planGlass, planGlassLine } from '../src/glass.ts';
import { type PerfInstrument, PlanVoice, planPart, type SampleData } from '../src/performance.ts';
import type { SamplerSpec, SampleZone } from '../src/protocol.ts';
import { Sampler } from '../src/sampler.ts';

const SR = 44100;

const same = (a: Float32Array, b: Float32Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/** A voice played from its start, and another joined late by skip(): the same samples from where they overlap. */
function lateJoin<
  V extends {
    done: boolean;
    render(l: Float32Array, r: Float32Array, from: number, to: number, offset?: number): boolean;
  },
>(make: () => V, at: number, late: number, n: number): [Float32Array, Float32Array] {
  const play = (from: number) => {
    const v = make();
    const L = new Float32Array(n);
    const R = new Float32Array(n);
    for (let f = from; f < n && !v.done; f += 128) v.render(L, R, f, Math.min(n, f + 128), f);
    return L;
  };
  const whole = play(Math.max(0, at));
  const joined = play(Math.max(0, at) + late);
  return [whole.subarray(Math.max(0, at) + late), joined.subarray(Math.max(0, at) + late)];
}

describe('a planned voice joined late', () => {
  it('glass sounds as it would have, breath and all', () => {
    const notes = [
      { t: 0.1, d: 2, p: 64, v: 0.6 },
      { t: 0.4, d: 1, p: 71, v: 0.4, x: { pan: 0.3 } },
    ];
    for (const o of [{ seed: 3 }, { seed: 4, breath: 0 }]) {
      for (const p of planGlass(notes, o, SR)) {
        const [a, b] = lateJoin(() => new GlassVoice(p, SR), p.at, 7001, SR * 3);
        expect(same(a, b)).toBe(true);
        expect(a.some((x) => x !== 0)).toBe(true);
      }
    }
  });

  it('a glass line sounds as it would have, through its glides', () => {
    const notes = [
      { t: 0, d: 0.5, p: 60, v: 0.5 },
      { t: 0.5, d: 0.5, p: 64, v: 0.7 },
      { t: 1.0, d: 0.8, p: 67, v: 0.6 },
    ];
    for (const p of planGlassLine(notes, { seed: 5 }, SR)) {
      const [a, b] = lateJoin(() => new GlassLineVoice(p, SR), p.at, 30011, SR * 3);
      expect(same(a, b)).toBe(true);
      expect(a.some((x) => x !== 0)).toBe(true);
    }
  });

  it('a performance note sounds as it would have, read straight or through a glide', () => {
    const n = SR * 2;
    const make = (f: number): SampleData => {
      const l = new Float32Array(n);
      for (let i = 0; i < n; i++) l[i] = Math.sin((2 * Math.PI * f * i) / SR) * 0.5 * Math.min(1, i / 200);
      return [l, l.slice()];
    };
    const row = (sample: number, midi: number) => ({
      sample,
      midi,
      layer: 1,
      start: 0,
      attack: 300,
      frames: n,
      tune: 0,
      gainDb: 0,
      loopStart: SR / 2,
      loopEnd: SR + SR / 2,
      loopRho: 0.95,
    });
    const inst: PerfInstrument = {
      name: 'test_sus',
      kind: 'sus',
      release: 0.4,
      lag: 0,
      maxLead: 0.06,
      legatoSkip: 0.16,
      xfade: 0.16,
      pan: 0,
      width: 0.8,
      maxAttack: 0,
      rows: [row(0, 60), row(1, 67)],
    };
    const data = [make(261.63), make(392)];
    // a copied read, an interpolated one that needs its loop, and a vibrato's glide
    const notes = [
      { t: 0.1, d: 0.5, p: 60, v: 0.6 },
      { t: 0.7, d: 3.5, p: 62, v: 0.5, x: { legato: false } },
      { t: 0.2, d: 1.5, p: 65, v: 0.7, x: { vib: { depth: 0.3, rate: 5 } } },
    ];
    const plans = planPart(inst, notes, { seed: 4, gainDb: 0, shape: { swell: 0.2, taper: 1, attack: 0.2 } }, SR);
    expect(plans.some((p) => p.copy)).toBe(true);
    expect(plans.some((p) => p.extend)).toBe(true);
    expect(plans.some((p) => p.glide)).toBe(true);
    for (const p of plans) {
      const [a, b] = lateJoin(() => new PlanVoice(p, data[p.row.sample] as SampleData, SR), p.at, 12345, SR * 5);
      expect(same(a, b)).toBe(true);
      expect(a.some((x) => x !== 0)).toBe(true);
    }
  });
});

describe('the sampler', () => {
  const zone = (lo: number, hi: number, lovel: number, hivel: number, mark: number): SampleZone => {
    // each zone's first sample says which it is
    const left = new Float32Array(64);
    left[1] = mark;
    return { left, right: null, root: 60, lo, hi, lovel, hivel, gain: 1, loopStart: 0, loopEnd: 0, rr: 0 };
  };
  const spec: SamplerSpec = {
    key: 't',
    zones: [zone(0, 64, 1, 127, 0.1), zone(0, 64, 1, 127, 0.2), zone(0, 64, 1, 127, 0.3), zone(65, 127, 1, 127, 0.4)],
    release: 0.05,
    oneShot: true,
    pitched: false,
    velocityRange: 0,
    attack: 0,
  };
  const played = (s: Sampler, key: number) => {
    s.noteOn(key, 127);
    const l = new Float32Array(4);
    const r = new Float32Array(4);
    s.render(l, r, 0, 4);
    s.allNotesOff(true);
    for (let i = 0; i < 64; i++) s.render(new Float32Array(4), new Float32Array(4), 0, 4);
    return Math.round((l[1] as number) * 10) / 10;
  };
  it('takes tied zones in turn, and the one zone that fits otherwise', () => {
    const s = new Sampler(SR, spec);
    expect([60, 60, 60, 60, 61].map((k) => played(s, k))).toEqual([0.1, 0.2, 0.3, 0.1, 0.2]);
    expect(played(s, 80)).toBe(0.4);
    expect(played(s, 80)).toBe(0.4);
  });
});
