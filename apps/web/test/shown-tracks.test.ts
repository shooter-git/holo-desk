import { applyOps, newProject, newRegion, newTrack, type Project, type Track } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  hiddenTracks,
  nearestShown,
  type Sight,
  selectionInSight,
  shownSong,
  shownTracks,
  songIndex,
  stepShown,
} from '../src/app/shown-tracks.ts';

const ALL = { inactiveTracks: true };
const ACTIVE = { inactiveTracks: false };

/** Keys, Bass (inactive), Drums, Pad (inactive), Lead: each with a region. */
function song(): Project {
  const p = newProject('Shown');
  p.tracks = ['Keys', 'Bass', 'Drums', 'Pad', 'Lead'].map((name, i) => {
    const t = newTrack(name, { type: 'synth', preset: 'Soft Keys' });
    t.regions = [newRegion(0, 3840)];
    if (i === 1 || i === 3) t.inactive = true;
    return t;
  });
  return p;
}
const names = (tracks: (Track | null)[]) => tracks.map((t) => t?.name ?? null);
const at = (p: Project, name: string) => p.tracks.find((t) => t.name === name) as Track;
const sight = (p: Project, show: typeof ALL): Sight => ({ song: p.id, tracks: p.tracks, show });

describe('the tracks shown (View › Inactive tracks)', () => {
  it('are the song’s own list with the option on, or with no track inactive', () => {
    const p = song();
    expect(shownTracks(p.tracks, ALL)).toBe(p.tracks);
    expect(shownSong(p, ALL)).toBe(p);
    const on = applyOps(p, [
      { op: 'updateTrack', track: at(p, 'Bass').id, patch: { inactive: false } },
      { op: 'updateTrack', track: at(p, 'Pad').id, patch: { inactive: false } },
    ]);
    expect(shownTracks(on.tracks, ACTIVE)).toBe(on.tracks);
    expect(shownSong(on, ACTIVE)).toBe(on);
    expect(hiddenTracks(on.tracks, ACTIVE)).toBe(0);
  });

  it('leave the inactive ones out with it off, in the song’s order, and the song itself as it was', () => {
    const p = song();
    expect(names(shownTracks(p.tracks, ACTIVE))).toEqual(['Keys', 'Drums', 'Lead']);
    expect(hiddenTracks(p.tracks, ACTIVE)).toBe(2);
    const shown = shownSong(p, ACTIVE);
    expect(names(shown.tracks)).toEqual(['Keys', 'Drums', 'Lead']);
    expect(shown.tempo).toBe(p.tempo);
    expect(p.tracks).toHaveLength(5);
  });

  it('are the same list until the song’s tracks change: nothing to lay out or draw again', () => {
    const p = song();
    expect(shownTracks(p.tracks, ACTIVE)).toBe(shownTracks(p.tracks, ACTIVE));
    expect(shownSong(p, ACTIVE)).toBe(shownSong(p, ACTIVE));
    const moved = applyOps(p, [{ op: 'updateChannel', target: 'master', patch: { volume: -3 } }]);
    expect(shownTracks(moved.tracks, ACTIVE)).toBe(shownTracks(p.tracks, ACTIVE));
  });
});

describe('a track dropped among the tracks shown', () => {
  const dropped = (name: string, index: number) => {
    const p = song();
    const to = songIndex(p.tracks, ACTIVE, index);
    const next = applyOps(p, [{ op: 'moveTrack', track: at(p, name).id, index: to }]);
    return names(shownTracks(next.tracks, ACTIVE));
  };

  it('lands where it was dropped, whatever is left out in between', () => {
    expect(dropped('Keys', 1)).toEqual(['Drums', 'Keys', 'Lead']);
    expect(dropped('Keys', 2)).toEqual(['Drums', 'Lead', 'Keys']);
    expect(dropped('Lead', 0)).toEqual(['Lead', 'Keys', 'Drums']);
    expect(dropped('Drums', 0)).toEqual(['Drums', 'Keys', 'Lead']);
    expect(dropped('Drums', 9)).toEqual(['Keys', 'Lead', 'Drums']);
  });

  it('goes by the song’s own places with nothing left out', () => {
    const p = song();
    expect(songIndex(p.tracks, ALL, 3)).toBe(3);
  });
});

describe('going from track to track', () => {
  it('steps over the tracks left out, and stops at the ends', () => {
    const p = song();
    const step = (name: string, up: boolean) => stepShown(p.tracks, ACTIVE, at(p, name).id, up)?.name;
    expect(step('Keys', false)).toBe('Drums');
    expect(step('Drums', false)).toBe('Lead');
    expect(step('Lead', false)).toBe('Lead');
    expect(step('Lead', true)).toBe('Drums');
    expect(step('Keys', true)).toBe('Keys');
    expect(stepShown(p.tracks, ALL, at(p, 'Keys').id, false)?.name).toBe('Bass');
  });

  it('from a track left out goes to the nearest shown that way, and from none to the first', () => {
    const p = song();
    expect(stepShown(p.tracks, ACTIVE, at(p, 'Bass').id, false)?.name).toBe('Drums');
    expect(stepShown(p.tracks, ACTIVE, at(p, 'Bass').id, true)?.name).toBe('Keys');
    expect(stepShown(p.tracks, ACTIVE, null, true)?.name).toBe('Keys');
    expect(stepShown(p.tracks, ACTIVE, null, false)?.name).toBe('Keys');
  });

  it('finds the nearest track shown: the next one down, else the next up, or none', () => {
    const p = song();
    expect(nearestShown(p.tracks, ACTIVE, 1)?.name).toBe('Drums');
    expect(nearestShown(p.tracks, ACTIVE, 1, true)?.name).toBe('Keys');
    expect(nearestShown(p.tracks, ACTIVE, 5)?.name).toBe('Lead');
    const none = applyOps(
      p,
      p.tracks.map((t) => ({ op: 'updateTrack' as const, track: t.id, patch: { inactive: true } })),
    );
    expect(nearestShown(none.tracks, ACTIVE, 2)).toBeNull();
  });
});

describe('what’s selected when tracks go out of sight', () => {
  it('moves off a track made inactive while they’re left out, to the next one shown, and lets its regions go', () => {
    const p = song();
    const drums = at(p, 'Drums');
    const keys = at(p, 'Keys');
    const next = applyOps(p, [{ op: 'updateTrack', track: drums.id, patch: { inactive: true } }]);
    const regions = [drums.regions[0]?.id, keys.regions[0]?.id] as string[];
    expect(selectionInSight(sight(p, ACTIVE), sight(next, ACTIVE), drums.id, regions)).toEqual({
      selectedTrack: at(p, 'Lead').id,
      selectedRegions: [keys.regions[0]?.id],
    });
  });

  it('moves off an inactive track when they start being left out', () => {
    const p = song();
    expect(selectionInSight(sight(p, ALL), sight(p, ACTIVE), at(p, 'Pad').id, [])).toEqual({
      selectedTrack: at(p, 'Lead').id,
    });
    // the last track: the one above it
    const last = applyOps(p, [{ op: 'updateTrack', track: at(p, 'Lead').id, patch: { inactive: true } }]);
    expect(selectionInSight(sight(last, ALL), sight(last, ACTIVE), at(p, 'Lead').id, [])).toEqual({
      selectedTrack: at(p, 'Drums').id,
    });
  });

  it('stands when another track goes, when they show again, and with nothing left out', () => {
    const p = song();
    const next = applyOps(p, [{ op: 'updateTrack', track: at(p, 'Drums').id, patch: { inactive: true } }]);
    expect(selectionInSight(sight(p, ACTIVE), sight(next, ACTIVE), at(p, 'Keys').id, [])).toBeNull();
    expect(selectionInSight(sight(p, ACTIVE), sight(p, ALL), at(p, 'Keys').id, [])).toBeNull();
    expect(selectionInSight(sight(p, ALL), sight(next, ALL), at(p, 'Drums').id, [])).toBeNull();
  });

  it('stays on a track that was out of sight already and was selected on purpose', () => {
    const p = song();
    const pad = at(p, 'Pad');
    // (selected from the Score, say; then some other edit comes)
    const next = applyOps(p, [{ op: 'updateTrack', track: at(p, 'Keys').id, patch: { name: 'Piano' } }]);
    expect(selectionInSight(sight(p, ACTIVE), sight(next, ACTIVE), pad.id, [pad.regions[0]?.id as string])).toBeNull();
  });

  it('starts a song just opened on a track that shows', () => {
    const p = song();
    const first = applyOps(p, [{ op: 'moveTrack', track: at(p, 'Bass').id, index: 0 }]);
    const other: Sight = { song: 'prj_other', tracks: [], show: ACTIVE };
    expect(selectionInSight(other, sight(first, ACTIVE), at(p, 'Bass').id, [])).toEqual({
      selectedTrack: at(p, 'Keys').id,
    });
  });

  it('selects no track when none shows', () => {
    const p = song();
    const none = applyOps(
      p,
      p.tracks.map((t) => ({ op: 'updateTrack' as const, track: t.id, patch: { inactive: true } })),
    );
    expect(selectionInSight(sight(p, ACTIVE), sight(none, ACTIVE), at(p, 'Keys').id, [])).toEqual({
      selectedTrack: null,
    });
  });
});
