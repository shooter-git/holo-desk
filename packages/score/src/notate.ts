/**
 * A song laid out as a score. The notes are what plays; this works out how they're written: bars
 * (with the pickup, the repeats, key and time changes), each track as a part on its staves, voices,
 * the written values with their ties and tuplets, beams, spellings and accidentals, and the markings.
 * Pure and deterministic: the same song gives the same score, with the same ids.
 */
import {
  type FormMark,
  type KeyMode,
  type KeyPoint,
  keyAt,
  keysOf,
  type Mark,
  type MeterPoint,
  type Note,
  type Project,
  projectEnd,
  type Region,
  type Track,
  type TrackScore,
  ticksPerBar,
} from '@holo/session';
import { drumPlace, FEET, partDefaults } from './instruments.ts';
import { type Beats, beatsOf, groupStarts } from './meter.ts';
import type {
  Bar,
  ChordEvent,
  Control,
  Head,
  NoteRef,
  Part,
  RestEvent,
  ScoreDoc,
  ScoreEvent,
  Staff,
  TupletGroup,
} from './model.ts';
import { beatGrid, type Ratio, snap, splitValues, tupletFor, valueFor, writtenLength } from './rhythm.ts';
import {
  BarAccidentals,
  fifthsShift,
  keyAlters,
  normalFifths,
  type Spelling,
  spellAs,
  spellChord,
  spellInKey,
  transposeSpelling,
} from './spell.ts';
import { fretChords, tuningFor } from './tab.ts';
import { assignVoices, type Chord } from './voices.ts';

export interface NotateOptions {
  /** Only these tracks (by id), in this order; otherwise every instrument track not hidden. */
  tracks?: string[];
  /** Write transposing instruments as they sound (octave transpositions stay). */
  concert?: boolean;
}

/** A note on the timeline, with where it's written. */
interface Item {
  note: Note;
  region: string;
  t: number;
  end: number;
  p: number;
  vo?: number;
  st: number;
  grace?: 'a' | 'p';
}

const KEYLESS: KeyPoint = { tick: 0, fifths: 0, mode: 'major' };

export function notate(project: Project, opts: NotateOptions = {}): ScoreDoc {
  const warnings: string[] = [];
  const refs = new Map<string, NoteRef>();
  const ids = { chord: 0, head: 0, tuplet: 0 };
  const keys = keysOf(project);
  const tracks = opts.tracks
    ? opts.tracks.map((id) => project.tracks.find((t) => t.id === id)).filter((t): t is Track => !!t)
    : project.tracks.filter((t) => t.kind === 'instrument' && !t.score?.hidden);
  const bars = buildBars(project, keys);
  const concert = opts.concert ?? project.score?.concert ?? false;
  const parts: Part[] = [];
  let staffNumber = 1;
  for (const track of tracks) {
    const part = notatePart(track, bars, staffNumber, concert, refs, ids, warnings);
    parts.push(part);
    staffNumber += part.staves.length + (part.tab ? 1 : 0);
  }
  return { title: project.title, credits: project.score ?? {}, bars, parts, refs, warnings };
}

// ---- bars ----

/** The bar a tick falls in (the last one starting at or before it). */
export function barIndexAt(bars: readonly Bar[], tick: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((bars[mid] as Bar).start <= tick) lo = mid;
    else hi = mid - 1;
  }
  return lo;
}

function buildBars(project: Project, keys: KeyPoint[]): Bar[] {
  const end = projectEnd(project);
  const meter = project.meter.length ? project.meter : [{ tick: 0, num: 4, den: 4 }];
  const form = project.form ?? [];
  const splits = new Set<number>();
  const bars: Bar[] = [];
  // timeline bars, through the meter changes
  const timeline: { start: number; length: number; m: MeterPoint }[] = [];
  for (let i = 0; i < meter.length; i++) {
    const m = meter[i] as MeterPoint;
    const next = meter[i + 1];
    const len = ticksPerBar(m);
    for (let t = m.tick; next ? t < next.tick : t < end || timeline.length === 0; t += len) {
      timeline.push({ start: t, length: len, m });
      if (!next && t + len >= end) break;
    }
  }
  for (const f of form) splits.add(f.tick);
  const pickup = meter[0]?.pickup;
  let number = pickup ? 0 : 1;
  let lastMeter = '';
  let lastKey: string | null = null;
  timeline.forEach((tb, i) => {
    // where this timeline bar is cut: a pickup's hidden start, repeat signs inside it
    let from = tb.start;
    if (i === 0 && pickup) from = tb.start + tb.length - pickup;
    const cuts = [...splits].filter((s) => s > from && s < tb.start + tb.length).sort((a, b) => a - b);
    const edges = [from, ...cuts, tb.start + tb.length];
    for (let k = 0; k + 1 < edges.length; k++) {
      const start = edges[k] as number;
      const length = (edges[k + 1] as number) - start;
      const m = { num: tb.m.num, den: tb.m.den, ...(tb.m.groups ? { groups: tb.m.groups } : {}) };
      const mkey = `${m.num}/${m.den}/${m.groups?.join('+') ?? ''}`;
      const key = keyAt(keys, start);
      const kkey = key ? `${key.fifths}${key.mode}` : 'none';
      bars.push({
        index: bars.length,
        number,
        start,
        length,
        offset: start - tb.start,
        meter: m,
        showMeter: mkey !== lastMeter,
        key,
        showKey: bars.length > 0 && kkey !== lastKey,
        left: 'single',
        right: 'single',
        jumps: [],
        tempos: project.tempo.filter(
          (p) => !p.gen && p.tick >= start && p.tick < start + length && (p.text || p.mm || p.tick > 0),
        ),
        chords: project.chords.filter((c) => c.tick >= start && c.tick < start + length),
        controls: [],
      });
      lastMeter = mkey;
      lastKey = kkey;
    }
    number += 1;
  });
  applyForm(bars, form);
  const last = bars.at(-1);
  if (last && last.right === 'single') last.right = 'final';
  for (const [tick, kind] of project.score?.breaks ?? []) {
    const b = bars.find((x) => x.start === tick);
    if (b) b.break = kind;
  }
  return bars;
}

function applyForm(bars: Bar[], form: readonly FormMark[]): void {
  const startingAt = (t: number) => bars.find((b) => b.start === t);
  const endingAt = (t: number) => bars.find((b) => b.start + b.length === t);
  for (const f of form) {
    if (f.k === 'start') {
      const b = startingAt(f.tick);
      if (b) b.left = 'start';
    } else if (f.k === 'end') {
      const b = endingAt(f.tick);
      if (b) {
        b.right = 'end';
        if (f.times && f.times > 2) b.times = f.times;
      }
    } else if (f.k === 'ending') {
      if (f.e === undefined) continue;
      const b = startingAt(f.tick);
      if (b) {
        const count = bars.filter((x) => x.start >= f.tick && x.start < (f.e as number)).length;
        const passes = f.passes ?? [1];
        b.ending = { label: `${passes.join(', ')}.`, passes, bars: Math.max(1, count) };
      }
    } else if (f.k === 'segno' || f.k === 'coda') {
      const b = startingAt(f.tick) ?? bars[barIndexAt(bars, f.tick)];
      b?.jumps.push({ k: f.k, text: f.k === 'segno' ? 'Segno' : 'Coda', at: f.tick });
    } else {
      const b = endingAt(f.tick) ?? bars[barIndexAt(bars, f.tick)];
      if (!b) continue;
      const al = f.al ? ` al ${f.al === 'fine' ? 'Fine' : 'Coda'}` : '';
      const text = f.k === 'fine' ? 'Fine' : f.k === 'toCoda' ? 'To Coda' : f.k === 'dc' ? `D.C.${al}` : `D.S.${al}`;
      b.jumps.push({ k: f.k, text, at: f.tick });
      if (f.k === 'fine' && b.right === 'single') b.right = 'final';
    }
  }
  // a repeat that ends where the next begins is one sign
  for (let i = 0; i + 1 < bars.length; i++) {
    const a = bars[i] as Bar;
    const b = bars[i + 1] as Bar;
    if (a.right === 'end' && b.left === 'start') {
      a.right = 'start-end';
      b.left = 'single';
    } else if (b.left === 'start' && a.right === 'single') {
      // drawn as the next bar's left side
    }
  }
}

// ---- parts ----

function notatePart(
  track: Track,
  bars: Bar[],
  firstStaff: number,
  concert: boolean,
  refs: Map<string, NoteRef>,
  ids: { chord: number; head: number; tuplet: number },
  warnings: string[],
): Part {
  const settings = track.score ?? {};
  const regions = track.regions.filter((r) => !r.muted && !r.audio);
  const pitches = regions.flatMap((r) => r.notes.map((n) => n.p));
  const defaults = partDefaults(track, pitches);
  const drums = defaults.drums;
  const staffCount = drums ? 1 : Math.max(1, settings.staves ?? defaults.staves);
  let tr = settings.tr ?? defaults.tr;
  if (concert && tr && tr[0] % 12 !== 0) tr = null;
  if (drums) tr = null;
  const split = settings.split ?? 60;
  const firstStart = bars[0]?.start ?? 0;

  // the notes, on the timeline, with their written lengths
  const items: Item[] = [];
  for (const r of regions) {
    for (const note of r.notes) {
      const t = r.start + note.t;
      if (t < firstStart) {
        warnings.push(`${track.name}: a note before the pickup (at tick ${t}) isn't written`);
        continue;
      }
      if (t >= r.start + r.length) continue;
      const n = note.n;
      const written = n?.w && n.w[1] === note.d ? n.w[0] : note.d;
      const item: Item = { note, region: r.id, t, end: t + written, p: note.p, st: 1 };
      if (n?.vo) item.vo = n.vo;
      if (n?.g) item.grace = n.g;
      if (n?.st && n.st <= staffCount) item.st = n.st;
      else if (staffCount > 1) item.st = note.p >= split ? 1 : 2;
      items.push(item);
    }
  }

  // the grid played-in music is shown on
  const grace = items.filter((i) => i.grace);
  const main = items.filter((i) => !i.grace);
  quantizeItems(main, bars, settings.grid);

  if (drums) {
    for (const i of main) {
      i.vo = FEET.has(Math.round(i.p)) ? 2 : 1;
      i.st = 1;
    }
    // a drum lasts until the next hit in its voice, within its bar
    for (const vo of [1, 2]) {
      const hits = main.filter((i) => i.vo === vo).sort((a, b) => a.t - b.t);
      const starts = [...new Set(hits.map((h) => h.t))];
      for (const h of hits) {
        const bar = bars[barIndexAt(bars, h.t)] as Bar;
        const next = starts.find((s) => s > h.t) ?? Number.POSITIVE_INFINITY;
        h.end = Math.min(next, bar.start + bar.length);
      }
    }
  }

  // clefs
  const clefs: [number, string][][] = [];
  for (let s = 1; s <= staffCount; s++) {
    const own = (settings.clefs ?? []).filter((c) => c[1] === s).map((c): [number, string] => [c[0], c[2]]);
    const first = own.find((c) => c[0] <= firstStart)?.[1] ?? own[0]?.[1];
    const fallback = defaults.clefs[s - 1] ?? (s === 1 ? 'G' : 'F');
    clefs.push([[firstStart, first ?? fallback], ...own.filter((c) => c[0] > firstStart)]);
  }

  const staves: Staff[] = [];
  const pieces = new Map<Note, number>();
  for (let s = 1; s <= staffCount; s++) {
    const onStaff = main.filter((i) => i.st === s);
    const voices = assignVoices(onStaff, settings.grid ?? 0);
    const staff: Staff = {
      n: firstStaff + s - 1,
      local: s,
      clefs: clefs[s - 1] as [number, string][],
      bars: bars.map(() => ({ voices: [] })),
    };
    voices.forEach((chords, v) => {
      bars.forEach((bar, b) => {
        const events = barEvents(bar, chords, v === 0, track, refs, ids, pieces);
        if (events)
          (staff.bars[b] as { voices: { n: number; events: ScoreEvent[] }[] }).voices.push({ n: v + 1, events });
      });
    });
    if (!voices.length) {
      bars.forEach((bar, b) => {
        (staff.bars[b] as { voices: { n: number; events: ScoreEvent[] }[] }).voices.push({
          n: 1,
          events: [fullRest(bar, ids)],
        });
      });
    }
    staves.push(staff);
  }

  attachGrace(grace, staves, bars, track, refs, ids);
  beam(staves, bars);
  const octaves = octaveSpans(regions, staves);
  spell(staves, bars, tr, drums, track, octaves);
  const tab = settings.tab && !drums ? tabulate(staves, settings.tab, track.name, firstStaff, ids, refs) : undefined;
  const controls = markings(regions, staves);
  for (const c of controls) {
    const at = 'tick' in c ? c.tick : eventTick(staves, c.start);
    (bars[barIndexAt(bars, at)] as Bar).controls.push(c);
  }

  const part: Part = {
    track: track.id,
    name: settings.name ?? track.name,
    staves,
    tr,
    drums,
  };
  if (settings.abbr) part.abbr = settings.abbr;
  if (defaults.range) part.range = defaults.range;
  if (tab) part.tab = tab;
  return part;
}

/**
 * Strings and frets for a part's notes (on its first staff), chosen for the hand (fretChords). The
 * tab is drawn under the staff, the same notes again; a part that's tab only has its staff drawn as
 * tab instead (and nothing is returned).
 */
function tabulate(
  staves: Staff[],
  settings: NonNullable<TrackScore['tab']>,
  name: string,
  firstStaff: number,
  ids: { chord: number; head: number },
  refs: Map<string, NoteRef>,
): Staff | undefined {
  const src = staves[0];
  if (!src) return undefined;
  const tuning = settings.tuning?.length ? settings.tuning : tuningFor(name);
  const capo = settings.capo ?? 0;
  // the chords the hand plays: every note starting at a tick, whatever its voice
  const at = new Map<number, Head[]>();
  for (const sb of src.bars) {
    for (const v of sb.voices) {
      for (const e of v.events) {
        if (e.kind !== 'chord') continue;
        for (const h of e.heads) if (h.tie !== 'm' && h.tie !== 't') at.set(e.tick, [...(at.get(e.tick) ?? []), h]);
      }
    }
  }
  const ticks = [...at.keys()].sort((a, b) => a - b);
  const chords = ticks.map((t) => (at.get(t) as Head[]).map((h) => h.pitch));
  const fixed = ticks.map((t) =>
    (at.get(t) as Head[]).map((h) => {
      const tb = h.ref.note.n?.tb;
      return tb && tb[1] === h.ref.note.p ? tb[0] : null;
    }),
  );
  const frets = fretChords(chords, tuning, capo, fixed);
  ticks.forEach((t, i) => {
    (at.get(t) as Head[]).forEach((h, k) => {
      const f = frets[i]?.[k];
      if (f) h.tab = f;
    });
  });
  if (settings.only) {
    src.clefs = [[src.clefs[0]?.[0] ?? 0, 'tab']];
    src.tab = { tuning, capo };
    return undefined;
  }
  // the same bars again, for the tab staff: its own ids, pointing at the same notes
  return {
    n: firstStaff + staves.length,
    local: staves.length + 1,
    clefs: [[src.clefs[0]?.[0] ?? 0, 'tab']],
    tab: { tuning, capo },
    bars: src.bars.map((sb) => ({
      voices: sb.voices.map((v) => ({
        n: v.n,
        events: v.events.map((e): ScoreEvent => {
          if (e.kind === 'rest') return { ...e, id: `r${ids.chord++}` };
          const heads = e.heads.map((h) => {
            const id = `n${ids.head++}`;
            refs.set(id, h.ref);
            return { ...h, id };
          });
          return { ...e, id: `c${ids.chord++}`, heads };
        }),
      })),
    })),
  };
}

function quantizeItems(items: Item[], bars: Bar[], fixed?: number): void {
  if (!items.length) return;
  // each beat's grid, from the notes starting or ending in it
  const beats = new Map<number, { times: number[]; len: number; compound: boolean }>();
  const beatOf = (tick: number) => {
    const bar = bars[barIndexAt(bars, tick)] as Bar;
    const b = beatsOf(bar.meter);
    const tlStart = bar.start - bar.offset;
    const k = Math.floor((tick - tlStart) / b.beat + 1e-9);
    return { start: tlStart + k * b.beat, len: b.beat, compound: b.compound };
  };
  const grids = new Map<number, number>();
  const gridAt = (tick: number): number => {
    if (fixed) return fixed;
    const beat = beatOf(tick);
    let g = grids.get(beat.start);
    if (g === undefined) {
      const entry = beats.get(beat.start);
      g = entry ? beatGrid(entry.times, entry.len, entry.compound) : beat.len;
      grids.set(beat.start, g);
    }
    return g;
  };
  if (!fixed) {
    for (const i of items) {
      for (const tick of [i.t, i.end]) {
        const beat = beatOf(tick);
        const entry = beats.get(beat.start) ?? { times: [], len: beat.len, compound: beat.compound };
        entry.times.push(tick - beat.start);
        beats.set(beat.start, entry);
      }
    }
  }
  for (const i of items) {
    const g = gridAt(i.t);
    const beat = beatOf(i.t);
    i.t = beat.start + snap(i.t - beat.start, g);
    const eb = beatOf(i.end);
    const eg = gridAt(i.end);
    i.end = eb.start + snap(i.end - eb.start, eg);
    if (i.end <= i.t) i.end = i.t + g;
  }
}

function fullRest(bar: Bar, ids: { chord: number }): RestEvent {
  return {
    kind: 'rest',
    id: `r${ids.chord++}`,
    tick: bar.start,
    dur: bar.length,
    value: 1,
    dots: 0,
    full: true,
  };
}

interface Segment {
  s: number;
  e: number;
  chord?: Chord<Item>;
  tieIn: boolean;
  tieOut: boolean;
}

/** A voice's events in one bar: its chords (cut at the bar lines), rests between, values and tuplets. */
function barEvents(
  bar: Bar,
  chords: Chord<Item>[],
  first: boolean,
  track: Track,
  refs: Map<string, NoteRef>,
  ids: { chord: number; head: number; tuplet: number },
  pieces: Map<Note, number>,
): ScoreEvent[] | null {
  const bs = bar.start;
  const be = bar.start + bar.length;
  const inBar = chords.filter((c) => c.end > bs && c.t < be);
  if (!inBar.length) return first ? [fullRest(bar, ids)] : null;
  const segs: Segment[] = [];
  let at = bs;
  for (const c of inBar) {
    const s = Math.max(bs, c.t);
    const e = Math.min(be, c.end);
    if (s > at) segs.push({ s: at, e: s, tieIn: false, tieOut: false });
    if (e > s) segs.push({ s, e, chord: c, tieIn: c.t < bs, tieOut: c.end > be });
    at = Math.max(at, e);
  }
  if (at < be) segs.push({ s: at, e: be, tieIn: false, tieOut: false });

  const beats = beatsOf(bar.meter);
  const tlStart = bar.start - bar.offset;
  const tuplets = findTuplets(segs, bar, beats, tlStart, ids);
  const cut = cutAt(
    segs,
    tuplets.flatMap((t) => [t.start, t.end]),
  );

  const events: ScoreEvent[] = [];
  for (const seg of cut) {
    const tup = tuplets.find((t) => seg.s >= t.start && seg.e <= t.end);
    let spans: [number, number][];
    if (tup) {
      const r = tup.ratio;
      const toW = (x: number) => ((x - tup.start) * r.num) / r.numbase;
      const fromW = (w: number) => tup.start + (w * r.numbase) / r.num;
      const wlen = writtenLength(tup.end - tup.start, r);
      const tb: Beats = { bar: wlen, beat: wlen / r.num, groups: [wlen], compound: false };
      spans = splitValues(tb, toW(seg.s), toW(seg.e), !seg.chord).map(([a, b]) => [fromW(a), fromW(b)]);
    } else {
      spans = splitValues(beats, seg.s - tlStart, seg.e - tlStart, !seg.chord).map(([a, b]) => [
        a + tlStart,
        b + tlStart,
      ]);
    }
    spans.forEach(([a, b], k) => {
      const written = tup ? ((b - a) * tup.ratio.num) / tup.ratio.numbase : b - a;
      const v = valueFor(written) ?? { value: 4, dots: 0 };
      const base = {
        tick: a,
        dur: b - a,
        value: v.value,
        dots: v.dots,
        ...(tup ? { tuplet: tup } : {}),
      };
      if (!seg.chord) {
        events.push({ kind: 'rest', id: `r${ids.chord++}`, ...base });
        return;
      }
      const startTie = seg.tieIn || k > 0;
      const contTie = seg.tieOut || k < spans.length - 1;
      const tie = startTie && contTie ? 'm' : startTie ? 't' : contTie ? 'i' : undefined;
      const items = seg.chord.items.slice().sort((x, y) => x.p - y.p);
      const heads: Head[] = items.map((i) => {
        const piece = pieces.get(i.note) ?? 0;
        pieces.set(i.note, piece + 1);
        const id = `n${ids.head++}`;
        const ref: NoteRef = { track: track.id, region: i.region, note: i.note, piece };
        refs.set(id, ref);
        const h: Head = { id, pitch: i.p, step: 0, alter: 0, octave: 4, ref };
        if (tie) h.tie = tie;
        return h;
      });
      const firstPiece = !startTie;
      const artic = firstPiece ? [...new Set(items.flatMap((i) => i.note.n?.a ?? []))] : [];
      const chord: ChordEvent = { kind: 'chord', id: `c${ids.chord++}`, ...base, heads, artic };
      const topNote = items.at(-1)?.note;
      if (firstPiece && topNote?.n?.ly) chord.lyrics = topNote.n.ly;
      if (topNote?.n?.stem) chord.stem = topNote.n.stem;
      if (firstPiece && topNote?.n?.fi) chord.fingering = topNote.n.fi;
      events.push(chord);
    });
  }
  return events;
}

/** Tuplets in a voice's bar: per beat where its times need one, or across a group when notes cross beats. */
function findTuplets(segs: Segment[], bar: Bar, b: Beats, tlStart: number, ids: { tuplet: number }): TupletGroup[] {
  const bs = bar.start;
  const be = bar.start + bar.length;
  const out: TupletGroup[] = [];
  const times = segs.flatMap((s) => [s.s, s.e]);
  const hint = segs.find((s) => s.chord?.items.some((i) => i.note.n?.tu))?.chord?.items.find((i) => i.note.n?.tu)?.note
    .n?.tu;
  const tryspan = (a: number, z: number): 'none' | 'ok' | 'crossed' => {
    if (a < bs || z > be) return 'none';
    const inside = times.filter((t) => t > a && t < z).map((t) => t - a);
    let ratio: Ratio | null = tupletFor(inside, z - a, b.compound);
    if (!ratio) return 'none';
    if (hint && hint[0] !== ratio.num) ratio = { num: hint[0], numbase: hint[1] };
    if (segs.some((s) => s.chord && ((s.s < a && s.e > a) || (s.s < z && s.e > z)))) return 'crossed';
    out.push({ id: ids.tuplet++, ratio, start: a, end: z });
    return 'ok';
  };
  const crossed: number[] = [];
  for (let a = tlStart; a < tlStart + b.bar; a += b.beat) {
    if (tryspan(a, a + b.beat) === 'crossed') crossed.push(a);
  }
  if (crossed.length) {
    for (const g of groupStarts(b)) {
      const a = tlStart + g;
      const len = b.groups[groupStarts(b).indexOf(g)] as number;
      if (!crossed.some((c) => c >= a && c < a + len)) continue;
      if (out.some((t) => t.start >= a && t.end <= a + len)) continue;
      tryspan(a, a + len);
    }
  }
  return out.sort((x, y) => x.start - y.start);
}

function cutAt(segs: Segment[], at: number[]): Segment[] {
  const out: Segment[] = [];
  for (const seg of segs) {
    const cuts = at.filter((t) => t > seg.s && t < seg.e).sort((a, b) => a - b);
    const edges = [seg.s, ...cuts, seg.e];
    for (let k = 0; k + 1 < edges.length; k++) {
      out.push({
        ...seg,
        s: edges[k] as number,
        e: edges[k + 1] as number,
        tieIn: k === 0 ? seg.tieIn : true,
        tieOut: k === edges.length - 2 ? seg.tieOut : true,
      });
    }
  }
  return out;
}

/** Grace notes go before the next chord at or after them, on their staff. */
function attachGrace(
  grace: Item[],
  staves: Staff[],
  bars: Bar[],
  track: Track,
  refs: Map<string, NoteRef>,
  ids: { chord: number; head: number },
): void {
  for (const g of grace.sort((a, b) => a.t - b.t)) {
    const staff = staves[Math.min(staves.length, g.st) - 1] as Staff;
    const b = barIndexAt(bars, g.t);
    for (let k = b; k < bars.length; k++) {
      const voice = staff.bars[k]?.voices[0];
      const at = voice?.events.findIndex((e) => e.kind === 'chord' && !e.grace && e.tick >= g.t - 1) ?? -1;
      if (!voice || at < 0) continue;
      const main = voice.events[at] as ChordEvent;
      const id = `n${ids.head++}`;
      const ref: NoteRef = { track: track.id, region: g.region, note: g.note, piece: 0 };
      refs.set(id, ref);
      voice.events.splice(at, 0, {
        kind: 'chord',
        id: `c${ids.chord++}`,
        tick: main.tick,
        dur: 0,
        value: g.end - g.t <= 120 ? 16 : 8,
        dots: 0,
        grace: g.grace,
        heads: [{ id, pitch: g.p, step: 0, alter: 0, octave: 4, ref }],
        artic: g.note.n?.a ?? [],
      });
      break;
    }
  }
}

/** Beams: eighths and shorter, within a beat (a group of plain eighths in 4/4 and 2/2), broken by rests. */
function beam(staves: Staff[], bars: Bar[]): void {
  let id = 0;
  for (const staff of staves) {
    staff.bars.forEach((sb, b) => {
      const bar = bars[b] as Bar;
      const beats = beatsOf(bar.meter);
      const tlStart = bar.start - bar.offset;
      for (const voice of sb.voices) {
        const span = (e: ScoreEvent, wide: boolean) => {
          const unit = wide ? null : beats.beat;
          const rel = e.tick - tlStart;
          if (e.tuplet) return `t${e.tuplet.id}`;
          if (unit) return `b${Math.floor(rel / unit + 1e-9)}`;
          let g = 0;
          for (const [k, len] of beats.groups.entries()) {
            if (rel < g + len - 1e-9) return `g${k}`;
            g += len;
          }
          return 'g?';
        };
        // plain eighths across a whole group beam by group; anything finer by beat
        const groupsWithFine = new Set(
          voice.events.filter((e) => e.kind === 'chord' && e.value > 8 && !e.grace).map((e) => span(e, true)),
        );
        let run: ScoreEvent[] = [];
        let runKey = '';
        const flush = () => {
          if (run.filter((e) => e.kind === 'chord').length >= 2) {
            id++;
            for (const e of run) e.beam = id;
          }
          run = [];
        };
        for (const e of voice.events) {
          if (e.kind !== 'chord' || e.grace || e.value < 8) {
            if (e.kind === 'chord' && e.grace) continue;
            flush();
            continue;
          }
          const groupKey = span(e, true);
          const key =
            beats.compound || groupsWithFine.has(groupKey) || beats.groups.length === beats.bar / beats.beat
              ? span(e, false)
              : groupKey;
          if (key !== runKey) flush();
          runKey = key;
          run.push(e);
        }
        flush();
      }
    });
  }
}

/** 8va and 8vb lines: [staff, start, end, octaves up the music sounds]. */
function octaveSpans(regions: Region[], staves: Staff[]): [number, number, number, number][] {
  const out: [number, number, number, number][] = [];
  for (const r of regions) {
    for (const m of r.marks ?? []) {
      if (m.k !== 'oct' || typeof m.v !== 'number') continue;
      const shift = m.v === 15 ? 2 : m.v === -15 ? -2 : m.v < 0 ? -1 : 1;
      const staff = staves[Math.min(staves.length, m.st ?? 1) - 1] as Staff;
      out.push([staff.n, r.start + m.t, r.start + (m.e ?? m.t), shift]);
    }
  }
  return out;
}

function clefShift(clef: string): number {
  if (clef.endsWith('8vb')) return 1;
  if (clef.endsWith('8va')) return -1;
  if (clef.endsWith('15ma')) return -2;
  return 0;
}

/** Spell every head (by the key, the hints, the transposition) and decide the accidentals shown. */
function spell(
  staves: Staff[],
  bars: Bar[],
  tr: [number, number] | null,
  drums: boolean,
  track: Track,
  octaves: [number, number, number, number][],
): void {
  for (const staff of staves) {
    staff.bars.forEach((sb, b) => {
      const bar = bars[b] as Bar;
      const concertKey = bar.key ?? KEYLESS;
      const writtenFifths = tr ? normalFifths(concertKey.fifths + fifthsShift(tr[0], tr[1])) : concertKey.fifths;
      const accidentals = new BarAccidentals(keyAlters(writtenFifths));
      const events = sb.voices.flatMap((v) =>
        v.events.map((e, k) => ({ e, next: v.events.slice(k + 1).find((x) => x.kind === 'chord') })),
      );
      events.sort((x, y) => x.e.tick - y.e.tick || (x.e.kind === 'chord' && x.e.grace ? -1 : 0));
      for (const { e, next } of events) {
        if (e.kind !== 'chord') continue;
        const clef = clefAt(staff.clefs, e.tick);
        if (drums) {
          for (const h of e.heads) {
            const [place, head] = drumPlace(track, Math.round(h.pitch));
            const steps = 6 + place; // 0 is the middle line, B4
            h.step = ((steps % 7) + 7) % 7;
            h.octave = 4 + Math.floor(steps / 7);
            h.alter = 0;
            if (head !== 'normal') h.head = head;
          }
          continue;
        }
        const nextPitch = next?.kind === 'chord' ? Math.max(...next.heads.map((h) => h.pitch)) : undefined;
        const fixed = e.heads.map((h) => {
          const sp = h.ref.note.n?.sp;
          return !!sp && sp[2] === h.ref.note.p;
        });
        let spelled: Spelling[] = e.heads.map((h, k) => {
          const sp = h.ref.note.n?.sp;
          if (fixed[k] && sp) return spellAs(h.pitch, sp[0]);
          const direction = nextPitch === undefined ? 0 : Math.sign(nextPitch - h.pitch);
          return spellInKey(h.pitch, concertKey.fifths, concertKey.mode as KeyMode, direction);
        });
        spelled = spellChord(spelled, concertKey.fifths, concertKey.mode as KeyMode, fixed);
        e.heads.forEach((h, k) => {
          let s = spelled[k] as Spelling;
          if (tr) s = transposeSpelling(s, tr[0], tr[1]);
          const oct = octaves.find((o) => o[0] === staff.n && e.tick >= o[1] && e.tick <= o[2]);
          s = { ...s, octave: s.octave + clefShift(clef) - (oct ? oct[3] : 0) };
          h.step = s.step;
          h.alter = s.alter;
          h.octave = s.octave;
          const shown = accidentals.show(s, h.tie === 'm' || h.tie === 't');
          if (shown !== null) h.accid = shown;
        });
      }
    });
  }
}

export function clefAt(clefs: readonly [number, string][], tick: number): string {
  let c = clefs[0]?.[1] ?? 'G';
  for (const [t, clef] of clefs) {
    if (t > tick) break;
    c = clef;
  }
  return c;
}

function eventTick(staves: Staff[], id: string): number {
  for (const s of staves)
    for (const b of s.bars) for (const v of b.voices) for (const e of v.events) if (e.id === id) return e.tick;
  return 0;
}

/** The chord a marking at a tick belongs to, on a staff (and voice): the one there, else the next. */
function chordAt(staff: Staff, tick: number, vo: number | undefined, last = false): ChordEvent | null {
  const all: ChordEvent[] = [];
  for (const b of staff.bars)
    for (const v of b.voices)
      if (!vo || v.n === vo) for (const e of v.events) if (e.kind === 'chord' && !e.grace) all.push(e);
  if (last) {
    let found: ChordEvent | null = null;
    for (const e of all) if (e.tick <= tick) found = !found || e.tick >= found.tick ? e : found;
    return found;
  }
  let found: ChordEvent | null = null;
  for (const e of all) if (e.tick >= tick && (!found || e.tick < found.tick)) found = e;
  return found;
}

/** The markings: the regions' marks, the notes' ornaments and fermatas, the sustain pedal. */
function markings(regions: Region[], staves: Staff[]): Control[] {
  const out: Control[] = [];
  const staffOf = (m: Pick<Mark, 'st'>) => staves[Math.min(staves.length, m.st ?? 1) - 1] as Staff;
  for (const r of regions) {
    for (const m of r.marks ?? []) {
      const staff = staffOf(m);
      const t = r.start + m.t;
      const e = r.start + (m.e ?? m.t);
      switch (m.k) {
        case 'dyn':
          out.push({ kind: 'dyn', staff: staff.n, tick: t, value: String(m.v ?? 'mf') });
          break;
        case 'cresc':
        case 'dim':
          out.push({
            kind: 'hairpin',
            staff: staff.n,
            tick: t,
            end: Math.max(e, t + 1),
            form: m.k === 'cresc' ? 'cres' : 'dim',
          });
          break;
        case 'slur':
        case 'gliss': {
          const a = chordAt(staff, t, m.vo);
          const z = chordAt(staff, e, m.vo, true);
          if (a && z && z.tick > a.tick) out.push({ kind: m.k, staff: staff.n, start: a.id, end: z.id });
          break;
        }
        case 'text':
        case 'expr':
          out.push({
            kind: 'words',
            staff: staff.n,
            tick: t,
            text: String(m.v ?? ''),
            place: m.k === 'text' ? 'above' : 'below',
          });
          break;
        case 'oct': {
          const a = chordAt(staff, t, undefined);
          const z = chordAt(staff, e, undefined, true);
          const v = typeof m.v === 'number' ? m.v : 8;
          if (a && z) {
            out.push({
              kind: 'octave',
              staff: staff.n,
              start: a.id,
              end: z.id,
              dis: Math.abs(v) >= 15 ? 15 : 8,
              place: v < 0 ? 'below' : 'above',
            });
          }
          break;
        }
        case 'breath':
        case 'caesura':
          out.push({ kind: m.k, staff: staff.n, tick: t });
          break;
      }
    }
  }
  // ornaments and fermatas on notes: on their chord's first piece
  for (const staff of staves) {
    for (const b of staff.bars) {
      for (const v of b.voices) {
        for (const e of v.events) {
          if (e.kind !== 'chord') continue;
          for (const a of e.artic) {
            if (a === 'ferm' || a === 'tr' || a === 'turn') {
              out.push({ kind: a === 'ferm' ? 'fermata' : a === 'tr' ? 'trill' : 'turn', staff: staff.n, start: e.id });
            } else if (a === 'mord' || a === 'pmord') {
              out.push({ kind: 'mordent', staff: staff.n, start: e.id, form: a === 'mord' ? 'lower' : 'upper' });
            } else if (a === 'arp') {
              out.push({ kind: 'arpeg', staff: staff.n, start: e.id });
            }
          }
        }
      }
    }
  }
  // the sustain pedal, under the lowest staff
  const lowest = staves.at(-1) as Staff;
  for (const r of regions) {
    let down = false;
    for (const [t, value] of r.cc['64'] ?? []) {
      const now = value >= 64;
      if (now !== down) out.push({ kind: 'pedal', staff: lowest.n, tick: r.start + t, dir: now ? 'down' : 'up' });
      down = now;
    }
  }
  return out;
}
