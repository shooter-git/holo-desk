/**
 * What the adapters share: finding the program, asking its version and sign-in, looking up
 * updates (at most every 6 hours, never installing one unasked), relaying a sign-in, an update or an
 * install (the vendor's official installer, a fixed command, on a click only), and running a turn: the prompt on stdin, the event stream read line by line, each event checked
 * against the tripwire, and the whole process group stopped on a tripwire, a cancel, the time
 * limit, and after every run.
 */
import type { ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { harnessEnv } from './env.ts';
import {
  candidates,
  capture,
  eachLine,
  type Found,
  findBinary,
  plain,
  type SpawnOptions,
  start,
  stopGroup,
} from './process.ts';
import type { AuthStatus, Binary, Harness, HarnessEvent, HarnessId, HarnessInfo, Job, Run, RunEvent } from './types.ts';
import { MODEL } from './types.ts';
import { FAILED_ONCE_FILE, FINISHED_FILE, mcpServer, privateDir, writePrivate } from './workspace.ts';

/** What reading one event (or one line of stderr) found. */
export type Seen =
  | { kind: 'session'; id: string }
  /** The model the harness says the run uses (Claude Code's `init`). */
  | { kind: 'model'; model: string }
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
  /**
   * Whether it can be limited to HO[LO]'s tools here (and why not). `signedOut`: it wouldn't say
   * before it's signed in, so the seal is unknown (and nothing is remembered).
   */
  sealed(ctx: Context): Promise<Sealed>;
  models(ctx: Context): Promise<string[]>;
  efforts(ctx: Context, model?: string): Promise<string[]>;
  /**
   * What a run uses when it's given no model or no effort, as the harness lists it: its default model,
   * and each model's own effort.
   */
  defaults?(ctx: Context): Promise<{ model?: string; efforts?: Record<string, string> }>;
  /**
   * It lists no defaults (Claude Code): a job without a model and an effort is refused, rather than run
   * with whatever the harness picks (`HarnessInfo.mustChoose`).
   */
  mustChoose?: boolean;
  /** The newest version out, from where its installer gets it; null when unknown. */
  latest(ctx: Context): Promise<{ latest: string; available?: boolean } | null>;
  login: { args: string[]; asksCode: boolean; parse(text: string): { url?: string; code?: string } };
  updateArgs: string[];
  /**
   * The vendor's official installer, as its docs give it: a fixed command run with
   * `bash -o pipefail -c` (never anything from input). Each puts the program in ~/.local/bin.
   */
  installer: string;
  /** The workspace's files for a job, and the run's argv and extra environment. */
  prepare(ctx: Context, job: Job): { args: string[]; env: Record<string, string> };
  reader(): Reader;
  /** A run that failed at once for a reason a second try without it avoids (Cursor's sandbox). */
  retry?(ctx: Context, job: Job, output: string): boolean;
  /**
   * Whether HO[LO]'s MCP server started for this run, for a harness whose stream doesn't say
   * (Antigravity): a run that ends having used none of HO[LO]'s tools, without it, answered without them.
   */
  toolsStarted?(job: Job): boolean;
  /** What a run reads on stdin, when it isn't the prompt as it is (Antigravity's is one JSON line). */
  input?(job: Job): string;
  /**
   * A run that says nothing for this long has stalled before it began (Antigravity waits, silently,
   * for a browser sign-in when its own has lapsed): it's stopped, and `error` says why.
   */
  startup?: { limitMs: number; error: string };
  /**
   * Whether it reads the agent's instructions (its workspace's AGENTS.md) only when a conversation
   * starts, and never on resume (seen with Cursor). A resumed turn then carries them at the head of its
   * prompt, so the rules as they are now reach a conversation begun before they changed, and a long one
   * still has them.
   */
  rulesAtStartOnly?: boolean;
  /**
   * An error in its own result that the harness should get past by itself, so the conversation is kept
   * (Codex's context window: it compacts the conversation before the next turn), but that counts as a
   * refused conversation when a resumed run fails with it again in the conversation whose last run it
   * ended: then it didn't get past it, and every turn would fail the same way.
   */
  refusedIfRepeated?: RegExp;
}

export interface AdapterOptions {
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  root: string;
  repo: string;
  node?: string;
  fetchText?: (url: string) => Promise<string>;
  now?: () => number;
  /**
   * The longest a turn may take when its job doesn't say (an older server; the job's `limitMs`, the
   * server's ceiling, otherwise). This is the backstop: the server ends the job first.
   */
  runLimitMs?: number;
  /**
   * Whether a turn that ended without `finish` is carried on once, asking for it (true unless said:
   * the tests that replay recorded streams, which never call it, turn it off).
   */
  askToFinish?: boolean;
}

/** What a seal check found. */
export interface Sealed {
  sealed: boolean;
  reason?: string;
  signedOut?: boolean;
}

/** What a harness's runs said its aliases stood for, kept between runs (`aliases:<id>` in the runner's notes). */
interface Said {
  /** The account signed in when it was learned. */
  account?: string;
  /** By the model a run was given: the model it said it ran. */
  aliases: Record<string, string>;
}

/** The most aliases remembered from runs. */
const ALIASES_MOST = 50;

export const HOUR = 3_600_000;
const UPDATE_TTL = 6 * HOUR;
/** How long past the server's ceiling a turn is stopped here: the server's own end comes first. */
const PAST_CEILING_MS = 60_000;
const LOGIN_LIMIT_MS = 15 * 60_000;
const UPDATE_LIMIT_MS = 10 * 60_000;
const INSTALL_LIMIT_MS = 10 * 60_000;

/** Said when an installer finished but the runner still can't find what it installed. */
export const NOT_SEEN =
  'Installed in ~/.local/bin, which the runner doesn’t see: run `pnpm run runner-service on` again on the host';

/** Where the installers run: they're bash scripts. */
export const INSTALLS_ON: readonly NodeJS.Platform[] = ['linux', 'darwin'];

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
  capture: 'Keeping what you played',
  chords: 'Writing the chords',
  steps: 'Working on the drum pattern',
  stack: 'Stacking tracks',
  compare: 'Setting up a comparison',
  scan_show: 'Reading the scan',
  scan_status: 'Marking the scan',
  attachment_get: 'Reading the attachment',
  measure: 'Measuring',
  import: 'Bringing it in',
  regions: 'Editing regions',
  audio_notes: 'Editing a recording’s notes',
  timeline: 'Arranging bars',
  look: 'Asking you',
  ask_permission: 'Asking you',
  hand_off: 'Writing a brief',
  version: 'Keeping a version',
  finish: 'Finishing',
};

/**
 * Said to a harness that ended its turn without calling `finish`, in the same conversation: whatever it
 * wrote in its own chat never reached the person (the server shows its last words only as a stand-in).
 */
export const FINISH_NOW =
  "Your turn ended without a finish that went through, so the person saw nothing you wrote: only finish reaches them. Call finish now, without doing the work again: a short label, and as the reply one or two short sentences of plain text (no markdown) with your answer or what you did; put any details in finish's view. If finish refused your view, write it as its answer showed, or leave it out and don't mention it. Then stop.";

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

/**
 * How each harness says, in the error its own result carries, that its model service refused the
 * conversation itself: the request is the conversation so far, so carried on, much the same one is
 * sent again and refused again (seen with Antigravity: a conversation refused once was refused again on
 * the next turn's first request, though what was asked had changed). Each is the whole error's start,
 * as the harness writes it (docs/agent-harnesses.md, "A refused conversation", has where each was seen):
 * - Antigravity: Gemini's `INVALID_ARGUMENT (code 400): …` (seen in real use; not
 *   `FAILED_PRECONDITION (code 400)`, a location the API doesn't serve);
 * - Claude Code: `API Error: 400 …`, the API's message or its own words for a broken history ("due to
 *   tool use concurrency issues", "orphaned tool_result…"), never the API's JSON; and `Prompt is too
 *   long` or `Request too large`, said only once it couldn't compact the conversation to fit;
 * - Codex: the API's own JSON body, as it came (`{"error":{…"type":"invalid_request_error"…}}`, or over
 *   its WebSocket `{"type":"error","status":400,…}`): a 400 is the only status it shows that way. It
 *   shows any other as `unexpected status <status>: <the body's message>`, so a 400 in that form counts
 *   too (an older Codex wrote it so, with the body). Its context-window error ("Codex ran out of room…")
 *   counts only when it's repeated (`refusedIfRepeated` in codex.ts): Codex compacts the conversation
 *   before the next turn's first request, which should be enough.
 * Cursor's isn't in its stream at all (a failed run has no `result`; it prints the error on stderr):
 * none of its failures counts.
 */
const REFUSALS: Partial<Record<HarnessId, RegExp>> = {
  antigravity: /^INVALID_ARGUMENT \(code 400\):/,
  claude: /^(?:API Error: 400 |Prompt is too long\b|Request too large\b)/,
  codex: /^(?:unexpected status 400 Bad Request: |\{[\s\S]*"type":\s*"invalid_request_error")/,
};

/**
 * What the same 400s also say that has nothing to do with the conversation, and is ordinary: the
 * account (billing, credits, a plan, a quota, a disabled organization), where it is, a model it can't
 * use or a setting it doesn't take, a sign-in. Another conversation would be refused just the same, and
 * this one is worth keeping.
 * Phrases only, never a bare word a refusal may quote from the conversation ("region", "plan", "access"
 * and "not found" are all HO[LO]'s own words): Gemini's location refusal is `FAILED_PRECONDITION`, never
 * matched anyway.
 */
const ORDINARY = new RegExp(
  [
    'credit balance',
    'billing',
    'payment',
    'quota',
    'usage limit',
    'upgrade (?:your )?plan',
    'plans? (?:&|and) billing',
    'organization has been disabled',
    'disabled organization',
    'user location is not supported',
    'not (?:supported|available) in your (?:country|region|location)',
    'model\\b[^.]{0,80}?(?:not supported|unsupported|not available|not found|does not exist)',
    'invalid model name',
    'unsupported parameter',
    'organization must be verified',
    '"code":\\s*"(?:model_not_found|unsupported_parameter)"',
    '(?:do|does) not have access to (?:the |this |that )?(?:model|it)\\b',
    'not logged in',
    '(?:log|sign) ?in again',
    'please (?:log|sign) ?in',
    'unauthori[sz]ed',
    'permission denied',
    'api key',
    'authenticat',
    // what Codex adds to an error when the sign-in was refused
    'auth error(?: code)?:',
  ].join('|'),
  'i',
);

/**
 * Whether a harness's own error (its result's, never a tool's answer or the model's words) says its
 * model service refused the conversation itself.
 */
export function refusedRequest(harness: HarnessId, error: string): boolean {
  const said = error.trim();
  return !!REFUSALS[harness]?.test(said) && !ORDINARY.test(said);
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
  const askToFinish = o.askToFinish ?? true;
  let known: { bin: Binary; version: string | null } | null = null;
  let unresolved: string | null = null;
  let login: { child: ChildProcess; asksCode: boolean } | null = null;
  /** The models the last look found, for its version: a job's model is checked against them. */
  let offered: { version: string | null; models: string[] } | null = null;
  const sealKey = `sealed:${spec.id}`;
  /** A seal check that failed for this version is done again at the next look. */
  const forgetFailedSeal = () => {
    const cached = memory.get<{ sealed?: boolean }>(sealKey);
    if (cached && cached.sealed !== true) memory.set(sealKey, undefined);
  };
  /** The defaults the last look listed (`spec.defaults`), and the account it was signed in with. */
  let listed: { model?: string; efforts?: Record<string, string> } | null = null;
  let account: string | undefined;
  const saidKey = `aliases:${spec.id}`;

  /** The aliases the harness's runs said, for the account signed in now (another's may differ: another plan). */
  function aliasesSaid(): Record<string, string> {
    const known = memory.get<Said>(saidKey);
    if (!known || typeof known !== 'object' || (account && known.account && known.account !== account)) return {};
    return Object.fromEntries(
      Object.entries(known.aliases ?? {}).filter(([name, model]) => MODEL.test(name) && MODEL.test(model)),
    );
  }

  /** Remember that a run given `given` said it ran `ran`; true when that's new. */
  function learn(given: string, ran: string): boolean {
    if (!given || given === ran || !MODEL.test(ran)) return false;
    const aliases = aliasesSaid();
    if (aliases[given] === ran && memory.get<Said>(saidKey)?.account === account) return false;
    if (!(given in aliases) && Object.keys(aliases).length >= ALIASES_MOST) return false;
    aliases[given] = ran;
    memory.set(saidKey, { ...(account ? { account } : {}), aliases } satisfies Said);
    return true;
  }

  /** The harness's defaults as it lists them, and what its aliases stood for. */
  function defaults(): Pick<HarnessInfo, 'defaultModel' | 'defaultEfforts' | 'aliases'> {
    const out: Pick<HarnessInfo, 'defaultModel' | 'defaultEfforts' | 'aliases'> = {};
    if (listed?.model) out.defaultModel = listed.model;
    const efforts = Object.fromEntries(
      Object.entries(listed?.efforts ?? {}).filter(([m, e]) => MODEL.test(m) && MODEL.test(e)),
    );
    if (Object.keys(efforts).length) out.defaultEfforts = efforts;
    const aliases = aliasesSaid();
    if (Object.keys(aliases).length) out.aliases = aliases;
    return out;
  }

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

  /** Relay a long command's lines (a sign-in, an update, an installer) until it ends or runs out of time. */
  function relay(
    bin: Binary,
    args: string[],
    where: SpawnOptions,
    purpose: 'login' | 'update' | 'install',
    onLine: (text: string) => void,
    limitMs: number,
  ): Promise<{ ok: boolean; tail: string[] }> {
    return new Promise((done) => {
      let child: ChildProcess;
      try {
        child = start(bin, args, where);
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

  /** A long command's lines as they're relayed: a few a second is plenty. */
  const fewLines = (onLine: (line: string) => void) => {
    let last = 0;
    return (line: string) => {
      const t = now();
      if (t - last > 300) {
        last = t;
        onLine(line.slice(0, 200));
      }
    };
  };

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
          if (unresolved)
            return {
              ...base,
              found: true,
              reason: `Its launcher (${unresolved}) couldn’t be resolved to the program it runs`,
            };
          const missing: HarnessInfo = { ...base, reason: `${spec.name} isn’t installed on this computer` };
          if (INSTALLS_ON.includes(platform)) missing.installer = spec.installer;
          return missing;
        }
        const info: HarnessInfo = { ...base, found: true };
        if (ctx.version) info.version = ctx.version;
        const [auth, sealed, models, efforts, update, given] = await Promise.all([
          spec.auth(ctx).catch(() => null),
          spec.sealed(ctx).catch(
            (err: unknown): Sealed => ({
              sealed: false,
              reason: err instanceof Error ? err.message : String(err),
            }),
          ),
          spec.models(ctx).catch(() => []),
          spec.efforts(ctx).catch(() => []),
          checkUpdate(ctx),
          spec.defaults ? spec.defaults(ctx).catch(() => null) : null,
        ]);
        if (auth) {
          info.signedIn = auth.signedIn;
          if (auth.account) {
            info.account = auth.account;
            account = auth.account;
          }
        }
        listed = given;
        info.sealed = sealed.sealed;
        if (sealed.reason) info.reason = sealed.reason;
        if (sealed.signedOut) {
          // it asked for its sign-in before saying whether it can be sealed: signed out, whatever its
          // status said, and checked again at the first look once it's signed in
          info.signedIn = false;
          delete info.account;
          info.sealed = false;
          info.sealUnknown = true;
        }
        const okModels = models.filter((m) => MODEL.test(m));
        offered = { version: ctx.version, models: okModels };
        if (okModels.length) info.models = okModels;
        info.efforts = efforts.filter((e) => MODEL.test(e));
        // each model's own efforts, when they aren't all the same (the lists are read already: no new look)
        const all = info.efforts.join(' ');
        const byModel = await Promise.all(
          okModels.map(async (m) => {
            const own = await spec.efforts(ctx, m).catch(() => null);
            return [m, own ? own.filter((e) => MODEL.test(e)) : (info.efforts ?? [])] as const;
          }),
        );
        if (byModel.some(([, own]) => own.join(' ') !== all)) info.modelEfforts = Object.fromEntries(byModel);
        Object.assign(info, defaults());
        if (spec.mustChoose) info.mustChoose = true;
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
        ctx.bin,
        spec.login.args,
        spec.toolEnv(ctx, 'login'),
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
      if (ok && after?.signedIn !== false) {
        // a seal check that failed while it was signed out is done again at the next look
        forgetFailedSeal();
        onEvent({ state: 'done', line: `${spec.name} is signed in` });
      } else onEvent({ state: 'failed', error: cleanError(tailError(tail) || 'The sign-in didn’t finish') });
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
      const { ok, tail } = await relay(
        ctx.bin,
        spec.updateArgs,
        spec.toolEnv(ctx, 'update'),
        'update',
        fewLines(onLine),
        UPDATE_LIMIT_MS,
      );
      memory.set(`update:${spec.id}`, undefined);
      await found(true);
      if (!ok) throw new Error(cleanError(tailError(tail) || 'The update failed'));
    },

    async install(onLine) {
      if (!INSTALLS_ON.includes(platform))
        throw new Error(`HO[LO] installs ${spec.name} on Linux and macOS: install it by hand here`);
      if ((await found(true)) || unresolved) throw new Error(`${spec.name} is installed already`);
      // the fixed command, run by bash: nothing from input reaches it. pipefail: a download that fails
      // fails the install, rather than handing bash nothing to run
      const bash = findBinary(candidates(['bash'], ['/bin', '/usr/bin'], undefined, env, platform), platform);
      if (!bash || !('binary' in bash)) throw new Error('bash isn’t on this computer');
      // as the user's own update runs: their home and environment (the allowlist), not a sealed run's
      const where: SpawnOptions = {
        cwd: privateDir(join(o.root, '.probe')),
        env: harnessEnv(spec.id, {}, env, platform),
      };
      const { ok, tail } = await relay(
        bash.binary,
        ['-o', 'pipefail', '-c', spec.installer],
        where,
        'install',
        fewLines(onLine),
        INSTALL_LIMIT_MS,
      );
      memory.set(`update:${spec.id}`, undefined);
      const after = await found(true);
      if (!ok) throw new Error(cleanError(tailError(tail) || 'The installer failed'));
      if (!after) throw new Error(NOT_SEEN);
    },

    recheck() {
      forgetFailedSeal();
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
        const checked = await checkJob(spec, ctx, job, offered?.version === ctx.version ? offered.models : null);
        if ('error' in checked) return report({ type: 'failed', error: checked.error });
        const given = checked.job;
        let attempt: Job = withRules(given);
        /** Set once the turn has been carried on to ask for finish: what the turn itself last said. */
        let asked: { said: string } | null = null;
        // one limit for the whole turn, the go asked for finish included: a minute past the server's ceiling
        const ms = given.limitMs ?? runLimit;
        const deadline = { at: now() + (given.limitMs !== undefined ? ms + PAST_CEILING_MS : ms), ms };
        for (let tries = 0; tries < 3 && !cancelled; tries++) {
          const outcome = await once(
            ctx,
            attempt,
            report,
            (c) => {
              current = c;
            },
            asked,
            deadline,
          );
          if (outcome.again === 'finish' && !asked) {
            // the same conversation, asked only for finish (not a retry: it doesn't count as one)
            asked = { said: outcome.said ?? '' };
            attempt = { ...attempt, session: outcome.session, prompt: FINISH_NOW };
            tries--;
            continue;
          }
          if (outcome.again === 'fresh' && attempt.session) {
            // the harness no longer has that session: start the conversation again (it reads the rules then)
            attempt = { ...attempt, prompt: given.prompt };
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

  /**
   * What a run ended with, for an error that counts as a refusal only when repeated
   * (`spec.refusedIfRepeated`): the conversation it failed in is noted in the workspace, and any other
   * outcome clears it. True when this run resumed the conversation the last one failed in, and failed
   * with it again.
   */
  function failedOnce(job: Job, session: string | null, error: string | null): boolean {
    const file = join(job.workspace, FAILED_ONCE_FILE);
    const repeated = error !== null && !!spec.refusedIfRepeated?.test(error.trim());
    let before: string | null = null;
    try {
      before = existsSync(file) ? readFileSync(file, 'utf8').trim() : null;
    } catch {
      // as if it weren't there
    }
    const again = repeated && !!job.session && before === job.session;
    const now = session ?? job.session;
    try {
      if (repeated && !again && now) writePrivate(file, now);
      else rmSync(file, { force: true });
    } catch {
      // only a note: without it, the next failure counts as the first
    }
    return again;
  }

  /** A resumed turn's prompt, for a harness that reads its instructions only when a conversation starts: the rules first. */
  function withRules(job: Job): Job {
    const rules = job.instructions?.trim();
    if (!spec.rulesAtStartOnly || !job.session || !rules || job.prompt.startsWith(rules)) return job;
    return { ...job, prompt: `${rules}\n\n${job.prompt}` };
  }

  /**
   * One go at a turn; `again` asks for another (without the session, or as it was), or for the turn to
   * be carried on in `session` to ask for finish, which it never called (`said`: its last words).
   * `asked` is set on that go: the turn's own last words, which stand if this go doesn't finish either.
   * `deadline` is the turn's: when every go must be over (`at`, on `now()`), and the limit it says (`ms`).
   */
  function once(
    ctx: Context,
    job: Job,
    report: (e: RunEvent) => void,
    started: (c: ChildProcess) => void,
    asked: { said: string } | null,
    deadline: { at: number; ms: number },
  ): Promise<{ again?: 'fresh' | 'same' } | { again: 'finish'; session: string; said?: string }> {
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
      let model: string | null = null;
      let tripped: string | null = null;
      let failure: string | null = null;
      /** The error the harness's own result said (its reader's `failed`), not one of HO[LO]'s limits. */
      let harnessError: string | null = null;
      let note: string | null = null;
      let ended = false;
      let busy = false;
      /** Whether the harness has said anything yet (an event on stdout). */
      let heard = false;
      let lastLine = '';
      let reply: string | undefined;
      // written by HO[LO]'s MCP server when a finish goes through: this run's own, from nothing
      const finishedFile = join(job.workspace, FINISHED_FILE);
      rmSync(finishedFile, { force: true });
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
            case 'model':
              model = s.model;
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
              harnessError = s.error;
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
        if (typeof event === 'object' && event !== null && !Array.isArray(event)) {
          heard = true;
          handle(reader.event(event as Record<string, unknown>));
        }
      });
      eachLine(child.stderr, (line) => {
        stderrTail.push(line);
        if (stderrTail.length > 40) stderrTail.shift();
        if (reader.stderr) handle(reader.stderr(line));
      });
      child.stdin?.on('error', () => undefined);
      child.stdin?.end(spec.input ? spec.input(job) : job.prompt);

      let timedOut = false;
      const limit = setTimeout(
        () => {
          timedOut = true;
          failure = `It took longer than ${Math.round(deadline.ms / 60_000)} minutes`;
          stopGroup(child);
        },
        Math.max(0, deadline.at - now()),
      );
      limit.unref?.();
      const startup = spec.startup;
      const silent = startup
        ? setTimeout(() => {
            if (heard) return;
            timedOut = true;
            failure = startup.error;
            stopGroup(child);
          }, startup.limitMs)
        : null;
      silent?.unref?.();
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
        if (silent) clearTimeout(silent);
        // after every run, whatever it started goes (Cursor's worker outlives it otherwise)
        stopGroup(child, 500);
        // whether it failed, again, in the same conversation, with an error that counts only then
        const again = failedOnce(job, session, timedOut || tripped || spawnError ? null : harnessError);
        if (tripped) {
          report({ type: 'failed', error: `Stopped: ${tripped}` });
          return resolve({});
        }
        if (asked && (spawnError || failure || !(code === 0 || (ended && exited && code === null)))) {
          // only asked for finish: the turn itself went well, so its own last words stand
          report(asked.said ? { type: 'done', reply: asked.said } : { type: 'done' });
          return resolve({});
        }
        if (spawnError) {
          report({ type: 'failed', error: cleanError(`${spec.name} couldn’t start: ${spawnError}`, secrets) });
          return resolve({});
        }
        // the model its alias stood for, when that's news (Settings shows it)
        if (model && learn(job.model, model)) report({ type: 'aliases', aliases: aliasesSaid() });
        const said = [...output, ...stderrTail].join('\n');
        const early = code !== 0 && !timedOut && !session && !busy;
        if (early && spec.retry?.(ctx, job, said)) return resolve({ again: 'same' });
        // a session the harness no longer has fails before anything starts
        if (early && job.session) return resolve({ again: 'fresh' });
        // its model service refused the conversation itself: carried on, it's refused again. A resumed
        // one that hadn't called a tool yet starts again, once, as a new conversation; else the turn
        // fails, and the next one starts a new conversation
        const succeeded = code === 0 || (ended && exited && code === null);
        const refused = !timedOut && harnessError !== null && (refusedRequest(spec.id, harnessError) || again);
        if (refused && job.session && !busy) return resolve({ again: 'fresh' });
        const fresh = refused ? { fresh: true as const } : {};
        if (failure) {
          report({ type: 'failed', error: cleanError(failure, secrets), ...fresh });
          return resolve({});
        }
        if (succeeded) {
          if (!asked && !busy && spec.toolsStarted && !spec.toolsStarted(job)) {
            report({
              type: 'failed',
              error: `HO[LO]’s tools didn’t start in ${spec.name}, so it answered without them`,
            });
            return resolve({});
          }
          const carryOn = session ?? job.session;
          if (!asked && askToFinish && carryOn && !existsSync(finishedFile)) {
            return resolve({ again: 'finish', session: carryOn, ...(reply ? { said: reply } : {}) });
          }
          const said = asked?.said || reply;
          report(said ? { type: 'done', reply: said } : { type: 'done' });
          return resolve({});
        }
        const why = note ?? (tailError(stderrTail) || `${spec.name} stopped (exit ${code ?? 'signal'})`);
        report({ type: 'failed', error: cleanError(why, secrets), ...fresh });
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
 * value is refused. A model the harness no longer offers (its last look listed others) is dropped, and
 * so is an effort it doesn't take with the model (one no longer offered, or a setting left from
 * another harness): the run uses the harness's default rather than failing. A harness that lists no
 * defaults (`mustChoose`) is refused instead: it runs only with a model and an effort it offers.
 * `models` is what the last look listed for this version (null: not looked at yet, so they're asked
 * for now).
 */
async function checkJob(
  spec: Spec,
  ctx: Context,
  job: Job,
  models: string[] | null,
): Promise<{ error: string } | { job: Job }> {
  if (job.model && !MODEL.test(job.model)) return { error: `“${job.model}” isn’t a model name` };
  if (job.effort && !MODEL.test(job.effort)) return { error: `“${job.effort}” isn’t an effort` };
  let out = job;
  if (out.model) {
    const list = models ?? (await spec.models(ctx).catch(() => [])).filter((m) => MODEL.test(m));
    // an empty list says nothing (it couldn't be read): the model is passed on
    if (list.length && !list.includes(out.model)) out = { ...out, model: '' };
  }
  if (out.effort) {
    const efforts: string[] = await spec.efforts(ctx, out.model || undefined).catch(() => []);
    // with no defaults, an empty list says nothing (it couldn't be read): the effort is passed on
    if (!efforts.includes(out.effort) && !(spec.mustChoose && !efforts.length)) out = { ...out, effort: '' };
  }
  if (spec.mustChoose && (!out.model || !out.effort)) return { error: chooseText(spec.name, job, out) };
  return { job: out };
}

/** Why a harness that lists no defaults won't run: what's to be chosen, and what was and has gone. */
function chooseText(name: string, given: Pick<Job, 'model' | 'effort'>, kept: Pick<Job, 'model' | 'effort'>): string {
  const what = !kept.model && !kept.effort ? 'a model and an effort' : !kept.model ? 'a model' : 'an effort';
  const gone = [
    given.model && !kept.model ? `“${given.model}”` : null,
    given.effort && !kept.effort ? `“${given.effort}” effort` : null,
  ].filter(Boolean);
  const choose = `${what} for ${name} in Settings › Agent`;
  return gone.length ? `${name} no longer offers ${gone.join(' or ')}: choose ${choose}` : `Choose ${choose}`;
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
