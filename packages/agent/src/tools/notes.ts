/**
 * Notes on a track: read bar by bar, written in the compact notation, cleared over a span. A write
 * never sends a region's whole note list from the agent's copy: the user may be editing that region
 * at the same time. It adds notes (`addNotes`), or replaces only the notes that start in the span it
 * writes (`setNotesIn`), so whatever the user does elsewhere stays.
 */
import {
  barToTick,
  describeNotes,
  type MiddleC,
  meterAt,
  type Note,
  newRegion,
  type Op,
  type Project,
  parseNotation,
  type Region,
  type Track,
  ticksPerBar,
  tickToBarBeat,
} from '@holo/session';
import {
  barsText,
  bool,
  change,
  need,
  num,
  plural,
  position,
  str,
  type Tool,
  ToolError,
  trackRef,
  UNITS,
  unitTicks,
} from './common.ts';

/** The most notes notes_show lists at once: more is better read a few bars at a time. */
const SHOW_MAX = 600;

export const notesShow: Tool = {
  name: 'notes_show',
  kind: 'see',
  summary: ({ middleC }) =>
    `A track's notes in order, bar by bar: each note's position (bar.beat.sixteenth.tick; 960 ticks to a quarter), name (middle C, MIDI 60, is ${middleC}) with its MIDI number, length in ticks, velocity, and region id. "from" and "to" are positions; "to" is where it stops (not included). Example: {"track": "Strings", "from": "9", "to": "17"} lists bars 9–16.`,
  args: [
    { name: 'track', type: 'string', describe: 'The track: its name (or the start of it) or id', required: true },
    {
      name: 'from',
      type: 'string',
      describe: 'First position, bar.beat.sixteenth (e.g. "9"); the start when left out',
    },
    { name: 'to', type: 'string', describe: 'Where to stop, not included (e.g. "17"); the end when left out' },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const track = trackRef(project, str(args, 'track'));
    const fromText = str(args, 'from');
    const toText = str(args, 'to');
    const from = fromText ? position(project, fromText, 'start') : 0;
    const to = toText ? position(project, toText, 'end') : Number.POSITIVE_INFINITY;
    if (to <= from) throw new ToolError('"to" must come after "from"');
    if (track.kind === 'audio') {
      return {
        text: `${track.name} is an audio track (recordings, no notes): ${plural(track.regions.length, 'region')}.`,
      };
    }
    // a long list stops before the note past the limit (and the chord it's in), to be asked for again
    const starts = track.regions
      .flatMap((r) => r.notes.map((n) => r.start + n.t))
      .filter((t) => t >= from && t < to)
      .sort((a, b) => a - b);
    const cut = starts.length > SHOW_MAX ? (starts[SHOW_MAX] as number) : to;
    const text = describeNotes(project, track, { from, to: cut, middleC: ctx.middleC });
    if (cut >= to) return { text };
    const p = tickToBarBeat(project.meter, cut);
    const rest = starts.filter((t) => t >= cut).length;
    return {
      text: `${text}\n… ${plural(rest, 'more note')} from ${p.bar}.${p.beat}.${p.div}.${p.tick}: ask again with "from": "t:${cut}".`,
    };
  },
};

/** How long a passage of the notation lasts, rests included: the span a replacing write clears. */
export function notationLength(text: string, unit: number): number {
  let total = 0;
  for (const raw of text.match(/\([^)]*\)\S*|\S+/g) ?? []) {
    if (raw === '|') continue;
    const token = raw.replace(/@\d+$/, '').replace(/[!?~]+$/, '');
    const value = token.slice(token.lastIndexOf(':') + 1);
    const [a = '0', b = '1'] = value.split('/');
    total += (value.includes('/') ? Number(a) / Number(b) : Number(value)) * unit;
  }
  return Math.round(total);
}

interface Target {
  region: Region;
  fresh: boolean;
  /** Where it should end to hold its notes. */
  end: number;
  notes: Note[];
}

/**
 * Notes (song ticks) into a track over [start, end): each into the region it starts in; a note past
 * a region the write runs through lengthens that region (on whole bars, never into the next one);
 * a note with no region near gets a new one. With `replace`, the notes that started in the span in
 * each region it covers go first.
 */
export function placeNotes(
  project: Project,
  track: Track,
  start: number,
  end: number,
  notes: Note[],
  replace: boolean,
): Op[] {
  const existing = track.regions.filter((r) => !r.audio).sort((a, b) => a.start - b.start);
  const targets: Target[] = [];
  const target = (region: Region, fresh = false): Target => {
    let t = targets.find((x) => x.region.id === region.id);
    if (!t) {
      t = { region, fresh, end: region.start + region.length, notes: [] };
      targets.push(t);
    }
    return t;
  };
  /** Where the next region after a tick starts: no region grows into it. */
  const nextStart = (from: number) => existing.find((r) => r.start > from)?.start ?? Number.POSITIVE_INFINITY;
  const barStart = (tick: number) => barToTick(project.meter, tickToBarBeat(project.meter, tick).bar);
  // the regions the span runs through take part, even those it only clears
  for (const r of existing) if (r.start < end && r.start + r.length > start) target(r);
  for (const n of notes.slice().sort((a, b) => a.t - b.t)) {
    const inside = existing.find((r) => n.t >= r.start && n.t < r.start + r.length);
    if (inside) {
      const t = target(inside);
      t.notes.push(n);
      t.end = Math.max(t.end, Math.min(n.t + n.d, nextStart(inside.start)));
      continue;
    }
    // past the end of a region the write runs through (the nearest before the note): it grows to
    // take the note, since the rests between are part of the write too
    const before = targets.filter((t) => t.region.start <= n.t).sort((a, b) => b.region.start - a.region.start)[0];
    if (before) {
      before.notes.push(n);
      before.end = Math.max(before.end, n.t + n.d);
      continue;
    }
    // before every region the write touches: a new region from the bar the note is in (or from
    // the end of an earlier region, so the two don't overlap)
    const prevEnd = Math.max(0, ...existing.filter((r) => r.start <= n.t).map((r) => r.start + r.length));
    const s = Math.max(prevEnd, barStart(n.t));
    const fresh = target(newRegion(s, ticksPerBar(meterAt(project.meter, s)), ''), true);
    fresh.notes.push(n);
    fresh.end = Math.max(fresh.end, n.t + n.d);
  }
  const ops: Op[] = [];
  for (const t of targets) {
    const r = t.region;
    // regions are lengthened on whole bars, but never into the next region
    const bar = ticksPerBar(meterAt(project.meter, r.start));
    const wanted = Math.max(r.length, Math.ceil((t.end - r.start) / bar) * bar);
    const length = Math.max(Math.min(wanted, nextStart(r.start) - r.start), ...t.notes.map((n) => n.t - r.start + 1));
    const shifted = t.notes.map((n) => ({ ...n, t: n.t - r.start }));
    if (t.fresh) {
      ops.push({ op: 'addRegion', track: track.id, region: { ...r, length, notes: shifted } });
      continue;
    }
    if (length > r.length) ops.push({ op: 'updateRegion', track: track.id, region: r.id, patch: { length } });
    if (replace) {
      const from = Math.max(start, r.start) - r.start;
      ops.push({ op: 'setNotesIn', track: track.id, region: r.id, from, to: end - r.start, notes: shifted });
    } else if (shifted.length) ops.push({ op: 'addNotes', track: track.id, region: r.id, notes: shifted });
  }
  return ops;
}

const notationHelp = (middleC: MiddleC) =>
  `The notation: NOTE:DUR is a note (C4:2, F#5:1, Bb3:1/2), r:DUR a rest, (D4 F#4 A4):4 a chord; DUR counts "unit"s (an eighth by default; 1.5 and 1/2 work); | is only for reading. After a note: ! accents it, ? makes it a ghost note, ~ ties it into the next note of the same pitch, @96 sets its velocity. Middle C (MIDI 60) is ${middleC}; a sharp or flat is kept as written on the score.`;

export const notesWrite: Tool = {
  name: 'notes_write',
  kind: 'change',
  summary: ({ middleC }) =>
    `Write notes on a track from a position, in the compact notation. ${notationHelp(middleC)} The notes go into the region there (lengthened to fit) or a new one. With "replace": true, the notes that started in the span this passage covers (rests included) are replaced; otherwise they're added to what's there. Example: {"track": "Strings", "at": "9", "unit": "1/8", "notes": "A4:2 C#5:2 (D4 F#4 A4):4 r:1 E5:1"}. Prefer a new track for a new voice (a counter-melody, a harmony) unless the user asked to change their part.`,
  args: [
    { name: 'track', type: 'string', describe: 'The track: its name (or the start of it) or id', required: true },
    {
      name: 'at',
      type: 'string',
      describe: 'Where the first note or rest starts, bar.beat.sixteenth: "9", "9.3", "9.3.2"',
      required: true,
    },
    {
      name: 'notes',
      type: 'string',
      describe: 'The notes, e.g. "A4:2 C#5:2 (D4 F#4 A4):4 r:1"',
      required: true,
      maxLength: 20000,
    },
    {
      name: 'unit',
      type: 'enum',
      values: UNITS,
      describe: 'What a duration of 1 is: 1/8 an eighth, 1/16 a sixteenth, 1/4T a quarter triplet…',
      default: '1/8',
    },
    {
      name: 'velocity',
      type: 'integer',
      describe: 'Velocity of notes without @, 1–127',
      min: 1,
      max: 127,
      default: 90,
    },
    {
      name: 'gate',
      type: 'number',
      describe: 'How much of each duration sounds: 1 legato, 0.5 staccato',
      min: 0.05,
      max: 1,
    },
    {
      name: 'replace',
      type: 'boolean',
      describe: 'Replace what started in the span written, instead of adding',
      default: false,
    },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const track = trackRef(project, str(args, 'track'));
    if (track.kind === 'audio') throw new ToolError(`${track.name} is an audio track: notes go on an instrument track`);
    const start = position(project, str(args, 'at'));
    const unit = unitTicks(str(args, 'unit'));
    const text = need(args, 'notes');
    let notes: Note[];
    try {
      const gate = num(args, 'gate');
      notes = parseNotation(text, {
        unit,
        start,
        velocity: num(args, 'velocity') ?? 90,
        middleC: ctx.middleC,
        ...(gate !== undefined ? { gate } : {}),
      });
    } catch (err) {
      throw new ToolError(`${err instanceof Error ? err.message : String(err)}. ${notationHelp(ctx.middleC)}`);
    }
    const replace = bool(args, 'replace') === true;
    const end = Math.max(start + 1, start + notationLength(text, unit), ...notes.map((n) => n.t + n.d));
    if (!notes.length && !replace)
      throw new ToolError('Those are all rests: nothing to write (use "replace" to clear)');
    if (notes.some((n) => n.p < 0 || n.p > 127)) throw new ToolError('A note is outside MIDI 0–127');
    const ops = placeNotes(project, track, start, end, notes, replace);
    const span = barsText(project, start, end);
    if (!ops.length) return { text: `Nothing on ${track.name} there to replace.` };
    const what = notes.length ? `${plural(notes.length, 'note')} on ${track.name}, ${span}` : `${track.name}, ${span}`;
    const label = notes.length ? `Wrote ${what}` : `Cleared ${what}`;
    await change(ctx, project, ops, label);
    return { text: `${label}${replace && notes.length ? ' (replacing what started there)' : ''}.`, progress: label };
  },
};

export const notesClear: Tool = {
  name: 'notes_clear',
  kind: 'change',
  summary:
    'Remove the notes that start in a span of a track. "from" and "to" are positions (bar.beat.sixteenth); "to" is where it stops, not included, and the end of the song when left out. Example: {"track": "Bass", "from": "9", "to": "13"} clears bars 9–12. The regions stay.',
  args: [
    { name: 'track', type: 'string', describe: 'The track: its name (or the start of it) or id', required: true },
    { name: 'from', type: 'string', describe: 'First position cleared, e.g. "9"', required: true },
    { name: 'to', type: 'string', describe: 'Where clearing stops, not included, e.g. "13"' },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const track = trackRef(project, str(args, 'track'));
    const from = position(project, str(args, 'from'), 'start');
    const toText = str(args, 'to');
    const to = toText ? position(project, toText, 'end') : Number.POSITIVE_INFINITY;
    if (to <= from) throw new ToolError('"to" must come after "from"');
    const ops: Op[] = [];
    let n = 0;
    for (const r of track.regions) {
      if (r.audio) continue;
      const gone = r.notes.filter((x) => r.start + x.t >= from && r.start + x.t < to).length;
      if (!gone) continue;
      n += gone;
      // the span in the region's own ticks; JSON has no infinity, so "to the end" is past its last note
      const relTo = Number.isFinite(to) ? to - r.start : Math.max(r.length, ...r.notes.map((x) => x.t + 1));
      ops.push({
        op: 'setNotesIn',
        track: track.id,
        region: r.id,
        from: Math.max(0, from - r.start),
        to: relTo,
        notes: [],
      });
    }
    if (!ops.length) return { text: `Nothing to clear on ${track.name} there.` };
    const span = Number.isFinite(to) ? barsText(project, from, to) : `from ${barsText(project, from, from + 1)}`;
    const label = `Cleared ${plural(n, 'note')} on ${track.name}, ${span}`;
    await change(ctx, project, ops, label);
    return { text: `${label}.`, progress: label };
  },
};

export const noteTools: Tool[] = [notesShow, notesWrite, notesClear];
