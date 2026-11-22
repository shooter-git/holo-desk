import { describe, expect, it } from 'vitest';
import type { Layout } from '../src/app/layout.ts';
import { closeForStudio, closesForStudio, pageCovers, paneCovered, usesPage } from '../src/app/page-layout.ts';
import { closeBar, openBar, store } from '../src/app/store.ts';

const ALL: Layout[] = ['desktop', 'tablet', 'phone-portrait', 'phone-landscape'];

describe('where the commands and the conversation go', () => {
  it('the bar on a desktop, the page everywhere else', () => {
    expect(ALL.filter(usesPage)).toEqual(['tablet', 'phone-portrait', 'phone-landscape']);
  });

  it('covers the studio only on a phone held upright: a sheet is beside it', () => {
    expect(ALL.filter(pageCovers)).toEqual(['phone-portrait']);
  });

  it('rests the panes under it only while it covers them, and not while it’s held to see through', () => {
    expect(paneCovered('phone-portrait', true, false)).toBe(true);
    expect(paneCovered('phone-portrait', true, true)).toBe(false);
    expect(paneCovered('phone-portrait', false, false)).toBe(false);
    for (const layout of ['desktop', 'tablet', 'phone-landscape'] as const)
      expect(paneCovered(layout, true, false)).toBe(false);
  });

  it('closes for a reply’s go or command where it hides what that does: the bar, and the page held upright', () => {
    expect(ALL.filter(closesForStudio)).toEqual(['desktop', 'phone-portrait']);
    openBar();
    closeForStudio('tablet');
    expect(store.get().bar).toBe(true);
    closeForStudio('phone-landscape');
    expect(store.get().bar).toBe(true);
    closeForStudio('phone-portrait');
    expect(store.get().bar).toBe(false);
    openBar();
    closeForStudio('desktop');
    expect(store.get().bar).toBe(false);
  });
});

describe('opening it', () => {
  it('at a turn: shown open, and let go with the hold to see through as it closes', () => {
    openBar('agj_000000000001');
    expect(store.get()).toMatchObject({ bar: true, barTurn: 'agj_000000000001' });
    // open already, another turn is gone to
    openBar('agj_000000000002');
    expect(store.get().barTurn).toBe('agj_000000000002');
    store.set({ barPeek: true });
    closeBar();
    expect(store.get()).toMatchObject({ bar: false, barTurn: null, barPeek: false });
    openBar();
    expect(store.get()).toMatchObject({ bar: true, barTurn: null });
    closeBar();
  });
});
