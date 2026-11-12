// Tool-count spike for the in-app agent: can each harness, sealed as HO[LO] Desk runs it, see and call
// MCP tools past 40? A dev tool, not part of the app. Findings: docs/agent-harnesses.md, "Tool count".
//
//   node tools/agent-spike-tools.mjs server
//       A stub MCP server on stdio with $HOLO_SPIKE_TOOLS (default 48) tools, tool_01…tool_NN. Each
//       answers `ok-NN-<nonce>`, the nonce new each time the server starts. Their descriptions and input
//       schemas are padded to the sizes of HO[LO]'s real tools (REAL_SIZES, cycled), so the tool list
//       weighs what HO[LO]'s would at that count. Logs every message to $HOLO_SPIKE_LOG.
//
//   node tools/agent-spike-tools.mjs sizes [--tools N]
//       Prints the size of the tool list served, next to HO[LO]'s real one (measured from
//       packages/agent/src/tools, the way mcp.ts lists them).
//
//   node tools/agent-spike-tools.mjs probe-codex [--tools N]
//       `codex debug prompt-input` with the run's settings and this server: the tools the model would
//       get, with no model call and an empty CODEX_HOME of its own (as the adapter's seal probe).
//
//   node tools/agent-spike-tools.mjs run <claude|codex|cursor> [--tools N] [--model m] [--effort e]
//       Runs the harness once, sealed with the adapters' own argv, environment and workspace files
//       (packages/agent/src/harness), in /tmp/holo-toolcount/<harness>-<N>, prompt on stdin, and asks it
//       to count the holo tools and call two of the last ones. Prints a summary built from the server's
//       log (what was really called and answered) and the stream. Two differences from a real run: no
//       agent instructions (AGENT.md would name tools that aren't there), and Codex runs `--ephemeral`
//       so nothing is saved to ~/.codex/sessions. Neither changes which tools reach the model.
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { appendFileSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const SELF = resolve(import.meta.filename);
const REPO = resolve(import.meta.dirname, '..');
const [command, ...rest] = process.argv.slice(2);

function option(args, name, fallback) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && i + 1 < args.length ? args[i + 1] : fallback;
}

// ---------------------------------------------------------------------------------------------------
// The tools.

// [description chars, inputSchema JSON chars] of HO[LO]'s 38 tools, in order (measured 2026-11-12 with
// describeTool(t, 'C4') and toJsonSchema(t.args); `sizes` measures them again).
const REAL_SIZES = [
  [318, 62],
  [311, 62],
  [383, 597],
  [254, 334],
  [204, 305],
  [258, 418],
  [934, 388],
  [347, 389],
  [871, 1004],
  [266, 341],
  [446, 539],
  [323, 846],
  [866, 271],
  [308, 271],
  [303, 172],
  [297, 170],
  [686, 670],
  [565, 605],
  [382, 611],
  [450, 362],
  [229, 62],
  [1442, 398],
  [487, 994],
  [173, 546],
  [406, 277],
  [182, 243],
  [334, 634],
  [767, 335],
  [162, 156],
  [458, 539],
  [234, 239],
  [430, 259],
  [285, 538],
  [489, 161],
  [846, 298],
  [944, 421],
  [789, 179],
  [378, 376],
];

const FILLER = [
  'This tool is one of a numbered set that measures how many tools a client can reach.',
  'It has no effect on anything: calling it only returns a short check word.',
  'The check word changes every time the server starts, so it cannot be guessed.',
  'Every optional field is ignored; they exist to give the tool a realistic size.',
  'Calling it twice returns the same word while the server keeps running.',
  'The numbered tools are independent of each other and may be called in any order.',
  'Nothing is read, written or sent anywhere when it runs.',
  'An unknown field is not an error.',
];

function pad(base, length, seed) {
  let text = base;
  for (let k = seed; text.length < length; k++) text += ` ${FILLER[k % FILLER.length]}`;
  return text.length > length ? `${text.slice(0, Math.max(base.length, length - 1)).trimEnd()}.` : text;
}

const two = (i) => String(i).padStart(2, '0');

export function spikeTools(count) {
  return Array.from({ length: count }, (_, k) => {
    const i = k + 1;
    const [descLen, schemaLen] = REAL_SIZES[k % REAL_SIZES.length];
    const description = pad(`Returns the check word of tool ${i}.`, descLen, i);
    const inputSchema = { type: 'object', properties: {}, additionalProperties: false };
    for (let f = 1; JSON.stringify(inputSchema).length < schemaLen - 40; f++) {
      const room = schemaLen - JSON.stringify(inputSchema).length - 60;
      inputSchema.properties[`detail_${f}`] = {
        type: 'string',
        description: pad(`Optional detail ${f}, ignored.`, Math.max(30, Math.min(room, 200)), i + f),
      };
    }
    return { name: `tool_${two(i)}`, description, inputSchema };
  });
}

function server() {
  const logFile = process.env.HOLO_SPIKE_LOG;
  const tools = spikeTools(Number(process.env.HOLO_SPIKE_TOOLS ?? 48));
  const nonce = randomBytes(3).toString('hex');
  const log = (entry) => {
    if (logFile)
      appendFileSync(logFile, `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  };
  log({ event: 'start', tools: tools.length, nonce });
  const send = (msg) => process.stdout.write(`${JSON.stringify(msg)}\n`);
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
  const handle = (msg) => {
    if (msg.method !== 'tools/list') log({ dir: 'in', method: msg.method, id: msg.id, params: msg.params });
    if (msg.id === undefined || msg.id === null) return;
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        log({ event: 'client', clientInfo: msg.params?.clientInfo, protocol: asked });
        return reply(msg.id, {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'holo-spike-tools', version: '0.0.0' },
        });
      }
      case 'ping':
        return reply(msg.id, {});
      case 'tools/list': {
        const result = { tools };
        log({ event: 'tools/list', served: tools.length, bytes: JSON.stringify(result).length });
        return reply(msg.id, result);
      }
      case 'tools/call': {
        const name = msg.params?.name;
        const tool = tools.find((t) => t.name === name);
        const text = tool ? `ok-${name.slice(5)}-${nonce}` : `Unknown tool: ${name}`;
        log({ event: 'call', name, text });
        return reply(msg.id, { content: [{ type: 'text', text }], ...(tool ? {} : { isError: true }) });
      }
      default:
        return send({
          jsonrpc: '2.0',
          id: msg.id,
          error: { code: -32601, message: `Method not found: ${msg.method}` },
        });
    }
  };
  createInterface({ input: process.stdin })
    .on('line', (line) => {
      if (!line.trim()) return;
      try {
        handle(JSON.parse(line));
      } catch {
        send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
      }
    })
    .on('close', () => {
      log({ event: 'stdin closed' });
      process.exit(0);
    });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, () => process.exit(0));
}

// ---------------------------------------------------------------------------------------------------
// Sizes.

async function sizes(args) {
  const count = Number(option(args, 'tools', 48));
  const { TOOLS } = await import(join(REPO, 'packages/agent/src/tools/index.ts'));
  const { describeTool } = await import(join(REPO, 'packages/agent/src/tools/common.ts'));
  const { toJsonSchema } = await import(join(REPO, 'packages/agent/src/args.ts'));
  const real = TOOLS.map((t) => ({
    name: t.name,
    description: describeTool(t, 'C4'),
    inputSchema: toJsonSchema(t.args),
  }));
  const stats = (list) => ({
    tools: list.length,
    descriptionChars: list.reduce((n, t) => n + t.description.length, 0),
    schemaChars: list.reduce((n, t) => n + JSON.stringify(t.inputSchema).length, 0),
    toolsListJsonChars: JSON.stringify({ tools: list }).length,
  });
  const fresh = real.map((t) => [t.description.length, JSON.stringify(t.inputSchema).length]);
  const stale = JSON.stringify(fresh) !== JSON.stringify(REAL_SIZES);
  console.log(JSON.stringify({ holo: stats(real), spike: stats(spikeTools(count)), realSizesStale: stale }, null, 2));
}

// ---------------------------------------------------------------------------------------------------
// Running a harness, sealed with the adapters' own code.

const H = join(REPO, 'packages/agent/src/harness');
const { claudeArgs } = await import(join(H, 'claude.ts'));
const { codexArgs, CODEX_DISABLED } = await import(join(H, 'codex.ts'));
const { cursorArgs, cursorEnv } = await import(join(H, 'cursor.ts'));
const { CLAUDE_ENV, harnessEnv } = await import(join(H, 'env.ts'));
const { agentsFile, claudeFiles, cursorFiles, privateDir } = await import(join(H, 'workspace.ts'));

const ROOT = '/tmp/holo-toolcount';

function spikeServer(count, logFile) {
  return {
    command: process.execPath,
    args: [SELF, 'server'],
    env: { HOLO_SPIKE_TOOLS: String(count), HOLO_SPIKE_LOG: logFile },
  };
}

const prompt = (targets) =>
  'The MCP server named "holo" offers numbered tools. First find out how many holo tools you can see, and ' +
  `which is the highest-numbered. Then call the holo tools ${targets.map((t) => `"${t}"`).join(' and ')} ` +
  '(they take no arguments) and note exactly what each returned. Reply in one line: seen=<count>, ' +
  `highest=<name>, ${targets.map((t) => `${t}=<returned text or error>`).join(', ')}.`;

async function probeCodex(args) {
  const count = Number(option(args, 'tools', 48));
  const dir = privateDir(join(ROOT, `codex-probe-${count}`));
  const codexHome = privateDir(join(dir, 'codex-home'));
  const logFile = join(dir, `${new Date().toISOString().replace(/[:.]/g, '-')}.mcp.log`);
  const full = codexArgs({ model: '', effort: '', session: null, workspace: dir }, spikeServer(count, logFile));
  // the run's -c settings with this server, and the --disable list, given to `debug prompt-input`
  const settings = [];
  for (let i = 0; i < full.length; i++) if (full[i] === '-c') settings.push('-c', full[i + 1]);
  const argv = ['debug', 'prompt-input', ...settings, ...CODEX_DISABLED.flatMap((f) => ['--disable', f]), 'hi'];
  const out = await capture('codex', argv, { cwd: dir, env: harnessEnv('codex', { CODEX_HOME: codexHome }) });
  writeFileSync(join(dir, 'prompt-input.json'), out.stdout);
  const nested = [...out.stdout.matchAll(/### `(mcp__holo__[^`\\]+)`/g)].map((m) => m[1]);
  const unique = [...new Set(nested)];
  console.log(
    JSON.stringify(
      {
        count,
        exit: out.code,
        holoToolsListedToModel: unique.length,
        last: unique.at(-1),
        mentions: (out.stdout.match(/tool_search|deferred|too many/gi) ?? []).length,
        stderr: out.stderr.trim().split('\n').slice(-5),
        promptInput: join(dir, 'prompt-input.json'),
        mcpLog: logFile,
      },
      null,
      2,
    ),
  );
}

function capture(bin, argv, { cwd, env, input = '', timeoutMs = 300_000 }) {
  return new Promise((done) => {
    const child = spawn(bin, argv, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true });
    const out = [];
    const err = [];
    child.stdout.on('data', (d) => out.push(d));
    child.stderr.on('data', (d) => err.push(d));
    child.stdin.end(input);
    const stop = () => {
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch {}
    };
    const timer = setTimeout(stop, timeoutMs);
    child.on('close', (code, sig) => {
      clearTimeout(timer);
      stop(); // Cursor's worker outlives the CLI: the whole group goes
      done({ code: sig ?? code, stdout: Buffer.concat(out).toString(), stderr: Buffer.concat(err).toString() });
    });
  });
}

const WARNING = /too many|maximum|exceed|truncat|capped|only the first|tool limit|limit of|\blimit(ed)? to\b/i;

function summarize(harness, events, stderr) {
  const s = { calls: [], reply: null, warnings: [] };
  for (const e of events) {
    if (harness === 'claude') {
      if (e.type === 'system' && e.subtype === 'init') {
        const tools = Array.isArray(e.tools) ? e.tools : [];
        s.initTools = tools.length;
        s.initHoloTools = tools.filter((t) => String(t).startsWith('mcp__holo__')).length;
        s.mcpServers = e.mcp_servers;
        s.model = e.model;
      }
      for (const b of e.type === 'assistant' ? (e.message?.content ?? []) : [])
        if (b.type === 'tool_use') s.calls.push(b.name);
      if (e.type === 'result') {
        s.reply = e.result;
        s.usage = e.usage;
        s.cost = e.total_cost_usd;
      }
    } else if (harness === 'codex') {
      if (e.type === 'item.completed' && e.item?.type === 'mcp_tool_call')
        s.calls.push({
          tool: e.item.tool,
          status: e.item.status,
          result: e.item.result?.content?.map((c) => c.text).join(' '),
          error: e.item.error?.message,
        });
      if (e.type === 'item.completed' && e.item?.type === 'agent_message') s.reply = e.item.text;
      if (e.type === 'turn.completed') s.usage = e.usage;
      if (e.type === 'error' || e.type === 'turn.failed') s.warnings.push(JSON.stringify(e).slice(0, 300));
    } else {
      if (e.type === 'system' && e.subtype === 'init') s.model = e.model;
      if (e.type === 'tool_call' && e.subtype === 'completed') {
        const [kind, call] = Object.entries(e.tool_call ?? {}).find(([, v]) => v && typeof v === 'object') ?? [];
        const result = call?.result?.success?.content;
        const text = Array.isArray(result) ? result.map((c) => c.text?.text ?? '').join(' ') : result;
        s.calls.push({ kind, args: call?.args, result: typeof text === 'string' ? text.slice(0, 400) : call?.result });
      }
      if (e.type === 'assistant') s.reply = (e.message?.content ?? []).map((b) => b.text ?? '').join('');
      if (e.type === 'result') s.usage = e.usage;
    }
  }
  const lines = [...events.map((e) => JSON.stringify(e)), ...stderr.split('\n')];
  s.warnings.push(
    ...lines
      .filter((l) => WARNING.test(l) && /tool/i.test(l))
      .filter((l) => !l.includes('"text":"ok-') && !l.includes('This tool is one of'))
      .map((l) => l.slice(0, 300)),
  );
  s.stderrTail = stderr.trim().split('\n').filter(Boolean).slice(-5);
  return s;
}

async function run(args) {
  const [harness] = args;
  if (!['claude', 'codex', 'cursor'].includes(harness)) {
    console.error('usage: agent-spike-tools.mjs run <claude|codex|cursor> [--tools N] [--model m] [--effort e]');
    process.exit(2);
  }
  const count = Number(option(args, 'tools', 48));
  const targets = [count - 3, count].map((i) => `tool_${two(i)}`); // 48: tool_45 and tool_48
  const ws = privateDir(join(privateDir(ROOT), `${harness}-${count}`));
  const runs = privateDir(join(ws, 'runs'));
  const base = join(runs, new Date().toISOString().replace(/[:.]/g, '-'));
  const logFile = `${base}.mcp.log`;
  const server = spikeServer(count, logFile);
  const defaults = { claude: ['haiku', 'low'], codex: ['gpt-6-luna', 'low'], cursor: ['composer-2.5', ''] }[harness];
  const job = {
    model: option(args, 'model', defaults[0]),
    effort: option(args, 'effort', defaults[1]),
    session: null,
    workspace: ws,
  };
  let argv;
  let extra;
  if (harness === 'claude') {
    argv = claudeArgs(job, claudeFiles(ws, server, null));
    extra = { ...CLAUDE_ENV };
  } else if (harness === 'codex') {
    agentsFile(ws, null);
    argv = codexArgs(job, server);
    argv.splice(1, 0, '--ephemeral'); // nothing saved to ~/.codex/sessions (no resume needed here)
    extra = {};
  } else {
    const { home } = cursorFiles(ws, server, null);
    // the adapter tries the sandbox first and, where it can't start (here), runs every turn without it
    argv = cursorArgs(job, option(args, 'sandbox', 'disabled'));
    extra = cursorEnv(home, process.env);
  }
  const env = harnessEnv(harness, extra);
  const text = prompt(targets);
  writeFileSync(
    `${base}.argv.json`,
    JSON.stringify({ bin: harness === 'cursor' ? 'cursor-agent' : harness, argv, env: extra, prompt: text }, null, 2),
  );
  const started = Date.now();
  const out = await capture(harness === 'cursor' ? 'cursor-agent' : harness, argv, { cwd: ws, env, input: text });
  writeFileSync(`${base}.jsonl`, out.stdout);
  writeFileSync(`${base}.stderr.txt`, out.stderr);
  const events = out.stdout
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => {
      try {
        return [JSON.parse(l)];
      } catch {
        return [];
      }
    });
  const log = existsSync(logFile)
    ? readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    : [];
  const listed = log.filter((l) => l.event === 'tools/list');
  const called = log.filter((l) => l.event === 'call').map((l) => ({ name: l.name, returned: l.text }));
  const summary = summarize(harness, events, out.stderr);
  console.log(
    JSON.stringify(
      {
        harness,
        model: job.model,
        effort: job.effort,
        exit: out.code,
        seconds: Math.round((Date.now() - started) / 1000),
        server: {
          toolsServed: listed[0]?.served ?? null,
          toolsListBytes: listed[0]?.bytes ?? null,
          listCalls: listed.length,
          nonces: log.filter((l) => l.event === 'start').map((l) => l.nonce),
          client: log.find((l) => l.event === 'client')?.clientInfo,
          called,
        },
        targets: Object.fromEntries(
          targets.map((t) => {
            const hit = called.find((c) => c.name === t);
            return [
              t,
              hit
                ? { called: true, returned: hit.returned, inReply: !!summary.reply?.includes(hit.returned) }
                : { called: false },
            ];
          }),
        ),
        ...summary,
        stream: `${base}.jsonl`,
        mcpLog: logFile,
      },
      null,
      2,
    ),
  );
}

if (command === 'server') server();
else if (command === 'sizes') await sizes(rest);
else if (command === 'probe-codex') await probeCodex(rest);
else if (command === 'run') await run(rest);
else {
  console.error(
    'usage: agent-spike-tools.mjs server | sizes [--tools N] | probe-codex [--tools N] | run <harness> [...]',
  );
  process.exit(2);
}
