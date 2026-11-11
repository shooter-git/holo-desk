/**
 * The recognition engines, as a second reader of scanned pages (optional: `pnpm omr on` starts their
 * container, which the server reaches at HOLO_OMR_URL on a network with no way out). Their readings
 * are kept beside the scan; where they differ from the bars written into the song, the systems are
 * flagged, for you or the agent to look at. With no agent to read a scan in, the studio reads it in
 * from those readings: the systems not read yet, as one change to the song.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  compareReading,
  engineReadingOps,
  type PageReading,
  readScanWithEngines,
  type Scan,
  type SystemState,
} from '@holo/score';
import type { Op, Project } from '@holo/session';
import type { FastifyInstance } from 'fastify';

export interface OmrOptions {
  url: string | null;
  dataDir: string;
  scan: (id: string) => Scan | null;
  save: (scan: Scan) => void;
  project: (id: string) => Project | null;
}

interface Reading {
  engine: string;
  musicxml?: string;
  error?: string;
}

const PAGE_MS = 6 * 60 * 1000;
/** An engine's reading of a page, as it's kept: `<page>-<engine>.musicxml`. */
const KEPT = /^(\d{1,3})-([a-z]{2,20})\.musicxml$/;

/**
 * The engines' reading of a scan as a change to its song (`GET /api/scans/:id/engines/reading`). The
 * studio applies `ops` as one undo step labelled `label`, and only then sets each system as `systems`
 * says (through `PATCH /api/scans/:id/systems/:page/:system`): this route changes nothing.
 */
export interface EngineReadingAnswer {
  ops: Op[];
  label: string;
  /** The song's saved revision it was worked out from. */
  revision: number;
  /** How far each system not read yet got: read, or still new with what was refused flagged. */
  systems: { page: number; system: number; state: SystemState; written?: [number, number]; flags?: string[] }[];
  /** Each page read: the engine used, and the others that read it. */
  pages: { page: number; engine: string; others: string[] }[];
  /** Bar numbers written, bars refused (with why), and what couldn't be read. */
  written: number[];
  errors: string[];
  warnings: string[];
}

export function omrRoutes(app: FastifyInstance, opts: OmrOptions): void {
  /** The engines' readings kept beside a scan, page by page. */
  const kept = (scan: Scan): PageReading[] => {
    const dir = join(opts.dataDir, 'scans', scan.id, 'engines');
    if (!existsSync(dir)) return [];
    const out: PageReading[] = [];
    for (const file of readdirSync(dir).sort()) {
      const m = KEPT.exec(file);
      if (!m) continue;
      try {
        out.push({ page: Number(m[1]), engine: m[2] as string, musicxml: readFileSync(join(dir, file), 'utf8') });
      } catch {
        // gone meanwhile
      }
    }
    return out;
  };

  const health = async (): Promise<{ available: boolean; engines: string[] }> => {
    if (!opts.url) return { available: false, engines: [] };
    try {
      const res = await fetch(`${opts.url}/health`, { signal: AbortSignal.timeout(2000) });
      const body = (await res.json()) as { engines?: string[] };
      return { available: res.ok, engines: body.engines ?? [] };
    } catch {
      return { available: false, engines: [] };
    }
  };

  app.get('/api/omr', async () => health());

  app.post<{ Params: { id: string } }>('/api/scans/:id/engines', async (req, reply) => {
    const scan = opts.scan(req.params.id);
    if (!scan) return reply.code(404).send({ error: 'No such scan' });
    const status = await health();
    if (!status.available || !opts.url) {
      return reply.code(409).send({ error: 'The recognition engines aren’t running (pnpm omr on)' });
    }
    const project = opts.project(scan.project);
    if (!project) return reply.code(404).send({ error: 'The scan’s song is gone' });
    const dir = join(opts.dataDir, 'scans', scan.id);
    mkdirSync(join(dir, 'engines'), { recursive: true });
    const flags = new Map<string, string[]>();
    const summary: string[] = [];
    for (const page of scan.pages) {
      const file = existsSync(join(dir, 'pages'))
        ? readdirSync(join(dir, 'pages')).find((f) => f.startsWith(`${page.n}.`))
        : undefined;
      if (!file) continue;
      const type = file.endsWith('.jpeg') ? 'image/jpeg' : file.endsWith('.webp') ? 'image/webp' : 'image/png';
      let readings: Reading[] = [];
      try {
        const res = await fetch(`${opts.url}/read`, {
          method: 'POST',
          headers: { 'content-type': type },
          body: readFileSync(join(dir, 'pages', file)),
          signal: AbortSignal.timeout(PAGE_MS),
        });
        readings = ((await res.json()) as { readings?: Reading[] }).readings ?? [];
      } catch (e) {
        summary.push(`page ${page.n + 1}: the engines didn't answer (${e instanceof Error ? e.message : String(e)})`);
        continue;
      }
      for (const r of readings) {
        if (!/^[a-z]{2,20}$/.test(r.engine)) continue;
        if (!r.musicxml) {
          summary.push(
            `page ${page.n + 1}: ${r.engine} couldn't read it${r.error ? ` (${r.error.slice(0, 120)})` : ''}`,
          );
          continue;
        }
        writeFileSync(join(dir, 'engines', `${page.n}-${r.engine}.musicxml`), r.musicxml);
        for (const [k, list] of compareReading(project, page, r.musicxml, r.engine)) {
          flags.set(`${page.n}.${k}`, [...(flags.get(`${page.n}.${k}`) ?? []), ...list]);
        }
        summary.push(`page ${page.n + 1}: ${r.engine} read it`);
      }
    }
    // the engines' flags replace their earlier ones; the rest stay
    const engine = (f: string) => /^[a-z]+:? (reads|found|couldn't)/.test(f);
    const next: Scan = {
      ...scan,
      pages: scan.pages.map((p) => ({
        ...p,
        systems: p.systems.map((s) => {
          const kept = (s.flags ?? []).filter((f) => !engine(f));
          const all = [...kept, ...(flags.get(`${p.n}.${s.k}`) ?? [])];
          const out = { ...s, flags: all };
          if (!all.length) delete (out as { flags?: string[] }).flags;
          return out;
        }),
      })),
    };
    opts.save(next);
    return { summary, flagged: [...flags.values()].reduce((n, l) => n + l.length, 0) };
  });

  // the engines' reading of the systems not read yet, worked out from the song as it was last saved
  // (the studio saves first): the studio applies it, then marks the systems
  app.get<{ Params: { id: string } }>('/api/scans/:id/engines/reading', async (req, reply) => {
    const scan = opts.scan(req.params.id);
    if (!scan) return reply.code(404).send({ error: 'No such scan' });
    const project = opts.project(scan.project);
    if (!project) return reply.code(404).send({ error: 'The scan’s song is gone' });
    const answer: EngineReadingAnswer = {
      ops: [],
      label: '',
      revision: project.revision,
      systems: [],
      pages: [],
      written: [],
      errors: [],
      warnings: [],
    };
    const unread = scan.pages.filter((p) => p.systems.some((s) => s.state === 'new'));
    if (!unread.length) return answer;
    const readings = kept(scan);
    if (!unread.some((p) => readings.some((r) => r.page === p.n))) {
      return reply
        .code(409)
        .send({ error: 'The engines haven’t read this scan yet: run them first', reason: 'no-readings' });
    }
    const reading = readScanWithEngines(project, scan, readings);
    const write = engineReadingOps(project, scan, reading, readings);
    return {
      ...answer,
      ops: write.ops,
      label: write.label,
      systems: write.systems.map(({ page, k, ...rest }) => ({ page, system: k, ...rest })),
      pages: reading.pages,
      written: write.written,
      errors: write.errors,
      warnings: write.warnings,
    } satisfies EngineReadingAnswer;
  });
}
