import { applyOps, newBus, newProject, newRegion, newTrack, type Op, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { broken, mergeSongs, same } from '../src/app/merge-songs.ts';

const BAR = 3840;

/** A song with a track playing a two-bar region of notes, as it was saved. */
function saved(): { song: Project; track: string; region: string } {
  const track = newTrack('Keys', { type: 'synth', preset: 'Soft Keys' });
  const region = newRegion(0, 2 * BAR, 'Verse');
  const song = applyOps(newProject('Song'), [
    { op: 'addTrack', track },
    { op: 'addRegion', track: track.id, region },
    {
      op: 'addNotes',
      track: track.id,
      region: region.id,
      notes: [
        { t: 0, d: 960, p: 60, v: 90 },
        { t: BAR, d: 960, p: 64, v: 90 },
      ],
    },
  ]);
  return { song: { ...song, revision: 4 }, track: track.id, region: region.id };
}

const host = (song: Project, ops: Op[], revision = 7): Project => ({ ...applyOps(song, ops), revision });

describe('a song changed in two places, merged', () => {
  it('keeps each side’s changes to different things, the other side’s as it has them', () => {
    const { song: base, track } = saved();
    const mine = applyOps(base, [{ op: 'updateChannel', target: track, patch: { mute: true } }]);
    const theirs = host(base, [
      { op: 'setProject', patch: { key: 'D minor' } },
      { op: 'updateTrack', track, patch: { name: 'Piano' } },
    ]);
    const merged = mergeSongs(base, mine, theirs) as Project;
    const t = merged.tracks.find((x) => x.id === track);
    expect([merged.key, t?.name, t?.channel.mute, merged.revision]).toEqual(['D minor', 'Piano', true, 7]);
    // nothing of mine: theirs as it is; nothing of theirs: mine
    expect(same(mergeSongs(base, base, theirs), theirs)).toBe(true);
    expect(mergeSongs(base, mine, { ...base, revision: 7 })?.tracks.find((x) => x.id === track)?.channel.mute).toBe(
      true,
    );
  });

  it('takes the agent’s copied bars with the ids the host gave them, and its change to the copy, under the user’s', () => {
    const { song: base, track } = saved();
    // the agent copies bars 1–2 after themselves, then renames the copy (by the id the host made)
    const copied = host(base, [{ op: 'arrange', edit: 'copy', from: 0, to: 2 * BAR, at: 2 * BAR }]);
    const copy = copied.tracks.find((t) => t.id === track)?.regions.find((r) => r.start === 2 * BAR);
    if (!copy) throw new Error('no copy');
    const theirs = host(copied, [{ op: 'updateRegion', track, region: copy.id, patch: { name: 'Verse 2' } }], 8);
    // the user, meanwhile, made the track louder
    const mine = applyOps(base, [{ op: 'updateChannel', target: track, patch: { volume: -3 } }]);
    const merged = mergeSongs(base, mine, theirs) as Project;
    const t = merged.tracks.find((x) => x.id === track);
    expect(t?.channel.volume).toBe(-3);
    expect(t?.regions.map((r) => [r.id, r.name, r.start])).toEqual(
      theirs.tracks.find((x) => x.id === track)?.regions.map((r) => [r.id, r.name, r.start]),
    );
    // (the agent's operations made again here wouldn't do: the copy gets other ids, and the rename fails)
    const again = applyOps(mine, [{ op: 'arrange', edit: 'copy', from: 0, to: 2 * BAR, at: 2 * BAR }]);
    expect(() =>
      applyOps(again, [{ op: 'updateRegion', track, region: copy.id, patch: { name: 'Verse 2' } }]),
    ).toThrow();
  });

  it('adds what each side added, where it came, and drops what one removed that the other left alone', () => {
    const { song: base, track } = saved();
    const bass = newTrack('Bass', { type: 'synth', preset: 'Soft Keys' });
    const drums = newTrack('Drums', { type: 'synth', preset: 'Soft Keys' });
    const mine = applyOps(base, [{ op: 'addTrack', track: bass }]);
    const theirs = host(base, [{ op: 'addTrack', track: drums, index: 0 }]);
    expect((mergeSongs(base, mine, theirs) as Project).tracks.map((t) => t.name)).toEqual([
      'Drums',
      ...base.tracks.map((t) => t.name),
      'Bass',
    ]);
    // removed on one side, untouched on the other: gone
    const removed = applyOps(base, [{ op: 'removeTrack', track }]);
    const moved = host(base, [{ op: 'setProject', patch: { key: 'A minor' } }]);
    const merged = mergeSongs(base, removed, moved) as Project;
    expect([merged.tracks.some((t) => t.id === track), merged.key]).toEqual([false, 'A minor']);
  });

  it('clashes where both changed the same thing differently, or one removed what the other changed', () => {
    const { song: base, track, region } = saved();
    const rename = (name: string): Op[] => [{ op: 'updateTrack', track, patch: { name } }];
    expect(mergeSongs(base, applyOps(base, rename('Mine')), host(base, rename('Theirs')))).toBeNull();
    // the same change on both sides is no clash
    expect(mergeSongs(base, applyOps(base, rename('Same')), host(base, rename('Same')))?.tracks[1]?.name).toBe('Same');
    // a region's notes edited on both sides: its notes are one part
    const notes = (p: number): Op[] => [{ op: 'setNotes', track, region, notes: [{ t: 0, d: 480, p, v: 80 }] }];
    expect(mergeSongs(base, applyOps(base, notes(62)), host(base, notes(65)))).toBeNull();
    // removed on one side, changed on the other
    expect(mergeSongs(base, applyOps(base, [{ op: 'removeTrack', track }]), host(base, rename('Kept')))).toBeNull();
  });

  it('clashes where the merged song would point at what it doesn’t have, or keep an id twice', () => {
    const { song: start, track, region } = saved();
    const room = newBus('Room');
    const base = { ...applyOps(start, [{ op: 'addBus', bus: room }]), revision: 4 };
    // the user removed the bus the agent sends the track to
    const send: Op[] = [
      { op: 'updateChannel', target: track, patch: { sends: [{ bus: room.id, level: -12, pre: false }] } },
    ];
    expect(mergeSongs(base, applyOps(base, [{ op: 'removeBus', bus: room.id }]), host(base, send))).toBeNull();
    // the user removed an articulation the agent wrote notes for
    const art = { id: 'art_pizz', name: 'Pizzicato', instrument: { type: 'synth', preset: 'Soft Keys' } } as const;
    const withArt = { ...applyOps(base, [{ op: 'updateTrack', track, patch: { articulations: [art] } }]), revision: 4 };
    const pizz: Op[] = [{ op: 'setNotes', track, region, notes: [{ t: 0, d: 480, p: 60, v: 80, art: art.id }] }];
    const noArt = applyOps(withArt, [{ op: 'updateTrack', track, patch: { articulations: [] } }]);
    expect(mergeSongs(withArt, noArt, host(withArt, pizz))).toBeNull();
    // both moved the same region, to different tracks: its id would be kept twice
    const two = newTrack('Two', { type: 'synth', preset: 'Soft Keys' });
    const three = newTrack('Three', { type: 'synth', preset: 'Soft Keys' });
    const more = {
      ...applyOps(base, [
        { op: 'addTrack', track: two },
        { op: 'addTrack', track: three },
      ]),
      revision: 4,
    };
    const move = (to: string): Op[] => [{ op: 'moveRegion', from: track, to, region }];
    expect(mergeSongs(more, applyOps(more, move(two.id)), host(more, move(three.id)))).toBeNull();
    // what was so already in the host's song is no clash of the merge's
    // (a send left pointing at a bus that's gone: removing a bus takes its sends, so it's made by hand)
    const dangling = { ...host(base, send), buses: [] };
    const louder = applyOps(base, [{ op: 'setProject', patch: { title: 'Louder' } }]);
    expect(mergeSongs(base, louder, dangling)?.title).toBe('Louder');
    expect([...broken(dangling)]).toContain(`track ${track} sends to ${room.id}`);
    expect(broken(base)).toEqual(new Set());
  });

  it('tells songs apart by their parts, whatever the order of their keys', () => {
    expect(same({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1 })).toBe(true);
    expect(same({ a: 1, b: undefined }, { a: 1 })).toBe(true);
    expect(same({ a: 1 }, { a: 2 })).toBe(false);
    expect(same([1, 2], [2, 1])).toBe(false);
  });
});
