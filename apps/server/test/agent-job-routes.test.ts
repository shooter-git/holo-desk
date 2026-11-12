import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { bad, body, int } from '../src/agent/check.ts';
import { type JobRouteKit, type JobRoutes, registerJobRoutes } from '../src/agent/job-routes/index.ts';
import { type AgentJob, Refusal } from '../src/agent/jobs.ts';

describe('the job routes kept in modules', () => {
  it('adds each module’s routes to the server, through the kit', async () => {
    const app = Fastify();
    const job = { view: { id: 'agj_000000000000', project: 'prj_a' } } as unknown as AgentJob;
    // (forJob as routes.ts makes it, short of the token: the job, and a Refusal answered as {error})
    const forJob: JobRouteKit['forJob'] = (handler) => async (req, reply) => {
      try {
        return await handler(req, reply, job);
      } catch (err) {
        if (err instanceof Refusal) return reply.code(err.status).send({ error: err.message });
        throw err;
      }
    };
    const kit = { app, J: '/api/agent/jobs/:job', forJob } as unknown as JobRouteKit;
    const echo: JobRoutes = ({ app, J, forJob }) => {
      app.post(
        `${J}/echo`,
        forJob(async (req, _reply, job) => {
          const n = int(body(req).n, 'n', 1, 9);
          if (n === 9) throw bad('n is not 9 here');
          return { job: job.view.id, n };
        }),
      );
    };
    const seen: JobRouteKit[] = [];
    registerJobRoutes(kit, [echo, (k) => seen.push(k)]);
    expect(seen).toEqual([kit]);

    const post = (n: unknown) =>
      app.inject({ method: 'POST', url: '/api/agent/jobs/agj_000000000000/echo', payload: { n } });
    expect((await post(3)).json()).toEqual({ job: 'agj_000000000000', n: 3 });
    const refused = await post(9);
    expect(refused.statusCode).toBe(400);
    expect(refused.json()).toEqual({ error: 'n is not 9 here' });
    expect((await post('3')).json()).toEqual({ error: 'n is a whole number from 1 to 9' });
    await app.close();
  });
});
