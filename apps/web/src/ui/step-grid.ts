/**
 * The Step Grid's arithmetic, apart from its drawing: which bars a page holds, the strip of bars
 * above it, how a drag reads as a velocity, the swing a part already has, and which of the studio's
 * controls makes each of the grid's edits (a test holds that list against the edits themselves).
 */
import { type Cell, type Held, MAX_SWING, type Step, type StepEditName, swings } from '@holo/agent/edits';
import { barToTick, firstBar, type MeterPoint, tickToBarBeat } from '@holo/session';
import { useSyncExternalStore } from 'react';

// ---- the page ----

/** How narrow a step may get before a page holds fewer bars: a finger's, and a mouse's. */
export const STEP_MIN_TOUCH = 17;
export const STEP_MIN = 15;
/** The bars a page may hold. */
export const PAGE_BARS = [1, 2, 4] as const;

/**
 * How many bars a page shows: the most of 1, 2 or 4 whose steps are still wide enough to press, or
 * the number chosen (0: as many as fit) when that many fit at all.
 */
export function pageBars(width: number, stepsPerBar: number, chosen: number, touch: boolean): number {
  const least = touch ? STEP_MIN_TOUCH : STEP_MIN;
  const fits = (bars: number) => width / (bars * Math.max(1, stepsPerBar)) >= least;
  const most = [...PAGE_BARS].reverse().find(fits) ?? 1;
  return PAGE_BARS.includes(chosen as 1 | 2 | 4) ? Math.min(chosen, Math.max(most, 1)) : most;
}

export interface Page {
  /** Its first bar's number, and where it starts and ends, in ticks. */
  bar: number;
  from: number;
  to: number;
}

/** The page of `bars` bars a tick is on: pages are counted from the song's first bar. */
export function pageAt(meter: readonly MeterPoint[], tick: number, bars: number): Page {
  const first = firstBar(meter);
  const at = tickToBarBeat(meter, Math.max(0, tick)).bar;
  const bar = first + Math.floor((at - first) / bars) * bars;
  return { bar, from: barToTick(meter, bar), to: barToTick(meter, bar + bars) };
}

/** The page after (`by` 1) or before (-1) another; never before the song's first. */
export function pageBy(meter: readonly MeterPoint[], page: Page, bars: number, by: number): Page {
  const bar = Math.max(firstBar(meter), page.bar + by * bars);
  return { bar, from: barToTick(meter, bar), to: barToTick(meter, bar + bars) };
}

export interface StripBar {
  bar: number;
  from: number;
  to: number;
  /** How much of each quarter of the bar is played, 0 to 1 (by its hardest hit). */
  parts: [number, number, number, number];
}

/**
 * The strip above the grid: every bar from the song's first to the last the part plays (and a page
 * past it, to write into), each with how much is played in it.
 */
export function stripBars(
  meter: readonly MeterPoint[],
  held: readonly Held[],
  through: number,
  most = 256,
): StripBar[] {
  const first = firstBar(meter);
  let end = Math.max(0, through);
  for (const h of held) for (const n of h.notes) end = Math.max(end, h.region.start + n.t + 1);
  const last = Math.min(first + most - 1, tickToBarBeat(meter, Math.max(0, end - 1)).bar);
  const out: StripBar[] = [];
  for (let bar = first; bar <= last; bar++)
    out.push({ bar, from: barToTick(meter, bar), to: barToTick(meter, bar + 1), parts: [0, 0, 0, 0] });
  if (!out.length) return out;
  const start = (out[0] as StripBar).from;
  const stop = (out.at(-1) as StripBar).to;
  for (const h of held)
    for (const n of h.notes) {
      const at = h.region.start + n.t;
      if (at < start || at >= stop) continue;
      // (bars are found by search: a song's meter may change)
      let lo = 0;
      let hi = out.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if ((out[mid] as StripBar).from <= at) lo = mid;
        else hi = mid - 1;
      }
      const b = out[lo] as StripBar;
      const q = Math.min(3, Math.floor(((at - b.from) / (b.to - b.from)) * 4));
      b.parts[q] = Math.max(b.parts[q] as number, n.v / 127);
    }
  return out;
}

// ---- gestures ----

/** A velocity after a drag of `dy` pixels (up is harder): a pixel a step and a bit, within 1 to 127. */
export const velocityDragged = (v0: number, dy: number): number =>
  Math.max(1, Math.min(127, Math.round(v0 - dy * 1.1)));

/** What a press that has moved turns out to be, on a lit step: its velocity (up and down), or erasing along the row. */
export function dragKind(dx: number, dy: number, threshold: number): 'velocity' | 'along' | null {
  if (Math.hypot(dx, dy) < threshold) return null;
  return Math.abs(dy) > Math.abs(dx) ? 'velocity' : 'along';
}

/** The steps between two of a row, both ends in: what a drag crossed, in the order it crossed them. */
export function stepsBetween(a: number, b: number): number[] {
  const out: number[] = [];
  const by = b >= a ? 1 : -1;
  for (let i = a; i !== b + by; i += by) out.push(i);
  return out;
}

// ---- swing ----

/**
 * The swing a part has, as its off-steps are placed: the middle one's lateness, as a share of half a
 * step (0 to 0.75; 0 on a grid that doesn't swing, or with no off-steps lit).
 */
export function swingOf(rows: Iterable<readonly Cell[]>, steps: readonly Step[], size: number): number {
  if (!swings(size)) return 0;
  const late: number[] = [];
  for (const cells of rows)
    cells.forEach((cell, i) => {
      if (cell.notes.length && (steps[i] as Step).index % 2 === 1) late.push(cell.offset);
    });
  if (!late.length) return 0;
  late.sort((a, b) => a - b);
  const mid = late[late.length >> 1] as number;
  return Math.max(0, Math.min(MAX_SWING, mid / (size * 0.5)));
}

/** The swings the grid offers, as a drum machine's dial names them. */
export const SWINGS: readonly { amount: number; name: string }[] = [
  { amount: 0, name: 'Straight' },
  { amount: 0.16, name: 'A touch' },
  { amount: 0.33, name: 'Light' },
  { amount: 0.5, name: 'Medium' },
  { amount: 0.67, name: 'Triplet' },
  { amount: 0.75, name: 'Hard' },
];

/** The offered swing nearest an amount. */
export const swingNamed = (amount: number): { amount: number; name: string } =>
  SWINGS.reduce((best, s) => (Math.abs(s.amount - amount) < Math.abs(best.amount - amount) ? s : best));

// ---- what offers each edit ----

/** The studio's controls for each of the Step Grid's edits (`missingStepEdits` checks none is left out). */
export const STUDIO_STEP_EDITS: Readonly<Record<StepEditName, readonly string[]>> = {
  set: ['tap', 'drag along a row', 'Enter key', 'level menu', '1–4 keys'],
  clear: ['tap', 'drag along a row', 'Enter key', 'Delete key'],
  velocity: ['drag up or down', 'level menu', 'row menu'],
  fill: ['row menu'],
  euclid: ['row menu'],
  shift: ['row menu', 'page menu'],
  humanize: ['row menu', 'page menu'],
  copy: ['page menu'],
  swing: ['Swing menu'],
  'clear-row': ['row menu', 'page menu'],
  write: ['row menu'],
};

// ---- where the grid is ----

/** The page the grid shows, shared with its bar (which copies it, clears it, turns it). */
class StepView {
  /** The page's first tick (a bar line) and its bars; -1 before the grid has opened. */
  from = -1;
  bars = 1;
  private readonly heard = new Set<() => void>();
  subscribe = (fn: () => void): (() => void) => {
    this.heard.add(fn);
    return () => this.heard.delete(fn);
  };
  set(from: number, bars: number): void {
    if (from === this.from && bars === this.bars) return;
    this.from = from;
    this.bars = bars;
    for (const fn of this.heard) fn();
  }
}

export const stepView = new StepView();

/** The page's first tick, as it changes. */
export const useStepPage = (): number =>
  useSyncExternalStore(
    stepView.subscribe,
    () => stepView.from,
    () => stepView.from,
  );
