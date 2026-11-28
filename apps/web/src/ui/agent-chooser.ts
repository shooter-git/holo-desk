/**
 * What the agent's page says a song's conversation runs with, and what its chooser offers: one place
 * for the words and the rules, tried on its own in a test.
 *
 *  - The header's line: the harness, its model and effort, and what's left of the account's usage for
 *    that model ("Codex · Gpt-6.1-sol · high · 63% left"), with "This song:" before it when the song has
 *    its own choice. What's left is the tightest limit the model counts against; nothing is said where
 *    nothing is known (a harness that doesn't report it, a limit that has started again since it was
 *    read).
 *  - The chooser ("Continue this conversation with"): the harnesses that are ready as buttons, each with
 *    the model and effort it would run with filled in (the user picks; nothing is judged comparable),
 *    "As in Settings" for following Settings › Agent again, and in a line why the others aren't offered.
 *  - The line where a conversation changed hands ("Continued with Codex, Gpt-6.1-sol at high").
 */
import { groupFor, type LimitGroup, type LimitWindow, usedUp } from '@holo/agent/limits';
import {
  type AgentSettings,
  type AgentState,
  type Choice,
  type Exchange,
  HARNESS_NAME,
  type HarnessId,
  type HarnessInfo,
} from '../app/agent.ts';
import { caution, effortsFor, inUse, modelSaid, runsWith, runsWithText, toChoose } from './harness-row.ts';
import { type Clock, meter, startsAgain } from './harness-usage.ts';

type Told = Pick<AgentState, 'settings' | 'thread' | 'harness'>;

/** What a song's conversation runs with now: its own choice, or what Settings › Agent says. */
export interface RunsNow {
  id: HarnessId;
  /** The harness as the host reports it; null when no runner has it now. */
  info: HarnessInfo | null;
  /** The model and effort given it (each empty: the harness's own). */
  model: string;
  effort: string;
  /** The song's own choice, not Settings'. */
  own: boolean;
}

/**
 * The harness Settings › Agent runs with, as the host decides it for a request: the one named there
 * (`info` null when no runner has it now: a request is refused, it isn't run with another), or, with
 * none named, the one the host picks. Null when there's none.
 */
function hostRuns(s: AgentSettings): { id: HarnessId; info: HarnessInfo | null } | null {
  if (s.harness) return { id: s.harness, info: s.harnesses.find((h) => h.id === s.harness && h.found) ?? null };
  const info = inUse(s.harnesses, null);
  return info ? { id: info.id, info } : null;
}

/** Null until the host's settings are known, and when the host has no harness to run with. */
export function runsNow(a: Told, project: string | null): RunsNow | null {
  if (!a.settings || !project) return null;
  const own = a.thread?.project === project ? a.thread.choice : null;
  if (own) {
    const info = a.settings.harnesses.find((h) => h.id === own.harness && h.found) ?? null;
    return { id: own.harness, info, model: own.model, effort: own.effort, own: true };
  }
  const host = hostRuns(a.settings);
  return host ? { ...host, model: a.settings.model, effort: a.settings.effort, own: false } : null;
}

/** What's left of an account's usage for a model, as the header's line and the chooser say it. */
export interface Left {
  /** Plenty, a fifth or less, or none. */
  level: 'ok' | 'low' | 'out';
  /** "63% left", "5-hour: 8% left", "Used up, resets in 2 h 10 min". */
  text: string;
  /** After the harness's name: "has 63% left this week", "is used up, resets in 2 h 10 min", "has used up this model’s limit". */
  say: string;
}

const WEEK = 10080;
const outNow = (w: LimitWindow, now: number) => w.used >= 1 && (w.resets === undefined || w.resets > now);
const fresh = (w: LimitWindow, now: number) => w.resets === undefined || w.resets > now;

/**
 * What's left for a model, from limits as they were last read: the tightest window of the limits it
 * counts against (those every model shares, and its own group's). `models`: the model chosen, then the
 * one a run uses (what an alias stood for, or the harness's default). Null when it can't be told which
 * limits it counts against, or every one of them has started again since it was read: never guessed.
 */
export function leftOf(
  groups: readonly LimitGroup[],
  models: readonly (string | null | undefined)[],
  c: Clock,
): Left | null {
  const named = models.find((m) => m && groupFor(groups, m)) ?? null;
  const own = groupFor(groups, named);
  const counted = [...new Set([...groups.filter((g) => !g.models?.length), ...(own ? [own] : [])])];
  if (!counted.length) return null;
  const out = usedUp(groups, named, c.now);
  if (out) {
    const when = out.resets === undefined ? '' : `, resets ${startsAgain(out.resets, c)}`;
    // (a limit of this model's alone: the harness still runs with another)
    const all = !!usedUp(groups, null, c.now) || groups.length === 1;
    return {
      level: 'out',
      text: `Used up${when}`,
      say: `${all ? 'is used up' : 'has used up this model’s limit'}${when}`,
    };
  }
  const windows = counted.flatMap((g) => g.windows).filter((w) => fresh(w, c.now));
  const tightest = windows.reduce<LimitWindow | null>((t, w) => (!t || w.used > t.used ? w : t), null);
  if (!tightest) return null;
  const m = meter(tightest, 'left', c);
  if (m.level === 'stale') return null;
  const left = m.text.charAt(0).toLowerCase() + m.text.slice(1);
  const week = tightest.minutes === WEEK;
  return {
    level: m.level,
    text: week ? m.text : `${m.label}: ${m.text}`,
    say: week ? `has ${left} this week` : `has ${left} of its ${m.label.toLowerCase()} limit`,
  };
}

/** A signed-in harness's limits as last read (none for one that's signed out, or doesn't report them). */
const groupsOf = (h: HarnessInfo): readonly LimitGroup[] => (h.signedIn === false ? [] : (h.limits?.groups ?? []));

const HOUR = 3_600_000;

/** How long ago limits were read, once that's an hour or more: "3 h ago", "2 days ago". */
function readAgo(at: number | undefined, now: number): string | null {
  const age = at === undefined ? 0 : now - at;
  if (age < HOUR) return null;
  return age < 48 * HOUR ? `${Math.round(age / HOUR)} h ago` : `${Math.round(age / (24 * HOUR))} days ago`;
}

/**
 * What's left for a harness run with this model and effort. A share read an hour ago or more says so
 * (the account may have been used since, here or elsewhere: Claude Code reports only with a request).
 */
function leftFor(h: HarnessInfo, model: string, effort: string, c: Clock): Left | null {
  const left = leftOf(groupsOf(h), [model, runsWith(h, model, effort).model], c);
  const ago = left && left.level !== 'out' ? readAgo(h.limits?.at, c.now) : null;
  return left && ago ? { ...left, text: `${left.text}, read ${ago}`, say: `${left.say} (read ${ago})` } : left;
}

/** The model and effort a run uses, in the menus' own names: what's chosen, else the harness's default when it says. */
function named(h: HarnessInfo | null, model: string, effort: string): { model: string; effort: string } {
  if (!h) return { model: model ? modelSaid(model) : '', effort };
  const r = runsWith(h, model, effort);
  // (an alias keeps its own name: "Opus", not what it last stood for)
  const name = r.defaultModel ? (r.model ?? '') : model;
  return { model: name ? modelSaid(name) : '', effort: r.effort ?? '' };
}

/** The header's line: what the conversation runs with, then what's left (in the warning colour when `warn`). */
export interface RunsLine {
  text: string;
  usage: { text: string; warn: boolean } | null;
}

/**
 * `last`: the conversation's newest exchange. When it's one this harness and model refused for being
 * out of usage (till a time still ahead, or with no time said), the line says so whatever limits were
 * last read (a harness that reports none, or ones read before it ran out): it's the harness's own
 * word, and what the reply under it says. A harness no runner has now is said to be gone.
 */
export function runsLine(
  r: RunsNow,
  c: Clock,
  last: Pick<Exchange, 'failed' | 'harness' | 'model' | 'stop'> | null = null,
): RunsLine {
  const said = named(r.info, r.model, r.effort);
  const parts = [r.info?.name ?? HARNESS_NAME[r.id], said.model, said.effort].filter(Boolean);
  const left = r.info ? leftFor(r.info, r.model, r.effort, c) : null;
  const stop = last?.failed && last.harness === r.id && last.model === r.model ? last.stop : null;
  const refused = stop?.why === 'usage' && (stop.resets === undefined || stop.resets > c.now) ? stop : null;
  const usage = !r.info
    ? { text: 'not on the host now', warn: true }
    : refused && left?.level !== 'out'
      ? {
          text: `Used up${refused.resets === undefined ? '' : `, resets ${startsAgain(refused.resets, c)}`}`,
          warn: true,
        }
      : left
        ? { text: left.text, warn: left.level !== 'ok' }
        : null;
  return { text: `${r.own ? 'This song: ' : ''}${parts.join(' · ')}`, usage };
}

/**
 * Where a conversation changed hands: the line before a turn that ran with another harness, or another
 * model, than the turn before it. Null between two that ran with the same (or when either isn't known).
 */
export function movedLine(
  before: Pick<Exchange, 'harness' | 'model'>,
  ex: Pick<Exchange, 'harness' | 'model' | 'effort'>,
): string | null {
  if (!before.harness || !ex.harness) return null;
  if (before.harness === ex.harness && before.model === ex.model) return null;
  const model = ex.model ? `, ${modelSaid(ex.model)}` : '';
  return `Continued with ${HARNESS_NAME[ex.harness]}${model}${ex.effort ? ` at ${ex.effort}` : ''}`;
}

// ---- the chooser ----

/** A harness the chooser offers, with what it would run with filled in. */
export interface Offer {
  h: HarnessInfo;
  model: string;
  effort: string;
  /** Its vendor doesn't support it on a consumer plan (Antigravity): it's never picked ahead, and asks first. */
  asks: boolean;
}

export interface Offers {
  ready: Offer[];
  /**
   * Following Settings › Agent again, and what that is ("Claude Code, Opus at high effort"). Under a
   * failed request, only when what it says can carry it on.
   */
  settings: { id: HarnessId; text: string; asks: boolean } | null;
  /** Why the others aren't offered, each a clause: "Cursor is signed out". */
  notes: string[];
  /** What's picked as it opens; null when nothing can be picked ahead. */
  selected: HarnessId | 'settings' | null;
  /** The song has its own choice now. */
  own: boolean;
}

/** The failed exchange the chooser carries on, as far as the offers go. */
type Failed = Pick<Exchange, 'failed' | 'harness' | 'stop'> & Partial<Pick<Exchange, 'model'>>;

/**
 * Out of usage whichever model it's run with: a limit every model shares is used up, or (when every
 * limit is by model, and each model the harness lists counts against one of them) each of them is.
 * `resets`: when it starts again, when the vendor says. Null where that can't be told.
 */
function outForAll(h: HarnessInfo, groups: readonly LimitGroup[], now: number): { resets?: number } | null {
  const shared = usedUp(groups, null, now);
  if (shared) return shared;
  if (!groups.length || groups.some((g) => !g.models?.length)) return null;
  if (!groups.every((g) => g.windows.some((w) => outNow(w, now)))) return null;
  // (a model of its own in none of the groups: which limit it counts against isn't known)
  if (!h.models?.length || !h.models.every((m) => groupFor(groups, m))) return null;
  // (the first of them to start again: from then some model runs)
  const resets = groups.map((g) => {
    const all = g.windows.filter((w) => outNow(w, now)).map((w) => w.resets);
    return all.every((r): r is number => r !== undefined) ? Math.max(...all) : undefined;
  });
  return resets.every((r): r is number => r !== undefined) ? { resets: Math.min(...resets) } : {};
}

/**
 * A model of the harness's whose limits aren't the ones the model that ran out counts against, and
 * aren't used up: the first it lists. Null when its limits don't go by model, or it can't be told
 * which the one that ran out counts against.
 */
function otherModel(h: HarnessInfo, groups: readonly LimitGroup[], ranOut: string, now: number): string | null {
  const own = groupFor(groups, ranOut) ?? groupFor(groups, runsWith(h, ranOut, '').model);
  if (!own?.models?.length) return null;
  const runs = (g: LimitGroup | null) => !!g && g !== own && !g.windows.some((w) => outNow(w, now));
  return (h.models ?? []).find((m) => runs(groupFor(groups, m))) ?? null;
}

/** What a harness would run with on this song, filled in: the song's own, what it last ran with here, Settings', its default. */
function prefill(a: Told, project: string, h: HarnessInfo): { model: string; effort: string } {
  const thread = a.thread?.project === project ? a.thread : null;
  const last = thread?.turns.findLast((t) => t.harness === h.id);
  const host = a.settings && hostRuns(a.settings)?.id === h.id ? a.settings : null;
  const from = (thread?.choice?.harness === h.id ? thread.choice : null) ??
    (last ? { model: last.model ?? '', effort: last.effort ?? '' } : null) ??
    host ?? { model: '', effort: '' };
  // (only what the harness still offers: the rest is its default, or left to choose)
  const model = from.model && h.models?.length && !h.models.includes(from.model) ? '' : from.model;
  const efforts = effortsFor(h, model);
  const effort = from.effort && efforts && !efforts.includes(from.effort) ? '' : from.effort;
  return { model, effort };
}

/**
 * What the chooser offers for a song. `failed`: the exchange it would carry on, when it's opened under
 * one that failed; the harness that failed isn't offered while what stopped it still holds (signed out,
 * gone, or out of usage till a time still ahead, with every model).
 */
export function offers(a: Told, project: string, failed: Failed | null, c: Clock): Offers {
  const listed = a.settings?.harnesses ?? [];
  const thread = a.thread?.project === project ? a.thread : null;
  const stopped = failed?.failed ? failed : null;
  // why the harness that failed can't carry the request on, while that still holds: a limit that has
  // started again, a harness signed in or installed again since, is as any other
  const was = stopped ? listed.find((h) => h.id === stopped.harness && h.found) : undefined;
  const stop = stopped?.stop ?? null;
  const holds =
    stop?.why === 'usage'
      ? stop.resets === undefined || stop.resets > c.now
      : stop?.why === 'signed-out'
        ? was?.signedIn !== true
        : stop?.why === 'not-installed'
          ? !was
          : false;
  const forGood = stopped && stop && holds ? { id: stopped.harness, why: stop.why } : null;
  const ready: Offer[] = [];
  const notes: string[] = [];
  for (const h of listed) {
    if (!h.found) continue;
    const itFailed = forGood?.id === h.id ? forGood.why : undefined;
    // (the reply already says so of the one that failed)
    if (itFailed === 'signed-out' || itFailed === 'not-installed') continue;
    if (h.signedIn === false) {
      notes.push(`${h.name} is signed out`);
      continue;
    }
    if (!h.sealed) continue;
    const under = a.harness[h.id];
    if (under?.state === 'running' && under.kind !== 'refresh') {
      if (under.kind === 'update') notes.push(`${h.name} is being updated`);
      continue;
    }
    const groups = groupsOf(h);
    const out = outForAll(h, groups, c.now);
    if (itFailed === 'usage') {
      // out of usage as it said: offered only where its limits go by model and show another model's
      // still running, with that model filled in
      const other = out ? null : otherModel(h, groups, stopped?.model ?? '', c.now);
      if (other) ready.push({ h, model: other, effort: '', asks: !!caution(h) });
      continue;
    }
    if (out) {
      notes.push(`${h.name} is used up${out.resets === undefined ? '' : `, resets ${startsAgain(out.resets, c)}`}`);
      continue;
    }
    ready.push({ h, ...prefill(a, project, h), asks: !!caution(h) });
  }
  // following Settings again: always there to go back to; to carry a failed request on, only when
  // what it says can run it (not the harness that just ran out, or one that isn't ready)
  const host = a.settings ? hostRuns(a.settings) : null;
  const runsIt = !!host && host.id !== forGood?.id && ready.some((o) => o.h.id === host.id);
  const follows = host && a.settings && (stopped ? runsIt : true) ? host : null;
  const settings =
    follows && a.settings
      ? {
          id: follows.id,
          text: follows.info
            ? `${follows.info.name}, ${runsWithText(follows.info, a.settings.model, a.settings.effort)}`
            : `${HARNESS_NAME[follows.id]}, which isn’t on the host now`,
          asks: !!caution(follows),
        }
      : null;
  const own = thread?.choice ?? null;
  let selected: Offers['selected'] = null;
  if (stopped) {
    // another harness that's ready; else what Settings says; else the one that ran out, with another
    // model. Never one that asks first.
    const other = ready.find((o) => o.h.id !== stopped.harness && !o.asks);
    selected =
      other?.h.id ??
      (settings && !settings.asks ? 'settings' : null) ??
      ready.find((o) => o.h.id === stopped.harness && !o.asks)?.h.id ??
      null;
  } else if (own) selected = ready.some((o) => o.h.id === own.harness) ? own.harness : null;
  else selected = settings ? 'settings' : null;
  return { ready, settings, notes, selected, own: !!own };
}

/**
 * The chooser as it opens on a song whose newest exchange is `failed` (null: none that failed, or not
 * asked from this device). It carries that request on while there's something to carry it on with;
 * where there isn't (its only harness ran out), it's the chooser for the song's next requests, so
 * what the song runs with can still be changed.
 */
export function chooserFor(a: Told, project: string, failed: Failed | null, c: Clock): { o: Offers; carries: boolean } {
  const under = failed?.failed ? offers(a, project, failed, c) : null;
  return under && (under.ready.length || under.settings)
    ? { o: under, carries: true }
    : { o: offers(a, project, null, c), carries: false };
}

/**
 * The harness a pick asks about first (its vendor doesn't support it on a consumer plan), whether it's
 * picked by name or as what Settings says: null for one that doesn't ask, and for one the conversation
 * already runs with.
 */
export function asksFirst(pick: Offer | 'settings' | null, o: Offers, runs: RunsNow | null): HarnessId | null {
  const id = pick === 'settings' ? (o.settings?.asks ? o.settings.id : null) : pick?.asks ? pick.h.id : null;
  return id && runs?.id !== id ? id : null;
}

/**
 * Whether a failed reply offers "Continue with…": another harness is ready to take it, or the one that
 * ran out still has a model to run with. (What a song runs with can be chosen from the header's line at
 * any time; this is only what's worth offering under a failure.)
 */
export function canMove(o: Offers, failed: Failed): boolean {
  if (!failed.failed) return false;
  if (o.ready.some((r) => r.h.id !== failed.harness)) return true;
  return failed.stop?.why === 'usage' && o.ready.some((r) => r.h.id === failed.harness);
}

/** What's left to pick before Continue: a harness, or what one with no defaults needs chosen. Null: nothing. */
export function toPick(picked: Offer | 'settings' | null): string | null {
  if (!picked) return 'Pick a harness';
  if (picked === 'settings') return null;
  const missing = toChoose(picked.h, picked.model, picked.effort);
  return missing ? `Choose ${missing} first` : null;
}

/** The line under the chooser's menus: what's left for what's picked, then why the others aren't offered. */
export function chooserNote(
  picked: Offer | null,
  notes: readonly string[],
  c: Clock,
): { text: string; warn: boolean } | null {
  const left = picked ? leftFor(picked.h, picked.model, picked.effort, c) : null;
  const parts = [...(left && picked ? [`${picked.h.name} ${left.say}`] : []), ...notes];
  return parts.length ? { text: `${parts.join('. ')}.`, warn: left?.level === 'out' } : null;
}

/** The choice a pick stands for: a harness with its model and effort, or null for Settings › Agent's again. */
export function choiceOf(picked: Offer | 'settings'): Choice | null {
  return picked === 'settings' ? null : { harness: picked.h.id, model: picked.model, effort: picked.effort };
}
