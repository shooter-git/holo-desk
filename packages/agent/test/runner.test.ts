import { existsSync, mkdirSync, statSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { claudeHarness } from '../src/harness/claude.ts';
import type { Harness, HarnessEvent, HarnessId, HarnessInfo, Job, RunEvent } from '../src/harness/types.ts';
import { parseRun, readInstructions, startAgentRunner, withoutInstructions } from '../src/runner.ts';
import { fakeBinary, REPO, recorded, replay, type Sandbox, sandbox, until } from './fakes.ts';

const TOKEN = 'runner-test-token-abcdefghijklmnopqrstuvwxyz0123';
const SECRET_WORDS = 'SECRET-REQUEST-WORDS';

let s: Sandbox;
afterEach(() => s?.cleanup());

/** A harness whose runs the test drives by hand. */
function stub(id: HarnessId, o: { delayInfo?: number } = {}) {
  const runs: { job: Job; on: (e: RunEvent) => void; finish: () => void; cancelled: boolean }[] = [];
  const logins: ((e: HarnessEvent) => void)[] = [];
  const codes: string[] = [];
  let infoCalls = 0;
  const h: Harness = {
    id,
    name: id === 'claude' ? 'Claude Code' : id === 'codex' ? 'Codex' : 'Cursor',
    detect: async () => ({ path: `/bin/${id}`, prefix: [] }),
    async info(): Promise<HarnessInfo> {
      infoCalls++;
      if (o.delayInfo) await new Promise((ok) => setTimeout(ok, o.delayInfo));
      return { id, name: h.name, found: true, sealed: true, version: `1.${infoCalls}` };
    },
    authStatus: async () => ({ signedIn: false }),
    login(on) {
      logins.push(on);
      on({ state: 'running', url: 'https://example.com/login', ask: 'code' });
      // the user hasn't finished signing in yet
      return new Promise<void>(() => undefined);
    },
    loginCode(code) {
      if (!logins.length) return false;
      codes.push(code);
      return true;
    },
    checkUpdate: async () => null,
    async update(onLine) {
      onLine('updating…');
    },
    models: async () => [],
    efforts: async () => [],
    run(job, on) {
      let finish: () => void = () => undefined;
      const done = new Promise<void>((ok) => {
        finish = ok;
      });
      const r = { job, on, finish, cancelled: false };
      runs.push(r);
      return {
        done,
        cancel() {
          r.cancelled = true;
          finish();
        },
      };
    },
  };
  return { h, runs, codes, infoCalls: () => infoCalls };
}

function runner(over: { delayInfo?: number } = {}) {
  const sent: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const claude = stub('claude', over);
  const codex = stub('codex', over);
  const cursor = stub('cursor', over);
  const r = startAgentRunner({
    base: 'http://127.0.0.1:47998',
    send: (m) => sent.push(m),
    repo: REPO,
    log: (l) => logs.push(l),
    harnesses: { claude: claude.h, codex: codex.h, cursor: cursor.h },
    root: s.root,
    env: s.env,
    middleC: async () => 'C4',
  });
  return { r, sent, logs, claude, codex, cursor };
}

const run = (n: number, over: Record<string, unknown> = {}) => ({
  type: 'agent-run',
  job: `agj_00000000000${n}`,
  thread: `agt_00000000000${n}`,
  harness: 'claude',
  model: 'haiku',
  effort: 'low',
  prompt: `${SECRET_WORDS} ${n}`,
  token: TOKEN,
  workspace: `agt_00000000000${n}`,
  base: 'http://elsewhere.example:1',
  ...over,
});

describe('the agent runner', () => {
  it('prints the pairing code clearly, and nothing for a code that isn’t one', () => {
    s = sandbox();
    const { r, logs } = runner();
    expect(r.handle({ type: 'pairing-code', code: '123456', expires: Date.now() + 10 * 60_000 })).toBe(true);
    expect(logs).toEqual(['Agent pairing code: 123456 (enter it in Settings › Agent; valid for 10 minutes)']);
    r.handle({ type: 'pairing-code', code: '12; rm -rf ~', expires: 0 });
    expect(logs).toHaveLength(1);
    expect(r.handle({ type: 'render', id: 'x' })).toBe(false);
  });

  it('says which harnesses are here without holding up the socket, and again from memory on reconnecting', async () => {
    s = sandbox();
    const { r, sent, claude } = runner({ delayInfo: 50 });
    r.connected();
    // nothing yet: the look goes on in the background
    expect(sent).toEqual([]);
    await until(() => sent.length > 0);
    expect(sent[0]).toMatchObject({ type: 'harnesses', list: [{ id: 'claude' }, { id: 'codex' }, { id: 'cursor' }] });
    r.connected();
    expect(sent).toHaveLength(2);
    expect(claude.infoCalls()).toBe(1);
    // asked to look again: a fresh look, and each harness says it's done
    r.handle({ type: 'agent-refresh' });
    await until(() => sent.filter((m) => m.type === 'agent-harness').length === 3);
    expect(claude.infoCalls()).toBe(2);
    expect(sent.filter((m) => m.type === 'agent-harness')[0]).toEqual({
      type: 'agent-harness',
      harness: 'claude',
      kind: 'refresh',
      state: 'done',
    });
  });

  it('runs a job and reports it: progress, session, done; the token in the workspace only while it runs', async () => {
    s = sandbox();
    const { r, sent, logs, claude } = runner();
    r.handle(run(1));
    await until(() => claude.runs.length === 1);
    const { job, on, finish } = claude.runs[0] as (typeof claude.runs)[0];
    expect(job).toMatchObject({
      id: 'agj_000000000001',
      thread: 'agt_000000000001',
      model: 'haiku',
      effort: 'low',
      prompt: `${SECRET_WORDS} 1`,
      // the job's tools reach the server the runner is connected to, not one a message names
      base: 'http://127.0.0.1:47998',
      middleC: 'C4',
    });
    expect(job.workspace).toBe(join(s.root, 'agt_000000000001'));
    expect(statSync(job.workspace).mode & 0o777).toBe(0o700);
    expect(statSync(join(job.workspace, '.holo-job')).mode & 0o777).toBe(0o600);
    on({ type: 'session', session: 'sess-1' });
    on({ type: 'progress', line: 'x'.repeat(300) });
    on({ type: 'done' });
    finish();
    await until(() => r.busy().running === 0);
    expect(sent.filter((m) => m.type !== 'harnesses')).toEqual([
      { type: 'agent-session', job: 'agj_000000000001', session: 'sess-1' },
      { type: 'agent-progress', job: 'agj_000000000001', line: 'x'.repeat(200) },
      { type: 'agent-done', job: 'agj_000000000001' },
    ]);
    expect(existsSync(join(job.workspace, '.holo-job'))).toBe(false);
    // neither the token nor the request is ever printed
    expect(logs.join('\n')).not.toContain(TOKEN);
    expect(logs.join('\n')).not.toContain(SECRET_WORDS);
  });

  it('refuses a job HO[LO] couldn’t have made', () => {
    s = sandbox();
    const { r, sent, claude } = runner();
    const bad = [
      run(1, { token: 'short' }),
      run(2, { workspace: '../../etc' }),
      run(3, { thread: '../x' }),
      run(4, { model: 'haiku --dangerously-skip-permissions' }),
      run(5, { effort: '$(rm -rf ~)' }),
      run(6, { harness: 'bash' }),
      run(7, { session: '--tools=Bash' }),
      run(8, { prompt: '' }),
    ];
    for (const m of bad) r.handle(m);
    expect(claude.runs).toHaveLength(0);
    expect(sent.map((m) => m.type)).toEqual(Array(bad.length).fill('agent-failed'));
    expect(parseRun(run(9, { workspace: undefined }))).toMatchObject({ job: 'agj_000000000009' });
  });

  it('runs at most two jobs at once, one per thread; the rest wait their turn', async () => {
    s = sandbox();
    const { r, claude, codex } = runner();
    r.handle(run(1));
    r.handle(run(2, { thread: 'agt_000000000001', workspace: 'agt_000000000001' }));
    r.handle(run(3, { harness: 'codex' }));
    r.handle(run(4));
    await until(() => claude.runs.length + codex.runs.length === 2);
    expect(r.busy()).toEqual({ running: 2, waiting: 2 });
    // job 2 waits for its thread even when a slot frees
    expect(claude.runs.map((x) => x.job.id)).toEqual(['agj_000000000001']);
    expect(codex.runs.map((x) => x.job.id)).toEqual(['agj_000000000003']);
    codex.runs[0]?.finish();
    await until(() => claude.runs.length === 2);
    expect(claude.runs.map((x) => x.job.id)).toEqual(['agj_000000000001', 'agj_000000000004']);
    claude.runs[0]?.finish();
    await until(() => claude.runs.length === 3);
    expect(claude.runs[2]?.job.id).toBe('agj_000000000002');
  });

  it('stops a job when the server cancels it, and drops one still waiting, without a word back', async () => {
    s = sandbox();
    const { r, sent, claude } = runner();
    r.handle(run(1));
    r.handle(run(2));
    r.handle(run(3));
    await until(() => claude.runs.length === 2);
    r.handle({ type: 'agent-cancel', job: 'agj_000000000003' });
    r.handle({ type: 'agent-cancel', job: 'agj_000000000001' });
    await until(() => r.busy().running === 1);
    expect(claude.runs[0]?.cancelled).toBe(true);
    expect(r.busy()).toEqual({ running: 1, waiting: 0 });
    expect(sent.filter((m) => m.type === 'agent-failed')).toEqual([]);
  });

  it('relays a sign-in and its pasted code; refuses one while the harness works', async () => {
    s = sandbox();
    const { r, sent, claude, codex } = runner();
    r.handle({ type: 'agent-login', harness: 'codex' });
    await until(() => sent.some((m) => m.type === 'agent-harness'));
    expect(sent.find((m) => m.type === 'agent-harness')).toEqual({
      type: 'agent-harness',
      harness: 'codex',
      kind: 'login',
      state: 'running',
      url: 'https://example.com/login',
      ask: 'code',
    });
    r.handle({ type: 'agent-login-code', harness: 'codex', code: ' abc#def ' });
    expect(codex.codes).toEqual(['abc#def']);
    // no sign-in waits on Cursor
    r.handle({ type: 'agent-login-code', harness: 'cursor', code: 'x' });
    expect(sent.at(-1)).toEqual({
      type: 'agent-harness',
      harness: 'cursor',
      kind: 'login',
      state: 'failed',
      error: 'No sign-in is waiting for a code',
    });
    r.handle(run(1));
    await until(() => claude.runs.length === 1);
    r.handle({ type: 'agent-login', harness: 'claude' });
    await until(() => sent.at(-1)?.state === 'failed');
    expect(sent.at(-1)).toMatchObject({
      harness: 'claude',
      kind: 'login',
      error: 'Claude Code is busy: try once it’s done',
    });
  });

  it('runs an update only when asked, and says what it found after', async () => {
    s = sandbox();
    const { r, sent } = runner();
    r.handle({ type: 'agent-update', harness: 'cursor' });
    await until(() => sent.some((m) => m.type === 'harnesses'));
    expect(sent.filter((m) => m.type === 'agent-harness').map((m) => [m.state, m.line ?? ''])).toEqual([
      ['running', 'Updating Cursor'],
      ['running', 'updating…'],
      ['done', ''],
    ]);
  });
});

describe('the agent runner with a real adapter', () => {
  it('runs Claude Code in the thread’s workspace with the instructions there, not twice in the prompt', async () => {
    s = sandbox();
    const instructions = readInstructions(REPO);
    expect(instructions).toContain('HO[LO] Desk');
    const path = fakeBinary(
      s,
      'claude',
      [
        { when: '--version', run: 'echo "2.1.322 (Claude Code)"; exit 0' },
        { when: '--help', run: 'exit 0' },
      ],
      `${replay('claude-normal')}\nexit 0`,
    );
    const env = { ...s.env, HOLO_CLAUDE: path };
    const sent: Record<string, unknown>[] = [];
    const harnesses = {
      claude: claudeHarness({ env, root: s.root, repo: REPO }),
    } as unknown as Record<HarnessId, Harness>;
    const r = startAgentRunner({
      base: 'http://127.0.0.1:47998',
      send: (m) => sent.push(m),
      repo: REPO,
      log: () => undefined,
      harnesses,
      root: s.root,
      env,
      middleC: async () => 'C3',
    });
    const request = `## The request\n${SECRET_WORDS}: add a marker at bar 3\n`;
    r.handle(run(1, { prompt: `${instructions}\n\n${request}` }));
    await until(() => sent.some((m) => m.type === 'agent-done' || m.type === 'agent-failed'));
    expect(sent.map((m) => m.type)).toEqual(['agent-session', 'agent-progress', 'agent-done']);
    const rec = recorded(s);
    expect(rec.stdin).toBe(request);
    expect(rec.tokenMode).toBe('600');
    expect(rec.token).toBe(TOKEN);
    expect(rec.argv.join(' ')).not.toContain(TOKEN);
    expect(rec.argv.join(' ')).not.toContain(SECRET_WORDS);
    const ws = join(s.root, 'agt_000000000001');
    expect(rec.argv).toContain(`--append-system-prompt-file=${join(ws, 'instructions.md')}`);
    await until(() => !existsSync(join(ws, '.holo-job')));
  });

  it('leaves a prompt whose instructions differ as it is', () => {
    expect(withoutInstructions('Rules A\n\n## The request\nhi', 'Rules A')).toBe('## The request\nhi');
    expect(withoutInstructions('Rules B\n\n## The request\nhi', 'Rules A')).toBe('Rules B\n\n## The request\nhi');
    expect(withoutInstructions('## The request\nhi', null)).toBe('## The request\nhi');
  });

  it('refuses a workspace that’s a link to somewhere else', async () => {
    s = sandbox();
    const { r, sent } = runner();
    mkdirSync(s.root, { recursive: true });
    const elsewhere = join(s.dir, 'elsewhere');
    mkdirSync(elsewhere);
    symlinkSync(elsewhere, join(s.root, 'agt_000000000001'));
    r.handle(run(1));
    await until(() => sent.some((m) => m.type === 'agent-failed'));
    expect(existsSync(join(elsewhere, '.holo-job'))).toBe(false);
  });
});
