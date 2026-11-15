import { describe, expect, it } from 'vitest';
import { runnerProblem } from '../src/app/agent.ts';
import { codeIn, readPairLink, takePairCode } from '../src/app/pair-link.ts';

describe('a pairing link', () => {
  it('carries six digits in the fragment, and nothing else counts', () => {
    expect(codeIn('#agent-pair=012345')).toBe('012345');
    for (const hash of ['', '#agent-pair=12345', '#agent-pair=1234567', '#agent-pair=12a456', '#other=012345'])
      expect(codeIn(hash)).toBeNull();
  });

  it('is taken once, and the address loses it at once', () => {
    const replaced: string[] = [];
    const hist = {
      state: { kept: true },
      replaceState: (_s: unknown, _t: string, url?: string | URL | null) => {
        replaced.push(String(url));
      },
    };
    expect(readPairLink({ hash: '', pathname: '/', search: '' }, hist)).toBe(false);
    expect(replaced).toEqual([]);
    expect(readPairLink({ hash: '#agent-pair=012345', pathname: '/', search: '?song=a' }, hist)).toBe(true);
    expect(replaced).toEqual(['/?song=a']);
    expect(takePairCode()).toBe('012345');
    expect(takePairCode()).toBeNull();
  });
});

describe('why the agent has no runner, in Settings', () => {
  it('names the problem and the runner’s computer, and says nothing when one is ready', () => {
    expect(runnerProblem({ connected: true, keyed: true, state: 'ready' })).toBeNull();
    expect(runnerProblem(undefined)).toBeNull();
    expect(runnerProblem({ connected: false, keyed: false, state: 'none' })).toMatch(/^No runner is connected/);
    expect(runnerProblem({ connected: true, keyed: false, state: 'old', host: 'desk' })).toMatch(
      /^The runner on desk is from an older HO\[LO\] than this studio/,
    );
    expect(runnerProblem({ connected: true, keyed: false, state: 'no-key' })).toMatch(/^The runner can’t read/);
    expect(runnerProblem({ connected: true, keyed: false, state: 'wrong-key', host: 'desk' })).toMatch(
      /another HO\[LO\]’s runner key/,
    );
    // a host from before states: connected without the key is an old runner
    expect(runnerProblem({ connected: true, keyed: false })).toMatch(/older HO\[LO\]/);
    expect(runnerProblem({ connected: false, keyed: false })).toMatch(/^No runner is connected/);
  });
});
