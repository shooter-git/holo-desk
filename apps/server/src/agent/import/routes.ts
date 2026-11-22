/**
 * The import tool's route (docs/agent.md): `POST …/import {attachment}`. What only a browser decodes
 * is converted by the requester's studio, so that needs it there (409 `away` while it's in the
 * background or closed); the rest is read here, studio or not. The answer is what importer.ts says: the
 * recording as one of the song's files, or the MIDI or MusicXML file as a song to merge; or, after
 * about 40 s of a studio still converting, not done yet.
 */
import { ATTACHMENT_ID } from '../attachments.ts';
import { bad, body } from '../check.ts';
import type { JobRoutes } from '../job-routes/index.ts';
import { Importer } from './importer.ts';

const importRoutes: JobRoutes = (kit) => {
  const importer = new Importer(kit);
  kit.onClose(() => importer.close());
  kit.app.post(
    `${kit.J}/import`,
    kit.forJob(async (req, _reply, job) => {
      const id = body(req).attachment;
      if (typeof id !== 'string' || !ATTACHMENT_ID.test(id)) throw bad('attachment is an attachment’s id (att_…)');
      return importer.import(job, id);
    }),
  );
};

export default importRoutes;
