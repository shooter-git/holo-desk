/**
 * Scrolling and zoom for a timeline (the tracks area and the piano roll each have one). Kept out
 * of React: scrolling redraws canvases, not components.
 */

/** Pixels per quarter note each editor allows, [min, max]. */
export const ZOOM = { tracks: [3, 600], roll: [10, 2400], audio: [4, 4000] } as const;
/** How much a wheel tick zooms: factor = exp(-deltaY * WHEEL_ZOOM). */
export const WHEEL_ZOOM = 0.0025;
/** Two taps this close together are a double tap. */
export const DOUBLE_TAP_MS = 320;
/** How long the view stays where the user put it before following the playhead again. */
const USER_SCROLL_MS = 1500;

export class Viewport {
  /** First tick at the left edge. */
  x = 0;
  /** Pixels scrolled from the top. */
  y = 0;
  /** Pixels per quarter note. */
  zoom: number;
  /** Until when the user's own scrolling or zooming holds the view against following. */
  userScrollUntil = 0;
  private listeners = new Set<() => void>();
  constructor(zoom: number) {
    this.zoom = zoom;
  }
  get pxPerTick(): number {
    return this.zoom / 960;
  }
  tickToX(tick: number): number {
    return (tick - this.x) * this.pxPerTick;
  }
  xToTick(x: number): number {
    return this.x + x / this.pxPerTick;
  }
  scrollBy(dxPx: number, dyPx: number, maxY = Number.POSITIVE_INFINITY): void {
    this.x = Math.max(0, this.x + dxPx / this.pxPerTick);
    this.y = Math.max(0, Math.min(Math.max(0, maxY), this.y + dyPx));
    this.userScrollUntil = performance.now() + USER_SCROLL_MS;
    this.emit();
  }
  /** Zoom around a point on screen, so what's under the pointer stays put. */
  zoomAt(factor: number, atPx: number, min = 4, max = 1200): void {
    const tick = this.xToTick(atPx);
    this.zoom = Math.max(min, Math.min(max, this.zoom * factor));
    this.x = Math.max(0, tick - atPx / this.pxPerTick);
    this.userScrollUntil = performance.now() + USER_SCROLL_MS;
    this.emit();
  }
  /**
   * Keep the playhead in view while it plays, paging like Logic does when it reaches the right
   * edge. The user's own scrolling wins for a moment, and scrolling ahead of the playhead is never
   * undone (a jump backwards, such as a cycle wrap, goes through `reveal`).
   */
  follow(tick: number, widthPx: number): void {
    if (performance.now() < this.userScrollUntil) return;
    if (this.tickToX(tick) > widthPx * 0.92) this.page(tick, widthPx);
  }
  /** Bring a tick on screen if it's off either edge (after a locate or a cycle wrap). */
  reveal(tick: number, widthPx: number): void {
    const x = this.tickToX(tick);
    if (x < 0 || x > widthPx * 0.92) this.page(tick, widthPx);
  }
  private page(tick: number, widthPx: number): void {
    this.x = Math.max(0, tick - (widthPx * 0.08) / this.pxPerTick);
    this.emit();
  }
  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }
  emit(): void {
    for (const l of this.listeners) l();
  }
}

/** A grid spacing in ticks that leaves at least `minPx` between lines. */
export function gridStep(pxPerTick: number, minPx: number, beatTicks: number, barTicks: number): number {
  const candidates = [
    beatTicks / 8,
    beatTicks / 4,
    beatTicks / 2,
    beatTicks,
    barTicks,
    barTicks * 2,
    barTicks * 4,
    barTicks * 8,
    barTicks * 16,
  ];
  for (const c of candidates) if (c * pxPerTick >= minPx) return c;
  return barTicks * 32;
}
