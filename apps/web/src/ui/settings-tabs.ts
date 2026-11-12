/** Settings' tabs, in order, and the keys that move between them (as a tab strip's do: the arrows, Home, End). */
import type { SettingsTab } from '../app/store.ts';

export const SETTINGS_TABS: readonly [SettingsTab, string][] = [
  ['general', 'General'],
  ['audio', 'Audio'],
  ['midi', 'MIDI'],
  ['metronome', 'Metronome'],
  ['view', 'View'],
  ['agent', 'Agent'],
];

const IDS = SETTINGS_TABS.map(([id]) => id);

/** The tab a key moves to from `tab` (Left and Right go round the ends), or null for a key that doesn't move. */
export function tabForKey(tab: SettingsTab, key: string): SettingsTab | null {
  const at = Math.max(0, IDS.indexOf(tab));
  const n = IDS.length;
  if (key === 'ArrowRight') return IDS[(at + 1) % n] ?? null;
  if (key === 'ArrowLeft') return IDS[(at + n - 1) % n] ?? null;
  if (key === 'Home') return IDS[0] ?? null;
  if (key === 'End') return IDS[n - 1] ?? null;
  return null;
}
