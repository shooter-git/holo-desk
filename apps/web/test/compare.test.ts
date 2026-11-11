import { newProject, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { comparePlan } from '../src/app/compare.ts';
import * as history from '../src/app/history.ts';

const BAR = 4 * PPQ;
const song = (title: string): Project => ({ ...newProject(title), cycle: { on: true, start: 0, end: 4 * BAR } });

describe('before and after', () => {
  it('plays the song from before the job: under its first step still in the undo history', () => {
    const start = song('Before the job');
    const one = song('After the first batch');
    const mine = song('After the user’s own edit');
    const two = song('After the second batch');
    // the job's first batch, then the user's own step, then the job's second batch (a step of its own)
    let h: history.History = { undo: [], redo: [] };
    h = history.pushOrMergeJob(h, start, 'Agent: …', 'agj_1', true);
    h = history.push(h, { project: one, label: 'Mute' });
    h = history.pushOrMergeJob(h, mine, 'Agent: …', 'agj_1', true);
    const steps = history.jobSteps(h, 'agj_1');
    expect(steps).toHaveLength(2);
    const plan = comparePlan(steps, two, 5, 9);
    if ('error' in plan) throw new Error(plan.error);
    expect(plan.before.song.title).toBe('Before the job');
    expect(plan.after.song.title).toBe('After the second batch');
    // bars 5 up to 9 (not played), straight through: the cycle off
    expect([plan.before.from, plan.before.to]).toEqual([4 * BAR, 8 * BAR]);
    expect(plan.before.song.cycle.on).toBe(false);
    expect(plan.after.song.cycle.on).toBe(false);
  });

  it('counts the bars in each song’s own meter', () => {
    const before = { ...song('3/4'), meter: [{ tick: 0, num: 3, den: 4 }] };
    const plan = comparePlan([{ project: before, label: 'Agent: …', job: 'agj_1' }], song('4/4'), 2, 3);
    if ('error' in plan) throw new Error(plan.error);
    expect([plan.before.from, plan.before.to]).toEqual([3 * PPQ, 6 * PPQ]);
    expect([plan.after.from, plan.after.to]).toEqual([BAR, 2 * BAR]);
  });

  it('says so when the song from before has gone from the undo history', () => {
    expect(comparePlan([], song('Now'), 1, 5)).toEqual({
      error: 'The song from before isn’t in the undo history any more',
    });
    expect(comparePlan([{ project: song('x'), label: 'Agent: …', job: 'j' }], song('Now'), 5, 5)).toHaveProperty(
      'error',
    );
  });
});
