/**
 * Scrolling and zoom for a timeline (the tracks area and the piano roll each have one). Kept out
 * of React: scrolling redraws canvases, not components.
 */
export class Viewport {
  /** First tick at the left edge. */
  x = 0;
  /** Pixels scrolled from the top. */
  y = 0;
  /** Pixels per quarter note. */
  zoom: number;
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
    this.emit();
  }
  /** Zoom around a point on screen, so what's under the pointer stays put. */
  zoomAt(factor: number, atPx: number, min = 4, max = 1200): void {
    const tick = this.xToTick(atPx);
    this.zoom = Math.max(min, Math.min(max, this.zoom * factor));
    this.x = Math.max(0, tick - atPx / this.pxPerTick);
    this.emit();
  }
  /** Keep a tick in view (following the playhead), paging like Logic does. */
  follow(tick: number, widthPx: number): void {
    const x = this.tickToX(tick);
    if (x > widthPx * 0.92 || x < 0) {
      this.x = Math.max(0, tick - (widthPx * 0.08) / this.pxPerTick);
      this.emit();
    }
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
