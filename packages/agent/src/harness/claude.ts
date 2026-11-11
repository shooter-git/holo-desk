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
import { candidates, capture, findBinary, home, plain } from './process.ts';
import type { Harness, Job } from './types.ts';
import { claudeFiles, privateDir } from './workspace.ts';

export const CLAUDE_EFFORTS = ['low', 'medium', 'high', 'xhigh', 'max'] as const;

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
      if (e.type === 'result') {
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

/** `claude auth status` (JSON; exits 1 when signed out). */
export function parseClaudeAuth(stdout: string): { signedIn: boolean; account?: string } | null {
  try {
    const d = JSON.parse(stdout) as Record<string, unknown>;
    if (typeof d.loggedIn !== 'boolean') return null;
    const account = [d.email, d.orgName].find((v): v is string => typeof v === 'string' && v.length > 0);
    return { signedIn: d.loggedIn, ...(d.loggedIn && account ? { account } : {}) };
  } catch {
    return null;
  }
}

/** The model aliases `--help` names ("e.g. 'fable', 'opus', or 'sonnet'"), with the usual ones. */
export function claudeModels(help: string): string[] {
  const line = /--model <model>[\s\S]{0,400}?\)/.exec(help)?.[0] ?? '';
  const named = [...line.matchAll(/'([a-z][a-z0-9-]{1,30})'/g)].map((m) => m[1] as string);
  return [...new Set([...named, ...ALIASES])];
}

export function claudeSpec(): Spec {
  // sealed() and models() both read --help: once per version
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
      return claudeModels(await helpText(ctx));
    },
    async efforts() {
      return [...CLAUDE_EFFORTS];
    },
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
    prepare(ctx, job) {
      const files = claudeFiles(job.workspace, serverFor(ctx, job), job.instructions);
      return { args: claudeArgs(job, files), env: { ...CLAUDE_ENV } };
    },
    reader: claudeReader,
  };
}

export function claudeHarness(o: AdapterOptions): Harness {
  return defineHarness(claudeSpec(), o);
}
