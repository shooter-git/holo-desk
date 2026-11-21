import { describe, expect, it } from 'vitest';
import {
  applyOps,
  describeChanges,
  describeProject,
  newProject,
  newRegion,
  newTrack,
  PPQ,
  type Project,
  parseProject,
  performed,
} from '../src/index.ts';

/** Keys and Pad, each with a bar of notes. */
function song(): Project {
  const p = newProject('Parked');
  const keys = p.tracks[0];
  if (!keys) throw new Error('no track');
  keys.name = 'Keys';
  keys.regions = [{ ...newRegion(0, PPQ * 4), notes: [{ t: 0, d: PPQ, p: 60, v: 100 }] }];
  const pad = newTrack('Pad', { type: 'synth', preset: 'Warm Pad' });
  pad.regions = [{ ...newRegion(0, PPQ * 4), notes: [{ t: 0, d: PPQ * 4, p: 64, v: 80 }] }];
  p.tracks.push(pad);
  return p;
}

const padOf = (p: Project) => p.tracks[1]?.id as string;

describe('an inactive track', () => {
  it('is kept in the song as written, and only `true` is', () => {
    const p = song();
    const off = applyOps(p, [{ op: 'updateTrack', track: padOf(p), patch: { inactive: true } }]);
    const read = parseProject(JSON.parse(JSON.stringify(off)));
    expect(read.tracks[1]?.inactive).toBe(true);
    expect(read).toEqual(off);
    // anything but true reads as on, and isn't kept
    const odd = JSON.parse(JSON.stringify(p));
    odd.tracks[1].inactive = 'yes';
    expect('inactive' in (parseProject(odd).tracks[1] ?? {})).toBe(false);
  });

  it('switched on again, reads as if it never was off', () => {
    const p = song();
    const off = applyOps(p, [{ op: 'updateTrack', track: padOf(p), patch: { inactive: true } }]);
    const on = applyOps(off, [{ op: 'updateTrack', track: padOf(p), patch: { inactive: false } }]);
    expect('inactive' in (on.tracks[1] ?? {})).toBe(false);
    expect(JSON.stringify(on)).toBe(JSON.stringify(p));
  });

  it('is left out of the song as the engines hear it', () => {
    const p = song();
    expect(performed(p)).toBe(p);
    const off = applyOps(p, [{ op: 'updateTrack', track: padOf(p), patch: { inactive: true } }]);
    const heard = performed(off);
    expect(heard.tracks.map((t) => t.name)).toEqual(['Keys']);
    // the same objects again (an engine goes by them to send only what changed)
    expect(performed(off)).toBe(heard);
    expect(heard.tracks[0]).toBe(off.tracks[0]);
    // the song itself keeps it
    expect(off.tracks.map((t) => t.name)).toEqual(['Keys', 'Pad']);
  });

  it('is left out of a song with repeats too', () => {
    const p = song();
    p.form = [{ tick: PPQ * 4, k: 'end' }];
    const off = applyOps(p, [{ op: 'updateTrack', track: padOf(p), patch: { inactive: true } }]);
    expect(performed(off).tracks.map((t) => t.name)).toEqual(['Keys']);
  });

  it('is said in the song summary and the changes', () => {
    const p = song();
    const off = applyOps(p, [{ op: 'updateTrack', track: padOf(p), patch: { inactive: true } }]);
    expect(describeProject(off)).toMatch(/Pad .*inactive \(not heard\)/);
    expect(describeChanges(p, off)).toContain('Pad: made inactive');
    expect(describeChanges(off, p)).toContain('Pad: made active');
  });
});
