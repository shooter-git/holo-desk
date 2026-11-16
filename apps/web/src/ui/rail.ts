/**
 * A phone's track headers fold to a rail: each track's color, what it plays, and whether it's muted,
 * soloed or armed. Its name goes on its lane, and the headers come out over the lanes as a drawer.
 * Here, the rules a finger meets there: how tall the rows may be, what a finger drawn out of the
 * rail pulls out, and which way two fingers on the lanes act.
 */

/** The rail's width. */
export const RAIL = 52;
/** The drawer's: the headers on one line each (the buttons beside the name), over the lanes. */
export const DRAWER = 300;
/**
 * A phone's rows hold no buttons, so they can be as short as a finger's touch or a few times that:
 * two fingers spread up and down set it (the song's own height, 56, to begin with).
 */
export const RAIL_ROW = { min: 44, max: 160 };
/** How far a finger draws a rail cell out to show that track's buttons, and further, the drawer. */
export const PEEK_SWIPE = 24;
export const DRAWER_SWIPE = 120;

/** A row's height on a phone, from the height asked for. */
export const railRow = (h: number): number => Math.max(RAIL_ROW.min, Math.min(RAIL_ROW.max, h));

/** What a finger drawn `dx` pixels to the right from a track's place on the rail pulls out. */
export function pulledOut(dx: number): 'drawer' | 'buttons' | null {
  if (dx >= DRAWER_SWIPE) return 'drawer';
  return dx >= PEEK_SWIPE ? 'buttons' : null;
}

/**
 * Which way two fingers act, from how far apart they are across and up and down as they begin: one
 * above the other, they set the rows' height; side by side (or aslant), they zoom in time.
 */
export const pinchAxis = (across: number, upDown: number): 'x' | 'y' => (upDown > across * 1.3 ? 'y' : 'x');

/** The rows' height as two fingers that began `from` apart up and down, over rows `row` tall, are now `span` apart. */
export const pinchedRow = (row: number, from: number, span: number): number => Math.round(railRow((row * span) / from));
