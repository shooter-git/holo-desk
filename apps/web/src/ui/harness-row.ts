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
 * A picker's choices: the harness's own, and the one saved when it's no longer among them (it's kept
 * as it is, said so; a run uses the harness's default instead).
 */
export function choices(list: readonly string[], saved: string): { value: string; label: string; gone?: true }[] {
  const out: { value: string; label: string; gone?: true }[] = list.map((v) => ({ value: v, label: shown(v) }));
  if (saved && !list.includes(saved))
    out.push({ value: saved, label: `${shown(saved)} (no longer offered)`, gone: true });
  return out;
}
