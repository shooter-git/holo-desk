import { rmSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { type MeasureAnswer, MeasureFailed, type MeasureJob, MeasureRunner } from '../src/agent/measure/runner.ts';
import type { ChildInput, MeasureResult } from '../src/agent/measure/tasks.ts';
import { FakeChild, takeWorld } from './measure-fakes.ts';

const input = { kind: 'recording', path: '/nowhere', name: 'x', key: null, against: 'key' } as ChildInput;
const result = (n: number) => ({ kind: 'mix', n }) as unknown as MeasureResult;
const ask = (key: string, job = 'j1', lane: MeasureJob['lane'] = 'render', estimate = 120): MeasureJob => ({
  job,
  project: 'prj_a',
  key,
  lane,
  estimate,
  input,
});
const later = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A runner whose children are stand-ins, kept in order. */
function fakeRunner(o: { budgetMs?: number; idleMs?: number; orphanMs?: number } = {}) {
  const children: FakeChild[] = [];
  const runner = new MeasureRunner({
    budgetMs: o.budgetMs ?? 30,
    idleMs: o.idleMs ?? 60_000,
    orphanMs: o.orphanMs ?? 60_000,
    spawn: () => {
      const c = new FakeChild();
      children.push(c);
      return c;
    },
  });
  return { runner, children };
}

describe('measuring away from the server', () => {
  it('waits up to its budget, says how far it got, joins the same request, then answers from the cache', async () => {
    const { runner, children } = fakeRunner();
    const first = await runner.request(ask('mix@3'));
    expect(first).toMatchObject({ done: false, progress: 0, stage: 'Starting' });
    // before it says how far it has got: its estimate
    expect((first as Extract<MeasureAnswer, { done: false }>).eta).toBeGreaterThan(110);
    expect(children).toHaveLength(1);
    const child = children[0] as FakeChild;
    expect(child.sent).toEqual([{ type: 'run', id: first.task, input }]);

    child.say({ type: 'progress', id: first.task, fraction: 0.5, stage: 'Rendering… 50%' });
    const second = await runner.request(ask('mix@3'));
    expect(second).toMatchObject({ done: false, task: first.task, progress: 0.5, stage: 'Rendering… 50%' });
    // the same measurement, not a second one
    expect(child.sent).toHaveLength(1);

    const waiting = runner.request(ask('mix@3'), 5000);
    child.say({ type: 'done', id: first.task, result: result(1) });
    expect(await waiting).toEqual({ done: true, task: first.task, result: result(1) });
    expect(await runner.request(ask('mix@3'))).toEqual({
      done: true,
      task: first.task,
      result: result(1),
      cached: true,
    });
    expect(await runner.check(first.task, 'prj_a', 'j1')).toEqual({ done: true, task: first.task, result: result(1) });
    // another song's job can't ask for it by id
    expect(runner.check(first.task, 'prj_b', 'j9')).toBeNull();
    expect(child.sent).toHaveLength(1);
    runner.close();
  });

  it('runs one measurement at a time in a lane, the files beside the renders', async () => {
    const { runner, children } = fakeRunner();
    const a = await runner.request(ask('mix'));
    const b = await runner.request(ask('tracks', 'j1', 'render', 60));
    expect(b).toMatchObject({ done: false, progress: 0, stage: 'Waiting for another measurement to finish' });
    // after the render under way (about 120 s) and its own 60
    expect((b as Extract<MeasureAnswer, { done: false }>).eta).toBeGreaterThan(170);
    const take = runner.request(ask('take', 'j1', 'files', 2), 5000);
    expect(children).toHaveLength(2);
    const [render, files] = children as [FakeChild, FakeChild];
    files.say({ type: 'done', id: files.running, result: result(2) });
    expect(await take).toMatchObject({ done: true, result: result(2) });
    render.say({ type: 'done', id: a.task, result: result(3) });
    expect(render.sent.map((m) => m.id)).toEqual([a.task, b.task]);
    expect(runner.status().render).toMatchObject({ running: b.task, queued: 0 });
    runner.close();
  });

  it('cancels what a stopped request alone asked for, and lets a finished turn’s run on', async () => {
    const { runner, children } = fakeRunner({ orphanMs: 50 });
    const a = runner.request(ask('mix', 'j1'), 5000);
    const b = await runner.request(ask('tracks', 'j1'));
    await runner.request(ask('tracks', 'j2'));
    const first = children[0] as FakeChild;
    runner.jobEnded('j1', true);
    // the render it alone wanted stops with its child; the one j2 wants too goes on, on a new child
    await expect(a).rejects.toThrow(MeasureFailed);
    expect(first.killed).toBe(true);
    const second = children[1] as FakeChild;
    expect(second.sent.map((m) => m.id)).toEqual([b.task]);
    // j2's turn finishes: it runs on, and the next turn collects it
    runner.jobEnded('j2', false);
    second.say({ type: 'done', id: b.task, result: result(4) });
    expect(await runner.request(ask('tracks', 'j3'))).toMatchObject({ done: true, cached: true, result: result(4) });
    // one nobody comes back for is given up on
    await runner.request(ask('long', 'j4'));
    runner.jobEnded('j4', false);
    await later(100);
    expect(second.killed).toBe(true);
    expect(runner.status().render).toMatchObject({ child: false, running: null });
    runner.close();
  });

  it('fails a measurement whose child dies, and starts the next on a new one', async () => {
    const { runner, children } = fakeRunner();
    const a = runner.request(ask('mix'), 5000);
    const b = runner.request(ask('tracks'), 5000);
    (children[0] as FakeChild).emit('exit');
    await expect(a).rejects.toThrow('run out of memory');
    expect(children).toHaveLength(2);
    const second = children[1] as FakeChild;
    second.say({ type: 'failed', id: second.running, error: 'No track trk_x' });
    await expect(b).rejects.toThrow('No track trk_x');
    runner.close();
  });

  it('lets a lane’s child go when it has nothing to do, and every child when the server closes', async () => {
    const { runner, children } = fakeRunner({ idleMs: 20 });
    const a = await runner.request(ask('take', 'j1', 'files', 1));
    (children[0] as FakeChild).say({ type: 'done', id: a.task, result: result(5) });
    await later(60);
    expect((children[0] as FakeChild).killed).toBe(true);
    expect(runner.status().files.child).toBe(false);
    const waiting = runner.request(ask('mix'), 5000);
    runner.close();
    await expect(waiting).rejects.toThrow('closing');
    expect((children[1] as FakeChild).killed).toBe(true);
    await expect(runner.request(ask('mix'))).rejects.toThrow('closing');
  });

  it('measures a take recorded as FLAC in a child process of its own', async () => {
    const { dataDir, song, vocals } = takeWorld('flac');
    const runner = new MeasureRunner();
    try {
      const a = await runner.request({
        job: 'j1',
        project: song.id,
        key: 'take',
        lane: 'files',
        estimate: 2,
        input: { kind: 'take', dataDir, project: song, track: vocals.id, against: 'key', grid: 240 },
      });
      expect(a.done).toBe(true);
      const r = (a as Extract<MeasureAnswer, { done: true }>).result;
      if (r.kind !== 'take') throw new Error(r.kind);
      expect(r.notes.map((n) => [n.target, Math.round(n.cents)])).toEqual([
        [62, 0],
        [65, 30],
        [69, 0],
      ]);
      // from bar 2 (tick 3840) at 120 bpm: half a second in is beat 2
      expect(r.notes.map((n) => Math.round((n.tick ?? 0) / 10) * 10)).toEqual([4800, 6720, 8640]);
    } finally {
      runner.close();
      rmSync(dataDir, { recursive: true, force: true });
    }
  });
});
