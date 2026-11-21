/**
 * A thread's workspace: one folder per conversation, `${XDG_CACHE_HOME:-~/.cache}/holo/agent/<thread>`,
 * mode 0700, outside every repository so a harness's sessions there never mix with the user's own.
 * It stays as long as the thread does (the harnesses find their sessions by it, Cursor's and
 * Antigravity's private homes live in it), and holds:
 *
 * - `.holo-job` (mode 0600): the running job's token, for HO[LO]'s MCP server to read. It's never in
 *   argv, the environment or a log, and it's removed when the job ends.
 * - `.holo-mcp-ready`: written by HO[LO]'s MCP server when an Antigravity run starts it (that harness
 *   doesn't say), removed before each run.
 * - The harness's own files: Claude's `mcp.json`, `settings.json` and `instructions.md`; Codex's
 *   `AGENTS.md`; Cursor's `.cursor/mcp.json`, `.cursor/cli.json`, `AGENTS.md` and `home/`;
 *   Antigravity's `.agents/mcp_config.json`, `.agents/agents/holo.md` and `home/`.
 */
import { chmodSync, lstatSync, mkdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { THREAD } from './types.ts';

/** Where every thread's workspace is. */
export function agentRoot(env: NodeJS.ProcessEnv = process.env): string {
  const cache = env.XDG_CACHE_HOME?.trim() || join(env.HOME?.trim() || homedir(), '.cache');
  return join(cache, 'holo', 'agent');
}

/** A folder of ours, made if need be, mode 0700; refused if something else (a link, a file) is there. */
export function privateDir(path: string): string {
  mkdirSync(path, { recursive: true, mode: 0o700 });
  const st = lstatSync(path);
  if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`${path} isn't a folder of HO[LO]'s`);
  if (typeof process.getuid === 'function' && st.uid !== process.getuid())
    throw new Error(`${path} belongs to someone else`);
  if (process.platform !== 'win32') chmodSync(path, 0o700);
  return path;
}

/** The thread's workspace, made if need be. */
export function openWorkspace(root: string, thread: string): string {
  if (!THREAD.test(thread)) throw new Error('Not a thread id');
  privateDir(root);
  return privateDir(join(root, thread));
}

/** A file only we may read (mode 0600), written fresh so an old file's mode can't linger. */
export function writePrivate(path: string, text: string): void {
  rmSync(path, { force: true });
  writeFileSync(path, text, { mode: 0o600, flag: 'wx' });
}

export const TOKEN_FILE = '.holo-job';

/** The job's token, for HO[LO]'s MCP server: its path. */
export function writeToken(workspace: string, token: string): string {
  const file = join(workspace, TOKEN_FILE);
  writePrivate(file, `${token}\n`);
  return file;
}

/** The job is over: its token goes (it no longer works anyway). */
export function removeToken(workspace: string): void {
  rmSync(join(workspace, TOKEN_FILE), { force: true });
}

/** How a harness starts HO[LO]'s MCP server for a job. */
export interface McpServer {
  command: string;
  args: string[];
  env: Record<string, string>;
}

export interface McpTarget {
  /** Node, and HO[LO]'s folder (where packages/agent/src/mcp.ts is). */
  node: string;
  repo: string;
  base: string;
  job: string;
  workspace: string;
  middleC: 'C3' | 'C4';
}

export function mcpServer(t: McpTarget): McpServer {
  return {
    command: t.node,
    args: ['--disable-warning=ExperimentalWarning', join(t.repo, 'packages', 'agent', 'src', 'mcp.ts')],
    env: {
      HOLO_URL: t.base,
      HOLO_JOB: t.job,
      HOLO_JOB_TOKEN_FILE: join(t.workspace, TOKEN_FILE),
      HOLO_MIDDLE_C: t.middleC,
    },
  };
}

const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;

/** How long Claude waits for one of HO[LO]'s tools (ms); Codex's is the same in seconds. */
export const TOOL_TIMEOUT_MS = 240_000;

/** Claude Code's files: its MCP config (HO[LO]'s server only), its settings, the agent's instructions. */
export function claudeFiles(
  workspace: string,
  server: McpServer,
  instructions: string | null,
): { mcp: string; settings: string; instructions: string | null } {
  const mcp = join(workspace, 'mcp.json');
  writePrivate(mcp, json({ mcpServers: { holo: { type: 'stdio', ...server, timeout: TOOL_TIMEOUT_MS } } }));
  const settings = join(workspace, 'settings.json');
  writePrivate(settings, json({ disableAllHooks: true, autoMemoryEnabled: false, disableClaudeAiConnectors: true }));
  const file = join(workspace, 'instructions.md');
  if (instructions === null) {
    rmSync(file, { force: true });
    return { mcp, settings, instructions: null };
  }
  writePrivate(file, `${instructions.trim()}\n`);
  return { mcp, settings, instructions: file };
}

/** AGENTS.md, which Codex and Cursor read from the workspace (or none). */
export function agentsFile(workspace: string, instructions: string | null): void {
  const file = join(workspace, 'AGENTS.md');
  if (instructions === null) rmSync(file, { force: true });
  else writePrivate(file, `${instructions.trim()}\n`);
}

/** Cursor's permissions: HO[LO]'s tools allowed, everything else denied (deny wins over allow). */
export const CURSOR_PERMISSIONS = {
  allow: ['Mcp(holo:*)'],
  deny: ['Shell(*)', 'Read(**)', 'Write(**)', 'WebFetch(*)'],
};

/** Cursor's files: the workspace's MCP config and permissions, and its private home (kept for resume). */
export function cursorFiles(workspace: string, server: McpServer, instructions: string | null): { home: string } {
  const dir = privateDir(join(workspace, '.cursor'));
  writePrivate(join(dir, 'mcp.json'), json({ mcpServers: { holo: server } }));
  // only known keys: Cursor refuses a cli.json with any other ("version" included)
  writePrivate(join(dir, 'cli.json'), json({ permissions: CURSOR_PERMISSIONS }));
  agentsFile(workspace, instructions);
  const home = privateDir(join(workspace, 'home'));
  privateDir(join(home, '.cursor'));
  return { home };
}

/** The custom agent an Antigravity run runs as (`--agent=holo`). */
export const ANTIGRAVITY_AGENT = 'holo';

/**
 * Antigravity's custom agent: none of its built-in tools or prompt sections
 * (`excludeDefaultComponents`), only the ones `tools` names (none: HO[LO]'s MCP tools come from the
 * workspace's MCP config), never a subagent, and the agent's instructions as its system prompt.
 */
export function antigravityAgent(instructions: string | null, tools: readonly string[] = []): string {
  return [
    '---',
    `name: ${ANTIGRAVITY_AGENT}`,
    "description: Works on the open song through HO[LO]'s tools only.",
    'mainAgent: true',
    'subagent: false',
    'excludeDefaultComponents: true',
    `tools: ${JSON.stringify(tools)}`,
    '---',
    instructions?.trim() || "Work on the open song with HO[LO]'s tools.",
    '',
  ].join('\n');
}

/**
 * Written by HO[LO]'s MCP server, beside the job's token, when a call of finish goes through: a run that
 * ends without it never gave the studio its reply (a refused finish doesn't count). Cleared before each run.
 */
export const FINISHED_FILE = '.holo-finished';

/** Written by HO[LO]'s MCP server when a harness starts it (HOLO_MCP_READY_FILE, Antigravity's runs only). */
export const READY_FILE = '.holo-mcp-ready';

/**
 * Antigravity's files: the workspace's MCP config (HO[LO]'s server, each of its tools loaded up front,
 * so the model has them without the built-in tools that read their schemas; told to mark when it's
 * started, which Antigravity doesn't say), the custom agent, and the private home (kept for resume: the
 * conversations are in it).
 */
export function antigravityFiles(
  workspace: string,
  server: McpServer,
  instructions: string | null,
  tools: readonly string[],
): { home: string } {
  const dir = privateDir(join(workspace, '.agents'));
  const ready = join(workspace, READY_FILE);
  rmSync(ready, { force: true });
  writePrivate(
    join(dir, 'mcp_config.json'),
    json({
      mcpServers: {
        holo: {
          ...server,
          env: { ...server.env, HOLO_MCP_READY_FILE: ready },
          // a call (and the server's start) may take as long as Claude's and Codex's
          timeoutSeconds: TOOL_TIMEOUT_MS / 1000,
          tools: Object.fromEntries(tools.map((t) => [t, { eager: true }])),
        },
      },
    }),
  );
  writePrivate(join(privateDir(join(dir, 'agents')), `${ANTIGRAVITY_AGENT}.md`), antigravityAgent(instructions));
  return { home: privateDir(join(workspace, 'home')) };
}

/** Where Antigravity keeps its sign-in when the desktop has no keyring, under a home. */
export const ANTIGRAVITY_TOKEN = ['.gemini', 'antigravity-cli', 'antigravity-oauth-token'] as const;

/**
 * Ready a private home for Antigravity: its folder, a link to the sign-in file in the user's own home
 * (read by Antigravity, never by HO[LO]: with a keyring it isn't used at all), and its last update check
 * marked now, so it doesn't update itself in the background (it looks at most every 15 minutes).
 */
export function antigravityHome(home: string, realHome: string): void {
  const dir = privateDir(join(home, '.gemini', 'antigravity-cli'));
  privateDir(join(home, '.gemini'));
  privateDir(home);
  const link = join(home, ...ANTIGRAVITY_TOKEN);
  try {
    // made again each time: a sign-in renewed in here may have replaced the link with a file
    rmSync(link, { force: true });
    symlinkSync(join(realHome, ...ANTIGRAVITY_TOKEN), link);
  } catch {
    // no links here (Windows without the right): a keyring's sign-in still works
  }
  const stamp = join(dir, 'last_check.timestamp');
  const now = new Date();
  try {
    utimesSync(stamp, now, now);
  } catch {
    writeFileSync(stamp, '', { mode: 0o600 });
  }
}
