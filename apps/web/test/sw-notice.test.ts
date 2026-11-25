import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';

// The service worker's notices (src/sw-template.js, as the build writes it out): the agent's, and a
// bounce the host made. Run here with a stand-in for the worker's world.

type Handler = (event: Record<string, unknown>) => void;

interface Shown {
  title: string;
  options: { body: string; tag: string; data: { url: string; project: string | null; job: string | null } };
}

function worker(windows: { url: string }[] = []) {
  const source = readFileSync(resolve(import.meta.dirname, '../src/sw-template.js'), 'utf8').replace(
    '/* BUILD */ null',
    JSON.stringify({ version: 'test', shell: [], lazy: [] }),
  );
  const handlers = new Map<string, Handler>();
  const shown: Shown[] = [];
  const badges: (number | 'cleared')[] = [];
  const focused: string[] = [];
  const posted: unknown[] = [];
  const opened: string[] = [];
  const self = {
    registration: {
      scope: 'https://holo.test/',
      showNotification: async (title: string, options: Shown['options']) => void shown.push({ title, options }),
    },
    location: { origin: 'https://holo.test' },
    navigator: {
      setAppBadge: async (n: number) => void badges.push(n),
      clearAppBadge: async () => void badges.push('cleared'),
    },
    clients: {
      claim: async () => undefined,
      matchAll: async () =>
        windows.map((w) => ({
          url: w.url,
          focus: async () => void focused.push(w.url),
          postMessage: (msg: unknown) => void posted.push(msg),
        })),
      openWindow: async (url: string) => void opened.push(url),
    },
    addEventListener: (type: string, fn: Handler) => void handlers.set(type, fn),
  };
  vm.runInNewContext(source, { self, URL, URLSearchParams, Request, Response, caches: {}, fetch: () => undefined });
  const fire = async (type: string, event: Record<string, unknown>) => {
    const waits: Promise<unknown>[] = [];
    handlers.get(type)?.({ ...event, waitUntil: (p: Promise<unknown>) => void waits.push(p) });
    await Promise.all(waits);
  };
  const push = (payload: unknown) => fire('push', { data: { json: () => payload } });
  const tap = (n: Shown) =>
    fire('notificationclick', { notification: { close: () => undefined, data: n.options.data } });
  return { shown, badges, focused, posted, opened, push, tap };
}

const AGENT = {
  title: 'HO[LO] Desk',
  body: 'Song: a reply is ready.',
  project: 'prj_abc',
  job: 'agj_0123456789ab',
  unseen: 2,
};
const BOUNCE = { title: 'HO[LO] Desk', body: 'Song: the bounce is ready (4:07).', kind: 'bounce', song: 'prj_abc' };

describe('the notices the service worker shows', () => {
  it('shows the agent’s under its song, opening the page at that reply, and sets the badge', async () => {
    const w = worker();
    await w.push(AGENT);
    expect(w.shown).toHaveLength(1);
    expect(w.shown[0]).toMatchObject({
      title: 'HO[LO] Desk',
      options: {
        body: 'Song: a reply is ready.',
        tag: 'prj_abc',
        data: {
          url: 'https://holo.test/?project=prj_abc&turn=agj_0123456789ab',
          project: 'prj_abc',
          job: 'agj_0123456789ab',
        },
      },
    });
    expect(w.badges).toEqual([2]);
  });

  it('shows a bounce’s beside it, not in its place, opening HO[LO] on the song, and leaves the badge alone', async () => {
    const w = worker();
    await w.push(AGENT);
    await w.push(BOUNCE);
    expect(w.shown).toHaveLength(2);
    expect(w.shown[1]).toMatchObject({
      title: 'HO[LO] Desk',
      options: {
        body: 'Song: the bounce is ready (4:07).',
        tag: 'bounce:prj_abc',
        data: { url: 'https://holo.test/?project=prj_abc', project: null, job: null },
      },
    });
    expect(w.shown[1]?.options.tag).not.toBe(w.shown[0]?.options.tag);
    // (the badge counts the agent's replies: a bounce's notice says nothing of it)
    expect(w.badges).toEqual([2]);
  });

  it('shows a bounce’s plainly when its song is nothing it can open', async () => {
    const w = worker();
    await w.push({ kind: 'bounce', song: '../../x', title: 7 });
    expect(w.shown[0]).toMatchObject({
      title: 'HO[LO] Desk',
      options: { body: 'A bounce is ready.', tag: 'holo:bounce', data: { url: 'https://holo.test/', project: null } },
    });
  });

  it('brings the open studio to the front for a bounce, without the agent’s page; opens HO[LO] on the song when none is open', async () => {
    const open = worker([{ url: 'https://holo.test/?project=prj_other' }]);
    await open.push(BOUNCE);
    await open.tap(open.shown[0] as Shown);
    expect(open.focused).toEqual(['https://holo.test/?project=prj_other']);
    expect(open.posted).toEqual([]);
    expect(open.opened).toEqual([]);
    const closed = worker();
    await closed.push(BOUNCE);
    await closed.tap(closed.shown[0] as Shown);
    expect(closed.opened).toEqual(['https://holo.test/?project=prj_abc']);
    // (the Remote isn't a studio)
    const remote = worker([{ url: 'https://holo.test/remote' }]);
    await remote.push(BOUNCE);
    await remote.tap(remote.shown[0] as Shown);
    expect(remote.focused).toEqual([]);
    expect(remote.opened).toEqual(['https://holo.test/?project=prj_abc']);
  });

  it('opens the page at the reply for the agent’s, as before', async () => {
    const w = worker([{ url: 'https://holo.test/' }]);
    await w.push(AGENT);
    await w.tap(w.shown[0] as Shown);
    expect(w.focused).toEqual(['https://holo.test/']);
    expect(w.posted).toEqual([{ type: 'open-turn', project: 'prj_abc', job: 'agj_0123456789ab' }]);
  });
});
