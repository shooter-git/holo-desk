import { newProject, PPQ, parseNoteName } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  analyzePerformance,
  describePerformance,
  type PlayedNote,
  pickupWords,
  type QuantizedNote,
  writeScoreText,
} from '../src/index.ts';

/** A note of a written part: [start, length] in quarter notes, its pitch, and how accented (0–2). */
type Written = [number, number, string, number];

/** "e5:2 g5:1 | c6:3" in quarter notes from `start`, each note accented as `accent` says for its start. */
function part(text: string, accent: (beat: number) => number = () => 0, start = 0): Written[] {
  const out: Written[] = [];
  let t = start;
  for (const token of text.split(/\s+/)) {
    if (!token || token === '|') continue;
    const [pitch = 'r', length = '1'] = token.split(':');
    if (pitch !== 'r') out.push([t, Number(length), pitch, accent(t)]);
    t += Number(length);
  }
  return out;
}

/**
 * A person playing it: at `bpm` quarters a minute, each note up to `jitter` ms early or late, louder
 * where accented, held for 90% of its length; with `drift`, the tempo swaying that much either way
 * over `period` quarters. The same seed plays it the same way.
 */
function play(
  written: Written[],
  bpm: number,
  {
    jitter = 20,
    drift = 0,
    period = 32,
    seed = 1,
  }: { jitter?: number; drift?: number; period?: number; seed?: number } = {},
): PlayedNote[] {
  let state = seed;
  const random = () => {
    state = (state * 1103515245 + 12345) & 0x7fffffff;
    return state / 0x7fffffff;
  };
  // ms at each 48th of a quarter, the tempo summed up as it sways
  const STEPS = 48;
  const end = Math.max(...written.map(([t, d]) => t + d)) + 1;
  const table = [0];
  for (let k = 0; k < end * STEPS; k++) {
    const b = (k + 0.5) / STEPS;
    table.push((table[k] as number) + 60000 / STEPS / (bpm * (1 + drift * Math.sin((2 * Math.PI * b) / period))));
  }
  const at = (beats: number) => {
    const x = beats * STEPS;
    const k = Math.floor(x);
    return (table[k] as number) + ((table[k + 1] as number) - (table[k] as number)) * (x - k);
  };
  const notes = written.map(([t, d, p, accent]) => {
    const time = at(t) + (random() * 2 - 1) * jitter;
    return {
      time,
      pitch: parseNoteName(p),
      velocity: Math.round(62 + accent * 20 + (random() * 2 - 1) * 5),
      length: Math.max(30, (at(t + d) - at(t)) * 0.9 + (random() * 2 - 1) * jitter),
      tick: null,
    };
  });
  const first = Math.min(...notes.map((n) => n.time));
  return notes.map((n) => ({ ...n, time: n.time - first }));
}

/** The written notes as the song would have them: ticks from the start of the song's first bar. */
const asTicks = (written: Written[], shift = 0) =>
  written.map(([t, d, p]) => [Math.round((t + shift) * PPQ), Math.round(d * PPQ), parseNoteName(p)]).sort(order);
const heard = (notes: QuantizedNote[]) => notes.map((n) => [n.ticks, n.durationTicks, n.pitch]).sort(order);
const order = (a: number[], b: number[]) => (a[0] as number) - (b[0] as number) || (a[2] as number) - (b[2] as number);

// a waltz: the bass on one, the chord on two and three, a tune over them
const waltz: Written[] = [
  ...part('e5:2 g5:1 | c6:3 | b5:2 a5:1 | g5:3 | f5:2 a5:1 | d6:3 | c6:1 b5:1 a5:1 | g5:3', (t) =>
    t % 3 === 0 ? 1.5 : 0.5,
  ),
  ...['c3', 'a2', 'g2', 'c3', 'f2', 'f2', 'g2', 'c3'].flatMap((root, bar): Written[] => {
    const chord = ['e4', 'e4', 'f4', 'e4', 'a4', 'a4', 'f4', 'e4'][bar] as string;
    return [
      [bar * 3, 1, root, 2],
      [bar * 3 + 1, 1, chord, 0],
      [bar * 3 + 2, 1, chord, 0],
    ];
  }),
];

// a jig-like tune in 6/8 from an eighth-note pickup: long-short pairs, the two beats of each bar leaned on
const jig = part(
  'b3:0.5 | e4:1 g4:0.5 b4:1 a4:0.5 | g4:1.5 e4:1 b3:0.5 | e4:1 g4:0.5 b4:1 d5:0.5 | e5:1.5 r:1 b4:0.5 | ' +
    'c5:1 b4:0.5 a4:1 g4:0.5 | f#4:1.5 d4:1 f#4:0.5 | g4:1 f#4:0.5 e4:1 d#4:0.5 | e4:3',
  (t) => {
    const x = (t - 0.5 + 30) % 3;
    return x === 0 ? 1.6 : x === 1.5 ? 1 : 0;
  },
);

// a tune in 4/4 from a quarter-note pickup, the downbeats leaned on hardest and the half bars a little
const fourFour = (start: number) => (t: number) => {
  const x = (t - start + 40) % 4;
  return x === 0 ? 1.6 : x === 2 ? 0.9 : 0.2;
};
const hymn = part(
  'g4:1 | c5:1 c5:1 e5:1 g5:1 | a5:2 g5:2 | f5:1 f5:1 e5:1 e5:1 | d5:4 | e5:1 e5:1 d5:1 c5:1 | ' +
    'b4:1.5 a4:0.5 g4:2 | a4:1 b4:1 c5:1 d5:1 | c5:3',
  fourFour(1),
);

describe('hearing a performance', () => {
  it('hears a waltz at 96 as 3/4, and writes it down as played', () => {
    const a = analyzePerformance(play(waltz, 96));
    const best = a.meters[0];
    expect(best).toMatchObject({ time: '3/4', beat: 'quarter', pickup: 0 });
    expect(Math.abs((best?.bpm ?? 0) - 96)).toBeLessThanOrEqual(2);
    expect(best?.confidence).toBeGreaterThan(0.6);
    expect(a.keys[0]?.key).toBe('C major');
    expect(heard(a.best?.notes ?? [])).toEqual(asTicks(waltz));
    expect(a.best?.text.split('\n')[0]).toBe('bar 1  time 3/4  key C major  tempo 96');
    expect(describePerformance(a)).toMatch(/^Heard 37 notes over about 15 s: 3\/4 at 96 \(strong\), C major/);
  });

  it('hears a tune in 6/8 at 72 as 6/8 with its pickup, not as 3/4 at the same speed', () => {
    const a = analyzePerformance(play(jig, 108));
    const best = a.meters[0];
    expect(best).toMatchObject({ time: '6/8', beat: 'dotted quarter', pickup: PPQ / 2 });
    expect(Math.abs((best?.bpm ?? 0) - 72)).toBeLessThanOrEqual(2);
    // the song's tempo is in quarters: 72 dotted quarters a minute are 108 quarters
    expect(Math.abs((best?.quarterBpm ?? 0) - 108)).toBeLessThanOrEqual(3);
    const threeFour = a.meters.find((m) => m.time === '3/4');
    expect(threeFour?.confidence ?? 0).toBeLessThan((best?.confidence ?? 0) / 10);
    expect(a.keys[0]?.key).toBe('E minor');
    // the pickup's bar is a full bar on the timeline, the eighth at its end
    expect(heard(a.best?.notes ?? [])).toEqual(asTicks(jig, 2.5));
    expect(a.best?.notes[0]).toMatchObject({ bar: 0, beat: 6, ticks: 5 * (PPQ / 2) });
    expect(a.best?.notes[1]).toMatchObject({ bar: 1, beat: 1 });
    expect(a.best?.text.split('\n').slice(0, 4)).toEqual([
      'bar 0  time 6/8  key E minor  pickup  tempo 108',
      '  P1: b3:e',
      'bar 1',
      '  P1: e4:q g4:e b4:q a4:e',
    ]);
    expect(describePerformance(a)).toMatch(
      /^Heard 26 notes over about 13 s: 6\/8 at 72 \(strong\), E minor \(strong\), a pickup of one eighth; alternatives: /,
    );
    // the best reading in another meter is written down too
    expect(a.second?.reading.time).not.toBe('6/8');
    expect(a.second?.text).toMatch(/^bar 0 {2}time /);
  });

  it('hears 4/4 at 120 with a quarter-note pickup', () => {
    const a = analyzePerformance(play(hymn, 120));
    const best = a.meters[0];
    expect(best).toMatchObject({ time: '4/4', pickup: PPQ });
    expect(Math.abs((best?.bpm ?? 0) - 120)).toBeLessThanOrEqual(3);
    expect(best?.pickupConfidence).toBeGreaterThan(0.9);
    expect(heard(a.best?.notes ?? [])).toEqual(asTicks(hymn, 3));
    expect(a.best?.text.split('\n')[0]).toBe('bar 0  time 4/4  key C major  pickup  tempo 120');
    expect(describePerformance(a)).toContain('4/4 at 120 (strong), C major (strong), a pickup of one quarter');
  });

  it('hears a D minor melody in D minor', () => {
    const tune = part(
      'd4:1 f4:1 a4:1 d5:1 | c#5:2 a4:2 | bb4:1 a4:1 g4:1 f4:1 | e4:2 a3:2 | d4:1 e4:1 f4:1 g4:1 | ' +
        'a4:1 bb4:1 c#5:2 | d5:1 a4:1 f4:1 e4:1 | d4:4',
      fourFour(0),
    );
    const a = analyzePerformance(play(tune, 100));
    expect(a.keys.map((k) => k.key)[0]).toBe('D minor');
    expect(a.keys).toHaveLength(3);
    expect(a.keys[0]).toMatchObject({ fifths: -1, mode: 'minor' });
    expect(a.meters[0]?.time).toBe('4/4');
    expect(Math.abs((a.meters[0]?.bpm ?? 0) - 100)).toBeLessThanOrEqual(3);
  });

  it('hears a C major scale in C major', () => {
    const a = analyzePerformance(
      play(part('c4:1 d4:1 e4:1 f4:1 g4:1 a4:1 b4:1 c5:1 b4:1 a4:1 g4:1 f4:1 e4:1 d4:1 c4:2'), 100),
    );
    expect(a.keys[0]?.key).toBe('C major');
    expect(Math.abs((a.tempos[0]?.bpm ?? 0) - 100)).toBeLessThanOrEqual(3);
  });

  it('follows rubato: the tempo swaying 8% either way', () => {
    const tune = part(
      'c5:1 c5:1 e5:1 g5:1 | a5:2 g5:2 | f5:1 f5:1 e5:1 e5:1 | d5:4 | e5:1 e5:1 d5:1 c5:1 | b4:1.5 a4:0.5 g4:2 | ' +
        'a4:1 b4:1 c5:1 d5:1 | c5:2 r:2 | c5:0.5 d5:0.5 e5:0.5 f5:0.5 g5:1 g5:1 | a5:0.5 g5:0.5 f5:0.5 e5:0.5 d5:2 | ' +
        'f5:1 f5:1 e5:1 e5:1 | d5:4 | e5:1 e5:1 d5:1 c5:1 | b4:1.5 a4:0.5 g4:2 | a4:1 b4:1 c5:1 d5:1 | c5:4',
      fourFour(0),
    );
    for (const [seed, period] of [
      [1, 32],
      [2, 32],
      [3, 16],
    ] as const) {
      const a = analyzePerformance(play(tune, 100, { drift: 0.08, period, seed }));
      expect(a.meters[0]?.time).toBe('4/4');
      expect(Math.abs((a.meters[0]?.bpm ?? 0) / 100 - 1)).toBeLessThan(0.05);
      const want = new Set(tune.map(([t]) => t * PPQ));
      const placed = (a.best?.notes ?? []).filter((n) => want.has(n.ticks));
      expect(placed.length / tune.length).toBeGreaterThanOrEqual(0.9);
    }
  });

  it('writes text that reads back into a song as the same notes', () => {
    const a = analyzePerformance(play(waltz, 96));
    const song = newProject('Waltz');
    const result = writeScoreText(song, a.best?.text ?? '');
    expect(result.errors).toEqual([]);
    expect(result.written).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(result.ops.some((op) => op.op === 'setProject' && op.patch.meter?.[0]?.num === 3)).toBe(true);
  });

  it('gives the same reading every time, whatever order the notes come in', () => {
    const notes = play(jig, 108, { seed: 7 });
    const once = analyzePerformance(notes);
    const again = analyzePerformance(notes.slice().reverse());
    expect(again).toEqual(once);
    expect(describePerformance(again)).toBe(describePerformance(once));
  });

  it('says so when there is nothing, or too little, to go on', () => {
    const none = analyzePerformance([]);
    expect(none).toMatchObject({ notes: 0, meters: [], tempos: [], keys: [], best: null, second: null });
    expect(describePerformance(none)).toBe('Heard nothing.');
    const one = analyzePerformance([{ time: 0, pitch: 64, velocity: 80, length: 400 }]);
    expect(one).toMatchObject({ notes: 1, meters: [], best: null });
    expect(describePerformance(one)).toBe('Heard 1 note: too few to tell a tempo or a meter.');
    const held = analyzePerformance([
      { time: 0, pitch: 60, velocity: 80, length: null },
      { time: 500, pitch: 64, velocity: 80, length: null },
    ]);
    expect(held.meters).toEqual([]);
    expect(describePerformance(held)).toContain('too few to tell a tempo or a meter');
  });

  it('only weighs the meters asked for', () => {
    const a = analyzePerformance(play(jig, 108), { meters: ['3/4', '4/4'] });
    expect(new Set(a.meters.map((m) => m.time))).toEqual(new Set(['3/4', '4/4']));
    expect(a.meters[0]?.time).toBe('3/4');
  });

  it('names pickups in words', () => {
    expect(pickupWords(PPQ / 2, 8)).toBe('one eighth');
    expect(pickupWords(PPQ, 4)).toBe('one quarter');
    expect(pickupWords(PPQ * 2, 4)).toBe('two quarters');
    expect(pickupWords((PPQ * 3) / 2, 8)).toBe('three eighths');
    expect(pickupWords(PPQ / 4, 4)).toBe('one sixteenth');
  });

  it('hears thousands of notes quickly', () => {
    // a 4/4 accompaniment pattern (bass on the half bars, a chord off the beat) under a running tune, 60 times over
    const phrase =
      'c5:0.5 d5:0.5 e5:0.5 f5:0.5 g5:1 g5:1 | a5:0.5 g5:0.5 f5:0.5 e5:0.5 d5:2 | f5:1 f5:1 e5:1 e5:1 | d5:4';
    const written: Written[] = [];
    for (let k = 0; k < 60; k++) {
      written.push(...part(phrase, fourFour(0), k * 16));
      for (let b = 0; b < 8; b++) written.push([k * 16 + b * 2, 2, b % 2 ? 'g3' : 'c3', b % 2 ? 0.5 : 1.5]);
      for (let b = 0; b < 8; b++) written.push([k * 16 + b * 2 + 1, 0.5, 'e4', 0]);
    }
    const notes = play(written, 112, { drift: 0.05 });
    expect(notes.length).toBeGreaterThan(1900);
    analyzePerformance(notes, { text: false });
    const start = performance.now();
    const a = analyzePerformance(notes, { text: false });
    const ms = performance.now() - start;
    expect(a.meters[0]?.time).toBe('4/4');
    expect(heard(a.best?.notes ?? []).map(([t]) => t)).toEqual(asTicks(written).map(([t]) => t));
    // well under 50 ms on a desktop; room here for a slow machine running tests side by side
    expect(ms).toBeLessThan(150);
  });
});
