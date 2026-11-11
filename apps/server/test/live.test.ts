import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { WebSocket } from 'ws';
import { type AiJob, Live, type RenderJob } from '../src/live.ts';

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

const caps = { render: true, ai: { claude: '/usr/bin/claude', version: '2.0.0', skill: true } };

function setup(key: string | null = KEY) {
  const lines: string[] = [];
  const live = new Live({ key, log: (line) => lines.push(line) });
  const connect = (hello: Record<string, unknown>) => {
    const ws = new FakeSocket();
    live.attach(ws as unknown as WebSocket);
    ws.say({ type: 'hello', ...hello });
    return ws;
  };
  const runner = (name: string, key?: string) => connect({ role: 'runner', name, caps, ...(key ? { key } : {}) });
  // a studio with the song open, to hear how jobs go
  const studio = connect({ role: 'editor', name: 'studio' });
  studio.say({ type: 'state', state: { project: 'prj_song', revision: 1 } });
  return { live, lines, runner, connect, studio };
}

let n = 0;
const aiJob = (): AiJob => ({
  id: `job_${++n}`,
  task: 'read',
  scan: 'scn_0a1b2c3d4e5f',
  project: 'prj_song',
  state: 'waiting',
  started: Date.now(),
  finished: null,
  lines: [],
  summary: null,
  error: null,
});
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

describe('runners and the runner key', () => {
  it('still hands a runner without the key its renders, but no AI job', () => {
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

    expect(live.aiStatus()).toEqual({ available: false, reason: 'no-runner' });
    const job = aiJob();
    expect(live.ai(job)).toBe(false);
    expect(old.got('ai')).toEqual([]);
    // the server says why, once
    runner('another old runner');
    expect(lines).toEqual(['A runner without the key connected: restart it with the current HO[LO] to use the agent']);
  });

  it('hands the AI job to a runner with the key, not to one without', () => {
    const { live, lines, runner } = setup();
    const old = runner('old runner');
    const keyed = runner('keyed runner', KEY);
    expect(live.aiStatus()).toEqual({ available: true, version: '2.0.0' });

    const job = aiJob();
    expect(live.ai(job)).toBe(true);
    expect(keyed.got('ai')).toEqual([{ type: 'ai', id: job.id, task: 'read', scan: job.scan, project: 'prj_song' }]);
    expect(old.got('ai')).toEqual([]);
    expect(lines).toHaveLength(1);

    // a cancel goes to that runner alone
    expect(live.aiCancel(job.id)).toBe(true);
    expect(keyed.got('ai-cancel')).toEqual([{ type: 'ai-cancel', id: job.id }]);
    expect(old.got('ai-cancel')).toEqual([]);
  });

  it('treats a wrong key as none, and with no key of its own trusts no runner', () => {
    const wrong = setup();
    wrong.runner('stale runner', 'cd'.repeat(32));
    expect(wrong.live.aiStatus()).toEqual({ available: false, reason: 'no-runner' });
    expect(wrong.lines[0]).toMatch(/wrong key/);

    const keyless = setup(null);
    keyless.runner('runner', KEY);
    expect(keyless.live.aiStatus()).toEqual({ available: false, reason: 'no-runner' });
    expect(keyless.live.ai(aiJob())).toBe(false);
  });

  it('takes a job’s progress and its end only from the runner it was handed to', () => {
    const { live, runner, connect, studio } = setup();
    const assigned = runner('keyed runner', KEY);
    const job = aiJob();
    expect(live.ai(job)).toBe(true);

    // another runner, even one with the key, a runner without it, and a page posing as one
    const other = runner('other keyed runner', KEY);
    const old = runner('old runner');
    const studioAsRunner = connect({ role: 'editor', name: 'impostor' });
    for (const ws of [other, old, studioAsRunner]) {
      ws.say({ type: 'job-progress', id: job.id, line: 'spoofed' });
      ws.say({ type: 'job-done', id: job.id, summary: 'spoofed' });
      ws.say({ type: 'job-failed', id: job.id, error: 'spoofed' });
    }
    expect(job).toMatchObject({ state: 'waiting', lines: [], summary: null, error: null, finished: null });
    const told = studio.got('ai-status').length;

    assigned.say({ type: 'job-progress', id: job.id, line: 'reading system 1' });
    expect(job).toMatchObject({ state: 'running', lines: ['reading system 1'] });
    assigned.say({ type: 'job-done', id: job.id, summary: 'Read 4 systems' });
    expect(job).toMatchObject({ state: 'done', summary: 'Read 4 systems' });
    expect(studio.got('ai-status').length).toBe(told + 2);
  });

  it('reports the AI as available only while a runner with the key is connected', () => {
    const { live, runner, connect, studio } = setup();
    expect(live.aiStatus()).toEqual({ available: false, reason: 'no-runner' });
    runner('old runner');
    expect(live.aiStatus()).toEqual({ available: false, reason: 'no-runner' });

    const keyed = runner('keyed runner', KEY);
    expect(live.aiStatus().available).toBe(true);
    const job = aiJob();
    expect(live.ai(job)).toBe(true);

    // gone: its job can't finish, and the studio hears so
    keyed.close();
    expect(live.aiStatus()).toEqual({ available: false, reason: 'no-runner' });
    expect(job).toMatchObject({ state: 'failed', error: 'The runner disconnected' });
    expect(studio.got('ai-status').at(-1)).toMatchObject({ job: { id: job.id, state: 'failed' } });

    // one with the key but no Claude Code: there's a runner, Claude is what's missing
    connect({ role: 'runner', name: 'bare runner', key: KEY, caps: { render: true } });
    expect(live.aiStatus()).toEqual({ available: false, reason: 'no-claude' });
  });

  it('forgets the key when a connection says hello again as something else', () => {
    const { live, connect } = setup();
    const ws = connect({ role: 'runner', name: 'runner', caps, key: KEY });
    expect(live.aiStatus().available).toBe(true);
    ws.say({ type: 'hello', role: 'remote', name: 'phone' });
    expect(live.aiStatus()).toEqual({ available: false, reason: 'no-runner' });
  });
});
