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

describe('the count-in', () => {
  const PPQ = 960;
  /** Where the clicks start (seconds from the play, rounded to ms), as the engine plays at this tempo. */
  function clicks(
    sr: number,
    bpm: number,
    play: { from: number; countInBars: number; metronome: boolean },
    seconds: number,
  ): number[] {
    const core = new EngineCore(sr, (m) => {
      if (m.type === 'error') throw new Error(m.message);
    });
    core.receive({ type: 'init', ring: null, meters: null, transport: null });
    const framesPerTick = (60 / bpm / PPQ) * sr;
    core.receive({
      type: 'tempo',
      segments: [{ frame: 0, tick: 0, framesPerTick }],
      ppq: PPQ,
      beatTicks: PPQ,
      barTicks: PPQ * 4,
    });
    core.receive({ type: 'metronome', on: play.metronome, level: 1, sound: 'stick' });
    // as the studio sends them: the start and the count-in, each rounded to a frame
    const frame = Math.round(play.from * PPQ * 4 * framesPerTick);
    const countIn = Math.round(play.countInBars * PPQ * 4 * framesPerTick);
    core.receive({ type: 'play', frame, record: true, countIn });
    const l = new Float32Array(128);
    const r = new Float32Array(128);
    const starts: number[] = [];
    let quiet = Number.POSITIVE_INFINITY;
    for (let k = 0; k * 128 < seconds * sr; k++) {
      core.process(l, r, undefined, k * 128);
      for (let i = 0; i < 128; i++) {
        if (Math.abs(l[i] as number) > 1e-3) {
          if (quiet > sr * 0.05) starts.push(Math.round(((k * 128 + i) / sr) * 1000));
          quiet = 0;
        } else quiet++;
      }
    }
    return starts;
  }

  // 72.5 bpm at 44.1 kHz: a bar's frames round down, so the count-in starts a hair after its first beat
  const beat = 60 / 72.5;
  const beats = (n: number) => Array.from({ length: n }, (_, i) => Math.round(i * beat * 1000));

  it('clicks every beat of the count-in, the first too, with the metronome off', () => {
    expect(clicks(44100, 72.5, { from: 0, countInBars: 1, metronome: false }, 6)).toEqual(beats(4));
  });

  it('counts in from further into the song as well', () => {
    expect(clicks(44100, 72.5, { from: 4, countInBars: 1, metronome: false }, 6)).toEqual(beats(4));
    expect(clicks(44100, 72.5, { from: 4, countInBars: 2, metronome: false }, 9)).toEqual(beats(8));
  });

  it('goes on into the song with the metronome on', () => {
    expect(clicks(44100, 72.5, { from: 4, countInBars: 1, metronome: true }, 6)).toEqual(beats(8));
  });

  it('clicks at once when the song starts on a beat a rounded frame puts it past', () => {
    // (bar 3 at 72.5 bpm lands between two frames: the start is rounded up past the beat)
    for (const from of [1, 2, 3, 5]) {
      const got = clicks(44100, 72.5, { from, countInBars: 0, metronome: true }, 2);
      expect(got[0], `from bar ${from + 1}`).toBe(0);
    }
  });
});
