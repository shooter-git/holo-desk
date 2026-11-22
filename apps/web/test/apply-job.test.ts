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

const titled = (p: Project, title: string): Project => applyOps(p, [{ op: 'setProject', patch: { title } }]);

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
   * The host, as far as these use it: the agent on for this device; what its job saved of the song
   * (`song`, as revision `base`), batch by batch, as the away route answers it, with the song as it is
   * then; the song as it is; saves (refused on any revision but the latest, with the song as it is);
   * and the run's first revision in the song's history. `agent` saves another batch of the job's,
   * `other` someone else's song; `onAway` runs once the away route has answered.
   */
  function host(song: Project, base: number, batches: { batch: string; ops: Op[] }[], label = 'Lift') {
    const run = [...batches];
    let latest: Project = { ...run.reduce((p, b) => applyOps(p, b.ops), song), revision: base + run.length };
    const saves: { doc: Project; baseRevision: number }[] = [];
    const h = {
      saves,
      head: () => base + run.length,
      latest: () => latest,
      agent(b: { batch: string; ops: Op[] }) {
        run.push(b);
        latest = { ...applyOps(latest, b.ops), revision: latest.revision + 1 };
      },
      other(p: Project) {
        latest = { ...p, revision: latest.revision + 1 };
      },
      onAway: null as (() => void) | null,
      running: true,
    };
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      const path = String(url);
      if (path === '/api/agent') return json(200, { enabled: true, allowed: true, pairing: false, runner: {} });
      if (path === '/api/agent/devices') return json(200, { devices: [{ id: 'dev_me', current: true }], requests: [] });
      if (path.startsWith('/api/agent/away/')) {
        const from = Number(new URL(path, 'http://h').searchParams.get('from'));
        const after = from <= base ? 0 : from - base;
        const left = run.slice(after);
        const answer = json(200, {
          away:
            !left.length || latest.revision !== h.head()
              ? null
              : {
                  job: JOB,
                  label,
                  running: h.running,
                  base: after === 0 ? base : from,
                  head: h.head(),
                  batches: left,
                  song: latest,
                },
        });
        const then = h.onAway;
        h.onAway = null;
        then?.();
        return answer;
      }
      if (path === `/api/projects/${song.id}/history/${base}`) return json(200, { ...song, revision: base });
      if (path.startsWith(`/api/projects/${song.id}/history/`)) return json(404, { error: 'Not kept' });
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
    return h;
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
    expect([s.serverRevision, s.saveState, s.agentJobs[JOB]]).toEqual([h.head(), 'saved', true]);
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
    expect([s.project?.title, s.project?.key, s.serverRevision]).toEqual(['My title', 'D minor', h.head() + 1]);
    expect(h.saves.map((x) => x.baseRevision)).toEqual([10, h.head()]);
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

  it('a batch the agent saves while a refused save picks up the run doesn’t end in which-version-to-keep', async () => {
    const song = { ...newProject('Racing'), revision: 100 };
    S.store.set({ project: song, serverRevision: 100, saveState: 'saved', undo: [], redo: [], agentJobs: {} });
    const h = host(song, 100, [{ batch: 'r1', ops: key('B minor') }], 'Race');
    A.apply(title('Mine'), 'Title');
    // the agent saves its next batch just after the host has said what there is to pick up
    h.onAway = () => h.agent({ batch: 'r2', ops: [{ op: 'setProject', patch: { tempo: [{ tick: 0, bpm: 99 }] } }] });
    await A.saveNow();
    await settled(() => S.store.get().saveState !== 'saving' && S.store.get().serverRevision === h.latest().revision);
    const s = S.store.get();
    expect(s.saveState).toBe('saved');
    expect([s.project?.title, s.project?.key, s.project?.tempo[0]?.bpm]).toEqual(['Mine', 'B minor', 99]);
    expect(h.latest()).toMatchObject({ title: 'Mine', key: 'B minor' });
    expect(s.undo.map((x) => x.label)).toEqual(['Title', 'Agent: Race']);
  });

  it('a save that got to the host unanswered is the song, then the agent’s run on it is picked up', async () => {
    // the page saved "Mine" as it went (revision 201), but never heard back; the agent saved on top of it
    const mine = { ...titled(newProject('Lost answer'), 'Mine'), revision: 201 };
    S.store.set({ project: mine, serverRevision: 200, saveState: 'offline', undo: [], redo: [], agentJobs: {} });
    const h = host(mine, 201, [{ batch: 'l1', ops: key('C minor') }], 'Darker');
    await A.saveNow();
    await settled(() => S.store.get().serverRevision === h.head());
    const s = S.store.get();
    expect([s.saveState, s.project?.title, s.project?.key]).toEqual(['saved', 'Mine', 'C minor']);
    expect(s.undo.at(-1)).toMatchObject({ label: 'Agent: Darker', job: JOB });
    expect(s.undo.at(-1)?.project).toBe(mine);
    // and with nobody else's change on top, the host having this very song is no conflict
    const same = { ...titled(newProject('Lost answer too'), 'Same'), revision: 301 };
    S.store.set({ project: same, serverRevision: 300, saveState: 'dirty', undo: [], redo: [], agentJobs: {} });
    host(same, 301, []);
    expect(await A.saveNow()).toBe(301);
    expect(S.store.get().saveState).toBe('saved');
  });

  it('a gesture that never ends doesn’t hold the pick-up, or this studio’s saves, past a moment', async () => {
    vi.useFakeTimers();
    try {
      const song = { ...newProject('Held'), revision: 400 };
      S.store.set({ project: song, serverRevision: 400, saveState: 'saved', undo: [], redo: [], agentJobs: {} });
      const h = host(song, 400, [{ batch: 'g1', ops: key('A minor') }], 'Held');
      // a remote's fader, whose phone went away mid-move: the agent's queue is held
      A.beginGesture('Volume');
      let picked: boolean | null = null;
      void A.pickUpAgent().then((r) => {
        picked = r;
      });
      await vi.advanceTimersByTimeAsync(5000);
      expect(picked).toBeNull();
      // a change of the user's meanwhile is saved at once: refused (the agent saved since), it waits for the pick-up
      S.store.set({ project: titled(song, 'Mine'), saveState: 'dirty' });
      const saving = A.saveNow();
      await vi.advanceTimersByTimeAsync(10);
      expect(h.saves).toHaveLength(1);
      // let through after 15 s, like the agent's batches
      await vi.advanceTimersByTimeAsync(15_000);
      expect(picked).toBe(true);
      await saving;
      await vi.advanceTimersByTimeAsync(1000);
      const s = S.store.get();
      expect([s.saveState, s.project?.title, s.project?.key]).toEqual(['saved', 'Mine', 'A minor']);
      expect(h.latest()).toMatchObject({ title: 'Mine', key: 'A minor' });
    } finally {
      A.endGesture();
      vi.useRealTimers();
    }
  });
});

describe('a song saved somewhere else, as the live channel says', () => {
  it('opens as it is when it’s still newer after the agent’s changes are picked up', async () => {
    const JOB = 'agj_00000000b0b1';
    const song = { ...newProject('Shared'), revision: 500 };
    S.store.set({ project: song, serverRevision: 500, saveState: 'saved', undo: [], redo: [], agentJobs: {} });
    const agentSong = { ...applyOps(song, [{ op: 'setProject', patch: { key: 'F minor' } }]), revision: 501 };
    // someone else saves just after the agent's batch: the host says so twice, the second during the pick-up
    let latest: Project = agentSong;
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', async (url: string) => {
      const path = String(url);
      if (path === '/api/agent') return json({ enabled: true, allowed: true, pairing: false, runner: {} });
      if (path.startsWith('/api/agent/away/')) {
        const answer =
          latest.revision === 501 && path.endsWith('from=500')
            ? {
                job: JOB,
                label: 'Darker',
                running: true,
                base: 500,
                head: 501,
                batches: [{ batch: 's1', ops: [{ op: 'setProject', patch: { key: 'F minor' } }] }],
                song: agentSong,
              }
            : null;
        latest = { ...titled(agentSong, 'Theirs'), revision: 502 };
        return json({ away: answer });
      }
      if (path === `/api/projects/${song.id}`) return json(latest);
      if (path.startsWith('/api/agent/threads/')) return json({ thread: null, job: null });
      return json({ error: 'No such route' }, 404);
    });
    await Promise.all([A.savedElsewhere(song.id, 501), A.savedElsewhere(song.id, 502)]);
    const s = S.store.get();
    expect([s.serverRevision, s.saveState, s.project?.title, s.project?.key]).toEqual([
      502,
      'saved',
      'Theirs',
      'F minor',
    ]);
  });

  it('with changes here not saved yet: they’re saved at once; one already saved here is let be', async () => {
    const song = { ...newProject('Here'), revision: 600 };
    S.store.set({ project: song, serverRevision: 600, saveState: 'saved', undo: [], redo: [], agentJobs: {} });
    const puts: number[] = [];
    vi.stubGlobal('fetch', async (_url: string, init?: RequestInit) => {
      if (init?.method === 'PUT') puts.push(1);
      return new Response(JSON.stringify(init?.method === 'PUT' ? { revision: 602, modified: '' } : {}), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });
    await A.savedElsewhere(song.id, 600);
    await A.savedElsewhere('prj_another', 900);
    expect(puts).toEqual([]);
    A.apply([{ op: 'setProject', patch: { title: 'Mine' } }], 'Title');
    await A.savedElsewhere(song.id, 601);
    expect(puts).toHaveLength(1);
  });
});

describe('a reload that finds the agent’s changes saved since the history this device kept', () => {
  const JOB = 'agj_00000000c0c1';
  const key = (k: string): Op[] => [{ op: 'setProject', patch: { key: k } }];
  /** The host: a run from `base`, the song at each revision, and the run's first kept in the song's history. */
  function host(at: Map<number, Project>, base: number, head: number, label = 'Lift') {
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    vi.stubGlobal('fetch', async (url: string) => {
      const path = String(url);
      if (path === '/api/agent') return json({ enabled: true, allowed: true, pairing: false, runner: {} });
      if (path.startsWith('/api/agent/away/')) {
        const from = Number(new URL(path, 'http://h').searchParams.get('from'));
        const batches = [];
        for (let r = Math.max(from, base) + 1; r <= head; r++) batches.push({ batch: `v${r}`, ops: key(`K${r}`) });
        return json({
          away: { job: JOB, label, running: false, base: Math.max(from, base), head, batches, song: at.get(head) },
        });
      }
      const kept = /\/history\/(\d+)$/.exec(path);
      if (kept && Number(kept[1]) === base) return json(at.get(base));
      return json({ error: 'Not kept' }, 404);
    });
  }
  /** The song at revisions `from` to `to`, a key change each. */
  function songs(first: Project, from: number, to: number): Map<number, Project> {
    const at = new Map<number, Project>([[from, { ...first, revision: from }]]);
    for (let r = from + 1; r <= to; r++)
      at.set(r, { ...applyOps(at.get(r - 1) as Project, key(`K${r}`)), revision: r });
    return at;
  }

  it('kept in the middle of the run, with the job’s step on top: the run joins it, and nothing else is read', async () => {
    const before = newProject('Before the job');
    const at = songs(titled(before, 'Lifted'), 700, 704);
    host(at, 700, 704);
    // the page picked the run up at 702, kept its history there, and was let go; the run went on to 704
    const step = { project: before, label: 'Agent: Lift', job: JOB, at: 1 };
    const opened = at.get(704) as Project;
    S.store.set({ project: opened, serverRevision: 704, saveState: 'saved', undo: [], redo: [], agentJobs: {} });
    expect(await A.pickUpBehind(opened, { revision: 702, undo: [step], redo: [] })).toBe(true);
    const s = S.store.get();
    expect(s.undo).toEqual([step]);
    expect(s.project).toBe(opened);
    A.undo();
    expect(S.store.get().project).toBe(before);
  });

  it('kept where the run began: a step of its own, its Undo the song the history leads to', async () => {
    const at = songs(newProject('Began'), 800, 802);
    host(at, 800, 802, 'Brighter');
    const earlier = { project: newProject('Earlier'), label: 'Title', at: 1 };
    const opened = at.get(802) as Project;
    S.store.set({ project: opened, serverRevision: 802, saveState: 'saved', undo: [], redo: [], agentJobs: {} });
    expect(await A.pickUpBehind(opened, { revision: 800, undo: [earlier], redo: [] })).toBe(true);
    const s = S.store.get();
    expect(s.undo.map((x) => x.label)).toEqual(['Title', 'Agent: Brighter']);
    expect(s.undo[1]?.project).toEqual(at.get(800));
  });

  it('the agent saved again as it opened: the song is as the host has it now, with the step', async () => {
    const at = songs(newProject('Moving'), 900, 903);
    host(at, 900, 903);
    const opened = at.get(902) as Project;
    S.store.set({ project: opened, serverRevision: 902, saveState: 'saved', undo: [], redo: [], agentJobs: {} });
    expect(await A.pickUpBehind(opened, { revision: 900, undo: [], redo: [] })).toBe(true);
    const s = S.store.get();
    expect([s.serverRevision, s.project?.key, s.undo.length]).toEqual([903, 'K903', 1]);
  });

  it('not the agent’s since, or a history kept before the run: nothing comes back', async () => {
    const at = songs(newProject('Other'), 1000, 1002);
    host(at, 1000, 1002);
    const opened = at.get(1002) as Project;
    S.store.set({ project: opened, serverRevision: 1002, saveState: 'saved', undo: [], redo: [], agentJobs: {} });
    expect(await A.pickUpBehind(opened, { revision: 990, undo: [], redo: [] })).toBe(false);
    expect(S.store.get().undo).toEqual([]);
  });
});
