/**
 * The harnesses the in-app agent runs through (Claude Code, Codex, Cursor), as the runner sees them:
 * found or not, signed in or not, sealed to HO[LO]'s tools or not, and how a job runs in one.
 * docs/agent-harnesses.md records why each adapter does what it does.
 */

export type HarnessId = 'claude' | 'codex' | 'cursor';

export const HARNESS_IDS: readonly HarnessId[] = ['claude', 'codex', 'cursor'];

/** A model or effort as the harnesses take them: passed as `--opt=value`, so nothing that reads as more. */
export const MODEL = /^[A-Za-z0-9][\w.:\-[\]=]{0,79}$/;

/** A thread id, which names its workspace folder. */
export const THREAD = /^[a-z0-9_]{6,40}$/;

/** A job id, as the server makes them. */
export const JOB = /^agj_[0-9a-f]{12}$/;

/** A harness's session id (it comes back from the harness, and goes to it again as `--resume=`). */
export const SESSION = /^[A-Za-z0-9][\w.:-]{0,199}$/;

/** A job token: base64url, as the server makes them. */
export const TOKEN = /^[A-Za-z0-9_-]{20,200}$/;

/** A harness as the server and the studio see it (docs/agent.md, `HarnessInfo`). */
export interface HarnessInfo {
  id: HarnessId;
  name: string;
  found: boolean;
  version?: string;
  signedIn?: boolean;
  account?: string;
  update?: { available: boolean; latest?: string };
  /** False when it can't be limited to HO[LO]'s tools here; `reason` says why. */
  sealed: boolean;
  /**
   * The seal couldn't be checked yet: the harness asks for its sign-in before it reads its options
   * (Cursor). It's signed out; once it's signed in, the next look checks the seal.
   */
  sealUnknown?: boolean;
  reason?: string;
  models?: string[];
  efforts?: string[];
  /** The computer the runner that reports it is on (its host name). */
  host?: string;
  /** Not found: the official installer Install runs there (fixed in the adapter, never from input). */
  installer?: string;
}

/** What to start for a harness: the program, and any arguments before ours (a Windows shim's script). */
export interface Binary {
  path: string;
  prefix: string[];
}

/** A job as the runner hands it to an adapter: checked, with its workspace made. */
export interface Job {
  id: string;
  thread: string;
  /** The thread's workspace folder (workspace.ts), with the job's token in it already. */
  workspace: string;
  /** Empty: the harness's own default. */
  model: string;
  effort: string;
  /** What the harness reads on stdin: never in argv. */
  prompt: string;
  /** The agent's standing instructions (AGENT.md), put where the harness reads them; null: none. */
  instructions: string | null;
  /** The harness's session to carry on, when the thread has one. */
  session?: string;
  /** HO[LO]'s server, as the job's tools reach it. */
  base: string;
  /** How the studio names middle C. */
  middleC: 'C3' | 'C4';
}

/** What a run reports, in order: progress lines, its session, then exactly one of done or failed. */
export type RunEvent =
  | { type: 'progress'; line: string }
  | { type: 'session'; session: string }
  | { type: 'done'; reply?: string }
  | { type: 'failed'; error: string };

export interface Run {
  /** Settles once the harness and everything it started are gone. */
  done: Promise<void>;
  /** Stop now: the whole process group goes. Nothing more is reported. */
  cancel(): void;
}

/** What a harness's relay is (the `agent-harness` message's `kind`). */
export type HarnessAction = 'login' | 'update' | 'install' | 'refresh';

/** How a sign-in, an update, an install or a refresh goes (the `agent-harness` message, less its harness and kind). */
export interface HarnessEvent {
  state: 'running' | 'done' | 'failed';
  url?: string;
  code?: string;
  ask?: 'code';
  line?: string;
  error?: string;
}

export interface AuthStatus {
  signedIn: boolean;
  account?: string;
}

export interface Harness {
  readonly id: HarnessId;
  readonly name: string;
  /** Where it is on this computer, or null. */
  detect(): Promise<Binary | null>;
  /** Everything the studio shows about it. Never throws; `fresh` looks again rather than using what's known. */
  info(fresh?: boolean): Promise<HarnessInfo>;
  /** Signed in or not; null when that couldn't be told. */
  authStatus(): Promise<AuthStatus | null>;
  /**
   * Sign in, relaying what the harness prints: a link, a one-time code, or a request for a pasted
   * code (given with loginCode). Refused when it's signed in already: HO[LO] never signs out or
   * switches accounts.
   */
  login(onEvent: (e: HarnessEvent) => void): Promise<void>;
  /** A code pasted for the sign-in under way; false when none is waiting for one. */
  loginCode(code: string): boolean;
  /** Whether a newer version is out (looked up at most every 6 hours); null when that couldn't be told. */
  checkUpdate(): Promise<{ available: boolean; latest?: string } | null>;
  /** Run the harness's own updater (only when the user clicks Update), relaying its lines. */
  update(onLine: (line: string) => void): Promise<void>;
  /**
   * Run its vendor's official installer (only when the user clicks Install, and only while it isn't
   * found), relaying its lines, then look again. Throws when it's installed already, when the
   * installer fails, or when what it installed still can't be found.
   */
  install(onLine: (line: string) => void): Promise<void>;
  /** Forget a seal check that failed for this version (Look again): the next look checks it again. */
  recheck(): void;
  models(): Promise<string[]>;
  /** The efforts a model takes (none: effort is part of the model, or there's no such setting). */
  efforts(model?: string): Promise<string[]>;
  /** Run one turn of a job in its workspace. */
  run(job: Job, onEvent: (e: RunEvent) => void): Run;
}
