/**
 * The agent's measurements (docs/agent.md, "Measuring"): `POST …/measure` asks for one, `GET
 * …/measure/:task` asks again after it by id. A take, a bounce or an attachment is read from its file;
 * the mix, a track or a plugin's effect on its track's sound is rendered; all of it in a child process
 * (runner.ts), each call waiting up to 40 s and otherwise answering how far it has got. The studio's
 * own meters (`what: 'meters'`) are asked of the requester's studio, while it plays.
 *
 * A render is refused when it would take too long (about ten minutes of work): the answer says to
 * measure fewer bars or one track, or to bounce the song and measure the bounce.
 */
import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { keysOf, PLUGINS, type Project, projectEnd, type Track, tickToSeconds } from '@holo/session';
import type { FastifyRequest } from 'fastify';
import { NO_ANSWER } from '../../live.ts';
import { ATTACHMENT_ID } from '../attachments.ts';
import { type Body, bad, body, ID, int, isObj, num, type Params } from '../check.ts';
import type { JobRouteKit } from '../job-routes/index.ts';
import { type AgentJob, Refusal } from '../jobs.ts';
import {
  type Lane,
  type MeasureAnswer,
  MeasureFailed,
  MeasureRunner,
  type RunnerOptions,
  type Watcher,
} from './runner.ts';
import type { ChildInput } from './tasks.ts';

export const MEASURE_WHAT = ['take', 'mix', 'tracks', 'plugin', 'meters', 'file'] as const;
export type MeasureWhat = (typeof MEASURE_WHAT)[number];

/** A render estimated to take longer than this (s) is refused, with what to do instead. */
export const MAX_RENDER_S = 600;
/** How many seconds of play the studio's meters cover unless asked (it waits for them, up to 30). */
const METERS_S = 8;
const METERS_MAX_S = 30;
/** How long the studio has to read out its meters, past the seconds it may wait for them (ms). */
const METERS_MS = 4000;
/** A bounce file, as the server names them. */
const BOUNCE_FILE = /^[\w .()'-]+\.wav$/;
/** Audio attachments the host decodes (MP3, OGG and M4A are measured in the studio, as their meta). */
const DECODED = new Set(['audio/wav', 'audio/x-wav', 'audio/flac', 'audio/aiff', 'audio/x-aiff']);

/** What one measurement asks to have done, as the child is handed it: its lane, cache key and estimate. */
interface Planned {
  lane: Lane;
  key: string;
  estimate: number;
  input: ChildInput;
  /** Said with the answer (a bounce's name and age). */
  extra?: Record<string, unknown>;
  /** What it measures, in words for the bar ("the mix"). */
  label: string;
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

function tooLong(seconds: number, what: string): Refusal {
  const minutes = Math.round(seconds / 60);
  return new Refusal(
    422,
    `${what} would take about ${plural(minutes, 'minute')} to render here: measure fewer bars ("from" and "to"), or one track, or ask the user to bounce the song (ask_permission "bounce") and measure the bounce (source "bounce")`,
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
function metersOf(answer: Record<string, unknown>): Record<string, unknown> {
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

export interface MeasureRoutesOptions extends RunnerOptions {
  runner?: MeasureRunner;
}

/** `POST …/measure` and `GET …/measure/:task`. */
export default function measureRoutes(kit: JobRouteKit, options: MeasureRoutesOptions = {}): void {
  const { app, J, forJob, jobs, live, dataDir, attachments } = kit;
  const runner = options.runner ?? new MeasureRunner(options);
  jobs.onJobEnd((job) => runner.jobEnded(job.view.id, job.view.state === 'cancelled' || job.view.state === 'failed'));
  kit.onClose(() => runner.close());

  /** The path of an attachment of this job's, if it's a recording the host decodes. */
  const recording = (job: AgentJob, id: unknown): { path: string; name: string } => {
    if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) throw bad('attachment is an attachment’s id');
    const a = attachments.get(id);
    if (!a) throw new Refusal(404, 'No such attachment');
    if (a.project !== job.view.project || !jobs.mayRead(job, id))
      throw new Refusal(403, 'That attachment isn’t this request’s');
    if (!DECODED.has(a.type))
      throw new Refusal(
        422,
        a.type.startsWith('audio/')
          ? 'Only WAV, FLAC and AIFF recordings are measured on the host: what the studio heard in this one is in its meta (attachment_get)'
          : 'That attachment isn’t a recording',
      );
    const path = attachments.file(id);
    if (!path) throw new Refusal(404, 'No such attachment');
    return { path, name: a.name };
  };

  const bounce = (song: Project) => {
    const b = newestBounce(dataDir, song.id);
    if (!b)
      throw new Refusal(
        404,
        'The song hasn’t been bounced: ask the user to bounce it (ask_permission "bounce"), or measure the mix by rendering it (source "render")',
        'no-bounce',
      );
    return b;
  };

  function plan(job: AgentJob, song: Project, what: Exclude<MeasureWhat, 'meters'>, b: Body): Planned {
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
    switch (what) {
      case 'take': {
        const against = opt(b.against) ? 'key' : b.against === 'key' || b.against === 'none' ? b.against : null;
        if (!opt(b.attachment)) {
          const { path, name } = recording(job, b.attachment);
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
        if (region && !t.regions.some((r) => r.id === region))
          throw new Refusal(404, `No region ${region} on ${t.name}`);
        const grid = opt(b.grid) ? 240 : int(b.grid, 'grid', 10, 3840);
        const seconds = t.regions.reduce(
          (s, r) =>
            s + (r.audio ? tickToSeconds(song.tempo, r.start + r.length) - tickToSeconds(song.tempo, r.start) : 0),
          0,
        );
        return {
          lane: 'files',
          key: `take:${rev}:${JSON.stringify([t.id, region, from, to, ref, grid])}`,
          label: `the take on ${t.name}`,
          estimate: 1 + seconds * 0.015,
          input: {
            kind: 'take',
            dataDir,
            project: song,
            track: t.id,
            ...(region ? { region } : {}),
            ...range,
            against: ref,
            grid,
          },
        };
      }
      case 'mix':
      case 'file': {
        const source = opt(b.source) ? (what === 'file' && opt(b.attachment) ? 'bounce' : 'render') : b.source;
        if (source !== 'render' && source !== 'bounce') throw bad('source is render or bounce');
        if (what === 'file' && !opt(b.attachment)) {
          const { path, name } = recording(job, b.attachment);
          return {
            lane: 'files',
            key: `file:${b.attachment}`,
            label: 'the recording',
            estimate: 5,
            input: { kind: 'file', path, name, source: 'file' },
          };
        }
        if (source === 'bounce' || what === 'file') {
          const f = bounce(song);
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
        if (estimate > MAX_RENDER_S) throw tooLong(estimate, 'Measuring the mix there');
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
          throw tooLong(estimate, list.length > 1 ? `Rendering ${plural(list.length, 'track')} one by one` : 'That');
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
        if (estimate > MAX_RENDER_S) throw tooLong(estimate, 'Measuring it on its track’s sound');
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

  /**
   * While a call waits, the bar under the studio's command bar says how far the measurement has got
   * ("Still measuring the mix: 35% done, about 2 min left"), as the tool will when the call answers.
   */
  const saying = (job: AgentJob): Watcher => {
    let said = '';
    return (now, label) => {
      const left =
        now.eta === null
          ? ''
          : now.eta < 90
            ? `, about ${now.eta} s left`
            : `, about ${Math.round(now.eta / 60)} min left`;
      const line = `Still measuring ${label}: ${Math.round(now.progress * 100)}% done${left}`;
      if (line === said) return;
      said = line;
      jobs.progress(job, line);
    };
  };

  /** A measurement's answer (with what's said beside its result), or why it failed. */
  const answered = async (waiting: Promise<MeasureAnswer>, extra?: Record<string, unknown>) => {
    try {
      const a = await waiting;
      return a.done && extra ? { ...a, result: { ...a.result, ...extra } } : a;
    } catch (err) {
      if (err instanceof MeasureFailed) throw new Refusal(422, `The measurement failed: ${err.message}`);
      throw err;
    }
  };

  app.post(
    `${J}/measure`,
    forJob(async (req, _reply, job) => {
      const b = body(req);
      const what = b.what as MeasureWhat;
      if (!MEASURE_WHAT.includes(what)) throw bad(`what is ${MEASURE_WHAT.join(', ')}`);
      if (what === 'meters') {
        const studio = jobs.studio(job);
        if (!studio) throw new Refusal(403, 'The song isn’t open in the studio that asked');
        const seconds = opt(b.seconds) ? METERS_S : num(b.seconds, 'seconds', 1, METERS_MAX_S);
        // the studio waits until it has watched that much play (playing started less than that ago)
        const answer = await live.request(studio, { type: 'agent-meters', seconds }, seconds * 1000 + METERS_MS);
        if (!answer.ok)
          throw new Refusal(
            answer.error === NO_ANSWER ? 504 : 409,
            answer.error ?? 'The studio couldn’t read its meters',
          );
        return { done: true, task: 'meters', result: metersOf(answer) };
      }
      const arrived = Date.now();
      const song = await jobs.song(job);
      const planned = plan(job, song, what, b);
      // the budget counts from the call's arrival (the studio saves first)
      const budget = Math.max(Math.min(1000, runner.budgetMs), runner.budgetMs - (Date.now() - arrived));
      return answered(
        runner.request(
          {
            job: job.view.id,
            project: song.id,
            key: planned.key,
            lane: planned.lane,
            estimate: planned.estimate,
            input: planned.input,
            label: planned.label,
          },
          budget,
          saying(job),
        ),
        planned.extra,
      );
    }),
  );

  app.get(
    `${J}/measure/:task`,
    forJob(async (req: FastifyRequest, _reply, job) => {
      const id = (req.params as Params).task ?? '';
      const waiting = /^msr_[a-z0-9]{1,40}$/.test(id)
        ? runner.check(id, job.view.project, job.view.id, undefined, saying(job))
        : null;
      if (!waiting) throw new Refusal(404, 'No such measurement (it may be from before HO[LO] restarted): ask again');
      return answered(waiting);
    }),
  );
}
