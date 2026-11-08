import { GROOVES } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { createMidiEffect, EventList, type MidiHost } from '../src/midifx.ts';
import { EV_OFF, EV_ON } from '../src/protocol.ts';

const SR = 48000;
const BLOCK = 128;
/** 120 bpm: half a second a beat. */
const BEAT = 0.5;

interface Played {
  beat: number;
  key: number;
  vel: number;
  on: boolean;
}

/**
 * A Session Drummer played from a beat for so many beats, 4/4, as the engine runs it a block at a
 * time; `song` false is the audio thread's twin of a strip a worker plays.
 */
function play(
  params: Record<string, number>,
  from: number,
  beats: number,
  opts: { song?: boolean; stopAt?: number; jumpAt?: [number, number]; barBeats?: number } = {},
): Played[] {
  let beat = from;
  let playing = true;
  const barBeats = opts.barBeats ?? 4;
  const host: MidiHost = {
    sr: SR,
    beatSeconds: () => BEAT,
    beatAt: () => beat,
    playing: () => playing,
    barAt: () => beat / barBeats,
    barBeats: () => barBeats,
  };
  const fx = createMidiEffect('drummer', host);
  if (!fx) throw new Error('drummer');
  fx.setParams(params);
  const input = new EventList();
  const output = new EventList();
  const out: Played[] = [];
  const perFrame = 1 / (BEAT * SR);
  const end = from + beats;
  while (beat < end) {
    if (opts.stopAt !== undefined && beat >= opts.stopAt) playing = false;
    if (opts.jumpAt && beat >= opts.jumpAt[0]) {
      beat = opts.jumpAt[1];
      opts.jumpAt = undefined;
    }
    output.clear();
    fx.process(input, output, BLOCK, opts.song ?? true);
    for (let i = 0; i < output.count; i++) {
      const kind = output.kind[i] as number;
      // (the last block reaches past the end: what starts there is the next bar's)
      if (kind === EV_ON && beat + (output.offset[i] as number) * perFrame >= end - 1e-4) continue;
      out.push({
        beat: beat + (output.offset[i] as number) * perFrame,
        key: output.a[i] as number,
        vel: output.b[i] as number,
        on: kind === EV_ON,
      });
      if (kind !== EV_ON && kind !== EV_OFF) throw new Error('only notes');
    }
    if (playing) beat += BLOCK * perFrame;
    else break;
  }
  return out;
}

const ons = (p: Played[], key?: number) => p.filter((x) => x.on && (key === undefined || x.key === key));
/** A beat to the nearest sixteenth (the block a step lands in rounds it by a frame or two). */
const at = (b: number) => Math.round(b * 4) / 4;

describe('Session Drummer', () => {
  it('plays a rock groove: kick on one and three, snare on two and four, eighths on the hi-hat', () => {
    const notes = play({ genre: 0, complexity: 0, fills: 0, kick: 1 }, 0, 8);
    expect(ons(notes, 36).map((n) => at(n.beat))).toEqual([0, 2, 2.5, 4, 6, 6.5]);
    expect(ons(notes, 38).map((n) => at(n.beat))).toEqual([1, 3, 5, 7]);
    expect(ons(notes, 42).map((n) => at(n.beat))).toEqual(Array.from({ length: 16 }, (_, i) => i / 2));
    // every note it starts, it ends
    for (const n of ons(notes)) expect(notes.some((x) => !x.on && x.key === n.key && x.beat > n.beat)).toBe(true);
  });

  it('busier with Complexity, harder with Loudness', () => {
    const plain = play({ genre: 1, complexity: 0, fills: 0 }, 0, 16);
    const busy = play({ genre: 1, complexity: 100, fills: 0 }, 0, 16);
    expect(ons(busy).length).toBeGreaterThan(ons(plain).length * 1.3);
    const soft = play({ genre: 1, loudness: 0, fills: 0 }, 0, 8);
    const hard = play({ genre: 1, loudness: 100, fills: 0 }, 0, 8);
    const mean = (p: Played[]) => ons(p).reduce((a, n) => a + n.vel, 0) / ons(p).length;
    expect(mean(hard)).toBeGreaterThan(mean(soft) * 1.6);
    for (const n of ons(hard)) expect(n.vel).toBeLessThanOrEqual(127);
  });

  it('fills the last bar of a phrase, and crashes into the next', () => {
    const notes = play({ genre: 0, fills: 100 }, 0, 20);
    const toms = ons(notes).filter((n) => [50, 48, 45, 43].includes(n.key) || n.key === 38);
    // the fourth bar (beats 12 to 16) ends in a fill
    expect(toms.filter((n) => n.beat >= 12 && n.beat < 16).length).toBeGreaterThan(4);
    expect(ons(notes, 49).map((n) => at(n.beat))).toContain(16);
    const none = play({ genre: 0, fills: 0 }, 0, 20);
    expect(ons(none, 49)).toHaveLength(0);
    expect(ons(none).filter((n) => [50, 48, 45, 43].includes(n.key))).toHaveLength(0);
  });

  it('plays the same from wherever the song starts', () => {
    const params = { genre: 2, complexity: 70, fills: 60, swing: 30 };
    const whole = play(params, 0, 32).filter((n) => n.beat >= 16 - 1e-9);
    const later = play(params, 16, 16);
    const key = (p: Played[]) => p.map((n) => `${n.on ? 'on' : 'off'} ${n.key} ${n.vel} ${n.beat.toFixed(4)}`);
    // (the notes still sounding from before end at the start of the later one: compare what starts)
    expect(key(ons(later))).toEqual(key(ons(whole)));
  });

  it('plays a style of each kind, in triplets where it swings', () => {
    for (let g = 0; g < GROOVES.length; g++) {
      const notes = ons(play({ genre: g }, 0, 8));
      expect(notes.length).toBeGreaterThan(8);
      const grid = (GROOVES[g] as (typeof GROOVES)[number]).grid;
      for (const n of notes) {
        const step = n.beat * grid;
        // on the grid (or a swung sixteenth off it)
        expect(Math.abs(step - Math.round(step))).toBeLessThan(0.01);
      }
    }
    // brushes: the ride and the hi-hat foot on two and four
    const jazz = play({ genre: 6, fills: 0 }, 0, 4);
    expect(ons(jazz, 51).length).toBeGreaterThan(4);
    expect(ons(jazz, 44).map((n) => at(n.beat))).toEqual([1, 3]);
  });

  it('keeps to a bar of three in 3/4', () => {
    const notes = play({ genre: 0, complexity: 0, fills: 0 }, 0, 6, { barBeats: 3 });
    expect(ons(notes, 36).map((n) => at(n.beat))).toEqual([0, 2, 2.5, 3, 5, 5.5]);
  });

  it('ends its notes when the song stops or jumps, and makes none where it does not play the song', () => {
    const stopped = play({ genre: 0 }, 0, 8, { stopAt: 2.1 });
    const last = stopped.at(-1);
    const held = ons(stopped).filter((n) => !stopped.some((x) => !x.on && x.key === n.key && x.beat >= n.beat));
    expect(held).toHaveLength(0);
    expect(last?.on).toBe(false);
    const jumped = play({ genre: 0 }, 0, 8, { jumpAt: [2.1, 6] });
    expect(ons(jumped).every((n) => n.beat < 2.2 || n.beat >= 6)).toBe(true);
    expect(play({ genre: 0 }, 0, 8, { song: false })).toHaveLength(0);
  });
});
