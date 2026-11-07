/**
 * Repeats and jumps, as they play. The timeline holds the music once, as it's written; `form` marks
 * where it repeats, which ending each time through takes, and the D.C. and D.S. jumps. `playMap`
 * walks the form as a player reads the score, and `performed` builds the song as it's heard, which is
 * what the engines play. The playhead goes between the two timelines with `writtenAt` and `playedAt`.
 *
 * The walk: a repeat sign sends the music back (to the last start sign, or the last end sign, or the
 * top) until it has played `times` times; an ending is taken on the passes it lists and skipped on
 * the others; the first D.C. or D.S. jumps once, after which To Coda and Fine take effect, and the
 * repeats aren't taken again unless the jump says to (`repeats`). A song that would never end stops
 * after a few hundred passes.
 */
import { automationAt } from './automation.ts';
import { newId } from './defaults.ts';
import { keyAt, keysOf } from './keysig.ts';
import type { Op } from './ops.ts';
import { realize } from './realize.ts';
import { bpmAt, meterAt, ticksPerBar, tickToSeconds } from './time.ts';
import type {
  AutomationLane,
  Bus,
  CCPoint,
  Channel,
  Cycle,
  FormMark,
  KeyPoint,
  Loop,
  Marker,
  MeterPoint,
  Project,
  Region,
  TempoPoint,
  Track,
} from './types.ts';

/** A stretch of the song as written, [from, to), played from `at` on the played timeline. */
export interface Pass {
  from: number;
  /** Infinity: on to the end of the song. */
  to: number;
  at: number;
  /** Which time through these bars it is: 1, 2… */
  n: number;
}

/** The song as played, in order. */
export type PlayMap = readonly Pass[];

const LIMIT = 400;

/** Where the music starts again from the top: the pickup's first note, when there is one. */
function topOf(meter: readonly MeterPoint[]): number {
  const m = meter[0];
  return m?.pickup ? Math.max(0, ticksPerBar(m) - m.pickup) : 0;
}

function walk(form: readonly FormMark[], meter: readonly MeterPoint[]): Pass[] {
  const top = topOf(meter);
  const sorted = [...form].sort((a, b) => a.tick - b.tick);
  const of = (...k: FormMark['k'][]) => sorted.filter((f) => k.includes(f.k));
  const ends = of('end');
  const starts = of('start');
  const endings = of('ending').filter((g) => g.e !== undefined && g.e > g.tick && g.passes?.length);
  const jumps = of('dc', 'ds');
  const segnos = of('segno');
  const codas = of('coda');
  const toCodas = of('toCoda');
  const fines = of('fine');
  /** How many times each repeat sign has sent the music back. */
  const back = new Map<FormMark, number>();
  const spans: [number, number][] = [];

  /** The time through that an ending is on: its repeat's (the end sign inside it, or the last before it). */
  const passOf = (g: FormMark): number => {
    const end =
      ends.find((x) => x.tick > g.tick && x.tick <= (g.e as number)) ??
      [...ends].reverse().find((x) => x.tick <= g.tick);
    return end ? (back.get(end) ?? 0) + 1 : 1;
  };
  /** Where a repeat goes back to: the last start sign since the last end sign (past its endings), or that end sign. */
  const backTo = (end: FormMark): number => {
    let from = 0;
    for (const x of ends) if (x.tick < end.tick) from = x.tick;
    for (let moved = true; moved; ) {
      moved = false;
      for (const g of endings) {
        if (g.tick === from && (g.e as number) < end.tick) {
          from = g.e as number;
          moved = true;
        }
      }
    }
    for (const s of starts) if (s.tick >= from && s.tick < end.tick) from = s.tick;
    return from === 0 ? top : from;
  };
  const after = (list: FormMark[], pos: number) => list.find((x) => x.tick > pos)?.tick ?? Number.POSITIVE_INFINITY;

  let pos = 0;
  let jumped: FormMark | null = null;
  let al: FormMark['al'];
  for (let guard = 0; guard < LIMIT; guard++) {
    const ending = endings.find((g) => g.tick === pos);
    if (ending && !ending.passes?.includes(passOf(ending))) {
      pos = ending.e as number;
      continue;
    }
    let next = Math.min(after(ends, pos), after(endings, pos), jumped ? Number.POSITIVE_INFINITY : after(jumps, pos));
    if (al === 'coda') next = Math.min(next, after(toCodas, pos));
    if (al === 'fine') next = Math.min(next, after(fines, pos));
    spans.push([pos, next]);
    if (next === Number.POSITIVE_INFINITY) break;
    pos = next;
    if (al === 'fine' && fines.some((f) => f.tick === pos)) break;
    if (al === 'coda' && toCodas.some((f) => f.tick === pos)) {
      const coda = codas.find((c) => c.tick > pos) ?? codas[0];
      if (coda) {
        pos = coda.tick;
        al = undefined;
        continue;
      }
    }
    const end = !jumped || jumped.repeats ? ends.find((x) => x.tick === pos) : undefined;
    if (end && (back.get(end) ?? 0) < Math.max(1, end.times ?? 2) - 1) {
      back.set(end, (back.get(end) ?? 0) + 1);
      pos = backTo(end);
      continue;
    }
    const jump: FormMark | undefined = jumped ? undefined : jumps.find((x) => x.tick === pos);
    if (jump) {
      jumped = jump;
      al = jump.al;
      if (jump.repeats) back.clear();
      const segno = jump.k === 'ds' ? ([...segnos].reverse().find((s) => s.tick < pos) ?? segnos[0]) : undefined;
      pos = segno && segno.tick > 0 ? segno.tick : top;
    }
  }
  // stretches that follow on from each other are one
  const merged: [number, number][] = [];
  for (const [a, b] of spans) {
    const last = merged[merged.length - 1];
    if (b <= a) continue;
    if (last && last[1] === a) last[1] = b;
    else merged.push([a, b]);
  }
  const out: Pass[] = [];
  let at = 0;
  for (const [from, to] of merged) {
    const n = 1 + out.filter((p) => p.from < to && from < p.to).length;
    out.push({ from, to, at, n });
    at += to - from;
  }
  return out;
}

const maps = new WeakMap<readonly FormMark[], { meter: readonly MeterPoint[]; map: PlayMap | null }>();

/** The song as played, or null when it plays straight through as written. */
export function playMap(project: Pick<Project, 'form' | 'meter'>): PlayMap | null {
  const form = project.form;
  if (!form?.length) return null;
  const hit = maps.get(form);
  if (hit && hit.meter === project.meter) return hit.map;
  const passes = walk(form, project.meter);
  const only = passes[0];
  const map = passes.length === 1 && only && only.from === 0 && only.to === Number.POSITIVE_INFINITY ? null : passes;
  maps.set(form, { meter: project.meter, map });
  return map;
}

/** How long the played song is, when it stops (a Fine) before the music runs out; else Infinity. */
export function playedLength(map: PlayMap): number {
  const last = map[map.length - 1];
  return last ? last.at + (last.to - last.from) : 0;
}

/** Where a tick of the played song is in the music as written, and which time through it is. */
export function writtenAt(map: PlayMap | null, played: number): { tick: number; n: number } {
  if (!map || played < 0) return { tick: played, n: 1 };
  for (const p of map)
    if (played < p.at + (p.to - p.from)) return { tick: p.from + Math.max(0, played - p.at), n: p.n };
  const last = map[map.length - 1] as Pass;
  return { tick: last.to + (played - playedLength(map)), n: last.n };
}

/**
 * Where a written tick plays: the first time it's played at or after `after` (a tick of the played
 * song), else the first time at all. Music that isn't played (after a Fine) goes to where the next
 * music that is starts, or to the end.
 */
export function playedAt(map: PlayMap | null, written: number, after = Number.NEGATIVE_INFINITY): number {
  if (!map || written < 0) return written;
  let first = Number.POSITIVE_INFINITY;
  let next = Number.POSITIVE_INFINITY;
  let later = Number.POSITIVE_INFINITY;
  for (const p of map) {
    if (written >= p.from && written < p.to) {
      const t = p.at + (written - p.from);
      first = Math.min(first, t);
      if (t >= after) next = Math.min(next, t);
    } else if (p.from > written) later = Math.min(later, p.at);
  }
  if (next < Number.POSITIVE_INFINITY) return next;
  if (first < Number.POSITIVE_INFINITY) return first;
  return later < Number.POSITIVE_INFINITY ? later : playedLength(map);
}

/** Every time a written tick is played (an end tick counts as played where a pass ends on it). */
export function playedTimes(map: PlayMap | null, written: number, asEnd = false): number[] {
  if (!map) return [written];
  const out: number[] = [];
  for (const p of map) {
    if (asEnd ? written > p.from && written <= p.to : written >= p.from && written < p.to)
      out.push(p.at + (written - p.from));
  }
  return out;
}

/**
 * A stretch of the song as played, [a, b), as the written stretches it plays, in order: each with
 * where it starts on the played timeline and which time through it is (how a take recorded through
 * the repeats is put back where it was played).
 */
export function writtenSpans(map: PlayMap | null, a: number, b: number): Pass[] {
  if (!map) return b > a ? [{ from: a, to: b, at: a, n: 1 }] : [];
  const out: Pass[] = [];
  for (const p of map) {
    const s = Math.max(a, p.at);
    const e = Math.min(b, p.at + (p.to - p.from));
    if (e > s) out.push({ from: p.from + (s - p.at), to: p.from + (e - p.at), at: s, n: p.n });
  }
  return out;
}

// ---- cutting the song into its passes ----

/** A controller lane's points from `a` to `b` (ticks of the region), moved to start at 0, with the value it had at `a`. */
function cutLane(points: readonly CCPoint[], a: number, b: number): CCPoint[] {
  const out: CCPoint[] = [];
  let held: CCPoint | undefined;
  for (const pt of points) {
    if (pt[0] < a) held = pt;
    else if (pt[0] <= b) out.push([pt[0] - a, pt[1]]);
  }
  if (held && !(out[0] && out[0][0] === 0)) out.unshift([0, held[1]]);
  return out;
}

interface CutOptions {
  /** The written song's tempo (an audio region's place in its file moves by the time cut off). */
  tempo: readonly TempoPoint[];
  /** For the score too: keep the notes' hints and the marks, give the pieces ids of their own. */
  written?: boolean;
}

const EDGE = 0.005;

/** The piece of a region inside a pass, placed where the pass plays (null when none of it is). */
function cutRegion(r: Region, p: Pass, opts: CutOptions): Region | null {
  const a = Math.max(p.from, r.start);
  const b = Math.min(p.to, r.start + r.length);
  if (b <= a) return null;
  const x0 = a - r.start;
  const x1 = b - r.start;
  const piece: Region = {
    ...r,
    id: opts.written ? newId('rgn') : `${r.id}~${p.at}`,
    start: p.at + (a - p.from),
    length: b - a,
    notes: r.notes
      .filter((n) => n.t >= x0 && n.t < x1)
      .map((n) => {
        const out = { ...n, t: n.t - x0 };
        if (!opts.written) delete out.n;
        return out;
      }),
    cc: Object.fromEntries(Object.entries(r.cc).map(([k, pts]) => [k, cutLane(pts, x0, x1)])),
  };
  if (opts.written && r.marks) {
    piece.marks = r.marks
      .filter((m) => m.t >= x0 && m.t < x1)
      .map((m) => ({ ...m, t: m.t - x0, ...(m.e !== undefined ? { e: Math.min(m.e, x1) - x0 } : {}) }));
  } else delete piece.marks;
  if (r.audio) {
    const moved = tickToSeconds(opts.tempo, a) - tickToSeconds(opts.tempo, r.start);
    piece.audio = {
      ...r.audio,
      offset: r.audio.offset + moved / r.audio.stretch,
      fadeIn: x0 > 0 ? EDGE : r.audio.fadeIn,
      fadeOut: x1 < r.length ? EDGE : r.audio.fadeOut,
    };
  }
  return piece;
}

/** A track's regions, pass by pass. */
function cutRegions(regions: readonly Region[], map: PlayMap, opts: CutOptions): Region[] {
  const out: Region[] = [];
  for (const p of map) {
    for (const r of regions) {
      const piece = cutRegion(r, p, opts);
      if (piece) out.push(piece);
    }
  }
  return out;
}

/** An automation lane, pass by pass: each pass starts from the value the lane has where it starts in the music. */
function cutAutomation(lane: AutomationLane, map: PlayMap): [number, number][] {
  const out: [number, number][] = [];
  for (const p of map) {
    const from = automationAt(lane, p.from, lane.param === 'mute');
    if (from !== null) out.push([p.at, from]);
    for (const [t, v] of lane.points) if (t > p.from && t < p.to) out.push([p.at + (t - p.from), v]);
    if (p.to !== Number.POSITIVE_INFINITY) {
      const to = automationAt(lane, p.to, lane.param === 'mute');
      if (to !== null) out.push([p.at + (p.to - p.from), to]);
    }
  }
  return out;
}

/** Tempo points, pass by pass (`keep` the score's words and ramps: else just the speeds the engines play). */
function cutTempo(tempo: readonly TempoPoint[], map: PlayMap, keep = false): TempoPoint[] {
  const out: TempoPoint[] = [];
  for (const p of map) {
    const inside = tempo.filter((t) => t.tick > p.from && t.tick < p.to);
    const at = tempo.find((t) => t.tick === p.from);
    const start = keep && at ? { ...at, tick: p.at } : { tick: p.at, bpm: bpmAt(tempo, p.from) };
    // (a pass that starts at the speed already playing says nothing, unless it's a mark heard the first time)
    const prev = out[out.length - 1];
    if (!prev || prev.bpm !== start.bpm || (keep && at && p.n === 1 && at.text)) out.push(start);
    for (const t of inside) {
      const moved = { ...t, tick: p.at + (t.tick - p.from) };
      if (keep && t.ramp !== undefined) moved.ramp = p.at + (Math.min(t.ramp, p.to) - p.from);
      out.push(keep ? moved : { tick: moved.tick, bpm: t.bpm });
    }
  }
  // (a speed that doesn't change is no point)
  return out.filter((t, i) => i === 0 || keep || t.bpm !== (out[i - 1] as TempoPoint).bpm);
}

/** Meter points, pass by pass: a pass that starts inside a bar (after a pickup) keeps the bar's beat. */
function cutMeter(meter: readonly MeterPoint[], map: PlayMap): MeterPoint[] {
  const out: MeterPoint[] = [];
  const same = (a: MeterPoint, b: MeterPoint) =>
    a.num === b.num && a.den === b.den && (a.groups ?? []).join() === (b.groups ?? []).join();
  const add = (m: MeterPoint) => {
    const last = out[out.length - 1];
    if (last && same(last, m) && (m.tick - last.tick) % ticksPerBar(m) === 0) return;
    if (last && m.tick < last.tick) m.tick = last.tick;
    if (last && m.tick === last.tick) out.pop();
    out.push(m);
  };
  for (const p of map) {
    const m = meterAt(meter, p.from);
    const into = (p.from - m.tick) % ticksPerBar(m);
    const { pickup: _, ...rest } = m;
    const bar = p.at - into;
    add({ ...rest, tick: out.length ? Math.max(bar, out[out.length - 1]?.tick ?? 0) : 0 });
    for (const x of meter) if (x.tick > p.from && x.tick < p.to) add({ ...x, tick: p.at + (x.tick - p.from) });
  }
  const first = meter[0];
  if (first?.pickup && out[0]) out[0] = { ...out[0], pickup: first.pickup };
  return out;
}

/** A written stretch (the cycle, a loop) where it first plays: its end the first time it's reached after its start. */
function cutRange<T extends { start: number; end: number }>(range: T, map: PlayMap): T {
  const start = playedAt(map, range.start);
  const ends = playedTimes(map, range.end, true).filter((t) => t > start);
  return { ...range, start, end: ends.length ? Math.min(...ends) : start + (range.end - range.start) };
}

// ---- the song as it's heard ----

type Cache<K extends object, V> = WeakMap<K, { deps: readonly unknown[]; v: V }>;

function memo<K extends object, V>(cache: Cache<K, V>, key: K, deps: readonly unknown[], make: () => V): V {
  const hit = cache.get(key);
  if (hit && hit.deps.length === deps.length && hit.deps.every((d, i) => d === deps[i])) return hit.v;
  const v = make();
  cache.set(key, { deps, v });
  return v;
}

const regionsCache: Cache<readonly Region[], Region[]> = new WeakMap();
const channelCache: Cache<Channel, Channel> = new WeakMap();
const trackCache: Cache<Track, Track> = new WeakMap();
const tracksCache: Cache<readonly Track[], Track[]> = new WeakMap();
const busesCache: Cache<readonly Bus[], Bus[]> = new WeakMap();
const tempoCache: Cache<readonly TempoPoint[], TempoPoint[]> = new WeakMap();
const meterCache: Cache<readonly MeterPoint[], MeterPoint[]> = new WeakMap();
const projectCache: Cache<Project, Project> = new WeakMap();

/** The same list when every item came out the same, else the new one. */
const sameOr = <T>(list: readonly T[], next: T[]): T[] =>
  next.length === list.length && next.every((x, i) => x === list[i]) ? (list as T[]) : next;

function playedRegions(
  regions: readonly Region[],
  map: PlayMap | null,
  tempo: readonly TempoPoint[],
  keys: readonly KeyPoint[],
): Region[] {
  return memo(regionsCache, regions, [map, tempo, keys], () => {
    const sounding = sameOr(
      regions,
      regions.map((r) => {
        const notes = realize(r.notes, { start: r.start, tempo, keys });
        return notes === r.notes ? r : { ...r, notes };
      }),
    );
    return map ? cutRegions(sounding, map, { tempo }) : sounding;
  });
}

function playedChannel(c: Channel, map: PlayMap | null): Channel {
  if (!map || !c.automation?.length) return c;
  return memo(channelCache, c, [map], () => ({
    ...c,
    automation: (c.automation ?? []).map((lane) => ({ ...lane, points: cutAutomation(lane, map) })),
  }));
}

const textKeys = new Map<string | null, KeyPoint[]>();

/** The song's keys, the same list each time for the same song (a key given only as text too). */
function keyList(project: Pick<Project, 'key' | 'keys'>): readonly KeyPoint[] {
  if (project.keys) return project.keys;
  let keys = textKeys.get(project.key);
  if (!keys) {
    keys = keysOf(project);
    if (textKeys.size > 64) textKeys.clear();
    textKeys.set(project.key, keys);
  }
  return keys;
}

/**
 * The song as it's heard: its repeats and jumps played out, its ornaments played as notes. What the
 * engines play; the song itself (what's shown and edited) keeps the music as it's written. A song
 * with neither is itself, and what doesn't change from one call to the next stays the same objects,
 * so an engine that goes by them only works again on what changed.
 */
export function performed(project: Project): Project {
  const map = playMap(project);
  const keys = keyList(project);
  const tracks = memo(tracksCache, project.tracks, [map, project.tempo, project.keys, project.key], () =>
    sameOr(
      project.tracks,
      project.tracks.map((t) =>
        memo(trackCache, t, [map, project.tempo, project.keys, project.key], () => {
          const regions = playedRegions(t.regions, map, project.tempo, keys);
          const channel = playedChannel(t.channel, map);
          return regions === t.regions && channel === t.channel ? t : { ...t, regions, channel };
        }),
      ),
    ),
  );
  if (!map && tracks === project.tracks) return project;
  return memo(projectCache, project, [map, tracks], () => {
    if (!map) return { ...project, tracks };
    const out: Project = {
      ...project,
      tracks,
      tempo: memo(tempoCache, project.tempo, [map], () => cutTempo(project.tempo, map)),
      meter: memo(meterCache, project.meter, [map], () => cutMeter(project.meter, map)),
      buses: memo(busesCache, project.buses, [map], () =>
        sameOr(
          project.buses,
          project.buses.map((b) => {
            const channel = playedChannel(b.channel, map);
            return channel === b.channel ? b : { ...b, channel };
          }),
        ),
      ),
      master: playedChannel(project.master, map),
      cycle: cutRange(project.cycle, map),
    };
    if (project.loop) out.loop = cutRange(project.loop, map);
    delete out.form;
    return out;
  });
}

// ---- writing the repeats out ----

/**
 * The changes that write a song's repeats and jumps out: every pass's music one after another on the
 * timeline, as it plays, and no repeat signs. One undo step in the studio ("Unroll repeats").
 */
export function unrollOps(project: Project): Op[] {
  const map = playMap(project);
  if (!map) return project.form?.length ? [{ op: 'setProject', patch: { form: null } }] : [];
  const ops: Op[] = [];
  const opts: CutOptions = { tempo: project.tempo, written: true };
  for (const t of project.tracks) {
    for (const r of t.regions) ops.push({ op: 'removeRegion', track: t.id, region: r.id });
    for (const r of cutRegions(t.regions, map, opts)) ops.push({ op: 'addRegion', track: t.id, region: r });
  }
  const channels: [string, Channel][] = [
    ['master', project.master],
    ...project.buses.map((b): [string, Channel] => [b.id, b.channel]),
    ...project.tracks.map((t): [string, Channel] => [t.id, t.channel]),
  ];
  for (const [target, c] of channels) {
    for (const lane of c.automation ?? []) {
      ops.push({
        op: 'setAutomation',
        target,
        param: lane.param,
        points: cutAutomation(lane, map),
        mode: lane.mode,
        ...(lane.curve ? { curve: lane.curve } : {}),
      });
    }
  }
  const inside = <T extends { tick: number }>(list: readonly T[], f: (x: T, p: Pass) => T): T[] =>
    map.flatMap((p) => list.filter((x) => x.tick >= p.from && x.tick < p.to).map((x) => f(x, p)));
  const keys = project.keys?.length
    ? map
        .flatMap((p) => {
          const k = keyAt(project.keys ?? [], p.from);
          const moved = (project.keys ?? [])
            .filter((x) => x.tick > p.from && x.tick < p.to)
            .map((x) => ({ ...x, tick: p.at + (x.tick - p.from) }));
          return k ? [{ ...k, tick: p.at }, ...moved] : moved;
        })
        .filter((k, i, all) => i === 0 || k.fifths !== all[i - 1]?.fifths || k.mode !== all[i - 1]?.mode)
    : undefined;
  ops.push({
    op: 'setProject',
    patch: {
      form: null,
      tempo: cutTempo(project.tempo, map, true),
      meter: cutMeter(project.meter, map),
      ...(keys ? { keys } : {}),
      markers: inside(project.markers, (m: Marker, p) => ({
        ...m,
        id: p.n > 1 ? newId('mrk') : m.id,
        tick: p.at + (m.tick - p.from),
      })),
      chords: inside(project.chords, (c, p) => ({ ...c, tick: p.at + (c.tick - p.from) })),
      cycle: cutRange<Cycle>(project.cycle, map),
      ...(project.loop ? { loop: cutRange<Loop>(project.loop, map) } : {}),
    },
  });
  return ops;
}
