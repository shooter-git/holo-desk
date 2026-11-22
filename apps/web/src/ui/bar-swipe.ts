/**
 * The bar hangs from the top of the screen, so on a touch screen a swipe up puts it away, as a swipe
 * down on a phone's top bar brings it. The card goes up with the finger; let go far enough up, or
 * flicked, it goes on up and the bar closes, and otherwise it drops back into place.
 *
 * A swipe that would scroll is the scroll's: one that starts on a reply (or the list) that can still
 * go on is left to it, and only once that's at its end does a swipe up take the card. A finger held
 * still before it moves is the caret's, a selection's or a menu's, a sideways drag or a swipe down is
 * the browser's, and a slider is its own. A tap is a tap.
 *
 * On a phone the bar also keeps to what shows of the page (above the keyboard, when it's up), and
 * held upright it stops short of the foot of it, so there's always some studio under it to tap.
 */
import { type RefObject, useEffect, useLayoutEffect } from 'react';
import { closeBar } from '../app/store.ts';

/** How far a finger goes before it's a swipe or a scroll (less is a tap): judged before the browser scrolls. */
export const MOVE_PX = 6;
/** A finger held still this long before it moves is a press (the caret, a selection, a menu), not a swipe. */
export const HOLD_MS = 300;
/** How far up the card is drawn for it to close when it's let go; or, flicked, how far and how fast (px a ms). */
export const CLOSE_PX = 72;
export const FLICK_PX = 16;
export const FLICK_SPEED = 0.4;
/** How long the card takes to drop back, or to go on up and away (the style's transitions, the same). */
const BACK_MS = 180;
const AWAY_MS = 180;

/** Whether a box that scrolls shows the end of what it holds (within a pixel). */
export function atEnd(s: { scrollTop: number; clientHeight: number; scrollHeight: number }): boolean {
  return s.scrollHeight - s.clientHeight - s.scrollTop <= 1;
}

/**
 * What a finger that has gone (dx, dy) since it went down, `ms` ago, is doing: nothing yet (null, a
 * tap so far), drawing the card up ('swipe'), or something that's the browser's ('pass': a scroll, a
 * sideways drag, a swipe down, or a press held first).
 */
export function judge(dx: number, dy: number, ms: number): 'swipe' | 'pass' | null {
  if (Math.hypot(dx, dy) < MOVE_PX) return null;
  return ms <= HOLD_MS && -dy > Math.abs(dx) ? 'swipe' : 'pass';
}

/** Where the card is, drawn by a finger now `dy` below where it went down: up with it, never down. */
export const drawn = (dy: number): number => Math.min(0, dy);

/**
 * How fast a finger was going up as it let go (px a ms), from where it was in the last `window` ms:
 * none if it rested before it let go.
 */
export function speedUp(moves: { y: number; at: number }[], now: number, window = 100): number {
  const last = moves[moves.length - 1];
  if (!last || now - last.at > window) return 0;
  const first = moves.find((m) => last.at - m.at <= window) ?? last;
  return last.at > first.at ? (first.y - last.y) / (last.at - first.at) : 0;
}

/** Whether a finger let go `up` px above where it went down, going up at `speed`, closes the bar. */
export const closes = (up: number, speed: number): boolean =>
  up >= CLOSE_PX || (up >= FLICK_PX && speed >= FLICK_SPEED);

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/** How near words that are selected a finger is taken to be going for the selection's handles. */
const HANDLE_PX = 30;

/**
 * Whether a swipe up from (x, y) may take the card: not from a control of the reply's (a slider), not
 * from selected words or their handles, and not where what's under the finger can still scroll on.
 */
function mayTake(target: EventTarget | null, x: number, y: number, card: HTMLElement): boolean {
  if (!(target instanceof Element)) return false;
  const control = target.closest('input, textarea, select, [contenteditable]');
  if (control && !control.closest('.field')) return false;
  if (control instanceof HTMLInputElement && control.selectionStart !== control.selectionEnd) return false;
  const selected = document.getSelection();
  if (selected && !selected.isCollapsed && selected.rangeCount) {
    const r = selected.getRangeAt(0).getBoundingClientRect();
    if (x > r.left - HANDLE_PX && x < r.right + HANDLE_PX && y > r.top - HANDLE_PX && y < r.bottom + HANDLE_PX)
      return false;
  }
  for (let el: Element | null = target; el && el !== card; el = el.parentElement) {
    if (el.scrollHeight > el.clientHeight + 1 && /auto|scroll/.test(getComputedStyle(el).overflowY) && !atEnd(el))
      return false;
  }
  return true;
}

/**
 * A swipe up on the card closes the bar. The listeners are the card's own (a finger that starts outside
 * it is the scrim's), and the one for moves isn't passive: once a swipe has the card, the browser
 * mustn't scroll or bounce what's under the finger too.
 */
export function useSwipeUpToClose(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    let from: { x: number; y: number; at: number } | null = null;
    let swiping = false;
    let moves: { y: number; at: number }[] = [];
    let timer = 0;
    // the click a swipe ends with goes nowhere (a swipe that began on a button doesn't press it)
    let quietUntil = 0;

    const place = (state: 'drag' | 'back' | 'away' | null, y = 0) => {
      if (state) card.dataset.swipe = state;
      else delete card.dataset.swipe;
      card.style.setProperty('--swipe', `${y}px`);
    };
    // (with less motion asked for, it's back, or closed, at once)
    const back = () => {
      if (reducedMotion()) {
        place(null);
        return;
      }
      place('back');
      timer = window.setTimeout(() => place(null), BACK_MS);
    };
    // on up, out of sight, then it's closed
    const away = () => {
      if (reducedMotion()) {
        closeBar();
        return;
      }
      const y = Number.parseFloat(card.style.getPropertyValue('--swipe')) || 0;
      place('away', y - card.getBoundingClientRect().bottom - 8);
      timer = window.setTimeout(closeBar, AWAY_MS);
    };

    const start = (e: TouchEvent) => {
      const t = e.touches[0];
      // a second finger ends a swipe, and the card drops back
      if (swiping) back();
      swiping = false;
      from =
        e.touches.length === 1 && t && mayTake(e.target, t.clientX, t.clientY, card)
          ? { x: t.clientX, y: t.clientY, at: e.timeStamp }
          : null;
    };
    const move = (e: TouchEvent) => {
      const t = e.touches[0];
      if (!from || !t || e.touches.length !== 1) return;
      const dy = t.clientY - from.y;
      if (!swiping) {
        const said = judge(t.clientX - from.x, dy, e.timeStamp - from.at);
        if (!said) return;
        if (said === 'pass') {
          from = null;
          return;
        }
        swiping = true;
        moves = [{ y: from.y, at: from.at }];
        window.clearTimeout(timer);
      }
      if (e.cancelable) e.preventDefault();
      moves.push({ y: t.clientY, at: e.timeStamp });
      if (moves.length > 16) moves.shift();
      place('drag', drawn(dy));
    };
    const end = (e: TouchEvent) => {
      const was = from;
      from = null;
      if (!was || !swiping) return;
      swiping = false;
      quietUntil = performance.now() + 300;
      const last = moves[moves.length - 1];
      const up = last ? was.y - last.y : 0;
      // (a touch the browser took back is let go of where it was)
      if (e.type === 'touchend' && closes(up, speedUp(moves, e.timeStamp))) away();
      else back();
    };
    const click = (e: MouseEvent) => {
      if (performance.now() >= quietUntil) return;
      e.preventDefault();
      e.stopPropagation();
    };

    card.addEventListener('touchstart', start, { passive: true });
    card.addEventListener('touchmove', move, { passive: false });
    card.addEventListener('touchend', end, { passive: true });
    card.addEventListener('touchcancel', end, { passive: true });
    card.addEventListener('click', click, true);
    return () => {
      window.clearTimeout(timer);
      card.removeEventListener('touchstart', start);
      card.removeEventListener('touchmove', move);
      card.removeEventListener('touchend', end);
      card.removeEventListener('touchcancel', end);
      card.removeEventListener('click', click, true);
    };
  }, [ref]);
}

/**
 * What of the page shows, as --shown-top and --shown-height on the scrim: on a phone, whose keyboard
 * may cover the page rather than make it shorter, the bar keeps within it. data-covered says the foot
 * of the screen is hidden (by the keyboard), and with it the room kept for the home bar.
 */
export function useShownRoom(ref: RefObject<HTMLElement | null>): void {
  useLayoutEffect(() => {
    const el = ref.current;
    const view = window.visualViewport;
    if (!el || !view) return;
    const fit = () => {
      el.style.setProperty('--shown-top', `${view.offsetTop}px`);
      el.style.setProperty('--shown-height', `${view.height}px`);
      el.toggleAttribute('data-covered', window.innerHeight - view.offsetTop - view.height > 1);
    };
    fit();
    view.addEventListener('resize', fit);
    view.addEventListener('scroll', fit);
    return () => {
      view.removeEventListener('resize', fit);
      view.removeEventListener('scroll', fit);
    };
  }, [ref]);
}
