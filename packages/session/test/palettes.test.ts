import { describe, expect, it } from 'vitest';
import { applyOps, checkSound, newProject, type PackSound, soundPacks, soundTrack } from '../src/index.ts';

const lowBrass: PackSound = {
  name: 'Low Brass',
  family: 'Brass',
  instrument: { pack: 'vsco2', name: 'trombones' },
  inserts: [{ type: 'eq', params: { lsGain: 3 } }],
  space: { name: 'Big Hall', type: 'space', params: { space: 5 }, send: -10 },
  volume: -4,
  pan: -0.2,
  note: 'Trombones, full and broad.',
};

const pulse: PackSound = {
  name: 'Soft Pulse',
  family: 'Synths',
  instrument: { synth: 'Fat Poly', params: { cutoff: 900 } },
  inserts: [
    { type: 'arpeggiator', params: { rate: 3 } },
    { type: 'delay', params: { mix: 30 } },
  ],
  space: { name: 'Big Hall', type: 'space', params: { space: 5 }, send: -14 },
};

describe('palette sounds', () => {
  it('become a track with their instrument, effects, level and room, the room made once and shared', () => {
    let project = newProject('Test');
    const first = soundTrack(project, lowBrass, { color: '#123456' });
    expect(first.ops.map((o) => o.op)).toEqual(['addBus', 'addTrack']);
    project = applyOps(project, first.ops);
    const track = project.tracks.find((t) => t.id === first.track.id);
    expect(track?.name).toBe('Low Brass');
    expect(track?.instrument).toEqual({ type: 'sampler', pack: 'vsco2', name: 'trombones' });
    expect(track?.channel.inserts.map((p) => p.type)).toEqual(['eq']);
    expect(track?.channel.inserts[0]?.params.lsGain).toBe(3);
    expect(track?.channel.volume).toBe(-4);
    expect(track?.channel.pan).toBe(-0.2);
    const room = project.buses.find((b) => b.name === 'Big Hall');
    expect(room?.channel.inserts[0]?.type).toBe('space');
    // all room: none of the dry sound comes back through it
    expect(room?.channel.inserts[0]?.params.dry).toBe(-60);
    expect(track?.channel.sends).toEqual([{ bus: room?.id, level: -10, pre: false }]);

    // a MIDI effect goes before the instrument, and the same room is shared
    const second = soundTrack(project, pulse);
    expect(second.ops.map((o) => o.op)).toEqual(['addTrack']);
    project = applyOps(project, second.ops);
    const synth = project.tracks.find((t) => t.id === second.track.id);
    expect(synth?.instrument).toEqual({ type: 'synth', preset: 'Fat Poly', params: { cutoff: 900 } });
    expect(synth?.midiFx.map((p) => p.type)).toEqual(['arpeggiator']);
    expect(synth?.channel.inserts.map((p) => p.type)).toEqual(['delay']);
    expect(synth?.channel.sends[0]?.bus).toBe(room?.id);
    expect(project.buses.filter((b) => b.name === 'Big Hall')).toHaveLength(1);
  });

  it('without a room, send to the song’s first bus as a new track does', () => {
    const project = newProject('Test');
    const { track } = soundTrack(project, { name: 'Keys', family: 'Keys', instrument: { synth: 'Soft Keys' } });
    expect(track.channel.sends).toEqual([{ bus: project.buses[0]?.id, level: -18, pre: false }]);
  });

  it('say what this engine lacks (coming) apart from what is wrong', () => {
    expect(checkSound(lowBrass)).toEqual({ missing: [], problems: [] });
    expect(checkSound(pulse)).toEqual({ missing: [], problems: [] });
    const later = checkSound({
      name: 'Later',
      family: 'Keys',
      instrument: { synth: 'Not Yet' },
      inserts: [{ type: 'not-yet', params: { amount: 1 } }],
    });
    expect(later.missing).toEqual(['the Not Yet synth', 'the "not-yet" effect']);
    expect(later.problems).toEqual([]);
    const wrong = checkSound({
      name: 'Wrong',
      family: 'Nope',
      instrument: { synth: 'Fat Poly', params: { cutof: 900, drive: 4 } },
      space: { name: 'Room', type: 'delay' as 'space', send: -100 },
    });
    expect(wrong.missing).toEqual([]);
    expect(wrong.problems).toHaveLength(5);
    expect(() =>
      soundTrack(newProject('x'), { name: 'Later', family: 'Keys', instrument: { synth: 'Not Yet' } }),
    ).toThrow(/doesn't have yet/);
  });

  it('name the packs they play, a room’s response file’s too', () => {
    expect(soundPacks(lowBrass)).toEqual(['vsco2']);
    expect(soundPacks(pulse)).toEqual([]);
    expect(
      soundPacks({
        ...lowBrass,
        space: { name: 'Church', type: 'space', params: { space: 13 }, settings: { ir: 'rooms/church' }, send: -12 },
      }),
    ).toEqual(['rooms', 'vsco2']);
  });
});
