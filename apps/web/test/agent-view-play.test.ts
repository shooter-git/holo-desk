import type { View } from '@holo/agent/view';
import { newProject, type Project } from '@holo/session';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ViewModule from '../src/app/agent-view.ts';
import type * as StoreModule from '../src/app/store.ts';

/** What happened, in order: the audio asked to start, the history asked for a version, the bars played. */
const { calls } = vi.hoisted(() => ({ calls: [] as string[] }));

vi.mock('../src/app/actions.ts', async (original) => ({
  ...(await original<typeof import('../src/app/actions.ts')>()),
  ensureAudio: () => {
    calls.push('audio');
    return Promise.resolve();
  },
  playPasses: () => {
    calls.push('play');
    return { ok: true };
  },
  stopPasses: () => calls.push('stop'),
}));

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

let S: typeof StoreModule;
let V: typeof ViewModule;
/** The history's answer for a version, held until the test lets it go. */
let answer: (song: Project) => void = () => {};

beforeAll(async () => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('innerWidth', 390);
  vi.stubGlobal('innerHeight', 844);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('addEventListener', () => {});
  vi.stubGlobal('removeEventListener', () => {});
  vi.stubGlobal('document', {
    addEventListener() {},
    removeEventListener() {},
    documentElement: { style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} }, dataset: {} },
    visibilityState: 'visible',
    hidden: false,
  });
  vi.stubGlobal('fetch', (url: string) => {
    calls.push(/\/history\/\d+$/.test(url) ? 'version' : `fetch ${url}`);
    return new Promise<Response>((done) => {
      answer = (song) => done(new Response(JSON.stringify(song), { status: 200 }));
    });
  });
  S = await import('../src/app/store.ts');
  V = await import('../src/app/agent-view.ts');
});

describe('a view’s play button', () => {
  it('starts the audio in the click itself, before a version it plays has arrived', async () => {
    const now = newProject('A song');
    S.store.set({ project: now, undo: [], redo: [], selectedNotes: [], selectedRegions: [] });
    const view: View = { blocks: [], versions: { Before: 3 } };
    const played = V.playBars(view, { from: 1, to: 5, version: 'Before' }, 'play-1');
    // still in the click: the audio has been asked to start, the version only asked for
    expect(calls).toEqual(['audio', 'version']);
    answer({ ...newProject('Before'), id: now.id, revision: 3 });
    expect(await played).toBeNull();
    expect(calls).toEqual(['audio', 'version', 'play']);
  });
});
