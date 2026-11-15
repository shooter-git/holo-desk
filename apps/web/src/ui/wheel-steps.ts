/**
 * The wheel over a knob or a fader. A mouse's wheel sends a notch at a time; a trackpad sends a
 * stream of small movements, dozens for one swipe. Both are counted by how far they travel, so a
 * notch is a step and a swipe across a control is a few steps, not one for every event the pad sends.
 */

/** How far a mouse's wheel travels for one notch, in pixels (what most browsers report). */
export const NOTCH = 100;
/** A wheel that has rested this long starts a new turn. */
const REST_MS = 400;

export interface WheelLike {
  deltaX: number;
  deltaY: number;
  deltaMode: number;
  shiftKey: boolean;
}

/**
 * Whether the wheel is turning sideways: that scrolls what the control sits in (the mixer's strips),
 * and the control leaves it alone. With Shift held it isn't: browsers turn a mouse's wheel sideways
 * then, and Shift is the control's fine step.
 */
export function sideways(e: WheelLike): boolean {
  return !e.shiftKey && Math.abs(e.deltaX) > Math.abs(e.deltaY);
}

/** How far the wheel turned, in pixels: lines and pages count as a mouse's notches do. */
export function wheelPixels(e: WheelLike): number {
  const d = e.deltaY || (e.shiftKey ? e.deltaX : 0);
  return e.deltaMode === 1 ? (d * NOTCH) / 3 : e.deltaMode === 2 ? d * NOTCH : d;
}

/** Counts a control's steps from the wheel's travel. */
export class WheelSteps {
  private rest = 0;
  private last = Number.NEGATIVE_INFINITY;

  /** The whole steps this event makes (negative: the wheel turned up); what's left over is kept for the next. */
  take(e: WheelLike, now: number): number {
    const d = wheelPixels(e);
    if (d === 0) return 0;
    const fresh = now - this.last > REST_MS || Math.sign(d) !== Math.sign(this.rest || d);
    this.last = now;
    if (fresh) {
      this.rest = 0;
      // a turn's first movement is a step, however small (a slow mouse wheel, the start of a swipe)
      if (Math.abs(d) < NOTCH) return Math.sign(d);
    }
    this.rest += d;
    // (|| 0: a part of a step the other way truncates to -0)
    const steps = Math.trunc(this.rest / NOTCH) || 0;
    this.rest -= steps * NOTCH;
    return steps;
  }
}
