/**
 * Notes drawn small: a region's on the tracks, a few bars of a track's in a reply's view. Each note a
 * short bar at its time and pitch, scaled to the notes' own range (at least an octave), no wider than
 * the canvas needs.
 */
import type { Region } from '@holo/session';

/** A note to draw: its start and length in ticks from the window's start, and its pitch. */
export interface MiniNote {
  t: number;
  d: number;
  p: number;
}

/** The lowest and highest pitch of some notes. */
export function rangeOf(notes: readonly MiniNote[]): { lo: number; hi: number } {
  let lo = 127;
  let hi = 0;
  for (const n of notes) {
    if (n.p < lo) lo = n.p;
    if (n.p > hi) hi = n.p;
  }
  return { lo, hi };
}

// a MIDI region's pitch range is scanned once per region, not per frame
const pitchRanges = new WeakMap<Region, { lo: number; hi: number }>();

export function pitchRange(r: Region): { lo: number; hi: number } {
  let range = pitchRanges.get(r);
  if (!range) {
    range = rangeOf(r.notes);
    pitchRanges.set(r, range);
  }
  return range;
}

/**
 * Notes of a window `length` ticks long drawn in a box, in the fill style already set. Those starting
 * after the window, or off a canvas `canvasWidth` wide, aren't drawn.
 */
export function drawMiniNotes(
  ctx: CanvasRenderingContext2D,
  notes: readonly MiniNote[],
  length: number,
  box: { x: number; y: number; w: number; h: number },
  range: { lo: number; hi: number },
  canvasWidth = Number.POSITIVE_INFINITY,
): void {
  const { lo, hi } = range;
  const span = Math.max(12, hi - lo + 1);
  const pxPerTick = box.w / length;
  for (const n of notes) {
    if (n.t >= length) continue;
    const nx = box.x + n.t * pxPerTick;
    // (a long region zoomed in holds far more notes than the canvas shows: those off it aren't drawn)
    if (nx > canvasWidth) continue;
    const nw = Math.max(1.5, Math.min(n.d, length - n.t) * pxPerTick - 0.5);
    if (nx + nw < 0) continue;
    const ny = box.y + (1 - (n.p - lo + 0.5) / span) * box.h;
    ctx.fillRect(nx, ny - 1, nw, Math.max(1.5, Math.min(3, box.h / span)));
  }
}
