/**
 * PUT …/details: who the job's song is by and its album, set as the Songs window sets them (the
 * server's own `PUT /api/projects/:id/details`, answered as it answers). The library keeps them beside
 * the song, so they're outside undo, and a creation's song is refused (400): it stays its creation's.
 */
import { bad, body, CONTROL } from '../check.ts';
import type { JobRoutes } from './index.ts';

const details: JobRoutes = ({ app, J, forJob, relayJson }) => {
  app.put(
    `${J}/details`,
    forJob(async (req, reply, job) => {
      const b = body(req);
      const payload: Record<string, string | null> = {};
      for (const field of ['artist', 'album'] as const) {
        const v = b[field];
        if (v === undefined) continue;
        if (v !== null && (typeof v !== 'string' || v.length > 200 || CONTROL.test(v)))
          throw bad(`${field} is a name (one line), or null for none`);
        payload[field] = v;
      }
      if (!Object.keys(payload).length) throw bad('Say artist or album');
      return relayJson(reply, 'PUT', `/api/projects/${encodeURIComponent(job.view.project)}/details`, payload);
    }),
  );
};

export default details;
