/**
 * The recognition engines, as a second reader of scanned pages (optional: `pnpm omr on` starts their
 * container, which the server reaches at HOLO_OMR_URL on a network with no way out). Their readings
 * are kept beside the scan; where they differ from the bars written into the song, the systems are
 * flagged, for you or the AI to look at.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { compareReading, type Scan } from '@holo/score';
import type { Project } from '@holo/session';
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

export function omrRoutes(app: FastifyInstance, opts: OmrOptions): void {
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
}
