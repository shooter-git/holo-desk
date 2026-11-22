import type { View } from '@holo/agent/view';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AgentModule from '../src/app/agent.ts';
import type { AgentState, JobView, Turn } from '../src/app/agent.ts';
import type { Layout } from '../src/app/layout.ts';
import type * as TrayModule from '../src/app/tray.ts';

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
let T: typeof TrayModule;
const browser = new Storage();

beforeAll(async () => {
  // the modules read the browser's storage and the screen as they load: theirs are these
  vi.stubGlobal('localStorage', browser);
  vi.stubGlobal('window', globalThis);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('addEventListener', () => undefined);
  A = await import('../src/app/agent.ts');
  T = await import('../src/app/tray.ts');
});

const ON = { enabled: true, allowed: true, pairing: false, runner: { connected: true, keyed: true } };
const SONG = 'prj_a';
const TAKES = 'agj_00000000000c';

/** A reply's view with a dock: three takes and Keep. */
const VIEW: View = {
  blocks: [{ text: 'Three takes of the bass.' }],
  versions: { 'Take 1': 4, 'Take 2': 5, 'Take 3': 6 },
  dock: [
    {
      choice: [
        { label: 'Take 1', do: { play: { from: 5, to: 13, version: 'Take 1' } } },
        { label: 'Take 2', do: { play: { from: 5, to: 13, version: 'Take 2' } } },
        { label: 'Take 3', do: { play: { from: 5, to: 13, version: 'Take 3' } } },
      ],
    },
    { button: 'Keep Take 2', do: { keep: 'Take 2' } },
  ],
};

const turn = (patch: Partial<Turn> = {}): Turn => ({
  job: TAKES,
  request: 'Three bass takes for the verse',
  reply: 'Three takes, each kept as a version.',
  label: 'Three bass takes',
  state: 'done',
  at: 2000,
  view: VIEW,
  ...patch,
});

/** The agent on for this device, with the song's conversation: an earlier turn, then these. */
function withTurns(...turns: Turn[]): AgentState {
  const on = A.reduce(A.reduce(A.EMPTY, { type: 'me', id: 'dev_me' }), { type: 'info', info: ON });
  const earlier = turn({ job: 'agj_00000000000a', at: 1000, view: undefined });
  return A.reduce(on, { type: 'thread', project: SONG, turns: [earlier, ...turns] });
}

const SEEN: TrayModule.Kept = { seen: [TAKES], gone: [] };
const tray = (a: AgentState, kept = SEEN, layout: Layout = 'phone-portrait', open = false) =>
  T.trayFor(a, SONG, kept, layout, open)?.job ?? null;

describe('the tray: when a reply’s dock waits in the studio', () => {
  it('shows the newest reply’s dock once it has been read, the page closed, on a phone either way up', () => {
    const a = withTurns(turn());
    expect(tray(a)).toBe(TAKES);
    expect(tray(a, SEEN, 'phone-landscape')).toBe(TAKES);
    expect(T.trayFor(a, SONG, SEEN, 'phone-portrait', false)?.view?.dock).toEqual(VIEW.dock);
  });

  it('isn’t there for a reply not read yet: the dot says it', () => {
    expect(tray(withTurns(turn()), { seen: [], gone: [] })).toBeNull();
    expect(tray(withTurns(turn()), { seen: ['agj_00000000000a'], gone: [] })).toBeNull();
  });

  it('goes once put away', () => {
    expect(tray(withTurns(turn()), { seen: [TAKES], gone: [TAKES] })).toBeNull();
  });

  it('goes with the next request: on its way, working, turned down, or done without a dock', () => {
    const a = withTurns(turn());
    expect(tray(A.reduce(a, { type: 'sending', project: SONG, request: 'Busier', at: 3000 }))).toBeNull();
    const working: JobView = {
      id: 'agj_00000000000d',
      project: SONG,
      device: 'dev_me',
      state: 'running',
      request: 'Busier',
      started: 3000,
    };
    expect(tray(A.reduce(a, { type: 'status', job: working, barOpen: false }))).toBeNull();
    expect(
      tray(A.reduce(a, { type: 'refused', project: SONG, request: 'Busier', error: 'No harness', at: 3000 })),
    ).toBeNull();
    const plain = withTurns(turn(), turn({ job: 'agj_00000000000d', at: 3000, view: undefined }));
    expect(tray(plain, { seen: [TAKES, 'agj_00000000000d'], gone: [] })).toBeNull();
  });

  it('isn’t there while its own request works, or waits for a click', () => {
    expect(tray(withTurns(turn({ state: 'running' })))).toBeNull();
    expect(
      tray(withTurns(turn({ state: 'awaiting', permission: { kind: 'bounce', detail: 'Bounce it' } }))),
    ).toBeNull();
  });

  it('isn’t on a tablet or a desktop, nor while the page is open', () => {
    const a = withTurns(turn());
    expect(tray(a, SEEN, 'tablet')).toBeNull();
    expect(tray(a, SEEN, 'desktop')).toBeNull();
    expect(tray(a, SEEN, 'phone-portrait', true)).toBeNull();
    expect(tray(a, SEEN, 'phone-landscape', true)).toBeNull();
  });

  it('isn’t there for another song, with the agent off, or for a dock that doesn’t pass the check', () => {
    const a = withTurns(turn());
    expect(T.trayFor(a, 'prj_b', SEEN, 'phone-portrait', false)).toBeNull();
    expect(tray(A.reduce(a, { type: 'info', info: { ...ON, enabled: false } }))).toBeNull();
    const slider = { ...VIEW, dock: [{ slider: { track: 'trk_1', param: 'volume' } }] } as View;
    expect(tray(withTurns(turn({ view: slider })))).toBeNull();
    expect(tray(withTurns(turn({ view: { ...VIEW, dock: [] } })))).toBeNull();
  });
});

describe('what the tray keeps on this device', () => {
  const ids = (n: number, from = 0) =>
    Array.from({ length: n }, (_, i) => `agj_${(from + i).toString(16).padStart(12, '0')}`);

  it('reads only job ids, the latest 20 of each', () => {
    const s = new Storage();
    expect(T.readKept(s)).toEqual({ seen: [], gone: [] });
    s.setItem('holo:agent-tray', 'not json');
    expect(T.readKept(s)).toEqual({ seen: [], gone: [] });
    s.setItem('holo:agent-tray', JSON.stringify([TAKES]));
    expect(T.readKept(s)).toEqual({ seen: [], gone: [] });
    s.setItem(
      'holo:agent-tray',
      JSON.stringify({ seen: [TAKES, 'agj_nothex', 42, '<b>', 'agj_00000000000d'], gone: 'agj_00000000000c' }),
    );
    expect(T.readKept(s)).toEqual({ seen: [TAKES, 'agj_00000000000d'], gone: [] });
    s.setItem('holo:agent-tray', JSON.stringify({ seen: ids(25), gone: ids(30) }));
    expect(T.readKept(s)).toEqual({ seen: ids(20, 5), gone: ids(20, 10) });
  });

  it('marks a reply read and a tray put away, keeping the latest 20 of each', () => {
    const s = new Storage();
    for (const id of ids(25, 100)) T.markSeen(id, s);
    T.markSeen('not a job', s);
    T.dismiss(TAKES, s);
    T.dismiss(TAKES, s);
    expect(T.keptNow().seen).toEqual(ids(20, 105));
    expect(T.keptNow().gone).toEqual([TAKES]);
    expect(T.readKept(s)).toEqual(T.keptNow());
    // one read again is there once
    T.markSeen(ids(1, 110)[0] as string, s);
    expect(T.keptNow().seen).toEqual(ids(20, 105));
  });

  it('is kept for the page when storage refuses it (a private window)', () => {
    const refusing = {
      getItem: () => null,
      setItem: () => {
        throw new Error('QuotaExceededError');
      },
      removeItem: () => undefined,
    };
    T.markSeen('agj_0000000000ff', refusing);
    expect(T.keptNow().seen).toContain('agj_0000000000ff');
  });
});

describe('the tray after a reload: the song’s conversation read quietly as it opens', () => {
  it('is read only with the agent on, not read yet, and a tray that could come of it', () => {
    const a = withTurns(turn());
    const off = A.reduce(a, { type: 'info', info: { ...ON, enabled: false } });
    expect(T.trayWantsThread(a, 'prj_b', SEEN)).toBe(true);
    // read already (the page opened), another song not open, the agent off
    expect(T.trayWantsThread(a, SONG, SEEN)).toBe(false);
    expect(T.trayWantsThread(a, null, SEEN)).toBe(false);
    expect(T.trayWantsThread(off, 'prj_b', SEEN)).toBe(false);
    // no reply with a dock read here, or every one put away: no tray could show, nothing is asked
    expect(T.trayWantsThread(a, 'prj_b', { seen: [], gone: [] })).toBe(false);
    expect(T.trayWantsThread(a, 'prj_b', { seen: [TAKES], gone: [TAKES] })).toBe(false);
  });

  /** The host answers the song's conversation (its turns, and its job working or waiting); what's asked is kept. */
  function host(turns: Turn[], job: JobView | null): string[] {
    const asked: string[] = [];
    vi.stubGlobal('fetch', async (path: string) => {
      asked.push(path);
      const body = path === `/api/agent/threads/${SONG}` ? { thread: { turns }, job, now: Date.now() } : {};
      return { ok: true, status: 200, json: async () => body } as Response;
    });
    return asked;
  }

  /** A fresh page: the agent on for this device, another song's reply waiting (the dot), nothing read. */
  function reloaded(): void {
    A.agent.dispatch({ type: 'info', info: { ...ON, enabled: false } });
    A.agent.dispatch({ type: 'me', id: 'dev_me' });
    A.agent.dispatch({ type: 'info', info: ON });
    const elsewhere: JobView = {
      id: 'agj_0000000000e1',
      project: 'prj_b',
      device: 'dev_me',
      state: 'done',
      request: 'Tidy the drums',
      started: 500,
    };
    A.agent.dispatch({ type: 'status', job: elsewhere, barOpen: false });
  }

  it('brings the tray back from what was read and put away here, and leaves the dot as it was', async () => {
    reloaded();
    browser.setItem('holo:agent-tray', JSON.stringify({ seen: [TAKES], gone: [] }));
    const followed = A.readFollowed().map((f) => f.id);
    expect(A.agent.get().unseen).toBe(true);
    const asked = host([turn({ job: 'agj_00000000000a', at: 1000, view: undefined }), turn()], null);
    expect(T.trayWantsThread(A.agent.get(), SONG, T.readKept())).toBe(true);
    await A.loadThread(SONG, false);
    expect(asked).toEqual([`/api/agent/threads/${SONG}`]);
    expect(A.agent.get().unseen).toBe(true);
    expect(A.readFollowed().map((f) => f.id)).toEqual(followed);
    expect(T.trayFor(A.agent.get(), SONG, T.readKept(), 'phone-portrait', false)?.job).toBe(TAKES);
    // read once: not again for that song
    expect(T.trayWantsThread(A.agent.get(), SONG, T.readKept())).toBe(false);
    // put away before the reload, it stays away
    browser.setItem('holo:agent-tray', JSON.stringify({ seen: [TAKES], gone: [TAKES] }));
    expect(T.trayFor(A.agent.get(), SONG, T.readKept(), 'phone-portrait', false)).toBeNull();
  });

  it('doesn’t take the song’s job working or waiting for a click as seen, nor as a reply waiting', async () => {
    for (const state of ['running', 'awaiting'] as const) {
      reloaded();
      // this device's request on the song, followed across the reload
      const id = 'agj_0000000000f1';
      A.agent.dispatch({
        type: 'sent',
        job: { id, project: SONG, device: 'dev_me', state: 'waiting', request: 'Bounce it', started: 3000 },
      });
      const followed = A.readFollowed().map((f) => f.id);
      expect(followed, state).toContain(id);
      const now: JobView = {
        id,
        project: SONG,
        device: 'dev_me',
        state,
        request: 'Bounce it',
        started: 3000,
        ...(state === 'awaiting' ? { permission: { kind: 'bounce' as const, detail: 'Bounce the song' } } : {}),
      };
      host([turn(), turn({ job: id, at: 3000, state, view: undefined, reply: null })], now);
      await A.loadThread(SONG, false);
      // read quietly: the job isn't told of from here, the dot stays, and it's still followed
      expect(A.agent.get().jobs[id]?.state, state).toBe('waiting');
      expect(A.agent.get().unseen, state).toBe(true);
      expect(
        A.readFollowed().map((f) => f.id),
        state,
      ).toEqual(followed);
      // the newest is that job's turn: no tray
      expect(T.trayFor(A.agent.get(), SONG, SEEN, 'phone-portrait', false), state).toBeNull();
      // the page, opening, reads it as before: the job's button comes back, and one waiting for a
      // click is seen there
      await A.loadThread(SONG);
      expect(A.agent.get().jobs[id]?.state, state).toBe(state);
      expect(
        A.readFollowed().some((f) => f.id === id),
        state,
      ).toBe(state === 'running');
    }
  });
});
