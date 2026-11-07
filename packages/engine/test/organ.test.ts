import { newProject, newRegion, newTrack, PPQ } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { compileGraph, compileTempo } from '../src/compile.ts';
import { EngineCore } from '../src/core.ts';
import type { Instrument } from '../src/instrument.ts';
import { TonewheelOrgan } from '../src/organ.ts';

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

type Inside = { voices: { perc: number; ph: Float64Array; done: boolean }[]; hornHz: number };
const inside = (o: TonewheelOrgan) => o as unknown as Inside;

describe('Tonewheel organ', () => {
  it('strikes its percussion only on a detached note', () => {
    const o = new TonewheelOrgan(SR, 'Tonewheel Jazz', { rotor: 0, vibrato: 0 });
    o.noteOn(48, 100);
    play(o, 0.05);
    expect(inside(o).voices[0]?.perc).toBeGreaterThan(0.1);
    o.noteOn(55, 100); // legato: C3 still down
    expect(inside(o).voices[1]?.perc).toBe(0);
    o.noteOff(48);
    o.noteOff(55);
    play(o, 0.2);
    o.noteOn(60, 100); // detached again
    expect(inside(o).voices.find((v) => !v.done)?.perc).toBe(1);
  });

  it('shares each wheel between the keys that use it: an octave apart, they turn together', () => {
    const o = new TonewheelOrgan(SR, 'Tonewheel Jazz', { rotor: 0 });
    o.noteOn(60, 100);
    play(o, 0.31);
    o.noteOn(72, 100);
    play(o, 0.1);
    const [low, high] = inside(o).voices;
    // C4's 4′ drawbar and C5's 8′ are the same wheel
    expect(high?.ph[2]).toBeCloseTo(low?.ph[3] as number, 9);
  });

  it('turns its rotor: the two microphones differ, and the mod wheel speeds it up', () => {
    const o = new TonewheelOrgan(SR, 'Tonewheel Gospel', { rotor: 1 });
    for (const k of [48, 55, 60, 64]) o.noteOn(k, 100);
    const { l, r } = play(o, 1.5);
    let lr = 0;
    let ll = 0;
    let rr = 0;
    for (let i = SR / 2; i < l.length; i++) {
      lr += (l[i] as number) * (r[i] as number);
      ll += (l[i] as number) ** 2;
      rr += (r[i] as number) ** 2;
    }
    expect(lr / Math.sqrt(ll * rr)).toBeLessThan(0.97);
    expect(inside(o).hornHz).toBeLessThan(1);
    o.cc(1, 127);
    play(o, 3);
    expect(inside(o).hornHz).toBeGreaterThan(6);
  });

  it('stays finite and in bounds with every knob up and a dense chord held', () => {
    const o = new TonewheelOrgan(SR, 'Tonewheel Rock', {
      drawbars: 6,
      percussion: 2,
      click: 1,
      vibrato: 6,
      rotor: 2,
      drive: 1,
    });
    for (const k of [24, 36, 48, 55, 60, 64, 67, 71, 74, 79, 84, 96, 108]) o.noteOn(k, 127);
    const { l, r } = play(o, 2);
    expect(l.every(Number.isFinite) && r.every(Number.isFinite)).toBe(true);
    expect(peak(l)).toBeLessThan(2);
    for (const k of [24, 36, 48, 55, 60, 64, 67, 71, 74, 79, 84, 96, 108]) o.noteOff(k);
    play(o, 0.2);
    expect(o.active).toBe(0);
  });

  it('takes its knobs where it is, and renders the same numbers every time', async () => {
    const core = new EngineCore(SR, () => undefined);
    const p = newProject('t');
    const track = newTrack('Organ', { type: 'synth', preset: 'Tonewheel Jazz' });
    p.tracks = [track];
    const send = () =>
      core.receive({ type: 'graph', graph: compileGraph(p, () => 1, compileTempo(p, SR)) } as Parameters<
        typeof core.receive
      >[0]);
    const instrument = () =>
      (core as unknown as { tracks: Map<number, { instruments: unknown[] }> }).tracks.get(1)?.instruments[0];
    send();
    const first = instrument();
    expect(first).toBeInstanceOf(TonewheelOrgan);
    track.instrument = { type: 'synth', preset: 'Tonewheel Jazz', params: { drawbars: 6, rotor: 2 } };
    send();
    expect(instrument()).toBe(first);

    const { renderSession } = await import('../src/render.ts');
    const song = newProject('Organ');
    song.tempo = [{ tick: 0, bpm: 96 }];
    const organ = newTrack('Organ', { type: 'synth', preset: 'Tonewheel Gospel' });
    organ.regions = [
      { ...newRegion(0, PPQ * 4), notes: [48, 55, 60, 64].map((k) => ({ t: 0, d: PPQ * 3, p: k, v: 90 })) },
    ];
    song.tracks = [organ];
    const source = {
      instrument: () => Promise.reject(new Error('no packs here')),
      sample: () => Promise.reject(new Error('no packs here')),
      audio: () => Promise.reject(new Error('no audio here')),
      impulse: () => Promise.reject(new Error('no packs here')),
    };
    const a = await renderSession(song, source, { sampleRate: SR, tail: 1 });
    const b = await renderSession(song, source, { sampleRate: SR, tail: 1 });
    expect(a.errors).toEqual([]);
    expect(peak(a.channels[0] as Float32Array)).toBeGreaterThan(0.01);
    expect(
      Buffer.from((a.channels[0] as Float32Array).buffer).equals(Buffer.from((b.channels[0] as Float32Array).buffer)),
    ).toBe(true);
  });
});
