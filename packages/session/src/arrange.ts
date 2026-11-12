/**
 * Arranging: bars inserted, deleted, copied or moved across the whole song at once (the `arrange`
 * operation). Every edit is a list of passes, as a repeat's are (form.ts): stretches of the song as
 * it is, [from, to), each placed somewhere in the song as it will be. An insert leaves a gap between
 * two passes, a delete leaves a stretch out, a copy plays one stretch twice, a move plays them in
 * another order. Everything with a time goes through the same passes: regions and their notes,
 * controller lanes and marks, automation, tempo, meter, keys, markers, chords, the cycle and the loop,
 * repeats and jumps, the score's breaks and clefs, and a Performance instrument's dynamics.
 *
 * What it keeps:
 * - A region inside one pass moves whole, with its id. One that a pass boundary cuts goes in pieces
 *   (form.ts's cutRegion), except that a MIDI region stays one region where the song only opens up
 *   (an insert: its later notes move on) or closes up (a delete: what was in the bars goes), so it
 *   keeps its id. Pieces of a recording that end up side by side, playing on exactly where the other
 *   stopped, are one region again.
 * - Automation and dynamics hold their value through inserted bars, and keep their shape on both
 *   sides of a cut; a point a seam leaves that changes nothing goes.
 * - So inserting bars and deleting them again gives the song back as it was.
 *
 * It's applied where the song is (the studio, or the server without one), as one operation: the song
 * it works on is never an old copy.
 */
import { automationAt, automationTargets } from './automation.ts';
import { newId } from './defaults.ts';
import { cutMeter, cutRange, cutRegion, EDGE, type Pass } from './form.ts';
import { textForKeys } from './keysig.ts';
import { OpError } from './ops.ts';
import { barToTick, meterAt, ticksPerBar, tickToBarBeat, tickToSeconds } from './time.ts';
import type {
  AutomationLane,
  CCPoint,
  Channel,
  Cycle,
  FormMark,
  KeyPoint,
  Loop,
  Mark,
  MeterPoint,
  Project,
  Region,
  TempoPoint,
  Track,
} from './types.ts';

export type ArrangeEdit = 'insert' | 'delete' | 'copy' | 'move';

/**
 * insert: empty bars [from, to), what was at `from` on moving to `to`. delete: [from, to) taken out.
 * copy: [from, to) played again at `at`, what was there moving on. move: [from, to) taken to `at`.
 * Every position on a bar line (ticks).
 */
export interface Arrangement {
  edit: ArrangeEdit;
  from: number;
  to: number;
  at?: number;
}

/** A pass of an edit: `copy` marks the bars a copy adds, `moved` the bars a move takes elsewhere. */
interface Span extends Pass {
  kind?: 'copy' | 'moved';
}

const INF = Number.POSITIVE_INFINITY;
const len = (p: Span) => p.to - p.from;

// ---- the edit as passes ----

/** Whether a tick is on a bar line. */
export function onBarLine(meter: readonly MeterPoint[], tick: number): boolean {
  return tick === 0 || barToTick(meter, tickToBarBeat(meter, tick).bar) === tick;
}

/** The meter new bars inserted at a tick are in: the one playing just before it. */
export function meterBefore(meter: readonly MeterPoint[], tick: number): MeterPoint {
  return meterAt(meter, Math.max(0, tick - 1));
}

const where = (project: Project, tick: number) => {
  const p = tickToBarBeat(project.meter, tick);
  return `${p.bar}.${p.beat}.${p.div}${p.tick ? `.${p.tick}` : ''}`;
};

function check(project: Project, e: Arrangement): void {
  const { edit, from, to, at } = e;
  if (!['insert', 'delete', 'copy', 'move'].includes(edit))
    throw new OpError(`arrange: "edit" is insert, delete, copy or move (got ${JSON.stringify(edit)})`);
  for (const [k, v] of [['from', from], ['to', to], ...(edit === 'copy' || edit === 'move' ? [['at', at]] : [])] as [
    string,
    unknown,
  ][]) {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0)
      throw new OpError(`arrange: "${k}" is a tick, a whole number from 0`);
  }
  if (to <= from) throw new OpError('arrange: "to" comes after "from"');
  const meter = project.meter;
  const bar = (k: string, tick: number) => {
    if (!onBarLine(meter, tick))
      throw new OpError(`arrange: "${k}" (${where(project, tick)}) isn't on a bar line: whole bars only`);
  };
  bar('from', from);
  if (edit === 'insert') {
    const m = meterBefore(meter, from);
    if ((to - from) % ticksPerBar(m) !== 0)
      throw new OpError(
        `arrange: an insert is whole bars of the ${m.num}/${m.den} before it (${ticksPerBar(m)} ticks each)`,
      );
  } else bar('to', to);
  if (edit === 'copy' || edit === 'move') bar('at', at as number);
  if (edit === 'move' && (at as number) > from && (at as number) < to)
    throw new OpError('arrange: bars can’t move inside themselves');
  if (edit === 'move' && (at === from || at === to)) throw new OpError('arrange: those bars are there already');
  if (meter[0]?.pickup && (from === 0 || at === 0))
    throw new OpError('arrange: the pickup bar stays where it is, first: start after it');
}

function spans(e: Arrangement): Span[] {
  const { from, to } = e;
  const n = to - from;
  const x = e.at ?? 0;
  const list: Span[] =
    e.edit === 'insert'
      ? [
          { from: 0, to: from, at: 0, n: 1 },
          { from, to: INF, at: to, n: 1 },
        ]
      : e.edit === 'delete'
        ? [
            { from: 0, to: from, at: 0, n: 1 },
            { from: to, to: INF, at: from, n: 1 },
          ]
        : e.edit === 'copy'
          ? [
              { from: 0, to: x, at: 0, n: 1 },
              { from, to, at: x, n: 2, kind: 'copy' },
              { from: x, to: INF, at: x + n, n: 1 },
            ]
          : x < from
            ? [
                { from: 0, to: x, at: 0, n: 1 },
                { from, to, at: x, n: 1, kind: 'moved' },
                { from: x, to: from, at: x + n, n: 1 },
                { from: to, to: INF, at: to, n: 1 },
              ]
            : [
                { from: 0, to: from, at: 0, n: 1 },
                { from: to, to: x, at: from, n: 1 },
                { from, to, at: x - n, n: 1, kind: 'moved' },
                { from: x, to: INF, at: x, n: 1 },
              ];
  return list.filter((p) => p.to > p.from);
}

/**
 * Two passes, one after the other in the new song, are one stretch of music opened up (an insert's
 * gap: the old song runs on) or closed up (a delete: the new song runs on). A copy's or a move's own
 * bars are always a stretch of their own.
 */
function joins(p: Span, q: Span): boolean {
  if (p.kind || q.kind || q.from < p.to || q.at < p.at + len(p)) return false;
  return q.from === p.to || q.at === p.at + len(p);
}

/** Where a tick of the song as it is goes: every place (a copy plays some twice), in order. */
function startsAt(map: readonly Span[], tick: number): { at: number; i: number }[] {
  const out: { at: number; i: number }[] = [];
  map.forEach((p, i) => {
    if (tick >= p.from && tick < p.to) out.push({ at: p.at + (tick - p.from), i });
  });
  return out;
}

/** The same for a tick that ends something (a repeat sign at a bar line belongs to the bar before it). */
function endsAt(map: readonly Span[], tick: number): { at: number; i: number }[] {
  const out: { at: number; i: number }[] = [];
  map.forEach((p, i) => {
    if (tick > p.from && tick <= p.to) out.push({ at: p.at + (tick - p.from), i });
  });
  return out;
}

/**
 * Where something that starts in pass `i` ends, its end a tick of the song as it is: on through the
 * passes it runs on into; an end inside bars taken out comes back to where they were, one past the
 * stretch it's in stops there.
 */
function endAt(map: readonly Span[], i: number, end: number): number {
  for (let k = i; k < map.length; k++) {
    const p = map[k] as Span;
    if (end <= p.to) return p.at + (Math.max(end, p.from) - p.from);
    const q = map[k + 1];
    if (!q || !joins(p, q)) return p.at + len(p);
    if (end <= q.from) return q.at;
  }
  return end;
}

/** Where the new song's passes meet, where the old song didn't: the ticks a cut or a gap leaves. */
function seams(map: readonly Span[]): Set<number> {
  const out = new Set<number>();
  map.forEach((p, i) => {
    if (i > 0 || p.from > 0) out.add(p.at);
    if (p.to !== INF) out.add(p.at + len(p));
  });
  return out;
}

// ---- things at a tick ----

/**
 * A list of settings that each hold until the next (tempo, key signatures, a staff's clefs): each
 * pass starts with the one playing where it starts in the old song, unless that one is playing
 * already (or one starts right there).
 */
function mapSteps<T extends { tick: number }>(
  list: readonly T[],
  map: readonly Span[],
  same: (a: T, b: T) => boolean,
  place: (x: T, tick: number, i: number) => T = (x, tick) => ({ ...x, tick }),
): T[] {
  const sorted = [...list].sort((a, b) => a.tick - b.tick);
  const out: T[] = [];
  map.forEach((p, i) => {
    if (!sorted.some((x) => x.tick === p.from)) {
      let held: T | undefined;
      for (const x of sorted) if (x.tick < p.from) held = x;
      const last = out[out.length - 1];
      if (held && (!last || !same(last, held))) out.push(place(held, p.at, i));
    }
    for (const x of sorted) if (x.tick >= p.from && x.tick < p.to) out.push(place(x, p.at + (x.tick - p.from), i));
  });
  // (what started the song still does: inserted bars at the very start take it too)
  const first = out[0];
  if (sorted[0]?.tick === 0 && first && first.tick > 0) out[0] = { ...first, tick: 0 };
  return out;
}

/** Things that happen at a tick and are gone with their bars (markers, chords, breaks): copied with a copy. */
function mapMoments<T extends { tick: number }>(
  list: readonly T[],
  map: readonly Span[],
  copy: (x: T) => T = (x) => ({ ...x }),
): T[] {
  const out: { x: T; at: number; order: number }[] = [];
  list.forEach((x, order) => {
    for (const { at, i } of startsAt(map, x.tick)) {
      const placed = (map[i] as Span).kind === 'copy' ? copy(x) : { ...x };
      out.push({ x: { ...placed, tick: at }, at, order });
    }
  });
  return out.sort((a, b) => a.at - b.at || a.order - b.order).map((o) => o.x);
}

// ---- lanes (automation, dynamics) ----

interface LanePoint {
  t: number;
  v: number;
  added: boolean;
}

const near = (a: number, b: number) => Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));

/** A lane's value just before a tick (where a step or a jump at the tick hasn't happened yet). */
function valueBefore(
  points: readonly [number, number][],
  t: number,
  curve: AutomationLane['curve'],
  stepped: boolean,
): number {
  const i = points.findIndex((p) => p[0] >= t);
  if (i === 0) return (points[0] as [number, number])[1];
  if (i < 0) return (points[points.length - 1] as [number, number])[1];
  const [t0, v0] = points[i - 1] as [number, number];
  const [t1, v1] = points[i] as [number, number];
  if (stepped) return v0;
  if (t === t1) return v1;
  let u = (t - t0) / (t1 - t0);
  if (curve === 'smooth') u = 0.5 - 0.5 * Math.cos(Math.PI * u);
  return v0 + (v1 - v0) * u;
}

/** A point that changes nothing: the lane runs through it as it would without it. */
function redundant(list: readonly LanePoint[], i: number, curve: AutomationLane['curve'], stepped: boolean): boolean {
  const x = list[i] as LanePoint;
  const a = list[i - 1];
  const b = list[i + 1];
  if (a && a.t === x.t) return near(a.v, x.v);
  if (b && b.t === x.t) return near(b.v, x.v);
  if (!a && !b) return false;
  if (!a) return near((b as LanePoint).v, x.v);
  if (!b || stepped) return near(a.v, x.v);
  const v = automationAt(
    {
      points: [
        [a.t, a.v],
        [b.t, b.v],
      ],
      ...(curve ? { curve } : {}),
    },
    x.t,
  );
  return near(v as number, x.v);
}

/**
 * A lane through the passes: each pass's points where it goes, the value it starts and ends with
 * held at its edges (so inserted bars hold it, and each side of a cut keeps its shape), and then the
 * points at the seams that change nothing taken away.
 */
function mapLane(
  points: readonly [number, number][],
  map: readonly Span[],
  curve: AutomationLane['curve'],
  stepped: boolean,
): [number, number][] {
  if (!points.length) return [];
  const pts = [...points].sort((a, b) => a[0] - b[0]);
  const lane = { points: pts, ...(curve ? { curve } : {}) };
  const out: LanePoint[] = [];
  for (const p of map) {
    if (!pts.some(([t]) => t === p.from))
      out.push({ t: p.at, v: automationAt(lane, p.from, stepped) as number, added: true });
    for (const [t, v] of pts) if (t >= p.from && t < p.to) out.push({ t: p.at + (t - p.from), v, added: false });
    if (p.to !== INF && pts.some(([t]) => t >= p.to))
      out.push({ t: p.at + len(p), v: valueBefore(pts, p.to, curve, stepped), added: true });
  }
  const at = seams(map);
  for (let changed = true; changed; ) {
    changed = false;
    for (let i = 0; i < out.length; i++) {
      const x = out[i] as LanePoint;
      if ((x.added || at.has(x.t)) && redundant(out, i, curve, stepped)) {
        out.splice(i, 1);
        i--;
        changed = true;
      }
    }
  }
  return out.map((x): [number, number] => [x.t, x.v]);
}

function mapChannel(project: Project, c: Channel, map: readonly Span[]): Channel {
  if (!c.automation?.length) return c;
  const targets = automationTargets(project, c);
  return {
    ...c,
    automation: c.automation.map((lane) => {
      const stepped = targets.find((x) => x.param === lane.param)?.stepped ?? lane.param === 'mute';
      return { ...lane, points: mapLane(lane.points, map, lane.curve, stepped) };
    }),
  };
}

// ---- regions ----

interface Piece {
  /** The stretch of the old song it holds, and where it starts in the new. */
  a: number;
  b: number;
  at: number;
  /** Its pass. */
  i: number;
}

/**
 * A MIDI region's pieces kept as one region, through the bars opened up or closed up between them:
 * its notes, controller points and marks where their ticks go (a note keeps its length; a controller
 * lane starts each piece with the value it had there, when that changes it).
 */
function joinRegion(r: Region, run: readonly Piece[], id: string): Region {
  const s = r.start;
  const end = s + r.length;
  const first = run[0] as Piece;
  const last = run[run.length - 1] as Piece;
  const start = first.at;
  const lo = (k: number) => (k === 0 && first.a === s ? Number.NEGATIVE_INFINITY : (run[k] as Piece).a);
  const hi = (k: number) => (k === run.length - 1 && last.b === end ? INF : (run[k] as Piece).b);
  /** A tick of the song as it is (something starting), relative to the new region; null where it's gone. */
  const place = (tick: number): number | null => {
    for (let k = 0; k < run.length; k++) {
      const p = run[k] as Piece;
      if (tick >= lo(k) && tick < hi(k)) return p.at + (tick - p.a) - start;
    }
    return null;
  };
  /** A tick that ends something. */
  const placeEnd = (tick: number): number => {
    for (let k = 0; k < run.length; k++) {
      const p = run[k] as Piece;
      if (tick <= hi(k))
        return (k === 0 && lo(0) < 0 ? p.at + (tick - p.a) : p.at + (Math.max(tick, p.a) - p.a)) - start;
    }
    return last.at + (last.b - last.a) - start;
  };
  const notes = r.notes.flatMap((n) => {
    const t = place(s + n.t);
    return t === null ? [] : [{ ...n, t }];
  });
  const cc: Region['cc'] = {};
  for (const [lane, pts] of Object.entries(r.cc)) {
    const out: CCPoint[] = [];
    run.forEach((p, k) => {
      if (Number.isFinite(lo(k)) && !pts.some(([t]) => s + t === p.a)) {
        let held: CCPoint | undefined;
        for (const pt of pts) if (s + pt[0] < p.a && (!held || pt[0] >= held[0])) held = pt;
        const prev = out[out.length - 1];
        if (held && (!prev || prev[1] !== held[1])) out.push([p.at - start, held[1]]);
      }
      for (const [t, v] of pts) if (s + t >= lo(k) && s + t < hi(k)) out.push([p.at + (s + t - p.a) - start, v]);
    });
    cc[lane] = out;
  }
  const next: Region = {
    ...r,
    id,
    start,
    length: last.at + (last.b - last.a) - start,
    notes,
    cc,
  };
  const marks = (r.marks ?? []).flatMap((m): Mark[] => {
    const t = place(s + m.t);
    if (t === null) return [];
    return [{ ...m, t, ...(m.e !== undefined ? { e: Math.max(t, placeEnd(s + m.e)) } : {}) }];
  });
  if (marks.length) next.marks = marks;
  else delete next.marks;
  return next;
}

/** A region through the passes: whole (its id kept), in one piece or several, or gone. */
function mapRegion(project: Project, r: Region, map: readonly Span[]): Region[] {
  const s = r.start;
  const end = s + r.length;
  const pieces: Piece[] = [];
  map.forEach((p, i) => {
    const a = Math.max(p.from, s);
    const b = Math.min(p.to, end);
    if (b > a) pieces.push({ a, b, at: p.at + (a - p.from), i });
  });
  // the pieces that stay one region: a MIDI region's, where the song opens or closes up between them
  const runs: Piece[][] = [];
  for (const piece of pieces) {
    const run = runs[runs.length - 1];
    const prev = run?.[run.length - 1];
    const p = prev && (map[prev.i] as Span);
    const q = map[piece.i] as Span;
    if (run && prev && p && !r.audio && piece.i === prev.i + 1 && joins(p, q) && prev.b === p.to && piece.a === q.from)
      run.push(piece);
    else runs.push([piece]);
  }
  const copyOf = (run: Piece[]) => run.every((x) => (map[x.i] as Span).kind === 'copy');
  // its id stays with the piece its start is in (not a copy's), else the first that isn't a copy
  const home =
    runs.find((run) => !copyOf(run) && run[0]?.a === s) ?? runs.find((run) => !copyOf(run)) ?? runs[0] ?? null;
  return runs.map((run) => {
    const id = run === home ? r.id : newId('rgn');
    const only = run[0] as Piece;
    if (run.length === 1 && only.a === s && only.b === end) {
      if (id === r.id) return only.at === s ? r : { ...r, start: only.at };
      return { ...structuredClone(r), id, start: only.at };
    }
    if (run.length > 1) return joinRegion(r, run, id);
    const p = map[only.i] as Span;
    const piece = cutRegion(r, p, { tempo: project.tempo, written: true }) as Region;
    return { ...piece, id };
  });
}

/**
 * Two pieces of one recording that end up side by side, the second playing on exactly where the
 * first stops (as an insert leaves them, once its bars are deleted again), are one region again.
 */
function heal(tempo: readonly TempoPoint[], regions: Region[], at: ReadonlySet<number>): Region[] {
  if (!at.size) return regions;
  const out = regions.slice();
  for (let i = 0; i < out.length; i++) {
    const l = out[i] as Region;
    const la = l.audio;
    if (!la || !at.has(l.start + l.length) || l.notes.length) continue;
    const j = out.findIndex((r) => {
      const ra = r.audio;
      if (!ra || r === l || r.start !== l.start + l.length || r.notes.length) return false;
      if (ra.file !== la.file || ra.gain !== la.gain || ra.stretch !== la.stretch) return false;
      if (r.muted !== l.muted || r.name !== l.name || r.color !== l.color) return false;
      if (la.fadeOut > EDGE + 1e-9 || ra.fadeIn > EDGE + 1e-9) return false;
      const played = (tickToSeconds(tempo, l.start + l.length) - tickToSeconds(tempo, l.start)) / la.stretch;
      return Math.abs(ra.offset - (la.offset + played)) < 1e-6;
    });
    if (j < 0) continue;
    const r = out[j] as Region;
    out[i] = {
      ...l,
      length: l.length + r.length,
      audio: { ...la, fadeOut: (r.audio as Region['audio'] & {}).fadeOut },
    };
    out.splice(j, 1);
    if (j < i) i--;
    i--;
  }
  return out;
}

/** Where pieces of one stretch of music meet again after bars between them went: where a recording may heal. */
function closed(map: readonly Span[]): Set<number> {
  const out = new Set<number>();
  for (let i = 1; i < map.length; i++) {
    const p = map[i - 1] as Span;
    const q = map[i] as Span;
    if (joins(p, q) && q.from > p.to) out.add(q.at);
  }
  return out;
}

function mapTrack(project: Project, t: Track, map: readonly Span[], heals: ReadonlySet<number>): Track {
  const regions = heal(
    project.tempo,
    t.regions.flatMap((r) => mapRegion(project, r, map)),
    heals,
  );
  const music = regions.length !== t.regions.length || regions.some((r, i) => r !== t.regions[i]);
  let next: Track = { ...t, regions, channel: mapChannel(project, t.channel, map) };
  if (music && next.origin && !next.origin.edited) next = { ...next, origin: { ...next.origin, edited: true } };
  const clefs = t.score?.clefs;
  if (clefs?.length && next.score) {
    const staves = [...new Set(clefs.map((c) => c[1]))];
    const moved = staves.flatMap((staff) =>
      mapSteps(
        clefs.filter((c) => c[1] === staff).map(([tick, st, clef]) => ({ tick, st, clef })),
        map,
        (a, b) => a.clef === b.clef,
      ).map((c): [number, number, string] => [c.tick, c.st, c.clef]),
    );
    next = { ...next, score: { ...next.score, clefs: moved.sort((a, b) => a[0] - b[0] || a[1] - b[1]) } };
  }
  const inst = t.instrument;
  if (inst.type === 'performance' && inst.play?.dyn?.length)
    next = {
      ...next,
      instrument: { ...inst, play: { ...inst.play, dyn: mapLane(inst.play.dyn, map, 'smooth', false) } },
    };
  return next;
}

// ---- the song ----

/** Repeat signs and jumps that sit at the end of the bar before their tick, not the start of the next. */
const ENDING: ReadonlySet<FormMark['k']> = new Set(['end', 'fine', 'toCoda', 'dc', 'ds']);

function mapForm(form: readonly FormMark[], map: readonly Span[]): FormMark[] {
  const out: FormMark[] = [];
  for (const f of form) {
    const ends = ENDING.has(f.k);
    let places = ends ? endsAt(map, f.tick) : startsAt(map, f.tick);
    if (!places.length) {
      // in bars taken out: it stays where they were, so the form around them still holds
      const next = ends
        ? [...map.keys()]
            .filter((i) => (map[i] as Span).to < f.tick)
            .sort((a, b) => (map[b] as Span).to - (map[a] as Span).to)[0]
        : [...map.keys()]
            .filter((i) => (map[i] as Span).from > f.tick)
            .sort((a, b) => (map[a] as Span).from - (map[b] as Span).from)[0];
      if (next === undefined) continue;
      const p = map[next] as Span;
      places = [{ at: ends ? p.at + len(p) : p.at, i: next }];
    }
    for (const { at, i } of places) {
      const moved: FormMark = { ...f, tick: at };
      if (f.e !== undefined) moved.e = Math.max(at, endAt(map, i, Math.max(f.e, f.tick)));
      out.push(moved);
    }
  }
  const seen = new Set<string>();
  return out
    .sort((a, b) => a.tick - b.tick)
    .filter((f) => {
      const key = JSON.stringify(f);
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function mapTempo(tempo: readonly TempoPoint[], map: readonly Span[]): TempoPoint[] {
  return mapSteps(
    tempo,
    map,
    (a, b) => a.bpm === b.bpm,
    (x, tick, i) => {
      const out: TempoPoint = { ...x, tick };
      if (x.ramp !== undefined) {
        const p = map[i] as Span;
        const end = x.ramp > p.from ? endAt(map, i, x.ramp) : tick;
        if (end > tick) out.ramp = end;
        else {
          delete out.ramp;
          delete out.to;
        }
      }
      return out;
    },
  );
}

/** The song with the edit made. */
export function arrange(project: Project, e: Arrangement): Project {
  check(project, e);
  const map = spans(e);
  // what stays with the old bars and isn't copied (the cycle, the loop): the passes without a copy's
  const kept = map.filter((p) => p.kind !== 'copy');
  const heals = closed(map);
  const next: Project = {
    ...project,
    tempo: mapTempo(project.tempo, map),
    meter: cutMeter(project.meter, map),
    markers: mapMoments(project.markers, map, (m) => ({ ...m, id: newId('mrk') })),
    chords: mapMoments(project.chords, map),
    tracks: project.tracks.map((t) => mapTrack(project, t, map, heals)),
    buses: project.buses.map((b) => ({ ...b, channel: mapChannel(project, b.channel, map) })),
    master: mapChannel(project, project.master, map),
    cycle: cutRange<Cycle>(project.cycle, kept),
  };
  if (project.loop) next.loop = cutRange<Loop>(project.loop, kept);
  if (project.keys?.length) {
    const keys = mapSteps<KeyPoint>(project.keys, map, (a, b) => a.fifths === b.fifths && a.mode === b.mode);
    if (keys.length) next.keys = keys;
    else delete next.keys;
    next.key = textForKeys(keys, project.key);
  }
  if (project.form?.length) {
    const form = mapForm(project.form, map);
    if (form.length) next.form = form;
    else delete next.form;
  }
  const breaks = project.score?.breaks;
  if (project.score && breaks?.length) {
    const moved = mapMoments(
      breaks.map(([tick, kind]) => ({ tick, kind })),
      map,
    ).filter((b, i, all) => i === 0 || b.tick !== all[i - 1]?.tick);
    const score = { ...project.score };
    if (moved.length) score.breaks = moved.map((b): [number, 'system' | 'page'] => [b.tick, b.kind]);
    else delete score.breaks;
    next.score = score;
  }
  return next;
}
