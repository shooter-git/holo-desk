import { type ChildProcessWithoutNullStreams, spawn } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { applyOps, describeProject, newProject, type Op, type Project } from '@holo/session';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { fakeJobApi } from '../src/api.ts';
import { createServer as createMcp } from '../src/mcp.ts';
import { newMemory } from '../src/tools/common.ts';
import { TOOLS } from '../src/tools/index.ts';

const TOKEN = 'job-token-for-the-test';
const JOB = 'job_test1';
const mcp = resolve(import.meta.dirname, '../src/mcp.ts');
const work = mkdtempSync(join(tmpdir(), 'holo-mcp-test-'));
const tokenFile = join(work, '.holo-job');
writeFileSync(tokenFile, `${TOKEN}\n`, { mode: 0o600 });

/** A stand-in for HO[LO]'s job endpoints: the song, its description, ops, progress. */
let project: Project = newProject('MCP song');
const seen: { method: string; path: string; auth: string | undefined; body: unknown }[] = [];
let http: Server;
let base = '';

beforeAll(async () => {
  http = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => {
      raw += c;
    });
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      const path = req.url ?? '';
      seen.push({ method: req.method ?? '', path, auth: req.headers.authorization, body });
      const send = (status: number, value: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify(value));
      };
      if (req.headers.authorization !== `Bearer ${TOKEN}`) return send(403, { error: 'Not this job' });
      const prefix = `/api/agent/jobs/${JOB}`;
      if (!path.startsWith(prefix)) return send(404, { error: 'Not found' });
      const rest = path.slice(prefix.length);
      if (req.method === 'GET' && rest === '/song') return send(200, project);
      if (req.method === 'GET' && rest === '/describe') return send(200, { text: describeProject(project) });
      if (req.method === 'GET' && rest === '/state') return send(200, { playhead: 0, playing: false });
      if (req.method === 'POST' && rest === '/ops') {
        project = applyOps(project, (body as { ops: Op[] }).ops);
        return send(200, { ok: true, revision: 2 });
      }
      if (req.method === 'POST' && rest === '/progress') return send(200, { ok: true });
      if (req.method === 'POST' && rest === '/transport') return send(409, { error: 'The studio is closed' });
      return send(404, { error: 'Not found' });
    });
  });
  await new Promise<void>((ok) => http.listen(0, '127.0.0.1', ok));
  base = `http://127.0.0.1:${(http.address() as AddressInfo).port}`;
});

afterAll(() => {
  http?.close();
  rmSync(work, { recursive: true, force: true });
});

interface Running {
  child: ChildProcessWithoutNullStreams;
  lines: string[];
  stderr: string[];
  send(msg: unknown): void;
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  next(): Promise<Record<string, unknown>>;
  exited: Promise<number | null>;
}

let counter = 0;

function start(env: Record<string, string> = {}, nodeArgs: string[] = []): Running {
  const child = spawn(process.execPath, ['--disable-warning=ExperimentalWarning', ...nodeArgs, mcp], {
    env: {
      PATH: process.env.PATH ?? '',
      HOLO_URL: base,
      HOLO_JOB: JOB,
      HOLO_JOB_TOKEN_FILE: tokenFile,
      HOLO_MIDDLE_C: 'C4',
      ...env,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const lines: string[] = [];
  const stderr: string[] = [];
  const waiting: ((m: Record<string, unknown>) => void)[] = [];
  const unread: Record<string, unknown>[] = [];
  let buffer = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let i = buffer.indexOf('\n');
    while (i >= 0) {
      const line = buffer.slice(0, i);
      buffer = buffer.slice(i + 1);
      lines.push(line);
      const msg = JSON.parse(line) as Record<string, unknown>;
      const w = waiting.shift();
      if (w) w(msg);
      else unread.push(msg);
      i = buffer.indexOf('\n');
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (c: string) => stderr.push(c));
  const exited = new Promise<number | null>((ok) => child.on('exit', (code) => ok(code)));
  const next = () =>
    new Promise<Record<string, unknown>>((ok, fail) => {
      const m = unread.shift();
      if (m) return ok(m);
      const timer = setTimeout(() => fail(new Error(`no answer; stderr: ${stderr.join('')}`)), 10_000);
      waiting.push((msg) => {
        clearTimeout(timer);
        ok(msg);
      });
    });
  const send = (msg: unknown) => child.stdin.write(`${JSON.stringify(msg)}\n`);
  return {
    child,
    lines,
    stderr,
    send,
    next,
    exited,
    async request(method, params) {
      const id = ++counter;
      send({ jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) });
      const answer = await next();
      expect(answer.id).toBe(id);
      return answer;
    },
  };
}

type ToolInfo = { name: string; description: string; inputSchema: Record<string, unknown> };
type CallResult = { content: { type: string; text?: string }[]; isError?: boolean };

describe('the MCP server over stdio', () => {
  let server: Running;
  beforeAll(() => {
    server = start();
  });
  afterAll(() => {
    server.child.kill();
  });

  it('negotiates the protocol version', async () => {
    const a = await server.request('initialize', {
      protocolVersion: '2025-03-26',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    expect(a.result).toEqual({
      protocolVersion: '2025-03-26',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'holo', version: '0.7.4' },
    });
    const b = await server.request('initialize', { protocolVersion: '2099-01-01' });
    expect((b.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
    const c = await server.request('initialize', { protocolVersion: '2024-11-05' });
    expect((c.result as { protocolVersion: string }).protocolVersion).toBe('2024-11-05');
    // what Claude Code and Cursor ask for, and what Codex asks for
    const d = await server.request('initialize', { protocolVersion: '2025-11-25', capabilities: {} });
    expect((d.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
    const e = await server.request('initialize', { protocolVersion: '2025-06-18', capabilities: {} });
    expect((e.result as { protocolVersion: string }).protocolVersion).toBe('2025-06-18');
  });

  it("answers Claude's server/discover probe (a string id) as an unknown method, then initializes", async () => {
    server.send({ jsonrpc: '2.0', id: 'server-discover-probe-1', method: 'server/discover', params: {} });
    expect(await server.next()).toEqual({
      jsonrpc: '2.0',
      id: 'server-discover-probe-1',
      error: { code: -32601, message: 'Method not found: server/discover' },
    });
    server.send({ jsonrpc: '2.0', id: 'init-2', method: 'initialize', params: { protocolVersion: '2025-11-25' } });
    const init = await server.next();
    expect(init.id).toBe('init-2');
    expect((init.result as { protocolVersion: string }).protocolVersion).toBe('2025-11-25');
  });

  it('answers resources/* and prompts/* as unknown methods', async () => {
    for (const method of ['resources/read', 'resources/list', 'resources/templates/list', 'prompts/list']) {
      const a = await server.request(method, { uri: 'file:///etc/hostname' });
      expect(a.error).toEqual({ code: -32601, message: `Method not found: ${method}` });
    }
  });

  it("ignores _meta (Claude's progress token, Codex's turn metadata), in params or in the arguments", async () => {
    const a = await server.request('tools/call', {
      name: 'song_status',
      arguments: {},
      _meta: {
        progressToken: 7,
        'x-codex-turn-metadata': { sandbox_mode: 'read-only', model: 'm', reasoning_effort: 'low' },
      },
    });
    expect((a.result as CallResult).isError).toBeUndefined();
    const b = await server.request('tools/call', { name: 'song_status', arguments: { _meta: { progressToken: 8 } } });
    expect((b.result as CallResult).isError).toBeUndefined();
  });

  it('ignores notifications and answers ping', async () => {
    server.send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    server.send({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 1 } });
    // the next line out is ping's: the notifications got none
    const a = await server.request('ping');
    expect(a).toEqual({ jsonrpc: '2.0', id: a.id, result: {} });
  });

  it('lists at most 40 tools, named for MCP, each with a well-formed input schema', async () => {
    const a = await server.request('tools/list', {});
    const tools = (a.result as { tools: ToolInfo[] }).tools;
    expect(tools.length).toBeGreaterThan(30);
    expect(tools.length).toBeLessThanOrEqual(40);
    for (const t of tools) {
      expect(t.name).toMatch(/^[a-z][a-z0-9_]{0,40}$/);
      expect(t.description.length).toBeGreaterThan(40);
      const s = t.inputSchema as {
        type: string;
        properties: Record<string, { type?: string; description?: string; enum?: unknown[] }>;
        required?: string[];
        additionalProperties: boolean;
      };
      expect(s.type).toBe('object');
      expect(s.additionalProperties).toBe(false);
      expect(typeof s.properties).toBe('object');
      for (const r of s.required ?? []) expect(Object.keys(s.properties)).toContain(r);
      for (const [name, p] of Object.entries(s.properties)) {
        expect(typeof p.description, `${t.name}.${name}`).toBe('string');
        if (p.type !== undefined)
          expect(['string', 'number', 'integer', 'boolean', 'object', 'array']).toContain(p.type);
        if (p.enum) expect(p.enum.length).toBeGreaterThan(0);
      }
    }
    expect(tools.find((t) => t.name === 'notes_write')?.description).toContain('Middle C (MIDI 60) is C4');
  });

  it('calls a reading tool', async () => {
    const a = await server.request('tools/call', { name: 'song_show', arguments: {} });
    const result = a.result as CallResult;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toContain('"MCP song"');
    expect(seen.at(-1)).toMatchObject({
      method: 'GET',
      path: `/api/agent/jobs/${JOB}/describe`,
      auth: `Bearer ${TOKEN}`,
    });
  });

  it('calls a change tool: one ops batch with the token, then a progress line', async () => {
    const a = await server.request('tools/call', {
      name: 'notes_write',
      arguments: { track: 'Keys', at: '2', notes: 'C4:2 E4:2', velocity: '80' },
    });
    const result = a.result as CallResult;
    expect(result.isError).toBeUndefined();
    expect(result.content[0]?.text).toBe('Wrote 2 notes on Keys, bar 2.');
    const ops = seen.find((s) => s.path.endsWith('/ops'));
    expect(ops?.auth).toBe(`Bearer ${TOKEN}`);
    const body = ops?.body as { ops: Op[]; label: string; batch: string };
    expect(body.label).toBe('Wrote 2 notes on Keys, bar 2');
    expect(body.batch).toMatch(/^[0-9a-f-]{36}$/);
    expect(body.ops.map((o) => o.op)).toEqual(['addRegion']);
    for (let i = 0; i < 50 && !seen.some((s) => s.path.endsWith('/progress')); i++)
      await new Promise((ok) => setTimeout(ok, 20));
    expect(seen.find((s) => s.path.endsWith('/progress'))?.body).toEqual({ line: 'Wrote 2 notes on Keys, bar 2' });
  });

  it('answers bad arguments and failures as tool errors, with the reason', async () => {
    const bad = (await server.request('tools/call', { name: 'notes_write', arguments: { track: 'Keys', colour: 1 } }))
      .result as CallResult;
    expect(bad.isError).toBe(true);
    expect(bad.content[0]?.text).toContain('Unknown field "colour"');
    expect(bad.content[0]?.text).toContain('"at" is required');
    const wrong = (await server.request('tools/call', { name: 'notes_show', arguments: { track: 'Violin' } }))
      .result as CallResult;
    expect(wrong).toEqual({
      content: [{ type: 'text', text: 'No track "Violin". The tracks: "Keys"' }],
      isError: true,
    });
    // the server's own error message comes through
    const closed = (await server.request('tools/call', { name: 'transport', arguments: { action: 'stop' } }))
      .result as CallResult;
    expect(closed).toEqual({ content: [{ type: 'text', text: 'The studio is closed' }], isError: true });
  });

  it('answers an unknown tool, an unknown method and garbage as JSON-RPC errors', async () => {
    const tool = await server.request('tools/call', { name: 'rm_rf', arguments: {} });
    expect(tool.error).toMatchObject({ code: -32602 });
    const method = await server.request('resources/list', {});
    expect(method.error).toMatchObject({ code: -32601 });
    server.child.stdin.write('{not json\n');
    expect(await server.next()).toEqual({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  });

  it('writes nothing but JSON-RPC on stdout', () => {
    expect(server.lines.length).toBeGreaterThan(10);
    for (const line of server.lines) {
      const msg = JSON.parse(line) as Record<string, unknown>;
      expect(msg.jsonrpc).toBe('2.0');
      expect('result' in msg || 'error' in msg).toBe(true);
    }
    // the token never shows
    expect(server.lines.join('\n')).not.toContain(TOKEN);
    expect(server.stderr.join('')).not.toContain(TOKEN);
  });
});

describe('the MCP server starting and stopping', () => {
  it('exits cleanly when stdin closes', async () => {
    const s = start();
    const a = await s.request('ping');
    expect(a.result).toEqual({});
    s.child.stdin.end();
    expect(await s.exited).toBe(0);
  });

  it('sends whatever else is printed to stderr', async () => {
    const noisy = join(work, 'noisy.mjs');
    writeFileSync(
      noisy,
      "setTimeout(() => { console.log('noise'); console.dir({ a: 1 }); process.stdout.write('raw noise\\n'); }, 100);\n",
    );
    const s = start({}, ['--import', noisy]);
    await new Promise((ok) => setTimeout(ok, 300));
    expect((await s.request('ping')).result).toEqual({});
    s.child.stdin.end();
    expect(await s.exited).toBe(0);
    expect(s.lines.map((l) => JSON.parse(l).jsonrpc)).toEqual(['2.0']);
    expect(s.stderr.join('')).toContain('raw noise');
    expect(s.stderr.join('')).toContain('noise');
  });

  it('refuses to start without a job', async () => {
    const s = start({ HOLO_JOB: '' });
    expect(await s.exited).toBe(2);
    expect(s.stderr.join('')).toContain('HOLO_JOB');
    expect(s.lines).toEqual([]);
  });

  it('turns a refused token into a plain tool error', async () => {
    const other = join(work, 'other-token');
    writeFileSync(other, 'wrong');
    const s = start({ HOLO_JOB_TOKEN_FILE: other });
    const a = (await s.request('tools/call', { name: 'song_status', arguments: {} })).result as CallResult;
    expect(a).toEqual({ content: [{ type: 'text', text: 'Not this job' }], isError: true });
    s.child.stdin.end();
    expect(await s.exited).toBe(0);
  });
});

describe('the MCP server in process', () => {
  it('runs changes one at a time in the order called, and reading alongside', async () => {
    const api = fakeJobApi(newProject('Lock'));
    const order: string[] = [];
    const applied = api.ops.bind(api);
    let release: () => void = () => undefined;
    const gate = new Promise<void>((ok) => {
      release = ok;
    });
    api.ops = async (ops, label, batch) => {
      order.push(`start ${label}`);
      if (label.endsWith('bar 1')) await gate;
      const r = await applied(ops, label, batch);
      order.push(`end ${label}`);
      return r;
    };
    const server = createMcp({ tools: TOOLS, ctx: { api, middleC: 'C4', memory: newMemory() } });
    const ask = (id: number, name: string, args: unknown) =>
      server.handle(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }));
    const first = ask(1, 'notes_write', { track: 'Keys', at: '1', notes: 'C4:1' });
    const second = ask(2, 'notes_write', { track: 'Keys', at: '2', notes: 'E4:1' });
    // reading isn't held up by the change waiting on the studio
    const read = (await ask(3, 'song_show', {})) as { result: { content: { text: string }[] } };
    expect(read.result.content[0]?.text).toContain('"Lock"');
    await new Promise((ok) => setTimeout(ok, 20));
    expect(order).toEqual(['start Wrote 1 note on Keys, bar 1']);
    release();
    await Promise.all([first, second]);
    expect(order).toEqual([
      'start Wrote 1 note on Keys, bar 1',
      'end Wrote 1 note on Keys, bar 1',
      'start Wrote 1 note on Keys, bar 2',
      'end Wrote 1 note on Keys, bar 2',
    ]);
    // the second write read the song only once the first had been applied
    const methods = api.calls.map((c) => c.method);
    expect(methods.lastIndexOf('song')).toBeGreaterThan(methods.indexOf('ops'));
  });

  it('answers a batch of requests together', async () => {
    const server = createMcp({
      tools: TOOLS,
      ctx: { api: fakeJobApi(newProject('B')), middleC: 'C4', memory: newMemory() },
    });
    const answers = await server.handle(
      JSON.stringify([
        { jsonrpc: '2.0', id: 'a', method: 'ping' },
        { jsonrpc: '2.0', method: 'notifications/initialized' },
        { jsonrpc: '2.0', id: 'b', method: 'nope' },
      ]),
    );
    expect(answers).toEqual([
      { jsonrpc: '2.0', id: 'a', result: {} },
      { jsonrpc: '2.0', id: 'b', error: { code: -32601, message: 'Method not found: nope' } },
    ]);
  });
});
