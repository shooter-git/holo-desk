/**
 * A box that scrolls without a scrollbar says there is more by fading the edge that has it. This
 * keeps the marks its style fades by: data-above and data-below for a box that scrolls up and down,
 * data-before and data-after for one that scrolls sideways.
 */
import { type RefObject, useEffect } from 'react';

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
 * Keep a scrolling box's marks. They are read again as the box scrolls, and as it or anything
 * directly in it changes size or comes and goes: what a box holds can outgrow it without the box
 * itself changing.
 */
export function useScrollCue(ref: RefObject<HTMLElement | null>, axis: 'x' | 'y' = 'y'): void {
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const on = () => mark(el, axis);
    el.addEventListener('scroll', on, { passive: true });
    const sizes = new ResizeObserver(on);
    const watch = () => {
      sizes.disconnect();
      sizes.observe(el);
      for (const child of el.children) sizes.observe(child);
    };
    const children = new MutationObserver(() => {
      watch();
      on();
    });
    children.observe(el, { childList: true });
    watch();
    on();
    return () => {
      el.removeEventListener('scroll', on);
      sizes.disconnect();
      children.disconnect();
    };
  }, [ref, axis]);
}
