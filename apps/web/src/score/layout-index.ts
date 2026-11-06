/**
 * Where things landed on a drawn score: each bar's box (in its system) and where its notes and rests
 * sit across it, so a tick on the timeline is a place on the page (the playback cursor) and a place
 * clicked on the page is a tick.
 */
import type { Bar, ScoreDoc, ScoreEvent } from '@holo/score';

export interface PlacedBar {
  bar: Bar;
  /** Box in the page's own coordinates (CSS pixels from its top left). */
  left: number;
  right: number;
  top: number;
  bottom: number;
  /** [tick, x] through the bar: its start, every note and rest, its end. */
  points: [number, number][];
  /** Each staff's top and bottom line, by its number in the score. */
  staves: { n: number; top: number; bottom: number }[];
}

export interface ScoreIndex {
  bars: PlacedBar[];
}

/** The element a score event is drawn as: a lone note is drawn as the note, a chord as the chord. */
export function drawnId(e: ScoreEvent): string {
  return e.kind === 'chord' && e.heads.length === 1 ? (e.heads[0]?.id ?? e.id) : e.id;
}

export function buildIndex(page: HTMLElement, doc: ScoreDoc): ScoreIndex {
  const origin = page.getBoundingClientRect();
  const rel = (r: DOMRect) => ({
    left: r.left - origin.left,
    right: r.right - origin.left,
    top: r.top - origin.top,
    bottom: r.bottom - origin.top,
  });
  // every event's ticks, by bar
  const events = new Map<number, { tick: number; id: string }[]>();
  for (const part of doc.parts) {
    for (const staff of part.staves) {
      staff.bars.forEach((sb, b) => {
        const list = events.get(b) ?? [];
        for (const v of sb.voices)
          for (const e of v.events) if (!(e.kind === 'chord' && e.grace)) list.push({ tick: e.tick, id: drawnId(e) });
        events.set(b, list);
      });
    }
  }
  const bars: PlacedBar[] = [];
  for (const bar of doc.bars) {
    const el = page.querySelector<SVGGElement>(`[id="b${bar.index}"]`);
    if (!el) continue;
    const staves = el.querySelectorAll<SVGGElement>(':scope > g.staff');
    const box = rel(el.getBoundingClientRect());
    let top = box.top;
    let bottom = box.bottom;
    if (staves.length) {
      top = rel((staves[0] as SVGGElement).getBoundingClientRect()).top;
      bottom = rel((staves[staves.length - 1] as SVGGElement).getBoundingClientRect()).bottom;
    }
    // the staff lines themselves (a staff's box also holds its notes and ledger lines)
    const lines = [...staves].map((st, k) => {
      const paths = [...st.querySelectorAll<SVGPathElement>(':scope > path')];
      const ys = paths.map((p) => {
        const r = rel(p.getBoundingClientRect());
        return (r.top + r.bottom) / 2;
      });
      const box = rel(st.getBoundingClientRect());
      return { n: k + 1, top: ys.length ? Math.min(...ys) : box.top, bottom: ys.length ? Math.max(...ys) : box.bottom };
    });
    const xs = new Map<number, number>();
    for (const { tick, id } of events.get(bar.index) ?? []) {
      const node = page.querySelector<SVGGElement>(`[id="${id}"]`);
      if (!node) continue;
      const head = node.querySelector<SVGGElement>('g.notehead') ?? node;
      const x = rel(head.getBoundingClientRect()).left;
      const had = xs.get(tick);
      if (had === undefined || x < had) xs.set(tick, x);
    }
    const end = bar.start + bar.length;
    const inner = [...xs].filter(([t]) => t > bar.start && t < end).sort((a, b) => a[0] - b[0]);
    const first = xs.get(bar.start) ?? box.left + 12;
    bars.push({
      bar,
      left: box.left,
      right: box.right,
      top,
      bottom,
      points: [[bar.start, first], ...inner, [end, box.right]],
      staves: lines,
    });
  }
  return { bars };
}

/** Where a tick is on the page: x, and its bar's system top and bottom. */
export function placeOf(index: ScoreIndex, tick: number): { x: number; top: number; bottom: number } | null {
  const bars = index.bars;
  if (!bars.length) return null;
  let found = bars[0] as PlacedBar;
  for (const b of bars) {
    if (b.bar.start > tick) break;
    found = b;
  }
  const pts = found.points;
  let x = (pts[0] as [number, number])[1];
  for (let i = 0; i + 1 < pts.length; i++) {
    const [t0, x0] = pts[i] as [number, number];
    const [t1, x1] = pts[i + 1] as [number, number];
    if (tick >= t0 && tick <= t1) {
      x = t1 === t0 ? x0 : x0 + ((tick - t0) / (t1 - t0)) * (x1 - x0);
      break;
    }
    if (tick > t1) x = x1;
  }
  return { x, top: found.top, bottom: found.bottom };
}

/** The tick at a place on the page (in the bar there), or null off the music. */
export function tickAt(index: ScoreIndex, x: number, y: number): number | null {
  const bar = index.bars.find((b) => x >= b.left && x <= b.right && y >= b.top - 24 && y <= b.bottom + 24);
  if (!bar) return null;
  const pts = bar.points;
  for (let i = 0; i + 1 < pts.length; i++) {
    const [t0, x0] = pts[i] as [number, number];
    const [t1, x1] = pts[i + 1] as [number, number];
    if (x >= x0 && x <= x1) return Math.round(x1 === x0 ? t0 : t0 + ((x - x0) / (x1 - x0)) * (t1 - t0));
  }
  return x < (pts[0] as [number, number])[1] ? bar.bar.start : bar.bar.start + bar.bar.length;
}
