/**
 * The agent's side of the runner (`pnpm runner`): it says which harnesses this computer has, runs the
 * jobs HO[LO]'s server hands it (each in its thread's sealed workspace, through the harness's
 * adapter), relays a sign-in, an update or an install when the user asks for one, and prints the
 * pairing code.
 *
 * The server's messages and the runner's answers are in docs/agent.md ("Live channel"). One job runs
 * per thread at a time, and at most two at once; looking for harnesses never holds up the socket.
 * Neither a job's token nor its prompt is ever printed.
 */
import { existsSync, readFileSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { agentRoot, createHarnesses, detectAll } from './harness/index.ts';
import {
  HARNESS_IDS,
  type Harness,
  type HarnessAction,
  type HarnessEvent,
  type HarnessId,
  type HarnessInfo,
  JOB,
  MODEL,
  type RunEvent,
  SESSION,
  THREAD,
  TOKEN,
} from './harness/types.ts';
import { openWorkspace, removeToken, writeToken } from './harness/workspace.ts';

export interface AgentRunnerOptions {
  /** The HO[LO] server the runner is connected to (the job's tools reach it there too). */
  base: string;
  /** Send a message to the server (dropped while the socket is closed). */
  send: (msg: Record<string, unknown>) => void;
  /** HO[LO]'s folder: packages/agent/src/mcp.ts and packages/agent/AGENT.md are in it. */
  repo: string;
  log?: (line: string) => void;
  /** For tests: other harnesses, another folder for the workspaces, another environment. */
  harnesses?: Record<HarnessId, Harness>;
  root?: string;
  env?: NodeJS.ProcessEnv;
  /** At most this many jobs at once (2). */
  maxJobs?: number;
  /** How the studio names middle C, when the job doesn't say. */
  middleC?: () => Promise<'C3' | 'C4'>;
  /** This computer's name, as Settings › Agent shows it (an install's confirmation names it). */
  host?: string;
}

export interface AgentRunner {
  /** What the runner says it can do in its hello. */
  caps: { agent: true };
  /** The socket is open and the hello sent: say what's known of the harnesses (they're looked for on agent-on). */
  connected(): void;
  /** A message from the server: true when it was one of the agent's. */
  handle(msg: Record<string, unknown>): boolean;
  /** Stop every job (the runner is closing). */
  stop(): void;
  /** Jobs running, and waiting for a free slot. */
  busy(): { running: number; waiting: number };
}

/** A job as the server sends it (`agent-run`), checked. */
export interface AgentRun {
  job: string;
  thread: string;
  harness: HarnessId;
  model: string;
  effort: string;
  prompt: string;
  token: string;
  session?: string;
  middleC?: 'C3' | 'C4';
}

const MAX_PROMPT = 400_000;

/** An `agent-run` message as the runner will run it, or why not. */
export function parseRun(msg: Record<string, unknown>): AgentRun | string {
  const { job, thread, harness, prompt, token, session, workspace } = msg;
  if (typeof job !== 'string' || !JOB.test(job)) return 'not a job id';
  if (typeof thread !== 'string' || !THREAD.test(thread)) return 'not a thread id';
  // the workspace is named for the thread: nothing else may name a folder
  if (workspace !== undefined && workspace !== thread) return 'the workspace isn’t the thread’s';
  if (!HARNESS_IDS.includes(harness as HarnessId)) return 'not a harness';
  const model = typeof msg.model === 'string' ? msg.model : '';
  const effort = typeof msg.effort === 'string' ? msg.effort : '';
  if (model && !MODEL.test(model)) return 'not a model name';
  if (effort && !MODEL.test(effort)) return 'not an effort';
  if (typeof prompt !== 'string' || !prompt.trim() || prompt.length > MAX_PROMPT) return 'no prompt';
  if (typeof token !== 'string' || !TOKEN.test(token)) return 'no token';
  if (session !== undefined && session !== null && (typeof session !== 'string' || !SESSION.test(session)))
    return 'not a session id';
  const run: AgentRun = { job, thread, harness: harness as HarnessId, model, effort, prompt, token };
  if (typeof session === 'string') run.session = session;
  if (msg.middleC === 'C3' || msg.middleC === 'C4') run.middleC = msg.middleC;
  return run;
}

/** The agent's standing instructions, as the server reads them for the prompt (prompt.ts readRules). */
export function readInstructions(repo: string): string | null {
  const file = join(repo, 'packages', 'agent', 'AGENT.md');
  try {
    if (!existsSync(file)) return null;
    const text = readFileSync(file, 'utf8').trim();
    return text ? text.slice(0, 40_000) : null;
  } catch {
    return null;
  }
}

/**
 * The prompt less the instructions it starts with, when they're the ones the harness reads from its
 * workspace (they'd be there twice otherwise); as it is when they differ.
 */
export function withoutInstructions(prompt: string, instructions: string | null): string {
  if (!instructions || !prompt.startsWith(instructions)) return prompt;
  const rest = prompt.slice(instructions.length).replace(/^\s+/, '');
  return rest || prompt;
}

const minutesLeft = (expires: unknown) =>
  typeof expires === 'number' && Number.isFinite(expires)
    ? Math.max(1, Math.round((expires - Date.now()) / 60_000))
    : 10;

export function startAgentRunner(o: AgentRunnerOptions): AgentRunner {
  const log = o.log ?? ((line: string) => console.log(line));
  const env = o.env ?? process.env;
  const root = o.root ?? agentRoot(env);
  const harnesses = o.harnesses ?? createHarnesses({ env, root, repo: o.repo });
  const maxJobs = o.maxJobs ?? 2;
  const host = (o.host ?? hostname()).slice(0, 64);
  const middleC =
    o.middleC ??
    (async (): Promise<'C3' | 'C4'> => {
      try {
        const res = await fetch(`${o.base}/api/settings`, { signal: AbortSignal.timeout(3000) });
        const d = (await res.json()) as { middleC?: string };
        return d.middleC === 'C4' ? 'C4' : 'C3';
      } catch {
        return 'C3';
      }
    });

  interface Running {
    run: AgentRun;
    cancel: () => void;
    started: number;
  }
  const running = new Map<string, Running>();
  const waiting: AgentRun[] = [];
  /** Harnesses signing in, updating or installing: no job starts on them meanwhile, and they take no second one. */
  const relaying = new Set<HarnessId>();
  let known: HarnessInfo[] | null = null;
  let detecting: Promise<HarnessInfo[]> | null = null;

  const harnessBusy = (id: HarnessId) => [...running.values()].some((r) => r.run.harness === id);

  function report(list: HarnessInfo[]): void {
    o.send({ type: 'harnesses', list: list.map((h) => ({ ...h, host })) });
  }

  /** Look for the harnesses (one look at a time), and tell the server what was found. */
  function detect(fresh: boolean): Promise<HarnessInfo[]> {
    if (detecting && !fresh) return detecting;
    const look = detectAll(harnesses, fresh).then((list) => {
      known = list;
      if (detecting === look) detecting = null;
      report(list);
      return list;
    });
    detecting = look;
    look.catch(() => {
      if (detecting === look) detecting = null;
    });
    return look;
  }

  function startNext(): void {
    while (running.size < maxJobs) {
      const i = waiting.findIndex(
        (r) => !relaying.has(r.harness) && ![...running.values()].some((x) => x.run.thread === r.thread),
      );
      if (i < 0) return;
      const [next] = waiting.splice(i, 1);
      if (next) void runJob(next);
    }
  }

  async function runJob(run: AgentRun): Promise<void> {
    const started = Date.now();
    let cancelled = false;
    let stop: () => void = () => {
      cancelled = true;
    };
    running.set(run.job, { run, started, cancel: () => stop() });
    const harness = harnesses[run.harness];
    const tag = `[agent ${run.job}]`;
    let workspace: string | null = null;
    try {
      workspace = openWorkspace(root, run.thread);
      writeToken(workspace, run.token);
      const instructions = readInstructions(o.repo);
      const job = {
        id: run.job,
        thread: run.thread,
        workspace,
        model: run.model,
        effort: run.effort,
        prompt: withoutInstructions(run.prompt, instructions),
        instructions,
        base: o.base,
        middleC: run.middleC ?? (await middleC()),
        ...(run.session ? { session: run.session } : {}),
      };
      if (cancelled) return;
      log(
        `${tag} ${harness.name}${run.model ? ` (${run.model}${run.effort ? `, ${run.effort}` : ''})` : ''}, ${run.session ? 'carrying on its conversation' : 'a new conversation'}`,
      );
      const handle = harness.run(job, (e: RunEvent) => {
        switch (e.type) {
          case 'progress':
            o.send({ type: 'agent-progress', job: run.job, line: e.line.slice(0, 200) });
            break;
          case 'session':
            o.send({ type: 'agent-session', job: run.job, session: e.session });
            break;
          case 'done':
            log(`${tag} done in ${Math.round((Date.now() - started) / 1000)} s`);
            // its last words stand as the reply if it never called finish
            o.send({ type: 'agent-done', job: run.job, ...(e.reply ? { reply: e.reply.slice(0, 2000) } : {}) });
            break;
          case 'failed':
            log(`${tag} failed: ${e.error}`);
            o.send({ type: 'agent-failed', job: run.job, error: e.error.slice(0, 500) });
            break;
        }
      });
      stop = handle.cancel;
      await handle.done;
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`${tag} failed: ${error}`);
      if (!cancelled) o.send({ type: 'agent-failed', job: run.job, error: error.slice(0, 500) });
    } finally {
      if (workspace) {
        try {
          removeToken(workspace);
        } catch {
          // the token is revoked when the job ends anyway
        }
      }
      running.delete(run.job);
      startNext();
    }
  }

  function harnessEvent(harness: HarnessId, kind: HarnessAction, e: HarnessEvent): void {
    o.send({ type: 'agent-harness', harness, kind, ...e });
  }

  /** Look again, then say how it went: the studio reloads its settings on `done`, and finds them as they are. */
  async function lookThenSay(id: HarnessId, kind: HarnessAction, e: HarnessEvent): Promise<void> {
    await detect(true).catch(() => undefined);
    harnessEvent(id, kind, e);
  }

  async function login(id: HarnessId): Promise<void> {
    const harness = harnesses[id];
    if (relaying.has(id) || harnessBusy(id)) {
      harnessEvent(id, 'login', { state: 'failed', error: `${harness.name} is busy: try once it’s done` });
      return;
    }
    relaying.add(id);
    const said: { ended: HarnessEvent | null } = { ended: null };
    try {
      log(`Signing in to ${harness.name} (asked from Settings › Agent)…`);
      await harness.login((e) => {
        if (e.url) log(`${harness.name} sign-in: open ${e.url}${e.code ? ` and enter ${e.code}` : ''}`);
        // how it ended is said once the harness has been looked at again (signed in, its seal checked)
        if (e.state === 'running') harnessEvent(id, 'login', e);
        else said.ended = e;
      });
    } finally {
      relaying.delete(id);
      startNext();
      await lookThenSay(id, 'login', said.ended ?? { state: 'failed', error: 'The sign-in didn’t finish' });
    }
  }

  async function update(id: HarnessId): Promise<void> {
    const harness = harnesses[id];
    if (relaying.has(id) || harnessBusy(id)) {
      harnessEvent(id, 'update', { state: 'failed', error: `${harness.name} is busy: try once it’s done` });
      return;
    }
    relaying.add(id);
    log(`Updating ${harness.name} (asked from Settings › Agent)…`);
    harnessEvent(id, 'update', { state: 'running', line: `Updating ${harness.name}` });
    let ended: HarnessEvent;
    try {
      await harness.update((line) => harnessEvent(id, 'update', { state: 'running', line }));
      log(`${harness.name} is updated`);
      ended = { state: 'done' };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`${harness.name} didn’t update: ${error}`);
      ended = { state: 'failed', error };
    } finally {
      relaying.delete(id);
      startNext();
    }
    // its new version's models and efforts are read at once
    await lookThenSay(id, 'update', ended);
  }

  /** Run a harness's official installer (asked from Settings › Agent), then look again. */
  async function install(id: HarnessId): Promise<void> {
    const harness = harnesses[id];
    if (relaying.has(id) || harnessBusy(id)) {
      harnessEvent(id, 'install', { state: 'failed', error: `${harness.name} is busy: try once it’s done` });
      return;
    }
    relaying.add(id);
    log(`Installing ${harness.name} with its official installer (asked from Settings › Agent)…`);
    harnessEvent(id, 'install', { state: 'running', line: `Installing ${harness.name} on ${host}` });
    let ended: HarnessEvent;
    try {
      await harness.install((line) => harnessEvent(id, 'install', { state: 'running', line }));
      const info = (await detect(true)).find((h) => h.id === id);
      const line = `${harness.name}${info?.version ? ` ${info.version}` : ''} is installed`;
      log(line);
      ended = { state: 'done', line };
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      log(`${harness.name} wasn’t installed: ${error}`);
      await detect(true).catch(() => undefined);
      ended = { state: 'failed', error };
    } finally {
      relaying.delete(id);
      startNext();
    }
    harnessEvent(id, 'install', ended);
  }

  return {
    caps: { agent: true },

    connected() {
      // what's known goes at once (a reconnection); nothing is looked for until the server says the
      // agent is on (agent-on): with it off, no harness is run and nothing is fetched
      if (known) report(known);
    },

    handle(msg) {
      switch (msg.type) {
        case 'pairing-code': {
          if (typeof msg.code !== 'string' || !/^\d{6}$/.test(msg.code)) return true;
          const minutes = minutesLeft(msg.expires);
          log(
            `Agent pairing code: ${msg.code} (enter it in Settings › Agent; valid for ${minutes} minute${minutes === 1 ? '' : 's'})`,
          );
          return true;
        }
        case 'agent-run': {
          const run = parseRun(msg);
          if (typeof run === 'string') {
            log(`[agent] refused a job: ${run}`);
            if (typeof msg.job === 'string' && JOB.test(msg.job))
              o.send({ type: 'agent-failed', job: msg.job, error: `The runner refused the job: ${run}` });
            return true;
          }
          if (running.has(run.job) || waiting.some((w) => w.job === run.job)) return true;
          waiting.push(run);
          startNext();
          return true;
        }
        case 'agent-cancel': {
          const id = String(msg.job ?? '');
          const i = waiting.findIndex((w) => w.job === id);
          if (i >= 0) waiting.splice(i, 1);
          const r = running.get(id);
          if (r) {
            log(`[agent ${id}] stopped`);
            r.cancel();
          }
          return true;
        }
        case 'agent-login':
          if (HARNESS_IDS.includes(msg.harness as HarnessId)) void login(msg.harness as HarnessId);
          return true;
        case 'agent-login-code': {
          const id = msg.harness as HarnessId;
          if (!HARNESS_IDS.includes(id)) return true;
          if (typeof msg.code !== 'string' || !harnesses[id].loginCode(msg.code.trim()))
            harnessEvent(id, 'login', { state: 'failed', error: 'No sign-in is waiting for a code' });
          return true;
        }
        case 'agent-update':
          if (HARNESS_IDS.includes(msg.harness as HarnessId)) void update(msg.harness as HarnessId);
          return true;
        case 'agent-install':
          if (HARNESS_IDS.includes(msg.harness as HarnessId)) void install(msg.harness as HarnessId);
          return true;
        case 'agent-on':
          // the agent is on (it was turned on, or this runner joined while it is): look, from memory
          // where it's fresh, the first time and after
          void detect(false).catch((err: unknown) =>
            log(`Looking for agent harnesses failed: ${err instanceof Error ? err.message : String(err)}`),
          );
          return true;
        case 'agent-refresh':
          if (msg.light === true) {
            // Settings › Agent was opened (the server asks at most hourly): versions, sign-ins, models and
            // efforts as they are now, with what's remembered for each version (its seal) kept; quietly
            if (!detecting) void detect(true).catch(() => undefined);
            return true;
          }
          // Look again: a seal check that failed for this version is done again too
          for (const h of Object.values(harnesses)) h.recheck();
          void detect(true).then((list) => {
            for (const h of list) harnessEvent(h.id, 'refresh', { state: 'done' });
          });
          return true;
        default:
          return false;
      }
    },

    stop() {
      waiting.length = 0;
      for (const r of running.values()) r.cancel();
    },

    busy() {
      return { running: running.size, waiting: waiting.length };
    },
  };
}
