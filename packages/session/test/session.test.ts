import { describe, expect, it } from 'vitest';
import {
  applyOps,
  barToTick,
  describeNotes,
  describeProject,
  formatNotation,
  newAudioTrack,
  newProject,
  newRegion,
  noteName,
  PPQ,
  parseNotation,
  parseNoteName,
  parsePosition,
  parseProject,
  projectFromMidi,
  readMidi,
  secondsToTick,
  tickToBarBeat,
  tickToSeconds,
  writeMidi,
} from '../src/index.ts';

describe('time', () => {
  const tempo = [
    { tick: 0, bpm: 120 },
    { tick: PPQ * 4, bpm: 60 },
  ];
  it('converts ticks and seconds through tempo changes', () => {
    expect(tickToSeconds(tempo, PPQ * 4)).toBeCloseTo(2);
    expect(tickToSeconds(tempo, PPQ * 5)).toBeCloseTo(3);
    expect(secondsToTick(tempo, 3)).toBeCloseTo(PPQ * 5);
    expect(secondsToTick(tempo, 1)).toBeCloseTo(PPQ * 2);
  });
  it('counts bars through meter changes', () => {
    const meter = [
      { tick: 0, num: 4, den: 4 },
      { tick: PPQ * 8, num: 7, den: 8 },
    ];
    expect(barToTick(meter, 3)).toBe(PPQ * 8);
    expect(barToTick(meter, 4)).toBe(PPQ * 8 + PPQ * 3.5);
    expect(tickToBarBeat(meter, PPQ * 8 + PPQ / 2)).toEqual({ bar: 3, beat: 2, div: 1, tick: 0 });
    expect(parsePosition(meter, '2.3')).toBe(PPQ * 6);
    expect(parsePosition(meter, 't:123')).toBe(123);
  });
});

describe('notation', () => {
  it('names notes both ways, in either middle-C convention', () => {
    expect(noteName(60)).toBe('C4');
    expect(noteName(60, 'C3')).toBe('C3');
    expect(parseNoteName('F#5')).toBe(78);
    expect(parseNoteName('Bb3')).toBe(58);
    expect(parseNoteName('C3', 'C3')).toBe(60);
  });
  it('parses the motif, chords, rests, ties and accents', () => {
    const notes = parseNotation('D5:1 | B5:2 A5:1! F#5:1? A5:2~ A5:1 r:1 (D4 F#4 A4):2@64', { unit: 480 });
    expect(notes.map((n) => [n.t, n.d, n.p])).toEqual([
      [0, 480, 74],
      [480, 960, 83],
      [1440, 480, 81],
      [1920, 480, 78],
      [2400, 1440, 81],
      [4320, 960, 62],
      [4320, 960, 66],
      [4320, 960, 69],
    ]);
    expect(notes[2]?.v).toBe(110);
    expect(notes[3]?.v).toBe(55);
    expect(notes[5]?.v).toBe(64);
  });
  it('writes notes back to the notation', () => {
    const text = 'D5:1 B5:2 r:1 (D4 A4):2';
    expect(formatNotation(parseNotation(text, { unit: 480 }), 480)).toBe(text);
  });
});

describe('operations', () => {
  it('edits a track and marks a creation’s voice as edited', () => {
    const project = newProject('Test');
    const track = project.tracks[0];
    if (!track) throw new Error('no track');
    track.origin = { voice: 'bass', edited: false };
    const region = newRegion(0, PPQ * 4);
    const next = applyOps(project, [
      { op: 'addRegion', track: track.id, region },
      { op: 'addNotes', track: track.id, region: region.id, notes: parseNotation('C4:1 E4:1', { unit: PPQ }) },
      { op: 'updateChannel', target: track.id, patch: { volume: -6 } },
    ]);
    const t = next.tracks[0];
    expect(t?.regions[0]?.notes).toHaveLength(2);
    expect(t?.channel.volume).toBe(-6);
    expect(t?.origin?.edited).toBe(true);
    expect(project.tracks[0]?.regions).toHaveLength(0);
    expect(describeProject(next)).toContain('2 notes');
    expect(describeNotes(next, t as NonNullable<typeof t>)).toContain('1.2.1.0  E4 (64)');
  });
});

describe('MIDI files and validation', () => {
  it('round-trips a session through a MIDI file', () => {
    const project = newProject('Round trip');
    project.tempo = [{ tick: 0, bpm: 72 }];
    const track = project.tracks[0];
    if (!track) throw new Error('no track');
    const region = newRegion(PPQ * 4, PPQ * 4);
    region.notes = parseNotation('A4:1 C#5:1 E5:2', { unit: PPQ, velocity: 80 });
    region.cc = {
      '64': [
        [0, 127],
        [PPQ * 3, 0],
      ],
      pb: [[PPQ, 4096]],
    };
    track.regions = [region];
    const back = projectFromMidi(readMidi(writeMidi(project)), 'x');
    expect(back.title).toBe('Round trip');
    expect(back.tempo[0]?.bpm).toBe(72);
    const notes = back.tracks[0]?.regions[0];
    expect(notes?.start).toBe(PPQ * 4);
    expect(notes?.notes.map((n) => [n.t, n.d, n.p, n.v])).toEqual([
      [0, PPQ, 69, 80],
      [PPQ, PPQ, 73, 80],
      [PPQ * 2, PPQ * 2, 76, 80],
    ]);
    expect(notes?.cc['64']).toEqual([
      [0, 127],
      [PPQ * 3, 0],
    ]);
    expect(notes?.cc.pb).toEqual([[PPQ, 4096]]);
  });
  it('accepts its own sessions and rejects other JSON', () => {
    const project = newProject('Valid');
    expect(parseProject(JSON.parse(JSON.stringify(project)))).toEqual(project);
    expect(() => parseProject({ format: 'something' })).toThrow(/Not a HO\[LO\] session/);
  });
});

describe('automation', () => {
  it('sets, interpolates and clears a lane through operations', async () => {
    const { applyOp, automationAt, automationTargets, findLane, newPlugin } = await import('../src/index.ts');
    let project = newProject('Auto');
    const track = project.tracks[0];
    if (!track) throw new Error('no track');
    const reverb = newPlugin('reverb');
    project = applyOp(project, { op: 'addPlugin', target: track.id, slot: 'inserts', plugin: reverb });
    project = applyOp(project, {
      op: 'setAutomation',
      target: track.id,
      param: 'volume',
      points: [
        [PPQ * 4, 0],
        [0, -24],
      ],
    });
    const lane = findLane(project.tracks[0]?.channel ?? track.channel, 'volume');
    expect(lane?.points).toEqual([
      [0, -24],
      [PPQ * 4, 0],
    ]);
    expect(lane?.mode).toBe('read');
    expect(automationAt(lane ?? { points: [] }, PPQ * 2)).toBeCloseTo(-12);
    expect(automationAt(lane ?? { points: [] }, PPQ * 8)).toBe(0);
    expect(
      automationAt(
        {
          points: [
            [0, 0],
            [PPQ, 1],
          ],
        },
        PPQ / 2,
        true,
      ),
    ).toBe(0);
    const targets = automationTargets(project, project.tracks[0]?.channel ?? track.channel).map((t) => t.param);
    expect(targets).toContain(`fx:${reverb.id}:mix`);
    expect(targets).toContain('volume');
    project = applyOp(project, { op: 'setAutomation', target: track.id, param: 'volume', points: [] });
    expect(project.tracks[0]?.channel.automation).toEqual([]);
  });
});

describe('audio tracks', () => {
  it('keeps recordings, regions that play them and the input through a save', () => {
    let p = newProject('Takes');
    const track = newAudioTrack('Vocal');
    const region = newRegion(PPQ * 4, PPQ * 8, 'Vocal #01');
    region.audio = { file: 'aud_abc', offset: 0.25, gain: -3, fadeIn: 0.01, fadeOut: 0.5, stretch: 1.5 };
    p = applyOps(p, [
      { op: 'addTrack', track },
      { op: 'addFile', file: { id: 'aud_abc', name: 'Vocal #01.wav', seconds: 12, rate: 48000, channels: 1 } },
      { op: 'addFile', file: { id: 'aud_abc', name: 'again', seconds: 1, rate: 44100, channels: 2 } },
      { op: 'addRegion', track: track.id, region },
    ]);
    expect(p.files).toHaveLength(1);
    const back = parseProject(JSON.parse(JSON.stringify(p)));
    const t = back.tracks.find((x) => x.id === track.id);
    expect(t?.kind).toBe('audio');
    expect(t?.audioInput).toEqual({ input: 0, channels: 1, monitor: false });
    expect(t?.regions[0]?.audio).toEqual(region.audio);
    expect(back.files?.[0]?.name).toBe('Vocal #01.wav');
    const text = describeProject(back);
    expect(text).toContain('audio track (input 1)');
    expect(text).toContain('"Vocal #01.wav" (from 0.25 s, -3.0 dB, stretched ×1.500');
  });

  it('clamps a stretch out of range when reading', () => {
    const p = newProject('x');
    const track = { ...newAudioTrack('A'), regions: [{ ...newRegion(0, PPQ), audio: { file: 'f', stretch: 9 } }] };
    const back = parseProject(JSON.parse(JSON.stringify({ ...p, tracks: [track] })));
    expect(back.tracks[0]?.regions[0]?.audio?.stretch).toBe(4);
    expect(back.tracks[0]?.regions[0]?.audio?.gain).toBe(0);
  });
});
