import { applyOp, newProject, newRegion, newTrack, PPQ, type Project, type Region, type Track } from '@holo/session';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type * as ActionsModule from '../src/app/actions.ts';
import type * as StoreModule from '../src/app/store.ts';
import type * as EngineModule from '../src/audio/engine.ts';

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
let E: typeof EngineModule;

beforeAll(async () => {
  vi.stubGlobal('localStorage', new Storage());
  vi.stubGlobal('window', globalThis);
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
  E = await import('../src/audio/engine.ts');
});

const BAR = PPQ * 4;

function song(): Project {
  const p = newProject('Split');
  p.tempo = [
    { tick: 0, bpm: 90 },
    { tick: 2 * BAR, bpm: 132 },
  ];
  p.files = [{ id: 'aud_take', name: 'Take.wav', seconds: 60, rate: 48000, channels: 1 }];
  const keys: Track = { ...newTrack('Keys', { type: 'synth', preset: 'Soft Keys' }), id: 'trk_keys' };
  const midi: Region = {
    ...newRegion(BAR, 4 * BAR, 'Riff'),
    id: 'rgn_midi',
    // score marks, a hairpin across where it's split: each half keeps those that start in it
    marks: [
      { t: 0, k: 'dyn', v: 'mf' },
      { t: BAR, k: 'cresc', e: 2 * BAR },
      { t: 2 * BAR, k: 'text', v: 'dolce' },
    ],
    notes: [
      { t: 0, d: 3 * PPQ, p: 60, v: 90 },
      { t: BAR + PPQ, d: PPQ, p: 64, v: 70, n: { a: ['stacc'] } },
      { t: 3 * BAR, d: PPQ, p: 67, v: 100 },
    ],
    cc: {
      '64': [
        [0, 127],
        [2 * BAR, 0],
      ],
      pb: [
        [PPQ, 0],
        [2 * BAR + PPQ, 2000],
      ],
    },
  };
  keys.regions = [midi];
  const vox: Track = { ...newTrack('Vox', { type: 'none' }), id: 'trk_vox', kind: 'audio' };
  vox.regions = [
    {
      ...newRegion(BAR, 3 * BAR, 'Take'),
      id: 'rgn_audio',
      audio: {
        file: 'aud_take',
        offset: 0.8,
        gain: -2,
        fadeIn: 0.1,
        fadeOut: 0.3,
        stretch: 1.2,
        // its recording's notes, one edited: each half keeps those it plays
        notes: {
          mode: 'mono',
          v: 1,
          n: Array.from({ length: 30 }, (_, i) => ({
            t: 0.4 * i,
            d: 0.3,
            p: 60 + (i % 5),
            ...(i === 9 ? { to: 62 } : {}),
          })),
        },
      },
    },
  ];
  p.tracks = [keys, vox];
  return p;
}

describe('splitting a region', () => {
  for (const [what, track, region, at] of [
    ['a MIDI region', 'trk_keys', 'rgn_midi', 2 * BAR + PPQ],
    ['an audio region across a tempo change', 'trk_vox', 'rgn_audio', 3 * BAR - 100],
  ] as const) {
    it(`gives the same song as the studio's Split, for ${what}`, () => {
      const before = song();
      S.store.set({ project: before, undo: [], redo: [], selectedRegions: [region], selectedTrack: track });
      E.engine.locate(at);
      A.splitAtPlayhead();
      const studio = S.store.get().project as Project;
      const right = studio.tracks
        .find((t) => t.id === track)
        ?.regions.find((r) => r.id !== region && r.start === at) as Region;
      expect(right).toBeDefined();
      const op = applyOp(before, { op: 'splitRegion', track, region, at, id: right.id });
      expect(op.tracks).toEqual(studio.tracks);
    });
  }
});

describe('bars arranged by the agent, in the studio', () => {
  it('are worked out on the song as it is then, and undone in one step', async () => {
    const before = song();
    S.store.set({ project: before, undo: [], redo: [], selectedRegions: [] });
    // the user moves the riff while the agent works from its copy of the song
    A.apply([{ op: 'moveRegion', from: 'trk_keys', to: 'trk_keys', region: 'rgn_midi', start: 2 * BAR }], 'Move');
    const edited = S.store.get().project as Project;
    const ok = await A.applyJob(
      [{ op: 'arrange', edit: 'insert', from: BAR, to: 3 * BAR }],
      'agj_arrange',
      'b1',
      'Two bars at 2',
    );
    expect(ok).toEqual({ ok: true });
    const now = S.store.get();
    // the riff the user moved to bar 3 moved on to bar 5: the user's move is in
    expect(now.project?.tracks[0]?.regions[0]?.start).toBe(4 * BAR);
    expect(now.project?.tempo).toEqual([
      { tick: 0, bpm: 90 },
      { tick: 4 * BAR, bpm: 132 },
    ]);
    expect(now.undo.at(-1)).toMatchObject({ label: 'Agent: Two bars at 2', job: 'agj_arrange' });
    expect(now.undo.at(-1)?.project).toBe(edited);
  });
});
