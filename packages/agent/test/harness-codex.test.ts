import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CODEX_DISABLED,
  codexHarness,
  codexReader,
  codexSealedTools,
  parseCodexAuth,
  parseCodexLogin,
  parseCodexModels,
} from '../src/harness/codex.ts';
import { GIT_ENV } from '../src/harness/env.ts';
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
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'].map((effort) => ({ effort })),
    },
    {
      slug: 'gpt-6-luna',
      visibility: 'list',
      supported_reasoning_levels: ['low', 'medium', 'high', 'xhigh', 'max'].map((effort) => ({ effort })),
    },
    { slug: 'gpt-5.5', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }, { effort: 'medium' }] },
    { slug: 'codex-auto-review', visibility: 'hide', supported_reasoning_levels: [{ effort: 'low' }] },
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
      update: { available: true, latest: '0.170.0' },
    });
  });

  it('checks the seal with an empty CODEX_HOME of its own and the run’s switches', async () => {
    s = sandbox();
    await fake().info();
    const args = readFileSync(join(s.rec, 'probe-args'), 'utf8');
    for (const f of CODEX_DISABLED) expect(args).toContain(`--disable ${f}`);
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

  it('reads the recorded tool lists, status, models and the device sign-in', () => {
    const sealed = readFileSync(join(FIXTURES, 'codex-prompt-input-sealed.json'), 'utf8');
    expect(codexSealedTools(sealed)).toEqual({ sealed: true });
    const loose = codexSealedTools(readFileSync(join(FIXTURES, 'codex-prompt-input-loose.json'), 'utf8'));
    expect(loose.sealed).toBe(false);
    expect(codexSealedTools('[]').sealed).toBe(false);
    expect(parseCodexAuth('Logged in using ChatGPT\n')).toEqual({ signedIn: true, account: 'ChatGPT' });
    expect(parseCodexAuth('Not logged in\n')).toEqual({ signedIn: false });
    expect(parseCodexModels(MODELS).map((m) => m.slug)).toEqual(['gpt-6-sol', 'gpt-6-luna', 'gpt-5.5']);
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
      ...CODEX_DISABLED.flatMap((f) => ['--disable', f]),
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
  });

  it('starts the thread again when Codex no longer has it', async () => {
    s = sandbox();
    const h = fake({
      run: `case "$*" in exec\\ resume*) echo "Error: thread/resume: thread/resume failed: no rollout found for thread id x" >&2; exit 1;; esac
${replay('codex-normal')}`,
    });
    const events = await runToEnd(h, job(s, { session: 'gone-thread' }));
    expect(recorded(s, 1).argv[1]).not.toBe('resume');
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
