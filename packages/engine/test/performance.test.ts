import { describe, expect, it } from 'vitest';
import { GlassLineVoice, GlassVoice, planGlass, planGlassLine } from '../src/glass.ts';
import { type PerfInstrument, PlanVoice, planPart, roundHalfEven, type SampleData } from '../src/performance.ts';
import { NumpyRandom, namedRandom } from '../src/random.ts';

const SR = 44100;

describe("numpy's random numbers", () => {
  it('draws what numpy draws from a named stream', () => {
    // np.random.default_rng(int.from_bytes(sha256(b"sampler|piano|8")[:8], "little")), drawn in this order
    const r = namedRandom('sampler', 'piano', 8);
    expect([r.random(), r.random(), r.random()]).toEqual([0.7608872594298725, 0.6983768488366395, 0.6696296188792653]);
    expect([r.standardNormal(), r.standardNormal(), r.standardNormal()]).toEqual([
      0.056692170701040795, -1.1397096003164997, 0.3360734893858439,
    ]);
    expect(Array.from({ length: 6 }, () => r.integers(0, 8))).toEqual([4, 2, 2, 5, 1, 1]);
    expect([r.uniform(3, 6), r.uniform(3, 6)]).toEqual([5.997040630681932, 4.249890262677783]);
  });

  it('draws what numpy draws from an integer seed', () => {
    const r = NumpyRandom.fromSeed(12345);
    expect(Array.from({ length: 4 }, () => r.standardNormal())).toEqual([
      -1.4238250364546312, 1.2637284581291104, -0.8706617379590857, -0.2591732349343976,
    ]);
  });

  it('a clone draws the same from there on', () => {
    const r = namedRandom('glass', 1, 3);
    r.standardNormal();
    const c = r.clone();
    expect(Array.from({ length: 5 }, () => c.standardNormal())).toEqual(
      Array.from({ length: 5 }, () => r.standardNormal()),
    );
  });

  it('rounds halves to even, as Python does', () => {
    expect([0.5, 1.5, 2.5, 2.4, 2.6, 3.5].map(roundHalfEven)).toEqual([0, 2, 2, 2, 3, 4]);
  });
});

/** A made-up instrument: two recorded notes (sines), one layer, a loop in each. */
function instrument(kind: PerfInstrument['kind']): { inst: PerfInstrument; data: SampleData[] } {
  const make = (f: number): SampleData => {
    const n = SR * 2;
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
    frames: SR * 2,
    tune: 0,
    gainDb: 0,
    loopStart: SR / 2,
    loopEnd: SR + SR / 2,
    loopRho: 0.95,
  });
  return {
    inst: {
      name: `test_${kind}`,
      kind,
      release: 0.4,
      lag: 0,
      maxLead: 0.06,
      legatoSkip: 0.16,
      xfade: 0.16,
      pan: 0,
      width: 0.8,
      maxAttack: 0,
      rows: [row(0, 60), row(1, 67)],
    },
    data: [make(261.63), make(392)],
  };
}

function play(kind: PerfInstrument['kind'], notes: { t: number; d: number; p: number; v: number }[], block: number) {
  const { inst, data } = instrument(kind);
  const plans = planPart(inst, notes, { seed: 4, gainDb: 0 }, SR);
  const n = SR * 6;
  const L = new Float32Array(n);
  const R = new Float32Array(n);
  for (const p of plans) {
    const v = new PlanVoice(p, data[p.row.sample] as SampleData, SR);
    for (let at = Math.max(0, p.at); at < n && !v.done; at += block) v.render(L, R, at, Math.min(n, at + block), at);
  }
  return { plans, L, R };
}

describe('the Performance sampler', () => {
  const melody = [
    { t: 0.1, d: 0.5, p: 60, v: 0.6 },
    { t: 0.6, d: 0.5, p: 62, v: 0.7 },
    { t: 1.1, d: 3.5, p: 67, v: 0.5 },
  ];

  it('plays the same in any block size, and from the same seed the same notes', () => {
    for (const kind of ['oneshot', 'sus'] as const) {
      const a = play(kind, melody, 128);
      const b = play(kind, melody, 997);
      expect(Buffer.from(a.L.buffer).equals(Buffer.from(b.L.buffer))).toBe(true);
      let peak = 0;
      for (const v of a.L) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeGreaterThan(0.05);
      expect(Number.isFinite(peak)).toBe(true);
    }
  });

  it('hands a sustain over legato, and lengthens it past its sample by looping', () => {
    const { plans } = play('sus', melody, 128);
    // the second note enters legato (no early start), the long last note runs on its loop
    expect(plans[1]?.sus?.legatoK).toBeGreaterThan(0);
    expect(plans[2]?.extend).not.toBeNull();
  });
});

describe('glass', () => {
  const chord = [
    { t: 0, d: 1.5, p: 69, v: 0.5 },
    { t: 0, d: 1.5, p: 76, v: 0.5 },
  ];
  it('rings, and the same from the same seed', () => {
    const run = () => {
      const n = SR * 4;
      const L = new Float32Array(n);
      const R = new Float32Array(n);
      for (const p of planGlass(chord, { seed: 1 }, SR)) {
        const v = new GlassVoice(p, SR);
        for (let at = 0; at < n && !v.done; at += 128) v.render(L, R, at, Math.min(n, at + 128), at);
      }
      for (const p of planGlassLine(chord, { seed: 2 }, SR)) {
        const v = new GlassLineVoice(p, SR);
        for (let at = 0; at < n && !v.done; at += 128) v.render(L, R, at, Math.min(n, at + 128), at);
      }
      return L;
    };
    const a = run();
    const b = run();
    expect(Buffer.from(a.buffer).equals(Buffer.from(b.buffer))).toBe(true);
    let peak = 0;
    for (const v of a) peak = Math.max(peak, Math.abs(v));
    expect(peak).toBeGreaterThan(0.01);
    expect(peak).toBeLessThan(1);
  });
});
