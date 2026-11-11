import { randomBytes } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { agentApp, auth, settle } from './agent-fakes.ts';

const MINUTE = 60_000;

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  vi.useRealTimers();
  await close?.();
  close = null;
});

async function setup() {
  const t = await agentApp();
  close = t.close;
  return t;
}

describe('the agent, before any device is allowed', () => {
  it('is off, and GET /api/agent says nothing but booleans', async () => {
    const { app } = await setup();
    const res = await app.inject({ method: 'GET', url: '/api/agent' });
    expect(res.json()).toEqual({
      enabled: false,
      allowed: false,
      pairing: true,
      runner: { connected: false, keyed: false },
    });
    const bogus = await app.inject({ method: 'GET', url: '/api/agent', headers: auth('x'.repeat(43)) });
    expect(bogus.json()).toMatchObject({ allowed: false });
  });

  it('pairs with a code only a keyed runner is sent: it works once, for 10 minutes, and 5 tries', async () => {
    const { app, connect, runner } = await setup();
    // no runner to print it: no code
    const none = await app.inject({ method: 'POST', url: '/api/agent/pairing' });
    expect(none.statusCode).toBe(409);
    expect(none.json()).toMatchObject({ reason: 'no-runner' });

    const old = connect({ role: 'runner', name: 'old runner', caps: { render: true } });
    const keyed = runner();
    const pair = (code: string) =>
      app.inject({ method: 'POST', url: '/api/agent/pair', payload: { code, name: 'Desk' } });
    const start = async () => {
      const res = await app.inject({ method: 'POST', url: '/api/agent/pairing' });
      expect(res.statusCode).toBe(200);
      const sent = keyed.got('pairing-code').at(-1) as { code: string; expires: number };
      expect(res.json()).toEqual({ expires: sent.expires });
      expect(sent.code).toMatch(/^\d{6}$/);
      expect(sent.expires - Date.now()).toBeGreaterThan(9 * MINUTE);
      return sent.code;
    };

    // five wrong tries, and the code no longer works
    const first = await start();
    expect(old.got('pairing-code')).toEqual([]);
    const wrong = first === '000000' ? '111111' : '000000';
    for (let i = 0; i < 5; i++) expect((await pair(wrong)).statusCode).toBe(401);
    expect((await pair(first)).statusCode).toBe(401);

    // ten minutes on, a code has expired
    const second = await start();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 10 * MINUTE + 1000);
    const expired = await pair(second);
    expect(expired.statusCode).toBe(401);
    expect(expired.json().error).toMatch(/expired/);
    vi.useRealTimers();

    // a good code pairs, turns the agent on, and works once
    const third = await start();
    const paired = await pair(third);
    expect(paired.statusCode).toBe(200);
    const { token, device } = paired.json() as { token: string; device: { id: string; name: string } };
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(device).toEqual({ id: expect.stringMatching(/^dev_/), name: 'Desk' });
    expect((await app.inject({ method: 'GET', url: '/api/agent', headers: auth(token) })).json()).toMatchObject({
      enabled: true,
      allowed: true,
      pairing: false,
    });
    // devices exist: pairing is closed, and asking for a code says so
    expect((await pair(third)).statusCode).toBe(409);
    expect((await app.inject({ method: 'POST', url: '/api/agent/pairing' })).statusCode).toBe(409);
    // with the only device gone, that code still doesn't work again
    await app.inject({ method: 'DELETE', url: `/api/agent/devices/${device.id}`, headers: auth(token) });
    expect((await pair(third)).statusCode).toBe(401);
  });

  it('locks pairing for an hour after 20 wrong codes in an hour (429)', async () => {
    const { app, runner } = await setup();
    const keyed = runner();
    const pair = (code: string) =>
      app.inject({ method: 'POST', url: '/api/agent/pair', payload: { code, name: 'Desk' } });
    for (let round = 0; round < 4; round++) {
      await app.inject({ method: 'POST', url: '/api/agent/pairing' });
      const code = String(keyed.got('pairing-code').at(-1)?.code);
      const wrong = code === '000000' ? '111111' : '000000';
      for (let i = 0; i < 5; i++) expect((await pair(wrong)).statusCode).toBe(401);
    }
    expect((await app.inject({ method: 'POST', url: '/api/agent/pairing' })).statusCode).toBe(429);
    expect((await pair('123456')).statusCode).toBe(429);

    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.now() + 60 * MINUTE + 1000);
    expect((await app.inject({ method: 'POST', url: '/api/agent/pairing' })).statusCode).toBe(200);
    expect((await pair(String(keyed.got('pairing-code').at(-1)?.code))).statusCode).toBe(200);
  });
});

describe('allowed devices', () => {
  it('needs a device’s token on every route but the open ones, and a job’s on the tools’', async () => {
    const { app, runner, pair } = await setup();
    const { token } = await pair(runner());
    const J = '/api/agent/jobs/agj_000000000000';
    const deviceRoutes: [string, string][] = [
      ['GET', '/api/agent/devices'],
      ['POST', '/api/agent/devices/requests/dvr_000000000000/approve'],
      ['POST', '/api/agent/devices/requests/dvr_000000000000/deny'],
      ['DELETE', '/api/agent/devices/dev_000000000000'],
      ['GET', '/api/agent/settings'],
      ['PUT', '/api/agent/settings'],
      ['POST', '/api/agent/harnesses/refresh'],
      ['POST', '/api/agent/harnesses/claude/login'],
      ['POST', '/api/agent/harnesses/claude/login/code'],
      ['POST', '/api/agent/harnesses/claude/update'],
      ['POST', '/api/agent/requests'],
      ['POST', `${J}/cancel`],
      ['POST', `${J}/permission`],
      ['POST', `${J}/done-listening`],
      ['GET', '/api/agent/threads/prj_000000'],
      ['POST', '/api/agent/threads/prj_000000/reset'],
      ['POST', '/api/agent/attachments'],
      ['PUT', '/api/agent/attachments/att_000000/meta'],
    ];
    const jobRoutes: [string, string][] = [
      ['GET', `${J}/song`],
      ['GET', `${J}/describe`],
      ['GET', `${J}/state`],
      ['POST', `${J}/ops`],
      ['POST', `${J}/transport`],
      ['POST', `${J}/audition`],
      ['POST', `${J}/listen`],
      ['GET', `${J}/played?seconds=5`],
      ['POST', `${J}/compare`],
      ['GET', `${J}/packs`],
      ['GET', `${J}/packs/available`],
      ['GET', `${J}/instruments/pack/piano`],
      ['GET', `${J}/scans/scn_000000`],
      ['GET', `${J}/scans/scn_000000/strip/0/0`],
      ['PATCH', `${J}/scans/scn_000000/systems/0/0`],
      ['GET', `${J}/attachments/att_000000`],
      ['POST', `${J}/progress`],
      ['POST', `${J}/handoff`],
      ['POST', `${J}/finish`],
    ];
    const ask = (method: string, url: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: method as 'GET',
        url,
        headers,
        ...(method === 'GET' || method === 'DELETE' ? {} : { payload: {} }),
      });
    const someone = randomBytes(32).toString('base64url');
    for (const [method, url] of [...deviceRoutes, ...jobRoutes]) {
      expect((await ask(method, url)).statusCode, `${method} ${url}`).toBe(401);
      expect((await ask(method, url, { authorization: 'Bearer nonsense' })).statusCode, `${method} ${url}`).toBe(401);
      const other = (await ask(method, url, auth(someone))).statusCode;
      expect([401, 403], `${method} ${url}`).toContain(other);
    }
    // the device's token isn't a job's
    expect((await ask('GET', `${J}/song`, auth(token))).statusCode).toBe(403);
    // and with it, the device's routes answer
    expect((await ask('GET', '/api/agent/devices', auth(token))).statusCode).toBe(200);
    expect((await ask('GET', '/api/agent/settings', auth(token))).json()).toMatchObject({
      enabled: true,
      harness: null,
      harnesses: [expect.objectContaining({ id: 'claude', found: true, sealed: true })],
    });
  });

  it('lets a later device ask; an allowed one approves, and its token comes once', async () => {
    const { app, runner, pair, studio } = await setup();
    const { token: desk } = await pair(runner());
    const deskStudio = studio(desk, null);
    const outsider = studio(null, null, 'outsider');

    const ask = (name: unknown) =>
      app.inject({ method: 'POST', url: '/api/agent/devices/requests', payload: { name } });
    expect((await ask('')).statusCode).toBe(400);
    expect((await ask('x'.repeat(61))).statusCode).toBe(400);
    expect((await ask(42)).statusCode).toBe(400);
    const asked = (await ask('Phone')).json() as { id: string; secret: string; code: string };
    expect(asked.code).toMatch(/^[A-Z2-9]{4}$/);
    expect(deskStudio.got('agent-devices').length).toBeGreaterThan(0);
    expect(outsider.got('agent-devices')).toEqual([]);

    const listed = await app.inject({ method: 'GET', url: '/api/agent/devices', headers: auth(desk) });
    expect(listed.json()).toEqual({
      devices: [expect.objectContaining({ name: 'Desk', current: true })],
      requests: [{ id: asked.id, name: 'Phone', code: asked.code, created: expect.any(Number) }],
    });

    const poll = (secret: string) =>
      app.inject({ method: 'GET', url: `/api/agent/devices/requests/${asked.id}?secret=${secret}` });
    expect((await poll(asked.secret)).json()).toEqual({ state: 'pending' });
    expect((await poll(randomBytes(32).toString('base64url'))).statusCode).toBe(404);

    const approve = await app.inject({
      method: 'POST',
      url: `/api/agent/devices/requests/${asked.id}/approve`,
      headers: auth(desk),
    });
    expect(approve.json()).toEqual({ ok: true });
    const approved = (await poll(asked.secret)).json() as { state: string; token: string; device: { id: string } };
    expect(approved).toEqual({
      state: 'approved',
      token: expect.stringMatching(/^[A-Za-z0-9_-]{43}$/),
      device: { id: expect.stringMatching(/^dev_/), name: 'Phone' },
    });
    // once
    expect((await poll(asked.secret)).json()).toEqual({ state: 'approved' });
    expect(
      (await app.inject({ method: 'GET', url: '/api/agent', headers: auth(approved.token) })).json(),
    ).toMatchObject({ allowed: true });

    // denied
    const other = (await ask('Tablet')).json() as { id: string; secret: string };
    await app.inject({ method: 'POST', url: `/api/agent/devices/requests/${other.id}/deny`, headers: auth(desk) });
    expect(
      (
        await app.inject({ method: 'GET', url: `/api/agent/devices/requests/${other.id}?secret=${other.secret}` })
      ).json(),
    ).toEqual({ state: 'denied' });

    // at most 5 waiting
    for (let i = 0; i < 5; i++) expect((await ask(`Guest ${i}`)).statusCode).toBe(200);
    expect((await ask('One too many')).statusCode).toBe(429);
  });

  it('answers only Settings and Remove while the agent is off', async () => {
    const { app, runner, pair, song, studio } = await setup();
    const { token } = await pair(runner());
    const s = await song();
    studio(token, s.id);
    const off = await app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(token),
      payload: { enabled: false },
    });
    expect(off.json()).toMatchObject({ enabled: false });
    const request = await app.inject({
      method: 'POST',
      url: '/api/agent/requests',
      headers: auth(token),
      payload: { project: s.id, text: 'A bass line' },
    });
    expect(request.statusCode).toBe(409);
    expect(request.json()).toMatchObject({ reason: 'off' });
    expect(
      (await app.inject({ method: 'POST', url: '/api/agent/devices/requests', payload: { name: 'Phone' } })).statusCode,
    ).toBe(409);
    expect(
      (await app.inject({ method: 'GET', url: `/api/agent/threads/${s.id}`, headers: auth(token) })).statusCode,
    ).toBe(409);
    expect((await app.inject({ method: 'GET', url: '/api/agent/devices', headers: auth(token) })).statusCode).toBe(200);
    const on = await app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(token),
      payload: { enabled: true, model: 'opus', effort: 'high' },
    });
    expect(on.json()).toMatchObject({ enabled: true, model: 'opus', effort: 'high' });
    const badModel = await app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(token),
      payload: { model: '--dangerously-skip-permissions' },
    });
    expect(badModel.statusCode).toBe(400);
  });

  it('removes a device at once: its token is refused, its studio loses the agent, its job stops', async () => {
    const { app, runner, pair, admit, studio, song } = await setup();
    const run = runner();
    const { token: desk } = await pair(run);
    const deskStudio = studio(desk, null, 'desk');
    const phone = await admit(desk);
    const s = await song();
    const phoneStudio = studio(phone.token, s.id, 'phone');

    const asked = await app.inject({
      method: 'POST',
      url: '/api/agent/requests',
      headers: auth(phone.token),
      payload: { project: s.id, text: 'A counter-line' },
    });
    expect(asked.statusCode).toBe(200);
    const { job } = asked.json() as { job: string };
    const jobToken = String(run.got('agent-run').at(-1)?.token);
    expect(
      (await app.inject({ method: 'GET', url: `/api/agent/jobs/${job}/song`, headers: auth(jobToken) })).statusCode,
    ).toBe(200);

    const removed = await app.inject({
      method: 'DELETE',
      url: `/api/agent/devices/${phone.device.id}`,
      headers: auth(desk),
    });
    expect(removed.json()).toEqual({ ok: true });

    // the very next request is refused
    expect(
      (await app.inject({ method: 'GET', url: '/api/agent/settings', headers: auth(phone.token) })).statusCode,
    ).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/agent', headers: auth(phone.token) })).json()).toMatchObject({
      allowed: false,
    });
    // its studio hears that its job stopped, then that it's no longer allowed
    const statuses = phoneStudio.got('agent-status');
    expect(statuses.at(-1)).toMatchObject({ job: { id: job, state: 'cancelled' } });
    expect(phoneStudio.got('agent-removed')).toEqual([{ type: 'agent-removed' }]);
    expect(phoneStudio.sent.findIndex((m) => m.type === 'agent-removed')).toBeGreaterThan(
      phoneStudio.sent.lastIndexOf(statuses.at(-1) as Record<string, unknown>),
    );
    // the runner is told to stop it, and its token works no more
    expect(run.got('agent-cancel')).toEqual([{ type: 'agent-cancel', job }]);
    expect(
      (await app.inject({ method: 'GET', url: `/api/agent/jobs/${job}/song`, headers: auth(jobToken) })).statusCode,
    ).toBe(403);
    // what its studio says for the agent is no longer heard, and it hears no more of it
    const before = phoneStudio.sent.length;
    phoneStudio.say({ type: 'history', action: 'undo', label: 'Agent: A counter-line', job });
    await app.inject({ method: 'POST', url: '/api/agent/devices/requests', payload: { name: 'Tablet' } });
    await settle();
    expect(phoneStudio.sent.slice(before).filter((m) => String(m.type).startsWith('agent-'))).toEqual([]);
    expect(deskStudio.got('agent-devices').length).toBeGreaterThan(0);
  });
});
