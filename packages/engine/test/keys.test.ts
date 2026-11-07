import { describe, expect, it } from 'vitest';
import type { Instrument } from '../src/instrument.ts';
import { ElectricKeys, KEYS_PRESETS } from '../src/keys.ts';

const SR = 48000;

function play(inst: Instrument, seconds: number): Float32Array {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let at = 0; at < n; at += 128) inst.render(l, r, at, Math.min(n, at + 128));
  return l;
}

/** How bright a sound is: the energy of its slope over the energy of the sound. */
function brightness(x: Float32Array): number {
  let e = 0;
  let d = 0;
  for (let i = 1; i < x.length; i++) {
    e += (x[i] as number) ** 2;
    d += ((x[i] as number) - (x[i - 1] as number)) ** 2;
  }
  return d / e;
}

describe('Electric keys', () => {
  for (const preset of KEYS_PRESETS) {
    it(`${preset}: brighter the harder it's played`, () => {
      const soft = new ElectricKeys(SR, preset, { tremolo: 0 });
      soft.noteOn(52, 30);
      const hard = new ElectricKeys(SR, preset, { tremolo: 0 });
      hard.noteOn(52, 127);
      expect(brightness(play(hard, 0.4))).toBeGreaterThan(brightness(play(soft, 0.4)) * 1.15);
    });

    it(`${preset}: stays finite and in bounds with every knob up, and stops when let go`, () => {
      const s = new ElectricKeys(SR, preset, { tone: 1, bark: 1, decay: 2, tremolo: 1, pickup: 1, stereo: 1 });
      const chord = [28, 40, 52, 59, 64, 67, 71, 76, 84, 96];
      for (const k of chord) s.noteOn(k, 127);
      const x = play(s, 1);
      expect(x.every(Number.isFinite)).toBe(true);
      let peak = 0;
      for (const v of x) peak = Math.max(peak, Math.abs(v));
      expect(peak).toBeLessThan(2);
      expect(peak).toBeGreaterThan(0.05);
      for (const k of chord) s.noteOff(k);
      play(s, 3);
      expect(s.active).toBe(0);
    });
  }

  it('the tine sings on while held, and the damper stops it', () => {
    const s = new ElectricKeys(SR, 'Tine Piano');
    s.noteOn(48, 100);
    play(s, 2);
    expect(s.active).toBe(1);
    s.noteOff(48);
    play(s, 1);
    expect(s.active).toBe(0);
  });

  it('a knob turned while a note rings changes it without cutting it', () => {
    const s = new ElectricKeys(SR, 'Clav Keys');
    s.noteOn(48, 100);
    play(s, 0.1);
    s.update({ tone: 0.2, pickup: 0.1 });
    const after = play(s, 0.1);
    expect(s.active).toBe(1);
    let e = 0;
    for (const v of after) e += v * v;
    expect(e).toBeGreaterThan(1e-4);
  });
});
