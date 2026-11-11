/**
 * A thread's workspace: one folder per conversation, `${XDG_CACHE_HOME:-~/.cache}/holo/agent/<thread>`,
 * mode 0700, outside every repository so a harness's sessions there never mix with the user's own.
 * It stays as long as the thread does (Claude, Codex and Cursor find their sessions by it, Cursor's
 * private home lives in it), and holds:
 *
 * - `.holo-job` (mode 0600): the running job's token, for HO[LO]'s MCP server to read. It's never in
 *   argv, the environment or a log, and it's removed when the job ends.
 * - The harness's own files: Claude's `mcp.json`, `settings.json` and `instructions.md`; Codex's
 *   `AGENTS.md`; Cursor's `.cursor/mcp.json`, `.cursor/cli.json`, `AGENTS.md` and `home/`.
 */
import { chmodSync, lstatSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
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
