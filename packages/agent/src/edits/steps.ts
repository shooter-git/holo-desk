/**
 * A drum part as steps: the Step Grid's view of a track's notes, and every edit it makes. The
 * studio's grid, the agent's `steps` tool and `holo steps` all read and write the pattern here, so a
 * step lit in one is the same note in the others.
 *
 * Nothing is stored for a step: a lit step is a note. A note belongs to the step it's nearest and
 * keeps where it really is (its offset from the step), so looking at a part as steps never moves a
 * note, and a part played by hand shows as it was played. A step with several notes of one pitch
 * (a flam) is one lit step: lighting, velocity and clearing act on all of them.
 */
import {
  DIVISIONS,
  DRUM_PRESETS,
  GM_DRUMS,
  type Instrument,
  type MeterPoint,
  meterAt,
  type Note,
  newRegion,
  type Op,
  PPQ,
  type Project,
  type Region,
  type Track,
  ticksPerBar,
  ticksPerBeat,
} from '@holo/session';
import { MAX_SWING, swings } from './timing.ts';

// ---- the grid ----

/** The step sizes a grid can have. */
export const STEP_GRIDS = ['1/8', '1/16', '1/32', '1/8T', '1/16T'] as const;
export type StepGridName = (typeof STEP_GRIDS)[number];
export const isStepGrid = (name: unknown): name is StepGridName => STEP_GRIDS.includes(name as StepGridName);
/** A grid's step, in ticks. */
export const stepSize = (grid: string): number => DIVISIONS[grid] ?? PPQ / 4;

/**
 * How hard a step is hit, as the Session Drummer's grooves write it: `X` an accent, `x` a full hit,
 * `o` a lighter one, `g` a ghost note. `v` is the velocity a step gets when it's set to that level.
 */
export const STEP_LEVELS = [
  { id: 'ghost', letter: 'g', name: 'Ghost', v: 40 },
  { id: 'soft', letter: 'o', name: 'Soft', v: 72 },
  { id: 'normal', letter: 'x', name: 'Normal', v: 100 },
  { id: 'accent', letter: 'X', name: 'Accent', v: 124 },
] as const;
export type StepLevel = (typeof STEP_LEVELS)[number];
/** The velocity a step gets when it's lit with no level said. */
export const STEP_VELOCITY = 100;

/** The level a velocity reads as. */
export function levelOf(v: number): StepLevel {
  return v >= 113 ? STEP_LEVELS[3] : v >= 86 ? STEP_LEVELS[2] : v >= 56 ? STEP_LEVELS[1] : STEP_LEVELS[0];
}

/** A level by its letter or its name ("X", "accent"); undefined for neither. */
export function levelNamed(text: string): StepLevel | undefined {
  return STEP_LEVELS.find((l) => l.letter === text) ?? STEP_LEVELS.find((l) => l.id === text.trim().toLowerCase());
}

export interface Step {
  /** Where it is in the song, ticks. */
  tick: number;
  /** Where its bar starts, and which step of the bar it is (0…). */
  bar: number;
  index: number;
  /** Whether a beat starts on it. */
  beat: boolean;
  /** Whether it's in an even beat of its bar (the second, the fourth…): a grid shades those apart. */
  alt: boolean;
}

/** The bar line at or before a tick. */
export function barLineAt(meter: readonly MeterPoint[], tick: number): number {
  const m = meterAt(meter, Math.max(0, tick));
  const bar = ticksPerBar(m);
  return m.tick + Math.floor((Math.max(0, tick) - m.tick) / bar) * bar;
}

/** The steps from one bar line to another: each bar's are counted from its own line. */
export function stepsIn(meter: readonly MeterPoint[], from: number, to: number, size: number): Step[] {
  const out: Step[] = [];
  let bar = barLineAt(meter, from);
  while (bar < to) {
    const m = meterAt(meter, bar);
    const length = ticksPerBar(m);
    const beat = ticksPerBeat(m);
    const n = Math.ceil(length / size - 1e-9);
    for (let i = 0; i < n; i++) {
      const at = i * size;
      const inBeat = at - Math.floor(at / beat + 1e-9) * beat;
      out.push({
        tick: Math.round(bar + at),
        bar,
        index: i,
        beat: inBeat < 0.5,
        alt: Math.floor(at / beat + 1e-9) % 2 === 1,
      });
    }
    bar += length;
  }
  return out;
}

// ---- reading ----

/** A region's notes as they stand (an edit under way has its own list of them). */
export interface Held {
  region: Region;
  notes: Note[];
}

export interface StepNote {
  held: Held;
  note: Note;
}

export interface Cell {
  /** The notes of this pitch nearest this step (none: the step is dark). */
  notes: StepNote[];
  /** The hardest of them (0 when dark). */
  v: number;
  /** How far the first of them is from the step, ticks (early is below 0). */
  offset: number;
}

const dark = (): Cell => ({ notes: [], v: 0, offset: 0 });

/** A track's regions that hold notes (not a recording's), as they stand. */
export const heldOf = (track: Pick<Track, 'regions'>): Held[] =>
  track.regions.filter((r) => !r.audio).map((region) => ({ region, notes: region.notes }));

/** The step of `steps` a tick is nearest (-1: nearer the page before or after). `end`: where the steps end. */
export function nearestStep(steps: readonly Step[], end: number, tick: number): number {
  if (!steps.length) return -1;
  let lo = 0;
  let hi = steps.length - 1;
  // the last step at or before the tick
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((steps[mid] as Step).tick <= tick) lo = mid;
    else hi = mid - 1;
  }
  const here = steps[lo] as Step;
  if (tick < here.tick) {
    // before the first step: its, if nearer it than the step before would be
    const size = steps.length > 1 ? (steps[1] as Step).tick - here.tick : end - here.tick;
    return here.tick - tick <= size / 2 ? 0 : -1;
  }
  const next = steps[lo + 1]?.tick ?? end;
  if (tick - here.tick <= next - tick) return lo;
  return lo + 1 < steps.length ? lo + 1 : -1;
}

/** The notes over those steps, by pitch: a cell for each step, lit where a note is nearest it. */
export function readSteps(held: readonly Held[], steps: readonly Step[], end: number): Map<number, Cell[]> {
  const rows = new Map<number, Cell[]>();
  if (!steps.length) return rows;
  const first = (steps[0] as Step).tick;
  const reach = steps.length > 1 ? (steps[1] as Step).tick - first : end - first;
  for (const h of held) {
    if (h.region.start >= end || h.region.start + h.region.length <= first - reach) continue;
    for (const note of h.notes) {
      const at = h.region.start + note.t;
      if (at < first - reach || at >= end) continue;
      const i = nearestStep(steps, end, at);
      if (i < 0) continue;
      const pitch = Math.round(note.p);
      let row = rows.get(pitch);
      if (!row) {
        row = steps.map(dark);
        rows.set(pitch, row);
      }
      const cell = row[i] as Cell;
      if (!cell.notes.length) cell.offset = at - (steps[i] as Step).tick;
      cell.notes.push({ held: h, note });
      cell.v = Math.max(cell.v, note.v);
    }
  }
  return rows;
}

// ---- the kit ----

export interface StepRowName {
  note: number;
  name: string;
}

/** What of an instrument's map says it's a kit: named pads, or sounds that aren't played by pitch. */
export interface KitMap {
  pads?: readonly unknown[];
  pitched?: boolean;
}

/**
 * Whether an instrument plays each key as a sound of its own (a kit, a drum synth, single hits), not
 * as a pitch. `map`: a sampled instrument's map (null while it isn't known: then it isn't said to be one).
 */
export function playsHits(instrument: Instrument | null | undefined, map: KitMap | null): boolean {
  if (instrument?.type === 'synth') return DRUM_PRESETS.includes(instrument.preset);
  if ((instrument?.type !== 'sampler' && instrument?.type !== 'performance') || !map) return false;
  return Boolean(map.pads?.length) || map.pitched === false;
}

/** A kit's pieces in the order a drum machine lists them: kick, snare, hats, toms, cymbals, the rest. */
export const GM_STEP_ORDER = [
  36, 35, 38, 40, 37, 39, 42, 44, 46, 41, 43, 45, 47, 48, 50, 49, 57, 51, 59, 53, 52, 55, 54, 56, 70, 69, 75, 60, 61,
  62, 63, 64, 76, 77,
];
/** The rows an empty part starts with. */
export const GM_STEP_START = [36, 38, 42, 46, 39, 45, 50, 49];

/**
 * A kit's rows by name, in the kit's own order. `pads`: a sampled kit's named pads (its map's), or
 * none for General MIDI's names (a drum synth, a kit that names none).
 */
export function kitRows(pads: readonly { key: number; name: string }[] | null | undefined): StepRowName[] {
  if (pads?.length) return pads.map((p) => ({ note: p.key, name: p.name }));
  return GM_STEP_ORDER.map((note) => ({ note, name: GM_DRUMS[note] ?? `Key ${note}` }));
}

/**
 * The rows a part shows: the kit's pieces it plays, in the kit's order, then any other key it has
 * notes on; an empty part starts with the kit's first few. `all`: every piece of the kit. `core`:
 * those first few always, played or not (a grid to write in keeps the kick, snare and hats in reach).
 */
export function stepRows(
  kit: readonly StepRowName[],
  played: Iterable<number>,
  all = false,
  core = false,
): StepRowName[] {
  const used = new Set(played);
  const known = new Set(kit.map((r) => r.note));
  const others = [...used]
    .filter((n) => !known.has(n))
    .sort((a, b) => a - b)
    .map((note) => ({ note, name: GM_DRUMS[note] ?? `Key ${note}` }));
  if (all) return [...kit, ...others];
  const named = kit.filter((r) => GM_STEP_START.includes(r.note));
  const start = new Set((named.length >= 3 ? named : kit).slice(0, 8).map((r) => r.note));
  const any = [...used].length > 0;
  const mine = kit.filter((r) => used.has(r.note) || ((core || !any) && start.has(r.note)));
  return [...mine, ...others];
}

/** A row by what it's called or its key ("snare", "Closed Hat", "38"); undefined when the kit has none such. */
export function rowNamed(kit: readonly StepRowName[], text: string): StepRowName | undefined {
  const want = text.trim().toLowerCase();
  if (!want) return undefined;
  if (/^\d+$/.test(want)) {
    const note = Number(want);
    return (
      kit.find((r) => r.note === note) ?? (note <= 127 ? { note, name: GM_DRUMS[note] ?? `Key ${note}` } : undefined)
    );
  }
  return (
    kit.find((r) => r.name.toLowerCase() === want) ??
    kit.find((r) => r.name.toLowerCase().startsWith(want)) ??
    kit.find((r) => r.name.toLowerCase().includes(want))
  );
}

// ---- lines: a row as text ----

/** A row's cells as a line, a character a step: X x o g, and `.` for none. */
export const stepLine = (cells: readonly Cell[]): string =>
  cells.map((c) => (c.notes.length ? levelOf(c.v).letter : '.')).join('');

/**
 * A line as the levels it asks for, a step each (null: none). Spaces and bar lines (`|`) are for the
 * eye; `-` and `_` are rests too. Throws on anything else.
 */
export function parseLine(line: string): (StepLevel | null)[] {
  const out: (StepLevel | null)[] = [];
  for (const ch of line) {
    if (ch === ' ' || ch === '|' || ch === '\t') continue;
    if (ch === '.' || ch === '-' || ch === '_') out.push(null);
    else {
      const level = STEP_LEVELS.find((l) => l.letter === ch);
      if (!level) throw new Error(`"${ch}" isn't a step: X (accent), x (hit), o (soft), g (ghost) or . (none)`);
      out.push(level);
    }
  }
  return out;
}

// ---- edits ----

/** What an edit works on: a track's part over whole bars, on a grid. */
export interface StepContext {
  project: Pick<Project, 'meter'>;
  track: Track;
  /** Bar lines, in ticks. */
  from: number;
  to: number;
  /** The step, in ticks. */
  size: number;
}

/**
 * Every edit the Step Grid makes. `step` counts the context's steps from 0; an edit with no `pitch`
 * acts on every row that has notes there.
 */
export type StepEdit =
  /** Light a step (or, lit already, set how hard it's hit). */
  | { edit: 'set'; pitch: number; step: number; v?: number }
  /** Put a step out. */
  | { edit: 'clear'; pitch: number; step: number }
  /** How hard lit steps are hit: set to `v`, or changed by `by`. `steps`: only those. */
  | { edit: 'velocity'; pitch?: number; steps?: number[]; v?: number; by?: number }
  /** Light every `every`th step of a row, from `offset`. */
  | { edit: 'fill'; pitch: number; every: number; offset?: number; v?: number }
  /** A row made a Euclidean rhythm in each bar: `hits` spread as evenly as its steps allow, turned by `rotate`. */
  | { edit: 'euclid'; pitch: number; hits: number; rotate?: number; v?: number }
  /** Turn the pattern later (`by` above 0) or earlier, around its ends. */
  | { edit: 'shift'; pitch?: number; by: number }
  /** Vary how hard each lit step is hit, by up to `amount` either way. */
  | { edit: 'humanize'; pitch?: number; amount: number; seed?: number }
  /** Copy these bars over the bars at `to` (a bar line, ticks), `times` over. */
  | { edit: 'copy'; pitch?: number; to: number; times?: number }
  /** Push every other step late, by `amount` (0 to 0.75) of half a step; 0 puts them back on the grid. */
  | { edit: 'swing'; pitch?: number; amount: number }
  /** Put a row out (every row, with no `pitch`). */
  | { edit: 'clear-row'; pitch?: number }
  /** A row written as a line, a character a step (a line shorter than the bars is repeated). */
  | { edit: 'write'; pitch: number; pattern: string };

export type StepEditName = StepEdit['edit'];

/** The edits by name, with what each does in a few words (the agent's tool and the studio's menu say the same). */
export const STEP_EDITS: readonly { name: StepEditName; does: string }[] = [
  { name: 'set', does: 'light a step, or set how hard it’s hit' },
  { name: 'clear', does: 'put a step out' },
  { name: 'velocity', does: 'how hard lit steps are hit' },
  { name: 'fill', does: 'light every Nth step of a row' },
  { name: 'euclid', does: 'spread a number of hits evenly over each bar' },
  { name: 'shift', does: 'turn the pattern a step later or earlier' },
  { name: 'humanize', does: 'vary how hard each step is hit' },
  { name: 'copy', does: 'copy these bars over other bars' },
  { name: 'swing', does: 'push every other step late' },
  { name: 'clear-row', does: 'put a row out' },
  { name: 'write', does: 'write a row as a line of steps' },
];

/** The edits of a list that none of `offered` names: empty when everything is offered. */
export const missingStepEdits = (offered: Iterable<string>): StepEditName[] => {
  const has = new Set(offered);
  return STEP_EDITS.map((e) => e.name).filter((n) => !has.has(n));
};

const clampV = (v: number): number => Math.max(1, Math.min(127, Math.round(v)));

/** A seeded run of numbers from 0 up to 1 (so a test, and an undo and redo, get the same ones). */
function seeded(seed: number): () => number {
  let s = seed >>> 0 || 0x9e3779b9;
  return () => {
    s ^= s << 13;
    s >>>= 0;
    s ^= s >>> 17;
    s ^= s << 5;
    s >>>= 0;
    return s / 0x100000000;
  };
}

/** `hits` spread over `n` steps as evenly as they go (Bjorklund's rhythm), turned later by `rotate`. */
export function euclid(hits: number, n: number, rotate = 0): boolean[] {
  const k = Math.max(0, Math.min(n, Math.round(hits)));
  const out = Array.from({ length: n }, (_, i) => n > 0 && Math.floor((i * k) / n) !== Math.floor(((i - 1) * k) / n));
  if (k > 0 && n > 0) out[0] = true;
  const r = n ? ((Math.round(rotate) % n) + n) % n : 0;
  return out.map((_, i) => out[(i - r + n) % n] as boolean);
}

/** A track's part while it's edited: its regions' notes as they'd be, and the operations that make them so. */
class Draft {
  readonly held: Held[];
  private readonly touched = new Set<Held>();
  private readonly made = new Set<Held>();
  /** Regions of the track made longer here, and their notes as they were. */
  private readonly grown = new Set<Held>();
  private readonly was = new Map<Held, Note[]>();

  private readonly ctx: StepContext;

  constructor(ctx: StepContext, held?: Held[]) {
    this.ctx = ctx;
    this.held = held ?? heldOf(ctx.track);
  }

  private own(h: Held): void {
    if (this.was.has(h) || this.made.has(h)) return;
    this.was.set(h, h.notes);
    this.touched.add(h);
    h.notes = h.notes.slice();
  }

  remove(n: StepNote): void {
    this.own(n.held);
    n.held.notes = n.held.notes.filter((x) => x !== n.note);
  }

  swap(n: StepNote, note: Note): void {
    this.own(n.held);
    n.held.notes = n.held.notes.map((x) => (x === n.note ? note : x));
  }

  /** A hit at a tick of the song: into the region that's there, or a new one over the free part of that bar. */
  add(tick: number, hit: { p: number; v: number; d: number }, like?: Note): void {
    const at = Math.max(0, Math.round(tick));
    const inside = (h: Held) => at >= h.region.start && at < h.region.start + h.region.length;
    let h = this.held.find((x) => inside(x) && !x.region.muted) ?? this.held.find(inside);
    if (!h) {
      // the bar it's in, less whatever of it other regions have
      const m = meterAt(this.ctx.project.meter, at);
      let start = barLineAt(this.ctx.project.meter, at);
      let end = start + ticksPerBar(m);
      for (const x of this.held) {
        const xEnd = x.region.start + x.region.length;
        if (xEnd <= at) start = Math.max(start, xEnd);
        else if (x.region.start > at) end = Math.min(end, x.region.start);
      }
      // a region that ends right where this would start grows over it: a part written bar after bar
      // stays one region (one made here is joined to its neighbours as the edit ends)
      const before = this.held.find(
        (x) => !this.made.has(x) && !x.region.muted && x.region.start + x.region.length === start,
      );
      if (before) {
        h = before;
        this.grown.add(h);
        h.region = { ...h.region, length: end - h.region.start };
      } else {
        h = { region: newRegion(start, end - start, this.ctx.track.name), notes: [] };
        this.held.push(h);
        this.made.add(h);
      }
      this.touched.add(h);
    }
    this.own(h);
    const end = h.region.start + h.region.length;
    // (`like`: a note moved or copied keeps what else it carries, its articulation and how it's written)
    const note: Note = {
      ...like,
      t: at - h.region.start,
      d: Math.max(1, Math.min(hit.d, end - at)),
      p: hit.p,
      v: clampV(hit.v),
    };
    h.notes = [...h.notes, note];
  }

  /** The regions made here, those that touch joined into one. */
  private joined(): Held[] {
    const made = [...this.made].filter((h) => h.notes.length).sort((a, b) => a.region.start - b.region.start);
    const out: Held[] = [];
    for (const h of made) {
      const last = out.at(-1);
      if (last && last.region.start + last.region.length === h.region.start) {
        const shift = h.region.start - last.region.start;
        last.notes = [...last.notes, ...h.notes.map((n) => ({ ...n, t: n.t + shift }))];
        last.region = { ...last.region, length: last.region.length + h.region.length };
      } else out.push({ region: h.region, notes: h.notes });
    }
    return out;
  }

  ops(): Op[] {
    const ops: Op[] = [];
    for (const h of this.touched) {
      if (this.made.has(h)) continue;
      const before = this.was.get(h) ?? h.notes;
      const same = before.length === h.notes.length && before.every((n, i) => n === h.notes[i]);
      if (this.grown.has(h) && !same)
        ops.push({
          op: 'updateRegion',
          track: this.ctx.track.id,
          region: h.region.id,
          patch: { length: h.region.length },
        });
      if (!same) ops.push({ op: 'setNotes', track: this.ctx.track.id, region: h.region.id, notes: h.notes });
    }
    for (const h of this.joined())
      ops.push({ op: 'addRegion', track: this.ctx.track.id, region: { ...h.region, notes: h.notes } });
    return ops;
  }
}

/** One edit made on a draft. */
function make(draft: Draft, ctx: StepContext, e: StepEdit): void {
  const steps = stepsIn(ctx.project.meter, ctx.from, ctx.to, ctx.size);
  if (!steps.length) return;
  const read = () => readSteps(draft.held, steps, ctx.to);
  const rowsOf = (rows: Map<number, Cell[]>, pitch: number | undefined): [number, Cell[]][] =>
    pitch === undefined ? [...rows.entries()] : [[pitch, rows.get(pitch) ?? steps.map(dark)]];
  const stepAt = (i: number): Step => {
    const s = steps[i];
    if (!Number.isInteger(i) || !s) throw new Error(`There are ${steps.length} steps here: step ${i + 1} isn't one`);
    return s;
  };
  const light = (pitch: number, i: number, v: number, offset = 0) =>
    draft.add((steps[i] as Step).tick + offset, { p: pitch, v, d: ctx.size });
  const put = (cell: Cell) => {
    for (const n of cell.notes) draft.remove(n);
  };
  const hit = (cell: Cell, v: number) => {
    for (const n of cell.notes) if (n.note.v !== clampV(v)) draft.swap(n, { ...n.note, v: clampV(v) });
  };

  switch (e.edit) {
    case 'set': {
      stepAt(e.step);
      const cell = (read().get(e.pitch) ?? [])[e.step];
      if (cell?.notes.length) hit(cell, e.v ?? cell.v);
      else light(e.pitch, e.step, e.v ?? STEP_VELOCITY);
      return;
    }
    case 'clear': {
      stepAt(e.step);
      const cell = (read().get(e.pitch) ?? [])[e.step];
      if (cell) put(cell);
      return;
    }
    case 'velocity': {
      const only = e.steps ? new Set(e.steps) : null;
      for (const [, cells] of rowsOf(read(), e.pitch))
        cells.forEach((cell, i) => {
          if (!cell.notes.length || (only && !only.has(i))) return;
          if (e.v !== undefined) hit(cell, e.v);
          else if (e.by) for (const n of cell.notes) draft.swap(n, { ...n.note, v: clampV(n.note.v + e.by) });
        });
      return;
    }
    case 'fill': {
      const every = Math.max(1, Math.round(e.every));
      const offset = Math.max(0, Math.round(e.offset ?? 0));
      const row = read().get(e.pitch) ?? steps.map(dark);
      for (let i = offset; i < steps.length; i += every)
        if (!(row[i] as Cell).notes.length) light(e.pitch, i, e.v ?? STEP_VELOCITY);
      return;
    }
    case 'euclid': {
      const row = read().get(e.pitch) ?? steps.map(dark);
      for (const cell of row) put(cell);
      // each bar has the rhythm over its own steps
      let i = 0;
      while (i < steps.length) {
        const bar = (steps[i] as Step).bar;
        let n = 0;
        while (steps[i + n]?.bar === bar) n++;
        euclid(e.hits, n, e.rotate ?? 0).forEach((on, k) => {
          if (on) light(e.pitch, i + k, e.v ?? STEP_VELOCITY);
        });
        i += n;
      }
      return;
    }
    case 'shift': {
      const by = Math.round(e.by);
      const n = steps.length;
      if (!by || !n) return;
      for (const [pitch, cells] of rowsOf(read(), e.pitch)) {
        const was = cells.map((c) => c.notes.map((x) => ({ note: x.note, at: x.held.region.start + x.note.t })));
        for (const cell of cells) put(cell);
        was.forEach((notes, i) => {
          const to = (((i + by) % n) + n) % n;
          for (const { note, at } of notes)
            draft.add(
              (steps[to] as Step).tick + (at - (steps[i] as Step).tick),
              { p: pitch, v: note.v, d: note.d },
              note,
            );
        });
      }
      return;
    }
    case 'humanize': {
      const amount = Math.max(0, Math.min(60, e.amount));
      const next = seeded(e.seed ?? 1);
      for (const [, cells] of rowsOf(read(), e.pitch))
        for (const cell of cells)
          for (const n of cell.notes) {
            const v = clampV(n.note.v + (next() * 2 - 1) * amount);
            if (v !== n.note.v) draft.swap(n, { ...n.note, v });
          }
      return;
    }
    case 'copy': {
      const length = ctx.to - ctx.from;
      const times = Math.max(1, Math.min(64, Math.round(e.times ?? 1)));
      const first = barLineAt(ctx.project.meter, e.to);
      if (first !== e.to) throw new Error('Bars are copied to a bar line');
      const from = rowsOf(read(), e.pitch).map(
        ([pitch, cells]) =>
          [
            pitch,
            cells.flatMap((c) => c.notes.map((x) => ({ note: x.note, at: x.held.region.start + x.note.t }))),
          ] as const,
      );
      for (let k = 0; k < times; k++) {
        const at = e.to + k * length;
        if (at < ctx.to && at + length > ctx.from) throw new Error('Bars can’t be copied over themselves');
        const there = stepsIn(ctx.project.meter, at, at + length, ctx.size);
        const rows = readSteps(draft.held, there, at + length);
        for (const [pitch, notes] of from) {
          for (const cell of rows.get(pitch) ?? []) put(cell);
          for (const n of notes) draft.add(at + (n.at - ctx.from), { p: pitch, v: n.note.v, d: n.note.d }, n.note);
        }
      }
      return;
    }
    case 'swing': {
      if (!swings(ctx.size)) throw new Error('A triplet grid has no off-steps to swing: choose 1/8, 1/16 or 1/32');
      const late = Math.round(Math.max(0, Math.min(MAX_SWING, e.amount)) * ctx.size * 0.5);
      for (const [, cells] of rowsOf(read(), e.pitch))
        cells.forEach((cell, i) => {
          if (!cell.notes.length || (steps[i] as Step).index % 2 === 0) return;
          // the step's notes keep their places among themselves (a flam stays one)
          const move = (steps[i] as Step).tick + late - (cell.notes[0] as StepNote).held.region.start;
          const shift = move - (cell.notes[0] as StepNote).note.t;
          if (shift) for (const n of cell.notes) draft.swap(n, { ...n.note, t: Math.max(0, n.note.t + shift) });
        });
      return;
    }
    case 'clear-row': {
      for (const [, cells] of rowsOf(read(), e.pitch)) for (const cell of cells) put(cell);
      return;
    }
    case 'write': {
      const line = parseLine(e.pattern);
      if (!line.length) throw new Error('The line has no steps: a character a step, like "x...x...x...x..."');
      if (line.length > steps.length)
        throw new Error(`The line has ${line.length} steps and there are ${steps.length} here`);
      const row = read().get(e.pitch) ?? steps.map(dark);
      row.forEach((cell, i) => {
        const level = line[i % line.length] as StepLevel | null;
        if (!level) put(cell);
        else if (!cell.notes.length) light(e.pitch, i, level.v);
        // (a step that reads as that level already keeps its own velocity)
        else if (levelOf(cell.v) !== level) hit(cell, level.v);
      });
      return;
    }
  }
}

/** The operations that make these edits, one after another, on a track's part (none when nothing changes). */
export function stepOps(ctx: StepContext, edits: StepEdit | readonly StepEdit[]): Op[] {
  const draft = new Draft(ctx);
  for (const e of Array.isArray(edits) ? (edits as readonly StepEdit[]) : [edits as StepEdit]) make(draft, ctx, e);
  return draft.ops();
}

/** The part as those edits would leave it, without making them: what a drag shows before it's let go. */
export function stepPreview(ctx: StepContext, edits: readonly StepEdit[]): Held[] {
  const draft = new Draft(ctx);
  for (const e of edits) make(draft, ctx, e);
  return draft.held;
}
