import { newBus, newProject, newRegion, newTrack, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { compileGraph, compileTempo, compileTrack, meterTicks } from '../src/compile.ts';
import { EngineCore } from '../src/core.ts';
import { Smooth } from '../src/dsp.ts';
import type { ToWorklet } from '../src/protocol.ts';

const SR = 48000;
const BLOCK = 128;

/** A song of three tracks into two buses: one panned hard, one muted, one with its fader at the bottom; sends on all. */
function song(lanes: boolean): Project {
  const p = newProject('Strips');
  p.tempo = [{ tick: 0, bpm: 120 }];
  const a = newBus('A');
  const b = newBus('B');
  p.buses = [a, b];
  p.master.inserts = [];
  const settings: [number, number, boolean][] = [
    [-7, 1, false],
    [-3, -0.35, false],
    [-144, 0.2, false],
    [-9, 0, true],
  ];
  p.tracks = settings.map(([volume, pan, mute], i) => {
    const t = newTrack(`T${i}`, { type: 'synth', preset: 'Soft Keys' });
    t.regions = [
      {
        ...newRegion(0, PPQ * 32),
        notes: [0, 1, 2, 3, 4, 5].map((n) => ({ t: n * PPQ * 2, d: PPQ, p: 55 + i * 4 + n, v: 96 })),
      },
    ];
    t.channel.volume = volume;
    t.channel.pan = pan;
    t.channel.mute = mute;
    t.channel.sends = [
      { bus: a.id, level: -10 - i, pre: false },
      { bus: b.id, level: -18, pre: i % 2 === 1 },
    ];
    // the same settings as lanes that never move: the long way round to the same numbers
    if (lanes)
      t.channel.automation = [
        {
          param: 'volume',
          mode: 'read',
          points: [
            [0, volume],
            [PPQ * 64, volume],
          ],
        },
        {
          param: 'pan',
          mode: 'read',
          points: [
            [0, pan],
            [PPQ * 64, pan],
          ],
        },
      ];
    return t;
  });
  return p;
}

function play(p: Project, blocks: number): Float32Array[] {
  const nums = new Map<string, number>();
  const numOf = (id: string) => {
    if (!nums.has(id)) nums.set(id, nums.size + 1);
    return nums.get(id) as number;
  };
  const segments = compileTempo(p, SR);
  const core = new EngineCore(SR, (m) => {
    if (m.type === 'error') throw new Error(m.message);
  });
  const messages: ToWorklet[] = [
    { type: 'init', ring: null, meters: null, transport: null },
    { type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) },
    { type: 'graph', graph: compileGraph(p, numOf, segments) },
    ...p.tracks.map((t): ToWorklet => ({ type: 'sequence', num: numOf(t.id), events: compileTrack(t, segments) })),
    { type: 'play', frame: 0, record: false, countIn: 0 },
  ];
  for (const m of messages) core.receive(m);
  const L = new Float32Array(blocks * BLOCK);
  const R = new Float32Array(blocks * BLOCK);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let k = 0; k < blocks; k++) {
    core.process(l, r, undefined, k * BLOCK);
    L.set(l, k * BLOCK);
    R.set(r, k * BLOCK);
  }
  return [L, R];
}

describe('a gain on its way to where it was set', () => {
  it('comes to rest, and stepping it on leaves it exactly there', () => {
    const g = new Smooth(1, SR);
    g.set(0.25);
    expect(g.still).toBe(false);
    for (let i = 0; i < SR * 2; i++) g.step();
    expect(g.still).toBe(true);
    // (at its target, or the last rounding short of it)
    expect(Math.abs(g.value - 0.25)).toBeLessThan(1e-12);
    const at = g.value;
    for (let i = 0; i < 1000; i++) g.step();
    expect(g.value).toBe(at);
    // set again, it moves again
    g.set(0.5);
    expect(g.still).toBe(false);
  });

  it('lands on nought once it is within the smallest numbers of it, and nowhere before', () => {
    const g = new Smooth(1, SR);
    g.set(0);
    for (let i = 0; i < 1000; i++) g.step();
    const before = g.value;
    g.land();
    expect(g.value).toBe(before);
    // (left to step, it never arrives: the smallest number there is, for good)
    for (let i = 0; i < SR * 20; i++) g.step();
    expect(g.value).toBeGreaterThan(0);
    expect(g.value).toBeLessThan(1e-300);
    g.land();
    expect(g.value).toBe(0);
    expect(g.still).toBe(true);
  });
});

describe('strips whose fader, balance and sends are where they were set', () => {
  it('play the same numbers as the same settings held by lanes, bit for bit, once the faders have arrived', () => {
    const blocks = Math.round((6 * SR) / BLOCK);
    const plain = play(song(false), blocks);
    const held = play(song(true), blocks);
    // (the first seconds a fader glides to its setting where a lane is there at once)
    const from = 3 * SR;
    let loud = 0;
    for (let c = 0; c < 2; c++) {
      const a = (plain[c] as Float32Array).subarray(from);
      const b = (held[c] as Float32Array).subarray(from);
      for (let i = 0; i < a.length; i++) {
        if (!Object.is(a[i], b[i])) throw new Error(`channel ${c}, frame ${from + i}: ${a[i]} against ${b[i]}`);
        loud = Math.max(loud, Math.abs(a[i] as number));
      }
    }
    expect(loud).toBeGreaterThan(0.01);
  });
});
