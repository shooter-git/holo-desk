import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  CLAUDE_EFFORTS,
  claudeArgs,
  claudeEfforts,
  claudeHarness,
  claudeModels,
  claudeReader,
  parseClaudeAuth,
} from '../src/harness/claude.ts';
import { allowed, GIT_ENV } from '../src/harness/env.ts';
import {
  alive,
  collect,
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
});
const SIGNED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none' });

let s: Sandbox;
afterEach(() => s?.cleanup());

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
      sealed: true,
      models: ['fable', 'opus', 'sonnet', 'haiku'],
      efforts: ['low', 'medium', 'high', 'xhigh', 'max'],
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
    expect(parseClaudeAuth(SIGNED_IN)).toEqual({ signedIn: true, account: 'user@example.com' });
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
      { type: 'done', reply: "Echoed: spike-42. Picture's main colour: blue." },
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
    expect(events.at(-1)).toEqual({ type: 'done', reply: 'Echoed "spike-42"; the picture was blue.' });
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

  it('runs at the default with a model or an effort it no longer offers, rather than failing', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    await h.info();
    // a model saved when an earlier version offered it, and an effort none takes now
    const events = await runToEnd(h, job(s, { model: 'gone-model', effort: 'xhigh' }));
    expect(events.at(-1)?.type).toBe('done');
    expect(recorded(s, 0).argv.some((a) => a.startsWith('--model'))).toBe(false);
    expect(recorded(s, 0).argv).toContain('--effort=xhigh');
    // one still offered is passed on
    await runToEnd(h, job(s, { model: 'fable', effort: 'gone-effort' }));
    expect(recorded(s, 1).argv).toContain('--model=fable');
    expect(recorded(s, 1).argv.some((a) => a.startsWith('--effort'))).toBe(false);
  });

  it('refuses a model or effort that reads as more than a value, and drops an effort it doesn’t take', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    expect(await runToEnd(h, job(s, { model: 'haiku --dangerously-skip-permissions' }))).toEqual([
      { type: 'failed', error: '“haiku --dangerously-skip-permissions” isn’t a model name' },
    ]);
    expect(await runToEnd(h, job(s, { effort: '--tools=Bash' }))).toEqual([
      { type: 'failed', error: '“--tools=Bash” isn’t an effort' },
    ]);
    expect(existsSync(join(s.rec, 'argv0'))).toBe(false);
    await runToEnd(h, job(s, { effort: 'ultra' }));
    expect(recorded(s).argv.some((a) => a.startsWith('--effort'))).toBe(false);
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
      { kind: 'tool', name: 'echo' },
      { kind: 'tool', name: 'image' },
      { kind: 'text', text: "Echoed: spike-42. Picture's main colour: blue." },
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
