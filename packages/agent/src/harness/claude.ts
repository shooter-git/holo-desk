/**
 * Claude Code, sealed (docs/agent-harnesses.md, "Claude Code"): no built-in tools (`--tools=`), HO[LO]'s
 * MCP server only (`--strict-mcp-config`), its tools allowed without asking and nothing else
 * (`dontAsk`), only the workspace's own settings (no hooks, no memory, no claude.ai connectors), no
 * CLAUDE.md, no slash commands or skills, no self-update. The agent's instructions are appended to its
 * system prompt from the workspace.
 *
 * Tripwire: the run stops unless `init` lists only HO[LO]'s tools and HO[LO]'s server, connected; and
 * on any other tool used or any permission refused.
 */
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
  type Seen,
  type Spec,
  serverFor,
} from './adapter.ts';
import { CLAUDE_ENV, harnessEnv } from './env.ts';
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
import { type Binary, type Harness, type Job, MODEL } from './types.ts';
import { claudeFiles, privateDir } from './workspace.ts';

/** The efforts when `--help` doesn't list them (it does: "--effort <level> … (low, medium, …)"). */
export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

/** How long one handshake answers for (a look asks its models, efforts, aliases and limits at once). */
const HANDSHAKE_FRESH_MS = 20_000;
/** How long a version that didn't answer isn't asked again. */
const HANDSHAKE_QUIET_MS = 10 * 60_000;

/** The aliases every recent Claude Code takes; `--help` may name newer ones. */
const ALIASES = ['sonnet', 'opus', 'haiku'];

/** The options a sealed run needs: without them this Claude Code is too old to be limited. */
export const CLAUDE_NEEDS = [
  '--tools',
  '--strict-mcp-config',
  '--mcp-config',
  '--allowedTools',
  '--permission-mode',
  '--setting-sources',
  '--settings',
  '--disable-slash-commands',
  '--append-system-prompt',
  '--effort',
  '--resume',
] as const;

const PREFIX = 'mcp__holo__';

/** The argv of a run; the prompt is on stdin. */
export function claudeArgs(
  job: Pick<Job, 'model' | 'effort' | 'session'>,
  files: { mcp: string; settings: string; instructions: string | null },
): string[] {
  const args = ['-p', '--output-format=stream-json', '--verbose'];
  if (job.model) args.push(`--model=${job.model}`);
  if (job.effort) args.push(`--effort=${job.effort}`);
  args.push(
    '--tools=',
    '--strict-mcp-config',
    `--mcp-config=${files.mcp}`,
    `--allowedTools=${PREFIX}*`,
    '--permission-mode=dontAsk',
    '--setting-sources=project',
    `--settings=${files.settings}`,
  );
  if (files.instructions) args.push(`--append-system-prompt-file=${files.instructions}`);
  args.push('--disable-slash-commands', '--no-chrome');
  if (job.session) args.push(`--resume=${job.session}`);
  return args;
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

/** Reads Claude's stream-json. */
export function claudeReader(): Reader {
  let init = false;
  /** The tools Claude Code said it has (all HO[LO]'s, or the run was stopped). */
  let offered = new Set<string>();
  return {
    event(e) {
      const out: Seen[] = [];
      if (e.type === 'system' && e.subtype === 'init') {
        init = true;
        if (typeof e.session_id === 'string') out.push({ kind: 'session', id: e.session_id });
        if (typeof e.model === 'string' && MODEL.test(e.model)) out.push({ kind: 'model', model: e.model });
        const tools = Array.isArray(e.tools) ? e.tools : [];
        const other = tools.find((t) => typeof t !== 'string' || !t.startsWith(PREFIX));
        offered = new Set(tools.filter((t): t is string => typeof t === 'string'));
        if (other !== undefined) {
          out.push({ kind: 'trip', why: `Claude Code offered a tool other than HO[LO]’s (${String(other)})` });
          return out;
        }
        const servers = Array.isArray(e.mcp_servers) ? e.mcp_servers.filter(isObject) : [];
        const strange = servers.find((s) => s.name !== 'holo');
        if (strange) {
          out.push({
            kind: 'trip',
            why: `Claude Code loaded an MCP server other than HO[LO]’s (${String(strange.name)})`,
          });
          return out;
        }
        const holo = servers.find((s) => s.name === 'holo');
        if (holo?.status !== 'connected' || !tools.length) {
          out.push({ kind: 'trip', why: 'HO[LO]’s tools didn’t start in Claude Code' });
          return out;
        }
        return out;
      }
      if (e.type === 'system' && e.subtype === 'permission_denied') {
        out.push({ kind: 'trip', why: `Claude Code tried ${String(e.tool_name ?? 'a tool')}, which isn’t HO[LO]’s` });
        return out;
      }
      if (e.type === 'assistant' && isObject(e.message)) {
        if (!init) {
          out.push({ kind: 'trip', why: 'Claude Code started without saying which tools it has' });
          return out;
        }
        const content = Array.isArray(e.message.content) ? e.message.content.filter(isObject) : [];
        for (const block of content) {
          if (block.type === 'tool_use') {
            const name = String(block.name ?? '');
            // a HO[LO] tool named without its prefix is a slip, not a way out: Claude Code has no tool
            // by that name and answers "No such tool available", and the model calls it again by its
            // full name
            if (!name.startsWith(PREFIX) && offered.has(`${PREFIX}${name}`)) continue;
            if (!name.startsWith(PREFIX)) {
              out.push({ kind: 'trip', why: `Claude Code tried ${name || 'a tool'}, which isn’t HO[LO]’s` });
              return out;
            }
            out.push({ kind: 'tool', name: name.slice(PREFIX.length) });
          } else if (block.type === 'text' && typeof block.text === 'string' && block.text.trim()) {
            out.push({ kind: 'text', text: block.text.trim() });
          }
        }
        return out;
      }
      if (e.type === 'rate_limit_event') {
        const limits = claudeLimits(e.rate_limit_info);
        if (limits) out.push({ kind: 'limits', limits });
        const refused = claudeRefused(e.rate_limit_info);
        if (refused) out.push({ kind: 'limited', ...refused });
        return out;
      }
      if (e.type === 'result') {
        const usage = claudeUsage(e.usage);
        if (usage) out.push({ kind: 'usage', usage });
        if (Array.isArray(e.permission_denials) && e.permission_denials.length)
          out.push({ kind: 'trip', why: 'Claude Code tried tools that aren’t HO[LO]’s' });
        else if (e.is_error === true || (typeof e.subtype === 'string' && e.subtype !== 'success'))
          out.push({
            kind: 'failed',
            error: typeof e.result === 'string' && e.result ? e.result : `Claude Code stopped (${String(e.subtype)})`,
          });
        out.push({ kind: 'ended' });
      }
      return out;
    },
  };
}

/** The windows a `rate_limit_event` names, in minutes. */
const CLAUDE_WINDOWS: Record<string, number> = { five_hour: 300, seven_day: 10080 };

/** One of its windows: `utilization` is the share used (0 to 1), `resetsAt` in seconds. */
function claudeWindow(minutes: number, raw: unknown): LimitWindow | null {
  if (!isObject(raw) || typeof raw.utilization !== 'number') return null;
  return {
    minutes,
    used: raw.utilization,
    ...(typeof raw.resetsAt === 'number' ? { resets: raw.resetsAt * 1000 } : {}),
  };
}

/**
 * What a run's `rate_limit_event` says of the account (a claude.ai sign-in's; an API key has none):
 * the five-hour and the seven-day windows every model shares (`unifiedWindows`), and, when the limit
 * it names is one model's own week (`seven_day_opus`, `seven_day_sonnet`), that model's. Windows it
 * names that aren't known here are left out.
 */
export function claudeLimits(info: unknown): LimitsRead | null {
  if (!isObject(info)) return null;
  const groups: LimitGroup[] = [];
  const all: LimitWindow[] = [];
  const unified = isObject(info.unifiedWindows) ? info.unifiedWindows : {};
  for (const [key, minutes] of Object.entries(CLAUDE_WINDOWS)) {
    const w = claudeWindow(minutes, unified[key]);
    if (w) all.push(w);
  }
  const type = typeof info.rateLimitType === 'string' ? info.rateLimitType : '';
  // an older Claude Code names one window only, the one nearest its limit
  if (!all.length && CLAUDE_WINDOWS[type]) {
    const w = claudeWindow(CLAUDE_WINDOWS[type], info);
    if (w) all.push(w);
  }
  if (all.length) groups.push({ windows: all });
  const model = /^seven_day_(opus|sonnet)$/.exec(type)?.[1];
  const own = model ? claudeWindow(10080, info) : null;
  if (model && own) {
    const name = model.charAt(0).toUpperCase() + model.slice(1);
    groups.push({ name: `${name} models`, models: [name], windows: [own] });
  }
  return groups.length ? { groups } : null;
}

/**
 * Whether a `rate_limit_event` says the account's limit refused the request (`status: "rejected"`, and
 * no extra usage taking it instead), with when that limit starts again.
 */
export function claudeRefused(info: unknown): { resets?: number } | null {
  if (!isObject(info) || info.status !== 'rejected' || info.isUsingOverage === true) return null;
  return typeof info.resetsAt === 'number' && info.resetsAt > 0 ? { resets: info.resetsAt * 1000 } : {};
}

/**
 * What its own error means, where its words are fixed (docs/agent-harnesses.md, "A refused
 * conversation", has them as recorded): signed out, or an API key's credit used up.
 */
export function claudeClassify(error: string): FailureKind | null {
  if (/^(?:Not logged in\b|Invalid API key\b|Failed to authenticate\b)/.test(error)) return { why: 'signed-out' };
  if (/^Credit balance is too low\b/.test(error)) return { why: 'usage' };
  return null;
}

/** What its `result` says the run used: input not from the cache (what it wrote there too), cache reads, output. */
export function claudeUsage(usage: unknown): RunUsage | null {
  if (!isObject(usage)) return null;
  // (one that counts nothing says nothing)
  return checkUsage({
    input: tokens(usage.input_tokens) + tokens(usage.cache_creation_input_tokens),
    cached: tokens(usage.cache_read_input_tokens),
    output: tokens(usage.output_tokens),
  });
}

/** `claude auth status` (JSON; exits 1 when signed out): its account, and its plan (`subscriptionType`). */
export function parseClaudeAuth(stdout: string): { signedIn: boolean; account?: string; plan?: string } | null {
  try {
    const d = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof d.loggedIn !== 'boolean') return null;
    const account = [d.email, d.orgName].find((v): v is string => typeof v === 'string' && v.length > 0);
    const plan = typeof d.subscriptionType === 'string' && d.subscriptionType ? d.subscriptionType : undefined;
    return {
      signedIn: d.loggedIn,
      ...(d.loggedIn && account ? { account } : {}),
      ...(d.loggedIn && plan ? { plan } : {}),
    };
  } catch {
    return null;
  }
}

// ---- the handshake: what Claude Code says of itself as it starts, with no request made ----
//
// Started as a run is (the same seal), with its input a stream of JSON it's never given a prompt on,
// Claude Code answers two questions over that stream (the control channel its own SDK uses): at
// `initialize`, the models the account may run, what each alias stands for and the efforts each takes;
// at `get_usage`, what the account has left. Neither calls a model. `get_usage` is marked
// experimental by its vendor, so everything here is read as it may not be: anything unexpected is no
// answer, and the adapter goes on as it did before (the models and efforts `--help` names, the limits
// its runs say).

/** The argv of the handshake: sealed as a run, reading JSON on stdin (on which no prompt is ever written). */
export const CLAUDE_HANDSHAKE_ARGS: readonly string[] = [
  '-p',
  '--input-format=stream-json',
  '--output-format=stream-json',
  '--verbose',
  '--tools=',
  '--strict-mcp-config',
  '--mcp-config={"mcpServers":{}}',
  '--permission-mode=dontAsk',
  '--setting-sources=project',
  '--disable-slash-commands',
  '--no-chrome',
];

/** A model as `initialize` lists it: its name for `--model`, what it stands for, its efforts, its vendor's name. */
export interface ClaudeModel {
  value: string;
  resolved?: string;
  efforts?: string[];
  display?: string;
}

/** What a handshake answered: its models (none: `initialize` said none it could read), and the account's limits. */
export interface ClaudeHandshake {
  models: ClaudeModel[];
  limits: LimitsRead | null;
}

/** The models `initialize` lists, as they should be: names a run can be given (`default` isn't one), at most 60. */
export function parseClaudeModels(response: unknown): ClaudeModel[] {
  if (!isObject(response) || !Array.isArray(response.models)) return [];
  const out: ClaudeModel[] = [];
  for (const m of response.models.slice(0, 120)) {
    if (!isObject(m) || typeof m.value !== 'string' || !MODEL.test(m.value) || m.value === 'default') continue;
    if (out.some((o) => o.value === m.value)) continue;
    const model: ClaudeModel = { value: m.value };
    if (typeof m.resolvedModel === 'string' && MODEL.test(m.resolvedModel)) model.resolved = m.resolvedModel;
    if (Array.isArray(m.supportedEffortLevels)) {
      const efforts = m.supportedEffortLevels.filter(
        (e): e is string => typeof e === 'string' && /^[a-z][a-z0-9-]{0,19}$/.test(e),
      );
      if (efforts.length) model.efforts = [...new Set(efforts)].slice(0, 12);
    }
    if (typeof m.displayName === 'string' && m.displayName.length <= 60) model.display = m.displayName;
    out.push(model);
    if (out.length === 60) break;
  }
  return out;
}

/** A time as `get_usage` writes it (ISO 8601), in ms; undefined when it isn't one. */
function isoTime(raw: unknown): number | undefined {
  const at = typeof raw === 'string' ? Date.parse(raw) : Number.NaN;
  return Number.isFinite(at) ? at : undefined;
}

/** A share `get_usage` gives in percent (0 to 100), as a window. */
function percentWindow(minutes: number, percent: unknown, resets: unknown): LimitWindow | null {
  if (typeof percent !== 'number' || !Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  const at = isoTime(resets);
  return { minutes, used: percent / 100, ...(at === undefined ? {} : { resets: at }) };
}

/**
 * What `get_usage` says the account has left (a claude.ai sign-in's; an API key has none:
 * `rate_limits_available` false). Its `limits` list is read where it's there: the session's five hours
 * and the week every model shares, and each week that's one model family's own (`weekly_scoped`, named
 * by `scope.model.display_name`: "Fable"), with the ids of `models` that family's are run by. Without
 * that list, its `five_hour` and `seven_day` (`utilization` in percent). Null when it says none of it
 * as expected.
 */
export function parseClaudeUsage(response: unknown, models: readonly ClaudeModel[] = []): LimitsRead | null {
  if (!isObject(response) || response.rate_limits_available !== true || !isObject(response.rate_limits)) return null;
  const rl = response.rate_limits;
  const shared: LimitWindow[] = [];
  const groups: LimitGroup[] = [];
  const listed = Array.isArray(rl.limits) ? rl.limits.filter(isObject) : [];
  for (const l of listed.slice(0, 24)) {
    if (l.kind === 'session' || l.kind === 'weekly_all') {
      const minutes = l.kind === 'session' ? 300 : 10080;
      const w = shared.some((s) => s.minutes === minutes) ? null : percentWindow(minutes, l.percent, l.resets_at);
      if (w) shared.push(w);
    } else if (l.kind === 'weekly_scoped') {
      const scope = isObject(l.scope) && isObject(l.scope.model) ? l.scope.model : null;
      const name = scope && typeof scope.display_name === 'string' ? scope.display_name.trim().slice(0, 40) : '';
      const w = name ? percentWindow(10080, l.percent, l.resets_at) : null;
      if (!w || groups.some((g) => g.models?.[0] === name)) continue;
      // the ids a run of that family is given: its alias, and each model its vendor names for it
      const family = name.toLowerCase();
      const ids = models
        .filter((m) => m.value.toLowerCase() === family || m.display?.toLowerCase().startsWith(`${family} `))
        .flatMap((m) => [m.value, ...(m.resolved ? [m.resolved] : [])]);
      groups.push({
        name: `${name} models`,
        models: [name],
        ...(ids.length ? { ids: [...new Set(ids)] } : {}),
        windows: [w],
      });
    }
  }
  if (!listed.length)
    for (const [key, minutes] of Object.entries(CLAUDE_WINDOWS)) {
      const raw = rl[key];
      const w = isObject(raw) ? percentWindow(minutes, raw.utilization, raw.resets_at) : null;
      if (w) shared.push(w);
    }
  if (shared.length) groups.unshift({ windows: shared });
  return groups.length ? { groups } : null;
}

/** What Claude Code writes when a model is at work, or a turn was taken: never expected of a handshake. */
const MODEL_AT_WORK: ReadonlySet<string> = new Set(['assistant', 'stream_event', 'result', 'user']);

/**
 * The handshake: Claude Code is started sealed, asked `initialize` and then `get_usage`, and stopped.
 * Nothing else is ever written to it, so no request is made of a model; should it write anything a
 * turn would (it never has), it's stopped at once and nothing it said is kept. Null when it didn't
 * answer `initialize` in time; its limits are null when only `get_usage` didn't.
 */
export function readClaudeHandshake(
  bin: Binary,
  where: SpawnOptions,
  timeoutMs = 15_000,
): Promise<ClaudeHandshake | null> {
  return new Promise((resolve) => {
    const child = start(bin, [...CLAUDE_HANDSHAKE_ARGS], where);
    let over = false;
    let models: ClaudeModel[] | null = null;
    const end = (found: ClaudeHandshake | null) => {
      if (over) return;
      over = true;
      clearTimeout(limit);
      child.stdin?.end();
      stopGroup(child, 500);
      resolve(found);
    };
    // (out of time: what `initialize` said stands, without limits)
    const limit = setTimeout(() => end(models ? { models, limits: null } : null), timeoutMs);
    limit.unref?.();
    const ask = (id: string, subtype: string, more: Record<string, unknown> = {}) =>
      child.stdin?.write(
        `${JSON.stringify({ type: 'control_request', request_id: id, request: { subtype, ...more } })}\n`,
      );
    eachLine(child.stdout, (line) => {
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        return;
      }
      if (!isObject(msg)) return;
      if (typeof msg.type === 'string' && MODEL_AT_WORK.has(msg.type)) return end(null);
      if (msg.type !== 'control_response' || !isObject(msg.response)) return;
      const { request_id: id, subtype, response } = msg.response;
      if (id === 'holo_init') {
        if (subtype !== 'success') return end(null);
        models = parseClaudeModels(response);
        ask('holo_usage', 'get_usage', { skip_behaviors: true });
      } else if (id === 'holo_usage' && models)
        end({ models, limits: subtype === 'success' ? parseClaudeUsage(response, models) : null });
    });
    child.stdin?.on('error', () => undefined);
    child.on('error', () => end(null));
    child.on('close', () => end(models ? { models, limits: null } : null));
    ask('holo_init', 'initialize');
  });
}

/** The model aliases `--help` names ("e.g. 'fable', 'opus', or 'sonnet'"), with the usual ones. */
export function claudeModels(help: string): string[] {
  const line = /--model <model>[\s\S]{0,400}?\)/.exec(help)?.[0] ?? '';
  const named = [...line.matchAll(/'([a-z][a-z0-9-]{1,30})'/g)].map((m) => m[1] as string);
  return [...new Set([...named, ...ALIASES])];
}

/**
 * The efforts `--help` lists for `--effort`: "(low, medium, high, xhigh, max)", or as commander puts
 * choices, `(choices: "low", "medium", …)`. The usual ones when it lists none.
 */
export function claudeEfforts(help: string): string[] {
  const list = /^\s*--effort\b[^\n(]*(?:\n(?!\s*--)[^\n(]*){0,3}?\(([^)]{1,300})\)/m.exec(help)?.[1] ?? '';
  const quoted = [...list.matchAll(/["']([a-z][a-z0-9-]{0,19})["']/g)].map((m) => m[1] as string);
  const words = quoted.length
    ? quoted
    : list
        .replace(/^\s*(choices|one of|e\.g\.)\s*:?\s*/i, '')
        .split(/\s*(?:,|\||\bor\b)\s*/)
        .map((w) => w.trim());
  const efforts = [...new Set(words.filter((w) => /^[a-z][a-z0-9-]{0,19}$/.test(w)))];
  return efforts.length ? efforts : [...CLAUDE_EFFORTS];
}

export function claudeSpec(): Spec {
  // sealed(), models() and efforts() all read --help: once per version (a new version is read at once)
  let help: { version: string | null; text: Promise<string> } | null = null;
  const helpText = (ctx: Context): Promise<string> => {
    if (help && help.version === ctx.version) return help.text;
    const text = capture(ctx.bin, ['--help'], { ...probe(ctx), timeoutMs: 15_000 }).then((out) => {
      // a failed read is tried again next time
      if (!out.stdout.trim()) help = null;
      return out.stdout;
    });
    help = { version: ctx.version, text };
    return text;
  };
  const probe = (ctx: Context) => {
    const cwd = privateDir(join(ctx.root, '.probe'));
    return { cwd, env: envFor(ctx) };
  };
  const envFor = (ctx: Context, extra: Readonly<Record<string, string>> = CLAUDE_ENV) =>
    harnessEnv('claude', extra, ctx.env, ctx.platform);
  // The handshake (above): one answers every question of a look (models, efforts, aliases, limits),
  // and a later one is made when the limits are asked again. What a version's last good one said of
  // its models stands until the next; a version that didn't answer isn't asked again for a while, and
  // the adapter goes on as it did before it (`--help`'s lists, the limits its runs say).
  let shake: { version: string | null; at: number; value: Promise<ClaudeHandshake | null> } | null = null;
  let good: { version: string | null; models: ClaudeModel[] } | null = null;
  let silent: { version: string | null; at: number } | null = null;
  const handshake = (ctx: Context): Promise<ClaudeHandshake | null> => {
    const now = Date.now();
    if (shake && shake.version === ctx.version && now - shake.at < HANDSHAKE_FRESH_MS) return shake.value;
    if (silent && silent.version === ctx.version && now - silent.at < HANDSHAKE_QUIET_MS) return Promise.resolve(null);
    // (kept at once, before anything is waited for: what's asked meanwhile shares this one)
    const value = helpText(ctx)
      // a Claude Code from before the stream of JSON it's asked on has nothing to ask
      .then((help) => (/--input-format\b/.test(help) ? readClaudeHandshake(ctx.bin, probe(ctx)) : null))
      .then(
        (found) => {
          if (found?.models.length) good = { version: ctx.version, models: found.models };
          if (!found) silent = { version: ctx.version, at: Date.now() };
          return found;
        },
        () => null,
      );
    shake = { version: ctx.version, at: now, value };
    return value;
  };
  /** The models the handshake listed for this version (the last good one's, when this one said none). */
  const listed = async (ctx: Context): Promise<ClaudeModel[]> => {
    const found = await handshake(ctx).catch(() => null);
    if (found?.models.length) return found.models;
    return good && good.version === ctx.version ? good.models : [];
  };
  return {
    id: 'claude',
    name: 'Claude Code',
    find(env, platform) {
      const h = home(env);
      return findBinary(
        candidates(
          ['claude'],
          [
            join(h, '.local', 'bin'),
            join(h, '.claude', 'local'),
            join(h, '.npm-global', 'bin'),
            '/usr/local/bin',
            '/opt/homebrew/bin',
          ],
          env.HOLO_CLAUDE,
          env,
          platform,
        ),
        platform,
      );
    },
    toolEnv(ctx, purpose) {
      // its updater must be free to update; the rest runs with the run's own switches
      if (purpose === 'update') {
        const { DISABLE_AUTOUPDATER: _, ...rest } = CLAUDE_ENV;
        return { cwd: probe(ctx).cwd, env: envFor(ctx, rest) };
      }
      return probe(ctx);
    },
    parseVersion: (out) => /\d+\.\d+\.\d+[\w.-]*/.exec(out)?.[0] ?? null,
    async auth(ctx) {
      const out = await capture(ctx.bin, ['auth', 'status', '--json'], { ...probe(ctx), timeoutMs: 15_000 });
      return parseClaudeAuth(out.stdout);
    },
    async sealed(ctx) {
      const text = await helpText(ctx);
      const missing = CLAUDE_NEEDS.filter((o) => !new RegExp(`${o}\\b`).test(text));
      return missing.length
        ? {
            sealed: false,
            reason: `This Claude Code (${ctx.version ?? 'unknown version'}) lacks ${missing.join(', ')}: update it to use it here`,
          }
        : { sealed: true };
    },
    async models(ctx) {
      // what the account may run, as Claude Code lists it as it starts; else the aliases `--help` names
      const models = await listed(ctx);
      return models.length ? models.map((m) => m.value) : claudeModels(await helpText(ctx));
    },
    async efforts(ctx, model) {
      const models = await listed(ctx);
      const all = claudeEfforts(await helpText(ctx));
      if (!models.length) return all;
      // a model's own, where it lists them; else every effort any of them takes (one that lists none
      // is given what's chosen, as before: Claude Code takes or leaves it)
      const own = model ? models.find((m) => m.value === model)?.efforts : undefined;
      if (own?.length) return own;
      const any = [...new Set(models.flatMap((m) => m.efforts ?? []))];
      return any.length ? any : all;
    },
    // what each alias stands for now ("opus" is claude-opus-…), as it lists them: no default model or
    // effort (below)
    async defaults(ctx) {
      const aliases = Object.fromEntries(
        (await listed(ctx))
          .filter((m) => m.resolved && m.resolved !== m.value)
          .map((m) => [m.value, m.resolved as string]),
      );
      return Object.keys(aliases).length ? { aliases } : null;
    },
    // what the account has left, asked as it starts (a claude.ai sign-in's): its runs say it too, so
    // it's asked at a look, not after each of them
    async limits(ctx) {
      return (await handshake(ctx).catch(() => null))?.limits ?? null;
    },
    limitsFromRuns: true,
    // it lists no defaults (they follow the account, and Anthropic's own list): a run is given both,
    // and each run's `init` says what its alias stood for
    mustChoose: true,
    async latest(ctx) {
      // an npm install updates from npm; the native one from Anthropic's release channels. The stable
      // channel is the one read: an install on either channel can reach what it names, so Update never
      // offers a version `claude update` won't install (one on `latest` updates itself sooner anyway)
      const npm = ctx.bin.path.includes('node_modules') || ctx.bin.prefix.some((p) => p.includes('node_modules'));
      if (npm) {
        const d = JSON.parse(await ctx.fetchText('https://registry.npmjs.org/@anthropic-ai/claude-code/stable')) as {
          version?: string;
        };
        return d.version ? { latest: d.version } : null;
      }
      const text = (await ctx.fetchText('https://downloads.claude.ai/claude-code-releases/stable')).trim();
      return /^\d+\.\d+\.\d+[\w.-]*$/.test(text) ? { latest: text } : null;
    },
    login: {
      args: ['auth', 'login'],
      asksCode: true,
      // "If the browser didn't open, visit: <url>", then it reads the pasted code#state on stdin
      parse(text) {
        const url = /visit:\s*(https?:\/\/\S+)/i.exec(plain(text))?.[1] ?? firstUrl(text);
        return url ? { url } : {};
      },
    },
    updateArgs: ['update'],
    // https://code.claude.com/docs/en/setup (native install): ~/.local/bin/claude
    installer: 'curl -fsSL https://claude.ai/install.sh | bash',
    prepare(ctx, job) {
      const files = claudeFiles(job.workspace, serverFor(ctx, job), job.instructions);
      return { args: claudeArgs(job, files), env: { ...CLAUDE_ENV } };
    },
    reader: claudeReader,
    classify: claudeClassify,
  };
}

export function claudeHarness(o: AdapterOptions): Harness {
  return defineHarness(claudeSpec(), o);
}
