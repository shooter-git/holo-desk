/**
 * The agent's measurements (docs/agent.md, "Measuring"): `POST …/measure` asks for one, `GET
 * …/measure/:task` asks again after it by id. A take, a bounce or an attachment is read from its file;
 * the mix, a track or a plugin's effect on its track's sound is rendered; all of it in a child process
 * (runner.ts), each call waiting up to 40 s and otherwise answering how far it has got. The studio's
 * own meters (`what: 'meters'`) are asked of the requester's studio, while it plays.
 *
 * A render is refused when it would take too long (about ten minutes of work): the answer says to
 * measure fewer bars or one track, or to bounce the song and measure the bounce (plan.ts plans each
 * measurement). The command line's measurements (terminal.ts) share this runner.
 */
import type { FastifyRequest } from 'fastify';
import { NO_ANSWER } from '../../live.ts';
import { ATTACHMENT_ID } from '../attachments.ts';
import { bad, body, num, type Params } from '../check.ts';
import type { JobRouteKit } from '../job-routes/index.ts';
import { type AgentJob, awayIfGone, Refusal } from '../jobs.ts';
import {
  answered,
  MEASURE_WHAT,
  METERS_MAX_S,
  METERS_MS,
  METERS_S,
  type MeasureWhat,
  metersOf,
  planMeasure,
  stillLine,
} from './plan.ts';
import { MeasureRunner, type RunnerOptions, type Watcher } from './runner.ts';
import terminalMeasureRoutes from './terminal.ts';

export { MAX_RENDER_S, MEASURE_WHAT, type MeasureWhat } from './plan.ts';

/** The meters' call, all told: the tool's client gives a measure call 50 s; this leaves it a little. */
const METERS_CALL_MS = 45_000;
/** Audio attachments the host decodes (MP3, OGG and M4A are measured in the studio, as their meta). */
const DECODED = new Set(['audio/wav', 'audio/x-wav', 'audio/flac', 'audio/aiff', 'audio/x-aiff']);

const opt = (v: unknown) => v === undefined || v === null;

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

  /**
   * While a call waits, the bar under the studio's command bar says how far the measurement has got
   * ("Still measuring the mix: 35% done, about 2 min left"), as the tool will when the call answers.
   */
  const saying = (job: AgentJob): Watcher => {
    let said = '';
    return (now, label) => {
      const line = stillLine(now, label);
      if (line === said) return;
      said = line;
      jobs.progress(job, line);
    };
  };

  app.post(
    `${J}/measure`,
    forJob(async (req, _reply, job) => {
      const b = body(req);
      const what = b.what as MeasureWhat;
      if (!MEASURE_WHAT.includes(what)) throw bad(`what is ${MEASURE_WHAT.join(', ')}`);
      if (what === 'meters') {
        const seconds = opt(b.seconds) ? METERS_S : num(b.seconds, 'seconds', 1, METERS_MAX_S);
        // a studio away a moment is waited for, as long as the call's 50 s leave after the meters' own time
        const studio = await jobs.studioBack(job, METERS_CALL_MS - (seconds * 1000 + METERS_MS));
        // the studio waits until it has watched that much play (playing started less than that ago)
        const answer = await live.request(studio, { type: 'agent-meters', seconds }, seconds * 1000 + METERS_MS, true);
        awayIfGone(answer);
        if (!answer.ok)
          throw new Refusal(
            answer.error === NO_ANSWER ? 504 : 409,
            answer.error ?? 'The studio couldn’t read its meters',
          );
        return { done: true, task: 'meters', result: metersOf(answer) };
      }
      const arrived = Date.now();
      const song = await jobs.song(job);
      const planned = planMeasure({ dataDir, runner, recording: (id) => recording(job, id) }, song, what, b);
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

  // the command line's measurements (`holo measure`), with this runner: the same question about the same
  // song joins the same measurement, whoever asks it
  terminalMeasureRoutes(kit, runner);
}
