import { describe, expect, it } from 'vitest';
import { DRONE_PRESETS, DroneSynth } from '../src/drone.ts';
import type { Instrument } from '../src/instrument.ts';
import { MORPH_PRESETS, MorphSynth } from '../src/morph.ts';

const SR = 48000;

function play(inst: Instrument, seconds: number): { l: Float32Array; r: Float32Array } {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let at = 0; at < n; at += 128) inst.render(l, r, at, Math.min(n, at + 128));
  return { l, r };
}

const peak = (x: Float32Array) => {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
};

function brightness(x: Float32Array): number {
  let e = 0;
  let d = 0;
  for (let i = 1; i < x.length; i++) {
    e += (x[i] as number) ** 2;
    d += ((x[i] as number) - (x[i - 1] as number)) ** 2;
  }
  return d / e;
}

describe('Morph synth', () => {
  for (const preset of MORPH_PRESETS) {
    it(`${preset}: stays finite and in bounds with every knob up, and its hall rings out`, () => {
      const s = new MorphSynth(SR, preset, {
        morph: 1,
        brightness: 14000,
        motion: 1,
        texture: 1,
        release: 0.05,
        space: 1,
      });
      const chord = [24, 36, 48, 55, 60, 64, 67, 71, 84, 108];
      for (const k of chord) s.noteOn(k, 127);
      const { l } = play(s, 2);
      expect(l.every(Number.isFinite)).toBe(true);
      expect(peak(l)).toBeLessThan(2);
      expect(peak(l)).toBeGreaterThan(0.01);
      for (const k of chord) s.noteOff(k);
      play(s, 0.2);
      expect(s.active).toBeGreaterThan(0); // the hall still ringing
      play(s, 15);
      expect(s.active).toBe(0);
    });
  }

  it('Morph moves between its two spectra, and Brightness opens the filter', () => {
    const at = (params: Record<string, number>) => {
      const s = new MorphSynth(SR, 'Morph Bass', { motion: 0, ...params });
      s.noteOn(45, 100);
      return brightness(play(s, 0.5).l);
    };
    // Morph Bass goes from hollow (odd harmonics) to saw (all of them)
    expect(at({ morph: 0, brightness: 6000 })).not.toBeCloseTo(at({ morph: 1, brightness: 6000 }), 6);
    expect(at({ brightness: 4000 })).toBeGreaterThan(at({ brightness: 300 }) * 1.5);
  });

  it('a table never aliases: a high note stays below Nyquist', () => {
    const s = new MorphSynth(SR, 'Morph Lead', { brightness: 14000, space: 0 });
    s.noteOn(108, 127);
    const { l } = play(s, 0.3);
    // a 4186 Hz saw band-limited: no more slope than its top harmonic allows (about 21 kHz)
    expect(brightness(l)).toBeLessThan((2 * Math.sin((Math.PI * 21000) / SR)) ** 2);
  });
});

describe('Drone synth', () => {
  for (const preset of DRONE_PRESETS) {
    it(`${preset}: stays finite and in bounds with every knob up, and fades out after release`, () => {
      const s = new DroneSynth(SR, preset, { tone: 1, motion: 1, density: 1, swell: 0.05, width: 1, space: 1 });
      const chord = [24, 36, 48, 55, 60, 64, 67, 71, 84, 96];
      for (const k of chord) s.noteOn(k, 127);
      const { l } = play(s, 2);
      expect(l.every(Number.isFinite)).toBe(true);
      expect(peak(l)).toBeLessThan(2);
      expect(peak(l)).toBeGreaterThan(0.01);
      // with little hall, it's gone soon after the keys are let go
      const t = new DroneSynth(SR, preset, { swell: 0.05, space: 0.1 });
      for (const k of chord) t.noteOn(k, 100);
      play(t, 0.5);
      for (const k of chord) t.noteOff(k);
      play(t, 5);
      expect(t.active).toBe(0);
    });
  }

  it('swells in slowly, and the same notes give the same sound', () => {
    const a = new DroneSynth(SR, 'Drone Field', { swell: 4 });
    const b = new DroneSynth(SR, 'Drone Field', { swell: 4 });
    a.noteOn(48, 100);
    b.noteOn(48, 100);
    const x = play(a, 3).l;
    const y = play(b, 3).l;
    expect(Buffer.from(x.buffer).equals(Buffer.from(y.buffer))).toBe(true);
    const early = peak(x.subarray(0, SR / 4));
    const late = peak(x.subarray(SR * 2, SR * 3));
    expect(late).toBeGreaterThan(early * 3);
  });

  it('Density breaks it into grains: its level moves more', () => {
    const spread = (density: number) => {
      const s = new DroneSynth(SR, 'Drone Glass', { density, swell: 0.05, space: 0, motion: 0.3 });
      s.noteOn(60, 100);
      play(s, 1);
      const { l } = play(s, 4);
      const block = SR / 20;
      const levels: number[] = [];
      for (let i = 0; i + block <= l.length; i += block) levels.push(peak(l.subarray(i, i + block)));
      const mean = levels.reduce((a, b) => a + b, 0) / levels.length;
      return Math.sqrt(levels.reduce((a, b) => a + (b - mean) ** 2, 0) / levels.length) / mean;
    };
    expect(spread(1)).toBeGreaterThan(spread(0));
  });
});
