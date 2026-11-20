import { defaultParams, PLUGINS, paramValue, presetNamed, presetParams } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { compressorCurve } from '../src/charcomp.ts';
import { Biquad } from '../src/dsp.ts';
import { delayTaps } from '../src/dualdelay.ts';
import { createEffect, type Host } from '../src/fx.ts';
import { roomDecay, roomReflections } from '../src/roomreverb.ts';
import { hallDecay } from '../src/smoothhall.ts';
import { studioEqResponse } from '../src/studioeq.ts';

const SR = 48000;
const host: Host = {
  sr: SR,
  lowLatency: false,
  beatSeconds: () => 0.5,
  impulse: () => undefined,
  songFrame: () => 0,
  clip: () => undefined,
};

/** Runs a plugin over two channels in place, 128 frames at a time; the deepest gain reduction it reported. */
function run(type: string, params: Record<string, number>, l: Float32Array, r: Float32Array): number {
  const fx = createEffect(type, host);
  if (!fx) throw new Error(type);
  fx.setParams(params);
  let gr = 0;
  for (let at = 0; at < l.length; at += 128) {
    const n = Math.min(128, l.length - at);
    fx.process(l.subarray(at, at + n), r.subarray(at, at + n), n);
    gr = Math.min(gr, fx.gr);
  }
  return gr;
}

/** A steady sine at `db` dBFS, the same on both sides. */
function tone(db: number, seconds: number, f = 1000): [Float32Array, Float32Array] {
  const n = Math.round(SR * seconds);
  const l = new Float32Array(n);
  const a = 10 ** (db / 20);
  for (let i = 0; i < n; i++) l[i] = a * Math.sin((2 * Math.PI * f * i) / SR);
  return [l, l.slice()];
}

const peakDb = (x: Float32Array, from = 0) => {
  let p = 0;
  for (let i = from; i < x.length; i++) p = Math.max(p, Math.abs(x[i] as number));
  return 20 * Math.log10(p + 1e-12);
};

function impulse(type: string, params: Record<string, number>, seconds: number, right = true) {
  const n = Math.round(SR * seconds);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  l[0] = 1;
  if (right) r[0] = 1;
  run(type, params, l, r);
  return [l, r] as const;
}

/** RT60 (s) in the octave around `fc`: a T20 fit to the Schroeder decay of both sides' energy. */
function rt60(l: Float32Array, r: Float32Array, fc: number): number {
  const a = Float32Array.from(l);
  const b = Float32Array.from(r);
  for (let k = 0; k < 2; k++) {
    const hp = new Biquad();
    const lp = new Biquad();
    hp.set('highpass', fc / Math.SQRT2, Math.SQRT1_2, 0, SR);
    lp.set('lowpass', Math.min(fc * Math.SQRT2, SR * 0.45), Math.SQRT1_2, 0, SR);
    hp.process(a, b, a.length);
    lp.process(a, b, a.length);
  }
  const e = new Float64Array(a.length);
  let total = 0;
  for (let i = a.length - 1; i >= 0; i--) {
    total += (a[i] as number) ** 2 + (b[i] as number) ** 2;
    e[i] = total;
  }
  const at = (db: number) => {
    const target = total * 10 ** (db / 10);
    for (let i = 0; i < e.length; i++) if ((e[i] as number) <= target) return i;
    return e.length;
  };
  return (3 * (at(-25) - at(-5))) / SR;
}

/** Plucked chords with silence between (what a track gives its plugins). */
function music(seconds: number): [Float32Array, Float32Array] {
  const n = SR * seconds;
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const t = i / SR;
    const k = Math.floor(t / 0.5);
    const tt = t - k * 0.5;
    const env = tt < 0.3 ? Math.exp(-tt * 8) : 0;
    const f = [220, 277, 330, 440][k % 4] as number;
    l[i] = (Math.sin(2 * Math.PI * f * t) + 0.5 * Math.sin(2 * Math.PI * f * 1.5 * t)) * env * 0.5;
    r[i] = (l[i] as number) * 0.8;
  }
  return [l, r];
}

describe('Character Compressor', () => {
  const levels = [-40, -30, -20, -15, -10, -6, -3, 0];
  for (const [circuit, name, within] of [
    [0, 'Clean', 0.1],
    [1, 'FET', 1],
    [2, 'VCA', 0.1],
    [3, 'Opto', 0.1],
  ] as const) {
    it(`${name}: a steady tone comes out where its transfer curve says`, () => {
      const p = { circuit, threshold: -20, ratio: 4, knee: 40, attack: 5, release: 50 };
      const curve = compressorCurve(p, levels);
      levels.forEach((x, i) => {
        const [l, r] = tone(x, 1.5);
        run('charcomp', p, l, r);
        expect(Math.abs(peakDb(l, SR) - (curve[i] as number))).toBeLessThan(within);
      });
    });
  }

  it('keeps the ratio above the knee (Clean, VCA), and an FET runs out of range near 20 dB', () => {
    for (const circuit of [0, 2]) {
      const [a, b] = compressorCurve({ circuit, threshold: -30, ratio: 5, knee: 10 }, [-10, 0]);
      expect(((b as number) - (a as number)) / 10).toBeCloseTo(1 / 5, 6);
    }
    const [deep] = compressorCurve({ circuit: 1, threshold: -60, ratio: 30, knee: 0 }, [6]);
    expect(6 - (deep as number)).toBeLessThan(20.01);
    expect(6 - (deep as number)).toBeGreaterThan(18);
  });

  it('gives a full-scale tone its level back with auto gain', () => {
    const [l, r] = tone(0, 1.5);
    run('charcomp', { threshold: -24, ratio: 4, autoGain: 1, release: 50 }, l, r);
    expect(Math.abs(peakDb(l, SR))).toBeLessThan(0.3);
  });

  it('holds peaks at its limiter, and its output stages never pass full scale', () => {
    const [l, r] = tone(0, 1, 200);
    run('charcomp', { threshold: -30, ratio: 2, makeup: 18, limiter: 1, limit: -3, release: 40 }, l, r);
    expect(peakDb(l, SR / 2)).toBeLessThan(-2.95);
    for (const saturation of [1, 2, 3]) {
      const [a, b] = tone(6, 0.5, 200);
      run('charcomp', { threshold: -10, ratio: 1.5, makeup: 12, saturation }, a, b);
      expect(peakDb(a)).toBeLessThanOrEqual(1e-6);
    }
  });

  it('passes the sound untouched at a mix of none', () => {
    const [l, r] = music(1);
    const dry = l.slice();
    run('charcomp', { threshold: -40, ratio: 10, mix: 0, saturation: 1 }, l, r);
    expect(l.every((v, i) => v === dry[i])).toBe(true);
  });
});

describe('Studio EQ', () => {
  /** The engine's gain (dB) on a steady sine at `f`, as the curve should show it (by power: a sampled sine's peaks fall short). */
  const gainAt = (p: Record<string, number>, f: number) => {
    const [l, r] = tone(-12, 1, f);
    const dry = l.slice();
    run('studioeq', p, l, r);
    let a = 0;
    let b = 0;
    for (let i = SR / 2; i < SR; i++) {
      a += (l[i] as number) ** 2;
      b += (dry[i] as number) ** 2;
    }
    return 10 * Math.log10(a / b);
  };

  it('draws the curve the engine plays', () => {
    const p = {
      lcOn: 1,
      lcFreq: 60,
      lcSlope: 4,
      lsGain: 3,
      p1Gain: -6,
      p1Freq: 400,
      p1Q: 3,
      p3Gain: 5,
      p3Freq: 3000,
      hsGain: -4,
      hcOn: 1,
      hcFreq: 15000,
      propQ: 6,
      output: -1.5,
    };
    for (const f of [40, 120, 400, 1000, 3000, 8000, 14000]) {
      const [drawn] = studioEqResponse(p, [f], SR);
      expect(Math.abs(gainAt(p, f) - (drawn as number))).toBeLessThan(0.15);
    }
  });

  it('puts a bell its full gain at its frequency, low to high, and a cut mirrors a boost', () => {
    for (const [f, g, q] of [
      [100, 9, 0.7],
      [1000, -12, 4],
      [8000, 6, 2],
      [16000, -9, 1],
    ] as const) {
      const [at] = studioEqResponse({ p2Freq: f, p2Gain: g, p2Q: q }, [f], SR);
      expect(at).toBeCloseTo(g, 2);
    }
    const freqs = [300, 600, 1000, 1700, 3000];
    const up = studioEqResponse({ p2Freq: 1000, p2Gain: 10, p2Q: 2 }, freqs, SR);
    const down = studioEqResponse({ p2Freq: 1000, p2Gain: -10, p2Q: 2 }, freqs, SR);
    up.forEach((v, i) => {
      expect(v + (down[i] as number)).toBeCloseTo(0, 6);
    });
  });

  it('cuts at 6 to 48 dB an octave, 3 dB down at the frequency at Q 0.71', () => {
    for (let slope = 0; slope < 6; slope++) {
      const order = [1, 2, 3, 4, 6, 8][slope] as number;
      const [corner, quarter, eighth] = studioEqResponse({ lcOn: 1, lcFreq: 800, lcSlope: slope }, [800, 200, 100], SR);
      expect(corner).toBeCloseTo(-3.01, 1);
      expect((quarter as number) - (eighth as number)).toBeCloseTo(6.02 * order, 0);
      const [top] = studioEqResponse({ hcOn: 1, hcFreq: 4000, hcSlope: slope }, [4000], SR);
      expect(top).toBeCloseTo(-3.01, 1);
    }
  });

  it('narrows a bell with Proportional Q, cuts most with the asymmetric ones', () => {
    // how many of the points between 250 Hz and 4 kHz are at least half the bell's gain
    const width = (propQ: number, gain: number) => {
      const freqs = Array.from({ length: 400 }, (_, i) => 250 * 16 ** (i / 399));
      const r = studioEqResponse({ p2Freq: 1000, p2Gain: gain, p2Q: 1, propQ }, freqs, SR);
      return r.filter((v) => Math.abs(v) >= Math.abs(gain) / 2).length;
    };
    expect(width(3, -12)).toBeLessThan(width(0, -12));
    expect(width(6, -12)).toBeLessThan(width(3, -12));
    expect(width(6, 12)).toBe(width(3, 12));
  });

  it('is silent until asked: flat settings pass the sound untouched', () => {
    const [l, r] = music(1);
    const dry = l.slice();
    run('studioeq', defaultParams('studioeq'), l, r);
    expect(l.every((v, i) => v === dry[i])).toBe(true);
  });
});

describe('Limiter, soft knee', () => {
  it('starts holding back below the ceiling and never passes it', () => {
    for (const knee of [0, 6, 12]) {
      const [l, r] = tone(-3, 1);
      run('limiter', { ceiling: -1, knee, release: 50, lookahead: 3 }, l, r);
      const out = peakDb(l, SR / 2);
      if (knee === 0) expect(out).toBeCloseTo(-3, 2);
      else expect(out).toBeLessThan(-3.05);
      const [a, b] = tone(6, 1);
      run('limiter', { ceiling: -1, knee, release: 50, lookahead: 3 }, a, b);
      expect(peakDb(a)).toBeLessThanOrEqual(-1 + 1e-4);
    }
  });
});

describe('Dual Delay', () => {
  const open = { lowcut: 20, highcut: 20000, mix: 100 };

  it('lands each side on its note and groove, in time with the song', () => {
    // a dotted eighth and a quarter at 120
    const [l, r] = impulse('dualdelay', { ...open, noteL: 3, grooveL: 75, noteR: 2, grooveR: 50, fbL: 0, fbR: 0 }, 1);
    const at = (x: Float32Array) =>
      x.reduce((best, v, i, a) => (Math.abs(v) > Math.abs(a[best] as number) ? i : best), 0);
    expect(at(l)).toBe(18000);
    expect(at(r)).toBe(24000);
  });

  it('repeats where its taps say, flipped where a phase is', () => {
    const p = { ...open, sync: 0, timeL: 100, timeR: 150, fbL: 50, fbR: 40, crossLR: 30, invL: 1, invX: 1 };
    const [l, r] = impulse('dualdelay', p, 1.2);
    for (const t of delayTaps(p, 0.5, 1.1).filter((x) => Math.abs(x.gain) > 0.05)) {
      const ch = t.side === 0 ? l : r;
      // (the high cut, wide open, spreads each repeat over a few frames: what they add up to is the repeat)
      const at = Math.round(t.time * SR);
      let v = 0;
      for (let i = at - 1; i < at + 8; i++) v += ch[i] as number;
      expect(v).toBeCloseTo(t.gain, 1);
      expect(Math.sign(v)).toBe(Math.sign(t.gain));
    }
  });

  it('passes the sound untouched at a mix of none', () => {
    const [l, r] = music(1);
    const dry = l.slice();
    run('dualdelay', { mix: 0, fbL: 80 }, l, r);
    expect(l.every((v, i) => v === dry[i])).toBe(true);
  });
});

describe('the room reverbs', () => {
  const bands = [125, 500, 2000, 8000];
  const cases: [string, string, Record<string, number>, number][] = [
    ['roomreverb', 'a small room', { size: 8, decay: 0.6 }, 2],
    ['roomreverb', 'a church', { size: 40, walls: 7, decay: 5, lowDecay: 125, highDecay: 50, highcut: 9000 }, 9],
    ['smoothhall', 'a soft hall', { decay: 1.8 }, 4],
    ['smoothhall', 'a long wash', { decay: 8, size: 100, highcut: 6000 }, 12],
  ];
  for (const [type, label, params, seconds] of cases) {
    it(`${label} rings as long as its settings say, band by band`, () => {
      const p = { ...params, dry: -60, wet: 0 };
      const [l, r] = impulse(type, p, seconds);
      const want = type === 'roomreverb' ? roomDecay(p, bands) : hallDecay(p, bands);
      bands.forEach((f, i) => {
        const ratio = rt60(l, r, f) / (want[i] as number);
        expect(ratio, `${f} Hz`).toBeGreaterThan(0.8);
        expect(ratio, `${f} Hz`).toBeLessThan(1.25);
      });
    }, 20000);
  }

  it('sends its first reflection after the pre-delay, as the room plan has it', () => {
    const p = { predelay: 20, size: 12, walls: 5, balance: 0, dry: -60, wet: 0, diffusion: 0 };
    const [l] = impulse('roomreverb', p, 0.5);
    const first = l.findIndex((v) => Math.abs(v) > 1e-6);
    const plan = roomReflections(p).left[0];
    expect(first).toBe(Math.round(0.02 * SR) + Math.max(1, Math.round((plan?.time ?? 0) * SR)));
  });

  it('gives back the dry sound alone with the wet off', () => {
    for (const type of ['roomreverb', 'smoothhall']) {
      const [l, r] = music(1);
      const dry = l.slice();
      run(type, { dry: -6, wet: -60 }, l, r);
      const g = 10 ** (-6 / 20);
      expect(Array.from(l).every((v, i) => Math.abs(v - (dry[i] as number) * g) < 1e-6)).toBe(true);
    }
  });

  it('stays finite at its extremes', () => {
    for (const type of ['roomreverb', 'smoothhall']) {
      const def = PLUGINS.find((d) => d.type === type);
      for (const end of ['min', 'max'] as const) {
        const p = Object.fromEntries((def?.params ?? []).map((x) => [x.id, x[end]]));
        const [l, r] = music(2);
        run(type, { ...p, wet: 0 }, l, r);
        expect(l.every((v) => Number.isFinite(v) && Math.abs(v) < 8)).toBe(true);
      }
    }
  }, 20000);
});

describe('presets', () => {
  const withPresets = PLUGINS.filter((d) => d.presets?.length);

  it('name only their own settings, in range', () => {
    expect(withPresets.map((d) => d.type).sort()).toEqual(
      ['charcomp', 'dualdelay', 'limiter', 'roomreverb', 'smoothhall', 'studioeq'].sort(),
    );
    for (const def of withPresets) {
      for (const preset of def.presets ?? []) {
        for (const [id, v] of Object.entries(preset.params)) {
          expect(
            def.params.find((x) => x.id === id),
            `${def.type} ${preset.name}: ${id}`,
          ).toBeDefined();
          expect(paramValue(def.type, preset.params, id)).toBe(v);
        }
      }
    }
  });

  it('keep a reverb’s and a delay’s levels where they were, and are known again by their settings', () => {
    const onBus = { dry: -60, wet: 0 };
    expect(presetParams('roomreverb', 'Church', onBus)).toMatchObject(onBus);
    expect(presetParams('dualdelay', 'Slapback', { mix: 100 })?.mix).toBe(100);
    for (const def of withPresets) {
      for (const preset of def.presets ?? []) {
        expect(presetNamed(def.type, presetParams(def.type, preset.name) ?? {})).toBe(preset.name);
      }
    }
  });

  it('every one sounds: finite, and not wildly louder than what goes in', () => {
    for (const def of withPresets) {
      for (const preset of def.presets ?? []) {
        const [l, r] = music(2);
        run(def.type, presetParams(def.type, preset.name, { mix: 40, wet: -6 }) ?? {}, l, r);
        expect(l.every((v) => Number.isFinite(v))).toBe(true);
        expect(peakDb(l), `${def.type} ${preset.name}`).toBeLessThan(8);
      }
    }
  }, 30000);
});
