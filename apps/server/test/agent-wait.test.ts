/**
 * "Carry on when it resets": a request its harness's limit refused is carried on by itself once that
 * limit has started again, where the user asked for it. Kept across a restart of HO[LO], and called
 * off by the user or by the conversation moving on.
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { TurnExtra } from '../src/agent/store.ts';
import { agentApp, auth, type FakeSocket, type Msg, waitFor } from './agent-fakes.ts';

type App = Awaited<ReturnType<typeof agentApp>>;
const open: App[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close().catch(() => undefined);
});

async function world() {
  const t = await agentApp();
  open.push(t);
  const run = t.runner();
  const { token, device } = await t.pair(run);
  const s = await t.song('Lantern Sketch');
  const desk = t.studio(token, s.id, 'desk');
  return { t, run, token, device, s, desk };
}
type World = Awaited<ReturnType<typeof world>>;

const HOUR = 3_600_000;
const runs = (run: FakeSocket) => run.got('agent-run') as (Msg & { job: string; prompt: string; token: string })[];
const extraOf = (t: App, job: string) =>
  JSON.parse(
    (t.services.store.database.prepare('SELECT extra FROM agent_turns WHERE job = ?').get(job) as { extra: string })
      .extra,
  ) as TurnExtra;
const lastTurn = async (t: App, token: string, project: string) =>
  (
    (await t.app.inject({ method: 'GET', url: `/api/agent/threads/${project}`, headers: auth(token) })).json() as {
      thread: { turns: Msg[] };
    }
  ).thread.turns.at(-1) as Msg;
const wait = (t: App, token: string, job: string, method: 'POST' | 'DELETE' = 'POST') =>
  t.app.inject({ method, url: `/api/agent/jobs/${job}/wait`, headers: auth(token) });
/** The job as a studio was last told of it. */
const told = (desk: FakeSocket) => (desk.got('agent-status').at(-1) as Msg).job as Msg;
const look = (t: App, now = Date.now()) => t.services.jobs.carryOnPending(now);
const waiting = (t: App) => t.services.jobs.carryWaiting();

/** A request that failed as its runner says: its job. */
async function failed(w: World, text: string, failure: Msg) {
  const res = await w.t.app.inject({
    method: 'POST',
    url: '/api/agent/requests',
    headers: auth(w.token),
    payload: { project: w.s.id, text },
  });
  expect(res.statusCode, res.body).toBe(200);
  const { job } = res.json() as { job: string };
  w.run.say({ type: 'agent-session', job, session: 'sess-1' });
  w.run.say({ type: 'agent-failed', job, ...failure });
  await waitFor(() => w.t.services.jobs.get(job)?.view.state === 'failed');
  return job;
}
/** Out of usage till an hour from now, and asked to carry on then: the job, and when it will. */
async function asked(w: World) {
  const resets = Date.now() + HOUR;
  const job = await failed(w, 'Strings under the chorus', { error: 'You’ve reached your limit', why: 'usage', resets });
  const res = await wait(w.t, w.token, job);
  expect(res.statusCode, res.body).toBe(200);
  return { job, resets, until: (res.json() as { until: number }).until };
}

describe('carry on when it resets', () => {
  it('carries the request on a moment after its limit has started again, not before', async () => {
    const w = await world();
    const { job, resets, until } = await asked(w);
    // (a moment after: the vendor's clock and this one's aren't the same to the second)
    expect(until).toBe(resets + 15_000);
    expect(extraOf(w.t, job)).toMatchObject({ wait: until });
    expect(await lastTurn(w.t, w.token, w.s.id)).toMatchObject({ job, state: 'failed', wait: until });
    // the studios with the song open read its conversation again (a job long over isn't told of as news)
    expect(told(w.desk).wait).toBeUndefined();
    expect(w.desk.got('agent-thread').at(-1)).toEqual({ type: 'agent-thread', project: w.s.id });
    expect(waiting(w.t)).toEqual([w.s.id]);
    await look(w.t, until - 1);
    expect(runs(w.run)).toHaveLength(1);
    await look(w.t, until);
    expect(runs(w.run)).toHaveLength(2);
    const go = runs(w.run)[1];
    expect(go).toMatchObject({ session: 'sess-1' });
    expect(go?.prompt).toContain('Your last go at this request didn’t finish');
    expect(w.t.services.jobs.get(go?.job as string)?.view).toMatchObject({ continues: job });
    // (it isn't one that carried on by itself after being cut short: that's another once)
    expect(extraOf(w.t, go?.job as string).auto).toBeUndefined();
    // the go it carried on waits for nothing any more
    expect(extraOf(w.t, job).wait).toBeUndefined();
    expect(waiting(w.t)).toEqual([]);
  });

  it('only where the harness said when its limit starts again, and only for who asked', async () => {
    const w = await world();
    const blip = await failed(w, 'One', { error: 'Overloaded' });
    expect((await wait(w.t, w.token, blip)).json()).toMatchObject({ reason: 'no-reset' });
    const noTime = await failed(w, 'Two', { error: 'Quota exceeded.', why: 'usage' });
    expect((await wait(w.t, w.token, noTime)).json()).toMatchObject({ reason: 'no-reset' });
    // (an earlier turn: the conversation has moved on from it)
    expect((await wait(w.t, w.token, blip)).statusCode).toBe(409);
    const out = await failed(w, 'Three', { error: 'Limit', why: 'usage', resets: Date.now() + HOUR });
    const phone = await w.t.admit(w.token);
    expect((await wait(w.t, phone.token, out)).statusCode).toBe(403);
    expect((await wait(w.t, phone.token, out, 'DELETE')).statusCode).toBe(403);
    expect((await wait(w.t, w.token, 'agj_000000000000')).statusCode).toBe(404);
    expect(waiting(w.t)).toEqual([]);
    // a limit that has started again already: carried on a moment from now
    const past = await failed(w, 'Four', { error: 'Limit', why: 'usage', resets: Date.now() + 50 });
    await new Promise((ok) => setTimeout(ok, 60));
    const before = Date.now();
    const res = (await wait(w.t, w.token, past)).json() as { until: number };
    expect(res.until).toBeGreaterThanOrEqual(before + 15_000);
    expect(res.until).toBeLessThan(Date.now() + 16_000);
  });

  it('is called off by the user, and the reply is as it failed', async () => {
    const w = await world();
    const { job, until } = await asked(w);
    expect((await wait(w.t, w.token, job, 'DELETE')).statusCode).toBe(200);
    expect(extraOf(w.t, job).wait).toBeUndefined();
    expect((await lastTurn(w.t, w.token, w.s.id)).wait).toBeUndefined();
    expect(w.t.services.jobs.get(job)?.view.wait).toBeUndefined();
    expect(waiting(w.t)).toEqual([]);
    await look(w.t, until + 1);
    expect(runs(w.run)).toHaveLength(1);
  });

  it('is called off by the conversation moving on: the request carried on another way, or started over', async () => {
    const w = await world();
    const { job, until } = await asked(w);
    // Continue with… (here: Try again, as the song runs now) carries it on at once
    const res = await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${job}/continue`,
      headers: auth(w.token),
      payload: {},
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(extraOf(w.t, job).wait).toBeUndefined();
    expect(waiting(w.t)).toEqual([]);
    const second = (res.json() as { job: string }).job;
    w.run.say({ type: 'agent-failed', job: second, error: 'Overloaded' });
    await waitFor(() => w.t.services.jobs.get(second)?.view.state === 'failed');
    await look(w.t, until + 1);
    expect(runs(w.run)).toHaveLength(2);
    expect(waiting(w.t)).toEqual([]);
    // started over
    const other = await world();
    const b = await asked(other);
    await other.t.app.inject({
      method: 'POST',
      url: `/api/agent/threads/${other.s.id}/reset`,
      headers: auth(other.token),
    });
    expect(waiting(other.t)).toEqual([]);
    expect(extraOf(other.t, b.job).wait).toBeUndefined();
    await look(other.t, b.until + 1);
    expect(runs(other.run)).toHaveLength(1);
  });

  it('is called off by a later request, whose own go still carries on by itself when it’s cut short', async () => {
    const w = await world();
    const { job } = await asked(w);
    // a later request: the one before it waits for nothing any more
    const res = await w.t.app.inject({
      method: 'POST',
      url: '/api/agent/requests',
      headers: auth(w.token),
      payload: { project: w.s.id, text: 'Something else' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const later = (res.json() as { job: string }).job;
    expect(extraOf(w.t, job).wait).toBeUndefined();
    expect(waiting(w.t)).toEqual([]);
    // its runner goes: it's cut short, and carries on by itself when one is back (nothing stale in its way)
    w.t.services.jobs.limits.droppedMs = 30;
    w.run.close();
    await waitFor(() => w.t.services.jobs.get(later)?.view.state === 'failed');
    const back = w.t.runner();
    await waitFor(() => runs(back).length === 1);
    expect(w.t.services.jobs.get(runs(back)[0]?.job as string)?.view).toMatchObject({ continues: later });
  });

  it('after a restart only the conversation’s last turn waits, whatever an earlier one still said', async () => {
    const w = await world();
    const a = await asked(w);
    const c = await failed(w, 'Something else', { error: 'Limit', why: 'usage', resets: Date.now() + HOUR / 2 });
    const until = ((await wait(w.t, w.token, c)).json() as { until: number }).until;
    // (as a version that didn't clear the earlier one would have left it)
    const db = w.t.services.store.database;
    db.prepare('UPDATE agent_turns SET extra = ? WHERE job = ?').run(
      JSON.stringify({ ...extraOf(w.t, a.job), wait: a.until }),
      a.job,
    );
    await w.t.stop();
    open.splice(open.indexOf(w.t), 1);
    const t = await agentApp(w.t.work);
    open.push(t);
    expect(extraOf(t, a.job).wait).toBeUndefined();
    expect(extraOf(t, c).wait).toBe(until);
    const run = t.runner();
    await look(t, until);
    expect(runs(run)).toHaveLength(1);
    expect(t.services.jobs.get(runs(run)[0]?.job as string)?.view).toMatchObject({ continues: c });
    await look(t, a.until + 1);
    expect(runs(run)).toHaveLength(1);
  });

  it('is called off with the agent turned off, or the device let go', async () => {
    const off = await world();
    const a = await asked(off);
    const settings = (enabled: boolean) =>
      off.t.app.inject({ method: 'PUT', url: '/api/agent/settings', headers: auth(off.token), payload: { enabled } });
    await settings(false);
    expect(waiting(off.t)).toEqual([]);
    expect(extraOf(off.t, a.job).wait).toBeUndefined();
    // (on again before the time: it was called off, and stays so)
    await settings(true);
    await look(off.t, a.until + 1);
    expect(runs(off.run)).toHaveLength(1);

    const gone = await world();
    const b = await asked(gone);
    const removed = await gone.t.app.inject({
      method: 'DELETE',
      url: `/api/agent/devices/${gone.device.id}`,
      headers: auth(gone.token),
    });
    expect(removed.statusCode, removed.body).toBe(200);
    expect(waiting(gone.t)).toEqual([]);
    expect(extraOf(gone.t, b.job).wait).toBeUndefined();
  });

  it('called off while its studio saves as it begins, it doesn’t begin', async () => {
    const w = await world();
    const { job, until } = await asked(w);
    const saves = w.desk.answer;
    let release: () => void = () => undefined;
    const held = new Promise<void>((ok) => {
      release = ok;
    });
    w.desk.answer = (msg) =>
      msg.type === 'agent-flush' ? held.then((): Msg => ({ ok: true, revision: 0 })) : (saves?.(msg) ?? null);
    const began = look(w.t, until);
    await waitFor(() => w.desk.got('agent-flush').length === 2);
    expect((await wait(w.t, w.token, job, 'DELETE')).statusCode).toBe(200);
    release();
    await began;
    expect(runs(w.run)).toHaveLength(1);
    expect(waiting(w.t)).toEqual([]);
    expect(extraOf(w.t, job).wait).toBeUndefined();
  });

  it('ends the wait when the request can’t begin for a reason that won’t pass, and doesn’t ask again', async () => {
    const w = await world();
    const { job, until } = await asked(w);
    const store = w.t.services.store;
    const snapshot = store.snapshotNow.bind(store);
    store.snapshotNow = () => {
      throw new Error('The disk is full');
    };
    // (a go that carries one on keeps its restore point: the song itself can't be read, say)
    const get = store.get.bind(store);
    let fails = true;
    store.get = (id: string) => {
      if (fails) throw new Error('The song can’t be read');
      return get(id);
    };
    await look(w.t, until);
    fails = false;
    store.snapshotNow = snapshot;
    expect(runs(w.run)).toHaveLength(1);
    expect(waiting(w.t)).toEqual([]);
    expect(extraOf(w.t, job).wait).toBeUndefined();
    const flushes = w.desk.got('agent-flush').length;
    await look(w.t, until + 10_000);
    expect(w.desk.got('agent-flush')).toHaveLength(flushes);
  });

  it('is kept across a restart of HO[LO], and carried on without its studio when that isn’t there', async () => {
    const w = await world();
    const { job, until } = await asked(w);
    await w.t.stop();
    open.splice(open.indexOf(w.t), 1);
    const t = await agentApp(w.t.work);
    open.push(t);
    expect(waiting(t)).toEqual([w.s.id]);
    expect(await lastTurn(t, w.token, w.s.id)).toMatchObject({ job, wait: until });
    const run = t.runner();
    await look(t, until - 1);
    expect(runs(run)).toEqual([]);
    await look(t, until);
    expect(runs(run)).toHaveLength(1);
    expect(t.services.jobs.get(runs(run)[0]?.job as string)?.view).toMatchObject({
      continues: job,
      device: w.device.id,
    });
    // (what it changes is saved here, for its studio to pick up)
    const saved = await t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${runs(run)[0]?.job}/ops`,
      headers: auth(runs(run)[0]?.token as string),
      payload: {
        ops: [{ op: 'setProject', patch: { title: 'Lantern Sketch (strings)' } }],
        label: 'Retitle',
        batch: 'b1',
      },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(t.services.store.get(w.s.id)?.title).toBe('Lantern Sketch (strings)');
  });

  it('waits for the runner when it’s away at that time, for a day; then the reply is as it failed', async () => {
    const w = await world();
    const { job, until } = await asked(w);
    w.run.close();
    await look(w.t, until + HOUR);
    expect(waiting(w.t)).toEqual([w.s.id]);
    expect(extraOf(w.t, job).wait).toBe(until);
    const back = w.t.runner();
    // (looked at as the runner reports, but by the clock it isn't time yet: as the tick finds it later)
    expect(runs(back)).toEqual([]);
    await look(w.t, until + 2 * HOUR);
    expect(runs(back)).toHaveLength(1);

    const late = await world();
    const b = await asked(late);
    late.run.close();
    await look(late.t, b.until + 25 * HOUR);
    expect(waiting(late.t)).toEqual([]);
    expect(extraOf(late.t, b.job).wait).toBeUndefined();
    expect((await lastTurn(late.t, late.token, late.s.id)).wait).toBeUndefined();
  });

  it('waits on when its harness isn’t ready at that time', async () => {
    const w = await world();
    const { until } = await asked(w);
    // the harness signed out at that time: it waits on
    w.run.say({
      type: 'harnesses',
      list: [{ id: 'claude', name: 'Claude Code', found: true, sealed: true, signedIn: false }],
    });
    await look(w.t, until + 1);
    expect(runs(w.run)).toHaveLength(1);
    expect(waiting(w.t)).toEqual([w.s.id]);
  });
});
