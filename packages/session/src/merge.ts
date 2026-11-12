/**
 * A MIDI or MusicXML file brought into a song: its parts become new tracks (or one part goes onto a
 * track the song has), as operations the studio applies as one undo step. The file arrives as a song
 * of its own (`projectFromMidi(readMidi(…))`, or `readMusicXml(…)` in @holo/score), and:
 *
 * - everything brought in gets new ids: tracks, regions, plugins, articulations;
 * - the song keeps its meter and key: the notes keep their beats from where the file starts, and each
 *   part's region starts and ends on the song's bar lines (whatever bars the file had);
 * - a send goes to the song's bus of the same name, or is left out: never to a bus the song lacks;
 * - clef changes, automation and a part's dynamics move with the notes;
 * - the song keeps its tempo (`keep`), or takes the file's (`adopt`) for as long as what came in runs,
 *   its own coming back after where the song goes on.
 *
 * A file with a pickup lands with its first full bar where it's put, the pickup just before.
 */
import { newId, TRACK_COLORS } from './defaults.ts';
import type { Op } from './ops.ts';
import { barToTick, bpmAt, meterAt, ticksPerBar, tickToBarBeat } from './time.ts';
import type {
  AutomationLane,
  CCPoint,
  Channel,
  Instrument,
  Mark,
  MeterPoint,
  Note,
  Plugin,
  Project,
  Region,
  Seat,
  TempoPoint,
  Track,
} from './types.ts';

/** Something the file or the options don't allow, said so it can be put right. */
export class MergeError extends Error {}

export interface MergeOptions {
  /** The song's tick where the file starts (its first full bar, when it begins with a pickup). */
  at: number;
  /** `keep` (the default): the song's tempo stays. `adopt`: the file's tempo runs through what came in. */
  tempo?: 'keep' | 'adopt';
  /** Which of the file's parts: names (or the start of one) or numbers from 1; every part when unsaid. */
  parts?: readonly (string | number)[];
  /** One of the song's instrument tracks, for the one part brought in (instead of a new track). */
  into?: string;
  /** The new track's name, when one part comes in as a new track. */
  name?: string;
}

/** Where a part of the file went. */
export interface MergedPart {
  /** Its name in the file. */
  part: string;
  /** The track it's on (a new one, or the song's own `into`), and that track's name. */
  track: string;
  name: string;
  added: boolean;
  notes: number;
  /** The region it's in, in the song's ticks: on its bar lines. */
  start: number;
  end: number;
}

export interface Merge {
  ops: Op[];
  parts: MergedPart[];
  /** A tick of the file is this tick of the song, less this. */
  offset: number;
  tempo: 'kept' | 'adopted';
  /** What's worth telling: what was left out, or fitted to the song. */
  notes: string[];
}

/** The bar line at or before a tick. */
export function barLineBefore(meter: readonly MeterPoint[], tick: number): number {
  return barToTick(meter, tickToBarBeat(meter, tick).bar);
}

/** The bar line at or after a tick. */
export function barLineAfter(meter: readonly MeterPoint[], tick: number): number {
  const bar = tickToBarBeat(meter, tick).bar;
  const at = barToTick(meter, bar);
  return at >= tick ? at : barToTick(meter, bar + 1);
}

/** A part's notes, controllers and marks, at the file's own ticks (from its regions, muted ones aside). */
interface Gathered {
  notes: Note[];
  cc: Record<string, CCPoint[]>;
  marks: Mark[];
  first: number;
  last: number;
}

function gather(track: Track): Gathered | null {
  const notes: Note[] = [];
  const cc: Record<string, CCPoint[]> = {};
  const marks: Mark[] = [];
  for (const r of track.regions) {
    if (r.muted) continue;
    for (const n of r.notes) notes.push({ ...n, t: n.t + r.start });
    for (const [lane, points] of Object.entries(r.cc)) {
      const list = cc[lane] ?? [];
      for (const [t, v] of points) list.push([t + r.start, v]);
      cc[lane] = list;
    }
    for (const m of r.marks ?? [])
      marks.push({ ...m, t: m.t + r.start, ...(m.e !== undefined ? { e: m.e + r.start } : {}) });
  }
  const ticks = [
    ...notes.flatMap((n) => [n.t, n.t + n.d]),
    ...Object.values(cc).flatMap((points) => points.map((p) => p[0])),
    ...marks.flatMap((m) => [m.t, m.e ?? m.t]),
  ];
  if (!notes.length) return null;
  for (const points of Object.values(cc)) points.sort((a, b) => a[0] - b[0]);
  notes.sort((a, b) => a.t - b.t || a.p - b.p);
  marks.sort((a, b) => a.t - b.t);
  return { notes, cc, marks, first: Math.min(...ticks), last: Math.max(...ticks) };
}

/** The file's parts asked for (every instrument part when none are), in the file's order. */
function choose(imported: Project, parts: MergeOptions['parts']): Track[] {
  const all = imported.tracks.filter((t) => t.kind === 'instrument');
  if (!all.length) throw new MergeError('The file has no parts');
  if (!parts?.length) return all;
  const list = () => all.map((t, i) => `${i + 1} "${t.name}"`).join(', ');
  const chosen = new Set<Track>();
  for (const want of parts) {
    const text = String(want).trim();
    let found: Track | undefined;
    if (/^\d+$/.test(text)) found = all[Number(text) - 1];
    else if (text) {
      const lower = text.toLowerCase();
      found = all.find((t) => t.name.toLowerCase() === lower);
      if (!found) {
        const starts = all.filter((t) => t.name.toLowerCase().startsWith(lower));
        if (starts.length > 1)
          throw new MergeError(`"${text}" could be ${starts.map((t) => `"${t.name}"`).join(' or ')}: say which`);
        found = starts[0];
      }
    }
    if (!found) throw new MergeError(`The file has no part "${text}". Its parts: ${list()}`);
    chosen.add(found);
  }
  return all.filter((t) => chosen.has(t));
}

/** A tick moved by the offset, never before the song's start. */
const moved = (tick: number, offset: number) => Math.max(0, tick + offset);

/** A region of the part's events on the song's bar lines. */
function regionOf(song: Project, g: Gathered, offset: number, name: string, art: (a?: string) => string | undefined) {
  const start = barLineBefore(song.meter, g.first + offset);
  const end = Math.max(barLineAfter(song.meter, g.last + offset), barLineAfter(song.meter, start + 1));
  const at = (t: number) => t + offset - start;
  const region: Region = {
    id: newId('rgn'),
    name,
    start,
    length: end - start,
    muted: false,
    notes: g.notes.map((n) => {
      const { art: from, ...rest } = n;
      const to = art(from);
      return { ...rest, t: at(n.t), ...(to ? { art: to } : {}) };
    }),
    cc: Object.fromEntries(
      Object.entries(g.cc).map(([lane, points]) => [lane, points.map(([t, v]): CCPoint => [at(t), v])]),
    ),
  };
  if (g.marks.length)
    region.marks = g.marks.map((m) => ({ ...m, t: at(m.t), ...(m.e !== undefined ? { e: at(m.e) } : {}) }));
  return region;
}

/**
 * The file's tempo from where it lands to the bar line after it ends (`to`, a song tick), then the
 * song's own again if the song goes on.
 */
function adoptTempo(song: Project, imported: Project, offset: number, to: number): TempoPoint[] {
  const from = Math.max(0, offset);
  // the song's points outside what came in (a ramp running into it stops where it starts)
  const kept = song.tempo
    .filter((p) => p.tick < from || p.tick >= to)
    .map((p) => {
      if (p.tick >= from || p.ramp === undefined || p.ramp <= from) return p;
      const { ramp: _ramp, to: _to, ...rest } = p;
      return rest;
    });
  const theirs = imported.tempo
    .filter((p) => p.tick + offset >= from && p.tick + offset < to)
    .map((p) => {
      const point: TempoPoint = { ...p, tick: p.tick + offset };
      if (p.ramp !== undefined) point.ramp = Math.min(p.ramp + offset, to);
      return point;
    });
  if (theirs[0]?.tick !== from) theirs.unshift({ tick: from, bpm: bpmAt(imported.tempo, from - offset) });
  // where the song goes on past what came in, its own tempo comes back
  const songEnd = Math.max(
    0,
    ...song.tracks.flatMap((t) => t.regions.map((r) => r.start + r.length)),
    ...song.markers.map((m) => m.tick),
  );
  const back = bpmAt(song.tempo, to);
  if (songEnd > to && !kept.some((p) => p.tick === to) && back !== theirs.at(-1)?.bpm)
    kept.push({ tick: to, bpm: back });
  return [...kept, ...theirs].sort((a, b) => a.tick - b.tick);
}

/**
 * The operations that bring the file's parts into the song: its tempo when adopted (`setProject`),
 * then each new track (`addTrack`, empty) and its region (`addRegion`). Throws a MergeError for a
 * part that isn't there, or a track that can't take it.
 */
export function mergeOps(song: Project, imported: Project, options: MergeOptions): Merge {
  const notes: string[] = [];
  const parts = choose(imported, options.parts);
  const gathered = parts.map((t) => ({ track: t, g: gather(t) }));
  const empty = gathered.filter((x) => !x.g).map((x) => `"${x.track.name}"`);
  const full = gathered.filter((x): x is { track: Track; g: Gathered } => x.g !== null);
  if (!full.length) throw new MergeError(parts.length === 1 ? 'That part has no notes' : 'The file has no notes');
  if (empty.length) notes.push(`${empty.join(', ')} ${empty.length === 1 ? 'has' : 'have'} no notes: left out`);

  const into = options.into ? song.tracks.find((t) => t.id === options.into) : undefined;
  if (options.into) {
    if (!into) throw new MergeError(`The song has no track "${options.into}"`);
    if (into.kind !== 'instrument')
      throw new MergeError(`"${into.name}" is an audio track: notes go on an instrument track, or a new one`);
    if (full.length !== 1)
      throw new MergeError(
        `${full.length} parts can't all go on "${into.name}": choose one with parts, or bring them in as new tracks`,
      );
  }

  // the file's first full bar where it's put, a pickup just before (or at it, when there's no room)
  const m0 = imported.meter[0];
  const lead = m0?.pickup ? ticksPerBar(m0) : 0;
  const earliest = Math.min(...full.map((x) => x.g.first));
  let offset = options.at - lead;
  if (offset + earliest < 0) {
    offset = options.at;
    notes.push('Its pickup had no room before where it was put: the pickup bar starts there');
  }

  const ops: Op[] = [];
  const out: MergedPart[] = [];
  const dropped = new Set<string>();
  // (the file's tempo runs to the bar line after what came in)
  const end = barLineAfter(song.meter, offset + Math.max(...full.map((x) => x.g.last)));
  if (options.tempo === 'adopt')
    ops.push({ op: 'setProject', patch: { tempo: adoptTempo(song, imported, offset, end) } });

  // the song's bus of the same name as one of the file's (a send to anything else is left out)
  const busFor = (id: string): string | null => {
    if (id === 'master') return 'master';
    const theirs = imported.buses.find((b) => b.id === id);
    const ours = theirs && song.buses.find((b) => b.name.trim().toLowerCase() === theirs.name.trim().toLowerCase());
    if (!ours) dropped.add(theirs?.name ?? id);
    return ours?.id ?? null;
  };

  full.forEach(({ track, g }, i) => {
    if (into) {
      const region = regionOf(song, g, offset, track.name, () => undefined);
      ops.push({ op: 'addRegion', track: into.id, region });
      const overlaps = into.regions.filter(
        (r) => r.start < region.start + region.length && region.start < r.start + r.length,
      );
      if (overlaps.length)
        notes.push(
          `It overlaps ${overlaps.length === 1 ? 'a region' : `${overlaps.length} regions`} on "${into.name}"`,
        );
      out.push({
        part: track.name,
        track: into.id,
        name: into.name,
        added: false,
        notes: region.notes.length,
        start: region.start,
        end: region.start + region.length,
      });
      return;
    }
    const arts = new Map(track.articulations.map((a) => [a.id, newId('art')]));
    const fx = new Map<string, string>();
    const plugin = (p: Plugin): Plugin => {
      const id = newId('fx');
      fx.set(p.id, id);
      return { ...structuredClone(p), id };
    };
    const midiFx = track.midiFx.map(plugin);
    const channel = channelFor(track.channel, plugin, fx, busFor, offset);
    const name = (full.length === 1 && options.name?.trim()) || track.name;
    const region = regionOf(song, g, offset, name, (a) => (a ? arts.get(a) : undefined));
    const added: Track = {
      id: newId('trk'),
      name,
      color: TRACK_COLORS[(song.tracks.length + i) % TRACK_COLORS.length] ?? track.color,
      kind: 'instrument',
      instrument: instrumentFor(track.instrument, offset),
      articulations: track.articulations.map((a) => ({
        ...structuredClone(a),
        id: arts.get(a.id) ?? newId('art'),
        instrument: instrumentFor(a.instrument, offset),
      })),
      input: { ...track.input },
      armed: false,
      midiFx,
      regions: [],
      channel,
    };
    if (track.score) {
      const score = structuredClone(track.score);
      // a staff's first clef stays at the start; later changes move with the notes
      if (score.clefs)
        score.clefs = score.clefs.map(([t, staff, clef]) => [t === 0 ? 0 : moved(t, offset), staff, clef]);
      added.score = score;
    }
    ops.push({ op: 'addTrack', track: added }, { op: 'addRegion', track: added.id, region });
    out.push({
      part: track.name,
      track: added.id,
      name,
      added: true,
      notes: region.notes.length,
      start: region.start,
      end: region.start + region.length,
    });
  });

  if (dropped.size)
    notes.push(`Sends to ${[...dropped].map((b) => `"${b}"`).join(', ')} left out: the song has no such bus`);
  const theirs = imported.meter[0];
  const ours = meterAt(song.meter, options.at);
  if (theirs && (theirs.num !== ours.num || theirs.den !== ours.den))
    notes.push(
      `The file is in ${theirs.num}/${theirs.den} and the song in ${ours.num}/${ours.den}: the notes keep their beats, in the song's bars`,
    );
  if (options.tempo !== 'adopt') {
    const file = Math.round((imported.tempo[0]?.bpm ?? 120) * 100) / 100;
    const here = Math.round(bpmAt(song.tempo, options.at) * 100) / 100;
    if (file !== here) notes.push(`The file's tempo is ${file}; the song keeps its ${here}`);
  }
  const left = [
    imported.markers.length ? 'markers' : '',
    imported.chords.length ? 'chord symbols' : '',
    imported.form?.length ? 'repeats' : '',
  ].filter(Boolean);
  if (left.length) notes.push(`Its ${left.join(', ')} weren't brought in`);
  const audio = imported.tracks.filter((t) => t.kind === 'audio').length;
  if (audio) notes.push(`${audio} audio track${audio === 1 ? '' : 's'} left out`);

  return { ops, parts: out, offset, tempo: options.tempo === 'adopt' ? 'adopted' : 'kept', notes };
}

/** An instrument as it is, a performance's dynamics moved with the notes. */
function instrumentFor(instrument: Instrument, offset: number): Instrument {
  const copy = structuredClone(instrument);
  if (copy.type === 'performance' && copy.play?.dyn)
    copy.play.dyn = copy.play.dyn.map(([t, v]): [number, number] => [moved(t, offset), v]);
  return copy;
}

/** A part's channel in the song: new plugin ids, its sends to the song's buses only, automation moved. */
function channelFor(
  channel: Channel,
  plugin: (p: Plugin) => Plugin,
  fx: Map<string, string>,
  busFor: (id: string) => string | null,
  offset: number,
): Channel {
  const inserts = channel.inserts.map(plugin);
  const sends = channel.sends.flatMap((s) => {
    const bus = busFor(s.bus);
    return bus && bus !== 'master' ? [{ ...s, bus }] : [];
  });
  const lane = (a: AutomationLane): AutomationLane[] => {
    let param = a.param;
    if (param.startsWith('send:')) {
      const bus = busFor(param.slice(5));
      if (!bus || bus === 'master') return [];
      param = `send:${bus}`;
    } else if (param.startsWith('fx:')) {
      const [, id = '', ...rest] = param.split(':');
      const to = fx.get(id);
      if (!to) return [];
      param = `fx:${to}:${rest.join(':')}`;
    }
    return [{ ...a, param, points: a.points.map(([t, v]): [number, number] => [moved(t, offset), v]) }];
  };
  const seat = (s: Seat): Seat => ({
    ...s,
    sends: s.sends.flatMap((x) => {
      const bus = busFor(x.bus);
      return bus && bus !== 'master' ? [{ ...x, bus }] : [];
    }),
  });
  const out: Channel = {
    ...structuredClone(channel),
    inserts,
    sends,
    output: channel.output === 'master' ? 'master' : (busFor(channel.output) ?? 'master'),
  };
  if (channel.automation) out.automation = channel.automation.flatMap(lane);
  if (channel.stage) out.stage = { ...channel.stage, near: seat(channel.stage.near), far: seat(channel.stage.far) };
  return out;
}
