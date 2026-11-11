import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cursorFlagsWork,
  cursorHarness,
  cursorReader,
  parseCursorAbout,
  parseCursorAuth,
  parseCursorModels,
} from '../src/harness/cursor.ts';
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

const STATUS_IN = JSON.stringify({
  status: 'authenticated',
  isAuthenticated: true,
  hasAccessToken: true,
  hasRefreshToken: true,
  userInfo: { email: 'user@example.com' },
});
const STATUS_OUT = JSON.stringify({ status: 'unauthenticated', isAuthenticated: false, message: 'Not logged in' });
const ABOUT = JSON.stringify({
  cliVersion: '2026.11.11-043ef28',
  latestStatus: 'update_available',
  latestVersion: '2026.11.12-aaaaaaa',
  model: 'Auto',
});
const MODELS = `Available models

auto - Auto (default)
composer-2.5 - Composer 2.5
composer-2.5[fast=true] - Composer 2.5 Fast
claude-opus-5-5-low - Claude Opus 5.5 Low
bad id with spaces - Nope

Tip: use --model <id> (or /model <id> in interactive mode) to switch.`;
const PROBE =
  'Invalid --allowed-tools value(s): holo_probe. Expected one of: shell_tool_call, delete_tool_call, mcp_tool_call, read_mcp_resource_tool_call, get_mcp_tools_tool_call, web_fetch_tool_call';

let s: Sandbox;
afterEach(() => s?.cleanup());

function fake(o: { run?: string; signedIn?: boolean; probe?: string } = {}) {
  const signed = q(join(s.rec, 'signed-in'));
  if (o.signedIn) writeFileSync(join(s.rec, 'signed-in'), '');
  const path = fakeBinary(
    s,
    'cursor-agent',
    [
      { when: '--version', run: 'echo "2026.11.11-043ef28"; exit 0' },
      {
        when: 'status\\ --format\\ json',
        run: `env -0 > ${q(join(s.rec, 'status-env'))}; if [ -f ${signed} ]; then echo ${q(STATUS_IN)}; else echo ${q(STATUS_OUT)}; fi; exit 0`,
      },
      { when: 'about\\ --format\\ json', run: `echo ${q(ABOUT)}; exit 0` },
      { when: 'models', run: `cat <<'EOF'\n${MODELS}\nEOF\nexit 0` },
      { when: '*--allowed-tools=holo_probe*', run: `echo ${q(o.probe ?? PROBE)} >&2; exit 1` },
      {
        when: 'login',
        run: `touch ${q(join(s.rec, 'login-ran'))}; env -0 > ${q(join(s.rec, 'login-env'))}
echo "Waiting for browser authentication..."
echo "Open a browser and navigate to this link: https://cursor.com/loginDeepControl?challenge=abc&uuid=def&mode=login"
sleep 0.3; touch ${signed}; echo "Login successful!"; exit 0`,
      },
      { when: 'update', run: 'echo "Downloading 2026.11.12-aaaaaaa"; exit 0' },
    ],
    o.run ??
      `sleep 300 & echo $! > ${q(join(s.rec, 'worker'))}
case "$*" in *--resume=*) ${replay('cursor-resume')};; *) ${replay('cursor-normal')};; esac
exit 0`,
  );
  return cursorHarness({
    env: { ...s.env, HOLO_CURSOR: path, CURSOR_API_KEY: 'key_test', ANTHROPIC_API_KEY: 'sk-ant-nope' },
    platform: 'linux',
    root: s.root,
    repo: REPO,
  });
}

describe('Cursor: finding it', () => {
  it('reports its version, sign-in, seal, models and an update, all with a private home', async () => {
    s = sandbox();
    expect(await fake({ signedIn: true }).info()).toEqual({
      id: 'cursor',
      name: 'Cursor',
      found: true,
      version: '2026.11.11-043ef28',
      signedIn: true,
      account: 'user@example.com',
      sealed: true,
      models: ['auto', 'composer-2.5', 'composer-2.5[fast=true]', 'claude-opus-5-5-low'],
      // effort is part of the model id
      efforts: [],
      update: { available: true, latest: '2026.11.12-aaaaaaa' },
    });
    const env = readFileSync(join(s.rec, 'status-env'), 'utf8').split('\0');
    const probeHome = join(s.root, '.cursor-home');
    expect(env).toContain(`HOME=${probeHome}`);
    expect(env).toContain(`CURSOR_CONFIG_DIR=${join(probeHome, '.cursor')}`);
    expect(env).toContain(`XDG_CONFIG_HOME=${join(s.home, '.config')}`);
    expect(existsSync(join(s.home, '.cursor'))).toBe(false);
  });

  it('isn’t offered when the option that limits its tools is gone, or off Linux', async () => {
    s = sandbox();
    const gone = await fake({ probe: "error: unknown option '--allowed-tools=holo_probe'" }).info();
    expect(gone.sealed).toBe(false);
    expect(gone.reason).toContain('no longer takes');
    const mac = cursorHarness({
      env: { ...s.env, HOLO_CURSOR: join(s.dir, 'bin', 'cursor-agent') },
      platform: 'darwin',
      root: s.root,
      repo: REPO,
    });
    const info = await mac.info();
    expect(info.sealed).toBe(false);
    expect(info.reason).toContain('Linux');
  });

  it('reads status, models, about and the probe', () => {
    expect(parseCursorAuth(STATUS_IN)).toEqual({ signedIn: true, account: 'user@example.com' });
    expect(parseCursorAuth(STATUS_OUT)).toEqual({ signedIn: false });
    expect(parseCursorModels(MODELS)).toContain('composer-2.5');
    expect(parseCursorAbout(ABOUT)).toEqual({ latest: '2026.11.12-aaaaaaa', available: true });
    expect(cursorFlagsWork(PROBE)).toBe(true);
    expect(cursorFlagsWork('Invalid --allowed-tools value(s): x. Expected one of: shell_tool_call')).toBe(false);
  });
});

describe('Cursor: a sealed run', () => {
  it('passes the prompt on stdin only, a private home, and the workspace’s own MCP config and permissions', async () => {
    s = sandbox();
    const j = job(s, { model: 'composer-2.5' });
    const events = await runToEnd(fake({ signedIn: true }), j);
    expect(events).toEqual([
      { type: 'session', session: '4da7463b-469a-41bf-86ad-c56bdcee7187' },
      { type: 'progress', line: 'Working' },
      { type: 'done', reply: '**spike-42** — main colour: **red**.' },
    ]);
    const r = recorded(s);
    expect(r.argv.join(' ')).not.toContain('PROMPT-MARK');
    expect(r.argv.join(' ')).not.toContain(TOKEN);
    expect(r.stdin).toBe(`${PROMPT_MARK}\n`);
    expect(r.argv).toEqual([
      '-p',
      '--output-format=stream-json',
      `--workspace=${j.workspace}`,
      '--trust',
      '--approve-mcps',
      '--sandbox=enabled',
      '--disable-auto-update',
      '--allowed-tools=mcp_tool_call,get_mcp_tools_tool_call',
      '--model=composer-2.5',
    ]);
    const home = join(j.workspace, 'home');
    expect(r.env).toEqual({
      PATH: s.env.PATH,
      LANG: 'C.UTF-8',
      CURSOR_API_KEY: 'key_test',
      HOME: home,
      XDG_CONFIG_HOME: join(s.home, '.config'),
      CURSOR_CONFIG_DIR: join(home, '.cursor'),
      XDG_CACHE_HOME: join(home, '.cache'),
      XDG_DATA_HOME: join(home, '.local', 'share'),
      XDG_STATE_HOME: join(home, '.local', 'state'),
    });
    expect(r.tokenMode).toBe('600');
    expect(statSync(home).mode & 0o777).toBe(0o700);
    expect(statSync(join(j.workspace, '.cursor')).mode & 0o777).toBe(0o700);
    expect(JSON.parse(readFileSync(join(j.workspace, '.cursor', 'cli.json'), 'utf8'))).toEqual({
      permissions: { allow: ['Mcp(holo:*)'], deny: ['Shell(*)', 'Read(**)', 'Write(**)', 'WebFetch(*)'] },
    });
    const mcp = JSON.parse(readFileSync(join(j.workspace, '.cursor', 'mcp.json'), 'utf8'));
    expect(Object.keys(mcp.mcpServers)).toEqual(['holo']);
    expect(mcp.mcpServers.holo.env.HOLO_JOB_TOKEN_FILE).toBe(join(j.workspace, '.holo-job'));
    expect(JSON.stringify(mcp)).not.toContain(TOKEN);
    expect(readFileSync(join(j.workspace, 'AGENTS.md'), 'utf8')).toBe('# Rules\nWork on the open song only.\n');
    expect(existsSync(join(s.home, '.cursor'))).toBe(false);
  });

  it('ends the worker it leaves behind after every run', async () => {
    s = sandbox();
    await runToEnd(fake(), job(s));
    const worker = Number(readFileSync(join(s.rec, 'worker'), 'utf8'));
    await until(() => !alive(worker));
  });

  it('carries a session on with --resume, from the same private home', async () => {
    s = sandbox();
    const events = await runToEnd(fake(), job(s, { session: '4da7463b-469a-41bf-86ad-c56bdcee7187' }));
    expect(recorded(s).argv.at(-1)).toBe('--resume=4da7463b-469a-41bf-86ad-c56bdcee7187');
    expect(recorded(s).env.HOME).toBe(join(s.root, 'agt_0123456789ab', 'home'));
    expect(events.at(-1)).toEqual({ type: 'done', reply: '**spike-42**, red.' });
  });

  it('runs without its sandbox where it can’t start, and remembers', async () => {
    s = sandbox();
    const h = fake({
      run: `case "$*" in *--sandbox=enabled*) echo "Error: Sandbox mode is enabled but not available on this system, possibly due to AppArmor configuration." >&2; exit 1;; esac
${replay('cursor-normal')}`,
    });
    expect((await runToEnd(h, job(s))).at(-1)?.type).toBe('done');
    expect(recorded(s, 0).argv).toContain('--sandbox=enabled');
    expect(recorded(s, 1).argv).toContain('--sandbox=disabled');
    await runToEnd(h, job(s));
    expect(recorded(s, 2).argv).toContain('--sandbox=disabled');
    expect(existsSync(join(s.rec, 'argv3'))).toBe(false);
  });

  it('ignores an effort: it is part of the model id', async () => {
    s = sandbox();
    await runToEnd(fake(), job(s, { model: 'claude-opus-5-5-low', effort: 'high' }));
    expect(recorded(s).argv.join(' ')).not.toContain('high');
  });

  it('stops at the tripwire (a shell call, another server’s tool) and ends the process group', async () => {
    for (const fixture of ['cursor-shell-denied', 'cursor-other-server-rejected']) {
      s = sandbox();
      const h = fake({
        run: `sleep 300 & echo $! > ${q(join(s.rec, 'bg'))}
${replay(fixture)}
sleep 300`,
      });
      const events = await runToEnd(h, job(s));
      expect(events.at(-1)?.type, fixture).toBe('failed');
      expect((events.at(-1) as { error: string }).error).toMatch(
        /^Stopped: Cursor (tried a tool|called a tool of another server)/,
      );
      const bg = Number(readFileSync(join(s.rec, 'bg'), 'utf8'));
      await until(() => !alive(bg));
      s.cleanup();
    }
  });

  it('reads every recorded stream as the spike saw it', () => {
    const read = (name: string) => {
      const r = cursorReader();
      return fixtureEvents(name).flatMap((e) => r.event(e));
    };
    const normal = read('cursor-normal');
    expect(normal[0]).toEqual({ kind: 'session', id: '4da7463b-469a-41bf-86ad-c56bdcee7187' });
    expect(normal.filter((x) => x.kind === 'tool')).toEqual([
      { kind: 'tool', name: 'echo' },
      { kind: 'tool', name: 'image' },
    ]);
    expect(normal.at(-1)).toEqual({ kind: 'ended' });
    for (const name of ['cursor-resume', 'cursor-shell', 'cursor-timeout'])
      expect(
        read(name).some((x) => x.kind === 'trip'),
        name,
      ).toBe(false);
    expect(read('cursor-shell-denied').find((x) => x.kind === 'trip')).toEqual({
      kind: 'trip',
      why: 'Cursor tried a tool that isn’t HO[LO]’s (shellToolCall)',
    });
    expect(read('cursor-other-server-rejected').find((x) => x.kind === 'trip')).toEqual({
      kind: 'trip',
      why: 'Cursor called a tool of another server (other)',
    });
  });
});

describe('Cursor: signing in and updating', () => {
  it('relays the link with its own home and config, and waits for it to finish', async () => {
    s = sandbox();
    const { events, on } = collect();
    await fake().login(on);
    expect(events).toContainEqual({
      state: 'running',
      url: 'https://cursor.com/loginDeepControl?challenge=abc&uuid=def&mode=login',
    });
    expect(events.at(-1)).toEqual({ state: 'done', line: 'Cursor is signed in' });
    const env = readFileSync(join(s.rec, 'login-env'), 'utf8').split('\0');
    expect(env).toContain(`HOME=${s.home}`);
    expect(env).toContain('NO_OPEN_BROWSER=1');
  });

  it('never signs in over an account that’s signed in', async () => {
    s = sandbox();
    const { events, on } = collect();
    await fake({ signedIn: true }).login(on);
    expect(events).toEqual([{ state: 'failed', error: 'Cursor is signed in already' }]);
    expect(existsSync(join(s.rec, 'login-ran'))).toBe(false);
  });

  it('runs its own updater when asked', async () => {
    s = sandbox();
    const lines: string[] = [];
    await fake().update((l) => lines.push(l));
    expect(lines).toEqual(['Downloading 2026.11.12-aaaaaaa']);
  });
});
