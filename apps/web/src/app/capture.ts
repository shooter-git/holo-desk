/**
 * Capture: what was just played becomes regions, whether or not Record was on. This is the part
 * with no browser in it: the memory of what was played (every note, pedal and bend, with the tracks
 * that sounded it), which stretch of it is "what I just played", and where it goes in the song.
 *
 * A phrase is the last stretch played in one go: after the last Capture or Record, since the
 * transport last started, stopped or was moved, and, while the song is stopped, with no more than
 * ten seconds of silence in it.
 *
 * - Played along to the song, its notes go where they were played. Around a cycle the last time
 *   through is what plays, and the earlier ones are kept beside it, muted, as a recording over a
 *   repeat keeps them.
 * - Played while the song is stopped, it starts at the bar the playhead is in and runs as it was
 *   played, at the song's tempo there. No tempo is guessed: reading one from a few bars of playing
 *   is right less than half the time, and a wrong one moves every note.
 */
import {
  meterAt,
  type Note,
  type Op,
  type PlayMap,
  PPQ,
  type Project,
  type Region,
  secondsToTick,
  type Track,
  ticksPerBar,
  tickToSeconds,
  writtenSpans,
} from '@holo/session';

/** A MIDI message as it was played: when, what, from where, the tracks that sounded it, and where the song was. */
export interface Played {
  /** When it arrived, ms on the page's clock. */
  at: number;
  /**
   * When it was played, ms on HO[LO] Engine's own clock, for what it heard on its devices: its
   * messages reach the page a batch at a time, so `at` is the batch's and this is the note's.
   */
  fine?: number;
  status: number;
  d1: number;
  d2: number;
  port: string;
  /** The ids of the tracks it played (the armed ones its input reaches, else the selected one). */
  tracks: readonly string[];
  /** The song's tick as played (through its repeats) when it was heard; null while the song was stopped. */
  tick: number | null;
}

/** What ends a phrase: the transport starting, stopping or being moved, or nothing before it being kept at all. */
export type Break = 'play' | 'stop' | 'locate' | 'floor';

interface Mark {
  mark: Break;
  at: number;
}

/** How long a stopped phrase may rest, ms: playing after a longer silence is a new phrase. */
export const SILENCE_MS = 10_000;
/** How far back it remembers, and how many messages at most (a controller swept for minutes is thousands). */
export const KEEP_MS = 5 * 60_000;
export const MOST = 20_000;

const isOn = (e: Played) => (e.status & 0xf0) === 0x90 && e.d2 > 0;
const isOff = (e: Played) => (e.status & 0xf0) === 0x80 || ((e.status & 0xf0) === 0x90 && e.d2 === 0);

/** A phrase: its messages in order, whether the song was playing, and when it was taken (held notes end there). */
export interface Phrase {
  playing: boolean;
  events: Played[];
  /** When it was taken, ms on the page's clock. */
  end: number;
}

export class CaptureMemory {
  private items: (Played | Mark)[] = [];
  private notes = 0;

  /** Take in a message (notes, controllers, pitch bend, pressure). */
  add(e: Played): void {
    const kind = e.status & 0xf0;
    if (kind !== 0x90 && kind !== 0x80 && kind !== 0xb0 && kind !== 0xe0 && kind !== 0xd0) return;
    this.items.push(e);
    if (isOn(e)) this.notes++;
    this.forget(e.at);
  }

  /** The transport started, stopped or moved; or (`floor`) nothing before now is ever captured: it was, or it was recorded, or it's another song's. */
  mark(mark: Break, at: number): void {
    if (mark === 'floor') {
      this.items = [];
      this.notes = 0;
      return;
    }
    if (this.items.length) this.items.push({ mark, at });
  }

  private forget(now: number): void {
    let drop = Math.max(0, this.items.length - MOST);
    while (drop < this.items.length && (this.items[drop] as Played | Mark).at < now - KEEP_MS) drop++;
    if (!drop) return;
    for (const gone of this.items.splice(0, drop)) if (!('mark' in gone) && isOn(gone)) this.notes--;
  }

  /** Whether there's a note to capture. */
  get ready(): boolean {
    return this.notes > 0;
  }

  /** The last stretch played in one go that has a note in it (null: there's none). */
  phrase(now: number): Phrase | null {
    let end = this.items.length;
    while (end > 0) {
      // the run of messages before `end`, back to the mark before it
      let start = end;
      while (start > 0 && !('mark' in (this.items[start - 1] as Played | Mark))) start--;
      let run = this.items.slice(start, end) as Played[];
      const playing = run.some((e) => e.tick !== null);
      if (!playing) {
        // stopped: what came before a long silence (with no key held through it) is another phrase
        let from = 0;
        const held = new Set<string>();
        let last = Number.NEGATIVE_INFINITY;
        run.forEach((e, i) => {
          if (isOn(e) && held.size === 0 && e.at - last > SILENCE_MS) from = i;
          if (isOn(e)) held.add(`${e.port}:${e.d1}`);
          else if (isOff(e)) held.delete(`${e.port}:${e.d1}`);
          last = e.at;
        });
        run = run.slice(from);
      }
      if (run.some(isOn)) return { playing, events: run, end: now };
      end = start - 1;
    }
    return null;
  }
}

/** The tracks live MIDI from a port and channel (1 to 16) plays: the armed ones its input reaches, else the selected one (as the engine routes it). */
export function heardBy(
  project: Pick<Project, 'tracks'> | null,
  selected: string | null,
  port: string,
  channel: number,
): string[] {
  const reaches = (t: Track) =>
    (t.input.port === '*' || t.input.port === port) && (t.input.channel === 0 || t.input.channel === channel);
  const tracks = (project?.tracks ?? []).filter((t) => !t.inactive);
  const armed = tracks.filter((t) => t.armed && reaches(t));
  if (armed.length) return armed.map((t) => t.id);
  const s = tracks.find((t) => t.id === selected);
  return s && reaches(s) ? [s.id] : [];
}

/** A take: notes and controller points in ticks of the song as played. */
export interface Take {
  notes: Note[];
  cc: Map<string, [number, number][]>;
}

/**
 * A take's regions, where its music is written: each time through the bars it was played over is a
 * region on whole bars; where a later time goes over the same bars, it plays and the earlier ones
 * are kept, muted (as takes are). Recording and Capture both place their takes with this.
 */
export function takeRegions(
  project: Pick<Project, 'meter'>,
  map: PlayMap | null,
  take: Take,
  name: string,
  id: () => string,
): Region[] {
  if (!take.notes.length && !take.cc.size) return [];
  const ticks = [...take.notes.map((n) => n.t), ...[...take.cc.values()].flatMap((l) => l.map((x) => x[0]))];
  const last = Math.max(...take.notes.map((n) => n.t + n.d), ...ticks) + 1;
  const regions: Region[] = [];
  for (const span of writtenSpans(map, Math.min(...ticks), last)) {
    const len = span.to - span.from;
    const inside = (t: number) => t >= span.at && t < span.at + len;
    const notes = take.notes
      .filter((n) => inside(n.t))
      .map((n) => ({ ...n, t: n.t - span.at + span.from, d: Math.min(n.d, span.at + len - n.t) }));
    const cc = [...take.cc]
      .map(([k, pts]): [string, [number, number][]] => [
        k,
        pts.filter(([t]) => inside(t)).map(([t, v]): [number, number] => [t - span.at + span.from, v]),
      ])
      .filter(([, pts]) => pts.length);
    if (!notes.length && !cc.length) continue;
    const at = [...notes.map((n) => n.t), ...cc.flatMap(([, pts]) => pts.map((x) => x[0]))];
    const ends = [...notes.map((n) => n.t + n.d), ...at];
    const bar = ticksPerBar(meterAt(project.meter, Math.min(...at)));
    const start = Math.floor(Math.min(...at) / bar) * bar;
    const stop = Math.max(start + bar, Math.ceil(Math.max(...ends) / bar) * bar);
    const region: Region = {
      id: id(),
      name: span.n > 1 ? `${name} (time ${span.n})` : name,
      start,
      length: stop - start,
      muted: false,
      notes: notes.map((n) => ({ ...n, t: n.t - start })),
      cc: Object.fromEntries(cc.map(([k, pts]) => [k, pts.map(([t, v]): [number, number] => [t - start, v])])),
    };
    for (const r of regions) if (r.start < stop && start < r.start + r.length) r.muted = true;
    regions.push(region);
  }
  return regions;
}

/** A message as a note or a controller point of a take, at a tick. */
function intoTake(take: Take, held: Map<number, Note>, e: Played, tick: number): void {
  const kind = e.status & 0xf0;
  const at = Math.round(tick);
  if (isOn(e)) {
    // (a key struck again while it's held: the first note ends where the second starts)
    const before = held.get(e.d1);
    if (before) before.d = Math.max(1, at - before.t);
    const n: Note = { t: at, d: 1, p: e.d1, v: e.d2 };
    take.notes.push(n);
    held.set(e.d1, n);
  } else if (isOff(e)) {
    const n = held.get(e.d1);
    if (n) {
      n.d = Math.max(1, at - n.t);
      held.delete(e.d1);
    }
  } else if (kind === 0xb0 || kind === 0xe0 || kind === 0xd0) {
    const lane = kind === 0xb0 ? String(e.d1) : kind === 0xe0 ? 'pb' : 'at';
    const value = kind === 0xb0 ? e.d2 : kind === 0xe0 ? ((e.d2 << 7) | e.d1) - 8192 : e.d1;
    const list = take.cc.get(lane) ?? [];
    list.push([at, value]);
    take.cc.set(lane, list);
  }
}

/** What a phrase needs of the studio to be placed. */
export interface CaptureAt {
  /** The selected track: what's played with no track to hear it goes there. */
  selectedTrack: string | null;
  /** Where the playhead is, ticks as written (a stopped phrase starts at its bar). */
  playhead: number;
  /** Where the song is now, ticks as played (a note still held while it plays ends there). */
  playedNow: number;
  /** The song's repeats and jumps as they play; null when it has none. */
  map: PlayMap | null;
  /** New region ids. */
  id: () => string;
}

/** A phrase placed: the operations that write it, and what to say of it. */
export interface CapturePlan {
  ops: Op[];
  notes: number;
  /** The names of the tracks it went to. */
  tracks: string[];
  regions: string[];
}

/**
 * Where a phrase goes in the song. A message goes to the tracks that sounded it when it was played
 * (those still there, and still instrument tracks that are on); one that no track sounded, to the
 * selected track. Null when it has nowhere to go.
 */
export function planCapture(project: Project, phrase: Phrase, at: CaptureAt): CapturePlan | null {
  const can = (t: Track | undefined): t is Track => !!t && t.kind === 'instrument' && !t.inactive;
  const fallback = project.tracks.find((t) => t.id === at.selectedTrack);
  const targets = (e: Played): Track[] => {
    const heard = e.tracks.map((id) => project.tracks.find((t) => t.id === id)).filter(can);
    return heard.length ? heard : can(fallback) ? [fallback] : [];
  };

  // each message's tick: as it was played along, or from the playhead's bar at the song's tempo
  let tickOf: (e: Played) => number;
  let endTick: number;
  if (phrase.playing) {
    // (a message from just before the song started has no tick: it's left out)
    tickOf = (e) => e.tick as number;
    endTick = at.playedNow;
  } else {
    const bar = ticksPerBar(meterAt(project.meter, Math.max(0, at.playhead)));
    const base = Math.floor(Math.max(0, at.playhead) / bar) * bar;
    const t0 = tickToSeconds(project.tempo, base);
    // (by the Engine's own clock where every message has it: the page's is a batch's)
    const fine = phrase.events.every((e) => e.fine !== undefined);
    const ms = (e: Played) => (fine ? (e.fine as number) : e.at);
    const firstOn = phrase.events.find(isOn) ?? phrase.events[0];
    const first = firstOn ? ms(firstOn) : 0;
    const lastOne = phrase.events[phrase.events.length - 1];
    const end = lastOne ? ms(lastOne) + Math.max(0, phrase.end - lastOne.at) : first;
    tickOf = (e) => Math.max(base, secondsToTick(project.tempo, t0 + (ms(e) - first) / 1000));
    endTick = secondsToTick(project.tempo, t0 + (end - first) / 1000);
  }
  const events = phrase.playing ? phrase.events.filter((e) => e.tick !== null) : phrase.events;

  // Times through a cycle: the song went around between two messages when it's further back than
  // the time between them says (the next note may still fall later in the bars than the last one did,
  // so "its tick went down" alone would miss it).
  const passes: Played[][] = [[]];
  let before: Played | null = null;
  for (const e of events) {
    if (phrase.playing && before) {
      const both = before.fine !== undefined && e.fine !== undefined;
      const seconds = ((both ? (e.fine as number) : e.at) - (both ? (before.fine as number) : before.at)) / 1000;
      const due = secondsToTick(project.tempo, tickToSeconds(project.tempo, tickOf(before)) + Math.max(0, seconds));
      if (due - tickOf(e) > PPQ / 2) passes.push([]);
    }
    before = e;
    (passes[passes.length - 1] as Played[]).push(e);
  }
  const used = passes.filter((p) => p.length);

  const ops: Op[] = [];
  const names = new Set<string>();
  const regionNames: string[] = [];
  let count = 0;
  used.forEach((pass, k) => {
    const isLast = k === used.length - 1;
    const takes = new Map<string, { take: Take; held: Map<number, Note> }>();
    let passEnd = 0;
    for (const e of pass) {
      const tick = tickOf(e);
      passEnd = Math.max(passEnd, tick);
      for (const t of targets(e)) {
        let made = takes.get(t.id);
        if (!made) {
          made = { take: { notes: [], cc: new Map() }, held: new Map() };
          takes.set(t.id, made);
        }
        intoTake(made.take, made.held, e, tick);
      }
    }
    // a key still down: to where the song is now, or (an earlier time through) to the cycle's end
    const cycleEnd = project.cycle.on && project.cycle.end > passEnd ? project.cycle.end : passEnd;
    const until = Math.round(isLast ? Math.max(endTick, passEnd) : cycleEnd);
    for (const [trackId, { take, held }] of takes) {
      for (const n of held.values()) n.d = Math.max(1, until - n.t);
      if (!take.notes.length) continue;
      const track = project.tracks.find((t) => t.id === trackId) as Track;
      const name = used.length > 1 && !isLast ? `Captured (pass ${k + 1})` : 'Captured';
      for (const region of takeRegions(project, at.map, take, name, at.id)) {
        // an earlier time around the cycle is kept, muted: the last is the one that plays
        if (!isLast) region.muted = true;
        else count += region.notes.length;
        ops.push({ op: 'addRegion', track: track.id, region });
        regionNames.push(region.name);
        names.add(track.name);
      }
    }
  });
  if (!ops.length || !count) return null;
  return { ops, notes: count, tracks: [...names], regions: regionNames };
}

/** What was played in this studio, for Capture. */
export const captured = new CaptureMemory();
