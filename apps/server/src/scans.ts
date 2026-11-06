/**
 * Scans on the host: photographed or scanned pages of sheet music, kept beside their song in
 * `data/scans/<id>/` (the pages, a strip of each system, and `scan.json`). The studio prepares the
 * images (it straightens and cleans them, and finds the systems) and sends them here; the command
 * line (and the AI through it) reads them back to write the music into the song.
 */
import { randomBytes } from 'node:crypto';
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseScan, SCAN_ID, type Scan, type SystemState, scanProgress } from '@holo/score';
import type { FastifyInstance, FastifyReply } from 'fastify';

const TYPES: Record<string, 'png' | 'jpeg' | 'webp'> = {
  'image/png': 'png',
  'image/jpeg': 'jpeg',
  'image/webp': 'webp',
};
const MIME = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' } as const;
const INDEX = /^\d{1,3}$/;

export interface ScanOptions {
  dataDir: string;
  projectExists: (id: string) => boolean;
  /** Tell open studios a scan changed (the review shows it). */
  changed: (scan: Scan) => void;
}

export function scanRoutes(app: FastifyInstance, opts: ScanOptions): { removeFor: (project: string) => void } {
  const root = join(opts.dataDir, 'scans');
  const dir = (id: string) => join(root, id);
  const read = (id: string): Scan | null => {
    if (!SCAN_ID.test(id)) return null;
    try {
      return parseScan(JSON.parse(readFileSync(join(dir(id), 'scan.json'), 'utf8')));
    } catch {
      return null;
    }
  };
  const write = (scan: Scan) => {
    mkdirSync(dir(scan.id), { recursive: true });
    const path = join(dir(scan.id), 'scan.json');
    writeFileSync(`${path}.tmp`, JSON.stringify(scan, null, 1));
    renameSync(`${path}.tmp`, path);
    opts.changed(scan);
  };
  const all = (): Scan[] =>
    existsSync(root)
      ? readdirSync(root)
          .map(read)
          .filter((s): s is Scan => s !== null)
      : [];
  const image = (reply: FastifyReply, path: string, type: keyof typeof MIME) => {
    if (!existsSync(path)) return reply.code(404).send({ error: 'No such image' });
    return reply.type(MIME[type]).header('cache-control', 'no-cache').send(createReadStream(path));
  };

  app.addContentTypeParser(Object.keys(TYPES), { parseAs: 'buffer', bodyLimit: 40 * 1024 * 1024 }, (_r, body, done) =>
    done(null, body),
  );

  app.post<{ Body: { project?: string; track?: string; title?: string } }>('/api/scans', async (req, reply) => {
    const { project, track, title } = req.body ?? {};
    if (typeof project !== 'string' || !opts.projectExists(project))
      return reply.code(404).send({ error: 'No such project' });
    const scan: Scan = {
      id: `scn_${randomBytes(6).toString('hex')}`,
      project,
      title: typeof title === 'string' && title.trim() ? title.slice(0, 120) : 'Scan',
      created: new Date().toISOString(),
      pages: [],
    };
    if (typeof track === 'string') scan.track = track.slice(0, 64);
    write(scan);
    return reply.code(201).send(scan);
  });

  app.get<{ Querystring: { project?: string } }>('/api/scans', async (req) =>
    all()
      .filter((s) => !req.query.project || s.project === req.query.project)
      .sort((a, b) => b.created.localeCompare(a.created))
      .map((s) => ({
        id: s.id,
        title: s.title,
        project: s.project,
        created: s.created,
        pages: s.pages.length,
        progress: scanProgress(s),
      })),
  );

  app.get<{ Params: { id: string } }>(
    '/api/scans/:id',
    async (req, reply) => read(req.params.id) ?? reply.code(404).send({ error: 'No such scan' }),
  );

  // the whole record (the studio's, once it has found the systems)
  app.put<{ Params: { id: string } }>('/api/scans/:id', async (req, reply) => {
    const old = read(req.params.id);
    if (!old) return reply.code(404).send({ error: 'No such scan' });
    const scan = parseScan({ ...(req.body as object), id: old.id, project: old.project, created: old.created });
    if (!scan) return reply.code(400).send({ error: 'Not a scan' });
    write(scan);
    return scan;
  });

  // one system's progress: read, checked, approved; the bars it went into; what was flagged
  app.patch<{
    Params: { id: string; page: string; k: string };
    Body: { state?: SystemState; written?: [number, number]; flags?: string[] };
  }>('/api/scans/:id/systems/:page/:k', async (req, reply) => {
    const scan = read(req.params.id);
    const system = scan?.pages[Number(req.params.page)]?.systems[Number(req.params.k)];
    if (!scan || !system) return reply.code(404).send({ error: 'No such system' });
    const next = parseScan({
      ...scan,
      pages: scan.pages.map((p) => ({
        ...p,
        systems: p.systems.map((s) => (s === system ? { ...s, ...req.body } : s)),
      })),
    });
    if (!next) return reply.code(400).send({ error: 'Not a system' });
    write(next);
    return next.pages[Number(req.params.page)]?.systems[Number(req.params.k)];
  });

  app.put<{ Params: { id: string; n: string } }>('/api/scans/:id/pages/:n', async (req, reply) => {
    const type = TYPES[req.headers['content-type'] ?? ''];
    if (!read(req.params.id) || !INDEX.test(req.params.n) || !type)
      return reply.code(400).send({ error: 'Not a page image' });
    mkdirSync(join(dir(req.params.id), 'pages'), { recursive: true });
    writeFileSync(join(dir(req.params.id), 'pages', `${Number(req.params.n)}.${type}`), req.body as Buffer);
    return { ok: true };
  });

  app.put<{ Params: { id: string; n: string; k: string } }>('/api/scans/:id/strips/:n/:k', async (req, reply) => {
    const type = TYPES[req.headers['content-type'] ?? ''];
    if (!read(req.params.id) || !INDEX.test(req.params.n) || !INDEX.test(req.params.k) || !type) {
      return reply.code(400).send({ error: 'Not a strip image' });
    }
    mkdirSync(join(dir(req.params.id), 'strips'), { recursive: true });
    writeFileSync(
      join(dir(req.params.id), 'strips', `${Number(req.params.n)}-${Number(req.params.k)}.${type}`),
      req.body as Buffer,
    );
    return { ok: true };
  });

  const find = (folder: string, base: string): [string, keyof typeof MIME] | null => {
    for (const type of ['png', 'jpeg', 'webp'] as const) {
      const path = join(folder, `${base}.${type}`);
      if (existsSync(path)) return [path, type];
    }
    return null;
  };
  app.get<{ Params: { id: string; n: string } }>('/api/scans/:id/pages/:n', async (req, reply) => {
    if (!SCAN_ID.test(req.params.id) || !INDEX.test(req.params.n))
      return reply.code(404).send({ error: 'No such page' });
    const found = find(join(dir(req.params.id), 'pages'), String(Number(req.params.n)));
    return found ? image(reply, ...found) : reply.code(404).send({ error: 'No such page' });
  });
  app.get<{ Params: { id: string; n: string; k: string } }>('/api/scans/:id/strips/:n/:k', async (req, reply) => {
    if (!SCAN_ID.test(req.params.id) || !INDEX.test(req.params.n) || !INDEX.test(req.params.k)) {
      return reply.code(404).send({ error: 'No such strip' });
    }
    const found = find(join(dir(req.params.id), 'strips'), `${Number(req.params.n)}-${Number(req.params.k)}`);
    return found ? image(reply, ...found) : reply.code(404).send({ error: 'No such strip' });
  });

  app.delete<{ Params: { id: string } }>('/api/scans/:id', async (req, reply) => {
    if (!read(req.params.id)) return reply.code(404).send({ error: 'No such scan' });
    rmSync(dir(req.params.id), { recursive: true, force: true });
    return { ok: true };
  });

  return {
    // a song's scans go with it
    removeFor: (project: string) => {
      for (const s of all()) if (s.project === project) rmSync(dir(s.id), { recursive: true, force: true });
    },
  };
}
