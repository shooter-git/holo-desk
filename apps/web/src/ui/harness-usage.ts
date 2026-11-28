/**
 * What a harness's row in Settings › Agent says of its account's usage: how much of each of its
 * vendor's limits is left and when it starts again, and what the requests made through HO[LO] used.
 * One place for the words and the numbers, tried on its own in a test.
 *
 * Only what a vendor reports is shown, as it reports it: a limit that has started again since it was
 * read isn't taken as full (the account may have been used elsewhere), and a harness that doesn't say
 * what's left (Cursor) has its plan, its own page, and HO[LO]'s counts.
 */
import { groupFor, type LimitGroup, type LimitWindow } from '@holo/agent/limits';
import type { HarnessId, HarnessInfo, UsageSum } from '../app/agent.ts';
import { modelSaid, shown } from './harness-row.ts';

/** One window of a limit, as a line: its name, a bar of what's left, and when it starts again. */
export interface MeterView {
  key: string;
  /** "Weekly", "5-hour". */
  label: string;
  /** What's left, from 0 to 1; null when that isn't known any more (it has started again since it was read). */
  left: number | null;
  /** "37% left", "Used up", "Reset 4 h ago". */
  text: string;
  /** "resets Thu 3 Dec, 07:02", "resets in 2 h 10 min", "not read since"; empty when the vendor doesn't say. */
  when: string;
  /** Plenty, a fifth or less, none, or not known any more. */
  level: 'ok' | 'low' | 'out' | 'stale';
}

/** The limits some models share. */
export interface GroupView {
  key: string;
  /** The vendor's name for the group; null when the harness has one for every model. */
  name: string | null;
  /** The models in it, as the vendor names them, in a line. */
  models: string | null;
  /** The model the agent runs with counts against it. */
  inUse: boolean;
  meters: MeterView[];
}

/** What the requests made through HO[LO] with one model used. */
export interface ThroughRow {
  key: string;
  /** "Opus · high", "Auto", "Its default model". */
  label: string;
  requests: string;
  /** Tokens read (what came from the vendor's cache too), and tokens written. */
  read: string;
  written: string;
}

export interface UsageView {
  /** The longest limit of the group in use (the first group otherwise): what a row can't do without. */
  summary: MeterView | null;
  /**
   * The lines that show folded: that limit alone, or, for the harness the agent runs with, every limit
   * of the group its model counts against.
   */
  lead: MeterView[];
  /** That group's name, when the harness has several. */
  summaryOf: string | null;
  groups: GroupView[];
  /** "Max plan". */
  plan: string | null;
  /** Something the vendor says beside its limits. */
  note: string | null;
  /** That, when it's worth saying folded too: a limit is low or used up. */
  noteNow: string | null;
  /** "Read 3 h ago", once that's a while. */
  read: string | null;
  /** Why no limit shows, when none does. */
  none: string | null;
  /** The vendor's own page for what's left, for a harness that doesn't report it. */
  link: { href: string; text: string } | null;
  /** What the requests through HO[LO] used: in a line, and by model. */
  through: { days: number; line: string; rows: ThroughRow[] } | null;
  /** There's more than the folded line shows. */
  more: boolean;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** How each harness says what its account has left: when asked, only with a request, or not at all. */
const REPORTS: Record<HarnessId, 'asked' | 'runs' | 'never'> = {
  claude: 'runs',
  codex: 'asked',
  cursor: 'never',
  antigravity: 'asked',
};

/** The vendor's own page for an account's usage, for a harness that doesn't report what's left. */
const USAGE_PAGE: Partial<Record<HarnessId, string>> = { cursor: 'https://cursor.com/dashboard?tab=usage' };

/** A window's name by its length: "5-hour", "Weekly". */
export function windowLabel(minutes: number): string {
  if (minutes === 10080) return 'Weekly';
  if (minutes === 1440) return 'Daily';
  if (minutes >= 28 * 1440 && minutes <= 31 * 1440) return 'Monthly';
  if (minutes % 1440 === 0) return `${minutes / 1440}-day`;
  if (minutes % 60 === 0) return `${minutes / 60}-hour`;
  return `${minutes}-minute`;
}

export interface Clock {
  now: number;
  /** For the tests: the place and the zone the times are written for (the browser's otherwise). */
  locale?: string;
  timeZone?: string;
}

/** A day and a time as the row writes them: "Thu 3 Dec, 07:02". */
function dayAndTime(at: number, c: Clock): string {
  const parts = new Intl.DateTimeFormat(c.locale, {
    weekday: 'short',
    day: 'numeric',
    month: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(c.timeZone ? { timeZone: c.timeZone } : {}),
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  // (a day's first hour is 00, never 24)
  const hour = part('hour') === '24' ? '00' : part('hour');
  return `${part('weekday')} ${part('day')} ${part('month')}, ${hour}:${part('minute')}`;
}

/** How long until a time, in a few words: "25 min", "5 h 10 min", "3 h". */
function span(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / MINUTE));
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} h ${m} min` : `${h} h`;
}

/** When a limit starts again, as it's said after "starts again": "in 2 h 10 min", or "Thu 3 Dec, 07:02". */
export function startsAgain(resets: number, c: Clock): string {
  return resets - c.now < DAY ? `in ${span(resets - c.now)}` : dayAndTime(resets, c);
}

/** A time as a button or a line says it: "at 14:05" within a day, else "Thu 3 Dec, 07:02". */
export function atClock(at: number, c: Clock): string {
  if (Math.abs(at - c.now) >= DAY) return dayAndTime(at, c);
  const parts = new Intl.DateTimeFormat(c.locale, {
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    ...(c.timeZone ? { timeZone: c.timeZone } : {}),
  }).formatToParts(at);
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? '';
  return `at ${part('hour') === '24' ? '00' : part('hour')}:${part('minute')}`;
}

/** One window, as its line. */
export function meter(w: LimitWindow, key: string, c: Clock): MeterView {
  const label = windowLabel(w.minutes);
  // it has started again since it was read: what's left now isn't what was read, and isn't guessed
  if (w.resets !== undefined && w.resets <= c.now) {
    const ago = c.now - w.resets;
    const text = ago < DAY ? `Reset ${span(ago)} ago` : `Reset ${dayAndTime(w.resets, c)}`;
    return { key, label, left: null, text, when: 'not read since', level: 'stale' };
  }
  const left = Math.min(1, Math.max(0, 1 - w.used));
  const percent = Math.round(left * 100);
  const text = left <= 0 ? 'Used up' : percent === 0 ? 'Under 1% left' : `${percent}% left`;
  const when =
    w.resets === undefined
      ? ''
      : w.resets - c.now < DAY
        ? `resets in ${span(w.resets - c.now)}`
        : `resets ${dayAndTime(w.resets, c)}`;
  return { key, label, left, text, when, level: left <= 0 ? 'out' : left <= 0.2 ? 'low' : 'ok' };
}

/** A count of tokens in a few characters: 940, 3.4k, 41k, 3.4M. */
export function tokenCount(n: number): string {
  const short = (v: number, unit: string) => `${v >= 9.95 ? Math.round(v) : Math.round(v * 10) / 10}${unit}`;
  if (n < 1000) return String(Math.round(n));
  if (n < 999_500) return short(n / 1e3, 'k');
  if (n < 999_500_000) return short(n / 1e6, 'M');
  return short(n / 1e9, 'B');
}

const plural = (n: number, word: string) => `${n.toLocaleString('en-US')} ${word}${n === 1 ? '' : 's'}`;

/** How long ago the limits were read, once that's ten minutes or more. */
function readAgo(at: number, now: number): string | null {
  const age = now - at;
  if (age < 10 * MINUTE) return null;
  if (age < HOUR) return `Read ${Math.round(age / MINUTE)} min ago`;
  if (age < 2 * DAY) return `Read ${Math.round(age / HOUR)} h ago`;
  return `Read ${Math.round(age / DAY)} days ago`;
}

/** A plan's name as the row writes it: "Max plan", "Pro+ plan". */
function planText(plan: string | undefined): string | null {
  const name = plan?.trim();
  if (!name) return null;
  return /\bplan$/i.test(name) ? shown(name) : `${shown(name)} plan`;
}

/** A model and effort as a requests' row names them. */
function modelLabel(model: string, effort: string): string {
  const name = model ? modelSaid(model) : 'Its default model';
  return effort ? `${name} · ${effort}` : name;
}

export interface UsageOptions extends Clock {
  /** It's the harness the agent runs with. */
  current: boolean;
  /** Then: the model chosen, and the one a run uses (what an alias stood for, or the harness's default). */
  chosen?: string | null;
  runs?: string | null;
  /** What the requests of the last `days` days used, every harness's. */
  usage?: { days: number; rows: readonly UsageSum[] };
}

/**
 * A harness's usage, for its row: null when there's nothing to say of it (it isn't installed, or it's
 * signed out and no request has run with it).
 */
export function usageView(h: HarnessInfo, o: UsageOptions): UsageView | null {
  if (!h.found) return null;
  const mine = (o.usage?.rows ?? []).filter((r) => r.harness === h.id);
  const signedOut = h.signedIn === false;
  if (signedOut && !mine.length) return null;

  const limits = signedOut ? undefined : h.limits;
  const listed: readonly LimitGroup[] = limits?.groups ?? [];
  const own = o.current ? (groupFor(listed, o.chosen) ?? groupFor(listed, o.runs)) : null;
  const several = listed.length > 1;
  const groups: GroupView[] = listed.map((g, i) => ({
    key: `${i}:${g.name ?? ''}`,
    // (a group that lists no models is every model's: a family's own, beside it, counts as well)
    name: several || g.name ? (g.name ?? 'Every model') : null,
    models: g.models?.length ? g.models.join(', ') : null,
    inUse: several && g === own,
    meters: g.windows.map((w, k) => meter(w, `${i}:${w.minutes}:${k}`, o)),
  }));
  // the group in use first, then as the vendor lists them
  const at = Math.max(0, own ? listed.indexOf(own) : 0);
  const ordered = groups.length ? [groups[at] as GroupView, ...groups.filter((_, i) => i !== at)] : [];
  const first = ordered[0];
  const summary = first?.meters[0] ?? null;

  const how = REPORTS[h.id];
  const page = USAGE_PAGE[h.id];
  const none = summary
    ? null
    : signedOut
      ? null
      : how === 'never'
        ? `${h.name} doesn’t report what’s left of its plan`
        : how === 'runs'
          ? `${h.name} says what’s left with each request: it shows after the next one`
          : null;

  const total = mine.reduce(
    (t, r) => ({ requests: t.requests + r.requests, read: t.read + r.input + r.cached, written: t.written + r.output }),
    { requests: 0, read: 0, written: 0 },
  );
  const through = mine.length
    ? {
        days: o.usage?.days ?? 30,
        line: `${plural(total.requests, 'request')} · ${tokenCount(total.read)} tokens in, ${tokenCount(total.written)} out`,
        rows: mine.map((r) => ({
          key: `${r.model}|${r.effort}`,
          label: modelLabel(r.model, r.effort),
          requests: r.requests.toLocaleString('en-US'),
          read: tokenCount(r.input + r.cached),
          written: tokenCount(r.output),
        })),
      }
    : null;

  const plan = signedOut ? null : planText(h.plan);
  const note = limits?.note ?? null;
  const read = limits && summary ? readAgo(limits.at, o.now) : null;
  const link = !summary && page && !signedOut ? { href: page, text: `${h.name}’s usage page` } : null;
  if (!summary && !none && !through && !plan && !note) return null;
  const meters = groups.reduce((n, g) => n + g.meters.length, 0);
  const lead = summary ? (o.current ? (first?.meters ?? []) : [summary]) : [];
  return {
    summary,
    lead,
    summaryOf: several ? (first?.name ?? null) : null,
    groups: ordered,
    plan,
    note,
    noteNow: note && lead.some((m) => m.level === 'low' || m.level === 'out') ? note : null,
    read,
    none,
    link,
    through,
    // (folded, a harness with a limit shows it alone; one without shows its plan, why, and its counts in a line)
    more: summary ? meters > lead.length || !!through || !!plan || !!note || !!read : !!through,
  };
}
