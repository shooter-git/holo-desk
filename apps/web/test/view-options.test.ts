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

  it('count as hidden only what begins shown: a choice that begins off hides nothing', () => {
    const fresh = { ...S.SHOW_DEFAULTS };
    expect(V.hiddenParts(fresh)).toBe(0);
    // (taken or left, track numbers and Stereo Out pinned are not hidden parts)
    expect(V.hiddenParts({ ...fresh, trackNumbers: true, masterRail: true })).toBe(0);
    expect(V.hiddenParts({ ...fresh, trackIcons: false, mixerMaster: false })).toBe(2);
    // every choice is one or the other: none begins off without being meant to
    const off = (Object.keys(fresh) as (keyof typeof fresh)[]).filter((k) => !fresh[k]);
    expect(off.sort()).toEqual(['masterRail', 'trackNumbers']);
  });

  it('show everything again without undoing what was added', () => {
    const fresh = { ...S.SHOW_DEFAULTS };
    const shown = V.showEverything({ ...fresh, trackIcons: false, stripPan: false, trackNumbers: true });
    expect(V.hiddenParts(shown)).toBe(0);
    expect(shown).toMatchObject({ trackIcons: true, stripPan: true, trackNumbers: true, masterRail: false });
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
