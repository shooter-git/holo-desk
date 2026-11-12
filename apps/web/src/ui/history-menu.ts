/**
 * The history menu that a right-click or a long press on Undo or Redo opens: every change the song
 * can go back or forward to, newest first, with how long ago it was made.
 */
import type { History } from '../app/history.ts';
import type { Step } from '../app/store.ts';
import type { MenuEntry } from './menu.tsx';

/** How much of a step's name the menu shows (an agent's request can run long). */
const NAME_MAX = 48;

/** How long ago a change was made, in a few words. */
export function ago(at: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - at) / 1000));
  if (s < 10) return 'just now';
  if (s < 60) return `${s} s ago`;
  const min = Math.floor(s / 60);
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  return h < 24 ? `${h} h ago` : `${Math.floor(h / 24)} d ago`;
}

const shortName = (label: string) => (label.length > NAME_MAX ? `${label.slice(0, NAME_MAX - 1).trimEnd()}…` : label);

/**
 * The history as a menu, newest first: what Redo would bring back on top (the next one nearest the
 * line), then what Undo would take back. `pick` goes to a step: redoing everything up to it, or
 * undoing it and everything after. The keyboard starts on the step the button that opened the menu
 * would take, so Enter does what a click on that button would.
 */
export function historyMenu(
  h: History,
  from: 'undo' | 'redo',
  pick: (step: Step) => void,
  now = Date.now(),
): MenuEntry[] {
  const row = (step: Step, next: boolean): MenuEntry => ({
    label: shortName(step.label),
    hint: ago(step.at, now),
    onSelect: () => pick(step),
    ...(next ? { focus: true } : {}),
  });
  const items: MenuEntry[] = [];
  if (h.redo.length) {
    items.push({ heading: 'Redo' });
    // (the stack's last step is the one Redo takes next)
    h.redo.forEach((step, i) => {
      items.push(row(step, from === 'redo' && i === h.redo.length - 1));
    });
  }
  if (h.undo.length) {
    if (items.length) items.push('sep');
    items.push({ heading: 'Undo' });
    [...h.undo].reverse().forEach((step, i) => {
      items.push(row(step, from === 'undo' && i === 0));
    });
  }
  return items;
}
