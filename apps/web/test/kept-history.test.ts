import { serialize } from 'node:v8';
import { applyOps, newProject, newRegion, newTrack, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { type History, push, pushOrMergeJob, travel } from '../src/app/history.ts';
import {
  KEEP_SONGS,
  type Keepable,
  Keeper,
  type Kept,
  overflow,
  restorable,
  type Shelf,
  stepJobs,
  toKeep,
} from '../src/app/kept-history.ts';

/** The browser's database in miniature: what goes in is cloned as one value, as the database clones it. */
class MemoryShelf implements Shelf {
  items = new Map<string, Kept>();
  puts = 0;
  fail = false;
  async get(project: string) {
    if (this.fail) throw new Error('refused');
    const k = this.items.get(project);
    return k && structuredClone(k);
  }
  async put(kept: Kept) {
    if (this.fail) throw new Error('refused');
    this.puts++;
    this.items.set(kept.project, structuredClone(kept));
  }
  async delete(project: string) {
    this.items.delete(project);
  }
  async list() {
    return [...this.items.values()].map(({ project, kept }) => ({ project, kept }));
  }
}

const titled = (p: Project, title: string): Project => applyOps(p, [{ op: 'setProject', patch: { title } }]);

/** A song edited a few times, and saved as revision `revision`. */
function edited(revision = 3): { state: Keepable; songs: Project[] } {
  const first = { ...newProject('Song'), revision };
  let h: History = { undo: [], redo: [] };
  let song = first;
  const songs = [first];
  for (const [i, t] of ['One', 'Two', 'Three'].entries()) {
    h = push(h, { project: song, label: `Title ${t}`, at: 1000 + i });
    song = titled(song, t);
    songs.push(song);
  }
  return { state: { project: song, serverRevision: revision, saveState: 'saved', ...h }, songs };
}

describe('which history is kept', () => {
  it('a saved song’s, with the revision it leads up to', () => {
    const { state } = edited(7);
    expect(toKeep(state, 'abc', 42)).toEqual({
      project: state.project?.id,
      revision: 7,
      undo: state.undo,
      redo: [],
      kept: 42,
      made: 'abc',
    });
  });

  it('none while the song isn’t saved as it is, or has no history', () => {
    const { state } = edited();
    for (const saveState of ['dirty', 'saving', 'offline', 'conflict', 'error'] as const)
      expect(toKeep({ ...state, saveState }, '')).toBeNull();
    expect(toKeep({ ...state, undo: [], redo: [] }, '')).toBeNull();
    expect(toKeep({ ...state, project: null }, '')).toBeNull();
  });

  it('comes back only for the same song at the same revision, made by the same code', () => {
    const { state } = edited(5);
    const kept = toKeep(state, 'abc') as Kept;
    const song = state.project as Project;
    expect(restorable(kept, song, 'abc')).toEqual({ undo: kept.undo, redo: kept.redo });
    // saved since somewhere else: its steps no longer line up
    expect(restorable(kept, { ...song, revision: 6 }, 'abc')).toBeNull();
    expect(restorable(kept, { ...song, id: 'prj_other' }, 'abc')).toBeNull();
    expect(restorable(undefined, song, 'abc')).toBeNull();
    // HO[LO] updated with other code for songs: its steps hold songs as the code before wrote them
    expect(restorable(kept, song, 'def')).toBeNull();
  });

  it('the songs kept longest ago go past the limit', () => {
    const list = Array.from({ length: KEEP_SONGS + 3 }, (_, i) => ({ project: `prj_${i}`, kept: i }));
    expect(overflow(list)).toEqual(['prj_2', 'prj_1', 'prj_0']);
    expect(overflow(list.slice(0, 4))).toEqual([]);
  });

  it('the steps’ jobs, each once', () => {
    const song = newProject('Song');
    let h: History = { undo: [], redo: [] };
    h = pushOrMergeJob(h, song, 'Agent: A', 'agj_1', true, 1);
    h = push(h, { project: song, label: 'Mine', at: 2 });
    h = pushOrMergeJob(h, song, 'Agent: B', 'agj_2', true, 3);
    h = pushOrMergeJob(h, song, 'Agent: B', 'agj_1', false, 4);
    expect(stepJobs(h).sort()).toEqual(['agj_1', 'agj_2']);
  });
});

describe('the keeper', () => {
  it('keeps the history, and a reload brings it back to undo and redo as before', async () => {
    const shelf = new MemoryShelf();
    const keeper = new Keeper(shelf, { delay: 0 });
    const { state, songs } = edited();
    keeper.changed(state);
    await keeper.flush();
    const song = state.project as Project;

    // the page reloads: a new keeper, the song as the host has it
    const back = (await new Keeper(shelf, { delay: 0 }).restore(structuredClone(song))) as History;
    expect(back.undo.map((s) => s.label)).toEqual(['Title One', 'Title Two', 'Title Three']);
    expect(back.undo.map((s) => s.at)).toEqual([1000, 1001, 1002]);
    const undone = travel(back, song, -3);
    expect(undone?.project).toEqual(songs[0]);
    const redone = travel(undone?.history as History, undone?.project as Project, 2);
    expect(redone?.project.title).toBe('Two');
  });

  it('keeps the same history once', async () => {
    const shelf = new MemoryShelf();
    const keeper = new Keeper(shelf, { delay: 0 });
    const { state } = edited();
    keeper.changed(state);
    keeper.changed({ ...state });
    await keeper.flush();
    keeper.changed(state);
    await keeper.flush();
    expect(shelf.puts).toBe(1);
    // a step renamed (the agent's job ended): kept again
    keeper.changed({ ...state, undo: state.undo.map((s) => ({ ...s, label: 'Renamed' })) });
    await keeper.flush();
    expect(shelf.puts).toBe(2);
  });

  it('nothing while the song has changes not yet saved', async () => {
    const shelf = new MemoryShelf();
    const keeper = new Keeper(shelf, { delay: 0 });
    keeper.changed({ ...edited().state, saveState: 'dirty' });
    await keeper.flush();
    expect(shelf.puts).toBe(0);
  });

  it('what it brought back isn’t kept again', async () => {
    const shelf = new MemoryShelf();
    const { state } = edited();
    await (async () => {
      const k = new Keeper(shelf, { delay: 0 });
      k.changed(state);
      await k.flush();
    })();
    const keeper = new Keeper(shelf, { delay: 0 });
    const song = state.project as Project;
    const back = (await keeper.restore(song)) as History;
    keeper.changed({ ...state, undo: back.undo, redo: back.redo });
    await keeper.flush();
    expect(shelf.puts).toBe(1);
  });

  it('a song’s history on its way in is kept before the song opens again', async () => {
    const shelf = new MemoryShelf();
    const keeper = new Keeper(shelf, { delay: 60_000 });
    const { state } = edited();
    keeper.changed(state);
    // (not flushed: the song is opened again at once, as a reload of the same song would)
    expect((await keeper.restore(state.project as Project))?.undo).toHaveLength(3);
  });

  it('keeps a limited number of songs, letting the oldest go', async () => {
    const shelf = new MemoryShelf();
    const keeper = new Keeper(shelf, { delay: 0 });
    const { state } = edited();
    for (let i = 0; i < KEEP_SONGS + 2; i++) {
      keeper.changed({ ...state, project: { ...(state.project as Project), id: `prj_${i}` } });
      await keeper.flush();
    }
    expect(shelf.items.size).toBe(KEEP_SONGS);
    expect(shelf.items.has('prj_0')).toBe(false);
    expect(shelf.items.has(`prj_${KEEP_SONGS + 1}`)).toBe(true);
  });

  it('a history kept by other code for songs doesn’t come back', async () => {
    const shelf = new MemoryShelf();
    const { state } = edited();
    const before = new Keeper(shelf, { made: 'abc', delay: 0 });
    before.changed(state);
    await before.flush();
    const song = state.project as Project;
    expect(await new Keeper(shelf, { made: 'def' }).restore(song)).toBeNull();
    expect((await new Keeper(shelf, { made: 'abc' }).restore(song))?.undo).toHaveLength(3);
  });

  it('a database that refuses is no error: nothing comes back', async () => {
    const shelf = new MemoryShelf();
    shelf.fail = true;
    const keeper = new Keeper(shelf, { delay: 0 });
    const { state } = edited();
    keeper.changed(state);
    await expect(keeper.flush()).resolves.toBeUndefined();
    await expect(keeper.restore(state.project as Project)).resolves.toBeNull();
    // and no database at all
    const none = new Keeper(null, { delay: 0 });
    none.changed(state);
    await expect(none.restore(state.project as Project)).resolves.toBeNull();
  });
});

describe('what a long history costs to keep', () => {
  it('about one song and what its steps changed, not a song a step', () => {
    // 16 tracks of 500 notes each, then 300 edits of one track's name
    let song = newProject('Big');
    for (let t = 0; t < 16; t++) {
      const notes = Array.from({ length: 500 }, (_, i) => ({ t: i * 120, d: 96, p: 60 + (i % 12), v: 100 }));
      const track = {
        ...newTrack(`Track ${t}`, { type: 'synth', preset: 'Soft Keys' }),
        regions: [{ ...newRegion(0, 500 * 120), notes }],
      };
      song = applyOps(song, [{ op: 'addTrack', track }]);
    }
    let h: History = { undo: [], redo: [] };
    const track = song.tracks[0]?.id as string;
    for (let i = 0; i < 300; i++) {
      h = push(h, { project: song, label: 'Rename', at: i });
      song = applyOps(song, [{ op: 'updateTrack', track, patch: { name: `Name ${i}` } }]);
    }
    // v8's serializer stores a shared object once, as the browser's database does
    const one = serialize(song).length;
    const all = serialize({ undo: h.undo, redo: h.redo }).length;
    expect(all).toBeLessThan(one * 2);
    // without the sharing it would be 300 songs
    expect(JSON.stringify(h.undo).length).toBeGreaterThan(one * 100);
  });
});
