import { notate } from '@holo/score';
import { applyOps, newProject, newRegion, newTrack, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { sameMusic } from '../src/score/same-music.ts';

function song(): Project {
  const p = newProject('Same music');
  const a = newTrack('Keys', { type: 'synth', preset: 'Soft Keys' });
  a.regions = [{ ...newRegion(0, 3840), notes: [{ t: 0, d: 480, p: 60, v: 90 }] }];
  const b = newTrack('Bass', { type: 'synth', preset: 'Fat Mono' });
  p.tracks = [a, b];
  return p;
}

const first = (p: Project) => p.tracks[0] as Project['tracks'][number];

describe('whether a song is still the same music', () => {
  it('is, after the mix moved: a fader, a balance, a mute, a plugin, the master, the cycle, arming', () => {
    const p = song();
    const id = first(p).id;
    const edits: Parameters<typeof applyOps>[1][] = [
      [{ op: 'updateChannel', target: id, patch: { volume: -9, pan: 0.3, mute: true } }],
      [{ op: 'updateChannel', target: 'master', patch: { volume: -2 } }],
      [{ op: 'addPlugin', target: id, slot: 'inserts', plugin: { id: 'fx_a', type: 'eq', bypass: false, params: {} } }],
      [{ op: 'setProject', patch: { cycle: { on: true, start: 0, end: 3840 } } }],
      [{ op: 'updateTrack', track: id, patch: { armed: true } }],
    ];
    for (const ops of edits) {
      const moved = applyOps(p, ops);
      expect(moved).not.toBe(p);
      expect(sameMusic(p, moved), JSON.stringify(ops)).toBe(true);
    }
  });

  it('isn’t, once a note, a region, a name, an instrument, the tempo, the meter, the key or the title changes', () => {
    const p = song();
    const t = first(p);
    const region = (t.regions[0] as Project['tracks'][number]['regions'][number]).id;
    const edits: Parameters<typeof applyOps>[1][] = [
      [{ op: 'addNotes', track: t.id, region, notes: [{ t: 480, d: 480, p: 62, v: 90 }] }],
      [{ op: 'addRegion', track: t.id, region: newRegion(3840, 3840) }],
      [{ op: 'updateTrack', track: t.id, patch: { name: 'Piano' } }],
      [{ op: 'updateTrack', track: t.id, patch: { instrument: { type: 'synth', preset: 'Warm Pad' } } }],
      [{ op: 'setProject', patch: { tempo: [{ tick: 0, bpm: 97 }] } }],
      [{ op: 'setProject', patch: { meter: [{ tick: 0, num: 3, den: 4 }] } }],
      [{ op: 'setProject', patch: { key: 'D minor' } }],
      [{ op: 'setProject', patch: { title: 'Another' } }],
      [{ op: 'removeTrack', track: t.id }],
    ];
    for (const ops of edits) expect(sameMusic(p, applyOps(p, ops)), JSON.stringify(ops)).toBe(false);
  });

  it('the same music is the same score', () => {
    const p = song();
    const moved = applyOps(p, [{ op: 'updateChannel', target: first(p).id, patch: { volume: -30, mute: true } }]);
    expect(sameMusic(p, moved)).toBe(true);
    const strip = (v: unknown) => JSON.stringify(v, (_k, x) => (x instanceof Map ? [...x.keys()] : x));
    expect(strip(notate(moved))).toBe(strip(notate(p)));
  });
});
