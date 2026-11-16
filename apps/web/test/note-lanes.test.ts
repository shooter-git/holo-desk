import type { TempoPoint } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  capsule,
  curveRuns,
  fileToTick,
  fileToTicks,
  firstAt,
  fitPitches,
  KEY_HEIGHT,
  laneTop,
  levelThickness,
  maxPitchScroll,
  pitchAtY,
  pitchY,
  restingPitch,
  shownPitch,
  thinPoints,
  tickToFile,
  zoomPitch,
} from '../src/ui/note-lanes.ts';

// 120 bpm: a beat (960 ticks) is half a second
const steady: TempoPoint[] = [{ tick: 0, bpm: 120 }];
// 120 bpm for two bars, then 90
const slower: TempoPoint[] = [
  { tick: 0, bpm: 120 },
  { tick: 7680, bpm: 90 },
];

describe('a recording’s time on the song’s timeline', () => {
  const clip = { offset: 1.5, stretch: 2 };

  it('plays the region’s first second of the file at its start, stretched after it', () => {
    expect(fileToTick(steady, 3840, clip, 1.5)).toBeCloseTo(3840, 9);
    // a second of the file later, stretched twice: two seconds, four beats
    expect(fileToTick(steady, 3840, clip, 2.5)).toBeCloseTo(3840 + 4 * 960, 9);
    // before the region's start (the part a trim hid) goes back as far
    expect(fileToTick(steady, 3840, clip, 1)).toBeCloseTo(3840 - 2 * 960, 9);
  });

  it('goes through the tempo map', () => {
    // the region starts at bar 2 (2 s); bar 3 is at 4 s; past it a beat is 2/3 s
    const at = fileToTick(slower, 3840, { offset: 0, stretch: 1 }, 3);
    expect(at).toBeCloseTo(7680 + (1 / (2 / 3)) * 960, 6);
  });

  it('comes back the same way', () => {
    for (const tempo of [steady, slower]) {
      for (const sec of [0, 0.37, 1.5, 4.25, 11.1]) {
        const tick = fileToTick(tempo, 3840, clip, sec);
        expect(tickToFile(tempo, 3840, clip, tick)).toBeCloseTo(sec, 9);
      }
    }
  });

  it('works out a region’s start once for many points, to the same ticks', () => {
    const ticks = fileToTicks(slower, 1234, clip);
    for (const sec of [0, 2, 3.333, 9]) expect(ticks(sec)).toBe(fileToTick(slower, 1234, clip, sec));
  });
});

describe('the semitone lanes', () => {
  it('draws a whole semitone on its lane’s middle line, cents between', () => {
    expect(pitchY(60, 12, 0)).toBe(laneTop(60, 12, 0) + 6);
    expect(pitchY(60.5, 12, 0)).toBe(laneTop(60, 12, 0));
    expect(pitchY(127, 10, 0)).toBe(5);
    expect(pitchY(64, 10, 300)).toBe(pitchY(64, 10, 0) - 300);
  });

  it('finds the pitch at a height', () => {
    for (const p of [0, 40.25, 64, 127]) expect(pitchAtY(pitchY(p, 14, 230), 14, 230)).toBeCloseTo(p, 9);
  });

  it('scrolls as far as the lowest lane', () => {
    expect(maxPitchScroll(10, 300)).toBe(128 * 10 - 300);
    expect(maxPitchScroll(2, 300)).toBe(0);
  });

  it('zooms round the pitch under the pointer', () => {
    const before = { keyHeight: 12, y: 600 };
    const after = zoomPitch(before, 1.5, 100, 400);
    expect(after.keyHeight).toBe(18);
    expect(pitchAtY(100, after.keyHeight, after.y)).toBeCloseTo(pitchAtY(100, before.keyHeight, before.y), 9);
  });

  it('keeps the zoom and the scroll in bounds', () => {
    expect(zoomPitch({ keyHeight: 12, y: 0 }, 100, 0, 400).keyHeight).toBe(KEY_HEIGHT.max);
    expect(zoomPitch({ keyHeight: 12, y: 0 }, 0.01, 0, 400).keyHeight).toBe(KEY_HEIGHT.min);
    // zoomed out near the top: never scrolled above the highest lane
    expect(zoomPitch({ keyHeight: 12, y: 10 }, 0.5, 400, 400).y).toBe(0);
    // nor below the lowest
    const low = zoomPitch({ keyHeight: 12, y: maxPitchScroll(12, 400) }, 0.8, 400, 400);
    expect(low.y).toBeLessThanOrEqual(maxPitchScroll(low.keyHeight, 400));
  });

  it('fits round a line’s pitches, an octave at least', () => {
    // a fifth: an octave fits
    expect(fitPitches(62, 69, 200).keyHeight).toBeCloseTo(200 / 12, 9);
    // a semitone no taller than asked
    expect(fitPitches(62, 69, 320).keyHeight).toBe(22);
    const wide = fitPitches(48, 76, 320);
    expect(wide.keyHeight).toBeCloseTo(320 / 32, 9);
    // centred
    expect(pitchAtY(160, wide.keyHeight, wide.y)).toBeCloseTo(62, 9);
    // never smaller than asked
    expect(fitPitches(30, 100, 320, 8).keyHeight).toBe(8);
  });
});

describe('where a note is drawn', () => {
  it('is at its moved pitch, else as it was found', () => {
    expect(shownPitch({ p: 64.2 })).toBe(64.2);
    expect(shownPitch({ p: 64.2, to: 65 })).toBe(65);
    expect(shownPitch({ p: null })).toBeNull();
  });

  it('puts a note with no pitch at the nearest one that has one', () => {
    const notes = [
      { t: 0, d: 1, p: 60 },
      { t: 1.2, d: 0.2, p: null },
      { t: 1.5, d: 1, p: 67, to: 65 },
    ];
    // 0.2 s after the first, 0.1 s before the next (drawn where it was moved)
    expect(restingPitch(notes, 1)).toBe(65);
    // as near either way: the one before
    expect(restingPitch([notes[0], { t: 1.25, d: 0.25, p: null }, { t: 1.75, d: 1, p: 67 }] as typeof notes, 1)).toBe(
      60,
    );
    expect(restingPitch([{ t: 0, d: 1, p: null }], 0)).toBeNull();
  });
});

describe('a note’s outline', () => {
  it('is as thick as the note is loud, down to its thinnest 42 dB under the loudest', () => {
    expect(levelThickness(1, 1, 2, 12)).toBe(12);
    expect(levelThickness(10 ** -2.1, 1, 2, 12)).toBeCloseTo(7, 9);
    expect(levelThickness(10 ** -5, 1, 2, 12)).toBe(2);
    expect(levelThickness(0, 1, 2, 12)).toBe(2);
    expect(levelThickness(0.5, 0, 2, 12)).toBe(2);
  });

  it('finds where a time starts in the curve', () => {
    const t = [0, 0.005, 0.01, 0.015];
    expect(firstAt(t, -1)).toBe(0);
    expect(firstAt(t, 0.005)).toBe(1);
    expect(firstAt(t, 0.007)).toBe(2);
    expect(firstAt(t, 1)).toBe(4);
    expect(firstAt(new Float64Array(0), 1)).toBe(0);
  });

  it('takes points closer than a pixel or two as one, the loudest of them', () => {
    const out = thinPoints([0, 0.5, 1, 2.5, 3, 6], [1, 5, 2, 3, 9, 4], 2);
    expect(out.x).toEqual([0, 2.5, 6]);
    expect(out.value).toEqual([5, 9, 4]);
  });

  it('is rounded at its ends, as thick as its body there', () => {
    const o = capsule([100, 110, 120, 150, 190, 200], [4, 5, 6, 6, 3, 2], 100, 200);
    expect(o.x[0]).toBe(100);
    expect(o.half[0]).toBe(0);
    expect(o.x.at(-1)).toBe(200);
    expect(o.half.at(-1)).toBeCloseTo(0, 9);
    // the body's samples kept between the caps
    expect(o.x).toContain(150);
    expect(o.half[o.x.indexOf(150)]).toBe(6);
    // the caps reach the body's thickness at each end
    expect(Math.max(...o.half.slice(0, 7))).toBeCloseTo(4, 9);
    for (let i = 1; i < o.x.length; i++) expect(o.x[i]).toBeGreaterThanOrEqual(o.x[i - 1] as number);
  });

  it('keeps a short note’s caps within it', () => {
    const o = capsule([10, 12], [6, 6], 10, 14);
    expect(Math.min(...o.x)).toBe(10);
    expect(Math.max(...o.x)).toBe(14);
    expect(Math.max(...o.half)).toBeLessThanOrEqual(2);
  });
});

describe('a pitch curve as it’s drawn', () => {
  const N = Number.NaN;
  const at = (i: number) => i * 4;

  it('breaks where the line isn’t voiced, and leaves out a lone voiced point', () => {
    const runs = curveRuns([60, 60, 60, N, 62, N, 64, 64], 0, 8, at, 1);
    expect(runs.map((r) => r.x)).toEqual([
      [0, 4, 8],
      [24, 28],
    ]);
    expect(runs[1]?.p).toEqual([64, 64]);
  });

  it('draws no spike for a slip of a step or two', () => {
    const [run] = curveRuns([60, 60.1, 60, 48, 60.1, 60, 60.1], 0, 7, at, 1);
    expect(Math.min(...(run?.p ?? []))).toBeGreaterThan(59.5);
  });

  it('keeps a real step to another note', () => {
    const [run] = curveRuns([60, 60, 60, 60, 62, 62, 62, 62], 0, 8, at, 1);
    expect(run?.p[0]).toBe(60);
    expect(run?.p.at(-1)).toBe(62);
  });

  it('takes points closer than a pixel or two as one, ending on the last', () => {
    const [run] = curveRuns([60, 60, 60, 61, 61, 61, 61], 0, 7, (i) => i * 0.5, 1.5);
    expect(run?.x).toEqual([0, 1.5, 3]);
    expect(run?.p.at(-1)).toBe(61);
  });

  it('keeps to the stretch asked for', () => {
    const runs = curveRuns([50, 50, 60, 60, 60, 70, 70], 2, 5, at, 1);
    expect(runs).toEqual([{ x: [8, 12, 16], p: [60, 60, 60] }]);
  });
});
