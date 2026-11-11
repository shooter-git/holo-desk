/**
 * A second reading of a page (a recognition engine's MusicXML) set beside the bars written into the
 * song from it: where they differ, the system is flagged, bar by bar, for you or the AI to look at.
 * Bars are matched in order: the engine's bars fill the page's systems as the bar lines found there
 * say, and each system's bars line up with the song's bars it was written as.
 */
import { noteName, type Project } from '@holo/session';
import type { Bar, ScoreDoc } from '../model.ts';
import { readMusicXml } from '../musicxml/read.ts';
import { notate } from '../notate.ts';
import type { ScanPage } from './model.ts';

/** A bar's notes, every part's: where each starts in the bar and its pitch, in order. */
export function barNotes(doc: ScoreDoc, bar: Bar): [number, number][] {
  const out: [number, number][] = [];
  for (const part of doc.parts) {
    for (const staff of part.staves) {
      for (const v of staff.bars[bar.index]?.voices ?? []) {
        for (const e of v.events) {
          if (e.kind !== 'chord' || e.grace) continue;
          for (const h of e.heads)
            if (h.tie !== 'm' && h.tie !== 't') out.push([Math.round(e.tick - bar.start), Math.round(h.pitch)]);
        }
      }
    }
  }
  return out.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

const say = (notes: [number, number][]) => {
  const names = notes.map(([, p]) => noteName(p));
  return names.length > 10 ? `${names.slice(0, 10).join(' ')} …` : names.join(' ') || 'rests';
};

/** Whether two bars hold the same notes: the same pitches, starting within a sixteenth of each other. */
export function sameBarNotes(a: [number, number][], b: [number, number][]): boolean {
  if (a.length !== b.length) return false;
  return a.every(([t, p], i) => {
    const [u, q] = b[i] as [number, number];
    return p === q && Math.abs(t - u) <= 240;
  });
}

/**
 * A reading's bars laid over a page's systems: in order, as many to each system as its bar lines
 * say (at least one), the first system's first. One list a system, in the page's order.
 */
export function pageBars(page: ScanPage, doc: ScoreDoc): Bar[][] {
  let next = 0;
  return page.systems.map((s) => {
    const count = Math.max(1, s.bars.length - 1);
    const bars = doc.bars.slice(next, next + count);
    next += count;
    return bars;
  });
}

/** The flags a page's systems get from an engine's reading of it: system k → what differs. */
export function compareReading(
  project: Project,
  page: ScanPage,
  musicXml: string,
  engine: string,
): Map<number, string[]> {
  const flags = new Map<number, string[]>();
  let theirs: ScoreDoc;
  try {
    theirs = notate(readMusicXml(musicXml).project);
  } catch (e) {
    for (const s of page.systems)
      flags.set(s.k, [`${engine}: couldn't read its own result (${e instanceof Error ? e.message : String(e)})`]);
    return flags;
  }
  const ours = notate(project);
  const laid = pageBars(page, theirs);
  for (const [i, s] of page.systems.entries()) {
    const mine = laid[i] ?? [];
    if (!s.written) continue;
    const list: string[] = [];
    for (let i = 0; i <= s.written[1] - s.written[0]; i++) {
      const number = s.written[0] + i;
      const songBar = ours.bars.find((b) => b.number === number);
      const engineBar = mine[i];
      if (!songBar) continue;
      if (!engineBar) {
        list.push(`${engine}: found no bar ${number} on the page`);
        continue;
      }
      const a = barNotes(ours, songBar);
      const b = barNotes(theirs, engineBar);
      if (!sameBarNotes(a, b)) list.push(`${engine} reads bar ${number} as ${say(b)} (the song has ${say(a)})`);
    }
    if (list.length) flags.set(s.k, list);
  }
  return flags;
}
