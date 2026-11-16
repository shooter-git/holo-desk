/**
 * What a measurement asks to have done (docs/agent.md, "Measuring"): the question checked against the
 * song as it is now, and turned into the child's input, its lane, its cache key and an estimate. The
 * agent's routes (routes.ts) and the command line's (terminal.ts) plan the same way, with one runner,
 * so the same question about the same song is the same measurement whoever asks it.
 *
 * A render is refused when it would take too long (about ten minutes of work): the answer says to
 * measure fewer bars or one track, or to bounce the song and measure the bounce, in the asker's words
 * (the agent's tool names, or the command line's flags).
 *
 * A recording's notes (`notes`: the agent's `audio_notes`, `holo notes`) depend on its file and the
 * engine's code alone, not on the song's revision: they're found once for both, whoever asks, until
 * the engine changes.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { engineCode } from '@holo/music';
import {
  isNoteEdited,
  keysOf,
  PLUGINS,
  type Project,
  projectEnd,
  type Region,
  type Track,
  tickToSeconds,
} from '@holo/session';
import { type Body, bad, ID, int, isObj } from '../check.ts';
import { Refusal } from '../jobs.ts';
import { type Lane, type MeasureAnswer, MeasureFailed, type MeasureRunner } from './runner.ts';
import { takeSpan } from './span.ts';
import type { ChildInput } from './tasks.ts';

export const MEASURE_WHAT = ['take', 'mix', 'tracks', 'plugin', 'meters', 'file', 'notes'] as const;
export type MeasureWhat = (typeof MEASURE_WHAT)[number];

/** A render estimated to take longer than this (s) is refused, with what to do instead. */
export const MAX_RENDER_S = 600;
/** How many seconds of play the studio's meters cover unless asked (it waits for them, up to 30). */
export const METERS_S = 8;
export const METERS_MAX_S = 30;
/** How long the studio has to read out its meters, past the seconds it may wait for them (ms). */
export const METERS_MS = 4000;
/** A bounce file, as the server names them. */
const BOUNCE_FILE = /^[\w .()'-]+\.wav$/;

/** What one measurement asks to have done, as the child is handed it: its lane, cache key and estimate. */
export interface Planned {
  lane: Lane;
  key: string;
  estimate: number;
  input: ChildInput;
  /** Said with the answer (a bounce's name and age). */
  extra?: Record<string, unknown>;
  /** What it measures, in words for the bar ("the mix"). */
  label: string;
}

/** How a refusal says what to do instead: in the agent's words (its tools), or the command line's. */
export interface PlanWords {
  /** After "… would take about N minutes to render here: ". */
  tooLong: string;
  /** The song has no bounce to measure. */
  noBounce: string;
  /** A recording that isn't on a track was asked for through its effects. */
  noEffects: string;
}

/** The agent's words (its tools and their fields). */
export const AGENT_WORDS: PlanWords = {
  tooLong:
    'measure fewer bars ("from" and "to"), or one track, or ask the user to bounce the song (ask_permission "bounce") and measure the bounce (source "bounce")',
  noBounce:
    'The song hasn’t been bounced: ask the user to bounce it (ask_permission "bounce"), or measure the mix by rendering it (source "render")',
  noEffects: 'An attached recording has no effects: through is for a track’s take',
};

export interface PlanContext {
  dataDir: string;
  runner: MeasureRunner;
  /**
   * The recording an `attachment` names, as its file on the host and its name: one the asker may
   * read, or a Refusal saying why not.
   */
  recording: (id: unknown) => { path: string; name: string };
  words?: PlanWords;
}

const opt = (v: unknown) => v === undefined || v === null;

function tick(v: unknown, what: string): number | undefined {
  return opt(v) ? undefined : int(v, what, 0, 1e9);
}

function idOf(v: unknown, what: string): string {
  if (typeof v !== 'string' || !ID.test(v)) throw bad(`${what} is an id`);
  return v;
}

/** Seconds of a song's render from `from` to `to` (its two bars of pre-roll in, and the tail at its end). */
function renderSeconds(song: Project, from?: number, to?: number): number {
  const a = from ?? 0;
  const b = to ?? projectEnd(song);
  return Math.max(0, tickToSeconds(song.tempo, b) - tickToSeconds(song.tempo, a)) + (a > 0 ? 4 : 0) + (to ? 0 : 2);
}

/**
 * About how hard rendering is, as a share of real time on one thread (docs/architecture.md's numbers:
 * 16 tracks with a hall about 2.4×, a 29-track game loop with five about 1.8×), halls the heaviest. The
 * runner scales it by how the song's last render went.
 */
const inserts = (list: readonly { type: string }[]) =>
  list.reduce((w, p) => w + (p.type === 'space' || p.type === 'reverb' || p.type === 'shimmer' ? 0.1 : 0.02), 0);
const weight = (t: Track): number => (t.kind === 'audio' ? 0.01 : 0.05) + inserts(t.channel.inserts);

/** The whole mix's: every track, and the buses' and the master's plugins. */
const mixWeight = (song: Project) =>
  0.1 +
  song.tracks.reduce((s, t) => s + weight(t), 0) +
  song.buses.reduce((s, b) => s + inserts(b.channel.inserts), 0) +
  inserts(song.master.inserts);

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;

/** HO[LO]'s folder, from here (apps/server/src/agent/measure). */
const REPO = join(import.meta.dirname, '..', '..', '..', '..', '..');

/** Seconds of a region's recording its note edits render again, about (each edited note and a little around it). */
const editedSeconds = (r: Region): number =>
  r.audio?.notes && !r.audio.notes.off && !r.muted
    ? r.audio.notes.n.reduce((s, n) => s + (isNoteEdited(n) ? n.d + 0.4 : 0), 0)
    : 0;

function tooLong(seconds: number, what: string, words: PlanWords): Refusal {
  const minutes = Math.round(seconds / 60);
  return new Refusal(
    422,
    `${what} would take about ${plural(minutes, 'minute')} to render here: ${words.tooLong}`,
    'too-long',
  );
}

/** The newest bounce of a song (data/bounces/<song>/), or null. */
function newestBounce(dataDir: string, project: string): { path: string; name: string; made: number } | null {
  const dir = join(dataDir, 'bounces', project.replace(/[^\w-]/g, ''));
  if (!existsSync(dir)) return null;
  let best: { path: string; name: string; made: number } | null = null;
  for (const name of readdirSync(dir)) {
    if (!BOUNCE_FILE.test(name)) continue;
    const path = join(dir, name);
    const made = statSync(path).mtimeMs;
    if (!best || made > best.made || (made === best.made && name > best.name)) best = { path, name, made };
  }
  return best;
}

/** What the studio says of its meters, checked: levels in dB (null: silence), each channel's id. */
export function metersOf(answer: Record<string, unknown>): Record<string, unknown> {
  const level = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-200, Math.min(60, v)) : null);
  const pair = (v: unknown) => (Array.isArray(v) && v.length === 2 ? [level(v[0]), level(v[1])] : [null, null]);
  const channels = (Array.isArray(answer.channels) ? answer.channels : [])
    .slice(0, 300)
    .filter((c): c is Body => isObj(c) && typeof c.id === 'string' && (c.id === 'master' || ID.test(c.id)))
    .map((c) => ({
      id: c.id as string,
      peak: pair(c.peak),
      max: pair(c.max),
      gr: level(c.gr),
      grMax: level(c.grMax),
      clipped: c.clipped === true,
    }));
  const seconds = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.min(86_400, v)) : 0);
  return {
    kind: 'meters',
    playing: answer.playing === true,
    seconds: seconds(answer.seconds),
    covered: Math.min(METERS_MAX_S, seconds(answer.covered)),
    channels,
  };
}

/** A measurement's answer (with what's said beside its result), or why it failed. */
export async function answered(
  waiting: Promise<MeasureAnswer>,
  extra?: Record<string, unknown>,
): Promise<MeasureAnswer> {
  try {
    const a = await waiting;
    return a.done && extra ? { ...a, result: { ...a.result, ...extra } } : a;
  } catch (err) {
    if (err instanceof MeasureFailed) throw new Refusal(422, `The measurement failed: ${err.message}`);
    throw err;
  }
}

/** "Still measuring the mix: 35% done, about 2 min left", as the bar (or the command line) says it. */
export function stillLine(now: Extract<MeasureAnswer, { done: false }>, label: string): string {
  const left =
    now.eta === null ? '' : now.eta < 90 ? `, about ${now.eta} s left` : `, about ${Math.round(now.eta / 60)} min left`;
  return `Still measuring ${label}: ${Math.round(now.progress * 100)}% done${left}`;
}

/** One measurement (anything but the studio's meters) planned for a song as it is now. */
export function planMeasure(ctx: PlanContext, song: Project, what: Exclude<MeasureWhat, 'meters'>, b: Body): Planned {
  const { dataDir, runner, recording } = ctx;
  const words = ctx.words ?? AGENT_WORDS;
  const rev = `${song.id}@${song.revision}`;
  const from = tick(b.from, 'from');
  const to = tick(b.to, 'to');
  if (from !== undefined && to !== undefined && to <= from) throw bad('to is after from');
  const range = { ...(from !== undefined ? { from } : {}), ...(to !== undefined ? { to } : {}) };
  const trackOf = (v: unknown, what = 'track') => {
    const id = idOf(v, what);
    const t = song.tracks.find((x) => x.id === id);
    if (!t) throw new Refusal(404, `No track ${id} in the song`);
    return t;
  };
  const bounce = () => {
    const f = newestBounce(dataDir, song.id);
    if (!f) throw new Refusal(404, words.noBounce, 'no-bounce');
    return f;
  };
  switch (what) {
    case 'take': {
      const against = opt(b.against) ? 'key' : b.against === 'key' || b.against === 'none' ? b.against : null;
      if (!opt(b.through) && b.through !== 'recording' && b.through !== 'effects')
        throw bad('through is "recording" or "effects"');
      const through = b.through === 'effects';
      if (!opt(b.attachment)) {
        if (through) throw bad(words.noEffects);
        const { path, name } = recording(b.attachment);
        const k = keysOf(song)[0] ?? null;
        return {
          lane: 'files',
          key: `take:${b.attachment}:${against ?? 'key'}:${k ? `${k.fifths}${k.mode}` : ''}`,
          estimate: 3,
          input: { kind: 'recording', path, name, key: k, against: against === 'none' ? 'none' : 'key' },
          label: 'the recording',
        };
      }
      const t = trackOf(b.track);
      if (t.kind !== 'audio') throw bad(`${t.name} isn’t an audio track: a take is a recording`);
      let ref = against;
      if (ref === null) {
        const r = trackOf(b.against, 'against');
        if (r.kind !== 'instrument') throw bad('against is "key", "none" or an instrument track');
        ref = r.id;
      }
      const region = opt(b.region) ? undefined : idOf(b.region, 'region');
      if (region && !t.regions.some((r) => r.id === region)) throw new Refusal(404, `No region ${region} on ${t.name}`);
      const grid = opt(b.grid) ? 240 : int(b.grid, 'grid', 10, 3840);
      const input: ChildInput = {
        kind: 'take',
        dataDir,
        project: song,
        track: t.id,
        ...(region ? { region } : {}),
        ...range,
        against: ref,
        grid,
        ...(through ? { through: 'effects' as const } : {}),
      };
      if (through) {
        // rendered: the track alone through its plugins, over its regions' bars and two bars before
        let span: { from: number; to: number };
        try {
          span = takeSpan(t, { ...(region ? { region } : {}), ...range });
        } catch (err) {
          throw new Refusal(422, err instanceof Error ? err.message : String(err));
        }
        const estimate = runner.paced(
          song.id,
          2 + renderSeconds(song, span.from, span.to) * (0.05 + weight(t) + 0.02 * t.channel.inserts.length),
        );
        if (estimate > MAX_RENDER_S) throw tooLong(estimate, 'Measuring the take through its effects there', words);
        return {
          lane: 'render',
          key: `take:${rev}:${JSON.stringify([t.id, region, from, to, ref, grid, 'effects'])}`,
          label: `the take on ${t.name} through its effects`,
          estimate,
          input,
        };
      }
      const seconds = t.regions.reduce(
        (s, r) =>
          s + (r.audio ? tickToSeconds(song.tempo, r.start + r.length) - tickToSeconds(song.tempo, r.start) : 0),
        0,
      );
      // a region whose notes are edited is measured as it plays: its recording loaded, its patches rendered
      const edited = t.regions.filter((r) => (!region || r.id === region) && editedSeconds(r) > 0);
      const files = new Set(edited.map((r) => r.audio?.file));
      const recordings = [...files].reduce((s, f) => s + (song.files?.find((x) => x.id === f)?.seconds ?? 0), 0);
      const patches = edited.reduce((s, r) => s + editedSeconds(r), 0);
      return {
        lane: 'files',
        key: `take:${rev}:${JSON.stringify([t.id, region, from, to, ref, grid])}`,
        label: `the take on ${t.name}`,
        estimate: 1 + seconds * 0.015 + recordings * 0.02 + patches * 0.08,
        input,
      };
    }
    case 'notes': {
      // a recording's notes, found once whoever asks: by its file and the engine's code, not the song's revision
      const t = trackOf(b.track);
      if (t.kind !== 'audio') throw bad(`${t.name} isn’t an audio track: notes are found in a recording`);
      const audio = t.regions.filter((r) => r.audio);
      let r: Region | undefined;
      if (opt(b.region)) {
        if (audio.length !== 1)
          throw bad(
            audio.length ? `${t.name} has ${plural(audio.length, 'region')}: say which` : `${t.name} has no recording`,
          );
        r = audio[0];
      } else {
        const id = idOf(b.region, 'region');
        r = t.regions.find((x) => x.id === id);
        if (!r) throw new Refusal(404, `No region ${id} on ${t.name}`);
        if (!r.audio) throw bad('That region plays no recording');
      }
      const file = (r as Region).audio?.file as string;
      const known = song.files?.find((f) => f.id === file);
      return {
        lane: 'files',
        key: `notes:${song.id}:${file}:${engineCode(REPO)}`,
        label: `the notes of ${known?.name ?? 'the recording'}`,
        estimate: 1 + (known?.seconds ?? 60) * 0.05,
        input: { kind: 'notes', dataDir, project: song.id, file, name: known?.name ?? file },
      };
    }
    case 'mix':
    case 'file': {
      const source = opt(b.source) ? (what === 'file' && opt(b.attachment) ? 'bounce' : 'render') : b.source;
      if (source !== 'render' && source !== 'bounce') throw bad('source is render or bounce');
      if (what === 'file' && !opt(b.attachment)) {
        const { path, name } = recording(b.attachment);
        return {
          lane: 'files',
          key: `file:${b.attachment}`,
          label: 'the recording',
          estimate: 5,
          input: { kind: 'file', path, name, source: 'file' },
        };
      }
      if (source === 'bounce' || what === 'file') {
        const f = bounce();
        // the song from its start, unless it's the cycle's bounce (laid out by the clock, then)
        const whole = !/\(cycle\)\.wav$/.test(f.name);
        return {
          lane: 'files',
          key: `bounce:${f.path}:${f.made}:${song.id}@${song.revision}`,
          label: 'the bounce',
          estimate: 5,
          input: { kind: 'file', path: f.path, name: f.name, source: 'bounce', ...(whole ? { project: song } : {}) },
          extra: { made: new Date(f.made).toISOString(), stale: f.made < Date.parse(song.modified) },
        };
      }
      const seconds = renderSeconds(song, from, to);
      const estimate = runner.paced(song.id, 3 + seconds * mixWeight(song));
      if (estimate > MAX_RENDER_S) throw tooLong(estimate, 'Measuring the mix there', words);
      return {
        lane: 'render',
        key: `mix:${rev}:${JSON.stringify([from, to])}`,
        label: 'the mix',
        estimate,
        input: { kind: 'mix', dataDir, project: song, ...range },
      };
    }
    case 'tracks': {
      const list: Track[] = opt(b.track) ? song.tracks : [trackOf(b.track)];
      if (!opt(b.against)) {
        if (opt(b.track)) throw bad('against needs a track to compare it with');
        const other = trackOf(b.against, 'against');
        if (other.id === list[0]?.id) throw bad('against is another track');
        list.push(other);
      }
      if (!list.length) throw new Refusal(404, 'The song has no tracks');
      const seconds = renderSeconds(song, from, to);
      const estimate = runner.paced(
        song.id,
        list.reduce((s, t) => s + 2 + seconds * (0.05 + weight(t)), 0),
      );
      if (estimate > MAX_RENDER_S)
        throw tooLong(
          estimate,
          list.length > 1 ? `Rendering ${plural(list.length, 'track')} one by one` : 'That',
          words,
        );
      return {
        lane: 'render',
        key: `tracks:${rev}:${JSON.stringify([list.map((t) => t.id), from, to])}`,
        label: list.length === 1 ? (list[0] as Track).name : list.length === 2 ? 'the two tracks' : 'each track',
        estimate,
        input: { kind: 'tracks', dataDir, project: song, tracks: list.map((t) => t.id), ...range },
      };
    }
    case 'plugin': {
      const channel = b.track === 'master' ? 'master' : idOf(b.track, 'track');
      const owner =
        channel === 'master'
          ? { channel: song.master, track: null }
          : (() => {
              const t = song.tracks.find((x) => x.id === channel);
              const bus = song.buses.find((x) => x.id === channel);
              if (!t && !bus) throw new Refusal(404, `No track or bus ${channel} in the song`);
              return { channel: (t ?? bus)?.channel as Project['master'], track: t ?? null };
            })();
      const id = idOf(b.plugin, 'plugin');
      const p = owner.channel.inserts.find((x) => x.id === id);
      if (!p) throw new Refusal(404, `No plugin ${id} there`);
      const linear = ['eq', 'peq', 'reverb', 'space', 'delay', 'width'].includes(p.type);
      const seconds = renderSeconds(song, from, to);
      const heavy = owner.track ? 0.1 + weight(owner.track) : mixWeight(song);
      const estimate = linear ? 3 : runner.paced(song.id, 3 + seconds * heavy);
      if (estimate > MAX_RENDER_S) throw tooLong(estimate, 'Measuring it on its track’s sound', words);
      return {
        lane: linear ? 'files' : 'render',
        key: `plugin:${rev}:${JSON.stringify([channel, id, linear ? null : from, linear ? null : to])}`,
        label: `the ${PLUGINS.find((d) => d.type === p.type)?.name ?? p.type}`,
        estimate,
        input: { kind: 'plugin', dataDir, project: song, channel, plugin: id, ...range },
      };
    }
  }
}
