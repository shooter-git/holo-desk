import { GM_DRUMS } from '@holo/session';
import { describe, expect, it } from 'vitest';
import type { Instrument } from '../src/instrument.ts';
import { DrumMachine, MACHINE_PRESETS } from '../src/machine.ts';

const SR = 48000;

function play(inst: Instrument, seconds: number): Float32Array {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let at = 0; at < n; at += 128) inst.render(l, r, at, Math.min(n, at + 128));
  return l;
}

const peak = (x: Float32Array) => {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
};

describe('Drum machine', () => {
  for (const preset of MACHINE_PRESETS) {
    it(`${preset}: every General MIDI drum sounds, at most 0 dBFS at full velocity, and ends`, () => {
      for (const key of Object.keys(GM_DRUMS).map(Number)) {
        const m = new DrumMachine(SR, preset, { drive: 1, snap: 1, tone: 1 });
        m.noteOn(key, 127);
        const x = play(m, 0.4);
        expect(x.every(Number.isFinite)).toBe(true);
        expect(peak(x), `${preset} ${GM_DRUMS[key]}`).toBeGreaterThan(0.01);
        expect(peak(x), `${preset} ${GM_DRUMS[key]}`).toBeLessThanOrEqual(1);
        play(m, 3);
        expect(m.active, `${preset} ${GM_DRUMS[key]}`).toBe(0);
      }
    });
  }

  it('a closed hat cuts off the open one', () => {
    const m = new DrumMachine(SR, 'Analog Machine');
    m.noteOn(46, 110);
    play(m, 0.05);
    m.noteOn(42, 1);
    const x = play(m, 0.3);
    // the open hat (half a second of ring) is gone well before
    expect(peak(x.subarray(Math.round(SR * 0.15)))).toBeLessThan(1e-3);
  });

  it('the kick falls in pitch and booms; Decay lengthens it, Tune moves it', () => {
    const at = (params: Record<string, number>, from: number, to: number) => {
      const m = new DrumMachine(SR, 'Analog Machine', params);
      m.noteOn(36, 110);
      const x = play(m, 1.5);
      return peak(x.subarray(Math.round(from * SR), Math.round(to * SR)));
    };
    expect(at({ decay: 3 }, 1, 1.4)).toBeGreaterThan(at({ decay: 0.25 }, 1, 1.4) * 10);
    // tuned up an octave, it crosses zero about twice as often
    const crossings = (tune: number) => {
      const m = new DrumMachine(SR, 'Analog Machine', { tune });
      m.noteOn(36, 110);
      const x = play(m, 0.5).subarray(SR / 10);
      let n = 0;
      for (let i = 1; i < x.length; i++) if ((x[i - 1] as number) < 0 !== (x[i] as number) < 0) n++;
      return n;
    };
    expect(crossings(12) / crossings(0)).toBeGreaterThan(1.8);
  });

  it('the same hits give the same sound', () => {
    const run = () => {
      const m = new DrumMachine(SR, 'Lo-fi Machine');
      for (const k of [36, 38, 42, 39, 46]) m.noteOn(k, 100);
      return play(m, 0.5);
    };
    expect(Buffer.from(run().buffer).equals(Buffer.from(run().buffer))).toBe(true);
  });
});
