/**
 * The command line's measurements (`holo measure`, docs/agent.md "Measuring"): what the agent's
 * `measure` tool measures, for any song, outside the agent's job routes and with the agent on or off.
 *
 * - `POST /api/projects/:id/measure` asks for one: the job route's body, with `file` (a recording sent
 *   first) where the agent gives an `attachment`. It waits up to 40 s and otherwise answers how far it
 *   has got; the same question again joins it.
 * - `GET /api/projects/:id/measure/:task` asks again after it by id.
 * - `POST /api/projects/:id/measure/files?name=` takes a recording to measure (WAV, FLAC or AIFF, up to
 *   200 MB, as `application/x-holo-audio`) and answers its id: the same file always gets the same id,
 *   so a recording sent again joins its measurement. Kept a day.
 *
 * They're planned as the agent's are (plan.ts) and run by the same runner, so the same question about
 * the same song as it is now is the same measurement whoever asks it, or comes from the cache. The
 * studio with the song open is asked to save first (as the agent's are), and the studio's meters are
 * asked of it. A measurement the command line asked for is never cancelled: it runs to its end (a
 * render too long to make is refused before it starts).
 */
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import {
  closeSync,
  createWriteStream,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import type { Project } from '@holo/session';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { GONE, NO_ANSWER } from '../../live.ts';
import { MAX_AUDIO } from '../attachments.ts';
import { type Body, bad, isObj, num } from '../check.ts';
import type { JobRouteKit } from '../job-routes/index.ts';
import { Refusal } from '../jobs.ts';
import {
  answered,
  MEASURE_WHAT,
  METERS_MAX_S,
  METERS_MS,
  METERS_S,
  type MeasureWhat,
  metersOf,
  type PlanWords,
  planMeasure,
} from './plan.ts';
import type { MeasureRunner } from './runner.ts';

/** Who asks, as the runner keeps its askers: the command line is one asker, and never ends. */
export const TERMINAL = 'holo';

/** A recording sent to measure: its id, from its bytes. */
const FILE_ID = /^mfl_[0-9a-f]{16}$/;
/** A recording sent to measure is kept this long (ms). */
const KEEP_MS = 24 * 3600_000;
/** How long the studio with the song open has to save before a measurement reads it (ms). */
const FLUSH_MS = 10_000;

/** The command line's words: its flags and commands. */
export const TERMINAL_WORDS: PlanWords = {
  tooLong:
    'measure fewer bars (--from and --to), or one track (--track), or bounce the song in the studio (holo bounce) and measure the bounce (--source bounce)',
  noBounce:
    'The song hasn’t been bounced: bounce it in the studio (holo bounce), or measure the mix by rendering it (leave --source out)',
  noEffects: 'A recording file has no effects: --through effects is for a track’s take',
};

const opt = (v: unknown) => v === undefined || v === null;

/** WAV (RIFF or RF64), FLAC or AIFF, by its first bytes. */
function recordingExt(head: Buffer): string | null {
  const tag = head.subarray(0, 4).toString('latin1');
  if ((tag === 'RIFF' || tag === 'RF64') && head.subarray(8, 12).toString('latin1') === 'WAVE') return '.wav';
  if (tag === 'fLaC') return '.flac';
  if (tag === 'FORM') return '.aiff';
  return null;
}

/** A request's body as it arrives, to a file under `dir`, hashed as it goes; refused past `max` bytes. */
async function receive(
  stream: AsyncIterable<Uint8Array | string>,
  dir: string,
  max: number,
): Promise<{ path: string; hash: string; size: number }> {
  mkdirSync(dir, { recursive: true });
  const path = join(dir, `.upload-${randomBytes(6).toString('hex')}`);
  const hash = createHash('sha256');
  const out = createWriteStream(path);
  let size = 0;
  try {
    for await (const piece of stream) {
      const chunk = typeof piece === 'string' ? Buffer.from(piece) : piece;
      size += chunk.length;
      if (size > max) throw new Refusal(413, `A recording to measure is ${Math.round(max / 1024 ** 2)} MB at most`);
      hash.update(chunk);
      if (!out.write(chunk)) await once(out, 'drain');
    }
    out.end();
    await once(out, 'finish');
  } catch (err) {
    out.destroy();
    rmSync(path, { force: true });
    throw err;
  }
  return { path, hash: hash.digest('hex'), size };
}

/** `POST /api/projects/:id/measure`, `GET …/measure/:task` and `POST …/measure/files`, with the agent's runner. */
export default function terminalMeasureRoutes(
  kit: Pick<JobRouteKit, 'app' | 'live' | 'store' | 'dataDir'>,
  runner: MeasureRunner,
): void {
  const { app, live, store, dataDir } = kit;
  const filesOf = (project: string) => join(dataDir, 'measure-files', project.replace(/[^\w-]/g, ''));

  /** A route whose refusals are answered `{error, reason?}`, as the agent's are. */
  const route =
    (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(req, reply);
      } catch (err) {
        if (err instanceof Refusal)
          return reply.code(err.status).send({ error: err.message, ...(err.reason ? { reason: err.reason } : {}) });
        throw err;
      }
    };

  const projectOf = (req: FastifyRequest): string => {
    const id = (req.params as { id?: string }).id ?? '';
    if (!store.get(id)) throw new Refusal(404, 'No such project');
    return id;
  };

  /** The song as it is now: the studio with it open saves first (as for the agent's measurements). */
  const songNow = async (id: string): Promise<Project> => {
    const studio = live.editor(id);
    if (studio) await live.request(studio, { type: 'agent-flush' }, FLUSH_MS);
    const song = store.get(id);
    if (!song) throw new Refusal(404, 'No such project');
    return song;
  };

  /** A recording sent to measure, by its id: its file here and its name. */
  const recording = (project: string, id: unknown): { path: string; name: string } => {
    if (typeof id !== 'string' || !FILE_ID.test(id))
      throw bad('file is a recording’s id, as POST /api/projects/:id/measure/files answers it');
    const dir = filesOf(project);
    const found = existsSync(dir)
      ? readdirSync(dir).find((f) => f.startsWith(`${id}.`) && !f.endsWith('.json'))
      : undefined;
    if (!found) throw new Refusal(404, 'No such recording here (they are kept a day): send it again');
    let name = found;
    try {
      const meta = JSON.parse(readFileSync(join(dir, `${id}.json`), 'utf8')) as { name?: unknown };
      if (typeof meta.name === 'string' && meta.name) name = meta.name;
    } catch {
      // (its name is its file's, then)
    }
    return { path: join(dir, found), name };
  };

  /** Recordings sent more than a day ago go. */
  const sweep = (dir: string) => {
    const now = Date.now();
    for (const f of readdirSync(dir)) {
      const path = join(dir, f);
      try {
        if (now - statSync(path).mtimeMs > KEEP_MS) rmSync(path, { force: true });
      } catch {
        // (gone already)
      }
    }
  };

  app.post(
    '/api/projects/:id/measure/files',
    route(async (req, reply) => {
      const project = projectOf(req);
      const raw = (req.query as { name?: unknown }).name;
      const name = (typeof raw === 'string' && raw.trim() ? raw.trim() : 'recording.wav')
        .replace(/\p{Cc}/gu, '')
        .slice(0, 120);
      const dir = filesOf(project);
      const got = await receive(req.body as AsyncIterable<Uint8Array>, dir, MAX_AUDIO);
      try {
        const head = Buffer.alloc(12);
        const fd = openSync(got.path, 'r');
        try {
          readSync(fd, head, 0, head.length, 0);
        } finally {
          closeSync(fd);
        }
        const ext = recordingExt(head);
        if (!ext) throw new Refusal(415, 'Only WAV, FLAC and AIFF recordings are measured on the host');
        const id = `mfl_${got.hash.slice(0, 16)}`;
        renameSync(got.path, join(dir, `${id}${ext}`));
        writeFileSync(join(dir, `${id}.json`), JSON.stringify({ name }));
        sweep(dir);
        return reply.code(201).send({ file: id, name, size: got.size });
      } finally {
        rmSync(got.path, { force: true });
      }
    }),
  );

  app.post(
    '/api/projects/:id/measure',
    route(async (req) => {
      const project = projectOf(req);
      if (!isObj(req.body)) throw bad('The body is a JSON object');
      const b = req.body as Body;
      const what = b.what as MeasureWhat;
      if (!MEASURE_WHAT.includes(what)) throw bad(`what is ${MEASURE_WHAT.join(', ')}`);
      if (!opt(b.attachment)) throw bad('A recording is sent first (POST …/measure/files), then named as file');
      if (what === 'meters') {
        const seconds = opt(b.seconds) ? METERS_S : num(b.seconds, 'seconds', 1, METERS_MAX_S);
        const studio = live.editor(project);
        if (!studio)
          throw new Refusal(409, 'No studio has this song open: the meters are the studio’s, while it plays');
        // the studio waits until it has watched that much play (playing started less than that ago)
        const answer = await live.request(studio, { type: 'agent-meters', seconds }, seconds * 1000 + METERS_MS, true);
        if (answer.error === GONE) throw new Refusal(409, 'The studio went away before it read its meters');
        if (!answer.ok)
          throw new Refusal(
            answer.error === NO_ANSWER ? 504 : 409,
            answer.error ?? 'The studio couldn’t read its meters',
          );
        return { done: true, task: 'meters', result: metersOf(answer) };
      }
      const arrived = Date.now();
      const song = await songNow(project);
      const { file, ...rest } = b;
      const planned = planMeasure(
        { dataDir, runner, recording: (id) => recording(project, id), words: TERMINAL_WORDS },
        song,
        what,
        opt(file) ? rest : { ...rest, attachment: file },
      );
      // the budget counts from the call's arrival (the studio saves first)
      const budget = Math.max(Math.min(1000, runner.budgetMs), runner.budgetMs - (Date.now() - arrived));
      return answered(
        runner.request(
          {
            job: TERMINAL,
            project: song.id,
            key: planned.key,
            lane: planned.lane,
            estimate: planned.estimate,
            input: planned.input,
            label: planned.label,
          },
          budget,
        ),
        planned.extra,
      );
    }),
  );

  app.get(
    '/api/projects/:id/measure/:task',
    route(async (req) => {
      const project = projectOf(req);
      const id = (req.params as { task?: string }).task ?? '';
      const waiting = /^msr_[a-z0-9]{1,40}$/.test(id) ? runner.check(id, project, TERMINAL) : null;
      if (!waiting) throw new Refusal(404, 'No such measurement (it may be from before HO[LO] restarted): ask again');
      return answered(waiting);
    }),
  );
}
