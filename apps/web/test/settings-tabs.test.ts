import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as StoreModule from '../src/app/store.ts';
import { SETTINGS_TABS, tabForKey } from '../src/ui/settings-tabs.ts';

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
const storage = new Storage();

beforeAll(async () => {
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', globalThis);
  S = await import('../src/app/store.ts');
});

afterEach(() => {
  vi.useRealTimers();
  S.store.set({ dialog: null });
});

describe('Settings’ tabs', () => {
  it('are General, Audio, MIDI, Metronome, View and Agent, in that order', () => {
    expect(SETTINGS_TABS.map(([, label]) => label)).toEqual(['General', 'Audio', 'MIDI', 'Metronome', 'View', 'Agent']);
  });

  it('move with the arrows (round the ends), Home and End; other keys leave them', () => {
    expect(tabForKey('general', 'ArrowRight')).toBe('audio');
    expect(tabForKey('audio', 'ArrowLeft')).toBe('general');
    expect(tabForKey('agent', 'ArrowRight')).toBe('general');
    expect(tabForKey('general', 'ArrowLeft')).toBe('agent');
    expect(tabForKey('midi', 'Home')).toBe('general');
    expect(tabForKey('midi', 'End')).toBe('agent');
    for (const key of ['ArrowUp', 'ArrowDown', 'Enter', ' ', 'Tab', 'a']) expect(tabForKey('midi', key)).toBeNull();
  });
});

describe('opening Settings', () => {
  it('starts on General', () => {
    expect(S.store.get().settingsTab).toBe('general');
    S.openSettings();
    expect(S.store.get()).toMatchObject({ dialog: 'settings', settingsTab: 'general' });
  });

  it('lands on the tab a caller names (the DSP meter on Audio, the metronome’s link, MIDI, the agent)', () => {
    for (const tab of ['audio', 'metronome', 'midi', 'agent'] as const) {
      S.store.set({ dialog: null });
      S.openSettings(tab);
      expect(S.store.get()).toMatchObject({ dialog: 'settings', settingsTab: tab });
    }
  });

  it('without a tab named, opens on the last one shown', () => {
    S.openSettings('audio');
    // a tab chosen in the dialog
    S.store.set({ settingsTab: 'view' });
    S.store.set({ dialog: null });
    S.openSettings();
    expect(S.store.get()).toMatchObject({ dialog: 'settings', settingsTab: 'view' });
  });

  it('remembers the tab for this session only, never in what a reload reads back', () => {
    vi.useFakeTimers();
    S.store.set({ settingsTab: 'midi', metronome: true });
    vi.advanceTimersByTime(1000);
    const saved = JSON.parse(storage.getItem('holo:view') ?? '{}') as Record<string, unknown>;
    expect(saved.metronome).toBe(true);
    expect(saved).not.toHaveProperty('settingsTab');
  });
});
