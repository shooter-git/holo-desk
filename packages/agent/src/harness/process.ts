/**
 * Starting a harness's program and stopping it, everything it started included. Never through a
 * shell: arguments go to the program as they are. On Linux and macOS each run is its own process
 * group (detached), so stopping it stops its MCP server and any daemon it leaves (Cursor's worker);
 * on Windows the tree is ended with taskkill.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve } from 'node:path';
import type { Binary } from './types.ts';

/** Where a harness might be: its override variable, then PATH, then where its installers put it. */
export function candidates(
  names: readonly string[],
  dirs: readonly string[],
  override: string | undefined,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const exts = platform === 'win32' ? ['.exe', '.cmd', ''] : [''];
  const out: string[] = [];
  if (override) out.push(override);
  const path = env.PATH ?? env.Path ?? '';
  for (const dir of [...path.split(platform === 'win32' ? ';' : delimiter), ...dirs]) {
    if (!dir) continue;
    for (const name of names) for (const ext of exts) out.push(join(dir, `${name}${ext}`));
  }
  return [...new Set(out)];
}

function runnable(path: string, platform: NodeJS.Platform): boolean {
  try {
    if (!statSync(path).isFile()) return false;
    if (platform !== 'win32') accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * What a Windows `.cmd` launcher (npm's shim) really runs: its `.exe`, or node with its script.
 * Null when it isn't one of those: the harness is then shown as unavailable, never run through cmd.
 */
export function resolveShim(file: string, text: string, node: string = process.execPath): Binary | null {
  const dir = dirname(file);
  // npm writes "%dp0%\node_modules\…\cli.js" (or "%~dp0\…"), after its node
  const target = /"%~?dp0%?\\([^"%]+?\.(?:js|cjs|mjs|exe))"/i.exec(text)?.[1];
  if (!target) return null;
  const path = resolve(dir, target.replace(/\\/g, '/'));
  if (!existsSync(path)) return null;
  if (/\.exe$/i.test(path)) return { path, prefix: [] };
  const local = join(dir, 'node.exe');
  return { path: existsSync(local) ? local : node, prefix: [path] };
}

export type Found = { binary: Binary } | { unresolved: string } | null;

/** The first candidate that can run: a program, or a `.cmd` resolved to what it runs. */
export function findBinary(list: readonly string[], platform: NodeJS.Platform = process.platform): Found {
  for (const path of list) {
    if (!runnable(path, platform)) continue;
    if (/\.(cmd|bat)$/i.test(path)) {
      let text = '';
      try {
        text = readFileSync(path, 'utf8');
      } catch {
        // unreadable: as unresolved
      }
      const binary = resolveShim(path, text);
      return binary ? { binary } : { unresolved: path };
    }
    return { binary: { path, prefix: [] } };
  }
  return null;
}

export const home = (env: NodeJS.ProcessEnv = process.env) => env.HOME?.trim() || homedir();

export interface SpawnOptions {
  cwd: string;
  env: Record<string, string>;
}

/** Start a program in a process group of its own, with pipes for all three streams. */
export function start(bin: Binary, args: readonly string[], o: SpawnOptions): ChildProcess {
  return spawn(bin.path, [...bin.prefix, ...args], {
    cwd: o.cwd,
    env: o.env,
    stdio: ['pipe', 'pipe', 'pipe'],
    detached: process.platform !== 'win32',
    windowsHide: true,
    shell: false,
  });
}

function groupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Stop a program and everything in its group: SIGTERM, then SIGKILL for whatever is left after a while. */
export function stopGroup(child: ChildProcess, graceMs = 3000): void {
  const pid = child.pid;
  if (!pid) return;
  if (process.platform === 'win32') {
    spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }).on(
      'error',
      () => undefined,
    );
    return;
  }
  if (!groupAlive(pid)) return;
  try {
    process.kill(-pid, 'SIGTERM');
  } catch {
    return;
  }
  setTimeout(() => {
    if (groupAlive(pid)) {
      try {
        process.kill(-pid, 'SIGKILL');
      } catch {
        // gone meanwhile
      }
    }
  }, graceMs).unref();
}

/** Calls `fn` with each line of a stream as it comes (the last one too, once the stream ends). */
export function eachLine(stream: NodeJS.ReadableStream | null, fn: (line: string) => void): void {
  if (!stream) return;
  let pending = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk: string) => {
    pending += chunk;
    let i = pending.indexOf('\n');
    while (i >= 0) {
      fn(pending.slice(0, i).replace(/\r$/, ''));
      pending = pending.slice(i + 1);
      i = pending.indexOf('\n');
    }
    // a line that never ends shouldn't fill the memory
    if (pending.length > 4_000_000) pending = pending.slice(-1_000_000);
  });
  stream.on('end', () => {
    if (pending) fn(pending);
    pending = '';
  });
}

export interface Captured {
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

/** Run a short command (a version, a status) to the end, or until the time is up; never throws. */
export function capture(
  bin: Binary,
  args: readonly string[],
  o: SpawnOptions & { timeoutMs?: number; input?: string },
): Promise<Captured> {
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = start(bin, args, o);
    } catch (err) {
      done({ code: null, stdout: '', stderr: err instanceof Error ? err.message : String(err), timedOut: false });
      return;
    }
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const cap = 2_000_000;
    child.stdout?.setEncoding('utf8');
    child.stderr?.setEncoding('utf8');
    child.stdout?.on('data', (c: string) => {
      if (stdout.length < cap) stdout += c;
    });
    child.stderr?.on('data', (c: string) => {
      if (stderr.length < cap) stderr += c;
    });
    child.stdin?.on('error', () => undefined);
    child.stdin?.end(o.input ?? '');
    const timer = setTimeout(() => {
      timedOut = true;
      stopGroup(child, 500);
    }, o.timeoutMs ?? 15_000);
    child.on('error', (err) => {
      clearTimeout(timer);
      done({ code: null, stdout, stderr: stderr || err.message, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      // whatever it left behind goes too
      stopGroup(child, 500);
      done({ code, stdout, stderr, timedOut });
    });
  });
}

/** Text as a terminal would show it, less its colours and cursor moves. */
export function plain(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: the escape sequences are what's removed
  return text.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g, '');
}
