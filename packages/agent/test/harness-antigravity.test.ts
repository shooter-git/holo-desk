import { existsSync, lstatSync, readFileSync, readlinkSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { remember } from '../src/harness/adapter.ts';
import {
  ANTIGRAVITY_MANIFESTS,
  ANTIGRAVITY_SETTINGS,
  antigravityArgs,
  antigravityFamilies,
  antigravityHarness,
  antigravityInput,
  antigravityMissing,
  antigravityModelArgs,
  antigravityPlatform,
  antigravityProbe,
  antigravityReader,
  antigravityWantsSignIn,
  parseAntigravityAuth,
  parseAntigravityModels,
} from '../src/harness/antigravity.ts';
import { GIT_ENV } from '../src/harness/env.ts';
import { TOOLS } from '../src/tools/index.ts';
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

/** `agy --help` 1.5.13, the options a sealed run uses among them. */
const HELP = `Usage of agy:
  --add-dir                       Add a directory to the workspace (repeatable) (default [])
  --agent                         Agent for the current CLI session
  --conversation                  Resume a previous conversation by ID
  --disable-slash-commands        Disable slash command and skill expansion in print mode
  --effort                        Reasoning effort for the current CLI session (low|medium|high|xhigh|max)
  --input-format                  Input format for print mode (text, stream-json). stream-json reads one NDJSON message per line from stdin and runs a turn for each; it requires --output-format stream-json (default text)
  --model                         Model for the current CLI session
  --output-format                 Output format for print mode (text, json, stream-json) (default text)
  -p                              Short alias for --print
  --settings                      Settings for this session only, never saved: a JSON object of settings.json keys, inline or as a file path

Available subcommands:
  models          List available models
  update          Update CLI`;

/** `agy models` on a free account (1.5.13). */
const MODELS = `Fetching available models...
gemini-3.8-flash-high\tGemini 3.8 Flash (High)
gemini-3.8-flash-medium\tGemini 3.8 Flash (Medium)
gemini-3.8-flash-low\tGemini 3.8 Flash (Low)
claude-sonnet-4-6\tClaude Sonnet 4.6 (Thinking)
claude-opus-4-6-thinking\tClaude Opus 4.6 (Thinking)
gpt-oss-120b-medium\tGPT-OSS 120B (Medium)`;
const SIGNED_OUT = `Fetching available models...
Error: Please sign in to view available models. Launch the CLI without arguments to sign in.`;
const PROBE_SAID = readFileSync(join(FIXTURES, 'antigravity-probe.stderr.txt'), 'utf8');

let s: Sandbox;
afterEach(() => s?.cleanup());

const count = (file: string) =>
  existsSync(join(s.rec, file)) ? readFileSync(join(s.rec, file), 'utf8').split('\n').length - 1 : 0;
/** How many times the seal probe ran. */
const probes = () => count('probes');

interface FakeOptions {
  run?: string;
  signedIn?: boolean;
  help?: string;
  probe?: string;
  platform?: NodeJS.Platform;
  startupMs?: number;
}

function fake(o: FakeOptions = {}) {
  const signed = q(join(s.rec, 'signed-in'));
  if (o.signedIn) writeFileSync(join(s.rec, 'signed-in'), '');
  const path = fakeBinary(
    s,
    'agy',
    [
      { when: '--version', run: 'echo "1.5.13"; exit 0' },
      { when: '--help', run: `cat <<'EOF'\n${o.help ?? HELP}\nEOF\nexit 0` },
      {
        when: 'models',
        run: `env -0 > ${q(join(s.rec, 'models-env'))}; pwd > ${q(join(s.rec, 'models-cwd'))}
if [ -f ${signed} ]; then cat <<'EOF'\n${MODELS}\nEOF\nexit 0; else cat <<'EOF'\n${SIGNED_OUT}\nEOF\nexit 1; fi`,
      },
      {
        // the seal probe: the workspace's agent asks for a tool no Antigravity has
        when: '*--agent=holo*',
        run: `if grep -q holo_probe_not_a_tool .agents/agents/holo.md 2>/dev/null; then
  echo probe >> ${q(join(s.rec, 'probes'))}; cat > ${q(join(s.rec, 'probe-stdin'))}
  cat <<'EOF' >&2\n${o.probe ?? PROBE_SAID}\nEOF\n  exit 3; fi`,
      },
      {
        when: 'acp\\ --login',
        run: `env -0 > ${q(join(s.rec, 'login-env'))}
echo "Open this link in a browser to log in with Google:"
echo ""
echo "  https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=abc&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=xyz"
echo ""
echo "Then paste the authorization code, or the full URL of the page you land on, and press Enter:"
read code
if [ "$code" = "good-code" ]; then touch ${signed}; echo "Signed in."; exit 0; fi
echo "couldn't log in: token exchange failed: oauth2: \\"invalid_grant\\" \\"Malformed auth code.\\""; exit 1`,
      },
      {
        when: 'update',
        run: `env -0 > ${q(join(s.rec, 'update-env'))}; echo "⟳ Checking for updates... (current version 1.5.13)"; echo "✓ You are already on the latest version."; exit 0`,
      },
    ],
    o.run ??
      `case "$*" in *--conversation=*) ${replay('antigravity-resume')};; *) ${replay('antigravity-normal')};; esac\nexit 0`,
  );
  const fetched: string[] = [];
  const h = antigravityHarness({
    env: {
      ...s.env,
      HOLO_ANTIGRAVITY: path,
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      GEMINI_API_KEY: 'nope',
    },
    platform: o.platform ?? 'linux',
    root: s.root,
    repo: REPO,
    fetchText: async (url) => {
      fetched.push(url);
      return JSON.stringify({ version: '1.5.14', url: 'https://example.invalid/agy.tar.gz', sha512: 'abc' });
    },
    ...(o.startupMs ? { startupMs: o.startupMs } : {}),
  });
  return Object.assign(h, { fetched });
}

const envOf = (file: string) => readFileSync(join(s.rec, file), 'utf8').split('\0');

describe('Antigravity: finding it', () => {
  it('reports its version, sign-in, seal, models by effort and an update, all with a private home', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    expect(await h.info()).toEqual({
      id: 'antigravity',
      name: 'Antigravity',
      found: true,
      version: '1.5.13',
      signedIn: true,
      sealed: true,
      // a model's effort variants are one model with those efforts
      models: ['gemini-3.8-flash', 'claude-sonnet-4-6', 'claude-opus-4-6-thinking', 'gpt-oss-120b'],
      efforts: ['low', 'medium', 'high'],
      update: { available: true, latest: '1.5.14' },
    });
    expect(h.fetched).toEqual([`${ANTIGRAVITY_MANIFESTS}/${antigravityPlatform('linux')}.json`]);
    expect(await h.efforts('gemini-3.8-flash')).toEqual(['low', 'medium', 'high']);
    expect(await h.efforts('gpt-oss-120b')).toEqual(['medium']);
    expect(await h.efforts('claude-sonnet-4-6')).toEqual([]);
    const probeHome = join(s.root, '.antigravity-home');
    const env = envOf('models-env');
    expect(env).toContain(`HOME=${probeHome}`);
    expect(env).toContain(`XDG_CONFIG_HOME=${join(probeHome, '.config')}`);
    // the keyring stays reachable; an API key never reaches it (the subscription only)
    expect(env).toContain('DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/1000/bus');
    expect(env.some((e) => e.startsWith('GEMINI_API_KEY='))).toBe(false);
    expect(env).toContain('GIT_SSH_COMMAND=false');
    expect(env.some((e) => e.startsWith('SSH_'))).toBe(false);
    // the sign-in is the user's, through a link; the update check is marked done; nothing in the real home
    const link = join(probeHome, '.gemini', 'antigravity-cli', 'antigravity-oauth-token');
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readlinkSync(link)).toBe(join(s.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'));
    const stamp = statSync(join(probeHome, '.gemini', 'antigravity-cli', 'last_check.timestamp'));
    expect(Date.now() - stamp.mtimeMs).toBeLessThan(60_000);
    expect(existsSync(join(s.home, '.gemini'))).toBe(false);
    // what the probe was given: the run's own switches, and a prompt on stdin only
    expect(probes()).toBe(1);
    expect(readFileSync(join(s.rec, 'probe-stdin'), 'utf8')).toBe(antigravityInput('Reply OK.'));
    expect(remember(s.root).get('sealed:antigravity')).toMatchObject({ version: '1.5.13', sealed: true });
    // remembered for this version
    await h.info(true);
    expect(probes()).toBe(1);
  });

  it('never probes while signed out (a run would wait for a browser): signed out, seal unknown, then checked once signed in', async () => {
    s = sandbox();
    const h = fake();
    const before = await h.info();
    expect(before).toMatchObject({ found: true, signedIn: false, sealed: false, sealUnknown: true });
    expect(before.reason).toContain('Sign in to Antigravity');
    expect(before.models).toBeUndefined();
    expect(probes()).toBe(0);
    expect(remember(s.root).get('sealed:antigravity')).toBeUndefined();
    const { events, on } = collect();
    const login = h.login(on);
    await until(() => events.some((e) => e.url));
    expect(events.find((e) => e.url)).toEqual({
      state: 'running',
      url: 'https://accounts.google.com/o/oauth2/auth?access_type=offline&client_id=abc&redirect_uri=https%3A%2F%2Fantigravity.google%2Foauth-callback&state=xyz',
      ask: 'code',
    });
    expect(h.loginCode('good-code')).toBe(true);
    await login;
    expect(events.at(-1)).toEqual({ state: 'done', line: 'Antigravity is signed in' });
    // its own home and config: the sign-in is the one the terminal uses
    const env = envOf('login-env');
    expect(env).toContain(`HOME=${s.home}`);
    expect(env.some((e) => e.startsWith('XDG_CONFIG_HOME='))).toBe(false);
    const after = await h.info(true);
    expect(after).toMatchObject({ signedIn: true, sealed: true });
    expect(after.sealUnknown).toBeUndefined();
    expect(probes()).toBe(1);
  });

  it('says why a sign-in failed', async () => {
    s = sandbox();
    const h = fake();
    const { events, on } = collect();
    const login = h.login(on);
    await until(() => events.some((e) => e.url));
    h.loginCode('not-a-code');
    await login;
    expect(events.at(-1)?.state).toBe('failed');
    expect(events.at(-1)?.error).toContain('Malformed auth code');
  });

  it('isn’t offered without the options a sealed run needs, when the probe isn’t refused, or off Linux', async () => {
    s = sandbox();
    const old = await fake({ signedIn: true, help: HELP.replace(/ {2}--agent .*\n/, '') }).info();
    expect(old.sealed).toBe(false);
    expect(old.reason).toContain('lacks --agent');
    expect(probes()).toBe(0);
    s.cleanup();
    s = sandbox();
    const settings = await fake({ signedIn: true, probe: 'Error: --settings: unknown setting "permissions"' }).info();
    expect(settings).toMatchObject({ sealed: false });
    expect(settings.reason).toContain('no longer takes the settings');
    expect(remember(s.root).get('sealed:antigravity')).toMatchObject({ sealed: false });
    s.cleanup();
    s = sandbox();
    // it ran the agent without refusing the made-up tool: not sealed, and looked at again next time
    const loose = await fake({ signedIn: true, probe: 'OK' }).info();
    expect(loose.sealed).toBe(false);
    expect(loose.reason).toContain('can’t tell');
    expect(remember(s.root).get('sealed:antigravity')).toBeUndefined();
    const mac = await fake({ signedIn: true, platform: 'darwin' }).info();
    expect(mac.sealed).toBe(false);
    expect(mac.reason).toContain('Linux');
  });

  it('reads its models, sign-in, help, probe and platforms', () => {
    expect(parseAntigravityModels(MODELS)).toEqual([
      'gemini-3.8-flash-high',
      'gemini-3.8-flash-medium',
      'gemini-3.8-flash-low',
      'claude-sonnet-4-6',
      'claude-opus-4-6-thinking',
      'gpt-oss-120b-medium',
    ]);
    // as its docs show it: padded with spaces
    expect(parseAntigravityModels('gemini-4-neon-xhigh            Gemini 4 Neon (XHigh)')).toEqual([
      'gemini-4-neon-xhigh',
    ]);
    expect(parseAntigravityModels(SIGNED_OUT)).toEqual([]);
    expect(
      antigravityFamilies([
        'gemini-4-neon-xhigh',
        'gemini-4-neon-low',
        'gemini-pro-orchestrator-neon',
        'gemini-4-neon-high',
      ]),
    ).toEqual({
      models: ['gemini-4-neon', 'gemini-pro-orchestrator-neon'],
      efforts: { 'gemini-4-neon': ['low', 'high', 'xhigh'], 'gemini-pro-orchestrator-neon': [] },
    });
    expect(parseAntigravityAuth({ code: 0, stdout: MODELS, stderr: '' })).toEqual({ signedIn: true });
    expect(parseAntigravityAuth({ code: 1, stdout: SIGNED_OUT, stderr: '' })).toEqual({ signedIn: false });
    // offline, or anything else: unknown
    expect(
      parseAntigravityAuth({ code: 1, stdout: 'Fetching available models...', stderr: 'dial tcp: i/o timeout' }),
    ).toBeNull();
    expect(antigravityWantsSignIn(SIGNED_OUT)).toBe(true);
    expect(antigravityMissing(HELP)).toEqual([]);
    expect(antigravityMissing('--model  Model')).toContain('--settings');
    expect(antigravityProbe(PROBE_SAID)).toEqual({ sealed: true });
    expect(antigravityProbe('Error: --settings: unknown setting "permissions"')?.sealed).toBe(false);
    expect(antigravityProbe('agent "holo" not found. Available agents: default')?.reason).toContain('agent');
    expect(antigravityProbe('')).toBeNull();
    expect(antigravityPlatform('linux', 'x64')).toBe('linux_amd64');
    expect(antigravityPlatform('darwin', 'arm64')).toBe('darwin_arm64');
    expect(antigravityPlatform('win32', 'x64')).toBeNull();
  });
});

describe('Antigravity: a sealed run', () => {
  it('passes the prompt on stdin as one stream-json line, runs as HO[LO]’s agent with its tools only, in a private home', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    const j = job(s);
    const events = await runToEnd(h, j);
    expect(events).toEqual([
      { type: 'session', session: 'c7a94997-872a-4181-a684-499816e061a0' },
      { type: 'progress', line: 'Working' },
      { type: 'done', reply: 'Echoed text: "spike-42", main colour: green.' },
    ]);
    const r = recorded(s);
    expect(r.argv.join(' ')).not.toContain('PROMPT-MARK');
    expect(r.argv.join(' ')).not.toContain(TOKEN);
    expect(r.stdin).toBe(antigravityInput(`${PROMPT_MARK}\n`));
    expect(JSON.parse(r.stdin)).toEqual({ event: 'user', message: { content: `${PROMPT_MARK}\n` } });
    expect(r.argv).toEqual([
      '--input-format=stream-json',
      '--output-format=stream-json',
      '--agent=holo',
      `--settings=${JSON.stringify(ANTIGRAVITY_SETTINGS)}`,
      '--disable-slash-commands',
    ]);
    expect(r.cwd).toBe(j.workspace);
    const home = join(j.workspace, 'home');
    expect(r.env).toEqual({
      PATH: '/usr/local/bin:/usr/bin:/bin',
      LANG: 'C.UTF-8',
      DBUS_SESSION_BUS_ADDRESS: 'unix:path=/run/user/1000/bus',
      HOME: home,
      XDG_CONFIG_HOME: join(home, '.config'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
      ...GIT_ENV,
    });
    // the workspace's MCP config: HO[LO]'s server only, each of its tools up front, the token by file
    const config = JSON.parse(readFileSync(join(j.workspace, '.agents', 'mcp_config.json'), 'utf8'));
    expect(Object.keys(config.mcpServers)).toEqual(['holo']);
    const holo = config.mcpServers.holo;
    expect(holo.env.HOLO_JOB_TOKEN_FILE).toBe(join(j.workspace, '.holo-job'));
    expect(JSON.stringify(config)).not.toContain(TOKEN);
    expect(holo.timeoutSeconds).toBe(240);
    expect(Object.keys(holo.tools)).toEqual(TOOLS.map((t) => t.name));
    expect(Object.values(holo.tools).every((t) => (t as { eager: boolean }).eager === true)).toBe(true);
    expect(statSync(join(j.workspace, '.agents', 'mcp_config.json')).mode & 0o777).toBe(0o600);
    // the agent: none of the built-in tools, never a subagent, the instructions as its prompt
    const agent = readFileSync(join(j.workspace, '.agents', 'agents', 'holo.md'), 'utf8');
    expect(agent).toContain('\nexcludeDefaultComponents: true\n');
    expect(agent).toContain('\ntools: []\n');
    expect(agent).toContain('\nsubagent: false\n');
    expect(agent.endsWith('---\n# Rules\nWork on the open song only.\n')).toBe(true);
    // the private home: the sign-in by a link, the update check marked done
    expect(readlinkSync(join(home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'))).toBe(
      join(s.home, '.gemini', 'antigravity-cli', 'antigravity-oauth-token'),
    );
    expect(existsSync(join(home, '.gemini', 'antigravity-cli', 'last_check.timestamp'))).toBe(true);
    expect(statSync(home).mode & 0o777).toBe(0o700);
  });

  it('names a model’s effort the way its list does, and drops an effort the model doesn’t take', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    await h.info();
    await runToEnd(h, job(s, { model: 'gemini-3.8-flash', effort: 'low' }));
    expect(recorded(s, 0).argv).toContain('--model=gemini-3.8-flash-low');
    expect(recorded(s, 0).argv.some((a) => a.startsWith('--effort'))).toBe(false);
    await runToEnd(h, job(s, { model: 'claude-sonnet-4-6', effort: 'high' }));
    expect(recorded(s, 1).argv.filter((a) => a.startsWith('--model') || a.startsWith('--effort'))).toEqual([
      '--model=claude-sonnet-4-6',
    ]);
    // a model it no longer lists: its default instead
    await runToEnd(h, job(s, { model: 'gemini-2-gone', effort: '' }));
    expect(recorded(s, 2).argv.some((a) => a.startsWith('--model'))).toBe(false);
    expect(antigravityModelArgs('gemini-3.8-flash', '', null)).toEqual(['--model=gemini-3.8-flash']);
    expect(antigravityModelArgs('', 'high', null)).toEqual(['--effort=high']);
    expect(antigravityModelArgs('gemini-9', 'max', {})).toEqual(['--model=gemini-9', '--effort=max']);
  });

  it('carries a conversation on with --conversation, in the same private home', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    const events = await runToEnd(h, job(s, { session: '353139ba-a600-4fd1-ae54-5b948d504c57' }));
    expect(events).toEqual([
      { type: 'session', session: '353139ba-a600-4fd1-ae54-5b948d504c57' },
      { type: 'done', reply: 'You asked me to remember the number 4417. BANANA' },
    ]);
    expect(recorded(s).argv.at(-1)).toBe('--conversation=353139ba-a600-4fd1-ae54-5b948d504c57');
    expect(antigravityArgs({ model: '', effort: '', session: 'abc' }, null).at(-1)).toBe('--conversation=abc');
  });

  it('stops at the tripwire (a built-in tool, even one refused) and ends the process group', async () => {
    s = sandbox();
    const shell = fake({
      signedIn: true,
      // recorded without the agent (deny rules only): as the agent here, so the shell call is what trips
      run: `sleep 300 & echo $! > ${q(join(s.rec, 'worker'))}\n${replay('antigravity-shell-denied')} | sed 's/"init":{/"init":{"agent":"holo",/'\nsleep 5\nexit 0`,
    });
    const events = await runToEnd(shell, job(s));
    expect(events.at(-1)).toEqual({
      type: 'failed',
      error: 'Stopped: Antigravity tried a tool that isn’t HO[LO]’s (run_command)',
    });
    const worker = Number(readFileSync(join(s.rec, 'worker'), 'utf8'));
    await until(() => !alive(worker));
    // without HO[LO]'s permission (and its tools by schema files): the first built-in tool stops it
    rmSync(s.rec, { recursive: true, force: true });
    s.cleanup();
    s = sandbox();
    const lazy = fake({
      signedIn: true,
      run: `${replay('antigravity-mcp-denied')} | sed 's/"init":{/"init":{"agent":"holo",/'\nexit 0`,
    });
    expect((await runToEnd(lazy, job(s))).at(-1)).toEqual({
      type: 'failed',
      error: 'Stopped: Antigravity tried a tool that isn’t HO[LO]’s (read_file)',
    });
  });

  it('says why a run it refused failed: a model it doesn’t know, a slash command', async () => {
    s = sandbox();
    const bad = fake({
      signedIn: true,
      run: `${replay('antigravity-bad-model')}\ncat ${q(join(FIXTURES, 'antigravity-bad-model.stderr.txt'))} >&2\nexit 1`,
    });
    const events = await runToEnd(bad, job(s));
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe('failed');
    expect((events[0] as { error: string }).error).toContain('model holo-not-a-model is not recognized');
    const slash = fake({ signedIn: true, run: `${replay('antigravity-slash')}\nexit 2` });
    expect((await runToEnd(slash, job(s))).at(-1)).toEqual({
      type: 'failed',
      error: '/model takes no arguments, got "gemini-3.8-flash-high"',
    });
  });

  it('stops a run that says nothing (waiting for a browser sign-in), and doesn’t start it again without its session', async () => {
    s = sandbox();
    const h = fake({
      signedIn: true,
      startupMs: 300,
      run: `echo started >> ${q(join(s.rec, 'starts'))}\nsleep 30\nexit 0`,
    });
    const events = await runToEnd(h, job(s, { session: 'abc-123' }));
    expect(events).toEqual([
      {
        type: 'failed',
        error: 'Antigravity didn’t start: it may be waiting for a sign-in. Sign in again in Settings › Agent',
      },
    ]);
    expect(count('starts')).toBe(1);
  });

  it('reads every recorded stream as the spike saw it', () => {
    const read = (name: string) => {
      const r = antigravityReader();
      return fixtureEvents(name).flatMap((e) => r.event(e));
    };
    expect(read('antigravity-normal')).toEqual([
      { kind: 'session', id: 'c7a94997-872a-4181-a684-499816e061a0' },
      { kind: 'tool', name: 'echo' },
      { kind: 'tool', name: 'image' },
      { kind: 'text', text: 'Echoed text: "spike-42", main colour: green.' },
      { kind: 'ended' },
    ]);
    // recorded with the deny rules but not the agent: stopped at its first word
    expect(read('antigravity-shell-denied').find((x) => x.kind === 'trip')).toEqual({
      kind: 'trip',
      why: 'Antigravity didn’t run as HO[LO]’s agent',
    });
    const asAgent = antigravityReader();
    const seen = fixtureEvents('antigravity-shell-denied')
      .slice(1)
      .flatMap((e) => asAgent.event(e));
    expect(seen.find((x) => x.kind === 'trip')).toEqual({
      kind: 'trip',
      why: 'Antigravity tried a tool that isn’t HO[LO]’s (run_command)',
    });
    expect(read('antigravity-probe').at(-2)).toMatchObject({ kind: 'failed' });
    expect(read('antigravity-bad-model')).toEqual([
      { kind: 'failed', error: expect.stringContaining('invalid model selection') },
      { kind: 'ended' },
    ]);
  });

  it('allows HO[LO]’s tools by any name and the holo server’s resources; trips on anything else', () => {
    const step = (tool_name: string, parameters: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
      antigravityReader().event({
        event: 'step_update',
        step_update: {
          step_index: 4,
          state: 'ACTIVE',
          step_type: 'tool',
          tool_name,
          tool_info: { name: tool_name, parameters },
          ...extra,
        },
      });
    expect(step('mcp_holo_notes_write')).toEqual([{ kind: 'tool', name: 'notes_write' }]);
    expect(step('call_mcp_tool', { ServerName: 'holo', ToolName: 'song_status', Arguments: {} })).toEqual([
      { kind: 'tool', name: 'song_status' },
    ]);
    expect(step('call_mcp_tool', { ServerName: 'gdrive', ToolName: 'search' })[0]?.kind).toBe('trip');
    expect(step('list_resources', { ServerName: 'holo' })).toEqual([]);
    expect(step('read_resource', { ServerName: 'other' })[0]?.kind).toBe('trip');
    expect(step('manage_task', { Action: 'list' })).toEqual([]);
    expect(step('mcp_gdrive_search')[0]?.kind).toBe('trip');
    expect(step('invoke_subagent')[0]?.kind).toBe('trip');
    expect(step('mcp_holo_echo', {}, { subagent_info: { subagents: [] } })).toEqual([
      { kind: 'trip', why: 'Antigravity started a subagent' },
    ]);
    // one of HO[LO]'s tools refused by its permissions: they aren't as set
    expect(
      step(
        'mcp_holo_echo',
        {},
        {
          state: 'ERROR',
          tool_info: { name: 'mcp_holo_echo', error: { message: 'Permission denied for mcp(holo/echo)' } },
        },
      )[0]?.kind,
    ).toBe('trip');
    // a tool's own error isn't a trip
    expect(
      step(
        'mcp_holo_echo',
        {},
        { state: 'ERROR', tool_info: { name: 'mcp_holo_echo', error: { message: 'No such track' } } },
      ),
    ).toEqual([{ kind: 'tool', name: 'echo' }]);
    const r = antigravityReader();
    expect(r.event({ event: 'init', conversation_id: 'c1', init: { agent: 'default' } })).toEqual([
      { kind: 'session', id: 'c1' },
      { kind: 'trip', why: 'Antigravity didn’t run as HO[LO]’s agent' },
    ]);
    expect(
      r.event({ event: 'result', result: { status: 'SUCCESS', response: '', denied_actions: [{ action: 'mcp' }] } }),
    ).toEqual([{ kind: 'trip', why: 'Antigravity tried something it was refused' }]);
    expect(r.event({ event: 'result', result: { status: 'CANCELED' } })).toEqual([
      { kind: 'failed', error: 'Antigravity stopped (CANCELED)' },
      { kind: 'ended' },
    ]);
    expect(r.stderr?.('AGY_ERROR: {"short_error":"quota exhausted","status":"UNKNOWN"}')).toEqual([
      { kind: 'note', text: 'quota exhausted' },
    ]);
  });
});

describe('Antigravity: updating', () => {
  it('runs its own updater when asked, with the user’s own home', async () => {
    s = sandbox();
    const h = fake({ signedIn: true });
    const lines: string[] = [];
    await h.update((l) => lines.push(l));
    expect(lines[0]).toContain('Checking for updates');
    expect(envOf('update-env')).toContain(`HOME=${s.home}`);
  });
});
