/**
 * Settings › Agent's harness rows through a harness's whole life, for each of the three: not installed
 * → Install (asked first) → installing → installed and signed out → Sign in (each one's own relay) →
 * signed in → Use / In use → Update to x.y (asked first) → updating → up to date.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AgentModule from '../src/app/agent.ts';
import type { HarnessEvent, HarnessId, HarnessInfo } from '../src/app/agent.ts';
import { choices, harnessRow, installQuestion } from '../src/ui/harness-row.ts';

class Storage {
  items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

let A: typeof AgentModule;
beforeAll(async () => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('window', globalThis);
  A = await import('../src/app/agent.ts');
});

const HARNESSES: {
  id: HarnessId;
  name: string;
  installer: string;
  version: string;
  latest: string;
  /** Its sign-in as the runner relays it. */
  signin: Omit<HarnessEvent, 'harness' | 'kind' | 'state'>;
  shows: { url: string; code?: string; askCode: boolean };
  /** Signed out, it can't say yet whether it can be sealed (Cursor asks for its sign-in first). */
  sealUnknown: boolean;
}[] = [
  {
    id: 'claude',
    name: 'Claude Code',
    installer: 'curl -fsSL https://claude.ai/install.sh | bash',
    version: '2.1.330',
    latest: '2.1.400',
    // a link, then a code pasted from the page
    signin: { url: 'https://claude.ai/oauth/authorize?code=true', ask: 'code' },
    shows: { url: 'https://claude.ai/oauth/authorize?code=true', askCode: true },
    sealUnknown: false,
  },
  {
    id: 'codex',
    name: 'Codex',
    installer: 'curl -fsSL https://chatgpt.com/codex/install.sh | sh',
    version: '0.168.0',
    latest: '0.170.0',
    // a link and a one-time code to enter there
    signin: { url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234' },
    shows: { url: 'https://auth.openai.com/codex/device', code: 'ABCD-1234', askCode: false },
    sealUnknown: false,
  },
  {
    id: 'cursor',
    name: 'Cursor',
    installer: 'curl https://cursor.com/install -fsS | bash',
    version: '2026.11.11-b912975',
    latest: '2026.11.12-aaaaaaa',
    // a link, and it waits for the sign-in to finish
    signin: { url: 'https://cursor.com/loginDeepControl?challenge=abc' },
    shows: { url: 'https://cursor.com/loginDeepControl?challenge=abc', askCode: false },
    sealUnknown: true,
  },
];

describe('a harness’s row, through its whole life', () => {
  for (const x of HARNESSES) {
    it(`${x.name}: Install, sign in, use, update`, () => {
      const event = (kind: HarnessEvent['kind'], state: HarnessEvent['state'], more: Partial<HarnessEvent> = {}) =>
        ({ harness: x.id, kind, state, ...more }) as HarnessEvent;

      // not installed: Install, and what it would run, where
      const missing: HarnessInfo = {
        id: x.id,
        name: x.name,
        found: false,
        sealed: false,
        host: 'r430',
        installer: x.installer,
        reason: `${x.name} isn’t installed on this computer`,
      };
      expect(harnessRow(missing, undefined, false)).toEqual({
        label: 'Not installed',
        version: false,
        install: { busy: false },
        signIn: null,
        update: null,
        use: null,
        note: null,
        signin: null,
        progress: null,
      });
      expect(installQuestion(missing)).toEqual({
        text: `This downloads and runs ${x.name}’s official installer on r430`,
        command: x.installer,
      });

      // installing: the button waits, the installer's lines show
      const installing = harnessRow(
        missing,
        event('install', 'running', { line: `Installing ${x.name} on r430` }),
        false,
      );
      expect(installing.install).toEqual({ busy: true });
      expect(installing.progress).toEqual({ line: `Installing ${x.name} on r430` });
      // failed: Install again, and why
      const failed = harnessRow(
        missing,
        event('install', 'failed', { error: 'curl: (6) Could not resolve host' }),
        false,
      );
      expect(failed.install).toEqual({ busy: false });
      expect(failed.progress).toEqual({ error: 'curl: (6) Could not resolve host' });

      // installed, signed out (as the runner's fresh look says, before the install is said done): Sign in
      const installed: HarnessInfo = {
        id: x.id,
        name: x.name,
        found: true,
        version: x.version,
        signedIn: false,
        sealed: !x.sealUnknown,
        ...(x.sealUnknown
          ? {
              sealUnknown: true,
              reason: 'Sign in to Cursor: it checks its sign-in before HO[LO] can check it limits it to its tools',
            }
          : {}),
        update: { available: false, latest: x.version },
        host: 'r430',
      };
      const justInstalled = harnessRow(
        installed,
        event('install', 'done', { line: `${x.name} ${x.version} is installed` }),
        false,
      );
      expect(justInstalled).toMatchObject({
        label: x.version,
        version: true,
        install: null,
        signIn: { busy: false },
        update: 'up-to-date',
        // not picked while it's signed out
        use: null,
        progress: { line: `${x.name} ${x.version} is installed` },
      });
      // one whose seal waits on its sign-in says so, without calling it unsealed
      expect(justInstalled.note).toBe(
        x.sealUnknown ? 'Once it’s signed in, HO[LO] checks it can be limited to its tools' : null,
      );
      // the one in use, signed out: In use, and Sign in
      expect(harnessRow(installed, undefined, true)).toMatchObject({ signIn: { busy: false }, use: 'in-use' });

      // signing in: its own relay (a pasted code, a device code, a link it polls)
      const signingIn = harnessRow(installed, event('login', 'running', x.signin), false);
      expect(signingIn.signIn).toEqual({ busy: true });
      expect(signingIn.signin).toEqual({ ...x.shows, waiting: true });
      expect(signingIn.progress).toBeNull();
      // it didn't finish: Sign in again, and why
      const signinFailed = harnessRow(installed, event('login', 'failed', { error: 'Timed out' }), false);
      expect(signinFailed.signIn).toEqual({ busy: false });
      expect(signinFailed.signin).toMatchObject({ error: 'Timed out', waiting: false });

      // signed in (its seal checked now): Use, or In use
      const signedIn: HarnessInfo = {
        ...installed,
        signedIn: true,
        account: 'user@example.com',
        sealed: true,
        sealUnknown: undefined,
        reason: undefined,
      };
      const done = event('login', 'done', { line: `${x.name} is signed in` });
      expect(harnessRow(signedIn, done, false)).toMatchObject({
        signIn: 'signed-in',
        use: 'use',
        note: null,
        signin: null,
        update: 'up-to-date',
      });
      expect(harnessRow(signedIn, done, true).use).toBe('in-use');

      // an update is out: Update to x.y; while it runs, its lines
      const outdated: HarnessInfo = { ...signedIn, update: { available: true, latest: x.latest } };
      expect(harnessRow(outdated, done, true).update).toEqual({ latest: x.latest, busy: false });
      const updating = harnessRow(outdated, event('update', 'running', { line: `Updating ${x.name}` }), true);
      expect(updating.update).toEqual({ latest: x.latest, busy: true });
      expect(updating.progress).toEqual({ line: `Updating ${x.name}` });
      const updateFailed = harnessRow(outdated, event('update', 'failed', { error: 'No space left' }), true);
      expect(updateFailed.update).toEqual({ latest: x.latest, busy: false });
      expect(updateFailed.progress).toEqual({ error: 'No space left' });

      // updated: up to date, at its new version
      const current: HarnessInfo = { ...signedIn, version: x.latest, update: { available: false, latest: x.latest } };
      expect(harnessRow(current, event('update', 'done'), true)).toMatchObject({
        label: x.latest,
        signIn: 'signed-in',
        update: 'up-to-date',
        use: 'in-use',
        progress: null,
      });
    });
  }

  it('keeps Sign in on one that can’t be limited to HO[LO]’s tools, and says why it can’t be used', () => {
    const h: HarnessInfo = {
      id: 'codex',
      name: 'Codex',
      found: true,
      version: '0.1.0',
      signedIn: false,
      sealed: false,
      reason: 'This Codex gives the model tools HO[LO] can’t turn off (shell)',
    };
    expect(harnessRow(h, undefined, false)).toMatchObject({
      signIn: { busy: false },
      use: null,
      note: 'Can’t be limited to HO[LO]’s tools: This Codex gives the model tools HO[LO] can’t turn off (shell)',
    });
  });

  it('says how to install one by hand where the host can’t run its installer', () => {
    const h: HarnessInfo = { id: 'cursor', name: 'Cursor', found: false, sealed: false, host: 'win-box' };
    expect(harnessRow(h, undefined, false)).toMatchObject({
      label: 'Not installed',
      install: null,
      note: 'Install it on win-box, then Look again',
    });
  });
});

describe('the model and effort pickers', () => {
  it('list the harness’s own, and keep one saved that it no longer offers, said so', () => {
    expect(choices(['opus', 'sonnet'], 'opus')).toEqual([
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
    ]);
    expect(choices(['opus', 'sonnet'], 'fable')).toEqual([
      { value: 'opus', label: 'Opus' },
      { value: 'sonnet', label: 'Sonnet' },
      { value: 'fable', label: 'Fable (no longer offered)', gone: true },
    ]);
    expect(choices(['low', 'high'], '')).toHaveLength(2);
  });
});

describe('an install as the studio hears of it', () => {
  it('shows one under way after a reload, and follows it to its end', () => {
    const installing: HarnessEvent = {
      harness: 'cursor',
      kind: 'install',
      state: 'running',
      line: 'Installing Cursor on r430',
    };
    const settings = {
      enabled: true,
      harness: null,
      model: '',
      effort: '',
      harnesses: [
        {
          id: 'cursor' as const,
          name: 'Cursor',
          found: false,
          sealed: false,
          installer: 'curl https://cursor.com/install -fsS | bash',
        },
      ],
      relays: [installing],
    };
    let a = A.reduce(A.EMPTY, { type: 'settings', settings });
    expect(a.harness.cursor).toEqual(installing);
    a = A.reduce(a, {
      type: 'harness',
      event: { harness: 'cursor', kind: 'install', state: 'done', line: 'Cursor 2026.11.11-b912975 is installed' },
    });
    expect(a.harness.cursor?.state).toBe('done');
    // the settings that come next don't bring an install back
    a = A.reduce(a, { type: 'settings', settings: { ...settings, relays: [] } });
    expect(a.harness.cursor?.state).toBe('done');
  });
});
