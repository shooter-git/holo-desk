/**
 * Everything the studio does to a song goes through here: edits as operations (each an undo
 * step), saving, opening, the transport, tracks and regions. Buttons, key commands, the piano roll
 * and the AI all call these.
 */

import { notesIntoKey, type StemsBy, stepInKey, swings, swungAt } from '@holo/agent/edits';
import {
  type ClickSound,
  clipKey,
  compileClips,
  compileTempo,
  detectHits,
  encodeWav,
  frameToTick,
  isClickSound,
  kitSource,
  songKits,
  tickToFrame,
} from '@holo/engine';
import type { LiveRoute } from '@holo/engine/companion';
import {
  type AudioFile,
  applyOps,
  barToTick,
  type ChannelPatch,
  DIVISIONS,
  DRUM_PIECES,
  type Instrument,
  meterAt,
  type Note,
  newAudioTrack,
  newBus,
  newId,
  newPlugin,
  newRegion,
  newTrack,
  type Op,
  type PackSound,
  PPQ,
  type Project,
  paramValue,
  parseProject,
  performed,
  pluginDef,
  projectEnd,
  quantize,
  type Region,
  scaleAt,
  secondsToTick,
  soundTrack,
  splitRegionAt,
  TRACK_COLORS,
  type Track,
  type TrackPatch,
  ticksPerBar,
  tickToBarBeat,
  tickToSeconds,
  unrollOps,
  writtenSpans,
} from '@holo/session';
import { bounce, bounceRange } from '../audio/bounce.ts';
import { bouncesOnHost } from '../audio/bounce-on.ts';
import { companion, STUDIO_ENGINE } from '../audio/companion.ts';
import { engine, type RecordedTake, warmEngine } from '../audio/engine.ts';
import { chosenRate, type RateChoice } from '../audio/engine-rate.ts';
import { audioFiles } from '../audio/files.ts';
import { onSoundsComing, soundsComing } from '../audio/loading.ts';
import { midi } from '../audio/midi.ts';
import { instrumentManifest } from '../audio/pack-files.ts';
import { library } from '../audio/samples.ts';
import { songKeys } from '../audio/song-samples.ts';
import { takes as keptTakes, type TakePlan, uploadTake } from '../audio/takes.ts';
import { holdDuringDrags } from '../ui/gesture.ts';
import { NOTE_EFFECTS, playsHits } from '../ui/pads.ts';
import { AgentError, agent, awayChanges, helloFields, isLive, jobLabels } from './agent.ts';
import { ApiError, api } from './api.ts';
import { bounceShelf, holdFile, letFileGo, type SaveWay, saveFile, thisSaveWay } from './bounce-save.ts';
// (live.ts imports this module too: neither uses the other while loading, so the cycle is harmless)
import { type CapturePlan, captured, planCapture, takeRegions } from './capture.ts';
import { comparePlan, type Pass } from './compare.ts';
import * as history from './history.ts';
import {
  askHostBounce,
  dropBounce,
  findBounce,
  isStems,
  type KeptBounce,
  keepBounce,
  keptBounce,
  type ListedBounce,
  markBounced,
  removeBounce,
  startHostBounce,
  watchHostBounce,
} from './host-bounce.ts';
import { browserShelf, type Keepable, Keeper, type Restored, sameSong, stepJobs } from './kept-history.ts';
import { isTouch } from './layout.ts';
import { reconnectSoon, reportHistory } from './live.ts';
import { mergeSongs } from './merge-songs.ts';
import { nearestShown, type Show, type Sight, selectionInSight, songIndex, stepShown } from './shown-tracks.ts';
import { type AppState, openBar, type Step, store, toast } from './store.ts';
import { TakeSender } from './take-sender.ts';
import { foldsKept, foldsOf, isStackRowId, keepFolds, planDrop } from './track-rows.ts';

// ---- editing ----

/**
 * Apply operations as one undo step. Returns the new song, or null if they didn't apply. `own` is
 * false for changes made from the command line (the agent hears only of the user's own).
 */
export function apply(ops: Op[], label: string, own = true): Project | null {
  const s = store.get();
  if (!s.project || ops.length === 0) return null;
  let next: Project;
  try {
    next = applyOps(s.project, ops);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
    return null;
  }
  store.set({ project: next, ...history.push(s, { project: s.project, label, at: Date.now() }), saveState: 'dirty' });
  changed(next);
  if (own) userStep(label);
  return next;
}

/**
 * A step of the user's own while this device's request runs: the host is told, so the agent hears
 * of it before its next reply (and the job's changes after it go in a step of their own).
 */
function userStep(label: string): void {
  const s = store.get();
  if (s.agentReport && agentAtWork(s)) reportHistory('step', label);
}

/**
 * A request of this device's is at work on the open song (as the studio knows: from its first batch,
 * or from the host's word). One at work on another song isn't this song's.
 */
function agentAtWork(s: AppState): boolean {
  const open = s.project?.id;
  if (!open) return false;
  const a = agent.get();
  const here = (job: string) => (a.jobs[job]?.project ?? open) === open;
  return (
    Object.entries(s.agentJobs).some(([job, running]) => running && here(job)) ||
    Object.values(a.jobs).some((j) => j.device === a.me && j.project === open && isLive(j.state))
  );
}

function changed(project: Project): void {
  document.title = `${project.title} · HO[LO] Desk`;
  engine.sync(project);
  loadInstruments(project);
  refreshRouting();
  scheduleSave();
}

export function undo(): void {
  travel(-1);
}

export function redo(): void {
  travel(1);
}

/**
 * Several Undos (`n` below 0) or Redos (above 0) at once, as from the history menu: the song goes
 * straight to where they lead, and the agent hears of each step, as it would of that many presses.
 */
export function travel(n: number): void {
  const s = store.get();
  const moved = s.project && history.travel(s, s.project, n);
  if (!moved) return;
  const { steps, project } = moved;
  const action = n < 0 ? 'undo' : 'redo';
  const verb = n < 0 ? 'Undo' : 'Redo';
  store.set({ project, ...moved.history, selectedNotes: [], saveState: 'dirty' });
  changed(project);
  toast(steps.length === 1 ? `${verb} ${steps[0]?.label}` : `${verb} ${steps.length} steps`);
  if (s.agentReport) for (const step of steps) reportHistory(action, step.label, step.job);
}

/** Go to a step the history menu showed: back to before it, or forward through it. */
export function travelTo(step: Step): void {
  travel(history.distance(store.get(), step));
}

// ---- the agent's changes ----

/** A batch of the agent's changes, as the live channel brought it, for the song open then. */
interface JobBatch {
  project: string;
  ops: Op[];
  job: string;
  batch: string;
  label: string;
  /** Changes it saved on the host instead, picked up (pickUpAgent): this takes them in. */
  take?: () => history.JobResult;
}

/** The agent's batches wait here while a gesture or a drag is in progress (they hold it). */
const jobs = new history.JobQueue<JobBatch>(runJob);
holdDuringDrags(() => jobs.hold());

/**
 * How long a batch waits for a gesture before it goes in anyway: one that never ends (a remote's
 * fader whose phone went away) mustn't stall the agent, whose host gives up on a batch after a minute.
 */
const HOLD_LIMIT_MS = 15_000;

/**
 * Apply a batch of the agent's changes to the open song, as part of its job's undo step (named
 * "Agent: <label>"). It waits while the user is in the middle of a gesture or a drag, so their
 * step lands first; a batch that already went in isn't applied again. Resolves once it's in the song
 * (not saved yet), or with why it was refused, the song unchanged. No toast: the bar says what the
 * agent is doing.
 */
export function applyJob(ops: Op[], job: string, batch: string, label: string): Promise<history.JobResult> {
  const s = store.get();
  if (!s.project) return Promise.resolve({ ok: false, error: 'No song is open in the studio' });
  // (a job is running from its first batch until the host says otherwise)
  if (!Object.hasOwn(s.agentJobs, job)) setJobRunning(job, true);
  return submitJob({ project: s.project.id, ops, job, batch, label: `Agent: ${label}` });
}

/** Into the agent's queue: held by a gesture at most HOLD_LIMIT_MS, then let through. */
function submitJob(b: JobBatch): Promise<history.JobResult> {
  const result = jobs.submit(b);
  if (jobs.waiting(b.batch)) {
    window.setTimeout(() => {
      if (jobs.waiting(b.batch)) jobs.letThrough();
    }, HOLD_LIMIT_MS);
  }
  return result;
}

function runJob(b: JobBatch): history.JobResult {
  const s = store.get();
  // (another song was opened while it waited)
  if (!s.project || s.project.id !== b.project) return { ok: false, error: 'That song is not open in the studio' };
  if (b.take) return b.take();
  if (!b.ops.length) return { ok: true };
  let next: Project;
  try {
    next = applyOps(s.project, b.ops);
    // what the agent makes must be a song the studio could open again
    parseProject(next);
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
  const running = Object.hasOwn(s.agentJobs, b.job) ? s.agentJobs[b.job] === true : true;
  const h = history.pushOrMergeJob(gestureFirst(s, s.project), s.project, b.label, b.job, running);
  gestureFrom(next);
  arrived(b.batch, s.project, next);
  // only the history's own fields: `h` may still be the whole state (a batch merged into the job's
  // step leaves it as it was), whose song is the one from before this batch
  store.set({ project: next, undo: h.undo, redo: h.redo, saveState: 'dirty' });
  changed(next);
  return { ok: true };
}

/**
 * A gesture still going as the agent's changes are let through: its step so far lands first (the
 * history returned), and it goes on from the song with their changes in (`gestureFrom`), its own step
 * after theirs.
 */
function gestureFirst(h: history.History, now: Project): history.History {
  if (!gesture || gesture.before === now) return h;
  return history.push(h, { project: gesture.before, label: gesture.label, at: Date.now() });
}
function gestureFrom(next: Project): void {
  if (!gesture) return;
  gesture.before = next;
  gesture.last = undefined;
}

// ---- the agent's changes saved on the host while the studio was away ----

/**
 * The song as the host has it at the revision the studio carries on from (`serverRevision`): what its
 * own changes not saved yet were made on. Kept on the device with those changes, so a reload has it
 * too. Null when it isn't known: then the host's history is asked for that revision, and nothing else.
 */
let saved: { revision: number; song: Project } | null = null;

/** The song is the host's at `revision`, as saved, opened or picked up. */
function savedAs(revision: number, song: Project): void {
  saved = { revision, song };
}

/** The song as the host has it at `revision`, when this studio knows it. */
function savedAt(revision: number): Project | null {
  return saved?.revision === revision ? saved.song : null;
}

/**
 * The open song's last few batches of the agent's, with the song just before and after each: one the
 * host saved too (it came late, to a page frozen past the time it had) is taken back out of this
 * studio's own changes before they're put onto the host's song, which has it already. Only a few, and
 * only the open song's: each holds two songs.
 */
const lately = new Map<string, { before: Project; after: Project }>();
const LATELY_MOST = 5;
function arrived(batch: string, before: Project, after: Project): void {
  lately.set(batch, { before, after });
  for (const old of lately.keys()) {
    if (lately.size <= LATELY_MOST) break;
    lately.delete(old);
  }
}

/** How many of the agent's batches are kept as they came (for its tests). */
export function lateBatchesKept(): number {
  return lately.size;
}

/** Picking up the agent's changes saved on the host, under way, and whether to look again after it. */
let pickingUp: Promise<PickUp> | null = null;
let pickAgain = false;

/**
 * How a pick-up went: `picked` up; `none` to pick up (someone else saved the song, or nothing was
 * saved by the agent); `unknown`, as the host didn't answer: it's asked again later.
 */
export type PickUp = 'picked' | 'none' | 'unknown';

/**
 * The one try again a song has waiting, when the host didn't answer a pick-up (its song's, let go as
 * another opens), and how many came before it: each waits longer, up to a minute.
 */
let retry: { project: string; timer: number } | null = null;
let retries = 0;
const retryIn = () => Math.min(60_000, 5_000 * 2 ** retries++);
function retryLater(project: string, again: () => void): void {
  if (retry) window.clearTimeout(retry.timer);
  const timer = window.setTimeout(() => {
    retry = null;
    again();
  }, retryIn());
  retry = { project, timer };
}
/** The open song is let go: its try again, its count and its batches as they came go with it. */
function letGo(): void {
  if (retry) window.clearTimeout(retry.timer);
  retry = null;
  retries = 0;
  lately.clear();
}

/**
 * The song was saved on the host since this studio's revision. If that was the agent, working on this
 * device's request while the studio was away (a phone in another app, a closed tab), its changes are
 * picked up as its job's step, as if they had come while the studio was there (history.pickUp), and the
 * studio carries on from the host's revision: a later batch of the job's merges into that step, and
 * Undo takes the song back to before them. A call while one is under way joins it, and it looks again
 * after (unless the host didn't answer). What the studio does next goes by its revision then, which
 * callers that joined share.
 */
export function pickUpAgent(): Promise<PickUp> {
  if (pickingUp) {
    pickAgain = true;
    return pickingUp;
  }
  const run = async (): Promise<PickUp> => {
    let picked = false;
    let once: PickUp;
    do {
      pickAgain = false;
      once = await pickUpOnce();
      picked ||= once === 'picked';
    } while (pickAgain && once !== 'unknown');
    if (once !== 'unknown') retries = 0;
    return picked ? 'picked' : once;
  };
  pickingUp = run().finally(() => {
    pickingUp = null;
  });
  return pickingUp;
}

/** No answer from the host (its network, or nothing came for a while): it may have been the agent's. */
const LATE = Symbol('late');

/** What the host answers: its answer, null when it refused (no such revision kept, the agent off here), or LATE. */
function answered<T>(asked: Promise<T>): Promise<T | null | typeof LATE> {
  return asked.then(
    (v) => v,
    (err: unknown) => (err instanceof ApiError || err instanceof AgentError ? null : LATE),
  );
}

async function pickUpOnce(): Promise<PickUp> {
  const s = store.get();
  const song = s.project;
  if (!song) return 'none';
  const from = s.serverRevision;
  // (the song comes with them, as the host has it with them: no save can come between the two)
  const away = await answered(awayChanges(song.id, from));
  if (away === LATE) return 'unknown';
  if (!away || away.song.id !== song.id || away.song.revision !== away.head) return 'none';
  // what this studio's own changes were made on: the song as saved at `from`, known here (kept on the
  // device with them), else as the host's history kept that very revision; never another one
  let base = savedAt(from);
  if (!base) {
    const kept = await answered(api.revision(song.id, from));
    if (kept === LATE) return 'unknown';
    base = kept;
  }
  const label = `Agent: ${away.label}`;
  const take = (): history.JobResult => {
    const cur = store.get();
    if (cur.project?.id !== song.id || cur.serverRevision !== from) return { ok: false, error: 'The song changed' };
    const mine = cur.saveState === 'saved' ? null : withoutLate(cur.project, away.batches);
    // (what can't be told apart from the agent's late batches clashes with them)
    const own = cur.saveState === 'saved' ? null : mine ? { base, song: mine } : { base: null, song: cur.project };
    const picked = history.pickUp(gestureFirst(cur, cur.project), cur.project, away.song, own, label, away.job);
    gestureFrom(picked.project);
    jobs.remember(away.batches.map((b) => b.batch));
    savedAs(away.head, away.song);
    store.set({
      project: picked.project,
      undo: picked.undo,
      redo: picked.redo,
      serverRevision: away.head,
      saveState: picked.how === 'merged' ? 'dirty' : 'saved',
    });
    changed(picked.project);
    if (picked.how === 'theirs')
      toast(
        picked.why === 'unknown'
          ? 'The agent changed the song while this device had unsaved changes: the song has the agent’s now, and yours are one Undo away'
          : 'Your unsaved changes and the agent’s couldn’t be put together: the song has the agent’s now, and yours are one Undo away',
        'info',
        12_000,
      );
    return { ok: true };
  };
  // (in turn with its batches, and after a gesture under way, or one that never ends)
  const r = await submitJob({
    project: song.id,
    ops: [],
    job: away.job,
    batch: `away:${away.job}:${away.head}`,
    label,
    take,
  });
  if (!r.ok) return 'none';
  setJobRunning(away.job, away.running);
  return 'picked';
}

/**
 * This studio's song without the agent's batches that came here late (`lately`) but that the host
 * saved too: each taken back out, the latest first, with what was changed here since kept. Null when
 * one can't be (it was changed since, the same parts).
 */
function withoutLate(song: Project, batches: readonly { batch: string }[]): Project | null {
  let mine: Project | null = song;
  for (const { batch } of [...batches].reverse()) {
    const late = lately.get(batch);
    if (!late || !mine) continue;
    mine = mergeSongs(late.after, mine, late.before);
  }
  return mine;
}

/**
 * The song was saved somewhere else (`saved` on the live channel) at `revision`. With nothing unsaved
 * here, the agent's changes saved on the host while this studio was away come in as its job's step;
 * still behind after that (someone else saved it: another device, a creation), the song opens as it is
 * now. With changes of its own not saved yet, they're saved now: on top of the agent's, picked up, or
 * asking which version to keep. A save under way hears the same from the host. When the host doesn't
 * answer, the song's one try again (`retryLater`) asks later; notices meanwhile leave it to that.
 */
export async function savedElsewhere(project: string, revision: number): Promise<void> {
  const newer = () => {
    const now = store.get();
    return now.project?.id === project && revision > now.serverRevision;
  };
  if (!newer()) return;
  const state = store.get().saveState;
  if (state === 'saved') {
    if (retry?.project === project) return;
    if ((await pickUpAgent()) === 'unknown') {
      if (store.get().project?.id === project) retryLater(project, () => void savedElsewhere(project, revision));
      return;
    }
    // (by the revision it's at now, whoever's pick-up that was)
    if (newer() && store.get().saveState === 'saved') await openProject(project);
  } else if (state === 'dirty' || state === 'offline' || state === 'error') await saveNow();
}

/** How long a reload waits before it asks the host again what the agent saved (it didn't answer). */
const BEHIND_RETRIES_MS = [2_000, 5_000];

/**
 * A song opened at a later revision than the history this device kept of it (the page was gone, a
 * phone that let it go): if what was saved since is the agent's, the history comes back with its
 * changes as their job's step on top, whose Undo goes back to the song the history leads to (kept with
 * it, else as the host's history kept that revision); the song is as the host has it with them (later
 * than it opened, if the agent saved again meanwhile). Asked again a couple of times when the host
 * doesn't answer (the history stays on the device till then). Whether it came back. (Exported for its
 * tests: the page's database isn't there in them.)
 */
export async function pickUpBehind(
  project: Project,
  kept: history.History & { revision: number; song?: Project },
  waits: readonly number[] = BEHIND_RETRIES_MS,
): Promise<boolean> {
  const away = await answered(awayChanges(project.id, kept.revision));
  // the job's step on top already holds the song from before the job, and they join it
  const joins = away && away !== LATE && kept.undo.at(-1)?.job === away.job;
  const before =
    !away || away === LATE || joins
      ? project
      : (kept.song ?? (await answered(api.revision(project.id, kept.revision))));
  if (away === LATE || before === LATE) {
    const [wait, ...more] = waits;
    if (wait === undefined) return false;
    await new Promise((done) => window.setTimeout(done, wait));
    return pickUpBehind(project, kept, more);
  }
  if (!away || !before || away.base !== kept.revision || away.song.id !== project.id || away.head < project.revision)
    return false;
  const s = store.get();
  // (edited, or another song opened, meanwhile: what's there stands)
  if (s.project !== project || s.undo.length || s.redo.length) return false;
  const picked = history.pickUp(kept, before, away.song, null, `Agent: ${away.label}`, away.job);
  jobs.remember(away.batches.map((b) => b.batch));
  if (away.head === project.revision) store.set({ undo: picked.undo, redo: picked.redo });
  else {
    savedAs(away.head, away.song);
    store.set({ project: away.song, serverRevision: away.head, undo: picked.undo, redo: picked.redo });
    changed(away.song);
  }
  setJobRunning(away.job, away.running);
  return true;
}

/** Whether a job is still running (its batches merge into its step), as the host says. */
export function setJobRunning(job: string, running: boolean): void {
  store.set((s) => ({ agentJobs: { ...s.agentJobs, [job]: running } }));
}

/** A job's steps, undone or not, take its final name: "Agent: <label>". */
export function relabelJob(job: string, label: string): void {
  store.set(history.relabelJob(store.get(), job, `Agent: ${label}`));
}

/** A job's steps in the song as it is, oldest first: the first one's song is the song from before the job. */
export function jobSteps(job: string): Step[] {
  return history.jobSteps(store.get(), job);
}

/** Before and after under way: how to stop it (the song is put back as it is). */
let comparing: { end: () => void } | null = null;

/** What asks the patch renderer for the note edits of the passes about to play. */
const PASSES = 'passes';

/**
 * Stretches of a song played one after another, then stopped: each its own song (a version of it,
 * its cycle off) or the song as it is (`song` null), from a tick to a tick. Then the song as it is is
 * back, the playhead where the last began. Pressing Stop, another of these starting, or (while a
 * version plays) a change to the song ends it there; the song as it is plays on through edits, as
 * playback does. `ended` is called once it's over, however it ended.
 *
 * The note edits each pass plays in its bars are rendered before the first starts (a version's too,
 * though the song as it is doesn't play them), so an A/B compares the edits from their first note,
 * not the recording until they come: meanwhile the transport says it's waiting, as Play does, and
 * the same button (or Stop) calls it off.
 */
export function playPasses(passes: readonly Pass[], ended?: () => void): { ok: true } | { ok: false; error: string } {
  const s = store.get();
  const last = passes[passes.length - 1];
  if (!s.project) return { ok: false, error: 'No song is open in the studio' };
  if (!last) return { ok: false, error: 'Nothing to play' };
  comparing?.end();
  cancelWaiting();
  if (s.playing) stop();
  const now = s.project;
  const notes = passes.flatMap((p) => engine.patchesWithin(p.song ?? now, p.from, p.to));
  engine.preparePatches(PASSES, notes);
  const waiting = { end: () => cancelWaiting() };
  comparing = waiting;
  whenReady(
    // (the song changed while they came: nothing to wait for, and nothing plays)
    () => (store.get().project === now ? soundsComing() + engine.patchesComing(notes) : 0),
    'play',
    () => {
      if (comparing !== waiting) return;
      comparing = null;
      engine.preparePatches(PASSES, null);
      if (store.get().project !== now) ended?.();
      else playNow(passes, now, last, ended);
    },
    () => {
      if (comparing === waiting) comparing = null;
      engine.preparePatches(PASSES, null);
      ended?.();
    },
  );
  return { ok: true };
}

/** The passes played, once what they play is in (playPasses). */
function playNow(passes: readonly Pass[], now: Project, last: Pass, ended?: () => void): void {
  let timer = 0;
  const end = () => {
    window.clearInterval(timer);
    if (comparing?.end !== end) return;
    comparing = null;
    engine.stop();
    store.set({ playing: false });
    // the audio thread plays the song as it is again
    const back = store.get().project;
    if (back) engine.sync(back);
    engine.locate(last.from);
    store.set({});
    ended?.();
  };
  const pass = (i: number) => {
    const p = passes[i];
    if (!p) return end();
    if (p.song) engine.sync(p.song);
    engine.locate(p.from);
    engine.play(p.from);
    store.set({ playing: true });
    window.clearInterval(timer);
    timer = window.setInterval(() => {
      const cur = store.get();
      // stopped, or the song changed under a version: it ends here
      if (!cur.playing || (p.song && cur.project !== now)) return end();
      if (engine.positionTick() >= p.to) pass(i + 1);
    }, 30);
  };
  comparing = { end };
  pass(0);
}

/** Whether playPasses is playing now (or waiting for what it will play). */
export const passesPlaying = (): boolean => comparing !== null;

/** Stop what playPasses is playing, if it is. */
export function stopPasses(): void {
  comparing?.end();
}

/**
 * Before and after (the agent's A/B): bars `from` up to `to` as they were before the job, then the same
 * bars as they are now; then the song is back as it is, the playhead where they began. Pressing Stop,
 * or changing the song, ends it. Says why not when the song from before is gone from the undo
 * history.
 */
export function compareJob(job: string, from: number, to: number): { ok: true } | { ok: false; error: string } {
  const s = store.get();
  if (!s.project) return { ok: false, error: 'No song is open in the studio' };
  const plan = comparePlan(jobSteps(job), s.project, from, to);
  if ('error' in plan) return { ok: false, error: plan.error };
  return playPasses([plan.before, plan.after]);
}

/**
 * The song replaced by another of its versions (a reply's Keep), as one undo step: the version's
 * music and mix, under the song's own id, revision and origin.
 */
export function replaceSong(version: Project, label: string): Project | null {
  const s = store.get();
  const cur = s.project;
  if (!cur) return null;
  let next: Project;
  try {
    next = parseProject({
      ...version,
      id: cur.id,
      revision: cur.revision,
      created: cur.created,
      modified: cur.modified,
      origin: cur.origin,
    });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
    return null;
  }
  store.set({ project: next, ...history.push(s, { project: cur, label, at: Date.now() }), saveState: 'dirty' });
  changed(next);
  userStep(label);
  return next;
}

// ---- saving ----

let saveTimer = 0;
let saving = false;
let saveAgain = false;

export function scheduleSave(delay = 700): void {
  window.clearTimeout(saveTimer);
  saveTimer = window.setTimeout(() => void saveNow(), delay);
}

/**
 * Save soon, with whatever else arrives meanwhile in the one save (the AI's changes come in bursts).
 * Resolves with the revision the song as it is now was saved under (or null if it couldn't be).
 */
export function saveSoon(delay = 150): Promise<number | null> {
  const s = store.get();
  if (!s.project) return Promise.resolve(null);
  if (s.saveState === 'saved' || s.saveState === 'conflict') return Promise.resolve(s.serverRevision);
  if (!awaited) {
    let resolve: (revision: number | null) => void = () => undefined;
    const promise = new Promise<number | null>((r) => {
      resolve = r;
    });
    awaited = { promise, resolve };
  }
  scheduleSave(delay);
  return awaited.promise;
}
/** Those waiting for the next save that takes in the song as it is now. */
let awaited: { promise: Promise<number | null>; resolve: (revision: number | null) => void } | null = null;

function settle(revision: number | null): void {
  const done = awaited;
  awaited = null;
  done?.resolve(revision);
}

/** The save on its way to the host, if one is: its song, and the revision it gets (null: none). */
let inFlight: { project: Project; revision: Promise<number | null> } | null = null;

/** Save now. Resolves with the saved revision (or null if it couldn't). */
export async function saveNow(): Promise<number | null> {
  const s = store.get();
  const project = s.project;
  if (!project) return null;
  if (saving) {
    saveAgain = true;
    return null;
  }
  if (s.saveState === 'saved' || s.saveState === 'conflict') {
    settle(s.serverRevision);
    return s.serverRevision;
  }
  saving = true;
  store.set({ saveState: 'saving' });
  const sending = api.save(project, s.serverRevision);
  inFlight = {
    project,
    revision: sending.then(
      (r) => r.revision,
      () => null,
    ),
  };
  try {
    const r = await sending;
    const now = store.get();
    // the host answered: the live channel needn't wait for its next retry
    if (now.connection === 'offline') reconnectSoon();
    if (now.project?.id !== project.id) {
      // another song was opened meanwhile: the answer is this song's, not the open one's (what's left
      // of this one is saved on top of it, by saveLeft)
      settle(null);
      return r.revision;
    }
    savedAs(r.revision, project);
    store.set({ serverRevision: r.revision, saveState: now.project === project ? 'saved' : 'dirty' });
    // (changed meanwhile: those waiting get the save that takes the change in)
    if (now.project !== project) scheduleSave(200);
    else settle(r.revision);
    return r.revision;
  } catch (err) {
    // (another song opened meanwhile: this one's changes are kept on the device, and saveLeft tries again)
    if (store.get().project?.id !== project.id) {
      settle(null);
      return null;
    }
    if (err instanceof ApiError && err.status === 409) {
      // the host has this very song: an earlier save of it got there, its answer lost (a phone's page
      // frozen as it went)
      const current = (err.body as { current?: Project } | null)?.current;
      if (current && sameSong(current, project)) {
        const same = store.get().project === project;
        savedAs(current.revision, project);
        store.set({ serverRevision: current.revision, saveState: same ? 'saved' : 'dirty' });
        if (same) settle(current.revision);
        else scheduleSave(200);
        return current.revision;
      }
      // the agent's changes, saved on the host while this studio was away: picked up with this
      // studio's own (here, or by a pick-up under way already), which are saved on top of them; those
      // waiting get that save
      const picked = await pickUpAgent();
      if (picked === 'picked' || store.get().serverRevision !== s.serverRevision) {
        scheduleSave(0);
        return null;
      }
      // the host didn't say in time what the agent saved: this studio's changes stay to be saved, and
      // it's asked again in a while (never which version to keep, while the answer may be the agent's)
      if (picked === 'unknown') {
        store.set({ saveState: 'dirty' });
        scheduleSave(retryIn());
        settle(null);
        return null;
      }
      store.set({ saveState: 'conflict' });
      toast('This song was changed somewhere else. Choose which version to keep.', 'error', 8000);
    } else {
      store.set({ saveState: 'offline' });
      scheduleSave(5000);
    }
    settle(null);
    return null;
  } finally {
    saving = false;
    inFlight = null;
    if (saveAgain) {
      saveAgain = false;
      scheduleSave(100);
    }
  }
}

/** After a conflict: keep this studio's version (it becomes the newest) or take the saved one. */
export async function resolveConflict(keep: 'mine' | 'theirs'): Promise<void> {
  const s = store.get();
  if (!s.project) return;
  const theirs = await api.project(s.project.id);
  if (keep === 'theirs') {
    // (this studio's changes, kept on the device until saved, go too)
    load(theirs, { discard: true });
    return;
  }
  savedAs(theirs.revision, theirs);
  store.set({ serverRevision: theirs.revision, saveState: 'dirty' });
  await saveNow();
}

// ---- opening ----

/** The open song, kept on this device: its undo history, and its changes the host doesn't have yet (kept-history.ts). */
const keeper = new Keeper(typeof window === 'undefined' ? null : browserShelf(), { made: STUDIO_ENGINE });

/**
 * Keep the open song on the device now (its changes the host doesn't have yet, or its history):
 * resolves once it's written, or couldn't be.
 */
export function keepNow(): Promise<void> {
  keeper.changed(keepable());
  return keeper.flush();
}

/** What's kept of the open song: its state, and the song as the host has it at its revision, when known. */
function keepable(): Keepable {
  const s = store.get();
  const { project, serverRevision, saveState, undo, redo } = s;
  return { project, serverRevision, saveState, undo, redo, saved: savedAt(serverRevision), agent: agentAtWork(s) };
}

/**
 * Keep the open song on the device as it changes, and as the page is hidden; then it's saved to the
 * host too, while the page still runs (a phone's browser soon freezes a hidden page), so what the
 * agent changes while it's away lands on the song as it is.
 */
function keepOnDevice(): void {
  store.subscribe(() => keeper.changed(keepable()));
  // (a request of the agent's starting on the song: it's kept as saved even with no history, for the
  // agent's changes while the song isn't open here, or the page is gone, to come back as its step)
  agent.subscribe(() => keeper.changed(keepable()));
  addEventListener('pagehide', () => void keeper.flush());
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'hidden') return;
    void keeper.flush();
    if (LEFT_TO_SAVE.has(store.get().saveState)) void saveNow();
  });
}

/**
 * What this device kept of the song as it opens: changes the host didn't get (a reload, the tab
 * closed, the host away, another song opened before they were saved), which the song opens with and
 * saves; or its history at the revision it opened at (a reload's Undo and Redo, the agent's steps with
 * them), or at an earlier one with the agent's changes saved since as their job's step (pickUpBehind).
 * The agent's batches wait meanwhile (`release` lets them in), so they land on the history as it comes
 * back.
 */
async function bringBack(project: Project, kept: Promise<Restored | null>, release: () => void): Promise<void> {
  try {
    const back = await kept;
    const s = store.get();
    // (edited, or another song opened, meanwhile: what's there stands)
    if (!back || s.project !== project || s.undo.length || s.redo.length) return;
    if (back.kind === 'behind') {
      if (!(await pickUpBehind(project, back))) return;
    } else restoreKept(back);
  } finally {
    release();
  }
  // a job that ended while the page was away: its steps take the name it ended with
  const named = stepJobs(store.get());
  if (named.length) for (const [job, label] of await jobLabels(project.id, named)) relabelJob(job, label);
}

/**
 * The song opens with what was kept of it at its revision: its changes the host didn't get (and the
 * song they were made on, when kept with them), or its history. (Exported for its tests.)
 */
export function restoreKept(back: Exclude<Restored, { kind: 'behind' }>): void {
  const s = store.get();
  if (back.kind === 'unsaved') {
    const song = back.song;
    // (what they were made on, as kept with them: only that song is ever merged against)
    if (back.baseSong) savedAs(back.base, back.baseSong);
    else saved = null;
    store.set({
      project: song,
      serverRevision: back.base,
      undo: back.undo,
      redo: back.redo,
      saveState: 'dirty',
      selectedTrack: song.tracks.some((t) => t.id === s.selectedTrack) ? s.selectedTrack : (song.tracks[0]?.id ?? null),
    });
    changed(song);
    // saved at once: on the revision they were made on, or (changed somewhere else since) asking which to keep
    scheduleSave(0);
    toast('Brought back changes to this song that hadn’t been saved');
  } else store.set({ undo: back.undo, redo: back.redo });
}

/** The save states a song left with changes the host doesn't have can be saved from (not a conflict's). */
const LEFT_TO_SAVE: ReadonlySet<AppState['saveState']> = new Set(['dirty', 'saving', 'offline', 'error']);

/**
 * Another song opened while this one had changes the host didn't have yet (they're kept on the
 * device meanwhile): they're saved now, in the background, on top of a save of it already on its
 * way. Not saved (the host away, the song changed somewhere else), they stay on the device, and come
 * back when the song opens here again.
 */
async function saveLeft(left: AppState, agent: boolean): Promise<void> {
  const { project, undo, redo } = left;
  if (!project) return;
  let base = left.serverRevision;
  const sending = inFlight;
  if (sending && sending.project.id === project.id) {
    const revision = await sending.revision;
    if (revision === null) return;
    base = revision;
    // (what's kept is on top of that save now: all of it, or what came after it, made on the song it saved)
    const all = sending.project === project;
    keeper.changed({
      project,
      serverRevision: base,
      saveState: all ? 'saved' : 'dirty',
      undo,
      redo,
      saved: sending.project,
      agent,
    });
    if (all) return;
  }
  try {
    const r = await api.save(project, base);
    keeper.changed({ project, serverRevision: r.revision, saveState: 'saved', undo, redo, agent });
  } catch {
    // kept on the device: saved when the song opens here again
  }
}

/** The longest another song waits to open while the one being left is saved for its agent. */
const LEAVE_MS = 4000;

/**
 * Before another song opens while this device's request is at work on the open one: the open song is
 * saved first, for at most `LEAVE_MS`. The agent's changes are saved on the host from the moment the
 * song is left, so they land on the song with everything done here so far (its own earlier changes
 * among them), and the song it reads next is whole. What isn't saved in time (the host out of reach)
 * stays on this device and is put together with the agent's when the song opens here again, as when a
 * page goes. (With no request at work on it, nothing waits: the song is saved in the background,
 * `openSong`.)
 */
async function saveBeforeLeaving(): Promise<void> {
  const leaving = store.get().project?.id;
  const end = Date.now() + LEAVE_MS;
  for (;;) {
    const s = store.get();
    if (!leaving || s.project?.id !== leaving || !LEFT_TO_SAVE.has(s.saveState)) return;
    const left = end - Date.now();
    if (left <= 0) return;
    let timer = 0;
    const late = new Promise<null>((done) => {
      timer = window.setTimeout(() => done(null), left);
    });
    const saved = await Promise.race([saveSoon(0), late]);
    window.clearTimeout(timer);
    // (not saved: the host away, or changed somewhere else; it's kept on the device)
    if (saved === null) return;
  }
}

/** A request of this device's is at work on the open song, or on its way to the host. */
function agentBusyHere(): boolean {
  const s = store.get();
  return agentAtWork(s) || (!!s.project && agent.get().sending?.project === s.project.id);
}

/** The songs asked to open, counted: one that another was asked for after, while it waited, doesn't open. */
let opens = 0;

/**
 * Open a song in place of the open one. With a request of this device's at work on the one being
 * left, that one is saved first (`saveBeforeLeaving`), with the agent's changes held meanwhile (they'd
 * make the song unsaved again as fast as it's saved; held, they're answered as not gone in once the
 * other song is open, and the host saves them), and it's kept on this device as saved, even with no
 * history, so what the agent does from here on comes back as its step. Whether it opened (not: another
 * song was asked for meanwhile).
 */
async function openSong(next: Project): Promise<boolean> {
  const mine = ++opens;
  if (next.id === store.get().project?.id || !agentBusyHere()) {
    load(next);
    return true;
  }
  const release = jobs.hold();
  try {
    await saveBeforeLeaving();
    await keepNow();
    if (mine !== opens) return false;
    load(next);
    return true;
  } finally {
    release();
  }
}

/**
 * Open a song as the host has it (`discard`: this device's changes to it that the host doesn't have
 * go, the other version chosen).
 */
export function load(project: Project, { discard = false }: { discard?: boolean } = {}): void {
  const left = store.get();
  // what was kept of the song is read first (the state changing to it would let that go)
  const kept = keeper.open(project, { discard });
  if (left.project && left.project.id !== project.id && LEFT_TO_SAVE.has(left.saveState))
    void saveLeft(left, agentAtWork(left));
  letGo();
  savedAs(project.revision, project);
  store.set({
    project,
    serverRevision: project.revision,
    undo: [],
    redo: [],
    saveState: 'saved',
    selectedTrack: project.tracks[0]?.id ?? null,
    selectedRegions: [],
    selectedNotes: [],
    plugin: null,
  });
  try {
    localStorage.setItem('holo:last', project.id);
  } catch {
    // remembered next time if storage allows
  }
  engine.stop();
  engine.sync(project);
  engine.locate(0);
  loadInstruments(project);
  refreshRouting();
  document.title = `${project.title} · HO[LO] Desk`;
  // changes, then takes recorded for this song, that never reached it (a reload, the tab closed, the
  // host away): back now, the takes placed in the song as it is with the changes
  void bringBack(project, kept, jobs.hold()).finally(sendKeptTakes);
}

export async function openProject(id: string): Promise<void> {
  try {
    if (await openSong(await api.project(id))) store.set({ dialog: null });
  } catch (err) {
    // (a song that's gone has no reply left to read: the bar's dot for it goes)
    if (err instanceof ApiError && err.status === 404) agent.dispatch({ type: 'seen', project: id });
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
}

/**
 * Give a song a new name. The open song's rename is an undo step like any other edit; one that
 * isn't open is loaded, renamed and saved as it stands. Resolves once the new name is saved.
 */
export async function renameSong(id: string, title: string): Promise<boolean> {
  const name = title.trim();
  if (!name) return false;
  try {
    if (store.get().project?.id === id) {
      if (store.get().project?.title === name) return true;
      if (!apply([{ op: 'setProject', patch: { title: name } }], 'Rename Song')) return false;
      await saveNow();
      return true;
    }
    const doc = await api.project(id);
    if (doc.title === name) return true;
    await api.save({ ...doc, title: name }, doc.revision);
    return true;
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
    return false;
  }
}

export async function createProject(title = 'Untitled'): Promise<void> {
  if (await openSong(await api.create(title))) store.set({ dialog: null });
}

export async function importMidiFile(file: File): Promise<void> {
  try {
    // a score (MusicXML, .mxl) or a MIDI file, by its name
    const score = /\.(musicxml|xml|mxl)$/i.test(file.name);
    if (!(await openSong(await (score ? api.importScore(file) : api.importMidi(file))))) return;
    if (score) store.set({ editor: 'piano', noteView: 'score', scoreAll: true });
    store.set({ dialog: null });
    toast(`Imported ${file.name}`);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error');
  }
}

export function exportScore(): void {
  const p = store.get().project;
  if (!p) return;
  void saveNow().then(() => {
    const a = document.createElement('a');
    a.href = `/api/projects/${p.id}/musicxml`;
    a.click();
  });
}

export function exportMidi(): void {
  const p = store.get().project;
  if (!p) return;
  void saveNow().then(() => {
    const a = document.createElement('a');
    a.href = `/api/projects/${p.id}/midi`;
    a.click();
  });
}

/**
 * Keep what's selected in sight as tracks go out of it (View's Inactive tracks off, and a track made
 * inactive here, by the agent or on another device): see selectionInSight.
 */
function keepSelectionInSight(): void {
  const sight = (s: AppState): Sight => ({
    song: s.project?.id ?? null,
    tracks: s.project?.tracks ?? [],
    show: showNow(s),
  });
  let was = sight(store.get());
  let stacks = store.get().project?.stacks;
  store.subscribe(() => {
    let s = store.get();
    const song = s.project?.id ?? null;
    // a song opened: the stacks this device had closed in it are closed again; a stack that's gone
    // from the song is forgotten
    if (song !== was.song || s.project?.stacks !== stacks) {
      stacks = s.project?.stacks;
      const folded =
        song !== was.song ? foldsKept(s.project, song ? foldsOf(song) : []) : foldsKept(s.project, s.foldedStacks);
      if (folded.length !== s.foldedStacks.length || folded.some((id, i) => id !== s.foldedStacks[i])) {
        store.set({ foldedStacks: folded });
        s = store.get();
      }
    }
    if (
      s.project?.tracks === was.tracks &&
      s.show.inactiveTracks === was.show.inactiveTracks &&
      s.foldedStacks === was.show.folded
    )
      return;
    const now = sight(s);
    const next = selectionInSight(was, now, s.selectedTrack, s.selectedRegions);
    was = now;
    if (!next) return;
    if (next.selectedRegions) store.set({ selectedRegions: next.selectedRegions });
    if (next.selectedTrack !== undefined) selectTrack(next.selectedTrack);
  });
}

export async function startup(): Promise<void> {
  keepOnDevice();
  keepSelectionInSight();
  // (a bounce the host was making for this tab before it was reloaded)
  void resumeHostBounce();
  void library.refresh();
  warmEngine();
  void api
    .settings()
    .then((s) => store.set({ middleC: s.middleC }))
    .catch(() => undefined);
  let id: string | null = null;
  try {
    id = new URLSearchParams(location.search).get('project') ?? localStorage.getItem('holo:last');
  } catch {
    id = null;
  }
  const turn = takeLinkedTurn();
  // the last song and the list are asked for together: a song that's gone costs no second round trip
  const last = id ? api.project(id).catch(() => null) : Promise.resolve(null);
  const list = api.projects();
  list.catch(() => undefined);
  const project = await last;
  if (project) {
    load(project);
    goToLinkedBar();
    if (turn?.project === project.id) openAtTurn(project.id, turn.job);
    return;
  }
  try {
    const first = (await list)[0];
    if (first) load(await api.project(first.id));
    else load(await api.create('My First Song'));
  } catch {
    toast('Can’t reach the HO[LO] server. Is it running?', 'error', 10000);
  }
}

/** A link may name a bar (?at=9): the playhead goes there, and the tracks area shows it. */
function goToLinkedBar(): void {
  const p = store.get().project;
  const at = Number(new URLSearchParams(location.search).get('at'));
  if (!p || !(at > 0)) return;
  const tick = barToTick(p.meter, at);
  locate(tick);
  linkedTick = tick;
}

/** A turn's job, as the host names them. */
const JOB_ID = /^agj_[0-9a-f]{12}$/;

/**
 * A link may name a turn of its song's conversation (?project=…&turn=…, a notice's: notify.ts), for
 * the page to open at. It's taken out of the address as it's read, so a reload doesn't open it again.
 */
function takeLinkedTurn(): { project: string; job: string } | null {
  try {
    const url = new URL(location.href);
    const job = url.searchParams.get('turn');
    if (job === null) return null;
    url.searchParams.delete('turn');
    window.history.replaceState(window.history.state, '', url);
    const project = url.searchParams.get('project');
    return project && JOB_ID.test(job) ? { project, job } : null;
  } catch {
    return null;
  }
}

/** Opening the page at a turn, while it waits for the studio to start. */
let waitingToOpen: (() => void) | null = null;

/**
 * The page (the bar, on a desktop) open at a turn of the song, once the studio has started (on a
 * phone, past Start the studio), and only while the song is still the open one.
 */
function openAtTurn(project: string, turn: string | null): void {
  waitingToOpen?.();
  waitingToOpen = null;
  const open = () => {
    if (store.get().project?.id === project) openBar(turn ?? undefined);
  };
  if (store.get().audioReady) {
    open();
    return;
  }
  const off = store.subscribe(() => {
    if (!store.get().audioReady) return;
    off();
    waitingToOpen = null;
    open();
  });
  waitingToOpen = off;
}

/**
 * A notice was tapped (the service worker posts `open-turn` to a studio already open), or a row of the
 * bar's for a request on another song: HO[LO] on that song, with the page open at that reply. A
 * request at work on the song that's left carries on there.
 */
export function openTurn(project: string, turn: string | null): void {
  if (!/^[\w-]{1,64}$/.test(project)) return;
  const at = turn !== null && JOB_ID.test(turn) ? turn : null;
  if (store.get().project?.id === project) {
    openAtTurn(project, at);
    return;
  }
  void openProject(project).then(() => openAtTurn(project, at));
}

/** Where a link asked the views to start (read once by the tracks area). */
export let linkedTick: number | null = null;
export function takeLinkedTick(): number | null {
  const t = linkedTick;
  linkedTick = null;
  return t;
}

// ---- audio ----

let starting: Promise<void> | null = null;

/** Start the audio (browsers only allow it after a click or a key press). */
export function ensureAudio(): Promise<void> {
  if (engine.started) return Promise.resolve();
  if (!starting) {
    starting = (async () => {
      try {
        await startEngine();
        store.set({ audioReady: true });
        await engine.setInput(store.get().inputDevice);
        const p = store.get().project;
        if (p) {
          engine.sync(p);
          loadInstruments(p);
        }
        syncMetronome();
        engine.setLowLatency(store.get().lowLatency);
        if (store.get().outputDevice)
          void engine.setOutput(store.get().outputDevice).catch(() => store.set({ outputDevice: '' }));
        void enableMidi();
      } catch (err) {
        toast(`Audio couldn’t start: ${err instanceof Error ? err.message : String(err)}`, 'error', 8000);
      } finally {
        starting = null;
      }
    })();
  }
  return starting;
}

export async function setLatencyMode(mode: AppStateLatency): Promise<void> {
  store.set({ latencyMode: mode, roundTrip: null });
  companion.setFloor(mode);
  if (engine.ctx) {
    await engine.start(mode);
    syncMetronome();
  }
}
type AppStateLatency = ReturnType<typeof store.get>['latencyMode'];

/** The rate this device's choice asks the engine for (null: the sound device's own). */
const wantedRate = () => chosenRate(store.get().rateChoice, isTouch());

/**
 * The audio started (or started again) as this device plays: at its rate, and on a phone or a tablet
 * with its recordings held as 16-bit, half the memory.
 */
function startEngine(): Promise<void> {
  engine.compactRecordings = isTouch();
  return engine.start(store.get().latencyMode, wantedRate());
}

/** Play at another rate (Settings › Audio): the audio starts again at it, and the song's sounds load at it. */
export async function setRateChoice(choice: RateChoice): Promise<void> {
  store.set({ rateChoice: choice, roundTrip: null });
  // (before the audio starts, or while HO[LO] Engine plays at its device's rate, it waits for the next start)
  if (engine.ctx && !engine.remote) {
    await startEngine();
    syncMetronome();
  }
}

export async function enableMidi(): Promise<void> {
  const status = await midi.enable();
  store.set({ midiStatus: status, midiPorts: midi.ports });
}

// ---- HO[LO] Engine ----

/**
 * Look for HO[LO] Engine on this device. When it has opened its sound device the studio plays
 * through it (and needs no click to start: it isn't the browser's audio); when it goes, the browser's
 * audio and MIDI take over again, as if it had never been there.
 */
export function findCompanion(): void {
  midi.onPorts(() => store.set({ midiPorts: midi.ports }));
  companion.onmidi = (events) => midi.nativeEvents(events);
  // an Engine built with another engine than the studio: said once a connection (the settings offer the matching one)
  let staleSaid = false;
  companion.subscribe(() => {
    const m = companion.snapshot().matches;
    if (m === false && !staleSaid) {
      staleSaid = true;
      toast(
        'HO[LO] Engine on this computer was built with another engine than this studio, so it may play the newest instruments wrong. Settings › Audio has the matching one.',
        'error',
        12000,
      );
    }
    if (m === null) staleSaid = false;
  });
  let ports = companion.snapshot().ports;
  companion.subscribe(() => {
    const snap = companion.snapshot();
    if (snap.ports !== ports) {
      ports = snap.ports;
      midi.setNativePorts(ports);
    }
    const remote = snap.device !== null;
    const rate = snap.device?.rate ?? 0;
    // the browser let go of its audio for it, and it couldn't open the device: the browser plays again
    const released = !remote && !engine.ctx && store.get().audioReady;
    if (!released && remote === engine.remote && (!remote || rate === engine.sampleRate)) return;
    midi.setNative(remote);
    void switchEngine(remote);
  });
  companion.beforeOpen = async () => {
    if (!engine.ctx || engine.remote) return;
    if (store.get().playing) stop();
    await engine.close();
  };
  companion.setFloor(store.get().latencyMode);
  void companion.find(!store.get().shareDevice);
}

async function switchEngine(remote: boolean): Promise<void> {
  if (!remote && !engine.ctx) {
    // it went before the studio had started: nothing plays yet
    void enableMidi();
    return;
  }
  const playing = store.get().playing;
  if (playing) stop();
  starting = null;
  try {
    await startEngine();
    store.set({ audioReady: true });
    syncMetronome();
    engine.setLowLatency(store.get().lowLatency);
    const p = store.get().project;
    if (p) loadInstruments(p);
    refreshRouting();
    await enableMidi();
    toast(
      remote
        ? 'HO[LO] Engine is playing: native sound and MIDI on this device'
        : 'HO[LO] Engine has stopped: the browser plays again',
      'info',
    );
  } catch (err) {
    toast(`Audio couldn’t start: ${err instanceof Error ? err.message : String(err)}`, 'error', 8000);
  }
}

/** HO[LO] Engine shares the sound device (other apps can play too) or has it to itself (the lowest latency). */
export function setShareDevice(on: boolean): void {
  store.set({ shareDevice: on, roundTrip: null });
  companion.setExclusive(!on);
}

/**
 * The song's instruments into the audio thread, the selected and armed tracks' first (they're the
 * ones about to be played). An inactive track's aren't: it isn't heard.
 */
export function loadInstruments(written: Project): void {
  if (!engine.ctx) return;
  const project = performed(written);
  const selected = store.get().selectedTrack;
  // on a phone or tablet, each instrument's samples for the keys the song plays (more come as more
  // are played): a big song's instruments whole are more than its browser allows a page
  const keys = isTouch() ? songKeys(written) : null;
  const keysOf = (pack: string, name: string) => keys?.get(`${pack}/${name}`) ?? undefined;
  for (const t of project.tracks) {
    const first = t.id === selected || t.armed;
    for (const i of [t.instrument, ...t.articulations.map((a) => a.instrument)]) {
      // a Performance instrument's live notes play on its pack's plain sampler
      if (i.type === 'sampler' || i.type === 'performance')
        void library.ensure(i.pack, i.name, first ? 0 : 1, keysOf(i.pack, i.name));
    }
  }
  // the kits plugins play (a Drum Replacer's)
  for (const kit of songKits(project)) {
    const [pack = '', ...rest] = kit.split('/');
    void library.ensure(pack, rest.join('/'), 1);
  }
}

// ---- live routing ----

/**
 * Live MIDI goes to the armed tracks whose input matches; with none armed, to the selected track.
 * Never to an inactive one (it has nothing to play it on).
 */
export function refreshRouting(): void {
  const s = store.get();
  const tracks = (s.project?.tracks ?? []).filter((t) => !t.inactive);
  const route = (t: Track): LiveRoute => ({ num: engine.numOf(t.id), port: t.input.port, channel: t.input.channel });
  const selected = tracks.find((t) => t.id === s.selectedTrack);
  midi.setRoutes({ armed: tracks.filter((t) => t.armed).map(route), selected: selected ? route(selected) : null });
}

// ---- transport ----

export function playheadTick(): number {
  return engine.positionTick();
}

export async function togglePlay(): Promise<void> {
  await ensureAudio();
  if (store.get().playWaiting) cancelWaiting();
  else if (store.get().playing) stop();
  else playWhenLoaded(false);
}

/** How long a wait for the song's sounds goes without one arriving before it plays anyway. */
const STALLED = 20_000;
let waitingOff: (() => void) | null = null;

/** How far past where Play starts its note edits are waited for (s): those after render as it plays. */
const NOTES_AHEAD_S = 8;

/** Where Play starts: the playhead, or the cycle's start when the cycle is on and the playhead is outside it. */
function playStart(p: Project, record: boolean): number {
  const from = Math.max(0, engine.positionTick());
  return p.cycle.on && !record && (from < p.cycle.start || from >= p.cycle.end) ? p.cycle.start : from;
}

/**
 * `go` once what it will play is in (`coming`: how much is still on its way, asked again whenever the
 * song's sounds or its note edits change): at once if it is; else the transport says it's waiting,
 * and Play pressed again (or Stop) calls it off (`off`). A wait that stops moving (a file that never
 * comes) doesn't hold it up for good: it goes anyway, and says so.
 */
function whenReady(coming: () => number, waiting: 'play' | 'record', go: () => void, off?: () => void): void {
  if (!coming()) {
    go();
    return;
  }
  store.set({ playWaiting: waiting });
  let left = coming();
  let stall = window.setTimeout(stalled, STALLED);
  function stalled() {
    finish();
    toast('Some sounds are still loading: they come in as they arrive', 'info', 6000);
    go();
  }
  const check = () => {
    const now = coming();
    if (now === 0) {
      finish();
      go();
    } else if (now !== left) {
      left = now;
      clearTimeout(stall);
      stall = window.setTimeout(stalled, STALLED);
    }
  };
  const offSounds = onSoundsComing(check);
  const offNotes = engine.onPatches(check);
  function finish() {
    clearTimeout(stall);
    offSounds();
    offNotes();
    waitingOff = null;
    store.set({ playWaiting: null });
  }
  waitingOff = () => {
    finish();
    off?.();
  };
}

/**
 * Play (or record) once the song's sounds are in, and the note edits of its first seconds rendered
 * (so a tuned note is heard tuned from the start, not the recording first): at once if they are; else
 * the transport says it's waiting, as `whenReady` does.
 */
function playWhenLoaded(record: boolean): void {
  const notesComing = () => {
    const p = store.get().project;
    if (!p) return 0;
    const from = playStart(p, record);
    const until = secondsToTick(p.tempo, tickToSeconds(p.tempo, from) + NOTES_AHEAD_S);
    return engine.patchesComing(engine.patchesWithin(p, from, until));
  };
  whenReady(
    () => soundsComing() + notesComing(),
    record ? 'record' : 'play',
    () => play(record),
  );
}

/** Play no longer waiting for the song's sounds (pressed again, or Stop). */
function cancelWaiting(): void {
  waitingOff?.();
}

export function play(record: boolean): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  const from = playStart(p, record);
  engine.play(from, record, record ? s.countIn : 0);
  store.set({ playing: true, recording: record });
  if (record) startRecording();
}

export function stop(): void {
  const s = store.get();
  if (s.playWaiting) {
    cancelWaiting();
    return;
  }
  if (!s.playing) {
    // stopped already: back to the beginning, and every note still sounding stops (a latched
    // arpeggio, a key held on a keyboard that came loose, a Drum Replacer's hit)
    engine.panic();
    locate(0);
    return;
  }
  const end = engine.positionTick();
  engine.stop();
  store.set({ playing: false, recording: false });
  if (s.recording) finishRecording();
  engine.locate(Math.max(0, end));
}

export async function toggleRecord(): Promise<void> {
  await ensureAudio();
  const s = store.get();
  if (s.playWaiting) {
    cancelWaiting();
    return;
  }
  if (s.recording) {
    store.set({ recording: false });
    engine.setRecording(false);
    finishRecording();
    return;
  }
  // with nothing armed, a take goes to the selected track: not when that one is switched off
  const selected = s.project?.tracks.find((t) => t.id === s.selectedTrack);
  if (selected?.inactive && !s.project?.tracks.some((t) => t.armed && !t.inactive)) {
    toast(`${selected.name} is inactive: make it active to record on it`, 'info');
    return;
  }
  if (s.playing) {
    // punch in
    store.set({ recording: true });
    engine.setRecording(true);
    startRecording();
    return;
  }
  playWhenLoaded(true);
}

export function locate(tick: number): void {
  // (the song moved under what's being played: a phrase doesn't go across it)
  if (store.get().playing) captured.mark('locate', performance.now());
  engine.locate(Math.max(0, Math.round(tick)));
  store.set({}); // let the position display catch up
}

export function moveBars(bars: number): void {
  const p = store.get().project;
  if (!p) return;
  const now = Math.max(0, engine.positionTick());
  const pos = tickToBarBeat(p.meter, now);
  const target = barToTick(
    p.meter,
    Math.max(1, pos.bar + bars + (bars < 0 && pos.beat + pos.div + pos.tick > 3 ? 1 : 0)),
  );
  locate(target);
}

/** The song's repeats and jumps written out, as they play: one undo step. */
export function unrollRepeats(): void {
  const p = store.get().project;
  if (!p) return;
  const ops = unrollOps(p);
  if (!ops.length) {
    toast('This song has no repeats or jumps to write out');
    return;
  }
  if (apply(ops, 'Unroll Repeats')) toast('The repeats are written out: the song plays the same, straight through');
}

export function toggleCycle(): void {
  const p = store.get().project;
  if (!p) return;
  apply([{ op: 'setProject', patch: { cycle: { ...p.cycle, on: !p.cycle.on } } }], 'Cycle');
}

export function setCycle(start: number, end: number): void {
  if (end <= start) return;
  apply([{ op: 'setProject', patch: { cycle: { on: true, start, end } } }], 'Set Cycle');
}

/** The studio full screen (on the computer you look at while playing), and back. */
export function toggleFullscreen(): void {
  if (document.fullscreenElement) {
    void document.exitFullscreen().catch(() => undefined);
    return;
  }
  void document.documentElement
    .requestFullscreen({ navigationUI: 'hide' })
    .catch(() => toast('This browser won’t go full screen here: try F11', 'info'));
}

export function toggleMetronome(): void {
  store.set({ metronome: !store.get().metronome });
  syncMetronome();
}

/** Tells the engine how the metronome sounds on this device; `audition` plays one click to hear it. */
export function syncMetronome(audition = false): void {
  const s = store.get();
  const level = Number.isFinite(s.metronomeLevel) ? Math.max(0, Math.min(1, s.metronomeLevel)) : 0.6;
  engine.setMetronome(s.metronome, level, isClickSound(s.metronomeSound) ? s.metronomeSound : 'beep', audition);
}

export function setMetronomeSound(sound: ClickSound): void {
  store.set({ metronomeSound: sound });
  syncMetronome(true);
}

/** The metronome's volume (0–1). */
export function setMetronomeLevel(level: number): void {
  store.set({ metronomeLevel: Math.max(0, Math.min(1, level)) });
  syncMetronome();
}

// ---- recording ----

interface Take {
  track: string;
  notes: Note[];
  held: Map<number, Note>;
  cc: Map<string, [number, number][]>;
}

let takes = new Map<string, Take>();
let offRecord: (() => void) | null = null;

/** Notes being recorded right now, for the screen to draw as they're played. */
export function liveTakes(): ReadonlyMap<string, Take> {
  return takes;
}

function startRecording(): void {
  takes = new Map();
  offRecord?.();
  offRecord = midi.onEvent((e) => {
    const s = store.get();
    if (!s.recording || !s.project) return;
    // (in ticks of the song as played: where it repeats, each pass's notes go back where they were played)
    const tick = engine.heardPlayedTick(e.time, e.frame);
    if (tick === null || tick < 0) return;
    const channel = (e.status & 0x0f) + 1;
    const project = s.project;
    const armed = project.tracks.filter(
      (t) =>
        t.armed &&
        !t.inactive &&
        (t.input.port === '*' || t.input.port === e.port) &&
        (t.input.channel === 0 || t.input.channel === channel),
    );
    const targets = armed.length ? armed : project.tracks.filter((t) => t.id === s.selectedTrack && !t.inactive);
    const kind = e.status & 0xf0;
    for (const t of targets) {
      let take = takes.get(t.id);
      if (!take) {
        take = { track: t.id, notes: [], held: new Map(), cc: new Map() };
        takes.set(t.id, take);
      }
      if (kind === 0x90 && e.d2 > 0) {
        const n: Note = { t: Math.round(tick), d: 1, p: e.d1, v: e.d2 };
        take.notes.push(n);
        take.held.set(e.d1, n);
      } else if (kind === 0x80 || kind === 0x90) {
        const n = take.held.get(e.d1);
        if (n) {
          n.d = Math.max(1, Math.round(tick) - n.t);
          take.held.delete(e.d1);
        }
      } else if (kind === 0xb0 || kind === 0xe0 || kind === 0xd0) {
        const lane = kind === 0xb0 ? String(e.d1) : kind === 0xe0 ? 'pb' : 'at';
        const value = kind === 0xb0 ? e.d2 : kind === 0xe0 ? ((e.d2 << 7) | e.d1) - 8192 : e.d1;
        const list = take.cc.get(lane) ?? [];
        list.push([Math.round(tick), value]);
        take.cc.set(lane, list);
      }
    }
  });
}

function finishRecording(): void {
  offRecord?.();
  offRecord = null;
  const s = store.get();
  const p = s.project;
  if (!p) return;
  const end = engine.positionTick() < 0 ? 0 : engine.playedPosition();
  const map = engine.playMap;
  const ops: Op[] = [];
  let count = 0;
  for (const take of takes.values()) {
    for (const n of take.held.values()) n.d = Math.max(1, Math.round(end) - n.t);
    if (!take.notes.length && !take.cc.size) continue;
    // each time through the music it was played over, a region where that music is written; where a
    // later pass goes over the same bars, it plays and the earlier ones are kept, muted (as takes are)
    const regions = takeRegions(p, map, take, 'Recording', () => newId('rgn'));
    for (const region of regions) count += region.notes.length;
    for (const region of regions) ops.push({ op: 'addRegion', track: take.track, region });
  }
  takes = new Map();
  // (what was recorded isn't there for Capture to keep a second time)
  forgetPlayed();
  if (ops.length) {
    apply(ops, 'Record');
    toast(`Recorded ${count} note${count === 1 ? '' : 's'}`);
  }
}

// ---- sections ----

/**
 * A section started at the bar a tick is in: a marker there (the Arrangement lane's blocks run from
 * each marker to the next). Its id, to name it; the one already there, when there is one.
 */
export function addSectionAt(tick: number): string | null {
  const p = store.get().project;
  if (!p) return null;
  const m = meterAt(p.meter, Math.max(0, tick));
  const bar = ticksPerBar(m);
  const at = m.tick + Math.floor((Math.max(0, tick) - m.tick) / bar) * bar;
  const there = p.markers.find((x) => x.tick === at);
  if (there) return there.id;
  const marker = { id: newId('mrk'), tick: at, name: `Section ${p.markers.length + 1}` };
  const markers = [...p.markers, marker].sort((a, b) => a.tick - b.tick);
  return apply([{ op: 'setProject', patch: { markers } }], 'Add Section') ? marker.id : null;
}

/** A section at the playhead's bar, with the Arrangement lane brought in to show it. */
export function addSectionAtPlayhead(): string | null {
  const id = addSectionAt(Math.max(0, engine.positionTick()));
  const s = store.get();
  if (id && !s.show.arrangement) store.set({ show: { ...s.show, arrangement: true } });
  return id;
}

// ---- capture ----

/** Nothing played up to now is Capture's to keep: it was kept, or recorded, or it's another song's. */
export function forgetPlayed(): void {
  captured.mark('floor', performance.now());
  if (store.get().captureReady) store.set({ captureReady: false });
}

/** What was just played as the operations that would keep it (not applied), or why there are none. */
export function planCaptured(): { plan: CapturePlan } | { nothing: string } {
  const s = store.get();
  const p = s.project;
  if (!p) return { nothing: 'No song is open' };
  const phrase = captured.phrase(performance.now());
  if (!phrase) return { nothing: 'Nothing was played to keep' };
  const plan = planCapture(p, phrase, {
    selectedTrack: s.selectedTrack,
    playhead: Math.max(0, engine.positionTick()),
    playedNow: engine.positionTick() < 0 ? 0 : engine.playedPosition(),
    map: engine.playMap,
    id: () => newId('rgn'),
  });
  if (!plan) return { nothing: 'Select an instrument track to keep what you played on' };
  return { plan };
}

/**
 * Capture: what was just played becomes regions, whether or not Record was on, on the tracks that
 * sounded it. One undo step.
 */
export function captureRecent(): void {
  const made = planCaptured();
  if ('nothing' in made) {
    toast(made.nothing, 'info');
    return;
  }
  const { plan } = made;
  if (!apply(plan.ops, 'Capture')) return;
  forgetPlayed();
  const muted = plan.regions.length - plan.regions.filter((n) => n === 'Captured').length;
  toast(
    `Captured ${plan.notes} note${plan.notes === 1 ? '' : 's'} onto ${plan.tracks.join(', ')}${muted ? ` (${muted} earlier pass${muted === 1 ? '' : 'es'} kept, muted)` : ''}`,
  );
}

// ---- audio recording ----

/**
 * How far behind a recording is: the sound you played along to took the output's time to reach you,
 * and your playing took the input's time to come back. Measured on this device when it has been
 * (Settings › Audio), otherwise worked out from what the browser reports.
 */
export function roundTripFrames(sr: number): number {
  const measured = store.get().roundTrip;
  if (measured && measured > 0) return Math.round((measured / 1000) * sr);
  const l = engine.latency();
  const input = engine.inputLatency() ?? 10;
  return Math.round(((l.base + l.output + input) / 1000) * sr) + 128;
}

/** A take's regions into the open song, where it was played (false: its song isn't the one open). */
function placeTake(take: TakePlan, file: AudioFile): boolean {
  const p = store.get().project;
  if (!p || p.id !== take.project) return false;
  const ops: Op[] = [{ op: 'addFile', file }];
  const track = p.tracks.find((t) => t.id === take.track);
  if (track) {
    for (const r of take.regions) {
      const region = newRegion(r.from, r.length, r.name);
      region.audio = { file: file.id, offset: r.offset, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
      ops.push({ op: 'addRegion', track: track.id, region });
    }
  }
  apply(ops, 'Record Audio');
  toast(
    track
      ? `Recorded ${take.name} (${file.seconds.toFixed(1)} s)`
      : `${take.name} is in the song’s files: the track it was recorded on is gone`,
  );
  return true;
}

/** A take as a file for the person to keep (when it couldn't be sent). */
function saveCopy(name: string, wav: Blob): void {
  const url = URL.createObjectURL(wav);
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const takeSender = new TakeSender({
  takes: keptTakes,
  upload: uploadTake,
  place: placeTake,
  say: toast,
  save: saveCopy,
  wait: (ms) => new Promise((done) => window.setTimeout(done, ms)),
});

/** Takes kept on this device for the open song are sent again every so often until none wait. */
let takesTimer = 0;
function sendKeptTakes(): void {
  const id = store.get().project?.id;
  if (!id) return;
  void takeSender.resume(id).then((left) => {
    if (left > 0 && !takesTimer) takesTimer = window.setInterval(sendKeptTakes, 20_000);
    if (left === 0 && takesTimer) {
      window.clearInterval(takesTimer);
      takesTimer = 0;
    }
  });
}
if (typeof window !== 'undefined') window.addEventListener('online', sendKeptTakes);

async function keepTake(take: RecordedTake): Promise<void> {
  const p = store.get().project;
  const track = p?.tracks.find((t) => t.id === take.trackId);
  const first = take.channels[0];
  if (!p || !track || !first) return;
  const sr = take.sampleRate;
  const skip = Math.min(roundTripFrames(sr), first.length - 1);
  const n = track.regions.filter((r) => r.audio).length + 1;
  const name = `${track.name} #${String(n).padStart(2, '0')}`;
  // (ticks of the song as played: where it repeats, the take is cut where each pass was played over)
  const start = Math.max(0, Math.round(frameToTick(engine.segments, take.frame)));
  const end = Math.round(frameToTick(engine.segments, take.frame + first.length - skip));
  const plan: TakePlan = {
    project: p.id,
    track: track.id,
    name,
    rate: sr,
    channels: take.channels.length,
    seconds: first.length / sr,
    regions: writtenSpans(engine.playMap, start, Math.max(start + 1, end)).map((span) => ({
      from: span.from,
      length: span.to - span.from,
      name: span.n > 1 ? `${name} (time ${span.n})` : name,
      offset: skip / sr + (tickToFrame(engine.segments, span.at) - take.frame) / sr,
    })),
  };
  // as it was captured (32-bit float, nothing lost); kept on this device before anything is sent
  const wav = new Blob([encodeWav(take.channels, sr, 'float32') as BlobPart], { type: 'audio/wav' });
  if (!(await takeSender.record(plan, wav))) sendKeptTakes();
}

engine.onTake((take) => void keepTake(take));
engine.onError((message) => {
  console.error(`[engine] ${message}`);
  toast(`The audio engine hit a problem: ${message.split('\n')[0]}`, 'error', 8000);
});
engine.onInputError((message) =>
  toast(
    `The audio input couldn’t open: ${message}. Allow the microphone for this site, or choose another input in Settings › Audio.`,
    'error',
    9000,
  ),
);

/** An empty audio track below the selected one. */
export function addAudioTrack(name?: string): string | null {
  const s = store.get();
  const p = s.project;
  if (!p) return null;
  const color = TRACK_COLORS[p.tracks.length % TRACK_COLORS.length];
  const count = p.tracks.filter((t) => t.kind === 'audio').length + 1;
  const track = newAudioTrack(name ?? `Audio ${count}`, color);
  const index = s.selectedTrack ? p.tracks.findIndex((t) => t.id === s.selectedTrack) + 1 : p.tracks.length;
  apply([{ op: 'addTrack', track, index }], 'New Audio Track');
  selectTrack(track.id);
  return track.id;
}

const AUDIO_FILE = /\.(wav|flac|mp3|ogg|oga|m4a|aac|aif|aiff)$/i;
export const isAudioFile = (f: File) => AUDIO_FILE.test(f.name) || f.type.startsWith('audio/');

/**
 * Audio files into the song (dropped or chosen): each becomes a region at the tick, the first on the
 * audio track it was dropped on (if it was), the rest on new audio tracks.
 */
export async function importAudio(files: File[], trackId?: string | null, tick?: number): Promise<void> {
  const list = files.filter(isAudioFile);
  if (!list.length) {
    if (files.length) toast('Those aren’t audio files (WAV, FLAC, MP3, Ogg, AIFF or M4A)', 'error');
    return;
  }
  const ctx = engine.ctx ?? new OfflineAudioContext(1, 1, 48000);
  const at = Math.max(0, Math.round(tick ?? engine.positionTick()));
  let target = trackId
    ? store.get().project?.tracks.find((t) => t.id === trackId && t.kind === 'audio')?.id
    : undefined;
  for (const f of list) {
    const p = store.get().project;
    if (!p) return;
    store.set({ bouncing: `Importing ${f.name}…` });
    try {
      const file = await audioFiles.upload(p.id, f, f.name, ctx);
      const name = f.name.replace(/\.[^.]+$/, '');
      const id = target ?? addAudioTrack(name);
      if (!id) return;
      const startSec = tickToSeconds(p.tempo, at);
      const end = Math.round(secondsToTick(p.tempo, startSec + file.seconds));
      const region = newRegion(at, Math.max(1, end - at), name);
      region.audio = { file: file.id, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
      apply(
        [
          { op: 'addFile', file },
          { op: 'addRegion', track: id, region },
        ],
        'Import Audio',
      );
      store.set({ selectedRegions: [region.id], selectedTrack: id });
      target = undefined;
    } catch (err) {
      toast(`${f.name}: ${err instanceof Error ? err.message : String(err)}`, 'error', 8000);
    } finally {
      store.set({ bouncing: null });
    }
  }
}

/** An audio region's gain set so its loudest peak reaches −1 dB. */
export function normalizeRegion(trackId: string, regionId: string): void {
  const p = store.get().project;
  const region = p?.tracks.find((t) => t.id === trackId)?.regions.find((r) => r.id === regionId);
  const clip = region?.audio;
  const peaks = clip ? audioFiles.peaks.get(clip.file) : undefined;
  if (!p || !region || !clip || !peaks) return;
  const seconds = secondsBetween(p, region.start, region.start + region.length) / clip.stretch;
  const perPeak = peaks.rate / peaks.step;
  const i0 = Math.max(0, Math.floor(clip.offset * perPeak));
  const i1 = Math.min(peaks.max.length, Math.ceil((clip.offset + seconds) * perPeak));
  let peak = 0;
  for (let i = i0; i < i1; i++)
    peak = Math.max(peak, Math.abs(peaks.min[i] as number), Math.abs(peaks.max[i] as number));
  if (peak < 1e-6) return;
  const gain = Math.round((-1 - 20 * Math.log10(peak)) * 10) / 10;
  apply([{ op: 'updateRegion', track: trackId, region: regionId, patch: { audio: { ...clip, gain } } }], 'Normalize');
  toast(`${region.name || 'Region'}: ${gain >= 0 ? '+' : ''}${gain.toFixed(1)} dB`);
}

/** Seconds of song between two ticks. */
export function secondsBetween(project: Project, from: number, to: number): number {
  return tickToSeconds(project.tempo, to) - tickToSeconds(project.tempo, from);
}

// ---- tracks ----

export function selectTrack(id: string | null): void {
  store.set({ selectedTrack: id, selectedNotes: [] });
  refreshRouting();
}

/** The track above or below the selected one, as they're shown: one View leaves out is stepped over. */
export function selectTrackBeside(up: boolean): void {
  const s = store.get();
  const next = s.project ? stepShown(s.project.tracks, showNow(s), s.selectedTrack, up) : null;
  if (next) selectTrack(next.id);
}

export function addTrack(instrument: Instrument, name?: string): string | null {
  const s = store.get();
  const p = s.project;
  if (!p) return null;
  const color = TRACK_COLORS[p.tracks.length % TRACK_COLORS.length];
  const track = newTrack(name ?? defaultName(instrument), instrument, color);
  const reverb = p.buses[0];
  if (reverb) track.channel.sends.push({ bus: reverb.id, level: -18, pre: false });
  const index = s.selectedTrack ? p.tracks.findIndex((t) => t.id === s.selectedTrack) + 1 : p.tracks.length;
  apply([{ op: 'addTrack', track, index }], 'New Track');
  selectTrack(track.id);
  return track.id;
}

/**
 * A palette's sound as a new track: its instrument, effects, level and pan, sending to its room (the
 * room's bus made when the song hasn't one). Its packs must be installed first (the Library does it).
 */
export function addSound(sound: PackSound): string | null {
  const s = store.get();
  const p = s.project;
  if (!p) return null;
  const color = TRACK_COLORS[p.tracks.length % TRACK_COLORS.length];
  const index = s.selectedTrack ? p.tracks.findIndex((t) => t.id === s.selectedTrack) + 1 : p.tracks.length;
  const { ops, track } = soundTrack(p, sound, { ...(color ? { color } : {}), index });
  apply(ops, 'New Track');
  selectTrack(track.id);
  return track.id;
}

/**
 * A Drum Replacer's hits, heard in its track's recordings as the track plays them (each region at its
 * gain, the later of overlapping regions on top), as notes of its piece on a new track that plays its
 * kit: the drum part to play on any kit from here on.
 */
export async function hitsToMidi(trackId: string, pluginId: string): Promise<void> {
  const p = store.get().project;
  const t = p?.tracks.find((x) => x.id === trackId);
  const plugin = t?.channel.inserts.find((x) => x.id === pluginId);
  if (!p || !t || !plugin || t.kind !== 'audio') return;
  await ensureAudio();
  const ctx = engine.ctx;
  if (!ctx) return;
  const sr = ctx.sampleRate;
  const segments = compileTempo(p, sr);
  const audioOf = new Map(t.regions.flatMap((r) => (r.audio ? [[clipKey(r.audio), r.audio] as const] : [])));
  const loaded = new Map<string, Float32Array[]>();
  const frames: { frame: number; velocity: number }[] = [];
  try {
    // (the recordings as they were: hits are found in what was played, edits or not)
    for (const clip of compileClips(t, segments, sr, () => false)) {
      const audio = audioOf.get(clip.key);
      if (!audio) continue;
      let channels = loaded.get(clip.key);
      if (!channels) {
        channels = await audioFiles.load(p.id, audio, ctx);
        loaded.set(clip.key, channels);
      }
      // the stretch of it this piece plays, at its gain
      const from = Math.max(0, clip.source);
      const to = Math.min(channels[0]?.length ?? 0, clip.source + (clip.end - clip.start));
      if (to <= from) continue;
      const played = channels.map((c) => c.slice(from, to).map((v) => v * clip.gain));
      for (const h of detectHits(played, sr, plugin.params))
        frames.push({ frame: clip.start + (from - clip.source) + h.frame, velocity: h.velocity });
    }
  } catch (err) {
    toast(`The recording couldn’t be read: ${err instanceof Error ? err.message : String(err)}`, 'error');
    return;
  }
  if (!frames.length) {
    toast('No hits heard: lower the Threshold or raise the Sensitivity, then try again', 'info');
    return;
  }
  const key = DRUM_PIECES[Math.round(paramValue('replacer', plugin.params, 'piece'))]?.key ?? 36;
  const kit = kitSource(plugin.settings?.kit);
  let instrument: Instrument = { type: 'synth', preset: 'Drum Synth' };
  if (kit.kind === 'synth') instrument = { type: 'synth', preset: kit.preset };
  else {
    const [pack = '', ...rest] = kit.key.split('/');
    instrument = { type: 'sampler', pack, name: rest.join('/') };
  }
  const audible = t.regions.filter((r) => r.audio && !r.muted);
  const start = Math.min(...audible.map((r) => r.start));
  const end = Math.max(...audible.map((r) => r.start + r.length));
  const region = newRegion(start, end - start, `${t.name} hits`);
  region.notes = frames.map((h) => ({
    t: Math.max(0, Math.round(frameToTick(segments, h.frame)) - start),
    d: PPQ / 4,
    p: key,
    v: h.velocity,
  }));
  const track = newTrack(`${t.name} Hits`, instrument, t.color);
  track.regions = [region];
  const index = p.tracks.findIndex((x) => x.id === t.id) + 1;
  apply([{ op: 'addTrack', track, index }], 'Hits to MIDI');
  toast(`${frames.length} hits on ${track.name}`, 'info');
}

export function defaultName(i: Instrument): string {
  if (i.type === 'sampler' || i.type === 'performance')
    return i.name.replace(/[_-]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
  if (i.type === 'synth') return i.preset;
  if (i.type === 'glass') return i.line ? 'Glass Line' : 'Glass';
  return 'Instrument';
}

/** Move a track to a new place in the list (and the mixer): one undo step. */
export function moveTrack(id: string, index: number): void {
  const p = store.get().project;
  const from = p?.tracks.findIndex((t) => t.id === id) ?? -1;
  if (!p || from < 0) return;
  const to = Math.max(0, Math.min(p.tracks.length - 1, index));
  if (to !== from) apply([{ op: 'moveTrack', track: id, index: to }], 'Move Track');
}

/**
 * Move a track to the `index`th place among the tracks shown (a strip dragged there in the Mixer):
 * where View leaves inactive tracks out, or a closed stack's are folded away, that's the place in
 * the song of the track shown there now. It stays in the stack it's in, or out of every stack (the
 * tracks pane is where a track is dragged into one).
 */
export function moveShownTrack(id: string, index: number): void {
  const s = store.get();
  if (s.project) moveTrack(id, songIndex(s.project.tracks, showNow(s), index));
}

/** What this device shows of the song's tracks: View's Inactive tracks, and the stacks closed here. */
export const showNow = (s: AppState = store.get()): Show => ({
  inactiveTracks: s.show.inactiveTracks,
  folded: s.foldedStacks,
});

/** Open or close a stack on this device (its tracks fold away under its header): kept for the song, never an undo step. */
export function foldStack(stack: string, closed: boolean): void {
  const s = store.get();
  if (!s.project || s.foldedStacks.includes(stack) === closed) return;
  const folded = closed ? [...s.foldedStacks, stack] : s.foldedStacks.filter((id) => id !== stack);
  store.set({ foldedStacks: folded });
  keepFolds(s.project.id, folded);
}

/**
 * A row of the tracks pane dragged to the `index`th place among its rows (track-rows.ts): a track
 * moved, into a stack or out of one where it lands so, or a stack moved whole. One undo step. A
 * track that joins a stack with a bus plays through that bus, and one that leaves it goes back to
 * Stereo Out, in the same step: said, as it changes what's heard only by the bus's own fader and effects.
 */
export function dropRow(id: string, index: number): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  const op = planDrop(p, showNow(s), id, index);
  if (!op) return;
  if (op.op !== 'moveTrack' || op.stack === undefined) {
    apply([op], isStackRowId(id) ? 'Move Stack' : 'Move Track');
    return;
  }
  const track = p.tracks.find((t) => t.id === op.track);
  const was = p.stacks?.find((x) => x.id === track?.stack);
  const into = op.stack === null ? undefined : p.stacks?.find((x) => x.id === op.stack);
  const ops: Op[] = [op];
  let said = '';
  if (track && into?.bus && track.channel.output !== into.bus) {
    ops.push({ op: 'updateChannel', target: track.id, patch: { output: into.bus } });
    said = `${track.name} now plays through ${p.buses.find((b) => b.id === into.bus)?.name ?? 'the stack’s bus'}`;
  } else if (track && !into && was?.bus && track.channel.output === was.bus) {
    ops.push({ op: 'updateChannel', target: track.id, patch: { output: 'master' } });
    said = `${track.name} now plays to Stereo Out`;
  }
  if (apply(ops, into ? `Into the stack “${into.name}”` : `Out of the stack “${was?.name ?? ''}”`) && said) toast(said);
}

export function deleteTrack(id: string): void {
  const p = store.get().project;
  if (!p) return;
  const index = p.tracks.findIndex((t) => t.id === id);
  apply([{ op: 'removeTrack', track: id }], 'Delete Track');
  // the track above takes the selection (the nearest one that shows, where View leaves some out)
  const s = store.get();
  const next = s.project ? nearestShown(s.project.tracks, s.show, Math.max(0, index - 1) + 1, true) : null;
  selectTrack(next?.id ?? null);
}

export function setInstrument(trackId: string, instrument: Instrument, rename = false): void {
  const p = store.get().project;
  const t = p?.tracks.find((x) => x.id === trackId);
  if (!t) return;
  const patch: TrackPatch = { instrument };
  if (rename) patch.name = defaultName(instrument);
  apply([{ op: 'updateTrack', track: trackId, patch }], 'Instrument');
  void warnNoteEffects(trackId, instrument);
}

/**
 * A kit (or any instrument that plays each key as its own hit) put on a track whose MIDI effects
 * move or add notes: each hit would play other drums too (a Harmonizer's added note lands on
 * another piece). Said once, with the effects a press away from bypassed.
 */
async function warnNoteEffects(trackId: string, instrument: Instrument): Promise<void> {
  const effects = () =>
    store
      .get()
      .project?.tracks.find((t) => t.id === trackId)
      ?.midiFx.filter((p) => !p.bypass && NOTE_EFFECTS.has(p.type)) ?? [];
  if (!effects().length) return;
  let manifest = null;
  if (instrument.type === 'sampler' || instrument.type === 'performance')
    manifest = await instrumentManifest(instrument.pack, instrument.name).catch(() => null);
  if (!playsHits(instrument, manifest)) return;
  const live = effects();
  const t = store.get().project?.tracks.find((x) => x.id === trackId);
  // the instrument may have changed again while its map came
  if (!live.length || !t || JSON.stringify(t.instrument) !== JSON.stringify(instrument)) return;
  const what = manifest?.title ?? (instrument.type === 'synth' ? instrument.preset : 'This kit');
  const names = live.map((p) => pluginDef(p.type)?.name ?? p.type);
  const list = names.length === 1 ? names[0] : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`;
  toast(
    `${what} plays each note as a drum, and the ${list} on ${t.name} ${names.length === 1 ? 'changes' : 'change'} which notes play: each hit would sound other drums too.`,
    'info',
    12000,
    {
      label: names.length === 1 ? `Bypass ${names[0]}` : 'Bypass them',
      run: () =>
        apply(
          live.map((p) => ({ op: 'updatePlugin', target: trackId, plugin: p.id, patch: { bypass: true } })),
          'Bypass MIDI Effects',
        ),
    },
  );
}

export function updateTrack(trackId: string, patch: TrackPatch, label = 'Track'): void {
  apply([{ op: 'updateTrack', track: trackId, patch }], label);
}

/**
 * Switch a track off (Make Inactive) or on again: one undo step. Off, it's kept and stays editable
 * but nothing plays, loads or records for it, so it's disarmed and stops monitoring its input too.
 */
export function setTrackActive(trackId: string, active: boolean): void {
  const t = store.get().project?.tracks.find((x) => x.id === trackId);
  if (!t || active === !t.inactive) return;
  if (active) {
    updateTrack(trackId, { inactive: false }, 'Make Active');
    return;
  }
  const patch: TrackPatch = { inactive: true, armed: false };
  if (t.audioInput?.monitor) patch.audioInput = { ...t.audioInput, monitor: false };
  updateTrack(trackId, patch, 'Make Inactive');
}

export function updateChannel(target: string, patch: ChannelPatch, label = 'Mixer'): void {
  apply([{ op: 'updateChannel', target, patch }], label);
}

/**
 * Mixer moves while dragging: applied live, one undo step per gesture. A gesture holds the agent's
 * changes back until it ends (`release`), so they don't land in the middle of its step.
 */
let gesture: { label: string; before: Project; last?: Project; release: () => void } | null = null;
export function beginGesture(label: string): void {
  const p = store.get().project;
  if (!p) return;
  // (one that never ended, as a remote's whose connection went, holds them no longer)
  const old = gesture;
  gesture = { label, before: p, release: jobs.hold() };
  old?.release();
}
export function gestureChange(ops: Op[]): void {
  const s = store.get();
  if (!s.project) return;
  try {
    const next = applyOps(s.project, ops);
    if (gesture) gesture.last = next;
    store.set({ project: next, saveState: 'dirty' });
    // (the pointer moves far more often than frames are drawn: the audio thread follows once a frame)
    engine.syncSoon(next);
  } catch {
    // ignore a change that no longer applies mid-drag
  }
}
export function endGesture(): void {
  const s = store.get();
  const g = gesture;
  gesture = null;
  if (g && s.project && g.before !== s.project) {
    store.set(history.push(s, { project: g.before, label: g.label, at: Date.now() }));
    changed(s.project);
    userStep(g.label);
  }
  // the agent's changes that waited go in now, after the gesture's step
  g?.release();
}
/**
 * Calls a gesture off (Escape): the song goes back to how it was, with no undo step. Where something
 * else changed the song meanwhile, that stays: the gesture ends as usual.
 */
export function cancelGesture(): void {
  const s = store.get();
  if (!gesture?.last || s.project !== gesture.last) {
    endGesture();
    return;
  }
  const { before, release } = gesture;
  gesture = null;
  // (a save while it was under way may have taken its changes to the host: the song as it was goes too)
  store.set({ project: before, saveState: 'dirty' });
  changed(before);
  release();
}

export function addPlugin(target: string, type: string, slot: 'inserts' | 'midiFx'): void {
  const plugin = newPlugin(type);
  apply([{ op: 'addPlugin', target, slot, plugin }], 'Add Plugin');
  store.set({ plugin: { target, id: plugin.id } });
}

export function addBus(name = 'Bus'): string | null {
  const bus = newBus(name);
  return apply([{ op: 'addBus', bus }], 'New Bus') ? bus.id : null;
}

/** A new bus with a send to it from a channel, as one undo step (undone, the bus goes with the send). */
export function addBusWithSend(target: string, name = 'Bus', level = -12): string | null {
  const p = store.get().project;
  const channel =
    target === 'master'
      ? p?.master
      : (p?.tracks.find((t) => t.id === target)?.channel ?? p?.buses.find((b) => b.id === target)?.channel);
  if (!channel) return null;
  const bus = newBus(name);
  const ops: Op[] = [
    { op: 'addBus', bus },
    { op: 'updateChannel', target, patch: { sends: [...channel.sends, { bus: bus.id, level, pre: false }] } },
  ];
  return apply(ops, 'New Bus') ? bus.id : null;
}

// ---- regions ----

export function findRegion(project: Project, regionId: string): { track: Track; region: Region } | null {
  for (const track of project.tracks) {
    const region = track.regions.find((r) => r.id === regionId);
    if (region) return { track, region };
  }
  return null;
}

/** A region covering a bar, on a track, at a tick (Logic: click with the pencil). */
export function createRegionAt(trackId: string, tick: number, bars = 1): Region | null {
  const p = store.get().project;
  if (!p) return null;
  const m = meterAt(p.meter, tick);
  const bar = ticksPerBar(m);
  const start = Math.floor(tick / bar) * bar;
  const region = newRegion(start, bar * bars, '');
  apply([{ op: 'addRegion', track: trackId, region }], 'New Region');
  store.set({ selectedRegions: [region.id], selectedTrack: trackId });
  return region;
}

export function deleteSelection(): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  if (s.selectedNotes.length) {
    deleteNotes(s.selectedNotes);
    return;
  }
  const ops: Op[] = [];
  for (const id of s.selectedRegions) {
    const found = findRegion(p, id);
    if (found) ops.push({ op: 'removeRegion', track: found.track.id, region: id });
  }
  if (ops.length) {
    apply(ops, ops.length > 1 ? 'Delete Regions' : 'Delete Region');
    store.set({ selectedRegions: [] });
  }
}

export function splitAtPlayhead(): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  const at = Math.round(engine.positionTick());
  const ops: Op[] = [];
  const ids = s.selectedRegions.length
    ? s.selectedRegions
    : (p.tracks.find((t) => t.id === s.selectedTrack)?.regions.map((r) => r.id) ?? []);
  for (const id of ids) {
    const found = findRegion(p, id);
    if (!found) continue;
    const { track, region } = found;
    if (at <= region.start || at >= region.start + region.length) continue;
    // as the session splits one: score marks and a recording's notes go to the half that plays them
    const [left, right] = splitRegionAt(p, region, at, newId('rgn'));
    ops.push(
      { op: 'removeRegion', track: track.id, region: region.id },
      { op: 'addRegion', track: track.id, region: left },
      { op: 'addRegion', track: track.id, region: right },
    );
  }
  if (ops.length) apply(ops, 'Split');
}

export function repeatRegions(): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  const ops: Op[] = [];
  const newIds: string[] = [];
  for (const id of s.selectedRegions) {
    const found = findRegion(p, id);
    if (!found) continue;
    const copy = {
      ...structuredClone(found.region),
      id: newId('rgn'),
      start: found.region.start + found.region.length,
    };
    newIds.push(copy.id);
    ops.push({ op: 'addRegion', track: found.track.id, region: copy });
  }
  if (ops.length) {
    apply(ops, 'Repeat');
    store.set({ selectedRegions: newIds });
  }
}

// ---- notes ----

/** Where a note lives: its track and region, found by object identity. */
export function locateNote(project: Project, note: Note): { track: Track; region: Region } | null {
  for (const track of project.tracks)
    for (const region of track.regions) if (region.notes.includes(note)) return { track, region };
  return null;
}

export function deleteNotes(notes: readonly Note[]): void {
  const p = store.get().project;
  if (!p) return;
  const doomed = new Set(notes);
  const ops: Op[] = [];
  for (const track of p.tracks) {
    for (const region of track.regions) {
      if (!region.notes.some((n) => doomed.has(n))) continue;
      ops.push({
        op: 'setNotes',
        track: track.id,
        region: region.id,
        notes: region.notes.filter((n) => !doomed.has(n)),
      });
    }
  }
  if (ops.length) {
    apply(ops, notes.length > 1 ? 'Delete Notes' : 'Delete Note');
    store.set({ selectedNotes: [] });
  }
}

/** Replace some notes with changed copies (moved, stretched, re-velocitied), keeping them selected. */
export function replaceNotes(changes: Map<Note, Note>, label: string, keepSelected = true): void {
  const p = store.get().project;
  if (!p || !changes.size) return;
  const ops: Op[] = [];
  for (const track of p.tracks) {
    for (const region of track.regions) {
      if (!region.notes.some((n) => changes.has(n))) continue;
      ops.push({
        op: 'setNotes',
        track: track.id,
        region: region.id,
        notes: region.notes.map((n) => changes.get(n) ?? n),
      });
    }
  }
  if (apply(ops, label) && keepSelected) store.set({ selectedNotes: [...changes.values()] });
}

/** The notes an edit of "the selection" acts on: the selected notes, else the selected regions', else the selected track's. */
function notesInPlay(s: AppState, p: Project): Note[] {
  if (s.selectedNotes.length) return s.selectedNotes;
  const regions = s.selectedRegions.length
    ? s.selectedRegions.map((id) => findRegion(p, id)?.region).filter((r): r is Region => !!r)
    : (p.tracks.find((t) => t.id === s.selectedTrack)?.regions ?? []);
  return regions.flatMap((r) => r.notes);
}

/**
 * Move into key: the notes outside the song's key (the one in force where each starts) go to its
 * nearest note. One undo step; the notes already in it stay.
 */
export function moveIntoKey(): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  if (!scaleAt(p, 0) && !(p.keys?.length ?? 0)) {
    toast('This song has no key yet: set one in the control bar’s KEY display');
    return;
  }
  const picked = new Set(notesInPlay(s, p));
  const changes = new Map<Note, Note>();
  for (const track of p.tracks) {
    for (const region of track.regions) {
      if (region.audio || !region.notes.some((n) => picked.has(n))) continue;
      const moved = notesIntoKey(p, region, picked);
      if (!moved) continue;
      region.notes.forEach((n, i) => {
        const to = moved.notes[i] as Note;
        if (to !== n) changes.set(n, to);
      });
    }
  }
  if (!changes.size) {
    toast(picked.size ? 'Every one of those notes is in the key already' : 'No notes there to move');
    return;
  }
  replaceNotes(changes, 'Move into Key', s.selectedNotes.length > 0);
  toast(`Moved ${changes.size} note${changes.size === 1 ? '' : 's'} into the key`);
}

export function quantizeSelection(): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  const grid = DIVISIONS[s.grid] ?? PPQ / 4;
  const notes = notesInPlay(s, p);
  // (this device's strength and swing: Quantize's own panel sets them. A grid that doesn't swing never does)
  const strength = Math.max(0, Math.min(100, s.quantStrength)) / 100;
  const swing = swings(grid) ? Math.max(0, s.quantSwing) / 100 : 0;
  const changes = new Map<Note, Note>();
  for (const n of notes) {
    const where = locateNote(p, n);
    if (!where) continue;
    const abs = where.region.start + n.t;
    // straight, to the song's grid as ever; swung, its steps are counted from the note's bar line
    const to = swing > 0 ? swungAt(p.meter, abs, grid, strength, swing) : quantize(abs, grid, strength);
    changes.set(n, { ...n, t: to - where.region.start });
  }
  replaceNotes(changes, 'Quantize', s.selectedNotes.length > 0);
}

export function transposeSelection(semitones: number): void {
  const s = store.get();
  const notes = s.selectedNotes;
  if (!notes.length) return;
  const p = s.project;
  // with Snap to key on, a step up or down is a step of the key (an octave is an octave either way)
  const inKey = s.rollSnap && p && Math.abs(semitones) < 12;
  replaceNotes(
    new Map(
      notes.map((n) => {
        const where = inKey ? locateNote(p, n) : null;
        const scale = where ? scaleAt(p as Project, Math.max(0, where.region.start + n.t)) : null;
        const to = scale ? stepInKey(scale, n.p, semitones) : Math.max(0, Math.min(127, n.p + semitones));
        return [n, { ...n, p: to }];
      }),
    ),
    'Transpose',
  );
}

export function selectAll(): void {
  const s = store.get();
  const p = s.project;
  if (!p) return;
  if (s.editor === 'piano' && s.selectedTrack) {
    const t = p.tracks.find((x) => x.id === s.selectedTrack);
    store.set({ selectedNotes: t?.regions.flatMap((r) => r.notes) ?? [] });
  } else {
    store.set({ selectedRegions: p.tracks.flatMap((t) => t.regions.map((r) => r.id)) });
  }
}

// ---- creations ----

/**
 * The creation renders this song itself (its samples, halls and mastering, with the edits made here),
 * through the creation runner on the host; its render comes back as a soloed audio track.
 */
export async function renderInCreation(): Promise<void> {
  const p = store.get().project;
  if (!p?.origin) return;
  await saveNow();
  try {
    const res = await fetch(`/api/projects/${p.id}/render`, { method: 'POST' });
    const body = (await res.json()) as { ok?: boolean; error?: string; already?: boolean; note?: string };
    if (!res.ok) throw new Error(body.error ?? 'The render could not start');
    store.set({ dialog: null, bouncing: `${p.origin.creation} is rendering ${p.title}…` });
    if (body.note) toast(body.note, undefined, 10000);
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error', 10000);
  }
}

/** A creation's render as the host tells it (`GET /api/renders/:id`). */
interface RenderView {
  state: 'waiting' | 'running' | 'done' | 'failed';
  title: string;
  piece: string;
  error: string | null;
}

/**
 * The creation renders this song for the agent (the bar's "Hear it as …"): what to tell it once the
 * render is back on its track, soloed, or failed. A render that can't start throws, with why (the bar
 * shows it, and the button stays). Its progress shows as a render's always does.
 */
export async function renderForAgent(): Promise<string> {
  const p = store.get().project;
  if (!p?.origin) return 'This song didn’t come from a creation, so there’s none to render it';
  await saveNow();
  const res = await fetch(`/api/projects/${p.id}/render`, { method: 'POST' });
  const started = (await res.json().catch(() => ({}))) as { id?: string; error?: string };
  if (!res.ok || !started.id) throw new Error(started.error ?? 'The render could not start');
  const until = Date.now() + 30 * 60_000;
  while (Date.now() < until) {
    await new Promise((r) => window.setTimeout(r, 2000));
    const job = (await fetch(`/api/renders/${started.id}`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null)) as RenderView | null;
    if (job?.state === 'done')
      return `${job.title} rendered “${p.title}”: it's on the track “${job.title} render” at the top, soloed (unsoloed, the studio's own mix plays)`;
    if (job?.state === 'failed') return `${job.title} couldn’t render ${job.piece}: ${job.error ?? 'it failed'}`;
  }
  return `${p.origin.creation} is still rendering after 30 minutes: its render will come back as a soloed track`;
}

/**
 * Send the song to the creation it came from: whether it went, and what to say of it (null when the
 * song has no creation). `quiet` when the bar asked: the agent's reply says how it went, so no toast
 * says it as well.
 */
export async function sendToCreation(quiet = false): Promise<{ ok: boolean; text: string } | null> {
  const p = store.get().project;
  if (!p?.origin) return null;
  await saveNow();
  try {
    const r = await api.send(p.id);
    const sent = r.edited.length
      ? `Sent to ${p.origin.creation}: ${r.edited.length} edited track${r.edited.length === 1 ? '' : 's'} (${r.path})`
      : `Sent to ${p.origin.creation} (${r.path})`;
    const text = r.note ? `${sent}. ${r.note}` : sent;
    // what its pinned packs did: a pack it can't play yet is worth reading
    const cant = r.packs?.missing.some((m) => m.why !== 'imported') ?? false;
    if (!quiet) toast(text, cant ? 'error' : undefined, r.note ? 12000 : undefined);
    return { ok: true, text };
  } catch (err) {
    const text = err instanceof Error ? err.message : String(err);
    if (!quiet) toast(text, 'error', 8000);
    return { ok: false, text };
  }
}

export async function openPiece(creation: string, piece: string): Promise<void> {
  try {
    if (await openSong(await api.openPiece(creation, piece))) store.set({ dialog: null });
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err), 'error', 8000);
  }
}

// ---- bouncing ----

type Bounced = { file: string; url: string; path: string; seconds: number };
/** How long a bounce rings on after its last tick, seconds. */
export const BOUNCE_TAIL = 3;
/** A bounce is under way (the line that shows it is also a creation's render's, which comes and goes by itself). */
let bounceUnderWay = false;
/** The kept bounce whose line is showing (null: one that was never kept, a bounce made here that didn't reach the host). */
let bouncedId: string | null = null;

const tokenOf = (hello: { agentToken?: string }) => (hello.agentToken ? { token: hello.agentToken } : {});

/** A length as minutes and seconds: 4:07. */
export const bounceClock = (seconds: number): string => {
  const s = Math.max(0, Math.round(seconds));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const bouncedToast = (seconds: number | null, name: string, kept: boolean, stems = false) =>
  toast(
    stems
      ? `Exported “${name}” (a ZIP of 24-bit WAVs, kept with the song)`
      : `Bounced ${seconds === null ? '' : `${bounceClock(seconds)} of `}“${name}” (24-bit WAV${kept ? ', kept with the song' : ''})`,
  );

/**
 * Render the song (or the cycle, when it's on) to a WAV file, keep a copy with the song on the host,
 * and save it on this device when asked. Made in this page, or by the host for a device that asks
 * it to (Settings › Audio: a phone or a tablet, unless told otherwise): the same file either way.
 * When the host can't take it, this page makes it.
 *
 * A computer downloads the file when it's done. A phone or a tablet is shown that it's done, and
 * saves it from there (bounce-save.ts).
 */
export async function bounceSong(download = true): Promise<Bounced | null> {
  const p = store.get().project;
  if (!p) return null;
  if (store.get().bouncing || bounceUnderWay) {
    // (asked for by hand while one is being made: said, where it used to do nothing)
    if (download && bounceUnderWay) toast('A bounce is already under way');
    return null;
  }
  const range = bounceRange(p, projectEnd(p));
  const name = p.cycle.on ? `${p.title} (cycle)` : p.title;
  const way = thisSaveWay();
  bounceUnderWay = true;
  // (the last one's line goes: its file stays with the song)
  if (download) putBounceAway();
  try {
    if (bouncesOnHost(store.get().bounceOn, isTouch())) {
      store.set({ bouncing: 'Asking the host…' });
      const job = await startHostBounce({
        project: p,
        from: range.from,
        to: range.to,
        tail: BOUNCE_TAIL,
        name,
        // (a device the agent knows is told outside HO[LO] when it's done, as it has its notices set)
        ...tokenOf(helloFields()),
      });
      const made = job
        ? await followHostBounce({ ...job, project: p.id, name, download, at: Date.now() }, way)
        : 'lost';
      if (made !== 'lost') return made;
      toast('The host couldn’t take the bounce: this device is making it');
    }
    return await bounceOnDevice(p, range, name, download, way);
  } finally {
    bounceUnderWay = false;
    store.set({ bouncing: null });
  }
}

/** The stretch a song's stems cover: the cycle, or the whole song. */
export type StemsRange = 'cycle' | 'song';

/**
 * Export the song's stems: a 24-bit WAV for each track the mix is made of, in one ZIP, made by the
 * host (always: a device has no way to make them, and a small host is only slower) and kept with
 * the song's bounces. A computer downloads the ZIP when it's done; a phone or a tablet is shown its
 * line, to save it from. Why the host won't start them is said, as there's nothing to fall back to.
 */
export async function exportStems(
  range: StemsRange = store.get().project?.cycle.on ? 'cycle' : 'song',
  download = true,
  /** A file for each track, or for each stack (its tracks together) and each track in none. */
  by: StemsBy = 'tracks',
): Promise<Bounced | null> {
  const p = store.get().project;
  if (!p) return null;
  if (store.get().bouncing || bounceUnderWay) {
    if (download) toast('A bounce is already under way: the stems can be exported when it’s done');
    return null;
  }
  const cycle = range === 'cycle' && p.cycle.end > p.cycle.start;
  const from = cycle ? p.cycle.start : 0;
  const to = cycle ? p.cycle.end : projectEnd(p);
  const name = `${p.title}${cycle ? ' (cycle)' : ''} (stems)`;
  const way = thisSaveWay();
  bounceUnderWay = true;
  if (download) putBounceAway();
  try {
    store.set({ bouncing: 'Asking the host…' });
    const job = await askHostBounce({
      project: p,
      from,
      to,
      tail: BOUNCE_TAIL,
      name,
      stems: by === 'stacks' ? 'stacks' : true,
      ...tokenOf(helloFields()),
    });
    if ('error' in job) {
      toast(`The stems weren’t started: ${job.error}`, 'error', 8000);
      return null;
    }
    const made = await followHostBounce({ ...job, project: p.id, name, download, at: Date.now(), stems: true }, way);
    if (made !== 'lost') return made;
    toast('The host didn’t finish the stems: export them again', 'error', 8000);
    return null;
  } finally {
    bounceUnderWay = false;
    store.set({ bouncing: null });
  }
}

/**
 * A bounce the host is making, followed to its end: its progress shown, and what came of it said.
 * Done, a computer downloads it; a phone or a tablet is shown its line, to save it from. 'lost':
 * the host gave it up untried (or was started again and has no file of it), and this device may
 * make it.
 */
async function followHostBounce(kept: KeptBounce, way: SaveWay): Promise<Bounced | null | 'lost'> {
  const shelf = bounceShelf(way);
  // (kept: a page reloaded, or an app closed and opened, while the host works picks it up again)
  keepBounce(kept, shelf);
  const made = await watchHostBounce(kept.id, {
    onLine: (line) => store.set({ bouncing: `On the host: ${line}` }),
  });
  let done: { file: string; url: string; path: string; seconds: number | null } | null = null;
  if (made.state === 'done') done = made;
  // a host started again forgets its bounces, not their files: one it finished is among the song's
  else if (made.lost && kept.download && kept.project) {
    const found = await findBounce(kept.project, kept.name, kept.started, fetch, kept.stems ? 'zip' : 'wav');
    if (found) done = { ...found, seconds: null };
  }
  if (!done) {
    dropBounce(kept.id, shelf);
    if (made.state === 'failed' && !made.lost) {
      toast(`The ${kept.stems ? 'stems' : 'bounce'} failed on the host: ${made.error}`, 'error', 8000);
      return null;
    }
    return 'lost';
  }
  const result = { file: done.file, url: done.url, path: done.path, seconds: done.seconds ?? 0 };
  if (!kept.download || way === 'auto') {
    dropBounce(kept.id, shelf);
    // (straight from the host to the device's files: the page never holds it)
    if (kept.download) void saveFile(kept.name, done.url);
    bouncedToast(done.seconds, kept.name, true, kept.stems);
    return result;
  }
  markBounced(kept.id, { url: done.url, file: done.file, seconds: done.seconds }, shelf);
  showBounced(kept.id, kept.name, done.seconds, done.url, way);
  return result;
}

/**
 * A finished bounce's line: that it's done, with Save. Where saving is through the share sheet the
 * file is fetched first (`source`: the one a bounce made here has already), and Save waits for it.
 */
function showBounced(
  id: string | null,
  name: string,
  seconds: number | null,
  url: string | null,
  way: SaveWay,
  source: Blob | string | null = url,
): void {
  bouncedId = id;
  const share = way === 'share' && source !== null;
  // (a song's stems are known by their file: a ZIP)
  store.set({ bounced: { name, seconds, url, ready: !share, ...(isStems(url) ? { stems: true } : {}) } });
  if (!share) return;
  holdFile(name, source, () => {
    const now = store.get().bounced;
    if (now && now.name === name && now.url === url) store.set({ bounced: { ...now, ready: true } });
  });
}

/** The finished bounce's line put away, and what was kept of it: its file stays with the song on the host. */
export function putBounceAway(): void {
  letFileGo();
  if (bouncedId) dropBounce(bouncedId, bounceShelf(thisSaveWay()));
  bouncedId = null;
  if (store.get().bounced) store.set({ bounced: null });
}

/** Save the finished bounce on this device (its line's button). The share sheet closed with nothing done leaves the line. */
export async function saveBounce(): Promise<void> {
  const b = store.get().bounced;
  if (!b?.ready) return;
  if (await saveFile(b.name, b.url)) putBounceAway();
}

/**
 * Save one of the song's bounces from their list. A computer, and a phone or a tablet in a browser,
 * download it from the tap. An installed iPhone or iPad app saves through the share sheet, which
 * wants the file beforehand: the bounce becomes the one whose line is showing (the last one's is
 * put away, its file still with the song), and its row, like that line, says when Save can be
 * pressed; pressed again, it opens the sheet.
 */
export async function saveListedBounce(b: ListedBounce): Promise<void> {
  const way = thisSaveWay();
  if (way !== 'share') {
    await saveFile(b.title, b.url);
    return;
  }
  if (store.get().bounced?.url === b.url) {
    await saveBounce();
    return;
  }
  putBounceAway();
  showBounced(null, b.title, b.seconds, b.url, way);
}

/** Delete one of the song's bounces for good (the list asked first). False when the host didn't. */
export async function deleteListedBounce(b: ListedBounce): Promise<boolean> {
  const gone = await removeBounce(b).catch(() => false);
  if (!gone) {
    toast(`“${b.title}” wasn’t deleted: the host couldn’t be reached`, 'error', 6000);
    return false;
  }
  // (its line, if it's the one showing: there's nothing left to save)
  if (store.get().bounced?.url === b.url) putBounceAway();
  return true;
}

/**
 * A bounce this device asked the host for before the page was reloaded or the app closed (a phone
 * lets a page go and brings it back): one still being made is followed again and finished as it
 * would have been; one that was done and not yet saved shows its line again. One the host lost
 * meanwhile is said to be, and asked for again by hand.
 */
export async function resumeHostBounce(): Promise<void> {
  const way = thisSaveWay();
  const shelf = bounceShelf(way);
  const kept = keptBounce(shelf);
  if (!kept) return;
  if (kept.done) {
    // (its file gone from the host since, a song deleted: nothing to save)
    const there = await fetch(kept.done.url, { method: 'HEAD' }).then(
      (res) => res.status !== 404,
      () => true,
    );
    if (!there) dropBounce(kept.id, shelf);
    else if (!bounceUnderWay && !store.get().bounced)
      showBounced(kept.id, kept.name, kept.done.seconds, kept.done.url, way);
    return;
  }
  if (bounceUnderWay) return;
  bounceUnderWay = true;
  try {
    store.set({ bouncing: 'On the host: …' });
    if ((await followHostBounce(kept, way)) === 'lost')
      toast(
        kept.stems
          ? `The host didn’t finish “${kept.name}”: export the stems again`
          : `The host didn’t finish bouncing “${kept.name}”: bounce it again`,
        'error',
        8000,
      );
  } finally {
    bounceUnderWay = false;
    store.set({ bouncing: null });
  }
}

/** A bounce rendered in this page, uploaded to be kept with the song. */
async function bounceOnDevice(
  p: Project,
  range: ReturnType<typeof bounceRange>,
  name: string,
  download: boolean,
  way: SaveWay,
): Promise<Bounced | null> {
  store.set({ bouncing: 'Starting…' });
  try {
    const { wav, seconds } = await bounce(p, {
      ...range,
      tail: BOUNCE_TAIL,
      onProgress: (text) => store.set({ bouncing: text }),
    });
    store.set({ bouncing: 'Saving…' });
    const res = await fetch(`/api/projects/${p.id}/bounces?name=${encodeURIComponent(name)}`, {
      method: 'POST',
      headers: { 'content-type': 'audio/wav' },
      body: wav,
    });
    const saved = res.ok ? ((await res.json()) as { file: string; url: string; path: string }) : null;
    if (download && way !== 'auto') {
      // a phone or a tablet: its line, to save it from (kept, where the host has it, through the app closing)
      const id = saved ? `own_${Date.now().toString(36)}` : null;
      if (saved && id) {
        const at = Date.now();
        keepBounce(
          { id, project: p.id, name, download, at, started: at, done: { url: saved.url, file: saved.file, seconds } },
          bounceShelf(way),
        );
      }
      showBounced(id, name, seconds, saved?.url ?? null, way, wav);
      return saved ? { ...saved, seconds } : null;
    }
    if (download) {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(wav);
      a.download = `${name}.wav`;
      a.click();
      window.setTimeout(() => URL.revokeObjectURL(a.href), 60_000);
    }
    bouncedToast(seconds, name, saved !== null);
    return saved ? { ...saved, seconds } : null;
  } catch (err) {
    toast(`The bounce failed: ${err instanceof Error ? err.message : String(err)}`, 'error', 8000);
    return null;
  }
}

/** How long the song runs, in ticks, plus a few empty bars to write into. */
export function songLength(project: Project): number {
  const m = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
  return projectEnd(project) + ticksPerBar(m) * 8;
}
