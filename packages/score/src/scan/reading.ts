/**
 * A scan read with the recognition engines, for when there's no AI to read it. Each page's engine
 * reading is laid over the page's systems as the comparison with the engines lays it (the engine's
 * bars fill the systems in order, as many to each as its bar lines say), and every system not read
 * yet becomes score text for its bars, numbered on from the last bar the scan has written, as the
 * AI's reading numbers them. That text goes into the song through `writeScoreText`, as one change,
 * and the systems it filled are marked read.
 *
 * Where two or more engines read a page, the one that agrees most with the others is used. Two
 * engines agree with each other equally, so then it's the one whose bar count fits the page's bar
 * lines, then the one that found more notes. Where the others read the systems written differently,
 * the systems are flagged, as "Compare with the engines" flags them.
 *
 * The engine's parts go into the song's parts in order (all of them into the scan's part, when the
 * scan is for one), with a track added for each part the song lacks and staves added to a part that
 * needs more. Pitches are written as the song's part reads them, so a transposing part gets its
 * notes at the right pitch whatever the engine thought the page was for.
 */
import { applyOps, type MeterPoint, type Op, type Project, type Track } from '@holo/session';
import type { Bar, ScoreDoc } from '../model.ts';
import { readMusicXml } from '../musicxml/read.ts';
import { notate } from '../notate.ts';
import { scoreText } from '../text.ts';
import { writeScoreText } from '../write.ts';
import { barNotes, compareReading, pageBars, sameBarNotes } from './compare.ts';
import type { Scan, ScanPage, ScanSystem, SystemState } from './model.ts';

/** An engine's reading of one page: its MusicXML. */
export interface PageReading {
  /** The page's number in the scan (from 0). */
  page: number;
  engine: string;
  musicxml: string;
}

/** A system not yet read, as the engines read it: its bars as score text, numbered as the song's. */
export interface EngineSystem {
  page: number;
  /** The system's place on its page. */
  k: number;
  engine: string;
  /** The song's bars it goes into: [first, last]. */
  bars: [number, number];
  text: string;
}

export interface EngineReading {
  /** The systems not yet read, in the scan's order. */
  systems: EngineSystem[];
  /** What the bars need first: tracks for parts the song lacks, staves a part needs, the song's pickup. */
  setup: Op[];
  /** Each page read: the engine used, and the others that read it. */
  pages: { page: number; engine: string; others: string[] }[];
  /** What couldn't be read, and parts left out. */
  warnings: string[];
}

/** How far a system's reading has got after the engines' bars went in, as the scan's systems take it. */
export interface SystemUpdate {
  page: number;
  k: number;
  state: SystemState;
  written?: [number, number];
  flags?: string[];
}

export interface EngineWrite {
  /** The change to the song, to apply as one step with `label`. */
  ops: Op[];
  label: string;
  /** Each system written: read, or still new with what was refused. */
  systems: SystemUpdate[];
  /** The scan with those systems updated. */
  scan: Scan;
  /** Bar numbers written, and bars refused (with why). */
  written: number[];
  errors: string[];
  warnings: string[];
}

interface Parsed {
  engine: string;
  project: Project;
  doc: ScoreDoc;
}

const unread = (s: ScanSystem) => s.state === 'new';

/** How many notes a reading found: an engine that missed some finds fewer. */
function noteCount(doc: ScoreDoc): number {
  let n = 0;
  for (const part of doc.parts)
    for (const staff of part.staves)
      for (const bar of staff.bars) for (const v of bar.voices) for (const e of v.events) if (e.kind === 'chord') n++;
  return n;
}

/** The reading to write a page from: the one that agrees most with the others, then fits the page best. */
function choose(page: ScanPage, parsed: Parsed[]): Parsed {
  if (parsed.length === 1) return parsed[0] as Parsed;
  const laid = parsed.map((p) => pageBars(page, p.doc));
  const expected = page.systems.reduce((n, s) => n + Math.max(1, s.bars.length - 1), 0);
  const ranked = parsed.map((p, i) => {
    let agree = 0;
    parsed.forEach((q, j) => {
      if (j === i) return;
      (laid[i] as Bar[][]).forEach((bars, s) => {
        bars.forEach((bar, b) => {
          const other = laid[j]?.[s]?.[b];
          if (other && sameBarNotes(barNotes(p.doc, bar), barNotes(q.doc, other))) agree++;
        });
      });
    });
    return { p, i, agree, off: Math.abs(p.doc.bars.length - expected), notes: noteCount(p.doc) };
  });
  ranked.sort((a, b) => b.agree - a.agree || a.off - b.off || b.notes - a.notes || a.i - b.i);
  return (ranked[0] as { p: Parsed }).p;
}

/**
 * Each system not yet read, as the engines read it: score text for its bars, numbered on from the
 * last bar the scan has written (bar 1 when it has written none), and what the song needs first.
 */
export function readScanWithEngines(project: Project, scan: Scan, readings: readonly PageReading[]): EngineReading {
  const warnings: string[] = [];
  const systems: EngineSystem[] = [];
  const pages: EngineReading['pages'] = [];
  const setup: Op[] = [];
  if (!scan.pages.some((p) => p.systems.some(unread))) return { systems, setup, pages, warnings };

  const song = notate(project);
  const parts = song.parts;
  // the next bar to write, as `holo scan show` says it: after the last the scan has written
  let next = 1;
  let started = false;
  for (const p of scan.pages)
    for (const s of p.systems) {
      if (!s.written) continue;
      started = true;
      next = Math.max(next, s.written[1] + 1);
    }

  // the engine's parts, by their place on the page, into the song's: one part for a scan of one part
  const forPart = scan.track ? parts.findIndex((p) => p.track === scan.track) : -1;
  if (scan.track && forPart < 0) warnings.push(`the scan's part isn't on the score: the parts are written in order`);
  const added: Track[] = [];
  const widened = new Map<string, number>();
  const target = (i: number, engineTrack: Track): number | null => {
    if (forPart >= 0) return i === 0 ? forPart : null;
    if (i < parts.length) return i;
    // a part the song lacks: a track for it, as the engine read it, added once
    while (parts.length + added.length <= i) {
      const track: Track = { ...engineTrack, regions: [] };
      added.push(track);
      setup.push({ op: 'addTrack', track });
    }
    return i;
  };
  const trackAt = (j: number): Track | undefined => {
    const part = parts[j];
    return part ? project.tracks.find((t) => t.id === part.track) : added[j - parts.length];
  };
  let leftOut = 0;

  for (const page of scan.pages) {
    if (!page.systems.some(unread)) continue;
    const parsed: Parsed[] = [];
    for (const r of readings) {
      if (r.page !== page.n || !r.musicxml) continue;
      try {
        const read = readMusicXml(r.musicxml).project;
        parsed.push({ engine: r.engine, project: read, doc: notate(read) });
      } catch (e) {
        warnings.push(
          `page ${page.n + 1}: ${r.engine}'s reading couldn't be read (${e instanceof Error ? e.message : String(e)})`,
        );
      }
    }
    if (!parsed.length) {
      warnings.push(`page ${page.n + 1}: no engine has read it`);
      continue;
    }
    const chosen = choose(page, parsed);
    pages.push({
      page: page.n,
      engine: chosen.engine,
      others: parsed.filter((p) => p !== chosen).map((p) => p.engine),
    });

    // the engine's parts as the song's parts they go into: their names, sounds and transpositions
    const reading = chosen.project;
    const map: number[] = [];
    const kept: Track[] = [];
    reading.tracks
      .filter((t) => t.kind === 'instrument' && !t.score?.hidden)
      .forEach((t, i) => {
        const j = target(i, t);
        if (j === null) {
          leftOut = Math.max(leftOut, i + 1);
          return;
        }
        const into = trackAt(j);
        const staves = Math.max(t.score?.staves ?? 1, parts[j]?.staves.length ?? 1);
        if (into && j < parts.length && (parts[j]?.staves.length ?? 1) < (t.score?.staves ?? 1)) {
          widened.set(into.id, Math.max(widened.get(into.id) ?? 1, t.score?.staves ?? 1));
        }
        if (into) {
          const { tr: _, ...score } = t.score ?? {};
          t.name = into.name;
          t.instrument = into.instrument;
          t.score = { ...score, ...(into.score?.tr ? { tr: into.score.tr } : {}), ...(staves > 1 ? { staves } : {}) };
        }
        map.push(j);
        kept.push(t);
      });
    reading.tracks = kept;

    // a pickup starts the song only when the scan's first bar starts it; elsewhere, its bar is a full one
    const pickup = reading.meter[0]?.pickup;
    const opening = !started && next === 1;
    if (pickup && !opening) {
      const { pickup: _, ...plain } = reading.meter[0] as MeterPoint;
      reading.meter = [plain, ...reading.meter.slice(1)];
    }
    const doc = notate(reading);
    const laid = pageBars(page, doc);

    page.systems.forEach((s, index) => {
      if (!unread(s)) return;
      const bars = laid[index] ?? [];
      if (!bars.length) {
        warnings.push(`page ${page.n + 1}, system ${s.k + 1}: ${chosen.engine} found no bars for it`);
        return;
      }
      // the engine's bar numbers as the song's (a bar split by a repeat keeps one number)
      const numbers = new Map<number, number>();
      for (const b of bars) {
        if (numbers.has(b.number)) continue;
        if (b.number === 0 && b.index === 0 && pickup && opening) numbers.set(0, 0);
        else numbers.set(b.number, next++);
      }
      const first = bars[0] as Bar;
      const last = bars[bars.length - 1] as Bar;
      const numbered = [...numbers.values()];
      systems.push({
        page: page.n,
        k: s.k,
        engine: chosen.engine,
        bars: [Math.min(...numbered), Math.max(...numbered)],
        text: textOf(doc, first.index, last.index + 1, numbers, map),
      });
      started = true;
    });

    // the song's pickup, when the engine's first bar is one and it opens the song: its time with it, as
    // a bar header can't change the time inside the pickup's bar
    if (pickup && opening && systems.some((x) => x.page === page.n && x.bars[0] === 0)) {
      const m = reading.meter[0] as MeterPoint;
      const now = project.meter[0];
      if (!now || now.pickup !== pickup || now.num !== m.num || now.den !== m.den) {
        const { pickup: _, tick: __, ...rest } = m;
        setup.push({
          op: 'setProject',
          patch: { meter: [{ ...rest, tick: 0, pickup }, ...project.meter.filter((x) => x.tick > 0)] },
        });
      }
    }
  }

  for (const [id, staves] of widened) {
    const track = project.tracks.find((t) => t.id === id);
    if (track) setup.push({ op: 'updateTrack', track: id, patch: { score: { ...track.score, staves } } });
  }
  if (leftOut > 1) {
    warnings.push(`the engines read ${leftOut} parts; the scan is for one, so only the first is written`);
  }
  return { systems, setup, pages, warnings };
}

/** The bars [from, to) as score text: numbered as the song's, each engine part as the song's part it goes into. */
function textOf(doc: ScoreDoc, from: number, to: number, numbers: Map<number, number>, parts: number[]): string {
  const lines = scoreText(doc, { from, to }).split('\n');
  const start = lines.findIndex((l) => /^bar\s/.test(l));
  return lines
    .slice(Math.max(0, start))
    .map((line) => {
      const bar = /^bar (\d+)(.*)$/.exec(line);
      if (bar) {
        const n = numbers.get(Number(bar[1])) ?? Number(bar[1]);
        // a pickup is only the song's own first bar
        const rest = n === 0 ? (bar[2] as string) : (bar[2] as string).replace(/\s+pickup\b/, '');
        return `bar ${n}${rest}`;
      }
      return line.replace(
        /^(\s*(?:clef\s+|lyrics\s+)?)P(\d+)\b/,
        (_, head: string, p: string) => `${head}P${(parts[Number(p) - 1] ?? Number(p) - 1) + 1}`,
      );
    })
    .join('\n');
}

/** The scan with its systems' reading moved on. */
function updated(scan: Scan, updates: readonly SystemUpdate[]): Scan {
  return {
    ...scan,
    pages: scan.pages.map((p) => ({
      ...p,
      systems: p.systems.map((s) => {
        const u = updates.find((x) => x.page === p.n && x.k === s.k);
        if (!u) return s;
        const { flags: _, written: __, ...rest } = s;
        return {
          ...rest,
          state: u.state,
          ...(u.written ? { written: u.written } : s.written ? { written: s.written } : {}),
          ...(u.flags?.length ? { flags: u.flags } : {}),
        };
      }),
    })),
  };
}

/**
 * The engines' reading as one change to the song: the setup, then every system's bars through
 * `writeScoreText`. Each system written whole is read; one with bars refused stays new, flagged with
 * why. With the engines' readings given, where the others read a system differently, it's flagged.
 */
export function engineReadingOps(
  project: Project,
  scan: Scan,
  reading: EngineReading,
  readings: readonly PageReading[] = [],
): EngineWrite {
  if (!reading.systems.length)
    return { ops: [], label: '', systems: [], scan, written: [], errors: [], warnings: reading.warnings };
  const work = reading.setup.length ? applyOps(project, reading.setup) : project;
  const result = writeScoreText(work, reading.systems.map((s) => s.text).join('\n'));
  const ops = [...reading.setup, ...result.ops];
  const systems = reading.systems.map((s): SystemUpdate => {
    const [a, b] = s.bars;
    const done = result.written.filter((n) => n >= a && n <= b);
    const refused = result.errors.filter((e) => {
      const m = /^bar (\d+)/.exec(e);
      return m && Number(m[1]) >= a && Number(m[1]) <= b;
    });
    const u: SystemUpdate = { page: s.page, k: s.k, state: done.length && !refused.length ? 'read' : 'new' };
    if (done.length) u.written = [Math.min(...done), Math.max(...done)];
    if (refused.length) u.flags = refused;
    return u;
  });
  let next = updated(scan, systems);
  // where the other engines read the systems just written differently
  if (readings.length && ops.length) {
    const after = applyOps(project, ops);
    for (const { page, others } of reading.pages) {
      const p = next.pages.find((x) => x.n === page);
      if (!p) continue;
      for (const engine of others) {
        const xml = readings.find((r) => r.page === page && r.engine === engine)?.musicxml;
        if (!xml) continue;
        for (const [k, list] of compareReading(after, p, xml, engine)) {
          const u = systems.find((x) => x.page === page && x.k === k);
          if (u) u.flags = [...(u.flags ?? []), ...list];
        }
      }
    }
    next = updated(scan, systems);
  }
  const written = result.written;
  const engines = [...new Set(reading.systems.map((s) => s.engine))].join(' and ');
  const range = written.length
    ? written.length === 1
      ? `bar ${written[0]}`
      : `bars ${Math.min(...written)}–${Math.max(...written)}`
    : 'no bars';
  return {
    ops,
    label: `Scan: ${range}, read by ${engines}`,
    systems,
    scan: next,
    written,
    errors: result.errors,
    warnings: [...reading.warnings, ...result.warnings],
  };
}
