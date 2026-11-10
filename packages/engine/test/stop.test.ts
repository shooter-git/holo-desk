import { newPlugin, newProject, newRegion, newTrack, PPQ, type Project, type Track } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { compileGraph, compileTempo, compileTrack, meterTicks, tickToFrame } from '../src/compile.ts';
import { EngineCore } from '../src/core.ts';
import { createMidiEffect, EventList, type MidiHost } from '../src/midifx.ts';
import { EV_OFF, EV_ON, type ToWorklet } from '../src/protocol.ts';

const SR = 48000;
const BLOCK = 128;
/** 120 bpm: half a second a beat. */
const BEAT = 0.5;
const CHORD = [60, 64, 67];

/**
 * An Arpeggiator run a block at a time as the engine runs it, its notes followed into what's
 * sounding: `step` sets up each block (the song's clock, keys coming in) before it's played.
 */
function arpeggiate(params: Record<string, number>) {
  const clock = { beat: 0, playing: true };
  const host: MidiHost = {
    sr: SR,
    beatSeconds: () => BEAT,
    beatAt: () => clock.beat,
    playing: () => clock.playing,
  };
  const fx = createMidiEffect('arpeggiator', host);
  if (!fx) throw new Error('arpeggiator');
  fx.setParams(params);
  const input = new EventList();
  const output = new EventList();
  const sounding = new Map<number, number>();
  let frame = 0;
  let ons = 0;
  /** The longest any note has sounded (frames). */
  let longest = 0;
  const block = (keys: { on?: number[]; off?: number[] } = {}) => {
    input.clear();
    output.clear();
    for (const k of keys.off ?? []) input.push(0, EV_OFF, k, 0);
    for (const k of keys.on ?? []) input.push(0, EV_ON, k, 100);
    fx.process(input, output, BLOCK, true);
    for (let i = 0; i < output.count; i++) {
      const at = frame + (output.offset[i] as number);
      const key = output.a[i] as number;
      if (output.kind[i] === EV_ON) {
        ons++;
        sounding.set(key, at);
      } else if (output.kind[i] === EV_OFF && sounding.has(key)) {
        longest = Math.max(longest, at - (sounding.get(key) as number));
        sounding.delete(key);
      }
    }
    frame += BLOCK;
    if (clock.playing) clock.beat += BLOCK / (BEAT * SR);
  };
  const run = (seconds: number) => {
    for (let b = Math.round((seconds * SR) / BLOCK); b > 0; b--) block();
  };
  return {
    clock,
    block,
    run,
    sounding: () => sounding.size,
    ons: () => ons,
    longest: () => longest,
  };
}

/** A sixteenth at 80% gate: 0.2 of a beat. */
const SIXTEENTHS = { rate: 3, gate: 80 };
const STEP_FRAMES = 0.2 * BEAT * SR;

describe('the Arpeggiator when the song stops or jumps', () => {
  for (const bar of [1, 17, 65]) {
    it(`ends the note sounding at Stop, played from bar ${bar}`, () => {
      const a = arpeggiate(SIXTEENTHS);
      a.clock.beat = (bar - 1) * 4;
      a.block({ on: CHORD });
      // stop in the middle of a step, the chord still held by the song
      a.run(2.06);
      expect(a.sounding()).toBe(1);
      a.clock.playing = false;
      a.block({ off: CHORD });
      expect(a.sounding()).toBe(0);
      const ons = a.ons();
      a.run(5);
      expect(a.ons()).toBe(ons);
      expect(a.sounding()).toBe(0);
    });
  }

  it('lets a latched pattern go at Stop', () => {
    const a = arpeggiate({ ...SIXTEENTHS, latch: 1 });
    a.block({ on: CHORD });
    a.run(0.5);
    a.block({ off: CHORD });
    a.run(1.5);
    // latched: it plays on with the keys let go, while the song plays
    expect(a.ons()).toBeGreaterThan(10);
    a.clock.playing = false;
    a.block();
    const ons = a.ons();
    a.run(5);
    expect(a.ons()).toBe(ons);
    expect(a.sounding()).toBe(0);
  });

  it('ends what sounds when a cycle goes around, and plays on from its start', () => {
    const a = arpeggiate(SIXTEENTHS);
    a.clock.beat = 32;
    a.block({ on: CHORD });
    for (let turn = 0; turn < 3; turn++) {
      a.run(2.06);
      a.clock.beat = 32;
    }
    const ons = a.ons();
    a.run(1);
    expect(a.ons()).toBeGreaterThan(ons);
    expect(a.longest()).toBeLessThanOrEqual(STEP_FRAMES + BLOCK);
  });

  it('keeps live keys going across Play and Stop, every step its own length', () => {
    const a = arpeggiate(SIXTEENTHS);
    a.clock.playing = false;
    a.block({ on: CHORD });
    a.run(1.03);
    let ons = a.ons();
    expect(ons).toBeGreaterThan(0);
    // Play from bar 33 with the keys still down, then Stop with them still down
    a.clock.playing = true;
    a.clock.beat = 128;
    a.run(1.03);
    expect(a.ons()).toBeGreaterThan(ons);
    ons = a.ons();
    a.clock.playing = false;
    a.run(1.03);
    expect(a.ons()).toBeGreaterThan(ons);
    a.block({ off: CHORD });
    a.run(1);
    expect(a.sounding()).toBe(0);
    expect(a.longest()).toBeLessThanOrEqual(STEP_FRAMES + BLOCK);
  });
});

interface Held {
  active: number;
  voices: { released: boolean; done: boolean }[];
}

/** A song on the engine as the studio plays it: its tracks numbered from 1, in order. */
function studio(p: Project) {
  const core = new EngineCore(SR, (m) => {
    if (m.type === 'error') throw new Error(m.message);
  });
  const segments = compileTempo(p, SR);
  const numOf = (id: string) => p.tracks.findIndex((t) => t.id === id) + 1;
  const send = (msg: ToWorklet) => core.receive(msg);
  send({ type: 'init', ring: null, meters: null, transport: null });
  send({ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) });
  const graph = () => send({ type: 'graph', graph: compileGraph(p, numOf, segments) });
  graph();
  for (const t of p.tracks) send({ type: 'sequence', num: numOf(t.id), events: compileTrack(t, segments) });
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  let at = 0;
  const run = (seconds: number) => {
    for (let b = Math.round((seconds * SR) / BLOCK); b > 0; b--) {
      core.process(l, r, undefined, at);
      at += BLOCK;
    }
  };
  const instruments = (num = 1) =>
    (core as unknown as { tracks: Map<number, { instruments: Held[] }> }).tracks.get(num)?.instruments ?? [];
  /** Voices still held (not let go, not finished) on each of a track's instruments. */
  const held = (num = 1) => instruments(num).map((i) => i.voices.filter((v) => !v.released && !v.done).length);
  const sounding = (num = 1) => instruments(num).reduce((n, i) => n + i.active, 0);
  const frame = (tick: number) => Math.round(tickToFrame(segments, tick));
  return { send, graph, run, held, sounding, frame };
}

/** A pad whose notes sound for as long as they're held, with a second articulation on the same pad. */
function padTrack(): Track {
  const pad = { type: 'synth' as const, preset: 'Fat Poly' };
  const t = newTrack('Pad', pad);
  t.channel.sends = [];
  t.articulations = [{ id: 'leg', name: 'Legato', instrument: pad }];
  return t;
}

function song(...tracks: Track[]): Project {
  const p = newProject('Stop');
  p.buses = [];
  p.tracks = tracks;
  return p;
}

describe('notes the song holds when it stops or goes around', () => {
  it('lets go of notes on an articulation at Stop', () => {
    const t = padTrack();
    t.regions = [
      { ...newRegion(0, PPQ * 32), notes: CHORD.map((p) => ({ t: 0, d: PPQ * 32, p, v: 100, art: 'leg' })) },
    ];
    const s = studio(song(t));
    s.send({ type: 'play', frame: 0, record: false, countIn: 0 });
    s.run(1);
    expect(s.held()).toEqual([0, 3]);
    s.send({ type: 'stop' });
    s.run(3);
    expect(s.sounding()).toBe(0);
  });

  it('lets go of notes on an articulation when a cycle goes around, so they never pile up', () => {
    const t = padTrack();
    // the chord outlasts the one-bar cycle: each turn starts it again
    t.regions = [
      { ...newRegion(0, PPQ * 32), notes: CHORD.map((p) => ({ t: 0, d: PPQ * 32, p, v: 100, art: 'leg' })) },
    ];
    const s = studio(song(t));
    s.send({ type: 'cycle', on: true, start: 0, end: s.frame(PPQ * 4) });
    s.send({ type: 'play', frame: 0, record: false, countIn: 0 });
    s.run(2 * 3 + 1);
    expect(s.held()).toEqual([0, 3]);
  });

  it('lets go of notes on an articulation at a locate', () => {
    const t = padTrack();
    t.regions = [{ ...newRegion(0, PPQ * 32), notes: CHORD.map((p) => ({ t: 0, d: PPQ * 8, p, v: 100, art: 'leg' })) }];
    const s = studio(song(t));
    s.send({ type: 'play', frame: 0, record: false, countIn: 0 });
    s.run(1);
    // past the chord's end: nothing should sound from here
    s.send({ type: 'locate', frame: s.frame(PPQ * 16) });
    s.run(3);
    expect(s.sounding()).toBe(0);
  });
});

describe('a MIDI effect taken out of the way while its notes sound', () => {
  it('lets go of the notes it changed when it is bypassed', () => {
    const t = padTrack();
    t.midiFx = [newPlugin('scale', { transpose: 7, quantize: 0 })];
    const p = song(t);
    const s = studio(p);
    s.send({ type: 'live', events: [0x90, 60, 100, 1] });
    s.run(0.5);
    expect(s.held()).toEqual([1, 0]);
    (t.midiFx[0] as Track['midiFx'][number]).bypass = true;
    s.graph();
    s.send({ type: 'live', events: [0x80, 60, 0, 1] });
    s.run(3);
    expect(s.sounding()).toBe(0);
  });

  it('lets go of an arpeggio when the arpeggiator is removed', () => {
    const t = padTrack();
    t.midiFx = [newPlugin('arpeggiator', { latch: 1, ...SIXTEENTHS })];
    const p = song(t);
    const s = studio(p);
    s.send({ type: 'live', events: CHORD.flatMap((k) => [0x90, k, 100, 1]) });
    s.run(0.5);
    s.send({ type: 'live', events: CHORD.flatMap((k) => [0x80, k, 0, 1]) });
    s.run(0.5);
    t.midiFx = [];
    s.graph();
    s.run(3);
    expect(s.sounding()).toBe(0);
  });
});
