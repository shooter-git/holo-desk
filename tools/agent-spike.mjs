// Harness spike for the in-app agent (step C0 of the agent plan). A dev tool, not part of the app.
//
//   node tools/agent-spike.mjs server
//       A stub MCP server on stdio (JSON-RPC 2.0, one message per line): initialize, ping, tools/list,
//       tools/call. Tools: echo {text}, image {} (a small PNG of one colour, as MCP image content) and
//       slow {ms}. It logs every message to $HOLO_SPIKE_LOG when set.
//
//   node tools/agent-spike.mjs run <claude|codex|cursor> <scenario> [--resume <id>] [--model <m>]
//       [--effort <e>] [--variant loose|all-tools] [--kill-after <event>] [--timeout <s>]
//       [--drop <arg prefix>] [--add <arg>] [--unset <ENV>]
//       Runs the harness once in a sealed workspace under ${XDG_CACHE_HOME:-~/.cache}/holo/agent-spike/<harness>,
//       prompt on stdin, and saves its raw output stream in <workspace>/runs/. Scenarios: normal, resume,
//       shell, write, other (Cursor: a second, unapproved server),
//       many (with HOLO_SPIKE_TOOLS=45), timeout. --kill-after init stops the harness (its whole process group) after its first event.
//
//   node tools/agent-spike.mjs sanitize <in.jsonl> <out.jsonl>
//       Copies a recorded stream with the home folder replaced by ~ and account details removed.
//
// Every harness option used here is explained in docs/agent-harnesses.md.
import { spawn } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, userInfo } from 'node:os';
import { join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { crc32, deflateSync } from 'node:zlib';

const SELF = resolve(import.meta.filename);
const [command, ...rest] = process.argv.slice(2);

// ---------------------------------------------------------------------------------------------------
// The stub MCP server.

const COLOURS = { red: [220, 30, 30], green: [30, 170, 60], blue: [40, 80, 220], yellow: [240, 210, 30] };

function png(width, height, [r, g, b]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const out = Buffer.alloc(body.length + 8);
    out.writeUInt32BE(data.length, 0);
    body.copy(out, 4);
    out.writeUInt32BE(crc32(body), body.length + 4);
    return out;
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // bit depth
  header[9] = 2; // RGB
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x++) row.set([r, g, b], 1 + x * 3);
  const raw = Buffer.concat(Array.from({ length: height }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TOOLS = [
  {
    name: 'echo',
    description: 'Echoes the given text back.',
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
  {
    name: 'image',
    description: 'Returns a small picture.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'slow',
    description: 'Waits the given number of milliseconds, then answers "done".',
    inputSchema: { type: 'object', properties: { ms: { type: 'number' } }, required: ['ms'] },
  },
];

// HOLO_SPIKE_TOOLS=<n> adds n harmless extra tools, to see how each harness copes with many.
for (let i = 1; i <= Number(process.env.HOLO_SPIKE_TOOLS ?? 0); i++) {
  TOOLS.push({
    name: `extra_${i}`,
    description: `Extra tool number ${i}.`,
    inputSchema: { type: 'object', properties: {} },
  });
}

function server() {
  const logFile = process.env.HOLO_SPIKE_LOG;
  const log = (entry) => {
    if (logFile)
      appendFileSync(logFile, `${JSON.stringify({ t: new Date().toISOString(), pid: process.pid, ...entry })}\n`);
  };
  const colourName = process.env.HOLO_SPIKE_COLOUR in COLOURS ? process.env.HOLO_SPIKE_COLOUR : 'green';
  log({ event: 'start', argv: process.argv.slice(2), colour: colourName, cwd: process.cwd() });
  const send = (msg) => {
    log({ dir: 'out', msg: msg.result?.content ? { ...msg, result: '(content)' } : msg });
    process.stdout.write(`${JSON.stringify(msg)}\n`);
  };
  const reply = (id, result) => send({ jsonrpc: '2.0', id, result });
  const fail = (id, code, message) => send({ jsonrpc: '2.0', id, error: { code, message } });
  const SUPPORTED = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

  const handle = async (msg) => {
    log({ dir: 'in', msg });
    if (msg.id === undefined || msg.id === null) return; // notifications: nothing to answer
    switch (msg.method) {
      case 'initialize': {
        const asked = msg.params?.protocolVersion;
        return reply(msg.id, {
          protocolVersion: SUPPORTED.includes(asked) ? asked : SUPPORTED[0],
          capabilities: { tools: {} },
          serverInfo: { name: 'holo-spike', version: '0.0.0' },
        });
      }
      case 'ping':
        return reply(msg.id, {});
      case 'tools/list':
        return reply(msg.id, { tools: TOOLS });
      case 'tools/call': {
        const { name, arguments: args = {} } = msg.params ?? {};
        if (name === 'echo') return reply(msg.id, { content: [{ type: 'text', text: String(args.text ?? '') }] });
        if (name === 'image') {
          const data = png(64, 64, COLOURS[colourName]).toString('base64');
          return reply(msg.id, {
            content: [
              { type: 'image', data, mimeType: 'image/png' },
              { type: 'text', text: 'That is the picture.' },
            ],
          });
        }
        if (name === 'slow') {
          const ms = Math.min(Math.max(Number(args.ms) || 0, 0), 600_000);
          await new Promise((r) => setTimeout(r, ms));
          return reply(msg.id, { content: [{ type: 'text', text: `done after ${ms} ms` }] });
        }
        if (TOOLS.some((t) => t.name === name))
          return reply(msg.id, { content: [{ type: 'text', text: `${name}: ok` }] });
        return reply(msg.id, { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true });
      }
      default:
        return fail(msg.id, -32601, `Method not found: ${msg.method}`);
    }
  };

  const lines = createInterface({ input: process.stdin });
  lines.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    }
    handle(msg).catch((e) => fail(msg.id, -32603, String(e)));
  });
  lines.on('close', () => {
    log({ event: 'stdin closed' });
    process.exit(0);
  });
  for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) {
    process.on(sig, () => {
      log({ event: sig });
      process.exit(0);
    });
  }
}

// ---------------------------------------------------------------------------------------------------
// Running a harness.

const PROMPTS = {
  normal:
    'Call the holo "echo" tool with the text "spike-42". Then call the holo "image" tool and look at the ' +
    'picture it returns. Reply in one short line: the echoed text, and the main colour of the picture.',
  resume: 'In one short line: what text did you echo in your previous turn, and what colour was the picture?',
  shell:
    'Run the shell command `ls ~`, read the file /etc/hostname, and create a file named note.txt here ' +
    'containing "hi". Then tell me what you found. If you cannot, reply in one line listing the exact ' +
    'names of the tools you have and why you could not.',
  write:
    'Use whatever tool you have that can create files (for example apply_patch) to create note.txt here ' +
    'containing "hi". Try it even if you expect it to fail, then reply in one line with the exact result or error.',
  many: 'Call the holo tool named "extra_44" and reply in one line with what it returned, or the error.',
  other:
    'Call the "echo" tool of the MCP server named "other" with the text "x". Reply in one line with the result ' +
    'or the exact error.',
  // Claude and Codex get a 3 s tool timeout here. Cursor has no setting for it in print mode, so this asks for
  // longer than the MCP SDK's 60 s default request timeout (set HOLO_SPIKE_SLOW_MS).
  timeout: `Call the holo "slow" tool with ms set to ${process.env.HOLO_SPIKE_SLOW_MS ?? 8000}. Reply in one line with what it returned, or the error.`,
};

function option(args, name) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
}

function options(args, name) {
  return args.flatMap((a, i) => (a === `--${name}` && i + 1 < args.length ? [args[i + 1]] : []));
}

const cacheHome = process.env.XDG_CACHE_HOME || join(homedir(), '.cache');

// Only these variables reach the harness (plus each harness's own auth variables).
const ENV_ALLOW = [
  /^(HOME|PATH|LANG|LANGUAGE|LC_[A-Z]+|TERM|TMPDIR|TZ|USER|LOGNAME|SHELL)$/,
  /^XDG_[A-Z_]+$/,
  /^(HTTPS?_PROXY|NO_PROXY|ALL_PROXY|https?_proxy|no_proxy|all_proxy)$/,
  /^(NODE_EXTRA_CA_CERTS|SSL_CERT_FILE|SSL_CERT_DIR)$/,
];
const AUTH_ENV = {
  claude: /^(ANTHROPIC_API_KEY|CLAUDE_CODE_OAUTH_TOKEN|CLAUDE_CONFIG_DIR)$/,
  codex: /^(OPENAI_API_KEY|CODEX_HOME|CODEX_API_KEY)$/,
  cursor: /^(CURSOR_API_KEY|CURSOR_AUTH_TOKEN|CURSOR_CONFIG_DIR|CURSOR_DATA_DIR)$/,
};

function sealedEnv(harness, extra = {}) {
  const env = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_ALLOW.some((re) => re.test(k)) || AUTH_ENV[harness].test(k)) env[k] = v;
  }
  return { ...env, ...extra };
}

function mcpServer(logFile) {
  return {
    command: process.execPath,
    args: [SELF, 'server'],
    env: {
      HOLO_SPIKE_LOG: logFile,
      HOLO_SPIKE_COLOUR: process.env.HOLO_SPIKE_COLOUR ?? 'green',
      HOLO_SPIKE_TOOLS: process.env.HOLO_SPIKE_TOOLS ?? '0',
    },
  };
}

// Each harness: files to write into the workspace, and the argv. The prompt always goes on stdin.
const HARNESSES = {
  claude({ ws, logFile, scenario, resume, model = 'haiku', effort = 'low', variant }) {
    const server = mcpServer(logFile);
    // The per-server timeout (ms) applies to every tool call on that server.
    const holo = { type: 'stdio', ...server, ...(scenario === 'timeout' ? { timeout: 3000 } : {}) };
    writeFileSync(join(ws, 'mcp.json'), JSON.stringify({ mcpServers: { holo } }, null, 2));
    const settings = { disableAllHooks: true, autoMemoryEnabled: false, disableClaudeAiConnectors: true };
    writeFileSync(join(ws, 'settings.json'), JSON.stringify(settings, null, 2));
    const argv = [
      '-p',
      '--output-format=stream-json',
      '--verbose',
      `--model=${model}`,
      `--effort=${effort}`,
      '--tools=',
      '--strict-mcp-config',
      `--mcp-config=${join(ws, 'mcp.json')}`,
      '--allowedTools=mcp__holo__*',
      '--setting-sources=project',
      `--settings=${join(ws, 'settings.json')}`,
      '--permission-mode=dontAsk',
      '--no-chrome',
      '--disable-slash-commands',
    ];
    if (variant === 'loose') argv.splice(argv.indexOf('--tools='), 1); // built-in tools left on, to see the guard
    if (resume) argv.push(`--resume=${resume}`);
    const env = { ENABLE_CLAUDEAI_MCP_SERVERS: 'false', DISABLE_AUTOUPDATER: '1', CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1' };
    return { bin: 'claude', argv, env };
  },

  codex({ ws, logFile, scenario, resume, model = 'gpt-6-luna', effort = 'low', variant }) {
    const server = mcpServer(logFile);
    const toml = (v) => JSON.stringify(v); // JSON strings and arrays are valid TOML values
    const c = [
      `model_reasoning_effort=${toml(effort)}`,
      'sandbox_mode="read-only"',
      'approval_policy="never"',
      'web_search="disabled"',
      'features.multi_agent_v2.disable_native_tools=true', // the collaboration.* (sub-agent) tools
      `mcp_servers.holo.command=${toml(server.command)}`,
      `mcp_servers.holo.args=${toml(server.args)}`,
      `mcp_servers.holo.env={${Object.entries(server.env)
        .map(([k, v]) => `${k}=${toml(v)}`)
        .join(',')}}`,
      `mcp_servers.holo.tool_timeout_sec=${scenario === 'timeout' ? 3 : 240}`,
      'mcp_servers.holo.startup_timeout_sec=20',
      'mcp_servers.holo.default_tools_approval_mode="approve"',
    ];
    // "loose" is for comparison only: Codex then also fetches the account's apps and plugins into ~/.codex.
    const disable =
      variant === 'loose'
        ? []
        : [
            'shell_tool',
            'unified_exec',
            'apps',
            'plugins',
            'remote_plugin',
            'browser_use',
            'browser_use_external',
            'in_app_browser',
            'computer_use',
            'image_generation',
            'multi_agent',
            'hooks',
            'goals',
            'view_image',
            'tool_suggest',
            'skill_search',
            'skill_mcp_dependency_install',
            'workspace_dependencies',
            'shell_snapshot',
            'plugin_discovery_prefetch',
            'sleep_tool',
          ];
    const common = [
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      `--model=${model}`,
      ...c.flatMap((kv) => ['-c', kv]),
      ...disable.flatMap((f) => ['--disable', f]),
    ];
    const argv = resume
      ? ['exec', 'resume', ...common, resume, '-']
      : ['exec', ...common, '--sandbox=read-only', `--cd=${ws}`, '-'];
    return { bin: 'codex', argv, env: {} };
  },

  cursor({ ws, logFile, scenario, resume, model = 'composer-2.5', variant }) {
    const server = mcpServer(logFile);
    mkdirSync(join(ws, '.cursor'), { recursive: true, mode: 0o700 });
    // "other" stands for a server we did not mean to allow (as a user's global or plugin server would be).
    const servers = scenario === 'other' ? { holo: server, other: mcpServer(`${logFile}.other`) } : { holo: server };
    writeFileSync(join(ws, '.cursor', 'mcp.json'), JSON.stringify({ mcpServers: servers }, null, 2));
    const permissions =
      variant === 'loose'
        ? { allow: [], deny: [] }
        : { allow: ['Mcp(holo:*)'], deny: ['Shell(*)', 'Read(**)', 'Write(**)', 'WebFetch(*)'] }; // deny wins over allow
    // The project cli.json accepts only known keys: "version" here makes Cursor refuse the file.
    writeFileSync(join(ws, '.cursor', 'cli.json'), JSON.stringify({ permissions }, null, 2));
    const argv = [
      '-p',
      '--output-format=stream-json',
      `--workspace=${ws}`,
      // --sandbox=enabled refuses to start where unprivileged user namespaces are blocked (AppArmor).
      process.env.HOLO_SPIKE_CURSOR_SANDBOX === '1' ? '--sandbox=enabled' : '--sandbox=disabled',
      '--approve-mcps',
      '--trust',
      '--disable-auto-update', // hidden flag; without it every run updates the CLI in the background
      `--model=${model}`,
    ];
    // Hidden, "internal only" flag, enforced by Cursor's backend: the model then gets only the two MCP meta-tools.
    if (variant !== 'all-tools') argv.push('--allowed-tools=mcp_tool_call,get_mcp_tools_tool_call');
    if (resume) argv.push(`--resume=${resume}`);
    // A private HOME keeps out ~/.cursor (global mcp.json, plugins and their MCP servers, skills, rules,
    // cli-config.json). On Linux the sign-in stays readable through XDG_CONFIG_HOME (~/.config/cursor/auth.json);
    // CURSOR_CONFIG_DIR keeps Cursor from writing a cli-config.json next to it.
    const home = join(ws, 'home');
    mkdirSync(home, { recursive: true, mode: 0o700 });
    // Never run Cursor here with the real HOME: it saves --model as the user's default model in
    // ~/.cursor/cli-config.json and loads their global MCP servers.
    const env = {
      HOME: home,
      XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME || join(homedir(), '.config'),
      CURSOR_CONFIG_DIR: join(home, '.cursor'),
    };
    return { bin: 'cursor-agent', argv, env };
  },
};

function sessionOf(harness, event) {
  if (harness === 'claude' && event.type === 'system' && event.subtype === 'init') return event.session_id;
  if (harness === 'codex' && event.type === 'thread.started') return event.thread_id;
  if (harness === 'cursor' && event.session_id) return event.session_id;
  return undefined;
}

async function run(args) {
  const [harness, scenario = 'normal'] = args;
  if (!HARNESSES[harness] || !PROMPTS[scenario]) {
    console.error(
      'usage: agent-spike.mjs run <claude|codex|cursor> <normal|resume|shell|write|other|many|timeout> [options]',
    );
    process.exit(2);
  }
  const ws = join(cacheHome, 'holo', 'agent-spike', harness);
  mkdirSync(join(ws, 'runs'), { recursive: true, mode: 0o700 });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const variant = option(args, 'variant');
  const base = join(ws, 'runs', `${stamp}-${scenario}${variant ? `-${variant}` : ''}`);
  const logFile = `${base}.mcp.log`;
  const spec = HARNESSES[harness]({
    ws,
    logFile,
    scenario,
    resume: option(args, 'resume'),
    model: option(args, 'model'),
    effort: option(args, 'effort'),
    variant,
  });
  // Experiments: --drop <arg prefix>, --add <arg>, --unset <ENV> (each repeatable).
  for (const prefix of options(args, 'drop')) spec.argv = spec.argv.filter((a) => !a.startsWith(prefix));
  const added = options(args, 'add');
  if (added.length) spec.argv.splice(spec.argv.at(-1) === '-' ? -1 : spec.argv.length, 0, ...added);
  for (const name of options(args, 'unset')) delete spec.env[name];
  const killAfter = option(args, 'kill-after');
  const timeoutMs = Number(option(args, 'timeout') ?? 240) * 1000;
  const prompt = PROMPTS[scenario];
  writeFileSync(
    `${base}.argv.json`,
    JSON.stringify({ bin: spec.bin, argv: spec.argv, env: spec.env, prompt }, null, 2),
  );

  const started = Date.now();
  const child = spawn(spec.bin, spec.argv, {
    cwd: ws,
    env: sealedEnv(harness, spec.env),
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: true, // its own process group, so the whole tree can be stopped
  });
  child.stdin.end(prompt);
  const out = [];
  let firstEventMs;
  let session;
  const tools = [];
  const stopGroup = (why) => {
    console.log(`stopping process group ${child.pid} (${why})`);
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
    setTimeout(() => {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {}
    }, 3000).unref();
  };
  const timer = setTimeout(() => stopGroup('timeout'), timeoutMs);
  createInterface({ input: child.stdout }).on('line', (line) => {
    out.push(line);
    firstEventMs ??= Date.now() - started;
    let event;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }
    session ??= sessionOf(harness, event);
    const name = event.type === 'assistant' ? event.message?.content?.find((b) => b.type === 'tool_use')?.name : null;
    if (name) tools.push(name);
    if (event.type === 'item.started' || event.type === 'item.completed') tools.push(`${event.item?.type}`);
    if (event.type === 'tool_call' && event.subtype === 'started') tools.push(Object.keys(event.tool_call ?? {})[0]);
    if (killAfter && (killAfter === 'first' || event.subtype === killAfter || event.type === killAfter)) {
      stopGroup(`after ${killAfter}`);
    }
  });
  const errors = [];
  child.stderr.on('data', (d) => errors.push(d));
  const code = await new Promise((r) => child.on('close', (c, sig) => r(sig ?? c)));
  clearTimeout(timer);
  writeFileSync(`${base}.jsonl`, out.length ? `${out.join('\n')}\n` : '');
  writeFileSync(`${base}.stderr.txt`, Buffer.concat(errors));
  // Is anything from that process group still alive (Cursor leaves its per-project worker-server)? Then stop it.
  let alive = false;
  try {
    process.kill(-child.pid, 0);
    alive = true;
    process.kill(-child.pid, 'SIGTERM');
  } catch {}
  console.log(
    JSON.stringify(
      {
        harness,
        scenario,
        variant,
        exit: code,
        firstEventMs,
        totalMs: Date.now() - started,
        session,
        tools,
        groupStillAlive: alive,
        stream: `${base}.jsonl`,
        mcpLog: existsSync(logFile) ? logFile : null,
      },
      null,
      2,
    ),
  );
}

// ---------------------------------------------------------------------------------------------------
// Sanitizing a recorded stream for the fixtures.

function sanitize([input, output]) {
  const home = homedir();
  const user = userInfo().username;
  let text = readFileSync(input, 'utf8');
  text = text.split(home).join('~');
  text = text.replace(/\/home\/[a-z_][a-z0-9_.-]*\//g, '~/');
  // Harness state folders are named after the path (e.g. home-<user>-cache-holo-…): drop the user name too.
  if (user.length >= 3) text = text.split(user).join('user');
  text = text.replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, 'user@example.com');
  const lines = text
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        return line;
      }
      const scrub = (v, key) => {
        if (Array.isArray(v)) return v.map((x) => scrub(x));
        if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, scrub(x, k)]));
        if (
          typeof v === 'string' &&
          /^(email|orgId|orgName|organization|account|accountUuid|userId|uuid_account)$/i.test(key ?? '')
        )
          return 'redacted';
        if (typeof v === 'string' && key === 'data' && v.length > 200) return `${v.slice(0, 32)}…(base64 trimmed)`;
        return v;
      };
      return JSON.stringify(scrub(event));
    });
  writeFileSync(output, `${lines.join('\n')}\n`);
  console.log(`wrote ${output} (${lines.length} events)`);
}

if (command === 'server') server();
else if (command === 'run') await run(rest);
else if (command === 'sanitize') sanitize(rest);
else {
  console.error('usage: agent-spike.mjs server | run <harness> <scenario> [options] | sanitize <in> <out>');
  process.exit(2);
}
