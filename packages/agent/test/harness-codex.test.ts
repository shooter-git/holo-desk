import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { refusedRequest } from '../src/harness/adapter.ts';
import {
  CODEX_DISABLED,
  codexDefaults,
  codexHarness,
  codexReader,
  codexSealedTools,
  parseCodexAuth,
  parseCodexLogin,
  parseCodexModels,
} from '../src/harness/codex.ts';
import { GIT_ENV } from '../src/harness/env.ts';
import { FAILED_ONCE_FILE } from '../src/harness/workspace.ts';
import {
  alive,
  collect,
  FIXTURES,
  fakeBinary,
  fixtureEvents,
  job,
  PROMPT_MARK,
  q,
  REPO,
  recorded,
  replay,
  runToEnd,
  type Sandbox,
  sandbox,
  TOKEN,
  until,
} from './fakes.ts';

const MODELS = JSON.stringify({
  models: [
    {
      slug: 'gpt-6-sol',
      visibility: 'list',
      priority: 4,
      default_reasoning_level: 'medium',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort })),
    },
    {
      slug: 'gpt-6-luna',
      visibility: 'list',
      // first in the catalog's order, though not in its list: Codex's default
      priority: 2,
      default_reasoning_level: 'low',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort })),
    },
    { slug: 'gpt-5.5', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
    {
      slug: 'codex-auto-review',
      visibility: 'hide',
      priority: 1,
      default_reasoning_level: 'low',
      supported_reasoning_levels: [{ effort: 'low' }],
    },
  ],
});

const DEVICE = `Welcome to Codex [v0.167.1]
Follow these steps to sign in with ChatGPT using device code authorization:

1. Open this link in your browser and sign in to your account
   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

2. Enter this one-time code after you are signed in (expires in 15 minutes)
   \u001b[94mABCD-12345\u001b[0m

Continue only if you started this login in Codex.`;

let s: Sandbox;
afterEach(() => s?.cleanup());

function fake(o: { run?: string; signedIn?: boolean; sealed?: 'sealed' | 'loose' } = {}) {
  const signed = q(join(s.rec, 'signed-in'));
  if (o.signedIn) writeFileSync(join(s.rec, 'signed-in'), '');
  const path = fakeBinary(
    s,
    'codex',
    [
      { when: '--version', run: 'echo "codex-cli 0.167.1"; exit 0' },
      {
        when: 'login\\ status',
        run: `if [ -f ${signed} ]; then echo "Logged in using ChatGPT" >&2; exit 0; else echo "Not logged in" >&2; exit 1; fi`,
      },
      {
        when: 'login\\ --device-auth',
        run: `touch ${q(join(s.rec, 'login-ran'))}; printf '%s\\n' ${q(DEVICE)}; sleep 0.3; touch ${signed}; echo "Successfully logged in."; exit 0`,
      },
      { when: 'debug\\ models*', run: `echo ${q(MODELS)}; exit 0` },
      {
        when: 'debug\\ prompt-input*',
        run: `printf '%s' "$*" > ${q(join(s.rec, 'probe-args'))}; env -0 > ${q(join(s.rec, 'probe-env'))}; cat ${q(join(FIXTURES, `codex-prompt-input-${o.sealed ?? 'sealed'}.json`))}; exit 0`,
      },
      { when: 'update', run: 'echo "Updating Codex to 0.170.0"; exit 0' },
    ],
    o.run ??
      `case "$*" in exec\\ resume*) ${replay('codex-resume')};; *) ${replay('codex-normal')};; esac
exit 0`,
  );
  return codexHarness({
    env: { ...s.env, HOLO_CODEX: path, OPENAI_API_KEY: 'sk-openai-test', ANTHROPIC_API_KEY: 'sk-ant-nope' },
    root: s.root,
    repo: REPO,
    // the recorded streams never call finish: no turn is carried on to ask for it
    askToFinish: false,
    fetchText: async (url) => {
      if (url === 'https://registry.npmjs.org/@openai/codex/latest') return JSON.stringify({ version: '0.170.0' });
      throw new Error(`unexpected ${url}`);
    },
  });
}

describe('Codex: finding it', () => {
  it('reports its version, sign-in, seal, models (offered ones), efforts and an update', async () => {
    s = sandbox();
    expect(await fake({ signedIn: true }).info()).toEqual({
      id: 'codex',
      name: 'Codex',
      found: true,
      version: '0.167.1',
      signedIn: true,
      account: 'ChatGPT',
      sealed: true,
      models: ['gpt-6-sol', 'gpt-6-luna', 'gpt-5.5'],
      // "ultra" delegates to sub-agents, which a sealed run doesn't have
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      // not every model takes them all: each model's own
      modelEfforts: {
        'gpt-6-sol': ['low', 'medium', 'high', 'xhigh', 'max'],
        'gpt-6-luna': ['low', 'medium', 'high', 'xhigh', 'max'],
        'gpt-5.5': ['low', 'medium'],
      },
      // what a run given none uses: the listed model first in the catalog's order, and each one's own effort
      defaultModel: 'gpt-6-luna',
      defaultEfforts: { 'gpt-6-sol': 'medium', 'gpt-6-luna': 'low' },
      update: { available: true, latest: '0.170.0' },
    });
  });

  it('checks the seal with an empty CODEX_HOME of its own and the run’s switches', async () => {
    s = sandbox();
    await fake().info();
    const args = readFileSync(join(s.rec, 'probe-args'), 'utf8');
    for (const f of CODEX_DISABLED) expect(args).toContain(`-c features.${f}=false`);
    // never as --disable, which stops Codex on a name it no longer has
    expect(args).not.toContain('--disable');
    expect(args).toContain('features.multi_agent_v2.disable_native_tools=true');
    const env = readFileSync(join(s.rec, 'probe-env'), 'utf8').split('\0');
    expect(env).toContain(`CODEX_HOME=${join(s.root, '.codex-probe')}`);
    // the probe too: git never over ssh, no ssh agent, no scripts folders
    expect(env).toContain('GIT_SSH_COMMAND=false');
    expect(env).toContain(`PATH=${s.path}`);
    expect(env.some((e) => e.startsWith('SSH_'))).toBe(false);
    expect(statSync(join(s.root, '.codex-probe')).mode & 0o777).toBe(0o700);
  });

  it('isn’t offered when its model would get more than HO[LO]’s tools', async () => {
    s = sandbox();
    const info = await fake({ sealed: 'loose' }).info();
    expect(info.sealed).toBe(false);
    expect(info.reason).toContain('exec_command');
  });

  it('takes the message tool Codex 0.169.1 gives the model, and nothing else new', () => {
    const items = JSON.parse(readFileSync(join(FIXTURES, 'codex-prompt-input-sealed.json'), 'utf8')) as {
      type: string;
      tools?: object[];
    }[];
    const withTool = (name: string) =>
      JSON.stringify(
        items.map((i) =>
          i.type === 'additional_tools' ? { ...i, tools: [...(i.tools ?? []), { type: 'function', name }] } : i,
        ),
      );
    // it only talks to the user, as request_user_input_async does; its feature switch doesn't remove it
    expect(codexSealedTools(withTool('send_message_to_user_async'))).toEqual({ sealed: true });
    expect(codexSealedTools(withTool('send_files_somewhere'))).toEqual({
      sealed: false,
      reason: 'This Codex gives the model tools HO[LO] can’t turn off (send_files_somewhere)',
    });
  });

  it('checks the seal again when what it remembers was checked under other rules', async () => {
    s = sandbox();
    mkdirSync(s.root, { recursive: true });
    // what an older runner found for this version, before it allowed a tool
    const notes = join(s.root, '.harnesses.json');
    writeFileSync(
      notes,
      JSON.stringify({ 'sealed:codex': { version: '0.167.1', sealed: false, reason: 'old rules' } }),
    );
    expect(await fake().info()).toMatchObject({ sealed: true });
    expect(existsSync(join(s.rec, 'probe-args'))).toBe(true);
    // checked under these rules: remembered, not probed again
    rmSync(join(s.rec, 'probe-args'));
    expect(await fake().info()).toMatchObject({ sealed: true });
    expect(existsSync(join(s.rec, 'probe-args'))).toBe(false);
  });

  it('reads the recorded tool lists, status, models and the device sign-in', () => {
    const sealed = readFileSync(join(FIXTURES, 'codex-prompt-input-sealed.json'), 'utf8');
    expect(codexSealedTools(sealed)).toEqual({ sealed: true });
    const loose = codexSealedTools(readFileSync(join(FIXTURES, 'codex-prompt-input-loose.json'), 'utf8'));
    expect(loose.sealed).toBe(false);
    expect(codexSealedTools('[]').sealed).toBe(false);
    expect(parseCodexAuth('Logged in using ChatGPT\n')).toEqual({ signedIn: true, account: 'ChatGPT' });
    expect(parseCodexAuth('Not logged in\n')).toEqual({ signedIn: false });
    expect(parseCodexModels(MODELS).map((m) => m.slug)).toEqual(['gpt-6-sol', 'gpt-6-luna', 'gpt-5.5']);
    // the lowest priority is the default; without priorities, the first listed; a tie keeps the list's order
    expect(
      codexDefaults([
        { slug: 'a', efforts: [] },
        { slug: 'b', efforts: [], effort: 'low' },
      ]),
    ).toEqual({
      model: 'a',
      efforts: { b: 'low' },
    });
    expect(
      codexDefaults([
        { slug: 'a', efforts: [], priority: 3 },
        { slug: 'b', efforts: [], priority: 2 },
        { slug: 'c', efforts: [], priority: 2 },
      ]).model,
    ).toBe('b');
    expect(codexDefaults([])).toEqual({ efforts: {} });
    expect(parseCodexLogin(DEVICE)).toEqual({ url: 'https://auth.openai.com/codex/device', code: 'ABCD-12345' });
  });
});

describe('Codex: a sealed run', () => {
  it('passes the prompt on stdin only, the allowlisted environment, and HO[LO]’s server through -c', async () => {
    s = sandbox();
    const j = job(s, { model: 'gpt-6-luna', effort: 'low' });
    const events = await runToEnd(fake({ signedIn: true }), j);
    expect(events).toEqual([
      { type: 'session', session: '01a1cbcd-f893-71a1-aa67-6013e3fe50b3' },
      { type: 'progress', line: 'Working' },
      { type: 'done', reply: 'spike-42 — yellow.' },
    ]);
    const r = recorded(s);
    expect(r.argv.join(' ')).not.toContain('PROMPT-MARK');
    expect(r.argv.join(' ')).not.toContain(TOKEN);
    expect(r.stdin).toBe(`${PROMPT_MARK}\n`);
    expect(r.cwd).toBe(j.workspace);
    const server = {
      command: process.execPath,
      args: ['--disable-warning=ExperimentalWarning', join(REPO, 'packages', 'agent', 'src', 'mcp.ts')],
    };
    expect(r.argv).toEqual([
      'exec',
      '--json',
      '--skip-git-repo-check',
      '--ignore-user-config',
      '--ignore-rules',
      '--model=gpt-6-luna',
      '-c',
      'model_reasoning_effort="low"',
      '-c',
      'sandbox_mode="read-only"',
      '-c',
      'approval_policy="never"',
      '-c',
      'web_search="disabled"',
      '-c',
      'features.multi_agent_v2.disable_native_tools=true',
      '-c',
      'check_for_update_on_startup=false',
      '-c',
      'project_root_markers=[]',
      ...CODEX_DISABLED.flatMap((f) => ['-c', `features.${f}=false`]),
      '-c',
      `mcp_servers.holo.command=${JSON.stringify(server.command)}`,
      '-c',
      `mcp_servers.holo.args=${JSON.stringify(server.args)}`,
      '-c',
      `mcp_servers.holo.env={HOLO_URL="http://127.0.0.1:47999",HOLO_JOB="agj_0123456789ab",HOLO_JOB_TOKEN_FILE=${JSON.stringify(join(j.workspace, '.holo-job'))},HOLO_MIDDLE_C="C4"}`,
      '-c',
      'mcp_servers.holo.tool_timeout_sec=240',
      '-c',
      'mcp_servers.holo.startup_timeout_sec=20',
      '-c',
      'mcp_servers.holo.default_tools_approval_mode="approve"',
      '--sandbox=read-only',
      `--cd=${j.workspace}`,
      '-',
    ]);
    expect(r.env).toEqual({
      PATH: s.path,
      HOME: s.home,
      LANG: 'C.UTF-8',
      OPENAI_API_KEY: 'sk-openai-test',
      ...GIT_ENV,
    });
    expect(r.tokenMode).toBe('600');
    // the agent's instructions as the workspace's AGENTS.md
    expect(readFileSync(join(j.workspace, 'AGENTS.md'), 'utf8')).toBe('# Rules\nWork on the open song only.\n');
    expect(statSync(join(j.workspace, 'AGENTS.md')).mode & 0o777).toBe(0o600);
    expect(existsSync(join(s.home, '.codex'))).toBe(false);
  });

  it('carries a thread on with exec resume (no --sandbox or --cd)', async () => {
    s = sandbox();
    const events = await runToEnd(fake(), job(s, { session: '01a1cbcd-f893-71a1-aa67-6013e3fe50b3' }));
    const argv = recorded(s).argv;
    expect(argv.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(argv.slice(-2)).toEqual(['01a1cbcd-f893-71a1-aa67-6013e3fe50b3', '-']);
    expect(argv.some((a) => a.startsWith('--sandbox') || a.startsWith('--cd'))).toBe(false);
    expect(argv).toContain('sandbox_mode="read-only"');
    expect(events.at(-1)).toEqual({ type: 'done', reply: 'spike-42; yellow.' });
    // AGENTS.md reaches it only when a thread starts: a resumed one has the rules as they are now first
    expect(recorded(s).stdin).toBe(`# Rules\nWork on the open song only.\n\n${PROMPT_MARK}\n`);
  });

  it('starts the thread again when Codex no longer has it', async () => {
    s = sandbox();
    const h = fake({
      run: `case "$*" in exec\\ resume*) echo "Error: thread/resume: thread/resume failed: no rollout found for thread id x" >&2; exit 1;; esac
${replay('codex-normal')}`,
    });
    const events = await runToEnd(h, job(s, { session: 'gone-thread' }));
    expect(recorded(s, 1).argv[1]).not.toBe('resume');
    // a new thread reads the rules from AGENTS.md: the prompt alone
    expect(recorded(s, 1).stdin).toBe(`${PROMPT_MARK}\n`);
    expect(events.at(-1)?.type).toBe('done');
  });

  it('checks the effort against the model’s', async () => {
    s = sandbox();
    const h = fake();
    await runToEnd(h, job(s, { model: 'gpt-5.5', effort: 'max' }));
    expect(recorded(s, 0).argv.some((a) => a.startsWith('model_reasoning_effort'))).toBe(false);
    await runToEnd(h, job(s, { model: 'gpt-6-sol', effort: 'xhigh' }));
    expect(recorded(s, 1).argv).toContain('model_reasoning_effort="xhigh"');
    expect(await h.efforts('gpt-5.5')).toEqual(['low', 'medium']);
  });

  it('stops at the tripwire (any item but its own and HO[LO]’s calls) and ends the process group', async () => {
    s = sandbox();
    const shell = JSON.stringify({
      type: 'item.started',
      item: { id: 'item_1', type: 'command_execution', command: 'ls ~' },
    });
    const h = fake({
      run: `sleep 300 & echo $! > ${q(join(s.rec, 'bg'))}
${replay('codex-shell')} | head -2
echo ${q(shell)}
sleep 300`,
    });
    const events = await runToEnd(h, job(s));
    expect(events.at(-1)).toEqual({
      type: 'failed',
      error: 'Stopped: Codex used something other than HO[LO]’s tools (command_execution)',
    });
    const bg = Number(readFileSync(join(s.rec, 'bg'), 'utf8'));
    await until(() => !alive(bg));
  });

  it('stops when a refused attempt shows on stderr', async () => {
    s = sandbox();
    const h = fake({
      run: `${replay('codex-write-rejected')} | head -2
echo "2026-11-11T18:10:00Z ERROR codex_core::tools::router: error=patch rejected: writing is blocked by read-only sandbox" >&2
sleep 300`,
    });
    const events = await runToEnd(h, job(s));
    expect(events.at(-1)).toEqual({ type: 'failed', error: 'Stopped: Codex tried a tool that isn’t HO[LO]’s' });
  });

  it('reads every recorded stream as the spike saw it', () => {
    const read = (name: string) => {
      const r = codexReader();
      return fixtureEvents(name).flatMap((e) => r.event(e));
    };
    expect(read('codex-normal')).toEqual([
      { kind: 'session', id: '01a1cbcd-f893-71a1-aa67-6013e3fe50b3' },
      { kind: 'text', text: 'I’ll call the echo tool first, then request and inspect the image it returns.' },
      { kind: 'tool', name: 'echo' },
      { kind: 'tool', name: 'image' },
      { kind: 'text', text: 'spike-42 — yellow.' },
      { kind: 'ended' },
    ]);
    for (const name of [
      'codex-resume',
      'codex-shell',
      'codex-timeout',
      'codex-write-rejected',
      'codex-mcp-approval-required',
    ])
      expect(
        read(name).some((x) => x.kind === 'trip'),
        name,
      ).toBe(false);
    expect(
      codexReader().event({ type: 'item.started', item: { type: 'mcp_tool_call', server: 'other', tool: 'x' } }),
    ).toEqual([{ kind: 'trip', why: 'Codex called a tool of another server (other)' }]);
    expect(codexReader().event({ type: 'turn.failed', error: { message: 'usage limit' } })).toEqual([
      { kind: 'failed', error: 'usage limit' },
      { kind: 'ended' },
    ]);
    // a failed call of HO[LO]'s own on stderr is no tripwire
    expect(codexReader().stderr?.('ERROR codex_core::tools::router: error=tool call failed for `holo/slow`')).toEqual(
      [],
    );
  });

  it('says why a run failed', async () => {
    s = sandbox();
    const h = fake({
      run: `echo '{"type":"thread.started","thread_id":"t1"}'
echo '{"type":"error","message":"unexpected status 401 Unauthorized"}'
exit 1`,
    });
    expect((await runToEnd(h, job(s))).at(-1)).toEqual({ type: 'failed', error: 'unexpected status 401 Unauthorized' });
  });
});

/**
 * Recorded from Codex 0.167.1, run as a sealed run is, against a stand-in for the OpenAI Responses API
 * that answered as it does (docs/agent-harnesses.md, "A refused conversation"). What each `turn.failed`
 * says.
 */
const FAILED = {
  'codex-refused-tool-output':
    '{"error":{"message":"No tool output found for function call call_MockMockMockMock.","type":"invalid_request_error","param":"input","code":null}}',
  'codex-refused-invalid':
    '{"error":{"message":"Invalid \'input[3].name\': string does not match pattern. Expected a string that matches the pattern \'^[a-zA-Z0-9_-]+$\'.","type":"invalid_request_error","param":"input[3].name","code":"invalid_value"}}',
  'codex-refused-too-long':
    '{"error":{"message":"Your input exceeds the context window of this model. Please adjust your input and try again.","type":"invalid_request_error","param":"input","code":"context_length_exceeded"}}',
  'codex-context-window':
    "Codex ran out of room in the model's context window. Start a new thread or clear earlier history before retrying.",
  'codex-quota': 'Quota exceeded. Check your plan and billing details.',
  'codex-unauthorized':
    'unexpected status 401 Unauthorized: Incorrect API key provided: dummy. You can find your API key at https://platform.openai.com/account/api-keys., url: http://127.0.0.1:47911/v1/responses, request id: req_mock',
  'codex-model-chatgpt':
    '{"detail":"The \'gpt-holo-nope\' model is not supported when using Codex with a ChatGPT account."}',
  'codex-model-missing': 'The model `gpt-holo-nope` does not exist or you do not have access to it.',
  'codex-rate-limited': 'exceeded retry limit, last status: 429 Too Many Requests, request id: req_mock',
  'codex-refused-websocket':
    '{"type":"error","status":400,"error":{"type":"invalid_request_error","code":null,"message":"No tool output found for function call call_MockMockMockMock.","param":"input"}}',
} as const;

describe('Codex: a conversation its model service refused', () => {
  const OLD = '01a1cbcd-f893-71a1-aa67-6013e3fe50b3';
  const runs = () => [0, 1, 2, 3, 4].filter((n) => existsSync(join(s.rec, `argv${n}`))).length;
  const threadOf = (name: string) => fixtureEvents(name).find((e) => e.type === 'thread.started')?.thread_id;
  /** A resumed run that prints `stream` and fails as Codex does (exit 1); a new one goes well. */
  const resumed = (stream: string) =>
    fake({
      signedIn: true,
      run: `case "$*" in exec\\ resume*) cat <<'EOF'\n${stream}\nEOF\nexit 1;; *) ${replay('codex-normal')};; esac\nexit 0`,
    });
  const lines = (name: string) =>
    readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
      .trim()
      .split('\n');
  /**
   * Not recorded as one: the recorded refusal with one of HO[LO]'s calls first (the stand-in API never
   * asked for one), the call as the recorded normal run has it.
   */
  const afterACall = (name: string) => {
    const [started, turn, ...rest] = lines(name);
    const call = lines('codex-normal').filter((l) => l.includes('"mcp_tool_call"') && l.includes('"echo"'));
    return [started, turn, ...call, ...rest].join('\n');
  };
  /**
   * Not recorded: a recorded stream with its error in another form: `unexpected status 400 Bad Request: `
   * and the body's message, as Codex shows every other status (and might show a 400).
   */
  const withError = (stream: string, message: string) =>
    stream
      .split('\n')
      .map((l) => {
        const e = JSON.parse(l) as Record<string, unknown>;
        if (e.type === 'error') e.message = message;
        if (e.type === 'turn.failed') e.error = { message };
        return JSON.stringify(e);
      })
      .join('\n');

  it('reads each recorded failure as the error its turn.failed says, with no tripwire', () => {
    for (const [name, error] of Object.entries(FAILED)) {
      const r = codexReader();
      const seen = fixtureEvents(name).flatMap((e) => r.event(e));
      expect(
        seen.filter((x) => x.kind === 'failed'),
        name,
      ).toEqual([{ kind: 'failed', error }]);
      expect(
        seen.some((x) => x.kind === 'trip'),
        name,
      ).toBe(false);
    }
  });

  it('starts it again as a new thread, once, when the turn hadn’t called a tool yet', async () => {
    s = sandbox();
    const events = await runToEnd(resumed(lines('codex-refused-tool-output').join('\n')), job(s, { session: OLD }));
    expect(runs()).toBe(2);
    expect(recorded(s, 0).argv.slice(0, 2)).toEqual(['exec', 'resume']);
    expect(recorded(s, 1).argv[1]).not.toBe('resume');
    // a new thread reads the rules from AGENTS.md: the prompt alone
    expect(recorded(s, 1).stdin).toBe(`${PROMPT_MARK}\n`);
    expect(events[0]).toEqual({ type: 'session', session: threadOf('codex-refused-tool-output') });
    expect(events.at(-1)).toEqual({ type: 'done', reply: 'spike-42 — yellow.' });
    expect(events.some((e) => e.type === 'failed')).toBe(false);
  });

  it('knows a 400 over its WebSocket, as recorded: the error event as it came', async () => {
    s = sandbox();
    const events = await runToEnd(resumed(lines('codex-refused-websocket').join('\n')), job(s, { session: OLD }));
    expect(runs()).toBe(2);
    expect(recorded(s, 1).argv[1]).not.toBe('resume');
    expect(events.at(-1)).toEqual({ type: 'done', reply: 'spike-42 — yellow.' });
    s.cleanup();
    s = sandbox();
    expect((await runToEnd(resumed(afterACall('codex-refused-websocket')), job(s, { session: OLD }))).at(-1)).toEqual({
      type: 'failed',
      error: FAILED['codex-refused-websocket'],
      fresh: true,
    });
  });

  it('knows a 400 with the status first and the body’s message, and keeps the account’s and the model’s', async () => {
    const tail = ', url: https://chatgpt.com/backend-api/codex/responses, request id: req_0123456789';
    for (const message of [
      'No tool output found for function call call_abc.',
      "Invalid 'input[3].name': string does not match pattern. Expected a string that matches the pattern '^[a-zA-Z0-9_-]+$'.",
    ]) {
      s = sandbox();
      const said = `unexpected status 400 Bad Request: ${message}${tail}`;
      const events = await runToEnd(
        resumed(withError(afterACall('codex-refused-tool-output'), said)),
        job(s, { session: OLD }),
      );
      expect(events.at(-1), message).toEqual({ type: 'failed', error: said, fresh: true });
      s.cleanup();
    }
    for (const message of [
      'You exceeded your current quota, please check your plan and billing details.',
      'Your organization must have a payment method on file. Add one in Billing settings.',
      'The model `gpt-6` does not exist or you do not have access to it.',
      "The 'gpt-6' model is not supported when using Codex with a ChatGPT account.",
    ]) {
      s = sandbox();
      const said = `unexpected status 400 Bad Request: ${message}${tail}`;
      const events = await runToEnd(
        resumed(withError(lines('codex-refused-tool-output').join('\n'), said)),
        job(s, { session: OLD }),
      );
      expect(events.at(-1), message).toEqual({ type: 'failed', error: said });
      expect(runs(), message).toBe(1);
      s.cleanup();
    }
    // a refused sign-in, as Codex adds it
    expect(
      refusedRequest(
        'codex',
        `unexpected status 400 Bad Request: Bad request${tail}, auth error: missing_authorization_header, auth error code: token_expired`,
      ),
    ).toBe(false);
  });

  it('fails a turn that had called a tool, saying the next starts a new thread (a broken history, too long)', async () => {
    for (const name of ['codex-refused-invalid', 'codex-refused-too-long'] as const) {
      s = sandbox();
      expect(await runToEnd(resumed(afterACall(name)), job(s, { session: OLD })), name).toEqual([
        { type: 'session', session: threadOf(name) },
        { type: 'progress', line: 'Working' },
        { type: 'failed', error: FAILED[name], fresh: true },
      ]);
      expect(runs(), name).toBe(1);
      s.cleanup();
    }
  });

  it('keeps the thread for an ordinary failure, and for its context window once: Codex compacts it next turn', async () => {
    for (const name of [
      'codex-context-window',
      'codex-quota',
      'codex-unauthorized',
      'codex-model-chatgpt',
      'codex-model-missing',
      'codex-rate-limited',
    ] as const) {
      s = sandbox();
      const events = await runToEnd(resumed(lines(name).join('\n')), job(s, { session: OLD }));
      expect(events.at(-1), name).toEqual({ type: 'failed', error: FAILED[name] });
      expect(runs(), name).toBe(1);
      s.cleanup();
    }
  });

  describe('its context window, again', () => {
    const SID = String(threadOf('codex-context-window'));
    const overflow = () => lines('codex-context-window').join('\n');
    const failedOnce = (j: ReturnType<typeof job>) => {
      const file = join(j.workspace, FAILED_ONCE_FILE);
      return existsSync(file) ? readFileSync(file, 'utf8') : null;
    };

    it('keeps the thread the first time, and starts a new one when it fails so again, resumed, before a tool', async () => {
      s = sandbox();
      const first = job(s, { session: SID });
      expect(await runToEnd(resumed(overflow()), first)).toEqual([
        { type: 'session', session: SID },
        { type: 'failed', error: FAILED['codex-context-window'] },
      ]);
      expect(failedOnce(first)).toBe(SID);
      const events = await runToEnd(resumed(overflow()), job(s, { session: SID }));
      // the second turn: its resumed run, then a new thread at once
      expect(runs()).toBe(3);
      expect(recorded(s, 1).argv.slice(0, 2)).toEqual(['exec', 'resume']);
      expect(recorded(s, 2).argv[1]).not.toBe('resume');
      expect(recorded(s, 2).stdin).toBe(`${PROMPT_MARK}\n`);
      expect(events.at(-1)).toEqual({ type: 'done', reply: 'spike-42 — yellow.' });
      expect(failedOnce(first)).toBeNull();
    });

    it('fails the second, after a tool, saying the next starts a new thread', async () => {
      s = sandbox();
      await runToEnd(resumed(afterACall('codex-context-window')), job(s, { session: SID }));
      expect((await runToEnd(resumed(afterACall('codex-context-window')), job(s, { session: SID }))).at(-1)).toEqual({
        type: 'failed',
        error: FAILED['codex-context-window'],
        fresh: true,
      });
      expect(runs()).toBe(2);
    });

    it('counts only twice in a row, in the same thread', async () => {
      s = sandbox();
      // a turn that went well between them
      await runToEnd(resumed(overflow()), job(s, { session: SID }));
      await runToEnd(fake({ signedIn: true }), job(s, { session: SID }));
      expect(failedOnce(job(s))).toBeNull();
      expect((await runToEnd(resumed(overflow()), job(s, { session: SID }))).at(-1)).toEqual({
        type: 'failed',
        error: FAILED['codex-context-window'],
      });
      // another failure between them
      await runToEnd(resumed(lines('codex-quota').join('\n')), job(s, { session: SID }));
      expect((await runToEnd(resumed(overflow()), job(s, { session: SID }))).at(-1)).toEqual({
        type: 'failed',
        error: FAILED['codex-context-window'],
      });
      // the first in another thread: the one noted is the thread it failed in
      expect((await runToEnd(resumed(overflow()), job(s, { session: OLD }))).at(-1)).toEqual({
        type: 'failed',
        error: FAILED['codex-context-window'],
      });
    });
  });

  it('knows a refusal by the API’s own body, as Codex shows it, and nothing else as one', () => {
    for (const said of [
      FAILED['codex-refused-tool-output'],
      FAILED['codex-refused-invalid'],
      FAILED['codex-refused-too-long'],
      // by its source (0.171.0): a 400 over its WebSocket shows the error event as it came
      '{"type":"error","status":400,"error":{"type":"invalid_request_error","message":"No tool output found for function call call_abc."}}',
      FAILED['codex-refused-websocket'],
      // the status first: an older Codex, with the body; or the body's message, as it shows other statuses
      'unexpected status 400 Bad Request: {"error":{"message":"No tool output found for function call call_abc.","type":"invalid_request_error","param":"input","code":null}}',
      'unexpected status 400 Bad Request: No tool output found for function call call_abc., url: https://chatgpt.com/backend-api/codex/responses',
    ])
      expect(refusedRequest('codex', said), said).toBe(true);
    for (const said of [
      FAILED['codex-context-window'],
      FAILED['codex-quota'],
      FAILED['codex-unauthorized'],
      FAILED['codex-model-chatgpt'],
      FAILED['codex-model-missing'],
      FAILED['codex-rate-limited'],
      'Invalid prompt: your prompt was flagged as potentially violating our usage policy.',
      '{"error":{"message":"The model `gpt-6` does not exist or you do not have access to it.","type":"invalid_request_error","param":null,"code":"model_not_found"}}',
      // a setting the model doesn't take: another thread is sent it too
      '{"error":{"message":"Unsupported parameter: \'reasoning.effort\' is not supported with this model.","type":"invalid_request_error","param":"reasoning.effort","code":"unsupported_parameter"}}',
      '{"error":{"message":"You exceeded your current quota, please check your plan and billing details.","type":"invalid_request_error","param":null,"code":null}}',
      // a 400 seen in a tool's answer is the tool's, not the API's
      'HTTP 400: {"error":{"type":"invalid_request_error"}}',
    ])
      expect(refusedRequest('codex', said), said).toBe(false);
  });
});

describe('Codex: signing in and updating', () => {
  it('relays the device link and its one-time code', async () => {
    s = sandbox();
    const { events, on } = collect();
    await fake().login(on);
    expect(events).toContainEqual({
      state: 'running',
      url: 'https://auth.openai.com/codex/device',
      code: 'ABCD-12345',
    });
    expect(events.at(-1)).toEqual({ state: 'done', line: 'Codex is signed in' });
  });

  it('never signs in over an account that’s signed in', async () => {
    s = sandbox();
    const { events, on } = collect();
    await fake({ signedIn: true }).login(on);
    expect(events).toEqual([{ state: 'failed', error: 'Codex is signed in already' }]);
    expect(existsSync(join(s.rec, 'login-ran'))).toBe(false);
  });

  it('runs its own updater when asked', async () => {
    s = sandbox();
    const lines: string[] = [];
    await fake().update((l) => lines.push(l));
    expect(lines).toEqual(['Updating Codex to 0.170.0']);
  });
});
