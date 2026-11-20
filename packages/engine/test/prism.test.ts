import { newProject, newTrack, SRC_LFO, SRC_MACRO, SYNTH_MACROS, TGT_PITCH } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { compileGraph, compileTempo } from '../src/compile.ts';
import { EngineCore } from '../src/core.ts';
import { PRISM_PRESETS, PrismSynth } from '../src/prism.ts';
import { type PartialSet, pitchSpread, readPartials, writePartials } from '../src/prism-sources.ts';
import type { SamplerSpec, SampleZone } from '../src/protocol.ts';

const SR = 48000;
const host = (beatSeconds = 0.5) => ({ beatSeconds: () => beatSeconds, beatAt: () => 0, playing: () => false });

function play(
  s: PrismSynth,
  seconds: number,
  at?: { t: number; fn: () => void }[],
): { l: Float32Array; r: Float32Array } {
  const n = Math.round(seconds * SR);
  const l = new Float32Array(n);
  const r = new Float32Array(n);
  const due = [...(at ?? [])].sort((a, b) => a.t - b.t);
  for (let i = 0; i < n; i += 128) {
    while (due.length && (due[0] as { t: number }).t * SR <= i) due.shift()?.fn();
    s.render(l, r, i, Math.min(n, i + 128));
  }
  return { l, r };
}

const peak = (x: Float32Array) => {
  let p = 0;
  for (const v of x) p = Math.max(p, Math.abs(v));
  return p;
};
const rms = (x: Float32Array, a = 0, b = x.length) => {
  let s = 0;
  for (let i = a; i < b; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / Math.max(1, b - a));
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

const hz = (key: number) => 440 * 2 ** ((key - 69) / 12);
const cents = (a: number, b: number) => 1200 * Math.log2(a / b);

/** A whole patch from nothing: source 1 one sine oscillator, its level held, no velocity on it. */
const solo = (more: Record<string, number> = {}): Record<string, number> => ({
  'patch:blank': 1,
  's1:wave': 0,
  'mod1:src': 0,
  'env1:a': 0.002,
  'env1:r': 0.05,
  'amp:level': 0.5,
  ...more,
});

/** A partial set of steady partials (ratio, level), lasting a second. */
function steady(parts: [number, number][]): PartialSet {
  return {
    length: 1,
    loopStart: 0,
    loopEnd: 0,
    pitch: null,
    partials: parts.map(([ratio, amp]) => ({
      phase: 0,
      t: Float32Array.from([0, 1]),
      amp: Float32Array.from([amp, amp]),
      ratio: Float32Array.from([ratio, ratio]),
      pan: null,
    })),
  };
}

const zone = (o: Partial<SampleZone>): SampleZone => ({
  left: new Float32Array(0),
  right: null,
  root: 60,
  lo: 0,
  hi: 127,
  lovel: 0,
  hivel: 127,
  gain: 1,
  loopStart: 0,
  loopEnd: 0,
  rr: 0,
  ...o,
});

const media = (zones: SampleZone[]): SamplerSpec => ({
  key: 'mine/patch',
  zones,
  release: 0.1,
  oneShot: false,
  pitched: true,
  velocityRange: 0,
  attack: 0,
  synth: 'Pulse Bells',
});

describe('Prism', () => {
  for (const preset of PRISM_PRESETS) {
    it(`${preset}: six knobs, finite and in bounds at either end of every knob, and ends after release`, () => {
      expect(SYNTH_MACROS[preset]?.length).toBe(6);
      const chord = [36, 48, 55, 60, 64, 67, 72, 79];
      for (const v of [0, 1]) {
        const knobs = Object.fromEntries(['m1', 'm2', 'm3', 'm4', 'm5', 'm6'].map((k) => [k, v]));
        const s = new PrismSynth(SR, preset, knobs, host());
        for (const k of chord) s.noteOn(k, 127);
        const { l, r } = play(s, 1.2);
        expect(l.every(Number.isFinite) && r.every(Number.isFinite)).toBe(true);
        expect(Math.max(peak(l), peak(r))).toBeLessThanOrEqual(1);
        expect(Math.max(peak(l), peak(r))).toBeGreaterThan(0.005);
      }
      // with a short release and no effects, everything stops soon after the keys are let go
      const dry = Object.fromEntries([1, 2, 3, 4, 5, 6].map((k) => [`fx${k}:type`, 0]));
      const t = new PrismSynth(SR, preset, { ...dry, 'env1:r': 0.1 }, host());
      for (const k of chord) t.noteOn(k, 100);
      play(t, 0.6);
      for (const k of chord) t.noteOff(k);
      play(t, 1);
      expect(t.active).toBe(0);
    });
  }

  it('plays the same numbers every time', () => {
    for (const preset of ['Pulse Bells', 'Drift Pad', 'Tide Field']) {
      const once = () => {
        const s = new PrismSynth(SR, preset, {}, host());
        s.noteOn(60, 100);
        s.noteOn(67, 90);
        return play(s, 1).l;
      };
      expect(Buffer.from(once().buffer).equals(Buffer.from(once().buffer)), preset).toBe(true);
    }
  });

  it('an oscillator plays the note asked for; a harmonic bank of sines is additive, each partial at its spread', () => {
    for (const key of [45, 72]) {
      const s = new PrismSynth(SR, 'Pulse Bells', solo(), host());
      s.noteOn(key, 100);
      const { l } = play(s, 0.5);
      const f = pitch(l.subarray(SR * 0.1, SR * 0.1 + 8000), hz(key));
      expect(Math.abs(cents(f, hz(key))), String(key)).toBeLessThan(2);
    }
    // four sines on harmonics 1…4, falling as 1/n
    const s = new PrismSynth(SR, 'Pulse Bells', solo({ 's1:count': 4, 's1:pitcha': 2, 's1:ampa': 5 }), host());
    s.noteOn(57, 100);
    const x = play(s, 0.6).l.subarray(SR * 0.1);
    const f = hz(57);
    const h1 = tone(x, f);
    for (const k of [2, 3, 4]) expect(tone(x, f * k) / h1).toBeCloseTo(1 / k, 2);
    expect(tone(x, f * 5) / h1).toBeLessThan(1e-3);
    // a fractional count plays the last one that much
    const t = new PrismSynth(SR, 'Pulse Bells', solo({ 's1:count': 2.5, 's1:pitcha': 2 }), host());
    t.noteOn(57, 100);
    const y = play(t, 0.6).l.subarray(SR * 0.1);
    expect(tone(y, f * 3) / tone(y, f)).toBeCloseTo(0.5, 1);
  });

  it('keeps its oscillators below the top: a saw high up has no aliases between its harmonics', () => {
    const s = new PrismSynth(SR, 'Pulse Bells', solo({ 's1:wave': 2 }), host());
    s.noteOn(98, 100);
    const x = play(s, 0.5).l.subarray(SR * 0.1);
    const f = hz(98);
    const fundamental = tone(x, f);
    for (const k of [1.5, 2.5, 3.5, 4.5]) expect(tone(x, f * k) / fundamental, String(k)).toBeLessThan(2e-3);
  });

  it('spreads detune either way, and lay out partial and bar ratios', () => {
    expect(pitchSpread(1, 0, 10)).toBe(1);
    expect(cents(pitchSpread(1, 1, 10), 1)).toBeCloseTo(-10, 1);
    expect(cents(pitchSpread(1, 2, 10), 1)).toBeCloseTo(20, 1);
    expect([0, 1, 2, 3].map((k) => pitchSpread(2, k, 0))).toEqual([1, 2, 3, 4]);
    expect([0, 1, 2].map((k) => pitchSpread(3, k, 0))).toEqual([1, 3, 5]);
    expect(pitchSpread(6, 1, 0)).toBeCloseTo(2.756, 2);
    expect(pitchSpread(6, 2, 0)).toBeCloseTo(5.404, 2);
  });

  it('reads back a partial set as it was written, and refuses what is not one', () => {
    const set: PartialSet = {
      length: 2.5,
      loopStart: 0.5,
      loopEnd: 2,
      pitch: { t: Float32Array.from([0, 1]), st: Float32Array.from([0, -0.5]) },
      partials: [
        {
          phase: 0.25,
          t: Float32Array.from([0, 0.1, 2]),
          amp: Float32Array.from([0, 1, 0]),
          ratio: Float32Array.from([1, 1.001, 1]),
          pan: null,
        },
        {
          phase: 0,
          t: Float32Array.from([0, 2]),
          amp: Float32Array.from([0.5, 0]),
          ratio: Float32Array.from([2, 2]),
          pan: Float32Array.from([-0.5, 0.5]),
        },
      ],
    };
    const back = readPartials(writePartials(set));
    expect(back).toEqual(set);
    expect(readPartials(new Uint8Array(40))).toBeNull();
    const cut = writePartials(set).slice(0, 60);
    expect(readPartials(cut)).toBeNull();
  });

  it("plays a pack's partial set and sample on the sources they're for", () => {
    // source 1: one partial an octave up; source 3: a sampled 440 Hz sine, its root A4
    const sine = new Float32Array(SR);
    for (let i = 0; i < SR; i++) sine[i] = Math.sin((2 * Math.PI * 440 * i) / SR) * 0.5;
    const m = media([
      zone({ source: 1, partials: steady([[2, 0.5]]) }),
      zone({ source: 3, left: sine, root: 69, loopStart: 0, loopEnd: SR }),
    ]);
    const parts = new PrismSynth(SR, 'Pulse Bells', solo({ 's1:kind': 1, 's1:data': 0, 's1:partials': 4 }), null, m);
    parts.noteOn(60, 100);
    const a = play(parts, 0.5).l.subarray(SR * 0.1);
    expect(Math.abs(cents(pitch(a, hz(72)), hz(72)))).toBeLessThan(2);
    const sample = new PrismSynth(
      SR,
      'Pulse Bells',
      solo({ 's1:on': 0, 's3:on': 1, 's3:kind': 2, 's3:data': 0, 's3:loop': 1 }),
      null,
      m,
    );
    sample.noteOn(81, 100);
    const b = play(sample, 0.5).l.subarray(SR * 0.1);
    expect(Math.abs(cents(pitch(b, 880), 880))).toBeLessThan(3);
  });

  it('morphs between its corners: at one corner only that source is heard', () => {
    // four sources a fifth and octaves apart, each its own pitch
    const four = {
      's1:coarse': 0,
      's2:on': 1,
      's2:wave': 0,
      's2:coarse': 7,
      's3:on': 1,
      's3:wave': 0,
      's3:coarse': 12,
      's4:on': 1,
      's4:wave': 0,
      's4:coarse': 19,
      'xy:on': 1,
    };
    const corner = (x: number, y: number) => {
      const s = new PrismSynth(SR, 'Pulse Bells', solo({ ...four, 'xy:x': x, 'xy:y': y }), host());
      s.noteOn(48, 100);
      const l = play(s, 0.5).l.subarray(SR * 0.1);
      return [0, 7, 12, 19].map((st) => tone(l, hz(48 + st)));
    };
    for (const [x, y, which] of [
      [0, 0, 0],
      [1, 0, 1],
      [0, 1, 2],
      [1, 1, 3],
    ] as [number, number, number][]) {
      const levels = corner(x, y);
      const heard = levels[which] as number;
      expect(heard).toBeGreaterThan(0.05);
      levels.forEach((v, i) => {
        if (i !== which) expect(v / heard).toBeLessThan(1e-3);
      });
    }
    // in the middle, all four at once, equally (equal power)
    const mid = corner(0.5, 0.5);
    for (const v of mid) expect(v / (mid[0] as number)).toBeCloseTo(1, 1);
  });

  it('moves its targets through the matrix: an LFO on pitch swings it by its depth, a knob at the middle changes nothing', () => {
    // a square LFO at 2 Hz, a twelfth of the pitch range (8 semitones) at full depth
    const vib = solo({
      'lfo1:shape': 4,
      'lfo1:rate': 2,
      'mod2:src': SRC_LFO,
      'mod2:dst': TGT_PITCH,
      'mod2:depth': 1 / 12,
    });
    const s = new PrismSynth(SR, 'Pulse Bells', vib, host());
    s.noteOn(60, 100);
    const { l } = play(s, 0.5);
    // the first half cycle up 8 semitones, the second down 8
    const up = pitch(l.subarray(SR * 0.05, SR * 0.2), hz(68));
    const down = pitch(l.subarray(SR * 0.3, SR * 0.45), hz(52));
    expect(Math.abs(cents(up, hz(68)))).toBeLessThan(5);
    expect(Math.abs(cents(down, hz(52)))).toBeLessThan(5);
    // a knob wired to pitch, at its middle: as if it weren't there
    const knob = solo({ 'mod2:src': SRC_MACRO + 2, 'mod2:dst': TGT_PITCH, 'mod2:depth': 0.5 });
    const a = new PrismSynth(SR, 'Pulse Bells', { ...knob, m3: 0.5 }, host());
    const b = new PrismSynth(SR, 'Pulse Bells', solo(), host());
    a.noteOn(60, 100);
    b.noteOn(60, 100);
    expect(Buffer.from(play(a, 0.3).l.buffer).equals(Buffer.from(play(b, 0.3).l.buffer))).toBe(true);
  });

  it('keeps a synced LFO to the tempo: a ramp sweeping partials strikes again on every beat', () => {
    const strikes = (beatSeconds: number) => {
      const s = new PrismSynth(SR, 'Pulse Bells', { m5: 0, m6: 0 }, host(beatSeconds));
      s.noteOn(60, 100);
      // (both sides: the strikes hop between them)
      const both = play(s, 3);
      const l = both.l.map((x, i) => x + (both.r[i] as number));
      // count the rises: frames of 20 ms, each strike well above the two frames before it
      const frame = SR * 0.02;
      const v: number[] = [];
      for (let f = 0; f * frame < l.length; f++) v.push(rms(l, f * frame, Math.min(l.length, (f + 1) * frame)));
      let count = 0;
      let since = 99;
      for (let f = 2; f < v.length; f++) {
        since++;
        if (since > 3 && (v[f] as number) > 3 * Math.min(v[f - 1] as number, v[f - 2] as number)) {
          count++;
          since = 0;
        }
      }
      return count;
    };
    // at 120 a quarter note is half a second: five more after the first in three seconds; at 150, seven
    expect(strikes(0.5)).toBe(5);
    expect(strikes(0.4)).toBe(7);
  });

  it('plays one note at a time when mono: legato glides on without starting again, and falls back to a held key', () => {
    const p = solo({ 'voice:mono': 1, 'voice:legato': 1, 'voice:glide': 0.05, 'env1:a': 0.3 });
    const s = new PrismSynth(SR, 'Pulse Bells', p, host());
    const { l } = play(s, 1.6, [
      { t: 0, fn: () => s.noteOn(60, 100) },
      { t: 0.5, fn: () => s.noteOn(67, 100) },
      { t: 1, fn: () => s.noteOff(67) },
    ]);
    expect(s.active).toBe(1);
    // the second note took over without its envelope starting again: no dip across the change
    const before = rms(l, SR * 0.45, SR * 0.5);
    const after = rms(l, SR * 0.5, SR * 0.55);
    expect(after / before).toBeGreaterThan(0.9);
    expect(Math.abs(cents(pitch(l.subarray(SR * 0.7, SR * 0.9), hz(67)), hz(67)))).toBeLessThan(3);
    // let go, it went back to the key still held
    expect(Math.abs(cents(pitch(l.subarray(SR * 1.3, SR * 1.5), hz(60)), hz(60)))).toBeLessThan(3);
  });

  it('a pack instrument that names it plays through it in the engine, its params its patch', () => {
    const core = new EngineCore(SR, () => undefined);
    core.receive({ type: 'sampler', spec: media([zone({ source: 1, partials: steady([[1, 0.5]]) })]) });
    const p = newProject('t');
    p.tracks = [newTrack('Bells', { type: 'sampler', pack: 'mine', name: 'patch', params: { m1: 0.7 } })];
    core.receive({ type: 'graph', graph: compileGraph(p, () => 1, compileTempo(p, SR)) } as Parameters<
      typeof core.receive
    >[0]);
    const inst = (core as unknown as { tracks: Map<number, { instruments: unknown[] }> }).tracks.get(1)?.instruments[0];
    expect(inst).toBeInstanceOf(PrismSynth);
  });
});
