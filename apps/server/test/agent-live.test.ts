import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentApp, agentWorld, auth, type Msg, note, until, waitFor } from './agent-fakes.ts';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await close?.();
  close = null;
});

async function setup() {
  const w = await agentWorld();
  close = w.close;
  return w;
}

/** A pending answer, and whether it has come. */
function pending<T>(p: Promise<T>) {
  const out = { done: false, value: null as T | null, promise: p };
  void p.then((v) => {
    out.done = true;
    out.value = v;
  });
  return out;
}

describe('the song’s conversation after a reload', () => {
  it('keeps what each turn asked, its brief and why it stopped, with the job running or waiting', async () => {
    const { app, start, tool, run, s, token, desk, status } = await setup();
    const thread = async () =>
      (await app.inject({ method: 'GET', url: `/api/agent/threads/${s.id}`, headers: auth(token) })).json() as {
        thread: { turns: Msg[] };
        job: Msg | null;
      };

    const first = await start({ project: s.id, text: 'Make the mixer wider' });
    expect((await thread()).job).toMatchObject({ id: first.job, state: 'waiting', request: 'Make the mixer wider' });
    await tool(first.job, first.token, 'POST', '/handoff', { brief: 'Widen the mixer.\nRun `pnpm test`.' });
    await tool(first.job, first.token, 'POST', '/permission', { kind: 'screen', detail: 'To see the mixer' });
    await tool(first.job, first.token, 'POST', '/finish', { label: 'Mixer brief', reply: 'The brief is ready.' });
    run.say({ type: 'agent-done', job: first.job });
    await waitFor(() => status(desk, first.job)?.state === 'awaiting');

    const after = await thread();
    expect(after.job).toMatchObject({
      id: first.job,
      state: 'awaiting',
      permission: { kind: 'screen', detail: 'To see the mixer' },
      brief: 'Widen the mixer.\nRun `pnpm test`.',
      briefWarnings: [{ line: 1, kind: 'command' }],
    });
    expect(after.thread.turns).toEqual([
      {
        job: first.job,
        request: 'Make the mixer wider',
        reply: 'The brief is ready.',
        label: 'Mixer brief',
        state: 'awaiting',
        at: expect.any(Number),
        permission: { kind: 'screen', detail: 'To see the mixer' },
        brief: 'Widen the mixer.\nRun `pnpm test`.',
        briefWarnings: [{ line: 1, kind: 'command' }],
      },
    ]);

    // a new request passes over the question; Stop says why it ended
    const second = await start({ project: s.id, text: 'A bass line' });
    await app.inject({ method: 'POST', url: `/api/agent/jobs/${second.job}/cancel`, headers: auth(token) });
    const last = await thread();
    expect(last.job).toBeNull();
    expect(last.thread.turns.map((t) => [t.state, t.error ?? null])).toEqual([
      ['done', null],
      ['cancelled', 'Stopped'],
    ]);
  });
});

describe('settings, as they change', () => {
  it('tells every studio whether the agent is on, and allowed devices the rest', async () => {
    const t = await agentApp();
    close = t.close;
    const run = t.runner();
    // a studio open before the first device paired
    const before = t.studio(null, null, 'before');
    const { token } = await t.pair(run);
    expect(before.got('agent-settings')).toEqual([{ type: 'agent-settings', enabled: true }]);

    const desk = t.studio(token, null, 'desk');
    const outsider = t.studio(null, null, 'outsider');
    const put = (payload: Msg) =>
      t.app.inject({ method: 'PUT', url: '/api/agent/settings', headers: auth(token), payload });

    await put({ enabled: false });
    expect(outsider.got('agent-settings')).toEqual([{ type: 'agent-settings', enabled: false }]);
    expect(desk.got('agent-settings')).toEqual([
      {
        type: 'agent-settings',
        enabled: false,
        harness: null,
        model: '',
        relays: [],
        effort: '',
        harnesses: [expect.objectContaining({ id: 'claude', found: true })],
      },
    ]);
    await put({ enabled: true });
    expect(outsider.got('agent-settings').at(-1)).toEqual({ type: 'agent-settings', enabled: true });

    // the harness, model or effort: allowed devices alone
    const seen = outsider.got('agent-settings').length;
    await put({ model: 'opus', effort: 'high', harness: 'claude' });
    expect(desk.got('agent-settings').at(-1)).toMatchObject({
      enabled: true,
      harness: 'claude',
      model: 'opus',
      effort: 'high',
    });
    expect(outsider.got('agent-settings')).toHaveLength(seen);
    // nothing changed: nothing said
    const told = desk.got('agent-settings').length;
    await put({ model: 'opus' });
    expect(desk.got('agent-settings')).toHaveLength(told);
  });

  it('sends allowed devices the harnesses as the runners report them', async () => {
    const { runner, desk, studio } = await setup();
    const outsider = studio(null, null, 'outsider');
    const codex = runner([{ id: 'codex', name: 'Codex', found: true, sealed: true, version: '0.50.0' }], 'second');
    const last = desk.got('agent-settings').at(-1) as { harnesses: Msg[] };
    expect(last.harnesses.map((h) => h.id)).toEqual(['claude', 'codex']);
    codex.say({
      type: 'harnesses',
      list: [{ id: 'codex', name: 'Codex', found: true, sealed: true, version: '0.51.0' }],
    });
    expect(desk.got('agent-settings').at(-1)).toMatchObject({
      harnesses: [
        expect.objectContaining({ id: 'claude' }),
        expect.objectContaining({ id: 'codex', version: '0.51.0' }),
      ],
    });
    // its runner gone, so are its harnesses
    codex.close();
    expect((desk.got('agent-settings').at(-1) as { harnesses: Msg[] }).harnesses.map((h) => h.id)).toEqual(['claude']);
    expect(outsider.got('agent-settings')).toEqual([]);
  });
});

describe('listening', () => {
  it('hears only the requester’s studio, and ends on a quiet spell after a note', async () => {
    const { start, tool, s, token, desk, admit, studio } = await setup();
    const phone = await admit(token);
    const phoneStudio = studio(phone.token, s.id, 'phone');
    const outsider = studio(null, s.id, 'outsider');
    const { job, token: jobToken } = await start({ project: s.id, text: 'Write down what I play' });
    expect((await tool(job, jobToken, 'POST', '/listen', { maxMs: 50_000, quietMs: 1000 })).statusCode).toBe(400);
    expect((await tool(job, jobToken, 'POST', '/listen', { maxMs: 10_000, quietMs: 100 })).statusCode).toBe(400);

    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const heard = pending(tool(job, jobToken, 'POST', '/listen', { maxMs: 45_000, quietMs: 1000 }));
    await until(() => desk.got('agent-listen').length > 0);
    expect(desk.got('agent-listen')).toEqual([{ type: 'agent-listen', job, state: 'on' }]);
    expect(phoneStudio.got('agent-listen')).toEqual([]);
    expect((await tool(job, jobToken, 'POST', '/listen', { maxMs: 1000, quietMs: 500 })).statusCode).toBe(409);

    // quiet before any note doesn't end it
    await vi.advanceTimersByTimeAsync(5000);
    expect(heard.done).toBe(false);
    desk.say({ type: 'played', events: [note(60, true)] });
    phoneStudio.say({ type: 'played', events: [note(64, true), note(64, false)] });
    outsider.say({ type: 'played', events: [note(67, true), note(67, false)] });
    // a held note isn't quiet
    await vi.advanceTimersByTimeAsync(3000);
    expect(heard.done).toBe(false);
    desk.say({ type: 'played', events: [note(60, false), note(62, true, 80), note(62, false)] });
    await vi.advanceTimersByTimeAsync(999);
    expect(heard.done).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await until(() => heard.done);
    const res = heard.value as Awaited<ReturnType<typeof tool>>;
    expect(res.json()).toEqual({
      done: true,
      part: 1,
      pending: 0,
      notes: [
        { tick: null, time: expect.any(Number), pitch: 60, velocity: 100, length: expect.any(Number), port: 'Keys' },
        { tick: null, time: expect.any(Number), pitch: 62, velocity: 80, length: expect.any(Number), port: 'Keys' },
      ],
    });
    expect(desk.got('agent-listen').at(-1)).toEqual({ type: 'agent-listen', job, state: 'off' });
  });

  it('ends when the user presses Done, and only the device that asked can', async () => {
    const { start, tool, s, token, desk, admit, app } = await setup();
    const phone = await admit(token);
    const { job, token: jobToken } = await start({ project: s.id, text: 'Listen' });
    const heard = pending(tool(job, jobToken, 'POST', '/listen', { maxMs: 45_000, quietMs: 2000 }));
    await until(() => desk.got('agent-listen').length > 0);
    desk.say({ type: 'played', events: [note(60, true)] });
    const done = (as: string) =>
      app.inject({ method: 'POST', url: `/api/agent/jobs/${job}/done-listening`, headers: auth(as) });
    expect((await done(phone.token)).statusCode).toBe(403);
    expect((await done(token)).json()).toEqual({ ok: true });
    await until(() => heard.done);
    expect((heard.value as Awaited<ReturnType<typeof tool>>).json()).toMatchObject({
      done: true,
      notes: [{ pitch: 60, length: null }],
    });
    expect(desk.got('agent-listen').map((m) => m.state)).toEqual(['on', 'off']);
  });

  it('comes back at maxMs not done, keeps showing it listens between parts, and Done in between ends the next', async () => {
    const { start, tool, s, token, desk, app } = await setup();
    const { job, token: jobToken } = await start({ project: s.id, text: 'Listen' });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const part = () => pending(tool(job, jobToken, 'POST', '/listen', { maxMs: 2000, quietMs: 1000 }));

    const first = await part();
    await until(() => desk.got('agent-listen').length > 0);
    await vi.advanceTimersByTimeAsync(2000);
    await until(() => first.done);
    expect((first.value as Awaited<ReturnType<typeof tool>>).json()).toEqual({
      notes: [],
      done: false,
      part: 1,
      pending: 0,
    });
    // still listening, as far as the studio shows
    expect(desk.got('agent-listen').map((m) => m.state)).toEqual(['on']);

    const second = await part();
    await vi.advanceTimersByTimeAsync(10);
    expect(desk.got('agent-listen').map((m) => m.state)).toEqual(['on']);
    await vi.advanceTimersByTimeAsync(2000);
    await until(() => second.done);
    expect((second.value as Awaited<ReturnType<typeof tool>>).json()).toEqual({
      notes: [],
      done: false,
      part: 2,
      pending: 0,
    });
    // Done between two parts: the next one ends at once
    await app.inject({ method: 'POST', url: `/api/agent/jobs/${job}/done-listening`, headers: auth(token) });
    const third = part();
    await until(() => third.done);
    expect((third.value as Awaited<ReturnType<typeof tool>>).json()).toEqual({
      notes: [],
      done: true,
      part: 3,
      pending: 0,
    });
    expect(desk.got('agent-listen').map((m) => m.state)).toEqual(['on', 'off']);

    // no next part: after a few seconds the studio stops showing it
    const fourth = part();
    await until(() => desk.got('agent-listen').length === 3);
    await vi.advanceTimersByTimeAsync(2000);
    await until(() => fourth.done);
    // (a listen of its own: the one before ended)
    expect((fourth.value as Awaited<ReturnType<typeof tool>>).json()).toMatchObject({ done: false, part: 1 });
    await vi.advanceTimersByTimeAsync(14_999);
    expect(desk.got('agent-listen').map((m) => m.state)).toEqual(['on', 'off', 'on']);
    await vi.advanceTimersByTimeAsync(1);
    expect(desk.got('agent-listen').map((m) => m.state)).toEqual(['on', 'off', 'on', 'off']);
  });

  it('stops when the job ends', async () => {
    const { start, tool, s, desk, run, status } = await setup();
    const { job, token: jobToken } = await start({ project: s.id, text: 'Listen' });
    const heard = pending(tool(job, jobToken, 'POST', '/listen', { maxMs: 45_000, quietMs: 2000 }));
    await until(() => desk.got('agent-listen').length > 0);
    run.say({ type: 'agent-failed', job, error: 'Cursor stopped' });
    await until(() => heard.done);
    expect((heard.value as Awaited<ReturnType<typeof tool>>).json()).toEqual({
      notes: [],
      done: true,
      part: 1,
      pending: 0,
    });
    expect(desk.got('agent-listen').at(-1)).toEqual({ type: 'agent-listen', job, state: 'off' });
    expect(status(desk, job)).toMatchObject({ state: 'failed' });
  });

  describe('across parts', () => {
    /** A listen's parts, two seconds each (a quiet spell long enough not to end one), on fake time. */
    async function parts() {
      const w = await setup();
      const { job, token: jobToken } = await w.start({ project: w.s.id, text: 'Write down what I play' });
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      /** A part asked for, once the server has it (the call takes a few turns of the event loop to arrive). */
      const part = async (body: Msg = {}) => {
        const p = pending(w.tool(job, jobToken, 'POST', '/listen', { maxMs: 2000, quietMs: 5000, ...body }));
        for (let i = 0; i < 100; i++) await new Promise((r) => setImmediate(r));
        return p;
      };
      const answer = async (p: Awaited<ReturnType<typeof part>>) => {
        await until(() => p.done);
        return (p.value as Awaited<ReturnType<typeof w.tool>>).json() as {
          notes: { pitch: number; time: number; length: number | null }[];
          done: boolean;
          part: number;
          pending: number;
        };
      };
      /** A key down at `at` ms from now, up `length` ms later. */
      const play = async (pitch: number, at: number, length: number) => {
        await vi.advanceTimersByTimeAsync(at);
        w.desk.say({ type: 'played', events: [note(pitch, true)] });
        await vi.advanceTimersByTimeAsync(length);
        w.desk.say({ type: 'played', events: [note(pitch, false)] });
      };
      const states = () => w.desk.got('agent-listen').map((m) => m.state);
      return { ...w, job, part, answer, play, states };
    }
    const brief = (notes: { pitch: number; time: number; length: number | null }[]) =>
      notes.map((n) => [n.pitch, n.time, n.length]);

    it('hands what was played between two parts to the next, its times running on from the first', async () => {
      const { part, answer, play, states } = await parts();
      const first = await part();
      await until(() => states().length > 0);
      await play(60, 500, 300);
      await vi.advanceTimersByTimeAsync(1200);
      const one = await answer(first);
      expect(one).toMatchObject({ done: false, part: 1, pending: 0 });
      expect(brief(one.notes)).toEqual([[60, 500, 300]]);
      // between the parts (the model is reading the answer): still heard
      await play(62, 500, 200);
      await vi.advanceTimersByTimeAsync(300);
      const second = await part();
      await play(64, 200, 200);
      await vi.advanceTimersByTimeAsync(1600);
      const two = await answer(second);
      expect(two).toMatchObject({ done: false, part: 2, pending: 0 });
      expect(brief(two.notes)).toEqual([
        [62, 2500, 200],
        [64, 3200, 200],
      ]);
      // the studio showed it listening throughout
      expect(states()).toEqual(['on']);
    });

    it('keeps a note held over the end of a part whole: a later part hands it on', async () => {
      const { part, answer, play, desk } = await parts();
      const first = await part();
      await play(60, 200, 200);
      await vi.advanceTimersByTimeAsync(1100);
      desk.say({ type: 'played', events: [note(67, true)] });
      await vi.advanceTimersByTimeAsync(500);
      // the part ends with the key down: nothing handed out yet, two notes kept
      expect(await answer(first)).toEqual({ notes: [], done: false, part: 1, pending: 2 });
      await vi.advanceTimersByTimeAsync(400);
      desk.say({ type: 'played', events: [note(67, false)] });
      const second = await part({ last: true });
      await vi.advanceTimersByTimeAsync(2000);
      const two = await answer(second);
      expect(two).toMatchObject({ done: true, part: 2, pending: 0 });
      expect(brief(two.notes)).toEqual([
        [60, 200, 200],
        [67, 1500, 900],
      ]);
    });

    it('lets what came after a part go when no next part comes within the grace', async () => {
      const { part, answer, play, states } = await parts();
      const first = await part();
      await play(60, 500, 300);
      await vi.advanceTimersByTimeAsync(1200);
      expect(brief((await answer(first)).notes)).toEqual([[60, 500, 300]]);
      await play(62, 1000, 200);
      await vi.advanceTimersByTimeAsync(13_800);
      expect(states()).toEqual(['on', 'off']);
      // the next call is a listen of its own: the note played after the last part is gone
      const again = await part();
      await play(64, 100, 100);
      await vi.advanceTimersByTimeAsync(1800);
      const two = await answer(again);
      expect(two).toMatchObject({ done: false, part: 1 });
      expect(brief(two.notes)).toEqual([[64, 100, 100]]);
      expect(states()).toEqual(['on', 'off', 'on']);
    });

    it('ends the next part at once when Done is pressed between two, with what was played up to Done', async () => {
      const { part, answer, play, app, job, token, desk, states } = await parts();
      const first = await part();
      await play(60, 500, 300);
      await vi.advanceTimersByTimeAsync(1200);
      await answer(first);
      await play(62, 500, 200);
      await app.inject({ method: 'POST', url: `/api/agent/jobs/${job}/done-listening`, headers: auth(token) });
      // after Done: not part of the listen
      desk.say({ type: 'played', events: [note(64, true), note(64, false)] });
      await vi.advanceTimersByTimeAsync(1000);
      const two = await answer(await part());
      expect(two).toMatchObject({ done: true, part: 2, pending: 0 });
      expect(brief(two.notes)).toEqual([[62, 2500, 200]]);
      expect(states()).toEqual(['on', 'off']);
    });

    it('ends the part the tool says is the last when its time is up, as done', async () => {
      const { part, answer, play, states } = await parts();
      const first = await part({ last: true });
      await play(60, 500, 300);
      await vi.advanceTimersByTimeAsync(1200);
      const one = await answer(first);
      expect(one).toMatchObject({ done: true, part: 1, pending: 0 });
      expect(brief(one.notes)).toEqual([[60, 500, 300]]);
      expect(states()).toEqual(['on', 'off']);
    });
  });
});

describe('what was just played', () => {
  it('asks the requester’s studio for its memory of it, and says so when it has none', async () => {
    const { start, tool, s, token, desk, admit, studio } = await setup();
    const phone = await admit(token);
    const phoneStudio = studio(phone.token, s.id, 'phone');
    const { job, token: jobToken } = await start({ project: s.id, text: 'What did I play?' });
    desk.answer = (msg) =>
      msg.type === 'agent-played'
        ? {
            ok: true,
            notes: [
              { tick: 1920, time: 0, pitch: 60, velocity: 90, length: 240, port: 'Keys' },
              { pitch: 'C4' },
              { tick: null, time: 300, pitch: 64, velocity: 70, length: null, port: 'Keys' },
            ],
          }
        : { ok: true };
    const res = await tool(job, jobToken, 'GET', '/played?seconds=10');
    expect(res.json()).toEqual({
      notes: [
        { tick: 1920, time: 0, pitch: 60, velocity: 90, length: 240, port: 'Keys' },
        { tick: null, time: 300, pitch: 64, velocity: 70, length: null, port: 'Keys' },
      ],
    });
    expect(desk.got('agent-played')).toEqual([{ type: 'agent-played', id: expect.any(String), seconds: 10 }]);
    expect(phoneStudio.got('agent-played')).toEqual([]);
    expect((await tool(job, jobToken, 'GET', '/played?seconds=61')).statusCode).toBe(400);
    expect((await tool(job, jobToken, 'GET', '/played?seconds=x')).statusCode).toBe(400);

    // a studio that can't say yet
    desk.answer = (msg) => (msg.type === 'agent-played' ? { ok: false, error: 'No memory' } : { ok: true });
    const none = await tool(job, jobToken, 'GET', '/played?seconds=5');
    expect(none.statusCode).toBe(409);
    expect(none.json()).toEqual({ error: 'No memory' });
    desk.answer = (msg) => (msg.type === 'agent-played' ? null : { ok: true });
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const silent = pending(tool(job, jobToken, 'GET', '/played?seconds=5'));
    await until(() => desk.got('agent-played').length === 3);
    await vi.advanceTimersByTimeAsync(3000);
    await until(() => silent.done);
    expect((silent.value as Awaited<ReturnType<typeof tool>>).statusCode).toBe(504);
  });
});

describe('A/B', () => {
  it('asks the requester’s studio alone to play before and after, and answers once it has', async () => {
    const { start, tool, s, token, desk, admit, studio } = await setup();
    const phone = await admit(token);
    const phoneStudio = studio(phone.token, s.id, 'phone');
    const { job, token: jobToken } = await start({ project: s.id, text: 'Compare' });
    const res = await tool(job, jobToken, 'POST', '/compare', { from: 9, to: 17 });
    expect(res.json()).toEqual({ ok: true });
    expect(desk.got('agent-compare')).toEqual([
      { type: 'agent-compare', id: expect.any(String), job, from: 9, to: 17 },
    ]);
    expect(phoneStudio.got('agent-compare')).toEqual([]);
    expect((await tool(job, jobToken, 'POST', '/compare', { from: 9, to: 9 })).statusCode).toBe(400);
    expect((await tool(job, jobToken, 'POST', '/compare', { from: 0, to: 4 })).statusCode).toBe(400);
    desk.answer = (msg) =>
      msg.type === 'agent-compare' ? { ok: false, error: 'Nothing to compare yet' } : { ok: true };
    const refused = await tool(job, jobToken, 'POST', '/compare', { from: 1, to: 3 });
    expect(refused.statusCode).toBe(409);
    expect(refused.json()).toEqual({ error: 'Nothing to compare yet' });
  });
});
