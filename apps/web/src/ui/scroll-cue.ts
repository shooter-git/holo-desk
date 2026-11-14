/**
 * A box that scrolls without a scrollbar says there is more by fading the edge that has it. This
 * keeps the marks its style fades by: data-above and data-below for a box that scrolls up and down,
 * data-before and data-after for one that scrolls sideways.
 */
import { type RefObject, useEffect, useLayoutEffect } from 'react';

/** Whether a scrolled box holds more before and after what it shows (its scroll, its content's size, its own). */
export function scrollCue(start: number, content: number, box: number): { before: boolean; after: boolean } {
  return { before: start > 1, after: content - box - start > 1 };
}

function mark(el: HTMLElement, axis: 'x' | 'y'): void {
  const c =
    axis === 'y'
      ? scrollCue(el.scrollTop, el.scrollHeight, el.clientHeight)
      : scrollCue(Math.abs(el.scrollLeft), el.scrollWidth, el.clientWidth);
  el.toggleAttribute(axis === 'y' ? 'data-above' : 'data-before', c.before);
  el.toggleAttribute(axis === 'y' ? 'data-below' : 'data-after', c.after);
}

/**
 * Keep a scrolling box's marks: read as it scrolls, as it resizes, and when `holds` changes (what
 * the box holds, as the caller counts it: its content can grow without the box changing size).
 */
export function useScrollCue(ref: RefObject<HTMLElement | null>, holds: unknown, axis: 'x' | 'y' = 'y'): void {
  // biome-ignore lint/correctness/useExhaustiveDependencies: holds is what the box's content depends on
  useLayoutEffect(() => {
    if (ref.current) mark(ref.current, axis);
  }, [ref, holds, axis]);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => mark(el, axis);
    el.addEventListener('scroll', on, { passive: true });
    const watch = new ResizeObserver(on);
    watch.observe(el);
    return () => {
      el.removeEventListener('scroll', on);
      watch.disconnect();
    };
  }, [ref, axis]);
}
