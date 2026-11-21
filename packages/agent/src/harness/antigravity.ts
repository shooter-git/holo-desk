/**
 * Antigravity (Google's `agy`), sealed (docs/agent-harnesses.md, "Antigravity"): print mode reading the
 * prompt as one stream-json line, run as the workspace's custom agent `holo`, which has none of the
 * built-in tools (`excludeDefaultComponents`, `tools: []`) and the agent's instructions as its system
 * prompt; HO[LO]'s MCP server from the workspace's own MCP config, each of its tools loaded up front;
 * session-only settings that allow HO[LO]'s tools and deny shell, files and the web, in case a built-in
 * tool ever comes back; no slash commands or skills; a private HOME kept in the workspace (none of the
 * user's MCP servers, plugins, hooks, rules or settings), with a link to the sign-in file and the
 * update check marked done so it doesn't update itself. Offered on Linux only until the private home is
 * checked elsewhere.
 *
 * Its `init` lists every built-in tool whatever the agent has, so it can't vouch for the seal: once per
 * version a probe that costs nothing (an agent naming a tool that doesn't exist, refused before any
 * model call) shows it reads the workspace's agent and holds it to its tools. Signed out, a print-mode
 * run waits for a browser sign-in, silently: nothing runs before the sign-in is known to be there, and a
 * run that says nothing for two minutes is stopped.
 *
 * Tripwire: any tool step but HO[LO]'s (`mcp_holo_*`, or `call_mcp_tool` and the resource tools for
 * the holo server), `manage_task` (its own background tasks, of which it can start none), any
 * subagent, any action denied, and a run not as the `holo` agent.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { TOOLS } from '../tools/index.ts';
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
import { type Captured, candidates, capture, findBinary, home, plain } from './process.ts';
import type { AuthStatus, Harness, Job } from './types.ts';
import {
  ANTIGRAVITY_AGENT,
  antigravityAgent,
  antigravityFiles,
  antigravityHome,
  privateDir,
  writePrivate,
} from './workspace.ts';

/** The options a sealed run needs: without them this Antigravity can't be limited. */
export const ANTIGRAVITY_NEEDS = [
  '--input-format',
  '--output-format',
  '--settings',
  '--agent',
  '--disable-slash-commands',
  '--conversation',
  '--model',
  '--effort',
] as const;

/**
 * The run's own settings (`--settings`, never saved): HO[LO]'s tools allowed, and shell, files and the
 * web denied (deny wins), should the agent ever have a built-in tool. Anything else asks, and a print
 * mode run can't ask: it's refused.
 */
export const ANTIGRAVITY_SETTINGS = {
  permissions: {
    allow: ['mcp(holo/*)'],
    deny: ['command(*)', 'read_file(*)', 'write_file(*)', 'read_url(*)', 'execute_url(*)'],
  },
} as const;

/** The efforts its model names end in ("gemini-3.8-flash-low"), in order; `--effort` takes the same. */
export const ANTIGRAVITY_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** A tool name the probe's agent asks for: no Antigravity has it. */
export const PROBE_TOOL = 'holo_probe_not_a_tool';

const PREFIX = 'mcp_holo_';

/** What the model may call besides HO[LO]'s own tools: the holo server's resources, and its own tasks. */
const RESOURCE_TOOLS = new Set(['list_resources', 'read_resource']);
const HARMLESS = new Set(['manage_task']);

/** The prompt, as the one stream-json line a run reads. */
export function antigravityInput(prompt: string): string {
  return `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`;
}

/** The `--model` (and `--effort`) of a run: an effort the model's list has is its own name. */
export function antigravityModelArgs(
  model: string,
  effort: string,
  variants: Readonly<Record<string, readonly string[]>> | null,
): string[] {
  if (!model) return effort ? [`--effort=${effort}`] : [];
  if (!effort) return [`--model=${model}`];
  if (variants?.[model]?.includes(effort)) return [`--model=${model}-${effort}`];
  return [`--model=${model}`, `--effort=${effort}`];
}

export function antigravityArgs(
  job: Pick<Job, 'model' | 'effort' | 'session'>,
  variants: Readonly<Record<string, readonly string[]>> | null,
): string[] {
  const args = [
    '--input-format=stream-json',
    '--output-format=stream-json',
    `--agent=${ANTIGRAVITY_AGENT}`,
    `--settings=${JSON.stringify(ANTIGRAVITY_SETTINGS)}`,
    // a prompt that starts with "/" is text, never one of its commands or skills
    '--disable-slash-commands',
    ...antigravityModelArgs(job.model, job.effort, variants),
  ];
  if (job.session) args.push(`--conversation=${job.session}`);
  return args;
}

/**
 * Its environment for a run or a probe: `home` as HOME, and the XDG folders inside it. The keyring
 * (the session bus, by XDG_RUNTIME_DIR) stays the user's.
 */
export function antigravityEnv(privateHome: string): Record<string, string> {
  return {
    HOME: privateHome,
    XDG_CONFIG_HOME: join(privateHome, '.config'),
    XDG_CACHE_HOME: join(privateHome, '.cache'),
    XDG_DATA_HOME: join(privateHome, '.local', 'share'),
    XDG_STATE_HOME: join(privateHome, '.local', 'state'),
  };
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads its stream-json: `init`, each step's `step_update`, then one `result`. */
export function antigravityReader(): Reader {
  /** The tool steps already reported (a step is said when it starts and again when it's done). */
  const said = new Set<number>();
  return {
    event(e) {
      const out: Seen[] = [];
      const id = typeof e.conversation_id === 'string' ? e.conversation_id : undefined;
      if (e.event === 'init') {
        if (id) out.push({ kind: 'session', id });
        const init = isObject(e.init) ? e.init : {};
        if (init.agent !== ANTIGRAVITY_AGENT)
          out.push({ kind: 'trip', why: 'Antigravity didn’t run as HO[LO]’s agent' });
        return out;
      }
      if (e.event === 'step_update') {
        const step = isObject(e.step_update) ? e.step_update : {};
        if (step.subagent_info !== undefined) {
          out.push({ kind: 'trip', why: 'Antigravity started a subagent' });
          return out;
        }
        const info = isObject(step.tool_info) ? step.tool_info : {};
        const name =
          typeof step.tool_name === 'string' ? step.tool_name : typeof info.name === 'string' ? info.name : '';
        if (step.step_type !== 'tool' && !name) return out;
        const params = isObject(info.parameters) ? info.parameters : {};
        let tool: string | null = null;
        if (name.startsWith(PREFIX)) tool = name.slice(PREFIX.length);
        else if (name === 'call_mcp_tool' && params.ServerName === 'holo') tool = String(params.ToolName ?? '');
        else if (RESOURCE_TOOLS.has(name) && params.ServerName === 'holo') tool = '';
        else if (!HARMLESS.has(name)) {
          out.push({ kind: 'trip', why: `Antigravity tried a tool that isn’t HO[LO]’s (${name || 'unknown'})` });
          return out;
        }
        const error = isObject(info.error) && typeof info.error.message === 'string' ? info.error.message : '';
        if (tool !== null && /permission/i.test(error)) {
          out.push({ kind: 'trip', why: 'Antigravity refused one of HO[LO]’s tools: its permissions aren’t as set' });
          return out;
        }
        const index = typeof step.step_index === 'number' ? step.step_index : -1;
        if (tool && !said.has(index)) {
          said.add(index);
          out.push({ kind: 'tool', name: tool });
        }
        return out;
      }
      if (e.event === 'result') {
        const r = isObject(e.result) ? e.result : {};
        if (Array.isArray(r.denied_actions) && r.denied_actions.length) {
          out.push({ kind: 'trip', why: 'Antigravity tried something it was refused' });
          return out;
        }
        if (r.status === 'SUCCESS') {
          if (typeof r.response === 'string' && r.response.trim()) out.push({ kind: 'text', text: r.response.trim() });
        } else {
          const error =
            typeof r.error === 'string' && r.error.trim()
              ? r.error.trim()
              : `Antigravity stopped (${String(r.status ?? 'unknown')})`;
          out.push({ kind: 'failed', error });
        }
        out.push({ kind: 'ended' });
      }
      return out;
    },
    stderr(line) {
      // "AGY_ERROR: {…, "short_error": …}" or "error: …": said before it fails
      const text = plain(line).trim();
      const json = /^AGY_ERROR:\s*(\{.*\})\s*$/.exec(text)?.[1];
      if (json) {
        try {
          const d = JSON.parse(json) as Record<string, unknown>;
          if (typeof d.short_error === 'string' && d.short_error) return [{ kind: 'note', text: d.short_error }];
        } catch {
          // not as it says: the line as it is
        }
      }
      const error = /^error:\s*(.+)$/i.exec(text)?.[1];
      return error ? [{ kind: 'note', text: error }] : [];
    },
  };
}

/** `models`: "slug<tab>Name" lines after "Fetching available models...". */
export function parseAntigravityModels(stdout: string): string[] {
  const out: string[] = [];
  for (const line of plain(stdout).split('\n')) {
    const slug = /^([A-Za-z0-9][\w.:\-[\]=]*)(?:\t|\s{2,})\S/.exec(line.trim())?.[1];
    if (slug && !out.includes(slug)) out.push(slug);
  }
  return out;
}

/**
 * Its models as the pickers show them: a model's variants that differ only by effort
 * ("gemini-3.8-flash-low", "…-medium", "…-high") are one model with those efforts, in its own order;
 * any other name ("claude-opus-4-6-thinking") is a model with none. Models keep their listed order.
 */
export function antigravityFamilies(slugs: readonly string[]): {
  models: string[];
  efforts: Record<string, string[]>;
} {
  const models: string[] = [];
  const efforts: Record<string, string[]> = {};
  for (const slug of slugs) {
    const m = /^(.+)-(low|medium|high|xhigh|max)$/.exec(slug);
    const model = m?.[1] ?? slug;
    if (!models.includes(model)) models.push(model);
    const list = efforts[model] ?? [];
    if (m?.[2] && !list.includes(m[2])) list.push(m[2]);
    efforts[model] = list;
  }
  const order = (e: string) => ANTIGRAVITY_EFFORTS.indexOf(e as (typeof ANTIGRAVITY_EFFORTS)[number]);
  for (const list of Object.values(efforts)) list.sort((a, b) => order(a) - order(b));
  return { models, efforts };
}

/** Whether what it said asks for a sign-in ("Please sign in to view available models…"). */
export function antigravityWantsSignIn(text: string): boolean {
  return /please sign in|sign in to (view|use|continue)|not logged in|authentication required/i.test(plain(text));
}

/** Signed in or not, from what `models` said: a list (signed in), a request to sign in, or neither. */
export function parseAntigravityAuth(out: Pick<Captured, 'code' | 'stdout' | 'stderr'>): AuthStatus | null {
  if (antigravityWantsSignIn(`${out.stdout}\n${out.stderr}`)) return { signedIn: false };
  return out.code === 0 && parseAntigravityModels(out.stdout).length ? { signedIn: true } : null;
}

/** The checks `--help` must pass: every option a sealed run uses. */
export function antigravityMissing(help: string): string[] {
  return ANTIGRAVITY_NEEDS.filter((o) => !new RegExp(`(^|\\s)${o}\\b`, 'm').test(help));
}

/** What the probe found: the agent read and held to its tools, or why not (null: no answer, tried again). */
export function antigravityProbe(output: string): { sealed: boolean; reason?: string } | null {
  const text = plain(output);
  if (new RegExp(`${PROBE_TOOL}"? not found in registry`).test(text)) return { sealed: true };
  if (/unknown setting/i.test(text))
    return { sealed: false, reason: 'This Antigravity no longer takes the settings that limit it to HO[LO]’s tools' };
  if (/agent/i.test(text) && /not found|available agents/i.test(text))
    return { sealed: false, reason: 'This Antigravity no longer reads the agent that limits it to HO[LO]’s tools' };
  return null;
}

/** Where its installer gets a version: `<os>_<arch>`, as install.sh names them. */
export function antigravityPlatform(platform: NodeJS.Platform, arch: string = process.arch): string | null {
  const os = platform === 'linux' ? 'linux' : platform === 'darwin' ? 'darwin' : null;
  const cpu = arch === 'x64' ? 'amd64' : arch === 'arm64' ? 'arm64' : null;
  return os && cpu ? `${os}_${cpu}` : null;
}

/** Where its installer (https://antigravity.google/cli/install.sh) reads the newest version. */
export const ANTIGRAVITY_MANIFESTS = 'https://antigravity-cli-auto-updater-974169037036.us-central1.run.app/manifests';

/** What a seal check checks, short: a remembered result holds only under the same. */
const SEAL_RULES = createHash('sha256')
  .update(JSON.stringify([ANTIGRAVITY_NEEDS, ANTIGRAVITY_SETTINGS, antigravityAgent(null, [PROBE_TOOL]), PROBE_TOOL]))
  .digest('hex')
  .slice(0, 12);

/** How long one `models` answer serves (a look asks for the sign-in, the seal and the models at once). */
const LISTING_TTL = 10_000;

/** How long a run may say nothing before it's taken as waiting for a sign-in. */
const STARTUP_MS = 120_000;

export function antigravitySpec(o: { startupMs?: number } = {}): Spec {
  const realHome = (ctx: Context) => home(ctx.env);
  const probeDir = (ctx: Context) => privateDir(join(ctx.root, '.probe'));
  const probeHome = (ctx: Context) => {
    const h = join(ctx.root, '.antigravity-home');
    antigravityHome(h, realHome(ctx));
    return h;
  };
  const probe = (ctx: Context, cwd = probeDir(ctx)) => ({
    cwd,
    env: harnessEnv('antigravity', antigravityEnv(probeHome(ctx)), ctx.env, ctx.platform),
  });
  // --help, once per version (a new version is read at once)
  let help: { version: string | null; text: Promise<string> } | null = null;
  const helpText = (ctx: Context): Promise<string> => {
    if (help && help.version === ctx.version) return help.text;
    const text = capture(ctx.bin, ['--help'], { ...probe(ctx), timeoutMs: 15_000 }).then((out) => {
      const said = `${out.stdout}\n${out.stderr}`;
      if (!said.trim()) help = null;
      return said;
    });
    help = { version: ctx.version, text };
    return text;
  };
  // the sign-in and the models come from the same `models`: one serves a look. Only a list is kept
  // after it's in: a refusal (signed out) is asked again next time, so a sign-in shows at once
  let listing: { version: string | null; at: number; out: Promise<Captured> } | null = null;
  const modelList = (ctx: Context): Promise<Captured> => {
    if (listing && listing.version === ctx.version && Date.now() - listing.at < LISTING_TTL) return listing.out;
    const out = capture(ctx.bin, ['models'], { ...probe(ctx), timeoutMs: 30_000 });
    const mine = { version: ctx.version, at: Date.now(), out };
    listing = mine;
    void out.then((r) => {
      if (r.code !== 0 && listing === mine) listing = null;
    });
    return out;
  };
  /** The efforts each model listed has, from the last listing: a run's effort becomes its model's name. */
  let variants: Record<string, string[]> | null = null;
  const families = async (ctx: Context) => {
    const out = await modelList(ctx);
    const found = antigravityFamilies(out.code === 0 ? parseAntigravityModels(out.stdout) : []);
    if (found.models.length) variants = found.efforts;
    return found;
  };
  const auth = async (ctx: Context) => parseAntigravityAuth(await modelList(ctx));

  return {
    id: 'antigravity',
    name: 'Antigravity',
    find(env, platform) {
      const h = home(env);
      return findBinary(
        candidates(
          ['agy'],
          [join(h, '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'],
          env.HOLO_ANTIGRAVITY,
          env,
          platform,
        ),
        platform,
      );
    },
    toolEnv(ctx, purpose) {
      // signing in and updating are for the user's own Antigravity: their home
      if (purpose === 'login' || purpose === 'update')
        return { cwd: probeDir(ctx), env: harnessEnv('antigravity', {}, ctx.env, ctx.platform) };
      return probe(ctx);
    },
    parseVersion: (out) => /^\s*(\d+\.\d+\.\d+[\w.-]*)/.exec(out)?.[1] ?? null,
    auth,
    async sealed(ctx) {
      if (ctx.platform !== 'linux')
        return { sealed: false, reason: 'HO[LO] keeps Antigravity’s own settings out of a run on Linux only, so far' };
      const missing = antigravityMissing(await helpText(ctx));
      if (missing.length)
        return {
          sealed: false,
          reason: `This Antigravity (${ctx.version ?? 'unknown version'}) lacks ${missing.join(', ')}: update it to use it here`,
        };
      const memory = remember(ctx.root);
      const known = memory.get<{ version: string; rules?: string; sealed: boolean; reason?: string }>(
        'sealed:antigravity',
      );
      if (known && ctx.version && known.version === ctx.version && known.rules === SEAL_RULES)
        return known.reason ? { sealed: known.sealed, reason: known.reason } : { sealed: known.sealed };
      // signed out, a print-mode run waits for a browser sign-in: the probe waits for the sign-in
      const signed = await auth(ctx).catch(() => null);
      if (signed?.signedIn !== true)
        return {
          sealed: false,
          signedOut: signed?.signedIn === false,
          reason:
            signed?.signedIn === false
              ? 'Sign in to Antigravity: HO[LO] checks it limits it to its tools once it’s signed in'
              : 'Antigravity didn’t say whether it’s signed in, so HO[LO] couldn’t check it limits it to its tools',
        };
      // an agent asking for a tool no Antigravity has is refused before any model is asked
      const dir = privateDir(join(ctx.root, '.antigravity-probe'));
      const agents = privateDir(join(privateDir(join(dir, '.agents')), 'agents'));
      writePrivate(join(agents, `${ANTIGRAVITY_AGENT}.md`), antigravityAgent(null, [PROBE_TOOL]));
      const out = await capture(ctx.bin, antigravityArgs({ model: '', effort: '' }, null), {
        ...probe(ctx, dir),
        input: antigravityInput('Reply OK.'),
        timeoutMs: 45_000,
      });
      const found = antigravityProbe(`${out.stdout}\n${out.stderr}`);
      if (!found)
        return {
          sealed: false,
          reason: out.timedOut
            ? 'Antigravity didn’t answer the check that limits it to HO[LO]’s tools'
            : 'Antigravity didn’t refuse the check’s made-up tool, so HO[LO] can’t tell it holds an agent to its tools',
        };
      if (ctx.version) memory.set('sealed:antigravity', { version: ctx.version, rules: SEAL_RULES, ...found });
      return found;
    },
    async models(ctx) {
      return (await families(ctx)).models;
    },
    async efforts(ctx, model) {
      const { efforts } = await families(ctx);
      if (model) return efforts[model] ?? [];
      const all = new Set(Object.values(efforts).flat());
      return ANTIGRAVITY_EFFORTS.filter((e) => all.has(e));
    },
    async latest(ctx) {
      const platform = antigravityPlatform(ctx.platform);
      if (!platform) return null;
      const d = JSON.parse(await ctx.fetchText(`${ANTIGRAVITY_MANIFESTS}/${platform}.json`)) as { version?: unknown };
      return typeof d.version === 'string' && /^\d+\.\d+\.\d+[\w.-]*$/.test(d.version) ? { latest: d.version } : null;
    },
    // `agy acp --login`: a link, then the code the page shows, pasted on stdin (no TTY needed)
    login: {
      args: ['acp', '--login'],
      asksCode: true,
      parse: (text) => {
        const url = firstUrl(text);
        return url ? { url } : {};
      },
    },
    updateArgs: ['update'],
    // https://antigravity.google/docs/getting-started?tab=cli: ~/.local/bin/agy
    installer: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    prepare(ctx, job) {
      const files = antigravityFiles(
        job.workspace,
        serverFor(ctx, job),
        job.instructions,
        TOOLS.map((t) => t.name),
      );
      antigravityHome(files.home, realHome(ctx));
      return { args: antigravityArgs(job, variants), env: antigravityEnv(files.home) };
    },
    reader: antigravityReader,
    input: (job) => antigravityInput(job.prompt),
    startup: {
      limitMs: o.startupMs ?? STARTUP_MS,
      error: 'Antigravity didn’t start: it may be waiting for a sign-in. Sign in again in Settings › Agent',
    },
  };
}

/** `startupMs`: how long a run may say nothing (two minutes; shorter in tests). */
export function antigravityHarness(o: AdapterOptions & { startupMs?: number }): Harness {
  return defineHarness(antigravitySpec({ ...(o.startupMs ? { startupMs: o.startupMs } : {}) }), o);
}
