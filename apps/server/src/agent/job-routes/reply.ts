/**
 * What a reply's view needs from the job's studio: POST …/version keeps the song as it is now as a
 * named version (the studio saves first; a revision in the song's history, which its play and keep
 * buttons use), and GET …/commands lists the studio's own commands its buttons may run.
 */
import { VERSION_NAME } from '@holo/agent/view';
import { bad, body, line } from '../check.ts';
import type { JobRoutes } from './index.ts';

const reply: JobRoutes = ({ app, J, forJob, jobs }) => {
  app.post(
    `${J}/version`,
    forJob(async (req, _reply, job) => {
      const name = line(body(req).name, 'name', 40).trim();
      if (!VERSION_NAME.test(name)) throw bad('name is a few words, letters and numbers first');
      return jobs.version(job, name);
    }, true),
  );
  app.get(
    `${J}/commands`,
    forJob(async (_req, _reply, job) => jobs.commands(job), true),
  );
};

export default reply;
