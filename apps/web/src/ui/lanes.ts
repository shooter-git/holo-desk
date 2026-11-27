/**
 * The Arrangement and Chords lanes' arithmetic, with no screen in it: what's under a point, where a
 * dragged section may land, where a marker's line may go, which beat a chord is typed at.
 */
import type { Section } from '@holo/agent/edits';
import { type ChordMark, type MeterPoint, meterAt, ticksPerBar, ticksPerBeat } from '@holo/session';

/** A lane's height: a mouse's, and a finger's. */
export const LANE = 24;
export const LANE_TOUCH = 30;

/** What View has on, as the lanes' heights from the top: the Arrangement lane first. */
export interface LaneRows {
  arrangement: boolean;
  chords: boolean;
  /** One lane's height. */
  row: number;
}

export const lanesHeight = (rows: LaneRows): number => (Number(rows.arrangement) + Number(rows.chords)) * rows.row;

/** The lane at a height in the box. */
export function laneAt(rows: LaneRows, y: number): 'arrangement' | 'chords' | null {
  if (y < 0 || y >= lanesHeight(rows)) return null;
  if (rows.arrangement && y < rows.row) return 'arrangement';
  return rows.chords ? 'chords' : null;
}

/** The colours sections take, by name: two sections with one name (a theme that comes back) share theirs. */
export const SECTION_COLORS = ['#7c8a99', '#a987d6', '#4fb89a', '#d6a14f', '#d66f8a', '#5aa3d6', '#8fbf5a', '#d68a5a'];

/** A section's name without a number at its end: "Verse 2" is a Verse. */
const family = (name: string): string =>
  name
    .trim()
    .toLowerCase()
    .replace(/\s*#?\d+$/, '');

export function sectionColor(list: readonly Section[], section: Section): string {
  if (!section.name) return '#4a5260';
  const names = [...new Set(list.filter((s) => s.name).map((s) => family(s.name)))];
  return SECTION_COLORS[names.indexOf(family(section.name)) % SECTION_COLORS.length] as string;
}

/** The section a tick is in. */
export function sectionAt(list: readonly Section[], tick: number): Section | null {
  return list.find((s) => tick >= s.from && tick < s.to) ?? null;
}

/**
 * The marker line near a tick: the start of a section other than the song's own (a line at 0 isn't
 * one to drag), within `slop` ticks.
 */
export function edgeAt(list: readonly Section[], tick: number, slop: number): Section | null {
  let best: Section | null = null;
  for (const s of list) {
    if (!s.marker || s.from === 0) continue;
    if (Math.abs(s.from - tick) <= slop && (!best || Math.abs(s.from - tick) < Math.abs(best.from - tick))) best = s;
  }
  return best;
}

/** The bar line nearest a tick. */
export function nearestBar(meter: readonly MeterPoint[], tick: number): number {
  const m = meterAt(meter, Math.max(0, tick));
  const bar = ticksPerBar(m);
  return Math.max(0, m.tick + Math.round((Math.max(0, tick) - m.tick) / bar) * bar);
}

/** The bar line at or before a tick. */
export function barStart(meter: readonly MeterPoint[], tick: number): number {
  const m = meterAt(meter, Math.max(0, tick));
  const bar = ticksPerBar(m);
  return m.tick + Math.floor((Math.max(0, tick) - m.tick) / bar) * bar;
}

/** The beat at or before a tick (where a chord is typed). */
export function beatStart(meter: readonly MeterPoint[], tick: number): number {
  const m = meterAt(meter, Math.max(0, tick));
  const beat = ticksPerBeat(m);
  return m.tick + Math.floor((Math.max(0, tick) - m.tick) / beat) * beat;
}

/**
 * Where a marker's line may be dragged to: the bar line nearest the pointer, at least a bar after
 * the section before it starts and a bar before its own ends (two markers never meet).
 */
export function edgePlace(
  list: readonly Section[],
  section: Section,
  meter: readonly MeterPoint[],
  tick: number,
): number {
  const i = list.indexOf(section);
  const before = list[i - 1];
  const lo = (before ? before.from : 0) + ticksPerBar(meterAt(meter, before ? before.from : 0));
  const hi = section.to - ticksPerBar(meterAt(meter, Math.max(0, section.to - 1)));
  const at = nearestBar(meter, tick);
  return Math.max(Math.min(lo, hi), Math.min(hi, Math.max(lo, at)));
}

/**
 * Where a dragged section lands: the section boundary nearest the pointer that isn't inside it.
 * Null where that's where it is already (its own start or end), so letting go there moves nothing.
 */
export function dropPlace(list: readonly Section[], section: Section, tick: number): number | null {
  const last = list[list.length - 1];
  const lines = [...new Set([...list.map((s) => s.from), ...(last ? [last.to] : [])])].filter(
    (t) => t <= section.from || t >= section.to,
  );
  let best: number | null = null;
  for (const t of lines) if (best === null || Math.abs(t - tick) < Math.abs(best - tick)) best = t;
  return best === null || best === section.from || best === section.to ? null : best;
}

/** About how wide a chord's symbol is drawn, pixels. */
export const chordWidth = (symbol: string): number => Math.max(22, symbol.length * 7.2 + 12);

/** The chord whose symbol is under a point: the last one starting at or before it, if its symbol reaches that far. */
export function chordAt(chords: readonly ChordMark[], tick: number, pxPerTick: number): ChordMark | null {
  let found: ChordMark | null = null;
  for (const c of chords) if (c.tick <= tick && (!found || c.tick >= found.tick)) found = c;
  return found && (tick - found.tick) * pxPerTick <= chordWidth(found.symbol) ? found : null;
}

/** The chords that have room to be drawn at this zoom: each needs its symbol's width before the next one drawn. */
export function chordsShown(chords: readonly ChordMark[], pxPerTick: number): ChordMark[] {
  const sorted = [...chords].sort((a, b) => a.tick - b.tick);
  const out: ChordMark[] = [];
  let free = Number.NEGATIVE_INFINITY;
  for (const c of sorted) {
    const x = c.tick * pxPerTick;
    if (x < free) continue;
    out.push(c);
    free = x + chordWidth(c.symbol);
  }
  return out;
}
