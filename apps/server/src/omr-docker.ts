/**
 * The recognition engines run by the server itself, for a studio run without Docker (`pnpm start`,
 * `pnpm dev`) on a computer that has Docker: their image in a container of its own, with no network at
 * all (not even to this computer), started the first time a scan wants them and stopped with the
 * server. A page goes in and the readings come back through `docker exec`, to the engines' own server
 * inside the container; nothing else reaches it.
 *
 * The first start pulls the image (a few GB), so it takes a while; meanwhile the engines are
 * "starting". Without Docker, or when it fails, they say why, and try again a minute later.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import type { Engines, OmrStatus, Reading } from './omr.ts';

/** What a docker command did: its exit code (-1 when it couldn't run), what it wrote, and what it said. */
export interface Ran {
  code: number;
  out: Buffer;
  err: string;
  /** No docker command on this computer. */
  missing?: boolean;
}

export type Docker = (args: string[], opts: { input?: Buffer; timeout: number; signal?: AbortSignal }) => Promise<Ran>;

/** The docker command, run with `args`: `input` on its stdin, killed after `timeout` ms or when `signal` says. */
export const docker: Docker = (args, { input, timeout, signal }) =>
  new Promise((resolve) => {
    const out: Buffer[] = [];
    let err = '';
    let done = false;
    const finish = (r: Ran) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(r);
    };
    const child = spawn('docker', args, { stdio: ['pipe', 'pipe', 'pipe'], ...(signal ? { signal } : {}) });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeout);
    child.stdout.on('data', (b: Buffer) => out.push(b));
    child.stderr.on('data', (b: Buffer) => {
      err = (err + b.toString('utf8')).slice(-4000);
    });
    child.on('error', (e: NodeJS.ErrnoException) =>
      finish({ code: -1, out: Buffer.alloc(0), err: e.message, missing: e.code === 'ENOENT' }),
    );
    child.on('close', (code) => finish({ code: code ?? -1, out: Buffer.concat(out), err }));
    // (one that stops before reading it all mustn't take the server down)
    child.stdin.on('error', () => undefined);
    child.stdin.end(input);
  });

/**
 * Inside the container: a request to the engines' server (argv: the path, and for a page its type,
 * with the page on stdin), its answer written out as it came.
 */
const ASK = [
  'import sys, urllib.request',
  'path, kind = sys.argv[1], (sys.argv[2] if len(sys.argv) > 2 else None)',
  'req = urllib.request.Request("http://127.0.0.1:8070" + path, data=sys.stdin.buffer.read() if kind else None,',
  '                             headers={"content-type": kind} if kind else {})',
  'sys.stdout.buffer.write(urllib.request.urlopen(req, timeout=3600).read())',
].join('\n');

/** How long after failing to start they try again, and how often a running container is looked at. */
const RETRY_MS = 60_000;
const CHECK_MS = 30_000;
/** Pulling the image the first time (a few GB on a slow line). */
const PULL_MS = 60 * 60 * 1000;

type State =
  | { kind: 'idle' }
  | { kind: 'starting' }
  | { kind: 'ready'; engines: string[]; checked: number }
  | { kind: 'failed'; why: 'no-docker' | 'unreachable'; detail: string; at: number };

/** The last line someone would want to read of what a command said. */
const said = (text: string, otherwise: string) =>
  text
    .trim()
    .split('\n')
    .map((l) => l.trim())
    .filter(Boolean)
    .at(-1)
    ?.slice(0, 300) ?? otherwise;

/**
 * The engines in a container of the server's own, from `image`. One per data folder (two studios on one
 * computer each have their own), named for it so a server started again finds the one it left.
 */
export function dockerEngines(image: string, dataDir: string, run: Docker = docker, pageMs = 6 * 60_000): Engines {
  const name = `holo-omr-${createHash('sha256').update(dataDir).digest('hex').slice(0, 10)}`;
  let state: State = { kind: 'idle' };
  let starting: Promise<void> | null = null;
  let ours = false;
  let closed = false;
  // (what's under way when the server stops is stopped with it: a first pull, above all, which would
  // otherwise go on to start a container nobody removes)
  const stop = new AbortController();
  const { signal } = stop;

  const ask = async (path: string, timeout: number, page?: { data: Buffer; type: string }): Promise<unknown> => {
    const r = await run(['exec', '-i', name, 'python', '-c', ASK, path, ...(page ? [page.type] : [])], {
      input: page?.data,
      timeout,
      signal,
    });
    if (r.code !== 0) throw new Error(said(r.err, `docker exec ended with ${r.code}`));
    return JSON.parse(r.out.toString('utf8'));
  };

  const engines = async (timeout: number): Promise<string[]> => {
    const body = (await ask('/health', timeout)) as { engines?: unknown };
    return Array.isArray(body.engines) ? body.engines.filter((e): e is string => typeof e === 'string') : [];
  };

  const start = async (): Promise<void> => {
    const version = await run(['version', '--format', '{{.Server.Version}}'], { timeout: 20_000 });
    if (version.code !== 0) {
      state = {
        kind: 'failed',
        why: 'no-docker',
        detail: version.missing ? 'Docker isn’t installed' : said(version.err, 'Docker isn’t running'),
        at: Date.now(),
      };
      return;
    }
    const running = await run(['inspect', '--format', '{{.State.Running}}', name], { timeout: 20_000 });
    if (running.code !== 0 || running.out.toString('utf8').trim() !== 'true') {
      await run(['rm', '-f', name], { timeout: 30_000 });
      // (the first time, this pulls the image)
      const started = await run(
        ['run', '-d', '--rm', '--name', name, '--network', 'none', '--label', 'holo.omr=1', image],
        { timeout: PULL_MS, signal },
      );
      if (started.code !== 0) {
        state = { kind: 'failed', why: 'unreachable', detail: said(started.err, 'it didn’t start'), at: Date.now() };
        return;
      }
    }
    ours = true;
    // the server stopped while the image came: nothing's left running
    if (closed) {
      await run(['rm', '-f', name], { timeout: 10_000 });
      return;
    }
    // its server answers a few seconds after it starts
    let last = '';
    for (let i = 0; i < 40; i++) {
      try {
        state = { kind: 'ready', engines: await engines(10_000), checked: Date.now() };
        // a newer image, if there is one, for the next start (the one running stays)
        if (image.includes('/')) void run(['pull', '--quiet', image], { timeout: PULL_MS, signal });
        return;
      } catch (e) {
        last = e instanceof Error ? e.message : String(e);
        await new Promise((ok) => setTimeout(ok, 1000));
      }
    }
    state = { kind: 'failed', why: 'unreachable', detail: last || 'they didn’t answer', at: Date.now() };
  };

  const kick = () => {
    if (starting || closed) return;
    state = { kind: 'starting' };
    starting = start()
      .catch((e: unknown) => {
        state = {
          kind: 'failed',
          why: 'unreachable',
          detail: e instanceof Error ? e.message : String(e),
          at: Date.now(),
        };
      })
      .finally(() => {
        starting = null;
      });
  };

  return {
    async status(): Promise<OmrStatus> {
      if (state.kind === 'ready') {
        if (Date.now() - state.checked < CHECK_MS) return { available: true, engines: state.engines };
        try {
          state = { kind: 'ready', engines: await engines(10_000), checked: Date.now() };
          return { available: true, engines: state.engines };
        } catch {
          // gone (stopped by hand, Docker started again): start it again
          state = { kind: 'idle' };
        }
      }
      if (state.kind === 'failed' && Date.now() - state.at < RETRY_MS)
        return { available: false, engines: [], why: state.why, detail: state.detail };
      kick();
      return { available: false, engines: [], why: 'starting' };
    },
    async read(page: Buffer, type: string): Promise<Reading[]> {
      const body = (await ask('/read', pageMs, { data: page, type })) as { readings?: Reading[] };
      return body.readings ?? [];
    },
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      const starting = state.kind === 'starting';
      stop.abort();
      // (one stopped while it started may have got as far as making its container)
      if (ours || starting) await run(['rm', '-f', name], { timeout: 10_000 });
    },
  };
}
