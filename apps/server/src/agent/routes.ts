/**
 * The agent's HTTP routes (docs/agent.md): turning it on and pairing a device with the runner's code
 * (the first, or one that lost its way back in), devices asking to join, settings, the harnesses'
 * sign-in and updates, requests and their jobs, threads; and the job-scoped routes its tools call
 * (`/api/agent/jobs/:job/*`, with the job's token).
 *
 * Only `GET /api/agent`, pairing, and asking to join are open; everything else needs an allowed
 * device's token (401 without one), or for the tools, the running job's token (403 when it isn't).
 * Every body is checked: its types, its lengths, and ids of the shapes HO[LO] makes. With the agent
 * off, only turning it on, Settings (to turn it on again) and removing devices answer.
 *
 * Attachments a device sends are kept a week, each the device's own for the song it was sent for;
 * a job reads only those its request (or an earlier one on its thread) named.
 */
import { createReadStream } from 'node:fs';
import { join } from 'node:path';
import { SCAN_ID, type Scan } from '@holo/score';
import { describeProject, type Op } from '@holo/session';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from '../db.ts';
import type { Live } from '../live.ts';
import {
  ATTACHMENT_ID,
  ATTACHMENT_TYPES,
  Attachments,
  type AttachmentType,
  HEAD,
  isAudio,
  isScore,
  MAX_AUDIO,
  MAX_META,
  maxSize,
  metaSummary,
  scoreText,
  sniff,
  tooBigText,
} from './attachments.ts';
import { Auth, bearer } from './auth.ts';
import { type Body, bad, body, CONTROL, ID, int, isObj, line, num, type Params, text } from './check.ts';
import { type JobHandler, type JobRouteKit, type OwnMethod, registerJobRoutes } from './job-routes/index.ts';
import { type AgentJob, Jobs, type Limits, MODEL, PERMISSION_KINDS, Refusal } from './jobs.ts';
import type { PermissionKind, RequestContext, ScanPreset } from './prompt.ts';
import { AgentStore, HARNESSES, type HarnessId } from './store.ts';
import { Threads } from './threads.ts';

export interface AgentOptions {
  store: Store;
  live: Live;
  repoDir: string;
  /** HO[LO]'s data folder (attachments are kept in agent/attachments there). */
  dataDir: string;
  /** The URL the agent's tools reach this server at. */
  base: () => string;
  scans: { get: (id: string) => Scan | null };
  limits?: Partial<Limits>;
}

const NOT_ALLOWED = 'This device isn’t allowed to use the agent';
const OFF = 'The agent is off: turn it on in Settings › Agent';
/** MusicXML is passed on whole (as text) up to this size; past it, only what was measured. */
const MAX_XML_DATA = 1024 * 1024;

// ---- checking what comes in (the checks every route uses are in check.ts) ----

/** What the studio sees, as a request carries it: each part checked, anything else left out. */
function context(v: unknown): RequestContext | undefined {
  if (v === undefined || v === null) return undefined;
  if (!isObj(v)) throw bad('context is an object');
  const out: RequestContext = {};
  if (v.view !== undefined) {
    if (typeof v.view !== 'string' || !/^[\w .-]{1,40}$/.test(v.view)) throw bad('context.view is a view’s name');
    out.view = v.view;
  }
  if (v.selection !== undefined && v.selection !== null) {
    const s = v.selection;
    if (!isObj(s)) throw bad('context.selection is an object');
    const sel: NonNullable<RequestContext['selection']> = {};
    if (s.track !== undefined && s.track !== null) {
      if (typeof s.track !== 'string' || !ID.test(s.track)) throw bad('context.selection.track is a track’s id');
      sel.track = s.track;
    }
    if (s.regions !== undefined) {
      if (
        !Array.isArray(s.regions) ||
        s.regions.length > 1000 ||
        !s.regions.every((r) => typeof r === 'string' && ID.test(r))
      )
        throw bad('context.selection.regions are regions’ ids');
      sel.regions = s.regions as string[];
    }
    if (s.notes !== undefined) sel.notes = int(s.notes, 'context.selection.notes', 0, 1_000_000);
    if (s.from !== undefined) sel.from = num(s.from, 'context.selection.from', 0, 1e10);
    if (s.to !== undefined) sel.to = num(s.to, 'context.selection.to', 0, 1e10);
    out.selection = sel;
  }
  if (v.playhead !== undefined) out.playhead = num(v.playhead, 'context.playhead', 0, 1e10);
  if (v.cycle !== undefined && v.cycle !== null) {
    const c = v.cycle;
    if (!isObj(c) || typeof c.on !== 'boolean') throw bad('context.cycle is {on, start, end}');
    out.cycle = {
      on: c.on,
      start: num(c.start, 'context.cycle.start', 0, 1e10),
      end: num(c.end, 'context.cycle.end', 0, 1e10),
    };
  }
  if (v.scan !== undefined && v.scan !== null) {
    if (typeof v.scan !== 'string' || !SCAN_ID.test(v.scan)) throw bad('context.scan is a scan’s id');
    out.scan = v.scan;
  }
  return out;
}

function preset(v: unknown): ScanPreset | null {
  if (v === undefined || v === null) return null;
  if (!isObj(v) || v.kind !== 'scan') throw bad('preset is {kind: "scan", task, scan}');
  if (v.task !== 'read' && v.task !== 'check' && v.task !== 'fix') throw bad('preset.task is read, check or fix');
  if (typeof v.scan !== 'string' || !SCAN_ID.test(v.scan)) throw bad('preset.scan is a scan’s id');
  return { kind: 'scan', task: v.task, scan: v.scan };
}

function harnessId(v: unknown): HarnessId {
  if (!HARNESSES.includes(v as HarnessId)) throw new Refusal(404, 'No such harness');
  return v as HarnessId;
}

/** A refusal as the studio (or the agent) reads it: `{error, reason?}` with its status. */
function refuse(reply: FastifyReply, err: Refusal) {
  return reply.code(err.status).send({ error: err.message, ...(err.reason ? { reason: err.reason } : {}) });
}

export function agentRoutes(app: FastifyInstance, o: AgentOptions): { jobs: Jobs; auth: Auth; close: () => void } {
  const { store, live } = o;
  const agentStore = new AgentStore(store.database);
  const threads = new Threads(agentStore);
  let jobs: Jobs | null = null;
  const auth = new Auth({
    store: agentStore,
    changed: () => live.toDevices({ type: 'agent-devices' }),
    removed: (device) => {
      // its job stops (the studio hears so), then the studio loses the agent
      jobs?.deviceRemoved(device);
      live.downgrade(device);
    },
  });
  const attachments = new Attachments(join(o.dataDir, 'agent', 'attachments'));
  attachments.start();
  const theJobs = new Jobs({
    live,
    store,
    agentStore,
    threads,
    repoDir: o.repoDir,
    base: o.base,
    scan: o.scans.get,
    attachment: (id, project, device) => {
      const a = ATTACHMENT_ID.test(id) ? attachments.get(id) : null;
      if (!a || a.project !== project || a.device !== device) return null;
      const summary = metaSummary(a.meta);
      return { id, name: a.name, type: a.type, size: a.size, ...(summary ? { summary } : {}) };
    },
    deviceFor: (token) => auth.deviceFor(token)?.id ?? null,
    allowed: (device) => auth.allowed(device),
    ...(o.limits ? { limits: o.limits } : {}),
  });
  jobs = theJobs;
  live.agent = theJobs;

  type DeviceHandler = (req: FastifyRequest, reply: FastifyReply, device: string) => Promise<unknown>;
  /** A route for allowed devices (401 without a device's token; with the agent off, 409 unless `whenOff`). */
  const forDevice =
    (handler: DeviceHandler, whenOff = false) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const device = auth.device(req.headers.authorization);
      if (!device) return reply.code(401).send({ error: NOT_ALLOWED });
      if (!whenOff && !agentStore.settings().enabled) return reply.code(409).send({ error: OFF, reason: 'off' });
      try {
        return await handler(req, reply, device.id);
      } catch (err) {
        if (err instanceof Refusal) return refuse(reply, err);
        throw err;
      }
    };

  /** A refusal said as such, for the open routes. */
  const open =
    (handler: (req: FastifyRequest, reply: FastifyReply) => Promise<unknown>) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      try {
        return await handler(req, reply);
      } catch (err) {
        if (err instanceof Refusal) return refuse(reply, err);
        throw err;
      }
    };

  /**
   * A route for a job's tools: its token, while it runs (403 otherwise); with `studio`, only while the
   * requester's studio has the job's song open.
   */
  const forJob =
    (handler: JobHandler, studio = false) =>
    async (req: FastifyRequest, reply: FastifyReply) => {
      const token = bearer(req.headers.authorization);
      if (!token) return reply.code(401).send({ error: 'This needs the job’s token' });
      const job = theJobs.forTool((req.params as Params).job ?? '', token);
      if (!job) return reply.code(403).send({ error: 'This job has ended, or the token isn’t its' });
      if (studio && !theJobs.studio(job))
        return reply.code(403).send({ error: 'The song isn’t open in the studio that asked' });
      try {
        return await handler(req, reply, job);
      } catch (err) {
        if (err instanceof Refusal) return refuse(reply, err);
        throw err;
      }
    };

  /** One of the server's own routes, asked from here (the tools get exactly what the studio does). */
  const own = async (method: OwnMethod, url: string, payload?: Body) => {
    const res = await app.inject({ method, url, ...(payload ? { payload } : {}) });
    return res;
  };
  const relayJson = async (reply: FastifyReply, method: OwnMethod, url: string, payload?: Body) => {
    const res = await own(method, url, payload);
    return reply.code(res.statusCode).type('application/json; charset=utf-8').send(res.body);
  };

  const settingsView = () => theJobs.settingsView();

  /** At most 10 attachments' ids, as HO[LO] makes them. */
  const attachmentIds = (v: unknown): string[] => {
    const ids = v ?? [];
    if (!Array.isArray(ids) || ids.length > 10 || !ids.every((a) => typeof a === 'string' && ATTACHMENT_ID.test(a)))
      throw bad('attachments are at most 10 attachments’ ids');
    return ids as string[];
  };

  // ---- open ----

  app.get('/api/agent', async (req) => ({
    enabled: agentStore.settings().enabled,
    allowed: auth.device(req.headers.authorization) !== null,
    // no device is allowed yet (a code works either way, while a keyed runner is connected)
    pairing: auth.unpaired(),
    runner: live.runners(),
  }));

  app.post(
    '/api/agent/pairing',
    open(async (_req, reply) => {
      if (auth.locked()) return reply.code(429).send({ error: auth.lockedText() });
      // with devices allowed or not: the code is the way back in for a device that lost its token
      const runners = live.keyedRunners();
      if (!runners.length)
        return reply
          .code(409)
          .send({ error: 'Start the runner on this computer (pnpm runner): it shows the code', reason: 'no-runner' });
      const { code, expires } = auth.startPairing();
      for (const r of runners) live.sendTo(r, { type: 'pairing-code', code, expires });
      return { expires };
    }),
  );

  app.post(
    '/api/agent/pair',
    open(async (req, reply) => {
      const b = body(req);
      if (typeof b.code !== 'string' || b.code.length > 20) throw bad('code is the 6 digits the runner shows');
      const name = line(b.name, 'name', 60);
      const r = auth.pair(b.code.trim(), name);
      if (!r.ok) return reply.code(r.status).send({ error: r.error });
      const was = agentStore.settings().enabled;
      agentStore.setSettings({ enabled: true });
      if (!was) {
        theJobs.announce(true);
        theJobs.turnedOn();
      }
      return { token: r.token, device: r.device };
    }),
  );

  app.post(
    '/api/agent/devices/requests',
    open(async (req, reply) => {
      if (!agentStore.settings().enabled) return reply.code(409).send({ error: OFF, reason: 'off' });
      const name = line(body(req).name, 'name', 60);
      const r = auth.ask(name);
      if ('error' in r) return reply.code(r.status).send({ error: r.error });
      return r;
    }),
  );

  app.get(
    '/api/agent/devices/requests/:id',
    open(async (req, reply) => {
      const secret = (req.query as Record<string, unknown>).secret;
      const r = auth.poll((req.params as Params).id ?? '', typeof secret === 'string' ? secret : '');
      return r ?? reply.code(404).send({ error: 'No such request' });
    }),
  );

  // ---- devices and settings ----

  app.get(
    '/api/agent/devices',
    forDevice(async (_req, _reply, device) => auth.list(device), true),
  );

  for (const answer of ['approve', 'deny'] as const) {
    app.post(
      `/api/agent/devices/requests/:id/${answer}`,
      forDevice(async (req, reply) =>
        auth.answer((req.params as Params).id ?? '', answer === 'approve')
          ? { ok: true }
          : reply.code(404).send({ error: 'No such request waiting' }),
      ),
    );
  }

  app.delete(
    '/api/agent/devices/:id',
    forDevice(
      async (req, reply) =>
        auth.remove((req.params as Params).id ?? '') ? { ok: true } : reply.code(404).send({ error: 'No such device' }),
      true,
    ),
  );

  app.get(
    '/api/agent/settings',
    forDevice(async () => settingsView(), true),
  );

  app.put(
    '/api/agent/settings',
    forDevice(async (req) => {
      const b = body(req);
      const patch: Parameters<AgentStore['setSettings']>[0] = {};
      if (b.enabled !== undefined) {
        if (typeof b.enabled !== 'boolean') throw bad('enabled is true or false');
        patch.enabled = b.enabled;
      }
      if (b.harness !== undefined) patch.harness = b.harness === null ? null : harnessIdOr400(b.harness);
      for (const key of ['model', 'effort'] as const) {
        const v = b[key];
        if (v === undefined) continue;
        if (typeof v !== 'string' || (v !== '' && !MODEL.test(v)))
          throw bad(`${key} is a name of letters, digits and . : - _ [ ] =, or empty for the harness's own`);
        patch[key] = v;
      }
      const before = agentStore.settings();
      const after = agentStore.setSettings(patch);
      if (before.enabled && !after.enabled) theJobs.stopAll('The agent was turned off');
      if (!before.enabled && after.enabled) theJobs.turnedOn();
      // the studios hear of it: whether it's on, and (allowed devices) the rest
      const enabledChanged = before.enabled !== after.enabled;
      if (
        enabledChanged ||
        before.harness !== after.harness ||
        before.model !== after.model ||
        before.effort !== after.effort
      )
        theJobs.announce(enabledChanged);
      return settingsView();
    }, true),
  );

  // ---- harnesses: found, signed in, up to date (on the runner's computer) ----

  app.post(
    '/api/agent/harnesses/refresh',
    forDevice(async () => {
      theJobs.relay('refresh');
      return { ok: true };
    }),
  );
  app.post(
    '/api/agent/harnesses/:id/login',
    forDevice(async (req) => {
      theJobs.relay('login', harnessId((req.params as Params).id));
      return { ok: true };
    }),
  );
  app.post(
    '/api/agent/harnesses/:id/login/code',
    forDevice(async (req) => {
      const harness = harnessId((req.params as Params).id);
      const code = body(req).code;
      if (typeof code !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(code.trim()))
        throw bad('code is the code the sign-in page showed');
      theJobs.relay('login-code', harness, code.trim());
      return { ok: true };
    }),
  );
  app.post(
    '/api/agent/harnesses/:id/update',
    forDevice(async (req) => {
      theJobs.relay('update', harnessId((req.params as Params).id));
      return { ok: true };
    }),
  );

  // ---- requests, jobs and threads ----

  app.post(
    '/api/agent/requests',
    forDevice(async (req, _reply, device) => {
      const b = body(req);
      if (typeof b.project !== 'string' || !ID.test(b.project)) throw bad('project is a song’s id');
      const p = preset(b.preset);
      const request = p ? text(b.text, 'text', 4000, true) : text(b.text, 'text', 4000);
      const ids = attachmentIds(b.attachments);
      const ctx = context(b.context);
      const job = await theJobs.request(device, {
        project: b.project,
        text: request,
        attachments: ids,
        preset: p,
        ...(ctx ? { context: ctx } : {}),
      });
      return { job };
    }),
  );

  app.post(
    '/api/agent/jobs/:job/cancel',
    forDevice(async (req) => {
      theJobs.cancel((req.params as Params).job ?? '');
      return { ok: true };
    }),
  );

  const askPermission = async (req: FastifyRequest, job: AgentJob) => {
    const b = body(req);
    if (!PERMISSION_KINDS.includes(b.kind as PermissionKind))
      throw bad('kind is install-pack, send-creation, bounce, render, screen, photo or microphone');
    const kind = b.kind as PermissionKind;
    const detail = line(b.detail, 'detail', 300);
    // only a creation can render its own song
    if (kind === 'render' && !store.get(job.view.project)?.origin)
      throw bad('This song didn’t come from a creation, so there’s none to render it');
    let pack: string | undefined;
    if (b.pack !== undefined && b.pack !== null) {
      if (typeof b.pack !== 'string' || !/^[\w.-]{1,80}$/.test(b.pack)) throw bad('pack is a pack’s id');
      pack = b.pack;
    }
    if (kind === 'install-pack' && !pack) throw bad('install-pack names its pack');
    if (kind !== 'install-pack' && pack) throw bad('pack goes only with install-pack');
    theJobs.permission(job, { kind, detail, ...(pack ? { pack } : {}) });
    return { ok: true };
  };

  // the same path for the job's tools (its token: they ask) and for the device (its token: it answers)
  app.post('/api/agent/jobs/:job/permission', async (req, reply) => {
    const token = bearer(req.headers.authorization);
    const job = token ? theJobs.forTool((req.params as Params).job ?? '', token) : null;
    if (job) return forJob(async (r) => askPermission(r, job))(req, reply);
    return forDevice(async (r, _reply, device) => {
      const b = body(r);
      if (typeof b.grant !== 'boolean') throw bad('grant is true or false');
      const result = text(b.result, 'result', 1000, true);
      // a screenshot, a photo or a recording the click took comes as an attachment
      const ids = attachmentIds(b.attachments);
      const next = await theJobs.permit(device, (r.params as Params).job ?? '', b.grant, result, ids);
      return next ? { ok: true, job: next } : { ok: true };
    })(req, reply);
  });

  // the user pressed Done while the agent listened
  app.post(
    '/api/agent/jobs/:job/done-listening',
    forDevice(async (req, _reply, device) => {
      theJobs.doneListening(device, (req.params as Params).job ?? '');
      return { ok: true };
    }),
  );

  app.get(
    '/api/agent/threads/:project',
    forDevice(async (req) => theJobs.threadView((req.params as Params).project ?? '')),
  );
  app.post(
    '/api/agent/threads/:project/reset',
    forDevice(async (req, reply) => {
      const project = (req.params as Params).project ?? '';
      if (theJobs.running(project))
        return reply.code(409).send({ error: 'Still working on this song', reason: 'busy' });
      threads.reset(project);
      return { ok: true };
    }),
  );

  // ---- attachments: what a device sends with a request ----

  // any type comes in as bytes, straight to disk as they arrive, cut off at the type's limit (the type
  // it is is in the query, and checked against its first bytes); the device and the agent being on are
  // checked before the body is read
  app.register(async (scope) => {
    scope.removeAllContentTypeParsers();
    scope.addContentTypeParser('*', (_req, payload, done) => done(null, payload));
    scope.post(
      '/api/agent/attachments',
      {
        bodyLimit: MAX_AUDIO,
        onRequest: async (req, reply) => {
          if (!auth.device(req.headers.authorization)) return reply.code(401).send({ error: NOT_ALLOWED });
          if (!agentStore.settings().enabled) return reply.code(409).send({ error: OFF, reason: 'off' });
        },
      },
      forDevice(async (req, _reply, device) => {
        const q = req.query as Record<string, unknown>;
        if (typeof q.project !== 'string' || !ID.test(q.project)) throw bad('project is a song’s id');
        if (!store.get(q.project)) throw new Refusal(404, 'No such song');
        const name = line(q.name, 'name', 120);
        if (!ATTACHMENT_TYPES.includes(q.type as AttachmentType))
          throw new Refusal(415, `HO[LO] takes ${ATTACHMENT_TYPES.join(', ')}`);
        const type = q.type as AttachmentType;
        const max = maxSize(type);
        // too big by what it says: not read at all
        if (Number(req.headers['content-length']) > max) throw new Refusal(413, tooBigText(type));
        const body = req.body as AsyncIterable<Uint8Array> | null | undefined;
        const got = body && Symbol.asyncIterator in Object(body) ? await attachments.receive(body, max) : null;
        if (body && !got) throw new Refusal(413, tooBigText(type));
        if (!got?.size) {
          if (got) attachments.discard(got.id);
          throw bad('The file is the body, and it’s empty');
        }
        // a recording by its first bytes; anything else (at most 25 MB) whole
        const wrong = sniff(type, attachments.head(got.id, isAudio(type) ? HEAD : undefined));
        if (wrong) {
          attachments.discard(got.id);
          throw new Refusal(415, wrong);
        }
        const a = attachments.keep(got.id, device, q.project, name, type, got.size);
        return { id: a.id, name: a.name, type: a.type, size: a.size };
      }),
    );
  });

  // a file's bytes, for the device that sent it (the studio imports a recording it can decode); or for
  // the device whose running job may read it (an earlier request on the job's thread, from another device)
  app.get(
    '/api/agent/attachments/:id/data',
    forDevice(async (req, reply, device) => {
      const id = (req.params as Params).id ?? '';
      const a = ATTACHMENT_ID.test(id) ? attachments.get(id) : null;
      const path = a ? attachments.file(id) : null;
      if (!a || !path) throw new Refusal(404, 'No such attachment');
      const job = theJobs.running(a.project);
      const jobs = !!job && job.view.device === device && theJobs.mayRead(job, id);
      if (a.device !== device && !jobs) throw new Refusal(403, 'Not this device’s');
      return reply
        .type(a.type)
        .header('content-length', a.size)
        .header('cache-control', 'no-store')
        .send(createReadStream(path));
    }),
  );

  app.put(
    '/api/agent/attachments/:id/meta',
    { bodyLimit: MAX_META },
    forDevice(async (req, _reply, device) => {
      const id = (req.params as Params).id ?? '';
      const a = ATTACHMENT_ID.test(id) ? attachments.get(id) : null;
      if (!a) throw new Refusal(404, 'No such attachment');
      if (a.device !== device) throw new Refusal(403, 'Not this device’s');
      if (!isObj(req.body)) throw bad('What was measured is a JSON object');
      attachments.setMeta(id, req.body);
      return { ok: true };
    }),
  );

  // ---- the job's tools ----

  const J = '/api/agent/jobs/:job';

  app.get(
    `${J}/song`,
    forJob(async (_req, _reply, job) => theJobs.song(job)),
  );
  app.get(
    `${J}/describe`,
    forJob(async (_req, _reply, job) => {
      // the song as text, after who it's by, its album and its creation (the library's, beside the song)
      const text = describeProject(await theJobs.song(job));
      const about = theJobs.about(job.view.project);
      return { text: about.length ? `${about.join('\n')}\n${text}` : text };
    }),
  );
  app.get(
    `${J}/state`,
    forJob(async (_req, _reply, job) => theJobs.studioState(job), true),
  );

  app.post(
    `${J}/ops`,
    forJob(async (req, _reply, job) => {
      const b = body(req);
      const ops = b.ops;
      if (
        !Array.isArray(ops) ||
        ops.length === 0 ||
        ops.length > 5000 ||
        !ops.every((op) => isObj(op) && typeof op.op === 'string')
      )
        throw bad('ops are 1 to 5000 operations');
      const label = line(b.label, 'label', 80);
      if (typeof b.batch !== 'string' || !/^[\w.:-]{1,80}$/.test(b.batch)) throw bad('batch is an id for this batch');
      return theJobs.ops(job, ops as Op[], label, b.batch);
    }),
  );

  app.post(
    `${J}/transport`,
    forJob(async (req, _reply, job) => {
      const b = body(req);
      if (b.action !== 'play' && b.action !== 'stop' && b.action !== 'locate')
        throw bad('action is play, stop or locate');
      const bar = b.bar === undefined || b.bar === null ? undefined : int(b.bar, 'bar', 1, 100_000);
      if (b.action === 'locate' && bar === undefined) throw bad('locate needs a bar');
      return theJobs.transport(job, b.action, bar);
    }, true),
  );

  app.post(
    `${J}/audition`,
    forJob(async (req, _reply, job) => {
      const b = body(req);
      const events = b.events;
      if (!Array.isArray(events) || events.length === 0 || events.length > 1024)
        throw bad('events are 1 to 1024 [delayMs, status, data1, data2]');
      const checked = events.map((e) => {
        if (!Array.isArray(e) || e.length !== 4) throw bad('each event is [delayMs, status, data1, data2]');
        return [
          num(e[0], 'delayMs', 0, 60_000),
          int(e[1], 'status', 0x80, 0xef),
          int(e[2], 'data1', 0, 127),
          int(e[3], 'data2', 0, 127),
        ];
      });
      const track = b.track === undefined || b.track === null ? undefined : line(b.track, 'track', 64);
      theJobs.audition(job, checked, track);
      return { ok: true };
    }, true),
  );

  // listening (a part at a time: a tool call is cut at 60 s by some harnesses), what was just played, A/B
  app.post(
    `${J}/listen`,
    forJob(async (req, _reply, job) => {
      const b = body(req);
      if (b.last !== undefined && typeof b.last !== 'boolean') throw bad('last is true or false');
      return theJobs.listen(
        job,
        int(b.maxMs, 'maxMs', 100, 45_000),
        int(b.quietMs, 'quietMs', 500, 10_000),
        b.last === true,
      );
    }, true),
  );
  app.get(
    `${J}/played`,
    forJob(async (req, _reply, job) => {
      const raw = (req.query as Record<string, unknown>).seconds;
      const seconds = typeof raw === 'string' && /^\d{1,3}(\.\d+)?$/.test(raw) ? Number(raw) : Number.NaN;
      return theJobs.played(job, num(seconds, 'seconds', 1, 60));
    }, true),
  );
  app.post(
    `${J}/compare`,
    forJob(async (req, _reply, job) => {
      const b = body(req);
      const from = int(b.from, 'from', 1, 100_000);
      const to = int(b.to, 'to', 2, 100_001);
      if (to <= from) throw bad('to is after from (the bar it stops at, not played)');
      return theJobs.compare(job, from, to);
    }, true),
  );

  app.get(
    `${J}/packs`,
    forJob(async (_req, reply) => relayJson(reply, 'GET', '/api/packs')),
  );
  app.get(
    `${J}/packs/available`,
    forJob(async (_req, reply) => relayJson(reply, 'GET', '/api/packs/available')),
  );
  app.get(
    `${J}/instruments/:pack/:name`,
    forJob(async (req, reply) => {
      const { pack, name } = req.params as Params;
      if (!pack || !name || !/^[\w.-]{1,80}$/.test(pack) || name.length > 120 || CONTROL.test(name))
        throw new Refusal(404, 'No such instrument');
      return relayJson(reply, 'GET', `/api/packs/${encodeURIComponent(pack)}/instruments/${encodeURIComponent(name)}`);
    }),
  );

  /** A scan of the job's song (another song's is no business of this job's). */
  const scanOf = (job: AgentJob, id: string | undefined) => {
    const scan = id && SCAN_ID.test(id) ? o.scans.get(id) : null;
    if (!scan) throw new Refusal(404, 'No such scan');
    if (scan.project !== job.view.project) throw new Refusal(403, 'That scan is another song’s');
    return scan;
  };
  const INDEX = /^\d{1,3}$/;

  app.get(
    `${J}/scans/:id`,
    forJob(async (req, _reply, job) => scanOf(job, (req.params as Params).id)),
  );
  app.get(
    `${J}/scans/:id/strip/:page/:system`,
    forJob(async (req, reply, job) => {
      const { id, page, system } = req.params as Params;
      const scan = scanOf(job, id);
      if (!page || !system || !INDEX.test(page) || !INDEX.test(system)) throw new Refusal(404, 'No such strip');
      const res = await own('GET', `/api/scans/${scan.id}/strips/${Number(page)}/${Number(system)}`);
      if (res.statusCode !== 200) return reply.code(404).send({ error: 'No such strip' });
      return reply
        .type(String(res.headers['content-type'] ?? 'image/png'))
        .header('cache-control', 'no-store')
        .send(res.rawPayload);
    }),
  );
  app.patch(
    `${J}/scans/:id/systems/:page/:system`,
    forJob(async (req, reply, job) => {
      const { id, page, system } = req.params as Params;
      const scan = scanOf(job, id);
      if (!page || !system || !INDEX.test(page) || !INDEX.test(system)) throw new Refusal(404, 'No such system');
      const b = body(req);
      const patch: Body = {};
      if (b.state !== undefined) {
        if (!['new', 'read', 'checked', 'approved'].includes(b.state as string))
          throw bad('state is new, read, checked or approved');
        patch.state = b.state;
      }
      if (b.written !== undefined) {
        if (!Array.isArray(b.written) || b.written.length !== 2) throw bad('written is [first bar, last bar]');
        patch.written = [int(b.written[0], 'written', 0, 100_000), int(b.written[1], 'written', 0, 100_000)];
      }
      if (b.flags !== undefined) {
        if (!Array.isArray(b.flags) || b.flags.length > 40) throw bad('flags are at most 40 lines');
        patch.flags = b.flags.map((f) => line(f, 'a flag', 300));
      }
      return relayJson(reply, 'PATCH', `/api/scans/${scan.id}/systems/${Number(page)}/${Number(system)}`, patch);
    }),
  );

  app.get(
    `${J}/attachments/:id`,
    forJob(async (req, _reply, job) => {
      const id = (req.params as Params).id ?? '';
      const a = ATTACHMENT_ID.test(id) ? attachments.get(id) : null;
      if (!a) throw new Refusal(404, 'No such attachment');
      // only what this job's request (or an earlier one on its thread) named, for its song
      if (a.project !== job.view.project || !theJobs.mayRead(job, id))
        throw new Refusal(403, 'That attachment isn’t this request’s');
      const whole = a.type.startsWith('image/') || a.type === 'text/plain';
      let data = whole ? attachments.data(id) : null;
      // a score as UTF-8 text, whatever it came as (UTF-16, or zipped in an .mxl), up to MAX_XML_DATA
      if (isScore(a.type)) {
        const bytes = attachments.data(id);
        const xml = bytes ? await scoreText(a.type, bytes).catch(() => null) : null;
        const utf8 = xml === null ? null : Buffer.from(xml, 'utf8');
        if (utf8 && utf8.length <= MAX_XML_DATA) data = utf8;
      }
      return {
        name: a.name,
        type: a.type,
        size: a.size,
        meta: a.meta ?? null,
        ...(data ? { data: data.toString('base64') } : {}),
      };
    }),
  );

  app.post(
    `${J}/progress`,
    forJob(async (req, _reply, job) => {
      theJobs.progress(job, line(body(req).line, 'line', 200));
      return { ok: true };
    }),
  );
  app.post(
    `${J}/handoff`,
    forJob(async (req, _reply, job) => {
      theJobs.handoff(job, text(body(req).brief, 'brief', 4000));
      return { ok: true };
    }),
  );
  app.post(
    `${J}/finish`,
    forJob(async (req, _reply, job) => {
      const b = body(req);
      theJobs.finish(job, line(b.label, 'label', 80), text(b.reply, 'reply', 600));
      return { ok: true };
    }),
  );

  // the rest of the job's tools: each area's routes in its own module (job-routes/index.ts lists them)
  const closing: (() => void)[] = [];
  const kit: JobRouteKit = {
    app,
    J,
    forJob,
    jobs: theJobs,
    live,
    store,
    attachments,
    dataDir: o.dataDir,
    scans: o.scans,
    own,
    relayJson,
    onClose: (fn) => closing.push(fn),
  };
  registerJobRoutes(kit);

  return {
    jobs: theJobs,
    auth,
    close: () => {
      theJobs.close();
      attachments.stop();
      for (const fn of closing) fn();
    },
  };
}

/** A harness named in a body (400 if it isn't one). */
function harnessIdOr400(v: unknown): HarnessId {
  if (!HARNESSES.includes(v as HarnessId)) throw bad('harness is claude, codex or cursor');
  return v as HarnessId;
}
