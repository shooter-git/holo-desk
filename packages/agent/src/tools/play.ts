/**
 * Playing and listening in the requester's studio: the transport, notes auditioned (heard, not
 * recorded), what the user plays (listened for, a part of a listen a call, or the last few seconds
 * already played), a performance heard as music and written down, and an A/B of the song before and
 * after the agent's changes.
 */
import { analyzePerformance, describePerformance, type PerformanceAnalysis, pickupWords } from '@holo/score';
import { type MiddleC, noteName, PPQ, type Project, parseNotation, tickToBarBeat } from '@holo/session';
import type { PlayedNote } from '../api.ts';
import {
  barTick,
  getAttachment,
  need,
  num,
  plural,
  str,
  type Tool,
  ToolError,
  trackRef,
  UNITS,
  unitTicks,
} from './common.ts';

export const transport: Tool = {
  name: 'transport',
  kind: 'play',
  summary:
    'The studio\'s transport: "play" (from "bar" if given, else from the playhead), "stop", or "locate" (move the playhead to "bar" without playing). Example: {"action": "play", "bar": 9}.',
  args: [
    { name: 'action', type: 'enum', values: ['play', 'stop', 'locate'], describe: 'What to do', required: true },
    { name: 'bar', type: 'integer', describe: 'A bar number, e.g. 9', min: 0 },
  ],
  async run(ctx, args) {
    const action = str(args, 'action') as 'play' | 'stop' | 'locate';
    const bar = num(args, 'bar');
    if (action === 'locate' && bar === undefined) throw new ToolError('Say which "bar" to locate to');
    if (bar !== undefined) barTick(await ctx.api.song(), bar);
    await ctx.api.transport({ action, ...(bar !== undefined && action !== 'stop' ? { bar } : {}) });
    return {
      text:
        action === 'stop'
          ? 'Stopped.'
          : action === 'locate'
            ? `The playhead is at bar ${bar}.`
            : `Playing${bar !== undefined ? ` from bar ${bar}` : ''}.`,
    };
  },
};

export const audition: Tool = {
  name: 'audition',
  kind: 'play',
  summary: ({ middleC }) =>
    `Play notes in the studio now, to try an idea out loud: heard, not written into the song. The notes are in the compact notation notes_write takes ("A4:2 C#5:2 (D4 F#4 A4):4 r:1", durations in "unit"s; middle C is ${middleC}), on a track's instrument ("track") or the selected one, at "bpm" (the song's tempo when left out). At most 60 seconds.`,
  args: [
    { name: 'notes', type: 'string', describe: 'The notes, e.g. "C4:1 E4:1 G4:2"', required: true, maxLength: 4000 },
    { name: 'track', type: 'string', describe: 'Whose instrument plays them: a track name or id' },
    { name: 'unit', type: 'enum', values: UNITS, describe: 'What a duration of 1 is', default: '1/8' },
    { name: 'bpm', type: 'number', describe: 'Tempo for the audition', min: 20, max: 400 },
    { name: 'velocity', type: 'integer', describe: 'Velocity of notes without @', min: 1, max: 127, default: 90 },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const trackText = str(args, 'track');
    const track = trackText ? trackRef(project, trackText) : undefined;
    const bpm = num(args, 'bpm') ?? project.tempo[0]?.bpm ?? 120;
    let notes: ReturnType<typeof parseNotation>;
    try {
      notes = parseNotation(need(args, 'notes'), {
        unit: unitTicks(str(args, 'unit')),
        velocity: num(args, 'velocity') ?? 90,
        middleC: ctx.middleC,
      });
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
    if (!notes.length) throw new ToolError('No notes to play');
    const msPerTick = 60000 / bpm / PPQ;
    const length = Math.max(...notes.map((n) => n.t + n.d)) * msPerTick;
    if (length > 60_000) throw new ToolError(`That lasts ${Math.round(length / 1000)} s; audition at most 60 s`);
    const events: [number, number, number, number][] = [];
    for (const n of notes) {
      const p = Math.max(0, Math.min(127, Math.round(n.p)));
      events.push([Math.round(n.t * msPerTick), 0x90, p, Math.round(n.v)]);
      events.push([Math.max(Math.round(n.t * msPerTick) + 1, Math.round((n.t + n.d) * msPerTick) - 5), 0x80, p, 0]);
    }
    events.sort((a, b) => a[0] - b[0]);
    await ctx.api.audition({ ...(track ? { track: track.id } : {}), events });
    return {
      text: `Playing ${plural(notes.length, 'note')} (${(length / 1000).toFixed(1)} s)${track ? ` on ${track.name}` : ''}.`,
    };
  },
};

/** What was played, a note a line, in the studio's note names, at its place in the song if it was playing. */
export function playedText(
  project: Project | null,
  notes: readonly PlayedNote[],
  middleC: MiddleC,
  most = Number.POSITIVE_INFINITY,
): string {
  if (!notes.length) return 'Nothing was played.';
  const lines = notes.slice(0, most).map((n) => {
    const where =
      n.tick !== null && project
        ? (() => {
            const p = tickToBarBeat(project.meter, n.tick);
            return `at ${p.bar}.${p.beat}.${p.div}.${p.tick}`;
          })()
        : `at ${(n.time / 1000).toFixed(2)} s`;
    return `${noteName(n.pitch, middleC)} (${n.pitch}) vel ${n.velocity} ${where}, ${n.length !== null ? `${Math.round(n.length)} ms` : 'still held'}`;
  });
  if (notes.length > most) lines.push(`… ${plural(notes.length - most, 'more note')}`);
  return [`${plural(notes.length, 'note')}:`, ...lines].join('\n');
}

/** A part of a listen lasts at most this long: a harness cuts a tool call at 60 s. */
const PART_MS = 40_000;
/** A listen whose last part came back longer ago than this was left: the next call begins another. */
const LEFT_MS = 60_000;

/** The notes of a whole listen, then what they sound like in a line. */
function heardText(project: Project | null, notes: readonly PlayedNote[], middleC: MiddleC): string {
  if (!notes.length) return 'Nothing was played.';
  const reading = describePerformance(analyzePerformance(notes, { text: false }));
  return `${playedText(project, notes, middleC)}\n${reading}${/[.!]$/.test(reading) ? '' : '.'} analyze_played (given nothing) writes this listen down.`;
}

export const listen: Tool = {
  name: 'listen',
  kind: 'play',
  summary: ({ middleC }) =>
    `Listen to what the user plays now on a MIDI keyboard or controller (or Musical Typing), until they stop for "quiet" seconds, press Done, or "max" seconds pass in all; the studio shows them it's listening, with a Done button. Each call listens for up to 40 seconds: while they're still playing it answers "Still listening", and you call listen again at once (no arguments needed) to hear the rest of the same listen. When it ends it returns every note: name (middle C is ${middleC}), MIDI number, velocity, where it fell in the song (bar.beat.sixteenth.tick, if the song was playing) or its time from the start, and length in ms; then its tempo, meter and key in a line. Singing or an acoustic instrument isn't heard here: ask_permission with "microphone" lets them record it.`,
  args: [
    {
      name: 'max',
      type: 'number',
      describe: 'Most seconds the whole listen may last, every call together (60 when left out)',
      min: 2,
      max: 600,
    },
    {
      name: 'quiet',
      type: 'number',
      describe: 'Seconds of silence after a note that end it (4 when left out)',
      min: 1,
      max: 10,
    },
  ],
  async run(ctx, args) {
    const memory = ctx.memory;
    const max = num(args, 'max');
    const quiet = num(args, 'quiet');
    const now = Date.now();
    let l = memory.listening;
    // left unfinished a while ago: what it heard is the last listen, and this call begins another
    if (l && now - l.lastPart > LEFT_MS) {
      if (l.notes.length) memory.lastListen = l.notes;
      l = null;
    }
    if (!l) {
      l = { started: now, maxMs: 60_000, quietMs: 4000, notes: [], parts: 0, lastPart: now, offset: 0 };
      memory.listening = l;
    }
    // (a first call that failed began nothing)
    if (!l.parts) l.started = now;
    if (max !== undefined) l.maxMs = Math.round(max * 1000);
    if (quiet !== undefined) l.quietMs = Math.round(quiet * 1000);
    const left = l.maxMs - (now - l.started);
    const last = left <= PART_MS;
    const part = await ctx.api.listen({
      maxMs: Math.round(Math.max(100, Math.min(PART_MS, left))),
      quietMs: l.quietMs,
      ...(last ? { last: true } : {}),
    });
    // HO[LO] began listening again (this call came too long after the last): the time between wasn't heard
    if (part.part === 1 && l.parts > 0) l.offset = now - l.started;
    l.parts++;
    l.lastPart = Date.now();
    for (const n of part.notes) l.notes.push({ ...n, time: n.time + l.offset });
    if (!part.done && !last)
      return {
        text: `Still listening: ${plural(l.notes.length + part.pending, 'note')} so far. Call listen again to hear the rest.`,
      };
    memory.listening = null;
    memory.lastListen = l.notes;
    const project = await ctx.api.song().catch(() => null);
    return { text: heardText(project, l.notes, ctx.middleC) };
  },
};

export const played: Tool = {
  name: 'played',
  kind: 'play',
  summary:
    'What the user just played, from the studio\'s memory of the last "seconds" (at most 60): use it when they say "what I just played". Each note as listen returns it.',
  args: [{ name: 'seconds', type: 'number', describe: 'How far back', min: 1, max: 60, default: 20 }],
  async run(ctx, args) {
    const seconds = num(args, 'seconds') ?? 20;
    const [{ notes }, project] = await Promise.all([ctx.api.played(seconds), ctx.api.song().catch(() => null)]);
    return { text: playedText(project, notes, ctx.middleC) };
  },
};

/** A recording's notes, as the studio heard them ([start s, length s, pitch, velocity] each): null when it heard none. */
export function recordedNotes(meta: unknown): PlayedNote[] | null {
  const list = typeof meta === 'object' && meta !== null ? (meta as { notes?: unknown }).notes : undefined;
  if (!Array.isArray(list)) return null;
  const notes: PlayedNote[] = [];
  for (const n of list) {
    if (!Array.isArray(n) || !n.slice(0, 4).every((x) => typeof x === 'number' && Number.isFinite(x))) continue;
    const [start, length, pitch, velocity] = n as number[];
    notes.push({
      tick: null,
      time: Math.round((start as number) * 1000),
      pitch: Math.round(pitch as number),
      velocity: Math.round(velocity as number),
      length: Math.round((length as number) * 1000),
      port: 'microphone',
    });
  }
  return notes.length ? notes : null;
}

/** How each grid is said. */
const GRID: Record<'sixteenths' | 'triplets' | 'mixed', string> = {
  sixteenths: 'on a grid of sixteenths',
  triplets: 'on a grid of eighth-note triplets',
  mixed: 'on sixteenths, with some beats in triplets',
};

/** An analysis as the tool says it: the reading, what to set in the song, the score text, the alternative. */
export function analysisText(a: PerformanceAnalysis, song: Project | null): string {
  const said = describePerformance(a);
  const lines = [/[.!]$/.test(said) ? said : `${said}.`];
  const best = a.best;
  if (!best) {
    if (a.notes) lines.push('Too few notes to write down: a reading needs at least four onsets.');
    return lines.join('\n');
  }
  const r = best.reading;
  const time = `${r.time}${r.groups ? ` (${r.groups.join('+')})` : ''}`;
  const tempo =
    r.beat === 'dotted quarter'
      ? `tempo ${r.quarterBpm} in quarters (${r.bpm} dotted quarters a minute in ${r.time}; the song's tempo and the score text's "tempo" count quarters)`
      : `tempo ${r.quarterBpm}`;
  const key = best.key ? `key ${best.key.key}` : 'no clear key';
  const pickup = r.pickup ? `a pickup of ${pickupWords(r.pickup, r.den)}` : 'no pickup';
  lines.push(`For the song: ${tempo}, time ${time}, ${key}, ${pickup}, ${GRID[best.grid]}.`);
  if (r.pickup) {
    const has = song?.meter[0]?.pickup ?? 0;
    // score_meta counts the pickup in the beats of the song's meter as it is now
    const den = song?.meter[0]?.den ?? r.den;
    const beats = Math.round((r.pickup / ((PPQ * 4) / den)) * 1000) / 1000;
    lines.push(
      has === r.pickup
        ? 'The song has that pickup already (bar 0).'
        : `Set the song's pickup before writing the text, or bar 0 has nowhere to go: score_meta {"pickup": ${beats}}.`,
    );
  }
  lines.push(
    "As score text for score_write (rename P1 to the part it goes into, and renumber the bars to where it goes; its header sets the song's time, key and tempo there: drop what the song keeps):",
    best.text,
  );
  const lastBar = best.notes.at(-1)?.bar ?? 0;
  if (lastBar > TEXT_BARS)
    lines.push(`(The text stops at bar ${TEXT_BARS}; the performance runs on to bar ${lastBar}.)`);
  const other = a.second?.text.split('\n')[0]?.trim();
  if (other) lines.push(`The alternative: ${other}`);
  return lines.join('\n');
}

/** The score text covers at most this many bars. */
const TEXT_BARS = 64;

export const analyzePlayed: Tool = {
  name: 'analyze_played',
  kind: 'see',
  summary:
    'Hear a performance as music, to write it down: its tempo, meter, key, pickup and grid, read from its timing as played, and its notes as score text ready for score_write, with the likeliest reading in another meter as an alternative. It reads "notes" if given (time and length in ms, as listen returns them), else a recording the user attached ("attachment": the notes the studio heard in it), else the last listen, else what was just played ("seconds" back).',
  args: [
    {
      name: 'notes',
      type: 'array',
      items: 'object',
      describe: 'Notes, as [{"pitch": 62, "time": 0, "length": 400, "velocity": 80}…] (time and length in ms)',
      maxLength: 2000,
    },
    {
      name: 'attachment',
      type: 'string',
      describe: 'A recording the user attached (its id, att_…): the notes the studio heard in it',
      maxLength: 80,
    },
    {
      name: 'seconds',
      type: 'number',
      describe: 'Read what was just played this far back (30 when left out and there was no listen)',
      min: 1,
      max: 60,
    },
  ],
  async run(ctx, args) {
    const given = Array.isArray(args.notes) ? (args.notes as Record<string, unknown>[]) : undefined;
    const attachment = str(args, 'attachment')?.trim();
    const seconds = num(args, 'seconds');
    let notes: PlayedNote[];
    if (given) {
      notes = given.map((n, i) => {
        const pitch = Number(n.pitch);
        const time = Number(n.time ?? 0);
        if (!Number.isFinite(pitch) || !Number.isFinite(time))
          throw new ToolError(`notes[${i}] needs a "pitch" (MIDI number) and a "time" (ms)`);
        return {
          pitch,
          time,
          velocity: Number(n.velocity ?? 80),
          length: n.length === null || n.length === undefined ? null : Number(n.length),
          tick: typeof n.tick === 'number' ? n.tick : null,
          port: '',
        };
      });
    } else if (attachment) {
      const a = await getAttachment(ctx, attachment);
      if (a.type === 'audio/midi')
        throw new ToolError(`${a.name} is a MIDI file, in time already: attachment_get lists its notes by bar`);
      if (!a.type.startsWith('audio/')) throw new ToolError(`${a.name} isn't a recording`);
      const heard = recordedNotes(a.meta);
      if (!heard)
        throw new ToolError(
          `The studio heard no notes in ${a.name}: it reads notes only from one line (a voice, a flute), not chords or several sounds at once`,
        );
      notes = heard;
    } else if (ctx.memory.lastListen && seconds === undefined) notes = ctx.memory.lastListen;
    else notes = (await ctx.api.played(seconds ?? 30)).notes;
    if (!notes.length) return { text: 'Nothing was played.' };
    const a = analyzePerformance(notes, { textBars: TEXT_BARS });
    const song = a.best?.reading.pickup ? await ctx.api.song().catch(() => null) : null;
    return { text: analysisText(a, song) };
  },
};

export const compare: Tool = {
  name: 'compare',
  kind: 'play',
  summary:
    'Let the user hear the difference: the studio plays the song as it was before this request (A), then as it is now (B), over bars "from" to "to" ("to" is where it stops, not played). Example: {"from": 9, "to": 17} plays bars 9–16 twice.',
  args: [
    { name: 'from', type: 'integer', describe: 'The first bar', required: true, min: 0 },
    { name: 'to', type: 'integer', describe: 'The bar it stops at (not played)', required: true, min: 1 },
  ],
  async run(ctx, args) {
    const from = num(args, 'from') as number;
    const to = num(args, 'to') as number;
    if (to <= from) throw new ToolError('"to" comes after "from"');
    const project = await ctx.api.song();
    barTick(project, from);
    await ctx.api.compare({ from, to });
    return { text: `Playing bars ${from}–${to - 1} as they were, then as they are now.` };
  },
};

export const playTools: Tool[] = [transport, audition, listen, played, analyzePlayed, compare];
