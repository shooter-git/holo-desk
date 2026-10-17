import { useSyncExternalStore } from 'react';

/**
 * Which layout fits the screen:
 *  - desktop: the full studio, panels side by side;
 *  - tablet: the same, side panels slide over the tracks;
 *  - phone: one view at a time with tabs at the bottom (portrait) or down the side (landscape).
 */
export type Layout = 'desktop' | 'tablet' | 'phone-portrait' | 'phone-landscape';

function measure(): Layout {
  const w = window.innerWidth;
  const h = window.innerHeight;
  const coarse = window.matchMedia('(pointer: coarse)').matches;
  if (w < 700 && h >= w) return 'phone-portrait';
  if (h < 500 && (coarse || w < 1000)) return 'phone-landscape';
  if (w < 1180 || coarse) return 'tablet';
  return 'desktop';
}

let current: Layout = typeof window === 'undefined' ? 'desktop' : measure();
const listeners = new Set<() => void>();
if (typeof window !== 'undefined') {
  const update = () => {
    const next = measure();
    if (next !== current) {
      current = next;
      for (const l of listeners) l();
    }
  };
  window.addEventListener('resize', update);
  window.addEventListener('orientationchange', update);
}

export function useLayout(): Layout {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => current,
  );
}

export const isPhone = (l: Layout) => l === 'phone-portrait' || l === 'phone-landscape';
export const isTouch = () => window.matchMedia('(pointer: coarse)').matches;
