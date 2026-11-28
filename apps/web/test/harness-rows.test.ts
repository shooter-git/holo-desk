/**
 * Settings › Agent's harness rows through a harness's whole life, for each of the four: not installed
 * → Install (asked first) → installing → installed and signed out → Sign in (each one's own relay) →
 * signed in → it can be picked / it's the one in use → Update (asked first) → updating → up to date.
 */
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AgentModule from '../src/app/agent.ts';
import type { HarnessEvent, HarnessId, HarnessInfo } from '../src/app/agent.ts';
import {
  caution,
  choices,
  defaultLabel,
  effortsFor,
  harnessRow,
  installQuestion,
  inUse,
  modelName,
  modelSaid,
  rowStates,
  runsWith,
  runsWithText,
  toChoose,
} from '../src/ui/harness-row.ts';

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
  {
    id: 'antigravity',
    name: 'Antigravity',
    installer: 'curl -fsSL https://antigravity.google/cli/install.sh | bash',
    version: '1.5.13',
    latest: '1.5.14',
    // a Google link, then the code its page shows, pasted
    signin: { url: 'https://accounts.google.com/o/oauth2/auth?state=xyz', ask: 'code' },
    shows: { url: 'https://accounts.google.com/o/oauth2/auth?state=xyz', askCode: true },
    // its check would start a browser sign-in: checked once it's signed in
    sealUnknown: true,
  },
];

describe('a harness its vendor doesn’t support HO[LO] running', () => {
  it('asks before Sign in and Use for Antigravity, with Google’s own words and where it says them; none for the others', () => {
    const warning = caution({ id: 'antigravity' });
    expect(warning?.text).toContain('“is not supported under consumer plans”');
    expect(warning?.text).toContain('suspended');
    expect(warning?.link).toBe('https://antigravity.google/docs/faq/');
    for (const id of ['claude', 'codex', 'cursor'] as const) expect(caution({ id })).toBeNull();
  });

  it('offers the efforts of the model a run uses, and says a model that takes none has its own', () => {
    const h: HarnessInfo = {
      id: 'antigravity',
      name: 'Antigravity',
      found: true,
      sealed: true,
      models: ['gemini-3.8-flash', 'claude-sonnet-4-6', 'gpt-oss-120b'],
      efforts: ['low', 'medium', 'high'],
      modelEfforts: {
        'gemini-3.8-flash': ['low', 'medium', 'high'],
        'claude-sonnet-4-6': [],
        'gpt-oss-120b': ['medium'],
      },
    };
    expect(effortsFor(h, 'gemini-3.8-flash')).toEqual(['low', 'medium', 'high']);
    expect(effortsFor(h, 'gpt-oss-120b')).toEqual(['medium']);
    // none chosen, and no default said: every effort
    expect(effortsFor(h, '')).toEqual(['low', 'medium', 'high']);
    expect(runsWithText(h, 'gemini-3.8-flash', 'high')).toBe('Gemini-3.8-flash at high effort');
    // its effort comes with it: none is said, whatever was saved
    expect(runsWith(h, 'claude-sonnet-4-6', 'high')).toMatchObject({ effort: null, effortInModel: true });
    // (a Claude model's full name, as people say it)
    expect(runsWithText(h, 'claude-sonnet-4-6', 'high')).toBe('Sonnet 4.6');
    // one it doesn't take: its own default
    expect(runsWithText(h, 'gpt-oss-120b', 'low')).toBe('Gpt-oss-120b at Antigravity’s default effort');
  });

  it('is never the one in use unless it’s chosen, as the server runs it', () => {
    const antigravity: HarnessInfo = {
      id: 'antigravity',
      name: 'Antigravity',
      found: true,
      sealed: true,
      signedIn: true,
    };
    const codex: HarnessInfo = { id: 'codex', name: 'Codex', found: true, sealed: true, signedIn: true };
    const claude: HarnessInfo = { id: 'claude', name: 'Claude Code', found: true, sealed: false };
    // the only one there, sealed and signed in: none is in use
    expect(inUse([antigravity], null)).toBeNull();
    // with another that can be used: that one
    expect(inUse([claude, codex, antigravity], null)).toBe(codex);
    // chosen: it
    expect(inUse([claude, codex, antigravity], 'antigravity')).toBe(antigravity);
    // chosen and gone from the host: the first that can be used instead
    expect(inUse([codex, { ...antigravity, found: false }], 'antigravity')).toBe(codex);
  });
});

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
        host: 'studio-pc',
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
        text: `This downloads and runs ${x.name}’s official installer on studio-pc`,
        command: x.installer,
      });

      // installing: the button waits, the installer's lines show
      const installing = harnessRow(
        missing,
        event('install', 'running', { line: `Installing ${x.name} on studio-pc` }),
        false,
      );
      expect(installing.install).toEqual({ busy: true });
      expect(installing.progress).toEqual({ line: `Installing ${x.name} on studio-pc` });
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
        host: 'studio-pc',
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

  it('says its states in a line once opened: its version, its sign-in, its update', () => {
    const h: HarnessInfo = {
      id: 'codex',
      name: 'Codex',
      found: true,
      sealed: true,
      signedIn: true,
      version: '0.167.1',
      update: { available: false },
    };
    const line = (x: HarnessInfo) => rowStates(harnessRow(x, undefined, false)).map((s) => s.text);
    expect(line(h)).toEqual(['0.167.1', 'Signed in', 'Up to date']);
    expect(line({ ...h, signedIn: false, update: { available: true, latest: '0.170.0' } })).toEqual([
      '0.167.1',
      'Signed out',
      '0.170.0 is out',
    ]);
    // what the host hasn't said isn't guessed
    expect(line({ ...h, signedIn: undefined, update: undefined })).toEqual(['0.167.1']);
    expect(rowStates(harnessRow(h, undefined, true))[1]).toEqual({ key: 'signin', text: 'Signed in' });
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

  it('show the version an alias stands for now', () => {
    const aliases = { opus: 'claude-opus-9-1', sonnet: 'claude-sonnet-9-20990101', best: 'claude-opus-9-1' };
    expect(choices(['opus', 'sonnet', 'haiku', 'best'], '', aliases)).toEqual([
      { value: 'opus', label: 'Opus (9.1)' },
      { value: 'sonnet', label: 'Sonnet (9)' },
      { value: 'haiku', label: 'Haiku' },
      { value: 'best', label: 'Best (Opus 9.1)' },
    ]);
    // a full name of another shape is shown as it is
    expect(choices(['opus'], '', { opus: 'claude-opus-test' })).toEqual([
      { value: 'opus', label: 'Opus (claude-opus-test)' },
    ]);
    expect(modelName('claude-fable-9-12')).toBe('Fable 9.12');
    expect(modelName('gpt-6.1-sol')).toBe('gpt-6.1-sol');
  });

  it('name a Claude model’s full id as people say it, where the harness lists those beside its aliases', () => {
    // (as Claude Code lists what an account may run: its aliases, then older models by their full names)
    const aliases = { opus: 'claude-opus-9-1', fable: 'claude-fable-9-2' };
    expect(choices(['opus', 'fable', 'claude-fable-9-1', 'claude-haiku-8-5-20990101'], '', aliases)).toEqual([
      { value: 'opus', label: 'Opus (9.1)' },
      { value: 'fable', label: 'Fable (9.2)' },
      { value: 'claude-fable-9-1', label: 'Fable 9.1' },
      { value: 'claude-haiku-8-5-20990101', label: 'Haiku 8.5' },
    ]);
    expect(modelSaid('claude-fable-9-1')).toBe('Fable 9.1');
    expect(modelSaid('opus')).toBe('Opus');
    expect(modelSaid('gpt-6.1-sol')).toBe('Gpt-6.1-sol');
  });
});

describe('what a run uses, as Settings › Agent says it', () => {
  const base = { found: true, sealed: true } as const;
  const codex: HarnessInfo = {
    ...base,
    id: 'codex',
    name: 'Codex',
    models: ['gpt-6.1-sol', 'gpt-6-astra'],
    efforts: ['low', 'medium', 'high'],
    defaultModel: 'gpt-6.1-sol',
    defaultEfforts: { 'gpt-6.1-sol': 'low', 'gpt-6-astra': 'medium' },
  };
  const cursor: HarnessInfo = {
    ...base,
    id: 'cursor',
    name: 'Cursor',
    models: ['auto', 'composer-2.5'],
    efforts: [],
    defaultModel: 'auto',
  };
  const claude: HarnessInfo = {
    ...base,
    id: 'claude',
    name: 'Claude Code',
    models: ['opus', 'sonnet'],
    efforts: ['low', 'medium', 'high'],
    mustChoose: true,
  };
  const ranClaude: HarnessInfo = { ...claude, aliases: { opus: 'claude-opus-test' } };

  it('names the harness’s defaults when it lists them, each model with its own effort', () => {
    expect(runsWithText(codex, '', '')).toBe('Gpt-6.1-sol at low effort');
    expect(runsWithText(codex, 'gpt-6-astra', '')).toBe('Gpt-6-astra at medium effort');
    expect(runsWithText(codex, 'gpt-6-astra', 'high')).toBe('Gpt-6-astra at high effort');
    expect(defaultLabel(codex, codex.defaultModel ?? null)).toBe('Gpt-6.1-sol (Codex’s default)');
    expect(defaultLabel(codex, runsWith(codex, 'gpt-6-astra', '').effort)).toBe('Medium (Codex’s default)');
    expect(defaultLabel(codex, null)).toBe('Codex’s default');
    // Cursor's model names carry their effort; its default, Auto, is Cursor choosing for itself
    expect(runsWithText(cursor, '', '')).toBe('Auto: Cursor chooses the model');
    expect(runsWithText(cursor, 'auto', '')).toBe('Auto: Cursor chooses the model');
    expect(runsWithText(cursor, 'composer-2.5', 'high')).toBe('Composer-2.5');
    // one that doesn't say its default
    expect(runsWithText({ ...codex, defaultModel: undefined }, '', '')).toBe('Codex’s default model and effort');
    expect(runsWithText({ ...cursor, defaultModel: undefined }, '', '')).toBe('Cursor’s default model');
  });

  it('runs with the default when what’s saved is no longer offered, as the adapter does', () => {
    expect(runsWith(codex, 'gpt-4', 'ultra')).toEqual({
      model: 'gpt-6.1-sol',
      effort: 'low',
      effortInModel: false,
      defaultModel: true,
      defaultEffort: true,
    });
    // an empty list says nothing: a typed model is passed on
    expect(runsWith({ ...codex, models: [] }, 'gpt-4', '').model).toBe('gpt-4');
  });

  it('asks for Claude Code’s model and effort until both are chosen: it has no defaults', () => {
    expect(toChoose(claude, '', '')).toBe('a model and an effort');
    expect(runsWithText(claude, '', '')).toBe('Choose a model and an effort first');
    expect(runsWithText(claude, 'sonnet', '')).toBe('Choose an effort first');
    expect(runsWithText(claude, '', 'high')).toBe('Choose a model first');
    // one saved that it no longer offers is as good as none, as the server and the runner take it
    expect(toChoose(claude, 'opus-4', 'ultra')).toBe('a model and an effort');
    expect(toChoose(claude, 'sonnet', 'high')).toBeNull();
    expect(runsWithText(claude, 'sonnet', 'high')).toBe('Sonnet at high effort');
    // the harnesses with defaults have nothing to choose
    expect(toChoose(codex, '', '')).toBeNull();
    expect(toChoose(cursor, '', '')).toBeNull();
  });

  it('says what an alias stands for now (opus moves on with each new Opus)', () => {
    expect(runsWithText(ranClaude, 'opus', 'high')).toBe('Opus at high effort (now claude-opus-test)');
    const versioned: HarnessInfo = { ...claude, aliases: { opus: 'claude-opus-9-1' } };
    expect(runsWithText(versioned, 'opus', 'high')).toBe('Opus at high effort (now Opus 9.1)');
    // a name not run yet: nothing from a run
    expect(runsWithText(ranClaude, 'sonnet', 'high')).toBe('Sonnet at high effort');
  });
});

describe('an install as the studio hears of it', () => {
  it('shows one under way after a reload, and follows it to its end', () => {
    const installing: HarnessEvent = {
      harness: 'cursor',
      kind: 'install',
      state: 'running',
      line: 'Installing Cursor on studio-pc',
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
