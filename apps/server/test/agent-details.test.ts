import { afterEach, describe, expect, it } from 'vitest';
import { agentWorld, auth } from './agent-fakes.ts';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function setup() {
  const w = await agentWorld();
  close = w.close;
  const put = (job: string, token: string, payload: unknown) =>
    w.app.inject({
      method: 'PUT',
      url: `/api/agent/jobs/${job}/details`,
      headers: auth(token),
      payload: payload as Record<string, unknown>,
    });
  return { ...w, put };
}

describe('the agent setting who the song is by and its album', () => {
  it('sets them as the Songs window does, beside the song: no new revision', async () => {
    const { start, put, s, services, tool } = await setup();
    const { job, token } = await start({ project: s.id, text: 'Set the artist to Example Artist' });
    const res = await put(job, token, { artist: '  Es   Claro ', album: 'Night Drives' });
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toEqual({ ok: true, artist: 'Example Artist', album: 'Night Drives' });
    expect(services.store.row(s.id)).toMatchObject({ artist: 'Example Artist', album: 'Night Drives', revision: 0 });
    // the agent's next look at the song says so
    expect(((await tool(job, token, 'GET', '/state')).json() as { about: string[] }).about).toEqual([
      'By "Example Artist", on the album "Night Drives".',
    ]);
    // null clears one, the other stays
    expect((await put(job, token, { album: null })).json()).toEqual({ ok: true, artist: 'Example Artist', album: null });
  });

  it('checks what it is given, and needs the job’s token while the job runs', async () => {
    const { start, put, s, app } = await setup();
    const { job, token } = await start({ project: s.id, text: 'Album' });
    expect((await put(job, token, {})).statusCode).toBe(400);
    expect((await put(job, token, { artist: 42 })).json()).toEqual({
      error: 'artist is a name (one line), or null for none',
    });
    expect((await put(job, token, { album: 'x'.repeat(121) })).statusCode).toBe(400);
    expect((await put(job, 'not-a-token', { artist: 'Anyone' })).statusCode).toBe(401);
    const unauth = await app.inject({ method: 'PUT', url: `/api/agent/jobs/${job}/details`, payload: { artist: 'A' } });
    expect(unauth.statusCode).toBe(401);
    // a job's token, but another job's: the job is the one the token is for
    expect((await put('agj_000000000000', token, { artist: 'Anyone' })).statusCode).toBe(403);
  });

  it("refuses a creation's song: it stays with its creation", async () => {
    const { start, put, s, services, save } = await setup();
    await save({
      ...(services.store.get(s.id) as typeof s),
      origin: { creation: 'moon', piece: 'theme', exportedAt: '' },
    });
    const { job, token } = await start({ project: s.id, text: 'Who is it by' });
    const res = await put(job, token, { artist: 'Me' });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toMatch(/moon's/);
    expect(services.store.row(s.id)).toMatchObject({ artist: null });
  });
});
