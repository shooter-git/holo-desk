import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AgentModule from '../src/app/agent.ts';

/** A browser's storage, as far as the studio uses it. */
class Storage {
  items = new Map<string, string>();
  getItem(key: string): string | null {
    return this.items.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.items.set(key, String(value));
  }
  removeItem(key: string): void {
    this.items.delete(key);
  }
}

let A: typeof AgentModule;

beforeAll(async () => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('window', globalThis);
  // (a page just loaded: it hasn't heard yet how the agent stands)
  A = await import('../src/app/agent.ts');
});

describe('what the agent saved while the studio was away, asked for as the page opens', () => {
  it('is given up when the host never says how the agent stands, so a save waiting on it goes on', async () => {
    vi.useFakeTimers();
    try {
      // the host takes the request, and answers nothing till it's given up
      vi.stubGlobal(
        'fetch',
        (_url: string, init?: RequestInit) =>
          new Promise<Response>((_done, fail) => {
            init?.signal?.addEventListener('abort', () => fail(new DOMException('Gave up', 'AbortError')));
          }),
      );
      let outcome = 'waiting';
      A.awayChanges('prj_a', 1).then(
        () => {
          outcome = 'answered';
        },
        () => {
          outcome = 'no answer';
        },
      );
      await vi.advanceTimersByTimeAsync(31_000);
      expect(outcome).toBe('no answer');
    } finally {
      vi.useRealTimers();
    }
  });
});
