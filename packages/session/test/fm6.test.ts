import { describe, expect, it } from 'vitest';
import {
  applyOps,
  checkSound,
  FM6_SOUNDS,
  fm6Key,
  newProject,
  type PackSound,
  SYNTH_FAMILIES,
  SYNTH_MACROS,
  SYNTH_NOTES,
  SYNTH_PRESETS,
  soundTrack,
  synthParam,
} from '../src/index.ts';

describe('the six-operator patch format', () => {
  it('reads every kind of key, with its part, number and range', () => {
    expect(fm6Key('op3:ratio')).toMatchObject({ part: 'op', index: 2, field: 'ratio', min: 0, max: 64 });
    expect(fm6Key('op6:kv2')).toMatchObject({ part: 'op', index: 5, field: 'kv', sub: 2 });
    expect(fm6Key('mod:2>1')).toMatchObject({ part: 'mod', index: 1, sub: 0 });
    expect(fm6Key('mod:4>4')).toMatchObject({ part: 'mod', index: 3, sub: 3 });
    expect(fm6Key('mod:f>6')).toMatchObject({ part: 'mod', index: 6, sub: 5 });
    expect(fm6Key('env1:t7')).toMatchObject({ part: 'env', index: 0, field: 't', sub: 7, min: 0, max: 600 });
    expect(fm6Key('envf:sus')).toMatchObject({ part: 'env', index: 6, field: 'sus' });
    expect(fm6Key('envp:l0')).toMatchObject({ part: 'env', index: 7, field: 'l', sub: 0 });
    expect(fm6Key('flt:cutoff')).toMatchObject({ part: 'flt', field: 'cutoff', min: 20, max: 20000 });
    expect(fm6Key('flt:k3')).toMatchObject({ part: 'flt', field: 'k', sub: 3 });
    expect(fm6Key('fx:tap2')).toMatchObject({ part: 'fx', field: 'tap', sub: 1 });
    expect(fm6Key('fx:rate4')).toMatchObject({ part: 'fx', field: 'rate', sub: 3 });
    expect(fm6Key('fx:rate')).toMatchObject({ part: 'fx', field: 'rate', sub: -1 });
    expect(fm6Key('lfo:cutoff')).toMatchObject({ part: 'lfo', field: 'cutoff' });
    expect(fm6Key('uni:voices')).toMatchObject({ part: 'uni', min: 1, max: 8 });
    expect(fm6Key('patch:blank')).toMatchObject({ part: 'patch', field: 'blank' });
    expect(fm6Key('w4:1023')).toMatchObject({ part: 'wave', index: 3, sub: 1023, min: -1, max: 1 });
  });

  it('knows nothing that is not a key', () => {
    for (const id of [
      'brightness',
      'op7:ratio',
      'op0:ratio',
      'op1:shade',
      'op1:k4',
      'mod:7>1',
      'mod:1>f',
      'env9:t0',
      'env1:t8',
      'fx:tap5',
      'w5:0',
      'w1:1024',
      'w1:x',
      'lfo:depth',
      'voice:longest',
      'mic:room',
    ])
      expect(fm6Key(id), id).toBeNull();
  });

  it("is each six-operator sound's, besides its knobs; other synths take only their knobs", () => {
    expect(synthParam('Bright Tines', 'brightness')).toMatchObject({ min: 0, max: 2 });
    expect(synthParam('Bright Tines', 'op1:ratio')).toMatchObject({ min: 0, max: 64 });
    expect(synthParam('FM Keys', 'op1:ratio')).toBeNull();
    expect(synthParam('Bright Tines', 'op1:nonsense')).toBeNull();
  });
});

describe('the six-operator sounds', () => {
  it('are built-in synths, each in one family, with six knobs at 1× and a note', () => {
    for (const name of FM6_SOUNDS) {
      expect(SYNTH_PRESETS as readonly string[]).toContain(name);
      expect(SYNTH_FAMILIES.filter((f) => f.presets.includes(name)).length, name).toBe(1);
      expect(SYNTH_MACROS[name]?.map((k) => k.default)).toEqual([1, 1, 1, 1, 1, 1]);
      expect(SYNTH_NOTES[name], name).toBeTruthy();
    }
  });

  it('a palette sound may carry a whole patch: checked key by key, then played as written', () => {
    const params = {
      'patch:blank': 1,
      'op1:on': 1,
      'op1:out': 1,
      'op2:on': 1,
      'op2:ratio': 14,
      'mod:2>1': 1.5,
      'env2:t1': 0.4,
      'w1:0': 0,
      'w1:1': 1,
      'w1:2': 0,
      'w1:3': -1,
      brightness: 1.2,
    };
    const sound: PackSound = { name: 'Two Operators', family: 'Keys', instrument: { synth: 'Bright Tines', params } };
    expect(checkSound(sound)).toEqual({ missing: [], problems: [] });
    const project = newProject('Test');
    const { ops, track } = soundTrack(project, sound);
    const after = applyOps(project, ops);
    const inst = after.tracks.find((t) => t.id === track.id)?.instrument;
    expect(inst).toEqual({ type: 'synth', preset: 'Bright Tines', params });
  });

  it('a patch key out of range, or one that is not a key, is a problem', () => {
    const bad = (params: Record<string, number>, synth = 'Bright Tines') =>
      checkSound({ name: 'Bad', family: 'Keys', instrument: { synth, params } }).problems;
    expect(bad({ 'op1:ratio': 65 })).toEqual(["the Bright Tines synth's op1:ratio is 65, outside 0…64"]);
    expect(bad({ 'mod:1>2': -40 })).toHaveLength(1);
    expect(bad({ 'op1:shade': 1 })).toEqual(['the Bright Tines synth has no "op1:shade"']);
    // the FM Keys synth takes no patch
    expect(bad({ 'op1:ratio': 2 }, 'FM Keys')).toEqual(['the FM Keys synth has no "op1:ratio"']);
  });
});
