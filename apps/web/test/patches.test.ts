import { compileTempo, type PatchJob, regionPatches } from '@holo/engine';
import {
  type AudioClip,
  type AudioNote,
  type AudioNotes,
  newAudioTrack,
  newProject,
  newRegion,
  PPQ,
  type Project,
  parseAudioNotes,
  type Region,
} from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  type FromPatchWorker,
  PatchCache,
  PatchRenderer,
  type PatchState,
  type PatchWorker,
  patchesWithin,
  patchSpans,
  planPatches,
  type ToPatchWorker,
} from '../src/audio/patches.ts';

const SR = 48000;

/** A line's notes, canonical, as the song keeps them. */
const line = (n: Partial<AudioNote>[]): AudioNotes =>
  parseAudioNotes({ mode: 'mono', v: 1, n: n.map((x) => ({ d: 0.3, p: 60, ...x })) }) as AudioNotes;

const clip = (notes: AudioNotes): AudioClip => ({
  file: 'aud_take',
  offset: 0,
  gain: 0,
  fadeIn: 0,
  fadeOut: 0,
  stretch: 1,
  notes,
});

/**
 * Two regions of one recording, four seconds each, one after the other at 120 bpm: the first with
 * level edits at 0.5 s and 3 s, the second with a pitch move at 1 s (to `to`) and a level edit at 2.5 s.
 */
function song(to = 62): Project {
  const p = newProject('Patches');
  p.tempo = [{ tick: 0, bpm: 120 }];
  const first: Region = {
    ...newRegion(0, PPQ * 8),
    id: 'rgn_a',
    audio: clip(
      line([
        { t: 0.5, g: -6 },
        { t: 3, g: -6 },
      ]),
    ),
  };
  const second: Region = {
    ...newRegion(PPQ * 8, PPQ * 8),
    id: 'rgn_b',
    audio: clip(
      line([
        { t: 1, to },
        { t: 2.5, g: -3 },
      ]),
    ),
  };
  p.tracks = [{ ...newAudioTrack('Vocal'), id: 'trk_v', regions: [first, second] }];
  return p;
}

const regionOf = (p: Project, id: string) => p.tracks[0]?.regions.find((r) => r.id === id) as Region;
const keysOf = (p: Project, id: string) => regionPatches(regionOf(p, id).audio as AudioClip, SR).map((j) => j.key);

/** Nothing rendered or sent, the recording loaded. */
const fresh = (more: Partial<PatchState> = {}): PatchState => ({
  loaded: () => true,
  rendered: () => false,
  sent: new Set(),
  ...more,
});

const plan = (p: Project, state: PatchState) => planPatches(p, compileTempo(p, SR), SR, state);

describe('which patches the studio renders, and in what order', () => {
  const p = song();
  const [a1, a2] = keysOf(p, 'rgn_a');
  const [b1, b2] = keysOf(p, 'rgn_b');

  it('wants every patch the song plays, rendered from a loaded recording only', () => {
    expect(plan(p, fresh()).render.map((j) => j.key)).toHaveLength(4);
    expect([...plan(p, fresh()).wanted.keys()].sort()).toEqual([a1, a2, b1, b2].sort());
    expect(plan(p, fresh({ loaded: () => false })).render).toEqual([]);
  });

  it('renders those the playhead comes to first, nearest first, then those behind it', () => {
    // at 3.5 s: the second region's are ahead (4.79 s, 6.47 s), the first's behind
    expect(plan(p, fresh({ playhead: 3.5 * SR })).render.map((j) => j.key)).toEqual([b1, b2, a1, a2]);
    // at 5 s, the pitch move (4.79 s to 5.51 s) is under the playhead: still first
    expect(plan(p, fresh({ playhead: 5 * SR })).render.map((j) => j.key)).toEqual([b1, b2, a1, a2]);
    // at 6 s it's behind
    expect(plan(p, fresh({ playhead: 6 * SR })).render.map((j) => j.key)).toEqual([b2, a1, a2, b1]);
    // at the start, in the song's order
    expect(plan(p, fresh({ playhead: 0 })).render.map((j) => j.key)).toEqual([a1, a2, b1, b2]);
  });

  it('renders the region the Audio Editor shows before anything else', () => {
    const focus = regionOf(p, 'rgn_a').audio;
    expect(plan(p, fresh({ playhead: 3.5 * SR, focus })).render.map((j) => j.key)).toEqual([a1, a2, b1, b2]);
    const other = regionOf(p, 'rgn_b').audio;
    expect(plan(p, fresh({ playhead: 0, focus: other })).render.map((j) => j.key)).toEqual([b1, b2, a1, a2]);
  });

  it('hands over what is rendered, and renders nothing twice', () => {
    const rendered = new Set([a1, b1]);
    const sent = new Set([a1]);
    const out = plan(p, fresh({ rendered: (k) => rendered.has(k), sent }));
    expect(out.send).toEqual([b1]);
    expect(out.render.map((j) => j.key)).toEqual([a2, b2]);
    // one the engines have, though no longer kept, isn't rendered again
    const kept = plan(p, fresh({ sent: new Set([a1]) }));
    expect(kept.render.map((j) => j.key)).not.toContain(a1);
  });

  it('lets go of a patch an edit replaces, and an undo finds it again at once', () => {
    const before = p;
    const after = song(63);
    const [moved] = keysOf(after, 'rgn_b');
    expect(moved).not.toBe(b1);
    // the edit: its old patch no longer played, the new one to render first where it's shown
    const all = new Set([a1, a2, b1, b2]);
    const edited = plan(after, {
      loaded: () => true,
      rendered: (k) => all.has(k),
      sent: all,
      focus: regionOf(after, 'rgn_b').audio,
    });
    expect(edited.forget).toEqual([b1]);
    expect(edited.render.map((j) => j.key)).toEqual([moved]);
    expect(edited.send).toEqual([]);
    // undone, a second later (the engines have let it go): the old patch is still kept, handed over again
    const engines = new Set([a1, a2, b2, moved as string]);
    const undone = plan(before, { loaded: () => true, rendered: (k) => all.has(k) || k === moved, sent: engines });
    expect(undone.send).toEqual([b1]);
    expect(undone.render).toEqual([]);
    expect(undone.forget).toEqual([moved]);
  });

  it('wants nothing of a region whose edits are off, or that is muted', () => {
    const off = song();
    const r = regionOf(off, 'rgn_b');
    r.audio = { ...(r.audio as AudioClip), notes: { ...(r.audio?.notes as AudioNotes), off: true } };
    expect([...plan(off, fresh()).wanted.keys()].sort()).toEqual([a1, a2].sort());
    regionOf(off, 'rgn_a').muted = true;
    expect(plan(off, fresh()).wanted.size).toBe(0);
  });
});

describe('rendered patches, kept by the memory they take', () => {
  const frames = (n: number) => [new Float32Array(n)];

  it('lets the least lately used go past the budget', () => {
    const cache = new PatchCache(4 * 1000);
    cache.set('a', frames(400));
    cache.set('b', frames(400));
    expect(cache.bytes).toBe(3200);
    // a used: b is now the least lately
    expect(cache.get('a')).toBeDefined();
    cache.set('c', frames(400));
    expect([cache.has('a'), cache.has('b'), cache.has('c')]).toEqual([true, false, true]);
    expect(cache.bytes).toBe(3200);
    // the newest stays, whatever it takes
    cache.set('big', frames(2000));
    expect([cache.has('a'), cache.has('c'), cache.has('big')]).toEqual([false, false, true]);
    expect(cache.bytes).toBe(8000);
  });

  it('counts a patch set again once', () => {
    const cache = new PatchCache(1e6);
    cache.set('a', frames(100));
    cache.set('a', frames(200));
    expect(cache.size).toBe(1);
    expect(cache.bytes).toBe(800);
  });
});

/** Workers that answer when told to. */
function pool() {
  const workers: (PatchWorker & { got: ToPatchWorker[] })[] = [];
  const make = (): PatchWorker => {
    const w = {
      got: [] as ToPatchWorker[],
      onmessage: null as ((e: MessageEvent<FromPatchWorker>) => void) | null,
      onerror: null as ((e: ErrorEvent) => void) | null,
      postMessage(msg: ToPatchWorker) {
        w.got.push(msg);
      },
      terminate() {},
    };
    workers.push(w);
    return w;
  };
  /** The job a worker was last given, answered. */
  const answer = (i: number, error?: string) => {
    const w = workers[i];
    const job = [...(w?.got ?? [])].reverse().find((m) => m.type === 'render');
    if (!w || !job || job.type !== 'render') throw new Error('no job');
    const data: FromPatchWorker = error
      ? { id: job.id, key: job.key, error }
      : { id: job.id, key: job.key, channels: [new Float32Array(10)], ms: 5 };
    w.onmessage?.({ data } as MessageEvent<FromPatchWorker>);
    return job.key;
  };
  const rendering = (i: number) => {
    const job = [...(workers[i]?.got ?? [])].reverse().find((m) => m.type === 'render');
    return job?.type === 'render' ? job.key : null;
  };
  return { workers, make, answer, rendering };
}

describe('the patch renderer', () => {
  const p = song();
  const jobs = plan(p, fresh()).render;
  const [j1, j2, j3, j4] = jobs as [PatchJob, PatchJob, PatchJob, PatchJob];

  it('renders the most wanted first, on every worker at once, and keeps what comes back', () => {
    const w = pool();
    const r = new PatchRenderer({ workers: 2, budget: 1e6, shared: true, make: w.make });
    const done: string[] = [];
    r.onRendered((k) => done.push(k));
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    expect(w.workers).toHaveLength(2);
    expect(w.workers.every((x) => x.got[0]?.type === 'recording')).toBe(true);
    r.want(jobs);
    expect([w.rendering(0), w.rendering(1)]).toEqual([j1.key, j2.key]);
    expect(r.pending).toBe(4);
    w.answer(1);
    expect(done).toEqual([j2.key]);
    expect(r.has(j2.key)).toBe(true);
    // the free worker takes the next
    expect(w.rendering(1)).toBe(j3.key);
    expect(r.pending).toBe(3);
  });

  it('drops queued patches no longer wanted, and keeps one rendering when it comes', () => {
    const w = pool();
    const r = new PatchRenderer({ workers: 1, budget: 1e6, shared: true, make: w.make });
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    r.want(jobs);
    expect(w.rendering(0)).toBe(j1.key);
    // an edit: only the last is wanted now
    r.want([j4]);
    expect(r.pending).toBe(1);
    w.answer(0);
    expect(r.has(j1.key)).toBe(true);
    expect(w.rendering(0)).toBe(j4.key);
    w.answer(0);
    expect(r.pending).toBe(0);
    // (j2 and j3 never rendered)
    expect(w.workers[0]?.got.filter((m) => m.type === 'render').map((m) => m.type === 'render' && m.key)).toEqual([
      j1.key,
      j4.key,
    ]);
  });

  it('renders nothing from a recording it doesn’t hold, and one worker without shared memory', () => {
    const w = pool();
    const r = new PatchRenderer({ workers: 3, budget: 1e6, shared: false, make: w.make });
    r.want(jobs);
    expect(r.pending).toBe(4);
    expect(w.workers).toHaveLength(0);
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    expect(w.workers).toHaveLength(1);
    r.want(jobs);
    expect(w.rendering(0)).toBe(j1.key);
    r.release('aud_take');
    expect(w.workers[0]?.got.at(-1)).toEqual({ type: 'forget', key: 'aud_take' });
  });

  it('tells of a patch that couldn’t be rendered, and doesn’t try it again', () => {
    const w = pool();
    const r = new PatchRenderer({ workers: 1, budget: 1e6, shared: true, make: w.make });
    const errors: string[] = [];
    r.onError((m) => errors.push(m));
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    r.want([j1]);
    w.answer(0, 'broken');
    expect(errors).toHaveLength(1);
    expect(r.pending).toBe(0);
    r.want([j1]);
    expect(w.workers[0]?.got.filter((m) => m.type === 'render')).toHaveLength(1);
  });
});

describe('a dragged note’s patches', () => {
  // the pitch move of the second region dragged on, a semitone at a time: each state its own patch
  const states = [63, 64, 65, 66].map((to) => regionPatches(regionOf(song(to), 'rgn_b').audio as AudioClip, SR)[0]);
  const [s63, s64, s65, s66] = states as [PatchJob, PatchJob, PatchJob, PatchJob];
  const p = song();
  const jobs = plan(p, fresh()).render;
  const renders = (w: ReturnType<typeof pool>, i = 0) =>
    w.workers[i]?.got.flatMap((m) => (m.type === 'render' ? [m.key] : [])) ?? [];

  it('come before anything the song wants', () => {
    const w = pool();
    const r = new PatchRenderer({ workers: 1, budget: 1e6, shared: true, make: w.make });
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    r.want(jobs);
    expect(w.rendering(0)).toBe(jobs[0]?.key);
    r.preview('rgn_b', [s63]);
    // (the worker is busy: the drag's patch is next, ahead of the song's)
    w.answer(0);
    expect(w.rendering(0)).toBe(s63.key);
    w.answer(0);
    expect(w.rendering(0)).toBe(jobs[1]?.key);
    expect(r.stats.previews).toBe(1);
  });

  it('render one at a time for a region, only the latest wanted after it', () => {
    const w = pool();
    const r = new PatchRenderer({ workers: 2, budget: 1e6, shared: true, make: w.make });
    const done: string[] = [];
    r.onRendered((k) => done.push(k));
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    r.preview('rgn_b', [s63]);
    expect(w.rendering(0)).toBe(s63.key);
    // the drag goes on while it renders: the second worker stays free, and only the latest waits
    r.preview('rgn_b', [s64]);
    r.preview('rgn_b', [s65]);
    expect(w.rendering(1)).toBeNull();
    w.answer(0);
    expect(done).toEqual([s63.key]);
    expect(w.rendering(0)).toBe(s65.key);
    w.answer(0);
    expect(done).toEqual([s63.key, s65.key]);
    // (the state passed over never rendered)
    expect([...renders(w, 0), ...renders(w, 1)]).toEqual([s63.key, s65.key]);
    // and one already rendered is wanted at once, with nothing to render
    r.preview('rgn_b', [s63]);
    expect(w.rendering(1)).toBeNull();
    expect(renders(w, 0)).toHaveLength(2);
  });

  it('render side by side for two regions, and not twice when the song wants one too', () => {
    const w = pool();
    const r = new PatchRenderer({ workers: 3, budget: 1e6, shared: true, make: w.make });
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    r.preview('rgn_a', [s63]);
    r.preview('rgn_b', [s64]);
    expect([w.rendering(0), w.rendering(1)]).toEqual([s63.key, s64.key]);
    // the drag let go: the song wants where it landed, already rendering
    r.want([s64, s66]);
    expect(w.rendering(2)).toBe(s66.key);
    w.answer(1);
    w.answer(2);
    expect(r.pending).toBe(0);
    expect([...renders(w, 0), ...renders(w, 1), ...renders(w, 2)].sort()).toEqual([s63.key, s64.key, s66.key].sort());
  });

  it('are dropped when the drag is cancelled, one rendering kept', () => {
    const w = pool();
    const r = new PatchRenderer({ workers: 1, budget: 1e6, shared: true, make: w.make });
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    r.preview('rgn_b', [s63]);
    r.preview('rgn_b', [s64]);
    r.preview('rgn_b', []);
    w.answer(0);
    expect(r.has(s63.key)).toBe(true);
    expect(w.rendering(0)).toBe(s63.key);
    expect(renders(w)).toEqual([s63.key]);
  });
});

describe('the patches some bars play', () => {
  const p = song();
  const segments = compileTempo(p, SR);
  // at 120 bpm a bar is 2 s: the first region plays bars 1–2, the second bars 3–4
  const bar = (n: number) => (n - 1) * 2 * SR;

  it('places each patch where the song plays it', () => {
    const spans = patchSpans(p, segments, SR);
    expect(spans.size).toBe(4);
    for (const key of keysOf(p, 'rgn_b')) {
      const [from, to] = (spans.get(key)?.spans ?? [])[0] ?? [Number.NaN, Number.NaN];
      // the second region starts at 4 s: its patches are past it
      expect(from).toBeGreaterThanOrEqual(4 * SR);
      expect(to).toBeLessThanOrEqual(8 * SR);
    }
  });

  it('finds those within some bars, and none where nothing is edited', () => {
    const second = keysOf(p, 'rgn_b');
    expect(
      patchesWithin(p, segments, SR, bar(3), bar(5))
        .map((j) => j.key)
        .sort(),
    ).toEqual([...second].sort());
    expect(patchesWithin(p, segments, SR, 0, bar(5))).toHaveLength(4);
    // the second region's pitch move is at 1 s into it (5 s): bar 3's first half has none
    const early = patchesWithin(p, segments, SR, bar(3), bar(3) + 0.6 * SR);
    expect(early.every((j) => !second.includes(j.key) || j.spec.a < 0.6 * SR + 0.2 * SR)).toBe(true);
    expect(patchesWithin(p, segments, SR, bar(5), bar(7))).toEqual([]);
  });
});

describe('patches about to be played (a version an A/B plays)', () => {
  const p = song();
  const jobs = plan(p, fresh()).render;
  // a version with the second region's pitch moved elsewhere: patches the song as it is doesn't play
  const other = regionPatches(regionOf(song(65), 'rgn_b').audio as AudioClip, SR);

  it('render after a drag’s and before the song’s, and stay when the song’s change', () => {
    const w = pool();
    const r = new PatchRenderer({ workers: 1, budget: 1e6, shared: true, make: w.make });
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    r.want(jobs);
    expect(w.rendering(0)).toBe(jobs[0]?.key);
    r.ready('passes', other);
    // the song's patches change: the version's are still wanted, and come first
    r.want(jobs.slice(1));
    w.answer(0);
    expect(w.rendering(0)).toBe(other[0]?.key);
    expect(r.over(other[0]?.key as string)).toBe(false);
    w.answer(0);
    expect(r.over(other[0]?.key as string)).toBe(true);
  });

  it('are dropped when no longer wanted, and nothing is rendered twice', () => {
    const w = pool();
    const r = new PatchRenderer({ workers: 1, budget: 1e6, shared: true, make: w.make });
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    r.ready('passes', other);
    expect(other.length).toBeGreaterThan(1);
    expect(w.rendering(0)).toBe(other[0]?.key);
    w.answer(0);
    // asked again: the one rendered isn't wanted again; then no longer wanted at all
    r.ready('passes', other);
    r.ready('passes', null);
    r.want(jobs);
    // (one rendering when they were let go finishes, and is kept)
    w.answer(0);
    expect(w.rendering(0)).toBe(jobs[0]?.key);
    const renders = w.workers[0]?.got.flatMap((m) => (m.type === 'render' ? [m.key] : [])) ?? [];
    expect(renders.filter((k) => k === other[0]?.key)).toHaveLength(1);
    expect(renders.filter((k) => other.slice(2).some((j) => j.key === k))).toEqual([]);
  });
});

describe('patches kept on the device, as the renderer uses them', () => {
  const p = song();
  const jobs = plan(p, fresh()).render;
  const [j1, j2] = jobs as [PatchJob, PatchJob];

  /** A device that has `kept`, ready when `open` is called. */
  function device(kept: Record<string, Float32Array[]>) {
    let open: () => void = () => undefined;
    const put: string[] = [];
    const store = {
      loaded: false,
      ready: new Promise<void>((resolve) => {
        open = () => {
          store.loaded = true;
          resolve();
        };
      }),
      has: (k: string) => k in kept,
      get: async (k: string) => kept[k] ?? null,
      put: (k: string) => {
        put.push(k);
      },
    };
    return { store, open: () => open(), put };
  }

  it('reads back what the device has instead of rendering it, and keeps what it renders', async () => {
    const w = pool();
    const d = device({ [j1.key]: [new Float32Array(10)] });
    const r = new PatchRenderer({ workers: 1, budget: 1e6, shared: false, make: w.make, store: d.store });
    const done: string[] = [];
    r.onRendered((k) => done.push(k));
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    r.want([j1, j2]);
    // nothing before the device's store has opened
    expect(w.rendering(0)).toBeNull();
    d.open();
    await d.store.ready;
    await Promise.resolve();
    // j1 from the device (counted as rendered, no worker), j2 rendered
    expect(w.rendering(0)).toBe(j2.key);
    await new Promise((r) => setTimeout(r, 0));
    expect(done).toEqual([j1.key]);
    expect(r.has(j1.key)).toBe(true);
    expect(r.pending).toBe(1);
    w.answer(0);
    expect(d.put).toEqual([j2.key]);
    expect(r.stats).toEqual({ rendered: 1, fromDevice: 1, previews: 0 });
    expect(w.workers[0]?.got.filter((m) => m.type === 'render')).toHaveLength(1);
  });

  it('keeps a drag’s patch on the device only once the song plays it, and nothing twice', async () => {
    const w = pool();
    const d = device({ [j1.key]: [new Float32Array(10)] });
    const r = new PatchRenderer({ workers: 1, budget: 1e6, shared: false, make: w.make, store: d.store });
    d.open();
    await d.store.ready;
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    // two states of a drag, rendered: neither kept
    r.preview('rgn_b', [j2]);
    w.answer(0);
    expect(r.has(j2.key)).toBe(true);
    expect(d.put).toEqual([]);
    // let go on the second: the song plays it (and j1, read from the device: not written back)
    r.want([j1]);
    await new Promise((r) => setTimeout(r, 0));
    r.keep([j1.key, j2.key]);
    r.keep([j1.key, j2.key]);
    expect(d.put).toEqual([j2.key]);
  });

  it('renders one the device has lost after all', async () => {
    const w = pool();
    const d = device({});
    d.store.has = () => true;
    const r = new PatchRenderer({ workers: 1, budget: 1e6, shared: false, make: w.make, store: d.store });
    r.hold('aud_take', [new Float32Array(SR * 8)]);
    d.open();
    await d.store.ready;
    r.want([j1]);
    d.store.has = () => false;
    await new Promise((r) => setTimeout(r, 0));
    expect(w.rendering(0)).toBe(j1.key);
  });
});
