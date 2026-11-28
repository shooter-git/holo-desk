/**
 * What a harness's account has left, as its vendor reports it, and what a request used: the shapes the
 * runner, the server and the studio share, and the check each applies to what it's handed.
 *
 * A vendor counts in windows (five hours, a week, a billing month), sometimes one set for every model
 * and sometimes one per group of models (Antigravity: its own models, and the others it serves). HO[LO]
 * shows what the vendor says and nothing it would have to work out: a harness that doesn't report its
 * limits (Cursor) has none here. docs/agent-harnesses.md, "Limits and usage", says where each comes from.
 */

/** One window of a limit. */
export interface LimitWindow {
  /** Its length in minutes: 300 is five hours, 10080 a week. */
  minutes: number;
  /** How much of it is used, from 0 to 1. */
  used: number;
  /** When it starts again (ms since 1970), when the vendor says. */
  resets?: number;
}

/** The windows some models share. */
export interface LimitGroup {
  /** The vendor's name for the group ("Gemini Models"); none: every model the harness runs. */
  name?: string;
  /** The models in it, by the vendor's own names for them ("Gemini 4 Neon"). */
  models?: string[];
  windows: LimitWindow[];
}

/** A harness's limits as last read. */
export interface HarnessLimits {
  /** When they were read (ms since 1970). */
  at: number;
  /** Something the vendor says beside them, in a line ("1 early reset available"). */
  note?: string;
  groups: LimitGroup[];
}

/** What reading a harness's limits gives: the limits, and the plan when it's said with them. */
export interface LimitsRead {
  plan?: string;
  note?: string;
  groups: LimitGroup[];
}

/**
 * Why a request couldn't go on, where that's known for sure: the account is out of usage until a
 * limit starts again, the harness is signed out, or it's no longer installed. Trying again as it is
 * wouldn't help with any of them.
 */
export type StopWhy = 'usage' | 'signed-out' | 'not-installed';

export interface FailureKind {
  why: StopWhy;
  /** When the limit that stopped it starts again (ms since 1970), when that's known. */
  resets?: number;
}

/** The tokens one request used. */
export interface RunUsage {
  /** Read by the model, and not from the vendor's cache. */
  input: number;
  /** Read from the vendor's cache (the conversation so far, mostly). */
  cached: number;
  /** Written by the model, its thinking included where the harness counts it. */
  output: number;
}

/** The longest window taken as one: a year. */
const MINUTES_MOST = 366 * 24 * 60;
/** The most tokens believed of one request. */
const TOKENS_MOST = 1e10;

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

const line = (v: unknown, max: number): string | undefined => {
  if (typeof v !== 'string') return undefined;
  // (control characters never: these are shown as they are)
  const text = [...v]
    .map((c) => (c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127 ? ' ' : c))
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
  return text ? text.slice(0, max) : undefined;
};

/** A window as it should be, or null: a length, a share used (held to 0…1), and a reset in this century. */
export function checkWindow(raw: unknown): LimitWindow | null {
  if (!isObject(raw)) return null;
  const { minutes, used, resets } = raw;
  if (typeof minutes !== 'number' || !Number.isFinite(minutes) || minutes < 1 || minutes > MINUTES_MOST) return null;
  if (typeof used !== 'number' || !Number.isFinite(used)) return null;
  const out: LimitWindow = { minutes: Math.round(minutes), used: Math.min(1, Math.max(0, used)) };
  if (typeof resets === 'number' && Number.isFinite(resets) && resets > 9e11 && resets < 5e12)
    out.resets = Math.round(resets);
  return out;
}

/** Groups as they should be: at most 8, each with at most 6 windows (the longest first) and 40 models. */
export function checkGroups(raw: unknown): LimitGroup[] {
  if (!Array.isArray(raw)) return [];
  const out: LimitGroup[] = [];
  for (const g of raw.slice(0, 8)) {
    if (!isObject(g) || !Array.isArray(g.windows)) continue;
    const windows = g.windows
      .slice(0, 12)
      .map(checkWindow)
      .filter((w): w is LimitWindow => w !== null)
      .slice(0, 6)
      .sort((a, b) => b.minutes - a.minutes);
    if (!windows.length) continue;
    const group: LimitGroup = { windows };
    const name = line(g.name, 60);
    if (name) group.name = name;
    if (Array.isArray(g.models)) {
      const models = g.models
        .slice(0, 80)
        .map((m) => line(m, 60))
        .filter((m): m is string => !!m)
        .slice(0, 40);
      if (models.length) group.models = models;
    }
    out.push(group);
  }
  return out;
}

/** Limits as the runner reports them, checked: null when there's nothing in them to show. */
export function checkLimits(raw: unknown): HarnessLimits | null {
  if (!isObject(raw)) return null;
  const at = typeof raw.at === 'number' && Number.isFinite(raw.at) && raw.at > 9e11 && raw.at < 5e12 ? raw.at : null;
  if (at === null) return null;
  const groups = checkGroups(raw.groups);
  const note = line(raw.note, 120);
  if (!groups.length && !note) return null;
  return { at: Math.round(at), ...(note ? { note } : {}), groups };
}

/** What a read gave, checked the same way. */
export function checkRead(raw: unknown): LimitsRead | null {
  if (!isObject(raw)) return null;
  const groups = checkGroups(raw.groups);
  const note = line(raw.note, 120);
  const plan = line(raw.plan, 40);
  if (!groups.length && !note && !plan) return null;
  return { ...(plan ? { plan } : {}), ...(note ? { note } : {}), groups };
}

/** A plan's name as a harness gives it, checked ("max", "Pro+"). */
export const checkPlan = (raw: unknown): string | undefined => line(raw, 40);

const count = (v: unknown): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= TOKENS_MOST ? Math.round(v) : null;

/** A request's usage, checked: whole counts, none negative; null when it isn't one, or counts nothing. */
export function checkUsage(raw: unknown): RunUsage | null {
  if (!isObject(raw)) return null;
  const input = count(raw.input);
  const cached = count(raw.cached);
  const output = count(raw.output);
  if (input === null || cached === null || output === null) return null;
  return input + cached + output > 0 ? { input, cached, output } : null;
}

/** Two requests' usage, as one. */
export function addUsage(a: RunUsage | null, b: RunUsage | null): RunUsage | null {
  if (!a || !b) return a ?? b;
  return { input: a.input + b.input, cached: a.cached + b.cached, output: a.output + b.output };
}

/** A count a harness gave: a whole number from 0 up, else 0. */
export const tokens = (v: unknown): number => count(v) ?? 0;

/** A model's name with only its letters and digits, to tell a harness's id for it from its vendor's name. */
const bare = (name: string) => name.toLowerCase().replace(/[^a-z0-9]+/g, '');

/**
 * The group a model's requests count against: the one that lists it, by its vendor's name or the id
 * the harness takes for it ("gemini-4-neon" is "Gemini 4 Neon"); the only group when there's one and
 * it lists none; null when that can't be told.
 */
export function groupFor(groups: readonly LimitGroup[], model: string | null | undefined): LimitGroup | null {
  if (groups.length === 1 && !groups[0]?.models?.length) return groups[0] ?? null;
  if (!model) return null;
  const wanted = bare(model);
  if (!wanted) return null;
  return groups.find((g) => g.models?.some((m) => bare(m) === wanted)) ?? null;
}

/**
 * Whether a model's requests are out of usage now, going by limits just read: a window they count
 * against is used up, and hasn't started again. They count against every group that lists no models
 * (the ones every model shares) and each group that lists this one. `resets` is when the last of the
 * used-up windows starts again (all of them must), when the vendor says for each. Null when none is
 * used up, or when it can't be told which groups the model counts against: nothing is guessed.
 */
export function usedUp(
  groups: readonly LimitGroup[],
  model: string | null | undefined,
  now: number,
): { resets?: number } | null {
  const wanted = model ? bare(model) : '';
  const shared = groups.filter((g) => !g.models?.length);
  const own = wanted ? groups.filter((g) => g.models?.some((m) => bare(m) === wanted)) : [];
  // (limits by model only, and this model in none of them: which it counts against isn't known)
  if (!own.length && !shared.length) return null;
  const out = [...shared, ...own]
    .flatMap((g) => g.windows)
    .filter((w) => w.used >= 1 && (w.resets === undefined || w.resets > now));
  if (!out.length) return null;
  const all = out.map((w) => w.resets);
  return all.every((r): r is number => r !== undefined) ? { resets: Math.max(...all) } : {};
}

/** The longest ahead a limit is believed to start again: a little over a month. */
const RESETS_MOST_MS = 35 * 24 * 3_600_000;

/** Why a request stopped, as a runner said it, checked: one of the known reasons, a reset within reason. */
export function checkFailureKind(why: unknown, resets: unknown, now: number): FailureKind | null {
  if (why !== 'usage' && why !== 'signed-out' && why !== 'not-installed') return null;
  const at = typeof resets === 'number' && Number.isFinite(resets) ? Math.round(resets) : null;
  return at !== null && why === 'usage' && at > now && at - now <= RESETS_MOST_MS ? { why, resets: at } : { why };
}
