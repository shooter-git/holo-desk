/** What a key or a click lands on: whether it's somewhere words are typed, and who Space belongs to. */

/** Inputs whose words are typed: the rest (sliders, checkboxes, colors) take no text. */
const TYPED = new Set(['', 'text', 'search', 'url', 'email', 'password', 'number', 'tel']);

/** Whether the element takes typed words: a text field, a text box, or something editable. */
export function typesWords(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el?.tagName) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  return el.tagName === 'INPUT' && TYPED.has(((el as HTMLInputElement).type ?? '').toLowerCase());
}

/**
 * Whether Space plays and stops the song: from anywhere but where words are typed, a menu, or a dialog
 * over the studio. A button just clicked (Mute, Solo), a checkbox, a list, a slider or a floating window
 * (a plugin's, the synth's) doesn't keep it; a button reached with Tab is pressed with Enter.
 */
export function spaceIsTransport(
  e: { code: string; ctrlKey: boolean; metaKey: boolean; altKey: boolean; target: EventTarget | null },
  dialogOpen: boolean,
): boolean {
  if (e.code !== 'Space' || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (dialogOpen || typesWords(e.target)) return false;
  const el = e.target as HTMLElement | null;
  return !el?.closest?.('[role="menu"], .view-menu, [aria-modal="true"]');
}

/**
 * How many lines the words in a box take as it shows them, wrapped ones counted: from how tall they
 * are (its scrollHeight), its padding top and bottom, and its line height. Never less than one.
 */
export function shownLines(scrollHeight: number, padding: number, lineHeight: number): number {
  if (!(lineHeight > 0)) return 1;
  return Math.max(1, Math.round((scrollHeight - padding) / lineHeight));
}

/**
 * Whether Up and Down in the page's field choose a row of the list over it: only while the list shows
 * and the words are on one line. In more than one, they move the caret, as in any box of words.
 */
export const arrowsChooseRows = (rows: number, lines: number): boolean => rows > 0 && lines <= 1;
