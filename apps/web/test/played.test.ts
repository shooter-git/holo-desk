import { describe, expect, it } from 'vitest';
import { PlayedMemory } from '../src/app/played.ts';

const on = (at: number, pitch: number, port = 'Keys', tick: number | null = null) => ({
  at,
  status: 0x90,
  d1: pitch,
  d2: 100,
  port,
  tick,
});
const off = (at: number, pitch: number, port = 'Keys') => ({ at, status: 0x80, d1: pitch, d2: 0, port, tick: null });

describe('what was just played', () => {
  it('gives the notes of the stretch asked for, timed from its start, with their lengths', () => {
    const m = new PlayedMemory();
    m.add(on(1000, 60, 'Keys', 3840));
    m.add(off(1500, 60));
    m.add(on(2000, 64));
    // (a note on at velocity 0 is a note off)
    m.add({ at: 2250, status: 0x90, d1: 64, d2: 0, port: 'Keys', tick: null });
    m.add(on(2500, 67, 'Musical Typing'));
    expect(m.played(1.5, 3000)).toEqual([
      { tick: null, time: 500, pitch: 64, velocity: 100, length: 250, port: 'Keys' },
      { tick: null, time: 1000, pitch: 67, velocity: 100, length: null, port: 'Musical Typing' },
    ]);
    // the last minute: its stretch began 57 s before the first note
    expect(m.played(60, 3000).map((n) => [n.pitch, n.time, n.tick])).toEqual([
      [60, 58_000, 3840],
      [64, 59_000, null],
      [67, 59_500, null],
    ]);
  });

  it('ends the note a port played, not the same pitch from another port', () => {
    const m = new PlayedMemory();
    m.add(on(0, 60, 'A'));
    m.add(on(10, 60, 'B'));
    m.add(off(100, 60, 'B'));
    expect(m.played(1, 200).map((n) => [n.port, n.length])).toEqual([
      ['A', null],
      ['B', 90],
    ]);
  });

  it('remembers a minute at most, and at most so many notes', () => {
    const m = new PlayedMemory(60_000, 100);
    m.add(on(0, 60));
    m.add(off(100, 60));
    m.add(on(70_000, 62));
    m.add(off(70_100, 62));
    // the first note went with time; asking for more than a minute gives a minute
    expect(m.played(600, 70_200).map((n) => n.pitch)).toEqual([62]);
    for (let i = 0; i < 250; i++) {
      m.add(on(71_000 + i * 10, 40 + (i % 40)));
      m.add(off(71_005 + i * 10, 40 + (i % 40)));
    }
    expect(m.size).toBeLessThanOrEqual(100);
    expect(m.played(60, 74_000)).toHaveLength(100);
  });
});
