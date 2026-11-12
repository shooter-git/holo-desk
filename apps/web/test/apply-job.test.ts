import { newProject } from '@holo/session';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ActionsModule from '../src/app/actions.ts';
import type * as StoreModule from '../src/app/store.ts';

/** A browser's storage, as far as the studio uses it. */
class Storage {
  items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

let S: typeof StoreModule;
let A: typeof ActionsModule;

beforeAll(async () => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('window', globalThis);
  // what the studio's layout and audio modules look at as they load
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('addEventListener', () => {});
  vi.stubGlobal('removeEventListener', () => {});
  vi.stubGlobal('document', {
    addEventListener() {},
    removeEventListener() {},
    documentElement: { style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } },
    visibilityState: 'visible',
    hidden: false,
  });
  S = await import('../src/app/store.ts');
  A = await import('../src/app/actions.ts');
});

describe('a job’s batches in the studio', () => {
  it('each lands in the song, all in one undo step', async () => {
    const song = newProject('Batches');
    S.store.set({ project: song, undo: [], redo: [] });
    const track = song.tracks[0]?.id as string;
    expect(await A.applyJob([{ op: 'updateTrack', track, patch: { name: 'Lead' } }], 'agj_1', 'b1', 'Lead')).toEqual({
      ok: true,
    });
    // the second batch merges into the job's step: it must land too
    expect(await A.applyJob([{ op: 'setProject', patch: { title: 'Renamed' } }], 'agj_1', 'b2', 'Lead')).toEqual({
      ok: true,
    });
    const s = S.store.get();
    expect(s.project?.title).toBe('Renamed');
    expect(s.project?.tracks.find((t) => t.id === track)?.name).toBe('Lead');
    expect(s.undo).toHaveLength(1);
    expect(s.undo[0]).toMatchObject({ label: 'Agent: Lead', job: 'agj_1' });
    expect(s.undo[0]?.project).toBe(song);
  });
});

describe('the history menu in the studio', () => {
  it('takes the song straight to the step picked, back or forward', () => {
    const song = newProject('Jumps');
    S.store.set({ project: song, undo: [], redo: [], toasts: [] });
    for (const title of ['A', 'B', 'C', 'D']) A.apply([{ op: 'setProject', patch: { title } }], `Title ${title}`);
    // back to before the second change: three Undos in one
    const second = S.store.get().undo[1];
    if (!second) throw new Error('no step');
    A.travelTo(second);
    let s = S.store.get();
    expect(s.project?.title).toBe('A');
    expect(s.undo.map((x) => x.label)).toEqual(['Title A']);
    expect(s.redo.map((x) => x.label)).toEqual(['Title D', 'Title C', 'Title B']);
    expect(s.toasts.at(-1)?.text).toBe('Undo 3 steps');
    // forward through the third: two Redos
    const third = s.redo[1];
    if (!third) throw new Error('no step');
    A.travelTo(third);
    s = S.store.get();
    expect(s.project?.title).toBe('C');
    expect(s.redo.map((x) => x.label)).toEqual(['Title D']);
    expect(s.toasts.at(-1)?.text).toBe('Redo 2 steps');
    // one step reads as Undo always has
    A.undo();
    expect(S.store.get().toasts.at(-1)?.text).toBe('Undo Title C');
  });
});
