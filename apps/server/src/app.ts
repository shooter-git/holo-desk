/**
 * HO[LO]'s server: the studio's files, its projects, its sample packs, the live channel, and the
 * bridge to your creations. It has no accounts and no passwords: it listens on this machine only,
 * and your own devices reach it through Tailscale.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { constants as zlib } from 'node:zlib';
import fastifyCompress from '@fastify/compress';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import { engineLabel, engineRelation, studioEngine } from '@holo/music';
import {
  applyOps,
  describeNotes,
  describeProject,
  findTrack,
  newId,
  newProject,
  type Op,
  OpError,
  type Project,
  parsePosition,
  parseProject,
  projectFromMidi,
  readMidi,
  SessionError,
  writeMidi,
} from '@holo/session';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { Config } from './config.ts';
import { Creations, sessionText } from './creations.ts';
import { Store } from './db.ts';
import { Live, type RenderJob } from './live.ts';
import { NetworkMidi } from './network-midi.ts';
import { audioInfo, extractZip, importFolder, saveStream } from './pack-import.ts';
import { Packs } from './packs.ts';

const ISOLATION = {
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'require-corp',
  'cross-origin-resource-policy': 'same-origin',
};

export interface Services {
  store: Store;
  packs: Packs;
  live: Live;
  creations: Creations;
}

export async function buildApp(config: Config): Promise<{ app: FastifyInstance; services: Services }> {
  const app = Fastify({ logger: { level: process.env.HOLO_LOG ?? 'warn' }, bodyLimit: 64 * 1024 * 1024 });
  const store = new Store(config.dataDir);
  const packs = new Packs(join(config.dataDir, 'packs'));
  const live = new Live();
  live.latestRevision = (id) => store.get(id)?.revision ?? null;
  const creations = new Creations(config.creationsDir);
  /** The engine this studio plays: what an experience's pinned engine is measured against. */
  const studio = studioEngine(config.repoDir);

  // every response may be part of a cross-origin isolated page
  app.addHook('onSend', async (_req, reply) => {
    for (const [k, v] of Object.entries(ISOLATION)) reply.header(k, v);
  });

  // JSON and text go out compressed (a song is a fifth of its size as brotli); other devices reach
  // the server through a proxy that compresses nothing. Audio is left alone, and the studio's own
  // files come compressed from the build, so a light setting is enough here
  await app.register(fastifyCompress, {
    global: true,
    threshold: 1024,
    encodings: ['br', 'gzip'],
    brotliOptions: { params: { [zlib.BROTLI_PARAM_QUALITY]: 4 } },
  });

  app.setErrorHandler((err, _req, reply) => {
    const message = err instanceof Error ? err.message : String(err);
    if (err instanceof SessionError || err instanceof OpError) return reply.code(400).send({ error: message });
    const status = (err as { statusCode?: number }).statusCode ?? 500;
    if (status >= 500) app.log.error(err);
    return reply.code(status).send({ error: message });
  });

  await app.register(fastifyWebsocket);
  app.register(async (scope) => {
    scope.get('/api/live', { websocket: true }, (socket) => live.attach(socket));
  });

  // ---- health and settings ----

  app.get('/api/health', async () => ({
    ok: true,
    version: '0.1.1',
    engine: { ...studio, label: engineLabel(studio) },
  }));

  app.get('/api/settings', async () => ({ middleC: store.setting('middleC') ?? 'C3' }));
  app.put<{ Body: { middleC?: string } }>('/api/settings', async (req) => {
    if (req.body.middleC === 'C3' || req.body.middleC === 'C4') store.setSetting('middleC', req.body.middleC);
    return { middleC: store.setting('middleC') ?? 'C3' };
  });

  // ---- projects ----

  app.get('/api/projects', async () => store.list());

  app.post<{ Body: { title?: string; doc?: unknown } }>('/api/projects', async (req, reply) => {
    const project = req.body.doc ? parseProject(req.body.doc) : newProject(req.body.title?.trim() || 'Untitled');
    if (store.get(project.id)) project.id = newId('prj');
    const saved = store.save({ ...project, revision: 0 }, null, 'studio');
    return reply.code(201).send(saved);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    const project = store.get(req.params.id);
    return project ?? reply.code(404).send({ error: 'No such project' });
  });

  app.put<{ Params: { id: string }; Body: { doc: unknown; baseRevision: number | null; author?: string } }>(
    '/api/projects/:id',
    async (req, reply) => {
      const project = parseProject(req.body.doc);
      if (project.id !== req.params.id) return reply.code(400).send({ error: 'The id does not match' });
      const saved = store.save(project, req.body.baseRevision ?? null, req.body.author ?? 'studio');
      if (!saved) return reply.code(409).send({ error: 'Changed elsewhere', current: store.get(project.id) });
      // other open studios with this song learn it changed
      live.tell({ type: 'saved', project: saved.id, revision: saved.revision });
      return { revision: saved.revision, modified: saved.modified };
    },
  );

  app.delete<{ Params: { id: string } }>('/api/projects/:id', async (req, reply) => {
    if (!store.remove(req.params.id)) return reply.code(404).send({ error: 'No such project' });
    // its recordings go with it
    rmSync(audioDir(req.params.id), { recursive: true, force: true });
    return { ok: true };
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/history', async (req) => store.history(req.params.id));
  app.get<{ Params: { id: string; rev: string } }>('/api/projects/:id/history/:rev', async (req, reply) => {
    return store.revision(req.params.id, Number(req.params.rev)) ?? reply.code(404).send({ error: 'No such revision' });
  });

  /** Readable text for the AI and the command line. */
  app.get<{ Params: { id: string }; Querystring: { track?: string; from?: string; to?: string; middleC?: string } }>(
    '/api/projects/:id/describe',
    async (req, reply) => {
      const project = store.get(req.params.id);
      if (!project) return reply.code(404).send({ error: 'No such project' });
      reply.type('text/plain; charset=utf-8');
      const middleC = (req.query.middleC ?? store.setting('middleC') ?? 'C3') === 'C4' ? 'C4' : 'C3';
      if (!req.query.track) return describeProject(project);
      const track = findTrack(project, req.query.track);
      if (!track) return reply.code(404).send(`No track "${req.query.track}"`);
      const from = req.query.from ? parsePosition(project.meter, req.query.from) : 0;
      const to = req.query.to ? parsePosition(project.meter, req.query.to) : Number.POSITIVE_INFINITY;
      return describeNotes(project, track, { from, to, middleC });
    },
  );

  /**
   * Changes from the AI or the command line. If a studio has the song open, it applies them (as a
   * step you can undo) and saves; otherwise they're applied here.
   */
  app.post<{ Params: { id: string }; Body: { ops: Op[]; author?: string; label?: string } }>(
    '/api/projects/:id/ops',
    async (req, reply) => {
      const { ops, author = 'AI', label = 'Changes' } = req.body;
      if (!Array.isArray(ops) || ops.length === 0) return reply.code(400).send({ error: 'No operations' });
      const editor = live.editor(req.params.id);
      if (editor) {
        const answer = await live.request(editor, { type: 'ops', project: req.params.id, ops, author, label });
        if (answer.ok) return { via: 'studio', revision: answer.revision };
        return reply.code(400).send({ error: answer.error ?? 'The studio refused the change' });
      }
      const project = store.get(req.params.id);
      if (!project) return reply.code(404).send({ error: 'No such project' });
      const next = applyOps(project, ops);
      const saved = store.save(next, project.revision, author);
      if (!saved) return reply.code(409).send({ error: 'Changed while applying; try again' });
      // a studio with this song open (but not answering just now) catches up
      live.tell({ type: 'saved', project: saved.id, revision: saved.revision });
      return { via: 'server', revision: saved.revision };
    },
  );

  // ---- MIDI files ----

  app.addContentTypeParser(
    ['audio/midi', 'audio/x-midi', 'application/octet-stream'],
    { parseAs: 'buffer' },
    (_r, body, done) => done(null, body),
  );

  app.post<{ Querystring: { title?: string } }>('/api/import/midi', async (req, reply) => {
    const body = req.body as Buffer;
    const project = projectFromMidi(readMidi(new Uint8Array(body)), req.query.title ?? 'Imported');
    const saved = store.save(project, null, 'import');
    return reply.code(201).send(saved);
  });

  app.get<{ Params: { id: string } }>('/api/projects/:id/midi', async (req, reply) => {
    const project = store.get(req.params.id);
    if (!project) return reply.code(404).send({ error: 'No such project' });
    const name = project.title.replace(/[^\w\- ]+/g, '').trim() || 'song';
    return reply
      .type('audio/midi')
      .header('content-disposition', `attachment; filename="${name}.mid"`)
      .send(Buffer.from(writeMidi(project)));
  });

  // ---- sample packs ----

  app.get('/api/packs', async () => packs.summaries());
  app.post('/api/packs/rescan', async () => {
    packs.scan();
    return packs.summaries();
  });
  // your own pack, uploaded as a ZIP (SFZ instruments, or folders of samples named by note)
  app.addContentTypeParser(['application/zip', 'application/x-zip-compressed'], (_req, payload, done) =>
    done(null, payload),
  );
  app.post<{ Querystring: { name?: string; license?: string } }>('/api/packs/import', async (req, reply) => {
    const work = mkdtempSync(join(tmpdir(), 'holo-upload-'));
    try {
      const zip = join(work, 'pack.zip');
      await saveStream(req.body as NodeJS.ReadableStream, zip);
      const unpacked = join(work, 'unpacked');
      extractZip(zip, unpacked);
      const pack = importFolder(unpacked, join(config.dataDir, 'packs'), {
        name: req.query.name?.trim() || 'Imported pack',
        ...(req.query.license ? { license: req.query.license } : {}),
      });
      packs.scan();
      return reply.code(201).send({ id: pack.id, name: pack.name, instruments: pack.instruments.map((i) => i.title) });
    } catch (err) {
      return reply.code(400).send({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  /**
   * A file sent from disk, with its length, a tag and a date for the browser to check it by, and
   * ranges (what the static plugin does for the studio's own files: see below).
   */
  const sendFile = (reply: FastifyReply, path: string, type: string, cacheControl: string) =>
    reply
      .type(type)
      .header('cache-control', cacheControl)
      .sendFile(basename(path), dirname(path), { contentType: false });
  // a sample is kept a week, then checked: a pack can be brought up to date in place
  const SAMPLE_CACHE = 'public, max-age=604800';

  app.get<{ Params: { pack: string; name: string } }>('/api/packs/:pack/instruments/:name', async (req, reply) => {
    const instrument = packs.instrument(req.params.pack, req.params.name);
    if (!instrument) return reply.code(404).send({ error: 'No such instrument' });
    // tagged by its content, so a studio that has it already gets a short answer and no body
    const body = JSON.stringify(instrument);
    const etag = `W/"${createHash('sha256').update(body).digest('base64url').slice(0, 16)}"`;
    reply.header('etag', etag).header('cache-control', 'no-cache');
    if (req.headers['if-none-match'] === etag) return reply.code(304).send();
    return reply.type('application/json; charset=utf-8').send(body);
  });
  app.get<{ Params: { pack: string; name: string } }>('/api/packs/:pack/impulses/:name', async (req, reply) => {
    const path = packs.impulse(req.params.pack, req.params.name);
    if (!path) return reply.code(404).send({ error: 'No such impulse response' });
    return sendFile(reply, path, 'audio/wav', SAMPLE_CACHE);
  });
  app.get<{ Params: { pack: string; '*': string } }>('/packs/:pack/files/*', async (req, reply) => {
    const path = packs.file(req.params.pack, req.params['*']);
    if (!path) return reply.code(404).send({ error: 'No such file' });
    const type = path.endsWith('.flac') ? 'audio/flac' : path.endsWith('.ogg') ? 'audio/ogg' : 'audio/wav';
    return sendFile(reply, path, type, SAMPLE_CACHE);
  });

  // ---- creations ----

  app.get('/api/creations', async () => {
    const list = creations.list();
    return list.map((c) => ({
      ...c,
      // an experience's songs build with its pinned engine: how that stands to the studio's
      engine: c.engine
        ? {
            label: engineLabel(c.engine),
            commit: c.engine.commit,
            date: c.engine.date,
            node: c.engine.node,
            relation: engineRelation(c.engine, studio),
            studio: engineLabel(studio),
            studioDate: studio.date,
          }
        : null,
      pieces: c.pieces.map((p) => ({ ...p, project: store.findByOrigin(c.name, p.piece)?.id ?? null })),
    }));
  });

  /** A new song for an experience: in the studio, and its file in the experience at once. */
  app.post<{ Params: { name: string }; Body: { title?: string; piece?: string } }>(
    '/api/creations/:name/songs',
    async (req, reply) => {
      const title = req.body?.title?.trim() || 'Untitled';
      const piece = creations.freePiece(req.params.name, title, req.body?.piece);
      const project = newProject(title);
      project.origin = { creation: req.params.name, piece, exportedAt: new Date().toISOString() };
      const saved = store.save({ ...project, revision: 0 }, null, 'studio');
      if (!saved) return reply.code(500).send({ error: 'The song could not be saved' });
      return reply.code(201).send({ project: saved, path: creations.write(saved) });
    },
  );

  /** Bring a piece in from its creation: a new project, or the linked one brought up to date. */
  app.post<{ Params: { name: string; piece: string }; Body: { mode?: 'new' | 'replace' } }>(
    '/api/creations/:name/pieces/:piece/open',
    async (req) => {
      const incoming = creations.read(req.params.name, req.params.piece);
      const existing = store.findByOrigin(req.params.name, req.params.piece);
      // the piece's own audio files come in with it
      const bringAudio = (id: string) => {
        for (const file of creations.audioFiles(req.params.name, req.params.piece)) {
          const to = join(audioDir(id), basename(file));
          if (existsSync(to)) continue;
          mkdirSync(audioDir(id), { recursive: true });
          copyFileSync(file, to);
        }
      };
      if (existing && req.body?.mode !== 'new') {
        const current = store.get(existing.id) as Project;
        bringAudio(existing.id);
        const saved = store.save({ ...incoming, id: existing.id, created: current.created }, null, req.params.name);
        live.tell({ type: 'saved', project: existing.id, revision: saved?.revision ?? 0 });
        return saved;
      }
      const id = newId('prj');
      bringAudio(id);
      const saved = store.save({ ...incoming, id, revision: 0 }, null, req.params.name);
      return saved;
    },
  );

  /**
   * Send a song back to the creation it came from; or, given an experience (`creation`), make one of
   * your songs its own and send it there.
   */
  app.post<{ Params: { id: string }; Body: { creation?: string; piece?: string } | null }>(
    '/api/projects/:id/send',
    async (req, reply) => {
      let project = store.get(req.params.id);
      if (!project) return reply.code(404).send({ error: 'No such project' });
      const to = req.body?.creation;
      if (to && project.origin && project.origin.creation !== to)
        return reply.code(409).send({ error: `This song belongs to ${project.origin.creation} already` });
      if (to && !project.origin) {
        const piece = creations.freePiece(to, project.title, req.body?.piece);
        const adopted = store.save(
          { ...project, origin: { creation: to, piece, exportedAt: new Date().toISOString() } },
          project.revision,
          'studio',
        );
        if (!adopted) return reply.code(409).send({ error: 'Changed elsewhere: try again' });
        live.tell({ type: 'saved', project: adopted.id, revision: adopted.revision });
        project = adopted;
      }
      const path = creations.write(project, audioDir(project.id));
      return {
        ok: true,
        path,
        edited: project.tracks.filter((t) => t.origin?.edited).map((t) => t.name),
      };
    },
  );

  /**
   * The creation renders the song itself (the game's own sound of it, edits and all), on the host,
   * through the creation runner; the result comes back as an audio track.
   */
  app.post<{ Params: { id: string } }>('/api/projects/:id/render', async (req, reply) => {
    const project = store.get(req.params.id);
    if (!project) return reply.code(404).send({ error: 'No such project' });
    const origin = project.origin;
    if (!origin) return reply.code(400).send({ error: 'This song did not come from a creation' });
    const creation = creations.renderable(origin.creation);
    if (!creation) {
      return reply
        .code(400)
        .send({ error: `${origin.creation} doesn't say how to render (no "render" in its holo.creation.json)` });
    }
    if (!live.runner()) {
      return reply.code(409).send({
        error: 'No creation runner is running. Start one on the computer that has the creation: pnpm runner',
      });
    }
    const running = [...live.renders.values()].find(
      (j) => j.project === project.id && (j.state === 'waiting' || j.state === 'running'),
    );
    if (running) return { ok: true, id: running.id, already: true };
    const job: RenderJob = {
      id: newId('rnd'),
      project: project.id,
      creation: origin.creation,
      piece: origin.piece,
      title: creation.title,
      state: 'waiting',
      started: Date.now(),
      finished: null,
      lines: [],
      error: null,
    };
    live.render(job);
    return { ok: true, id: job.id };
  });

  app.get<{ Params: { id: string } }>('/api/renders/:id', async (req, reply) => {
    const job = live.renders.get(req.params.id);
    return job ?? reply.code(404).send({ error: 'No such render' });
  });

  /** What the renderer reads: the song as its session file, as saved now. */
  app.get<{ Params: { id: string } }>('/api/renders/:id/session', async (req, reply) => {
    const job = live.renders.get(req.params.id);
    const project = job ? store.get(job.project) : null;
    if (!job || !project) return reply.code(404).send({ error: 'No such render' });
    return reply.type('application/json').send(sessionText(project));
  });

  // ---- audio files: recordings and imported audio, kept with their song ----

  app.addContentTypeParser('application/x-holo-audio', (_req, payload, done) => done(null, payload));
  const audioDir = (id: string) => join(config.dataDir, 'audio', id.replace(/[^\w-]/g, ''));
  const AUDIO_EXT: Record<string, string> = {
    '.wav': 'audio/wav',
    '.flac': 'audio/flac',
    '.mp3': 'audio/mpeg',
    '.ogg': 'audio/ogg',
    '.m4a': 'audio/mp4',
    '.aac': 'audio/aac',
    '.aif': 'audio/aiff',
    '.aiff': 'audio/aiff',
  };

  app.post<{ Params: { id: string }; Querystring: { name?: string } }>(
    '/api/projects/:id/files',
    // long recordings and a creation's renders are big (lossless, 32-bit float)
    { bodyLimit: 4 * 1024 ** 3 },
    async (req, reply) => {
      if (!store.get(req.params.id)) return reply.code(404).send({ error: 'No such project' });
      const name = (req.query.name ?? 'audio.wav').slice(0, 120);
      const ext = (/\.[a-z0-9]{2,5}$/i.exec(name)?.[0] ?? '.wav').toLowerCase();
      if (!AUDIO_EXT[ext])
        return reply.code(415).send({ error: `HO[LO] doesn't read ${ext} files: WAV, FLAC, MP3, OGG, M4A or AIFF` });
      const id = newId('aud');
      const path = join(audioDir(req.params.id), `${id}${ext}`);
      await saveStream(req.body as NodeJS.ReadableStream, path);
      // WAV and FLAC say how long they are (enough for the command line to place them)
      const info = ext === '.wav' || ext === '.flac' ? audioInfo(path) : null;
      return reply.code(201).send({
        id,
        name,
        ...(info?.frames ? { seconds: info.frames / info.rate, rate: info.rate, channels: info.channels } : {}),
      });
    },
  );

  app.get<{ Params: { id: string; file: string } }>('/api/projects/:id/files/:file', async (req, reply) => {
    const dir = audioDir(req.params.id);
    if (!/^aud_[a-z0-9]+$/.test(req.params.file) || !existsSync(dir))
      return reply.code(404).send({ error: 'No such file' });
    const found = readdirSync(dir).find((f) => f.startsWith(`${req.params.file}.`));
    if (!found) return reply.code(404).send({ error: 'No such file' });
    const ext = found.slice(found.lastIndexOf('.'));
    return sendFile(
      reply,
      join(dir, found),
      AUDIO_EXT[ext] ?? 'application/octet-stream',
      'private, max-age=31536000, immutable',
    );
  });

  // ---- bounces: songs rendered to WAV by the studio, kept with the song ----

  app.addContentTypeParser(['audio/wav', 'audio/x-wav'], (_req, payload, done) => done(null, payload));
  const bounceDir = (id: string) => join(config.dataDir, 'bounces', id.replace(/[^\w-]/g, ''));
  const SAFE_FILE = /^[\w .()'-]+\.wav$/;

  app.post<{ Params: { id: string }; Querystring: { name?: string } }>(
    '/api/projects/:id/bounces',
    async (req, reply) => {
      const project = store.get(req.params.id);
      if (!project) return reply.code(404).send({ error: 'No such project' });
      const stamp = new Date().toISOString().replace('T', ' ').replace(/:/g, '.').slice(0, 19);
      const title =
        (req.query.name ?? project.title)
          .replace(/[^\w .()'-]+/g, '')
          .trim()
          .slice(0, 80) || 'Bounce';
      const file = `${stamp} ${title}.wav`;
      await saveStream(req.body as NodeJS.ReadableStream, join(bounceDir(project.id), file));
      return reply.code(201).send({
        file,
        url: `/api/projects/${project.id}/bounces/${encodeURIComponent(file)}`,
        path: `bounces/${project.id}/${file}`,
      });
    },
  );

  app.get<{ Params: { id: string } }>('/api/projects/:id/bounces', async (req) => {
    const dir = bounceDir(req.params.id);
    if (!existsSync(dir)) return [];
    return readdirSync(dir)
      .filter((f) => SAFE_FILE.test(f))
      .map((f) => ({
        file: f,
        bytes: statSync(join(dir, f)).size,
        url: `/api/projects/${req.params.id}/bounces/${encodeURIComponent(f)}`,
      }))
      .sort((a, b) => b.file.localeCompare(a.file));
  });

  app.get<{ Params: { id: string; file: string } }>('/api/projects/:id/bounces/:file', async (req, reply) => {
    const file = req.params.file;
    const path = join(bounceDir(req.params.id), file);
    if (!SAFE_FILE.test(file) || !existsSync(path)) return reply.code(404).send({ error: 'No such bounce' });
    reply.header('content-disposition', `attachment; filename="${file}"`);
    return sendFile(reply, path, 'audio/wav', 'no-cache');
  });

  // ---- the live channel, from the command line ----

  app.post('/api/live/bounce', async (_req, reply) => {
    const editor = live.editor();
    if (!editor) return reply.code(409).send({ error: 'No studio is open: bouncing happens in the studio' });
    return live.request(editor, { type: 'bounce' }, 20 * 60 * 1000);
  });

  app.get('/api/live/state', async () => live.state());

  app.post<{ Body: Record<string, unknown> }>('/api/live/transport', async (req, reply) => {
    const editor = live.editor();
    if (!editor) return reply.code(409).send({ error: 'No studio is open' });
    return live.request(editor, { type: 'transport', ...req.body });
  });

  app.post<{ Body: { events: number[][]; track?: string; port?: string } }>('/api/live/midi', async (req, reply) => {
    const n = live.tell({
      type: 'play-notes',
      events: req.body.events,
      track: req.body.track ?? null,
      port: req.body.port ?? 'AI',
    });
    return n ? { ok: true } : reply.code(409).send({ error: 'No studio is open' });
  });

  app.post<{ Body: { project: string } }>('/api/live/open', async (req, reply) => {
    const editor = live.editor();
    if (!editor) return reply.code(409).send({ error: 'No studio is open' });
    return live.request(editor, { type: 'open', project: req.body.project });
  });

  app.get<{ Querystring: { seconds?: string } }>('/api/live/listen', async (req, reply) => {
    if (!live.editor()) return reply.code(409).send({ error: 'No studio is open' });
    const seconds = Math.min(120, Math.max(1, Number(req.query.seconds ?? 8)));
    return { seconds, notes: await live.listen(seconds * 1000) };
  });

  // ---- the studio itself (and, through its sendFile, the files sent from disk above) ----

  const webDir = existsSync(config.webDir) ? config.webDir : null;
  await app.register(fastifyStatic, {
    ...(webDir ? { root: webDir } : { serve: false }),
    wildcard: false,
    // the build writes .br and .gz beside its files: the browser gets whichever it takes
    preCompressed: true,
    cacheControl: false,
    setHeaders(reply, path) {
      // the studio's hashed files never change; the page and the manifests are checked each time
      if (webDir && path.startsWith(webDir))
        reply.header('cache-control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
    },
  });
  if (webDir) {
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api') && !req.url.startsWith('/packs')) {
        return reply.header('cache-control', 'no-cache').sendFile('index.html');
      }
      return reply.code(404).send({ error: 'Not found' });
    });
  }

  // ---- network MIDI (an iPhone's USB keyboard, a Mac's network session) ----

  let networkMidi: NetworkMidi | null = null;
  let networkMidiError: string | null = null;
  if (config.networkMidi) {
    networkMidi = new NetworkMidi({
      ...config.networkMidi,
      name: 'HO[LO] Desk',
      onMidi: (from, data) => live.networkMidi(from, data),
      log: (line) => app.log.info(line),
    });
    try {
      await networkMidi.listen();
    } catch (err) {
      networkMidiError = err instanceof Error ? err.message : String(err);
      app.log.error(`network MIDI couldn't start: ${networkMidiError}`);
      networkMidi = null;
    }
  }
  app.get('/api/network-midi', async () => ({
    on: networkMidi !== null,
    port: config.networkMidi?.port ?? 5004,
    // in Docker, where the ports are published ("127.0.0.1": this machine only)
    reach: process.env.HOLO_NETWORK_MIDI_REACH ?? null,
    error: networkMidiError,
    sessions: (networkMidi?.list() ?? []).map((s) => ({
      name: s.name,
      since: s.since,
      seen: s.seen,
      messages: s.messages,
    })),
  }));

  app.addHook('onClose', async () => {
    networkMidi?.close();
    store.close();
  });
  return { app, services: { store, packs, live, creations } };
}
