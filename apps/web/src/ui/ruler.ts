import { type Project, ticksPerBar, ticksPerBeat, tickToBarBeat } from '@holo/session';
import { gridStep } from './view.ts';

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

/** A timeline's view, as a ruler reads it. */
export interface RulerView {
  /** The first tick at the left edge. */
  x: number;
  pxPerTick: number;
  tickToX(tick: number): number;
  xToTick(x: number): number;
}

/** An editor's ruler: a tick on each beat (or finer, zoomed in), longer on bars, numbered as far apart as fits. */
export function drawRuler(
  ctx: CanvasRenderingContext2D,
  project: Project,
  view: RulerView,
  w: number,
  h: number,
): void {
  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  const beat = ticksPerBeat(m);
  const bar = ticksPerBar(m);
  ctx.fillStyle = '#1b1e23';
  ctx.fillRect(0, 0, w, h);
  ctx.font = '600 10.5px Inter Variable, system-ui, sans-serif';
  const step = gridStep(view.pxPerTick, 7, beat, bar);
  // labels on beats at the finest (a label between beats would repeat its beat's number)
  const labels = Math.max(beat, gridStep(view.pxPerTick, 40, beat, bar));
  for (let t = Math.floor(view.x / step) * step; t < view.xToTick(w); t += step) {
    const x = Math.round(view.tickToX(t)) + 0.5;
    const isBar = t % bar === 0;
    ctx.fillStyle = isBar ? '#7d8796' : '#454c57';
    ctx.fillRect(x, isBar ? h - 11 : h - 5, 1, isBar ? 11 : 5);
    if (t % labels === 0) {
      const bb = tickToBarBeat(project.meter, t);
      ctx.fillStyle = isBar ? '#c3cad4' : '#7d8796';
      ctx.fillText(isBar ? String(bb.bar) : `${bb.bar}.${bb.beat}`, x + 3, h - 4);
    }
  }
  ctx.fillStyle = '#0b0d10';
  ctx.fillRect(0, h - 1, w, 1);
}
