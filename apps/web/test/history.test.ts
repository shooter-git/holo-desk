import { applyOps, newProject, newRegion, newTrack, type Op, type Project, parseProject } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  type History,
  JobQueue,
  type JobResult,
  jobSteps,
  MAX_UNDO,
  push,
  pushOrMergeJob,
  redo,
  relabelJob,
  undo,
} from '../src/app/history.ts';

const empty: History = { undo: [], redo: [] };
const titled = (p: Project, title: string): Project => applyOps(p, [{ op: 'setProject', patch: { title } }]);

/** A studio in miniature: the song and its history, edited as the actions do. */
function studio() {
  let project = newProject('Song');
  let h = empty;
  return {
    get project() {
      return project;
    },
    get history() {
      return h;
    },
    edit(title: string, label = 'Edit') {
      const next = titled(project, title);
      h = push(h, { project, label });
      project = next;
    },
    agent(title: string, job: string, running = true, label = 'Agent: Notes') {
      const next = titled(project, title);
      h = pushOrMergeJob(h, project, label, job, running);
      project = next;
    },
    undo() {
      const r = undo(h, project);
      if (!r) return null;
      h = r.history;
      project = r.step.project;
      return r.step;
    },
    redo() {
      const r = redo(h, project);
      if (!r) return null;
      h = r.history;
      project = r.step.project;
      return r.step;
    },
    relabel(job: string, label: string) {
      h = relabelJob(h, job, label);
    },
  };
}

describe('the undo history', () => {
  it('pushes a step per edit, and an edit forgets what was undone', () => {
    const s = studio();
    s.edit('A', 'One');
    s.edit('B', 'Two');
    expect(s.history.undo.map((x) => x.label)).toEqual(['One', 'Two']);
    expect(s.undo()?.label).toBe('Two');
    expect(s.project.title).toBe('A');
    expect(s.history.redo.map((x) => x.label)).toEqual(['Two']);
    s.edit('C', 'Three');
    expect(s.history.redo).toEqual([]);
  });

  it('keeps at most MAX_UNDO steps, dropping the oldest', () => {
    const s = studio();
    for (let i = 0; i < MAX_UNDO + 10; i++) s.edit(`T${i}`, `Edit ${i}`);
    expect(s.history.undo).toHaveLength(MAX_UNDO);
    expect(s.history.undo[0]?.label).toBe('Edit 10');
    // the job's batches count the same way
    for (let i = 0; i < 5; i++) s.agent(`J${i}`, `job${i}`);
    expect(s.history.undo).toHaveLength(MAX_UNDO);
  });

  it("merges a running job's consecutive batches into one step", () => {
    const s = studio();
    s.edit('Before');
    const before = s.project;
    s.agent('A1', 'j1');
    s.agent('A2', 'j1');
    s.agent('A3', 'j1');
    expect(s.history.undo).toHaveLength(2);
    expect(s.history.undo[1]).toMatchObject({ label: 'Agent: Notes', job: 'j1' });
    expect(s.history.undo[1]?.project).toBe(before);
  });

  it('undoes a merged step back to the song from before the job', () => {
    const s = studio();
    s.edit('Before');
    const before = s.project;
    s.agent('A1', 'j1');
    s.agent('A2', 'j1');
    const after = s.project;
    expect(s.undo()?.job).toBe('j1');
    expect(s.project).toBe(before);
    expect(s.redo()?.job).toBe('j1');
    expect(s.project).toBe(after);
  });

  it('opens a second step when the user edits in between', () => {
    const s = studio();
    s.agent('A1', 'j1');
    s.edit('Mine', 'Move Notes');
    s.agent('A2', 'j1');
    expect(s.history.undo.map((x) => [x.label, x.job])).toEqual([
      ['Agent: Notes', 'j1'],
      ['Move Notes', undefined],
      ['Agent: Notes', 'j1'],
    ]);
    // undoing the second job step keeps the user's edit
    s.undo();
    expect(s.project.title).toBe('Mine');
  });

  it("joins the job's step again once the user's edit in between is undone", () => {
    const s = studio();
    s.agent('A1', 'j1');
    s.edit('Mine');
    s.undo();
    s.agent('A2', 'j1');
    expect(s.history.undo).toHaveLength(1);
    // (a redo would bring back a song without the batch)
    expect(s.history.redo).toEqual([]);
  });

  it('opens a new step for a job that has finished, or another job', () => {
    const s = studio();
    s.agent('A1', 'j1');
    s.agent('A2', 'j1', false);
    s.agent('B1', 'j2');
    expect(s.history.undo.map((x) => x.job)).toEqual(['j1', 'j1', 'j2']);
  });

  it("relabels a job's steps on both stacks", () => {
    const s = studio();
    s.agent('A1', 'j1');
    s.edit('Mine', 'Mine');
    s.agent('A2', 'j1');
    s.agent('B1', 'j2');
    s.undo();
    s.undo();
    s.relabel('j1', 'Agent: Counter-line');
    expect(s.history.undo.map((x) => x.label)).toEqual(['Agent: Counter-line', 'Mine']);
    expect(s.history.redo.map((x) => x.label)).toEqual(['Agent: Notes', 'Agent: Counter-line']);
  });

  it('carries the job across undo and redo', () => {
    const s = studio();
    s.edit('Mine', 'Mine');
    s.agent('A1', 'j1');
    s.undo();
    expect(s.history.redo[0]).toMatchObject({ job: 'j1', label: 'Agent: Notes' });
    s.undo();
    expect(s.history.redo[1]).not.toHaveProperty('job');
    s.redo();
    s.redo();
    expect(s.history.undo.map((x) => x.job)).toEqual([undefined, 'j1']);
    // still running and on top: the next batch joins it
    s.agent('A2', 'j1');
    expect(s.history.undo).toHaveLength(2);
  });

  it("finds a job's steps, oldest first", () => {
    const s = studio();
    const start = s.project;
    s.agent('A1', 'j1');
    s.edit('Mine');
    s.agent('A2', 'j1');
    const steps = jobSteps(s.history, 'j1');
    expect(steps).toHaveLength(2);
    expect(steps[0]?.project).toBe(start);
  });

  it('has nothing to undo or redo on empty stacks', () => {
    expect(undo(empty, newProject('x'))).toBeNull();
    expect(redo(empty, newProject('x'))).toBeNull();
  });
});

describe("the agent's queue", () => {
  const queue = () => {
    const ran: string[] = [];
    const refuse = new Set<string>();
    const q = new JobQueue<{ batch: string }>((item) => {
      ran.push(item.batch);
      return refuse.has(item.batch) ? { ok: false, error: 'no' } : { ok: true };
    });
    return { q, ran, refuse };
  };

  it('applies at once when nothing holds it', async () => {
    const { q, ran } = queue();
    const r = q.submit({ batch: 'b1' });
    expect(ran).toEqual(['b1']);
    expect(await r).toEqual({ ok: true });
  });

  it('waits while held, then applies in order once the last hold lets go', async () => {
    const { q, ran } = queue();
    const gesture = q.hold();
    const drag = q.hold();
    const results = [q.submit({ batch: 'b1' }), q.submit({ batch: 'b2' })];
    expect(ran).toEqual([]);
    expect(q.waiting('b1')).toBe(true);
    gesture();
    expect(ran).toEqual([]);
    // (letting go twice does nothing)
    gesture();
    expect(ran).toEqual([]);
    drag();
    expect(ran).toEqual(['b1', 'b2']);
    expect(await Promise.all(results)).toEqual([{ ok: true }, { ok: true }]);
    expect(q.held).toBe(false);
  });

  it('applies a batch once, however often it is sent', async () => {
    const { q, ran } = queue();
    await q.submit({ batch: 'b1' });
    expect(await q.submit({ batch: 'b1' })).toEqual({ ok: true });
    expect(ran).toEqual(['b1']);
    // sent again while it waits: both answered when it goes in
    const release = q.hold();
    const first = q.submit({ batch: 'b2' });
    const again = q.submit({ batch: 'b2' });
    release();
    expect(await Promise.all([first, again])).toEqual([{ ok: true }, { ok: true }]);
    expect(ran).toEqual(['b1', 'b2']);
  });

  it('tries a refused batch again', async () => {
    const { q, ran, refuse } = queue();
    refuse.add('b1');
    expect(await q.submit({ batch: 'b1' })).toEqual({ ok: false, error: 'no' });
    refuse.delete('b1');
    expect(await q.submit({ batch: 'b1' })).toEqual({ ok: true });
    expect(ran).toEqual(['b1', 'b1']);
  });

  it('answers a batch whose apply threw with the error, and goes on', async () => {
    const ran: string[] = [];
    const q = new JobQueue<{ batch: string }>((item) => {
      ran.push(item.batch);
      if (item.batch === 'bad') throw new Error('broken');
      return { ok: true };
    });
    const release = q.hold();
    const results = [q.submit({ batch: 'bad' }), q.submit({ batch: 'good' })];
    release();
    expect(await Promise.all(results)).toEqual([{ ok: false, error: 'broken' }, { ok: true }]);
    expect(ran).toEqual(['bad', 'good']);
  });

  it('remembers only the latest batches', async () => {
    const ran: string[] = [];
    const q = new JobQueue<{ batch: string }>((item) => {
      ran.push(item.batch);
      return { ok: true };
    }, 2);
    for (const b of ['b1', 'b2', 'b3']) await q.submit({ batch: b });
    await q.submit({ batch: 'b3' });
    await q.submit({ batch: 'b1' });
    expect(ran).toEqual(['b1', 'b2', 'b3', 'b1']);
  });

  it('lets everything through past a hold that never let go', async () => {
    const { q, ran } = queue();
    const stuck = q.hold();
    const r = q.submit({ batch: 'b1' });
    q.letThrough();
    expect(ran).toEqual(['b1']);
    expect(await r).toEqual({ ok: true });
    // that hold's release, later, does nothing; a new hold still holds
    const drag = q.hold();
    stuck();
    q.submit({ batch: 'b2' });
    expect(ran).toEqual(['b1']);
    drag();
    expect(ran).toEqual(['b1', 'b2']);
  });

  it('stops between batches when one takes a hold as it goes in', () => {
    const ran: string[] = [];
    let inner: (() => void) | null = null;
    const q: JobQueue<{ batch: string }> = new JobQueue<{ batch: string }>((item): JobResult => {
      ran.push(item.batch);
      if (item.batch === 'b1') inner = q.hold();
      return { ok: true };
    });
    const release = q.hold();
    q.submit({ batch: 'b1' });
    q.submit({ batch: 'b2' });
    release();
    // b1 took a hold as it went in: b2 waits for it
    expect(ran).toEqual(['b1']);
    (inner as (() => void) | null)?.();
    expect(ran).toEqual(['b1', 'b2']);
  });
});

describe("the agent's changes, as the studio applies them", () => {
  it('a gesture in progress keeps them back, and its step lands first', async () => {
    // the actions' gesture and job runner, in miniature
    let project = newProject('Song');
    let h = empty;
    const q = new JobQueue<{ batch: string; ops: Op[] }>((b) => {
      const next = applyOps(project, b.ops);
      h = pushOrMergeJob(h, project, 'Agent: Tempo', 'j1', true);
      project = next;
      return { ok: true };
    });
    const gesture = { before: project, release: q.hold() };
    project = titled(project, 'Dragged');
    const r = q.submit({ batch: 'b1', ops: [{ op: 'setProject', patch: { key: 'D minor' } }] });
    expect(project.key).not.toBe('D minor');
    // the gesture ends: its step, then the agent's
    h = push(h, { project: gesture.before, label: 'Volume' });
    gesture.release();
    expect(await r).toEqual({ ok: true });
    expect(h.undo.map((x) => x.label)).toEqual(['Volume', 'Agent: Tempo']);
    expect(h.undo[1]?.project.title).toBe('Dragged');
    expect(project.key).toBe('D minor');
  });

  it('passes the check the studio makes of a song the agent changed', () => {
    const track = newTrack('Bass', { type: 'synth', preset: 'Soft Keys' });
    const region = newRegion(0, 3840, 'Bass');
    const next = applyOps(newProject('Song'), [
      { op: 'addTrack', track },
      { op: 'addRegion', track: track.id, region },
      { op: 'addNotes', track: track.id, region: region.id, notes: [{ t: 0, d: 480, p: 40, v: 96 }] },
    ]);
    expect(() => parseProject(next)).not.toThrow();
    expect(() => parseProject({ ...next, tempo: 'fast' })).toThrow();
  });
});
