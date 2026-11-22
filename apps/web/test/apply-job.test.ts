import { applyOps, newProject, type Op, type Project } from '@holo/session';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ActionsModule from '../src/app/actions.ts';
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

let S: typeof StoreModule;
let A: typeof ActionsModule;

beforeAll(async () => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('window', globalThis);
  // what the studio's layout and audio modules look at as they load
  vi.stubGlobal('innerWidth', 1440);
  vi.stubGlobal('innerHeight', 900);
  vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
  vi.stubGlobal('addEventListener', () => {});
  vi.stubGlobal('removeEventListener', () => {});
  vi.stubGlobal('document', {
    addEventListener() {},
    removeEventListener() {},
    documentElement: { style: { setProperty() {} }, classList: { toggle() {}, add() {}, remove() {} } },
    visibilityState: 'visible',
    hidden: false,
  });
  S = await import('../src/app/store.ts');
  A = await import('../src/app/actions.ts');
});

describe('a job’s batches in the studio', () => {
  it('each lands in the song, all in one undo step', async () => {
    const song = newProject('Batches');
    S.store.set({ project: song, undo: [], redo: [] });
    const track = song.tracks[0]?.id as string;
    expect(await A.applyJob([{ op: 'updateTrack', track, patch: { name: 'Lead' } }], 'agj_1', 'b1', 'Lead')).toEqual({
      ok: true,
    });
    // the second batch merges into the job's step: it must land too
    expect(await A.applyJob([{ op: 'setProject', patch: { title: 'Renamed' } }], 'agj_1', 'b2', 'Lead')).toEqual({
      ok: true,
    });
    const s = S.store.get();
    expect(s.project?.title).toBe('Renamed');
    expect(s.project?.tracks.find((t) => t.id === track)?.name).toBe('Lead');
    expect(s.undo).toHaveLength(1);
    expect(s.undo[0]).toMatchObject({ label: 'Agent: Lead', job: 'agj_1' });
    expect(s.undo[0]?.project).toBe(song);
  });
});

describe('the history menu in the studio', () => {
  it('takes the song straight to the step picked, back or forward', () => {
    const song = newProject('Jumps');
    S.store.set({ project: song, undo: [], redo: [], toasts: [] });
    for (const title of ['A', 'B', 'C', 'D']) A.apply([{ op: 'setProject', patch: { title } }], `Title ${title}`);
    // back to before the second change: three Undos in one
    const second = S.store.get().undo[1];
    if (!second) throw new Error('no step');
    A.travelTo(second);
    let s = S.store.get();
    expect(s.project?.title).toBe('A');
    expect(s.undo.map((x) => x.label)).toEqual(['Title A']);
    expect(s.redo.map((x) => x.label)).toEqual(['Title D', 'Title C', 'Title B']);
    expect(s.toasts.at(-1)?.text).toBe('Undo 3 steps');
    // forward through the third: two Redos
    const third = s.redo[1];
    if (!third) throw new Error('no step');
    A.travelTo(third);
    s = S.store.get();
    expect(s.project?.title).toBe('C');
    expect(s.redo.map((x) => x.label)).toEqual(['Title D']);
    expect(s.toasts.at(-1)?.text).toBe('Redo 2 steps');
    // one step reads as Undo always has
    A.undo();
    expect(S.store.get().toasts.at(-1)?.text).toBe('Undo Title C');
  });
});

describe('the agent’s changes saved on the host while the studio was away', () => {
  const JOB = 'agj_00000000a0a1';
  const title = (t: string): Op[] => [{ op: 'setProject', patch: { title: t } }];
  const key = (k: string): Op[] => [{ op: 'setProject', patch: { key: k } }];

  /**
   * The host, as far as these use it: the agent on for this device, what its job saved of the song from
   * `base` to `head`, the song as it is, and saves (refused on any revision but the latest).
   */
  function host(song: Project, base: number, batches: { batch: string; ops: Op[] }[], label = 'Lift') {
    const head = base + batches.length;
    let latest: Project = { ...batches.reduce((p, b) => applyOps(p, b.ops), song), revision: head };
    const saves: { doc: Project; baseRevision: number }[] = [];
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === '/api/agent') return json(200, { enabled: true, allowed: true, pairing: false, runner: {} });
      if (path === '/api/agent/devices') return json(200, { devices: [{ id: 'dev_me', current: true }], requests: [] });
      if (path.startsWith('/api/agent/away/')) {
        const from = Number(new URL(path, 'http://h').searchParams.get('from'));
        const after = from - base;
        const left = batches.slice(after);
        return json(200, {
          away:
            after < 0 || !left.length || latest.revision !== head
              ? null
              : { job: JOB, label, running: true, head, batches: left },
        });
      }
      if (path === `/api/projects/${song.id}` && init?.method === 'PUT') {
        const body = JSON.parse(String(init.body)) as { doc: Project; baseRevision: number };
        saves.push(body);
        if (body.baseRevision !== latest.revision) return json(409, { error: 'Changed elsewhere', current: latest });
        latest = { ...body.doc, revision: latest.revision + 1 };
        return json(200, { revision: latest.revision, modified: '' });
      }
      if (path === `/api/projects/${song.id}`) return json(200, latest);
      return json(404, { error: 'No such route' });
    });
    return { head, saves, latest: () => latest };
  }

  const settled = async (check: () => boolean) => {
    for (let i = 0; i < 200 && !check(); i++) await new Promise((r) => setTimeout(r, 5));
    expect(check()).toBe(true);
  };

  it('are picked up as the job’s one step, its later batches join it, and Undo takes them all back', async () => {
    const song = { ...newProject('Away'), revision: 4 };
    const earlier = { project: newProject('Earlier'), label: 'Title', at: 1 };
    S.store.set({ project: song, serverRevision: 4, saveState: 'saved', undo: [earlier], redo: [], agentJobs: {} });
    const h = host(song, 4, [
      { batch: 'b1', ops: title('Lifted') },
      { batch: 'b2', ops: key('E minor') },
    ]);
    expect(await A.pickUpAgent()).toBe(true);
    let s = S.store.get();
    expect(s.project).toEqual(h.latest());
    expect([s.serverRevision, s.saveState, s.agentJobs[JOB]]).toEqual([h.head, 'saved', true]);
    expect(s.undo.map((x) => [x.label, x.job ?? null])).toEqual([
      ['Title', null],
      ['Agent: Lift', JOB],
    ]);
    expect(s.undo[1]?.project).toBe(song);
    // back in front of the user, the job's next batch comes live and joins the step
    const tempo: Op[] = [{ op: 'setProject', patch: { tempo: [{ tick: 0, bpm: 101 }] } }];
    expect(await A.applyJob(tempo, JOB, 'b3', 'Lift')).toEqual({ ok: true });
    // one it saved on the host, sent again, is answered and not applied twice
    expect(await A.applyJob(title('Twice'), JOB, 'b1', 'Lift')).toEqual({ ok: true });
    s = S.store.get();
    expect([s.project?.title, s.project?.tempo[0]?.bpm]).toEqual(['Lifted', 101]);
    expect(s.undo).toHaveLength(2);
    // nothing more to pick up
    expect(await A.pickUpAgent()).toBe(false);
    A.undo();
    expect(S.store.get().project).toBe(song);
  });

  it('go onto changes this studio hadn’t saved, which are then saved on top of them', async () => {
    const song = { ...newProject('Mine too'), revision: 10 };
    S.store.set({ project: song, serverRevision: 10, saveState: 'saved', undo: [], redo: [], agentJobs: {} });
    const h = host(song, 10, [{ batch: 'c1', ops: key('D minor') }], 'Darker');
    // the user changed the title just before the page went, and it wasn't saved
    A.apply(title('My title'), 'Title');
    const mine = S.store.get().project;
    // its save is refused (the agent saved since): the agent's changes are picked up, and it goes again
    expect(await A.saveNow()).toBeNull();
    await settled(() => S.store.get().saveState === 'saved');
    const s = S.store.get();
    expect([s.project?.title, s.project?.key, s.serverRevision]).toEqual(['My title', 'D minor', h.head + 1]);
    expect(h.saves.map((x) => x.baseRevision)).toEqual([10, h.head]);
    expect(h.latest()).toMatchObject({ title: 'My title', key: 'D minor' });
    expect(s.undo.map((x) => x.label)).toEqual(['Title', 'Agent: Darker']);
    expect(s.undo[1]?.project).toBe(mine);
  });

  it('saved by someone else, aren’t the agent’s: the save asks which version to keep, as ever', async () => {
    const song = { ...newProject('Shared'), revision: 20 };
    S.store.set({ project: song, serverRevision: 20, saveState: 'saved', undo: [], redo: [], agentJobs: {} });
    vi.stubGlobal(
      'fetch',
      async (url: string, init?: RequestInit) =>
        new Response(
          JSON.stringify(
            String(url) === '/api/agent'
              ? { enabled: true, allowed: true, pairing: false, runner: {} }
              : String(url).startsWith('/api/agent/away/')
                ? { away: null }
                : init?.method === 'PUT'
                  ? { error: 'Changed elsewhere' }
                  : {},
          ),
          { status: init?.method === 'PUT' ? 409 : 200, headers: { 'content-type': 'application/json' } },
        ),
    );
    A.apply(title('Mine'), 'Title');
    expect(await A.saveNow()).toBeNull();
    expect(S.store.get().saveState).toBe('conflict');
  });
});
