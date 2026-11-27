/** What Export stems says it would make, before the host is asked. */
import { newProject, newRegion, newTrack, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { stemsPlan } from '../src/app/stems.ts';
import { bouncesCount } from '../src/ui/Songs.tsx';

const BAR = PPQ * 4;

function song(): Project {
  const p = newProject('Plan');
  p.tempo = [{ tick: 0, bpm: 120 }];
  p.master.inserts = [];
  const part = (name: string) => {
    const t = newTrack(name, { type: 'synth', preset: 'Soft Keys' });
    const r = newRegion(0, BAR * 4, name);
    r.notes.push({ t: 0, d: BAR, p: 60, v: 90 });
    t.regions = [r];
    return t;
  };
  const muted = part('Muted');
  muted.channel.mute = true;
  p.tracks = [part('Keys'), part('Bass'), muted, newTrack('Empty', { type: 'synth', preset: 'Soft Keys' })];
  return p;
}

describe('the plan of a song’s stems', () => {
  it('lists a file for each track that’s heard, and counts the ones left out', () => {
    const plan = stemsPlan(song(), 'song', 3);
    expect(plan.stems.map((s) => s.file)).toEqual(['01 Keys.wav', '02 Bass.wav']);
    expect(plan.left).toBe(2);
    expect(plan.warnings).toEqual([]);
  });

  it('says how long each is with its tail, and about how big the ZIP', () => {
    const plan = stemsPlan(song(), 'song', 3);
    // four bars at 120: eight seconds, and three of tail
    expect(plan.seconds).toBeCloseTo(11, 5);
    // 24 bits, two channels, 48 kHz, for each of two
    const audio = 2 * 11 * 48000 * 6;
    expect(plan.bytes).toBeGreaterThan(audio);
    expect(plan.bytes).toBeLessThan(audio + 1000);
  });

  it('covers the cycle when that’s asked and the cycle has a length, in bars', () => {
    const p = song();
    // (a new song's cycle is its first four bars)
    expect(stemsPlan(p, 'cycle', 3).cycle).toBe('bars 1–4');
    p.cycle = { on: false, start: BAR, end: BAR * 3 };
    const plan = stemsPlan(p, 'cycle', 3);
    expect([plan.ofCycle, plan.cycle, plan.from, plan.to]).toEqual([true, 'bars 2–3', BAR, BAR * 3]);
    expect(plan.seconds).toBeCloseTo(7, 5);
    // the whole song is still there to choose
    expect(stemsPlan(p, 'song', 3).ofCycle).toBe(false);
    p.cycle = { on: false, start: BAR, end: BAR * 2 };
    expect(stemsPlan(p, 'cycle', 3).cycle).toBe('bar 2');
    // (a cycle with no length: only the song)
    p.cycle = { on: true, start: BAR, end: BAR };
    expect([stemsPlan(p, 'cycle', 3).ofCycle, stemsPlan(p, 'cycle', 3).cycle]).toEqual([false, null]);
  });

  it('carries the reasons the stems wouldn’t add up to the mix', () => {
    const p = song();
    p.finish = { lufs: -14, ceiling: -1, glue: false, lowcut: 0, tilt: 0 };
    expect(stemsPlan(p, 'song', 3).warnings.join(' ')).toMatch(/finish/);
  });
});

describe('the plan of a song’s stems, by stack', () => {
  it('offers stacks where the song has them, and counts the files and the tracks left out by them', () => {
    const p = song();
    expect(stemsPlan(p, 'song', 3).stacks).toBe(false);
    p.stacks = [{ id: 'stk_a', name: 'Band' }];
    for (const t of p.tracks.slice(0, 2)) t.stack = 'stk_a';
    const plan = stemsPlan(p, 'song', 3, 'stacks');
    expect(plan.stacks).toBe(true);
    expect(plan.stems.map((s) => s.file)).toEqual(['01 Band.wav']);
    // (Keys and Bass are in it; the muted and the empty track are in none)
    expect(plan.left).toBe(2);
    expect(stemsPlan(p, 'song', 3).stems).toHaveLength(2);
  });
});

describe('what a song has kept on the host, counted', () => {
  it('tells bounces from sets of stems', () => {
    const b = { stems: false };
    const s = { stems: true };
    expect(bouncesCount([b])).toBe('1 bounce');
    expect(bouncesCount([b, b])).toBe('2 bounces');
    expect(bouncesCount([s])).toBe('1 set of stems');
    expect(bouncesCount([b, s, b, b, s])).toBe('3 bounces and 2 sets of stems');
  });
});
