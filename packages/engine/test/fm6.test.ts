import { checkSound, SYNTH_MACROS } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { FM6_PRESETS, Fm6Synth } from '../src/fm6.ts';

const SR = 48000;

function play(s: Fm6Synth, seconds: number): { l: Float32Array; r: Float32Array } {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  for (let at = 0; at < n; at += 128) s.render(l, r, at, Math.min(n, at + 128));
  return { l, r };
}

const peak = (x: Float32Array) => {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
};

/** Level of a tone at `hz` in x (a single-bin DFT, Hann-windowed), relative to a full-scale sine. */
function tone(x: Float32Array, hz: number): number {
  let re = 0;
  let im = 0;
  let wsum = 0;
  for (let i = 0; i < x.length; i++) {
    const w = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (x.length - 1));
    const a = (2 * Math.PI * hz * i) / SR;
    re += (x[i] as number) * w * Math.cos(a);
    im += (x[i] as number) * w * Math.sin(a);
    wsum += w;
  }
  return (2 * Math.hypot(re, im)) / wsum;
}

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

const allUp = (preset: string) => Object.fromEntries((SYNTH_MACROS[preset] ?? []).map((k) => [k.id, k.max]));
const hz = (key: number) => 440 * 2 ** ((key - 69) / 12);

/** A whole patch from nothing: one operator heard (a sine at the note), its envelope held, no chorus. */
const solo = (more: Record<string, number> = {}): Record<string, number> => ({
  'patch:blank': 1,
  'op1:on': 1,
  'op1:out': 1,
  'env1:n': 2,
  'env1:t0': 0.002,
  'env1:l0': 1,
  'env1:t1': 0.05,
  'env1:l1': 0,
  'env1:sus': 0,
  'voice:level': 0.5,
  ...more,
});

describe('six-operator FM synth', () => {
  for (const preset of FM6_PRESETS) {
    it(`${preset}: has six knobs, stays finite and in bounds with every one up, and ends after release`, () => {
      expect(SYNTH_MACROS[preset]?.length).toBe(6);
      const s = new Fm6Synth(SR, preset, allUp(preset));
      const chord = [36, 48, 55, 60, 64, 67, 72, 79];
      for (const k of chord) s.noteOn(k, 127);
      const { l, r } = play(s, 1.5);
      expect(l.every(Number.isFinite) && r.every(Number.isFinite)).toBe(true);
      expect(Math.max(peak(l), peak(r))).toBeLessThan(2);
      expect(peak(l)).toBeGreaterThan(0.005);
      // with a short release and no chorus, everything stops soon after the keys are let go
      const t = new Fm6Synth(SR, preset, { release: 0.1, chorus: 0 });
      for (const k of chord) t.noteOn(k, 100);
      play(t, 0.6);
      for (const k of chord) t.noteOff(k);
      play(t, 4);
      expect(t.active).toBe(0);
    });
  }

  for (const preset of FM6_PRESETS.filter((p) => p !== 'Crystal Bells')) {
    it(`${preset} plays the note asked for, within 12 cents`, () => {
      for (const key of [48, 67]) {
        // (the leads' vibrato off, a patch key over the preset)
        const s = new Fm6Synth(SR, preset, { 'lfo:pitch': 0, chorus: 0, attack: 0.1 });
        s.noteOn(key, 100);
        const { l } = play(s, 0.9);
        const f = hz(key);
        const heard = pitch(l.subarray(Math.round(SR * 0.4), Math.round(SR * 0.4) + 6000), f);
        expect(Math.abs(1200 * Math.log2(heard / f)), `${preset} ${key}`).toBeLessThan(12);
      }
    });
  }

  it('a carrier alone is a sine; a modulator adds sidebands at its spacing, as deep as its index', () => {
    const f = hz(60);
    const alone = new Fm6Synth(SR, 'Bright Tines', solo());
    alone.noteOn(60, 127);
    const a = play(alone, 0.6).l.subarray(SR * 0.1);
    const fundamental = tone(a, f);
    expect(fundamental).toBeGreaterThan(0.3);
    for (const k of [2, 3, 4, 5]) expect(tone(a, f * k)).toBeLessThan(fundamental * 1e-3);
    // a modulator at 3.5 times the note, swinging the carrier's phase by 1 radian: sidebands at
    // f ± 3.5f (4.5f and, folded, 2.5f) at J1(1)/J0(1) of the carrier, and nothing between them
    const fm = new Fm6Synth(SR, 'Bright Tines', solo({ 'op2:on': 1, 'op2:ratio': 3.5, 'mod:2>1': 1 }));
    fm.noteOn(60, 127);
    const b = play(fm, 0.6).l.subarray(SR * 0.1);
    const c = tone(b, f);
    const j1j0 = 0.44005 / 0.765198;
    expect(tone(b, f * 4.5) / c).toBeCloseTo(j1j0, 1);
    expect(tone(b, f * 2.5) / c).toBeCloseTo(j1j0, 1);
    for (const k of [2, 3, 4]) expect(tone(b, f * k)).toBeLessThan(c * 1e-2);
    // and the modulator itself isn't heard: it has no output
    expect(tone(b, f * 3.5)).toBeLessThan(c * 1e-2);
  });

  it('a modulation loop is one pass: two operators swinging each other stay finite and in tune', () => {
    const s = new Fm6Synth(SR, 'Bright Tines', solo({ 'op2:on': 1, 'op2:ratio': 2, 'mod:2>1': 0.8, 'mod:1>2': 0.8 }));
    s.noteOn(57, 110);
    const { l } = play(s, 0.8);
    expect(l.every(Number.isFinite)).toBe(true);
    const heard = pitch(l.subarray(SR * 0.3, SR * 0.3 + 6000), hz(57));
    expect(Math.abs(1200 * Math.log2(heard / hz(57)))).toBeLessThan(5);
  });

  it('feedback stays stable: a saw-like ramp of harmonics when moderate, bounded and finite at its most', () => {
    const f = hz(48);
    const at = (fb: number) => {
      const s = new Fm6Synth(SR, 'Bright Tines', solo({ 'mod:1>1': fb }));
      s.noteOn(48, 127);
      return play(s, 1).l.subarray(SR * 0.2);
    };
    const mild = at(1.2);
    const h = [1, 2, 3, 4, 5].map((k) => tone(mild, f * k));
    for (let k = 1; k < h.length; k++) expect(h[k] as number).toBeLessThan(h[k - 1] as number);
    expect(h[1] as number).toBeGreaterThan((h[0] as number) * 0.1);
    let brighter = 0;
    for (const fb of [0, 0.5, 1, 1.5, 2, 4, 8, 16, 32]) {
      const x = at(fb);
      expect(x.every(Number.isFinite)).toBe(true);
      // bounded by the operator's level (0.5) and its offset's removal, with no offset, however hard it's pushed
      expect(peak(x)).toBeLessThan(0.75);
      let dc = 0;
      for (const v of x) dc += v;
      expect(Math.abs(dc / x.length)).toBeLessThan(0.01);
      if (fb > 2) continue;
      // in its musical range, brighter as it goes up
      const centroid = tone(x, f * 3) / Math.max(tone(x, f), 1e-9);
      expect(centroid).toBeGreaterThanOrEqual(brighter);
      brighter = centroid;
    }
  });

  it('unison detunes symmetrically: copies mirrored about the note, for even and odd counts', () => {
    const copies = (n: number) => {
      const s = new Fm6Synth(SR, 'Bright Tines', solo({ 'uni:voices': n, 'uni:detune': 10 }));
      s.noteOn(60, 100);
      const v = (s as unknown as { voices: { dr: Float64Array }[] }).voices[0];
      return Array.from(v?.dr ?? []).map((r) => 1200 * Math.log2(r));
    };
    const even = copies(4).sort((a, b) => a - b);
    expect(even.map((c) => Math.round(c))).toEqual([-15, -5, 5, 15]);
    const odd = copies(3).sort((a, b) => a - b);
    expect(odd.map((c) => Math.round(c))).toEqual([-10, 0, 10]);
    // heard: two copies 20 cents apart, at equal levels either side of the note
    const s = new Fm6Synth(SR, 'Bright Tines', solo({ 'uni:voices': 2, 'uni:detune': 20 }));
    s.noteOn(69, 100);
    const x = play(s, 2).l.subarray(SR * 0.2);
    const up = tone(x, 440 * 2 ** (10 / 1200));
    const down = tone(x, 440 * 2 ** (-10 / 1200));
    expect(up / down).toBeGreaterThan(0.9);
    expect(up / down).toBeLessThan(1.1);
  });

  it('counts unison copies against its voices: a chord thins its unison rather than losing notes', () => {
    const s = new Fm6Synth(SR, 'Bright Tines', solo({ 'uni:voices': 4, 'voice:poly': 8 }));
    const voices = () =>
      (s as unknown as { voices: { done: boolean; key: number; sounding: number; highest(): number }[] }).voices.filter(
        (v) => !v.done,
      );
    s.noteOn(48, 100);
    s.noteOn(52, 100);
    s.noteOn(55, 100);
    play(s, 0.05);
    const now = voices();
    expect(now.map((v) => v.key).sort()).toEqual([48, 52, 55]);
    expect(now.reduce((n, v) => n + v.sounding, 0)).toBeLessThanOrEqual(8);
    for (const v of now) expect(v.sounding).toBeGreaterThan(0);
    // the newest note took the highest unison copies of the others, not their first ones
    expect(now.find((v) => v.key === 48)?.highest()).toBeLessThan(3);
    // with one copy each, the oldest note gives way once all eight are taken
    const t = new Fm6Synth(SR, 'Bright Tines', solo({ 'voice:poly': 8 }));
    for (let k = 0; k < 10; k++) t.noteOn(48 + k, 100);
    play(t, 0.05);
    expect(t.active).toBe(8);
  });

  it('plays a whole patch from params alone, with a waveform the sound brings', () => {
    // a square wave of 64 points as w1, played by operator 1
    const square: Record<string, number> = {};
    for (let i = 0; i < 64; i++) square[`w1:${i}`] = i < 32 ? 0.8 : -0.8;
    const s = new Fm6Synth(SR, 'Solid Bass', solo({ 'op1:custom': 1, ...square }));
    s.noteOn(57, 127);
    const x = play(s, 0.6).l.subarray(SR * 0.1);
    const f = hz(57);
    const h1 = tone(x, f);
    expect(tone(x, f * 3) / h1).toBeGreaterThan(0.3);
    expect(tone(x, f * 3) / h1).toBeLessThan(0.36);
    expect(tone(x, f * 2)).toBeLessThan(h1 * 0.01);
    expect(tone(x, f * 4)).toBeLessThan(h1 * 0.01);
    // and the palette check takes such a sound as written
    const sound = {
      name: 'Square',
      family: 'Synths',
      instrument: { synth: 'Solid Bass', params: solo({ 'op1:custom': 1, ...square }) },
    };
    expect(checkSound(sound)).toEqual({ missing: [], problems: [] });
  });

  it('a filter in the matrix: a low cutoff darkens what the operators send it', () => {
    const through = (cutoff: number) => {
      const s = new Fm6Synth(
        SR,
        'Bright Tines',
        solo({ 'op1:wave': 2, 'op1:out': 0, 'op1:filter': 1, 'flt:out': 1, 'flt:cutoff': cutoff }),
      );
      s.noteOn(48, 127);
      const x = play(s, 0.6).l.subarray(SR * 0.1);
      return tone(x, hz(48) * 8) / tone(x, hz(48));
    };
    expect(through(200)).toBeLessThan(through(8000) * 0.1);
  });

  it('an envelope loops while the key is held, and holds where it has no loop', () => {
    const looped = new Fm6Synth(
      SR,
      'Bright Tines',
      solo({
        'env1:n': 4,
        'env1:t0': 0.01,
        'env1:l0': 1,
        'env1:t1': 0.1,
        'env1:l1': 0.1,
        'env1:t2': 0.1,
        'env1:l2': 1,
        'env1:t3': 0.05,
        'env1:l3': 0,
        'env1:sus': 2,
        'env1:loop': 0,
      }),
    );
    looped.noteOn(60, 127);
    const { l } = play(looped, 1);
    const level = (a: number) => peak(l.subarray(Math.round(a * SR), Math.round((a + 0.02) * SR)));
    // down at 0.11 s, up at 0.21, down at 0.31, up at 0.41…
    expect(level(0.1)).toBeLessThan(level(0.2) * 0.3);
    expect(level(0.3)).toBeLessThan(level(0.4) * 0.3);
    expect(level(0.7)).toBeLessThan(level(0.8) * 0.3);
  });

  it('a knob turned while a note sounds changes it in place', () => {
    const s = new Fm6Synth(SR, 'Wire Lead', { chorus: 0 });
    s.noteOn(60, 100);
    const f = hz(60);
    const before = play(s, 0.4).l.subarray(SR * 0.2);
    s.update({ brightness: 0.1, chorus: 0 });
    expect(s.active).toBe(1);
    const after = play(s, 0.4).l.subarray(SR * 0.2);
    expect(tone(after, f * 3) / tone(after, f)).toBeLessThan((tone(before, f * 3) / tone(before, f)) * 0.5);
  });

  it('harder playing is brighter where the modulators follow velocity', () => {
    for (const preset of ['Bright Tines', 'Solid Bass', 'Spark Pluck']) {
      const at = (v: number) => {
        const s = new Fm6Synth(SR, preset, { chorus: 0 });
        s.noteOn(57, v);
        const x = play(s, 0.15).l;
        return tone(x, hz(57) * 3) / tone(x, hz(57));
      };
      expect(at(127), preset).toBeGreaterThan(at(40));
    }
  });

  it('a patch may limit how long an envelope stretch lasts, carrying the rest into the next', () => {
    const slow = (longest: number) => {
      // a fall over a minute, let go after a moment: the release is short, unless the minute was cut
      // short and what it was owed carries into the release
      const s = new Fm6Synth(
        SR,
        'Bright Tines',
        solo({
          'env1:n': 3,
          'env1:t0': 0.002,
          'env1:l0': 1,
          'env1:t1': 60,
          'env1:l1': 0,
          'env1:t2': 0.05,
          'env1:l2': 0,
          'env1:sus': 1,
          'voice:longest': longest,
        }),
      );
      s.noteOn(60, 100);
      play(s, 0.2);
      s.noteOff(60);
      play(s, 1);
      return s.active;
    };
    expect(slow(0)).toBe(0);
    expect(slow(2)).toBe(1);
  });
});
