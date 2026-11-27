/** The tracks pane's rows where a song has stacks: headers, folds, and what a dragged row does. */
import { applyOp, applyOps, newBus, newProject, newTrack, type Op, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { hiddenTracks, selectionInSight, shownTracks, stepShown } from '../src/app/shown-tracks.ts';
import { stackState } from '../src/app/stack-actions.ts';
import {
  foldsKept,
  foldsOf,
  isStackRowId,
  keepFolds,
  planDrop,
  rowId,
  rowsSong,
  stackRow,
  trackRows,
} from '../src/app/track-rows.ts';

/** A, then B, C and D stacked as "X", then E and F stacked as "Y" (through a bus), then G. */
function song(): Project {
  const p = newProject('Rows');
  p.tracks = ['A', 'B', 'C', 'D', 'E', 'F', 'G'].map((name) => ({
    ...newTrack(name, { type: 'synth', preset: 'Soft Keys' }),
    id: `trk_${name.toLowerCase()}`,
  }));
  p.buses = [{ ...newBus('Sum'), id: 'bus_sum' }];
  return applyOps(p, [
    { op: 'addStack', stack: { id: 'stk_x', name: 'X' }, tracks: ['trk_b', 'trk_c', 'trk_d'] },
    { op: 'addStack', stack: { id: 'stk_y', name: 'Y', bus: 'bus_sum' }, tracks: ['trk_e', 'trk_f'] },
  ]);
}
const open = { inactiveTracks: true };
const names = (p: Project, show = open as { inactiveTracks: boolean; folded?: readonly string[] }) =>
  trackRows(p, show)
    .map((r) => (r.kind === 'stack' ? `[${r.stack.name}${r.open ? '' : '›'}]` : `${r.stack ? '·' : ''}${r.track.name}`))
    .join(' ');
const order = (p: Project) => p.tracks.map((t) => (t.stack ? `${t.name}:${t.stack.slice(4)}` : t.name)).join(' ');
/** The song after the row `id` is dragged to the `index`th place. */
const dropped = (p: Project, id: string, index: number, show = open as Parameters<typeof planDrop>[1]) => {
  const op = planDrop(p, show, id, index);
  return op ? order(applyOp(p, op)) : 'nothing';
};

describe('the rows of a song with stacks', () => {
  it('have a header before each stack’s tracks, which follow it set in', () => {
    expect(names(song())).toBe('A [X] ·B ·C ·D [Y] ·E ·F G');
    expect(trackRows(song(), open).map(rowId).filter(isStackRowId)).toEqual(['stack:stk_x', 'stack:stk_y']);
  });

  it('fold a closed stack’s tracks away under its header', () => {
    expect(names(song(), { inactiveTracks: true, folded: ['stk_x'] })).toBe('A [X›] [Y] ·E ·F G');
    expect(names(song(), { inactiveTracks: true, folded: ['stk_x', 'stk_y', 'stk_gone'] })).toBe('A [X›] [Y›] G');
  });

  it('leave out a stack whose tracks View leaves out, and keep one that has any showing', () => {
    const p = applyOps(song(), [
      { op: 'updateTrack', track: 'trk_e', patch: { inactive: true } },
      { op: 'updateTrack', track: 'trk_f', patch: { inactive: true } },
      { op: 'updateTrack', track: 'trk_c', patch: { inactive: true } },
    ]);
    expect(names(p, { inactiveTracks: false })).toBe('A [X] ·B ·D G');
    expect(names(p, { inactiveTracks: true })).toBe('A [X] ·B ·C ·D [Y] ·E ·F G');
    // (the header still says how many tracks the stack has)
    expect(trackRows(p, { inactiveTracks: false }).find((r) => r.kind === 'stack')).toMatchObject({
      tracks: { length: 3 },
    });
  });

  it('are the song’s own tracks where it has no stacks', () => {
    const plain = applyOps(song(), [
      { op: 'removeStack', stack: 'stk_x' },
      { op: 'removeStack', stack: 'stk_y' },
    ]);
    expect(rowsSong(plain, open)).toBe(plain);
    expect(names(plain)).toBe('A B C D E F G');
  });
});

describe('the song as the pane lays it out', () => {
  it('has a stand-in for each header among its tracks, which says which stack it is', () => {
    const p = song();
    const laid = rowsSong(p, open);
    expect(laid.tracks.map((t) => t.name)).toEqual(['A', 'X', 'B', 'C', 'D', 'Y', 'E', 'F', 'G']);
    const x = laid.tracks[1];
    expect(stackRow(x)).toMatchObject({ kind: 'stack', open: true, stack: { id: 'stk_x' } });
    expect(stackRow(x)?.tracks.map((t) => t.name)).toEqual(['B', 'C', 'D']);
    expect([x?.id, x?.regions, x?.color]).toEqual(['stack:stk_x', [], p.tracks[1]?.color]);
    // a track isn't one
    expect(stackRow(laid.tracks[0])).toBeUndefined();
    expect(stackRow(null)).toBeUndefined();
  });

  it('is the same song until something of it changes, and the same stand-in while its stack does not', () => {
    const p = song();
    const folded = ['stk_x'];
    const a = rowsSong(p, { inactiveTracks: true, folded });
    expect(rowsSong(p, { inactiveTracks: true, folded })).toBe(a);
    expect(a.tracks.map((t) => t.name)).toEqual(['A', 'X', 'Y', 'E', 'F', 'G']);
    // a fader moved on a track outside the stacks: the headers' stand-ins are the ones they were
    const moved = applyOp(p, { op: 'updateChannel', target: 'trk_a', patch: { volume: -3 } });
    const b = rowsSong(moved, { inactiveTracks: true, folded });
    expect(b).not.toBe(a);
    expect(b.tracks[1]).toBe(a.tracks[1]);
    // opened: another stand-in (its row says it's open)
    expect(rowsSong(p, open).tracks[1]).not.toBe(a.tracks[1]);
  });
});

describe('the tracks shown', () => {
  it('leave out those folded away, which View’s count of hidden tracks doesn’t include', () => {
    const p = song();
    const show = { inactiveTracks: true, folded: ['stk_x'] };
    expect(shownTracks(p.tracks, show).map((t) => t.name)).toEqual(['A', 'E', 'F', 'G']);
    expect(shownTracks(p.tracks, show)).toBe(shownTracks(p.tracks, show));
    expect(hiddenTracks(p.tracks, show)).toBe(0);
    expect(shownTracks(p.tracks, open)).toBe(p.tracks);
  });

  it('are stepped through past a closed stack', () => {
    const p = song();
    const show = { inactiveTracks: true, folded: ['stk_x'] };
    expect(stepShown(p.tracks, show, 'trk_a', false)?.name).toBe('E');
    expect(stepShown(p.tracks, show, 'trk_e', true)?.name).toBe('A');
  });

  it('give the selection to the nearest track showing when a stack closes around it', () => {
    const p = song();
    const was = { song: p.id, tracks: p.tracks, show: open };
    const now = { song: p.id, tracks: p.tracks, show: { inactiveTracks: true, folded: ['stk_x'] } };
    expect(selectionInSight(was, now, 'trk_c', [])).toEqual({ selectedTrack: 'trk_e' });
    expect(selectionInSight(was, now, 'trk_a', [])).toBeNull();
  });
});

describe('a row dragged to a new place', () => {
  it('moves a track among the others, as it always did, in a song with no stacks', () => {
    const plain = applyOps(song(), [
      { op: 'removeStack', stack: 'stk_x' },
      { op: 'removeStack', stack: 'stk_y' },
    ]);
    expect(dropped(plain, 'trk_a', 2)).toBe('B C A D E F G');
    expect(dropped(plain, 'trk_g', 0)).toBe('G A B C D E F');
    expect(dropped(plain, 'trk_c', 2)).toBe('nothing');
  });

  it('puts a track into a stack when it lands under its open header or among its tracks', () => {
    // rows: A [X] B C D [Y] E F G
    expect(dropped(song(), 'trk_g', 2)).toBe('A G:x B:x C:x D:x E:y F:y');
    expect(dropped(song(), 'trk_g', 3)).toBe('A B:x G:x C:x D:x E:y F:y');
    expect(dropped(song(), 'trk_a', 1)).toBe('A:x B:x C:x D:x E:y F:y G');
    expect(planDrop(song(), open, 'trk_g', 3)).toEqual({ op: 'moveTrack', track: 'trk_g', index: 2, stack: 'stk_x' });
  });

  it('keeps a stack’s own track in it at its lower edge, and leaves another outside', () => {
    // B to just after D: still in X, at its end
    expect(dropped(song(), 'trk_b', 4)).toBe('A C:x D:x B:x E:y F:y G');
    expect(planDrop(song(), open, 'trk_b', 4)).toEqual({ op: 'moveTrack', track: 'trk_b', index: 3 });
    // A to just after D (before Y's header): not in X
    expect(dropped(song(), 'trk_a', 4)).toBe('B:x C:x D:x A E:y F:y G');
  });

  it('takes a track out of its stack when it lands outside it', () => {
    expect(dropped(song(), 'trk_c', 0)).toBe('C A B:x D:x E:y F:y G');
    expect(dropped(song(), 'trk_d', 8)).toBe('A B:x C:x E:y F:y G D');
    expect(planDrop(song(), open, 'trk_c', 0)).toEqual({ op: 'moveTrack', track: 'trk_c', index: 0, stack: null });
    // from one stack into the other
    expect(dropped(song(), 'trk_c', 6)).toBe('A B:x D:x E:y C:y F:y G');
  });

  it('carries a track past a closed stack, never into it', () => {
    const show = { inactiveTracks: true, folded: ['stk_x'] };
    // rows: A [X›] [Y] E F G
    expect(dropped(song(), 'trk_a', 1, show)).toBe('B:x C:x D:x A E:y F:y G');
    // (just under the closed header: after the whole stack; just over it: before)
    expect(dropped(song(), 'trk_g', 2, show)).toBe('A B:x C:x D:x G E:y F:y');
    expect(dropped(song(), 'trk_g', 1, show)).toBe('A G B:x C:x D:x E:y F:y');
  });

  it('moves a stack whole when its header is dragged, and nothing when it lands among its own tracks', () => {
    // rows: A [X] B C D [Y] E F G; the header of X to the very top, to after Y's tracks, to the end
    expect(dropped(song(), 'stack:stk_x', 0)).toBe('B:x C:x D:x A E:y F:y G');
    expect(dropped(song(), 'stack:stk_x', 7)).toBe('A E:y F:y B:x C:x D:x G');
    expect(dropped(song(), 'stack:stk_x', 8)).toBe('A E:y F:y G B:x C:x D:x');
    expect(dropped(song(), 'stack:stk_x', 3)).toBe('nothing');
    expect(planDrop(song(), open, 'stack:stk_y', 0)).toEqual({ op: 'moveStack', stack: 'stk_y', index: 0 });
    // (dropped inside the other stack: on past it)
    expect(dropped(song(), 'stack:stk_y', 3)).toBe('A E:y F:y B:x C:x D:x G');
  });

  it('goes by the rows shown: a track View leaves out is passed over', () => {
    const p = applyOp(song(), { op: 'updateTrack', track: 'trk_a', patch: { inactive: true } });
    // rows: [X] B C D [Y] E F G
    expect(dropped(p, 'trk_g', 0, { inactiveTracks: false })).toBe('A G B:x C:x D:x E:y F:y');
    expect(planDrop(p, { inactiveTracks: false }, 'trk_zz', 0)).toBeNull();
  });
});

describe('which stacks are closed here', () => {
  function shelf() {
    const kept = new Map<string, string>();
    return { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v) };
  }

  it('is kept by song, and forgotten for a song with none closed', () => {
    const s = shelf();
    expect(foldsOf('prj_a', s)).toEqual([]);
    keepFolds('prj_a', ['stk_x'], s);
    keepFolds('prj_b', ['stk_1', 'stk_2'], s);
    expect([foldsOf('prj_a', s), foldsOf('prj_b', s)]).toEqual([['stk_x'], ['stk_1', 'stk_2']]);
    keepFolds('prj_a', [], s);
    expect(foldsOf('prj_a', s)).toEqual([]);
  });

  it('keeps the last twenty songs’, and reads nothing from what isn’t its own', () => {
    const s = shelf();
    for (let i = 0; i < 25; i++) keepFolds(`prj_${i}`, ['stk'], s);
    expect([foldsOf('prj_24', s), foldsOf('prj_5', s), foldsOf('prj_4', s)]).toEqual([['stk'], ['stk'], []]);
    s.setItem('holo:stack-folds', '{"not":"a list"}');
    expect(foldsOf('prj_24', s)).toEqual([]);
    expect(foldsOf('prj_24', null)).toEqual([]);
  });

  it('drops a stack the song no longer has', () => {
    const p = song();
    const folded = ['stk_x', 'stk_gone'];
    expect(foldsKept(p, folded)).toEqual(['stk_x']);
    const same = ['stk_x'];
    expect(foldsKept(p, same)).toBe(same);
    expect(foldsKept(null, same)).toEqual([]);
  });
});

describe('what a stack’s header shows of its tracks', () => {
  it('is muted, soloed and off when they all are; muted by its bus when it has one', () => {
    const p = song();
    const [x, y] = p.stacks ?? [];
    if (!x || !y) throw new Error('no stacks');
    expect(stackState(p, x)).toEqual({ mute: false, solo: false, inactive: false, count: 3 });
    const ops: Op[] = ['trk_b', 'trk_c', 'trk_d'].map((t) => ({
      op: 'updateChannel',
      target: t,
      patch: { mute: true, solo: true },
    }));
    expect(stackState(applyOps(p, ops), x)).toMatchObject({ mute: true, solo: true });
    expect(stackState(applyOps(p, ops.slice(1)), x)).toMatchObject({ mute: false, solo: false });
    // a summing stack: muted when its bus is, whatever its tracks are
    expect(stackState(applyOp(p, { op: 'updateChannel', target: 'bus_sum', patch: { mute: true } }), y).mute).toBe(
      true,
    );
    expect(stackState(applyOp(p, { op: 'updateChannel', target: 'trk_e', patch: { mute: true } }), y).mute).toBe(false);
    const off = applyOps(
      p,
      ['trk_e', 'trk_f'].map((t): Op => ({ op: 'updateTrack', track: t, patch: { inactive: true } })),
    );
    expect(stackState(off, y)).toMatchObject({ inactive: true, solo: false });
  });
});
