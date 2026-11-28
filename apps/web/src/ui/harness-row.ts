/**
 * What a harness's row in Settings › Agent shows, from what the host reports of it and what's under way
 * (a sign-in, an update, an install): one place for its whole life, tried on its own in a test.
 *
 * Not installed → Install (asked first) → installed and signed out → Sign in → signed in → Use / In use
 * → Update to x.y when one is out (asked first) → Up to date.
 */
import type { HarnessEvent, HarnessInfo } from '../app/agent.ts';

export interface HarnessRowView {
  /** Its version, or "Not installed". */
  label: string;
  /** The program's version (shown in a monospace face). */
  version: boolean;
  /** Install, when it isn't there and the host can run its installer; `busy` while it runs. */
  install: null | { busy: boolean };
  /** "Signed in", or Sign in (`busy` while a sign-in is under way). */
  signIn: null | 'signed-in' | { busy: boolean };
  /** "Up to date", or Update to x.y (`busy` while it updates). */
  update: null | 'up-to-date' | { latest: string; busy: boolean };
  /** "In use", or Use. */
  use: null | 'in-use' | 'use';
  /** Under the row: why it can't be used yet, or what to do (muted). */
  note: string | null;
  /** The sign-in under way: its page, its code, whether it waits for a pasted code, how it ended. */
  signin: null | { url?: string; code?: string; askCode: boolean; line?: string; error?: string; waiting: boolean };
  /** An install or an update under way, or how it ended: its last line, or its error. */
  progress: null | { line?: string; error?: string };
}

const running = (e: HarnessEvent | undefined, kind: HarnessEvent['kind']) => e?.kind === kind && e.state === 'running';

export function harnessRow(h: HarnessInfo, event: HarnessEvent | undefined, current: boolean): HarnessRowView {
  const relayed = (kind: 'install' | 'update') =>
    event?.kind === kind && (event.line || event.state === 'failed')
      ? {
          ...(event.line ? { line: event.line } : {}),
          ...(event.state === 'failed' ? { error: event.error ?? `The ${kind} failed` } : {}),
        }
      : null;
  if (!h.found) {
    return {
      label: 'Not installed',
      version: false,
      install: h.installer ? { busy: running(event, 'install') } : null,
      signIn: null,
      update: null,
      use: null,
      note: h.installer ? null : `Install it on ${h.host ?? 'the host'}, then Look again`,
      signin: null,
      progress: relayed('install'),
    };
  }
  const login = event?.kind === 'login' ? event : null;
  const signIn: HarnessRowView['signIn'] =
    h.signedIn === true ? 'signed-in' : h.signedIn === false ? { busy: running(event, 'login') } : null;
  const update: HarnessRowView['update'] = h.update?.available
    ? { latest: h.update.latest ?? 'the latest', busy: running(event, 'update') }
    : h.update
      ? 'up-to-date'
      : null;
  // only one that can be limited to HO[LO]'s tools, and isn't known to be signed out, can be picked
  const use: HarnessRowView['use'] = current ? 'in-use' : h.sealed && h.signedIn !== false ? 'use' : null;
  const note = h.sealUnknown
    ? `Once it’s signed in, HO[LO] checks it can be limited to its tools`
    : !h.sealed
      ? `Can’t be limited to HO[LO]’s tools${h.reason ? `: ${h.reason}` : ''}`
      : null;
  return {
    label: h.version ?? '',
    version: !!h.version,
    install: null,
    signIn,
    update,
    use,
    note,
    signin:
      login && h.signedIn === false
        ? {
            ...(login.url ? { url: login.url } : {}),
            ...(login.code ? { code: login.code } : {}),
            askCode: login.ask === 'code',
            ...(login.line ? { line: login.line } : {}),
            ...(login.state === 'failed' ? { error: login.error ?? 'The sign-in didn’t finish' } : {}),
            waiting: login.state === 'running',
          }
        : null,
    // an install's last word stays (it's installed); an update's while it runs or failed
    progress: relayed('update') ?? relayed('install'),
  };
}

/**
 * What Sign in and Use ask first for a harness whose vendor doesn't support HO[LO] running it on a
 * consumer plan (Antigravity: Google's FAQ), with where the vendor says so; null for the others. The
 * server never picks such a harness by itself either: it runs only once it's chosen.
 */
export function caution(h: Pick<HarnessInfo, 'id'>): { text: string; link: string; source: string } | null {
  if (h.id !== 'antigravity') return null;
  return {
    text:
      'Google’s Antigravity FAQ says running agy inside another app “is not supported under consumer plans”, ' +
      'and that using third-party software with an Antigravity sign-in can get the account suspended, ' +
      'Gemini CLI included. HO[LO] would run it as you, on your Google AI plan.',
    link: 'https://antigravity.google/docs/faq/',
    source: 'Google’s FAQ',
  };
}

/**
 * The harness the agent runs with, as the server picks it: the one chosen, when the host has it; else
 * the first that can be limited to HO[LO]'s tools, never one that asks first (`caution`: the server
 * runs it only once it's chosen); null when there's none.
 */
export function inUse(listed: readonly HarnessInfo[], chosen: HarnessInfo['id'] | null): HarnessInfo | null {
  const found = listed.filter((h) => h.found);
  return found.find((h) => h.id === chosen) ?? found.find((h) => h.sealed && !caution(h)) ?? null;
}

/** What Install asks before it runs: what runs, where, as the vendor's docs give it. */
export function installQuestion(h: HarnessInfo): { text: string; command: string } {
  return {
    text: `This downloads and runs ${h.name}’s official installer on ${h.host ?? 'the host'}`,
    command: h.installer ?? '',
  };
}

/** A model's or an effort's name as a menu shows it ("opus" is "Opus"). */
export const shown = (name: string) => name.charAt(0).toUpperCase() + name.slice(1);

/**
 * A Claude model's full name as people say it, with its version: "claude-opus-9-1" is "Opus 9.1", and a
 * dated one ("claude-sonnet-9-20990101") drops its date. Any other name stays as it is.
 */
export function modelName(full: string): string {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d{1,2}))?(?:-\d{8})?$/.exec(full);
  return m?.[1] && m[2] ? `${shown(m[1])} ${m[2]}${m[3] ? `.${m[3]}` : ''}` : full;
}

/**
 * A model as a menu or a line names it: an alias or any other name as it is, capitalised ("Opus",
 * "Gpt-6.1-sol"), and a Claude model's full name as people say it ("claude-fable-9-1" is "Fable 9.1").
 */
export function modelSaid(name: string): string {
  const said = modelName(name);
  return said !== name ? said : shown(name);
}

/** An alias in its menu once a run has said what it stands for: "Opus (9.1)", its version alone when it's its own family. */
function aliasLabel(alias: string, full: string): string {
  const name = shown(alias);
  const said = modelName(full);
  return `${name} (${said.startsWith(`${name} `) ? said.slice(name.length + 1) : said})`;
}

/**
 * The efforts the model a run uses takes: its own list when the harness gives each model's
 * (`modelEfforts`), else the harness's. The model is the one chosen while the harness offers it, else
 * its default.
 */
export function effortsFor(h: HarnessInfo, model: string): string[] | undefined {
  const name = model && (!h.models?.length || h.models.includes(model)) ? model : (h.defaultModel ?? '');
  return name && h.modelEfforts && Object.hasOwn(h.modelEfforts, name) ? h.modelEfforts[name] : h.efforts;
}

/** The model and effort a run uses now, from the agent's Model and Effort and what the harness says. */
export interface RunsWith {
  /** The model chosen (what its alias stood for at its last run), or the harness's default; null: not said. */
  model: string | null;
  /** The effort chosen, or the model's own default; null: not said, or carried in the model's name. */
  effort: string | null;
  /** The model's name carries its effort (Cursor, some of Antigravity's): there's no Effort to choose. */
  effortInModel: boolean;
  /** Each is the harness's default: nothing chosen, or the one chosen is no longer offered. */
  defaultModel: boolean;
  defaultEffort: boolean;
}

/**
 * What a run uses with these settings, as the adapter decides it: a model or an effort the harness no
 * longer offers is dropped (an empty list says nothing: what's typed is passed on), and then the
 * harness's own default applies (or, when it lists none, it doesn't run).
 */
export function runsWith(h: HarnessInfo, model: string, effort: string): RunsWith {
  const chosen = model && (!h.models?.length || h.models.includes(model)) ? model : '';
  const resolved = chosen ? (h.aliases?.[chosen] ?? chosen) : (h.defaultModel ?? null);
  const efforts = effortsFor(h, model);
  const effortInModel = efforts?.length === 0;
  const picked = !effortInModel && effort && (!efforts || efforts.includes(effort)) ? effort : '';
  const effortNow = effortInModel ? null : picked || (resolved && h.defaultEfforts?.[resolved]) || null;
  return { model: resolved, effort: effortNow, effortInModel, defaultModel: !chosen, defaultEffort: !picked };
}

/** What a harness that lists no defaults still needs chosen to run: null when nothing. */
export function toChoose(h: HarnessInfo, model: string, effort: string): string | null {
  if (!h.mustChoose) return null;
  const r = runsWith(h, model, effort);
  const effortToo = r.defaultEffort && !r.effortInModel;
  return r.defaultModel && effortToo
    ? 'a model and an effort'
    : r.defaultModel
      ? 'a model'
      : effortToo
        ? 'an effort'
        : null;
}

/**
 * What Settings › Agent says a request uses, in the menus' own names: "Gpt-6.1-sol at low effort",
 * "Opus at high effort (last ran as Opus 9.1)", "Auto: Cursor chooses the model", the harness's
 * default when it doesn't say what that is, or what's left to choose when it has no defaults.
 */
export function runsWithText(h: HarnessInfo, model: string, effort: string): string {
  const missing = toChoose(h, model, effort);
  if (missing) return `Choose ${missing} first`;
  const r = runsWith(h, model, effort);
  if (!r.model) return `${h.name}’s ${r.effortInModel ? 'default model' : 'default model and effort'}`;
  // a model that's the harness choosing for itself (Cursor's auto), its effort too
  if (r.effortInModel && r.model.toLowerCase() === 'auto') return `Auto: ${h.name} chooses the model`;
  // an alias moves on with each new model (Claude Code's opus): what it last ran as
  const alias = !r.defaultModel && r.model !== model;
  const name = modelSaid(alias ? model : r.model);
  const said = r.effortInModel
    ? name
    : r.effort
      ? `${name} at ${r.effort} effort`
      : `${name} at ${h.name}’s default effort`;
  return alias ? `${said} (last ran as ${modelName(r.model)})` : said;
}

/** The label of a picker's empty choice: what the harness's default is when that's known, then whose. */
export function defaultLabel(h: HarnessInfo, value: string | null): string {
  return value ? `${modelSaid(value)} (${h.name}’s default)` : `${h.name}’s default`;
}

/**
 * A picker's choices: the harness's own, each alias with the version it last ran as, and the one saved
 * when it's no longer among them (it's kept as it is, said so; a run uses the harness's default
 * instead, or doesn't run when it lists none).
 */
export function choices(
  list: readonly string[],
  saved: string,
  aliases: Readonly<Record<string, string>> = {},
): { value: string; label: string; gone?: true }[] {
  const out: { value: string; label: string; gone?: true }[] = list.map((v) => {
    const full = aliases[v];
    return { value: v, label: full && full !== v ? aliasLabel(v, full) : modelSaid(v) };
  });
  if (saved && !list.includes(saved))
    out.push({ value: saved, label: `${shown(saved)} (no longer offered)`, gone: true });
  return out;
}
