/**
 * Why a request stopped, as its runner said it, and Try again: the failed request carried on in the
 * same conversation, as a job that continues it.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { carryOnRequest } from '../src/agent/prompt.ts';
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

const sentFor = (run: FakeSocket, job: string) =>
  run.got('agent-run').find((m) => m.job === job) as Msg & { token: string; prompt: string };
const tool = (t: App, job: string, jobToken: string, path: string, payload: Msg) =>
  t.app.inject({ method: 'POST', url: `/api/agent/jobs/${job}${path}`, headers: auth(jobToken), payload });
const again = (t: App, token: string, job: string) =>
  t.app.inject({ method: 'POST', url: `/api/agent/jobs/${job}/continue`, headers: auth(token), payload: {} });
const extraOf = (t: App, job: string) =>
  JSON.parse(
    (t.services.store.database.prepare('SELECT extra FROM agent_turns WHERE job = ?').get(job) as { extra: string })
      .extra,
  ) as TurnExtra;
const turnsOf = async (t: App, token: string, project: string) =>
  (
    (await t.app.inject({ method: 'GET', url: `/api/agent/threads/${project}`, headers: auth(token) })).json() as {
      thread: { turns: Msg[] };
    }
  ).thread.turns;

async function begin(w: World, body: Msg) {
  const res = await w.t.app.inject({
    method: 'POST',
    url: '/api/agent/requests',
    headers: auth(w.token),
    payload: { project: w.s.id, ...body },
  });
  expect(res.statusCode, res.body).toBe(200);
  const { job } = res.json() as { job: string };
  return { job, token: sentFor(w.run, job).token };
}

/** A request that fails as its runner says, once its job has been heard from. */
async function failed(w: World, body: Msg, failure: Msg) {
  const first = await begin(w, body);
  w.run.say({ type: 'agent-session', job: first.job, session: 'sess-1' });
  w.run.say({ type: 'agent-failed', job: first.job, ...failure });
  await waitFor(() => w.t.services.jobs.get(first.job)?.view.state === 'failed');
  return first;
}

const RETITLE = [{ op: 'setProject', patch: { title: 'Lantern Sketch (strings)' } }];

describe('why a request stopped', () => {
  it('is kept as its runner said it: out of usage till when, signed out, not installed', async () => {
    const w = await world();
    const resets = Date.now() + 3_600_000;
    const first = await failed(w, { text: 'Strings' }, { error: 'You’ve reached your limit', why: 'usage', resets });
    expect(w.t.services.jobs.get(first.job)?.view).toMatchObject({
      state: 'failed',
      error: 'You’ve reached your limit',
      harness: 'claude',
      stop: { why: 'usage', resets },
    });
    expect((await turnsOf(w.t, w.token, w.s.id)).at(-1)).toMatchObject({
      state: 'failed',
      harness: 'claude',
      stop: { why: 'usage', resets },
    });
    const second = await failed(w, { text: 'Strings again' }, { error: 'Not logged in', why: 'signed-out', resets });
    expect(extraOf(w.t, second.job).stop).toEqual({ why: 'signed-out' });
  });

  it('says nothing for a failure with no reason, or with one it doesn’t know', async () => {
    const w = await world();
    const first = await failed(w, { text: 'Strings' }, { error: 'Overloaded' });
    expect(w.t.services.jobs.get(first.job)?.view).not.toHaveProperty('stop');
    const second = await failed(w, { text: 'Strings again' }, { error: 'Overloaded', why: 'tired', resets: 'soon' });
    expect(extraOf(w.t, second.job)).not.toHaveProperty('stop');
  });
});

describe('Try again', () => {
  it('carries the failed request on in the same conversation, as a job that continues it', async () => {
    const w = await world();
    const first = await begin(w, { text: 'Strings under the chorus', context: { view: 'mixer' } });
    w.run.say({ type: 'agent-session', job: first.job, session: 'sess-1' });
    await tool(w.t, first.job, first.token, '/ops', { ops: RETITLE, label: 'Retitle', batch: 'b1' });
    w.run.say({ type: 'agent-failed', job: first.job, error: 'API Error: 529 Overloaded' });
    await waitFor(() => w.t.services.jobs.get(first.job)?.view.state === 'failed');

    const res = await again(w.t, w.token, first.job);
    expect(res.statusCode, res.body).toBe(200);
    const { job: next } = res.json() as { job: string };
    expect(next).not.toBe(first.job);
    const sent = sentFor(w.run, next);
    expect(sent).toMatchObject({ session: 'sess-1', harness: 'claude', thread: sentFor(w.run, first.job).thread });
    expect(sent.prompt).toContain(
      'Your last turn failed (API Error: 529 Overloaded); what it changed may still be in the song.',
    );
    expect(sent.prompt).toContain(carryOnRequest('Strings under the chorus'));
    expect(sent.prompt).toContain('The view in front: mixer.');
    // the same request, the song before it kept as its "before", and its changes for the first go's step
    expect(w.t.services.jobs.get(next)?.view).toMatchObject({
      request: 'Strings under the chorus',
      continues: first.job,
    });
    expect(extraOf(w.t, next)).toMatchObject({ continues: first.job, before: extraOf(w.t, first.job).before });
    await tool(w.t, next, sent.token, '/ops', { ops: RETITLE, label: 'Retitle again', batch: 'b2' });
    expect(w.desk.got('agent-ops').at(-1)).toMatchObject({ job: next, continues: first.job, batch: 'b2' });
    expect(w.desk.got('agent-ops')[0]).not.toHaveProperty('continues');

    // it fails too, and is tried once more: still the first go's request
    w.run.say({ type: 'agent-failed', job: next, error: 'API Error: 529 Overloaded' });
    await waitFor(() => w.t.services.jobs.get(next)?.view.state === 'failed');
    const third = (await again(w.t, w.token, next)).json() as { job: string };
    expect(extraOf(w.t, third.job)).toMatchObject({ continues: first.job });
    expect((await turnsOf(w.t, w.token, w.s.id)).map((t) => t.continues)).toEqual([undefined, first.job, first.job]);
  });

  it('is only for the device that asked, a request that failed, and the conversation’s last', async () => {
    const w = await world();
    const first = await failed(w, { text: 'Strings' }, { error: 'Overloaded' });
    const phone = await w.t.admit(w.token);
    w.t.studio(phone.token, w.s.id, 'phone');
    expect((await again(w.t, phone.token, first.job)).statusCode).toBe(403);
    expect((await again(w.t, w.token, 'agj_000000000000')).statusCode).toBe(404);
    // a later request moved the conversation on
    const later = await begin(w, { text: 'Something else' });
    expect((await again(w.t, w.token, first.job)).statusCode).toBe(409);
    // (and one that's working, or done, isn't tried again)
    expect((await again(w.t, w.token, later.job)).statusCode).toBe(409);
    await tool(w.t, later.job, later.token, '/finish', { label: 'Else', reply: 'Done.' });
    w.run.say({ type: 'agent-done', job: later.job });
    await waitFor(() => w.t.services.jobs.get(later.job)?.view.state === 'done');
    expect((await again(w.t, w.token, later.job)).json()).toMatchObject({ error: 'That request didn’t fail' });
  });

  it('works for a request HO[LO] restarted under, from what its turn kept', async () => {
    const w = await world();
    const first = await begin(w, { text: 'Strings under the chorus' });
    w.run.say({ type: 'agent-session', job: first.job, session: 'sess-1' });
    await w.t.stop();
    open.splice(open.indexOf(w.t), 1);
    const t = await agentApp(w.t.work);
    open.push(t);
    // (past the time in which it would have carried on by itself: agent-restart.test.ts)
    t.services.jobs.carryOnPending(Date.now() + 11 * 60_000);
    const run = t.runner();
    t.studio(w.token, w.s.id, 'desk');
    const res = await again(t, w.token, first.job);
    expect(res.statusCode, res.body).toBe(200);
    const sent = sentFor(run, (res.json() as { job: string }).job);
    expect(sent).toMatchObject({ session: 'sess-1' });
    expect(sent.prompt).toContain('Your last turn failed (HO[LO] restarted while it was working)');
    expect(sent.prompt).toContain(carryOnRequest('Strings under the chorus'));
  });

  it('is refused as a request is when the song isn’t open, or the harness has gone', async () => {
    const w = await world();
    const first = await failed(w, { text: 'Strings' }, { error: 'Overloaded' });
    w.run.say({
      type: 'harnesses',
      list: [{ id: 'claude', name: 'Claude Code', found: true, sealed: true, signedIn: false }],
    });
    expect((await again(w.t, w.token, first.job)).json()).toMatchObject({ reason: 'signed-out' });
    w.desk.close();
    expect((await again(w.t, w.token, first.job)).json()).toMatchObject({ reason: 'not-open' });
  });
});
