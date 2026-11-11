/**
 * Stand-ins for Claude Code, Codex and Cursor: shell scripts that answer the commands an adapter
 * asks (version, status, models…) and, for a run, record what they were given (argv, environment,
 * stdin, working folder, the job token file's mode) and replay a recorded stream from fixtures/.
 * Every test runs with a temporary HOME, so nothing touches the real harnesses' folders.
 */
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { HarnessEvent, Job, RunEvent } from '../src/harness/types.ts';
import { openWorkspace, writeToken } from '../src/harness/workspace.ts';

export const FIXTURES = resolve(import.meta.dirname, 'fixtures');
export const REPO = resolve(import.meta.dirname, '../../..');

/** sh single quotes. */
export const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

export interface Sandbox {
  dir: string;
  home: string;
  root: string;
  rec: string;
  env: NodeJS.ProcessEnv;
  cleanup(): void;
}

/** A temporary HOME, a workspaces folder, a folder for what the fakes record, and an environment with extras. */
export function sandbox(extra: Record<string, string> = {}): Sandbox {
  const dir = mkdtempSync(join(tmpdir(), 'holo-harness-test-'));
  const home = join(dir, 'home');
  const root = join(dir, 'cache', 'holo', 'agent');
  const rec = join(dir, 'rec');
  mkdirSync(home, { recursive: true });
  mkdirSync(rec, { recursive: true });
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? '/usr/bin:/bin',
    HOME: home,
    LANG: 'C.UTF-8',
    // never to be passed on
    SECRET_OF_ANOTHER_TOOL: 'nope',
    GITHUB_TOKEN: 'ghp_nope',
    NODE_OPTIONS: '--require /tmp/evil.js',
    ...extra,
  };
  return { dir, home, root, rec, env, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

export interface FakeCase {
  /** A sh `case` pattern matched against "$*". */
  when: string;
  /** What to do (sh). */
  run: string;
}

/**
 * A fake harness program. `cases` answer its commands; anything else is a run: it records argv
 * (NUL-separated), environment, stdin, cwd and the token file, then does `run`.
 */
export function fakeBinary(s: Sandbox, name: string, cases: FakeCase[], run: string): string {
  const bin = join(s.dir, 'bin');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, name);
  const r = q(s.rec);
  writeFileSync(
    path,
    `#!/bin/sh
case "$*" in
${cases.map((c) => `  ${c.when}) ${c.run}\n  ;;`).join('\n')}
esac
n=$(ls ${r} | grep -c '^argv' || true)
for a in "$@"; do printf '%s\\0' "$a"; done > ${r}/argv$n
env -0 > ${r}/env$n
pwd > ${r}/cwd$n
if [ -f .holo-job ]; then stat -c '%a' .holo-job > ${r}/token-mode$n; cat .holo-job > ${r}/token$n; fi
cat > ${r}/stdin$n
${run}
`,
  );
  chmodSync(path, 0o755);
  return path;
}

/** Print a fixture's lines. */
export const replay = (fixture: string) => `cat ${q(join(FIXTURES, `${fixture}.jsonl`))}`;

/** What the fake recorded for its nth run. */
export function recorded(s: Sandbox, n = 0) {
  const read = (f: string) =>
    existsSync(join(s.rec, `${f}${n}`)) ? readFileSync(join(s.rec, `${f}${n}`), 'utf8') : '';
  const env: Record<string, string> = {};
  for (const kv of read('env').split('\0')) {
    const i = kv.indexOf('=');
    // what sh sets by itself
    if (i > 0 && !['PWD', 'OLDPWD', 'SHLVL', '_'].includes(kv.slice(0, i))) env[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return {
    argv: read('argv').split('\0').slice(0, -1),
    env,
    stdin: read('stdin'),
    cwd: read('cwd').trim(),
    tokenMode: read('token-mode').trim(),
    token: read('token').trim(),
  };
}

export const TOKEN = 'tok_TEST-0123456789abcdefghijklmnopqrstuvwxyz';
export const PROMPT_MARK = 'PROMPT-MARK-7c1f: add a counter-melody in bars 9 to 16 on the oboe';

/** A job in a fresh workspace, with its token written as the runner writes it. */
export function job(s: Sandbox, over: Partial<Job> = {}): Job {
  const thread = over.thread ?? 'agt_0123456789ab';
  const workspace = openWorkspace(s.root, thread);
  writeToken(workspace, TOKEN);
  return {
    id: 'agj_0123456789ab',
    thread,
    workspace,
    model: '',
    effort: '',
    prompt: `${PROMPT_MARK}\n`,
    instructions: '# Rules\nWork on the open song only.',
    base: 'http://127.0.0.1:47999',
    middleC: 'C4',
    ...over,
  };
}

/** Run a job to its end, collecting what it reported. */
export async function runToEnd(
  h: { run(job: Job, on: (e: RunEvent) => void): { done: Promise<void> } },
  j: Job,
): Promise<RunEvent[]> {
  const events: RunEvent[] = [];
  await h.run(j, (e) => events.push(e)).done;
  return events;
}

export function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Wait until `test` holds (or fail after a while). */
export async function until(test: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (!test()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((ok) => setTimeout(ok, 20));
  }
}

export const collect = () => {
  const events: HarnessEvent[] = [];
  return { events, on: (e: HarnessEvent) => events.push(e) };
};

/** The fixtures' events, parsed. */
export function fixtureEvents(name: string): Record<string, unknown>[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Record<string, unknown>);
}
