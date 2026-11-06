import { newProject, newRegion, newTrack, PPQ } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { FatSynth } from '../src/analog.ts';
import { compileGraph, compileTempo } from '../src/compile.ts';
import { EngineCore } from '../src/core.ts';
import { EtherealSynth } from '../src/ethereal.ts';
import type { Instrument } from '../src/instrument.ts';

const SR = 48000;

/** Render `seconds` of an instrument, returning the left channel. */
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

const rms = (x: Float32Array, from: number, to: number) => {
  let s = 0;
  for (let i = from; i < to; i++) s += (x[i] as number) ** 2;
  return Math.sqrt(s / (to - from));
};

describe('Fat Mono', () => {
  it('plays one note at a time: legato it glides there without starting again, let go it falls back', () => {
    const s = new FatSynth(SR, 'Fat Mono', { glide: 0.2, cutoff: 400, contour: 0, emphasis: 0 });
    const voice = () => (s as unknown as { voices: { pitch: number; key: number }[] }).voices[0];
    s.noteOn(36, 100);
    const a = play(s, 0.5);
    s.noteOn(48, 100); // legato: C2 held, C3 played
    const start = play(s, 0.03);
    // one voice, on its way up (not there at once)
    expect(s.active).toBe(1);
    expect(voice()?.pitch).toBeGreaterThan(36.5);
    expect(voice()?.pitch).toBeLessThan(47);
    // the envelope carried on: no new attack at the change
    expect(rms(start, 0, start.length) / rms(a, SR * 0.4, SR * 0.5)).toBeGreaterThan(0.6);
    play(s, 0.6);
    expect(voice()?.pitch).toBeCloseTo(48, 1);
    s.noteOff(48); // back to C2, still held
    play(s, 0.8);
    expect(voice()?.pitch).toBeCloseTo(36, 1);
    expect(s.active).toBe(1);
    s.noteOff(36);
    play(s, 0.5);
    expect(s.active).toBe(0);
    // with no glide it's there at once
    const t = new FatSynth(SR, 'Fat Mono', { glide: 0 });
    t.noteOn(36, 100);
    play(t, 0.1);
    t.noteOn(43, 100);
    expect((t as unknown as { voices: { pitch: number }[] }).voices[0]?.pitch).toBe(43);
  });

  it('sustains under the pedal, and goes on to the next note from where it is', () => {
    const s = new FatSynth(SR, 'Fat Mono');
    s.cc(64, 127);
    s.noteOn(40, 100);
    play(s, 0.1);
    s.noteOff(40);
    play(s, 0.3);
    expect(s.active).toBe(1);
    s.cc(64, 0);
    play(s, 0.5);
    expect(s.active).toBe(0);
  });

  it('takes a knob turned while it plays, without cutting the note', () => {
    const s = new FatSynth(SR, 'Fat Mono', { cutoff: 200, contour: 0 });
    s.noteOn(36, 100);
    const dark = play(s, 0.4);
    s.update({ cutoff: 6000, contour: 0 });
    const bright = play(s, 0.4);
    expect(s.active).toBe(1);
    // brighter: more of its sound is in its quick changes
    const edge = (x: Float32Array) => {
      let d = 0;
      for (let i = 1; i < x.length; i++) d += Math.abs((x[i] as number) - (x[i - 1] as number));
      return d / rms(x, 0, x.length);
    };
    expect(edge(bright.subarray(SR * 0.1))).toBeGreaterThan(edge(dark.subarray(SR * 0.1)) * 2);
  });

  it('stays finite and under control with every knob up', () => {
    const s = new FatSynth(SR, 'Fat Mono', { emphasis: 1, drive: 1, contour: 1, cutoff: 12000 });
    s.noteOn(24, 127);
    const x = play(s, 2);
    expect(x.every(Number.isFinite)).toBe(true);
    expect(peak(x)).toBeLessThan(1.5);
  });
});

describe('Fat Poly', () => {
  it('plays chords, and the same notes make the same sound', () => {
    const run = () => {
      const s = new FatSynth(SR, 'Fat Poly');
      for (const k of [48, 52, 55]) s.noteOn(k, 90);
      const x = play(s, 0.3);
      return { x, active: s.active };
    };
    const a = run();
    expect(a.active).toBe(3);
    expect(run().x).toEqual(a.x);
  });
});

describe('Ethereal', () => {
  it('keeps sounding while its hall rings after the last voice, then stops', () => {
    const s = new EtherealSynth(SR, 'Ethereal Keys', { release: 0.2, space: 0.15, shimmer: 0 });
    s.noteOn(72, 100);
    play(s, 0.3);
    s.noteOff(72);
    play(s, 3);
    // the voice has gone, the hall hasn't
    const tail = play(s, 0.5);
    expect(rms(tail, 0, tail.length)).toBeGreaterThan(1e-5);
    expect(s.active).toBe(1);
    play(s, 12);
    expect(s.active).toBe(0);
  }, 30000);

  it('is wide: its two sides are different sounds', () => {
    const s = new EtherealSynth(SR, 'Ethereal Pad');
    s.noteOn(60, 90);
    const n = SR * 2;
    const l = new Float32Array(n);
    const r = new Float32Array(n);
    for (let at = 0; at < n; at += 128) s.render(l, r, at, Math.min(n, at + 128));
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = SR; i < n; i++) {
      lr += (l[i] as number) * (r[i] as number);
      ll += (l[i] as number) ** 2;
      rr += (r[i] as number) ** 2;
    }
    expect(lr / Math.sqrt(ll * rr)).toBeLessThan(0.8);
  });

  it('stays finite with every knob up and a dense chord held', () => {
    const s = new EtherealSynth(SR, 'Ethereal Pad', { shimmer: 1, space: 1, brightness: 14000, motion: 1 });
    for (const k of [36, 48, 55, 60, 64, 67, 71, 74, 79, 84]) s.noteOn(k, 127);
    const x = play(s, 4);
    expect(x.every(Number.isFinite)).toBe(true);
    expect(peak(x)).toBeLessThan(2);
  });
});

describe('a synth in the engine', () => {
  it('renders in a song, the same numbers every time', async () => {
    const { renderSession } = await import('../src/render.ts');
    const p = newProject('Synths');
    p.tempo = [{ tick: 0, bpm: 100 }];
    const bass = newTrack('Bass', { type: 'synth', preset: 'Fat Mono' });
    const pad = newTrack('Pad', { type: 'synth', preset: 'Ethereal Pad', params: { bloom: 0.2 } });
    bass.regions = [
      {
        ...newRegion(0, PPQ * 4),
        notes: [0, 1, 2, 3].map((i) => ({ t: i * PPQ, d: PPQ * 1.2, p: 36 + i * 3, v: 100 })),
      },
    ];
    pad.regions = [{ ...newRegion(0, PPQ * 4), notes: [60, 64, 67].map((k) => ({ t: 0, d: PPQ * 4, p: k, v: 80 })) }];
    p.tracks = [bass, pad];
    const source = {
      instrument: () => Promise.reject(new Error('no packs here')),
      sample: () => Promise.reject(new Error('no packs here')),
      audio: () => Promise.reject(new Error('no audio here')),
      impulse: () => Promise.reject(new Error('no packs here')),
    };
    const a = await renderSession(p, source, { sampleRate: SR, tail: 2 });
    const b = await renderSession(p, source, { sampleRate: SR, tail: 2 });
    expect(a.errors).toEqual([]);
    const left = a.channels[0] as Float32Array;
    expect(rms(left, 0, left.length)).toBeGreaterThan(0.01);
    expect(Buffer.from(left.buffer).equals(Buffer.from((b.channels[0] as Float32Array).buffer))).toBe(true);
  });

  it('takes its knobs where it is, and is made again for another preset', () => {
    const core = new EngineCore(SR, () => undefined);
    const p = newProject('t');
    const track = newTrack('Bass', { type: 'synth', preset: 'Fat Mono' });
    p.tracks = [track];
    const send = () =>
      core.receive({ type: 'graph', graph: compileGraph(p, () => 1, compileTempo(p, SR)) } as Parameters<
        typeof core.receive
      >[0]);
    const instrument = () =>
      (core as unknown as { tracks: Map<number, { instruments: unknown[] }> }).tracks.get(1)?.instruments[0];
    send();
    const first = instrument();
    expect(first).toBeInstanceOf(FatSynth);
    track.instrument = { type: 'synth', preset: 'Fat Mono', params: { cutoff: 3000 } };
    send();
    expect(instrument()).toBe(first);
    track.instrument = { type: 'synth', preset: 'Ethereal Pad' };
    send();
    expect(instrument()).toBeInstanceOf(EtherealSynth);
  });
});
