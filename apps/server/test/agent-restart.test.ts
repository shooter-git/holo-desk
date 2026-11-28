/**
 * What a restart of HO[LO] leaves of the agent's requests: a click that was waited for still is, a
 * request that was working says it was cut short and carries on by itself, once, and what every turn
 * kept of itself is there to read.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { RESTARTED } from '../src/agent/jobs.ts';
import type { TurnExtra } from '../src/agent/store.ts';
import { agentApp, auth, CLAUDE, type FakeSocket, type Msg, waitFor } from './agent-fakes.ts';

type App = Awaited<ReturnType<typeof agentApp>>;
const open: App[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close().catch(() => undefined);
});

/** HO[LO] with a runner, a paired device and a song open in its studio. */
async function world() {
  const t = await agentApp();
  open.push(t);
  const run = t.runner();
  const { token, device } = await t.pair(run);
  const s = await t.song('Lantern Sketch');
  const desk = t.studio(token, s.id, 'desk');
  return { t, run, token, device, s, desk };
}

/** The same HO[LO], stopped and started again: a runner and the device's studio come back to it. */
async function restarted(before: App, token: string, project: string, carriesOn = true) {
  await before.stop();
  open.splice(open.indexOf(before), 1);
  const t = await agentApp(before.work);
  open.push(t);
  // (past the time in which a request cut short carries on by itself)
  if (!carriesOn) await t.services.jobs.carryOnPending(Date.now() + 11 * 60_000);
  const run = t.runner();
  const desk = t.studio(token, project, 'desk');
  return { t, run, desk };
}

const ask = (t: App, token: string, body: Msg) =>
  t.app.inject({ method: 'POST', url: '/api/agent/requests', headers: auth(token), payload: body });
const tool = (t: App, job: string, jobToken: string, path: string, payload: Msg) =>
  t.app.inject({ method: 'POST', url: `/api/agent/jobs/${job}${path}`, headers: auth(jobToken), payload });
const sentFor = (run: FakeSocket, job: string) =>
  run.got('agent-run').find((m) => m.job === job) as Msg & { token: string; prompt: string };
const threadOf = async (t: App, token: string, project: string) =>
  (await t.app.inject({ method: 'GET', url: `/api/agent/threads/${project}`, headers: auth(token) })).json() as {
    thread: { turns: (Msg & { job: string; state: string })[] } | null;
    job: (Msg & { id: string; state: string }) | null;
  };
const turnExtra = (t: App, job: string): TurnExtra & { device: string | null } => {
  const row = t.services.store.database.prepare('SELECT extra, device FROM agent_turns WHERE job = ?').get(job) as {
    extra: string;
    device: string | null;
  };
  return { ...(JSON.parse(row.extra) as TurnExtra), device: row.device };
};
const busy = async (t: App) =>
  ((await t.app.inject({ method: 'GET', url: '/api/health' })).json() as { busy: boolean }).busy;

/** A request started, as far as its runner being handed it. */
async function begin(w: Awaited<ReturnType<typeof world>>, body: Msg) {
  const res = await ask(w.t, w.token, { project: w.s.id, ...body });
  expect(res.statusCode, res.body).toBe(200);
  const { job } = res.json() as { job: string };
  return { job, token: sentFor(w.run, job).token };
}

const RETITLE = [{ op: 'setProject', patch: { title: 'Lantern Sketch (strings)' } }];

describe('a turn', () => {
  it('keeps who asked, what it ran with, what the studio showed and what it changed', async () => {
    const w = await world();
    const first = await begin(w, { text: 'Strings under the chorus', context: { view: 'mixer', playhead: 0 } });
    expect(
      (await tool(w.t, first.job, first.token, '/ops', { ops: RETITLE, label: 'Retitle', batch: 'b1' })).statusCode,
    ).toBe(200);
    expect(
      (await tool(w.t, first.job, first.token, '/ops', { ops: RETITLE, label: 'Retitle', batch: 'b2' })).statusCode,
    ).toBe(200);
    expect(
      (await tool(w.t, first.job, first.token, '/ops', { ops: RETITLE, label: 'Name it', batch: 'b3' })).statusCode,
    ).toBe(200);
    // (a batch sent again changes nothing, and counts for nothing)
    await tool(w.t, first.job, first.token, '/ops', { ops: RETITLE, label: 'Retitle', batch: 'b1' });
    expect(turnExtra(w.t, first.job)).toMatchObject({
      device: w.device.id,
      harness: 'claude',
      context: { view: 'mixer', playhead: 0 },
      changes: [
        ['Retitle', 2],
        ['Name it', 1],
      ],
      title: 'Lantern Sketch',
    });
    expect(turnExtra(w.t, first.job).started).toBeGreaterThan(0);
  });
});

describe('an update waits for the agent', () => {
  it('says HO[LO] is busy while a request works, and not once it’s done', async () => {
    const w = await world();
    expect(await busy(w.t)).toBe(false);
    const first = await begin(w, { text: 'Strings under the chorus' });
    expect(await busy(w.t)).toBe(true);
    await tool(w.t, first.job, first.token, '/finish', { label: 'Strings', reply: 'Done.' });
    w.run.say({ type: 'agent-done', job: first.job });
    await waitFor(() => w.t.services.jobs.get(first.job)?.view.state === 'done');
    expect(await busy(w.t)).toBe(false);
  });

  it('isn’t kept waiting by a reply that waits for a click', async () => {
    const w = await world();
    const first = await begin(w, { text: 'Strings under the chorus' });
    await tool(w.t, first.job, first.token, '/permission', { kind: 'screen', detail: 'To see the mixer' });
    w.run.say({ type: 'agent-done', job: first.job });
    await waitFor(() => w.t.services.jobs.get(first.job)?.view.state === 'awaiting');
    expect(await busy(w.t)).toBe(false);
  });
});

describe('a restart of HO[LO]', () => {
  it('keeps a click that was waited for: it’s still asked, and allowed, the conversation carries on', async () => {
    const w = await world();
    const first = await begin(w, { text: 'Strings under the chorus' });
    w.run.say({ type: 'agent-session', job: first.job, session: 'sess-1' });
    await tool(w.t, first.job, first.token, '/permission', {
      kind: 'install-pack',
      detail: 'Holo Strings, for the pad under the chorus',
      pack: 'holo-strings',
    });
    await tool(w.t, first.job, first.token, '/finish', {
      label: 'Strings',
      reply: 'Once it’s installed I’ll write the pad.',
    });
    w.run.say({ type: 'agent-done', job: first.job });
    await waitFor(() => w.t.services.jobs.get(first.job)?.view.state === 'awaiting');

    const again = await restarted(w.t, w.token, w.s.id);
    const shown = await threadOf(again.t, w.token, w.s.id);
    expect(shown.job).toMatchObject({
      id: first.job,
      state: 'awaiting',
      device: w.device.id,
      request: 'Strings under the chorus',
      reply: 'Once it’s installed I’ll write the pad.',
      permission: { kind: 'install-pack', detail: 'Holo Strings, for the pad under the chorus', pack: 'holo-strings' },
    });
    expect(shown.thread?.turns.at(-1)).toMatchObject({ job: first.job, state: 'awaiting' });

    const granted = await again.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${first.job}/permission`,
      headers: auth(w.token),
      payload: { grant: true, result: 'Holo Strings installed (3 instruments)' },
    });
    expect(granted.statusCode, granted.body).toBe(200);
    const { job: next } = granted.json() as { job: string };
    const followUp = sentFor(again.run, next);
    expect(followUp).toMatchObject({ session: 'sess-1', harness: 'claude' });
    expect(followUp.prompt).toContain('You asked to install a pack (holo-strings)');
    expect(followUp.prompt).toContain('Holo Strings installed (3 instruments)');
    expect((await threadOf(again.t, w.token, w.s.id)).thread?.turns.map((t) => t.state)).toEqual(['done', 'waiting']);
  });

  it('lets go of a click whose device is no longer allowed, or whose conversation was started over', async () => {
    const w = await world();
    const first = await begin(w, { text: 'Strings under the chorus' });
    await tool(w.t, first.job, first.token, '/permission', { kind: 'screen', detail: 'To see the mixer' });
    w.run.say({ type: 'agent-done', job: first.job });
    await waitFor(() => w.t.services.jobs.get(first.job)?.view.state === 'awaiting');
    // as a server from before turns kept who asked would have left it
    w.t.services.store.database.prepare('UPDATE agent_turns SET device = NULL WHERE job = ?').run(first.job);

    const again = await restarted(w.t, w.token, w.s.id);
    const shown = await threadOf(again.t, w.token, w.s.id);
    expect(shown.job).toBeNull();
    expect(shown.thread?.turns.at(-1)).toMatchObject({ job: first.job, state: 'cancelled' });
  });

  it('says a request that was working was cut short, and tells the agent so next time', async () => {
    const w = await world();
    const first = await begin(w, { text: 'Strings under the chorus' });
    w.run.say({ type: 'agent-session', job: first.job, session: 'sess-1' });
    await tool(w.t, first.job, first.token, '/ops', { ops: RETITLE, label: 'Retitle', batch: 'b1' });

    // (it would carry on by itself: below, "a request cut short carries on by itself")
    const again = await restarted(w.t, w.token, w.s.id, false);
    expect(await busy(again.t)).toBe(false);
    const shown = await threadOf(again.t, w.token, w.s.id);
    expect(shown.job).toBeNull();
    expect(shown.thread?.turns.at(-1)).toMatchObject({ job: first.job, state: 'failed', error: RESTARTED });
    expect(turnExtra(again.t, first.job)).toMatchObject({ stop: { why: 'interrupted' }, changes: [['Retitle', 1]] });
    // the runner that comes back is told to stop what it may still run of it, once
    expect(again.run.got('agent-cancel')).toEqual([{ type: 'agent-cancel', job: first.job }]);
    again.run.say({ type: 'harnesses', list: [CLAUDE] });
    expect(again.run.got('agent-cancel')).toHaveLength(1);
    // and again whenever it says it's still at it
    again.run.say({ type: 'agent-progress', job: first.job, line: 'Still writing strings' });
    expect(again.run.got('agent-cancel')).toHaveLength(2);
    // its tools' token went with the server that made it
    expect((await tool(again.t, first.job, first.token, '/progress', { line: 'Still here' })).statusCode).toBe(403);

    // the next request carries the conversation on, and says what happened
    const res = await ask(again.t, w.token, { project: w.s.id, text: 'Carry on' });
    expect(res.statusCode, res.body).toBe(200);
    const next = sentFor(again.run, (res.json() as { job: string }).job);
    expect(next).toMatchObject({ session: 'sess-1' });
    expect(next.prompt).toContain(`Your last turn failed (${RESTARTED}); what it changed may still be in the song.`);
  });

  it('leaves the turns that were over as they were', async () => {
    const w = await world();
    const first = await begin(w, { text: 'Strings under the chorus' });
    await tool(w.t, first.job, first.token, '/finish', { label: 'Strings', reply: 'Done.' });
    w.run.say({ type: 'agent-done', job: first.job });
    await waitFor(() => w.t.services.jobs.get(first.job)?.view.state === 'done');
    const again = await restarted(w.t, w.token, w.s.id);
    expect((await threadOf(again.t, w.token, w.s.id)).thread?.turns).toMatchObject([
      { job: first.job, state: 'done', reply: 'Done.', label: 'Strings' },
    ]);
  });
});

describe('a request cut short carries on by itself', () => {
  const MINUTE = 60_000;
  type Run = Msg & { job: string; prompt: string; token: string };
  const runs = (run: FakeSocket) => run.got('agent-run') as Run[];
  /** HO[LO] started again on what `before` left, nobody connected to it yet. */
  async function startedAgain(before: App) {
    await before.stop();
    open.splice(open.indexOf(before), 1);
    const t = await agentApp(before.work);
    open.push(t);
    return t;
  }
  /** A request at work with a session, HO[LO] then stopped under it and started again. */
  async function cutShort(body: Msg = { text: 'Strings under the chorus' }, live = false) {
    const w = await world();
    const first = await begin(w, body);
    w.run.say({ type: 'agent-session', job: first.job, session: 'sess-1' });
    if (live) await tool(w.t, first.job, first.token, '/ops', { ops: RETITLE, label: 'Retitle', batch: 'b1' });
    return { w, first, t: await startedAgain(w.t) };
  }
  /** What waits is looked at now (as the clock's tick does), and what began is with its runner. */
  const look = (t: App, now = Date.now()) => t.services.jobs.carryOnPending(now);
  const waiting = (t: App) => t.services.jobs.carryWaiting();
  /** The device's studio, not yet on a song (it shows one with `shows`): what it answers can be set first. */
  const shows = (desk: FakeSocket, project: string) =>
    desk.say({
      type: 'state',
      state: { project, revision: 0, tick: 0, selection: { track: null, regions: [], notes: 0 } },
    });
  const NOT_SAVED = { ok: false, error: 'The studio could not save the song' };
  /** The studio was asked to save `times` times, didn't, and the request waits again. */
  const asked = (t: App, desk: FakeSocket, times: number) =>
    waitFor(() => desk.got('agent-flush').length === times && waiting(t).length === 1);
  const rewrite = (t: App, job: string, change: (extra: Msg) => Msg, state?: string) => {
    const db = t.services.store.database;
    const row = db.prepare('SELECT extra FROM agent_turns WHERE job = ?').get(job) as { extra: string };
    db.prepare('UPDATE agent_turns SET extra = ? WHERE job = ?').run(
      JSON.stringify(change(JSON.parse(row.extra))),
      job,
    );
    if (state) db.prepare('UPDATE agent_turns SET state = ? WHERE job = ?').run(state, job);
  };

  it('once the runner and its studio are back: the same request, in the same session, told its last go didn’t finish', async () => {
    const { w, first, t } = await cutShort();
    expect((await threadOf(t, w.token, w.s.id)).thread?.turns.at(-1)).toMatchObject({ state: 'failed' });
    expect(waiting(t)).toEqual([w.s.id]);
    const run = t.runner();
    // (its studio is given a moment to come back: what the user did meanwhile is saved first)
    await look(t);
    expect(runs(run)).toEqual([]);
    const desk = t.studio(w.token, w.s.id, 'desk');
    await waitFor(() => runs(run).length === 1);
    expect(waiting(t)).toEqual([]);
    const [go] = runs(run);
    expect(go).toMatchObject({ session: 'sess-1', harness: 'claude' });
    expect(go?.prompt).toContain(`Your last turn failed (${RESTARTED})`);
    expect(go?.prompt).toContain('Your last go at this request didn’t finish');
    expect(go?.prompt).toContain('Strings under the chorus');
    // what the runner may still run of the go before is stopped first, and its studio saved first
    const sent = run.sent.map((m) => m.type).filter((type) => type === 'agent-cancel' || type === 'agent-run');
    expect(sent.at(-1)).toBe('agent-run');
    expect(sent.slice(0, -1).length).toBeGreaterThan(0);
    expect(run.got('agent-cancel').every((m) => m.job === first.job)).toBe(true);
    expect(desk.got('agent-flush')).toHaveLength(1);
    // it's the request's next go: one exchange on the page, one step to undo, and said to have carried on by itself
    const job = go?.job as string;
    expect(t.services.jobs.get(job)?.view).toMatchObject({ continues: first.job, device: w.device.id });
    expect(turnExtra(t, job)).toMatchObject({ continues: first.job, auto: true });
    await waitFor(() => desk.got('agent-status').some((m) => (m.job as Msg).id === job));
    // and it ends as any request does
    await tool(t, job, go?.token as string, '/finish', { label: 'Strings', reply: 'Carried on: done.' });
    run.say({ type: 'agent-done', job });
    await waitFor(() => t.services.jobs.get(job)?.view.state === 'done');
    expect((await threadOf(t, w.token, w.s.id)).thread?.turns.map((x) => x.state)).toEqual(['failed', 'done']);
  });

  it('only once: cut short again, it’s left to the user', async () => {
    const { w, t } = await cutShort();
    const run = t.runner();
    t.studio(w.token, w.s.id, 'desk');
    await waitFor(() => runs(run).length === 1);
    const second = await startedAgain(t);
    const runAgain = second.runner();
    second.studio(w.token, w.s.id, 'desk');
    await look(second);
    expect(runs(runAgain)).toEqual([]);
    expect(waiting(second)).toEqual([]);
    expect((await threadOf(second, w.token, w.s.id)).thread?.turns.map((x) => x.state)).toEqual(['failed', 'failed']);
    // (Try again is still the user's; cut short too, that go isn't carried on by itself either)
    const res = await second.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${runs(run)[0]?.job}/continue`,
      headers: auth(w.token),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    const third = await startedAgain(second);
    const runThird = third.runner();
    third.studio(w.token, w.s.id, 'desk');
    await look(third);
    expect(runs(runThird)).toEqual([]);
    expect(waiting(third)).toEqual([]);
  });

  it('waits for its studio when what it changed went in there, and begins only once that studio has saved', async () => {
    const { w, first, t } = await cutShort({ text: 'Strings' }, true);
    expect(turnExtra(t, first.job)).toMatchObject({ live: true });
    const run = t.runner();
    // however long its studio is away (within the ten minutes), it doesn't run on the song without them
    await look(t, Date.now() + 5 * MINUTE);
    expect(runs(run)).toEqual([]);
    expect(waiting(t)).toEqual([w.s.id]);
    // a studio that can't save yet: asked, and asked again
    const desk = t.studio(w.token, null, 'desk');
    const saves = desk.answer;
    desk.answer = (msg) => (msg.type === 'agent-flush' ? NOT_SAVED : (saves?.(msg) ?? null));
    shows(desk, w.s.id);
    await asked(t, desk, 1);
    expect(runs(run)).toEqual([]);
    await look(t);
    await asked(t, desk, 2);
    expect(runs(run)).toEqual([]);
    desk.answer = saves;
    await look(t);
    expect(runs(run)).toHaveLength(1);
    expect(waiting(t)).toEqual([]);
  });

  it('says a change went into its studio before that studio answers, so it’s known however that ends', async () => {
    const w = await world();
    const first = await begin(w, { text: 'Strings' });
    // the studio is handed the batch and never answers (HO[LO] stops meanwhile)
    w.desk.answer = () => null;
    void tool(w.t, first.job, first.token, '/ops', { ops: RETITLE, label: 'Retitle', batch: 'b1' });
    await waitFor(() => w.desk.got('agent-ops').length === 1);
    expect(turnExtra(w.t, first.job)).toMatchObject({ live: true });
  });

  it('without its studio when nothing of it is kept there, once that studio has had a moment: saved here', async () => {
    const { w, t } = await cutShort();
    const run = t.runner();
    await look(t, Date.now() + 19_000);
    expect(runs(run)).toEqual([]);
    await look(t, Date.now() + 21_000);
    expect(runs(run)).toHaveLength(1);
    const [go] = runs(run);
    const saved = await tool(t, go?.job as string, go?.token as string, '/ops', {
      ops: RETITLE,
      label: 'Retitle',
      batch: 'b1',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(t.services.store.get(w.s.id)?.title).toBe('Lantern Sketch (strings)');
  });

  it('not when it’s too late, or the request was begun hours ago', async () => {
    // more than ten minutes after HO[LO] came back
    const late = await cutShort();
    const lateRun = late.t.runner();
    late.t.studio(late.w.token, late.w.s.id, 'desk');
    // (looked at only now: the runner and the studio came while nothing looked)
    late.t.services.jobs.limits.carryWindowMs = -1;
    await look(late.t);
    expect(waiting(late.t)).toEqual([]);
    // begun more than four hours ago: the host was off a good while, and nobody is waiting on it
    const old = await cutShort();
    rewrite(old.t, old.first.job, (extra) => ({ ...extra, started: Date.now() - 5 * 60 * MINUTE }));
    const oldRun = old.t.runner();
    old.t.studio(old.w.token, old.w.s.id, 'desk');
    await look(old.t);
    expect(waiting(old.t)).toEqual([]);
    expect(runs(oldRun)).toEqual([]);
    // (the first of them did begin, or it would prove nothing: the window is looked at as it's looked at)
    expect(runs(lateRun).length).toBeLessThanOrEqual(1);
  });

  it('not once the conversation has moved on, the agent is off, or the device let go', async () => {
    // a later request
    const moved = await cutShort({ text: 'One' }, true);
    const movedRun = moved.t.runner();
    await look(moved.t);
    moved.t.services.jobs.limits.carryTickMs = 60_000;
    // (its studio is back, but hasn't saved what it holds of the go before: it still waits)
    const desk = moved.t.studio(moved.w.token, null, 'desk');
    const saves = desk.answer;
    let flushes = 0;
    desk.answer = (msg) => (msg.type === 'agent-flush' && flushes++ === 0 ? NOT_SAVED : (saves?.(msg) ?? null));
    shows(desk, moved.w.s.id);
    await asked(moved.t, desk, 1);
    const later = await ask(moved.t, moved.w.token, { project: moved.w.s.id, text: 'Something else' });
    expect(later.statusCode, later.body).toBe(200);
    await look(moved.t);
    expect(waiting(moved.t)).toEqual([]);
    expect(runs(movedRun).map((r) => r.job)).toEqual([(later.json() as { job: string }).job]);
    // started over
    const reset = await cutShort();
    await reset.t.app.inject({
      method: 'POST',
      url: `/api/agent/threads/${reset.w.s.id}/reset`,
      headers: auth(reset.w.token),
    });
    // the agent turned off
    const off = await cutShort();
    await off.t.app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(off.w.token),
      payload: { enabled: false },
    });
    // the device let go
    const gone = await cutShort();
    const removed = await gone.t.app.inject({
      method: 'DELETE',
      url: `/api/agent/devices/${gone.w.device.id}`,
      headers: auth(gone.w.token),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    for (const c of [reset, off, gone]) {
      const run = c.t.runner();
      await look(c.t, Date.now() + 30_000);
      expect(waiting(c.t)).toEqual([]);
      expect(runs(run)).toEqual([]);
    }
  });

  it('not a go that failed for another reason, or that was stopped', async () => {
    // (as the turn would read had it ended so: only one HO[LO] or its runner stopped under carries on)
    const failed = await cutShort();
    rewrite(failed.t, failed.first.job, ({ stop: _stop, ...extra }) => ({ ...extra, error: 'Overloaded' }));
    const stopped = await cutShort();
    rewrite(stopped.t, stopped.first.job, (extra) => extra, 'cancelled');
    for (const c of [failed, stopped]) {
      const run = c.t.runner();
      c.t.studio(c.w.token, c.w.s.id, 'desk');
      await look(c.t);
      expect(waiting(c.t)).toEqual([]);
      expect(runs(run)).toEqual([]);
    }
  });

  it('not once who asked has undone what it changed', async () => {
    const { w, first, t } = await cutShort({ text: 'Strings' }, true);
    const run = t.runner();
    const desk = t.studio(w.token, null, 'desk');
    const saves = desk.answer;
    desk.answer = (msg) => (msg.type === 'agent-flush' ? NOT_SAVED : (saves?.(msg) ?? null));
    shows(desk, w.s.id);
    await asked(t, desk, 1);
    desk.say({ type: 'history', action: 'undo', label: 'Agent: Retitle', job: first.job });
    await waitFor(() => waiting(t).length === 0);
    desk.answer = saves;
    await look(t);
    expect(runs(run)).toEqual([]);
  });

  it('waits for the harness to be ready again', async () => {
    const { w, t } = await cutShort();
    const run = t.runner([{ ...CLAUDE, signedIn: false }]);
    t.studio(w.token, w.s.id, 'desk');
    await look(t);
    expect(runs(run)).toEqual([]);
    expect(waiting(t)).toEqual([w.s.id]);
    run.say({ type: 'harnesses', list: [CLAUDE] });
    await waitFor(() => runs(run).length === 1);
  });
});

describe('a request whose runner went', () => {
  it('goes on when the runner is back in time, saying it’s still at it', async () => {
    const w = await world();
    const first = await begin(w, { text: 'Strings under the chorus' });
    w.run.close();
    const back = w.t.runner();
    // (as the runner says of what it still runs, as its connection opens)
    back.say({ type: 'agent-started', job: first.job });
    await tool(w.t, first.job, first.token, '/finish', { label: 'Strings', reply: 'All done.' });
    back.say({ type: 'agent-done', job: first.job });
    await waitFor(() => w.t.services.jobs.get(first.job)?.view.state === 'done');
    expect(w.t.services.jobs.carryWaiting()).toEqual([]);
    expect(back.got('agent-run')).toEqual([]);
    expect(back.got('agent-cancel')).toEqual([]);
  });

  it('fails once the runner has been gone a while, and carries on by itself when one is back', async () => {
    const w = await world();
    const first = await begin(w, { text: 'Strings under the chorus' });
    w.run.say({ type: 'agent-session', job: first.job, session: 'sess-1' });
    w.t.services.jobs.limits.droppedMs = 30;
    w.run.close();
    await waitFor(() => w.t.services.jobs.get(first.job)?.view.state === 'failed');
    expect(turnExtra(w.t, first.job)).toMatchObject({ stop: { why: 'interrupted' }, error: 'The runner disconnected' });
    const back = w.t.runner();
    await waitFor(() => back.got('agent-run').length === 1);
    expect(back.got('agent-run')[0]).toMatchObject({ session: 'sess-1' });
    expect(turnExtra(w.t, back.got('agent-run')[0]?.job as string)).toMatchObject({ continues: first.job, auto: true });
    // the runner may be the same one, still at the go before: it's told to stop that first
    const sent = back.sent.map((m) => m.type).filter((type) => type === 'agent-cancel' || type === 'agent-run');
    expect(sent).toEqual(['agent-cancel', 'agent-run']);
    expect(back.got('agent-cancel')[0]).toMatchObject({ job: first.job });
  });
});
