import type { PointerEvent as ReactPointerEvent } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Pinch } from '../src/ui/gesture.ts';

const finger = (pointerId: number, clientX = 0, clientY = 0) =>
  ({ pointerType: 'touch', pointerId, clientX, clientY }) as unknown as ReactPointerEvent;

/** A window that only hears and says pointer events, as the page's does for the pinch. */
class FakeWindow extends EventTarget {
  lift(pointerId: number, type = 'pointerup'): void {
    this.dispatchEvent(Object.assign(new Event(type), { pointerId }));
  }
}

describe('two fingers on a canvas', () => {
  let page: FakeWindow;
  const real = (globalThis as { window?: unknown }).window;
  beforeEach(() => {
    page = new FakeWindow();
    (globalThis as { window?: unknown }).window = page;
  });
  afterEach(() => {
    (globalThis as { window?: unknown }).window = real;
  });

  it('are a pinch from the second finger until the last one lifts', () => {
    const p = new Pinch();
    expect(p.down(finger(1))).toBe(false);
    expect(p.down(finger(2, 100))).toBe(true);
    expect(p.up(finger(1))).toBe(false);
    expect(p.active).toBe(true);
    expect(p.up(finger(2))).toBe(true);
    expect(p.active).toBe(false);
  });

  it('a finger whose lift the canvas never hears (it landed on a menu) is not still down', () => {
    const p = new Pinch();
    p.down(finger(1));
    // the lift goes to whatever is over the canvas by then, and reaches only the window
    page.lift(1);
    // the next finger is one finger: a tap or a drag, not a pinch's second
    expect(p.down(finger(2))).toBe(false);
    expect(p.active).toBe(false);
  });

  it('the same for a touch the browser took away', () => {
    const p = new Pinch();
    p.down(finger(1));
    page.lift(1, 'pointercancel');
    expect(p.down(finger(2))).toBe(false);
  });

  it('another finger’s lift leaves this one down', () => {
    const p = new Pinch();
    p.down(finger(1));
    page.lift(7);
    expect(p.down(finger(2))).toBe(true);
  });

  it('a pinch whose lifts the canvas missed ends at the window too', () => {
    const p = new Pinch();
    p.down(finger(1));
    p.down(finger(2, 100));
    page.lift(1);
    expect(p.active).toBe(true);
    page.lift(2);
    expect(p.active).toBe(false);
  });
});
