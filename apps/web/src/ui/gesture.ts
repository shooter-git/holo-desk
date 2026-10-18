/**
 * Pointer gestures on the editors' canvases, shared by the tracks area, the piano roll and the
 * audio editor: one capture for a drag that ends cleanly however the pointer leaves (lifted,
 * cancelled, joined by a second finger, or held still for a menu), the two-finger pinch, scrolling
 * when a drag reaches an edge, and the wheel.
 */
import { type PointerEvent as ReactPointerEvent, type RefObject, useEffect, useRef } from 'react';

/** How long a finger rests before the press opens a menu. */
export const LONG_PRESS_MS = 500;
/** How close to an edge a drag starts scrolling the view. */
const EDGE_PX = 24;

export interface Gesture {
  /** The last pointer event seen (where the pointer rests while the view scrolls under it). */
  last: PointerEvent;
  /** Whether the pointer has travelled past the threshold (a tap is not a drag). */
  moved: boolean;
  /** Which way the view may scroll when the pointer nears an edge. */
  edgeScroll?: 'x' | 'xy';
  /** Run onMove again with the last event: the view scrolled under a still pointer. */
  replay(): void;
  /** End the gesture without its onUp: a second finger, a long press, the component going away. */
  abort(): void;
}

export interface GestureOptions {
  /** Pixels the pointer may wander before it counts as a drag: 10 for a finger, 3 for a mouse. */
  threshold?: number;
  edgeScroll?: 'x' | 'xy';
  onMove?: (ev: PointerEvent, g: Gesture) => void;
  onUp?: (ev: PointerEvent, g: Gesture) => void;
  /** A finger held still: the gesture is aborted and this runs instead (the long press is touch's right click). */
  onLongPress?: (ev: PointerEvent) => void;
  /** The gesture ended without onUp: undo any preview it had put up. */
  onAbort?: () => void;
}

/** Capture the pointer from a pointerdown and follow it to the end. */
export function capture(e: ReactPointerEvent, o: GestureOptions): Gesture {
  const el = e.currentTarget as HTMLElement;
  const id = e.pointerId;
  const touch = e.pointerType === 'touch';
  const threshold = o.threshold ?? (touch ? 10 : 3);
  const x0 = e.clientX;
  const y0 = e.clientY;
  let done = false;
  let timer = 0;
  const g: Gesture = {
    last: e.nativeEvent,
    moved: false,
    edgeScroll: o.edgeScroll,
    replay: () => {
      if (!done) o.onMove?.(g.last, g);
    },
    abort: () => {
      if (done) return;
      finish();
      o.onAbort?.();
    },
  };
  const finish = () => {
    done = true;
    window.clearTimeout(timer);
    el.removeEventListener('pointermove', move);
    el.removeEventListener('pointerup', up);
    el.removeEventListener('pointercancel', cancel);
    try {
      if (el.hasPointerCapture(id)) el.releasePointerCapture(id);
    } catch {
      // the element may already be gone
    }
  };
  const move = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    g.last = ev;
    if (!g.moved && Math.hypot(ev.clientX - x0, ev.clientY - y0) >= threshold) {
      g.moved = true;
      window.clearTimeout(timer);
    }
    o.onMove?.(ev, g);
  };
  const up = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    g.last = ev;
    finish();
    o.onUp?.(ev, g);
  };
  const cancel = (ev: PointerEvent) => {
    if (ev.pointerId !== id) return;
    g.abort();
  };
  el.setPointerCapture(id);
  el.addEventListener('pointermove', move);
  el.addEventListener('pointerup', up);
  el.addEventListener('pointercancel', cancel);
  if (touch && o.onLongPress) {
    timer = window.setTimeout(() => {
      if (done || g.moved) return;
      g.abort();
      navigator.vibrate?.(10);
      o.onLongPress?.(g.last);
    }, LONG_PRESS_MS);
  }
  return g;
}

/**
 * How far to scroll this frame while a drag rests near or past a box's edge: a steady pace in the
 * last pixels, faster the further the pointer has left the box.
 */
export function edgeScroll(
  ev: { clientX: number; clientY: number },
  rect: DOMRect,
  axes: 'x' | 'xy',
): { dx: number; dy: number } {
  const amount = (p: number, size: number) => {
    if (p < EDGE_PX) return -(8 + (EDGE_PX - p) / 4);
    if (p > size - EDGE_PX) return 8 + (p - (size - EDGE_PX)) / 4;
    return 0;
  };
  return {
    dx: amount(ev.clientX - rect.left, rect.width),
    dy: axes === 'xy' ? amount(ev.clientY - rect.top, rect.height) : 0,
  };
}

/** Two fingers on a canvas: their distance apart sets the zoom. */
export class Pinch {
  private pts = new Map<number, { x: number; y: number }>();
  /** From the second finger landing until the last one lifts; taps and drags are ignored meanwhile. */
  active = false;
  /** A finger landed: true once two are down. */
  down(e: ReactPointerEvent): boolean {
    if (e.pointerType !== 'touch') return false;
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (this.pts.size >= 2) this.active = true;
    return this.active;
  }
  /** A finger moved: the zoom factor and the point between the fingers, while two are down. */
  move(e: ReactPointerEvent): { factor: number; x: number; y: number } | null {
    if (e.pointerType !== 'touch' || this.pts.size !== 2 || !this.pts.has(e.pointerId)) return null;
    const [a, b] = [...this.pts.values()] as [{ x: number; y: number }, { x: number; y: number }];
    const before = Math.hypot(a.x - b.x, a.y - b.y);
    this.pts.set(e.pointerId, { x: e.clientX, y: e.clientY });
    const [c, d] = [...this.pts.values()] as [{ x: number; y: number }, { x: number; y: number }];
    const after = Math.hypot(c.x - d.x, c.y - d.y);
    if (before < 20 || after < 20) return null;
    return { factor: after / before, x: (c.x + d.x) / 2, y: (c.y + d.y) / 2 };
  }
  /** A finger lifted: true when it was the pinch's last. */
  up(e: ReactPointerEvent): boolean {
    this.pts.delete(e.pointerId);
    if (this.active && this.pts.size === 0) {
      this.active = false;
      return true;
    }
    return false;
  }
}

/**
 * The wheel on an element, with the page kept still: React's own wheel listener is passive, so a
 * trackpad pinch (wheel with ctrlKey) would zoom the page as well as the view. Deltas come back in
 * pixels whatever the browser counts in.
 */
export function useWheel(
  ref: RefObject<HTMLElement | null>,
  handler: (e: WheelEvent, dx: number, dy: number) => void,
): void {
  const fn = useRef(handler);
  fn.current = handler;
  const bound = useRef<HTMLElement | null>(null);
  const unbind = useRef<() => void>(() => undefined);
  // the element may appear later than the component (it renders once there's a project)
  useEffect(() => {
    const el = ref.current;
    if (el === bound.current) return;
    unbind.current();
    bound.current = el;
    if (!el) return;
    const on = (e: WheelEvent) => {
      e.preventDefault();
      const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? el.clientHeight : 1;
      fn.current(e, e.deltaX * k, e.deltaY * k);
    };
    el.addEventListener('wheel', on, { passive: false });
    unbind.current = () => el.removeEventListener('wheel', on);
  });
  useEffect(() => () => unbind.current(), []);
}

/** Device pixel ratio as the canvases use it (capped, as `prepare` caps it). */
export const screenDpr = () => Math.min(3, window.devicePixelRatio || 1);
