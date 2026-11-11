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
