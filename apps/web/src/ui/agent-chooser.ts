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
  type AgentState,
  type Choice,
  type Exchange,
  HARNESS_NAME,
  type HarnessId,
  type HarnessInfo,
} from '../app/agent.ts';
import { caution, effortsFor, inUse, runsWith, runsWithText, shown, toChoose } from './harness-row.ts';
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

/** Null until the host's settings are known, and when the host has no harness to run with. */
export function runsNow(a: Told, project: string | null): RunsNow | null {
  if (!a.settings || !project) return null;
  const listed = a.settings.harnesses;
  const own = a.thread?.project === project ? a.thread.choice : null;
  if (own) {
    const info = listed.find((h) => h.id === own.harness && h.found) ?? null;
    return { id: own.harness, info, model: own.model, effort: own.effort, own: true };
  }
  const info = inUse(listed, a.settings.harness);
  return info ? { id: info.id, info, model: a.settings.model, effort: a.settings.effort, own: false } : null;
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

/** What's left for a harness run with this model and effort. */
function leftFor(h: HarnessInfo, model: string, effort: string, c: Clock): Left | null {
  return leftOf(groupsOf(h), [model, runsWith(h, model, effort).model], c);
}

/** The model and effort a run uses, in the menus' own names: what's chosen, else the harness's default when it says. */
function named(h: HarnessInfo | null, model: string, effort: string): { model: string; effort: string } {
  if (!h) return { model: model ? shown(model) : '', effort };
  const r = runsWith(h, model, effort);
  // (an alias keeps its own name: "Opus", not what it last stood for)
  const name = r.defaultModel ? (r.model ?? '') : model;
  return { model: name ? shown(name) : '', effort: r.effort ?? '' };
}

/** The header's line: what the conversation runs with, then what's left (in the warning colour when `warn`). */
export interface RunsLine {
  text: string;
  usage: { text: string; warn: boolean } | null;
}

/**
 * `last`: the conversation's newest exchange. When it's one this harness and model refused for being
 * out of usage, till a time still ahead, the line says so whatever limits were last read (a harness
 * that reports none, or ones read before it ran out): it's the harness's own word.
 */
export function runsLine(
  r: RunsNow,
  c: Clock,
  last: Pick<Exchange, 'failed' | 'harness' | 'model' | 'stop'> | null = null,
): RunsLine {
  const said = named(r.info, r.model, r.effort);
  const parts = [r.info?.name ?? HARNESS_NAME[r.id], said.model, said.effort].filter(Boolean);
  const left = r.info ? leftFor(r.info, r.model, r.effort, c) : null;
  const refused =
    last?.failed && last.stop?.why === 'usage' && last.harness === r.id && last.model === r.model
      ? last.stop.resets
      : undefined;
  const usage =
    refused !== undefined && refused > c.now && left?.level !== 'out'
      ? { text: `Used up, resets ${startsAgain(refused, c)}`, warn: true }
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
  const model = ex.model ? `, ${shown(ex.model)}` : '';
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
  settings: { id: HarnessId; text: string } | null;
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
 * limit is by model) each of them is. `resets`: when it starts again, when the vendor says.
 */
function outForAll(groups: readonly LimitGroup[], now: number): { resets?: number } | null {
  const shared = usedUp(groups, null, now);
  if (shared) return shared;
  if (!groups.length || groups.some((g) => !g.models?.length)) return null;
  if (!groups.every((g) => g.windows.some((w) => outNow(w, now)))) return null;
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
  const host = a.settings && inUse(a.settings.harnesses, a.settings.harness)?.id === h.id ? a.settings : null;
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
 * one that failed; the harness that failed isn't offered where that wouldn't help (signed out, gone, or
 * out of usage with every model).
 */
export function offers(a: Told, project: string, failed: Failed | null, c: Clock): Offers {
  const listed = a.settings?.harnesses ?? [];
  const thread = a.thread?.project === project ? a.thread : null;
  const stopped = failed?.failed ? failed : null;
  const ready: Offer[] = [];
  const notes: string[] = [];
  for (const h of listed) {
    if (!h.found) continue;
    const itFailed = stopped?.harness === h.id ? stopped.stop?.why : undefined;
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
    const out = outForAll(groups, c.now);
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
  const host = a.settings ? inUse(listed, a.settings.harness) : null;
  const forGood = stopped?.stop && stopped.stop.why !== 'interrupted' ? stopped.harness : null;
  const runsIt = !!host && host.id !== forGood && ready.some((o) => o.h.id === host.id);
  const follows = host && a.settings && (stopped ? runsIt : true) ? host : null;
  const settings =
    follows && a.settings
      ? { id: follows.id, text: `${follows.name}, ${runsWithText(follows, a.settings.model, a.settings.effort)}` }
      : null;
  const own = thread?.choice ?? null;
  let selected: Offers['selected'] = null;
  if (stopped) {
    const other = ready.find((o) => o.h.id !== stopped.harness && !o.asks);
    selected =
      other?.h.id ??
      (settings && settings.id !== stopped.harness ? 'settings' : null) ??
      ready.find((o) => o.h.id === stopped.harness)?.h.id ??
      null;
  } else if (own) selected = ready.some((o) => o.h.id === own.harness) ? own.harness : null;
  else selected = settings ? 'settings' : null;
  return { ready, settings, notes, selected, own: !!own };
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
