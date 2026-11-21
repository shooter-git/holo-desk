import { newProject, newTrack, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { songKeys, zonesForKeys } from '../src/audio/song-samples.ts';

function song(tracks: { instrument: Project['tracks'][number]['instrument']; pitches: number[]; fx?: boolean }[]) {
  const p = newProject('t');
  p.tracks = tracks.map((x, i) => {
    const t = newTrack(`T${i}`, x.instrument);
    t.regions = [
      {
        ...(t.regions[0] ?? {}),
        id: `r${i}`,
        start: 0,
        length: 3840 * 4,
        name: '',
        notes: x.pitches.map((p, j) => ({ t: j * 480, d: 480, p, v: 80 })),
        muted: false,
      } as Project['tracks'][number]['regions'][number],
    ];
    if (x.fx) t.midiFx = [{ id: 'fx1', type: 'arpeggiator', bypass: false, params: {} }];
    return t;
  });
  return p;
}

describe('the keys a song plays on each sampled instrument', () => {
  it('gathers every track on the instrument, fractional pitches by both neighbours', () => {
    const piano = { type: 'sampler', pack: 'p', name: 'grand' } as const;
    const keys = songKeys(
      song([
        { instrument: piano, pitches: [60, 64] },
        { instrument: piano, pitches: [67.5] },
        { instrument: { type: 'synth', preset: 'Soft Keys' } as never, pitches: [30] },
      ]),
    );
    expect([...(keys.get('p/grand') ?? [])].sort((a, b) => a - b)).toEqual([60, 64, 67, 68]);
    expect(keys.size).toBe(1);
  });

  it("leaves out an inactive track's keys", () => {
    const piano = { type: 'sampler', pack: 'p', name: 'grand' } as const;
    const strings = { type: 'sampler', pack: 'p', name: 'strings' } as const;
    const p = song([
      { instrument: piano, pitches: [60] },
      { instrument: piano, pitches: [72] },
      { instrument: strings, pitches: [55] },
    ]);
    p.tracks = p.tracks.map((t, i) => (i === 0 ? t : { ...t, inactive: true }));
    const keys = songKeys(p);
    expect([...(keys.get('p/grand') ?? [])]).toEqual([60]);
    expect(keys.has('p/strings')).toBe(false);
  });

  it('takes the whole instrument when a MIDI effect plays it', () => {
    const strings = { type: 'sampler', pack: 'v', name: 'strings' } as const;
    const keys = songKeys(
      song([
        { instrument: strings, pitches: [50] },
        { instrument: strings, pitches: [55], fx: true },
      ]),
    );
    expect(keys.get('v/strings')).toBeNull();
  });
});

describe('the zones that play some keys', () => {
  // three velocity layers on each of three key ranges, and a release sample over them all
  const zones = [
    ...[0, 1, 2].map(() => ({ lo: 48, hi: 50 })),
    ...[0, 1, 2].map(() => ({ lo: 51, hi: 53 })),
    ...[0, 1, 2].map(() => ({ lo: 54, hi: 56 })),
    { lo: 0, hi: 127 },
  ];

  it('are every layer of the key, those a key either side, and what covers it all', () => {
    expect([...zonesForKeys(zones, [52])].sort((a, b) => a - b)).toEqual([3, 4, 5, 9]);
    // 50 is a key from 51
    expect([...zonesForKeys(zones, [50])].sort((a, b) => a - b)).toEqual([0, 1, 2, 3, 4, 5, 9]);
  });

  it('are the nearest for a key outside them all', () => {
    const narrow = zones.slice(0, 9);
    expect([...zonesForKeys(narrow, [70])].sort((a, b) => a - b)).toEqual([6, 7, 8]);
    expect([...zonesForKeys(narrow, [])]).toEqual([]);
  });
});
