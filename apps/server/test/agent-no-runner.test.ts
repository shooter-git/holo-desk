import { describe, expect, it } from 'vitest';
import { noRunnerText } from '../src/agent/jobs.ts';

describe('why the agent has no runner', () => {
  it('says what to do for each way the runners stand, naming the runner’s computer when known', () => {
    expect(noRunnerText({ state: 'none', host: null })).toMatch(/^No runner is connected: start it on the computer/);
    expect(noRunnerText({ state: 'old', host: 'desk' })).toMatch(/^The runner on desk is from an older HO\[LO\]/);
    expect(noRunnerText({ state: 'no-key', host: 'desk' })).toMatch(
      /^The runner on desk can’t read HO\[LO\]’s runner key/,
    );
    expect(noRunnerText({ state: 'wrong-key', host: null })).toMatch(/^The runner has another HO\[LO\]’s runner key/);
  });
});
