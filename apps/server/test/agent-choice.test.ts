/**
 * A song's own choice of what its conversation runs with: its harness, model and effort, whatever
 * Settings › Agent says for the others.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { agentApp, auth, CLAUDE, type FakeSocket, type Msg, waitFor } from './agent-fakes.ts';

type App = Awaited<ReturnType<typeof agentApp>>;
const open: App[] = [];
afterEach(async () => {
  for (const t of open.splice(0)) await t.close().catch(() => undefined);
});

const CODEX = { id: 'codex', name: 'Codex', found: true, sealed: true, signedIn: true, version: '0.170.0' };

async function world() {
  const t = await agentApp();
  open.push(t);
  const run = t.runner([CLAUDE, CODEX]);
  const { token, device } = await t.pair(run);
  const s = await t.song('Lantern Sketch');
  const desk = t.studio(token, s.id, 'desk');
  return { t, run, token, device, s, desk };
}
type World = Awaited<ReturnType<typeof world>>;

const sentFor = (run: FakeSocket, job: string) =>
  run.got('agent-run').find((m) => m.job === job) as Msg & { token: string; prompt: string };
const choose = (w: World, project: string, payload: Msg) =>
  w.t.app.inject({ method: 'PUT', url: `/api/agent/threads/${project}/choice`, headers: auth(w.token), payload });
const view = async (w: World, project: string) =>
  (await w.t.app.inject({ method: 'GET', url: `/api/agent/threads/${project}`, headers: auth(w.token) })).json() as {
    thread: { turns: Msg[] } | null;
    choice: Msg | null;
    runsWith: Msg;
  };
const ask = async (w: World, project: string, text: string) => {
  const res = await w.t.app.inject({
    method: 'POST',
    url: '/api/agent/requests',
    headers: auth(w.token),
    payload: { project, text },
  });
  expect(res.statusCode, res.body).toBe(200);
  return (res.json() as { job: string }).job;
};
const finish = async (w: World, job: string, session: string) => {
  w.run.say({ type: 'agent-session', job, session });
  await w.t.app.inject({
    method: 'POST',
    url: `/api/agent/jobs/${job}/finish`,
    headers: auth(sentFor(w.run, job).token),
    payload: { label: 'Done', reply: 'Done.' },
  });
  w.run.say({ type: 'agent-done', job });
  await waitFor(() => w.t.services.jobs.get(job)?.view.state === 'done');
};

describe('a song’s own choice', () => {
  it('is what its requests run with, while the other songs follow Settings', async () => {
    const w = await world();
    expect(await view(w, w.s.id)).toMatchObject({
      choice: null,
      runsWith: { harness: 'claude', model: '', effort: '' },
    });
    const set = await choose(w, w.s.id, { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' });
    expect(set.statusCode, set.body).toBe(200);
    const chosen = { harness: 'codex', model: 'gpt-6.1-sol', effort: 'high' };
    expect(set.json()).toMatchObject({ choice: chosen, runsWith: chosen });
    // the studios with the song open hear of it, and read the conversation again
    expect(w.desk.got('agent-thread').at(-1)).toEqual({ type: 'agent-thread', project: w.s.id });

    const job = await ask(w, w.s.id, 'A bass under it');
    expect(sentFor(w.run, job)).toMatchObject(chosen);
    expect(w.t.services.jobs.get(job)?.view).toMatchObject(chosen);
    await finish(w, job, 'codex-1');
    expect((await view(w, w.s.id)).thread?.turns.at(-1)).toMatchObject(chosen);

    // another song: as Settings says
    const other = await w.t.song('Second Light');
    w.t.studio(w.token, other.id, 'desk two');
    expect(sentFor(w.run, await ask(w, other.id, 'A pad'))).toMatchObject({ harness: 'claude', model: '', effort: '' });
    expect(await view(w, other.id)).toMatchObject({ choice: null, runsWith: { harness: 'claude' } });
  });

  it('lasts until it’s taken back, or the conversation is started over', async () => {
    const w = await world();
    await choose(w, w.s.id, { harness: 'codex', model: '', effort: '' });
    await finish(w, await ask(w, w.s.id, 'One'), 'codex-1');
    expect(sentFor(w.run, await ask(w, w.s.id, 'Two'))).toMatchObject({ harness: 'codex', session: 'codex-1' });
    await finish(w, w.run.got('agent-run').at(-1)?.job as string, 'codex-1');
    // taken back: Settings' again, in the same conversation (told what it missed, as any harness is)
    expect((await choose(w, w.s.id, { harness: null })).json()).toMatchObject({
      choice: null,
      runsWith: { harness: 'claude' },
    });
    const third = sentFor(w.run, await ask(w, w.s.id, 'Three'));
    expect(third).toMatchObject({ harness: 'claude' });
    expect(third.prompt).toContain('## The conversation so far');
    await finish(w, third.job as string, 'claude-1');
    // chosen again, then the conversation started over: the new one follows Settings
    await choose(w, w.s.id, { harness: 'codex', model: '', effort: '' });
    await w.t.app.inject({ method: 'POST', url: `/api/agent/threads/${w.s.id}/reset`, headers: auth(w.token) });
    expect(await view(w, w.s.id)).toMatchObject({ thread: null, choice: null, runsWith: { harness: 'claude' } });
    expect(sentFor(w.run, await ask(w, w.s.id, 'Afresh'))).toMatchObject({ harness: 'claude' });
  });

  it('is refused while a request works on the song, for a harness nobody has, and for what isn’t one', async () => {
    const w = await world();
    expect((await choose(w, w.s.id, { harness: 'cursor' })).json()).toMatchObject({ reason: 'no-harness' });
    expect((await choose(w, w.s.id, { harness: 'emacs' })).statusCode).toBe(400);
    expect((await choose(w, w.s.id, { harness: 'codex', model: 'a model; rm -rf' })).statusCode).toBe(400);
    expect((await choose(w, 'prj_none', { harness: 'codex' })).statusCode).toBe(404);
    await ask(w, w.s.id, 'One');
    expect((await choose(w, w.s.id, { harness: 'codex' })).json()).toMatchObject({ reason: 'busy' });
    expect(await view(w, w.s.id)).toMatchObject({ choice: null });
  });
});

describe('a choice that couldn’t run', () => {
  const MUST = { ...CLAUDE, models: ['opus', 'sonnet'], efforts: ['low', 'high'], mustChoose: true };
  const failAt = async (w: World, text: string) => {
    const res = await w.t.app.inject({
      method: 'POST',
      url: '/api/agent/requests',
      headers: auth(w.token),
      payload: { project: w.s.id, text },
    });
    return res.json() as { error: string; reason: string };
  };

  it('isn’t taken: a harness signed out, or one still needing a model and an effort', async () => {
    const w = await world();
    w.run.say({ type: 'harnesses', list: [MUST, { ...CODEX, signedIn: false }] });
    expect((await choose(w, w.s.id, { harness: 'codex' })).json()).toMatchObject({ reason: 'signed-out' });
    const need = (await choose(w, w.s.id, { harness: 'claude', model: 'opus' })).json() as Msg;
    // (said of the song's own choice, not of Settings › Agent: that's where it's chosen)
    expect(need).toMatchObject({
      reason: 'choose',
      error: 'Choose an effort for Claude Code in this song’s own choice, the line at the top of the agent’s page',
    });
    expect(await view(w, w.s.id)).toMatchObject({ choice: null });
    expect((await choose(w, w.s.id, { harness: 'claude', model: 'opus', effort: 'low' })).statusCode).toBe(200);
  });

  it('says where to change it when it stops being able to: the song’s own choice, not Settings', async () => {
    const w = await world();
    w.run.say({ type: 'harnesses', list: [MUST, CODEX] });
    await choose(w, w.s.id, { harness: 'claude', model: 'opus', effort: 'low' });
    // the harness no longer offers the model
    w.run.say({ type: 'harnesses', list: [{ ...MUST, models: ['sonnet'] }, CODEX] });
    expect(await failAt(w, 'One')).toEqual({
      reason: 'choose',
      error:
        'Claude Code no longer offers “opus”: choose a model for Claude Code in this song’s own choice, the line at the top of the agent’s page',
    });
    // the harness is gone from the host
    await choose(w, w.s.id, { harness: 'codex' });
    w.run.say({ type: 'harnesses', list: [MUST] });
    expect(await failAt(w, 'Two')).toEqual({
      reason: 'no-harness',
      error:
        'Codex isn’t on this computer: pick another harness in this song’s own choice, the line at the top of the agent’s page',
    });
    // a song that follows Settings is still sent there
    const other = await w.t.song('Second Light');
    w.t.studio(w.token, other.id, 'desk two');
    await w.t.app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(w.token),
      payload: { harness: 'cursor' },
    });
    const res = await w.t.app.inject({
      method: 'POST',
      url: '/api/agent/requests',
      headers: auth(w.token),
      payload: { project: other.id, text: 'Three' },
    });
    expect((res.json() as Msg).error).toBe('Cursor isn’t on this computer: pick another harness in Settings › Agent');
  });
});

describe('a song given a choice before its first request', () => {
  it('starts its conversation with the harness that runs first, in the thread’s own folder, told nothing happened “since”', async () => {
    const w = await world();
    await choose(w, w.s.id, { harness: 'codex', model: '', effort: '' });
    // (the studio's steps before any request aren't "since a reply")
    w.desk.say({ type: 'history', action: 'step', label: 'Move notes' });
    const events = () =>
      w.t.services.store.database
        .prepare('SELECT events_json FROM agent_threads WHERE project = ? AND current = 1')
        .get(w.s.id) as { events_json: string } | undefined;
    await waitFor(() => (events()?.events_json ?? '[]') !== '[]');
    await choose(w, w.s.id, { harness: null });
    const sent = sentFor(w.run, await ask(w, w.s.id, 'One')) as Msg & { prompt: string };
    const thread = (await view(w, w.s.id)).thread as unknown as { id: string };
    expect(sent).toMatchObject({ harness: 'claude', thread: thread.id, workspace: thread.id });
    expect(sent.prompt).not.toContain('## Since your last reply');
    expect(sent.prompt).not.toContain('## The conversation so far');
  });
});

describe('started over', () => {
  it('tells the song’s studios, whose line would still say the choice that went with it', async () => {
    const w = await world();
    await choose(w, w.s.id, { harness: 'codex', model: '', effort: '' });
    const before = w.desk.got('agent-thread').length;
    await w.t.app.inject({ method: 'POST', url: `/api/agent/threads/${w.s.id}/reset`, headers: auth(w.token) });
    expect(w.desk.got('agent-thread')).toHaveLength(before + 1);
  });
});

describe('a database from before songs had a choice of their own', () => {
  it('carries its conversations on, following Settings, and takes a choice from then on', async () => {
    const w = await world();
    await finish(w, await ask(w, w.s.id, 'One'), 'claude-1');
    // as the version before this one left it: threads with no choice of their own
    for (const column of ['own_harness', 'own_model', 'own_effort'])
      w.t.services.store.database.exec(`ALTER TABLE agent_threads DROP COLUMN ${column}`);
    await w.t.stop();
    open.splice(open.indexOf(w.t), 1);
    const t = await agentApp(w.t.work);
    open.push(t);
    const run = t.runner([CLAUDE, CODEX]);
    t.studio(w.token, w.s.id, 'desk');
    const again = { ...w, t, run };
    expect(await view(again, w.s.id)).toMatchObject({
      thread: { turns: [{ request: 'One' }] },
      choice: null,
      runsWith: { harness: 'claude' },
    });
    expect(sentFor(run, await ask(again, w.s.id, 'Two'))).toMatchObject({ harness: 'claude', session: 'claude-1' });
    await finish(again, run.got('agent-run').at(-1)?.job as string, 'claude-1');
    expect((await choose(again, w.s.id, { harness: 'codex', model: '', effort: '' })).json()).toMatchObject({
      choice: { harness: 'codex' },
    });
  });
});

describe('Continue with another harness', () => {
  it('carries the failed request on with the harness picked, which becomes the song’s own choice', async () => {
    const w = await world();
    const job = await ask(w, w.s.id, 'Strings under the chorus');
    w.run.say({ type: 'agent-session', job, session: 'claude-1' });
    w.run.say({ type: 'agent-failed', job, error: 'You’ve reached your limit', why: 'usage' });
    await waitFor(() => w.t.services.jobs.get(job)?.view.state === 'failed');
    const res = await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${job}/continue`,
      headers: auth(w.token),
      payload: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' },
    });
    expect(res.statusCode, res.body).toBe(200);
    const sent = sentFor(w.run, (res.json() as { job: string }).job);
    expect(sent).toMatchObject({ harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
    expect(sent.prompt).toContain('## The conversation so far\nYou are taking over a conversation about this song.');
    expect(await view(w, w.s.id)).toMatchObject({ choice: { harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' } });
    // Settings itself is as it was: the other songs' choice
    const settings = (
      await w.t.app.inject({ method: 'GET', url: '/api/agent/settings', headers: auth(w.token) })
    ).json() as Msg;
    expect(settings).toMatchObject({ harness: null });
  });

  it('goes back to what Settings says, when that’s what is picked', async () => {
    const w = await world();
    await choose(w, w.s.id, { harness: 'codex', model: '', effort: '' });
    const job = await ask(w, w.s.id, 'Strings');
    w.run.say({ type: 'agent-failed', job, error: 'Quota exceeded.', why: 'usage' });
    await waitFor(() => w.t.services.jobs.get(job)?.view.state === 'failed');
    const res = await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${job}/continue`,
      headers: auth(w.token),
      payload: { harness: null },
    });
    expect(res.statusCode, res.body).toBe(200);
    expect(sentFor(w.run, (res.json() as { job: string }).job)).toMatchObject({ harness: 'claude' });
    expect(await view(w, w.s.id)).toMatchObject({ choice: null, runsWith: { harness: 'claude' } });
  });

  it('leaves the song as it was when the request doesn’t go ahead after all', async () => {
    const w = await world();
    const job = await ask(w, w.s.id, 'Strings');
    w.run.say({ type: 'agent-failed', job, error: 'Overloaded' });
    await waitFor(() => w.t.services.jobs.get(job)?.view.state === 'failed');
    const told = w.desk.got('agent-thread').length;
    // the runner goes while the studio saves: refused past the point where the harness was picked
    const answer = w.desk.answer;
    w.desk.answer = (msg) => {
      w.run.close();
      return answer?.(msg) ?? null;
    };
    const res = await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${job}/continue`,
      headers: auth(w.token),
      payload: { harness: 'codex' },
    });
    expect(res.statusCode, res.body).toBe(409);
    expect(await view(w, w.s.id)).toMatchObject({ choice: null });
    expect(w.desk.got('agent-thread')).toHaveLength(told);
  });

  it('changes nothing when the harness picked can’t run it', async () => {
    const w = await world();
    const job = await ask(w, w.s.id, 'Strings');
    w.run.say({ type: 'agent-failed', job, error: 'Overloaded' });
    await waitFor(() => w.t.services.jobs.get(job)?.view.state === 'failed');
    const res = await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${job}/continue`,
      headers: auth(w.token),
      payload: { harness: 'cursor' },
    });
    expect(res.json()).toMatchObject({ reason: 'no-harness' });
    expect(await view(w, w.s.id)).toMatchObject({ choice: null });
  });
});

describe('a waiting OK, after HO[LO] restarted', () => {
  it('still says the model and effort its turn ran with, so the page draws no change of hands', async () => {
    const w = await world();
    await w.t.app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(w.token),
      payload: { harness: 'claude', model: 'opus', effort: 'high' },
    });
    const job = await ask(w, w.s.id, 'Bounce it');
    w.run.say({ type: 'agent-session', job, session: 'claude-1' });
    await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${job}/permission`,
      headers: auth(sentFor(w.run, job).token),
      payload: { kind: 'bounce', detail: 'To hear the mix' },
    });
    w.run.say({ type: 'agent-done', job });
    await waitFor(() => w.t.services.jobs.get(job)?.view.state === 'awaiting');
    await w.t.stop();
    open.splice(open.indexOf(w.t), 1);
    const t = await agentApp(w.t.work);
    open.push(t);
    t.runner([CLAUDE, CODEX]);
    t.studio(w.token, w.s.id, 'desk');
    const shown = (
      await t.app.inject({ method: 'GET', url: `/api/agent/threads/${w.s.id}`, headers: auth(w.token) })
    ).json() as { job: Msg };
    expect(shown.job).toMatchObject({ id: job, state: 'awaiting', harness: 'claude', model: 'opus', effort: 'high' });
  });
});

describe('a waiting OK, allowed after the song’s choice moved', () => {
  it('carries on with the harness that asked, and the model and effort its turn had', async () => {
    const w = await world();
    await w.t.app.inject({
      method: 'PUT',
      url: '/api/agent/settings',
      headers: auth(w.token),
      payload: { harness: 'claude', model: 'opus', effort: 'high' },
    });
    const job = await ask(w, w.s.id, 'Bounce it');
    const sent = sentFor(w.run, job);
    w.run.say({ type: 'agent-session', job, session: 'claude-1' });
    await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${job}/permission`,
      headers: auth(sent.token),
      payload: { kind: 'bounce', detail: 'To hear the mix' },
    });
    w.run.say({ type: 'agent-done', job });
    await waitFor(() => w.t.services.jobs.get(job)?.view.state === 'awaiting');
    await choose(w, w.s.id, { harness: 'codex', model: 'gpt-6.1-sol', effort: 'low' });
    const granted = await w.t.app.inject({
      method: 'POST',
      url: `/api/agent/jobs/${job}/permission`,
      headers: auth(w.token),
      payload: { grant: true, result: 'Bounced (3:41)' },
    });
    expect(granted.statusCode, granted.body).toBe(200);
    expect(sentFor(w.run, (granted.json() as { job: string }).job)).toMatchObject({
      harness: 'claude',
      model: 'opus',
      effort: 'high',
      session: 'claude-1',
    });
  });
});
