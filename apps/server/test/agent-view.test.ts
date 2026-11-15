import type { Project } from '@holo/session';
import { afterEach, describe, expect, it } from 'vitest';
import { agentWorld, auth, type Msg, waitFor } from './agent-fakes.ts';

let close: (() => Promise<void>) | null = null;
afterEach(async () => {
  await close?.();
  close = null;
});

async function setup() {
  const w = await agentWorld();
  close = w.close;
  return w;
}

/** A view as the agent's finish sends it (its names already resolved to ids). */
const VIEW = [
  {
    choice: [
      { label: 'Original', do: { play: { from: 1, to: 5, version: 'before' } } },
      { label: 'Lower', do: { play: { from: 1, to: 5, version: 'Lower' } } },
    ],
  },
  { button: 'Keep this', do: { keep: 'after' } },
];

describe('what a reply shows under it', () => {
  it('keeps versions as the studio saved them, and the view with their revisions', async () => {
    const { start, tool, s, desk, run, status, save, services, app, token } = await setup();
    const { job, token: jobToken } = await start({ project: s.id, text: 'The strings a half step down, to compare' });
    const before = services.store.history(s.id)[0]?.revision as number;

    // the song as the agent changed it, then kept as a version: the studio saves first
    const lower = await save({ ...(services.store.get(s.id) as Project), title: 'Lower' });
    const flushes = desk.got('agent-flush').length;
    const kept = await tool(job, jobToken, 'POST', '/version', { name: 'Lower' });
    expect(kept.json()).toEqual({ ok: true, revision: lower.revision });
    expect(desk.got('agent-flush')).toHaveLength(flushes + 1);
    expect(services.store.history(s.id)[0]).toMatchObject({ revision: lower.revision });
    expect((await tool(job, jobToken, 'POST', '/version', { name: 'Lower' })).statusCode).toBe(409);
    expect((await tool(job, jobToken, 'POST', '/version', { name: 'after' })).statusCode).toBe(409);
    expect((await tool(job, jobToken, 'POST', '/version', { name: '<b>' })).statusCode).toBe(400);

    // a view that names a version never kept, or isn't resolved, is refused
    const refused = await tool(job, jobToken, 'POST', '/finish', {
      label: 'x',
      reply: 'y',
      view: [{ button: 'Hall', do: { keep: 'Hall' } }],
    });
    expect(refused.statusCode).toBe(400);
    expect(refused.json().error).toMatch(/No version "Hall"/);
    const unresolved = await tool(job, jobToken, 'POST', '/finish', {
      label: 'x',
      reply: 'y',
      view: [{ slider: { track: 'Strings', param: 'reverb.mix' } }],
    });
    expect(unresolved.statusCode).toBe(400);

    const finished = await tool(job, jobToken, 'POST', '/finish', {
      label: 'Strings down a half step',
      reply: 'The strings are a half step lower.',
      view: VIEW,
      go: { bar: 3 },
    });
    expect(finished.statusCode, finished.body).toBe(200);

    // the turn ends: the song as it was left becomes "after"
    const changed = await save({ ...(services.store.get(s.id) as Project), title: 'After' });
    run.say({ type: 'agent-done', job });
    await waitFor(() => status(desk, job)?.state === 'done');
    const view = { blocks: VIEW, versions: { before, Lower: lower.revision, after: changed.revision } };
    expect(status(desk, job)).toMatchObject({ view, go: { bar: 3 } });
    const thread = await app.inject({ method: 'GET', url: `/api/agent/threads/${s.id}`, headers: auth(token) });
    expect(thread.json().thread.turns.at(-1)).toMatchObject({ job, view, go: { bar: 3 } });
    // each version is the song as it was then
    const lowerSong = await app.inject({ method: 'GET', url: `/api/projects/${s.id}/history/${lower.revision}` });
    expect(lowerSong.json()).toMatchObject({ title: 'Lower' });
  });

  it('takes no "after" when the view doesn’t name it', async () => {
    const { start, tool, s, desk, run, status, services } = await setup();
    const { job, token: jobToken } = await start({ project: s.id, text: 'Where is it flat?' });
    await tool(job, jobToken, 'POST', '/finish', {
      label: 'Read the take',
      reply: 'Bar 3 is flat.',
      view: [{ list: [{ text: 'Bar 3', do: { go: { bar: 3 } } }] }],
    });
    const kept = services.store.history(s.id).length;
    run.say({ type: 'agent-done', job });
    await waitFor(() => status(desk, job)?.state === 'done');
    expect(status(desk, job)?.view).toEqual({
      blocks: [{ list: [{ text: 'Bar 3', do: { go: { bar: 3 } } }] }],
      versions: {},
    });
    expect(services.store.history(s.id)).toHaveLength(kept);
  });
});

describe('the studio’s commands, for a reply’s buttons', () => {
  it('are asked of the studio that asked, and only proper ones passed on', async () => {
    const { start, tool, s, desk } = await setup();
    const { job, token: jobToken } = await start({ project: s.id, text: 'Tidy up' });
    const answer = desk.answer;
    desk.answer = (msg: Msg) =>
      msg.type === 'agent-commands'
        ? {
            ok: true,
            commands: [
              { id: 'metronome', title: 'Metronome' },
              { id: 'Bad id!', title: 'x' },
              { id: 'undo', title: 'Undo\u0007 Quantize' },
              'nonsense',
            ],
          }
        : (answer?.(msg) ?? null);
    const res = await tool(job, jobToken, 'GET', '/commands');
    expect(res.json()).toEqual({
      commands: [
        { id: 'metronome', title: 'Metronome' },
        { id: 'undo', title: 'Undo  Quantize' },
      ],
    });
    expect(desk.got('agent-commands')).toHaveLength(1);
  });
});
