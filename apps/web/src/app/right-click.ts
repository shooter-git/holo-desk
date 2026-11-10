/**
 * Right-click belongs to the studio. A control with a menu of its own opens it (a note, a region, a
 * send, a track); anywhere else the browser's menu stays shut, as it would in a desktop app. Without
 * this, a menu opened as the button went down was met by the browser's own a moment later (the
 * right-click landed on the menu's backdrop, which let it through), and controls without a menu
 * offered Back, Reload and Inspect.
 *
 * The browser's menu still opens where it's the one wanted: in a field being typed in (paste,
 * spelling), on a link (open it in a new tab) and on selected words (copy).
 */

/** Inputs whose words are typed: the rest (sliders, checkboxes, colours) have nothing to paste. */
const TYPED = new Set(['', 'text', 'search', 'url', 'email', 'password', 'number', 'tel']);

/** Whether a right-click on `target` should get the browser's own menu. */
export function browserMenuWanted(target: EventTarget | null, onSelectedWords: boolean): boolean {
  if (onSelectedWords) return true;
  const el = target as HTMLElement | null;
  if (!el?.closest) return false;
  if (el.isContentEditable || el.tagName === 'TEXTAREA') return true;
  if (el.tagName === 'INPUT') return TYPED.has(((el as HTMLInputElement).type ?? '').toLowerCase());
  return !!el.closest('a[href]');
}

/** Keep the browser's menu to the places above, on every page (the studio and the remote alike). */
export function installRightClick(): void {
  // on the window as it bubbles, so it comes after the controls' own handlers (React's sit on the
  // root): one that opened a menu has already said so
  window.addEventListener('contextmenu', (e) => {
    if (e.defaultPrevented) return;
    const sel = window.getSelection();
    const onSelectedWords = !!sel && !sel.isCollapsed && e.target instanceof Node && sel.containsNode(e.target, true);
    if (!browserMenuWanted(e.target, onSelectedWords)) e.preventDefault();
  });
}
