/**
 * The tray, on a phone (ui/Tray.tsx): once a reply that has a dock (a few of its view's controls again,
 * @holo/agent/view) has been read on the page, that row waits in the studio, above the transport held
 * upright and at the foot of the column on its side, so its takes can be played and one kept while the
 * studio shows. It stays until it's put away (×, a swipe across it) or the next request. It never shows
 * while a request works or for a reply not read yet: the bar's button's ring and dot are the only signs
 * then. A tablet or a desktop has none: its sheet or bar can stay open beside the studio.
 *
 * Which replies have been read, and which trays were put away, are kept on this device
 * (`holo:agent-tray`: job ids, the latest 20 of each), so a reload doesn't bring one back or lose it.
 */
import { checkDock } from '@holo/agent/view';
import { useSyncExternalStore } from 'react';
import { type AgentState, type Exchange, exchange, type TokenStorage } from './agent.ts';
import { isPhone, type Layout } from './layout.ts';

const TRAY_KEY = 'holo:agent-tray';
/** At most this many of each are kept (the latest). */
const TRAY_MOST = 20;
const JOB_ID = /^agj_[0-9a-f]{12}$/;

/** The replies read here with a dock (their jobs), and the trays put away. */
export interface Kept {
  seen: readonly string[];
  gone: readonly string[];
}

const NONE: Kept = { seen: [], gone: [] };

function storage(): TokenStorage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
}

/** Job ids, checked (what isn't one is left out), the latest kept. */
const jobIds = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && JOB_ID.test(x)).slice(-TRAY_MOST) : [];

/** What's kept, checked. */
export function readKept(s: TokenStorage | null = storage()): Kept {
  try {
    const v = JSON.parse(s?.getItem(TRAY_KEY) ?? 'null') as unknown;
    if (typeof v !== 'object' || v === null || Array.isArray(v)) return NONE;
    const o = v as Record<string, unknown>;
    return { seen: jobIds(o.seen), gone: jobIds(o.gone) };
  } catch {
    return NONE;
  }
}

let kept = readKept();
const listeners = new Set<() => void>();

function keep(next: Kept, s: TokenStorage | null): void {
  kept = next;
  try {
    s?.setItem(TRAY_KEY, JSON.stringify(next));
  } catch {
    // kept until the page goes
  }
  for (const fn of listeners) fn();
}

const added = (list: readonly string[], job: string): string[] =>
  [...list.filter((j) => j !== job), job].slice(-TRAY_MOST);

/** A reply with a dock was shown on the page: its tray may come once the page closes. */
export function markSeen(job: string, s: TokenStorage | null = storage()): void {
  if (!JOB_ID.test(job) || kept.seen.includes(job)) return;
  keep({ ...kept, seen: added(kept.seen, job) }, s);
}

/** A tray put away (×, a swipe): it doesn't come back for that reply. */
export function dismiss(job: string, s: TokenStorage | null = storage()): void {
  if (!JOB_ID.test(job) || kept.gone.includes(job)) return;
  keep({ ...kept, gone: added(kept.gone, job) }, s);
}

/** What's kept, as it is now. */
export const keptNow = (): Kept => kept;

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

export function useKept(): Kept {
  return useSyncExternalStore(subscribe, () => kept);
}

/**
 * The song's exchange the tray shows, or null: its newest, when it has ended (not waiting for a click
 * either) with a dock, has been read and not put away, the page is closed, and the studio is a phone's.
 */
export function trayFor(
  a: AgentState,
  project: string | null,
  read: Kept,
  layout: Layout,
  pageOpen: boolean,
): Exchange | null {
  if (pageOpen || !isPhone(layout)) return null;
  const ex = exchange(a, project);
  if (!ex?.job || ex.working || ex.permission || !ex.view?.dock?.length) return null;
  if (!read.seen.includes(ex.job) || read.gone.includes(ex.job)) return null;
  // (checked again as it's drawn: a dock that doesn't pass would leave an empty tray)
  return checkDock(ex.view.dock, true).ok ? ex : null;
}
