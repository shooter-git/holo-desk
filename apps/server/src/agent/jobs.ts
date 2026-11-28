/**
 * The agent's jobs: a request from a device's studio, carried out by a harness the runner starts on
 * this computer. One job runs per song, and a device may have jobs on several songs at once. Each has a
 * token for its tools (valid only while it runs) and belongs to the runner it was handed to: only that
 * runner may say how it goes. Its changes reach only the studio that asked, as one undo step; when its
 * turn is done the studio saves, and the song as saved is what the agent saw, for "since your last
 * reply" next time.
 *
 * The user may leave while it works (a phone switched to another app, the tab closed, another song
 * opened). Its changes still land: while the studio that asked is away from the song, they're saved
 * here as revisions by "Agent", and that studio picks them up as the job's undo step when it's back
 * on it (`awayFor`). What needs the studio itself (playing, listening, its meters) is refused
 * meanwhile, saying so (`BACKGROUND`).
 *
 * A job is `waiting` until the runner or its tools are first heard from, then `running`. One its
 * runner holds until another has finished (`agent-queued`) waits without a limit of its own: its
 * quiet and its ceiling start as it starts. It ends `done`, `awaiting` (it asked for a permission: the
 * user's click starts the follow-up), `failed` (the harness failed, the runner dropped, it went quiet
 * for 15 minutes or ran past its ceiling) or `cancelled` (Stop, the requester undid the job's change,
 * the device was removed, the agent turned off).
 */
import { randomBytes } from 'node:crypto';
import { checkFailureKind, checkLimits, checkPlan, checkUsage, type HarnessLimits } from '@holo/agent/limits';
import {
  AFTER,
  BEFORE,
  type Block,
  DOCK_NEEDS_VIEW,
  type Go,
  PREVIOUS,
  LIMITS as VIEW_LIMITS,
  type View,
  viewVersions,
} from '@holo/agent/view';
import { SCAN_ID, type Scan } from '@holo/score';
import { applyOps, barToTick, type MiddleC, type Op, type Project, parseProject, type Region } from '@holo/session';
import type { Store } from '../db.ts';
import {
  type AgentHooks,
  type Answer,
  type EditorState,
  GONE,
  type Live,
  type LiveClient,
  NO_ANSWER,
  type PlayedNote,
  type RunnerState,
} from '../live.ts';
import { hashToken, newToken, sameHash } from './auth.ts';
import { plainReply } from './plain.ts';
import {
  type AttachmentInfo,
  buildPrompt,
  carryOnRequest,
  contextLines,
  eventLine,
  historySections,
  NOT_NOW,
  oneLine,
  type Permission,
  type PermissionKind,
  permissionFollowUp,
  permissionWords,
  presetRequest,
  presetTitle,
  type RecordedTurn,
  type RequestContext,
  readRules,
  type ScanPreset,
  type Section,
  sizeText,
  songLines,
} from './prompt.ts';
import {
  type AgentStore,
  CHOSEN_ONLY,
  HARNESSES,
  type HarnessId,
  KEEP_CHANGES,
  type ThreadRow,
  type TurnExtra,
  type TurnStop,
  type UnfinishedTurn,
  type UsageSum,
} from './store.ts';
import { parseExtra, type Threads } from './threads.ts';

export type JobState = 'waiting' | 'running' | 'awaiting' | 'done' | 'failed' | 'cancelled';

/** A line of a hand-off brief the studio flags: a command to run, a link, or a secret it mentions. */
export interface BriefWarning {
  /** Its index in the brief's lines (from 0). */
  line: number;
  kind: 'command' | 'url' | 'secret';
}

/** A job as the studios see it (docs/agent.md). */
export interface JobView {
  id: string;
  project: string;
  device: string;
  state: JobState;
  request: string;
  line?: string;
  reply?: string;
  label?: string;
  permission?: Permission;
  brief?: string;
  briefWarnings?: BriefWarning[];
  /** What the reply shows under it (resolved, its versions as revisions), and where the studio goes as it arrives. */
  view?: View;
  go?: Go;
  error?: string;
  started: number;
  finished?: number;
  /** The song's title as the request was made: a studio with another song open names it by this. */
  title?: string;
  /** The harness it runs with, and the model and effort given it (none: the harness's own). */
  harness?: HarnessId;
  model?: string;
  effort?: string;
  /** Why it didn't go on, when that's known for sure (the studio offers what would help). */
  stop?: TurnStop;
  /** The earlier go at the same request it carries on: its changes join that go's undo step. */
  continues?: string;
}

/** A harness on the runner's computer, as the runner reports it. */
export interface HarnessInfo {
  id: HarnessId;
  name: string;
  found: boolean;
  version?: string;
  signedIn?: boolean;
  account?: string;
  /** The account's plan, in its vendor's word for it. */
  plan?: string;
  /** What the account has left, as its vendor reports it (`@holo/agent/limits`), when the harness says. */
  limits?: HarnessLimits;
  update?: { available: boolean; latest?: string };
  sealed: boolean;
  /** Its seal couldn't be checked yet: it asks for its sign-in first (it's signed out). */
  sealUnknown?: boolean;
  reason?: string;
  models?: string[];
  efforts?: string[];
  /** By model: the efforts it takes, when the models don't all take the same. */
  modelEfforts?: Record<string, string[]>;
  /** What a run given no model uses, as the harness lists it. */
  defaultModel?: string;
  /** By model: the effort a run given none uses. */
  defaultEfforts?: Record<string, string>;
  /** By alias: the model it stood for at its last run. */
  aliases?: Record<string, string>;
  /** It lists no defaults (Claude Code): a request needs a model and an effort chosen (`chooseText`). */
  mustChoose?: boolean;
  /** The runner's computer. */
  host?: string;
  /** Not found: the official installer Install would run there. */
  installer?: string;
}

/** How often, at most, opening Settings › Agent has a runner look at its harnesses again. */
export const LOOK_EVERY_MS = 3_600_000;

/** How often, at most, opening Settings › Agent has a runner ask its harnesses what their accounts have left. */
export const LIMITS_EVERY_MS = 60_000;

/** How far back Settings › Agent adds up what the requests used. */
export const USAGE_DAYS = 30;

/** A job as the server keeps it. */
export interface AgentJob {
  view: JobView;
  thread: string;
  harness: HarnessId;
  /** The model and effort it was handed to its runner with (empty: the harness's own). */
  model: string;
  effort: string;
  /** sha256 of its tools' token; null once revoked. */
  tokenHash: string | null;
  preset: ScanPreset | null;
  /** What it asked the user to allow during its turn: it waits for them once the turn ends. */
  asked: Permission | null;
  /** Batches applied here (its studio was away), each once: their revisions. */
  batches: Map<string, number>;
  /** Its latest run of batches saved here while its studio was away, for that studio to pick up. */
  away: AwayRun | null;
  /** Its ceiling, and the countdown once its runner dropped. */
  clock: NodeJS.Timeout | null;
  dropped: NodeJS.Timeout | null;
  /**
   * The quiet that ends it, started again each time it's heard from, and its tool calls under way:
   * while one is, it isn't quiet.
   */
  quiet: NodeJS.Timeout | null;
  calls: number;
  /** Its runner holds it until another has finished: it isn't quiet, and its ceiling hasn't begun. */
  queued: boolean;
  /** What the line under the bar said while it was held (it goes as the job starts). */
  queuedLine?: string;
  /** Its ceiling (ms), counted from when it starts. */
  ceiling: number;
  /** Its turn is over: the studio is saving, and the song is being read. */
  ending: boolean;
  /** The attachments its request carried (its tools may read these, and earlier ones on its thread). */
  attachments: string[];
  /** A part of a listen under way (its tool waits on it), and whether the studio shows it's listening. */
  listen: { finish: (done: boolean) => void } | null;
  listenOn: boolean;
  /** A listen, from its first part to its last: what it has heard, through the pauses between parts. */
  hearing: Hearing | null;
  /** Between two parts of one listen: the studio stops showing it unless the next part comes soon. */
  listenOff: NodeJS.Timeout | null;
  /** Done was pressed between two parts of a listen: the next part ends at once. */
  doneListening: boolean;
  /** The revision kept as the song before the request ("before"), and the versions its tools named. */
  before: number | null;
  versions: Map<string, number>;
  /** The song before the conversation's previous request ("previous"); none on its first. */
  previous: number | null;
  /** Its tools changed the song (an A/B of "before" and "after" plays the same song otherwise). */
  changed: boolean;
  /** What the studio showed as it was asked (null: nothing said, or a follow-up). */
  context: RequestContext | null;
  /** What it was told the user did before it, as it read it. */
  heard: string[];
  /** What its tools changed, in order: each batch's label, and how many in a row had it. */
  changes: [string, number][];
  /** Why it didn't go on, when that's known for sure. */
  stop: TurnStop | null;
  /** The earlier go at the same request it carries on (a turn that didn't finish), or null. */
  continues: string | null;
  /** What the user allowed, and what happened, when it follows a permission: its request is carried on. */
  allowed: string | null;
}

/** What a turn that was working says when HO[LO] stopped under it (its error, and what the agent hears next). */
export const RESTARTED = 'HO[LO] restarted while it was working';

/**
 * A listen, heard as one: its notes are collected from its first part to its last, the pauses between
 * parts included, and their times count from its start. A collector is swapped for a fresh one only
 * at the end of a part when no key is held, so no note is ever split between two: a part that ends
 * while a key is down hands its notes on to a later part, with their lengths whole.
 */
interface Hearing {
  /** When it began (Date.now()). */
  start: number;
  /** How many parts have begun, and how many notes have been handed out. */
  parts: number;
  given: number;
  /** The collector running now (null once Done between two parts stopped it), and when it began, from `start`. */
  stop: (() => PlayedNote[]) | null;
  from: number;
  /** As the collector last said: the notes it has, and the keys held; and when it last heard anything. */
  count: number;
  held: number;
  heardAt: number;
  /** What was heard before Done was pressed between two parts: the next part hands it out. */
  kept: PlayedNote[];
  /** The part under way, told when a note starts or ends. */
  onHeard: (() => void) | null;
}

/**
 * A job's batches saved here one after another while its studio was away: the song went from `base`
 * to `head` through them, with no one else's save in between. The studio picks them up as the job's
 * step when it's back (docs/agent.md, "The studio that asked, away").
 */
export interface AwayRun {
  base: number;
  head: number;
  batches: { batch: string; label: string; revision: number }[];
  /**
   * Its last few revisions past the one the requester's studio last said it's at, as saved (JSON, not
   * parsed: a big song is a few MB a copy), for the one it says next to be kept (`keepPickedUp`). Let go
   * as the studio catches up, and as the job ends: the agent saves no more of the run then, so the one
   * it says is the song as it is.
   */
  recent: { revision: number; doc: string }[];
  /** The last revision of it the requester's studio has said it's at (kept in the song's history if it could be). */
  kept?: number;
}

/** How many of a run's latest revisions are kept at hand, for the studio to say it's at one of them. */
const RUN_RECENT = 4;

/** What a studio back on the song picks up of a run (`Jobs.awayFor`): the batches after its revision. */
export interface AwayChanges {
  job: string;
  /** The job's label once it has finished, else its last batch's. */
  label: string;
  running: boolean;
  /**
   * The revision the batches were made on: the studio's own, or (it was before the run) the run's
   * first (a save of the studio's got here, its answer lost).
   */
  base: number;
  /** The revision the song is at with them, and the song as it is then. */
  head: number;
  /** By id: the studio puts its own changes onto the song as it is (merge-songs.ts), not the batches. */
  batches: { batch: string }[];
  song: Project;
}

/**
 * A device's studio that left a song: when, whether its page was hidden then, and what it showed.
 * `elsewhere`: it opened another song (it isn't waited for, as one that reloads is).
 */
interface Left {
  at: number;
  hidden: boolean;
  state: EditorState;
  elsewhere?: boolean;
}

/** What one part of a listen gives back. */
export interface ListenPart {
  /** The notes this part hands out, their times in ms from the start of the whole listen: parts concatenate. */
  notes: PlayedNote[];
  /** The listen is over (quiet, Done, its last part, or the job ending); not: ask for the next part. */
  done: boolean;
  /** Which part this was (1: it began a listen). */
  part: number;
  /** Notes heard but held over to a later part (a key was down when this one ended). */
  pending: number;
}

/** A refusal: the HTTP status, the words the studio (or the agent) shows, and a reason it can act on. */
export class Refusal extends Error {
  readonly status: number;
  readonly reason: string | undefined;
  constructor(status: number, message: string, reason?: string) {
    super(message);
    this.status = status;
    this.reason = reason;
  }
}

/** A model or effort as the harnesses take them (passed as `--opt=value`, so nothing that reads as more). */
export const MODEL = /^[A-Za-z0-9][\w.:\-[\]=]{0,79}$/;
export const JOB_ID = /^agj_[0-9a-f]{12}$/;

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

/** A limit in words: "15 minutes", "2 hours". */
const inWords = (ms: number) =>
  ms >= 2 * HOUR && ms % HOUR === 0 ? `${ms / HOUR} hours` : `${Math.round(ms / MINUTE)} minutes`;

/** What a tool hears when the requester's studio went away before it answered. */
export const AWAY =
  'The studio that asked went away before it answered (a reload, its network, or its page sent to the background): try again in a moment';
/** What a change hears when the studio went away before saying whether it went in. */
export const WENT =
  'The studio that asked went away before saying whether this change went in: read the song again, and make the change again only if it isn’t there';
/**
 * What a tool that needs the requester's studio itself hears while that studio is away from the song
 * (its page in the background or closed, or another song open in it): changes still land, and what's
 * to hear or see waits for the reply's view.
 */
export const BACKGROUND =
  'The user doesn’t have this song in front of them now (their studio’s page is in the background or closed, or they have another song open in it), so nothing can be played, heard or read in it until they’re back. Changes to the song still land: carry on, and put what there is to hear or see in your reply’s view, for when they’re back';
/**
 * What asking for the studio's meters hears while that studio is away from the song: they can't be
 * read, and levels don't need them (the mix and the tracks are rendered and measured on the host).
 */
export const METERS_AWAY =
  'The user doesn’t have this song in front of them now (their studio’s page is in the background or closed, or they have another song open in it), so its meters can’t be read until they’re back. Checking levels doesn’t need them: measure the mix or the tracks instead (what: "mix" or "tracks"), which are rendered here without the studio, with loudness, peaks and bands';
/**
 * What the line under the bar says of a job its runner holds: until another has finished, or (`why:
 * 'harness'`) until its harness has signed in or updated.
 */
export const QUEUED = 'Waiting for another request to finish';
export const queuedFor = (harness: string) => `Waiting for ${harness} to be ready`;
/** What a studio answers a change with when the job's song isn't the one it has open (it just opened another). */
export const NOT_OPEN = 'not-open';

export interface Limits {
  /**
   * How long a job may go unheard from before it's ended: no tool call, no line under the bar, no
   * message from its runner about it. A tool call under way (a render, a measurement) counts until it
   * answers.
   */
  idleMs: number;
  /**
   * The longest a request may take, and a scan preset, however busy: a ceiling for a run that never
   * ends. The runner is told it (`agent-run`'s `limitMs`) and stops the harness a little past it.
   */
  clockMs: number;
  scanClockMs: number;
  /** How long a job outlives its runner's connection. */
  droppedMs: number;
  /** How long the studio has to save, and to apply a batch of changes. */
  flushMs: number;
  opsMs: number;
  /**
   * How long a listen waits for its next part (the studio keeps showing it's listening, and what's
   * played meanwhile goes to that part); past it, the listen is over and what came after it is let go.
   */
  listenGraceMs: number;
  /** How long the studio has to say what was just played, and to start A/B. */
  playedMs: number;
  compareMs: number;
  /**
   * How long a tool that needs the requester's studio waits for it to come back (a reload, its
   * network back) before it's told the studio is away.
   */
  awayMs: number;
  /**
   * How long a studio whose page is hidden has to apply a batch: past it, its browser has frozen the
   * page (a phone in another app), and the batch is saved here.
   */
  hiddenMs: number;
  /** How long a batch waits for a studio that's back to pick up the changes saved here meanwhile. */
  catchUpMs: number;
}

export const LIMITS: Limits = {
  idleMs: 15 * MINUTE,
  clockMs: 2 * HOUR,
  // (a scan preset reads a whole score: longer than a request, as ever)
  scanClockMs: 3 * HOUR,
  droppedMs: 15_000,
  flushMs: 10_000,
  opsMs: 60_000,
  // (the model reads a part's answer and calls again: with reasoning on, that can take a while)
  listenGraceMs: 15_000,
  playedMs: 3_000,
  compareMs: 50_000,
  // (most tool calls are given up after 30 s: the wait, then what the studio does, fits in that)
  awayMs: 15_000,
  hiddenMs: 8_000,
  catchUpMs: 3_000,
};

export interface JobsOptions {
  live: Live;
  store: Store;
  agentStore: AgentStore;
  threads: Threads;
  /** HO[LO]'s folder (where packages/agent/AGENT.md is). */
  repoDir: string;
  /** The URL the agent's tools reach this server at. */
  base: () => string;
  scan: (id: string) => Scan | null;
  /** An attachment a device sent for a song (null: none, or not that device's for that song). */
  attachment?: (id: string, project: string, device: string) => AttachmentInfo | null;
  /** The device an agent token belongs to, and whether a device is still allowed. */
  deviceFor: (token: string) => string | null;
  allowed: (device: string) => boolean;
  limits?: Partial<Limits>;
}

/** What a request asks for, checked by its route. */
export interface NewRequest {
  project: string;
  text: string;
  context?: RequestContext;
  attachments: string[];
  preset: ScanPreset | null;
}

const LIVE: ReadonlySet<JobState> = new Set(['waiting', 'running']);
/** What a runner says of a job it's working on (not of one that just ended). */
const STILL_AT_IT: ReadonlySet<string> = new Set(['agent-queued', 'agent-started', 'agent-progress', 'agent-session']);
const isLive = (job: AgentJob) => LIVE.has(job.view.state);
const HARNESS_NAMES: Record<HarnessId, string> = {
  claude: 'Claude Code',
  codex: 'Codex',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
};

/**
 * Why a harness that lists no defaults (`mustChoose`) won't run with this model and effort: what's
 * left to choose, and what was chosen and is no longer offered (an empty list says nothing, as the
 * runner takes it). Null when it will, or when the harness has defaults of its own.
 */
export function chooseText(name: string, info: HarnessInfo, model: string, effort: string, own = false): string | null {
  if (!info.mustChoose) return null;
  const offered = (list: string[] | undefined, value: string) => !!value && (!list?.length || list.includes(value));
  const keptModel = offered(info.models, model);
  const keptEffort = offered(info.efforts, effort);
  if (keptModel && keptEffort) return null;
  const what = !keptModel && !keptEffort ? 'a model and an effort' : !keptModel ? 'a model' : 'an effort';
  const gone = [model && !keptModel ? `“${model}”` : null, effort && !keptEffort ? `“${effort}” effort` : null].filter(
    Boolean,
  );
  // (where it's chosen: the song's own choice is the line at the top of the agent's page, not Settings')
  const choose = `${what} for ${name} ${own ? OWN_CHOICE : 'in Settings › Agent'}`;
  return gone.length ? `${name} no longer offers ${gone.join(' or ')}: choose ${choose}` : `Choose ${choose}`;
}

/** Where a song's own choice is changed, as a refusal says it. */
const OWN_CHOICE = 'in this song’s own choice, the line at the top of the agent’s page';

/**
 * Why no runner takes the agent's jobs, said to an allowed device: none connected, or the one that is
 * from before keys, can't read the key, or has another HO[LO]'s.
 */
export function noRunnerText({ state, host }: { state: RunnerState; host: string | null }): string {
  const it = `The runner${host ? ` on ${host}` : ''}`;
  if (state === 'old')
    return `${it} is from an older HO[LO] than this one: bring its checkout up to this version and restart it`;
  if (state === 'no-key')
    return `${it} can’t read HO[LO]’s runner key: run it from the checkout whose data folder HO[LO] uses (or give it HOLO_RUNNER_KEY)`;
  if (state === 'wrong-key')
    return `${it} has another HO[LO]’s runner key: point its HOLO_DATA_DIR at this HO[LO]’s data folder`;
  return 'No runner is connected: start it on the computer HO[LO] runs on (pnpm runner; on Linux, pnpm run runner-service on keeps it running)';
}

export class Jobs implements AgentHooks {
  private readonly o: JobsOptions;
  private readonly limits: Limits;
  private readonly jobs = new Map<string, AgentJob>();
  /** The runner each job was handed to: only it may say how the job goes. */
  private readonly assigned = new WeakMap<AgentJob, LiveClient>();
  /** What each runner said it has. */
  private readonly reported = new WeakMap<LiveClient, HarnessInfo[]>();
  /** When each runner last said what it has, or was last asked to look (whichever came last). */
  private readonly looked = new WeakMap<LiveClient, number>();
  /** When each runner was last asked what its harnesses' accounts have left. */
  private readonly limitsAsked = new WeakMap<LiveClient, number>();
  /**
   * A sign-in, an update or an install under way, by harness, as its runner last told it: a studio that
   * opens Settings later, or again after a reload (a phone does, coming back from the sign-in page), is
   * shown it.
   */
  private readonly relays = new Map<HarnessId, { event: Record<string, unknown>; runner: LiveClient; at: number }>();
  /**
   * Requests that were working when HO[LO] last stopped. Their runner outlived it and may run them
   * still (nothing they do reaches a song now: their tokens went with HO[LO]), holding up their
   * conversations' next requests: each runner is told to stop them as it comes back.
   */
  private readonly orphans = new Set<string>();
  private readonly toldOrphans = new WeakSet<LiveClient>();
  /** The jobs whose prompt is known to have reached their harness's session (`reachedSession`). */
  private readonly reachedBy = new WeakSet<AgentJob>();
  /** The batches each job's changes were noted for (`noteChange`), by id. */
  private readonly noted = new WeakMap<AgentJob, Set<string>>();
  /** Songs a request is being started on (it waits for the studio to save first). */
  private readonly starting = new Set<string>();
  /** Told when a job ends, however it ends (its state says how). */
  private readonly endings: ((job: AgentJob) => void)[] = [];
  /** Tools waiting for a device's studio to come back with a song open: by device and song. */
  private readonly comingBack = new Map<string, Set<() => void>>();
  /** Devices' studios that left a song and haven't come back to it: by device and song. */
  private readonly left = new Map<string, Left>();
  /**
   * Studios still connected whose hidden page didn't answer (its browser froze it: a phone in another
   * app): away until they report from a page in view.
   */
  private readonly frozen = new WeakSet<LiveClient>();

  constructor(options: JobsOptions) {
    this.o = options;
    this.limits = { ...LIMITS, ...options.limits };
  }

  /**
   * As HO[LO] starts: the turns that weren't over when it stopped. One waiting for the user's click
   * still waits (its job is made again from its turn, so the click works as before): unless its
   * conversation was started over, its device is no longer allowed, or the turn is from before turns
   * kept who asked. One that was working can't go on (its tools' token went with HO[LO]): it reads
   * failed, saying why, and the agent hears so next time.
   */
  recover(): void {
    const waiting = new Map<string, AgentJob>();
    for (const row of this.o.agentStore.unfinishedTurns()) {
      const extra = parseExtra(row.extra);
      if (row.state !== 'awaiting') {
        const next: TurnExtra = { ...extra, error: RESTARTED, stop: { why: 'interrupted' }, finished: Date.now() };
        this.o.agentStore.updateTurn(row.job, { state: 'failed', extra: JSON.stringify(next) });
        this.o.threads.addEventTo(row.thread, { action: 'failed', label: RESTARTED, at: Date.now() });
        this.orphans.add(row.job);
        continue;
      }
      const thread = this.o.threads.get(row.thread);
      const kept =
        thread && row.project && row.current === 1 && row.device && extra.permission && this.o.allowed(row.device)
          ? jobFromTurn(row, extra, row.project, row.device, extra.harness ?? thread.harness)
          : null;
      if (!kept) {
        this.o.agentStore.updateTurn(row.job, { state: 'cancelled' });
        continue;
      }
      // (a song has one click waiting at most: its newest, as a later request passes an earlier one over)
      const earlier = waiting.get(kept.view.project);
      if (earlier) {
        this.jobs.delete(earlier.view.id);
        this.o.agentStore.updateTurn(earlier.view.id, { state: 'done' });
      }
      waiting.set(kept.view.project, kept);
      this.jobs.set(kept.view.id, kept);
    }
  }

  /**
   * A job's harness is at work on its prompt (its tools were heard from, its runner said a line of it,
   * or its turn ended well): its session now knows the conversation up to this turn. A go that never
   * got that far told it nothing, and what it missed is told it again next time.
   */
  private reachedSession(job: AgentJob): void {
    if (this.reachedBy.has(job)) return;
    this.reachedBy.add(job);
    this.o.threads.reached(job.thread, job.harness, job.view.id);
  }

  /** Whether a request is at work, or being started: an update of HO[LO] waits for it (`/api/health`). */
  working(): boolean {
    if (this.starting.size) return true;
    for (const job of this.jobs.values()) if (isLive(job)) return true;
    return false;
  }

  /** Something to do when a job ends (a measurement it started stops, or runs on for its next turn). */
  onJobEnd(fn: (job: AgentJob) => void): void {
    this.endings.push(fn);
  }

  private ended(job: AgentJob): void {
    // (its run saves no more: a studio back on it is at the song as it is, read as saved; an ended
    // job, kept a while, holds no songs)
    if (job.away) job.away.recent = [];
    for (const fn of this.endings) {
      try {
        fn(job);
      } catch {
        // (one listener's trouble isn't the job's)
      }
    }
  }

  get(id: string): AgentJob | null {
    return this.jobs.get(id) ?? null;
  }

  /** The song's job that's running (or about to), if one is. */
  running(project: string): AgentJob | null {
    for (const job of this.jobs.values()) if (job.view.project === project && isLive(job)) return job;
    return null;
  }

  // ---- harnesses ----

  /** Each harness as the runners report it (the best report of each). */
  harnesses(): HarnessInfo[] {
    const out: HarnessInfo[] = [];
    for (const id of HARNESSES) {
      let best: HarnessInfo | null = null;
      for (const runner of this.o.live.agentRunners()) {
        const h = this.reported.get(runner)?.find((x) => x.id === id);
        if (h && (!best || rank(h) > rank(best))) best = h;
      }
      if (best) out.push(best);
    }
    return out;
  }

  /** A runner that doesn't have the harness and can install it (it reported the installer it would run). */
  private installerFor(harness: HarnessId): LiveClient | null {
    for (const runner of this.o.live.agentRunners()) {
      const info = this.reported.get(runner)?.find((x) => x.id === harness);
      if (info && !info.found && info.installer) return runner;
    }
    return null;
  }

  /** The runner to hand a harness's job (or sign-in) to: one that has it, sealed, signed in if it can be. */
  private runnerFor(harness: HarnessId): { runner: LiveClient; info: HarnessInfo } | null {
    let found: { runner: LiveClient; info: HarnessInfo } | null = null;
    for (const runner of this.o.live.agentRunners()) {
      const info = this.reported.get(runner)?.find((x) => x.id === harness && x.found);
      if (info && (!found || rank(info) > rank(found.info))) found = { runner, info };
    }
    return found;
  }

  /** The harness a request runs with, its runner and what it reported; or why there's none. */
  private pick(wanted: HarnessId | null, own = false): { harness: HarnessId; runner: LiveClient; info: HarnessInfo } {
    if (!this.o.live.agentRunners().length) throw new Refusal(409, noRunnerText(this.o.live.runners()), 'no-runner');
    // none chosen: the first that can be sealed, else the first found (whose refusal then says why);
    // never one that runs only when it's chosen
    const any = HARNESSES.filter((id) => !CHOSEN_ONLY.has(id));
    const sealed = any.filter((id) => this.runnerFor(id)?.info.sealed);
    const ids = wanted ? [wanted] : sealed.length ? sealed : any.filter((id) => this.runnerFor(id));
    const harness = ids[0];
    const found = harness ? this.runnerFor(harness) : null;
    if (!harness || !found)
      throw new Refusal(
        409,
        wanted
          ? `${HARNESS_NAMES[wanted]} isn’t on this computer: pick another harness ${own ? OWN_CHOICE : 'in Settings › Agent'}`
          : [...CHOSEN_ONLY].some((id) => this.runnerFor(id))
            ? 'Choose a harness in Settings › Agent: Antigravity runs only once it’s chosen there'
            : 'No harness is on this computer: install Claude Code, Codex or Cursor',
        'no-harness',
      );
    // signed out, with its seal not yet checked (it asks for its sign-in first): the sign-in is what's missing
    if (!found.info.sealed && found.info.sealUnknown && found.info.signedIn === false)
      throw new Refusal(409, `${HARNESS_NAMES[harness]} is signed out: sign in in Settings › Agent`, 'signed-out');
    if (!found.info.sealed)
      throw new Refusal(
        409,
        `${HARNESS_NAMES[harness]} can’t be limited to HO[LO]’s tools${found.info.reason ? `: ${found.info.reason}` : ''}`,
        'not-sealed',
      );
    if (found.info.signedIn === false)
      throw new Refusal(409, `${HARNESS_NAMES[harness]} is signed out: sign in in Settings › Agent`, 'signed-out');
    return { harness, runner: found.runner, info: found.info };
  }

  /** A harness that lists no defaults runs only with a model and an effort chosen (409 `choose`). */
  private chosen(harness: HarnessId, info: HarnessInfo, runs: { model: string; effort: string }, own = false): void {
    const why = chooseText(HARNESS_NAMES[harness], info, runs.model, runs.effort, own);
    if (why) throw new Refusal(409, why, 'choose');
  }

  /**
   * What a song's requests run with: its conversation's own choice when it has one, else the host's
   * (Settings › Agent). `harness` null: whichever is available, as the host leaves it.
   */
  selection(project: string): { harness: HarnessId | null; model: string; effort: string; own: boolean } {
    const thread = this.o.threads.current(project);
    if (thread?.own_harness)
      return { harness: thread.own_harness, model: thread.own_model ?? '', effort: thread.own_effort ?? '', own: true };
    const { harness, model, effort } = this.o.agentStore.settings();
    return { harness, model, effort, own: false };
  }

  /**
   * The song's own choice of harness, model and effort for its conversation (null: Settings › Agent's
   * again). Not while a request works on the song; and only a choice a request could run with now: a
   * harness no runner has, one signed out or that can't be limited, a model or effort still to choose
   * are refused as a request with them would be, so a song is never left set to what can't run.
   */
  choose(project: string, choice: { harness: HarnessId; model: string; effort: string } | null): void {
    if (!this.o.store.get(project)) throw new Refusal(404, 'No such song');
    this.free(project);
    if (choice) {
      const { harness, info } = this.pick(choice.harness, true);
      this.chosen(harness, info, choice, true);
    }
    this.o.threads.choose(project, choice);
    this.toldThread(project);
  }

  /**
   * The studios with a song open hear that what its conversation runs with changed, or that it was
   * started over (its own choice gone with it): they read it again.
   */
  toldThread(project: string): void {
    this.o.live.toDevices({ type: 'agent-thread', project }, (c) => c.state?.project === project);
  }

  /**
   * Ask the runners to look for harnesses again, or a harness's runner to sign in, take a code, update,
   * or (a runner that doesn't have it) install it.
   */
  relay(action: 'refresh' | 'login' | 'login-code' | 'update' | 'install', harness?: HarnessId, code?: string): void {
    if (action === 'refresh') {
      const runners = this.o.live.agentRunners();
      if (!runners.length) throw new Refusal(409, noRunnerText(this.o.live.runners()), 'no-runner');
      for (const r of runners) {
        this.looked.set(r, Date.now());
        this.o.live.sendTo(r, { type: 'agent-refresh' });
      }
      return;
    }
    if (!harness) throw new Refusal(400, 'Which harness?');
    if (action === 'install') {
      if (!this.o.live.agentRunners().length) throw new Refusal(409, noRunnerText(this.o.live.runners()), 'no-runner');
      // only one that isn't there: HO[LO] never reinstalls over one (Update is for that)
      if (this.runnerFor(harness)) throw new Refusal(409, `${HARNESS_NAMES[harness]} is installed already`);
      if ([...this.jobs.values()].some((j) => j.harness === harness && isLive(j)))
        throw new Refusal(409, `${HARNESS_NAMES[harness]} is working on a request: try once it’s done`, 'busy');
      const runner = this.installerFor(harness);
      if (!runner) throw new Refusal(409, `HO[LO] can’t install ${HARNESS_NAMES[harness]} on this computer`);
      this.o.live.sendTo(runner, { type: 'agent-install', harness });
      return;
    }
    const found = this.runnerFor(harness);
    if (!found) throw new Refusal(409, `${HARNESS_NAMES[harness]} isn’t on this computer`, 'no-harness');
    if (action !== 'login-code' && [...this.jobs.values()].some((j) => j.harness === harness && isLive(j)))
      throw new Refusal(409, `${HARNESS_NAMES[harness]} is working on a request: try once it’s done`, 'busy');
    if (action === 'login') {
      // HO[LO] only signs in a harness that's signed out: it never signs out or switches accounts
      if (found.info.signedIn === true) throw new Refusal(409, `${HARNESS_NAMES[harness]} is signed in already`);
      this.o.live.sendTo(found.runner, { type: 'agent-login', harness });
    } else if (action === 'login-code') this.o.live.sendTo(found.runner, { type: 'agent-login-code', harness, code });
    else this.o.live.sendTo(found.runner, { type: 'agent-update', harness });
  }

  /**
   * Settings › Agent was opened: each runner that last looked at its harnesses an hour ago or more looks
   * again, quietly (`agent-refresh {light}`), so new versions' models and efforts show. At most once an
   * hour per runner; nothing is asked when nobody opens Settings. How many were asked.
   *
   * One that looked more recently is asked only what its harnesses' accounts have left
   * (`agent-limits`: a look reads that too), at most once a minute per runner: it's what changes between looks.
   */
  look(): number {
    const now = Date.now();
    let asked = 0;
    for (const runner of this.o.live.agentRunners()) {
      const last = this.looked.get(runner);
      // one that hasn't reported yet looks anyway once the agent is on (agent-on)
      if (last === undefined) continue;
      if (now - last >= LOOK_EVERY_MS) {
        this.looked.set(runner, now);
        this.limitsAsked.set(runner, now);
        this.o.live.sendTo(runner, { type: 'agent-refresh', light: true });
        asked++;
      } else if (now - Math.max(last, this.limitsAsked.get(runner) ?? 0) >= LIMITS_EVERY_MS) {
        this.limitsAsked.set(runner, now);
        this.o.live.sendTo(runner, { type: 'agent-limits' });
      }
    }
    return asked;
  }

  // ---- requests ----

  /** Start a request on the song a device's studio has open: the job's id. */
  async request(device: string, req: NewRequest): Promise<string> {
    const song = this.o.store.get(req.project);
    if (!song) throw new Refusal(404, 'No such song');
    if (!this.o.live.studioFor(device, req.project))
      throw new Refusal(409, 'Open the song in this studio first', 'not-open');
    this.free(req.project);
    if (req.preset) {
      const scan = this.o.scan(req.preset.scan);
      if (!scan || scan.project !== req.project) throw new Refusal(404, 'No such scan for this song');
    }
    if (req.context?.scan) {
      const scan = this.o.scan(req.context.scan);
      if (!scan || scan.project !== req.project) delete req.context.scan;
    }
    const attachments = this.attachments(device, req.project, req.attachments);
    const runs = this.selection(req.project);
    const { harness, runner, info } = this.pick(runs.harness, runs.own);
    this.chosen(harness, info, runs, runs.own);
    const thread = this.o.threads.forRequest(req.project, harness);
    const request = req.preset ? presetTitle(req.preset) : req.text;
    return this.begin(
      device,
      req.project,
      thread,
      runner,
      request,
      req.preset,
      req.attachments,
      async (now, history) =>
        buildPrompt({
          rules: readRules(this.o.repoDir),
          history,
          context: contextLines(req.context, now, this.about(req.project)),
          attachments,
          request: req.preset ? presetRequest(req.preset) : req.text,
        }),
      req.context ?? null,
    );
  }

  /** The attachments a request names: each the device's own, sent for that song (400 otherwise). */
  private attachments(device: string, project: string, ids: readonly string[]): AttachmentInfo[] {
    return ids.map((id) => {
      const a = this.o.attachment?.(id, project, device) ?? null;
      if (!a) throw new Refusal(400, `No such attachment: ${id}`);
      return a;
    });
  }

  /** There's no job running on a song (or being started), or a refusal. */
  private free(project: string): void {
    if (this.running(project) || this.starting.has(project))
      throw new Refusal(409, 'Still working on this song', 'busy');
  }

  /**
   * What the harness a thread runs with hears of the conversation before the request (prompt.ts,
   * `historySections`): since its last reply; or, when the conversation went on with another harness
   * meanwhile, what it missed; or, with no session of its own in it, the whole of it so far. `fresh`:
   * as for a harness with no session, whatever it has (what a conversation started over in the middle
   * of a turn is given instead). `thread` is as the request will run it (`Threads.forRequest`).
   */
  private soFar(thread: ThreadRow, now: Project, fresh = false): Section[] {
    const rows = this.o.agentStore.turns(thread.id);
    // a turn from before turns kept their harness was the conversation's only one's
    const own = (extra: TurnExtra) => !extra.harness || extra.harness === thread.harness;
    const turns = rows.map((row) => {
      const extra = parseExtra(row.extra);
      const attached = (extra.attachments ?? []).map((id) => {
        const a = row.device ? this.o.attachment?.(id, thread.project, row.device) : null;
        return a
          ? `${a.id} ${JSON.stringify(a.name)} (${a.type}, ${sizeText(a.size)}), readable with attachment_get`
          : 'a file no longer kept';
      });
      const turn: RecordedTurn = {
        request: row.request,
        reply: row.reply,
        state: row.state,
        ...(extra.harness ? { by: HARNESS_NAMES[extra.harness] } : {}),
        ...(extra.continues || extra.allowed ? { again: true } : {}),
        ...(extra.allowed ? { allowed: extra.allowed } : {}),
        ...(extra.error ? { error: extra.error } : {}),
        ...(extra.changes?.length ? { changes: extra.changes } : {}),
        ...(extra.heard?.length ? { heard: extra.heard } : {}),
        ...(extra.permission ? { asked: permissionWords(extra.permission) } : {}),
        ...(attached.length ? { attached } : {}),
      };
      return { turn, own: own(extra) };
    });
    // What was asked of another harness since this one's session last knew the conversation: after
    // the last turn that reached it (a go that never started told it nothing), or, where that isn't
    // known (a leg from before it was kept, a turn no longer kept), after its last turn.
    const told = this.o.threads.legOf(thread.id, thread.harness)?.told ?? null;
    const reached = told ? rows.findIndex((r) => r.job === told) : -1;
    const from = reached >= 0 ? reached : turns.findLastIndex((t) => t.own);
    return historySections({
      session: !fresh && !!thread.session,
      turns: turns.map((t) => t.turn),
      missed: turns
        .slice(from + 1)
        .filter((t) => !t.own)
        .map((t) => t.turn),
      // (a conversation every turn of which was this harness's own is one it starts over, not one it takes over)
      others: turns.some((t) => !t.own),
      // (a conversation with no turn yet, made when the song was given its own choice: nothing was
      // replied, so nothing happened "since")
      events: rows.length ? this.o.threads.events(thread) : [],
      seen: fresh ? null : this.o.threads.seenSong(thread),
      now,
      middleC: this.middleC(),
    });
  }

  private middleC(): MiddleC {
    return this.o.store.setting('middleC') === 'C4' ? 'C4' : 'C3';
  }

  /**
   * The start of a job: the studio saves, a restore point is taken, the prompt is made from the song
   * as it is now, and the runner is handed the job with its token.
   */
  private async begin(
    device: string,
    project: string,
    thread: ThreadRow,
    runner: LiveClient,
    request: string,
    preset: ScanPreset | null,
    attachments: readonly string[],
    prompt: (now: Project, history: Section[]) => Promise<string>,
    context: RequestContext | null = null,
    carry: {
      continues?: string;
      before?: number | null;
      previous?: number | null;
      allowed?: string;
      /** The model and effort to run with, when not the song's selection (a follow-up runs as what asked did). */
      runs?: { model: string; effort: string };
    } | null = null,
  ): Promise<string> {
    this.starting.add(project);
    const ceiling = preset ? this.limits.scanClockMs : this.limits.clockMs;
    let job: AgentJob;
    try {
      await this.flush(device, project);
      const now = this.o.store.get(project);
      if (!now) throw new Refusal(404, 'No such song');
      // a restore point, whatever the agent does (and the reply's "before"); the previous request's is "previous"
      // (a go that carries an earlier one on keeps that one's: its "before" is the song before the request)
      const carried = carry?.continues ? carry : null;
      const before = carried?.before ?? this.o.store.snapshotNow(project, 'Agent');
      const earlier = this.o.agentStore.turns(thread.id).at(-1);
      const previous = carried ? (carried.previous ?? null) : ((earlier && parseExtra(earlier.extra).before) ?? null);
      const text = await prompt(now, this.soFar(thread, now));
      // the same, as a conversation started over is told it: should the harness no longer have its
      // session (or its service refuse the conversation before it has done anything), the runner starts
      // one in the middle of the turn, and it's given this instead
      const fresh = thread.session ? await prompt(now, this.soFar(thread, now, true)) : null;
      const settings = carry?.runs ?? this.selection(project);
      const token = newToken();
      job = {
        view: {
          id: `agj_${randomBytes(6).toString('hex')}`,
          project,
          device,
          state: 'waiting',
          request,
          started: Date.now(),
          title: now.title,
          harness: thread.harness,
          ...(settings.model ? { model: settings.model } : {}),
          ...(settings.effort ? { effort: settings.effort } : {}),
          ...(carried?.continues ? { continues: carried.continues } : {}),
        },
        thread: thread.id,
        harness: thread.harness,
        model: settings.model,
        effort: settings.effort,
        tokenHash: hashToken(token),
        preset,
        asked: null,
        batches: new Map(),
        away: null,
        clock: null,
        dropped: null,
        quiet: null,
        calls: 0,
        queued: false,
        ceiling,
        ending: false,
        attachments: [...attachments],
        listen: null,
        listenOn: false,
        hearing: null,
        listenOff: null,
        doneListening: false,
        before,
        versions: new Map(),
        previous,
        changed: false,
        context,
        // (what the prompt just told of: the thread's events, cleared below; in words anyone reading
        // the conversation's record later can be told them in)
        heard: (this.o.agentStore.turns(thread.id).length
          ? this.o.threads.events(this.o.threads.get(thread.id) ?? thread)
          : []
        ).map((e) => eventLine(e, false)),
        changes: [],
        stop: null,
        continues: carried?.continues ?? null,
        allowed: carry?.allowed ?? null,
      };
      // the runner may have gone while the studio saved
      if (!this.o.live.agentRunners().includes(runner))
        throw new Refusal(409, 'The runner disconnected: start it again with pnpm runner', 'no-runner');
      this.jobs.set(job.view.id, job);
      this.assigned.set(job, runner);
      // nothing refuses the request from here on: the thread is its harness's now (when another ran last)
      const current = this.o.threads.use(thread);
      // the folder this harness works in, in this conversation: the runner knows a job's conversation
      // by it (and runs one job at a time in each)
      const workspace = this.o.threads.leg(current).workspace;
      this.o.live.sendTo(runner, {
        type: 'agent-run',
        job: job.view.id,
        thread: workspace,
        harness: thread.harness,
        model: settings.model,
        effort: settings.effort,
        // how the studio names notes: the tools read and write them the same way
        middleC: this.middleC(),
        prompt: text,
        ...(fresh && fresh !== text ? { freshPrompt: fresh } : {}),
        token,
        ...(current.session ? { session: current.session } : {}),
        workspace,
        base: this.o.base(),
        // its ceiling: the runner's own limit is set a little past it, so this one comes first
        limitMs: ceiling,
      });
    } finally {
      this.starting.delete(project);
    }
    // what the user did is told now: it starts again from none
    this.o.threads.clearEvents(thread.id);
    this.o.agentStore.addTurn({
      thread: thread.id,
      job: job.view.id,
      request,
      reply: null,
      label: null,
      state: job.view.state,
      at: job.view.started,
      extra: turnExtra(job),
      device,
    });
    // it runs while it's heard from, up to its ceiling
    this.startClock(job);
    this.heard(job);
    // a permission still waiting on this song is passed over by the new request
    for (const other of this.jobs.values()) {
      if (other !== job && other.view.project === project && other.view.state === 'awaiting') {
        other.view.state = 'done';
        this.saveTurn(other);
        this.tell(other);
      }
    }
    this.prune();
    this.tell(job);
    return job.view.id;
  }

  /** The studio saves now (it answers once it has, or in at most 10 s). */
  private async flush(device: string, project: string): Promise<void> {
    const studio = this.studioOf(device, project);
    if (!studio) return;
    const hidden = isHidden(studio);
    const answer = await this.o.live.request(
      studio,
      { type: 'agent-flush', project },
      hidden ? Math.min(this.limits.flushMs, this.limits.hiddenMs) : this.limits.flushMs,
    );
    if (hidden && answer.error === NO_ANSWER) this.unanswered(studio);
  }

  /** A device's studio with a song open, unless its browser froze it (`frozen`). */
  private studioOf(device: string, project: string): LiveClient | null {
    const studio = this.o.live.studioFor(device, project);
    return studio && !this.frozen.has(studio) ? studio : null;
  }

  /**
   * A studio asked while its page was hidden didn't answer: its browser froze it, and it's away, unless
   * it has said since that it's in view again (it may answer late, as it wakes).
   */
  private unanswered(studio: LiveClient): void {
    if (isHidden(studio)) this.frozen.add(studio);
  }

  // ---- the user's answers ----

  /** Stop a job (any allowed device may), or dismiss one waiting for a permission. */
  cancel(id: string): void {
    const job = this.jobs.get(id);
    if (!job) throw new Refusal(404, 'No such job');
    if (job.view.state === 'awaiting') {
      job.view.state = 'cancelled';
      this.saveTurn(job);
      this.tell(job);
      return;
    }
    if (!isLive(job)) throw new Refusal(409, 'That job has ended');
    this.end(job, 'cancelled', 'Stopped', true);
  }

  /**
   * Try again: a request whose last go failed is carried on, in the same conversation, as a new job
   * that continues it. It's the same request (its words, its preset, what the studio showed, its
   * attachments still kept), told that its last go didn't finish and to read the song first. Only for
   * the device that asked, and only for the conversation's last turn: a later request has moved on.
   */
  async carryOn(
    device: string,
    id: string,
    choice?: { harness: HarnessId; model: string; effort: string } | null,
  ): Promise<string> {
    const row = this.o.agentStore.turn(id);
    const thread = row ? this.o.threads.get(row.thread) : null;
    if (!row || !thread) throw new Refusal(404, 'No such request');
    if (row.device !== device) throw new Refusal(403, 'Only the device that asked can carry it on');
    if (this.o.threads.current(thread.project)?.id !== thread.id)
      throw new Refusal(409, 'That conversation was started over');
    if (this.o.agentStore.turns(thread.id).at(-1)?.job !== row.job)
      throw new Refusal(409, 'A later request has been made on this song since');
    if (row.state !== 'failed') throw new Refusal(409, 'That request didn’t fail');
    const project = thread.project;
    if (!this.o.store.get(project)) throw new Refusal(404, 'No such song');
    if (!this.o.live.studioFor(device, project))
      throw new Refusal(409, 'Open the song in this studio first', 'not-open');
    this.free(project);
    const extra = parseExtra(row.extra);
    const preset = extra.preset ?? null;
    // with the harness chosen now, as a request is (signed out or gone, the refusal says so): when
    // that's another than the one that failed, it takes the conversation over, the go that failed its last turn
    // (picked for this song as it's carried on, "Continue with…": a harness with its model and effort,
    // or null for Settings › Agent's again; not given, as the song's requests run now)
    const host = this.o.agentStore.settings();
    const runs =
      choice === undefined
        ? this.selection(project)
        : choice
          ? { ...choice, own: true }
          : { harness: host.harness, model: host.model, effort: host.effort, own: false };
    const { harness, runner, info } = this.pick(runs.harness, runs.own);
    this.chosen(harness, info, runs, runs.own);
    const going = this.o.threads.forRequest(project, harness);
    const same = (extra.harness ?? thread.harness) === harness;
    // what it was sent that's still kept (a week): the rest it was told of the first time
    const kept = (extra.attachments ?? []).filter((a) => this.o.attachment?.(a, project, device));
    const attachments = this.attachments(device, project, kept);
    const context = extra.context ?? null;
    const job = await this.begin(
      device,
      project,
      going,
      runner,
      row.request,
      preset,
      kept,
      async (now, history) =>
        buildPrompt({
          rules: readRules(this.o.repoDir),
          history,
          context: contextLines(context ?? undefined, now, this.about(project)),
          attachments,
          request: carryOnRequest(preset ? presetRequest(preset) : row.request, same),
        }),
      context,
      // (the go it continues may itself have carried one on: the request's first is what its step is under)
      {
        continues: extra.continues ?? row.job,
        before: extra.before ?? null,
        previous: extra.previous ?? null,
        runs: { model: runs.model, effort: runs.effort },
      },
    );
    // what was picked is the song's own only now that the request has gone ahead with it: a refusal
    // on the way (the studio's save, the runner gone) leaves the song as it was
    if (choice !== undefined) {
      this.o.threads.choose(project, choice);
      this.toldThread(project);
    }
    return job;
  }

  /**
   * The user's answer to what the job asked: allowed, the follow-up starts on the same thread (the
   * same harness session) with what happened; not, it ends with "Not now".
   */
  async permit(
    device: string,
    id: string,
    grant: boolean,
    result: string,
    attachmentIds: readonly string[] = [],
  ): Promise<string | null> {
    const job = this.jobs.get(id);
    if (!job) throw new Refusal(404, 'No such job');
    if (job.view.device !== device) throw new Refusal(403, 'Only the device that asked can answer');
    const permission = job.view.permission;
    if (job.view.state !== 'awaiting' || !permission) throw new Refusal(409, 'That job isn’t waiting for an answer');
    if (!grant) {
      job.view.state = 'done';
      job.view.reply = NOT_NOW;
      this.o.threads.addEventTo(job.thread, { action: 'denied', label: permission.detail, at: Date.now() });
      this.saveTurn(job);
      this.tell(job);
      return null;
    }
    // what the click brought (a screenshot, a photo, a recording) goes to the follow-up
    const attachments = this.attachments(device, job.view.project, attachmentIds);
    // "Start over" since it asked: the old conversation isn't carried on
    const thread = this.o.threads.get(job.thread);
    if (!thread || this.o.threads.current(job.view.project)?.id !== thread.id)
      throw new Refusal(409, 'That conversation was started over');
    if (!this.o.live.studioFor(device, job.view.project))
      throw new Refusal(409, 'Open the song in this studio first', 'not-open');
    this.free(job.view.project);
    const found = this.runnerFor(thread.harness);
    if (!found) throw new Refusal(409, `${HARNESS_NAMES[thread.harness]} isn’t available now`, 'no-harness');
    // (with the model and effort its turn had: the song's choice may have moved to another harness since)
    const asked = { model: job.model, effort: job.effort };
    this.chosen(thread.harness, found.info, asked);
    const next = await this.begin(
      device,
      job.view.project,
      thread,
      found.runner,
      job.view.request,
      job.preset,
      attachmentIds,
      async (_now, history) =>
        buildPrompt({
          rules: readRules(this.o.repoDir),
          history,
          context: [],
          attachments,
          request: permissionFollowUp(permission, result, job.view.request),
        }),
      null,
      { allowed: `${permissionWords(permission)}. Reported: ${oneLine(result, 300) || 'nothing'}`, runs: asked },
    );
    if (job.view.state === 'awaiting') {
      job.view.state = 'done';
      this.saveTurn(job);
      this.tell(job);
    }
    return next;
  }

  /** A device was removed: its jobs stop at once. */
  deviceRemoved(device: string): void {
    for (const job of this.jobs.values()) {
      if (job.view.device !== device) continue;
      if (isLive(job)) this.end(job, 'cancelled', 'This device was removed', true);
      else if (job.view.state === 'awaiting') {
        job.view.state = 'cancelled';
        this.saveTurn(job);
        this.tell(job);
      }
    }
  }

  /** The agent was turned off: every job stops. */
  stopAll(why: string): void {
    for (const job of this.jobs.values()) {
      if (isLive(job)) this.end(job, 'cancelled', why, true);
      else if (job.view.state === 'awaiting') {
        job.view.state = 'cancelled';
        this.saveTurn(job);
        this.tell(job);
      }
    }
  }

  /** The server is closing: no clock keeps it up. */
  close(): void {
    for (const job of this.jobs.values()) {
      this.clearTimers(job);
      this.stopListening(job);
    }
  }

  // ---- the end of a job ----

  /**
   * A job ends early: its runner is told to stop (when `cancel`), its token stops working, and the
   * agent hears next time that its turn didn't finish (`fresh`: in a new conversation, as this one
   * can't go on).
   */
  private end(job: AgentJob, state: 'cancelled' | 'failed', why: string, cancel: boolean, fresh = false): void {
    if (!isLive(job)) return;
    const runner = this.assigned.get(job);
    if (cancel && runner) this.o.live.sendTo(runner, { type: 'agent-cancel', job: job.view.id });
    job.tokenHash = null;
    this.clearTimers(job);
    job.view.state = state;
    job.view.error = oneLine(why, 500);
    job.view.finished = Date.now();
    if (job.stop && state === 'failed') job.view.stop = job.stop;
    this.stopListening(job);
    this.o.threads.addEventTo(job.thread, {
      action: state === 'failed' ? 'failed' : 'stopped',
      label: job.view.error,
      ...(fresh ? { fresh: true } : {}),
      at: Date.now(),
    });
    this.saveTurn(job);
    this.tell(job);
    this.ended(job);
  }

  /** The harness finished its turn: the studio saves, and the song as saved is what the agent saw. */
  private async turnDone(job: AgentJob): Promise<void> {
    if (!isLive(job) || job.ending) return;
    job.ending = true;
    // the harness has exited: its tools are done
    job.tokenHash = null;
    this.clearTimers(job);
    this.stopListening(job);
    await this.flush(job.view.device, job.view.project);
    // (stopped while the studio saved)
    if (!isLive(job)) return;
    const song = this.o.store.get(job.view.project);
    this.reachedSession(job);
    if (song) this.o.threads.seen(job.thread, job.harness, song);
    // the song as the turn left it, when the reply's view (or its dock) plays or keeps it
    const view = job.view.view;
    if (view && viewVersions([...view.blocks, ...(view.dock ?? [])]).includes(AFTER)) {
      const after = this.o.store.snapshotNow(job.view.project, 'Agent');
      if (after !== null) view.versions[AFTER] = after;
    }
    job.view.state = job.asked ? 'awaiting' : 'done';
    if (job.asked) job.view.permission = job.asked;
    job.view.finished = Date.now();
    this.saveTurn(job);
    this.tell(job);
    this.ended(job);
  }

  /** The turn's row as the job now stands: its state, reply and label, and what it asked, wrote and attached. */
  private saveTurn(job: AgentJob): void {
    this.o.agentStore.updateTurn(job.view.id, {
      state: job.view.state,
      reply: job.view.reply ?? null,
      label: job.view.label ?? null,
      extra: turnExtra(job),
    });
  }

  /** The job's ceiling counts from now: as it's handed to its runner, and again as a held one starts. */
  private startClock(job: AgentJob): void {
    if (job.clock) clearTimeout(job.clock);
    const ceiling = job.ceiling;
    job.clock = setTimeout(() => this.end(job, 'failed', `It took longer than ${inWords(ceiling)}`, true), ceiling);
    job.clock.unref?.();
  }

  private clearTimers(job: AgentJob): void {
    if (job.clock) clearTimeout(job.clock);
    if (job.dropped) clearTimeout(job.dropped);
    if (job.quiet) clearTimeout(job.quiet);
    job.clock = null;
    job.dropped = null;
    job.quiet = null;
  }

  /**
   * The job was heard from (a tool call, a line under the bar, a message from its runner): its quiet
   * starts again, unless a tool call is under way, which keeps it from being quiet until it answers.
   * One its runner holds isn't quiet either: it hasn't started.
   */
  private heard(job: AgentJob): void {
    if (job.quiet) clearTimeout(job.quiet);
    job.quiet = null;
    if (!isLive(job) || job.ending || job.calls > 0 || job.queued) return;
    const idle = inWords(this.limits.idleMs);
    job.quiet = setTimeout(() => {
      // (one never heard from at all hasn't started: a runner that doesn't say it holds a job, busy
      // with other songs' jobs)
      const started = job.view.state !== 'waiting';
      this.end(job, 'failed', started ? `It went quiet for ${idle}` : `It didn’t start in ${idle}`, true);
    }, this.limits.idleMs);
    job.quiet.unref?.();
  }

  /**
   * The studios that hear how a job goes: the requester's, and allowed devices with its song open. It
   * says the host's time too, so a studio counts how long a job has worked on the host's clock.
   */
  private tell(job: AgentJob): void {
    this.o.live.toDevices(
      { type: 'agent-status', job: job.view, now: Date.now() },
      (c) => c.device === job.view.device || c.state?.project === job.view.project,
    );
  }

  /** Jobs that ended are kept a while (the last 50), the others always. */
  private prune(): void {
    const ended = [...this.jobs.values()].filter((j) => !isLive(j) && j.view.state !== 'awaiting');
    for (const job of ended.slice(0, -50)) this.jobs.delete(job.view.id);
  }

  // ---- the live channel (AgentHooks) ----

  device(token: string): string | null {
    return this.o.deviceFor(token);
  }

  message(client: LiveClient, msg: Record<string, unknown>): void {
    if (msg.type === 'history') {
      this.history(client, msg);
      return;
    }
    // everything else comes from a runner with the key
    if (client.role !== 'runner' || !client.keyed) return;
    if (msg.type === 'harnesses') {
      this.reported.set(client, parseHarnesses(msg.list));
      // the list said again after a run learned a harness's defaults: no look was made
      if (msg.from !== 'run') this.looked.set(client, Date.now());
      // Settings › Agent shows them as they are now
      if (client.caps?.agent) this.announce(false);
      // (back after a restart of HO[LO]: what it may still run of before stops)
      if (client.caps?.agent && this.orphans.size && !this.toldOrphans.has(client)) {
        this.toldOrphans.add(client);
        for (const job of this.orphans) this.o.live.sendTo(client, { type: 'agent-cancel', job });
      }
      return;
    }
    if (msg.type === 'agent-harness') {
      const relay = parseHarnessEvent(msg);
      if (relay) {
        this.keepRelay(client, relay);
        this.o.live.toDevices({ type: 'agent-harness', ...relay });
      }
      return;
    }
    const job = typeof msg.job === 'string' ? this.jobs.get(msg.job) : undefined;
    // a runner still at work on a job that's over here (it came back after its connection dropped, or
    // HO[LO] restarted under it): it's told to stop, so the conversation's next request isn't kept waiting
    if (
      (!job || !isLive(job)) &&
      typeof msg.job === 'string' &&
      JOB_ID.test(msg.job) &&
      client.caps?.agent &&
      STILL_AT_IT.has(String(msg.type))
    )
      this.o.live.sendTo(client, { type: 'agent-cancel', job: msg.job });
    // only from the runner it was handed to, and only while it runs
    if (!job || this.assigned.get(job) !== client || !isLive(job) || job.ending) return;
    if (msg.type === 'agent-queued') {
      this.held(job, msg.why === 'harness' ? queuedFor(HARNESS_NAMES[job.harness]) : QUEUED);
      return;
    }
    // (anything else from its runner about it: it has started)
    if (job.queued) this.started(job);
    this.heard(job);
    switch (msg.type) {
      case 'agent-progress':
        job.view.state = 'running';
        job.view.line = oneLine(String(msg.line ?? ''), 200);
        this.reachedSession(job);
        this.tell(job);
        break;
      case 'agent-session':
        if (typeof msg.session === 'string' && /^[A-Za-z0-9][\w.:-]{0,199}$/.test(msg.session)) {
          this.o.threads.setSession(job.thread, job.harness, msg.session);
          if (job.view.state === 'waiting') {
            job.view.state = 'running';
            this.tell(job);
          }
        }
        break;
      case 'agent-done':
        this.used(job, msg.usage);
        // the harness's last words stand as the reply when the agent never called finish: what it
        // said in its own chat, often markdown, made plain for the bar
        if (job.view.reply === undefined && typeof msg.reply === 'string') {
          const said = plainReply(msg.reply, 600);
          if (said) job.view.reply = said;
        }
        void this.turnDone(job);
        break;
      case 'agent-failed': {
        this.used(job, msg.usage);
        // its model service refused the conversation itself: carried on, it would be refused again
        const fresh = msg.fresh === true;
        if (fresh) this.o.threads.forgetSession(job.thread, job.harness);
        const why = typeof msg.error === 'string' && msg.error ? msg.error : 'The agent stopped';
        // why, when its harness made it plain: out of usage (till when), signed out, not installed
        job.stop = checkFailureKind(msg.why, msg.resets, Date.now()) ?? job.stop;
        this.end(job, 'failed', why, false, fresh);
        break;
      }
    }
  }

  /**
   * What a turn used, as its harness counted it (the runner says with the turn's end): kept by the
   * model it ran with, the harness's default by name when none was chosen and it lists one. A turn
   * stopped from here says nothing, and isn't counted.
   */
  private used(job: AgentJob, raw: unknown): void {
    const usage = checkUsage(raw);
    if (!usage) return;
    const model = job.model || (this.harnesses().find((h) => h.id === job.harness)?.defaultModel ?? '');
    this.o.agentStore.addUsage({
      job: job.view.id,
      harness: job.harness,
      model,
      effort: job.effort,
      ...usage,
      at: Date.now(),
    });
  }

  /**
   * Its runner holds the job until another has finished (it runs two at once, and one per
   * conversation): it waits as long as that takes, with no quiet and no ceiling of its own (those
   * ahead of it have theirs), and the line under the bar says so. Stop still stops it.
   */
  private held(job: AgentJob, line: string): void {
    if (job.queued || job.view.state !== 'waiting') return;
    job.queued = true;
    job.queuedLine = line;
    if (job.clock) clearTimeout(job.clock);
    job.clock = null;
    this.heard(job);
    job.view.line = line;
    this.tell(job);
  }

  /** A job its runner held starts: its ceiling and its quiet count from now. */
  private started(job: AgentJob): void {
    job.queued = false;
    this.startClock(job);
    if (job.view.line === job.queuedLine) {
      delete job.view.line;
      this.tell(job);
    }
  }

  /**
   * A studio undid, redid or made a step: the agent hears of it before its next reply. Undoing a step
   * of the device's own running job stops that job.
   */
  private history(client: LiveClient, msg: Record<string, unknown>): void {
    if (client.role !== 'editor' || !client.device) return;
    if (!this.o.allowed(client.device)) {
      this.o.live.downgrade(client.device);
      return;
    }
    const action = msg.action;
    if (action !== 'undo' && action !== 'redo' && action !== 'step') return;
    const project = client.state?.project;
    if (!project || typeof msg.label !== 'string') return;
    const job = typeof msg.job === 'string' && JOB_ID.test(msg.job) ? this.jobs.get(msg.job) : undefined;
    const ours = job?.view.project === project ? job : undefined;
    this.o.threads.addEvent(project, {
      action,
      label: oneLine(msg.label, 120),
      ...(ours ? { agent: true } : {}),
      at: Date.now(),
    });
    if (action === 'undo' && ours && isLive(ours) && ours.view.device === client.device)
      this.end(ours, 'cancelled', 'You undid its change', true);
  }

  state(client: LiveClient, before: EditorState | null): void {
    const device = client.device;
    const was = before?.project ?? null;
    const now = client.state?.project ?? null;
    if (device && now) {
      const key = backKey(device, now);
      // the device has the song open again; a page in view again isn't frozen
      this.left.delete(key);
      if (!isHidden(client)) this.frozen.delete(client);
      // a studio back with the song open (after a reload, its network back), or saying where it's got
      // to: the tools waiting for it look again
      for (const back of [...(this.comingBack.get(key) ?? [])]) back();
      this.keepPickedUp(device, now, client.state?.revision);
    }
    if (!device || !before || !was || was === now) return;
    // the studio opened another song: a job of its on the one it left carries on, its changes saved
    // here from now on (as when its page goes), for it to pick up when it has that song open again.
    // What it showed there is kept for the agent to read; it isn't waited for, as a reload is
    if (!this.o.live.studioFor(device, was)) this.leave(device, { ...before, project: was }, true, true);
  }

  /** A device's studio left a song: remembered for a day (what it showed, whether it's waited for). */
  private leave(device: string, shown: EditorState, hidden: boolean, elsewhere: boolean): void {
    const now = Date.now();
    for (const [key, l] of this.left) if (now - l.at > LEFT_LIFE) this.left.delete(key);
    this.left.set(backKey(device, shown.project as string), {
      at: now,
      hidden,
      state: shown,
      ...(elsewhere ? { elsewhere } : {}),
    });
  }

  /**
   * The requester's studio says it's at a revision of its job's run (it picked the run up, maybe as
   * the agent saved again): that revision is kept in the song's history, once, as the song its own
   * changes from now on are made on, which a reload of it may read (actions.ts, picking up).
   */
  private keepPickedUp(device: string, project: string, revision: number | undefined): void {
    for (const job of this.jobs.values()) {
      const run = job.away;
      if (!run || job.view.device !== device || job.view.project !== project) continue;
      if (revision === undefined || revision === run.kept || revision <= run.base || revision > run.head) continue;
      const song = run.recent.find((r) => r.revision === revision);
      if (song) this.o.store.keepRevision(project, revision, song.doc, 'Agent');
      // (the song as it is, read as saved: not parsed)
      else if (this.o.store.row(project)?.revision === revision) this.o.store.snapshotNow(project, 'Agent');
      run.kept = revision;
      // it's at that one now, not before it: only those after it may still be said
      run.recent = run.recent.filter((r) => r.revision > revision);
    }
  }

  gone(client: LiveClient): void {
    // a studio leaving a song: whether its page was hidden (in the background, closed) or in view (a
    // reload, its network), and what it last showed
    const shown = client.state;
    if (client.role === 'editor' && client.device && shown?.project)
      this.leave(client.device, shown, isHidden(client), false);
    if (client.role !== 'runner') return;
    // its sign-ins and updates under way, and its harnesses, went with it
    for (const [harness, r] of this.relays) if (r.runner === client) this.relays.delete(harness);
    if (client.keyed && client.caps?.agent && this.reported.has(client)) {
      this.reported.delete(client);
      this.announce(false);
    }
    for (const job of this.jobs.values()) {
      if (this.assigned.get(job) !== client || !isLive(job) || job.dropped) continue;
      job.dropped = setTimeout(() => {
        job.stop = { why: 'interrupted' };
        this.end(job, 'failed', 'The runner disconnected', false);
      }, this.limits.droppedMs);
      job.dropped.unref?.();
    }
  }

  // ---- settings, and the song's conversation ----

  /**
   * Keep a sign-in, an update or an install under way (what it said so far: its link and code stay as
   * later lines come); one that's over is let go.
   */
  private keepRelay(runner: LiveClient, relay: Record<string, unknown>): void {
    const harness = relay.harness as HarnessId;
    if (relay.kind === 'refresh') return;
    if (relay.state !== 'running') {
      this.relays.delete(harness);
      return;
    }
    const before = this.relays.get(harness);
    const event = before && before.event.kind === relay.kind ? { ...before.event, ...relay } : relay;
    this.relays.set(harness, { event, runner, at: Date.now() });
  }

  /** The settings, as GET /api/agent/settings answers: with any sign-in, update or install under way. */
  settingsView(): {
    enabled: boolean;
    harness: HarnessId | null;
    model: string;
    effort: string;
    harnesses: HarnessInfo[];
    relays: Record<string, unknown>[];
    usage: { days: number; rows: UsageSum[] };
  } {
    const now = Date.now();
    const relays: Record<string, unknown>[] = [];
    for (const [harness, r] of this.relays) {
      if (now - r.at > RELAY_LIFE || !this.o.live.agentRunners().includes(r.runner)) this.relays.delete(harness);
      else relays.push(r.event);
    }
    return {
      ...this.o.agentStore.settings(),
      harnesses: this.harnesses(),
      relays,
      // what the requests used, added up by harness and model
      usage: { days: USAGE_DAYS, rows: this.o.agentStore.usage(now - USAGE_DAYS * 86_400_000) },
    };
  }

  /**
   * A runner with the key joined: if the agent is on, it looks for the harnesses. With the agent off,
   * a runner runs no harness and fetches nothing.
   */
  runner(client: LiveClient): void {
    if (this.o.agentStore.settings().enabled) this.o.live.sendTo(client, { type: 'agent-on' });
  }

  /** The agent was turned on: the runners look for the harnesses. */
  turnedOn(): void {
    for (const runner of this.o.live.agentRunners()) this.o.live.sendTo(runner, { type: 'agent-on' });
  }

  /**
   * Tell the studios the settings changed: allowed devices hear all of them (as GET /settings
   * answers); the others only whether the agent is on, and only when that changed.
   */
  announce(enabledChanged: boolean): void {
    const view = this.settingsView();
    for (const c of this.o.live.studios()) {
      if (c.device) this.o.live.sendTo(c, { type: 'agent-settings', ...view });
      else if (enabledChanged) this.o.live.sendTo(c, { type: 'agent-settings', enabled: view.enabled });
    }
  }

  /**
   * A song's conversation, as the bar shows it after a reload: each turn with what it asked, its brief
   * and why it stopped, and the song's job that's running or waiting for a click, if there is one.
   */
  threadView(project: string): {
    thread: ReturnType<Threads['view']>;
    job: JobView | null;
    /** The song's own choice (null: it follows Settings › Agent), and what its next request runs with. */
    choice: { harness: HarnessId; model: string; effort: string } | null;
    runsWith: { harness: HarnessId | null; model: string; effort: string };
  } {
    let job: AgentJob | null = this.running(project);
    if (!job)
      for (const j of this.jobs.values())
        if (j.view.project === project && j.view.state === 'awaiting' && (!job || j.view.started > job.view.started))
          job = j;
    const runs = this.selection(project);
    // (the harness a request would get now: the one chosen, or the one the host would pick; none, null)
    let harness = runs.harness;
    try {
      harness = this.pick(runs.harness).harness;
    } catch {
      // (not available now: a request says why)
    }
    return {
      thread: this.o.threads.view(project),
      job: job?.view ?? null,
      choice: runs.own && runs.harness ? { harness: runs.harness, model: runs.model, effort: runs.effort } : null,
      runsWith: { harness, model: runs.model, effort: runs.effort },
    };
  }

  // ---- the job's tools (/api/agent/jobs/:job/*) ----

  /** The job a tool's token is for, while it runs; null otherwise (the same either way it fails). */
  forTool(id: string, token: string): AgentJob | null {
    const job = this.jobs.get(id);
    if (!job || !isLive(job) || job.ending) return null;
    const hash = hashToken(token);
    if (!job.tokenHash || !sameHash(hash, job.tokenHash)) return null;
    if (job.view.state === 'waiting') {
      job.view.state = 'running';
      this.tell(job);
    }
    this.reachedSession(job);
    return job;
  }

  /**
   * A tool call began: the job isn't quiet until it answers (a render or a measurement may take a
   * while), and its quiet starts again then. What it gives back is called once the call has answered.
   */
  toolCall(job: AgentJob): () => void {
    job.calls++;
    this.heard(job);
    let open = true;
    return () => {
      if (!open) return;
      open = false;
      job.calls--;
      this.heard(job);
    };
  }

  /** The requester's studio, while it has the job's song open (and its browser hasn't frozen it). */
  studio(job: AgentJob): LiveClient | null {
    return this.studioOf(job.view.device, job.view.project);
  }

  /**
   * The requester's studio with the job's song open: at once, or once it's back within `awayMs` of
   * leaving (and `budgetMs`): a reload, or its network back after dropping. Meanwhile the line under
   * the bar says so, for the other devices that have the song open. A studio whose page was hidden as
   * it went (in the background, closed), that opened another song, or that's been gone longer, isn't
   * waited for. Refused 409
   * `away` (`BACKGROUND`) when it isn't there. A scan preset carries on without its studio, so it isn't
   * waited for: 403 at once, as ever.
   */
  async studioBack(job: AgentJob, budgetMs = this.limits.awayMs): Promise<LiveClient> {
    const here = this.studio(job);
    if (here) return here;
    if (job.preset) throw new Refusal(403, 'The song isn’t open in the studio that asked');
    const key = backKey(job.view.device, job.view.project);
    const left = this.left.get(key);
    // (gone with its page in view: a reload, or its network, may bring it back in a moment)
    const wait =
      left && !left.hidden && !left.elsewhere ? Math.min(left.at + this.limits.awayMs - Date.now(), budgetMs) : 0;
    if (wait > 0 && isLive(job) && !job.ending) {
      const before = job.view.line;
      const waiting = 'Waiting for the studio that asked to come back';
      this.progress(job, waiting);
      await this.until(key, () => this.studio(job) !== null, wait);
      // (the line it had comes back, unless the agent said another meanwhile)
      if (job.view.line === waiting && isLive(job) && !job.ending) {
        if (before === undefined) delete job.view.line;
        else job.view.line = before;
        this.tell(job);
      }
    }
    const back = this.studio(job);
    if (back) return back;
    throw new Refusal(409, BACKGROUND, 'away');
  }

  /** Wait until a device's studio with a song says something that makes `ready` true, or `ms` pass. */
  private async until(key: string, ready: () => boolean, ms: number): Promise<void> {
    const end = Date.now() + ms;
    while (!ready() && Date.now() < end) {
      await new Promise<void>((done) => {
        const backs = this.comingBack.get(key) ?? new Set<() => void>();
        this.comingBack.set(key, backs);
        const timer = setTimeout(() => back(), end - Date.now());
        timer.unref?.();
        const back = () => {
          clearTimeout(timer);
          backs.delete(back);
          if (!backs.size) this.comingBack.delete(key);
          done();
        };
        backs.add(back);
      });
    }
  }

  /** The song as the studio has it now (it saves first, so nothing it applied is missed). */
  async song(job: AgentJob): Promise<Project> {
    // (a studio away a moment is waited for; one that doesn't come back leaves the song as saved here)
    if (!job.preset) await this.studioBack(job).catch(() => null);
    await this.flush(job.view.device, job.view.project);
    const song = this.o.store.get(job.view.project);
    if (!song) throw new Refusal(404, 'The song is gone');
    return song;
  }

  /** Who a song is by, its album and its creation, in words (the library keeps them beside the song). */
  about(project: string): string[] {
    return songLines(this.o.store.row(project));
  }

  /**
   * What the requester's studio shows: the playhead, the selection, the cycle, the view. While it's
   * away, what it showed as it went, with `away` (nothing plays; the tempo and cycle are the song's as
   * saved).
   */
  async studioState(job: AgentJob): Promise<Record<string, unknown>> {
    const studio = job.preset ? await this.studioBack(job) : await this.studioBack(job).catch(awayIsNull);
    const { device, project } = job.view;
    // who the song is by, its album, its creation: the library's, beside the song
    const about = this.about(project);
    if (!studio) {
      const last = this.left.get(backKey(device, project))?.state ?? this.o.live.studioFor(device, project)?.state;
      const song = this.o.store.get(project);
      return {
        away: true,
        ...(last ? shown(last) : {}),
        playing: false,
        recording: false,
        ...(song ? { bpm: song.tempo[0]?.bpm ?? 120, cycle: song.cycle } : {}),
        middleC: this.middleC(),
        about,
      };
    }
    const s = studio.state;
    if (!s) throw new Refusal(403, 'The song isn’t open in the studio that asked');
    return {
      ...shown(s),
      playing: s.playing,
      recording: s.recording,
      bpm: s.bpm,
      cycle: s.cycle,
      middleC: s.middleC,
      about,
    };
  }

  /**
   * A batch of the job's changes, for the requester's studio (one undo step with the rest of the
   * job's), answered once it's applied. While that studio is away (or back, but not yet caught up with
   * what was saved here meanwhile), it's saved here as a revision by "Agent", for the studio to pick
   * up as the job's step (`saveHere`, `awayFor`). Each batch goes in once, here or there.
   */
  async ops(job: AgentJob, ops: Op[], label: string, batch: string): Promise<{ ok: true; revision?: number }> {
    const arrived = Date.now();
    job.changed = true;
    const done = job.batches.get(batch);
    if (done !== undefined) return { ok: true, revision: done };
    const studio = await this.forChanges(job);
    if (studio) {
      // (the time waited for the studio comes out of the minute it has to apply them; a hidden page
      // that doesn't answer soon was frozen by its browser)
      const hidden = isHidden(studio);
      const left = Math.max(5_000, (hidden ? this.limits.hiddenMs : this.limits.opsMs) - (Date.now() - arrived));
      const answer = await this.o.live.request(
        studio,
        {
          type: 'agent-ops',
          project: job.view.project,
          job: job.view.id,
          batch,
          ops,
          label,
          // (its changes join the undo step of the go it carries on)
          ...(job.continues ? { continues: job.continues } : {}),
        },
        left,
        true,
      );
      if (answer.error === GONE) throw new Refusal(409, WENT, 'away');
      // (it has just opened another song, and hasn't said so here yet: nothing went in there, and
      // the batch is saved here, as the rest will be)
      const elsewhere = !answer.ok && answer.reason === NOT_OPEN;
      if (!elsewhere && (!hidden || answer.error !== NO_ANSWER)) {
        if (!answer.ok)
          throw new Refusal(answer.error === NO_ANSWER ? 504 : 400, answer.error ?? 'The studio refused the change');
        this.noteChange(job, label, batch);
        return typeof answer.revision === 'number' ? { ok: true, revision: answer.revision } : { ok: true };
      }
      // (should it wake and apply the batch after all, its id has it go in there once)
      if (!elsewhere) this.unanswered(studio);
    }
    const saved = this.saveHere(job, ops, label, batch);
    this.noteChange(job, label, batch);
    return saved;
  }

  /**
   * A batch went in: its label joins what the turn changed (the same label again counts with the last),
   * kept with the turn as it goes, so what a turn got done is known however it ends.
   */
  private noteChange(job: AgentJob, label: string, batch: string): void {
    // (a batch sent again went in once: its studio answers for it as before)
    const noted = this.noted.get(job) ?? new Set<string>();
    this.noted.set(job, noted);
    if (noted.has(batch)) return;
    noted.add(batch);
    const last = job.changes.at(-1);
    const text = oneLine(label, 80);
    if (last && (last[0] === text || job.changes.length >= KEEP_CHANGES)) last[1]++;
    else job.changes.push([job.changes.length === KEEP_CHANGES - 1 ? 'more changes' : text, 1]);
    this.saveTurn(job);
  }

  /**
   * The requester's studio to send a batch to: there, and caught up with the changes saved here while
   * it was away (else this batch would land before them); or null, and the batch is saved here. A
   * studio away a moment (a reload) is waited for, and one that's back gets a moment to catch up.
   */
  private async forChanges(job: AgentJob): Promise<LiveClient | null> {
    const ready = (c: LiveClient | null): c is LiveClient => c !== null && caughtUp(job, c);
    // (a scan preset carries on without its studio: no waiting for it)
    if (job.preset) {
      const here = this.studio(job);
      return ready(here) ? here : null;
    }
    const back = await this.studioBack(job).catch(awayIsNull);
    if (!back || ready(back)) return back;
    const key = backKey(job.view.device, job.view.project);
    await this.until(key, () => ready(this.studio(job)), this.limits.catchUpMs);
    const now = this.studio(job);
    return ready(now) ? now : null;
  }

  /** A batch saved here as a revision by "Agent", in the job's run for its studio to pick up. */
  private saveHere(job: AgentJob, ops: Op[], label: string, batch: string): { ok: true; revision: number } {
    const song = this.o.store.get(job.view.project);
    if (!song) throw new Refusal(404, 'The song is gone');
    let next: Project;
    try {
      next = parseProject(applyOps(song, ops));
    } catch (err) {
      throw new Refusal(400, err instanceof Error ? err.message : String(err));
    }
    // the run goes on from its last revision; saved by someone else since, a new one begins, the song
    // as it was then kept (a studio that reloads reads it, for the step's Undo), and the old one's
    // songs go with it
    const run = job.away?.head === song.revision ? job.away : null;
    if (!run) this.o.store.snapshotNow(song.id, 'Agent');
    const saved = this.o.store.save(next, song.revision, 'Agent');
    if (!saved) throw new Refusal(409, 'Changed while applying; try again');
    const away: AwayRun = run ?? { base: song.revision, head: song.revision, batches: [], recent: [] };
    away.head = saved.revision;
    away.batches.push({ batch, label, revision: saved.revision });
    away.recent = [...away.recent, { revision: saved.revision, doc: JSON.stringify(saved) }].slice(-RUN_RECENT);
    job.away = away;
    job.batches.set(batch, saved.revision);
    this.o.live.tell({ type: 'saved', project: saved.id, revision: saved.revision });
    return { ok: true, revision: saved.revision };
  }

  /**
   * What a device's studio, back on a song at revision `from`, picks up of the changes the song's job
   * saved here while it was away: the batches after `from` (all of them from before the run), the
   * revision they bring the song to and the song then, and the job's label. Only for the device that
   * asked for the job; null when there's nothing to pick up from `from` (no run, `from` past it but not
   * one of its revisions, or the song saved since by someone else).
   */
  awayFor(device: string, project: string, from: number): AwayChanges | null {
    let job: AgentJob | null = null;
    for (const j of this.jobs.values()) if (j.view.project === project && j.view.device === device && j.away) job = j;
    const run = job?.away;
    // (read with the song as it is, at once: no save can come between them)
    const song = run ? this.o.store.get(project) : null;
    if (!job || !run || song?.revision !== run.head) return null;
    // from before the run, all of it: the studio takes it only if its song is the run's first
    const after = from <= run.base ? 0 : run.batches.findIndex((b) => b.revision === from) + 1;
    if (after === 0 && from > run.base) return null;
    const batches = run.batches.slice(after);
    const last = batches.at(-1);
    if (!last) return null;
    return {
      job: job.view.id,
      label: job.view.label ?? last.label,
      running: isLive(job),
      base: after === 0 ? run.base : from,
      head: run.head,
      batches: batches.map(({ batch }) => ({ batch })),
      song,
    };
  }

  /** Play, stop, or move the playhead to a bar, in the requester's studio. */
  async transport(job: AgentJob, action: 'play' | 'stop' | 'locate', bar?: number): Promise<{ ok: boolean }> {
    const studio = await this.studioBack(job);
    let at: number | undefined;
    if (bar !== undefined) {
      const song = this.o.store.get(job.view.project);
      if (!song) throw new Refusal(404, 'The song is gone');
      at = barToTick(song.meter, bar);
    }
    const answer = await this.o.live.request(
      studio,
      { type: 'transport', action, ...(at !== undefined ? { at } : {}) },
      undefined,
      true,
    );
    awayIfGone(answer);
    if (!answer.ok) throw new Refusal(409, answer.error ?? 'The studio couldn’t do that');
    return { ok: true };
  }

  /** Notes played in the requester's studio now (not recorded). */
  async audition(job: AgentJob, events: number[][], track?: string): Promise<void> {
    const studio = await this.studioBack(job);
    this.o.live.sendTo(studio, { type: 'play-notes', events, track: track ?? null, port: 'Agent' });
  }

  /** A line under the bar while the agent works (nothing once the job is over). */
  progress(job: AgentJob, line: string): void {
    if (!isLive(job) || job.ending) return;
    this.heard(job);
    job.view.state = 'running';
    job.view.line = oneLine(line, 200);
    this.tell(job);
  }

  /** The agent asks the user to allow something: the job waits for them once its turn ends. */
  permission(job: AgentJob, permission: Permission): void {
    job.asked = permission;
  }

  /** A brief for the user's own harness, shown in full with its commands and links flagged. */
  handoff(job: AgentJob, brief: string): void {
    job.view.brief = brief;
    const warnings = briefWarnings(brief);
    if (warnings.length) job.view.briefWarnings = warnings;
    else delete job.view.briefWarnings;
    this.tell(job);
  }

  /**
   * The undo step's label, the reply under the bar, and what it shows under it (blocks already checked,
   * every version they name one this job has: its revision goes with them; "after" once the turn is
   * done), where the studio goes as it arrives, and the view's dock (a few of its controls again, for a
   * phone's tray: only with a view, its versions taken with the view's).
   */
  finish(job: AgentJob, label: string, reply: string, blocks?: Block[], go?: Go, dock?: Block[]): void {
    if (dock && !blocks) throw new Refusal(400, DOCK_NEEDS_VIEW);
    job.view.label = label;
    job.view.reply = reply;
    if (blocks) {
      const versions: Record<string, number> = {};
      const named = viewVersions([...blocks, ...(dock ?? [])]);
      // (an A/B of two of the same song is no comparison)
      if (!job.changed && named.includes(BEFORE) && named.includes(AFTER))
        throw new Refusal(
          400,
          'Nothing changed in this request, so "before" and "after" are the same song. To compare an earlier change, play "previous" (the song before your previous request) against "before".',
        );
      for (const name of named) {
        if (name === AFTER) continue;
        const revision = name === BEFORE ? job.before : name === PREVIOUS ? job.previous : job.versions.get(name);
        if (revision === null || revision === undefined)
          throw new Refusal(
            400,
            name === BEFORE
              ? 'The song from before this request wasn’t kept'
              : name === PREVIOUS
                ? 'There’s no earlier request in this conversation to compare with'
                : `No version "${name}" was kept this turn`,
          );
        versions[name] = revision;
      }
      job.view.view = { blocks, versions, ...(dock?.length ? { dock } : {}) };
    } else delete job.view.view;
    if (go) job.view.go = go;
    else delete job.view.go;
    this.saveTurn(job);
  }

  /**
   * A version for the reply's view: the studio saves, and the song as saved is kept in its history
   * under the name; its revision. While the studio is away, the song as saved here is the song as it
   * is (the job's changes are saved here meanwhile).
   */
  async version(job: AgentJob, name: string): Promise<{ ok: true; revision: number }> {
    if (name === BEFORE || name === AFTER || name === PREVIOUS || job.versions.has(name))
      throw new Refusal(409, `There's a version "${name}" already`);
    if (job.versions.size >= VIEW_LIMITS.versions)
      throw new Refusal(409, `At most ${VIEW_LIMITS.versions} versions a turn`);
    const studio = job.preset ? null : await this.studioBack(job).catch(awayIsNull);
    if (studio) {
      const hidden = isHidden(studio);
      const wait = hidden ? Math.min(this.limits.flushMs, this.limits.hiddenMs) : this.limits.flushMs;
      const answer = await this.o.live.request(studio, { type: 'agent-flush', project: job.view.project }, wait, true);
      // (a hidden page that doesn't answer was frozen by its browser: the song as saved here it is;
      // so it is when the studio has just opened another song)
      if (hidden && answer.error === NO_ANSWER) this.unanswered(studio);
      else if (!(!answer.ok && answer.reason === NOT_OPEN)) {
        awayIfGone(answer);
        if (!answer.ok)
          throw new Refusal(
            answer.error === NO_ANSWER ? 504 : 409,
            answer.error ?? 'The studio couldn’t save the song',
          );
      }
    }
    const revision = this.o.store.snapshotNow(job.view.project, `Agent: ${name}`);
    if (revision === null) throw new Refusal(404, 'The song is gone');
    job.versions.set(name, revision);
    return { ok: true, revision };
  }

  /** The commands the requester's studio can run now (its bar's), for the buttons of a reply. */
  async commands(job: AgentJob): Promise<{ commands: { id: string; title: string }[] }> {
    const studio = await this.studioBack(job);
    const answer = await this.o.live.request(studio, { type: 'agent-commands' }, this.limits.compareMs, true);
    awayIfGone(answer);
    if (!answer.ok || !Array.isArray(answer.commands))
      throw new Refusal(answer.error === NO_ANSWER ? 504 : 409, answer.error ?? 'The studio didn’t list its commands');
    const commands: { id: string; title: string }[] = [];
    for (const c of answer.commands.slice(0, 200)) {
      if (typeof c !== 'object' || c === null) continue;
      const { id, title } = c as Record<string, unknown>;
      if (typeof id === 'string' && /^[a-z][a-z0-9-]{0,40}$/.test(id) && typeof title === 'string')
        commands.push({ id, title: title.replace(/\p{Cc}/gu, ' ').slice(0, 60) });
    }
    return { commands };
  }

  // ---- listening, what was just played, A/B ----

  /** Whether a job may read an attachment: its request's, or an earlier request's on its thread. */
  mayRead(job: AgentJob, id: string): boolean {
    if (job.attachments.includes(id)) return true;
    return this.o.agentStore.turns(job.thread).some((t) => (parseExtra(t.extra).attachments ?? []).includes(id));
  }

  /**
   * One part of a listen to what the requester's studio plays (only it: not other studios, not the
   * network). A listen is heard as one from its first part to its last: what's played between two
   * parts goes to the next, and every note's time counts from the listen's start. A part ends when
   * `quietMs` of silence follows a note (done), when the user presses Done (done), at the end of the
   * part the tool says is its `last` (done), or after `maxMs` (not done: the tool asks for the next
   * part, and the studio keeps showing it listens for a grace; with no next part by then, the listen
   * is over and what came after the last part is let go).
   */
  listen(job: AgentJob, maxMs: number, quietMs: number, last = false): Promise<ListenPart> {
    if (!this.studio(job)) throw new Refusal(403, 'The song isn’t open in the studio that asked');
    if (job.listen) throw new Refusal(409, 'Already listening');
    if (!job.hearing) {
      const now = Date.now();
      job.hearing = {
        start: now,
        parts: 0,
        given: 0,
        stop: null,
        from: 0,
        count: 0,
        held: 0,
        heardAt: now,
        kept: [],
        onHeard: null,
      };
      this.collect(job, job.hearing);
    }
    const h = job.hearing;
    const part = ++h.parts;
    // Done was pressed between two parts: this one ends at once, with what was played before it
    if (job.doneListening) return Promise.resolve(this.endHearing(job, part));
    return new Promise((resolve) => {
      let quiet: NodeJS.Timeout | null = null;
      // quiet once nothing's held, after at least one note of the listen (a quiet spell carries on from the part before)
      const listenFor = () => {
        if (quiet) clearTimeout(quiet);
        quiet =
          h.held === 0 && h.given + h.count > 0
            ? setTimeout(() => session.finish(true), Math.max(0, quietMs - (Date.now() - h.heardAt)))
            : null;
      };
      const session = {
        finish: (done: boolean) => {
          if (job.listen !== session) return;
          job.listen = null;
          clearTimeout(max);
          if (quiet) clearTimeout(quiet);
          h.onHeard = null;
          resolve(done || last ? this.endHearing(job, part) : this.pauseHearing(job, part));
        },
      };
      const max = setTimeout(() => session.finish(false), maxMs);
      job.listen = session;
      h.onHeard = listenFor;
      listenFor();
      this.listenState(job, 'on');
    });
  }

  /** Collect what the requester's studio plays, for a listen, from now on. */
  private collect(job: AgentJob, h: Hearing): void {
    const { device, project } = job.view;
    h.from = Date.now() - h.start;
    h.count = 0;
    h.held = 0;
    h.stop = this.o.live.collect(
      (c) => c.device === device && c.state?.project === project,
      (held, notes) => {
        h.held = held;
        h.count = notes;
        h.heardAt = Date.now();
        h.onHeard?.();
      },
    );
  }

  /** What a listen's collector has, its times from the listen's start; the collector stops. */
  private take(h: Hearing): PlayedNote[] {
    const raw = h.stop?.() ?? [];
    h.stop = null;
    h.count = 0;
    h.held = 0;
    h.given += raw.length;
    return raw.map((n) => ({ ...n, time: n.time + h.from }));
  }

  /** A part ended and the listen goes on: what's whole is handed out, and the studio waits for the next part. */
  private pauseHearing(job: AgentJob, part: number): ListenPart {
    const h = job.hearing as Hearing;
    let notes: PlayedNote[] = [];
    // with a key down, the collector carries on, so that note's length is whole: a later part has them
    if (h.stop && h.held === 0) {
      notes = this.take(h);
      this.collect(job, h);
    }
    this.listenState(job, 'pause');
    return { notes, done: false, part, pending: h.count };
  }

  /** The listen is over: every note not handed out yet. */
  private endHearing(job: AgentJob, part: number): ListenPart {
    const h = job.hearing as Hearing;
    job.hearing = null;
    const notes = [...h.kept, ...this.take(h)];
    this.listenState(job, 'off');
    return { notes, done: true, part, pending: 0 };
  }

  /** The user pressed Done: the listen ends now (or, between two parts, the next part ends at once). */
  doneListening(device: string, id: string): void {
    const job = this.jobs.get(id);
    if (!job) throw new Refusal(404, 'No such job');
    if (job.view.device !== device) throw new Refusal(403, 'Only the device that asked can say');
    if (!isLive(job)) throw new Refusal(409, 'That job has ended');
    if (job.listen) job.listen.finish(true);
    else if (job.listenOn) {
      job.doneListening = true;
      // what was played up to Done goes to that part; nothing after it
      const h = job.hearing;
      if (h?.stop) h.kept.push(...this.take(h));
    }
  }

  /**
   * What the studio shows: listening (`on`), not (`off`), or between two parts of a listen (`pause`:
   * it stays on unless the next part doesn't come within the grace). Off, the listen is over.
   */
  private listenState(job: AgentJob, state: 'on' | 'off' | 'pause'): void {
    if (job.listenOff) clearTimeout(job.listenOff);
    job.listenOff = null;
    const { device, project } = job.view;
    if (state === 'pause') {
      job.listenOff = setTimeout(() => this.listenState(job, 'off'), this.limits.listenGraceMs);
      job.listenOff.unref?.();
      return;
    }
    if (state === 'off' && job.hearing) {
      // no next part came: what was heard since the last one is let go
      job.hearing.stop?.();
      job.hearing = null;
    }
    if (job.listenOn === (state === 'on')) return;
    job.listenOn = state === 'on';
    if (state === 'off') job.doneListening = false;
    this.o.live.toDevices({ type: 'agent-listen', job: job.view.id, state }, (c) =>
      state === 'on' ? c.device === device && c.state?.project === project : c.device === device,
    );
  }

  /** A job ended: so does its listening. */
  private stopListening(job: AgentJob): void {
    job.listen?.finish(true);
    this.listenState(job, 'off');
  }

  /** What the requester's studio has just played (its memory of the last `seconds`, at most 60). */
  async played(job: AgentJob, seconds: number): Promise<{ notes: PlayedNote[] }> {
    const studio = await this.studioBack(job);
    const answer = await this.o.live.request(studio, { type: 'agent-played', seconds }, this.limits.playedMs, true);
    awayIfGone(answer);
    if (!answer.ok || !Array.isArray(answer.notes)) {
      if (answer.error === NO_ANSWER) throw new Refusal(504, 'The studio didn’t say in time what was just played');
      throw new Refusal(409, answer.error ?? 'The studio can’t say what was just played');
    }
    return { notes: parsePlayed(answer.notes) };
  }

  /**
   * What the requester's studio would keep of what was just played (Capture), as operations for the
   * job to apply: its tool sends them back through `ops`, so they're in the job's undo step.
   */
  async capture(job: AgentJob): Promise<Captured> {
    const studio = await this.studioBack(job);
    const answer = await this.o.live.request(studio, { type: 'agent-capture' }, this.limits.playedMs, true);
    awayIfGone(answer);
    if (!answer.ok) {
      if (answer.error === NO_ANSWER) throw new Refusal(504, 'The studio didn’t say in time what was just played');
      throw new Refusal(409, answer.error ?? 'The studio can’t keep what was just played');
    }
    return parseCaptured(answer);
  }

  /** A/B: the requester's studio plays bars `from` to `to` (not played) from before the job, then as they are now. */
  async compare(job: AgentJob, from: number, to: number): Promise<{ ok: true }> {
    const studio = await this.studioBack(job);
    const answer = await this.o.live.request(
      studio,
      { type: 'agent-compare', job: job.view.id, from, to },
      this.limits.compareMs,
      true,
    );
    awayIfGone(answer);
    if (!answer.ok)
      throw new Refusal(answer.error === NO_ANSWER ? 504 : 409, answer.error ?? 'The studio couldn’t play them');
    return { ok: true };
  }
}

/** Tools waiting for a device's studio with a song open are found by this. */
function backKey(device: string, project: string): string {
  return `${device}\n${project}`;
}

/** How long a studio that left a song is remembered (what it showed, whether it was hidden). */
const LEFT_LIFE = 24 * 3_600_000;

/** Whether a studio's page is hidden, as it last reported (its browser may freeze it: a phone in another app). */
export function isHidden(c: LiveClient): boolean {
  return (c.state as unknown as { hidden?: unknown } | null)?.hidden === true;
}

/** Whether a studio has the changes the job saved here while it was away: their last revision, or later. */
function caughtUp(job: AgentJob, c: LiveClient): boolean {
  return !job.away || (c.state?.revision ?? -1) >= job.away.head;
}

/** A refusal for the studio being away is no studio; anything else stands. */
function awayIsNull(err: unknown): null {
  if (err instanceof Refusal && err.reason === 'away') return null;
  throw err;
}

/** Where a studio's playhead is, what's selected, and the view and scan in front, as the tools read them. */
function shown(s: EditorState): Record<string, unknown> {
  const extra = s as unknown as Record<string, unknown>;
  return {
    playhead: s.tick,
    position: s.position,
    selection: s.selection,
    ...(typeof extra.view === 'string' ? { view: extra.view.slice(0, 40) } : {}),
    ...(typeof extra.scan === 'string' && SCAN_ID.test(extra.scan) ? { scan: extra.scan } : {}),
  };
}

/** A studio that went away before it answered: the tool hears it's away (409 `away`). */
export function awayIfGone(answer: Answer): void {
  if (answer.error === GONE) throw new Refusal(409, AWAY, 'away');
}

/** What a turn keeps of its job besides its reply. */
function turnExtra(job: AgentJob): string {
  const v = job.view;
  const extra: TurnExtra = {
    ...(job.before !== null ? { before: job.before } : {}),
    ...(v.permission ? { permission: v.permission } : {}),
    ...(v.brief ? { brief: v.brief } : {}),
    ...(v.briefWarnings ? { briefWarnings: v.briefWarnings } : {}),
    ...(v.view ? { view: v.view } : {}),
    ...(v.go ? { go: v.go } : {}),
    ...(v.error ? { error: v.error } : {}),
    ...(job.attachments.length ? { attachments: job.attachments } : {}),
    started: v.started,
    ...(v.finished !== undefined ? { finished: v.finished } : {}),
    ...(v.title !== undefined ? { title: v.title } : {}),
    harness: job.harness,
    ...(job.model ? { model: job.model } : {}),
    ...(job.effort ? { effort: job.effort } : {}),
    ...(job.context ? { context: job.context } : {}),
    ...(job.preset ? { preset: job.preset } : {}),
    ...(job.heard.length ? { heard: job.heard } : {}),
    ...(job.changes.length ? { changes: job.changes } : {}),
    ...(job.stop ? { stop: job.stop } : {}),
    ...(job.previous !== null ? { previous: job.previous } : {}),
    ...(job.continues ? { continues: job.continues } : {}),
    ...(job.allowed ? { allowed: job.allowed } : {}),
  };
  return JSON.stringify(extra);
}

/**
 * A job as it was when HO[LO] stopped, from its turn: what `permit` and the studios need of one that
 * waits for a click (it has no runner, no token and no clock: its turn was over).
 */
function jobFromTurn(
  row: UnfinishedTurn,
  extra: TurnExtra,
  project: string,
  device: string,
  harness: HarnessId,
): AgentJob {
  return {
    view: {
      id: row.job,
      project,
      device,
      state: 'awaiting',
      request: row.request,
      ...(row.reply !== null ? { reply: row.reply } : {}),
      ...(row.label !== null ? { label: row.label } : {}),
      ...(extra.permission ? { permission: extra.permission as Permission } : {}),
      ...(extra.brief ? { brief: extra.brief } : {}),
      ...(extra.briefWarnings ? { briefWarnings: extra.briefWarnings } : {}),
      ...(extra.view ? { view: extra.view } : {}),
      ...(extra.go ? { go: extra.go } : {}),
      started: extra.started ?? row.at,
      ...(extra.finished !== undefined ? { finished: extra.finished } : {}),
      ...(extra.title !== undefined ? { title: extra.title } : {}),
      harness,
      ...(extra.model ? { model: extra.model } : {}),
      ...(extra.effort ? { effort: extra.effort } : {}),
      ...(extra.continues ? { continues: extra.continues } : {}),
    },
    thread: row.thread,
    harness,
    model: extra.model ?? '',
    effort: extra.effort ?? '',
    tokenHash: null,
    preset: extra.preset ?? null,
    asked: (extra.permission as Permission | undefined) ?? null,
    batches: new Map(),
    away: null,
    clock: null,
    dropped: null,
    quiet: null,
    calls: 0,
    queued: false,
    ceiling: 0,
    ending: false,
    attachments: extra.attachments ?? [],
    listen: null,
    listenOn: false,
    hearing: null,
    listenOff: null,
    doneListening: false,
    before: extra.before ?? null,
    versions: new Map(),
    previous: extra.previous ?? null,
    changed: (extra.changes?.length ?? 0) > 0,
    context: extra.context ?? null,
    heard: extra.heard ?? [],
    changes: extra.changes ?? [],
    stop: null,
    continues: extra.continues ?? null,
    allowed: extra.allowed ?? null,
  };
}

/** What Capture would keep (the agent package's `Captured`): the operations and what to say of them, or why there are none. */
export type Captured = { ops: Op[]; notes: number; tracks: string[]; regions: string[] } | { nothing: string };

/**
 * What a studio says Capture would keep, checked (also for the command line's `POST /api/live/capture`):
 * only regions added to tracks, and no more of them than a phrase could make.
 */
export function parseCaptured(answer: Record<string, unknown>): Captured {
  if (typeof answer.nothing === 'string') return { nothing: oneLine(answer.nothing, 200) };
  const ops: Op[] = [];
  for (const raw of Array.isArray(answer.ops) ? answer.ops.slice(0, 256) : []) {
    if (typeof raw !== 'object' || raw === null) continue;
    const op = raw as Record<string, unknown>;
    if (op.op !== 'addRegion' || typeof op.track !== 'string' || typeof op.region !== 'object' || op.region === null)
      continue;
    ops.push({ op: 'addRegion', track: op.track, region: op.region as Region });
  }
  if (!ops.length) return { nothing: 'Nothing was played to keep' };
  const names = (v: unknown) =>
    Array.isArray(v)
      ? v
          .filter((x): x is string => typeof x === 'string')
          .map((x) => oneLine(x, 80))
          .slice(0, 256)
      : [];
  const notes =
    typeof answer.notes === 'number' && Number.isFinite(answer.notes) ? Math.max(0, Math.round(answer.notes)) : 0;
  return { ops, notes, tracks: names(answer.tracks), regions: names(answer.regions) };
}

/** Notes the studio says were played, checked (also for the command line's `GET /api/live/played`). */
export function parsePlayed(list: unknown[]): PlayedNote[] {
  const n = (v: unknown, lo: number, hi: number): number | null =>
    typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;
  const out: PlayedNote[] = [];
  for (const raw of list.slice(0, 5000)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const e = raw as Record<string, unknown>;
    const pitch = n(e.pitch, 0, 127);
    const velocity = n(e.velocity, 0, 127);
    const time = n(e.time, -1e9, 1e9);
    if (pitch === null || velocity === null || time === null) continue;
    out.push({
      tick: n(e.tick, 0, 1e10),
      time,
      pitch: Math.round(pitch),
      velocity: Math.round(velocity),
      length: n(e.length, 0, 1e9),
      port: typeof e.port === 'string' ? oneLine(e.port, 80) : '',
    });
  }
  return out;
}

/** Which report of a harness says most: found, then sealed, then signed in. */
function rank(h: HarnessInfo): number {
  return (h.found ? 4 : 0) + (h.sealed ? 2 : 0) + (h.signedIn !== false ? 1 : 0);
}

/** Programs a brief might ask the user to run (as typed in a terminal: lower case). */
const SHELL =
  '(?:sudo|curl|wget|rm|chmod|chown|npm|npx|pnpm|yarn|node|python3?|pip3?|git|bash|sh|zsh|powershell|pwsh|iex|eval|brew|apt(?:-get)?|docker|cargo)';
/** A line that runs something: a shell prompt, a program and its arguments (in code or not), pipes into a shell, chains. */
const COMMAND = new RegExp(`(^\\s*\\$\\s)|(^\\s*${SHELL}\\s)|(\`\\s*${SHELL}\\b)|(\\|\\s*(?:ba|z)?sh\\b)|&&|\\$\\(`);
const LINK = /\b(https?|ftp|file):\/\/|\bwww\.[a-z0-9-]+\.[a-z]/i;
/** A word, with `_`, `-`, `.` and `/` counting as gaps (API_KEY, client-secret, ~/.ssh/). */
const word = (re: string) => `(?<![a-z0-9])(?:${re})(?![a-z0-9])`;
/**
 * A line that mentions what a brief must never ask for (a brief is only for a change to HO[LO]'s
 * code, holo-packs or a creation): ssh and its keys, private keys, `.env` files (not `process.env`),
 * credentials, tokens, passwords, API keys, secrets, keychains, where other programs keep theirs, and
 * the system's password files.
 */
const SECRET = new RegExp(
  [
    word('ssh'),
    word('id_(?:rsa|dsa|ecdsa|ed25519)'),
    word('authorized_keys'),
    word('private[ _-]?keys?'),
    word('gnupg|gpg'),
    '\\.(?:pem|p12|pfx)(?![a-z0-9])',
    '(?<![a-z0-9_.$])\\.env(?![a-z0-9])',
    word('credentials?'),
    word('tokens?'),
    word('pass(?:words?|wd|phrases?)'),
    word('api[ _-]?keys?'),
    word('secrets?'),
    word('key[ -]?(?:chains?|rings?)'),
    '\\.aws(?![a-z0-9])',
    '\\.config/gh(?![a-z0-9])',
    '\\.(?:netrc|npmrc|pypirc|pgpass|git-credentials)(?![a-z0-9])',
    '\\.docker/config\\.json',
    '\\.kube/config(?![a-z0-9])',
    '/etc/(?:passwd|shadow|sudoers)(?![a-z0-9])',
  ].join('|'),
  'i',
);

/**
 * The lines of a brief the user should read twice before pasting: secrets it mentions, links and
 * commands. A line is flagged once: a secret first, then a link, then a command.
 */
export function briefWarnings(brief: string): BriefWarning[] {
  const out: BriefWarning[] = [];
  for (const [line, text] of brief.split('\n').entries()) {
    if (SECRET.test(text)) out.push({ line, kind: 'secret' });
    else if (LINK.test(text)) out.push({ line, kind: 'url' });
    else if (COMMAND.test(text)) out.push({ line, kind: 'command' });
  }
  return out;
}

const str = (v: unknown, max: number): string | undefined =>
  typeof v === 'string' && v.length > 0 ? oneLine(v, max) : undefined;

/** The harnesses a runner reports, checked: what's not as it should be is left out. */
export function parseHarnesses(list: unknown): HarnessInfo[] {
  if (!Array.isArray(list)) return [];
  const out: HarnessInfo[] = [];
  for (const raw of list.slice(0, 10)) {
    if (typeof raw !== 'object' || raw === null) continue;
    const h = raw as Record<string, unknown>;
    if (!HARNESSES.includes(h.id as HarnessId) || out.some((x) => x.id === h.id)) continue;
    const info: HarnessInfo = {
      id: h.id as HarnessId,
      name: str(h.name, 40) ?? HARNESS_NAMES[h.id as HarnessId],
      found: h.found === true,
      sealed: h.sealed === true,
    };
    if (h.sealUnknown === true && !info.sealed) info.sealUnknown = true;
    const version = str(h.version, 80);
    if (version) info.version = version;
    // a computer's name (letters, digits, - . _), and an installer's command line, as the studio shows them
    if (typeof h.host === 'string' && /^[A-Za-z0-9][\w.-]{0,63}$/.test(h.host)) info.host = h.host;
    const installer = str(h.installer, 200);
    if (installer && !info.found) info.installer = installer;
    if (typeof h.signedIn === 'boolean') info.signedIn = h.signedIn;
    const account = str(h.account, 120);
    if (account) info.account = account;
    const plan = checkPlan(h.plan);
    if (plan) info.plan = plan;
    const limits = checkLimits(h.limits);
    if (limits && info.found) info.limits = limits;
    if (typeof h.update === 'object' && h.update !== null) {
      const u = h.update as Record<string, unknown>;
      const latest = str(u.latest, 80);
      info.update = { available: u.available === true, ...(latest ? { latest } : {}) };
    }
    const reason = str(h.reason, 300);
    if (reason) info.reason = reason;
    // (a harness may list hundreds of models: Cursor lists nearly 300; each name is checked as settings check it)
    for (const [key, most] of [
      ['models', 500],
      ['efforts', 50],
    ] as const) {
      const values = h[key];
      if (Array.isArray(values))
        info[key] = values
          .slice(0, most * 2)
          .filter((m): m is string => typeof m === 'string' && MODEL.test(m))
          .slice(0, most);
    }
    if (typeof h.defaultModel === 'string' && MODEL.test(h.defaultModel)) info.defaultModel = h.defaultModel;
    // a model's name to a model's name or an effort, as settings check them
    for (const [key, most] of [
      ['defaultEfforts', 500],
      ['aliases', 50],
    ] as const) {
      const map = h[key];
      if (typeof map !== 'object' || map === null || Array.isArray(map)) continue;
      const kept = Object.entries(map)
        .filter((e): e is [string, string] => MODEL.test(e[0]) && typeof e[1] === 'string' && MODEL.test(e[1]))
        .slice(0, most);
      if (kept.length) info[key] = Object.fromEntries(kept);
    }
    // each model's efforts: a model's name to a few efforts, as settings check them
    const own = h.modelEfforts;
    if (typeof own === 'object' && own !== null && !Array.isArray(own)) {
      const kept = Object.entries(own)
        .filter(
          (e): e is [string, string[]] =>
            MODEL.test(e[0]) && Array.isArray(e[1]) && e[1].every((x) => typeof x === 'string' && MODEL.test(x)),
        )
        .slice(0, 500)
        .map(([m, list]) => [m, list.slice(0, 50)] as const);
      if (kept.length) info.modelEfforts = Object.fromEntries(kept);
    }
    if (h.mustChoose === true) info.mustChoose = true;
    out.push(info);
  }
  return out;
}

/** How long a sign-in, an update or an install under way is shown to a studio that comes later (a sign-in waits no longer). */
const RELAY_LIFE = 15 * 60_000;

/**
 * The longest sign-in link passed on to the studio. Google's (Antigravity) is about 700 characters,
 * with its client, its challenge and six scopes; the others' are much shorter.
 */
const URL_MOST = 2048;

/** How a sign-in, update, install or refresh goes, from the runner, checked before the studios see it. */
export function parseHarnessEvent(msg: Record<string, unknown>): Record<string, unknown> | null {
  if (!HARNESSES.includes(msg.harness as HarnessId)) return null;
  if (msg.kind !== 'login' && msg.kind !== 'update' && msg.kind !== 'install' && msg.kind !== 'refresh') return null;
  if (msg.state !== 'running' && msg.state !== 'done' && msg.state !== 'failed') return null;
  const out: Record<string, unknown> = { harness: msg.harness, kind: msg.kind, state: msg.state };
  if (typeof msg.url === 'string' && msg.url.length <= URL_MOST) {
    try {
      const url = new URL(msg.url);
      if (url.protocol === 'https:' || url.protocol === 'http:') out.url = url.href;
    } catch {
      // not a link: left out
    }
  }
  if (typeof msg.code === 'string' && /^[\x21-\x7e]{1,64}$/.test(msg.code)) out.code = msg.code;
  if (msg.ask === 'code') out.ask = 'code';
  const line = str(msg.line, 200);
  if (line) out.line = line;
  const error = str(msg.error, 500);
  if (error) out.error = error;
  return out;
}

export const PERMISSION_KINDS: readonly PermissionKind[] = [
  'install-pack',
  'send-creation',
  'bounce',
  'stems',
  'stems-stacks',
  'render',
  'screen',
  'photo',
  'microphone',
];
