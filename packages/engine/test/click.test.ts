import { describe, expect, it } from 'vitest';
import { CLICK_SOUNDS, Click, type ClickSound, isClickSound } from '../src/click.ts';
import { EngineCore } from '../src/core.ts';
import { loudness } from '../src/master.ts';

const SR = 48000;

/** Four bars of 4/4 at 120 bpm: the click on every beat, the first of each bar accented. */
function bars(sound: ClickSound, sr = SR): Float64Array {
  const beat = sr / 2;
  const out = new Float64Array(beat * 16);
  const c = new Click(sr);
  for (let i = 0; i < out.length; i++) {
    if (i % beat === 0) c.start(sound, (i / beat) % 4 === 0);
    out[i] = c.next();
  }
  return out;
}

function peak(x: Float64Array, from: number, to: number): number {
  let p = 0;
  for (let i = from; i < to; i++) p = Math.max(p, Math.abs(x[i] as number));
  return p;
}

describe('the metronome click', () => {
  it('beeps as the studio always has, sample for sample', () => {
    // the click as it was before it had sounds
    const was = (bar: boolean, n: number) => {
      const out: number[] = [];
      let env = bar ? 1 : 0.6;
      let phase = 0;
      const f = bar ? 1760 : 1175;
      for (let i = 0; i < n; i++) {
        if (env < 1e-4) {
          out.push(0);
          continue;
        }
        phase += f / SR;
        out.push(Math.sin(2 * Math.PI * phase) * env);
        env *= 0.9986;
      }
      return out;
    };
    for (const bar of [true, false]) {
      const c = new Click(SR);
      c.start('beep', bar);
      const now = Array.from({ length: 8000 }, () => c.next());
      expect(now).toEqual(was(bar, 8000));
      expect(c.active).toBe(false);
    }
  });

  it('every sound is as loud as the beep, and the bar louder than the beat', () => {
    const beep = loudness([bars('beep'), bars('beep')], SR);
    for (const s of CLICK_SOUNDS) {
      const x = bars(s);
      expect(Math.abs(loudness([x, x], SR) - beep), s).toBeLessThan(0.5);
      const bar = peak(x, 0, SR / 2);
      const beat = peak(x, SR / 2, SR);
      expect(bar, s).toBeGreaterThan(beat * 1.3);
      // (the engine halves it again: at full volume it stays well under full scale)
      expect(bar, s).toBeLessThan(1.6);
    }
  });

  it('rings out on its own, at any sample rate', () => {
    for (const sr of [44100, 48000, 96000]) {
      for (const s of CLICK_SOUNDS) {
        const c = new Click(sr);
        c.start(s, true);
        let n = 0;
        let finite = true;
        while (c.active && n < sr) {
          finite &&= Number.isFinite(c.next());
          n++;
        }
        expect(finite, `${s} at ${sr}`).toBe(true);
        expect(c.active, `${s} at ${sr}`).toBe(false);
        expect(n / sr, `${s} at ${sr}`).toBeLessThan(0.6);
      }
    }
  });

  it('knows its sounds', () => {
    expect(CLICK_SOUNDS.every(isClickSound)).toBe(true);
    expect(isClickSound('cowbell')).toBe(false);
    expect(isClickSound(undefined)).toBe(false);
  });
});

describe('the engine’s metronome', () => {
  /** What the engine plays while stopped, after these messages. */
  function stopped(...msgs: Parameters<EngineCore['receive']>[0][]): Float32Array {
    const core = new EngineCore(SR, (m) => {
      if (m.type === 'error') throw new Error(m.message);
    });
    core.receive({ type: 'init', ring: null, meters: null, transport: null });
    for (const m of msgs) core.receive(m);
    const out = new Float32Array(128 * 40);
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    for (let k = 0; k < 40; k++) {
      core.process(l, r, undefined, k * 128);
      out.set(l, k * 128);
    }
    return out;
  }
  const loudest = (x: Float32Array) => x.reduce((p, v) => Math.max(p, Math.abs(v)), 0);

  it('plays one click to audition a sound, at the level chosen', () => {
    const wood = stopped({ type: 'metronome', on: false, level: 1, sound: 'wood', audition: true });
    const c = new Click(SR);
    c.start('wood', false);
    const want = Float32Array.from({ length: 128 * 40 }, () => c.next() * 0.5);
    expect(wood).toEqual(want);
    const quieter = stopped({ type: 'metronome', on: false, level: 0.25, sound: 'wood', audition: true });
    expect(loudest(quieter)).toBeCloseTo(loudest(wood) / 4, 5);
  });

  it('is silent while stopped unless asked to audition', () => {
    expect(loudest(stopped({ type: 'metronome', on: true, level: 1, sound: 'stick' }))).toBe(0);
  });

  it('plays the beep for a studio that sends no sound', () => {
    const none = stopped(
      { type: 'metronome', on: true, level: 1 },
      { type: 'metronome', on: true, level: 1, audition: true },
    );
    const beep = stopped({ type: 'metronome', on: true, level: 1, sound: 'beep', audition: true });
    expect(none).toEqual(beep);
    expect(loudest(beep)).toBeGreaterThan(0.2);
  });
});
