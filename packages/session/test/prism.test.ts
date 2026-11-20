import { describe, expect, it } from 'vitest';
import {
  applyOps,
  checkSound,
  newProject,
  type PackSound,
  PER_FX,
  PER_SOURCE,
  PRISM_EFFECTS,
  PRISM_MOD_SOURCES,
  PRISM_MOD_TARGETS,
  PRISM_SOUNDS,
  prismKey,
  prismTargetName,
  SRC_MACRO,
  SRC_SEQ,
  SYNTH_FAMILIES,
  SYNTH_MACROS,
  SYNTH_NOTES,
  SYNTH_PRESETS,
  soundTrack,
  synthParam,
  TGT_ENV_TIME,
  TGT_FX,
  TGT_LFO_RATE,
  TGT_VOICE,
} from '../src/index.ts';

describe("Prism's patch format", () => {
  it('reads every kind of key, with its part, number and range', () => {
    expect(prismKey('s3:coarse')).toMatchObject({ part: 'src', index: 2, field: 'coarse', min: -48, max: 48 });
    expect(prismKey('s1:kind')).toMatchObject({ part: 'src', index: 0, min: 0, max: 3 });
    expect(prismKey('f2:type')).toMatchObject({ part: 'flt', index: 1, field: 'type' });
    expect(prismKey('f:serial')).toMatchObject({ part: 'flt', index: -1, field: 'serial' });
    expect(prismKey('xy:x')).toMatchObject({ part: 'xy', field: 'x', min: 0, max: 1 });
    expect(prismKey('lfo8:beats')).toMatchObject({ part: 'lfo', index: 7, field: 'beats' });
    expect(prismKey('env4:rc')).toMatchObject({ part: 'env', index: 3, field: 'rc', min: -1, max: 1 });
    expect(prismKey('shape2:x15')).toMatchObject({ part: 'shape', index: 1, field: 'x', sub: 15 });
    expect(prismKey('shape2:loop')).toMatchObject({ part: 'shape', field: 'loop', sub: -1 });
    expect(prismKey('curve8:c3')).toMatchObject({ part: 'curve', index: 7, field: 'c', sub: 3 });
    expect(prismKey('seq1:v31')).toMatchObject({ part: 'seq', field: 'v', sub: 31 });
    expect(prismKey('seq4:t0')).toMatchObject({ part: 'seq', index: 3, field: 't', sub: 0 });
    expect(prismKey('mod32:dst')).toMatchObject({ part: 'mod', index: 31, max: PRISM_MOD_TARGETS.length - 1 });
    expect(prismKey('mod1:src')).toMatchObject({ max: PRISM_MOD_SOURCES.length - 1 });
    expect(prismKey('fx6:decay')).toMatchObject({ part: 'fx', index: 5, field: 'decay' });
    expect(prismKey('ctl10')).toMatchObject({ part: 'ctl', index: 9 });
    expect(prismKey('w4:1023')).toMatchObject({ part: 'wave', index: 3, sub: 1023, min: -1, max: 1 });
    expect(prismKey('l2:63')).toMatchObject({ part: 'lshape', index: 1, sub: 63 });
    expect(prismKey('voice:glide')).toMatchObject({ part: 'voice', field: 'glide', min: 0, max: 10 });
    expect(prismKey('patch:blank')).toMatchObject({ part: 'patch', field: 'blank' });
  });

  it('knows nothing that is not a key', () => {
    for (const id of [
      'm1',
      's0:on',
      's5:on',
      's1:shade',
      'f3:type',
      'lfo9:rate',
      'env5:a',
      'shape1:x16',
      'curve9:n',
      'seq1:v32',
      'mod33:src',
      'fx7:mix',
      'fx1:nonsense',
      'ctl0',
      'ctl11',
      'w5:0',
      'w1:1024',
      'l1:64',
      'op1:ratio',
    ])
      expect(prismKey(id), id).toBeNull();
  });

  it('numbers its matrix: each source its sixteen targets, then the voice, the LFO rates, envelope times and effects', () => {
    expect(PER_SOURCE).toBe(16);
    expect(TGT_VOICE).toBe(4 * PER_SOURCE);
    expect(PRISM_MOD_TARGETS[TGT_LFO_RATE]?.name).toBe('LFO 1 rate');
    expect(PRISM_MOD_TARGETS[TGT_ENV_TIME + 4]?.name).toBe('Env 2 decay');
    expect(PRISM_MOD_TARGETS[TGT_FX]?.name).toBe('Effect 1 mix');
    expect(PRISM_MOD_TARGETS.length).toBe(TGT_FX + 6 * PER_FX);
    expect(PRISM_MOD_TARGETS[3]?.name).toBe('Source 1 position');
    expect(PRISM_MOD_TARGETS[PER_SOURCE * 2]?.name).toBe('Source 3 level');
    expect(PRISM_MOD_SOURCES[SRC_MACRO]).toBe('Macro 1');
    expect(PRISM_MOD_SOURCES[SRC_SEQ + 3]).toBe('Steps 4');
    // an effect's settings named for what's in its slot
    const types = [0, PRISM_EFFECTS.indexOf('Band')];
    expect(prismTargetName(TGT_FX + PER_FX + 1, types)).toBe('Band 2 low');
    expect(prismTargetName(TGT_FX + PER_FX, types)).toBe('Band 2 mix');
  });
});

describe("Prism's sounds", () => {
  it('are built-in synths, each in one family, with six knobs of their own at the middle, and a note', () => {
    expect(PRISM_SOUNDS.length).toBeGreaterThanOrEqual(14);
    for (const name of PRISM_SOUNDS) {
      expect(SYNTH_PRESETS as readonly string[]).toContain(name);
      expect(SYNTH_FAMILIES.filter((f) => f.presets.includes(name)).length, name).toBe(1);
      const knobs = SYNTH_MACROS[name] ?? [];
      expect(knobs.map((k) => k.id)).toEqual(['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
      expect(knobs.map((k) => k.default)).toEqual([0.5, 0.5, 0.5, 0.5, 0.5, 0.5]);
      expect(new Set(knobs.map((k) => k.name)).size, name).toBe(6);
      expect(SYNTH_NOTES[name], name).toBeTruthy();
    }
  });

  it('take their knobs and the keys of a whole patch; other synths take neither', () => {
    expect(synthParam('Pulse Bells', 'm3')).toMatchObject({ min: 0, max: 1 });
    expect(synthParam('Pulse Bells', 's2:coarse')).toMatchObject({ min: -48, max: 48 });
    expect(synthParam('Bright Tines', 's2:coarse')).toBeNull();
    expect(synthParam('Pulse Bells', 'op1:ratio')).toBeNull();
  });

  it('a palette sound may carry a whole patch: checked key by key, then played as written', () => {
    const params = {
      'patch:blank': 1,
      's1:kind': 1,
      's1:data': 3,
      's2:on': 1,
      's2:wave': 2,
      's2:count': 5,
      'mod1:src': SRC_MACRO,
      'mod1:dst': 3,
      'mod1:depth': 0.4,
      'fx1:type': 6,
      'fx1:mix': 0.3,
      'w1:0': 0,
      'w1:1': 1,
      'w1:2': 0,
      'w1:3': -1,
      m2: 0.8,
    };
    const sound: PackSound = { name: 'Two Sources', family: 'Synths', instrument: { synth: 'Drift Pad', params } };
    expect(checkSound(sound)).toEqual({ missing: [], problems: [] });
    const project = newProject('Test');
    const { ops, track } = soundTrack(project, sound);
    const after = applyOps(project, ops);
    expect(after.tracks.find((t) => t.id === track.id)?.instrument).toEqual({
      type: 'synth',
      preset: 'Drift Pad',
      params,
    });
    const bad = checkSound({
      name: 'Bad',
      family: 'Synths',
      instrument: { synth: 'Drift Pad', params: { 's1:count': 65 } },
    });
    expect(bad.problems).toEqual(["the Drift Pad synth's s1:count is 65, outside 1…64"]);
  });
});
