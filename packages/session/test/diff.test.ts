import { describe, expect, it } from 'vitest';
import {
  applyOps,
  clone,
  describeChanges,
  type Note,
  newPlugin,
  newProject,
  newRegion,
  newTrack,
  type Op,
  PPQ,
  type Project,
  parseNotation,
} from '../src/index.ts';

const BAR = PPQ * 4;

/** Keys (a synth) with 8 bars of quarter notes, Bass at −6 dB with 8 bars of whole notes, a compressor on Bass. */
function song(): Project {
  const p = newProject('Song');
  const keys = p.tracks[0];
  if (!keys) throw new Error('no track');
  const keysPart = newRegion(0, 8 * BAR);
  keysPart.notes = parseNotation('C4:1 E4:1 G4:1 E4:1 | '.repeat(8), { unit: PPQ });
  keys.regions = [keysPart];
  const bass = newTrack('Bass', { type: 'synth', preset: 'Sub Bass' });
  bass.channel.volume = -6;
  bass.channel.inserts.push(newPlugin('compressor'));
  const bassPart = newRegion(0, 8 * BAR);
  bassPart.notes = parseNotation('C2:4 | F2:4 | G2:4 | C2:4 | '.repeat(2), { unit: PPQ });
  bass.regions = [bassPart];
  p.tracks.push(bass);
  return p;
}

const parts = (p: Project) => {
  const [keys, bass] = p.tracks;
  if (!keys || !bass) throw new Error('no tracks');
  return { keys, bass, keysRegion: keys.regions[0]?.id ?? '', bassRegion: bass.regions[0]?.id ?? '' };
};

/** The song, then the same song with these edits. */
function edit(make: (p: Project, ids: ReturnType<typeof parts>) => Op[]): [Project, Project] {
  const before = song();
  return [before, applyOps(before, make(before, parts(before)))];
}

describe('describeChanges', () => {
  it('says nothing when nothing changed, even in a copy', () => {
    const p = song();
    expect(describeChanges(p, p)).toEqual([]);
    expect(describeChanges(p, clone(p))).toEqual([]);
    // an edit and its undo is no change
    const { keys } = parts(p);
    const there = applyOps(p, [{ op: 'updateChannel', target: keys.id, patch: { volume: -3 } }]);
    const back = applyOps(there, [{ op: 'updateChannel', target: keys.id, patch: { volume: 0 } }]);
    expect(describeChanges(p, back)).toEqual([]);
  });

  it('tells the song’s tempo, meter and key', () => {
    const [a, b] = edit(() => [
      {
        op: 'setProject',
        patch: {
          title: 'Song 2',
          tempo: [
            { tick: 0, bpm: 96 },
            { tick: 12 * BAR, bpm: 140 },
          ],
          meter: [{ tick: 0, num: 3, den: 4 }],
          key: 'E minor',
        },
      },
    ]);
    const lines = describeChanges(a, b);
    expect(lines.slice(0, 5)).toEqual([
      'Title "Song" → "Song 2"',
      'Tempo 120 → 96 bpm',
      // bars are counted in the new meter: 12 bars of 4/4 are 16 of 3/4
      'Tempo changes: 140 bpm added at bar 17',
      'Meter 4/4 → 3/4',
      'Key set to E minor',
    ]);
  });

  it('tells tracks added, removed and renamed, and an instrument changed', () => {
    const strings = newTrack('Strings', { type: 'sampler', pack: 'spitfire', name: 'violins' });
    const part = newRegion(4 * BAR, 4 * BAR);
    part.notes = parseNotation('A4:4 | B4:4', { unit: PPQ });
    strings.regions = [part];
    const [a, b] = edit((_, { keys, bass }) => [
      { op: 'removeTrack', track: bass.id },
      { op: 'addTrack', track: strings },
      { op: 'updateTrack', track: keys.id, patch: { name: 'Piano', armed: false } },
      { op: 'updateTrack', track: keys.id, patch: { instrument: { type: 'sampler', pack: 'grand', name: 'piano' } } },
    ]);
    expect(describeChanges(a, b)).toEqual([
      'Removed track Bass (8 notes, bars 1–8)',
      'Track "Keys" renamed "Piano"',
      'Piano: instrument synth "Soft Keys" → grand/piano',
      'Added track Strings: spitfire/violins (2 notes, bars 5–8)',
    ]);
  });

  it('tells the track order changed', () => {
    const [a, b] = edit((_, { bass }) => [{ op: 'moveTrack', track: bass.id, index: 0 }]);
    expect(describeChanges(a, b)).toEqual(['Track order changed']);
  });

  it('tells the mix: volume, pan, mute and sends', () => {
    const [a, b] = edit((p, { keys, bass }) => [
      { op: 'updateChannel', target: bass.id, patch: { volume: -8.5, pan: -0.5, mute: true } },
      { op: 'updateChannel', target: keys.id, patch: { sends: [] } },
      { op: 'updateChannel', target: 'master', patch: { volume: 1.5 } },
      { op: 'updateChannel', target: p.buses[0]?.id ?? '', patch: { solo: true } },
    ]);
    expect(describeChanges(a, b)).toEqual([
      'Keys: send to Reverb removed',
      'Bass: volume −6.0 → −8.5 dB; pan center → left 32; muted',
      'Reverb: soloed',
      'Master: volume 0.0 → +1.5 dB',
    ]);
  });

  it('tells plugins added, removed, bypassed and set', () => {
    const harmonizer = newPlugin('harmonizer');
    const eq = newPlugin('eq');
    const [a, b] = edit((p, { keys, bass }) => [
      { op: 'addPlugin', target: keys.id, slot: 'midiFx', plugin: harmonizer },
      { op: 'addPlugin', target: bass.id, slot: 'inserts', plugin: eq },
      { op: 'removePlugin', target: 'master', plugin: p.master.inserts[0]?.id ?? '' },
    ]);
    expect(describeChanges(a, b)).toEqual([
      'Keys: added Harmonizer',
      'Bass: added Channel EQ',
      'Master: removed Limiter',
    ]);
    const c = applyOps(b, [
      {
        op: 'updatePlugin',
        target: b.tracks[1]?.id ?? '',
        plugin: eq.id,
        patch: { params: { lsGain: 3, b2Gain: -2 } },
      },
      {
        op: 'updatePlugin',
        target: b.tracks[1]?.id ?? '',
        plugin: b.tracks[1]?.channel.inserts[0]?.id ?? '',
        patch: { params: { ratio: 4 }, bypass: true },
      },
    ]);
    expect(describeChanges(b, c)).toEqual([
      'Bass: Compressor bypassed; Compressor Ratio 3.0:1 → 4.0:1; Channel EQ settings changed',
    ]);
  });

  it('tells automation lanes added, changed and removed', () => {
    const [a, b] = edit((_, { keys }) => [
      {
        op: 'setAutomation',
        target: keys.id,
        param: 'volume',
        points: [
          [0, -24],
          [4 * BAR, 0],
        ],
      },
    ]);
    expect(describeChanges(a, b)).toEqual(['Keys automation: Volume added (2 points)']);
    const keys = b.tracks[0]?.id ?? '';
    const c = applyOps(b, [
      {
        op: 'setAutomation',
        target: keys,
        param: 'volume',
        points: [
          [0, -24],
          [8 * BAR, 0],
        ],
      },
      { op: 'setAutomation', target: keys, param: 'pan', points: [[0, 0.5]] },
    ]);
    expect(describeChanges(b, c)).toEqual(['Keys automation: Volume changed in bars 5–9; Pan added (1 point)']);
    expect(describeChanges(c, a)).toEqual(['Keys automation: Volume removed; Pan removed']);
  });

  it('tells a region moved and resized, and the notes that moved with it', () => {
    const [a, b] = edit((_, { bass, bassRegion }) => [
      { op: 'updateRegion', track: bass.id, region: bassRegion, patch: { start: 12 * BAR } },
    ]);
    expect(describeChanges(a, b)).toEqual([
      'Bass: region at bar 1 moved to bar 13',
      'Bass bars 1–8: 8 removed',
      'Bass bars 13–20: 8 added',
    ]);
    const [c, d] = edit((_, { keys, keysRegion }) => [
      { op: 'updateRegion', track: keys.id, region: keysRegion, patch: { length: 4 * BAR, muted: true } },
    ]);
    expect(describeChanges(c, d)).toEqual(['Keys: region at bar 1 resized from 8 bars to 4 bars; muted']);
  });

  it('tells notes added, removed and changed, bar by bar', () => {
    const [a, b] = edit((p, { keys, keysRegion }) => {
      const notes = p.tracks[0]?.regions[0]?.notes.map((n) => ({ ...n })) ?? [];
      // bar 2: the first note longer, the second louder; bar 3: the third gone; bar 4: two more on top
      const at = (bar: number, beat: number) => notes.find((n) => n.t === (bar - 1) * BAR + (beat - 1) * PPQ) as Note;
      at(2, 1).d = PPQ * 2;
      at(2, 2).v = 120;
      const gone = at(3, 3);
      const extra: Note[] = [
        { t: 3 * BAR, d: PPQ, p: 72, v: 90 },
        { t: 3 * BAR + PPQ, d: PPQ, p: 76, v: 90 },
      ];
      return [
        { op: 'setNotes', track: keys.id, region: keysRegion, notes: [...notes.filter((n) => n !== gone), ...extra] },
      ];
    });
    expect(describeChanges(a, b)).toEqual(['Keys bars 2–4: 2 added, 1 removed, 2 changed']);

    // a few changes are named, in the naming asked for
    const [c, d] = edit((_, { keys, keysRegion }) => [
      { op: 'addNotes', track: keys.id, region: keysRegion, notes: [{ t: 8 * BAR - PPQ, d: PPQ, p: 60, v: 90 }] },
    ]);
    expect(describeChanges(c, d)).toEqual(['Keys bar 8: C4 added']);
    expect(describeChanges(c, d, { middleC: 'C3' })).toEqual(['Keys bar 8: C3 added']);
  });

  it('keeps bars far apart on their own lines', () => {
    const [a, b] = edit((p, { keys, keysRegion }) => {
      const notes = (p.tracks[0]?.regions[0]?.notes ?? []).filter((n) => n.t !== 0 && n.t !== 7 * BAR);
      return [{ op: 'setNotes', track: keys.id, region: keysRegion, notes }];
    });
    expect(describeChanges(a, b)).toEqual(['Keys bar 1: C4 removed', 'Keys bar 8: C4 removed']);
  });

  it('stops at the most lines asked for and says how many more', () => {
    const [a, b] = edit((_, { keys }) => [
      { op: 'setProject', patch: { title: 'New' } },
      ...Array.from({ length: 30 }, (_, i): Op => ({ op: 'addTrack', track: newTrack(`T${i}`, { type: 'none' }) })),
      { op: 'updateChannel', target: keys.id, patch: { volume: -3 } },
    ]);
    const lines = describeChanges(a, b);
    expect(lines).toHaveLength(20);
    expect(lines[0]).toBe('Title "Song" → "New"');
    expect(lines[19]).toBe('…and 13 more changes');
    expect(describeChanges(a, b, { max: 3 })).toEqual([
      'Title "Song" → "New"',
      'Added track T0: no instrument (empty)',
      '…and 30 more changes',
    ]);
  });

  it('is quick on a big song', () => {
    const p = song();
    const keys = p.tracks[0];
    if (!keys) throw new Error('no track');
    const big = newRegion(0, 1250 * BAR);
    big.notes = Array.from({ length: 5000 }, (_, i) => ({ t: i * PPQ, d: PPQ, p: 48 + (i % 24), v: 90 }));
    keys.regions = [big];
    // every tenth note louder, every hundredth gone, a few new ones
    const notes = big.notes
      .filter((_, i) => i % 100 !== 50)
      .map((n, i) => (i % 10 === 0 ? { ...n, v: 100 } : n))
      .concat(Array.from({ length: 20 }, (_, i) => ({ t: i * 200 * PPQ + PPQ / 2, d: PPQ, p: 90, v: 90 })));
    const after = applyOps(p, [{ op: 'setNotes', track: keys.id, region: big.id, notes }]);
    const start = performance.now();
    const lines = describeChanges(p, after, { max: 1000 });
    const elapsed = performance.now() - start;
    expect(elapsed).toBeLessThan(100);
    // its first places in full, the rest summed up: 20 added, 50 removed, 495 changed in all
    expect(lines).toEqual([
      'Keys bars 1–3: C3 louder, F#6 added, A#3 louder',
      'Keys bars 6–8: G#4 louder, F#3 louder',
      'Keys bars 11–13: E4 louder, D3 removed, D#3 louder',
      'Keys bars 16–1248 (219 more places): 19 added, 49 removed, 489 changed',
    ]);
    const same = performance.now();
    expect(describeChanges(p, clone(p))).toEqual([]);
    expect(performance.now() - same).toBeLessThan(100);
  });
});
