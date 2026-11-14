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
} from '@holo/session';
import { describe, expect, it, vi } from 'vitest';
import { clipKey, compileClips, compileTempo } from '../src/compile.ts';
import { assembleClip, renderNotePatch } from '../src/notes/patch.ts';
import { isEdited, type PatchSpec, regionPatches, songPatches } from '../src/notes/plan.ts';
import { renderSession } from '../src/render.ts';
import { encodeWav } from '../src/wav.ts';

// How patches are planned, keyed, split and played, whatever they sound like: here each is rendered
// as the recording's own frames, so a song with edits must play to the bit what it would without them.
// (What a patch sounds like is notes-psola.test.ts's.)
vi.mock('../src/notes/patch.ts', async (original) => ({
  ...(await original<typeof import('../src/notes/patch.ts')>()),
  renderNotePatch: (base: readonly Float32Array[], _sr: number, spec: PatchSpec) =>
    base.map((c) => c.slice(Math.min(spec.a, c.length), Math.min(spec.b, c.length))),
}));

const SR = 48000;

/** A line's notes, canonical, as the song keeps them. */
const line = (n: Partial<AudioNote>[]): AudioNotes =>
  parseAudioNotes({ mode: 'mono', v: 1, n: n.map((x) => ({ d: 0.3, p: 60, ...x })) }) as AudioNotes;

const clip = (notes?: AudioNotes, more: Partial<AudioClip> = {}): AudioClip => ({
  file: 'aud_take',
  offset: 0,
  gain: 0,
  fadeIn: 0,
  fadeOut: 0,
  stretch: 1,
  ...(notes ? { notes } : {}),
  ...more,
});

describe('a region’s patches', () => {
  it('none for notes found but untouched, or with their edits off', () => {
    const found = line([{ t: 0.5 }, { t: 1 }, { t: 1.5, to: 60, dr: 1, mo: 1, fo: 0, g: 0 }]);
    expect(found.n.some(isEdited)).toBe(false);
    expect(regionPatches(clip(found), SR)).toEqual([]);
    expect(regionPatches(clip({ ...line([{ t: 1, to: 62 }]), off: true }), SR)).toEqual([]);
  });

  it('cover an edited note and 30 ms either side, and a pitch move’s glides too', () => {
    const [level] = regionPatches(clip(line([{ t: 1, g: -6 }])), SR);
    expect([level?.spec.a, level?.spec.b]).toEqual([Math.floor(0.97 * SR), Math.ceil(1.33 * SR)]);
    const [pitch] = regionPatches(clip(line([{ t: 1, to: 62 }])), SR);
    expect([pitch?.spec.a, pitch?.spec.b]).toEqual([Math.floor(0.79 * SR), Math.ceil(1.51 * SR)]);
    // in the recording as the region plays it: stretched
    const [stretched] = regionPatches(clip(line([{ t: 1, g: -6 }]), { stretch: 2 }), SR);
    expect(stretched?.spec.a).toBe(Math.floor(0.97 * 2 * SR));
    expect(stretched?.key.startsWith('aud_take@2.0000#')).toBe(true);
  });

  it('join edits closer than 40 ms, and keep those further apart apart', () => {
    expect(
      regionPatches(
        clip(
          line([
            { t: 1, g: -6 },
            { t: 1.36, g: -6 },
          ]),
        ),
        SR,
      ),
    ).toHaveLength(1);
    expect(
      regionPatches(
        clip(
          line([
            { t: 1, g: -6 },
            { t: 1.5, g: -6 },
          ]),
        ),
        SR,
      ),
    ).toHaveLength(2);
  });

  it('take in the whole island a note moved in time warps, out to the middles of the rests either side', () => {
    const notes = line([{ t: 1 }, { t: 1.5, ts: 1.55, te: 1.85 }, { t: 2.2 }]);
    const [moved] = regionPatches(clip(notes), SR);
    // the rests' middles (1.4 s, and 2.025 s between where it now ends and the next note), 30 ms past them
    expect(Math.abs((moved?.spec.a ?? 0) - 1.37 * SR)).toBeLessThanOrEqual(1);
    expect(Math.abs((moved?.spec.b ?? 0) - 2.055 * SR)).toBeLessThanOrEqual(1);
    // and clear of the notes that don't move
    expect(moved?.spec.a).toBeGreaterThan(1.3 * SR);
    expect(moved?.spec.b).toBeLessThan(2.2 * SR);
  });

  it('are keyed by what they sound like: the same edits share a key, another edit doesn’t', () => {
    const a = regionPatches(clip(line([{ t: 1, to: 62 }])), SR);
    const b = regionPatches(clip(line([{ t: 1, to: 62 }]), { offset: 0.5, gain: -3 }), SR);
    const c = regionPatches(clip(line([{ t: 1, to: 63 }])), SR);
    expect(b[0]?.key).toBe(a[0]?.key);
    expect(c[0]?.key).not.toBe(a[0]?.key);
    // a note far from the patch doesn't change it; one within 200 ms does
    const far = regionPatches(clip(line([{ t: 1, to: 62 }, { t: 3 }])), SR);
    const near = regionPatches(clip(line([{ t: 1, to: 62 }, { t: 1.6 }])), SR);
    expect(far[0]?.key).toBe(a[0]?.key);
    expect(near[0]?.key).not.toBe(a[0]?.key);
    // another rate, another key
    expect(regionPatches(clip(line([{ t: 1, to: 62 }])), 44100)[0]?.key).not.toBe(a[0]?.key);
  });
});

describe('clips with patches', () => {
  const song = (notes: AudioNotes | undefined, more: Partial<AudioClip> = {}): Project => {
    const p = newProject('Patches');
    p.tempo = [{ tick: 0, bpm: 120 }];
    const r = { ...newRegion(PPQ * 2, PPQ * 8), audio: clip(notes, more) };
    p.tracks = [{ ...newAudioTrack('Vocal'), id: 'trk_v', regions: [r] }];
    return p;
  };
  const clipsOf = (p: Project, ready?: (k: string) => boolean) =>
    compileClips(p.tracks[0] as Project['tracks'][number], compileTempo(p, SR), SR, ready);

  it('split a region where its patches start and end, joined sample to sample', () => {
    const notes = line([
      { t: 0.5, g: -6 },
      { t: 2, to: 62 },
    ]);
    const pieces = clipsOf(song(notes, { offset: 0.2 }));
    const [first, second] = regionPatches(clip(notes), SR);
    expect(pieces.map((c) => c.key)).toEqual(['aud_take', first?.key, 'aud_take', second?.key, 'aud_take']);
    // each starts where the one before ends
    for (let i = 1; i < pieces.length; i++) expect(pieces[i]?.start).toBe(pieces[i - 1]?.end);
    expect(pieces.map((c) => [!!c.seamIn, !!c.seamOut])).toEqual([
      [false, true],
      [true, true],
      [true, true],
      [true, true],
      [true, false],
    ]);
    // a patch's piece reads its own buffer, and knows its recording's frame
    const p1 = pieces[1];
    expect(p1?.source).toBe((p1?.at ?? 0) - (first?.spec.a ?? 0));
    expect(p1?.base).toBe('aud_take');
  });

  it('play the recording as it was where a patch has no sound yet', () => {
    const notes = line([
      { t: 0.5, g: -6 },
      { t: 2, to: 62 },
    ]);
    expect(clipsOf(song(notes), () => false)).toEqual(clipsOf(song(undefined)));
  });
});

describe('a song with edited notes, rendered', () => {
  // a take: a tone with a little noise, 6 s
  const take = (() => {
    const x = new Float32Array(SR * 6);
    let seed = 7;
    for (let i = 0; i < x.length; i++) {
      seed = (seed * 1103515245 + 12345) >>> 0;
      x[i] = 0.3 * Math.sin((2 * Math.PI * 220 * i) / SR) + 0.02 * (seed / 2 ** 32 - 0.5);
    }
    return x;
  })();
  const source = {
    instrument: () => Promise.reject(new Error('no packs here')),
    sample: () => Promise.reject(new Error('no packs here')),
    audio: async () => encodeWav([take], SR),
    impulse: () => Promise.reject(new Error('no packs here')),
  };
  /** Two regions of the take on one track, the second over the first's end; edits around both edges of each. */
  const song = (withNotes: boolean, stretch = 1): Project => {
    const p = newProject('Edited');
    p.tempo = [{ tick: 0, bpm: 120 }];
    const notes = line([
      { t: 0.3, g: -6 },
      { t: 1.2, to: 62 },
      // across where the first region's visible part ends (the second plays from there): a ramp, as the recording has
      { t: 1.8, g: -3 },
      { t: 2.05, fo: 3 },
      { t: 2.5, m: true },
      { t: 3.6, to: 58 },
    ]);
    const a = {
      ...newRegion(PPQ, PPQ * 4),
      audio: clip(withNotes ? notes : undefined, { offset: 0.4, fadeIn: 0.05, stretch }),
    };
    const b = {
      ...newRegion(PPQ * 4, PPQ * 4),
      audio: clip(withNotes ? notes : undefined, { offset: 2.4, gain: -2, fadeOut: 0.1, stretch }),
    };
    p.tracks = [{ ...newAudioTrack('Vocal'), id: 'trk_v', regions: [a, b] }];
    return p;
  };
  const bytes = (c: Float32Array | undefined) => Buffer.from(c?.buffer ?? new ArrayBuffer(0));

  for (const stretch of [1, 1.25]) {
    it(`plays to the bit what the recording would with patches that change nothing, stretch ${stretch}`, async () => {
      const plain = await renderSession(song(false, stretch), source, { sampleRate: SR, tail: 0.5, finish: false });
      const edited = await renderSession(song(true, stretch), source, { sampleRate: SR, tail: 0.5, finish: false });
      expect(songPatches(song(true, stretch), SR).length).toBeGreaterThan(2);
      expect(edited.errors).toEqual([]);
      expect(bytes(edited.channels[0]).equals(bytes(plain.channels[0]))).toBe(true);
      expect(bytes(edited.channels[1]).equals(bytes(plain.channels[1]))).toBe(true);
    });
  }

  it('renders the same twice, and plans the same patches every time', async () => {
    const one = await renderSession(song(true), source, { sampleRate: SR, tail: 0.5 });
    const two = await renderSession(song(true), source, { sampleRate: SR, tail: 0.5 });
    expect(bytes(one.channels[0]).equals(bytes(two.channels[0]))).toBe(true);
    expect(songPatches(song(true), SR).map((j) => j.key)).toEqual(songPatches(song(true), SR).map((j) => j.key));
  });

  it('assembles a recording with its patches in place', () => {
    const notes = line([{ t: 1, g: -6 }]);
    const [job] = regionPatches(clip(notes), SR);
    if (!job) throw new Error('no patch');
    const patched = assembleClip([take], [{ spec: job.spec, channels: renderNotePatch([take], SR, job.spec) }]);
    expect(bytes(patched[0]).equals(bytes(take))).toBe(true);
    expect(clipKey(job.base)).toBe('aud_take');
  });
});
