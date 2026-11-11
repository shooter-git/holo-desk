import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { Live, type RenderJob } from '../src/live.ts';

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

    expect(live.runners()).toEqual({ connected: true, keyed: false });
    expect(live.agentRunners()).toEqual([]);
    // the server says why, once
    runner('another old runner');
    expect(lines).toEqual(['A runner without the key connected: restart it with the current HO[LO] to use the agent']);
  });

  it('trusts a runner with the key, not one without', () => {
    const { live, lines, runner } = setup();
    runner('old runner');
    runner('keyed runner', KEY);
    expect(live.runners()).toEqual({ connected: true, keyed: true });
    expect(names(live.keyedRunners())).toEqual(['keyed runner']);
    expect(names(live.agentRunners())).toEqual(['keyed runner']);
    expect(lines).toHaveLength(1);
  });

  it('treats a wrong key as none, and with no key of its own trusts no runner', () => {
    const wrong = setup();
    wrong.runner('stale runner', 'cd'.repeat(32));
    expect(wrong.live.keyedRunners()).toEqual([]);
    expect(wrong.lines[0]).toMatch(/wrong key/);

    const keyless = setup(null);
    keyless.runner('runner', KEY);
    expect(keyless.live.runners()).toEqual({ connected: true, keyed: false });
    expect(keyless.live.agentRunners()).toEqual([]);
  });

  it('counts a keyed runner only while it is connected', () => {
    const { live, runner, connect } = setup();
    const keyed = runner('keyed runner', KEY);
    expect(live.runners().keyed).toBe(true);
    keyed.close();
    expect(live.runners()).toEqual({ connected: false, keyed: false });

    // one with the key that doesn't run the agent's jobs: keyed, but no agent runner
    connect({ role: 'runner', name: 'bare runner', key: KEY, caps: { render: true } });
    expect(names(live.keyedRunners())).toEqual(['bare runner']);
    expect(live.agentRunners()).toEqual([]);
  });

  it('forgets the key when a connection says hello again as something else', () => {
    const { live, connect } = setup();
    const ws = connect({ role: 'runner', name: 'runner', caps, key: KEY });
    expect(live.runners().keyed).toBe(true);
    ws.say({ type: 'hello', role: 'remote', name: 'phone' });
    expect(live.runners()).toEqual({ connected: false, keyed: false });
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
