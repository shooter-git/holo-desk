import { SYNTH_MACROS } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { CHOIR_PRESETS, ChoirSynth } from '../src/choir.ts';
import type { Instrument } from '../src/instrument.ts';
import { PLUCKED_PRESETS, PluckedSynth } from '../src/plucked.ts';
import { REED_PRESETS, ReedSynth } from '../src/reeds.ts';
import { STRUCK_PRESETS, StruckSynth } from '../src/struck.ts';
import { WIND_PRESETS, WindSynth } from '../src/wind.ts';

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

/** The pitch heard (hertz), by autocorrelation within a tone of `near`. */
function pitch(x: Float32Array, near: number): number {
  const ac = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < x.length; i++) s += (x[i] as number) * (x[i + lag] as number);
    return s;
  };
  const lo = Math.floor(SR / (near * 1.12));
  const hi = Math.ceil(SR / (near / 1.12));
  let best = -Infinity;
  let at = lo;
  for (let lag = lo; lag <= hi; lag++) {
    const s = ac(lag);
    if (s > best) {
      best = s;
      at = lag;
    }
  }
  const a = ac(at - 1);
  const b = ac(at);
  const c = ac(at + 1);
  return SR / (at + (0.5 * (a - c)) / (a - 2 * b + c));
}

/** Every knob of a preset at its top. */
const allUp = (preset: string) => Object.fromEntries((SYNTH_MACROS[preset] ?? []).map((k) => [k.id, k.max]));

const families: [string, string[], (sr: number, preset: string, params?: Record<string, number>) => Instrument][] = [
  ['Wind', WIND_PRESETS, (sr, p, q) => new WindSynth(sr, p, q)],
  ['Plucked', PLUCKED_PRESETS, (sr, p, q) => new PluckedSynth(sr, p, q)],
  ['Reeds', REED_PRESETS, (sr, p, q) => new ReedSynth(sr, p, q)],
  ['Choir', CHOIR_PRESETS, (sr, p, q) => new ChoirSynth(sr, p, q)],
  ['Struck', STRUCK_PRESETS, (sr, p, q) => new StruckSynth(sr, p, q)],
];

for (const [family, presets, make] of families) {
  describe(family, () => {
    for (const preset of presets) {
      it(`${preset}: has six knobs, stays finite and in bounds with every one up, and ends after release`, () => {
        expect(SYNTH_MACROS[preset]?.length).toBe(6);
        const s = make(SR, preset, { ...allUp(preset), release: 0.05, space: 1 });
        const chord = [36, 48, 55, 60, 64, 67, 72, 79];
        for (const k of chord) s.noteOn(k, 127);
        const { l, r } = play(s, 1.5);
        expect(l.every(Number.isFinite) && r.every(Number.isFinite)).toBe(true);
        expect(peak(l)).toBeLessThan(2);
        expect(peak(l)).toBeGreaterThan(0.005);
        // with little hall, everything stops soon after the keys are let go
        const t = make(SR, preset, { space: 0, decay: 0.25, release: 0.05 });
        for (const k of chord) t.noteOn(k, 100);
        play(t, 0.6);
        for (const k of chord) t.noteOff(k);
        play(t, 6);
        expect(t.active).toBe(0);
      });
    }
  });
}

describe('in tune', () => {
  const pitched = [
    ...WIND_PRESETS,
    ...PLUCKED_PRESETS.filter((p) => p !== 'Tanpura'),
    ...REED_PRESETS,
    ...CHOIR_PRESETS,
  ];
  const make = (preset: string): Instrument => {
    const q = { vibrato: 0, tremolo: 0, space: 0 };
    if (WIND_PRESETS.includes(preset)) return new WindSynth(SR, preset, q);
    if (PLUCKED_PRESETS.includes(preset)) return new PluckedSynth(SR, preset, q);
    if (REED_PRESETS.includes(preset)) return new ReedSynth(SR, preset, q);
    return new ChoirSynth(SR, preset, q);
  };
  for (const preset of pitched) {
    it(`${preset} plays the note asked for, within 12 cents`, () => {
      for (const key of [55, 67]) {
        const s = make(preset);
        s.noteOn(key, 100);
        const { l } = play(s, 0.9);
        const f = 440 * 2 ** ((key - 69) / 12);
        const heard = pitch(l.subarray(Math.round(SR * 0.6), Math.round(SR * 0.6) + 6000), f);
        expect(Math.abs(1200 * Math.log2(heard / f)), `${preset} ${key}`).toBeLessThan(12);
      }
    });
  }
});

describe('what each one does', () => {
  it('the tanpura plays itself while the key is held', () => {
    const s = new PluckedSynth(SR, 'Tanpura', { space: 0 });
    s.noteOn(48, 100);
    const { l } = play(s, 3);
    // a fresh pluck after the first second: the level rises again
    const window = (a: number) => peak(l.subarray(Math.round(a * SR), Math.round((a + 0.1) * SR)));
    const levels = [0.5, 0.7, 1.1, 1.3, 1.7, 1.9, 2.3, 2.5].map(window);
    let rises = 0;
    for (let i = 1; i < levels.length; i++) if ((levels[i] as number) > (levels[i - 1] as number) * 1.05) rises++;
    expect(rises).toBeGreaterThanOrEqual(2);
  });

  it('the pipes drone on the first note of a phrase until every key is let go', () => {
    const s = new WindSynth(SR, 'Celtic Pipes', { space: 0 });
    const drone = () => s as unknown as { droneKey: number; droneLevel: number };
    s.noteOn(62, 100);
    play(s, 0.5);
    s.noteOn(66, 100);
    s.noteOff(62);
    play(s, 0.5);
    expect(drone().droneKey).toBe(62);
    expect(drone().droneLevel).toBeGreaterThan(0.5);
    s.noteOff(66);
    play(s, 3);
    expect(drone().droneLevel).toBeLessThan(1e-3);
    expect(s.active).toBe(0);
  });

  it('an opera gong falls in pitch below middle C and rises above it', () => {
    const glideOf = (key: number) => {
      const s = new StruckSynth(SR, 'Opera Gongs', { space: 0 });
      s.noteOn(key, 120);
      return (s as unknown as { voices: { glide: number }[] }).voices[0]?.glide ?? 0;
    };
    expect(glideOf(48)).toBeLessThan(0);
    expect(glideOf(72)).toBeGreaterThan(0);
  });

  it('war drums are several drums struck a moment apart', () => {
    const s = new StruckSynth(SR, 'War Drums', { ensemble: 1, space: 0 });
    s.noteOn(36, 110);
    const v = (s as unknown as { voices: { players: number; at: Int32Array }[] }).voices[0];
    expect(v?.players).toBe(4);
    const at = Array.from(v?.at ?? []);
    for (let j = 1; j < at.length; j++) expect(at[j] as number).toBeGreaterThan(at[j - 1] as number);
    expect(at[at.length - 1] as number).toBeLessThan(SR * 0.07);
    const one = new StruckSynth(SR, 'War Drums', { ensemble: 0, space: 0 });
    one.noteOn(36, 110);
    expect((one as unknown as { voices: { players: number }[] }).voices[0]?.players).toBe(1);
  });

  it('the choir changes vowel as the knob turns', () => {
    const centroid = (vowel: number) => {
      const s = new ChoirSynth(SR, 'Choir Ahh', { vowel, space: 0, vibrato: 0 });
      s.noteOn(60, 100);
      const { l } = play(s, 0.8);
      let e = 0;
      let d = 0;
      for (let i = SR / 2; i < l.length; i++) {
        e += (l[i] as number) ** 2;
        d += ((l[i] as number) - (l[i - 1] as number)) ** 2;
      }
      return d / e;
    };
    // "ah" has its formants higher than "oo": brighter
    expect(centroid(0)).toBeGreaterThan(centroid(1) * 1.3);
  });
});
