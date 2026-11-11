/**
 * Playing and listening in the requester's studio: the transport, notes auditioned (heard, not
 * recorded), what the user plays (listened for, or the last few seconds already played), a first
 * look at a performance, and an A/B of the song before and after the agent's changes.
 */
import { KEYS, type MiddleC, noteName, PPQ, type Project, parseNotation, tickToBarBeat } from '@holo/session';
import type { PlayedNote } from '../api.ts';
import { barTick, need, num, plural, str, type Tool, ToolError, trackRef, UNITS, unitTicks } from './common.ts';

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
export function playedText(project: Project | null, notes: readonly PlayedNote[], middleC: MiddleC): string {
  if (!notes.length) return 'Nothing was played.';
  const lines = notes.map((n) => {
    const where =
      n.tick !== null && project
        ? (() => {
            const p = tickToBarBeat(project.meter, n.tick);
            return `at ${p.bar}.${p.beat}.${p.div}.${p.tick}`;
          })()
        : `at ${(n.time / 1000).toFixed(2)} s`;
    return `${noteName(n.pitch, middleC)} (${n.pitch}) vel ${n.velocity} ${where}, ${n.length !== null ? `${Math.round(n.length)} ms` : 'still held'}`;
  });
  return [`${plural(notes.length, 'note')}:`, ...lines].join('\n');
}

export const listen: Tool = {
  name: 'listen',
  kind: 'play',
  summary: ({ middleC }) =>
    `Listen to what the user plays now (MIDI, or singing through pitch tracking), until they stop for "quiet" seconds, press Done, or "max" seconds pass; the studio shows the user it's listening, with a Done button. Returns each note: name (middle C is ${middleC}), MIDI number, velocity, where it fell in the song (bar.beat.sixteenth.tick, if the song was playing) or its time, and length in ms.`,
  args: [
    { name: 'max', type: 'number', describe: 'Most seconds to listen', min: 2, max: 180, default: 30 },
    { name: 'quiet', type: 'number', describe: 'Seconds of silence that end it', min: 1, max: 30, default: 4 },
  ],
  async run(ctx, args) {
    const max = num(args, 'max') ?? 30;
    const quiet = num(args, 'quiet') ?? 4;
    const [{ notes }, project] = await Promise.all([
      ctx.api.listen({ maxMs: Math.round(max * 1000), quietMs: Math.round(quiet * 1000) }),
      ctx.api.song().catch(() => null),
    ]);
    return { text: playedText(project, notes, ctx.middleC) };
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

/** Krumhansl and Kessler's key profiles: how strongly each scale degree belongs to a major or minor key. */
const MAJOR = [6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88];
const MINOR = [6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17];

function correlation(a: readonly number[], b: readonly number[]): number {
  const mean = (x: readonly number[]) => x.reduce((s, v) => s + v, 0) / x.length;
  const ma = mean(a);
  const mb = mean(b);
  let num = 0;
  let da = 0;
  let db = 0;
  for (let i = 0; i < a.length; i++) {
    const x = (a[i] as number) - ma;
    const y = (b[i] as number) - mb;
    num += x * y;
    da += x * x;
    db += y * y;
  }
  return da && db ? num / Math.sqrt(da * db) : 0;
}

/** The keys a performance's pitches fit best, by how long each pitch class sounded. */
export function keyCandidates(notes: readonly PlayedNote[]): { key: string; score: number }[] {
  const weight = new Array<number>(12).fill(0);
  for (const n of notes) {
    const pc = ((Math.round(n.pitch) % 12) + 12) % 12;
    weight[pc] = (weight[pc] ?? 0) + Math.min(2000, n.length ?? 300);
  }
  const out: { key: string; score: number }[] = [];
  for (let tonic = 0; tonic < 12; tonic++) {
    const rotated = (profile: number[]) => weight.map((_, pc) => profile[(pc - tonic + 12) % 12] as number);
    out.push({ key: `${KEYS[tonic]} major`, score: correlation(weight, rotated(MAJOR)) });
    out.push({ key: `${KEYS[tonic]} minor`, score: correlation(weight, rotated(MINOR)) });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Notes starting within this many ms of each other are a chord. */
const CHORD_MS = 50;
/** A silence this long starts a new phrase. */
const PHRASE_MS = 1500;

export const analyzePlayed: Tool = {
  name: 'analyze_played',
  kind: 'see',
  summary: ({ middleC }) =>
    `A first look at a performance: its notes grouped into chords and phrases (in the studio's names, middle C ${middleC}), its range, the gaps between onsets, and the keys its pitches fit best. It reads what was just played ("seconds" back), or "notes" as listen or played returned them. Use it before writing a performance down: it helps with the key and the grid, which you still judge from the timings.`,
  args: [
    { name: 'seconds', type: 'number', describe: 'How far back to read what was played', min: 1, max: 60, default: 30 },
    {
      name: 'notes',
      type: 'array',
      items: 'object',
      describe: 'Notes instead, as [{"pitch": 62, "time": 0, "length": 400, "velocity": 80}…] (time and length in ms)',
      maxLength: 2000,
    },
  ],
  async run(ctx, args) {
    const given = Array.isArray(args.notes) ? (args.notes as Record<string, unknown>[]) : undefined;
    const notes: PlayedNote[] = given
      ? given.map((n, i) => {
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
        })
      : (await ctx.api.played(num(args, 'seconds') ?? 30)).notes;
    if (!notes.length) return { text: 'Nothing was played.' };
    const sorted = notes.slice().sort((a, b) => a.time - b.time || a.pitch - b.pitch);
    const t0 = sorted[0]?.time ?? 0;
    const name = (p: number) => noteName(p, ctx.middleC);
    // chords: onsets close together; phrases: split by silences
    const chords: PlayedNote[][] = [];
    for (const n of sorted) {
      const last = chords.at(-1);
      if (last && n.time - (last[0] as PlayedNote).time <= CHORD_MS) last.push(n);
      else chords.push([n]);
    }
    const phrases: PlayedNote[][][] = [];
    let heldUntil = Number.NEGATIVE_INFINITY;
    for (const c of chords) {
      const at = (c[0] as PlayedNote).time;
      if (!phrases.length || at - heldUntil >= PHRASE_MS) phrases.push([]);
      phrases.at(-1)?.push(c);
      heldUntil = Math.max(heldUntil, ...c.map((n) => n.time + (n.length ?? 0)));
    }
    const pitches = sorted.map((n) => n.pitch);
    const lo = Math.min(...pitches);
    const hi = Math.max(...pitches);
    const span = ((sorted.at(-1)?.time ?? t0) - t0) / 1000;
    const lines = [
      `${plural(sorted.length, 'note')} over ${span.toFixed(1)} s, ${name(lo)}–${name(hi)} (MIDI ${lo}–${hi}).`,
      `Phrases (a silence of ${PHRASE_MS / 1000} s starts a new one; chords in parentheses):`,
    ];
    phrases.forEach((p, i) => {
      const start = ((p[0]?.[0]?.time ?? t0) - t0) / 1000;
      const words = p.map((c) =>
        c.length > 1 ? `(${c.map((n) => name(n.pitch)).join(' ')})` : name((c[0] as PlayedNote).pitch),
      );
      lines.push(`  ${i + 1}. from ${start.toFixed(2)} s: ${words.join(' ')}`);
    });
    const gaps = chords
      .slice(1)
      .map((c, i) => (c[0] as PlayedNote).time - ((chords[i] as PlayedNote[])[0] as PlayedNote).time)
      .filter((g) => g < PHRASE_MS)
      .sort((a, b) => a - b);
    if (gaps.length >= 3) {
      const median = gaps[Math.floor(gaps.length / 2)] as number;
      lines.push(
        `Onsets: the middle gap between them is ${Math.round(median)} ms (as quarters ${Math.round(60000 / median)} bpm, as eighths ${Math.round(30000 / median)} bpm); shortest ${Math.round(gaps[0] as number)} ms, longest ${Math.round(gaps.at(-1) as number)} ms.`,
      );
    }
    if (new Set(pitches.map((p) => ((Math.round(p) % 12) + 12) % 12)).size >= 3) {
      const keys = keyCandidates(sorted).slice(0, 3);
      lines.push(`Keys its pitches fit best: ${keys.map((k) => `${k.key} (${k.score.toFixed(2)})`).join(', ')}.`);
    }
    lines.push("This reads pitches and timing; it doesn't decide the tempo, meter or grid: judge those from the gaps.");
    return { text: lines.join('\n') };
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
