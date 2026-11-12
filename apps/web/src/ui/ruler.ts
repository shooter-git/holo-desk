/** What a press on the tracks' ruler takes hold of: the playhead, or the cycle (an edge, all of it, a new one). */
export type RulerHold = 'playhead' | 'start' | 'end' | 'move' | 'new';

/** How close to the cycle's edge grabs it, with a mouse or a pen and with a finger. */
const EDGE = 8;
const EDGE_FINGER = 16;

/**
 * The ruler's top half is the cycle's strip and its bottom half moves the playhead. A finger on a
 * phone moves the playhead anywhere on it, as half of a ruler that short is too thin to aim at: only
 * the cycle's two edges, in its strip, still take the finger, to resize the cycle.
 */
export function rulerHold(
  x: number,
  y: number,
  height: number,
  cycle: { x0: number; x1: number },
  phoneFinger = false,
): RulerHold {
  if (y > height / 2) return 'playhead';
  const toStart = Math.abs(x - cycle.x0);
  const toEnd = Math.abs(x - cycle.x1);
  if (phoneFinger) {
    if (Math.min(toStart, toEnd) >= EDGE_FINGER) return 'playhead';
    return toStart <= toEnd ? 'start' : 'end';
  }
  if (toStart < EDGE) return 'start';
  if (toEnd < EDGE) return 'end';
  return x > cycle.x0 && x < cycle.x1 ? 'move' : 'new';
}

/** How far a drag on the position display goes for each bar it moves the playhead. */
export const JOG_PX = 14;

/**
 * A drag on the position display, in whole bars: the bars to move now, and the travel left over
 * toward the next one. Right or up goes forward, left or down back, as the tempo's drag counts.
 */
export function jog(travel: number, step = JOG_PX): { bars: number; rest: number } {
  // (|| 0: no -0 for a short drag back)
  const bars = Math.trunc(travel / step) || 0;
  return { bars, rest: travel - bars * step };
}
