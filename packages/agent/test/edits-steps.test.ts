/** A drum part as steps: read without moving a note, and every edit the Step Grid makes. */
import { applyOps, type Note, newProject, newRegion, newTrack, PPQ, type Project, type Track } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  euclid,
  heldOf,
  kitRows,
  levelOf,
  missingStepEdits,
  parseLine,
  playsHits,
  readSteps,
  rowNamed,
  STEP_EDITS,
  type StepContext,
  type StepEdit,
  stepLine,
  stepOps,
  stepPreview,
  stepRows,
  stepSize,
  stepsIn,
} from '../src/edits/steps.ts';

const BAR = PPQ * 4;
const S = PPQ / 4;
const KICK = 36;
const SNARE = 38;
const HAT = 42;

/** A drum track with one region over `bars` bars and these notes ([tick, pitch, velocity]). */
function part(notes: [number, number, number?][], bars = 2): { project: Project; track: Track } {
  const project = newProject('Steps');
  const track = newTrack('Drums', { type: 'synth', preset: 'Drum Synth' });
  const r = newRegion(0, BAR * bars, 'Drums');
  r.notes = notes.map(([t, p, v]) => ({ t, d: S, p, v: v ?? 100 }));
  track.regions = [r];
  project.tracks = [track];
  return { project, track };
}

const ctxOf = (x: { project: Project; track: Track }, bars = 1, from = 0): StepContext => ({
  project: x.project,
  track: x.track,
  from,
  to: from + BAR * bars,
  size: S,
});

/** The rows of a part after an edit, as lines. */
function after(x: { project: Project; track: Track }, edits: StepEdit | StepEdit[], bars = 1, from = 0) {
  const ctx = ctxOf(x, bars, from);
  const project = applyOps(x.project, stepOps(ctx, edits));
  const track = project.tracks[0] as Track;
  const line = (pitch: number, f = from, n = bars) => {
    const steps = stepsIn(project.meter, f, f + BAR * n, S);
    const row = readSteps(heldOf(track), steps, f + BAR * n).get(pitch);
    return row ? stepLine(row) : '.'.repeat(steps.length);
  };
  return { project, track, line };
}

describe('the steps of a bar', () => {
  it('are counted from each bar line, with the beats marked', () => {
    const p = newProject('x');
    const steps = stepsIn(p.meter, 0, BAR * 2, S);
    expect(steps).toHaveLength(32);
    expect(steps[17]).toEqual({ tick: BAR + S, bar: BAR, index: 1, beat: false, alt: false });
    expect(
      steps
        .slice(0, 16)
        .map((s) => (s.alt ? 'a' : '.'))
        .join(''),
    ).toBe('....aaaa....aaaa');
    expect(steps.filter((s) => s.beat).map((s) => s.index)).toEqual([0, 4, 8, 12, 0, 4, 8, 12]);
    // triplets: twelve to a bar of four, three to a beat
    const t = stepsIn(p.meter, 0, BAR, stepSize('1/8T'));
    expect([t.length, t.filter((s) => s.beat).length]).toEqual([12, 4]);
  });

  it('follow the meter: a bar of three has twelve sixteenths', () => {
    const p = newProject('x');
    p.meter = [{ tick: 0, num: 3, den: 4 }];
    expect(stepsIn(p.meter, 0, PPQ * 6, S)).toHaveLength(24);
    expect(stepsIn(p.meter, 0, PPQ * 6, S)[12]?.bar).toBe(PPQ * 3);
  });
});

describe('a part read as steps', () => {
  it('lights the step each note is nearest, and keeps where the note really is', () => {
    const x = part([
      [0, KICK, 120],
      [S * 4 + 30, SNARE, 90],
      [S * 8 - 40, KICK, 60],
      [S * 2, HAT, 30],
    ]);
    const steps = stepsIn(x.project.meter, 0, BAR, S);
    const rows = readSteps(heldOf(x.track), steps, BAR);
    expect(stepLine(rows.get(KICK) ?? [])).toBe('X.......o.......');
    expect(stepLine(rows.get(SNARE) ?? [])).toBe('....x...........');
    expect(stepLine(rows.get(HAT) ?? [])).toBe('..g.............');
    expect(rows.get(SNARE)?.[4]?.offset).toBe(30);
    expect(rows.get(KICK)?.[8]?.offset).toBe(-40);
    // reading changed nothing
    expect(x.track.regions[0]?.notes.map((n) => n.t)).toEqual([0, S * 4 + 30, S * 8 - 40, S * 2]);
  });

  it('gives a note played just before a bar to that bar’s first step, and one just before the next page to that page', () => {
    const x = part([
      [BAR - 20, KICK],
      [BAR * 2 - 20, SNARE],
    ]);
    const second = stepsIn(x.project.meter, BAR, BAR * 2, S);
    const rows = readSteps(heldOf(x.track), second, BAR * 2);
    expect(stepLine(rows.get(KICK) ?? [])).toBe('x...............');
    expect(rows.get(KICK)?.[0]?.offset).toBe(-20);
    expect(rows.has(SNARE)).toBe(false);
    const first = stepsIn(x.project.meter, 0, BAR, S);
    expect(readSteps(heldOf(x.track), first, BAR).has(KICK)).toBe(false);
  });

  it('shows a flam as one step, as hard as its hardest note', () => {
    const x = part([
      [S * 4 - 25, SNARE, 50],
      [S * 4, SNARE, 118],
    ]);
    const cell = readSteps(heldOf(x.track), stepsIn(x.project.meter, 0, BAR, S), BAR).get(SNARE)?.[4];
    expect([cell?.notes.length, cell?.v, cell?.offset]).toEqual([2, 118, -25]);
  });

  it('reads velocities as the four levels', () => {
    expect([127, 113, 112, 86, 85, 56, 55, 1].map((v) => levelOf(v).letter).join('')).toBe('XXxxoogg');
  });
});

describe('lines of steps', () => {
  it('are read with spaces and bar lines for the eye', () => {
    expect(
      parseLine('X.x. o.g-|____')
        .map((l) => l?.letter ?? '.')
        .join(''),
    ).toBe('X.x.o.g.....');
    expect(() => parseLine('x.q.')).toThrow(/"q" isn't a step/);
  });
});

describe('the Step Grid’s edits', () => {
  it('are all named in STEP_EDITS, each with what it does', () => {
    expect(STEP_EDITS.map((e) => e.name)).toEqual([
      'set',
      'clear',
      'velocity',
      'fill',
      'euclid',
      'shift',
      'humanize',
      'copy',
      'swing',
      'clear-row',
      'write',
    ]);
    expect(missingStepEdits(STEP_EDITS.map((e) => e.name))).toEqual([]);
    expect(missingStepEdits(['set', 'clear'])).toContain('euclid');
  });

  it('set lights a step with a note a step long, and sets how hard a lit one is hit', () => {
    const x = part([[0, KICK]]);
    const lit = after(x, { edit: 'set', pitch: SNARE, step: 4 });
    expect(lit.line(SNARE)).toBe('....x...........');
    expect(lit.track.regions[0]?.notes.find((n) => n.p === SNARE)).toEqual({ t: S * 4, d: S, p: SNARE, v: 100 });
    const harder = after(x, { edit: 'set', pitch: KICK, step: 0, v: 124 });
    expect(harder.line(KICK)).toBe('X...............');
    expect(harder.track.regions[0]?.notes).toHaveLength(1);
    // nothing changes: no operation
    expect(stepOps(ctxOf(x), { edit: 'set', pitch: KICK, step: 0, v: 100 })).toEqual([]);
    expect(() => stepOps(ctxOf(x), { edit: 'set', pitch: KICK, step: 16 })).toThrow(/16 steps here/);
  });

  it('clear puts a step out, all of a flam with it, and leaves the rest alone', () => {
    const x = part([
      [S * 4 - 25, SNARE, 50],
      [S * 4, SNARE],
      [0, KICK],
    ]);
    const out = after(x, { edit: 'clear', pitch: SNARE, step: 4 });
    expect(out.track.regions[0]?.notes.map((n) => n.p)).toEqual([KICK]);
    // (the kick is the note it was)
    expect(out.track.regions[0]?.notes[0]).toBe(x.track.regions[0]?.notes[2]);
  });

  it('several edits made together see each other: a painted row is one change', () => {
    const x = part([]);
    const edits: StepEdit[] = [0, 4, 8, 12].map((step) => ({ edit: 'set', pitch: KICK, step }));
    const ops = stepOps(ctxOf(x), [...edits, { edit: 'clear', pitch: KICK, step: 8 }]);
    expect(ops).toHaveLength(1);
    expect(after(x, [...edits, { edit: 'clear', pitch: KICK, step: 8 }]).line(KICK)).toBe('x...x.......x...');
    // what a drag shows before it's let go is the same part
    const held = stepPreview(ctxOf(x), edits);
    expect(stepLine(readSteps(held, stepsIn(x.project.meter, 0, BAR, S), BAR).get(KICK) ?? [])).toBe(
      'x...x...x...x...',
    );
    expect(x.track.regions[0]?.notes).toEqual([]);
  });

  it('velocity sets lit steps, or moves them, on a row or on all, within 1 to 127', () => {
    const x = part([
      [0, KICK, 100],
      [S * 8, KICK, 60],
      [S * 4, SNARE, 120],
    ]);
    expect(after(x, { edit: 'velocity', pitch: KICK, v: 124 }).line(KICK)).toBe('X.......X.......');
    expect(after(x, { edit: 'velocity', pitch: KICK, steps: [8], v: 124 }).line(KICK)).toBe('x.......X.......');
    const down = after(x, { edit: 'velocity', by: -70 });
    expect(down.track.regions[0]?.notes.map((n) => n.v).sort((a, b) => a - b)).toEqual([1, 30, 50]);
  });

  it('fill lights every Nth step and keeps what was lit', () => {
    const x = part([[S * 2, HAT, 40]]);
    const filled = after(x, { edit: 'fill', pitch: HAT, every: 2 });
    expect(filled.line(HAT)).toBe('x.g.x.x.x.x.x.x.');
    expect(after(x, { edit: 'fill', pitch: HAT, every: 4, offset: 2, v: 72 }).line(HAT)).toBe('..g...o...o...o.');
  });

  it('euclid spreads hits evenly in each bar, replacing the row', () => {
    expect(
      euclid(3, 8)
        .map((on) => (on ? 'x' : '.'))
        .join(''),
    ).toBe('x..x..x.');
    expect(euclid(5, 16).filter(Boolean)).toHaveLength(5);
    expect(
      euclid(4, 16)
        .map((on) => (on ? 'x' : '.'))
        .join(''),
    ).toBe('x...x...x...x...');
    expect(
      euclid(3, 8, 1)
        .map((on) => (on ? 'x' : '.'))
        .join(''),
    ).toBe('.x..x..x');
    expect([euclid(0, 8).some(Boolean), euclid(9, 8).every(Boolean)]).toEqual([false, true]);
    const x = part([[S, KICK]]);
    const made = after(x, { edit: 'euclid', pitch: KICK, hits: 3 }, 2);
    expect(made.line(KICK, 0, 2)).toBe('x.....x....x....x.....x....x....');
  });

  it('shift turns a row around its ends, each note keeping its own place in its step', () => {
    const x = part([
      [0, KICK],
      [S * 4 + 30, KICK],
      [S * 15, KICK],
    ]);
    const later = after(x, { edit: 'shift', pitch: KICK, by: 1 });
    expect(later.line(KICK)).toBe('xx...x..........');
    expect(later.track.regions[0]?.notes.map((n) => n.t).sort((a, b) => a - b)).toEqual([0, S, S * 5 + 30]);
    expect(after(x, { edit: 'shift', by: -4 }).line(KICK)).toBe('x..........xx...');
    expect(stepOps(ctxOf(x), { edit: 'shift', by: 0 })).toEqual([]);
  });

  it('humanize varies how hard each step is hit, the same way for the same seed', () => {
    const x = part([0, 4, 8, 12].map((i) => [S * i, HAT, 100]));
    const a = after(x, { edit: 'humanize', amount: 20, seed: 7 }).track.regions[0]?.notes.map((n) => n.v) ?? [];
    const b = after(x, { edit: 'humanize', amount: 20, seed: 7 }).track.regions[0]?.notes.map((n) => n.v) ?? [];
    expect(a).toEqual(b);
    expect(new Set(a).size).toBeGreaterThan(1);
    for (const v of a) expect(Math.abs(v - 100)).toBeLessThanOrEqual(20);
    expect(stepOps(ctxOf(x), { edit: 'humanize', amount: 0 })).toEqual([]);
  });

  it('copy lays these bars over others, replacing what the rows had there', () => {
    const x = part(
      [
        [0, KICK],
        [S * 4 + 20, SNARE, 110],
        [BAR + S * 2, KICK],
        [BAR + S * 6, HAT],
      ],
      4,
    );
    const made = after(x, { edit: 'copy', to: BAR, times: 2 });
    expect(made.line(KICK, BAR, 2)).toBe('x...............x...............');
    expect(made.line(SNARE, BAR, 2)).toBe('....x...............x...........');
    // a row the copied bars don't have is left as it was
    expect(made.line(HAT, BAR, 1)).toBe('......x.........');
    // (and the snare keeps its lateness)
    expect(made.track.regions[0]?.notes.filter((n) => n.p === SNARE).map((n) => n.t)).toEqual([
      S * 4 + 20,
      BAR + S * 4 + 20,
      BAR * 2 + S * 4 + 20,
    ]);
    expect(() => stepOps(ctxOf(x), { edit: 'copy', to: BAR + S })).toThrow(/bar line/);
    expect(() => stepOps(ctxOf(x, 2), { edit: 'copy', to: BAR })).toThrow(/over themselves/);
  });

  it('swing pushes the off-steps late and puts them back at 0, and only on a straight grid', () => {
    const x = part([0, 1, 2, 3].map((i) => [S * i, HAT]));
    const swung = after(x, { edit: 'swing', amount: 0.5 });
    expect(swung.track.regions[0]?.notes.map((n) => n.t)).toEqual([0, S + S / 4, S * 2, S * 3 + S / 4]);
    // still the same steps
    expect(swung.line(HAT)).toBe('xxxx............');
    const back = applyOps(swung.project, stepOps({ ...ctxOf(x), track: swung.track }, { edit: 'swing', amount: 0 }));
    expect(back.tracks[0]?.regions[0]?.notes.map((n) => n.t)).toEqual([0, S, S * 2, S * 3]);
    expect(() => stepOps({ ...ctxOf(x), size: stepSize('1/8T') }, { edit: 'swing', amount: 0.5 })).toThrow(
      /triplet grid/,
    );
  });

  it('clear-row puts a row out, or every row', () => {
    const x = part([
      [0, KICK],
      [S * 4, SNARE],
      [BAR, KICK],
    ]);
    const one = after(x, { edit: 'clear-row', pitch: KICK });
    expect(one.track.regions[0]?.notes.map((n) => [n.t, n.p])).toEqual([
      [S * 4, SNARE],
      [BAR, KICK],
    ]);
    expect(after(x, { edit: 'clear-row' }).track.regions[0]?.notes.map((n) => n.t)).toEqual([BAR]);
  });

  it('write sets a row from a line, repeating a short one, and keeps the velocity of a step it already reads as', () => {
    const x = part([
      [0, KICK, 91],
      [S * 2, KICK],
    ]);
    const made = after(x, { edit: 'write', pitch: KICK, pattern: 'x...X.g.' });
    expect(made.line(KICK)).toBe('x...X.g.x...X.g.');
    expect(made.track.regions[0]?.notes.find((n) => n.t === 0)?.v).toBe(91);
    expect(() => stepOps(ctxOf(x), { edit: 'write', pitch: KICK, pattern: 'x'.repeat(17) })).toThrow(/17 steps/);
    expect(() => stepOps(ctxOf(x), { edit: 'write', pitch: KICK, pattern: ' | ' })).toThrow(/no steps/);
  });

  it('makes a region where the part has none, joined over the bars it fills, around what’s there', () => {
    const project = newProject('Empty');
    const track = newTrack('Drums', { type: 'synth', preset: 'Drum Synth' });
    const there = newRegion(BAR * 2 + PPQ * 2, BAR, 'Later');
    track.regions = [there];
    project.tracks = [track];
    const ctx: StepContext = { project, track, from: 0, to: BAR * 3, size: S };
    const ops = stepOps(ctx, [
      { edit: 'set', pitch: KICK, step: 0 },
      { edit: 'set', pitch: KICK, step: 16 },
      { edit: 'set', pitch: KICK, step: 32 },
      { edit: 'set', pitch: SNARE, step: 44 },
    ]);
    const next = applyOps(project, ops).tracks[0] as Track;
    const regions = [...next.regions].sort((a, b) => a.start - b.start);
    // bars 1 and 2 as one region, the free half of bar 3 as another, and the region that was there
    expect(regions.map((r) => [r.start, r.length, r.notes.map((n: Note) => n.t)])).toEqual([
      [0, BAR * 2 + PPQ * 2, [0, BAR, BAR * 2]],
      [BAR * 2 + PPQ * 2, BAR, [S * 4]],
    ]);
  });
});

describe('writing past the end of a part', () => {
  it('grows the region that ends there, so a part written bar after bar stays one region', () => {
    const x = part([[0, KICK]], 1);
    const ctx: StepContext = { project: x.project, track: x.track, from: BAR, to: BAR * 3, size: S };
    const ops = stepOps(ctx, [
      { edit: 'set', pitch: KICK, step: 0 },
      { edit: 'set', pitch: SNARE, step: 20 },
    ]);
    expect(ops.map((o) => o.op)).toEqual(['updateRegion', 'setNotes']);
    const region = applyOps(x.project, ops).tracks[0]?.regions;
    expect(region).toHaveLength(1);
    expect([region?.[0]?.length, region?.[0]?.notes.map((n) => n.t)]).toEqual([BAR * 3, [0, BAR, BAR * 2 + S * 4]]);
    // (a preview of it shows the same part, and the song is as it was)
    expect(x.track.regions[0]?.length).toBe(BAR);
  });

  it('doesn’t grow a muted region: a new one starts beside it', () => {
    const x = part([[0, KICK]], 1);
    (x.track.regions[0] as { muted: boolean }).muted = true;
    const ops = stepOps(
      { project: x.project, track: x.track, from: BAR, to: BAR * 2, size: S },
      {
        edit: 'set',
        pitch: KICK,
        step: 0,
      },
    );
    expect(ops.map((o) => o.op)).toEqual(['addRegion']);
  });
});

describe('a kit’s rows', () => {
  const drums = { type: 'synth', preset: 'Drum Synth' } as const;
  const kit = { type: 'sampler', pack: 'p', name: 'Kit' } as const;

  it('are a kit’s when the instrument plays hits, not pitches', () => {
    expect(playsHits(drums, null)).toBe(true);
    expect(playsHits({ type: 'synth', preset: 'Soft Keys' }, null)).toBe(false);
    expect(playsHits(kit, { pads: [{ key: 36, name: 'Kick' }] })).toBe(true);
    expect(playsHits(kit, { pitched: false })).toBe(true);
    expect(playsHits(kit, {})).toBe(false);
    // (a map not known yet: not said to be one)
    expect(playsHits(kit, null)).toBe(false);
    expect(playsHits(null, null)).toBe(false);
  });

  it('are named by the kit, or by General MIDI, kick first', () => {
    expect(
      kitRows(null)
        .slice(0, 4)
        .map((r) => r.name),
    ).toEqual(['Kick', 'Kick 2', 'Snare', 'Snare 2']);
    expect(kitRows([{ key: 60, name: 'Boom' }])).toEqual([{ note: 60, name: 'Boom' }]);
  });

  it('show what the part plays, in the kit’s order, then keys the kit doesn’t name; a few to start an empty part', () => {
    const gm = kitRows(null);
    expect(stepRows(gm, [42, 36, 99, 38]).map((r) => r.name)).toEqual(['Kick', 'Snare', 'Closed Hat', 'Key 99']);
    expect(stepRows(gm, []).map((r) => r.name)).toEqual([
      'Kick',
      'Snare',
      'Clap',
      'Closed Hat',
      'Open Hat',
      'Low Tom',
      'High Tom',
      'Crash',
    ]);
    expect(stepRows(gm, [36], true)).toHaveLength(gm.length);
    // a grid to write in keeps the first few in reach, whatever is played
    expect(stepRows(gm, [36, 56], false, true).map((r) => r.name)).toEqual([
      'Kick',
      'Snare',
      'Clap',
      'Closed Hat',
      'Open Hat',
      'Low Tom',
      'High Tom',
      'Crash',
      'Cowbell',
    ]);
    const own = kitRows([
      { key: 60, name: 'Boom' },
      { key: 62, name: 'Tick' },
    ]);
    expect(stepRows(own, []).map((r) => r.name)).toEqual(['Boom', 'Tick']);
  });

  it('are found by name, the start of one, or a key', () => {
    const gm = kitRows(null);
    expect(rowNamed(gm, 'snare')?.note).toBe(38);
    expect(rowNamed(gm, 'Closed')?.note).toBe(42);
    expect(rowNamed(gm, 'hat')?.note).toBe(42);
    expect(rowNamed(gm, '46')?.name).toBe('Open Hat');
    expect(rowNamed(gm, '99')).toEqual({ note: 99, name: 'Key 99' });
    expect(rowNamed(gm, 'gong')).toBeUndefined();
  });
});
