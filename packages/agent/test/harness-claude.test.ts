import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { refusedRequest } from '../src/harness/adapter.ts';
import {
  CLAUDE_EFFORTS,
  claudeArgs,
  claudeEfforts,
  claudeHarness,
  claudeLimits,
  claudeModels,
  claudeReader,
  claudeUsage,
  parseClaudeAuth,
} from '../src/harness/claude.ts';
import { allowed, GIT_ENV } from '../src/harness/env.ts';
import type { Job } from '../src/harness/types.ts';
import {
  alive,
  job as anyJob,
  collect,
  fakeBinary,
  fixtureEvents,
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

const HELP = `Usage: claude [options] [command] [prompt]
  --allowedTools, --allowed-tools <tools...>
  --append-system-prompt <prompt>       Append a system prompt
  --disable-slash-commands
  --effort <level>                      Effort level for the current session (low, medium, high, xhigh, max)
  --mcp-config <configs...>
  --model <model>                       Model for the current session. Provide
                                        an alias for the latest model (e.g.
                                        'fable', 'opus', or 'sonnet') or a
                                        model's full name.
  --permission-mode <mode>
  -r, --resume [value]
  --setting-sources <sources>
  --settings <file-or-json>
  --strict-mcp-config
  --tools <tools...>`;

const SIGNED_IN = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  email: 'user@example.com',
  orgName: 'Org',
  subscriptionType: 'max',
});
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });

/** What the recorded run says it used (what it wrote to the cache counts as read anew). */
const USED = { input: 317, cached: 8636, output: 107 };
/** What its last `rate_limit_event` says the account has left: the week first. */
const LEFT = [
  {
    windows: [
      { minutes: 10080, used: 0.71, resets: 1794718800000 },
      { minutes: 300, used: 0.33, resets: 1794429600000 },
    ],
  },
];

let s: Sandbox;
afterEach(() => s?.cleanup());

/** A job with a model and an effort chosen, as Claude Code needs (it lists no defaults). */
const job = (sb: Sandbox, over: Partial<Job> = {}): Job => anyJob(sb, { model: 'haiku', effort: 'low', ...over });

interface Fake {
  run?: string;
  help?: string;
  signedIn?: boolean;
}

function fake(o: Fake = {}) {
  const signed = q(join(s.rec, 'signed-in'));
  if (o.signedIn) writeFileSync(join(s.rec, 'signed-in'), '');
  const path = fakeBinary(
    s,
    'claude',
    [
      { when: '--version', run: 'echo "2.1.322 (Claude Code)"; exit 0' },
      { when: '--help', run: `cat <<'EOF'\n${o.help ?? HELP}\nEOF\nexit 0` },
      {
        when: 'auth\\ status*',
        run: `if [ -f ${signed} ]; then echo ${q(SIGNED_IN)}; exit 0; else echo ${q(SIGNED_OUT)}; exit 1; fi`,
      },
      {
        when: 'auth\\ login',
        run: `touch ${q(join(s.rec, 'login-ran'))}
echo "Opening browser to sign in…"
echo "If the browser didn't open, visit: https://claude.ai/oauth/authorize?code=true&state=abc"
printf 'Paste code here if prompted > '
read code
printf '%s' "$code" > ${q(join(s.rec, 'pasted'))}
touch ${signed}
echo "Login successful."
exit 0`,
      },
      { when: 'update', run: 'echo "Current version: 2.1.322"; echo "Updating to 2.1.400…"; echo "Updated"; exit 0' },
    ],
    o.run ??
      `case "$*" in *--resume=*) ${replay('claude-resume')};; *) ${replay('claude-normal')};; esac
exit 0`,
  );
  return claudeHarness({
    env: { ...s.env, HOLO_CLAUDE: path, ANTHROPIC_API_KEY: 'sk-ant-test', OPENAI_API_KEY: 'sk-openai-nope' },
    root: s.root,
    repo: REPO,
    // the recorded streams never call finish: no turn is carried on to ask for it
    askToFinish: false,
    fetchText: async (url) => {
      if (url === 'https://downloads.claude.ai/claude-code-releases/stable') return '2.1.400\n';
      throw new Error(`unexpected ${url}`);
    },
  });
}

describe('Claude Code: its models and efforts', () => {
  it('reads the efforts `--help` lists for --effort, in either form, and the usual ones when it lists none', () => {
    expect(claudeEfforts(HELP)).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    expect(claudeEfforts('  --effort <level>   Effort level (low, high, ultra)\n  --model <m>')).toEqual([
      'low',
      'high',
      'ultra',
    ]);
    expect(
      claudeEfforts(
        '  --effort <level>   How hard it thinks\n                     (choices: "low", "medium", "turbo")',
      ),
    ).toEqual(['low', 'medium', 'turbo']);
    // the first parenthesis after --effort, never another option's
    expect(claudeEfforts('  --effort <level>   Effort level\n  --model <m>   (e.g. opus)')).toEqual([
      ...CLAUDE_EFFORTS,
    ]);
    expect(claudeEfforts('')).toEqual([...CLAUDE_EFFORTS]);
    // nothing that reads as more than a name
    expect(claudeEfforts('  --effort <l>  (low, rm -rf ~; x, MAX, max)')).toEqual(['low', 'max']);
  });

  it('reads them again at once when the version changes, and not before', async () => {
    s = sandbox();
    const version = join(s.rec, 'version');
    const help = join(s.rec, 'help');
    writeFileSync(version, '2.1.322 (Claude Code)\n');
    writeFileSync(help, HELP);
    const path = fakeBinary(
      s,
      'claude',
      [
        { when: '--version', run: `cat ${q(version)}; exit 0` },
        { when: '--help', run: `cat ${q(help)}; exit 0` },
        { when: 'auth\\ status*', run: `echo ${q(SIGNED_IN)}; exit 0` },
      ],
      'exit 0',
    );
    const h = claudeHarness({
      env: { ...s.env, HOLO_CLAUDE: path },
      root: s.root,
      repo: REPO,
      fetchText: async () => '2.1.400',
    });
    const first = await h.info();
    expect(first.models).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
    expect(first.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max']);
    const newer = HELP.replace("'fable', 'opus', or 'sonnet'", "'lyric', 'opus', or 'sonnet'").replace(
      '(low, medium, high, xhigh, max)',
      '(low, medium, high, xhigh, max, ultra)',
    );
    writeFileSync(help, newer);
    // the same version: what was read for it stands
    expect((await h.info(true)).efforts).toEqual(first.efforts);
    // a new version (an update, or one noticed at a look): read again at once
    writeFileSync(version, '2.1.400 (Claude Code)\n');
    const second = await h.info(true);
    expect(second.version).toBe('2.1.400');
    expect(second.models).toEqual(['lyric', 'opus', 'sonnet', 'haiku']);
    expect(second.efforts).toEqual(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
  });
});

describe('Claude Code: finding it', () => {
  it('reports its version, sign-in, seal, models, efforts and an update', async () => {
    s = sandbox();
    const info = await fake({ signedIn: true }).info();
    expect(info).toEqual({
      id: 'claude',
      name: 'Claude Code',
      found: true,
      version: '2.1.322',
      signedIn: true,
      account: 'user@example.com',
      plan: 'max',
      sealed: true,
      models: ['fable', 'opus', 'sonnet', 'haiku'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
      // it lists no defaults: a run needs both chosen
      mustChoose: true,
      update: { available: true, latest: '2.1.400' },
    });
  });

  it('says when it isn’t installed', async () => {
    s = sandbox();
    const h = claudeHarness({
      env: { ...s.env, PATH: s.dir, HOLO_CLAUDE: join(s.dir, 'nowhere') },
      root: s.root,
      repo: REPO,
    });
    const info = await h.info();
    expect(info).toMatchObject({ id: 'claude', found: false, sealed: false });
  });

  it('isn’t offered when it’s too old to be sealed', async () => {
    s = sandbox();
    const info = await fake({ help: '  --model <model>\n  --resume\n' }).info();
    expect(info.sealed).toBe(false);
    expect(info.reason).toContain('--strict-mcp-config');
  });

  it('reads auth status', () => {
    expect(parseClaudeAuth(SIGNED_IN)).toEqual({ signedIn: true, account: 'user@example.com', plan: 'max' });
    expect(parseClaudeAuth(SIGNED_OUT)).toEqual({ signedIn: false });
    expect(parseClaudeAuth('garbage')).toBeNull();
    expect(claudeModels(HELP)).toEqual(['fable', 'opus', 'sonnet', 'haiku']);
  });

  it('looks for an update at most every 6 hours', async () => {
    s = sandbox();
    let asked = 0;
    const path = fakeBinary(
      s,
      'claude',
      [{ when: '--version', run: 'echo "2.1.322 (Claude Code)"; exit 0' }],
      'exit 0',
    );
    const make = () =>
      claudeHarness({
        env: { ...s.env, HOLO_CLAUDE: path },
        root: s.root,
        repo: REPO,
        fetchText: async () => {
          asked++;
          return '2.1.322';
        },
      });
    expect(await make().checkUpdate()).toEqual({ available: false, latest: '2.1.322' });
    // another runner later the same day: what was looked up is remembered
    expect(await make().checkUpdate()).toEqual({ available: false, latest: '2.1.322' });
    expect(asked).toBe(1);
  });
});

describe('Claude Code: a sealed run', () => {
  it('passes the prompt on stdin only, the allowlisted environment, and HO[LO]’s server only', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    const j = job(s, { model: 'haiku', effort: 'low' });
    const events = await runToEnd(h, j);
    expect(events).toEqual([
      { type: 'session', session: 'c58564bc-c9a7-4e0d-ad72-6461accd9689' },
      { type: 'progress', line: 'Working' },
      // what the account has left, as the run said last
      { type: 'limits', limits: { at: expect.any(Number), groups: LEFT } },
      // what `haiku` stood for, as its init said
      { type: 'aliases', aliases: { haiku: 'claude-haiku-5-5' } },
      { type: 'done', reply: "Echoed: spike-42. Picture's main colour: blue.", usage: USED },
    ]);
    const r = recorded(s);
    // the prompt and the token never in argv
    expect(r.argv.join(' ')).not.toContain('PROMPT-MARK');
    expect(r.argv.join(' ')).not.toContain(TOKEN);
    expect(r.stdin).toBe(`${PROMPT_MARK}\n`);
    expect(r.cwd).toBe(j.workspace);
    expect(r.argv).toEqual([
      '-p',
      '--output-format=stream-json',
      '--verbose',
      '--model=haiku',
      '--effort=low',
      '--tools=',
      '--strict-mcp-config',
      `--mcp-config=${join(j.workspace, 'mcp.json')}`,
      '--allowedTools=mcp__holo__*',
      '--permission-mode=dontAsk',
      '--setting-sources=project',
      `--settings=${join(j.workspace, 'settings.json')}`,
      `--append-system-prompt-file=${join(j.workspace, 'instructions.md')}`,
      '--disable-slash-commands',
      '--no-chrome',
    ]);
    // exactly the allowlist (PATH without the scripts folders), its own sign-in, its switches and git's
    expect(r.env).toEqual({
      PATH: s.path,
      HOME: s.home,
      LANG: 'C.UTF-8',
      ANTHROPIC_API_KEY: 'sk-ant-test',
      DISABLE_AUTOUPDATER: '1',
      ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
      CLAUDE_CODE_DISABLE_CLAUDE_MDS: '1',
      ...GIT_ENV,
    });
    // the token file as the MCP server finds it
    expect(r.tokenMode).toBe('600');
    expect(r.token).toBe(TOKEN);
  });

  it('writes its workspace: private, HO[LO]’s MCP server with the token’s file (not the token)', async () => {
    s = sandbox();
    const j = job(s);
    await runToEnd(fake({ signedIn: true }), j);
    expect(statSync(j.workspace).mode & 0o777).toBe(0o700);
    for (const f of ['mcp.json', 'settings.json', 'instructions.md', '.holo-job'])
      expect(statSync(join(j.workspace, f)).mode & 0o777, f).toBe(0o600);
    const mcp = JSON.parse(readFileSync(join(j.workspace, 'mcp.json'), 'utf8'));
    expect(mcp).toEqual({
      mcpServers: {
        holo: {
          type: 'stdio',
          command: process.execPath,
          args: ['--disable-warning=ExperimentalWarning', join(REPO, 'packages', 'agent', 'src', 'mcp.ts')],
          env: {
            HOLO_URL: 'http://127.0.0.1:47999',
            HOLO_JOB: 'agj_0123456789ab',
            HOLO_JOB_TOKEN_FILE: join(j.workspace, '.holo-job'),
            HOLO_MIDDLE_C: 'C4',
          },
          timeout: 240000,
        },
      },
    });
    expect(readFileSync(join(j.workspace, 'mcp.json'), 'utf8')).not.toContain(TOKEN);
    expect(JSON.parse(readFileSync(join(j.workspace, 'settings.json'), 'utf8'))).toEqual({
      disableAllHooks: true,
      autoMemoryEnabled: false,
      disableClaudeAiConnectors: true,
    });
    expect(readFileSync(join(j.workspace, 'instructions.md'), 'utf8')).toBe('# Rules\nWork on the open song only.\n');
    // nothing was written in the (temporary) home: no ~/.claude
    expect(existsSync(join(s.home, '.claude'))).toBe(false);
  });

  it('carries a session on with --resume', async () => {
    s = sandbox();
    const events = await runToEnd(
      fake({ signedIn: true }),
      job(s, { session: 'c58564bc-c9a7-4e0d-ad72-6461accd9689' }),
    );
    expect(recorded(s).argv.at(-1)).toBe('--resume=c58564bc-c9a7-4e0d-ad72-6461accd9689');
    expect(events.at(-1)).toEqual({
      type: 'done',
      reply: 'Echoed "spike-42"; the picture was blue.',
      usage: { input: 79, cached: 4631, output: 20 },
    });
  });

  it('starts the conversation again when the session is gone', async () => {
    s = sandbox();
    const h = fake({
      run: `case "$*" in *--resume=*) echo "No conversation found with session ID: gone" >&2; exit 1;; esac
${replay('claude-normal')}`,
    });
    const events = await runToEnd(h, job(s, { session: 'gone-session' }));
    expect(recorded(s, 0).argv.at(-1)).toBe('--resume=gone-session');
    expect(recorded(s, 1).argv.join(' ')).not.toContain('--resume');
    expect(events[0]).toEqual({ type: 'session', session: 'c58564bc-c9a7-4e0d-ad72-6461accd9689' });
    expect(events.at(-1)?.type).toBe('done');
  });

  it('gives the conversation it starts again what one that never saw the last needs, when it was handed that', async () => {
    s = sandbox();
    const gone = `case "$*" in *--resume=*) echo "No conversation found with session ID: gone" >&2; exit 1;; esac
${replay('claude-normal')}`;
    await runToEnd(
      fake({ run: gone }),
      job(s, { session: 'gone-session', freshPrompt: 'THE CONVERSATION SO FAR, then the request\n' }),
    );
    expect(recorded(s, 0).stdin).toContain(PROMPT_MARK);
    expect(recorded(s, 1).stdin).toBe('THE CONVERSATION SO FAR, then the request\n');
    s.cleanup();
    // (without one, the turn's own prompt again, as before)
    s = sandbox();
    await runToEnd(fake({ run: gone }), job(s, { session: 'gone-session' }));
    expect(recorded(s, 1).stdin).toContain(PROMPT_MARK);
  });

  it('doesn’t run without a model and an effort it offers: it has no default to fall back on', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    await h.info();
    const choose = 'for Claude Code in Settings › Agent';
    expect(await runToEnd(h, job(s, { model: '', effort: '' }))).toEqual([
      { type: 'failed', error: `Choose a model and an effort ${choose}` },
    ]);
    expect(await runToEnd(h, job(s, { effort: '' }))).toEqual([
      { type: 'failed', error: `Choose an effort ${choose}` },
    ]);
    // one saved when an earlier version offered it
    expect(await runToEnd(h, job(s, { model: 'gone-model' }))).toEqual([
      { type: 'failed', error: `Claude Code no longer offers “gone-model”: choose a model ${choose}` },
    ]);
    expect(await runToEnd(h, job(s, { model: 'gone-model', effort: 'ultra' }))).toEqual([
      {
        type: 'failed',
        error: `Claude Code no longer offers “gone-model” or “ultra” effort: choose a model and an effort ${choose}`,
      },
    ]);
    expect(existsSync(join(s.rec, 'argv0'))).toBe(false);
    // both offered: passed on
    await runToEnd(h, job(s, { model: 'fable', effort: 'xhigh' }));
    expect(recorded(s, 0).argv).toContain('--model=fable');
    expect(recorded(s, 0).argv).toContain('--effort=xhigh');
  });

  it('remembers what an alias stood for at its last run, and says so when that’s news', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    expect((await h.info()).aliases).toBeUndefined();
    const events = await runToEnd(h, job(s));
    expect(events.filter((e) => e.type === 'aliases')).toEqual([
      { type: 'aliases', aliases: { haiku: 'claude-haiku-5-5' } },
    ]);
    expect(events.at(-1)?.type).toBe('done');
    expect((await h.info()).aliases).toEqual({ haiku: 'claude-haiku-5-5' });
    // the same again: nothing new to say
    expect((await runToEnd(h, job(s))).some((e) => e.type === 'aliases')).toBe(false);
  });

  it('forgets what another account’s runs said (another plan may have other models)', async () => {
    s = sandbox();
    mkdirSync(s.root, { recursive: true });
    writeFileSync(
      join(s.root, '.harnesses.json'),
      JSON.stringify({ 'aliases:claude': { account: 'someone@example.com', aliases: { opus: 'claude-opus-test' } } }),
    );
    expect((await fake({ signedIn: true }).info()).aliases).toBeUndefined();
  });

  it('refuses a model or effort that reads as more than a value, or an effort it doesn’t take', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    expect(await runToEnd(h, job(s, { model: 'haiku --dangerously-skip-permissions' }))).toEqual([
      { type: 'failed', error: '“haiku --dangerously-skip-permissions” isn’t a model name' },
    ]);
    expect(await runToEnd(h, job(s, { effort: '--tools=Bash' }))).toEqual([
      { type: 'failed', error: '“--tools=Bash” isn’t an effort' },
    ]);
    expect(await runToEnd(h, job(s, { effort: 'ultra' }))).toEqual([
      {
        type: 'failed',
        error: 'Claude Code no longer offers “ultra” effort: choose an effort for Claude Code in Settings › Agent',
      },
    ]);
    expect(existsSync(join(s.rec, 'argv0'))).toBe(false);
  });

  it('stops at the tripwire (a tool that isn’t HO[LO]’s) and ends the whole process group', async () => {
    s = sandbox();
    const h = fake({
      run: `sleep 300 & echo $! > ${q(join(s.rec, 'bg'))}
${replay('claude-shell-denied')}
sleep 300`,
    });
    const started = Date.now();
    const events = await runToEnd(h, job(s));
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(events).toEqual([
      { type: 'session', session: '8e7faa34-2d8d-4bd6-a6e4-b4468940ac1b' },
      { type: 'failed', error: 'Stopped: Claude Code offered a tool other than HO[LO]’s (Task)' },
    ]);
    const bg = Number(readFileSync(join(s.rec, 'bg'), 'utf8'));
    await until(() => !alive(bg));
  });

  it('stops when HO[LO]’s server didn’t connect, or another tool is used', () => {
    const r = claudeReader();
    const init = fixtureEvents('claude-normal')[0] as Record<string, unknown>;
    expect(r.event({ ...init, mcp_servers: [{ name: 'holo', status: 'failed' }] }).at(-1)).toEqual({
      kind: 'trip',
      why: 'HO[LO]’s tools didn’t start in Claude Code',
    });
    expect(
      claudeReader()
        .event({ ...init, mcp_servers: [...(init.mcp_servers as unknown[]), { name: 'gmail', status: 'connected' }] })
        .at(-1),
    ).toMatchObject({ kind: 'trip' });
    const ok = claudeReader();
    ok.event(init);
    expect(
      ok.event({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls' } }] },
      }),
    ).toEqual([{ kind: 'trip', why: 'Claude Code tried Bash, which isn’t HO[LO]’s' }]);
    // one of HO[LO]'s tools named without its prefix is a slip Claude Code refuses itself: no trip, and
    // the run goes on; a bare name HO[LO] doesn't have still trips
    const slip = claudeReader();
    slip.event({ ...init, tools: ['mcp__holo__track_add', 'mcp__holo__finish'] });
    expect(
      slip.event({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'track_add', input: {} }] } }),
    ).toEqual([]);
    expect(
      slip.event({
        type: 'assistant',
        message: { content: [{ type: 'tool_use', name: 'mcp__holo__track_add', input: {} }] },
      }),
    ).toEqual([{ kind: 'tool', name: 'track_add' }]);
    expect(
      slip.event({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Read', input: {} }] } }),
    ).toEqual([{ kind: 'trip', why: 'Claude Code tried Read, which isn’t HO[LO]’s' }]);
    // a tool before any init: not believed
    expect(claudeReader().event({ type: 'assistant', message: { content: [] } })[0]?.kind).toBe('trip');
  });

  it('reads every recorded stream as the spike saw it', () => {
    const read = (name: string) => {
      const r = claudeReader();
      return fixtureEvents(name).flatMap((e) => r.event(e));
    };
    expect(read('claude-normal')).toEqual([
      { kind: 'session', id: 'c58564bc-c9a7-4e0d-ad72-6461accd9689' },
      { kind: 'model', model: 'claude-haiku-5-5' },
      { kind: 'tool', name: 'echo' },
      { kind: 'tool', name: 'image' },
      // (as it said them: the five hours, then the week)
      { kind: 'limits', limits: { groups: [{ windows: [...(LEFT[0]?.windows ?? [])].reverse() }] } },
      { kind: 'text', text: "Echoed: spike-42. Picture's main colour: blue." },
      { kind: 'usage', usage: USED },
      { kind: 'ended' },
    ]);
    for (const name of ['claude-resume', 'claude-shell', 'claude-timeout'])
      expect(
        read(name).some((x) => x.kind === 'trip'),
        name,
      ).toBe(false);
    expect(read('claude-shell-denied').some((x) => x.kind === 'trip')).toBe(true);
  });

  it('builds the argv with the session last, and without instructions when there are none', () => {
    const args = claudeArgs(
      { model: '', effort: '', session: 'abc' },
      { mcp: '/w/mcp.json', settings: '/w/s.json', instructions: null },
    );
    expect(args.some((a) => a.startsWith('--append-system-prompt'))).toBe(false);
    expect(args.some((a) => a.startsWith('--model') || a.startsWith('--effort'))).toBe(false);
    expect(args.at(-1)).toBe('--resume=abc');
  });

  it('passes only allowlisted variables', () => {
    for (const ok of [
      'HOME',
      'PATH',
      'LANG',
      'LC_ALL',
      'TERM',
      'TMPDIR',
      'XDG_CONFIG_HOME',
      'HTTPS_PROXY',
      'no_proxy',
      'NODE_EXTRA_CA_CERTS',
      'ANTHROPIC_API_KEY',
      'CLAUDE_CONFIG_DIR',
    ])
      expect(allowed('claude', ok, 'linux'), ok).toBe(true);
    for (const no of [
      'OPENAI_API_KEY',
      'CURSOR_API_KEY',
      'GITHUB_TOKEN',
      'NODE_OPTIONS',
      'LD_PRELOAD',
      'SHELL',
      'HOLO_JOB',
      'AWS_SECRET_ACCESS_KEY',
      'SYSTEMROOT',
    ])
      expect(allowed('claude', no, 'linux'), no).toBe(false);
    expect(allowed('claude', 'SystemRoot', 'win32')).toBe(true);
  });
});

/**
 * Recorded from Claude Code 2.1.322, run as a sealed run is, against a stand-in for the Anthropic API
 * that answered as it does (docs/agent-harnesses.md, "A refused conversation"). What each result says.
 */
const SAID = {
  'claude-refused-history': 'API Error: 400 due to tool use concurrency issues.',
  'claude-refused-invalid': 'API Error: 400 messages.1.content.1.tool_use.input: Input should be a valid dictionary',
  'claude-refused-too-long': 'Prompt is too long',
  'claude-credit': 'Credit balance is too low',
  'claude-rate-limited':
    'API Error: Request rejected (429) · This request would exceed the rate limit for your organization of 50 requests per minute.',
  'claude-unauthorized': 'Invalid API key · Fix external API key',
  'claude-model-missing':
    "There's an issue with the selected model (claude-sonnet-4-6). It may not exist or you may not have access to it. Run --model to pick a different model.",
} as const;

/** Why each of those failed, where Claude Code's words make it plain. */
const WHY: Partial<Record<keyof typeof SAID, { why: 'usage' | 'signed-out' }>> = {
  'claude-credit': { why: 'usage' },
  'claude-unauthorized': { why: 'signed-out' },
};

describe('Claude Code: what the account has left', () => {
  it('reads a run’s rate_limit_event: the windows every model shares, and one model’s own week when it names it', () => {
    expect(
      claudeLimits({
        status: 'allowed',
        rateLimitType: 'five_hour',
        unifiedWindows: {
          five_hour: { utilization: 0.33, resetsAt: 1794429600, status: 'allowed' },
          seven_day: { utilization: 0.71, resetsAt: 1794718800 },
          // a window not known here is left out
          seven_day_overage_included: { utilization: 0.5, resetsAt: 1794718800 },
        },
      }),
    ).toEqual({
      groups: [
        {
          windows: [
            { minutes: 300, used: 0.33, resets: 1794429600000 },
            { minutes: 10080, used: 0.71, resets: 1794718800000 },
          ],
        },
      ],
    });
    // an older Claude Code names only the window nearest its limit
    expect(claudeLimits({ rateLimitType: 'seven_day', utilization: 0.9, resetsAt: 1794718800 })).toEqual({
      groups: [{ windows: [{ minutes: 10080, used: 0.9, resets: 1794718800000 }] }],
    });
    expect(
      claudeLimits({
        rateLimitType: 'seven_day_opus',
        utilization: 0.95,
        resetsAt: 1794718800,
        unifiedWindows: { seven_day: { utilization: 0.4, resetsAt: 1794718800 } },
      })?.groups,
    ).toEqual([
      { windows: [{ minutes: 10080, used: 0.4, resets: 1794718800000 }] },
      { name: 'Opus models', models: ['Opus'], windows: [{ minutes: 10080, used: 0.95, resets: 1794718800000 }] },
    ]);
    // an API key's run has none
    expect(claudeLimits({ status: 'allowed' })).toBeNull();
    expect(claudeLimits(undefined)).toBeNull();
    expect(
      claudeUsage({
        input_tokens: 4,
        cache_creation_input_tokens: 313,
        cache_read_input_tokens: 8636,
        output_tokens: 107,
      }),
    ).toEqual(USED);
  });

  it('shows them from then on: at the next look, and only for the account they were read with', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    expect((await h.info()).limits).toBeUndefined();
    await runToEnd(h, job(s, { model: 'haiku', effort: 'low' }));
    const kept = (await h.info()).limits;
    expect(kept).toEqual({ at: expect.any(Number), groups: LEFT });
    // asked again, there's nothing new to ask Claude Code: what its last run said stands
    expect((await h.limits())?.limits).toEqual(kept);
    // another account signed in since: its limits aren't these
    const notes = join(s.root, '.harnesses.json');
    const all = JSON.parse(readFileSync(notes, 'utf8')) as Record<string, { account?: string }>;
    writeFileSync(
      notes,
      JSON.stringify({ ...all, 'limits:claude': { ...all['limits:claude'], account: 'someone@example.com' } }),
    );
    expect((await h.info(true)).limits).toBeUndefined();
  });
});

describe('Claude Code: a conversation its model service refused', () => {
  const OLD = 'c58564bc-c9a7-4e0d-ad72-6461accd9689';
  const runs = () => [0, 1, 2].filter((n) => existsSync(join(s.rec, `argv${n}`))).length;
  /** A resumed run that replays `fixture` and fails as Claude Code does (exit 1); a new one goes well. */
  const resumed = (fixture: string) =>
    fake({
      signedIn: true,
      run: `case "$*" in *--resume=*) ${replay(fixture)}; exit 1;; *) ${replay('claude-normal')};; esac\nexit 0`,
    });
  /** What a turn reported, but what its runs said an alias stood for (the stand-in API's model). */
  const turn = async (h: ReturnType<typeof fake>, j: Job) => (await runToEnd(h, j)).filter((e) => e.type !== 'aliases');

  it('reads each recorded failure as the error its result says, with no tripwire', () => {
    for (const [name, error] of Object.entries(SAID)) {
      const r = claudeReader();
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

  it('starts it again as a new conversation, once, when the turn hadn’t called a tool yet', async () => {
    s = sandbox();
    const events = await turn(resumed('claude-refused-invalid'), job(s, { session: OLD }));
    expect(runs()).toBe(2);
    expect(recorded(s, 0).argv.at(-1)).toBe(`--resume=${OLD}`);
    expect(recorded(s, 1).argv.some((a) => a.startsWith('--resume'))).toBe(false);
    expect(events[0]).toEqual({ type: 'session', session: '873b99a0-d173-4265-92de-5d8411f641a4' });
    expect(events.at(-1)).toEqual({
      type: 'done',
      reply: "Echoed: spike-42. Picture's main colour: blue.",
      usage: USED,
    });
    expect(events.some((e) => e.type === 'failed')).toBe(false);
  });

  it('fails a turn that had called a tool, saying the next starts a new conversation (a broken history, too long)', async () => {
    for (const name of ['claude-refused-history', 'claude-refused-too-long'] as const) {
      s = sandbox();
      // (with what the turn used, when its result counted any)
      expect(await turn(resumed(name), job(s, { session: OLD })), name).toMatchObject([
        { type: 'session', session: fixtureEvents(name).find((e) => e.subtype === 'init')?.session_id },
        { type: 'progress', line: 'Reading the song' },
        { type: 'failed', error: SAID[name], fresh: true },
      ]);
      // what it changed stands: the request isn't made again in this turn
      expect(runs(), name).toBe(1);
      s.cleanup();
    }
  });

  it('keeps the conversation for an ordinary failure: credit, a rate limit, a sign-in, a model', async () => {
    for (const name of [
      'claude-credit',
      'claude-rate-limited',
      'claude-unauthorized',
      'claude-model-missing',
    ] as const) {
      s = sandbox();
      const events = await turn(resumed(name), job(s, { session: OLD }));
      // (and why, where its words are plain: an API key's credit used up, a sign-in it no longer has;
      // a rate limit by the minute, or a model, says nothing: it may pass, or isn't the account's)
      expect(events.at(-1), name).toEqual({ type: 'failed', error: SAID[name], ...WHY[name] });
      expect(runs(), name).toBe(1);
      s.cleanup();
    }
  });

  it('says the account is out of usage when its limit refused the request, with when it starts again', async () => {
    s = sandbox();
    const resetsAt = Math.floor(Date.now() / 1000) + 3600;
    const refusedBy = (info: Record<string, unknown>) =>
      [
        JSON.stringify({
          type: 'system',
          subtype: 'init',
          session_id: OLD,
          model: 'claude-opus-5-5',
          tools: ['mcp__holo__finish'],
          mcp_servers: [{ name: 'holo', status: 'connected' }],
        }),
        JSON.stringify({ type: 'rate_limit_event', rate_limit_info: info }),
        JSON.stringify({
          type: 'result',
          subtype: 'success',
          is_error: true,
          result: 'You’ve reached your limit for now',
          session_id: OLD,
        }),
      ].join('\n');
    const said = (stream: string) => `cat <<'EOF'\n${stream}\nEOF\nexit 1`;
    const rejected = fake({
      signedIn: true,
      run: said(refusedBy({ status: 'rejected', rateLimitType: 'five_hour', resetsAt, isUsingOverage: false })),
    });
    expect((await turn(rejected, job(s))).at(-1)).toEqual({
      type: 'failed',
      error: 'You’ve reached your limit for now',
      why: 'usage',
      resets: resetsAt * 1000,
    });
    // a window it says is used up, with no word that the request was refused: its limits say the same
    const full = fake({
      signedIn: true,
      run: said(
        refusedBy({
          status: 'allowed',
          rateLimitType: 'seven_day',
          unifiedWindows: {
            five_hour: { utilization: 0.2, resetsAt },
            seven_day: { utilization: 1, resetsAt: resetsAt + 86_400 },
          },
        }),
      ),
    });
    expect((await turn(full, job(s))).at(-1)).toMatchObject({
      type: 'failed',
      why: 'usage',
      resets: (resetsAt + 86_400) * 1000,
    });
    // with usage to spare, or extra usage taking it, a failure has no reason: it may pass
    const spare = fake({
      signedIn: true,
      run: said(
        refusedBy({
          status: 'allowed',
          rateLimitType: 'five_hour',
          unifiedWindows: { five_hour: { utilization: 0.4, resetsAt } },
        }),
      ),
    });
    expect((await turn(spare, job(s))).at(-1)).toEqual({ type: 'failed', error: 'You’ve reached your limit for now' });
    const overage = fake({
      signedIn: true,
      run: said(refusedBy({ status: 'rejected', resetsAt, isUsingOverage: true })),
    });
    expect((await turn(overage, job(s))).at(-1)).toEqual({
      type: 'failed',
      error: 'You’ve reached your limit for now',
    });
  });

  it('knows a refusal by how Claude Code words it, and the account’s, the plan’s and the model’s as ordinary', () => {
    // each as a recorded run's result said it (2.1.322)
    for (const said of [
      SAID['claude-refused-history'],
      SAID['claude-refused-invalid'],
      SAID['claude-refused-too-long'],
      'API Error: 400 orphaned tool_result in conversation history.',
      'API Error: 400 messages.1.content.0: Invalid `signature` in `thinking` block',
      'Prompt is too long · the request is ~215347 tokens (limit 200000) but this conversation is only ~270 tokens — the rest is system prompt, tool definitions, and attachment content. A single-exchange conversation cannot be compacted; reduce attached files/tools or start with less context.',
      'Request too large (max 32MB). Accumulated images and attachments in the conversation pushed the request over the limit. Remove older images or compact the conversation.',
      // the API's JSON after the status, as earlier versions wrote it
      'API Error: 400 {"type":"error","error":{"type":"invalid_request_error","message":"messages.3: `tool_use` ids were found without `tool_result` blocks immediately after"}}',
    ])
      expect(refusedRequest('claude', said), said).toBe(true);
    for (const said of [
      SAID['claude-credit'],
      SAID['claude-rate-limited'],
      SAID['claude-unauthorized'],
      SAID['claude-model-missing'],
      'API Error: 400 invalid model name',
      'API Error: 400 This organization has been disabled.',
      'Your ANTHROPIC_API_KEY belongs to a disabled organization · Update or unset the environment variable',
      'Failed to authenticate. API Error: 403 Your API key does not have permission to use the specified resource.',
      'API Error: 529 Overloaded. This is a server-side issue, usually temporary — try again in a moment.',
      // its own words for a picture it took out of the conversation: carried on, the request is new
      'API Error: an image in the conversation could not be processed and was removed. Re-read the file with a different approach if you still need it.',
    ])
      expect(refusedRequest('claude', said), said).toBe(false);
  });
});

describe('Claude Code: signing in and updating', () => {
  it('relays the link, asks for the pasted code, and passes it on', async () => {
    s = sandbox();
    const h = fake();
    const { events, on } = collect();
    const login = h.login(on);
    await until(() => events.some((e) => e.ask === 'code'));
    expect(events.find((e) => e.url)).toEqual({
      state: 'running',
      url: 'https://claude.ai/oauth/authorize?code=true&state=abc',
      ask: 'code',
    });
    expect(h.loginCode('the-code#the-state')).toBe(true);
    await login;
    expect(readFileSync(join(s.rec, 'pasted'), 'utf8')).toBe('the-code#the-state');
    expect(events.at(-1)).toEqual({ state: 'done', line: 'Claude Code is signed in' });
    // nothing waits for a code now
    expect(h.loginCode('again')).toBe(false);
  });

  it('never signs in over an account that’s signed in', async () => {
    s = sandbox();
    const { events, on } = collect();
    await fake({ signedIn: true }).login(on);
    expect(events).toEqual([{ state: 'failed', error: 'Claude Code is signed in already' }]);
    expect(existsSync(join(s.rec, 'login-ran'))).toBe(false);
  });

  it('runs its own updater only when asked, relaying its lines', async () => {
    s = sandbox();
    const lines: string[] = [];
    await fake().update((l) => lines.push(l));
    expect(lines[0]).toBe('Current version: 2.1.322');
  });
});
