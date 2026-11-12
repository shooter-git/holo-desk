import { newProject } from '@holo/session';
import { describe, expect, it } from 'vitest';
import type { Step } from '../src/app/store.ts';
import { ago, historyMenu } from '../src/ui/history-menu.ts';
import type { MenuEntry } from '../src/ui/menu.tsx';

const NOW = 10_000_000;
const step = (label: string, secondsAgo: number): Step => ({
  project: newProject(label),
  label,
  at: NOW - secondsAgo * 1000,
});

/** A row as it reads: its name and hint, a heading in capitals, a line as a dash. */
const read = (items: MenuEntry[]) =>
  items.map((i) => (i === 'sep' ? '—' : 'heading' in i ? i.heading.toUpperCase() : `${i.label} · ${i.hint}`));
const focused = (items: MenuEntry[]) => items.filter((i) => typeof i === 'object' && 'focus' in i && i.focus);

describe('the history menu', () => {
  // three changes kept, the last two undone (Redo takes Tempo back next, then Add Note)
  const undone = [step('Add Note', 20), step('Tempo', 90)];
  const kept = [step('New Track', 3 * 3600), step('Move Notes', 300), step('Quantize', 120)];
  const h = { undo: kept, redo: undone };

  it('lists what Redo brings back on top, then what Undo takes back, newest first', () => {
    expect(read(historyMenu(h, 'undo', () => {}, NOW))).toEqual([
      'REDO',
      'Add Note · 20 s ago',
      'Tempo · 1 min ago',
      '—',
      'UNDO',
      'Quantize · 2 min ago',
      'Move Notes · 5 min ago',
      'New Track · 3 h ago',
    ]);
  });

  it('starts the keyboard on the step the button that opened it would take', () => {
    expect(focused(historyMenu(h, 'undo', () => {}, NOW))).toMatchObject([{ label: 'Quantize' }]);
    expect(focused(historyMenu(h, 'redo', () => {}, NOW))).toMatchObject([{ label: 'Tempo' }]);
  });

  it('picks the step itself, so the song goes to it however the history moved since', () => {
    const picked: Step[] = [];
    const items = historyMenu(h, 'undo', (s) => picked.push(s), NOW);
    const row = items.find((i) => typeof i === 'object' && 'label' in i && i.label === 'Move Notes');
    if (row && typeof row === 'object' && 'onSelect' in row) row.onSelect();
    expect(picked).toEqual([kept[1]]);
  });

  it('leaves out an empty side, and its line', () => {
    expect(read(historyMenu({ undo: kept, redo: [] }, 'undo', () => {}, NOW))[0]).toBe('UNDO');
    expect(read(historyMenu({ undo: [], redo: undone }, 'redo', () => {}, NOW))).toEqual([
      'REDO',
      'Add Note · 20 s ago',
      'Tempo · 1 min ago',
    ]);
  });

  it("cuts a long request's name short", () => {
    const long = step(`Agent: ${'a counter-melody for the strings, '.repeat(4)}`, 5);
    const [, row] = historyMenu({ undo: [long], redo: [] }, 'undo', () => {}, NOW);
    expect(row && typeof row === 'object' && 'label' in row && row.label).toMatch(/^Agent: a counter.{20,}…$/);
    expect(row && typeof row === 'object' && 'label' in row && row.label.length).toBeLessThanOrEqual(48);
  });
});

describe('how long ago', () => {
  it('reads in a few words', () => {
    expect(ago(NOW - 3000, NOW)).toBe('just now');
    expect(ago(NOW - 45_000, NOW)).toBe('45 s ago');
    expect(ago(NOW - 61_000, NOW)).toBe('1 min ago');
    expect(ago(NOW - 59 * 60_000, NOW)).toBe('59 min ago');
    expect(ago(NOW - 2 * 3600_000, NOW)).toBe('2 h ago');
    expect(ago(NOW - 50 * 3600_000, NOW)).toBe('2 d ago');
    // a clock that went back a little isn't a negative time
    expect(ago(NOW + 5000, NOW)).toBe('just now');
  });
});
