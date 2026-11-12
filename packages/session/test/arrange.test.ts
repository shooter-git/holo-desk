import { describe, expect, it } from 'vitest';
import {
  applyOp,
  applyOps,
  newProject,
  newRegion,
  newTrack,
  type Op,
  OpError,
  PPQ,
  type Project,
  parseProject,
  type Region,
  type Track,
  tickToSeconds,
} from '../src/index.ts';

const BAR = PPQ * 4;
const BAR3 = PPQ * 3;
/** Bars 11–14 are 3/4; 4/4 comes back at bar 15, tick 13 × 3840. */
const B15 = 13 * BAR;

/**
 * A song with something everywhere a tick can be: MIDI and audio regions across bar 9 (an offset, a
 * stretch, a tempo change under the recording), controller lanes, marks, automation (linear, smooth,
 * stepped), a tempo ramp, meter changes, keys, markers, chords, the cycle, a loop, repeats, the score's
 * breaks and clefs, and a Performance instrument's dynamics.
 */
function song(): Project {
  const p = newProject('Everything');
  p.id = 'prj_everything';
  p.tempo = [
    { tick: 0, bpm: 100, text: 'Moderato', mm: true },
    { tick: 6 * BAR, bpm: 120 },
    { tick: 12 * BAR, bpm: 120, text: 'rit.', ramp: 14 * BAR + BAR3, to: 90 },
    { tick: 13 * BAR, bpm: 105, gen: true },
  ];
  p.meter = [
    { tick: 0, num: 4, den: 4 },
    { tick: 10 * BAR, num: 3, den: 4 },
    { tick: B15, num: 4, den: 4, groups: [3, 3, 2] },
  ];
  p.key = 'C major';
  p.keys = [
    { tick: 0, fifths: 0, mode: 'major' },
    { tick: 8 * BAR, fifths: 1, mode: 'major' },
    { tick: B15, fifths: -1, mode: 'dorian' },
  ];
  p.markers = [
    { id: 'mrk_intro', tick: 0, name: 'Intro' },
    { id: 'mrk_verse', tick: 4 * BAR, name: 'Verse' },
    { id: 'mrk_chorus', tick: 8 * BAR, name: 'Chorus' },
    { id: 'mrk_bridge', tick: B15, name: 'Bridge' },
  ];
  p.chords = [
    { tick: 0, symbol: 'C' },
    { tick: 2 * BAR, symbol: 'F' },
    { tick: 8 * BAR, symbol: 'G' },
    { tick: 9 * BAR + 2 * PPQ, symbol: 'Am' },
  ];
  p.cycle = { on: true, start: 6 * BAR, end: 10 * BAR };
  p.loop = { start: 0, end: 17 * BAR, tail: 2 };
  p.form = [
    { tick: 2 * BAR, k: 'start' },
    { tick: 7 * BAR, k: 'ending', e: 8 * BAR, passes: [1] },
    { tick: 8 * BAR, k: 'end' },
    { tick: 9 * BAR, k: 'segno' },
    { tick: 15 * BAR, k: 'ds', al: 'fine' },
    { tick: 10 * BAR + 2 * BAR3, k: 'fine' },
  ];
  p.score = {
    composer: 'Someone',
    breaks: [
      [4 * BAR, 'system'],
      [8 * BAR, 'page'],
      [B15, 'system'],
    ],
  };
  p.files = [{ id: 'aud_take', name: 'Take.wav', seconds: 120, rate: 48000, channels: 1 }];

  const piano: Track = { ...newTrack('Piano', { type: 'synth', preset: 'Soft Keys' }), id: 'trk_piano' };
  const before: Region = { ...newRegion(0, 2 * BAR, 'Intro'), id: 'rgn_before' };
  before.notes = [{ t: 0, d: BAR, p: 60, v: 80 }];
  const across: Region = { ...newRegion(2 * BAR, 8 * BAR, 'Long'), id: 'rgn_across' };
  across.notes = [
    { t: 0, d: PPQ, p: 62, v: 90, n: { sp: [1, 0, 62] } },
    { t: 5 * BAR + 2 * PPQ, d: 3 * PPQ, p: 64, v: 70 }, // rings across bar 9
    { t: 6 * BAR, d: PPQ, p: 65, v: 100 },
    { t: 7 * BAR + PPQ, d: PPQ, p: 67, v: 60 },
  ];
  across.cc = {
    '1': [
      [0, 10],
      [5 * BAR, 64],
      [6 * BAR + PPQ, 100],
    ],
    pb: [
      [0, 0],
      [5 * BAR + 100, 4000],
      [7 * BAR, -2000],
    ],
  };
  across.marks = [
    { t: 0, k: 'dyn', v: 'mf' },
    { t: 5 * BAR, k: 'cresc', e: 7 * BAR },
    { t: 6 * BAR + PPQ, k: 'text', v: 'dolce' },
  ];
  const after: Region = { ...newRegion(B15, 2 * BAR, 'Later'), id: 'rgn_after' };
  after.notes = [{ t: PPQ, d: PPQ, p: 72, v: 90 }];
  piano.regions = [before, across, after];
  piano.score = {
    staves: 2,
    clefs: [
      [0, 1, 'G'],
      [0, 2, 'F'],
      [8 * BAR, 2, 'G'],
      [B15, 2, 'F'],
    ],
  };
  piano.channel.automation = [
    {
      param: 'volume',
      points: [
        [0, -6],
        [6 * BAR, -12],
        [10 * BAR, -3],
      ],
      mode: 'read',
    },
    {
      param: 'pan',
      points: [
        [4 * BAR, -0.5],
        [12 * BAR, 0.5],
      ],
      mode: 'read',
      curve: 'smooth',
    },
    {
      param: 'mute',
      points: [
        [0, 0],
        [9 * BAR, 1],
        [11 * BAR, 0],
      ],
      mode: 'read',
    },
  ];

  const vox: Track = { ...newTrack('Vox', { type: 'none' }), id: 'trk_vox', kind: 'audio' };
  const take: Region = { ...newRegion(5 * BAR, 6 * BAR, 'Take'), id: 'rgn_take' };
  take.audio = { file: 'aud_take', offset: 1.5, gain: -3, fadeIn: 0.2, fadeOut: 0.4, stretch: 1.25 };
  const late: Region = { ...newRegion(15 * BAR, BAR, 'Ad lib'), id: 'rgn_late' };
  late.audio = { file: 'aud_take', offset: 30, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
  vox.regions = [take, late];

  const strings: Track = {
    ...newTrack('Strings', {
      type: 'performance',
      pack: 'strings',
      name: 'Ensemble',
      play: {
        legato: true,
        dyn: [
          [0, 0.3],
          [6 * BAR, 0.8],
          [12 * BAR, 0.5],
        ],
      },
    }),
    id: 'trk_strings',
  };
  const pad: Region = { ...newRegion(0, 16 * BAR, 'Pad'), id: 'rgn_pad' };
  pad.notes = [
    { t: 0, d: 8 * BAR, p: 48, v: 70 },
    { t: 8 * BAR, d: 8 * BAR, p: 50, v: 70 },
  ];
  strings.regions = [pad];

  p.tracks = [piano, vox, strings];
  p.master.automation = [
    {
      param: 'volume',
      points: [
        [8 * BAR, 0],
        [16 * BAR, -60],
      ],
      mode: 'read',
    },
  ];
  return parseProject(p);
}

const insert = (from: number, bars: number, bar = BAR): Op => ({
  op: 'arrange',
  edit: 'insert',
  from,
  to: from + bars * bar,
});
const del = (from: number, to: number): Op => ({ op: 'arrange', edit: 'delete', from, to });
const region = (p: Project, id: string) => p.tracks.flatMap((t) => t.regions).find((r) => r.id === id) as Region;
const track = (p: Project, id: string) => p.tracks.find((t) => t.id === id) as Track;
const ids = (p: Project) =>
  p.tracks
    .flatMap((t) => t.regions)
    .map((r) => r.id)
    .sort();

describe('inserting bars', () => {
  it('opens the song up at a bar line, everything after moving on', () => {
    const p = song();
    const n = applyOp(p, insert(8 * BAR, 2));
    expect(() => parseProject(n)).not.toThrow();
    // untouched and moved regions keep their ids; the recording across bar 9 is in two pieces now
    const added = ids(n).filter((id) => !ids(p).includes(id));
    expect(added).toHaveLength(1);
    expect(ids(n)).toEqual([...ids(p), ...added].sort());
    expect(region(n, 'rgn_before')).toBe(region(p, 'rgn_before'));
    expect(region(n, 'rgn_after').start).toBe(B15 + 2 * BAR);
    // a MIDI region across it opens up: its later notes, points and marks move on
    const across = region(n, 'rgn_across');
    expect(across.start).toBe(2 * BAR);
    expect(across.length).toBe(10 * BAR);
    expect(across.notes.map((x) => x.t)).toEqual([0, 5 * BAR + 2 * PPQ, 8 * BAR, 9 * BAR + PPQ]);
    expect(across.notes[0]?.n).toEqual({ sp: [1, 0, 62] });
    expect(across.cc['1']).toEqual([
      [0, 10],
      [5 * BAR, 64],
      [8 * BAR + PPQ, 100],
    ]);
    expect(across.marks?.[1]).toEqual({ t: 5 * BAR, k: 'cresc', e: 9 * BAR });
    // a recording can't open up: it's cut, the second piece playing on from where the first stopped
    const left = region(n, 'rgn_take');
    expect(left).toMatchObject({ start: 5 * BAR, length: 3 * BAR });
    expect(left.audio).toMatchObject({ offset: 1.5, fadeIn: 0.2, fadeOut: 0.005 });
    const right = region(n, added[0] as string);
    expect([right.start, right.length]).toEqual([10 * BAR, 3 * BAR]);
    const played = tickToSeconds(p.tempo, 8 * BAR) - tickToSeconds(p.tempo, 5 * BAR);
    expect(right.audio).toMatchObject({ offset: 1.5 + played / 1.25, fadeIn: 0.005, fadeOut: 0.4, stretch: 1.25 });
    // the song's own times
    expect(n.tempo.map((t) => t.tick)).toEqual([0, 6 * BAR, 14 * BAR, 15 * BAR]);
    expect(n.tempo[2]).toMatchObject({ ramp: 16 * BAR + BAR3, to: 90, text: 'rit.' });
    expect(n.meter.map((m) => [m.tick, m.num])).toEqual([
      [0, 4],
      [12 * BAR, 3],
      [B15 + 2 * BAR, 4],
    ]);
    expect(n.meter[2]?.groups).toEqual([3, 3, 2]);
    expect(n.keys?.map((k) => k.tick)).toEqual([0, 10 * BAR, B15 + 2 * BAR]);
    expect(n.key).toBe('C major');
    expect(n.markers.map((m) => [m.id, m.tick])).toEqual([
      ['mrk_intro', 0],
      ['mrk_verse', 4 * BAR],
      ['mrk_chorus', 10 * BAR],
      ['mrk_bridge', B15 + 2 * BAR],
    ]);
    expect(n.chords.map((c) => c.tick)).toEqual([0, 2 * BAR, 10 * BAR, 11 * BAR + 2 * PPQ]);
    expect(n.cycle).toEqual({ on: true, start: 6 * BAR, end: 12 * BAR });
    expect(n.loop).toEqual({ start: 0, end: 19 * BAR, tail: 2 });
    // a repeat's end belongs to the bar before it: the new bars come after the repeat
    expect(n.form?.map((f) => [f.k, f.tick, f.e])).toEqual([
      ['start', 2 * BAR, undefined],
      ['ending', 7 * BAR, 8 * BAR],
      ['end', 8 * BAR, undefined],
      ['segno', 11 * BAR, undefined],
      ['fine', 12 * BAR + 2 * BAR3, undefined],
      ['ds', 17 * BAR, undefined],
    ]);
    expect(n.score?.breaks).toEqual([
      [4 * BAR, 'system'],
      [10 * BAR, 'page'],
      [B15 + 2 * BAR, 'system'],
    ]);
    expect(n.score?.composer).toBe('Someone');
    expect(track(n, 'trk_piano').score?.clefs).toEqual([
      [0, 1, 'G'],
      [0, 2, 'F'],
      [10 * BAR, 2, 'G'],
      [B15 + 2 * BAR, 2, 'F'],
    ]);
  });

  it('holds automation and dynamics through the new bars', () => {
    const n = applyOp(song(), insert(8 * BAR, 2));
    const lane = (param: string) => track(n, 'trk_piano').channel.automation?.find((a) => a.param === param)?.points;
    // −12 at bar 7 to −3 at bar 11, through −7.5 at bar 9: held there for the two new bars
    expect(lane('volume')).toEqual([
      [0, -6],
      [6 * BAR, -12],
      [8 * BAR, -7.5],
      [10 * BAR, -7.5],
      [12 * BAR, -3],
    ]);
    // a step needs nothing new
    expect(lane('mute')).toEqual([
      [0, 0],
      [11 * BAR, 1],
      [13 * BAR, 0],
    ]);
    // a lane that starts at the insert just moves on
    expect(n.master.automation?.[0]?.points).toEqual([
      [10 * BAR, 0],
      [18 * BAR, -60],
    ]);
    const strings = track(n, 'trk_strings').instrument;
    expect(strings.type === 'performance' && strings.play?.dyn?.map((d) => d[0])).toEqual([
      0,
      6 * BAR,
      8 * BAR,
      10 * BAR,
      14 * BAR,
    ]);
  });

  it('and deleting them again gives the song back as it was', () => {
    for (const [at, bars, bar] of [
      [8 * BAR, 2, BAR],
      [6 * BAR, 1, BAR],
      [10 * BAR, 3, BAR],
      [10 * BAR + BAR3, 2, BAR3],
      [0, 4, BAR],
      [B15 + BAR, 1, BAR],
      [B15 + 8 * BAR, 2, BAR],
    ] as const) {
      const p = song();
      const opened = applyOp(p, insert(at, bars, bar));
      expect(() => parseProject(opened)).not.toThrow();
      expect(applyOp(opened, del(at, at + bars * bar)), `at ${at}`).toStrictEqual(p);
    }
  });

  it('starts the song with what started it, when the bars go in at the very start', () => {
    const n = applyOp(song(), insert(0, 2));
    expect(n.tempo[0]).toEqual({ tick: 0, bpm: 100, text: 'Moderato', mm: true });
    expect(n.tempo[1]?.tick).toBe(8 * BAR);
    expect(n.keys?.[0]).toEqual({ tick: 0, fifths: 0, mode: 'major' });
    expect(n.meter[0]).toEqual({ tick: 0, num: 4, den: 4 });
    expect(track(n, 'trk_piano').score?.clefs?.slice(0, 2)).toEqual([
      [0, 1, 'G'],
      [0, 2, 'F'],
    ]);
    expect(region(n, 'rgn_before').start).toBe(2 * BAR);
    expect(region(n, 'rgn_pad').start).toBe(2 * BAR);
  });
});

describe('deleting bars', () => {
  it('closes the song up: what was in them goes, what came after moves back', () => {
    const p = song();
    const n = applyOp(p, del(8 * BAR, 9 * BAR));
    expect(() => parseProject(n)).not.toThrow();
    // a MIDI region across them closes up, keeping its id
    const across = region(n, 'rgn_across');
    expect(across).toMatchObject({ start: 2 * BAR, length: 7 * BAR });
    expect(across.notes.map((x) => x.t)).toEqual([0, 5 * BAR + 2 * PPQ, 6 * BAR + PPQ]);
    // a controller holds what it had reached at the end of the cut bar
    expect(across.cc['1']).toEqual([
      [0, 10],
      [5 * BAR, 64],
      [6 * BAR, 100],
    ]);
    expect(across.cc.pb).toEqual([
      [0, 0],
      [5 * BAR + 100, 4000],
      [6 * BAR, -2000],
    ]);
    // a line into the cut bar stops where it was; a mark in it goes
    expect(across.marks).toEqual([
      { t: 0, k: 'dyn', v: 'mf' },
      { t: 5 * BAR, k: 'cresc', e: 6 * BAR },
    ]);
    // a recording across it: the part before keeps its id, the part after plays on from bar 10's audio
    const vox = track(n, 'trk_vox').regions;
    expect(vox.map((r) => [r.start, r.length])).toEqual([
      [5 * BAR, 3 * BAR],
      [8 * BAR, 2 * BAR],
      [14 * BAR, BAR],
    ]);
    expect(vox[0]?.id).toBe('rgn_take');
    expect(vox[2]?.id).toBe('rgn_late');
    const played = tickToSeconds(p.tempo, 9 * BAR) - tickToSeconds(p.tempo, 5 * BAR);
    expect(vox[1]?.audio?.offset).toBeCloseTo(1.5 + played / 1.25, 9);
    expect(n.markers.map((m) => m.id)).toEqual(['mrk_intro', 'mrk_verse', 'mrk_bridge']);
    expect(n.markers[2]?.tick).toBe(12 * BAR);
    // the key that started in the cut bar plays from where it was
    expect(n.keys?.map((k) => [k.tick, k.fifths])).toEqual([
      [0, 0],
      [8 * BAR, 1],
      [12 * BAR, -1],
    ]);
    expect(n.cycle).toEqual({ on: true, start: 6 * BAR, end: 9 * BAR });
    // repeat signs at the cut bar stay where it was, so the form still holds
    expect(n.form?.map((f) => [f.k, f.tick])).toEqual([
      ['start', 2 * BAR],
      ['ending', 7 * BAR],
      ['end', 8 * BAR],
      ['segno', 8 * BAR],
      ['fine', 9 * BAR + 2 * BAR3],
      ['ds', 14 * BAR],
    ]);
    const lane = track(n, 'trk_piano').channel.automation?.find((a) => a.param === 'volume')?.points;
    // each side keeps its shape: −7.5 reached at bar 9, then on from −5.25 (bar 10's) to −3
    expect(lane).toEqual([
      [0, -6],
      [6 * BAR, -12],
      [8 * BAR, -7.5],
      [8 * BAR, -5.25],
      [9 * BAR, -3],
    ]);
  });

  it('takes away whole regions inside the bars, and a recording heals only where it plays on', () => {
    const p = song();
    const n = applyOp(p, del(15 * BAR, 16 * BAR));
    expect(track(n, 'trk_vox').regions.map((r) => r.id)).toEqual(['rgn_take']);
    // two pieces of one recording, a bar of it cut from between them: they stay two
    const cut = applyOp(p, del(7 * BAR, 9 * BAR));
    expect(track(cut, 'trk_vox').regions.filter((r) => r.start < 10 * BAR)).toHaveLength(2);
  });
});

describe('copying and moving bars', () => {
  it('copies bars to a bar line, what was there moving on; the copies are new, the originals keep their ids', () => {
    const p = song();
    const n = applyOp(p, { op: 'arrange', edit: 'copy', from: 2 * BAR, to: 4 * BAR, at: B15 });
    expect(() => parseProject(n)).not.toThrow();
    expect(region(n, 'rgn_after').start).toBe(B15 + 2 * BAR);
    // the MIDI region across the copied bars stays whole; its piece in them is copied
    expect(region(n, 'rgn_across')).toEqual(region(p, 'rgn_across'));
    const copied = track(n, 'trk_piano').regions.filter((r) => r.start === B15);
    expect(copied).toHaveLength(1);
    expect(copied[0]?.id).not.toBe('rgn_across');
    expect(copied[0]?.notes.map((x) => x.p)).toEqual([62]);
    expect(copied[0]?.length).toBe(2 * BAR);
    // the pad runs through bar 15: it's cut there for the copy
    const pads = track(n, 'trk_strings').regions;
    expect(pads.map((r) => [r.start, r.length])).toEqual([
      [0, B15],
      [B15, 2 * BAR],
      [B15 + 2 * BAR, 16 * BAR - B15],
    ]);
    expect(pads[0]?.id).toBe('rgn_pad');
    expect(new Set(pads.map((r) => r.id)).size).toBe(3);
    // the copied bars' chord comes with them; the cycle stays with the original bars
    expect(n.chords.filter((c) => c.symbol === 'F').map((c) => c.tick)).toEqual([2 * BAR, B15]);
    expect(n.cycle).toEqual(p.cycle);
    expect(n.markers.find((m) => m.name === 'Bridge')?.tick).toBe(B15 + 2 * BAR);
    // a repeat's start in the copied bars is copied too
    expect(n.form?.filter((f) => f.k === 'start').map((f) => f.tick)).toEqual([2 * BAR, B15]);
    // and they play at their own tempo there
    expect(n.tempo.find((t) => t.tick === B15)).toMatchObject({ bpm: 100, text: 'Moderato' });
  });

  it('copies a marker with a new id', () => {
    const n = applyOp(song(), { op: 'arrange', edit: 'copy', from: 8 * BAR, to: 9 * BAR, at: 16 * BAR });
    const chorus = n.markers.filter((m) => m.name === 'Chorus');
    expect(chorus.map((m) => m.tick)).toEqual([8 * BAR, 16 * BAR]);
    expect(chorus[0]?.id).toBe('mrk_chorus');
    expect(chorus[1]?.id).not.toBe('mrk_chorus');
  });

  it('moves bars later or earlier; regions moving whole keep their ids', () => {
    const p = song();
    const later = applyOp(p, { op: 'arrange', edit: 'move', from: B15, to: B15 + 2 * BAR, at: B15 + 4 * BAR });
    expect(() => parseProject(later)).not.toThrow();
    expect(region(later, 'rgn_after').start).toBe(B15 + 2 * BAR);
    expect(region(later, 'rgn_late').start).toBe(B15);
    expect(later.markers.find((m) => m.id === 'mrk_bridge')?.tick).toBe(B15 + 2 * BAR);
    const earlier = applyOp(p, { op: 'arrange', edit: 'move', from: B15, to: B15 + 2 * BAR, at: 0 });
    expect(region(earlier, 'rgn_after').start).toBe(0);
    expect(region(earlier, 'rgn_before').start).toBe(2 * BAR);
    expect(earlier.markers.map((m) => [m.id, m.tick])).toEqual([
      ['mrk_bridge', 0],
      ['mrk_intro', 2 * BAR],
      ['mrk_verse', 6 * BAR],
      ['mrk_chorus', 10 * BAR],
    ]);
    expect(earlier.tempo[0]).toMatchObject({ tick: 0, bpm: 105 });
    expect(earlier.meter[0]).toMatchObject({ tick: 0, num: 4, den: 4, groups: [3, 3, 2] });
    expect(() => parseProject(earlier)).not.toThrow();
    expect(new Set(ids(earlier)).size).toBe(ids(earlier).length);
  });
});

describe('what arrange refuses', () => {
  const refused = (op: Op): string => {
    try {
      applyOp(song(), op);
    } catch (err) {
      expect(err).toBeInstanceOf(OpError);
      return (err as Error).message;
    }
    throw new Error('not refused');
  };
  it('positions off a bar line', () => {
    expect(refused(insert(8 * BAR + PPQ, 1))).toMatch(/9\.2\.1.*bar line/);
    expect(refused(del(8 * BAR, 9 * BAR + 10))).toMatch(/"to".*bar line/);
    expect(refused({ op: 'arrange', edit: 'copy', from: 0, to: BAR, at: BAR + PPQ })).toMatch(/"at".*bar line/);
    // an insert is whole bars of the meter before it
    expect(refused({ op: 'arrange', edit: 'insert', from: 10 * BAR + BAR3, to: 11 * BAR + BAR3 })).toMatch(/3\/4/);
  });
  it('a move into itself, nothing to do, and a song with a pickup at its start', () => {
    expect(refused({ op: 'arrange', edit: 'move', from: 2 * BAR, to: 6 * BAR, at: 4 * BAR })).toMatch(/inside/);
    expect(refused({ op: 'arrange', edit: 'move', from: 2 * BAR, to: 6 * BAR, at: 6 * BAR })).toMatch(/already/);
    expect(refused({ op: 'arrange', edit: 'delete', from: 2 * BAR, to: 2 * BAR })).toMatch(/after/);
    expect(refused({ op: 'arrange', edit: 'twist' as 'insert', from: 0, to: BAR })).toMatch(/insert, delete/);
    const pickup = song();
    pickup.meter = [{ tick: 0, num: 4, den: 4, pickup: PPQ }];
    expect(() => applyOp(pickup, insert(0, 1))).toThrow(/pickup/);
    expect(() => applyOp(pickup, insert(BAR, 1))).not.toThrow();
  });
});

describe('splitting a region', () => {
  it('cuts it in two at a tick: the left half keeps the id, the right takes the one given', () => {
    const p = song();
    const n = applyOp(p, { op: 'splitRegion', track: 'trk_piano', region: 'rgn_across', at: 8 * BAR, id: 'rgn_right' });
    const left = region(n, 'rgn_across');
    const right = region(n, 'rgn_right');
    expect([left.start, left.length, right.start, right.length]).toEqual([2 * BAR, 6 * BAR, 8 * BAR, 2 * BAR]);
    expect(left.notes.map((x) => x.t)).toEqual([0, 5 * BAR + 2 * PPQ]);
    expect(right.notes.map((x) => x.t)).toEqual([0, BAR + PPQ]);
    expect(right.cc['1']).toEqual([[PPQ, 100]]);
    // a line across the cut stops there; marks after it go to the right half
    expect(left.marks).toEqual([
      { t: 0, k: 'dyn', v: 'mf' },
      { t: 5 * BAR, k: 'cresc', e: 6 * BAR },
    ]);
    expect(right.marks).toEqual([{ t: PPQ, k: 'text', v: 'dolce' }]);
    expect(() => parseProject(n)).not.toThrow();
  });

  it('plays a recording on from where the cut fell', () => {
    const p = song();
    const n = applyOp(p, { op: 'splitRegion', track: 'trk_vox', region: 'rgn_take', at: 7 * BAR, id: 'rgn_b' });
    const played = tickToSeconds(p.tempo, 7 * BAR) - tickToSeconds(p.tempo, 5 * BAR);
    expect(region(n, 'rgn_take').audio).toMatchObject({ offset: 1.5, fadeIn: 0.2, fadeOut: 0 });
    expect(region(n, 'rgn_b').audio).toMatchObject({ offset: 1.5 + played / 1.25, fadeIn: 0, fadeOut: 0.4 });
  });

  it('refuses a tick outside the region and an id the song has', () => {
    const p = song();
    expect(() =>
      applyOp(p, { op: 'splitRegion', track: 'trk_vox', region: 'rgn_take', at: 5 * BAR, id: 'rgn_b' }),
    ).toThrow(/inside/);
    expect(() =>
      applyOp(p, { op: 'splitRegion', track: 'trk_vox', region: 'rgn_take', at: 6 * BAR, id: 'rgn_late' }),
    ).toThrow(/exists/);
    expect(() =>
      applyOp(p, { op: 'splitRegion', track: 'trk_vox', region: 'rgn_nope', at: 6 * BAR, id: 'rgn_b' }),
    ).toThrow(OpError);
  });
});

it('a creation’s track whose music an arrangement changed is marked edited', () => {
  const p = song();
  const piano = p.tracks[0] as Track;
  piano.origin = { voice: 'keys', edited: false };
  expect(applyOps(p, [insert(8 * BAR, 1)]).tracks[0]?.origin?.edited).toBe(true);
  expect(applyOps(p, [insert(20 * BAR, 1)]).tracks[0]?.origin?.edited).toBe(false);
});
