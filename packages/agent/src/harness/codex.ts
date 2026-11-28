/**
 * Codex, sealed (docs/agent-harnesses.md, "Codex"): `exec --json` with the user's config.toml and
 * rules ignored, a read-only sandbox, no approvals, no web, no shell (`shell_tool`, `unified_exec`),
 * no apps, plugins, browsers, sub-agents, hooks or image tools, and HO[LO]'s MCP server given with
 * `-c` (its job token stays in the workspace file: `-c` values show in `ps`). The agent's instructions
 * are the workspace's AGENTS.md; project_root_markers=[] keeps Codex from reading any above it.
 *
 * Tripwire: only `agent_message`, `reasoning`, `todo_list` (and `error`) items and HO[LO]'s
 * `mcp_tool_call`s may appear; a refused non-MCP attempt shows only on stderr, as a tool router
 * error, which stops the run too. Whether a version can be sealed at all is checked once per version
 * with `codex debug prompt-input`, which lists the model's tools without calling a model.
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import {
  checkUsage,
  type FailureKind,
  type LimitGroup,
  type LimitsRead,
  type LimitWindow,
  type RunUsage,
  tokens,
} from '../limits.ts';
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
import {
  candidates,
  capture,
  eachLine,
  findBinary,
  home,
  plain,
  type SpawnOptions,
  start,
  stopGroup,
} from './process.ts';
import type { Binary, Harness, Job } from './types.ts';
import { agentsFile, privateDir, TOOL_TIMEOUT_MS } from './workspace.ts';

/** Every feature that would give the model more than HO[LO]'s tools. */
export const CODEX_DISABLED = [
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
] as const;

/**
 * What the model may have in a sealed run (docs/agent-harnesses.md): code mode's own, and these. The
 * user-input pair only talks to the user: `send_message_to_user_async` (0.169.1) takes one message,
 * and its feature switch doesn't take it away.
 */
const TOP_TOOLS = new Set([
  'exec',
  'wait',
  'request_user_input',
  'request_user_input_async',
  'send_message_to_user_async',
]);
const NESTED_TOOLS = new Set([
  'apply_patch',
  'clock__curr_time',
  'list_mcp_resources',
  'list_mcp_resource_templates',
  'read_mcp_resource',
]);

/** "ultra" delegates to sub-agents, which a sealed run doesn't have. */
const NOT_OFFERED = new Set(['ultra']);
const FALLBACK_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'];

/** A TOML value (JSON strings and arrays are valid TOML). */
const toml = (v: unknown) => JSON.stringify(v);

/** The `-c` settings every run (and the seal probe) has, with or without HO[LO]'s server. */
export function codexSettings(effort: string): string[] {
  return [
    ...(effort ? [`model_reasoning_effort=${toml(effort)}`] : []),
    'sandbox_mode="read-only"',
    'approval_policy="never"',
    'web_search="disabled"',
    // the collaboration.* sub-agent tools (features.multi_agent=false covers only v1 models)
    'features.multi_agent_v2.disable_native_tools=true',
    'check_for_update_on_startup=false',
    // only the workspace's AGENTS.md: none from the folders above it
    'project_root_markers=[]',
    // as settings, not `--disable`: Codex refuses a `--disable` name it doesn't know ("Unknown feature flag"),
    // but ignores such a setting, so a feature a later Codex renames or drops doesn't stop every run (the seal
    // check still finds any tool it leaves the model)
    ...CODEX_DISABLED.map((f) => `features.${f}=false`),
  ];
}

/** `codex debug prompt-input` with a run's switches: the model's tools, listed without calling a model. */
export function codexProbeArgs(): string[] {
  return ['debug', 'prompt-input', ...codexSettings('').flatMap((kv) => ['-c', kv]), 'hi'];
}

export function codexArgs(
  job: Pick<Job, 'model' | 'effort' | 'session' | 'workspace'>,
  server: { command: string; args: string[]; env: Record<string, string> },
): string[] {
  const c = [
    ...codexSettings(job.effort),
    `mcp_servers.holo.command=${toml(server.command)}`,
    `mcp_servers.holo.args=${toml(server.args)}`,
    `mcp_servers.holo.env={${Object.entries(server.env)
      .map(([k, v]) => `${k}=${toml(v)}`)
      .join(',')}}`,
    `mcp_servers.holo.tool_timeout_sec=${TOOL_TIMEOUT_MS / 1000}`,
    'mcp_servers.holo.startup_timeout_sec=20',
    // without it every call fails: "requires approval, but approval policy is never"
    'mcp_servers.holo.default_tools_approval_mode="approve"',
  ];
  const common = [
    '--json',
    '--skip-git-repo-check',
    '--ignore-user-config',
    '--ignore-rules',
    ...(job.model ? [`--model=${job.model}`] : []),
    ...c.flatMap((kv) => ['-c', kv]),
  ];
  // `exec resume` takes neither --sandbox nor --cd: -c sandbox_mode and the working folder cover them
  return job.session
    ? ['exec', 'resume', ...common, job.session, '-']
    : ['exec', ...common, '--sandbox=read-only', `--cd=${job.workspace}`, '-'];
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const ITEMS = new Set(['agent_message', 'reasoning', 'todo_list', 'error']);

export function codexReader(): Reader {
  return {
    event(e) {
      const out: Seen[] = [];
      switch (e.type) {
        case 'thread.started':
          if (typeof e.thread_id === 'string') out.push({ kind: 'session', id: e.thread_id });
          break;
        case 'item.started':
        case 'item.updated':
        case 'item.completed': {
          const item = isObject(e.item) ? e.item : {};
          const type = String(item.type ?? '');
          if (type === 'mcp_tool_call') {
            if (item.server !== 'holo') {
              out.push({ kind: 'trip', why: `Codex called a tool of another server (${String(item.server)})` });
              break;
            }
            if (e.type === 'item.started') out.push({ kind: 'tool', name: String(item.tool ?? '') });
          } else if (!ITEMS.has(type)) {
            out.push({ kind: 'trip', why: `Codex used something other than HO[LO]’s tools (${type || 'unknown'})` });
          } else if (type === 'agent_message' && e.type === 'item.completed' && typeof item.text === 'string') {
            if (item.text.trim()) out.push({ kind: 'text', text: item.text.trim() });
          }
          break;
        }
        case 'turn.completed': {
          const usage = codexUsage(e.usage);
          if (usage) out.push({ kind: 'usage', usage });
          out.push({ kind: 'ended' });
          break;
        }
        case 'turn.failed': {
          const error = isObject(e.error) && typeof e.error.message === 'string' ? e.error.message : 'Codex failed';
          out.push({ kind: 'failed', error }, { kind: 'ended' });
          break;
        }
        case 'error':
          // "Reconnecting… 2/5" and the like: said, not the end (turn.failed is)
          if (typeof e.message === 'string') out.push({ kind: 'note', text: e.message });
          break;
      }
      return out;
    },
    stderr(line) {
      // a refused shell, file or patch attempt shows only here
      if (/codex_core::tools::router: error/.test(line) && !/\bholo\/|mcp__holo__/.test(line))
        return [{ kind: 'trip', why: 'Codex tried a tool that isn’t HO[LO]’s' }];
      return [];
    },
  };
}

/**
 * What `turn.completed` says was used: the conversation's total so far, not the turn's own (a resumed
 * one carries on from the last: `Spec.usageIsTotal`). Its `input_tokens` counts what was read from the
 * cache too.
 */
export function codexUsage(usage: unknown): RunUsage | null {
  if (!isObject(usage)) return null;
  const cached = tokens(usage.cached_input_tokens);
  // (one that counts nothing says nothing)
  return checkUsage({
    input: Math.max(0, tokens(usage.input_tokens) - cached),
    cached,
    output: tokens(usage.output_tokens),
  });
}

/** One of a limit's windows: `usedPercent` of `windowDurationMins`, starting again at `resetsAt` (seconds). */
function codexWindow(raw: unknown): LimitWindow | null {
  if (!isObject(raw) || typeof raw.usedPercent !== 'number' || typeof raw.windowDurationMins !== 'number') return null;
  return {
    minutes: raw.windowDurationMins,
    used: raw.usedPercent / 100,
    ...(typeof raw.resetsAt === 'number' ? { resets: raw.resetsAt * 1000 } : {}),
  };
}

/**
 * What the app server's `account/rateLimits/read` answers: the account's limits by id (`codex` is the
 * one every model shares; a model with a limit of its own has another, named by `limitName` or its
 * id), each with a `primary` and maybe a `secondary` window, the plan, and how many early resets of
 * the limit the account may still take.
 */
export function parseCodexLimits(result: unknown): LimitsRead | null {
  if (!isObject(result)) return null;
  const byId = isObject(result.rateLimitsByLimitId) ? Object.values(result.rateLimitsByLimitId) : [];
  const list = (byId.length ? byId : [result.rateLimits]).filter(isObject);
  const groups: LimitGroup[] = [];
  let plan: string | undefined;
  for (const snap of list) {
    const windows = [codexWindow(snap.primary), codexWindow(snap.secondary)].filter((w): w is LimitWindow => !!w);
    if (typeof snap.planType === 'string' && snap.planType) plan ??= snap.planType;
    if (!windows.length) continue;
    const shared = snap.limitId === 'codex' || snap.limitId === null || snap.limitId === undefined;
    const name =
      typeof snap.limitName === 'string' && snap.limitName
        ? snap.limitName
        : !shared && typeof snap.limitId === 'string'
          ? snap.limitId
          : undefined;
    const model = typeof snap.normalModelSlug === 'string' && snap.normalModelSlug ? snap.normalModelSlug : undefined;
    // the one every model shares comes first
    const group: LimitGroup = { ...(name ? { name } : {}), ...(model && !shared ? { models: [model] } : {}), windows };
    if (shared) groups.unshift(group);
    else groups.push(group);
  }
  const credits = isObject(result.rateLimitResetCredits) ? result.rateLimitResetCredits.availableCount : undefined;
  const note =
    typeof credits === 'number' && credits >= 1
      ? `${Math.round(credits)} early reset${Math.round(credits) === 1 ? '' : 's'} of its limit available, in Codex`
      : undefined;
  if (!groups.length && !plan && !note) return null;
  return { ...(plan ? { plan } : {}), ...(note ? { note } : {}), groups };
}

/**
 * Ask Codex's app server (`codex app-server`, JSON-RPC a line each way) for the account's limits: it's
 * started, greeted, asked the one thing, and stopped. No conversation is started and no model called.
 */
export function readCodexLimits(bin: Binary, where: SpawnOptions, timeoutMs = 20_000): Promise<LimitsRead | null> {
  return new Promise((resolve) => {
    const child = start(bin, ['app-server'], where);
    let over = false;
    const end = (found: LimitsRead | null) => {
      if (over) return;
      over = true;
      clearTimeout(limit);
      stopGroup(child, 500);
      resolve(found);
    };
    const limit = setTimeout(() => end(null), timeoutMs);
    limit.unref?.();
    const send = (msg: Record<string, unknown>) => child.stdin?.write(`${JSON.stringify(msg)}\n`);
    eachLine(child.stdout, (line) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObject(msg)) return;
      if (msg.id === 1) {
        if (!isObject(msg.result)) return end(null);
        send({ method: 'initialized' });
        send({ id: 2, method: 'account/rateLimits/read' });
      } else if (msg.id === 2) end(parseCodexLimits(msg.result));
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', () => end(null));
    child.on('close', () => end(null));
    send({
      id: 1,
      method: 'initialize',
      params: { clientInfo: { name: 'holo-desk', title: 'HO[LO] Desk', version: '1' } },
    });
  });
}

/**
 * What its own error means, where its words are fixed (docs/agent-harnesses.md, "A refused
 * conversation"): an API key's quota used up, or a sign-in the service no longer takes. A ChatGPT
 * plan's limit isn't told by its words here: the account's limits, read as the turn fails, say it.
 */
export function codexClassify(error: string): FailureKind | null {
  if (/^Quota exceeded\./.test(error)) return { why: 'usage' };
  if (/^unexpected status 401 Unauthorized\b|, auth error: /.test(error)) return { why: 'signed-out' };
  return null;
}

/** `codex login status`: on stderr, "Logged in using …" (exit 0) or "Not logged in" (exit 1). */
export function parseCodexAuth(text: string): { signedIn: boolean; account?: string } | null {
  const t = plain(text);
  if (/Not logged in/i.test(t)) return { signedIn: false };
  const how = /Logged in using ([^\n]+)/i.exec(t)?.[1]?.trim();
  return how ? { signedIn: true, account: how } : null;
}

/** The device sign-in's link and one-time code. */
export function parseCodexLogin(text: string): { url?: string; code?: string } {
  const t = plain(text);
  const out: { url?: string; code?: string } = {};
  const url = firstUrl(t);
  if (url) out.url = url;
  const after = t.slice(Math.max(0, t.search(/one-time code/i)));
  const code = /one-time code/i.test(t) ? /\b([A-Z0-9]{4,}(?:-[A-Z0-9]{4,})+)\b/.exec(after)?.[1] : undefined;
  if (code) out.code = code;
  return out;
}

export interface CodexModel {
  slug: string;
  efforts: string[];
  /** The effort a run with it has when none is given (`default_reasoning_level`). */
  effort?: string;
  /** Its place in the catalog: the lowest is Codex's default model. */
  priority?: number;
}

/** `codex debug models`: the models offered (visibility "list"), each with the efforts it takes. */
export function parseCodexModels(stdout: string): CodexModel[] {
  try {
    const d = JSON.parse(stdout) as { models?: unknown };
    if (!Array.isArray(d.models)) return [];
    const out: CodexModel[] = [];
    for (const m of d.models.filter(isObject)) {
      if (typeof m.slug !== 'string' || (m.visibility !== undefined && m.visibility !== 'list')) continue;
      const levels = Array.isArray(m.supported_reasoning_levels) ? m.supported_reasoning_levels : [];
      const efforts = levels
        .map((l) => (isObject(l) ? l.effort : l))
        .filter((x): x is string => typeof x === 'string' && !NOT_OFFERED.has(x));
      const model: CodexModel = { slug: m.slug, efforts };
      if (typeof m.default_reasoning_level === 'string') model.effort = m.default_reasoning_level;
      if (typeof m.priority === 'number' && Number.isFinite(m.priority)) model.priority = m.priority;
      out.push(model);
    }
    return out;
  } catch {
    return [];
  }
}

/**
 * What a run uses when it's given no model or effort: the listed model first in the catalog's order
 * (lowest `priority`; Codex's app server marks the same one `isDefault`, whatever config.toml says,
 * and a run ignores config.toml), and each model's `default_reasoning_level`.
 */
export function codexDefaults(models: readonly CodexModel[]): { model?: string; efforts: Record<string, string> } {
  let first: CodexModel | undefined;
  for (const m of models)
    if (!first || (m.priority ?? Number.POSITIVE_INFINITY) < (first.priority ?? Number.POSITIVE_INFINITY)) first = m;
  const efforts: Record<string, string> = {};
  for (const m of models) if (m.effort) efforts[m.slug] = m.effort;
  return { ...(first ? { model: first.slug } : {}), efforts };
}

/**
 * The tools `codex debug prompt-input` shows that a sealed run may not have (none: only code mode's own,
 * and nested ones from the allowed list and HO[LO]'s), or null when it didn't list the model's tools.
 */
export function codexExtraTools(stdout: string): string[] | null {
  let items: unknown;
  try {
    items = JSON.parse(stdout);
  } catch {
    return null;
  }
  if (!Array.isArray(items)) return null;
  const extra = new Set<string>();
  const walk = (tools: unknown[]) => {
    for (const t of tools.filter(isObject)) {
      if (Array.isArray(t.tools)) {
        walk(t.tools);
        continue;
      }
      const name = String(t.name ?? '');
      if (!TOP_TOOLS.has(name)) extra.add(name);
      // code mode's exec lists the tools it reaches as "### `name`" headings
      const nested = typeof t.description === 'string' ? [...t.description.matchAll(/^### `([^`]+)`/gm)] : [];
      for (const [, n] of nested) if (n && !NESTED_TOOLS.has(n) && !n.startsWith('mcp__holo__')) extra.add(n);
    }
  };
  let listed = false;
  for (const item of items.filter(isObject)) {
    if (item.type === 'additional_tools' && Array.isArray(item.tools)) {
      listed = true;
      walk(item.tools);
    }
  }
  return listed ? [...extra] : null;
}

/** Whether `codex debug prompt-input` (the model's tools, with the run's switches) shows only what a sealed run may have. */
export function codexSealedTools(stdout: string): { sealed: boolean; reason?: string } {
  const extra = codexExtraTools(stdout);
  if (!extra) return { sealed: false, reason: 'Codex didn’t list its tools' };
  return extra.length
    ? {
        sealed: false,
        reason: `This Codex gives the model tools HO[LO] can’t turn off (${extra.slice(0, 5).join(', ')})`,
      }
    : { sealed: true };
}

/** What a seal check checks (its switches and what it allows), short: a remembered result holds only under the same. */
const SEAL_RULES = createHash('sha256')
  .update(JSON.stringify([codexSettings(''), CODEX_DISABLED, [...TOP_TOOLS], [...NESTED_TOOLS]]))
  .digest('hex')
  .slice(0, 12);

/** How long the catalog's models are taken as they are (a look in Settings › Agent comes at most hourly). */
const CATALOG_TTL = 3_600_000;

export function codexSpec(): Spec {
  // models() and efforts() both read the catalog: once per version, and again after an hour
  let catalog: { version: string | null; at: number; models: Promise<CodexModel[]> } | null = null;
  const probeDir = (ctx: Context) => privateDir(join(ctx.root, '.probe'));
  const envFor = (ctx: Context, extra: Record<string, string> = {}) =>
    harnessEnv('codex', extra, ctx.env, ctx.platform);

  function models(ctx: Context): Promise<CodexModel[]> {
    if (catalog && catalog.version === ctx.version && Date.now() - catalog.at < CATALOG_TTL) return catalog.models;
    const opts = { cwd: probeDir(ctx), env: envFor(ctx), timeoutMs: 20_000 };
    const list = (async () => {
      const fresh = parseCodexModels((await capture(ctx.bin, ['debug', 'models'], opts)).stdout);
      // offline: the catalog shipped with this version
      return fresh.length
        ? fresh
        : parseCodexModels((await capture(ctx.bin, ['debug', 'models', '--bundled'], opts)).stdout);
    })();
    catalog = { version: ctx.version, at: Date.now(), models: list };
    return list;
  }

  return {
    id: 'codex',
    name: 'Codex',
    find(env, platform) {
      const h = home(env);
      return findBinary(
        candidates(
          ['codex'],
          [join(h, '.local', 'bin'), join(h, '.npm-global', 'bin'), '/usr/local/bin', '/opt/homebrew/bin'],
          env.HOLO_CODEX,
          env,
          platform,
        ),
        platform,
      );
    },
    toolEnv(ctx) {
      return { cwd: probeDir(ctx), env: envFor(ctx) };
    },
    parseVersion: (out) => /\d+\.\d+\.\d+[\w.-]*/.exec(out)?.[0] ?? null,
    async auth(ctx) {
      const out = await capture(ctx.bin, ['login', 'status'], { cwd: probeDir(ctx), env: envFor(ctx) });
      return parseCodexAuth(`${out.stdout}\n${out.stderr}`);
    },
    async sealed(ctx) {
      const memory = remember(ctx.root);
      const known = memory.get<{ version: string; rules?: string; sealed: boolean; reason?: string }>('sealed:codex');
      // what's remembered holds for this version, checked by these rules (a runner with others checks again)
      if (known && ctx.version && known.version === ctx.version && known.rules === SEAL_RULES)
        return known.reason ? { sealed: known.sealed, reason: known.reason } : { sealed: known.sealed };
      // an empty CODEX_HOME of its own: none of the user's config or MCP servers is read (or started)
      const codexHome = privateDir(join(ctx.root, '.codex-probe'));
      const out = await capture(ctx.bin, codexProbeArgs(), {
        cwd: probeDir(ctx),
        env: envFor(ctx, { CODEX_HOME: codexHome }),
        timeoutMs: 30_000,
      });
      const result =
        out.code === 0 ? codexSealedTools(out.stdout) : { sealed: false, reason: 'Codex couldn’t list its tools' };
      if (ctx.version && out.code === 0)
        memory.set('sealed:codex', { version: ctx.version, rules: SEAL_RULES, ...result });
      return result;
    },
    async models(ctx) {
      return (await models(ctx)).map((m) => m.slug);
    },
    async efforts(ctx, model) {
      const list = await models(ctx);
      const one = model ? list.find((m) => m.slug === model) : undefined;
      if (one) return one.efforts;
      const all = [...new Set(list.flatMap((m) => m.efforts))];
      return all.length ? all : [...FALLBACK_EFFORTS];
    },
    async defaults(ctx) {
      return codexDefaults(await models(ctx));
    },
    limits(ctx) {
      return readCodexLimits(ctx.bin, { cwd: probeDir(ctx), env: envFor(ctx) });
    },
    usageIsTotal: true,
    async latest(ctx) {
      const d = JSON.parse(await ctx.fetchText('https://registry.npmjs.org/@openai/codex/latest')) as {
        version?: string;
      };
      return d.version ? { latest: d.version } : null;
    },
    // a link and a one-time code, entered on any device: no TTY, no localhost callback
    login: { args: ['login', '--device-auth'], asksCode: false, parse: parseCodexLogin },
    updateArgs: ['update'],
    // https://developers.openai.com/codex/cli (standalone install): ~/.local/bin/codex
    installer: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    prepare(ctx, job) {
      agentsFile(job.workspace, job.instructions);
      return { args: codexArgs(job, serverFor(ctx, job)), env: {} };
    },
    reader: codexReader,
    classify: codexClassify,
    // AGENTS.md reaches the model as one message when a conversation starts, as Cursor's does
    rulesAtStartOnly: true,
    // it records the context as full and compacts the conversation before the next turn's first
    // request; if a resumed run fails so again in that conversation, it didn't, and every turn would
    refusedIfRepeated: /^Codex ran out of room in the model's context window\b/,
  };
}

export function codexHarness(o: AdapterOptions): Harness {
  return defineHarness(codexSpec(), o);
}
