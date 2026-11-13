import { applyOps, newProject, newRegion, newTrack, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { drawnOf } from '../src/ui/Tracks.tsx';

const same = (a: unknown[], b: unknown[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function song(): Project {
  const p = newProject('Drawn');
  const a = newTrack('Keys', { type: 'synth', preset: 'Soft Keys' });
  a.regions = [{ ...newRegion(0, 3840), notes: [{ t: 0, d: 480, p: 60, v: 90 }] }];
  const b = newTrack('Bass', { type: 'synth', preset: 'Fat Mono' });
  p.tracks = [a, b];
  return p;
}

describe('what of a song the timeline draws', () => {
  it('is the same after a fader, a balance or a mute moved: nothing to redraw', () => {
    const p = song();
    const id = (p.tracks[0] as Project['tracks'][number]).id;
    const moved = applyOps(p, [
      { op: 'updateChannel', target: id, patch: { volume: -9, pan: 0.3, mute: true } },
      { op: 'updateChannel', target: 'master', patch: { volume: -2 } },
    ]);
    expect(moved).not.toBe(p);
    expect(same(drawnOf(moved, false), drawnOf(p, false))).toBe(true);
  });

  it('differs once a region, a track’s colour or name, the tempo or a marker changes', () => {
    const p = song();
    const t = p.tracks[0] as Project['tracks'][number];
    const before = drawnOf(p, false);
    const edits: Parameters<typeof applyOps>[1][] = [
      [{ op: 'addRegion', track: t.id, region: newRegion(3840, 3840) }],
      [{ op: 'updateTrack', track: t.id, patch: { color: '#123456' } }],
      [{ op: 'updateTrack', track: t.id, patch: { name: 'Piano' } }],
      [{ op: 'setProject', patch: { tempo: [{ tick: 0, bpm: 97 }] } }],
      [{ op: 'setProject', patch: { markers: [{ id: 'mrk_a', tick: 3840, name: 'Verse' }] } }],
    ];
    for (const ops of edits) expect(same(drawnOf(applyOps(p, ops), false), before)).toBe(false);
  });

  it('is the whole song while the lanes show: they draw the mixer', () => {
    const p = song();
    const id = (p.tracks[0] as Project['tracks'][number]).id;
    const moved = applyOps(p, [{ op: 'updateChannel', target: id, patch: { volume: -9 } }]);
    expect(same(drawnOf(moved, true), drawnOf(p, true))).toBe(false);
  });
});
