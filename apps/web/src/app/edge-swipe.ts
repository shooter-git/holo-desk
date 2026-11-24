/**
 * An iPhone's or iPad's swipe from the side of the screen goes back (or forward) a page, in Safari and
 * in a Home Screen web app alike: the studio slides away under the finger and loads again. It's the
 * system's gesture, with no setting a page can turn it off by (styles/app.css keeps every other
 * sideways swipe in the studio). What a page can do is take the touch itself: a touch that starts at
 * the very side of the screen is kept from the browser here, so the gesture never begins.
 *
 * Keeping a touch from the browser also keeps it from what the browser would have done with it, so
 * that's done here instead: a tap presses what's under it (and puts the caret in a field), and a drag
 * scrolls the box under it. The studio's own drags (faders, notes, the page's swipe) hear the touch as
 * they always do: they listen to it themselves.
 *
 * Only on an iPhone or iPad, and only while there's a page to go back to: with none the gesture does
 * nothing, and the touch is left alone.
 */
import { isIosLike } from './notify.ts';

/** How near a side of the screen a touch starts for the system to take it for going back or forward. */
export const EDGE_PX = 24;
/** How far a finger goes, and how long it stays, before it's no longer a tap. */
const TAP_PX = 10;
const TAP_MS = 700;

/** Whether a touch at `x` on a screen `width` wide starts at one of its sides. */
export function atEdge(x: number, width: number, edge = EDGE_PX): boolean {
  return x < edge || x > width - edge;
}

/** Whether a touch that went (dx, dy) and lasted `ms` was a tap. */
export function isTap(dx: number, dy: number, ms: number): boolean {
  return Math.hypot(dx, dy) < TAP_PX && ms < TAP_MS;
}

/**
 * The nearest box at or above `from` that scrolls along an axis and has somewhere to scroll to; none
 * when something on the way takes drags itself (touch-action: none: a fader, the notes, a header).
 */
function scroller(from: Element | null, sideways: boolean): HTMLElement | null {
  for (let el = from; el && el !== document.documentElement; el = el.parentElement) {
    if (!(el instanceof HTMLElement)) continue;
    const s = getComputedStyle(el);
    if (s.touchAction === 'none') return null;
    const scrolls = /auto|scroll/.test(sideways ? s.overflowX : s.overflowY);
    const room = sideways ? el.scrollWidth - el.clientWidth : el.scrollHeight - el.clientHeight;
    if (scrolls && room > 1) return el;
  }
  return null;
}

/** A control the browser opens itself (a picker, a slider of its own): its touch is left to it. */
const NATIVE = 'select, input[type="range"], input[type="file"], input[type="date"], input[type="color"]';

/**
 * Keep touches that start at a side of the screen from the browser, wherever its swipe would go back
 * or forward. Returns how to stop.
 */
export function installEdgeGuard(win: Window = window): () => void {
  if (!isIosLike()) return () => undefined;
  const doc = win.document;
  let touch: { id: number; target: Element; x: number; y: number; at: number; moved: boolean } | null = null;
  // a drag's box, which way it scrolls, and where the finger last was
  let box: HTMLElement | null = null;
  let sideways = false;
  let last = { x: 0, y: 0 };

  const start = (e: TouchEvent) => {
    touch = null;
    box = null;
    const t = e.touches[0];
    if (!t || e.touches.length !== 1 || !e.cancelable) return;
    // (nothing to go back or forward to: the gesture does nothing, and the touch is the browser's)
    if (win.history.length <= 1) return;
    if (!atEdge(t.clientX, win.innerWidth)) return;
    const target = e.target instanceof Element ? e.target : null;
    if (!target || target.closest(NATIVE)) return;
    e.preventDefault();
    touch = { id: t.identifier, target, x: t.clientX, y: t.clientY, at: e.timeStamp, moved: false };
    last = { x: t.clientX, y: t.clientY };
  };
  const move = (e: TouchEvent) => {
    if (!touch) return;
    const id = touch.id;
    const t = [...e.changedTouches].find((c) => c.identifier === id);
    if (!t) return;
    if (!touch.moved) {
      const dx = t.clientX - touch.x;
      const dy = t.clientY - touch.y;
      if (Math.hypot(dx, dy) < TAP_PX) return;
      touch.moved = true;
      sideways = Math.abs(dx) > Math.abs(dy);
      box = scroller(touch.target, sideways);
    }
    // the scroll the browser would have made of it (with no glide once the finger lifts)
    if (box) {
      if (sideways) box.scrollLeft -= t.clientX - last.x;
      else box.scrollTop -= t.clientY - last.y;
    }
    last = { x: t.clientX, y: t.clientY };
  };
  const end = (e: TouchEvent) => {
    const was = touch;
    touch = null;
    if (!was || e.type === 'touchcancel') return;
    const t = [...e.changedTouches].find((c) => c.identifier === was.id);
    if (!t || was.moved || !isTap(t.clientX - was.x, t.clientY - was.y, e.timeStamp - was.at)) return;
    // the tap the browser would have made of it: the caret into a field, and a click
    const field = was.target.closest<HTMLElement>('input, textarea, [contenteditable]');
    field?.focus();
    was.target.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true, view: win, clientX: t.clientX, clientY: t.clientY }),
    );
  };

  doc.addEventListener('touchstart', start, { capture: true, passive: false });
  doc.addEventListener('touchmove', move, { capture: true, passive: true });
  doc.addEventListener('touchend', end, { capture: true, passive: true });
  doc.addEventListener('touchcancel', end, { capture: true, passive: true });
  return () => {
    doc.removeEventListener('touchstart', start, { capture: true });
    doc.removeEventListener('touchmove', move, { capture: true });
    doc.removeEventListener('touchend', end, { capture: true });
    doc.removeEventListener('touchcancel', end, { capture: true });
  };
}
