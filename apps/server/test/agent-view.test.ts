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

    // the agent's change (through its tools), then the song kept as a version: the studio saves first
    const changed1 = await tool(job, jobToken, 'POST', '/ops', {
      ops: [{ op: 'setProject', patch: { title: 'Lower' } }],
      label: 'Lower',
      batch: 'b1',
    });
    expect(changed1.statusCode, changed1.body).toBe(200);
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

describe('a reply’s dock', () => {
  it('is kept with the view, in the turn and the thread, its versions taken with the view’s', async () => {
    const { start, tool, s, desk, run, status, save, services, app, token } = await setup();
    const { job, token: jobToken } = await start({ project: s.id, text: 'Two takes of the strings' });
    await tool(job, jobToken, 'POST', '/ops', {
      ops: [{ op: 'setProject', patch: { title: 'Take 1' } }],
      label: 'Take 1',
      batch: 'b1',
    });
    const take1 = await save({ ...(services.store.get(s.id) as Project), title: 'Take 1' });
    expect((await tool(job, jobToken, 'POST', '/version', { name: 'Take 1' })).statusCode).toBe(200);
    const view = [{ text: 'Two takes of the strings.' }];
    // the dock alone names "Take 1" and "after": they're kept as the view's would be
    const dock = [
      {
        choice: [
          { label: 'Take 1', do: { play: { from: 1, to: 5, version: 'Take 1' } } },
          { label: 'Take 2', do: { play: { from: 1, to: 5, version: 'after' } } },
        ],
      },
      { button: 'Keep Take 1', do: { keep: 'Take 1' } },
    ];

    // refused: without a view, with a kind a dock doesn't hold, too many controls, or a version never kept
    const finish = (body: Record<string, unknown>) =>
      tool(job, jobToken, 'POST', '/finish', { label: 'Two takes', reply: 'Play them.', ...body });
    const alone = await finish({ dock });
    expect(alone.statusCode).toBe(400);
    expect(alone.json().error).toMatch(/a dock repeats a few of the view's controls/);
    const slider = await finish({ view, dock: [{ slider: { track: 'master', param: 'volume' } }] });
    expect(slider.statusCode).toBe(400);
    expect(slider.json().error).toMatch(/^dock\[0\]: a dock holds/);
    const many = await finish({ view, dock: [...dock, ...dock] });
    expect(many.statusCode).toBe(400);
    expect(many.json().error).toMatch(/^dock: 6 controls/);
    const never = await finish({ view, dock: [{ button: 'Hall', do: { keep: 'Hall' } }] });
    expect(never.statusCode).toBe(400);
    expect(never.json().error).toMatch(/No version "Hall"/);

    const finished = await finish({ view, dock });
    expect(finished.statusCode, finished.body).toBe(200);
    const after = await save({ ...(services.store.get(s.id) as Project), title: 'Take 2' });
    run.say({ type: 'agent-done', job });
    await waitFor(() => status(desk, job)?.state === 'done');
    const kept = { blocks: view, versions: { 'Take 1': take1.revision, after: after.revision }, dock };
    expect(status(desk, job)?.view).toEqual(kept);
    const thread = await app.inject({ method: 'GET', url: `/api/agent/threads/${s.id}`, headers: auth(token) });
    expect(thread.json().thread.turns.at(-1)).toMatchObject({ job, view: kept });
  });
});

describe('comparing an earlier change', () => {
  it('offers the song before the previous request, and refuses an A/B of two of the same song', async () => {
    const { start, tool, s, desk, run, status, services, save } = await setup();
    const first = await start({ project: s.id, text: 'Tune the vocal' });
    const firstBefore = services.store.history(s.id)[0]?.revision as number;
    // the conversation's first request has no "previous"
    const none = await tool(first.job, first.token, 'POST', '/finish', {
      label: 'x',
      reply: 'y',
      view: [{ button: 'Earlier', do: { play: { from: 1, to: 2, version: 'previous' } } }],
    });
    expect(none.statusCode).toBe(400);
    expect(none.json().error).toMatch(/no earlier request/);
    await tool(first.job, first.token, 'POST', '/ops', {
      ops: [{ op: 'setProject', patch: { title: 'Tuned' } }],
      label: 'Tuned',
      batch: 'b1',
    });
    // (the studio applies the change and saves it, as a real one does)
    await save({ ...(services.store.get(s.id) as Project), title: 'Tuned' });
    await tool(first.job, first.token, 'POST', '/finish', { label: 'Tuned', reply: 'Tuned.' });
    run.say({ type: 'agent-done', job: first.job });
    await waitFor(() => status(desk, first.job)?.state === 'done');

    // the next request changes nothing: "before" and "after" are the same song
    const second = await start({ project: s.id, text: 'Show me what the tuning changed' });
    const same = await tool(second.job, second.token, 'POST', '/finish', {
      label: 'Showed',
      reply: 'Here.',
      view: [
        {
          choice: [
            { label: 'Before', do: { play: { from: 1, to: 2, version: 'before' } } },
            { label: 'After', do: { play: { from: 1, to: 2, version: 'after' } } },
          ],
        },
      ],
    });
    expect(same.statusCode).toBe(400);
    expect(same.json().error).toMatch(/Nothing changed in this request.*"previous"/);
    // "previous" against "before" compares the tuning
    const compared = await tool(second.job, second.token, 'POST', '/finish', {
      label: 'Showed',
      reply: 'Here.',
      view: [
        {
          choice: [
            { label: 'Untuned', do: { play: { from: 1, to: 2, version: 'previous' } } },
            { label: 'Tuned', do: { play: { from: 1, to: 2, version: 'before' } } },
          ],
        },
      ],
    });
    expect(compared.statusCode, compared.body).toBe(200);
    run.say({ type: 'agent-done', job: second.job });
    await waitFor(() => status(desk, second.job)?.state === 'done');
    const versions = (status(desk, second.job)?.view as { versions: Record<string, number> } | undefined)?.versions;
    expect(versions?.previous).toBe(firstBefore);
    expect(versions?.before).toBeGreaterThan(firstBefore);
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
