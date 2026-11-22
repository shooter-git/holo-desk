import { describe, expect, it } from 'vitest';
import { arrowsChooseRows, shownLines } from '../src/app/fields.ts';
import type { Layout } from '../src/app/layout.ts';
import {
  closeForStudio,
  closesForStudio,
  pageCovers,
  paneCovered,
  usesPage,
  windowLeft,
  windowOpened,
} from '../src/app/page-layout.ts';
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

describe('a window opened with the page open', () => {
  const none = { plugin: null, synth: null, stage: null };

  it('is seen opening (or another put in its place), and the page goes under it', () => {
    const eq = { target: 'trk_a', id: 'plg_eq' };
    expect(windowOpened(none, { ...none, plugin: eq })).toBe(true);
    expect(windowOpened(none, { ...none, synth: 'trk_a' })).toBe(true);
    expect(windowOpened(none, { ...none, stage: 'trk_a' })).toBe(true);
    // the same one, still open, or one closing, isn't
    expect(windowOpened({ ...none, plugin: eq }, { ...none, plugin: eq })).toBe(false);
    expect(windowOpened({ ...none, synth: 'trk_a' }, none)).toBe(false);
    // another plugin's in its place is
    expect(windowOpened({ ...none, plugin: eq }, { ...none, plugin: { target: 'trk_a', id: 'plg_comp' } })).toBe(true);
    expect(windowOpened({ ...none, synth: 'trk_a' }, { ...none, synth: 'trk_b' })).toBe(true);
  });

  it('opens beside the sheet where there’s room, else in the middle, over it', () => {
    // no sheet: the middle
    expect(windowLeft(460, 1024, null)).toBe(282);
    // a tablet on its side: 796 px beside the sheet, room for it there
    expect(windowLeft(460, 1194, 796)).toBe(168);
    // an upright one, 428 px beside a 340 px sheet: not enough, so the middle (over the sheet)
    expect(windowLeft(460, 768, 428)).toBe(154);
    // just enough
    expect(windowLeft(460, 900, 476)).toBe(8);
    // a screen narrower than the window: kept a little in from the edge
    expect(windowLeft(460, 400, null)).toBe(8);
  });
});

describe('Up and Down in the page’s field', () => {
  it('counts the lines its words show, wrapped ones too', () => {
    // 16 px words at 1.45, 12 px padding above and below
    expect(shownLines(47.2, 24, 23.2)).toBe(1);
    expect(shownLines(70.4, 24, 23.2)).toBe(2);
    expect(shownLines(163.2, 24, 23.2)).toBe(6);
    expect(shownLines(10, 24, 23.2)).toBe(1);
    expect(shownLines(100, 24, Number.NaN)).toBe(1);
  });

  it('choose the list’s rows only while it shows and the words are on one line; else they move the caret', () => {
    expect(arrowsChooseRows(4, 1)).toBe(true);
    expect(arrowsChooseRows(4, 2)).toBe(false);
    expect(arrowsChooseRows(0, 1)).toBe(false);
  });
});
