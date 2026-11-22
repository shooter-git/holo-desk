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

beforeAll(async () => {
  // the modules read the browser's storage and the screen as they load: theirs are these
  vi.stubGlobal('localStorage', new Storage());
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
