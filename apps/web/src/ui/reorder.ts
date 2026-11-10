/**
 * Dragging a track to a new place, in the track list or the mixer: the item follows the pointer,
 * the others slide aside to show where it will land, and the list scrolls while the drag rests near
 * one of its ends. A mouse drags as soon as it moves; a finger holds still first (a finger that moves
 * straight away scrolls the list).
 */
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect } from 'react';
import { capture, edgeScroll, type Gesture, LONG_PRESS_MS } from './gesture.ts';
import { closeMenu } from './menu.tsx';

export interface ReorderList {
  /** The item that moves. */
  item: HTMLElement;
  /** The items in their order, the moving one among them (read when the drag begins). */
  items: () => HTMLElement[];
  axis: 'x' | 'y';
  /** The box whose ends scroll the list while a drag rests near them. */
  box: HTMLElement;
  /** How far the list has scrolled along the axis, and a way to scroll it. */
  scroll: { get(): number; by(d: number): void };
  /** It was let go at a new index among the items (not called when it lands where it was). */
  onDrop: (index: number) => void;
}

export interface PressOptions {
  /** The item lifted: a drag may follow. */
  onLift?: () => void;
  /** A finger moving before it has held still: scroll the list (left out, the browser scrolls it). */
  onSwipe?: (ev: PointerEvent, g: Gesture) => void;
  /** A finger let go without holding or moving. */
  onTap?: () => void;
  /** A finger held still: the item has lifted, and this can open its menu (dragging on closes it). */
  onHold?: (ev: PointerEvent) => void;
  /** The press is over, however it ended. */
  onEnd?: () => void;
}

interface Point {
  clientX: number;
  clientY: number;
}

interface Drag {
  move(p: Point): void;
  drop(): void;
  cancel(): void;
}

/** How far a finger may wander while it holds, and how far a mouse moves before it drags. */
const FINGER_SLOP = 10;
const MOUSE_SLOP = 4;
/** How long the item takes to slide into its place once it's let go. */
const SETTLE_MS = 120;

/** A drag under way: the browser mustn't scroll the list under the finger holding it. */
let dragging = false;
/** The last drop still sliding into place: a new drag finishes it first. */
let settling: (() => void) | null = null;

const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;

/**
 * Where an item dragged `d` pixels from its place lands, given where the items start and how big
 * they are along the list. It passes a neighbor once its middle crosses the neighbor's near edge
 * (half a place), so held against either end it takes the end place.
 */
export function landing(starts: number[], sizes: number[], from: number, d: number): number {
  const center = (starts[from] ?? 0) + d + (sizes[from] ?? 0) / 2;
  let to = from;
  starts.forEach((start, i) => {
    if (i > from && center > start) to++;
    if (i < from && center < start + (sizes[i] ?? 0)) to--;
  });
  return to;
}

function begin(o: ReorderList, start: Point): Drag {
  settling?.();
  const items = o.items();
  const from = items.indexOf(o.item);
  const along = o.axis === 'y' ? (p: Point) => p.clientY : (p: Point) => p.clientX;
  const scroll0 = o.scroll.get();
  // where each item sits in the list (scrolled or not), measured once
  const rects = items.map((el) => el.getBoundingClientRect());
  const starts = rects.map((r) => (o.axis === 'y' ? r.top : r.left) + scroll0);
  const sizes = rects.map((r) => (o.axis === 'y' ? r.height : r.width));
  const size = sizes[from] ?? 0;
  const lo = (starts[0] ?? 0) - (starts[from] ?? 0);
  const hi = (starts[items.length - 1] ?? 0) + (sizes[items.length - 1] ?? 0) - size - (starts[from] ?? 0);
  const place = (el: HTMLElement, px: number) => {
    el.style.translate = px === 0 ? '' : o.axis === 'y' ? `0 ${px}px` : `${px}px 0`;
  };

  let last = start;
  let to = from;
  let raf = 0;
  dragging = true;
  // marked with an attribute, not a class: a render (the track selected as it lifts) rewrites the class
  o.item.dataset.reorder = 'lift';
  for (const el of items) if (el !== o.item) el.dataset.reorder = 'shift';

  const layout = () => {
    const d = Math.max(lo, Math.min(hi, along(last) - along(start) + o.scroll.get() - scroll0));
    to = landing(starts, sizes, from, d);
    place(o.item, d);
    items.forEach((el, i) => {
      if (i === from) return;
      if (from < to && i > from && i <= to) place(el, -size);
      else if (to < from && i >= to && i < from) place(el, size);
      else place(el, 0);
    });
  };

  // resting near an end scrolls the list that way (only the way the drag has gone, so a press near
  // an end doesn't scroll by itself)
  const tick = () => {
    const edge = edgeScroll(last, o.box.getBoundingClientRect(), 'xy');
    const step = o.axis === 'y' ? edge.dy : edge.dx;
    const went = along(last) - along(start);
    if ((step < 0 && went < 0) || (step > 0 && went > 0)) {
      const before = o.scroll.get();
      o.scroll.by(step);
      if (o.scroll.get() !== before) layout();
    }
    raf = requestAnimationFrame(tick);
  };
  raf = requestAnimationFrame(tick);
  layout();

  const end = (land: boolean) => {
    cancelAnimationFrame(raf);
    dragging = false;
    const index = land ? to : from;
    // it slides into its place (or back to its own), then the list takes its new order
    let offset = 0;
    for (let i = from + 1; i <= index; i++) offset += sizes[i] ?? 0;
    for (let i = index; i < from; i++) offset -= sizes[i] ?? 0;
    if (!land) for (const el of items) if (el !== o.item) place(el, 0);
    o.item.dataset.reorder = 'settle';
    place(o.item, offset);
    const finish = () => {
      settling = null;
      window.clearTimeout(timer);
      // without their transitions, so nothing slides back as the new order is drawn
      for (const el of items) {
        delete el.dataset.reorder;
        place(el, 0);
      }
      if (index !== from) o.onDrop(index);
    };
    settling = finish;
    const timer = window.setTimeout(finish, reducedMotion() ? 0 : SETTLE_MS);
  };

  return {
    move: (p) => {
      last = { clientX: p.clientX, clientY: p.clientY };
      layout();
    },
    drop: () => end(true),
    cancel: () => end(false),
  };
}

/**
 * A press on an item that can drag it to a new place. A mouse or pen drags once it has moved a few
 * pixels (a click stays a click). A finger has to hold still first: then the item lifts, `onHold`
 * runs (a menu, say), and dragging on moves the item and closes the menu.
 */
export function pressToReorder(e: ReactPointerEvent, o: ReorderList & PressOptions): void {
  const touch = e.pointerType === 'touch';
  const start = { clientX: e.clientX, clientY: e.clientY };
  let drag: Drag | null = null;
  let held: Point | null = null;
  let menuOpen = false;
  let timer = 0;
  const g = capture(e, {
    lazy: !touch,
    threshold: touch ? FINGER_SLOP : MOUSE_SLOP,
    onMove: (ev, gesture) => {
      if (!touch) {
        if (!gesture.moved) return;
        if (!drag) {
          o.onLift?.();
          drag = begin(o, start);
        }
        drag.move(ev);
        return;
      }
      if (!held) {
        if (!gesture.moved) return;
        window.clearTimeout(timer);
        o.onSwipe?.(ev, gesture);
        return;
      }
      if (menuOpen && Math.hypot(ev.clientX - held.clientX, ev.clientY - held.clientY) >= FINGER_SLOP) {
        menuOpen = false;
        closeMenu();
      }
      drag?.move(ev);
    },
    onUp: (_ev, gesture) => {
      window.clearTimeout(timer);
      if (drag) drag.drop();
      else if (touch && !gesture.moved) o.onTap?.();
      o.onEnd?.();
    },
    onAbort: () => {
      window.clearTimeout(timer);
      drag?.cancel();
      o.onEnd?.();
    },
  });
  if (!touch) return;
  timer = window.setTimeout(() => {
    if (g.moved) return;
    held = { clientX: g.last.clientX, clientY: g.last.clientY };
    navigator.vibrate?.(10);
    o.onLift?.();
    drag = begin(o, held);
    if (o.onHold) {
      o.onHold(g.last);
      menuOpen = true;
    }
  }, LONG_PRESS_MS);
}

/**
 * Where the list scrolls by itself (the mixer), a finger dragging an item mustn't scroll it too.
 * The listener is there from the start: one added once the finger is down may come too late to stop it.
 */
export function useNoScrollWhileDragging(ref: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const stop = (ev: TouchEvent) => {
      if (dragging) ev.preventDefault();
    };
    el.addEventListener('touchmove', stop, { passive: false });
    return () => el.removeEventListener('touchmove', stop);
  }, [ref]);
}
