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
async function restarted(before: App, token: string, project: string) {
  await before.stop();
  open.splice(open.indexOf(before), 1);
  const t = await agentApp(before.work);
  open.push(t);
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

    const again = await restarted(w.t, w.token, w.s.id);
    // (past the time in which it would carry on by itself: below, "carries on by itself")
    again.t.services.jobs.carryOnPending(Date.now() + 11 * 60_000);
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
  const runs = (run: FakeSocket) => run.got('agent-run') as (Msg & { job: string; prompt: string; token: string })[];
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

  it('once the runner is back: the same request, in the same session, told its last go didn’t finish', async () => {
    const { w, first, t } = await cutShort();
    expect((await threadOf(t, w.token, w.s.id)).thread?.turns.at(-1)).toMatchObject({ state: 'failed' });
    const run = t.runner();
    const desk = t.studio(w.token, w.s.id, 'desk');
    await waitFor(() => runs(run).length === 1);
    const [go] = runs(run);
    expect(go).toMatchObject({ session: 'sess-1', harness: 'claude' });
    expect(go?.prompt).toContain(`Your last turn failed (${RESTARTED})`);
    expect(go?.prompt).toContain('Your last go at this request didn’t finish');
    expect(go?.prompt).toContain('Strings under the chorus');
    // (what the runner may still run of the go before was stopped first)
    const sent = run.sent.map((m) => m.type).filter((type) => type === 'agent-cancel' || type === 'agent-run');
    expect(sent).toEqual(['agent-cancel', 'agent-run']);
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
    await waitFor(() => runs(run).length === 1);
    const second = await startedAgain(t);
    const runAgain = second.runner();
    second.studio(w.token, w.s.id, 'desk');
    second.services.jobs.carryOnPending();
    await new Promise((ok) => setTimeout(ok, 50));
    expect(runs(runAgain)).toEqual([]);
    expect((await threadOf(second, w.token, w.s.id)).thread?.turns.map((x) => x.state)).toEqual(['failed', 'failed']);
    // (Try again is still the user's)
    const res = await second.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${runs(run)[0]?.job}/continue`,
      headers: auth(w.token),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
  });

  it('waits for its studio when what it changed went in there: that studio saves first', async () => {
    const { w, first, t } = await cutShort({ text: 'Strings' }, true);
    expect(turnExtra(t, first.job)).toMatchObject({ live: true });
    const run = t.runner();
    t.services.jobs.carryOnPending();
    await new Promise((ok) => setTimeout(ok, 50));
    expect(runs(run)).toEqual([]);
    const desk = t.studio(w.token, w.s.id, 'desk');
    t.services.jobs.carryOnPending();
    await waitFor(() => runs(run).length === 1);
    // (asked to save as the request begins, before the song is read for its prompt)
    expect(desk.got('agent-flush')).toHaveLength(1);
  });

  it('without its studio when nothing of it is kept there: what it changes is saved here', async () => {
    const { w, t } = await cutShort();
    const run = t.runner();
    await waitFor(() => runs(run).length === 1);
    const [go] = runs(run);
    const saved = await tool(t, go?.job as string, go?.token as string, '/ops', {
      ops: RETITLE,
      label: 'Retitle',
      batch: 'b1',
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(t.services.store.get(w.s.id)?.title).toBe('Lantern Sketch (strings)');
  });

  it('not when it’s too late, the request is old, or the conversation has moved on', async () => {
    // more than ten minutes after HO[LO] came back
    const late = await cutShort();
    late.t.services.jobs.carryOnPending(Date.now() + 11 * MINUTE);
    const lateRun = late.t.runner();
    late.t.services.jobs.carryOnPending();
    // a request begun more than a day ago
    const old = await cutShort();
    const extra = turnExtra(old.t, old.first.job);
    old.t.services.store.database
      .prepare('UPDATE agent_turns SET extra = ? WHERE job = ?')
      .run(JSON.stringify({ ...extra, device: undefined, started: Date.now() - 25 * 60 * MINUTE }), old.first.job);
    const oldRun = old.t.runner();
    // started over since
    const reset = await cutShort();
    await reset.t.app.inject({
      method: 'POST',
      url: `/api/agent/threads/${reset.w.s.id}/reset`,
      headers: auth(reset.w.token),
    });
    const resetRun = reset.t.runner();
    // the agent turned off, the device let go
    const off = await cutShort();
    await off.t.app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(off.w.token),
      payload: { enabled: false },
    });
    const offRun = off.t.runner();
    await new Promise((ok) => setTimeout(ok, 80));
    for (const run of [lateRun, oldRun, resetRun, offRun]) expect(runs(run)).toEqual([]);
  });

  it('not a request that failed for another reason, or that the user stopped', async () => {
    const w = await world();
    const failed = await begin(w, { text: 'One' });
    w.run.say({ type: 'agent-failed', job: failed.job, error: 'Overloaded' });
    await waitFor(() => w.t.services.jobs.get(failed.job)?.view.state === 'failed');
    const stopped = await begin(w, { text: 'Two' });
    await w.t.app.inject({ method: 'POST', url: `/api/agent/jobs/${stopped.job}/cancel`, headers: auth(w.token) });
    const t = await startedAgain(w.t);
    const run = t.runner();
    t.studio(w.token, w.s.id, 'desk');
    t.services.jobs.carryOnPending();
    await new Promise((ok) => setTimeout(ok, 50));
    expect(runs(run)).toEqual([]);
  });

  it('waits for the harness to be ready again, and for the song to be free', async () => {
    const { w, t } = await cutShort();
    const run = t.runner([{ ...CLAUDE, signedIn: false }]);
    t.studio(w.token, w.s.id, 'desk');
    t.services.jobs.carryOnPending();
    await new Promise((ok) => setTimeout(ok, 50));
    expect(runs(run)).toEqual([]);
    run.say({ type: 'harnesses', list: [CLAUDE] });
    await waitFor(() => runs(run).length === 1);
  });
});

describe('a request whose runner went', () => {
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
  });
});
