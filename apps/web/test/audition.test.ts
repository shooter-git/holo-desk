import { regionPatches } from '@holo/engine';
import {
  type AudioClip,
  type AudioNote,
  type AudioNotes,
  moveNotes,
  newAudioTrack,
  parseAudioNotes,
  type Track,
  warpAt,
  warpOf,
} from '@holo/session';
import { describe, expect, it } from 'vitest';
import { AUDITION_LEAD_S, auditionClips, auditionPatches, auditionRange } from '../src/audio/audition.ts';

const SR = 48000;

/** A line's notes, canonical, as the song keeps them. */
const line = (n: Partial<AudioNote>[]): AudioNotes =>
  parseAudioNotes({ mode: 'mono', v: 1, n: n.map((x) => ({ d: 0.3, p: 60, ...x })) }) as AudioNotes;

const clip = (notes: AudioNotes, more: Partial<AudioClip> = {}): AudioClip => ({
  file: 'aud_take',
  offset: 0,
  gain: 0,
  fadeIn: 0,
  fadeOut: 0,
  stretch: 1,
  notes,
  ...more,
});

const track: Track = { ...newAudioTrack('Vocal'), id: 'trk_v' };

describe('the stretch a pressed note is heard over', () => {
  it('is from just before it starts to its end', () => {
    const notes = line([{ t: 1 }, { t: 1.5, d: 0.4 }]);
    expect(auditionRange(notes, 0)).toEqual([1 - AUDITION_LEAD_S, 1.3]);
    const [a, b] = auditionRange(notes, 1) as [number, number];
    expect(a).toBeCloseTo(1.47, 9);
    expect(b).toBeCloseTo(1.9, 9);
    // (never before the recording starts; and no such note, nothing)
    expect(auditionRange(line([{ t: 0.01 }]), 0)?.[0]).toBe(0);
    expect(auditionRange(notes, 2)).toBeNull();
  });

  it('follows a note moved or stretched in time: from its ts to its te', () => {
    const notes = line([{ t: 1 }, { t: 1.4, ts: 1.45, te: 1.8 }, { t: 2.2 }]);
    const [a, b] = auditionRange(notes, 1) as [number, number];
    expect(a).toBeCloseTo(1.45 - AUDITION_LEAD_S, 9);
    expect(b).toBeCloseTo(1.8, 9);
    // its edits off, it's heard where it was recorded
    const [c, d] = auditionRange({ ...notes, off: true }, 1) as [number, number];
    expect(c).toBeCloseTo(1.37, 9);
    expect(d).toBeCloseTo(1.7, 9);
  });

  it('follows a neighbour a move stretches or squeezes, where the warp takes it', () => {
    // legato notes: moving the middle one later stretches the first and squeezes the last
    const before = line([{ t: 1 }, { t: 1.3 }, { t: 1.6 }]);
    const moved = moveNotes(before, [1], 0.06);
    expect(moved.n[1]?.ts).toBeCloseTo(1.36, 9);
    const w = warpOf(moved);
    for (let i = 0; i < 3; i++) {
      const n = moved.n[i] as AudioNote;
      const [a, b] = auditionRange(moved, i) as [number, number];
      expect(a).toBeCloseTo(warpAt(w, n.t) - AUDITION_LEAD_S, 9);
      expect(b).toBeCloseTo(warpAt(w, n.t + n.d), 9);
    }
    expect((auditionRange(moved, 0) as [number, number])[1]).toBeCloseTo(1.36, 6);
  });
});

describe('an audition’s clips', () => {
  // a pitch move on the second note: one patch over it (and its glides)
  const notes = line([{ t: 1 }, { t: 2, to: 62 }, { t: 3 }]);
  const edited = clip(notes, { gain: -6 });
  const [patch] = regionPatches(edited, SR);

  it('are the recording as it is where nothing is edited, from frame 0, at the region’s gain', () => {
    const range = auditionRange(notes, 0) as [number, number];
    const clips = auditionClips(track, edited, range, SR, () => true);
    expect(clips).toHaveLength(1);
    const [c] = clips;
    expect(c?.key).toBe('aud_take');
    expect(c?.start).toBe(0);
    expect(c?.end).toBe(Math.round((range[1] - range[0]) * SR));
    expect(c?.source).toBe(Math.round(range[0] * SR));
    expect(c?.gain).toBeCloseTo(10 ** (-6 / 20), 9);
    // in over 10 ms (within its lead: often in the middle of a sound, a few ms would click), and out at the note's end
    expect(c?.fadeIn).toBe(Math.round(0.01 * SR));
    expect(c?.fadeOut).toBe(Math.round(0.01 * SR));
  });

  it('play an edited note’s patch once the engines have it, the recording there until then', () => {
    const range = auditionRange(notes, 1) as [number, number];
    const waiting = auditionClips(track, edited, range, SR, () => false);
    expect(waiting.map((c) => c.key)).toEqual(['aud_take']);
    const ready = auditionClips(track, edited, range, SR, (k) => k === patch?.key);
    // the note lies inside its patch: all of it
    expect(ready.map((c) => c.key)).toEqual([patch?.key]);
    const [c] = ready;
    expect(c?.base).toBe('aud_take');
    expect(c?.at).toBe(Math.round(range[0] * SR));
    expect(c?.source).toBe(Math.round(range[0] * SR) - (patch?.spec.a ?? 0));
    expect(auditionPatches(edited, range, SR).map((j) => j.key)).toEqual([patch?.key]);
  });

  it('cut where a patch starts or ends, joined there sample to sample', () => {
    // from just before the first note to past the second: the recording, then the patch
    const range: [number, number] = [0.9, 2.1];
    const clips = auditionClips(track, edited, range, SR, () => true);
    expect(clips.map((c) => c.key)).toEqual(['aud_take', patch?.key]);
    const [a, b] = clips;
    expect(a?.end).toBe(b?.start);
    expect(a?.seamOut).toBe(true);
    expect(b?.seamIn).toBe(true);
    expect((b?.start ?? 0) + Math.round(0.9 * SR)).toBe(patch?.spec.a);
    // a region with no edits plays none
    expect(auditionPatches(clip(line([{ t: 1 }])), range, SR)).toEqual([]);
  });

  it('stretch with the region', () => {
    const slow = clip(line([{ t: 1 }]), { stretch: 2 });
    const [c] = auditionClips(track, slow, [0.97, 1.3], SR, () => true);
    expect(c?.source).toBe(Math.round(0.97 * 2 * SR));
    expect(c?.end).toBe(Math.round(0.33 * 2 * SR));
    expect(c?.key).toBe('aud_take@2.0000');
  });
});
