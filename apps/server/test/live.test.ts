import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { GONE, Live, NO_ANSWER, type RenderJob } from '../src/live.ts';

const KEY = 'ab'.repeat(32);

/** A connection as Live sees one: messages in, what it was sent kept. */
class FakeSocket extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  sent: Record<string, unknown>[] = [];
  send(data: string): void {
    this.sent.push(JSON.parse(data) as Record<string, unknown>);
  }
  say(msg: Record<string, unknown>): void {
    this.emit('message', Buffer.from(JSON.stringify(msg)));
  }
  close(): void {
    this.readyState = 3;
    this.emit('close');
  }
  got(type: string): Record<string, unknown>[] {
    return this.sent.filter((m) => m.type === type);
  }
}

const caps = { render: true, agent: true };
/** What a runner from before the agent bar said it could do: Scan's old AI buttons too. */
const oldCaps = { render: true, ai: { claude: '/usr/bin/claude', version: '2.0.0', skill: true }, agent: true };

function setup(key: string | null = KEY) {
  const lines: string[] = [];
  const live = new Live({ key, log: (line) => lines.push(line) });
  const connect = (hello: Record<string, unknown>) => {
    const ws = new FakeSocket();
    live.attach(ws as unknown as WebSocket);
    ws.say({ type: 'hello', ...hello });
    return ws;
  };
  const runner = (name: string, key?: string, says: Record<string, unknown> = caps) =>
    connect({ role: 'runner', name, caps: says, ...(key ? { key } : {}) });
  // a studio with the song open, to hear how jobs go
  const studio = connect({ role: 'editor', name: 'studio' });
  studio.say({ type: 'state', state: { project: 'prj_song', revision: 1 } });
  return { live, lines, runner, connect, studio };
}

let n = 0;
const renderJob = (): RenderJob => ({
  id: `rnd_${++n}`,
  project: 'prj_song',
  creation: 'game',
  piece: 'theme',
  title: 'Theme',
  state: 'waiting',
  started: Date.now(),
  finished: null,
  lines: [],
  error: null,
});

const names = (clients: { name: string }[]) => clients.map((c) => c.name);

describe('runners and the runner key', () => {
  it('still hands a runner without the key its renders, but no agent job', () => {
    const { live, lines, runner } = setup();
    const old = runner('old runner');
    expect(live.runner()).toBe(true);

    const render = renderJob();
    expect(live.render(render)).toBe(true);
    expect(old.got('render')).toEqual([
      { type: 'render', id: render.id, creation: 'game', piece: 'theme', project: 'prj_song' },
    ]);
    old.say({ type: 'render-progress', id: render.id, line: 'rendering' });
    expect(render.state).toBe('running');
    old.say({ type: 'render-done', id: render.id });
    expect(render.state).toBe('done');

    // a current runner (it runs the agent's jobs) that didn't say the key: it couldn't read it
    expect(live.runners()).toEqual({ connected: true, keyed: false, state: 'no-key', host: null });
    expect(live.agentRunners()).toEqual([]);
    // the server says why, once
    runner('another old runner');
    expect(lines).toEqual(['A runner without the key connected: restart it with the current HO[LO] to use the agent']);
  });

  it('trusts a runner with the key, not one without', () => {
    const { live, lines, runner } = setup();
    runner('old runner');
    runner('keyed runner', KEY);
    expect(live.runners()).toEqual({ connected: true, keyed: true, state: 'ready', host: null });
    expect(names(live.keyedRunners())).toEqual(['keyed runner']);
    expect(names(live.agentRunners())).toEqual(['keyed runner']);
    expect(lines).toHaveLength(1);
  });

  it('treats a wrong key as none, and with no key of its own trusts no runner', () => {
    const wrong = setup();
    wrong.runner('stale runner', 'cd'.repeat(32));
    expect(wrong.live.keyedRunners()).toEqual([]);
    expect(wrong.live.runners().state).toBe('wrong-key');
    expect(wrong.lines[0]).toMatch(/wrong key/);

    const keyless = setup(null);
    keyless.runner('runner', KEY);
    expect(keyless.live.runners()).toMatchObject({ connected: true, keyed: false });
    expect(keyless.live.agentRunners()).toEqual([]);
  });

  it('counts a keyed runner only while it is connected', () => {
    const { live, runner, connect } = setup();
    const keyed = runner('keyed runner', KEY);
    expect(live.runners().keyed).toBe(true);
    keyed.close();
    expect(live.runners()).toEqual({ connected: false, keyed: false, state: 'none', host: null });

    // one with the key that doesn't run the agent's jobs: keyed, but no agent runner
    connect({ role: 'runner', name: 'bare runner', key: KEY, caps: { render: true } });
    expect(names(live.keyedRunners())).toEqual(['bare runner']);
    expect(live.agentRunners()).toEqual([]);
  });

  it('says how the runners stand: one from before keys is old, and the keyed one counts', () => {
    const { live, runner } = setup();
    runner('runner on old-box', undefined, { render: true });
    expect(live.runners()).toEqual({ connected: true, keyed: false, state: 'old', host: 'old-box' });
    runner('runner on desk-2.local', KEY);
    expect(live.runners()).toEqual({ connected: true, keyed: true, state: 'ready', host: 'desk-2.local' });
    // a name that isn't a host's names none
    const other = setup();
    other.runner('runner on <script>', KEY);
    expect(other.live.runners().host).toBeNull();
  });

  it('knows its runner key, and nothing else', () => {
    const { live } = setup();
    expect(live.isRunnerKey(KEY)).toBe(true);
    for (const v of ['cd'.repeat(32), '', undefined, null, 42, [KEY], 'x'.repeat(300)])
      expect(live.isRunnerKey(v)).toBe(false);
    expect(setup(null).live.isRunnerKey(KEY)).toBe(false);
  });

  it('forgets the key when a connection says hello again as something else', () => {
    const { live, connect } = setup();
    const ws = connect({ role: 'runner', name: 'runner', caps, key: KEY });
    expect(live.runners().keyed).toBe(true);
    ws.say({ type: 'hello', role: 'remote', name: 'phone' });
    expect(live.runners()).toEqual({ connected: false, keyed: false, state: 'none', host: null });
  });

  it('ignores what an older runner says of Scan’s old AI buttons', () => {
    const { live, runner, studio } = setup();
    const old = runner('older runner', KEY, oldCaps);
    // its other caps still count; its word on Claude Code is left out
    expect(names(live.agentRunners())).toEqual(['older runner']);
    expect(live.keyedRunners()[0]?.caps).toEqual({ render: true, agent: true });

    const before = studio.sent.length;
    for (const type of ['job-progress', 'job-done', 'job-failed', 'ai', 'ai-cancel', 'ai-status']) {
      expect(() => old.say({ type, id: 'job_abc123def', line: 'reading', summary: 'done', error: 'no' })).not.toThrow();
    }
    // nothing reached the studio, and the runner still renders
    expect(studio.sent.length).toBe(before);
    expect(studio.got('ai-status')).toEqual([]);
    const render = renderJob();
    expect(live.render(render)).toBe(true);
    old.say({ type: 'render-done', id: render.id });
    expect(render.state).toBe('done');
    old.close();
    expect(studio.got('ai-status')).toEqual([]);
  });
});

describe('asking a studio', () => {
  it('asked to hear at once, a studio that goes answers GONE; otherwise the request waits for its time', async () => {
    const { live, studio } = setup();
    const editor = live.editor('prj_song');
    if (!editor) throw new Error('no studio');
    const early = live.request(editor, { type: 'agent-ops' }, 60_000, true);
    const plain = live.request(editor, { type: 'ops' }, 50);
    expect(studio.got('agent-ops')).toHaveLength(1);
    studio.close();
    expect(await early).toEqual({ ok: false, error: GONE });
    // (the command line's requests are as they were: no answer, at their timeout)
    expect(await plain).toEqual({ ok: false, error: NO_ANSWER });
    // asked once it has gone: GONE at once, nothing sent
    expect(await live.request(editor, { type: 'agent-ops' }, 60_000, true)).toEqual({ ok: false, error: GONE });
    expect(studio.got('agent-ops')).toHaveLength(1);
  });
});
