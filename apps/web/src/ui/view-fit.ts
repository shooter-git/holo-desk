/**
 * How a reply's view (ui/AgentView.tsx) lays out a choice's options and a row's buttons in the width it
 * has: on one line as wide as their words when they fit so, else in equal columns that fill every row,
 * or one under another; and a slider whose name is longer than its column, with its name over it. What's measured is their words (as wide as each would be on one line) against the room their
 * place has, never the device; the CSS draws them (.seg[data-cols], .v-row[data-cols],
 * .v-slider[data-stack], styles/app.css).
 */
import { type RefObject, useEffect, useLayoutEffect } from 'react';

/**
 * The columns for controls of these widths (on one line each, their padding and borders included) in a
 * room, `gap` apart: 0 when they fit on one line as they are; else the most equal columns the widest
 * fits in that fill every row, so none ends short or with one alone (four in two rows of two; six in two
 * of three or three of two); 1, one under another (three or five that don't fit on one line).
 */
export function fitColumns(widths: readonly number[], room: number, gap: number): number {
  const n = widths.length;
  if (!n) return 0;
  const total = widths.reduce((sum, w) => sum + w, 0) + gap * (n - 1);
  if (total <= room) return 0;
  const widest = Math.max(...widths);
  const most = Math.min(n, Math.floor((room + gap) / (widest + gap)));
  for (let cols = most; cols > 1; cols--) if (n % cols === 0) return cols;
  return 1;
}

/** The room inside an element: its width less its padding. */
function roomIn(el: HTMLElement): number {
  const s = getComputedStyle(el);
  return el.clientWidth - Number.parseFloat(s.paddingLeft) - Number.parseFloat(s.paddingRight);
}

/**
 * Lay out a view's choices, rows of buttons and sliders in the room each has: measured with their words
 * on one line (data-measuring, a moment never drawn), then given their columns (a slider, its name over
 * it or beside it). Each one's room is read first, as it is now: what's measured changes nothing around it.
 */
export function fitView(view: HTMLElement): void {
  if (!view.clientWidth) return;
  const boxes = [...view.querySelectorAll<HTMLElement>('.seg, .v-row.buttons')];
  const sliders = [...view.querySelectorAll<HTMLElement>('.v-slider')].map((slider) => ({
    slider,
    label: slider.querySelector<HTMLElement>('.v-label'),
    // (its name's column: the first of its grid's)
    column: Number.parseFloat(getComputedStyle(slider).gridTemplateColumns) || 0,
  }));
  if (!boxes.length && !sliders.length) return;
  const places = boxes.map((box) => {
    const seg = box.classList.contains('seg');
    const parent = box.parentElement;
    // (a choice's own borders take from its room; a choice's options are a line apart, a row's buttons its gap)
    const room = parent ? roomIn(parent) - (seg ? 2 : 0) : 0;
    const gap = seg ? 1 : Number.parseFloat(getComputedStyle(box).columnGap) || 0;
    return { box, room, gap };
  });
  view.setAttribute('data-measuring', '');
  const widths = places.map(({ box }) =>
    [...box.children].filter((c) => c.matches('.btn')).map((c) => Math.ceil(c.getBoundingClientRect().width) + 1),
  );
  const names = sliders.map(({ label }) => label?.getBoundingClientRect().width ?? 0);
  view.removeAttribute('data-measuring');
  for (const [i, { slider, column }] of sliders.entries())
    slider.toggleAttribute('data-stack', (names[i] ?? 0) > column + 0.5);
  places.forEach(({ box, room, gap }, i) => {
    const cols = fitColumns(widths[i] ?? [], room, gap);
    if (cols) {
      box.dataset.cols = String(cols);
      box.style.setProperty('--cols', String(cols));
    } else {
      delete box.dataset.cols;
      box.style.removeProperty('--cols');
    }
  });
}

/**
 * Keep a view laid out: after it renders, and as its width changes (one observer a view, gone with it:
 * nothing runs while the page or the bar is closed), and once a font still loading has come. `shown`:
 * whether the view is drawn at all (one that doesn't pass its check isn't).
 */
export function useFitView(ref: RefObject<HTMLElement | null>, shown: boolean): void {
  useLayoutEffect(() => {
    if (ref.current) fitView(ref.current);
  });
  useEffect(() => {
    const view = shown ? ref.current : null;
    if (!view) return;
    let width = view.clientWidth;
    let frame = 0;
    // (in the next frame: laid out in the observer's own call, the view's new height would be one it misses)
    const again = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => fitView(view));
    };
    const watch = new ResizeObserver(() => {
      if (view.clientWidth === width) return;
      width = view.clientWidth;
      again();
    });
    watch.observe(view);
    document.fonts?.addEventListener('loadingdone', again);
    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
      document.fonts?.removeEventListener('loadingdone', again);
    };
  }, [ref, shown]);
}
