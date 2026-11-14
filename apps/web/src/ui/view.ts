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

/**
 * How far a view must scroll to show the whole of a row (the row's top and height in the list, the
 * view's scroll and height): 0 when it already shows, and a row taller than the view comes to its top.
 */
export function revealBy(top: number, height: number, scroll: number, viewHeight: number): number {
  if (top < scroll || height > viewHeight) return top - scroll;
  const under = top + height - (scroll + viewHeight);
  return under > 0 ? under : 0;
}

// A finger's scroll, as a phone's browser scrolls a page (see TouchPan)
/** How far a finger moves before the view follows it, and the drag's direction is read. */
const PAN_SLOP = 8;
/** A drag this much more along one direction than the other holds to that direction. */
const PAN_LOCK = 2;
/** The share of a flick's speed kept each millisecond once the finger lifts (iOS's rate). */
const FLING_DECAY = 0.998;
/** A lift slower than this (pixels per millisecond) stops the view; a fling ends below FLING_STOP. */
const FLING_START = 0.1;
const FLING_STOP = 0.02;
/** The fastest a flick sends the view (pixels per millisecond). */
const FLING_MAX = 8;
/** The finger's moves in this long before it lifts give the flick its speed. */
const FLING_WINDOW_MS = 100;
/** A finger still for this long before it lifts has stopped: no flick. */
const FLING_REST_MS = 50;

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
  /** The animation frame of a fling under way (0: none). */
  private flinging = 0;
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
  /**
   * Carry the view on after a flick, at `vx`, `vy` pixels per millisecond, slowing as a phone's
   * scrolling does until it stops, reaches an edge, or a finger catches it (stopFling).
   */
  fling(vx: number, vy: number, maxY = Number.POSITIVE_INFINITY): void {
    this.stopFling();
    let last = 0;
    const step = (now: number) => {
      // (the first frame's time may come before the lift: it only sets the clock)
      const dt = last ? Math.min(50, now - last) : 0;
      last = now;
      if (dt > 0) {
        const { x, y } = this;
        this.scrollBy(vx * dt, vy * dt, maxY);
        // an edge stops the view along that direction
        if (this.x === x) vx = 0;
        if (this.y === y) vy = 0;
        const keep = FLING_DECAY ** dt;
        vx *= keep;
        vy *= keep;
      }
      this.flinging = Math.hypot(vx, vy) < FLING_STOP ? 0 : requestAnimationFrame(step);
    };
    this.flinging = requestAnimationFrame(step);
  }
  /** Stop a fling. True if the view was still moving: the finger that stops it caught it, and isn't a tap. */
  stopFling(): boolean {
    if (!this.flinging) return false;
    cancelAnimationFrame(this.flinging);
    this.flinging = 0;
    return true;
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
   * undone (a jump backward, such as a cycle wrap, goes through `reveal`).
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

/** Where a pointer was, and when (an event's timeStamp, on performance.now()'s clock). */
interface PanPoint {
  clientX: number;
  clientY: number;
  timeStamp: number;
}

/**
 * A finger dragging a timeline, as a phone's browser scrolls a page: the view follows once the
 * finger has gone past the slop (from there, so it doesn't jump), holds to one direction when the
 * drag starts mostly along it, and a flick carries on after the finger lifts, slowing to a stop.
 */
export class TouchPan {
  private x0: number;
  private y0: number;
  private lx = 0;
  private ly = 0;
  /** Which way the view moves; null until the finger passes the slop. */
  private axis: 'x' | 'y' | 'xy' | null = null;
  /** The finger's recent moves, for the flick's speed. */
  private moves: PanPoint[] = [];

  constructor(
    private view: Viewport,
    /** The ways this view scrolls: a list only up and down, a timeline both. */
    private axes: 'x' | 'y' | 'xy',
    private maxY: () => number,
    from: PanPoint,
  ) {
    view.stopFling();
    this.x0 = from.clientX;
    this.y0 = from.clientY;
  }

  /** Whether the finger has gone past the slop and moved the view: a finger that lifts before it has tapped. */
  get panned(): boolean {
    return this.axis !== null;
  }

  move(ev: PanPoint): void {
    if (!this.axis) {
      const dx = Math.abs(ev.clientX - this.x0);
      const dy = Math.abs(ev.clientY - this.y0);
      const far = Math.hypot(dx, dy);
      if (far < PAN_SLOP) return;
      this.axis = panAxis(this.axes, dx, dy);
      // the view moves from where the finger passed the slop, so it neither jumps nor lags further behind
      const k = PAN_SLOP / far;
      this.lx = this.x0 + (ev.clientX - this.x0) * k;
      this.ly = this.y0 + (ev.clientY - this.y0) * k;
    }
    const dx = this.axis === 'y' ? 0 : this.lx - ev.clientX;
    const dy = this.axis === 'x' ? 0 : this.ly - ev.clientY;
    this.lx = ev.clientX;
    this.ly = ev.clientY;
    this.view.scrollBy(dx, dy, this.maxY());
    this.moves.push({ clientX: ev.clientX, clientY: ev.clientY, timeStamp: ev.timeStamp });
    while (this.moves.length > 2 && ev.timeStamp - (this.moves[0] as PanPoint).timeStamp > FLING_WINDOW_MS)
      this.moves.shift();
  }

  /** The finger lifted (at `at`, on performance.now()'s clock): a flick carries the view on. */
  end(at = performance.now()): void {
    if (!this.axis) return;
    const v = flickSpeed(this.moves, at);
    if (!v) return;
    this.view.fling(this.axis === 'y' ? 0 : v.vx, this.axis === 'x' ? 0 : v.vy, this.maxY());
  }
}

/** The direction a drag holds to, from how far it went each way when it passed the slop. */
export function panAxis(axes: 'x' | 'y' | 'xy', dx: number, dy: number): 'x' | 'y' | 'xy' {
  if (axes !== 'xy') return axes;
  if (dx > dy * PAN_LOCK) return 'x';
  if (dy > dx * PAN_LOCK) return 'y';
  return 'xy';
}

/**
 * How fast the view should move on after the finger lifts (pixels per millisecond, the way the view
 * moves: opposite to the finger), from its moves in the last moment before it lifted. Null for a
 * finger that had stopped or was too slow to flick.
 */
export function flickSpeed(moves: readonly PanPoint[], at: number): { vx: number; vy: number } | null {
  const last = moves.at(-1);
  if (!last || at - last.timeStamp > FLING_REST_MS) return null;
  const first = moves.find((m) => last.timeStamp - m.timeStamp <= FLING_WINDOW_MS) ?? last;
  const dt = last.timeStamp - first.timeStamp;
  if (dt < 8) return null;
  let vx = (first.clientX - last.clientX) / dt;
  let vy = (first.clientY - last.clientY) / dt;
  const speed = Math.hypot(vx, vy);
  if (speed < FLING_START) return null;
  if (speed > FLING_MAX) {
    vx *= FLING_MAX / speed;
    vy *= FLING_MAX / speed;
  }
  return { vx, vy };
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
