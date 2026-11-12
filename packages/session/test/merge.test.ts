import { describe, expect, it } from 'vitest';
import {
  applyOps,
  barLineAfter,
  barLineBefore,
  barToTick,
  MergeError,
  mergeOps,
  newAudioTrack,
  newBus,
  newPlugin,
  newProject,
  newRegion,
  newTrack,
  type Op,
  PPQ,
  type Project,
  parseProject,
  projectFromMidi,
  readMidi,
  type Track,
  writeMidi,
} from '../src/index.ts';

const BAR = PPQ * 4;
const BAR34 = PPQ * 3;

/** A song with a Keys track (newProject's) and a Strings track playing bars 1–16. */
function song(meter = { num: 4, den: 4 }): Project {
  const p = newProject('Song');
  p.meter = [{ tick: 0, ...meter }];
  const strings = { ...newTrack('Strings', { type: 'synth', preset: 'Warm Pad' }), id: 'trk_strings' };
  const r = { ...newRegion(0, BAR * 16, 'Pad'), id: 'rgn_pad' };
  r.notes = [{ t: 0, d: BAR * 16, p: 60, v: 70 }];
  strings.regions.push(r);
  p.tracks.push(strings);
  return p;
}

/** A file read in: one track a part, each its notes at the file's ticks (as projectFromMidi makes them). */
function file(parts: Record<string, [number, number, number][]>, tempo = [{ tick: 0, bpm: 90 }]): Project {
  const p = newProject('File');
  p.tempo = tempo;
  p.tracks = Object.entries(parts).map(([name, notes]) => {
    const t = newTrack(name, { type: 'synth', preset: 'Soft Keys' });
    const r = newRegion(0, BAR * 8, name);
    r.notes = notes.map(([t0, d, pitch]) => ({ t: t0, d, p: pitch, v: 90 }));
    t.regions = [r];
    return t;
  });
  return p;
}

const applied = (s: Project, ops: Op[]) => parseProject(applyOps(s, ops));
const added = (ops: Op[]) => ops.flatMap((o) => (o.op === 'addTrack' ? [o.track] : []));
const regions = (ops: Op[]) => ops.flatMap((o) => (o.op === 'addRegion' ? [o] : []));

describe('bringing a file into a song', () => {
  it('puts its parts on new tracks from bar N, on the song’s bar lines, with new ids', () => {
    const s = song();
    const f = file({
      Bass: [
        [0, PPQ, 40],
        [PPQ, PPQ, 43],
        [BAR, PPQ * 2, 45],
      ],
      Lead: [[BAR + PPQ, PPQ, 72]],
    });
    f.tracks[0]?.channel.inserts.push(newPlugin('eq'));
    const m = mergeOps(s, f, { at: barToTick(s.meter, 5) });
    const tracks = added(m.ops);
    expect(tracks.map((t) => t.name)).toEqual(['Bass', 'Lead']);
    expect(tracks.every((t) => t.regions.length === 0 && t.kind === 'instrument')).toBe(true);
    const [bass, lead] = regions(m.ops);
    expect(bass?.track).toBe(tracks[0]?.id);
    expect(bass?.region).toMatchObject({ start: BAR * 4, length: BAR * 2, name: 'Bass' });
    expect(bass?.region.notes.map((n) => [n.t, n.d, n.p])).toEqual([
      [0, PPQ, 40],
      [PPQ, PPQ, 43],
      [BAR, PPQ * 2, 45],
    ]);
    // the lead's one note is in the file's bar 2: its region starts on the song's bar 6
    expect(lead?.region).toMatchObject({ start: BAR * 5, length: BAR });
    expect(lead?.region.notes[0]?.t).toBe(PPQ);
    // nothing keeps the file's ids
    const theirs = new Set([
      ...f.tracks.map((t) => t.id),
      ...f.tracks.flatMap((t) => t.regions.map((r) => r.id)),
      ...f.tracks.flatMap((t) => t.channel.inserts.map((p) => p.id)),
    ]);
    const ours = [
      ...tracks.map((t) => t.id),
      ...regions(m.ops).map((r) => r.region.id),
      ...tracks.flatMap((t) => t.channel.inserts.map((p) => p.id)),
    ];
    expect(ours.some((id) => theirs.has(id))).toBe(false);
    expect(new Set(ours).size).toBe(ours.length);
    expect(m).toMatchObject({ offset: BAR * 4, tempo: 'kept' });
    expect(m.parts.map((p) => [p.part, p.notes, p.start, p.end])).toEqual([
      ['Bass', 3, BAR * 4, BAR * 6],
      ['Lead', 1, BAR * 5, BAR * 6],
    ]);
    const after = applied(s, m.ops);
    expect(after.tracks.map((t) => t.name)).toEqual(['Keys', 'Strings', 'Bass', 'Lead']);
    // the song's own is untouched
    expect(after.tracks[1]).toEqual(s.tracks[1]);
    expect(after.tempo).toEqual(s.tempo);
  });

  it('snaps to a 3/4 song’s bars, whatever the file’s were', () => {
    const s = song({ num: 3, den: 4 });
    // four 4/4 bars of notes, the first a beat in
    const f = file({
      Piano: [
        [PPQ, PPQ, 60],
        [BAR * 3, BAR, 67],
      ],
    });
    f.meter = [{ tick: 0, num: 4, den: 4 }];
    const m = mergeOps(s, f, { at: barToTick(s.meter, 3) });
    const [r] = regions(m.ops);
    // bar 3 of 3/4 is 5760; the last note ends at 5760 + 15360 = 21120, inside bar 8 (20160–23040)
    expect(r?.region.start).toBe(BAR34 * 2);
    expect(r?.region.length).toBe(BAR34 * 6);
    expect((r?.region.start ?? 0) % BAR34).toBe(0);
    expect(r?.region.notes.map((n) => n.t)).toEqual([PPQ, BAR * 3]);
    expect(m.notes).toContain("The file is in 4/4 and the song in 3/4: the notes keep their beats, in the song's bars");
    // put mid-bar, the region still starts on the bar line before
    const mid = mergeOps(s, f, { at: barToTick(s.meter, 3) + PPQ });
    expect(regions(mid.ops)[0]?.region.start).toBe(BAR34 * 2);
    expect(regions(mid.ops)[0]?.region.notes[0]?.t).toBe(PPQ * 2);
    applied(s, m.ops);
  });

  it('keeps the song’s tempo, or adopts the file’s while it runs, the song’s own coming back after', () => {
    const s = song();
    const f = file({ Bass: [[0, BAR * 4, 40]] }, [
      { tick: 0, bpm: 90 },
      { tick: BAR * 2, bpm: 100 },
    ]);
    const kept = mergeOps(s, f, { at: BAR * 4 });
    expect(kept.ops.some((o) => o.op === 'setProject')).toBe(false);
    expect(kept.notes).toContain("The file's tempo is 90; the song keeps its 120");

    const adopted = mergeOps(s, f, { at: BAR * 4, tempo: 'adopt' });
    expect(adopted.tempo).toBe('adopted');
    expect(adopted.ops[0]).toEqual({
      op: 'setProject',
      patch: {
        tempo: [
          { tick: 0, bpm: 120 },
          { tick: BAR * 4, bpm: 90 },
          { tick: BAR * 6, bpm: 100 },
          // the song goes on to bar 16: its own tempo again where the file ends
          { tick: BAR * 8, bpm: 120 },
        ],
      },
    });
    expect(applied(s, adopted.ops).tempo).toHaveLength(4);

    // a song with nothing after: the file's tempo simply carries on
    const empty = newProject('Empty');
    const fresh = mergeOps(empty, f, { at: 0, tempo: 'adopt' });
    expect(fresh.ops[0]).toEqual({
      op: 'setProject',
      patch: {
        tempo: [
          { tick: 0, bpm: 90 },
          { tick: BAR * 2, bpm: 100 },
        ],
      },
    });
  });

  it('sends only to the song’s buses (by name), and moves automation and clefs with the notes', () => {
    const s = song();
    const f = file({ Cello: [[0, BAR, 48]] });
    const reverb = newBus('reverb');
    const hall = newBus('Hall');
    f.buses = [reverb, hall];
    const cello = f.tracks[0] as Track;
    const eq = newPlugin('eq');
    cello.channel.inserts = [eq];
    cello.channel.sends = [
      { bus: reverb.id, level: -10, pre: false },
      { bus: hall.id, level: -6, pre: false },
    ];
    cello.channel.output = hall.id;
    cello.channel.automation = [
      {
        param: 'volume',
        points: [
          [0, -6],
          [BAR, 0],
        ],
        mode: 'read',
      },
      { param: `send:${hall.id}`, points: [[0, -20]], mode: 'read' },
      { param: `fx:${eq.id}:gain1`, points: [[BAR, 3]], mode: 'read' },
    ];
    cello.score = {
      clefs: [
        [0, 1, 'F'],
        [BAR, 1, 'C4'],
      ],
    };
    const m = mergeOps(s, f, { at: BAR * 8 });
    const [t] = added(m.ops);
    const songReverb = s.buses[0]?.id;
    expect(t?.channel.sends).toEqual([{ bus: songReverb, level: -10, pre: false }]);
    expect(t?.channel.output).toBe('master');
    const newEq = t?.channel.inserts[0]?.id;
    expect(newEq).not.toBe(eq.id);
    expect(t?.channel.automation).toEqual([
      {
        param: 'volume',
        points: [
          [BAR * 8, -6],
          [BAR * 9, 0],
        ],
        mode: 'read',
      },
      { param: `fx:${newEq}:gain1`, points: [[BAR * 9, 3]], mode: 'read' },
    ]);
    expect(t?.score?.clefs).toEqual([
      [0, 1, 'F'],
      [BAR * 9, 1, 'C4'],
    ]);
    expect(m.notes).toContain('Sends to "Hall" left out: the song has no such bus');
    const after = applied(s, m.ops);
    const ids = new Set(after.buses.map((b) => b.id));
    for (const tr of after.tracks) for (const send of tr.channel.sends) expect(ids.has(send.bus)).toBe(true);
  });

  it('lands a pickup just before where it’s put', () => {
    const s = song();
    const f = file({
      Tune: [
        [BAR - PPQ, PPQ, 67],
        [BAR, PPQ, 72],
      ],
    });
    f.meter = [{ tick: 0, num: 4, den: 4, pickup: PPQ }];
    const m = mergeOps(s, f, { at: BAR * 4 });
    const [r] = regions(m.ops);
    // the pickup's beat is bar 4's last; the file's bar 1 is the song's bar 5
    expect(r?.region.start).toBe(BAR * 3);
    expect(r?.region.notes.map((n) => (r?.region.start ?? 0) + n.t)).toEqual([BAR * 4 - PPQ, BAR * 4]);
    // no room before the song's start: it starts there
    const first = mergeOps(s, f, { at: 0 });
    expect(regions(first.ops)[0]?.region.start).toBe(0);
    expect(first.notes.join(' ')).toMatch(/pickup/);
  });

  it('chooses parts by name, start of a name or number, or puts one part on the song’s own track', () => {
    const s = song();
    const f = file({ 'Violin I': [[0, PPQ, 76]], 'Violin II': [[0, PPQ, 72]], Cello: [[0, PPQ, 48]], Empty: [] });
    expect(added(mergeOps(s, f, { at: 0, parts: ['cello', 1] }).ops).map((t) => t.name)).toEqual(['Violin I', 'Cello']);
    expect(added(mergeOps(s, f, { at: 0, parts: ['2'] }).ops).map((t) => t.name)).toEqual(['Violin II']);
    expect(() => mergeOps(s, f, { at: 0, parts: ['Violin'] })).toThrow(/could be "Violin I" or "Violin II"/);
    expect(() => mergeOps(s, f, { at: 0, parts: ['Flute'] })).toThrow(
      new MergeError('The file has no part "Flute". Its parts: 1 "Violin I", 2 "Violin II", 3 "Cello", 4 "Empty"'),
    );
    // every part: the empty one is left out, and said so
    const all = mergeOps(s, f, { at: 0 });
    expect(added(all.ops)).toHaveLength(3);
    expect(all.notes).toContain('"Empty" has no notes: left out');
    // one part, named, as a new track
    expect(added(mergeOps(s, f, { at: 0, parts: ['Cello'], name: 'Celli' }).ops)[0]?.name).toBe('Celli');

    // onto the song's own track: a region there, no new track
    const onto = mergeOps(s, f, { at: BAR * 2, parts: ['Cello'], into: 'trk_strings' });
    expect(added(onto.ops)).toEqual([]);
    expect(regions(onto.ops)).toMatchObject([{ track: 'trk_strings', region: { start: BAR * 2 } }]);
    expect(onto.parts[0]).toMatchObject({ added: false, name: 'Strings', part: 'Cello' });
    expect(onto.notes).toContain('It overlaps a region on "Strings"');
    applied(s, onto.ops);
    expect(() => mergeOps(s, f, { at: 0, into: 'trk_strings' })).toThrow(/3 parts can't all go on "Strings"/);
    const withAudio = song();
    withAudio.tracks.push({ ...newAudioTrack('Vox'), id: 'trk_vox' });
    expect(() => mergeOps(withAudio, f, { at: 0, parts: [3], into: 'trk_vox' })).toThrow(/"Vox" is an audio track/);
  });
});

describe('a MIDI file read as a song', () => {
  it('makes its regions on the file’s own bars (a 3/4 file’s are 3/4)', () => {
    const src = newProject('Waltz');
    src.meter = [{ tick: 0, num: 3, den: 4 }];
    const t = src.tracks[0] as Track;
    const r = newRegion(0, BAR34 * 4);
    // bar 2 to the middle of bar 3
    r.notes = [{ t: BAR34, d: BAR34 + PPQ, p: 60, v: 80 }];
    t.regions = [r];
    const back = projectFromMidi(readMidi(writeMidi(src)), 'x');
    expect(back.meter[0]).toMatchObject({ num: 3, den: 4 });
    expect(back.tracks[0]?.regions[0]).toMatchObject({ start: BAR34, length: BAR34 * 2 });
  });

  it('finds bar lines either side of a tick', () => {
    const meter = [
      { tick: 0, num: 4, den: 4 },
      { tick: BAR * 2, num: 3, den: 4 },
    ];
    expect(barLineBefore(meter, BAR + 1)).toBe(BAR);
    expect(barLineAfter(meter, BAR + 1)).toBe(BAR * 2);
    expect(barLineAfter(meter, BAR * 2)).toBe(BAR * 2);
    expect(barLineAfter(meter, BAR * 2 + 1)).toBe(BAR * 2 + BAR34);
    expect(barLineBefore(meter, BAR * 2 + BAR34 + 5)).toBe(BAR * 2 + BAR34);
  });
});
