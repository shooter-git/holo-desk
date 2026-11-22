/**
 * The page's gestures (ui/TalkPage.tsx). A swipe puts it away: down from its header on a phone held
 * upright, to the right on a sheet (a phone on its side, a tablet). It goes with the finger; let go far
 * enough, or flicked, it goes on and closes, and otherwise it comes back. The rules are the bar's
 * (ui/bar-swipe.ts), toward the page's own side.
 *
 * Holding the header still for a moment, or drawing the page partway, fades it to almost clear for as
 * long as the finger stays, so the studio under it shows (and, on a phone held upright, draws again:
 * the panes under the page rest while it covers them). Faded, it takes no taps, so a look can't press
 * one of its buttons. It's only an opacity change while held: nothing is blurred, and nothing of it
 * costs anything otherwise.
 *
 * A swipe that would scroll, or move a slider, or the caret, is theirs: one that starts in a box that
 * can still scroll that way is left to it, and a finger held still before it moves is a press. A tap
 * is a tap.
 */
import { type RefObject, useEffect } from 'react';
import { closeBar, store } from '../app/store.ts';
import { along, closes, drawnToward, HOLD_MS, judgeToward, MOVE_PX, speedToward, type Toward } from './bar-swipe.ts';

/** How far the page is drawn before the studio shows through it. */
export const PEEK_PX = 24;
/** How long the page takes to come back, or to go on and away (the style's transitions, the same). */
const BACK_MS = 180;
const AWAY_MS = 180;
/** How near words that are selected a finger is taken to be going for the selection's handles. */
const HANDLE_PX = 30;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const vertical = (toward: Toward) => toward === 'up' || toward === 'down';

/** The page faded to see the studio through it, or back: said on it, and to the studio (its panes draw while it's faded). */
function peek(card: HTMLElement, on: boolean): void {
  card.toggleAttribute('data-peek', on);
  if (store.get().barPeek !== on) store.set({ barPeek: on });
}

/** Whether a box can still scroll the way a finger going toward `toward` moves what's in it. */
function canScroll(el: Element, toward: Toward): boolean {
  const s = getComputedStyle(el);
  if (vertical(toward)) {
    if (!/auto|scroll/.test(s.overflowY) || el.scrollHeight <= el.clientHeight + 1) return false;
    // (a finger going down shows what's above: there is some while it isn't at the top)
    return toward === 'down' ? el.scrollTop > 1 : el.scrollHeight - el.clientHeight - el.scrollTop > 1;
  }
  if (!/auto|scroll/.test(s.overflowX) || el.scrollWidth <= el.clientWidth + 1) return false;
  return toward === 'right' ? el.scrollLeft > 1 : el.scrollWidth - el.clientWidth - el.scrollLeft > 1;
}

/**
 * Whether a swipe from (x, y) may take the page: not from a field, a slider or another control of a
 * reply's, not from selected words or their handles, and not where what's under the finger can still
 * scroll that way.
 */
function mayTake(target: EventTarget | null, x: number, y: number, card: HTMLElement, toward: Toward): boolean {
  if (!(target instanceof Element)) return false;
  if (target.closest('input, textarea, select, [contenteditable], [role="slider"]')) return false;
  const selected = document.getSelection();
  if (selected && !selected.isCollapsed && selected.rangeCount) {
    const r = selected.getRangeAt(0).getBoundingClientRect();
    if (x > r.left - HANDLE_PX && x < r.right + HANDLE_PX && y > r.top - HANDLE_PX && y < r.bottom + HANDLE_PX)
      return false;
  }
  for (let el: Element | null = target; el && el !== card; el = el.parentElement)
    if (canScroll(el, toward)) return false;
  return true;
}

/**
 * A swipe toward `toward` that starts on `handle` (the header, or the whole sheet) draws `card` and,
 * let go far enough or flicked, closes the page. The listeners are the handle's own, and the one for
 * moves isn't passive: once a swipe has the page, the browser mustn't scroll or bounce what's under it.
 */
export function useSwipeToClose(
  handle: RefObject<HTMLElement | null>,
  card: RefObject<HTMLElement | null>,
  toward: Toward,
): void {
  useEffect(() => {
    const el = handle.current;
    const page = card.current;
    if (!el || !page) return;
    let from: { x: number; y: number; at: number } | null = null;
    let swiping = false;
    let moves: { x: number; y: number; at: number }[] = [];
    let timer = 0;
    // the click a swipe ends with goes nowhere (a swipe that began on a button doesn't press it)
    let quietUntil = 0;
    const axis = vertical(toward) ? '--swipe-y' : '--swipe-x';

    const place = (state: 'drag' | 'back' | 'away' | null, d = 0) => {
      if (state) page.dataset.swipe = state;
      else delete page.dataset.swipe;
      page.style.setProperty(axis, `${d}px`);
      // (the browser keeps a layer for it only while it moves)
      page.style.willChange = state ? 'transform, opacity' : '';
    };
    const back = () => {
      peek(page, false);
      if (reducedMotion()) {
        place(null);
        return;
      }
      place('back');
      timer = window.setTimeout(() => place(null), BACK_MS);
    };
    // on, out of sight, then it's closed
    const away = () => {
      if (reducedMotion()) {
        place(null);
        closeBar();
        return;
      }
      const r = page.getBoundingClientRect();
      const far = vertical(toward) ? r.height : r.width;
      place('away', drawnToward(toward === 'up' || toward === 'left' ? -far - 8 : far + 8, toward));
      timer = window.setTimeout(() => {
        place(null);
        closeBar();
      }, AWAY_MS);
    };

    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      // a second finger ends a swipe, and the page comes back
      if (swiping) back();
      swiping = false;
      from =
        e.touches.length === 1 && t && mayTake(e.target, t.clientX, t.clientY, page, toward)
          ? { x: t.clientX, y: t.clientY, at: e.timeStamp }
          : null;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!from || !t || e.touches.length !== 1) return;
      const dx = t.clientX - from.x;
      const dy = t.clientY - from.y;
      if (!swiping) {
        const said = judgeToward(dx, dy, e.timeStamp - from.at, toward);
        if (!said) return;
        if (said === 'pass') {
          from = null;
          return;
        }
        swiping = true;
        moves = [{ ...from }];
        window.clearTimeout(timer);
      }
      if (e.cancelable) e.preventDefault();
      moves.push({ x: t.clientX, y: t.clientY, at: e.timeStamp });
      if (moves.length > 16) moves.shift();
      const d = drawnToward(vertical(toward) ? dy : dx, toward);
      place('drag', d);
      // drawn partway, the studio shows through it
      peek(page, Math.abs(d) >= PEEK_PX);
    };
    const end = (e: TouchEvent) => {
      const was = from;
      from = null;
      if (!was || !swiping) return;
      swiping = false;
      quietUntil = performance.now() + 300;
      const last = moves[moves.length - 1];
      const gone = last ? along(last.x - was.x, last.y - was.y, toward) : 0;
      // (a touch the browser took back is let go of where it was)
      if (e.type === 'touchend' && closes(gone, speedToward(moves, e.timeStamp, toward))) away();
      else back();
    };
    const click = (e: MouseEvent) => {
      if (performance.now() >= quietUntil) return;
      e.preventDefault();
      e.stopPropagation();
    };

    el.addEventListener('touchstart', start, { passive: true });
    el.addEventListener('touchmove', move, { passive: false });
    el.addEventListener('touchend', end, { passive: true });
    el.addEventListener('touchcancel', end, { passive: true });
    el.addEventListener('click', click, true);
    return () => {
      window.clearTimeout(timer);
      el.removeEventListener('touchstart', start);
      el.removeEventListener('touchmove', move);
      el.removeEventListener('touchend', end);
      el.removeEventListener('touchcancel', end);
      el.removeEventListener('click', click, true);
      place(null);
      // (gone mid-swipe, drawn partway: the studio isn't left seeing through a page that isn't there)
      peek(page, false);
    };
  }, [handle, card, toward]);
}

/**
 * Holding the header still (a finger, a pen or the mouse) fades the page to see the studio through it,
 * until it's let go. A press that moves first is a swipe's, and one on the header's button is the
 * button's.
 */
export function useHoldToSeeThrough(header: RefObject<HTMLElement | null>, card: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = header.current;
    const page = card.current;
    if (!el || !page) return;
    let timer = 0;
    let held: { id: number; x: number; y: number } | null = null;
    let fading = false;

    const stop = () => {
      window.clearTimeout(timer);
      held = null;
      if (fading) peek(page, false);
      fading = false;
      if (!page.dataset.swipe) page.style.willChange = '';
      window.removeEventListener('pointermove', move, true);
      window.removeEventListener('pointerup', stop, true);
      window.removeEventListener('pointercancel', stop, true);
      window.removeEventListener('touchend', stop, true);
      window.removeEventListener('touchcancel', stop, true);
    };
    function move(e: PointerEvent) {
      if (!held || e.pointerId !== held.id || fading) return;
      if (Math.hypot(e.clientX - held.x, e.clientY - held.y) >= MOVE_PX) stop();
    }
    const down = (e: PointerEvent) => {
      if (!e.isPrimary || e.button > 0 || (e.target as Element | null)?.closest?.('button, a, input')) return;
      stop();
      held = { id: e.pointerId, x: e.clientX, y: e.clientY };
      page.style.willChange = 'opacity';
      // (the page takes no taps while it's faded: the end of the press is heard wherever it lands)
      window.addEventListener('pointermove', move, true);
      window.addEventListener('pointerup', stop, true);
      window.addEventListener('pointercancel', stop, true);
      window.addEventListener('touchend', stop, true);
      window.addEventListener('touchcancel', stop, true);
      timer = window.setTimeout(() => {
        fading = true;
        peek(page, true);
      }, HOLD_MS);
    };

    el.addEventListener('pointerdown', down);
    return () => {
      el.removeEventListener('pointerdown', down);
      stop();
    };
  }, [header, card]);
}
