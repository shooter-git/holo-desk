/**
 * The recognition engines, which read scanned pages into songs, and read them again as a second
 * reader. On by default: in Docker they're a container of their own on a network with no way out
 * (HOLO_OMR_URL, which the compose file sets); run without Docker, the server runs them itself in a
 * container with no network at all (omr-docker.ts). `pnpm omr off` turns them off. Their readings are
 * kept beside the scan; where they differ from the bars written into the song, the systems are flagged,
 * for you or the agent to look at. The studio reads a scan in from those readings: the systems not
 * read yet, as one change to the song.
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
import { dockerEngines } from './omr-docker.ts';

export interface OmrOptions {
  /** Where they answer (their container in Docker), or null. */
  url: string | null;
  /** Without an address: the image the server runs them from itself, or null (off). */
  image?: string | null;
  /** Off because the server runs in a container it wasn't given them for (not turned off). */
  unset?: boolean;
  dataDir: string;
  scan: (id: string) => Scan | null;
  save: (scan: Scan) => void;
  project: (id: string) => Project | null;
}

/** How long the engines may take over a page (both of them, one after the other). */
const PAGE_MS = 6 * 60 * 1000;
/** An engine's reading of a page, as it's kept: `<page>-<engine>.musicxml`. */
const KEPT = /^(\d{1,3})-([a-z]{2,20})\.musicxml$/;

/** An engine's reading of a page: its MusicXML, or why it has none. */
export interface Reading {
  engine: string;
  musicxml?: string;
  error?: string;
}

/**
 * Whether the engines are here to read (`GET /api/omr`), and which. When they aren't, why: being got
 * ready (the first start fetches them), turned off, no Docker to run them in, or not answering.
 */
export interface OmrStatus {
  available: boolean;
  engines: string[];
  why?: 'starting' | 'off' | 'no-docker' | 'unreachable';
  /** What went wrong, in the words of what failed. */
  detail?: string;
}

/** The engines, however they're reached: whether they're here, and a page read by each. */
export interface Engines {
  /** (Asking may start them: they say "starting" until they answer.) */
  status(): Promise<OmrStatus>;
  read(page: Buffer, type: string): Promise<Reading[]>;
  close?(): Promise<void>;
}

/** The engines' server at an address: their container, in Docker. */
export function urlEngines(url: string, pageMs = PAGE_MS): Engines {
  return {
    async status() {
      try {
        const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
        const body = (await res.json()) as { engines?: string[] };
        if (res.ok) return { available: true, engines: body.engines ?? [] };
        return { available: false, engines: [], why: 'unreachable', detail: `they answered ${res.status}` };
      } catch (e) {
        return {
          available: false,
          engines: [],
          why: 'unreachable',
          detail: e instanceof Error ? e.message : String(e),
        };
      }
    },
    async read(page, type) {
      const res = await fetch(`${url}/read`, {
        method: 'POST',
        headers: { 'content-type': type },
        body: page,
        signal: AbortSignal.timeout(pageMs),
      });
      return ((await res.json()) as { readings?: Reading[] }).readings ?? [];
    },
  };
}

/** Off: turned off, or (`unset`) a server in a container nobody gave their address. */
const off = (unset = false): Engines => ({
  status: async () => ({
    available: false,
    engines: [],
    why: 'off',
    ...(unset ? { detail: 'HO[LO] runs in a container here; give it HOLO_OMR_URL, their address' } : {}),
  }),
  read: async () => [],
});

/** Why the engines can't read now, as the studio says it to whoever pressed the button. */
export function unavailable(s: OmrStatus): string {
  if (s.why === 'starting') return 'The recognition engines are getting ready: try again in a moment';
  if (s.why === 'off' && s.detail) return `The recognition engines aren’t set up here: ${s.detail}`;
  if (s.why === 'off') return 'The recognition engines are turned off (pnpm omr on)';
  if (s.why === 'no-docker')
    return `The recognition engines need Docker where HO[LO] runs (${s.detail ?? 'none here'})`;
  return `The recognition engines aren’t answering${s.detail ? ` (${s.detail})` : ''}`;
}

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

export function omrRoutes(app: FastifyInstance, opts: OmrOptions): Engines {
  const engines = opts.url
    ? urlEngines(opts.url)
    : opts.image
      ? dockerEngines(opts.image, opts.dataDir)
      : off(opts.unset);

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

  app.get('/api/omr', async (): Promise<OmrStatus> => engines.status());

  app.post<{ Params: { id: string } }>('/api/scans/:id/engines', async (req, reply) => {
    const scan = opts.scan(req.params.id);
    if (!scan) return reply.code(404).send({ error: 'No such scan' });
    const status = await engines.status();
    if (!status.available) return reply.code(409).send({ error: unavailable(status), reason: status.why });
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
        readings = await engines.read(readFileSync(join(dir, 'pages', file)), type);
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

  return engines;
}
