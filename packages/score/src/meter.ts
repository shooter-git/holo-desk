/**
 * How a bar is felt: its beats and the groups they join into, and how strong each place in the bar
 * is. Rhythms are written so a note never hides a stronger place than the one it starts on.
 */
import { type MeterPoint, PPQ } from '@holo/session';

export interface Beats {
  /** Ticks in a full bar. */
  bar: number;
  /** The beat: a quarter in 4/4, a dotted quarter in 6/8. */
  beat: number;
  /** Groups the bar is felt in (half bars in 4/4, 3+3+2 eighths…), in ticks, summing to the bar. */
  groups: number[];
  /** Beats divide in three (6/8, 9/8, 12/8). */
  compound: boolean;
}

export function beatsOf(m: Pick<MeterPoint, 'num' | 'den' | 'groups'>): Beats {
  const unit = (PPQ * 4) / m.den;
  const bar = m.num * unit;
  const compound = m.den >= 8 && m.num % 3 === 0 && m.num > 3;
  const oneBeat = m.den >= 8 && m.num === 3;
  const beat = compound ? unit * 3 : oneBeat ? bar : unit;
  let groups: number[];
  const given = m.groups?.map((g) => g * (PPQ / 2));
  if (given?.length && given.reduce((a, b) => a + b, 0) === bar) groups = given;
  else if ((m.num === 4 && m.den === 4) || (m.num === 4 && m.den === 2)) groups = [bar / 2, bar / 2];
  else if (m.den === 8 && m.num === 5) groups = [unit * 3, unit * 2];
  else if (m.den === 8 && m.num === 7) groups = [unit * 2, unit * 2, unit * 3];
  else groups = Array.from({ length: Math.max(1, Math.round(bar / beat)) }, () => beat);
  return { bar, beat, groups, compound };
}

/** Strengths of the places in a bar: the bar line, group starts, beats, then each finer division. */
export const STRONG = { bar: 100, group: 80, beat: 60 } as const;

/**
 * How strong a place in the bar is (0 at the start of the bar's own timeline, so a pickup or the
 * second half of a split bar passes its offset). Finer divisions of the beat are weaker: halves
 * (thirds in compound time) 40, then 30, 20, 10; anything off those 0.
 */
export function strength(b: Beats, at: number): number {
  const t = ((at % b.bar) + b.bar) % b.bar;
  if (t === 0) return STRONG.bar;
  let g = 0;
  for (const len of b.groups) {
    g += len;
    if (g === t) return STRONG.group;
  }
  if (t % b.beat === 0) return STRONG.beat;
  const first = b.compound ? b.beat / 3 : b.beat / 2;
  let unit = first;
  for (const s of [40, 30, 20, 10]) {
    if (Number.isInteger(t / unit) && Math.abs(t / unit - Math.round(t / unit)) < 1e-9) return s;
    unit /= 2;
  }
  return 0;
}

/** Where beats start in a bar (ticks from the bar's own start). */
export function beatStarts(b: Beats): number[] {
  const out: number[] = [];
  for (let t = 0; t < b.bar; t += b.beat) out.push(t);
  return out;
}

/** Where groups start in a bar. */
export function groupStarts(b: Beats): number[] {
  const out: number[] = [];
  let t = 0;
  for (const g of b.groups) {
    out.push(t);
    t += g;
  }
  return out;
}
