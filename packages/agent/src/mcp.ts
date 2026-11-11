/**
 * HO[LO]'s MCP server for the in-app agent: JSON-RPC 2.0 over stdio, a message a line, written by
 * hand so it needs nothing beyond Node. The runner starts it as the harness's only tool server:
 *
 *     node --disable-warning=ExperimentalWarning packages/agent/src/mcp.ts
 *
 * with HOLO_URL (the server), HOLO_JOB (the job), HOLO_JOB_TOKEN_FILE (where the job token is; the
 * token itself is never in the environment or argv) and HOLO_MIDDLE_C ("C3" or "C4", the studio's
 * note naming).
 *
 * stdout carries JSON-RPC only: anything else printed goes to stderr. Changes run one at a time, in
 * the order they were called; reading runs alongside. It exits when stdin closes.
 */
import { readFileSync, realpathSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { format } from 'node:util';
import type { MiddleC } from '@holo/session';
import { ApiError, httpJobApi } from './api.ts';
import { check, toJsonSchema } from './args.ts';
import { describeTool, newMemory, type Tool, type ToolContext, ToolError, type ToolResult } from './tools/common.ts';
import { TOOLS } from './tools/index.ts';

/**
 * The protocol versions understood, newest first; a client asking for another gets the newest.
 * Claude Code and Cursor ask for 2025-11-25, Codex for 2025-06-18 (docs/agent-harnesses.md).
 */
export const PROTOCOL_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'] as const;

function packageVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version?: string };
    return pkg.version ?? '0.0.0';
  } catch {
    return '0.0.0';
  }
}

export const VERSION = packageVersion();

type Id = string | number | null;
type Message = Record<string, unknown>;

const PARSE_ERROR = -32700;
const INVALID_REQUEST = -32600;
const METHOD_NOT_FOUND = -32601;
const INVALID_PARAMS = -32602;

const reply = (id: Id, result: unknown): Message => ({ jsonrpc: '2.0', id, result });
const failure = (id: Id, code: number, message: string): Message => ({ jsonrpc: '2.0', id, error: { code, message } });

const isId = (v: unknown): v is Id => typeof v === 'string' || typeof v === 'number' || v === null;

export interface ServerOptions {
  tools: readonly Tool[];
  ctx: ToolContext;
  version?: string;
  /** Where the server's own notes go (stderr), never the protocol. */
  log?: (line: string) => void;
}

export interface Server {
  /** One line from the client: its answer, if it needs one (a notification gets none). */
  handle(line: string): Promise<Message | Message[] | null>;
}

/** A queue of one: each change starts when the one called before it has finished. */
function serial() {
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(fn, fn);
    chain = run.catch(() => undefined);
    return run;
  };
}

export function createServer(opts: ServerOptions): Server {
  const { tools, ctx } = opts;
  const log = opts.log ?? (() => undefined);
  const locked = serial();
  const byName = new Map(tools.map((t) => [t.name, t]));

  async function call(id: Id, params: Message): Promise<Message> {
    const name = params.name;
    if (typeof name !== 'string') return failure(id, INVALID_PARAMS, 'tools/call needs the tool\'s "name"');
    const tool = byName.get(name);
    if (!tool) return failure(id, INVALID_PARAMS, `Unknown tool: ${name}`);
    // _meta is the client's (a progress token, Codex's turn metadata): never one of the tool's arguments
    const given = params.arguments;
    const args =
      typeof given === 'object' && given !== null && !Array.isArray(given) && '_meta' in given
        ? Object.fromEntries(Object.entries(given).filter(([k]) => k !== '_meta'))
        : given;
    const checked = check(tool.args, args);
    if (!checked.ok) {
      return reply(id, {
        content: [{ type: 'text', text: `The arguments for ${name} aren't right:\n- ${checked.errors.join('\n- ')}` }],
        isError: true,
      });
    }
    const run = () => tool.run(ctx, checked.args);
    let result: ToolResult;
    try {
      // changes, and the turn's end, wait their turn; reading doesn't
      result = await (tool.kind === 'change' || tool.kind === 'ask' ? locked(run) : run());
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      // a mistake in the request is the model's to fix; anything else is worth a note for whoever looks
      if (!(err instanceof ToolError) && !(err instanceof ApiError))
        log(`${name}: ${err instanceof Error ? err.stack : message}`);
      return reply(id, { content: [{ type: 'text', text: message || `${name} failed` }], isError: true });
    }
    if (tool.kind === 'change' && result.progress) {
      ctx.api.progress(result.progress.slice(0, 200)).catch((err: unknown) => {
        log(`progress: ${err instanceof Error ? err.message : String(err)}`);
      });
    }
    return reply(id, {
      content: [
        { type: 'text', text: result.text },
        ...(result.images ?? []).map((i) => ({ type: 'image', data: i.data, mimeType: i.mime })),
      ],
    });
  }

  async function one(msg: unknown): Promise<Message | null> {
    if (typeof msg !== 'object' || msg === null || Array.isArray(msg))
      return failure(null, INVALID_REQUEST, 'Not a JSON-RPC message');
    const m = msg as Message;
    const hasId = 'id' in m;
    const id: Id = isId(m.id) ? m.id : null;
    if (m.jsonrpc !== '2.0' || (hasId && !isId(m.id)))
      return hasId ? failure(id, INVALID_REQUEST, 'Not JSON-RPC 2.0') : null;
    // an answer to something we never ask, or a notification: nothing to say
    if (typeof m.method !== 'string') return null;
    if (!hasId) return null;
    const params =
      typeof m.params === 'object' && m.params !== null && !Array.isArray(m.params) ? (m.params as Message) : {};
    switch (m.method) {
      case 'initialize': {
        const asked = params.protocolVersion;
        const protocolVersion = (PROTOCOL_VERSIONS as readonly unknown[]).includes(asked)
          ? asked
          : PROTOCOL_VERSIONS[0];
        return reply(id, {
          protocolVersion,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'holo', version: opts.version ?? VERSION },
        });
      }
      case 'ping':
        return reply(id, {});
      case 'tools/list':
        return reply(id, {
          tools: tools.map((t) => ({
            name: t.name,
            description: describeTool(t, ctx.middleC),
            inputSchema: toJsonSchema(t.args),
          })),
        });
      case 'tools/call':
        return call(id, params);
      // anything else (Claude's server/discover probe, resources/*, prompts/*) isn't offered
      default:
        return failure(id, METHOD_NOT_FOUND, `Method not found: ${m.method}`);
    }
  }

  return {
    async handle(line) {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return failure(null, PARSE_ERROR, 'Parse error');
      }
      if (Array.isArray(msg)) {
        if (!msg.length) return failure(null, INVALID_REQUEST, 'An empty batch');
        const answers = (await Promise.all(msg.map(one))).filter((a): a is Message => a !== null);
        return answers.length ? answers : null;
      }
      return one(msg);
    },
  };
}

/** Serve over a pair of streams until the input ends; answers in flight then get a moment to finish. */
export async function serveStdio(
  opts: ServerOptions & { input?: NodeJS.ReadableStream; write?: (text: string) => void },
): Promise<void> {
  const input = opts.input ?? process.stdin;
  const write = opts.write ?? ((text: string) => void process.stdout.write(text));
  const server = createServer(opts);
  const pending = new Set<Promise<void>>();
  const lines = createInterface({ input, crlfDelay: Number.POSITIVE_INFINITY });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const p: Promise<void> = server
      .handle(line)
      .then((answer) => {
        if (answer) write(`${JSON.stringify(answer)}\n`);
      })
      .catch((err: unknown) => opts.log?.(`internal: ${err instanceof Error ? err.stack : String(err)}`))
      .finally(() => pending.delete(p));
    pending.add(p);
  }
  await Promise.race([Promise.allSettled([...pending]), new Promise((ok) => setTimeout(ok, 2000).unref())]);
}

async function main(): Promise<void> {
  const err = (line: string) => process.stderr.write(`[holo mcp] ${line}\n`);
  // stdout is the protocol: only the answers are written to it. Whatever else is printed (console,
  // a library writing to stdout itself) goes to stderr, where the harness keeps it as a log.
  for (const k of ['log', 'info', 'warn', 'debug'] as const) {
    console[k] = (...a: unknown[]) => process.stderr.write(`${format(...a)}\n`);
  }
  const protocol = process.stdout.write.bind(process.stdout) as (text: string, done?: () => void) => boolean;
  process.stdout.write = ((chunk: unknown, ...rest: unknown[]) =>
    (process.stderr.write as (...a: unknown[]) => boolean)(chunk, ...rest)) as typeof process.stdout.write;
  process.stdout.on('error', () => process.exit(0));
  process.on('unhandledRejection', (e) => err(`unhandled: ${e instanceof Error ? e.message : String(e)}`));
  const base = process.env.HOLO_URL ?? `http://127.0.0.1:${process.env.HOLO_PORT ?? 47800}`;
  const job = process.env.HOLO_JOB;
  const tokenFile = process.env.HOLO_JOB_TOKEN_FILE;
  if (!job || !tokenFile) {
    err('HOLO_JOB and HOLO_JOB_TOKEN_FILE must be set: the runner starts this server for a job');
    process.exit(2);
  }
  // the studio names middle C C3 unless set otherwise, so that's what a missing setting means
  const middleC: MiddleC = process.env.HOLO_MIDDLE_C === 'C4' ? 'C4' : 'C3';
  let api: ToolContext['api'];
  try {
    api = httpJobApi(base, job, tokenFile);
  } catch (e) {
    err(`can't read the job token: ${e instanceof Error ? e.message : String(e)}`);
    process.exit(2);
  }
  // one memory for the run: a listen in parts is heard as one, and the last one is kept
  const ctx: ToolContext = { api, middleC, memory: newMemory() };
  await serveStdio({ tools: TOOLS, ctx, version: VERSION, log: err, write: (t) => void protocol(t) });
  protocol('', () => process.exit(0));
}

/** Run as a program (not imported by a test): node …/mcp.ts. */
function isEntry(): boolean {
  if ((import.meta as { main?: boolean }).main === true) return true;
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isEntry()) void main();
