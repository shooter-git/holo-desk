import { type RefObject, useEffect } from 'react';

/**
 * What last took the keyboard. A window that loads before it shows (Print, Scan) mounts after the
 * studio has gone inert under it, and by then the button that opened it is no longer the active
 * element: this is how the keyboard still finds its way back to it.
 */
let last: Element | null = null;
if (typeof document !== 'undefined') {
  document.addEventListener(
    'focusin',
    (e) => {
      last = e.target instanceof Element ? e.target : null;
    },
    true,
  );
}

/**
 * The keyboard moves into a dialog, or a window over the whole studio, while it's up, and back to
 * where it was when it closes. The box takes the focus itself (tabIndex -1), so Tab starts at its
 * first control.
 */
export function useFocusInside(box: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const active = document.activeElement;
    const was = active && active !== document.body ? active : last;
    box.current?.focus({ preventScroll: true });
    return () => {
      if (was instanceof HTMLElement && was.isConnected) was.focus({ preventScroll: true });
    };
  }, [box]);
}
