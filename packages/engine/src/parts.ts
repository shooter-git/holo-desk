/**
 * Planned parts: tracks whose instrument plays a whole part at once (a Performance instrument, Glass),
 * planned where the song is compiled and handed to the audio thread as voices to start at their frames.
 */
import type { Note, Project, Track } from '@holo/session';
import { type GlassLinePlan, type GlassPlan, planGlass, planGlassLine } from './glass.ts';
import { type NotePlan, type PerfCurve, type PerfInstrument, type PerfNote, planPart } from './performance.ts';
import type { TempoSegment } from './protocol.ts';

/** A pack's Performance data (in its instrument manifest): the instrument and its samples' files. */
export interface PerformanceManifest extends Omit<PerfInstrument, 'name' | 'rows'> {
  rows: PerfInstrument['rows'];
  /** The files the rows' `sample` indexes name (relative to the pack's samples). */
  files: string[];
}

export type PartPlans =
  | { kind: 'performance'; key: string; notes: NotePlan[] }
  | { kind: 'glass'; glass: GlassPlan[]; lines: GlassLinePlan[] };

export function isPlanned(t: Track): boolean {
  return t.instrument.type === 'performance' || t.instrument.type === 'glass';
}

/**
 * How a note was performed when its creation made it: its start and length in seconds, its
 * velocity (0–1), its pitch as the creation names it, and its place in the creation's list. Kept on
 * the note (`x.perf`) for as long as the note is where the creation put it (`tick`, `len`, `vel`).
 */
interface Performed {
  t: number;
  d: number;
  v: number;
  p?: number;
  i?: number;
  tick: number;
  len: number;
  vel: number;
}

function performed(n: Note, tick: number): Performed | null {
  const x = n.x?.perf as Performed | undefined;
  if (!x || typeof x !== 'object') return null;
  if (x.tick !== tick || x.len !== n.d || x.vel !== n.v) return null;
  return x;
}

/** The part's notes in seconds, as performed where a creation says, in the creation's order. */
export function partNotes(track: Track, segments: readonly TempoSegment[], sr: number): PerfNote[] {
  const sec = (tick: number) => tickToFrameOf(segments, tick) / sr;
  const out: { n: PerfNote; i: number }[] = [];
  let k = 0;
  for (const r of track.regions) {
    if (r.muted) continue;
    const end = r.start + r.length;
    for (const n of r.notes) {
      const tick = r.start + n.t;
      if (tick >= end) continue;
      const perf = performed(n, tick);
      const { perf: _, ...extras } = n.x ?? {};
      const note: PerfNote = perf
        ? { t: perf.t, d: perf.d, p: perf.p ?? n.p, v: perf.v, x: extras }
        : {
            t: sec(tick),
            d: sec(Math.min(end, tick + n.d)) - sec(tick),
            p: n.p,
            v: Math.min(1, Math.max(0, n.v / 127)),
            x: extras,
          };
      out.push({ n: note, i: perf?.i ?? 1e9 + k });
      k++;
    }
  }
  return out.sort((a, b) => a.i - b.i).map((o) => o.n);
}

function tickToFrameOf(segments: readonly TempoSegment[], tick: number): number {
  let seg = segments[0] as TempoSegment;
  for (const s of segments) {
    if (s.tick > tick) break;
    seg = s;
  }
  return seg.frame + (tick - seg.tick) * seg.framesPerTick;
}

/** Plan a track's part, or null when its instrument isn't planned (or its data isn't at hand). */
export function planTrack(
  track: Track,
  project: Project,
  segments: readonly TempoSegment[],
  sr: number,
  perf?: PerformanceManifest,
): PartPlans | null {
  const inst = track.instrument;
  const notes = partNotes(track, segments, sr);
  if (inst.type === 'glass') {
    const o = inst.options ?? {};
    return inst.line
      ? { kind: 'glass', glass: [], lines: planGlassLine(notes, o, sr) }
      : { kind: 'glass', glass: planGlass(notes, o, sr), lines: [] };
  }
  if (inst.type !== 'performance' || !perf) return null;
  const play = inst.play ?? {};
  const sec = (tick: number) => tickToFrameOf(segments, tick) / sr;
  const dyn: PerfCurve | undefined = play.dyn?.length
    ? { t: play.dyn.map(([t]) => sec(t)), v: play.dyn.map(([, v]) => v) }
    : undefined;
  // unpitched instruments take no pitch (the creation plays them as pitch 0)
  const pitched = perf.rows.some((r) => r.midi !== null);
  const part = pitched ? notes : notes.map((n) => ({ ...n, p: 0 }));
  const plans = planPart(
    { ...perf, name: inst.name },
    part,
    { ...play, seed: play.seed ?? 0, dyn },
    sr,
    project.performance?.kernelCuts,
  );
  return { kind: 'performance', key: `${inst.pack}/${inst.name}`, notes: plans };
}

/** A loop's plans: anything that starts before the loop (an early attack) comes round at its end. */
export function wrapPlans(plans: PartPlans, start: number, end: number): PartPlans {
  const turn = end - start;
  const wrap = <T extends { at: number }>(p: T): T =>
    p.at >= start && p.at < end ? p : { ...p, at: start + ((((p.at - start) % turn) + turn) % turn) };
  if (plans.kind === 'performance') return { ...plans, notes: plans.notes.map(wrap) };
  return { ...plans, glass: plans.glass.map(wrap), lines: plans.lines.map(wrap) };
}

/** Where the part's last voice ends (frames). */
export function partReach(plans: PartPlans): number {
  let end = 0;
  if (plans.kind === 'performance') for (const p of plans.notes) end = Math.max(end, p.at + p.length);
  else {
    for (const p of plans.glass) end = Math.max(end, p.at + p.n);
    for (const p of plans.lines) end = Math.max(end, p.at + p.n);
  }
  return end;
}

/**
 * How many of the part's voices sound at once for a good part of the song (`length` frames): as many
 * as sound together for at least a quarter of it. A part busy throughout counts its usual chord; one
 * that only now and then plays a run, next to none.
 */
export function partVoices(plans: PartPlans, length: number, share = 0.25): number {
  const spans: [number, number][] =
    plans.kind === 'performance'
      ? plans.notes.map((p) => [p.at, p.length])
      : [
          ...plans.glass.map((p): [number, number] => [p.at, p.n]),
          ...plans.lines.map((p): [number, number] => [p.at, p.n]),
        ];
  const edges: [number, number][] = [];
  for (const [at, n] of spans) if (n > 0) edges.push([at, 1], [at + n, -1]);
  edges.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  // frames spent with each count of voices sounding
  const time = new Map<number, number>();
  let count = 0;
  let last = 0;
  for (const [at, d] of edges) {
    if (count > 0 && at > last) time.set(count, (time.get(count) ?? 0) + (at - last));
    count += d;
    last = at;
  }
  let left = Math.max(1, length) * share;
  for (const c of [...time.keys()].sort((a, b) => b - a)) {
    left -= time.get(c) as number;
    if (left <= 0) return c;
  }
  return 0;
}

/** The sample files a performance part's plans play. */
export function partSamples(plans: PartPlans): number[] {
  if (plans.kind !== 'performance') return [];
  return [...new Set(plans.notes.map((p) => p.row.sample))];
}
