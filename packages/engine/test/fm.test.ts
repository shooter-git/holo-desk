import { describe, expect, it } from 'vitest';
import { FM_PRESETS, FmSynth } from '../src/fm.ts';
import type { Instrument } from '../src/instrument.ts';

const SR = 48000;

function play(inst: Instrument, seconds: number): { l: Float32Array; r: Float32Array } {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let at = 0; at < n; at += 128) inst.render(l, r, at, Math.min(n, at + 128));
  return { l, r };
}

function brightness(x: Float32Array): number {
  let e = 0;
  let d = 0;
  for (let i = 1; i < x.length; i++) {
    e += (x[i] as number) ** 2;
    d += ((x[i] as number) - (x[i - 1] as number)) ** 2;
  }
  return d / e;
}

describe('FM synth', () => {
  for (const preset of FM_PRESETS) {
    it(`${preset}: Brightness down is pure sines, up is bright`, () => {
      // over the attack, where FM's brightness lives (the pad's takes a second to arrive)
      const window = preset === 'FM Pad' ? 1.5 : 0.15;
      const dull = new FmSynth(SR, preset, { brightness: 0 });
      dull.noteOn(57, 100);
      const bright = new FmSynth(SR, preset, { brightness: 2 });
      bright.noteOn(57, 100);
      expect(brightness(play(bright, window).l)).toBeGreaterThan(brightness(play(dull, window).l) * 1.5);
    });

    it(`${preset}: stays finite and in bounds with every knob up, and ends after release`, () => {
      const s = new FmSynth(SR, preset, {
        brightness: 2,
        ratio: 10,
        feedback: 1,
        attack: 0.001,
        decay: 12,
        release: 0.01,
      });
      const chord = [24, 36, 48, 55, 60, 64, 67, 71, 84, 96];
      for (const k of chord) s.noteOn(k, 127);
      const { l } = play(s, 1);
      expect(l.every(Number.isFinite)).toBe(true);
      let peak = 0;
      for (const v of l) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeLessThan(2);
      expect(peak).toBeGreaterThan(0.01);
      for (const k of chord) s.noteOff(k);
      play(s, 0.5);
      expect(s.active).toBe(0);
    });
  }

  for (const preset of ['FM Keys', 'FM Bells', 'FM Bass', 'FM Brass']) {
    it(`${preset}: brighter played harder`, () => {
      const soft = new FmSynth(SR, preset);
      soft.noteOn(57, 30);
      const hard = new FmSynth(SR, preset);
      hard.noteOn(57, 127);
      expect(brightness(play(hard, 0.15).l)).toBeGreaterThan(brightness(play(soft, 0.15).l));
    });
  }

  it('the pad sits wide: its two halves are on opposite sides', () => {
    const s = new FmSynth(SR, 'FM Pad');
    for (const k of [48, 55, 60, 64]) s.noteOn(k, 90);
    const { l, r } = play(s, 2);
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = SR; i < l.length; i++) {
      lr += (l[i] as number) * (r[i] as number);
      ll += (l[i] as number) ** 2;
      rr += (r[i] as number) ** 2;
    }
    expect(lr / Math.sqrt(ll * rr)).toBeLessThan(0.95);
  });

  it('a knob turned while a note sounds changes it in place', () => {
    const s = new FmSynth(SR, 'FM Brass');
    s.noteOn(60, 100);
    const before = brightness(play(s, 0.3).l);
    s.update({ brightness: 0.1 });
    expect(s.active).toBe(1);
    expect(brightness(play(s, 0.3).l)).toBeLessThan(before);
  });
});
