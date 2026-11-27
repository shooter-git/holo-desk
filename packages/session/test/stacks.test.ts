import { describe, expect, it } from 'vitest';
import {
  applyOp,
  applyOps,
  describeChanges,
  describeProject,
  healStacks,
  newBus,
  newProject,
  newRegion,
  newTrack,
  type Op,
  PPQ,
  type Project,
  parseProject,
  performed,
  settle,
  stackBlocks,
  stackOf,
  stackTracks,
} from '../src/index.ts';

/** Six tracks, A to F, each with a bar of notes, and a bus "Sum". */
function song(): Project {
  const p = newProject('Stacked');
  p.tracks = ['A', 'B', 'C', 'D', 'E', 'F'].map((name, i) => {
    const t = { ...newTrack(name, { type: 'synth', preset: 'Soft Keys' }), id: `trk_${name.toLowerCase()}` };
    t.regions = [{ ...newRegion(0, PPQ * 4), notes: [{ t: 0, d: PPQ, p: 60 + i, v: 100 }] }];
    return t;
  });
  p.buses = [{ ...newBus('Sum'), id: 'bus_sum' }];
  return p;
}

const order = (p: Project) =>
  p.tracks.map((t) => (t.stack ? `${t.name}:${t.stack.replace('stk_', '')}` : t.name)).join(' ');
const stacked = (p: Project, id: string, tracks: string[], more: Record<string, unknown> = {}) =>
  applyOp(p, { op: 'addStack', stack: { id, name: id.replace('stk_', '').toUpperCase(), ...more }, tracks });
/** B, C and D stacked as "x". */
const withX = () => stacked(song(), 'stk_x', ['trk_b', 'trk_c', 'trk_d']);

describe('making a stack', () => {
  it('puts its tracks under one header, where they were when they were together already', () => {
    const p = withX();
    expect(order(p)).toBe('A B:x C:x D:x E F');
    expect(p.stacks).toEqual([{ id: 'stk_x', name: 'X' }]);
    expect(stackTracks(p, 'stk_x').map((t) => t.name)).toEqual(['B', 'C', 'D']);
    expect(stackOf(p, 'trk_c')?.name).toBe('X');
    expect(stackOf(p, 'trk_a')).toBeUndefined();
  });

  it('gathers tracks that were apart at the first one’s place, in the song’s order', () => {
    expect(order(stacked(song(), 'stk_x', ['trk_e', 'trk_b', 'trk_d']))).toBe('A B:x D:x E:x C F');
    expect(order(stacked(song(), 'stk_x', ['trk_f']))).toBe('A B C D E F:x');
  });

  it('takes a track out of the stack it was in, and a stack left empty goes', () => {
    const p = stacked(withX(), 'stk_y', ['trk_c', 'trk_e']);
    // (gathered where C was, inside the other stack: at that stack's nearer edge)
    expect(order(p)).toBe('A C:y E:y B:x D:x F');
    const all = stacked(withX(), 'stk_y', ['trk_b', 'trk_c', 'trk_d']);
    expect(order(all)).toBe('A B:y C:y D:y E F');
    expect(all.stacks?.map((s) => s.id)).toEqual(['stk_y']);
  });

  it('never lands inside another stack', () => {
    // A and E gathered at A's place: before the block, not in it
    expect(order(stacked(withX(), 'stk_y', ['trk_a', 'trk_e']))).toBe('A:y E:y B:x C:x D:x F');
  });

  it('names a bus its header controls, and routes nothing by it', () => {
    const p = stacked(song(), 'stk_x', ['trk_b', 'trk_c'], { bus: 'bus_sum', color: '#ff0000' });
    expect(p.stacks).toEqual([{ id: 'stk_x', name: 'X', color: '#ff0000', bus: 'bus_sum' }]);
    expect(p.tracks.map((t) => t.channel.output)).toEqual(song().tracks.map((t) => t.channel.output));
  });

  it('refuses what isn’t there, an id used already, and a stack of nothing', () => {
    expect(() => stacked(song(), 'stk_x', ['trk_zz'])).toThrow(/No track "trk_zz"/);
    expect(() => stacked(song(), 'stk_x', [])).toThrow(/needs a track/);
    expect(() => stacked(song(), 'stk_x', ['trk_a'], { bus: 'bus_no' })).toThrow(/No bus "bus_no"/);
    expect(() => stacked(withX(), 'stk_x', ['trk_a'])).toThrow(/Stack "stk_x" exists/);
  });
});

describe('moving a track when the song has stacks', () => {
  const move = (p: Project, track: string, index: number, stack?: string | null) =>
    order(applyOp(p, { op: 'moveTrack', track, index, ...(stack !== undefined ? { stack } : {}) }));

  it('is as it always was in a song with none', () => {
    expect(move(song(), 'trk_a', 3)).toBe('B C D A E F');
    expect(move(song(), 'trk_f', 0)).toBe('F A B C D E');
    expect(move(song(), 'trk_c', 99)).toBe('A B D E F C');
  });

  it('keeps a stack’s track inside its stack', () => {
    expect(move(withX(), 'trk_b', 3)).toBe('A C:x D:x B:x E F');
    expect(move(withX(), 'trk_b', 5)).toBe('A C:x D:x B:x E F');
    expect(move(withX(), 'trk_d', 0)).toBe('A D:x B:x C:x E F');
    expect(move(withX(), 'trk_c', 1)).toBe('A C:x B:x D:x E F');
  });

  it('carries another track on past a stack, the way it was going, never into it', () => {
    expect(move(withX(), 'trk_a', 1)).toBe('B:x C:x D:x A E F');
    // (asked into the block: on to its far side)
    expect(move(withX(), 'trk_f', 2)).toBe('A F B:x C:x D:x E');
    expect(move(withX(), 'trk_f', 3)).toBe('A F B:x C:x D:x E');
    expect(move(withX(), 'trk_a', 3)).toBe('B:x C:x D:x A E F');
    expect(move(withX(), 'trk_e', 0)).toBe('E A B:x C:x D:x F');
  });

  it('puts a track into a stack when told, among its tracks', () => {
    expect(move(withX(), 'trk_f', 2, 'stk_x')).toBe('A B:x F:x C:x D:x E');
    expect(move(withX(), 'trk_a', 0, 'stk_x')).toBe('A:x B:x C:x D:x E F');
    expect(move(withX(), 'trk_f', 0, 'stk_x')).toBe('A F:x B:x C:x D:x E');
    expect(() => move(withX(), 'trk_f', 2, 'stk_no')).toThrow(/No stack "stk_no"/);
  });

  it('takes a track out when told, to the nearer edge, and its stack goes with its last track', () => {
    expect(move(withX(), 'trk_c', 2, null)).toBe('A C B:x D:x E F');
    expect(move(withX(), 'trk_c', 5, null)).toBe('A B:x D:x E F C');
    let p = withX();
    for (const t of ['trk_b', 'trk_c', 'trk_d']) p = applyOp(p, { op: 'moveTrack', track: t, index: 0, stack: null });
    expect(order(p)).toBe('D C B A E F');
    expect(p.stacks).toBeUndefined();
  });

  it('never changes where a track’s sound goes', () => {
    const routed = applyOp(withX(), { op: 'updateChannel', target: 'trk_f', patch: { output: 'bus_sum' } });
    const p = applyOps(routed, [
      { op: 'updateStack', stack: 'stk_x', patch: { bus: 'bus_sum' } },
      { op: 'moveTrack', track: 'trk_a', index: 2, stack: 'stk_x' },
      { op: 'moveTrack', track: 'trk_f', index: 0 },
      { op: 'moveTrack', track: 'trk_b', index: 5, stack: null },
    ]);
    expect(Object.fromEntries(p.tracks.map((t) => [t.name, t.channel.output]))).toEqual({
      A: 'master',
      B: 'master',
      C: 'master',
      D: 'master',
      E: 'master',
      F: 'bus_sum',
    });
  });
});

describe('a stack as a whole', () => {
  it('moves as one block, to where its first track is asked to be, never into another stack', () => {
    const at = (index: number) => order(applyOp(withX(), { op: 'moveStack', stack: 'stk_x', index }));
    expect(at(0)).toBe('B:x C:x D:x A E F');
    expect(at(2)).toBe('A E B:x C:x D:x F');
    expect(at(99)).toBe('A E F B:x C:x D:x');
    const two = stacked(withX(), 'stk_y', ['trk_e', 'trk_f']);
    expect(order(two)).toBe('A B:x C:x D:x E:y F:y');
    // (asked between E and F: on past their stack)
    expect(order(applyOp(two, { op: 'moveStack', stack: 'stk_x', index: 2 }))).toBe('A E:y F:y B:x C:x D:x');
    expect(order(applyOp(two, { op: 'moveStack', stack: 'stk_y', index: 0 }))).toBe('E:y F:y A B:x C:x D:x');
  });

  it('is renamed, coloured, given a bus and made a folder again', () => {
    let p = applyOp(withX(), {
      op: 'updateStack',
      stack: 'stk_x',
      patch: { name: 'Strings', color: '#00ff00', bus: 'bus_sum' },
    });
    expect(p.stacks).toEqual([{ id: 'stk_x', name: 'Strings', color: '#00ff00', bus: 'bus_sum' }]);
    p = applyOp(p, { op: 'updateStack', stack: 'stk_x', patch: { bus: null, color: null } });
    expect(p.stacks).toEqual([{ id: 'stk_x', name: 'Strings' }]);
    expect(() => applyOp(p, { op: 'updateStack', stack: 'stk_x', patch: { bus: 'bus_no' } })).toThrow(/No bus/);
    expect(() => applyOp(p, { op: 'updateStack', stack: 'stk_no', patch: {} })).toThrow(/No stack/);
  });

  it('taken apart leaves its tracks where they are, in no stack', () => {
    const p = applyOp(withX(), { op: 'removeStack', stack: 'stk_x' });
    expect(order(p)).toBe('A B C D E F');
    expect(p.stacks).toBeUndefined();
    expect(p.tracks.every((t) => !('stack' in t))).toBe(true);
  });

  it('is a folder again when its bus is removed', () => {
    const p = applyOps(withX(), [
      { op: 'updateStack', stack: 'stk_x', patch: { bus: 'bus_sum' } },
      { op: 'removeBus', bus: 'bus_sum' },
    ]);
    expect(p.stacks).toEqual([{ id: 'stk_x', name: 'X' }]);
  });
});

describe('other operations, in a song with stacks', () => {
  it('can’t change which stack a track is in by its settings', () => {
    const patch = { name: 'Bee', stack: 'stk_y' } as unknown as { name: string };
    const p = applyOp(withX(), { op: 'updateTrack', track: 'trk_b', patch });
    expect(order(p)).toBe('A Bee:x C:x D:x E F');
    const out = applyOp(withX(), { op: 'updateTrack', track: 'trk_a', patch: { stack: 'stk_x' } as never });
    expect(order(out)).toBe('A B:x C:x D:x E F');
  });

  it('add a track into the stack it names, among its tracks, and into none it doesn’t have', () => {
    const made = (stack?: string) => ({
      ...newTrack('G', { type: 'synth', preset: 'Soft Keys' }),
      id: 'trk_g',
      ...(stack ? { stack } : {}),
    });
    expect(order(applyOp(withX(), { op: 'addTrack', track: made('stk_x') }))).toBe('A B:x C:x D:x G:x E F');
    expect(order(applyOp(withX(), { op: 'addTrack', track: made('stk_x'), index: 0 }))).toBe('A G:x B:x C:x D:x E F');
    expect(order(applyOp(withX(), { op: 'addTrack', track: made('stk_no') }))).toBe('A B:x C:x D:x E F G');
    // a track in no stack never lands inside one
    expect(order(applyOp(withX(), { op: 'addTrack', track: made(), index: 2 }))).toBe('A G B:x C:x D:x E F');
    expect(order(applyOp(song(), { op: 'addTrack', track: made(), index: 2 }))).toBe('A B G C D E F');
  });

  it('remove a stack with its last track', () => {
    let p = withX();
    for (const t of ['trk_b', 'trk_c']) p = applyOp(p, { op: 'removeTrack', track: t });
    expect(p.stacks).toHaveLength(1);
    p = applyOp(p, { op: 'removeTrack', track: 'trk_d' });
    expect(p.stacks).toBeUndefined();
    expect(order(p)).toBe('A E F');
  });
});

describe('a song read', () => {
  it('keeps its stacks as written', () => {
    const p = applyOp(withX(), { op: 'updateStack', stack: 'stk_x', patch: { bus: 'bus_sum', color: '#123456' } });
    const read = parseProject(JSON.parse(JSON.stringify(p)));
    expect(read.stacks).toEqual(p.stacks);
    expect(order(read)).toBe(order(p));
    // a song with none has no list of them, and its tracks say nothing of stacks
    const plain = parseProject(JSON.parse(JSON.stringify(song())));
    expect('stacks' in plain).toBe(false);
    expect(plain.tracks.every((t) => !('stack' in t))).toBe(true);
  });

  it('gathers a stack’s stragglers to its first track, in their order, and takes no track out', () => {
    const p = withX();
    const torn = { ...p, tracks: [p.tracks[1], p.tracks[0], p.tracks[4], p.tracks[3], p.tracks[5], p.tracks[2]] };
    const read = parseProject(JSON.parse(JSON.stringify(torn)));
    expect(order(read)).toBe('B:x D:x C:x A E F');
    expect(read.stacks).toEqual([{ id: 'stk_x', name: 'X' }]);
  });

  it('drops what points at nothing: a stack with no track, a track’s stack or a stack’s bus the song doesn’t have', () => {
    const p = withX();
    const odd = {
      ...p,
      stacks: [
        { id: 'stk_x', name: 'X', bus: 'bus_gone' },
        { id: 'stk_empty', name: 'Empty' },
        { id: 'stk_x', name: 'Twice' },
      ],
      tracks: p.tracks.map((t) => (t.id === 'trk_f' ? { ...t, stack: 'stk_gone' } : t)),
    };
    const read = parseProject(JSON.parse(JSON.stringify(odd)));
    expect(read.stacks).toEqual([{ id: 'stk_x', name: 'X' }]);
    expect(order(read)).toBe('A B:x C:x D:x E F');
  });

  it('is the same song when there’s nothing to mend', () => {
    const p = withX();
    expect(healStacks(p)).toBe(p);
    const plain = song();
    expect(healStacks(plain)).toBe(plain);
  });
});

describe('where a track may go', () => {
  const p = withX();
  const rest = p.tracks.filter((t) => t.id !== 'trk_f');

  it('is where it’s asked, unless that splits a stack: then an edge of it, the nearer for a new track', () => {
    expect(stackBlocks(p.tracks).get('stk_x')).toEqual({ start: 1, end: 4 });
    expect([0, 1, 2, 3, 4, 5, 99, -3].map((i) => settle(rest, i))).toEqual([0, 1, 1, 4, 4, 5, 5, 0]);
    expect([0, 1, 2, 4, 5].map((i) => settle(rest, i, 'stk_x'))).toEqual([1, 1, 2, 4, 4]);
    // (a stack of one track, being moved: anywhere outside the others)
    expect(settle(rest, 2, 'stk_solo')).toBe(1);
    // a track that was in the list goes on past the stack, from whichever side it came
    expect([settle(rest, 2, undefined, 0), settle(rest, 2, undefined, 5), settle(rest, 3, undefined, 0)]).toEqual([
      4, 1, 4,
    ]);
  });
});

describe('a stack and what’s heard', () => {
  it('changes nothing of the song as the engines hear it', () => {
    const plain = song();
    const p = applyOps(plain, [
      { op: 'addStack', stack: { id: 'stk_x', name: 'X', bus: 'bus_sum' }, tracks: ['trk_b', 'trk_c', 'trk_d'] },
    ]);
    const heard = (x: Project) =>
      performed(x).tracks.map((t) => {
        const { stack: _stack, ...rest } = t;
        return rest;
      });
    expect(heard(p)).toEqual(heard(plain));
    expect(performed(p).buses).toEqual(performed(plain).buses);
  });
});

describe('stacks, said', () => {
  it('are in the song’s summary: each stack with its tracks and its bus, each track with its stack', () => {
    const p = applyOps(withX(), [
      { op: 'updateStack', stack: 'stk_x', patch: { name: 'Strings', bus: 'bus_sum' } },
      { op: 'addStack', stack: { id: 'stk_y', name: 'Winds' }, tracks: ['trk_e'] },
    ]);
    const text = describeProject(p);
    expect(text).toContain('Strings [stk_x]: B, C, D; its header controls the bus Sum [bus_sum]');
    expect(text).toContain('Winds [stk_y]: E; a folder (no bus)');
    expect(text).toMatch(/2\. B \[trk_b\].*in the stack "Strings"/);
    expect(describeProject(song())).not.toContain('Stacks');
  });

  it('are in the changes: made, renamed, given a bus, joined, left, taken apart', () => {
    const a = song();
    const b = stacked(a, 'stk_x', ['trk_b', 'trk_c', 'trk_d']);
    expect(describeChanges(a, b)).toEqual(['Stacked B, C and D as "X"']);
    const ops: Op[] = [
      { op: 'updateStack', stack: 'stk_x', patch: { name: 'Strings', bus: 'bus_sum' } },
      { op: 'moveTrack', track: 'trk_e', index: 4, stack: 'stk_x' },
      { op: 'moveTrack', track: 'trk_b', index: 0, stack: null },
    ];
    expect(describeChanges(b, applyOps(b, ops))).toEqual([
      'Track order changed',
      'Stack "X" renamed "Strings"',
      'Stack "Strings": its header controls Sum',
      'E: into the stack "Strings"',
      'B: out of the stack "Strings"',
    ]);
    expect(describeChanges(b, applyOp(b, { op: 'removeStack', stack: 'stk_x' }))).toEqual(['Unstacked "X"']);
  });
});
