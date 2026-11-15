/**
 * A finger on a control that sits in something it also scrolls (a pan knob, a fader or a send in
 * the mixer's row of strips). Such a control answers to up and down alone, and its style gives the
 * browser a sideways swipe (touch-action: pan-x), which scrolls the strips from wherever it starts.
 * The first few pixels up or down move nothing: by then the browser has taken a swipe that was going
 * sideways, so a scroll that began on a knob leaves the knob as it was.
 */

/** How far a finger goes up or down on such a control before it drags it (px). */
export const UP_DOWN_SLOP = 6;

/** Whether this press is a finger's on a control whose style leaves sideways swipes to the browser. */
export function upDownOnly(e: { pointerType: string; currentTarget: Element }): boolean {
  return e.pointerType === 'touch' && getComputedStyle(e.currentTarget).touchAction === 'pan-x';
}

/**
 * A drag's travel with its first `slop` pixels taken out: fed each move's distance, it gives back
 * what the control should move by. Nothing until the travel passes the slop, then what's past it,
 * so the control doesn't jump when it starts.
 */
export function pastSlop(slop = UP_DOWN_SLOP): (d: number) => number {
  let held = 0;
  let free = false;
  return (d) => {
    if (free) return d;
    held += d;
    if (Math.abs(held) < slop) return 0;
    free = true;
    return held - Math.sign(held) * slop;
  };
}
