/**
 * What the three adapters share: finding the program, asking its version and sign-in, looking up
 * updates (at most every 6 hours, never installing one unasked), relaying a sign-in or an update,
 * and running a turn: the prompt on stdin, the event stream read line by line, each event checked
 * against the tripwire, and the whole process group stopped on a tripwire, a cancel, the time
 * limit, and after every run.
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessEnv } from './env.ts';
import { capture, eachLine, type Found, plain, type SpawnOptions, start, stopGroup } from './process.ts';
import type { AuthStatus, Binary, Harness, HarnessEvent, HarnessId, HarnessInfo, Job, Run, RunEvent } from './types.ts';
import { MODEL } from './types.ts';
import { mcpServer, privateDir } from './workspace.ts';

/** What reading one event (or one line of stderr) found. */
export type Seen =
  | { kind: 'session'; id: string }
  /** One of HO[LO]'s tools was called (its name, without any prefix). */
  | { kind: 'tool'; name: string }
  /** The agent said something (the last one is its reply). */
  | { kind: 'text'; text: string }
  /** Something other than HO[LO]'s tools was used, or offered: the run stops at once. */
  | { kind: 'trip'; why: string }
  /** The harness says the turn failed. */
  | { kind: 'failed'; error: string }
  /** Something the harness said that explains a failure, if one follows. */
  | { kind: 'note'; text: string }
  /** The turn is over. */
  | { kind: 'ended' };

/** Reads one run's stream: a fresh one per run (it may remember what it has seen). */
export interface Reader {
  event(e: Record<string, unknown>): Seen[];
  stderr?(line: string): Seen[];
}

/** What every adapter call gets: the program, its version, and the runner's setting. */
export interface Context {
  bin: Binary;
  version: string | null;
  env: NodeJS.ProcessEnv;
  platform: NodeJS.Platform;
  /** Where the workspaces are (and the runner's own files: what it knows of updates, probes). */
  root: string;
  repo: string;
  node: string;
  fetchText: (url: string) => Promise<string>;
}

export interface Spec {
  id: HarnessId;
  name: string;
  /** Where the program is (process.ts candidates). */
  find(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): Found;
  /** Its environment for everything but a run (version, status, models, sign-in, update). */
  toolEnv(ctx: Context, purpose: 'probe' | 'login' | 'update'): { env: Record<string, string>; cwd: string };
  parseVersion(stdout: string): string | null;
  auth(ctx: Context): Promise<AuthStatus | null>;
  /** Whether it can be limited to HO[LO]'s tools here (and why not). */
  sealed(ctx: Context): Promise<{ sealed: boolean; reason?: string }>;
  models(ctx: Context): Promise<string[]>;
  efforts(ctx: Context, model?: string): Promise<string[]>;
  /** The newest version out, from where its installer gets it; null when unknown. */
  latest(ctx: Context): Promise<{ latest: string; available?: boolean } | null>;
  login: { args: string[]; asksCode: boolean; parse(text: string): { url?: string; code?: string } };
  updateArgs: string[];
  /** The workspace's files for a job, and the run's argv and extra environment. */
  prepare(ctx: Context, job: Job): { args: string[]; env: Record<string, string> };
  reader(): Reader;
  /** A run that failed at once for a reason a second try without it avoids (Cursor's sandbox). */
  retry?(ctx: Context, job: Job, output: string): boolean;
}

export interface AdapterOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  root: string;
  repo: string;
  node?: string;
  fetchText?: (url: string) => Promise<string>;
  now?: () => number;
  /** The longest a run may take (the server's own clock is shorter: this is the backstop). */
  runLimitMs?: number;
}

export const HOUR = 3_600_000;
const UPDATE_TTL = 6 * HOUR;
const LOGIN_LIMIT_MS = 15 * 60_000;
const UPDATE_LIMIT_MS = 10 * 60_000;

async function defaultFetchText(url: string): Promise<string> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000), headers: { accept: '*/*' } });
  if (!res.ok) throw new Error(`${url}: ${res.status}`);
  return res.text();
}

/** The runner's notes about harnesses, kept between runs: updates looked up, probes done. */
export function remember(root: string): {
  get<T>(key: string): T | undefined;
  set(key: string, value: unknown): void;
} {
  const file = join(root, '.harnesses.json');
  const read = (): Record<string, unknown> => {
    try {
      return existsSync(file) ? (JSON.parse(readFileSync(file, 'utf8')) as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  };
  return {
    get: <T>(key: string) => read()[key] as T | undefined,
    set(key, value) {
      try {
        privateDir(root);
        const next = { ...read(), [key]: value };
        const tmp = `${file}.${process.pid}.tmp`;
        writeFileSync(tmp, JSON.stringify(next), { mode: 0o600 });
        renameSync(tmp, file);
      } catch {
        // only a cache
      }
    },
  };
}

/** Compare two versions by their leading numbers (1.2.10 > 1.2.9). */
export function newer(a: string, b: string): boolean {
  const nums = (v: string) => (/^\D*(\d+(?:\.\d+)*)/.exec(v)?.[1] ?? '0').split('.').map(Number);
  const x = nums(a);
  const y = nums(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

/** The first link in some text (what a sign-in prints for the user to open). */
export function firstUrl(text: string): string | undefined {
  return /https?:\/\/[^\s"'<>`]+/.exec(plain(text))?.[0]?.replace(/[).,;]+$/, '');
}

/** What the bar shows while a tool runs: the tool in words, never its name. */
const TOOL_WORDS: Record<string, string> = {
  song_status: 'Reading the song',
  song_show: 'Reading the song',
  notes_show: 'Reading the notes',
  score_show: 'Reading the score',
  score_parts: 'Reading the score',
  instruments: 'Looking through the instruments',
  plugins: 'Looking through the effects',
  packs: 'Looking through the packs',
  notes_write: 'Writing notes',
  notes_clear: 'Clearing notes',
  track_add: 'Adding a track',
  track_set: 'Setting up a track',
  synth_set: 'Shaping the sound',
  kit_set: 'Shaping the kit',
  fx: 'Setting up effects',
  automate: 'Writing automation',
  song_set: 'Changing the song’s settings',
  marker: 'Placing a marker',
  cycle: 'Setting the cycle',
  score_write: 'Writing the score',
  score_part: 'Setting up the score',
  score_meta: 'Setting up the score',
  finish_master: 'Mastering',
  looping: 'Setting the loop',
  ops_apply: 'Making changes',
  transport: 'Using the transport',
  audition: 'Playing an idea',
  listen: 'Listening',
  played: 'Reading what you played',
  analyze_played: 'Reading what you played',
  compare: 'Setting up a comparison',
  scan_show: 'Reading the scan',
  scan_status: 'Marking the scan',
  attachment_get: 'Reading the attachment',
  measure: 'Measuring',
  import: 'Bringing it in',
  regions: 'Editing regions',
  timeline: 'Arranging bars',
  look: 'Asking you',
  ask_permission: 'Asking you',
  hand_off: 'Writing a brief',
  finish: 'Finishing',
};

export function toolWords(name: string): string {
  return TOOL_WORDS[name] ?? 'Working';
}

/** A short, one-line, token-free error for the studio. */
export function cleanError(text: string, secrets: readonly string[] = []): string {
  let out = plain(text);
  for (const s of secrets) if (s) out = out.split(s).join('…');
  out = out.replace(/\s+/g, ' ').trim();
  return out.length > 400 ? `${out.slice(0, 399)}…` : out;
}

/** The last lines of stderr that say something, for an error. */
function tailError(lines: readonly string[]): string {
  const said = lines.map((l) => plain(l).trim()).filter((l) => l && !/^\s*at\s/.test(l));
  const error = said.filter((l) => /error|fail|denied|not|invalid|unknown|cannot|can't/i.test(l));
  return (error.length ? error : said).slice(-3).join(' · ');
}

export function defineHarness(spec: Spec, o: AdapterOptions): Harness {
  const env = o.env ?? process.env;
  const platform = o.platform ?? process.platform;
  const now = o.now ?? Date.now;
  const fetchText = o.fetchText ?? defaultFetchText;
  const memory = remember(o.root);
  const runLimit = o.runLimitMs ?? 60 * 60_000;
  let known: { bin: Binary; version: string | null } | null = null;
  let unresolved: string | null = null;
  let login: { child: ChildProcess; asksCode: boolean } | null = null;

  const context = (bin: Binary, version: string | null): Context => ({
    bin,
    version,
    env,
    platform,
    root: o.root,
    repo: o.repo,
    node: o.node ?? process.execPath,
    fetchText,
  });

  async function found(fresh = false): Promise<Context | null> {
    if (known && !fresh) return context(known.bin, known.version);
    const where = spec.find(env, platform);
    unresolved = where && 'unresolved' in where ? where.unresolved : null;
    if (!where || !('binary' in where)) {
      known = null;
      return null;
    }
    const probe = spec.toolEnv(context(where.binary, null), 'probe');
    const out = await capture(where.binary, ['--version'], { ...probe, timeoutMs: 15_000 });
    const version = out.code === 0 ? spec.parseVersion(out.stdout) : null;
    known = { bin: where.binary, version };
    return context(where.binary, version);
  }

  async function checkUpdate(ctx: Context): Promise<{ available: boolean; latest?: string } | null> {
    if (!ctx.version) return null;
    const key = `update:${spec.id}`;
    const cached = memory.get<{ latest: string; available?: boolean; version: string; at: number }>(key);
    let latest = cached && now() - cached.at < UPDATE_TTL && cached.version === ctx.version ? cached : null;
    if (!latest) {
      try {
        const found = await spec.latest(ctx);
        if (!found) return null;
        latest = { ...found, version: ctx.version, at: now() };
        memory.set(key, latest);
      } catch {
        return null;
      }
    }
    const available = latest.available ?? newer(latest.latest, ctx.version);
    return { available, latest: latest.latest };
  }

  /** Relay a long command's lines (a sign-in, an update) until it ends or runs out of time. */
  function relay(
    ctx: Context,
    args: string[],
    purpose: 'login' | 'update',
    onLine: (text: string) => void,
    limitMs: number,
  ): Promise<{ ok: boolean; tail: string[] }> {
    return new Promise((done) => {
      const where = spec.toolEnv(ctx, purpose);
      let child: ChildProcess;
      try {
        child = start(ctx.bin, args, where);
      } catch (err) {
        done({ ok: false, tail: [err instanceof Error ? err.message : String(err)] });
        return;
      }
      if (purpose === 'login') login = { child, asksCode: spec.login.asksCode };
      // only a sign-in that reads a pasted code keeps its input open
      if (purpose !== 'login' || !spec.login.asksCode) child.stdin?.end();
      child.stdin?.on('error', () => undefined);
      const tail: string[] = [];
      const line = (raw: string) => {
        const text = plain(raw).trim();
        if (!text) return;
        tail.push(text);
        if (tail.length > 30) tail.shift();
        onLine(text);
      };
      eachLine(child.stdout, line);
      eachLine(child.stderr, line);
      const timer = setTimeout(() => stopGroup(child), limitMs);
      timer.unref?.();
      const finish = (ok: boolean) => {
        clearTimeout(timer);
        if (login?.child === child) login = null;
        stopGroup(child, 500);
        done({ ok, tail });
      };
      child.on('error', (err) => {
        tail.push(err.message);
        finish(false);
      });
      child.on('close', (code) => finish(code === 0));
    });
  }

  const harness: Harness = {
    id: spec.id,
    name: spec.name,

    async detect() {
      return (await found(true))?.bin ?? null;
    },

    async info(fresh = false) {
      const base: HarnessInfo = { id: spec.id, name: spec.name, found: false, sealed: false };
      try {
        const ctx = await found(fresh);
        if (!ctx) {
          return unresolved
            ? {
                ...base,
                found: true,
                reason: `Its launcher (${unresolved}) couldn’t be resolved to the program it runs`,
              }
            : { ...base, reason: `${spec.name} isn’t installed on this computer` };
        }
        const info: HarnessInfo = { ...base, found: true };
        if (ctx.version) info.version = ctx.version;
        const [auth, sealed, models, efforts, update] = await Promise.all([
          spec.auth(ctx).catch(() => null),
          spec.sealed(ctx).catch((err: unknown) => ({
            sealed: false,
            reason: err instanceof Error ? err.message : String(err),
          })),
          spec.models(ctx).catch(() => []),
          spec.efforts(ctx).catch(() => []),
          checkUpdate(ctx),
        ]);
        if (auth) {
          info.signedIn = auth.signedIn;
          if (auth.account) info.account = auth.account;
        }
        info.sealed = sealed.sealed;
        if (sealed.reason) info.reason = sealed.reason;
        const okModels = models.filter((m) => MODEL.test(m));
        if (okModels.length) info.models = okModels;
        info.efforts = efforts.filter((e) => MODEL.test(e));
        if (update) info.update = update;
        return info;
      } catch (err) {
        return { ...base, reason: err instanceof Error ? err.message : String(err) };
      }
    },

    async authStatus() {
      const ctx = await found();
      return ctx ? spec.auth(ctx).catch(() => null) : null;
    },

    async login(onEvent) {
      const ctx = await found();
      if (!ctx) {
        onEvent({ state: 'failed', error: `${spec.name} isn’t installed on this computer` });
        return;
      }
      if (login) {
        onEvent({ state: 'failed', error: 'A sign-in is under way already' });
        return;
      }
      const auth = await spec.auth(ctx).catch(() => null);
      if (auth?.signedIn) {
        // HO[LO] never signs out or switches accounts: nothing to do
        onEvent({ state: 'failed', error: `${spec.name} is signed in already` });
        return;
      }
      onEvent({ state: 'running', line: `Starting ${spec.name}’s sign-in` });
      let text = '';
      let told: { url?: string; code?: string } = {};
      const { ok, tail } = await relay(
        ctx,
        spec.login.args,
        'login',
        (line) => {
          text += `${line}\n`;
          const seen = spec.login.parse(text);
          if (seen.url !== told.url || seen.code !== told.code) {
            told = seen;
            const e: HarnessEvent = { state: 'running' };
            if (seen.url) e.url = seen.url;
            if (seen.code) e.code = seen.code;
            if (seen.url && spec.login.asksCode) e.ask = 'code';
            onEvent(e);
          }
        },
        LOGIN_LIMIT_MS,
      );
      const after = await spec.auth(ctx).catch(() => null);
      if (ok && after?.signedIn !== false) onEvent({ state: 'done', line: `${spec.name} is signed in` });
      else onEvent({ state: 'failed', error: cleanError(tailError(tail) || 'The sign-in didn’t finish') });
    },

    loginCode(code) {
      if (!login?.asksCode || !login.child.stdin || login.child.stdin.destroyed) return false;
      if (!/^[\x21-\x7e]{1,600}$/.test(code)) return false;
      login.child.stdin.write(`${code}\n`);
      return true;
    },

    async checkUpdate() {
      const ctx = await found();
      return ctx ? checkUpdate(ctx) : null;
    },

    async update(onLine) {
      const ctx = await found();
      if (!ctx) throw new Error(`${spec.name} isn’t installed on this computer`);
      let last = 0;
      const { ok, tail } = await relay(
        ctx,
        spec.updateArgs,
        'update',
        (line) => {
          // a few lines a second is plenty
          const t = now();
          if (t - last > 300) {
            last = t;
            onLine(line.slice(0, 200));
          }
        },
        UPDATE_LIMIT_MS,
      );
      memory.set(`update:${spec.id}`, undefined);
      await found(true);
      if (!ok) throw new Error(cleanError(tailError(tail) || 'The update failed'));
    },

    async models() {
      const ctx = await found();
      return ctx ? spec.models(ctx) : [];
    },

    async efforts(model) {
      const ctx = await found();
      return ctx ? spec.efforts(ctx, model) : [];
    },

    run(job, onEvent) {
      let cancelled = false;
      let current: ChildProcess | null = null;
      let settled = false;
      const report = (e: RunEvent) => {
        if (cancelled || settled) return;
        if (e.type === 'done' || e.type === 'failed') settled = true;
        onEvent(e);
      };
      const done = (async () => {
        const ctx = await found();
        if (!ctx) return report({ type: 'failed', error: `${spec.name} isn’t installed on this computer` });
        const checked = await checkJob(spec, ctx, job);
        if ('error' in checked) return report({ type: 'failed', error: checked.error });
        let attempt: Job = checked.job;
        for (let tries = 0; tries < 3 && !cancelled; tries++) {
          const outcome = await once(ctx, attempt, report, (c) => {
            current = c;
          });
          if (outcome.again === 'fresh' && attempt.session) {
            // the harness no longer has that session: start the conversation again
            attempt = { ...attempt };
            delete attempt.session;
            continue;
          }
          if (outcome.again === 'same') continue;
          return;
        }
      })().catch((err: unknown) =>
        report({ type: 'failed', error: cleanError(err instanceof Error ? err.message : String(err)) }),
      );
      return {
        done: done.then(() => undefined),
        cancel() {
          cancelled = true;
          if (current) stopGroup(current);
        },
      } satisfies Run;
    },
  };

  /** One go at a turn; `again` asks for another (without the session, or as it was). */
  function once(
    ctx: Context,
    job: Job,
    report: (e: RunEvent) => void,
    started: (c: ChildProcess) => void,
  ): Promise<{ again?: 'fresh' | 'same' }> {
    return new Promise((resolve) => {
      const { args, env: extra } = spec.prepare(ctx, job);
      const runEnv = harnessEnv(spec.id, extra, env, platform);
      const where: SpawnOptions = { cwd: job.workspace, env: runEnv };
      const child = start(ctx.bin, args, where);
      started(child);
      const reader = spec.reader();
      const stderrTail: string[] = [];
      const output: string[] = [];
      let session: string | null = null;
      let tripped: string | null = null;
      let failure: string | null = null;
      let note: string | null = null;
      let ended = false;
      let busy = false;
      let lastLine = '';
      let reply: string | undefined;
      const secrets = [job.prompt.length > 40 ? job.prompt : ''];

      const handle = (seen: Seen[]) => {
        for (const s of seen) {
          if (tripped) return;
          switch (s.kind) {
            case 'session':
              if (s.id !== session) {
                session = s.id;
                report({ type: 'session', session: s.id });
              }
              break;
            case 'tool': {
              busy = true;
              const line = toolWords(s.name);
              if (line !== lastLine) {
                lastLine = line;
                report({ type: 'progress', line });
              }
              break;
            }
            case 'text':
              reply = s.text;
              break;
            case 'trip':
              tripped = s.why;
              // nothing more of this run is believed: it stops now, all of it
              stopGroup(child, 1000);
              break;
            case 'failed':
              failure = s.error;
              break;
            case 'note':
              note = s.text;
              break;
            case 'ended':
              ended = true;
              break;
          }
        }
      };

      eachLine(child.stdout, (line) => {
        if (output.length < 20) output.push(line);
        const text = line.trim();
        if (!text.startsWith('{')) return;
        let event: unknown;
        try {
          event = JSON.parse(text);
        } catch {
          return;
        }
        if (typeof event === 'object' && event !== null && !Array.isArray(event))
          handle(reader.event(event as Record<string, unknown>));
      });
      eachLine(child.stderr, (line) => {
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
        if (reader.stderr) handle(reader.stderr(line));
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(job.prompt);

      let timedOut = false;
      const limit = setTimeout(() => {
        timedOut = true;
        failure = `It took longer than ${Math.round(runLimit / 60_000)} minutes`;
        stopGroup(child);
      }, runLimit);
      limit.unref?.();
      let exited = false;
      child.on('exit', () => {
        exited = true;
        // a daemon it left may hold the pipes open: they close when the group goes (at once when the
        // turn's end has been read, else after a moment for the rest of its output)
        setTimeout(() => stopGroup(child, 500), ended ? 0 : 2000).unref();
      });
      let closed = false;
      const finish = (code: number | null, spawnError?: string) => {
        if (closed) return;
        closed = true;
        clearTimeout(limit);
        // after every run, whatever it started goes (Cursor's worker outlives it otherwise)
        stopGroup(child, 500);
        if (tripped) {
          report({ type: 'failed', error: `Stopped: ${tripped}` });
          return resolve({});
        }
        if (spawnError) {
          report({ type: 'failed', error: cleanError(`${spec.name} couldn’t start: ${spawnError}`, secrets) });
          return resolve({});
        }
        const said = [...output, ...stderrTail].join('\n');
        const early = code !== 0 && !timedOut && !session && !busy;
        if (early && spec.retry?.(ctx, job, said)) return resolve({ again: 'same' });
        // a session the harness no longer has fails before anything starts
        if (early && job.session) return resolve({ again: 'fresh' });
        if (failure) {
          report({ type: 'failed', error: cleanError(failure, secrets) });
          return resolve({});
        }
        if (code === 0 || (ended && exited && code === null)) {
          report(reply ? { type: 'done', reply } : { type: 'done' });
          return resolve({});
        }
        const why = note ?? (tailError(stderrTail) || `${spec.name} stopped (exit ${code ?? 'signal'})`);
        report({ type: 'failed', error: cleanError(why, secrets) });
        resolve({});
      };
      child.on('error', (err) => finish(null, err.message));
      child.on('close', (code) => finish(code));
    });
  }

  return harness;
}

/**
 * A job's model and effort, checked before anything starts: anything that could read as more than a
 * value is refused; an effort the harness doesn't take with that model (a setting left from another
 * harness) is dropped, so it runs at its default.
 */
async function checkJob(spec: Spec, ctx: Context, job: Job): Promise<{ error: string } | { job: Job }> {
  if (job.model && !MODEL.test(job.model)) return { error: `“${job.model}” isn’t a model name` };
  if (job.effort && !MODEL.test(job.effort)) return { error: `“${job.effort}” isn’t an effort` };
  if (job.effort) {
    const efforts = await spec.efforts(ctx, job.model || undefined);
    if (!efforts.includes(job.effort)) return { job: { ...job, effort: '' } };
  }
  return { job };
}

/** The MCP server for a job, as the adapters put it in their config. */
export function serverFor(ctx: Context, job: Job) {
  return mcpServer({
    node: ctx.node,
    repo: ctx.repo,
    base: job.base,
    job: job.id,
    workspace: job.workspace,
    middleC: job.middleC,
  });
}
