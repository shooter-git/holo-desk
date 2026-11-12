import { type Note, newProject, newRegion, newTrack, PPQ } from '@holo/session';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type * as AgentModule from '../src/app/agent.ts';
import type { AgentState, JobView } from '../src/app/agent.ts';
import type { Actions, BarState } from '../src/app/commands.ts';
import type * as StoreModule from '../src/app/store.ts';

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

const storage = new Storage();
let A: typeof AgentModule;
let S: typeof StoreModule;
let C: typeof import('../src/app/commands.ts');

beforeAll(async () => {
  // the modules read the browser's storage as they load: theirs is this one
  vi.stubGlobal('localStorage', storage);
  vi.stubGlobal('window', globalThis);
  S = await import('../src/app/store.ts');
  A = await import('../src/app/agent.ts');
  C = await import('../src/app/commands.ts');
});

afterEach(() => {
  vi.useRealTimers();
});

const ON = { enabled: true, allowed: true, pairing: false, runner: { connected: true, keyed: true } };
const OFF = { ...ON, enabled: false };

function job(patch: Partial<JobView> = {}): JobView {
  return {
    id: 'agj_000000000001',
    project: 'prj_a',
    device: 'dev_me',
    state: 'waiting',
    request: 'Add a bass line',
    started: 1000,
    ...patch,
  };
}

/** The agent on, for this device (`dev_me`). */
function on(): AgentState {
  return A.reduce(A.reduce(A.EMPTY, { type: 'me', id: 'dev_me' }), { type: 'info', info: ON });
}

describe('with the agent off', () => {
  it('shows nothing, and keeps nothing to show', () => {
    let a = on();
    a = A.reduce(a, { type: 'status', job: job({ state: 'running' }), barOpen: false });
    a = A.reduce(a, { type: 'thread', project: 'prj_a', turns: [] });
    expect(A.exchange(a, 'prj_a')).not.toBeNull();
    expect(A.barSign(a, 'prj_a')).toBe('busy');
    // turned off (on another device, say): the jobs and the conversation go with it
    a = A.reduce(a, { type: 'info', info: OFF });
    expect(A.isOn(a)).toBe(false);
    expect(a.jobs).toEqual({});
    expect(a.thread).toBeNull();
    expect(A.exchange(a, 'prj_a')).toBeNull();
    expect(A.barSign(a, 'prj_a')).toBeNull();
    // a device that isn't allowed sees nothing either, on or not
    const stranger = A.reduce(A.EMPTY, { type: 'info', info: { ...ON, allowed: false } });
    expect(A.isOn(stranger)).toBe(false);
    expect(A.exchange(stranger, 'prj_a')).toBeNull();
  });

  it('ignores the agent’s messages and reports nothing', () => {
    A.agent.dispatch({ type: 'info', info: OFF });
    expect(S.store.get().agentReport).toBe(false);
    const r = A.agentMessage({ type: 'agent-status', job: job({ state: 'running' }) });
    expect(r.handled).toBe(true);
    expect(r.effects).toBeUndefined();
    expect(A.agent.get().jobs).toEqual({});
    expect(A.helloFields()).toEqual({});
    // on, and Undo and Redo are reported again
    A.agent.dispatch({ type: 'info', info: ON });
    expect(S.store.get().agentReport).toBe(true);
    A.agent.dispatch({ type: 'info', info: OFF });
    expect(S.store.get().agentReport).toBe(false);
  });

  it('offers no request row in the bar, only the studio’s commands', () => {
    const state = barState();
    const act = new Proxy({} as Actions, { get: () => () => undefined });
    const rows = C.barRows('make the bass louder', state, act);
    expect(rows.map((r) => r.id)).toEqual(['find-sound']);
  });
});

describe('a job, as the host tells it', () => {
  it('works, then replies, under the field', () => {
    let a = on();
    a = A.reduce(a, { type: 'sending', project: 'prj_a', request: 'Add a bass line', at: 999 });
    let ex = A.exchange(a, 'prj_a');
    expect(ex).toMatchObject({ job: null, request: 'Add a bass line', working: true, reply: null });
    expect(A.barSign(a, 'prj_a')).toBe('busy');

    a = A.reduce(a, { type: 'status', job: job(), barOpen: true });
    expect(a.sending).toBeNull();
    a = A.reduce(a, { type: 'status', job: job({ state: 'running', line: 'Writing bars 5–8' }), barOpen: true });
    ex = A.exchange(a, 'prj_a');
    expect(ex).toMatchObject({ job: 'agj_000000000001', working: true, line: 'Writing bars 5–8', mine: true });

    a = A.reduce(a, {
      type: 'status',
      job: job({ state: 'done', label: 'Bass line', reply: 'Added a bass line in bars 5–8.' }),
      barOpen: true,
    });
    ex = A.exchange(a, 'prj_a');
    expect(ex).toMatchObject({ working: false, reply: 'Added a bass line in bars 5–8.', permission: null });
    expect(A.barSign(a, 'prj_a')).toBeNull();
    // (the bar was open: nothing waits to be seen)
    expect(a.unseen).toBe(false);
  });

  it('marks the bar’s button when one of this device’s ends while the bar is closed', () => {
    let a = on();
    a = A.reduce(a, { type: 'status', job: job({ state: 'running' }), barOpen: false });
    expect(A.barSign(a, 'prj_a')).toBe('busy');
    // another song's job, or another device's, isn't this studio's to show
    expect(A.barSign(a, 'prj_b')).toBeNull();
    const theirs = A.reduce(on(), {
      type: 'status',
      job: job({ device: 'dev_other', state: 'running' }),
      barOpen: false,
    });
    expect(A.barSign(theirs, 'prj_a')).toBeNull();
    expect(
      A.reduce(theirs, { type: 'status', job: job({ device: 'dev_other', state: 'done' }), barOpen: false }).unseen,
    ).toBe(false);

    a = A.reduce(a, { type: 'status', job: job({ state: 'done', reply: 'Done.' }), barOpen: false });
    expect(A.barSign(a, 'prj_a')).toBe('done');
    // told again (the same end), still once; opening the bar clears it
    a = A.reduce(a, { type: 'status', job: job({ state: 'done', reply: 'Done.' }), barOpen: false });
    a = A.reduce(a, { type: 'seen' });
    expect(A.barSign(a, 'prj_a')).toBeNull();
  });

  it('tells the studio whether its job runs, and the step’s final name', () => {
    const a = on();
    expect(A.statusEffects(a, job({ state: 'running' }))).toEqual({ running: true });
    expect(A.statusEffects(a, job({ state: 'done', label: 'Bass line' }))).toEqual({
      running: false,
      label: 'Bass line',
    });
    expect(A.statusEffects(a, job({ state: 'cancelled', error: 'Stopped' }))).toEqual({ running: false });
    expect(A.statusEffects(a, job({ device: 'dev_other', state: 'running' }))).toBeNull();
  });

  it('asks for a permission with one button, on the device that asked only', () => {
    let a = on();
    const asking = job({
      state: 'awaiting',
      reply: 'The closest flute is a 281 MB download.',
      permission: { kind: 'install-pack', detail: 'Iowa Flute', pack: 'iowa-flute' },
    });
    a = A.reduce(a, { type: 'status', job: asking, barOpen: true });
    expect(A.exchange(a, 'prj_a')).toMatchObject({
      permission: { kind: 'install-pack', pack: 'iowa-flute' },
      mine: true,
    });
    const elsewhere = A.reduce(on(), { type: 'status', job: { ...asking, device: 'dev_other' }, barOpen: true });
    expect(A.exchange(elsewhere, 'prj_a')?.mine).toBe(false);
  });

  it('shows a brief with the lines to read twice, and why a job stopped', () => {
    let a = on();
    a = A.reduce(a, {
      type: 'status',
      job: job({
        state: 'done',
        reply: 'That changes HO[LO] itself: here is a brief.',
        brief: 'Make the strips wider\npnpm test\nSee https://example.com',
        briefWarnings: [
          { line: 1, kind: 'command' },
          { line: 2, kind: 'url' },
        ],
      }),
      barOpen: true,
    });
    const ex = A.exchange(a, 'prj_a');
    expect(ex?.brief).toContain('pnpm test');
    expect([...(ex?.flagged ?? [])]).toEqual([
      [1, 'command'],
      [2, 'url'],
    ]);
    a = A.reduce(a, {
      type: 'status',
      job: job({ id: 'agj_000000000002', state: 'cancelled', started: 2000 }),
      barOpen: true,
    });
    expect(A.exchange(a, 'prj_a')).toMatchObject({ job: 'agj_000000000002', reply: 'Stopped' });
    a = A.reduce(a, {
      type: 'status',
      job: job({ id: 'agj_000000000003', state: 'failed', error: 'The runner disconnected', started: 3000 }),
      barOpen: true,
    });
    expect(A.exchange(a, 'prj_a')?.reply).toBe('The runner disconnected');
  });

  it('says why a request was turned down, as its reply', () => {
    let a = on();
    a = A.reduce(a, { type: 'sending', project: 'prj_a', request: 'Add strings', at: 5000 });
    a = A.reduce(a, { type: 'refused', project: 'prj_a', request: 'Add strings', error: 'Start the runner', at: 5000 });
    expect(A.exchange(a, 'prj_a')).toMatchObject({ request: 'Add strings', working: false, reply: 'Start the runner' });
  });

  it('shows the conversation’s last turn until a newer job comes, and forgets it on a new conversation', () => {
    let a = on();
    a = A.reduce(a, {
      type: 'thread',
      project: 'prj_a',
      turns: [
        { job: 'agj_00000000000a', request: 'First', reply: 'One', label: 'One', state: 'done', at: 10 },
        { job: 'agj_00000000000b', request: 'Second', reply: 'Two', label: 'Two', state: 'done', at: 20 },
      ],
    });
    expect(A.exchange(a, 'prj_a')).toMatchObject({ request: 'Second', reply: 'Two' });
    a = A.reduce(a, { type: 'status', job: job({ request: 'Third', started: 30 }), barOpen: true });
    expect(A.exchange(a, 'prj_a')?.request).toBe('Third');
    a = A.reduce(a, {
      type: 'status',
      job: job({ request: 'Third', started: 30, state: 'done', reply: '3' }),
      barOpen: true,
    });
    a = A.reduce(a, { type: 'reset', project: 'prj_a' });
    expect(A.exchange(a, 'prj_a')).toBeNull();
  });

  it('lets this device go when it is removed', () => {
    let a = on();
    a = A.reduce(a, { type: 'status', job: job({ state: 'running' }), barOpen: false });
    a = A.reduce(a, { type: 'removed' });
    expect(A.isOn(a)).toBe(false);
    expect(a.me).toBeNull();
    expect(a.jobs).toEqual({});
  });
});

describe('the request row', () => {
  const act = new Proxy({} as Actions, { get: () => () => undefined });
  const ask = (text: string) => ({
    id: 'ask',
    title: 'Ask the agent',
    group: 'Agent',
    keepOpen: true,
    run: () => text,
  });

  it('comes last when a command fits what was typed, first when none does', () => {
    const s = barState();
    expect(C.barRows('quant', s, act, { ask }).map((r) => r.id)).toEqual(['quantize', 'find-sound', 'ask']);
    expect(C.barRows('make the bass louder', s, act, { ask }).map((r) => r.id)).toEqual(['ask']);
    expect(C.barRows('17', s, act, { ask }).map((r) => r.id)).toEqual(['go-to-position', 'ask']);
    const rows = C.barRows('m', s, act, { ask });
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(rows.at(-1)?.id).toBe('ask');
  });
});

describe('what a request carries', () => {
  it('the view, the selection with its span, the playhead and the cycle', () => {
    const s = barState();
    const ctx = A.requestContext({ ...S.store.get(), ...s, scanView: null, printView: null }, 3840.4, false);
    expect(ctx).toEqual({
      view: 'tracks and piano roll',
      selection: { track: s.selectedTrack, regions: [], notes: 2, from: 4 * 4 * PPQ, to: 4 * 4 * PPQ + 4 * PPQ + PPQ },
      playhead: 3840,
      cycle: { on: false, start: s.project?.cycle.start, end: s.project?.cycle.end },
    });
    const phone = { ...S.store.get(), mobileTab: 'mixer' as const, scanView: null, printView: null };
    expect(A.viewName(phone, true)).toBe('mixer');
    expect(A.viewName({ ...phone, scanView: { id: 'scn_1' } }, true)).toBe('scan');
  });
});

describe('this device’s token', () => {
  it('is kept in its own key, never in the view this device remembers', () => {
    vi.useFakeTimers();
    A.keepToken('secret-token-123', 'dev_me');
    expect(storage.getItem('holo:agent-token')).toBe('secret-token-123');
    expect(A.helloFields()).toEqual({ agentToken: 'secret-token-123' });
    // the agent on, its state changing, and a remembered setting changing: the view is written
    A.agent.dispatch({ type: 'info', info: ON });
    A.agent.dispatch({ type: 'status', job: job({ state: 'running' }), barOpen: false });
    S.store.set({ zoom: 55, bar: true });
    vi.advanceTimersByTime(1000);
    const view = storage.getItem('holo:view') ?? '';
    expect(view).toContain('"zoom":55');
    expect(view).not.toContain('secret-token-123');
    expect(view).not.toContain('agentReport');
    expect(view).not.toContain('"bar"');
    expect(Object.keys(S.store.get())).not.toContain('token');
    A.forgetToken();
    expect(storage.getItem('holo:agent-token')).toBeNull();
    expect(A.helloFields()).toEqual({});
  });
});

/** The bar's state for a song with Piano selected and two of its notes in bars 5–6. */
function barState(): BarState {
  const project = newProject('Night Window');
  const piano = newTrack('Piano', { type: 'synth', preset: 'Soft Keys' });
  const region = newRegion(4 * 4 * PPQ, 4 * 4 * PPQ);
  const notes: Note[] = [
    { t: 0, d: PPQ, p: 60, v: 100 },
    { t: 4 * PPQ, d: PPQ, p: 64, v: 100 },
  ];
  region.notes = notes;
  piano.regions.push(region);
  project.tracks = [piano];
  return {
    project,
    selectedTrack: piano.id,
    selectedRegions: [],
    selectedNotes: notes,
    editor: 'piano',
    noteView: 'roll',
    inspector: true,
    library: false,
    automationView: false,
    playing: false,
    recording: false,
    typing: false,
    undo: [],
    redo: [],
    bouncing: null,
    playhead: 0,
    phone: false,
  };
}

describe('a scan’s tasks in the bar', () => {
  const run = { scan: () => undefined, reset: () => undefined };
  const ids = (rows: { id: string }[]) => rows.map((r) => r.id);

  it('are offered only with the agent on and a scan open', () => {
    expect(A.agentCommands({ on: false, project: 'prj_a', scan: 'scn_1', busy: false }, run)).toEqual({
      suggest: [],
      commands: [],
    });
    const noScan = A.agentCommands({ on: true, project: 'prj_a', scan: null, busy: false }, run);
    expect(ids(noScan.suggest)).toEqual([]);
    expect(ids(noScan.commands)).toEqual(['agent-new']);
    const scan = A.agentCommands({ on: true, project: 'prj_a', scan: 'scn_1', busy: false }, run);
    expect(scan.suggest.map((r) => r.title)).toEqual(['Read this scan', 'Check it', 'Fix flagged']);
    expect(ids(scan.commands)).toEqual(['scan-read', 'scan-check', 'scan-fix', 'agent-new']);
    // while the song's request runs, none (the host takes one at a time)
    const busy = A.agentCommands({ on: true, project: 'prj_a', scan: 'scn_1', busy: true }, run);
    expect(busy.suggest).toEqual([]);
  });

  it('come first in the bar before anything is typed, and are found by name', () => {
    const act = new Proxy({} as Actions, { get: () => () => undefined });
    const { suggest, commands } = A.agentCommands({ on: true, project: 'prj_a', scan: 'scn_1', busy: false }, run);
    const rows = C.barRows('', barState(), act, { suggest, commands });
    expect(rows.slice(0, 3).map((r) => r.title)).toEqual(['Read this scan', 'Check it', 'Fix flagged']);
    expect(rows.length).toBeLessThanOrEqual(8);
    expect(C.barRows('fix', barState(), act, { suggest, commands })[0]?.title).toBe('Fix flagged');
  });

  it('send the scan’s preset, not words', () => {
    const asked: string[] = [];
    const { suggest } = A.agentCommands(
      { on: true, project: 'prj_a', scan: 'scn_1', busy: false },
      { scan: (task, scan) => asked.push(`${task}:${scan}`), reset: () => undefined },
    );
    for (const r of suggest) r.run();
    expect(asked).toEqual(['read:scn_1', 'check:scn_1', 'fix:scn_1']);
  });
});

describe('the host’s word on the settings', () => {
  it('turned off on another device: everything of it goes', () => {
    let a = on();
    a = A.reduce(a, { type: 'status', job: job({ state: 'running' }), barOpen: false });
    a = A.reduce(a, { type: 'enabled', enabled: false });
    expect(A.isOn(a)).toBe(false);
    expect(a.jobs).toEqual({});
    expect(A.barSign(a, 'prj_a')).toBeNull();
    a = A.reduce(a, { type: 'enabled', enabled: true });
    expect(A.isOn(a)).toBe(true);
  });

  it('brings back a waiting permission and a brief after a reload, from the conversation', () => {
    let a = on();
    a = A.reduce(a, {
      type: 'thread',
      project: 'prj_a',
      turns: [
        {
          job: 'agj_00000000000a',
          request: 'A darker flute',
          reply: 'The closest is a download.',
          label: 'Flute',
          state: 'awaiting',
          at: 10,
          permission: { kind: 'install-pack', detail: 'Iowa Flute', pack: 'iowa-flute' },
          brief: 'pnpm test',
          briefWarnings: [{ line: 0, kind: 'command' }],
        },
      ],
    });
    const ex = A.exchange(a, 'prj_a');
    expect(ex?.permission?.pack).toBe('iowa-flute');
    expect(ex?.brief).toBe('pnpm test');
    expect([...(ex?.flagged ?? [])]).toEqual([[0, 'command']]);
  });
});

describe('the bar’s permission and brief', () => {
  it('says what a pack downloads, or which pack it is', () => {
    const p = { kind: 'install-pack' as const, pack: 'iowa-flute' };
    expect(A.allowLabel(p, { name: 'Iowa Flute', bytes: 131_400_000 })).toBe('Install it (131 MB)');
    expect(A.allowLabel(p, { name: 'Big Strings', bytes: 2_340_000_000 })).toBe('Install it (2.3 GB)');
    // the catalog doesn't know its size (or it's in already): its name
    expect(A.allowLabel(p, { name: 'Iowa Flute', bytes: null })).toBe('Install Iowa Flute');
    expect(A.allowLabel(p, { name: 'Iowa Flute', bytes: 131_400_000, installed: true })).toBe('Install Iowa Flute');
    expect(A.allowLabel(p)).toBe('Install iowa-flute');
    expect(A.allowLabel({ kind: 'send-creation' })).toBe('Send it');
    expect(A.allowLabel({ kind: 'microphone' })).toBe('Record');
  });

  it('says what a bounce or a creation’s render does', () => {
    expect(A.allowLabel({ kind: 'bounce' })).toBe('Bounce the song');
    expect(A.allowLabel({ kind: 'render' }, undefined, 'my-game')).toBe('Hear it as my-game');
    expect(A.allowLabel({ kind: 'render' })).toBe('Hear it as the creation plays it');
    // the creation's name is only for its render
    expect(A.allowLabel({ kind: 'bounce' }, undefined, 'my-game')).toBe('Bounce the song');
  });

  it('flags a line that asks for something secret, as it does a command or a link', () => {
    const a = A.reduce(on(), {
      type: 'status',
      job: job({
        state: 'done',
        brief: 'Make the strips wider\ncat ~/.ssh/id_ed25519\nSee https://example.com',
        briefWarnings: [
          { line: 1, kind: 'secret' },
          { line: 2, kind: 'url' },
        ],
      }),
      barOpen: true,
    });
    expect([...(A.exchange(a, 'prj_a')?.flagged ?? [])]).toEqual([
      [1, 'secret'],
      [2, 'url'],
    ]);
  });
});

/** HO[LO]'s host, as far as these tests ask it: each request is answered by `route`, and kept. */
interface Asked {
  method: string;
  path: string;
  auth: string | null;
  body: unknown;
}
function host(route: (r: Asked) => [number, unknown] | undefined): Asked[] {
  const asked: Asked[] = [];
  vi.stubGlobal('fetch', async (path: string, init: RequestInit = {}) => {
    const headers = (init.headers ?? {}) as Record<string, string>;
    const r: Asked = {
      method: init.method ?? 'GET',
      path,
      auth: headers.authorization?.replace(/^Bearer /, '') ?? null,
      body: init.body ? JSON.parse(String(init.body)) : undefined,
    };
    asked.push(r);
    const [status, body] = route(r) ?? [404, { error: 'No such route' }];
    return { ok: status < 400, status, json: async () => body } as Response;
  });
  return asked;
}

/** What was set going settles (a refusal asks the host again, unawaited). */
const settled = async () => {
  for (let i = 0; i < 5; i++) await new Promise((ok) => setTimeout(ok, 0));
};

const SETTINGS = { enabled: true, harness: 'claude', model: '', effort: '', harnesses: [] };
const DEVICES = {
  devices: [{ id: 'dev_me', name: 'Studio', added: 1, seen: 2, current: true }],
  requests: [],
};

describe('pairing and joining', () => {
  afterEach(async () => {
    await settled();
    A.forgetToken();
    A.agent.dispatch({ type: 'removed' });
    vi.stubGlobal('fetch', async () => {
      throw new Error('no host here');
    });
  });

  it('a wrong code leaves this device as it was: not allowed, no token', async () => {
    A.agent.dispatch({ type: 'info', info: { ...OFF, allowed: false, enabled: true } });
    host((r) => {
      if (r.path === '/api/agent/pair') return [401, { error: 'That code is wrong or has expired' }];
      if (r.path === '/api/agent') return [200, { ...ON, allowed: false }];
    });
    await expect(A.pair('000000', 'Studio')).rejects.toThrow('That code is wrong');
    await settled();
    expect(A.helloFields()).toEqual({});
    expect(A.isOn(A.agent.get())).toBe(false);
  });

  it('paired: allowed only once the host says so, and a token it doesn’t take is let go', async () => {
    host((r) => {
      if (r.path === '/api/agent/pair') return [200, { token: 'tok_new', device: { id: 'dev_me', name: 'Studio' } }];
      if (r.path === '/api/agent') return [200, { ...ON, allowed: r.auth === 'tok_good' }];
      if (r.path === '/api/agent/devices') return [200, DEVICES];
    });
    await expect(A.pair('123456', 'Studio')).rejects.toThrow('The host didn’t take this device');
    expect(A.helloFields()).toEqual({});
    expect(A.agent.get().me).toBeNull();
    expect(A.isOn(A.agent.get())).toBe(false);

    host((r) => {
      if (r.path === '/api/agent/pair') return [200, { token: 'tok_good', device: { id: 'dev_me', name: 'Studio' } }];
      if (r.path === '/api/agent') return [200, { ...ON, allowed: r.auth === 'tok_good' }];
      if (r.path === '/api/agent/devices') return [200, DEVICES];
    });
    await A.pair('123456', 'Studio');
    expect(A.helloFields()).toEqual({ agentToken: 'tok_good' });
    expect(A.isOn(A.agent.get())).toBe(true);
  });

  it('an answer about the token before pairing landed is asked again with the new one', async () => {
    const asked = host((r) => {
      if (r.path !== '/api/agent') return undefined;
      // pairing lands while the host is asked without a token (the host told every studio the agent is on)
      if (!r.auth) A.keepToken('tok_paired', 'dev_me');
      return [200, { ...ON, allowed: r.auth === 'tok_paired' }];
    });
    const info = await A.refreshAgent();
    expect(info?.allowed).toBe(true);
    expect(asked.filter((r) => r.path === '/api/agent').map((r) => r.auth)).toEqual([null, 'tok_paired']);
    // the token wasn't let go on the strength of the older answer
    expect(A.helloFields()).toEqual({ agentToken: 'tok_paired' });
  });

  it('approved to join: allowed with the token; approved without it (that answer was lost), not', async () => {
    host((r) => {
      if (r.path.startsWith('/api/agent/devices/requests/')) return [200, { state: 'approved' }];
      if (r.path === '/api/agent') return [200, { ...ON, allowed: false }];
    });
    expect(await A.pollJoin('req_1', 'secret')).toBe('lost');
    expect(A.helloFields()).toEqual({});
    expect(A.isOn(A.agent.get())).toBe(false);

    host((r) => {
      if (r.path.startsWith('/api/agent/devices/requests/'))
        return [200, { state: 'approved', token: 'tok_join', device: { id: 'dev_me', name: 'Phone' } }];
      if (r.path === '/api/agent') return [200, { ...ON, allowed: r.auth === 'tok_join' }];
      if (r.path === '/api/agent/devices') return [200, DEVICES];
    });
    expect(await A.pollJoin('req_1', 'secret')).toBe('approved');
    expect(A.isOn(A.agent.get())).toBe(true);
    expect(A.agent.get().me).toBe('dev_me');
  });

  it('a request that lapsed, or was denied, says so', async () => {
    host((r) =>
      r.path.endsWith('req_gone?secret=s') ? [404, { error: 'No such request' }] : [200, { state: 'denied' }],
    );
    expect(await A.pollJoin('req_gone', 's')).toBe('lapsed');
    expect(await A.pollJoin('req_no', 's')).toBe('denied');
    expect(A.helloFields()).toEqual({});
  });
});

describe('the live channel back', () => {
  afterEach(async () => {
    await settled();
    A.forgetToken();
    A.agent.dispatch({ type: 'removed' });
    vi.stubGlobal('fetch', async () => {
      throw new Error('no host here');
    });
  });

  /** This device allowed, the agent on, and a job of its running on prj_a. */
  function allowedWithAJob(): void {
    S.store.set({ bar: false });
    A.keepToken('tok_me', 'dev_me');
    A.agent.dispatch({ type: 'me', id: 'dev_me' });
    A.agent.dispatch({ type: 'info', info: ON });
    A.agent.dispatch({ type: 'status', job: job({ state: 'running', line: 'Writing bars 5–8' }), barOpen: false });
  }

  it('after the host restarted: settings and devices read again, and a job it ended ends here too', async () => {
    allowedWithAJob();
    const asked = host((r) => {
      if (r.path === '/api/agent') return [200, ON];
      if (r.path === '/api/agent/settings') return [200, SETTINGS];
      if (r.path === '/api/agent/devices') return [200, DEVICES];
      if (r.path === '/api/agent/threads/prj_a')
        return [
          200,
          {
            thread: {
              turns: [
                {
                  job: 'agj_000000000001',
                  request: 'Add a bass line',
                  reply: null,
                  label: null,
                  state: 'failed',
                  at: 1000,
                  error: 'HO[LO]’s host restarted before it was done',
                },
              ],
            },
            job: null,
          },
        ];
    });
    const effects = await A.catchUp();
    expect(effects).toEqual([{ job: 'agj_000000000001', running: false }]);
    const a = A.agent.get();
    expect(a.jobs.agj_000000000001?.state).toBe('failed');
    expect(A.exchange(a, 'prj_a')).toMatchObject({
      working: false,
      reply: 'HO[LO]’s host restarted before it was done',
    });
    expect(A.barSign(a, 'prj_a')).toBe('done');
    expect(a.settings).toEqual(SETTINGS);
    expect(a.devices).toEqual(DEVICES);
    expect(asked.map((r) => r.path)).toContain('/api/agent/threads/prj_a');
  });

  it('a job still running is told as the host has it; a device not allowed asks for nothing more', async () => {
    allowedWithAJob();
    host((r) => {
      if (r.path === '/api/agent') return [200, ON];
      if (r.path === '/api/agent/settings') return [200, SETTINGS];
      if (r.path === '/api/agent/devices') return [200, DEVICES];
      if (r.path === '/api/agent/threads/prj_a')
        return [200, { thread: null, job: job({ state: 'running', line: 'Writing bars 9–12' }) }];
    });
    expect(await A.catchUp()).toEqual([{ job: 'agj_000000000001', running: true }]);
    expect(A.exchange(A.agent.get(), 'prj_a')).toMatchObject({ working: true, line: 'Writing bars 9–12' });

    A.forgetToken();
    const asked = host((r) => (r.path === '/api/agent' ? [200, { ...ON, allowed: false }] : undefined));
    expect(await A.catchUp()).toEqual([]);
    expect(asked.map((r) => r.path)).toEqual(['/api/agent']);
  });

  it('asks how the agent stands when the host’s runners come or go', async () => {
    const asked = host((r) => (r.path === '/api/agent' ? [200, { ...OFF, allowed: false }] : undefined));
    const runner = { role: 'runner', name: 'Runner' };
    const editor = { role: 'editor', name: 'Studio' };
    A.peersSeen([editor, runner, runner, runner, runner]);
    A.peersSeen([editor, runner, runner, runner, runner]);
    await settled();
    expect(asked).toHaveLength(1);
    // the runner went (the host restarted, say), then came back
    A.peersSeen([editor]);
    A.peersSeen([editor, editor]);
    A.peersSeen([editor, runner]);
    await settled();
    expect(asked).toHaveLength(3);
  });
});

describe('the agent’s live messages', () => {
  it('shows listening from on to off, and takes nothing it doesn’t know', () => {
    A.agent.dispatch({ type: 'me', id: 'dev_me' });
    A.agent.dispatch({ type: 'info', info: ON });
    expect(A.agentMessage({ type: 'agent-listen', job: 'agj_000000000001', state: 'on' }).handled).toBe(true);
    expect(A.agent.get().listening).toBe('agj_000000000001');
    A.agentMessage({ type: 'agent-listen', job: 'agj_000000000001', state: 'what' });
    expect(A.agent.get().listening).toBe('agj_000000000001');
    A.agentMessage({ type: 'agent-listen', job: 'agj_000000000001', state: 'off' });
    expect(A.agent.get().listening).toBeNull();
    // the host sends no `agent-look`: it isn't the agent's to take
    expect(A.agentMessage({ type: 'agent-look' }).handled).toBe(false);
    A.agent.dispatch({ type: 'removed' });
  });
});

describe('a sign-in under way', () => {
  it('is shown again from the host after a reload, or on a device that didn’t see it start', () => {
    A.agent.dispatch({ type: 'info', info: ON });
    const running = {
      harness: 'claude' as const,
      kind: 'login' as const,
      state: 'running' as const,
      url: 'https://claude.example/oauth',
      ask: 'code' as const,
    };
    const settings = { enabled: true, harness: 'claude' as const, model: '', effort: '', harnesses: [] };
    A.agent.dispatch({ type: 'settings', settings: { ...settings, relays: [running] } });
    expect(A.agent.get().harness.claude).toEqual(running);
    // what this page saw itself, still running, stays as it is
    const later = { ...running, line: 'Waiting for the code' };
    A.agent.dispatch({ type: 'harness', event: later });
    A.agent.dispatch({ type: 'settings', settings: { ...settings, relays: [running] } });
    expect(A.agent.get().harness.claude).toEqual(later);
    // none under way: nothing is added
    A.agent.dispatch({ type: 'settings', settings: { ...settings, relays: [] } });
    expect(A.agent.get().harness.codex).toBeUndefined();
  });
});
