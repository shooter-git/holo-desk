/**
 * Cursor, sealed (docs/agent-harnesses.md, "Cursor"): print mode in the thread's workspace, with a
 * private HOME kept in the workspace (so neither the user's global MCP servers and plugins nor their
 * cli-config.json are read, and `--model` can't become their default model), the workspace's own MCP
 * config and permissions (HO[LO]'s tools allowed; shell, reading, writing and fetching denied), the
 * hidden `--allowed-tools` that leaves the model only the MCP meta-tools, and `--disable-auto-update`.
 * The sign-in stays readable on Linux through XDG_CONFIG_HOME (~/.config/cursor/auth.json); elsewhere
 * it lives under the real home, so Cursor is offered on Linux only until that's checked.
 *
 * Tripwire: any tool call other than HO[LO]'s MCP calls (and the meta-tool that looks them up), and
 * any MCP call refused. Its worker daemon outlives a run, so the process group goes after every run.
 */
import { join } from 'node:path';
import {
  type AdapterOptions,
  type Context,
  defineHarness,
  firstUrl,
  type Reader,
  remember,
  type Seen,
  type Spec,
  serverFor,
} from './adapter.ts';
import { harnessEnv } from './env.ts';
import { candidates, capture, findBinary, home } from './process.ts';
import type { Harness, Job } from './types.ts';
import { cursorFiles, privateDir } from './workspace.ts';

/** What the model may call: an MCP tool, and the meta-tool that looks one up. */
export const CURSOR_TOOLS = ['mcp_tool_call', 'get_mcp_tools_tool_call'] as const;

export function cursorArgs(
  job: Pick<Job, 'model' | 'session' | 'workspace'>,
  sandbox: 'enabled' | 'disabled',
): string[] {
  const args = [
    '-p',
    '--output-format=stream-json',
    `--workspace=${job.workspace}`,
    '--trust',
    '--approve-mcps',
    `--sandbox=${sandbox}`,
    // hidden: without it every run updates the CLI in the background
    '--disable-auto-update',
    // hidden ("internal only"), enforced by Cursor's backend
    `--allowed-tools=${CURSOR_TOOLS.join(',')}`,
  ];
  if (job.model) args.push(`--model=${job.model}`);
  if (job.session) args.push(`--resume=${job.session}`);
  return args;
}

/**
 * Cursor's environment for a run or a probe: `home` as HOME (and its config folder there), the real
 * XDG_CONFIG_HOME so the sign-in is found, and the other XDG folders inside `home` too.
 */
export function cursorEnv(home: string, env: NodeJS.ProcessEnv): Record<string, string> {
  const realHome = env.HOME?.trim() || (process.env.HOME ?? '');
  return {
    HOME: home,
    XDG_CONFIG_HOME: env.XDG_CONFIG_HOME?.trim() || join(realHome, '.config'),
    CURSOR_CONFIG_DIR: join(home, '.cursor'),
    XDG_CACHE_HOME: join(home, '.cache'),
    XDG_DATA_HOME: join(home, '.local', 'share'),
    XDG_STATE_HOME: join(home, '.local', 'state'),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

export function cursorReader(): Reader {
  return {
    event(e) {
      const out: Seen[] = [];
      if (e.type === 'system' && e.subtype === 'init') {
        if (typeof e.session_id === 'string') out.push({ kind: 'session', id: e.session_id });
        return out;
      }
      if (e.type === 'tool_call' && isObject(e.tool_call)) {
        const [kind, call] = Object.entries(e.tool_call).find(([, v]) => isObject(v)) ?? [];
        const c = isObject(call) ? call : {};
        const args = isObject(c.args) ? c.args : {};
        const result = isObject(c.result) ? c.result : {};
        if (kind === 'getMcpToolsToolCall') return out;
        if (kind !== 'mcpToolCall') {
          out.push({ kind: 'trip', why: `Cursor tried a tool that isn’t HO[LO]’s (${kind ?? 'unknown'})` });
          return out;
        }
        if (args.providerIdentifier !== 'holo') {
          out.push({
            kind: 'trip',
            why: `Cursor called a tool of another server (${String(args.providerIdentifier)})`,
          });
          return out;
        }
        if ('rejected' in result || 'permissionDenied' in result) {
          out.push({ kind: 'trip', why: 'Cursor refused one of HO[LO]’s tools: its permissions aren’t as set' });
          return out;
        }
        if (e.subtype === 'started') out.push({ kind: 'tool', name: String(args.toolName ?? '') });
        return out;
      }
      if (e.type === 'assistant' && isObject(e.message)) {
        const content = Array.isArray(e.message.content) ? e.message.content.filter(isObject) : [];
        const text = content
          .filter((b) => b.type === 'text' && typeof b.text === 'string')
          .map((b) => String(b.text))
          .join('')
          .trim();
        if (text) out.push({ kind: 'text', text });
        return out;
      }
      if (e.type === 'result') {
        if (e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success'))
          out.push({
            kind: 'failed',
            error: typeof e.result === 'string' && e.result ? e.result : `Cursor stopped (${String(e.subtype)})`,
          });
        out.push({ kind: 'ended' });
      }
      return out;
    },
  };
}

/** `status --format json` (it exits 0 either way). */
export function parseCursorAuth(stdout: string): { signedIn: boolean; account?: string } | null {
  try {
    const d = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof d.isAuthenticated !== 'boolean') return null;
    const email = isObject(d.userInfo) && typeof d.userInfo.email === 'string' ? d.userInfo.email : undefined;
    return { signedIn: d.isAuthenticated, ...(d.isAuthenticated && email ? { account: email } : {}) };
  } catch {
    return null;
  }
}

/** `models`: "id - Name" lines, Auto first. */
export function parseCursorModels(stdout: string): string[] {
  const out: string[] = [];
  for (const line of stdout.split('\n')) {
    const id = /^([A-Za-z0-9][\w.:\-[\]=]*) - \S/.exec(line.trim())?.[1];
    if (id) out.push(id);
  }
  return out;
}

/** `about --format json`: the version out, and whether it's newer. */
export function parseCursorAbout(stdout: string): { latest: string; available: boolean } | null {
  try {
    const d = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof d.latestVersion !== 'string' || !d.latestVersion) return null;
    return { latest: d.latestVersion, available: d.latestStatus === 'update_available' };
  } catch {
    return null;
  }
}

/** Whether a bad `--allowed-tools` value is refused with a list that has what a sealed run needs. */
export function cursorFlagsWork(output: string): boolean {
  const list = /Expected one of:([^\n]*)/.exec(output)?.[1] ?? '';
  const names = new Set(list.split(',').map((s) => s.trim().replace(/\.$/, '')));
  return CURSOR_TOOLS.every((t) => names.has(t));
}

/**
 * Whether Cursor refused for want of a sign-in before it looked at its options (2026.11.11-b912975:
 * "Error: Authentication required. Please run 'agent login' first, or set CURSOR_API_KEY …").
 */
export function cursorWantsSignIn(output: string): boolean {
  return (
    /Authentication required/i.test(output) ||
    /run '?(?:cursor-)?agent login'? first/i.test(output) ||
    /\bnot (?:logged|signed) in\b/i.test(output)
  );
}

/**
 * What the flag probe concluded, as remembered per version. `probe` marks how it was concluded: an
 * answer without it (an earlier adapter's) that said no is probed again, since that one took a refusal
 * for want of a sign-in for a missing option.
 */
const PROBE = 2;

export function cursorSpec(): Spec {
  const probeHome = (ctx: Context) => {
    const h = privateDir(join(ctx.root, '.cursor-home'));
    privateDir(join(h, '.cursor'));
    return h;
  };
  const probeDir = (ctx: Context) => privateDir(join(ctx.root, '.probe'));
  const probe = (ctx: Context) => ({
    cwd: probeDir(ctx),
    env: harnessEnv('cursor', cursorEnv(probeHome(ctx), ctx.env), ctx.env, ctx.platform),
  });
  const sandboxKey = 'sandbox:cursor';

  return {
    id: 'cursor',
    name: 'Cursor',
    find(env, platform) {
      const h = home(env);
      return findBinary(
        candidates(
          ['cursor-agent'],
          [join(h, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'],
          env.HOLO_CURSOR,
          env,
          platform,
        ),
        platform,
      );
    },
    toolEnv(ctx, purpose) {
      // signing in and updating are for the user's own Cursor: their home, their config
      if (purpose === 'login')
        return { cwd: probeDir(ctx), env: harnessEnv('cursor', { NO_OPEN_BROWSER: '1' }, ctx.env, ctx.platform) };
      if (purpose === 'update') return { cwd: probeDir(ctx), env: harnessEnv('cursor', {}, ctx.env, ctx.platform) };
      return probe(ctx);
    },
    parseVersion: (out) => /^\s*(\d[\w.-]*)/.exec(out)?.[1] ?? null,
    async auth(ctx) {
      const out = await capture(ctx.bin, ['status', '--format', 'json'], { ...probe(ctx), timeoutMs: 20_000 });
      return parseCursorAuth(out.stdout);
    },
    async sealed(ctx) {
      if (ctx.platform !== 'linux')
        return {
          sealed: false,
          reason: 'HO[LO] keeps Cursor’s own settings out of a run on Linux only, so far',
        };
      const memory = remember(ctx.root);
      const known = memory.get<{ version: string; sealed: boolean; reason?: string; probe?: number }>('sealed:cursor');
      if (known && ctx.version && known.version === ctx.version && (known.sealed || known.probe === PROBE))
        return known.reason ? { sealed: known.sealed, reason: known.reason } : { sealed: known.sealed };
      // a value it doesn't know makes it list the ones it does, before anything else (and no prompt is given)
      const p = probe(ctx);
      const out = await capture(
        ctx.bin,
        [
          '-p',
          '--output-format=stream-json',
          `--workspace=${p.cwd}`,
          '--trust',
          '--disable-auto-update',
          '--allowed-tools=holo_probe',
        ],
        { ...p, timeoutMs: 30_000 },
      );
      const said = `${out.stdout}\n${out.stderr}`;
      if (cursorFlagsWork(said)) {
        if (ctx.version) memory.set('sealed:cursor', { version: ctx.version, sealed: true, probe: PROBE });
        return { sealed: true };
      }
      // signed out, it asks for a sign-in before it reads its options: nothing is known yet, and
      // nothing is remembered (the first look once it's signed in probes again)
      if (cursorWantsSignIn(said))
        return {
          sealed: false,
          signedOut: true,
          reason: 'Sign in to Cursor: it checks its sign-in before HO[LO] can check it limits it to its tools',
        };
      // no answer at all (it timed out, or couldn't start): tried again at the next look
      if (out.timedOut || out.code === null)
        return { sealed: false, reason: 'Cursor didn’t answer the check that limits it to HO[LO]’s tools' };
      const result = {
        sealed: false,
        reason: 'This Cursor no longer takes the option that limits it to HO[LO]’s tools',
      };
      if (ctx.version) memory.set('sealed:cursor', { version: ctx.version, ...result, probe: PROBE });
      return result;
    },
    async models(ctx) {
      const out = await capture(ctx.bin, ['models'], { ...probe(ctx), timeoutMs: 20_000 });
      return parseCursorModels(out.stdout);
    },
    // effort is part of the model id
    async efforts() {
      return [];
    },
    async latest(ctx) {
      const out = await capture(ctx.bin, ['about', '--format', 'json'], { ...probe(ctx), timeoutMs: 20_000 });
      return parseCursorAbout(out.stdout);
    },
    // a link to open on any device; it polls until the sign-in is done
    login: {
      args: ['login'],
      asksCode: false,
      parse: (text) => ({ ...(firstUrl(text) ? { url: firstUrl(text) } : {}) }),
    },
    updateArgs: ['update'],
    // https://cursor.com/docs/cli/installation: ~/.local/bin/cursor-agent (and `agent`)
    installer: 'curl https://cursor.com/install -fsS | bash',
    prepare(ctx, job) {
      const { home: privateHome } = cursorFiles(job.workspace, serverFor(ctx, job), job.instructions);
      const known = remember(ctx.root).get<{ version: string | null; works: boolean }>(sandboxKey);
      const sandbox = known && known.version === ctx.version && !known.works ? 'disabled' : 'enabled';
      return { args: cursorArgs(job, sandbox), env: cursorEnv(privateHome, ctx.env) };
    },
    reader: cursorReader,
    retry(ctx, _job, output) {
      // its sandbox can't start where unprivileged user namespaces are blocked: run without it from now on
      if (!/Sandbox mode is enabled but not available/i.test(output)) return false;
      const memory = remember(ctx.root);
      const known = memory.get<{ version: string | null; works: boolean }>(sandboxKey);
      if (known && known.version === ctx.version && !known.works) return false;
      memory.set(sandboxKey, { version: ctx.version, works: false });
      return true;
    },
  };
}

export function cursorHarness(o: AdapterOptions): Harness {
  return defineHarness(cursorSpec(), o);
}
