/**
 * A stand-in for Claude Code and for Codex: one program that answers as each does to what HO[LO]'s
 * adapters ask (its version, its sign-in, its models, its seal) and, for a run, does what the
 * request's script says (script.ts) through HO[LO]'s real MCP server, writing the stream that harness
 * writes. So the runner, the adapters, their seal checks and tripwires, the tools and the server all
 * run as they do with the real thing, with no model, no sign-in and no subscription.
 *
 *     node packages/agent/stand-in/main.ts claude --version
 *     node packages/agent/stand-in/main.ts codex exec --json … -
 *
 * The runner reaches it through the overrides it already has: HOLO_CLAUDE and HOLO_CODEX name a
 * launcher that runs this with `claude` or `codex` before its arguments (tools/agent-check.mjs writes
 * them). It's for HO[LO]'s own checks: nothing starts it otherwise.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createInterface } from 'node:readline';
import { claudeServer, codexServer, type Server } from './config.ts';
import { parseScript, requestOf, type Step } from './script.ts';

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const say = (event: Record<string, unknown>) => process.stdout.write(`${JSON.stringify(event)}\n`);

function stdin(): Promise<string> {
  return new Promise((done) => {
    let text = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c: string) => {
      text += c;
    });
    process.stdin.on('end', () => done(text));
    process.stdin.on('error', () => done(text));
  });
}

// ---- HO[LO]'s tools: its MCP server, started as a harness starts it ----

interface Answer {
  text: string;
  failed: boolean;
}

/** HO[LO]'s MCP server over stdio: JSON-RPC 2.0, a message a line. */
class Tools {
  private readonly child: ChildProcess;
  private readonly waiting = new Map<number, (msg: Record<string, unknown>) => void>();
  private next = 1;

  constructor(server: Server) {
    this.child = spawn(server.command, server.args, {
      env: { ...process.env, ...server.env },
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    this.child.on('error', () => this.drop());
    this.child.on('close', () => this.drop());
    this.child.stdin?.on('error', () => undefined);
    if (this.child.stdout) {
      createInterface({ input: this.child.stdout }).on('line', (line) => {
        let msg: unknown;
        try {
          msg = JSON.parse(line);
        } catch {
          return;
        }
        if (!isObject(msg) || typeof msg.id !== 'number') return;
        const answer = this.waiting.get(msg.id);
        this.waiting.delete(msg.id);
        answer?.(msg);
      });
    }
  }

  /** The server went: whatever was asked of it has no answer. */
  private drop(): void {
    for (const answer of this.waiting.values()) answer({ error: { message: 'HO[LO]’s tools stopped' } });
    this.waiting.clear();
  }

  private ask(method: string, params: Record<string, unknown>): Promise<Record<string, unknown>> {
    return new Promise((done) => {
      const id = this.next++;
      this.waiting.set(id, done);
      this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    });
  }

  /** Greets the server and asks what it has: the tools' names, or null when it didn't start. */
  async start(protocolVersion: string): Promise<string[] | null> {
    const hello = await this.ask('initialize', {
      protocolVersion,
      capabilities: {},
      clientInfo: { name: 'holo-stand-in', version: '1' },
    });
    if (!isObject(hello.result)) return null;
    this.child.stdin?.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    const list = await this.ask('tools/list', {});
    const tools = isObject(list.result) && Array.isArray(list.result.tools) ? list.result.tools : null;
    if (!tools) return null;
    return tools.filter(isObject).map((t) => String(t.name ?? ''));
  }

  async call(name: string, args: Record<string, unknown>): Promise<Answer> {
    const msg = await this.ask('tools/call', { name, arguments: args });
    if (isObject(msg.error)) return { text: String(msg.error.message ?? 'failed'), failed: true };
    const result = isObject(msg.result) ? msg.result : {};
    const content = Array.isArray(result.content) ? result.content.filter(isObject) : [];
    const text = content
      .filter((c) => c.type === 'text' && typeof c.text === 'string')
      .map((c) => c.text as string)
      .join('\n');
    return { text, failed: result.isError === true };
  }

  stop(): void {
    this.child.stdin?.end();
    this.child.kill();
  }
}

// ---- what a run does, whichever harness it stands in for ----

/** How a harness writes what happens in a turn. */
interface Dialect {
  tool(name: string, args: Record<string, unknown>): void;
  toolDone(name: string, answer: Answer): void;
  text(text: string): void;
}

/** Tokens, roughly: enough for the counts to mean something. */
const tokensOf = (text: string) => Math.max(1, Math.ceil(text.length / 4));

interface Outcome {
  /** The harness's own last words. */
  last: string;
  /** Why the turn failed, if it did. */
  error: string | null;
  /** The account's limit refused it: starting again this many seconds from now. */
  limited?: number;
  output: number;
}

async function play(steps: readonly Step[], tools: Tools, dialect: Dialect): Promise<Outcome> {
  let last = '';
  let output = 0;
  for (const step of steps) {
    if (step.do === 'wait') await new Promise((ok) => setTimeout(ok, step.ms));
    else if (step.do === 'say') {
      last = step.text;
      output += tokensOf(step.text);
      dialect.text(step.text);
    } else if (step.do === 'fail') {
      if (step.once) failedOnce(steps);
      return { last, error: step.error, output };
    } else if (step.do === 'limit')
      return { last, error: 'The account’s limit refused the request', limited: step.seconds, output };
    else {
      output += tokensOf(JSON.stringify(step.args)) + 8;
      dialect.tool(step.tool, step.args);
      dialect.toolDone(step.tool, await tools.call(step.tool, step.args));
    }
  }
  return { last, error: null, output };
}

/** The scripts that have failed their one time, kept beside the conversation (a go carries on in its folder). */
const ONCE_FILE = '.stand-in-once.json';
const keyOf = (steps: readonly Step[]) => createHash('sha256').update(JSON.stringify(steps)).digest('hex').slice(0, 16);

function failedBefore(): string[] {
  try {
    const list = JSON.parse(readFileSync(ONCE_FILE, 'utf8')) as unknown;
    return Array.isArray(list) ? list.filter((k): k is string => typeof k === 'string') : [];
  } catch {
    return [];
  }
}

/** A script's `fail-once` has failed: the next go at it carries on after that step. */
function failedOnce(steps: readonly Step[]): void {
  try {
    writeFileSync(ONCE_FILE, JSON.stringify([...failedBefore(), keyOf(steps)].slice(-50)), { mode: 0o600 });
  } catch {
    // a folder it can't write in: it fails every time
  }
}

/** A turn's steps from its prompt; a script that can't be read is a turn that fails saying why. */
function stepsOf(prompt: string): Step[] {
  const steps = parseScript(requestOf(prompt));
  if (typeof steps === 'string') return [{ do: 'fail', error: `The stand-in couldn’t read its script: ${steps}` }];
  // (a script whose `fail-once` has failed: this go carries on from the step after it; the script it
  // was given is what's remembered, so what's left of it doesn't count as another)
  const once = steps.findIndex((s) => s.do === 'fail' && s.once);
  if (once < 0 || !failedBefore().includes(keyOf(steps))) return steps;
  return steps.slice(once + 1);
}

/** `--name=value` in an argv. */
const option = (argv: readonly string[], name: string): string | null => {
  const hit = argv.find((a) => a.startsWith(`${name}=`));
  return hit === undefined ? null : hit.slice(name.length + 1);
};

/** When each window starts again, in seconds: the stand-in's account is always a while from it. */
const resets = (minutes: number) => Math.floor(Date.now() / 1000) + minutes * 30;

// ---- as Claude Code ----

const CLAUDE_VERSION = '2.1.999';
const CLAUDE_HELP = `Usage: claude [options] [command] [prompt]
  --allowedTools, --allowed-tools <tools...>
  --append-system-prompt <prompt>       Append a system prompt
  --disable-slash-commands
  --effort <level>                      Effort level for the current session (low, medium, high)
  --mcp-config <configs...>
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'opus' or 'sonnet') or a model's full
                                        name.
  --permission-mode <mode>
  -r, --resume [value]
  --setting-sources <sources>
  --settings <file-or-json>
  --strict-mcp-config
  --tools <tools...>`;

const PREFIX = 'mcp__holo__';

async function claude(argv: readonly string[]): Promise<number> {
  if (argv.includes('--version')) {
    console.log(`${CLAUDE_VERSION} (Claude Code)`);
    return 0;
  }
  if (argv.includes('--help')) {
    console.log(CLAUDE_HELP);
    return 0;
  }
  if (argv[0] === 'auth' && argv[1] === 'status') {
    console.log(
      JSON.stringify({
        loggedIn: true,
        authMethod: 'claude.ai',
        email: 'stand-in@example.com',
        subscriptionType: 'max',
      }),
    );
    return 0;
  }
  if (argv[0] === 'update') {
    console.log(`Claude Code is up to date (${CLAUDE_VERSION})`);
    return 0;
  }
  if (!argv.includes('-p')) {
    console.error('The stand-in for Claude Code runs only as HO[LO] runs it (-p).');
    return 2;
  }
  const prompt = await stdin();
  const session = option(argv, '--resume') ?? randomUUID();
  const alias = option(argv, '--model') ?? 'sonnet';
  const model = /^[a-z]+$/.test(alias) ? `claude-${alias}-stand-in` : alias;
  let config = '';
  try {
    config = readFileSync(option(argv, '--mcp-config') ?? '', 'utf8');
  } catch {
    // none: said below, as Claude Code says a server that didn't start
  }
  const server = claudeServer(config);
  const tools = server ? new Tools(server) : null;
  const names = tools ? await tools.start('2025-11-25') : null;
  say({
    type: 'system',
    subtype: 'init',
    session_id: session,
    model,
    tools: (names ?? []).map((n) => `${PREFIX}${n}`),
    mcp_servers: [{ name: 'holo', status: names ? 'connected' : 'failed' }],
  });
  if (!tools || !names) {
    tools?.stop();
    return 1;
  }
  const outcome = await play(stepsOf(prompt), tools, {
    tool: (name, input) =>
      say({
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'tool_use', name: `${PREFIX}${name}`, input }] },
      }),
    toolDone: (_name, answer) =>
      say({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', content: answer.text, is_error: answer.failed }] },
      }),
    text: (text) => say({ type: 'assistant', message: { role: 'assistant', content: [{ type: 'text', text }] } }),
  });
  tools.stop();
  // what the account has left: some to spare, or (the script's `limit`) the five hours used up, the
  // request refused by them, as Claude Code says it
  const until = outcome.limited === undefined ? null : Math.floor(Date.now() / 1000) + outcome.limited;
  say({
    type: 'rate_limit_event',
    rate_limit_info: {
      status: until === null ? 'allowed' : 'rejected',
      rateLimitType: 'five_hour',
      ...(until === null ? {} : { resetsAt: until, isUsingOverage: false }),
      unifiedWindows: {
        five_hour:
          until === null
            ? { utilization: 0.12, resetsAt: resets(300), status: 'allowed' }
            : { utilization: 1, resetsAt: until, status: 'rejected' },
        seven_day: { utilization: 0.37, resetsAt: resets(10080), status: 'allowed' },
      },
    },
  });
  say({
    type: 'result',
    subtype: 'success',
    is_error: outcome.error !== null,
    result: outcome.error ?? outcome.last,
    session_id: session,
    usage: {
      input_tokens: tokensOf(prompt),
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 0,
      output_tokens: outcome.output,
    },
  });
  return outcome.error === null ? 0 : 1;
}

// ---- as Codex ----

const CODEX_VERSION = '0.999.0';
const CODEX_MODELS = {
  models: [
    {
      slug: 'stand-in-large',
      visibility: 'list',
      priority: 1,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }, { effort: 'high' }],
    },
    {
      slug: 'stand-in-small',
      visibility: 'list',
      priority: 2,
      default_reasoning_level: 'low',
      supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }],
    },
  ],
};

/** Its app server, as far as HO[LO] asks it: the greeting, then what the account has left. */
function codexAppServer(): Promise<number> {
  return new Promise((done) => {
    const answer = (id: unknown, result: unknown) => process.stdout.write(`${JSON.stringify({ id, result })}\n`);
    const lines = createInterface({ input: process.stdin });
    lines.on('line', (line) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObject(msg) || msg.id === undefined) return;
      if (msg.method === 'initialize') answer(msg.id, { userAgent: `stand-in/${CODEX_VERSION}` });
      else if (msg.method === 'account/rateLimits/read') {
        const codex = {
          limitId: 'codex',
          limitName: null,
          planType: 'plus',
          primary: { usedPercent: 24, windowDurationMins: 10080, resetsAt: resets(10080) },
          secondary: null,
        };
        answer(msg.id, { rateLimits: codex, rateLimitsByLimitId: { codex } });
      } else process.stdout.write(`${JSON.stringify({ id: msg.id, error: { message: 'not here' } })}\n`);
    });
    lines.on('close', () => done(0));
  });
}

/** What a conversation has used so far, kept beside it (Codex says the total, not the turn's own). */
const USED_FILE = '.stand-in-used.json';

function usedSoFar(session: string): { input: number; output: number } {
  try {
    const all = JSON.parse(readFileSync(USED_FILE, 'utf8')) as unknown;
    const one = isObject(all) ? all[session] : null;
    if (isObject(one) && typeof one.input === 'number' && typeof one.output === 'number')
      return { input: one.input, output: one.output };
  } catch {
    // none yet
  }
  return { input: 0, output: 0 };
}

function keepUsed(session: string, used: { input: number; output: number }): void {
  let all: Record<string, unknown> = {};
  try {
    const read = JSON.parse(readFileSync(USED_FILE, 'utf8')) as unknown;
    if (isObject(read)) all = read;
  } catch {
    // none yet
  }
  try {
    writeFileSync(USED_FILE, JSON.stringify({ ...all, [session]: used }), { mode: 0o600 });
  } catch {
    // a folder it can't write in: the next turn counts from none
  }
}

async function codex(argv: readonly string[]): Promise<number> {
  if (argv.includes('--version')) {
    console.log(`codex-cli ${CODEX_VERSION}`);
    return 0;
  }
  if (argv[0] === 'login' && argv[1] === 'status') {
    console.error('Logged in using ChatGPT');
    return 0;
  }
  if (argv[0] === 'debug' && argv[1] === 'models') {
    console.log(JSON.stringify(CODEX_MODELS));
    return 0;
  }
  if (argv[0] === 'debug' && argv[1] === 'prompt-input') {
    // the model's tools with a run's switches: none but what HO[LO]'s server adds
    console.log(JSON.stringify([{ type: 'additional_tools', tools: [] }]));
    return 0;
  }
  if (argv[0] === 'app-server') return codexAppServer();
  if (argv[0] === 'update') {
    console.log(`Codex is up to date (${CODEX_VERSION})`);
    return 0;
  }
  if (argv[0] !== 'exec' || argv.at(-1) !== '-') {
    console.error('The stand-in for Codex runs only as HO[LO] runs it (exec … -).');
    return 2;
  }
  // `exec resume … <id> -`: the conversation carried on
  const session = argv[1] === 'resume' ? (argv.at(-2) ?? randomUUID()) : randomUUID();
  const prompt = await stdin();
  say({ type: 'thread.started', thread_id: session });
  const server = codexServer(argv);
  const tools = server ? new Tools(server) : null;
  const names = tools ? await tools.start('2025-06-18') : null;
  if (!tools || !names) {
    tools?.stop();
    say({ type: 'turn.failed', error: { message: 'MCP client for `holo` failed to start' } });
    return 1;
  }
  let item = 0;
  const outcome = await play(stepsOf(prompt), tools, {
    tool: (tool, args) =>
      say({
        type: 'item.started',
        item: {
          id: `item_${item}`,
          type: 'mcp_tool_call',
          server: 'holo',
          tool,
          arguments: args,
          status: 'in_progress',
        },
      }),
    toolDone: (tool, answer) =>
      say({
        type: 'item.completed',
        item: {
          id: `item_${item++}`,
          type: 'mcp_tool_call',
          server: 'holo',
          tool,
          status: answer.failed ? 'failed' : 'completed',
        },
      }),
    text: (text) => say({ type: 'item.completed', item: { id: `item_${item++}`, type: 'agent_message', text } }),
  });
  tools.stop();
  const before = usedSoFar(session);
  const total = { input: before.input + tokensOf(prompt), output: before.output + outcome.output };
  keepUsed(session, total);
  if (outcome.error !== null) {
    // (an account out of usage, in the words Codex has for an API key's: its limits aren't told in a run)
    const message =
      outcome.limited === undefined ? outcome.error : 'Quota exceeded. Check your plan and billing details.';
    say({ type: 'turn.failed', error: { message } });
    return 1;
  }
  say({
    type: 'turn.completed',
    usage: { input_tokens: total.input, cached_input_tokens: 0, output_tokens: total.output },
  });
  return 0;
}

// ---- which one ----

const [, , which, ...argv] = process.argv;
// stopped as a harness is: at once, its tools with it (they're in its process group)
process.on('SIGTERM', () => process.exit(143));
const run = which === 'claude' ? claude : which === 'codex' ? codex : null;
if (!run) {
  console.error('The stand-in is started as `claude` or `codex`, then that program’s own arguments.');
  process.exit(2);
}
run(argv).then(
  (code) => {
    process.exitCode = code;
  },
  (err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exitCode = 1;
  },
);
