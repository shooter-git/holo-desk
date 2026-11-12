import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as StoreModule from '../src/app/store.ts';
import type * as ViewModule from '../src/ui/view-options.ts';

let S: typeof StoreModule;
let V: typeof ViewModule;

beforeAll(async () => {
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() {}, removeItem() {} });
  vi.stubGlobal('window', globalThis);
  S = await import('../src/app/store.ts');
  V = await import('../src/ui/view-options.ts');
});

const keys = (groups: ReturnType<typeof V.viewGroups>) => groups.flatMap(([, items]) => items.map(([key]) => key));

describe('View’s options (the eye’s menu and Settings › View)', () => {
  it('offer every part of the studio that can be hidden, once each', () => {
    const all = keys(V.GROUPS);
    expect([...all].sort()).toEqual(Object.keys(S.SHOW_DEFAULTS).sort());
    expect(new Set(all).size).toBe(all.length);
  });

  it('leave the control bar’s items out on a phone, which has no such bar, and nothing else', () => {
    expect(V.viewGroups(false)).toBe(V.GROUPS);
    const phone = V.viewGroups(true);
    expect(phone.map(([group]) => group)).toEqual(['Tracks', 'Mixer strips']);
    expect(keys(phone).some((k) => k.startsWith('bar'))).toBe(false);
    expect(keys(phone)).toHaveLength(keys(V.GROUPS).filter((k) => !k.startsWith('bar')).length);
  });

  it('show and hide the panes', () => {
    S.store.set({ library: false, inspector: true, editor: null, noteView: 'roll', automationView: false });
    const on = () => V.PANES.map(([p]) => V.paneOn(S.store.get(), p));
    expect(on()).toEqual([false, true, false, false, false, false]);
    V.togglePane('library');
    V.togglePane('inspector');
    V.togglePane('automation');
    expect(S.store.get()).toMatchObject({ library: true, inspector: false, automationView: true });
    // the Piano Roll, then the Score in its place, then neither
    V.togglePane('editor');
    expect(S.store.get()).toMatchObject({ editor: 'piano', noteView: 'roll' });
    V.togglePane('score');
    expect(S.store.get()).toMatchObject({ editor: 'piano', noteView: 'score' });
    expect(V.paneOn(S.store.get(), 'editor')).toBe(false);
    V.togglePane('score');
    expect(S.store.get().editor).toBeNull();
    // the Mixer takes the editor's place
    V.togglePane('mixer');
    expect(V.paneOn(S.store.get(), 'mixer')).toBe(true);
    V.togglePane('mixer');
    expect(S.store.get().editor).toBeNull();
  });
});
