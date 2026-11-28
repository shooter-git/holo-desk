/**
 * The queue: a request sent while another works on its song waits its turn, and starts by itself when
 * that one is done. Held after one that failed or was stopped (Send lets it go), and while a reply
 * waits for the user's OK.
 */
import { afterEach, describe, expect, it } from 'vitest';
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
type Run = Msg & { job: string; prompt: string; token: string };

const runs = (run: FakeSocket) => run.got('agent-run') as Run[];
const send = (w: World, text: string, more: Msg = {}, token = w.token) =>
  w.t.app.inject({
    method: 'POST',
    url: '/api/agent/requests',
    headers: auth(token),
    payload: { project: w.s.id, text, queue: true, ...more },
  });
const view = async (w: World) =>
  (await w.t.app.inject({ method: 'GET', url: `/api/agent/threads/${w.s.id}`, headers: auth(w.token) })).json() as {
    thread: { turns: Msg[] } | null;
    queue: { id: string; text: string; device: string }[];
    held: boolean;
    asks: boolean;
  };
const queued = async (w: World) => (await view(w)).queue.map((q) => q.text);
/** The newest request the runner was handed ends: done with a reply, or as given. */
const end = async (w: World, how: Msg = { type: 'agent-done' }, run = w.run) => {
  const go = runs(run).at(-1) as Run;
  if (how.type === 'agent-done')
    await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${go.job}/finish`,
      headers: auth(go.token),
      payload: { label: 'Done', reply: 'Done.' },
    });
  run.say({ ...how, job: go.job });
  await waitFor(() => !['waiting', 'running'].includes(w.t.services.jobs.get(go.job)?.view.state ?? ''));
  return go.job;
};
/** Wait for something asked of the host to be so. */
const until = async (check: () => Promise<boolean>) => {
  const end = Date.now() + 2000;
  while (!(await check())) {
    if (Date.now() > end) throw new Error('Timed out waiting');
    await new Promise((ok) => setTimeout(ok, 5));
  }
};
/** The studio's `nth` save from now takes until it's released (the others answer at once). */
const slowSave = (desk: FakeSocket, nth: number) => {
  let release: () => void = () => undefined;
  const held = new Promise<void>((ok) => {
    release = ok;
  });
  const saves = desk.answer;
  let asked = 0;
  desk.answer = (msg) =>
    msg.type === 'agent-flush' && ++asked === nth
      ? held.then((): Msg => ({ ok: true, revision: 0 }))
      : (saves?.(msg) ?? null);
  return { release: () => release() };
};
const act = (w: World, id: string, method: 'PUT' | 'DELETE' | 'POST', payload?: Msg, token = w.token) =>
  w.t.app.inject({
    method,
    url: `/api/agent/queue/${id}${method === 'POST' ? '/send' : ''}`,
    headers: auth(token),
    ...(payload ? { payload } : {}),
  });

describe('a request sent while another works on the song', () => {
  it('waits its turn, and starts by itself when the one before it is done, in the order sent', async () => {
    const w = await world();
    const first = await send(w, 'One');
    // (nothing works on the song: it starts at once, as a request does)
    expect(first.json()).toEqual({ job: runs(w.run)[0]?.job });
    const second = (await send(w, 'Two', { context: { view: 'mixer', playhead: 0 } })).json() as { queued: string };
    expect(second.queued).toMatch(/^agq_[0-9a-f]{12}$/);
    await send(w, 'Three');
    expect(await view(w)).toMatchObject({
      queue: [
        { id: second.queued, text: 'Two', device: w.device.id },
        { text: 'Three', device: w.device.id },
      ],
      held: false,
    });
    expect(runs(w.run)).toHaveLength(1);
    // the studios with the song open are told to read it again
    expect(w.desk.got('agent-thread').length).toBeGreaterThanOrEqual(2);
    await end(w);
    await waitFor(() => runs(w.run).length === 2);
    expect(runs(w.run)[1]?.prompt).toContain('## The request\nTwo');
    // (what the studio showed as it was sent goes with it)
    expect(runs(w.run)[1]?.prompt).toContain('mixer');
    expect(w.t.services.jobs.get(runs(w.run)[1]?.job as string)?.view).toMatchObject({ device: w.device.id });
    expect(await queued(w)).toEqual(['Three']);
    await end(w);
    await waitFor(() => runs(w.run).length === 3);
    expect(runs(w.run)[2]?.prompt).toContain('## The request\nThree');
    await end(w);
    expect(await view(w)).toMatchObject({ queue: [], held: false });
    expect((await view(w)).thread?.turns.map((t) => t.request)).toEqual(['One', 'Two', 'Three']);
  });

  it('is refused as before without `queue`, and for a scan’s preset; five wait at most', async () => {
    const w = await world();
    await send(w, 'One');
    const plain = await w.t.app.inject({
      method: 'POST',
      url: '/api/agent/requests',
      headers: auth(w.token),
      payload: { project: w.s.id, text: 'Two' },
    });
    expect(plain.json()).toMatchObject({ reason: 'busy' });
    for (const n of [2, 3, 4, 5, 6]) expect((await send(w, `Request ${n}`)).statusCode).toBe(200);
    expect((await send(w, 'One too many')).json()).toMatchObject({ reason: 'queue-full' });
    expect(await queued(w)).toHaveLength(5);
    // a device that doesn't have the song open can't queue on it
    const phone = await w.t.admit(w.token);
    expect((await send(w, 'From elsewhere', {}, phone.token)).json()).toMatchObject({ reason: 'not-open' });
  });

  it('starts whether or not its studio is still there: its changes are then saved here', async () => {
    const w = await world();
    await send(w, 'One');
    await send(w, 'Two');
    // (a studio that went with its page in view is waited for a little, as after a reload)
    w.t.services.jobs.limits.awayMs = 30;
    w.desk.close();
    // (the harness's own last words stand as its reply)
    w.run.say({ type: 'agent-done', job: runs(w.run)[0]?.job, reply: 'Done.' });
    await waitFor(() => runs(w.run).length === 2);
    const go = runs(w.run)[1] as Run;
    const saved = await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${go.job}/ops`,
      headers: auth(go.token),
      payload: { ops: [{ op: 'setProject', patch: { title: 'Lantern Sketch (two)' } }], label: 'Retitle', batch: 'b1' },
    });
    expect(saved.statusCode, saved.body).toBe(200);
    expect(w.t.services.store.get(w.s.id)?.title).toBe('Lantern Sketch (two)');
  });
});

describe('the queue is held', () => {
  it('after a request that failed or was stopped, until Send lets its first go', async () => {
    const w = await world();
    await send(w, 'One');
    const two = (await send(w, 'Two')).json() as { queued: string };
    const three = (await send(w, 'Three')).json() as { queued: string };
    const told = w.desk.got('agent-thread').length;
    await end(w, { type: 'agent-failed', error: 'Overloaded' });
    await new Promise((ok) => setTimeout(ok, 30));
    expect(runs(w.run)).toHaveLength(1);
    expect(await view(w)).toMatchObject({ queue: [{ text: 'Two' }, { text: 'Three' }], held: true });
    // (the studios that list them are told to read how they stand: held now)
    expect(w.desk.got('agent-thread').length).toBe(told + 1);
    // (a request sent now joins it: it doesn't jump the ones that wait)
    expect((await send(w, 'Four')).json()).toHaveProperty('queued');
    // only its first can be sent
    expect((await act(w, three.queued, 'POST')).json()).toMatchObject({ reason: 'not-first' });
    const sent = await act(w, two.queued, 'POST');
    expect(sent.statusCode, sent.body).toBe(200);
    expect(runs(w.run)[1]).toMatchObject({ job: (sent.json() as { job: string }).job });
    expect(runs(w.run)[1]?.prompt).toContain('## The request\nTwo');
    expect(await view(w)).toMatchObject({ queue: [{ text: 'Three' }, { text: 'Four' }], held: false });
    // and from there it goes on by itself
    await end(w);
    await waitFor(() => runs(w.run).length === 3);
    // stopped: held again
    await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${runs(w.run)[2]?.job}/cancel`,
      headers: auth(w.token),
    });
    await new Promise((ok) => setTimeout(ok, 30));
    expect(runs(w.run)).toHaveLength(3);
    expect(await view(w)).toMatchObject({ queue: [{ text: 'Four' }], held: true });
  });

  it('goes on once the failed request is carried on to its end', async () => {
    const w = await world();
    await send(w, 'One');
    await send(w, 'Two');
    const failed = await end(w, { type: 'agent-failed', error: 'Overloaded' });
    const again = await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${failed}/continue`,
      headers: auth(w.token),
      payload: {},
    });
    expect(again.statusCode, again.body).toBe(200);
    expect(await view(w)).toMatchObject({ queue: [{ text: 'Two' }], held: false });
    await end(w);
    await waitFor(() => runs(w.run).length === 3);
    expect(runs(w.run)[2]?.prompt).toContain('## The request\nTwo');
  });

  it('while a reply waits for the user’s OK, and goes on after it: allowed, or not now', async () => {
    const w = await world();
    await send(w, 'One');
    await send(w, 'Two');
    const go = runs(w.run)[0] as Run;
    await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${go.job}/permission`,
      headers: auth(go.token),
      payload: { kind: 'bounce', detail: 'To hear the mix' },
    });
    w.run.say({ type: 'agent-done', job: go.job });
    await waitFor(() => w.t.services.jobs.get(go.job)?.view.state === 'awaiting');
    await new Promise((ok) => setTimeout(ok, 30));
    expect(runs(w.run)).toHaveLength(1);
    // (it waits for the answer; or for Send, which passes the question over)
    expect(await view(w)).toMatchObject({ queue: [{ text: 'Two' }], held: true, asks: true });
    const no = await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${go.job}/permission`,
      headers: auth(w.token),
      payload: { grant: false },
    });
    expect(no.statusCode, no.body).toBe(200);
    await waitFor(() => runs(w.run).length === 2);
    expect(runs(w.run)[1]?.prompt).toContain('## The request\nTwo');

    // allowed: the follow-up runs first, then what waited
    const other = await world();
    await send(other, 'One');
    await send(other, 'Two');
    const asks = runs(other.run)[0] as Run;
    await other.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${asks.job}/permission`,
      headers: auth(asks.token),
      payload: { kind: 'bounce', detail: 'To hear the mix' },
    });
    other.run.say({ type: 'agent-done', job: asks.job });
    await waitFor(() => other.t.services.jobs.get(asks.job)?.view.state === 'awaiting');
    await other.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${asks.job}/permission`,
      headers: auth(other.token),
      payload: { grant: true, result: 'Bounced (3:41)' },
    });
    await waitFor(() => runs(other.run).length === 2);
    expect(runs(other.run)[1]?.prompt).not.toContain('## The request\nTwo');
    await end(other);
    await waitFor(() => runs(other.run).length === 3);
    expect(runs(other.run)[2]?.prompt).toContain('## The request\nTwo');
  });

  it('when its first can’t start (its harness signed out), saying why on Send', async () => {
    const w = await world();
    await send(w, 'One');
    const two = (await send(w, 'Two')).json() as { queued: string };
    w.run.say({
      type: 'harnesses',
      list: [{ id: 'claude', name: 'Claude Code', found: true, sealed: true, signedIn: false }],
    });
    await end(w);
    await new Promise((ok) => setTimeout(ok, 30));
    expect(runs(w.run)).toHaveLength(1);
    expect(await view(w)).toMatchObject({ queue: [{ text: 'Two' }], held: true });
    expect((await act(w, two.queued, 'POST')).json()).toMatchObject({ reason: 'signed-out' });
    expect(await queued(w)).toEqual(['Two']);
  });
});

describe('what waits behind a reply’s question', () => {
  /** One asks for an OK and ends, with Two waiting behind it. */
  async function asking() {
    const w = await world();
    await send(w, 'One');
    const two = (await send(w, 'Two')).json() as { queued: string };
    const go = runs(w.run)[0] as Run;
    await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${go.job}/permission`,
      headers: auth(go.token),
      payload: { kind: 'bounce', detail: 'To hear the mix' },
    });
    w.run.say({ type: 'agent-done', job: go.job });
    await waitFor(() => w.t.services.jobs.get(go.job)?.view.state === 'awaiting');
    return { w, two: two.queued, asked: go.job };
  }

  it('can be sent without answering it: the question is passed over, as a new request passes it', async () => {
    const { w, two } = await asking();
    // a request typed now joins what waits (it doesn't start ahead of it), and nothing is stuck
    expect((await send(w, 'Three')).json()).toHaveProperty('queued');
    expect(await view(w)).toMatchObject({ queue: [{ text: 'Two' }, { text: 'Three' }], held: true, asks: true });
    const sent = await act(w, two, 'POST');
    expect(sent.statusCode, sent.body).toBe(200);
    expect(runs(w.run)[1]?.prompt).toContain('## The request\nTwo');
    await end(w);
    await waitFor(() => runs(w.run).length === 3);
    expect(runs(w.run)[2]?.prompt).toContain('## The request\nThree');
  });

  it('is held once the question is dismissed, and the studios that list it are told', async () => {
    const { w, asked } = await asking();
    const told = w.desk.got('agent-thread').length;
    await w.t.app.inject({ method: 'POST', url: `/api/agent/jobs/${asked}/cancel`, headers: auth(w.token) });
    expect(await view(w)).toMatchObject({ queue: [{ text: 'Two' }], held: true, asks: false });
    expect(w.desk.got('agent-thread').length).toBeGreaterThan(told);
    expect(runs(w.run)).toHaveLength(1);
  });
});

describe('what waits is told to the studios as it changes', () => {
  it('held no more once the failed request is tried again, and held again when that fails too', async () => {
    const w = await world();
    await send(w, 'One');
    await send(w, 'Two');
    const failed = await end(w, { type: 'agent-failed', error: 'Overloaded' });
    let told = w.desk.got('agent-thread').length;
    await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${failed}/continue`,
      headers: auth(w.token),
      payload: {},
    });
    expect(w.desk.got('agent-thread').length).toBeGreaterThan(told);
    expect(await view(w)).toMatchObject({ held: false });
    told = w.desk.got('agent-thread').length;
    await end(w, { type: 'agent-failed', error: 'Overloaded' });
    expect(w.desk.got('agent-thread').length).toBeGreaterThan(told);
    expect(await view(w)).toMatchObject({ queue: [{ text: 'Two' }], held: true });
  });

  it('one being started shows no more as waiting, and counts no more against the five', async () => {
    const w = await world();
    await send(w, 'One');
    for (const n of [2, 3, 4, 5, 6]) await send(w, `Request ${n}`);
    // its studio takes a while to save as it begins (the save after One's end is the first asked for)
    const slow = slowSave(w.desk, 2);
    await end(w);
    await until(async () => (await queued(w)).length === 4);
    expect(await queued(w)).toEqual(['Request 3', 'Request 4', 'Request 5', 'Request 6']);
    expect((await send(w, 'Request 7')).json()).toHaveProperty('queued');
    slow.release();
    await waitFor(() => runs(w.run).length === 2);
    expect(runs(w.run)[1]?.prompt).toContain('## The request\nRequest 2');
  });
});

describe('nothing goes ahead of what waits, or starts when it shouldn’t', () => {
  it('a request that doesn’t queue (a scan’s task, an older studio) is refused while others are held', async () => {
    const w = await world();
    await send(w, 'One');
    await send(w, 'Two');
    await end(w, { type: 'agent-failed', error: 'Overloaded' });
    const plain = await w.t.app.inject({
      method: 'POST',
      url: '/api/agent/requests',
      headers: auth(w.token),
      payload: { project: w.s.id, text: 'Jumper' },
    });
    expect(plain.json()).toMatchObject({ reason: 'queue-waits' });
    expect(runs(w.run)).toHaveLength(1);
    expect(await view(w)).toMatchObject({ queue: [{ text: 'Two' }], held: true });
  });

  it('one being started doesn’t begin once the agent is turned off, or its device let go, meanwhile', async () => {
    for (const how of ['off', 'removed'] as const) {
      const w = await world();
      const phone = await w.t.admit(w.token);
      await send(w, 'One');
      await send(w, 'Two');
      const slow = slowSave(w.desk, 2);
      await end(w);
      // (Two is being started: its studio is saving)
      await until(async () => (await queued(w)).length === 0);
      if (how === 'off')
        await w.t.app.inject({
          method: 'PUT',
          url: '/api/agent/settings',
          headers: auth(w.token),
          payload: { enabled: false },
        });
      else
        await w.t.app.inject({
          method: 'DELETE',
          url: `/api/agent/devices/${w.device.id}`,
          headers: auth(phone.token),
        });
      slow.release();
      await new Promise((ok) => setTimeout(ok, 50));
      expect(runs(w.run), how).toHaveLength(1);
    }
  });
});

describe('a request that waits', () => {
  it('can be reworded by the device that sent it, and taken out by any allowed device', async () => {
    const w = await world();
    await send(w, 'One');
    const two = (await send(w, 'Two')).json() as { queued: string };
    const three = (await send(w, 'Three')).json() as { queued: string };
    const phone = await w.t.admit(w.token);
    expect((await act(w, two.queued, 'PUT', { text: 'Two, but quieter' }, phone.token)).statusCode).toBe(403);
    expect((await act(w, two.queued, 'PUT', { text: 'Two, but quieter' })).statusCode).toBe(200);
    expect((await act(w, two.queued, 'PUT', { text: '' })).statusCode).toBe(400);
    expect((await act(w, three.queued, 'DELETE', undefined, phone.token)).statusCode).toBe(200);
    expect((await act(w, three.queued, 'DELETE')).statusCode).toBe(404);
    expect((await act(w, 'agq_000000000000', 'PUT', { text: 'x' })).statusCode).toBe(404);
    expect((await act(w, 'not-an-id', 'DELETE')).statusCode).toBe(400);
    expect(await queued(w)).toEqual(['Two, but quieter']);
    await end(w);
    await waitFor(() => runs(w.run).length === 2);
    expect(runs(w.run)[1]?.prompt).toContain('## The request\nTwo, but quieter');
  });

  it('is kept across a restart of HO[LO], held until Send', async () => {
    const w = await world();
    await send(w, 'One');
    const two = (await send(w, 'Two')).json() as { queued: string };
    await end(w, { type: 'agent-failed', error: 'Overloaded' });
    await w.t.stop();
    open.splice(open.indexOf(w.t), 1);
    const t = await agentApp(w.t.work);
    open.push(t);
    const run = t.runner();
    t.studio(w.token, w.s.id, 'desk');
    const again = { ...w, t, run };
    expect(await view(again)).toMatchObject({ queue: [{ id: two.queued, text: 'Two' }], held: true });
    expect((await act(again, two.queued, 'POST')).statusCode).toBe(200);
    expect(runs(run)[0]?.prompt).toContain('## The request\nTwo');
  });

  it('goes with its conversation started over, with the agent turned off, and with its device let go', async () => {
    const reset = await world();
    await send(reset, 'One');
    await send(reset, 'Two');
    await end(reset, { type: 'agent-failed', error: 'Overloaded' });
    await reset.t.app.inject({
      method: 'POST',
      url: `/api/agent/threads/${reset.s.id}/reset`,
      headers: auth(reset.token),
    });
    expect(await view(reset)).toMatchObject({ queue: [], held: false });

    const off = await world();
    await send(off, 'One');
    await send(off, 'Two');
    await off.t.app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(off.token),
      payload: { enabled: false },
    });
    await off.t.app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(off.token),
      payload: { enabled: true },
    });
    expect(await view(off)).toMatchObject({ queue: [] });

    const gone = await world();
    const phone = await gone.t.admit(gone.token);
    gone.t.studio(phone.token, gone.s.id, 'phone');
    await send(gone, 'One');
    await send(gone, 'From the phone', {}, phone.token);
    await send(gone, 'From the desk');
    const devices = (
      await gone.t.app.inject({ method: 'GET', url: '/api/agent/devices', headers: auth(gone.token) })
    ).json() as { devices: { id: string; name: string }[] };
    const other = devices.devices.find((d) => d.id !== gone.device.id) as { id: string };
    await gone.t.app.inject({ method: 'DELETE', url: `/api/agent/devices/${other.id}`, headers: auth(gone.token) });
    expect(await queued(gone)).toEqual(['From the desk']);
  });
});
