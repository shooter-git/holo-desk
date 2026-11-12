/**
 * The job-scoped routes kept in modules of their own (`/api/agent/jobs/:job/*`, docs/agent.md), one
 * module per area. routes.ts builds the kit (what those routes reach: the server, the job's checks, the
 * jobs, the live channel, the songs, the attachments) and calls `registerJobRoutes` once.
 *
 * A module is a function of the kit that adds its routes, each wrapped in `forJob` (the job's token,
 * while it runs; with `studio`, only while the requester's studio has the job's song open), its bodies
 * checked with check.ts. To add one: its import in its area's block below, and its entry in `MODULES`.
 */
import type { Scan } from '@holo/score';
import type { FastifyInstance, FastifyReply, FastifyRequest, LightMyRequestResponse } from 'fastify';
import type { Store } from '../../db.ts';
import type { Live } from '../../live.ts';
import type { Attachments } from '../attachments.ts';
import type { Body } from '../check.ts';
import type { AgentJob, Jobs } from '../jobs.ts';

// ---- measure ----

// ---- details ----

// ---- import ----

/** A job route's handler: the request, the reply, and the job whose token came with it. */
export type JobHandler = (req: FastifyRequest, reply: FastifyReply, job: AgentJob) => Promise<unknown>;

/** The methods `own` asks the server's own routes with. */
export type OwnMethod = 'GET' | 'PATCH' | 'PUT';

/** What the job routes reach. */
export interface JobRouteKit {
  app: FastifyInstance;
  /** The job routes' path: `/api/agent/jobs/:job` (a route is `${J}/…`). */
  J: string;
  /**
   * A route for a job's tools: its token, while it runs (403 otherwise); with `studio`, only while the
   * requester's studio has the job's song open. A Refusal thrown inside is answered as `{error, reason?}`.
   */
  forJob: (handler: JobHandler, studio?: boolean) => (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>;
  jobs: Jobs;
  live: Live;
  store: Store;
  attachments: Attachments;
  /** HO[LO]'s data folder. */
  dataDir: string;
  /** The scans (a job reads only its own song's). */
  scans: { get: (id: string) => Scan | null };
  /** One of the server's own routes, asked from here (the tools get exactly what the studio does). */
  own: (method: OwnMethod, url: string, payload?: Body) => Promise<LightMyRequestResponse>;
  /** `own`'s answer passed on as it came: its status and its JSON. */
  relayJson: (reply: FastifyReply, method: OwnMethod, url: string, payload?: Body) => Promise<FastifyReply>;
  /** Something to do as the server closes (a child process to stop, a timer to clear). */
  onClose: (fn: () => void) => void;
}

/** A module of job routes: it adds its routes to the kit's server. */
export type JobRoutes = (kit: JobRouteKit) => void;

/** Every module of job routes, in its area's block. */
export const MODULES: readonly JobRoutes[] = [
  // ---- measure ----
  // ---- details ----
  // ---- import ----
];

/** Adds every module's routes (routes.ts calls it once, with the kit). */
export function registerJobRoutes(kit: JobRouteKit, modules: readonly JobRoutes[] = MODULES): void {
  for (const add of modules) add(kit);
}
