/**
 * Editing, arranging, automating and the song's details: the regions and timeline tools, automate's
 * list, show and plugin references, fx's move and its key, song_set's artist and album, and the new
 * operations through ops_apply.
 */

import {
  newPlugin,
  newProject,
  newRegion,
  newTrack,
  PLUGINS,
  PPQ,
  type Project,
  parseProject,
  type Region,
  SCALES,
  type Track,
  tickToSeconds,
} from '@holo/session';
import { describe, expect, it } from 'vitest';
import { type FakeJobApi, type FakeJobApiOptions, fakeJobApi } from '../src/api.ts';
import { BAR, call, lastOps, refused } from './helpers.ts';

/**
 * Piano (MIDI: "Riff" bars 1–4 with notes and a mod-wheel lane, "Tag" bar 9), Vocal (audio: "Take"
 * bars 5–8, 20 s into its recording), Pad (empty); EQ, EQ, Reverb and Delay on the Vocal. 92 bpm, D minor.
 */
function editSong(): Project {
  const p = newProject('Edits');
  p.key = 'D minor';
  p.tempo = [{ tick: 0, bpm: 92 }];
  p.files = [{ id: 'aud_take', name: 'Take 3.wav', seconds: 90, rate: 48000, channels: 1 }];
  p.markers = [{ id: 'mrk_chorus', tick: 8 * BAR, name: 'Chorus' }];
  const piano: Track = { ...newTrack('Piano', { type: 'synth', preset: 'Soft Keys' }), id: 'trk_piano' };
  const riff: Region = { ...newRegion(0, 4 * BAR, 'Riff'), id: 'rgn_riff' };
  riff.notes = [
    { t: 10, d: PPQ, p: 62, v: 100 },
    { t: PPQ + 130, d: PPQ, p: 65, v: 80 },
    { t: 2 * BAR + 470, d: PPQ, p: 69, v: 60 },
  ];
  riff.cc = {
    '1': [
      [0, 0],
      [BAR, 64],
    ],
  };
  const tag: Region = { ...newRegion(8 * BAR, BAR, 'Tag'), id: 'rgn_tag' };
  tag.notes = [{ t: 0, d: PPQ, p: 74, v: 90 }];
  piano.regions = [riff, tag];
  const vocal: Track = { ...newTrack('Vocal', { type: 'none' }), id: 'trk_vocal', kind: 'audio' };
  const take: Region = { ...newRegion(4 * BAR, 4 * BAR, 'Take'), id: 'rgn_take' };
  take.audio = { file: 'aud_take', offset: 20, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
  vocal.regions = [take];
  vocal.channel.inserts = [
    { ...newPlugin('eq'), id: 'fx_eq1' },
    { ...newPlugin('eq'), id: 'fx_eq2' },
    { ...newPlugin('reverb'), id: 'fx_verb' },
    { ...newPlugin('delay'), id: 'fx_delay' },
  ];
  const pad: Track = { ...newTrack('Pad', { type: 'synth', preset: 'Warm Pad' }), id: 'trk_pad' };
  p.tracks = [piano, vocal, pad];
  return parseProject(p);
}

const setup = (options: FakeJobApiOptions = {}): FakeJobApi => fakeJobApi(editSong(), options);
const regionOf = (api: FakeJobApi, id: string) =>
  api.project.tracks.flatMap((t) => t.regions).find((r) => r.id === id) as Region;
const trackOf = (api: FakeJobApi, id: string) => api.project.tracks.find((t) => t.id === id) as Track;

describe('regions', () => {
  it('shows a track’s regions, and one in detail with its lanes', async () => {
    const api = setup();
    const list = await call(api, 'regions', { action: 'show', track: 'Piano' });
    expect(list.text).toContain('"Riff" [rgn_riff] on Piano, 1 to 5 (bars 1–4), 3 notes');
    expect(list.text).toContain('"Tag" [rgn_tag]');
    const one = await call(api, 'regions', { action: 'show', region: 'Take' });
    expect(one.text).toContain('audio, Take 3.wav');
    expect(one.text).toContain('starts 20 s into the recording; gain 0 dB');
    expect((await call(api, 'regions', { action: 'show', region: 'rgn_riff' })).text).toContain('CC 1 (mod): 1=0 2=64');
    expect(api.batches).toHaveLength(0);
  });

  it('splits at a position (the region there on the track), and chops at several', async () => {
    const api = setup();
    const r = await call(api, 'regions', { action: 'split', track: 'Vocal', at: '7' });
    const [op] = lastOps(api);
    expect(op).toMatchObject({ op: 'splitRegion', track: 'trk_vocal', region: 'rgn_take', at: 6 * BAR });
    expect(r.progress).toBe('Split "Take" at 7');
    expect(trackOf(api, 'trk_vocal').regions.map((x) => [x.start, x.length])).toEqual([
      [4 * BAR, 2 * BAR],
      [6 * BAR, 2 * BAR],
    ]);
    const chop = setup();
    await call(chop, 'regions', { action: 'split', region: 'Riff', at: '2 3, 4' });
    expect(lastOps(chop).map((o) => (o.op === 'splitRegion' ? o.at : null))).toEqual([3 * BAR, 2 * BAR, BAR]);
    expect(trackOf(chop, 'trk_piano').regions.filter((x) => x.start < 4 * BAR)).toHaveLength(4);
    expect(await refused(chop, 'regions', { action: 'split', region: 'Tag', at: '3' })).toMatch(/isn't inside/);
  });

  it('takes "selected" from the studio, and says when nothing is', async () => {
    const api = setup({ state: { selection: { track: 'trk_piano', regions: ['rgn_riff', 'rgn_tag'] } } });
    await call(api, 'regions', { action: 'mute', region: 'selected' });
    expect(lastOps(api)).toEqual([
      { op: 'updateRegion', track: 'trk_piano', region: 'rgn_riff', patch: { muted: true } },
      { op: 'updateRegion', track: 'trk_piano', region: 'rgn_tag', patch: { muted: true } },
    ]);
    await call(api, 'regions', { action: 'unmute', region: 'selected' });
    expect(regionOf(api, 'rgn_tag').muted).toBe(false);
    expect(await refused(setup(), 'regions', { action: 'mute', region: 'selected' })).toMatch(/No region is selected/);
    expect(await refused(setup(), 'regions', { action: 'mute', region: 'Verse' })).toMatch(/No region "Verse"/);
    expect(await refused(setup(), 'regions', { action: 'mute', track: 'Piano' })).toMatch(/has 2 regions/);
  });

  it('deletes only with confirm', async () => {
    const api = setup();
    expect(await refused(api, 'regions', { action: 'delete', region: 'Tag' })).toMatch(/confirm/);
    await call(api, 'regions', { action: 'delete', region: 'Tag', confirm: true });
    expect(lastOps(api)).toEqual([{ op: 'removeRegion', track: 'trk_piano', region: 'rgn_tag' }]);
  });

  it('copies, moves and repeats, in time and to another track of the same kind', async () => {
    const api = setup();
    await call(api, 'regions', { action: 'copy', region: 'Riff', at: '13', to_track: 'Pad' });
    const copy = trackOf(api, 'trk_pad').regions[0] as Region;
    expect(copy).toMatchObject({ start: 12 * BAR, length: 4 * BAR, name: 'Riff' });
    expect(copy.id).not.toBe('rgn_riff');
    await call(api, 'regions', { action: 'move', region: 'Tag', at: '10' });
    expect(lastOps(api)).toEqual([
      { op: 'moveRegion', from: 'trk_piano', to: 'trk_piano', region: 'rgn_tag', start: 9 * BAR },
    ]);
    await call(api, 'regions', { action: 'repeat', region: 'Tag', times: 3 });
    expect(
      trackOf(api, 'trk_piano')
        .regions.map((x) => x.start)
        .filter((s) => s >= 9 * BAR),
    ).toEqual([9 * BAR, 10 * BAR, 11 * BAR, 12 * BAR]);
    expect(await refused(api, 'regions', { action: 'move', region: 'Take', to_track: 'Pad' })).toMatch(
      /recording: it goes on an audio track/,
    );
    expect(await refused(api, 'regions', { action: 'copy', region: 'rgn_tag' })).toMatch(/Say where/);
  });

  it('trims a recording’s edges and a MIDI region’s', async () => {
    const api = setup();
    await call(api, 'regions', { action: 'trim', region: 'Take', start: '6', end: '8' });
    const take = regionOf(api, 'rgn_take');
    expect([take.start, take.length]).toEqual([5 * BAR, 2 * BAR]);
    expect(take.audio?.offset).toBeCloseTo(20 + tickToSeconds(api.project.tempo, BAR), 9);
    await call(api, 'regions', { action: 'trim', region: 'Riff', start: '2', end: '4' });
    const riff = regionOf(api, 'rgn_riff');
    expect([riff.start, riff.length]).toEqual([BAR, 2 * BAR]);
    expect(riff.notes.map((n) => [n.t, n.p])).toEqual([[BAR + 470, 69]]);
    expect(riff.cc['1']).toEqual([[0, 64]]);
    expect(await refused(api, 'regions', { action: 'trim', region: 'Riff', start: '9' })).toMatch(
      /before the region's end/,
    );
  });

  it('sets a recording’s gain, and scales a MIDI region’s velocities', async () => {
    const api = setup();
    await call(api, 'regions', { action: 'gain', region: 'Take', db: -4.5 });
    expect(regionOf(api, 'rgn_take').audio?.gain).toBe(-4.5);
    await call(api, 'regions', { action: 'gain', region: 'Riff', db: -6 });
    expect(regionOf(api, 'rgn_riff').notes.map((n) => n.v)).toEqual([50, 40, 30]);
    expect(lastOps(api)[0]?.op).toBe('setNotesIn');
  });

  it('fades a recording, and ramps a MIDI region’s velocities', async () => {
    const api = setup();
    await call(api, 'regions', { action: 'fade', region: 'Take', fade_in: 0.25, fade_out: 1.5 });
    expect(regionOf(api, 'rgn_take').audio).toMatchObject({ fadeIn: 0.25, fadeOut: 1.5 });
    await call(api, 'regions', { action: 'fade', region: 'Riff', fade_in: 2 });
    const vs = regionOf(api, 'rgn_riff').notes.map((n) => n.v);
    expect(vs[0]).toBeLessThan(5);
    expect(vs[1]).toBeLessThan(80);
    expect(vs[2]).toBe(60);
  });

  it('stretches a recording (by a ratio, or to an end) and a MIDI region', async () => {
    const api = setup();
    await call(api, 'regions', { action: 'stretch', region: 'Take', ratio: 1.5 });
    expect(regionOf(api, 'rgn_take')).toMatchObject({ length: 6 * BAR, audio: { stretch: 1.5 } });
    await call(api, 'regions', { action: 'stretch', region: 'Take', end: '9' });
    expect(regionOf(api, 'rgn_take')).toMatchObject({ length: 4 * BAR, audio: { stretch: 1 } });
    await call(api, 'regions', { action: 'stretch', region: 'Tag', ratio: 2 });
    const tag = regionOf(api, 'rgn_tag');
    expect([tag.length, tag.notes[0]?.d]).toEqual([2 * BAR, 2 * PPQ]);
  });

  it('renames, quantizes and transposes', async () => {
    const api = setup();
    await call(api, 'regions', { action: 'rename', region: 'Tag', name: 'Ending' });
    expect(regionOf(api, 'rgn_tag').name).toBe('Ending');
    await call(api, 'regions', { action: 'quantize', region: 'Riff', unit: '1/8' });
    expect(regionOf(api, 'rgn_riff').notes.map((n) => n.t)).toEqual([0, PPQ, 2 * BAR + PPQ / 2]);
    const half = setup();
    await call(half, 'regions', { action: 'quantize', region: 'Riff', unit: '1/4', strength: 50 });
    expect(regionOf(half, 'rgn_riff').notes.map((n) => n.t)).toEqual([5, PPQ + 65, 2 * BAR + 235]);
    await call(api, 'regions', { action: 'transpose', region: 'Riff', semitones: -12 });
    expect(regionOf(api, 'rgn_riff').notes.map((n) => n.p)).toEqual([50, 53, 57]);
    expect(await refused(api, 'regions', { action: 'transpose', region: 'Take', semitones: 2 })).toMatch(/recording/);
    await call(api, 'regions', { action: 'transpose', region: 'Riff', semitones: 48 });
    expect(await refused(api, 'regions', { action: 'transpose', region: 'Riff', semitones: 48 })).toMatch(/0–127/);
  });

  it('writes, shows and clears controller and pitch-bend lanes', async () => {
    const api = setup();
    await call(api, 'regions', { action: 'cc', region: 'Riff', lane: 'pb', points: '1=0 1.3=4096 2=-8192' });
    expect(lastOps(api)).toEqual([
      {
        op: 'setCC',
        track: 'trk_piano',
        region: 'rgn_riff',
        lane: 'pb',
        points: [
          [0, 0],
          [2 * PPQ, 4096],
          [BAR, -8192],
        ],
      },
    ]);
    // new points replace the lane's from the first to the last, the rest stays
    await call(api, 'regions', { action: 'cc', region: 'Riff', lane: 'mod', points: '1.2=30 1.4=40' });
    expect(regionOf(api, 'rgn_riff').cc['1']).toEqual([
      [0, 0],
      [PPQ, 30],
      [3 * PPQ, 40],
      [BAR, 64],
    ]);
    expect((await call(api, 'regions', { action: 'cc', region: 'Riff', lane: 'pb' })).text).toBe(
      'pitch bend on "Riff": 1=0 1.3=4096 2=-8192',
    );
    await call(api, 'regions', { action: 'cc', region: 'Riff', lane: 'pb', clear: true });
    expect(regionOf(api, 'rgn_riff').cc.pb).toBeUndefined();
    expect(await refused(api, 'regions', { action: 'cc', region: 'Riff', lane: '7', points: '9=100' })).toMatch(
      /outside "Riff"/,
    );
    expect(await refused(api, 'regions', { action: 'cc', region: 'Riff', lane: '7', points: '1=300' })).toMatch(
      /0 to 127/,
    );
    expect(await refused(api, 'regions', { action: 'cc', region: 'Riff', lane: 'wobble', points: '1=3' })).toMatch(
      /CC number/,
    );
  });
});

describe('timeline', () => {
  it('inserts bars across the song, as one operation', async () => {
    const api = setup();
    const r = await call(api, 'timeline', { action: 'insert', at: '5', bars: 2 });
    expect(lastOps(api)).toEqual([{ op: 'arrange', edit: 'insert', from: 4 * BAR, to: 6 * BAR }]);
    expect(r.text).toBe('Inserted 2 bars at 5 (4/4); what was at 5 is at 7 now. One undo step takes it back.');
    expect(regionOf(api, 'rgn_take').start).toBe(6 * BAR);
    expect(api.project.markers[0]?.tick).toBe(10 * BAR);
  });

  it('deletes and moves only with confirm; copies to a bar', async () => {
    const api = setup();
    expect(await refused(api, 'timeline', { action: 'delete', from: '9', bars: 1 })).toMatch(/confirm/);
    await call(api, 'timeline', { action: 'delete', from: '9', bars: 1, confirm: true });
    expect(lastOps(api)).toEqual([{ op: 'arrange', edit: 'delete', from: 8 * BAR, to: 9 * BAR }]);
    expect(regionOf(api, 'rgn_tag')).toBeUndefined();
    await call(api, 'timeline', { action: 'copy', from: '1', to: '5', at: '9' });
    expect(lastOps(api)).toEqual([{ op: 'arrange', edit: 'copy', from: 0, to: 4 * BAR, at: 8 * BAR }]);
    expect(trackOf(api, 'trk_piano').regions.filter((x) => x.start === 8 * BAR)).toHaveLength(1);
    expect(await refused(api, 'timeline', { action: 'move', from: '5', to: '9', at: '1' })).toMatch(/confirm/);
    await call(api, 'timeline', { action: 'move', from: '5', to: '9', at: '1', confirm: true });
    expect(regionOf(api, 'rgn_take').start).toBe(0);
  });

  it('takes whole bars only', async () => {
    const api = setup();
    expect(await refused(api, 'timeline', { action: 'insert', at: '5.3', bars: 1 })).toMatch(/isn't on a bar line/);
    expect(await refused(api, 'timeline', { action: 'copy', from: '1', to: '2.2', at: '9' })).toMatch(/bar line/);
    expect(await refused(api, 'timeline', { action: 'move', from: '1', to: '5', at: '3', confirm: true })).toMatch(
      /inside themselves/,
    );
    expect(await refused(api, 'timeline', { action: 'insert', at: '5' })).toMatch(/how many "bars"/);
    expect(api.batches).toHaveLength(0);
  });
});

describe('automate', () => {
  it('lists every setting that can move, with plugins named the way automate takes them', async () => {
    const api = setup();
    const r = await call(api, 'automate', { action: 'list', target: 'Vocal' });
    expect(r.text).toContain('  volume (Volume): -60..6 dB, now 0');
    expect(r.text).toContain('  mute (Mute): 0/1, now 0');
    expect(r.text).toContain('  eq.hsGain (Channel EQ: High Shelf Gain, fx_eq1)');
    expect(r.text).toContain('  eq#2.hsGain (Channel EQ: High Shelf Gain, fx_eq2)');
    expect(r.text).toContain('  delay.mix (');
  });

  it('takes a plugin by position or id, and shows the lane', async () => {
    const api = setup();
    await call(api, 'automate', { target: 'Vocal', param: 'eq#2.hsGain', points: '5=0 7=-6' });
    expect(lastOps(api)[0]).toMatchObject({ op: 'setAutomation', param: 'fx:fx_eq2:hsGain' });
    await call(api, 'automate', { target: 'Vocal', param: 'fx_verb.mix', points: '5=10 9.3=40', smooth: true });
    expect(lastOps(api)[0]).toMatchObject({ param: 'fx:fx_verb:mix', curve: 'smooth' });
    // the parameter by its name too
    await call(api, 'automate', { target: 'Vocal', param: 'eq.High Shelf Gain', points: '5=3' });
    expect(lastOps(api)[0]).toMatchObject({ param: 'fx:fx_eq1:hsGain' });
    const shown = await call(api, 'automate', { action: 'show', target: 'Vocal', param: 'reverb.mix' });
    expect(shown.text).toBe('Vocal: Space Reverb: Mix (reverb.mix), read, smooth: 5=10 9.3=40');
    // read keeps its meaning: the lane plays again
    await call(api, 'automate', { action: 'off', target: 'Vocal', param: 'reverb.mix' });
    await call(api, 'automate', { action: 'read', target: 'Vocal', param: 'reverb.mix' });
    expect(trackOf(api, 'trk_vocal').channel.automation?.find((a) => a.param === 'fx:fx_verb:mix')?.mode).toBe('read');
    expect(await refused(api, 'automate', { target: 'Vocal', param: 'eq#3.hsGain', points: '1=0' })).toMatch(
      /has no eq#3: add it first.*eq, eq#2, reverb, delay/,
    );
    expect(await refused(api, 'automate', { target: 'Vocal', param: 'list' })).toMatch(/"param" is volume/);
  });

  it('says a MIDI effect’s settings can’t be automated', async () => {
    const api = setup();
    await call(api, 'fx', { action: 'add', target: 'Piano', plugin: 'arpeggiator' });
    expect(await refused(api, 'automate', { target: 'Piano', param: 'arpeggiator.rate', points: '1=2' })).toMatch(
      /MIDI effect/,
    );
  });
});

describe('fx', () => {
  it('moves a plugin to a place, or before or after another', async () => {
    const api = setup();
    const r = await call(api, 'fx', { action: 'move', target: 'Vocal', plugin: 'reverb', after: 'delay' });
    expect(lastOps(api)).toEqual([{ op: 'movePlugin', target: 'trk_vocal', plugin: 'fx_verb', index: 3 }]);
    expect(r.text).toContain('Channel EQ → Channel EQ → Tape Delay → Space Reverb');
    await call(api, 'fx', { action: 'move', target: 'Vocal', plugin: 'reverb', before: 'eq#2' });
    expect(trackOf(api, 'trk_vocal').channel.inserts.map((p) => p.id)).toEqual([
      'fx_eq1',
      'fx_verb',
      'fx_eq2',
      'fx_delay',
    ]);
    await call(api, 'fx', { action: 'move', target: 'Vocal', plugin: 'eq#2', index: 1 });
    expect(trackOf(api, 'trk_vocal').channel.inserts.map((p) => p.id)).toEqual([
      'fx_eq2',
      'fx_eq1',
      'fx_verb',
      'fx_delay',
    ]);
    expect((await call(api, 'fx', { action: 'move', target: 'Vocal', plugin: 'delay', index: 9 })).text).toBe(
      'Tape Delay is there already.',
    );
    expect(await refused(api, 'fx', { action: 'move', target: 'Vocal', plugin: 'delay' })).toMatch(/Say where/);
    // show numbers them
    expect((await call(api, 'fx', { action: 'show', target: 'Vocal' })).text).toContain('  1. Channel EQ [eq, fx_eq2]');
  });

  it('puts a plugin with a key in the song’s key, unless told otherwise', async () => {
    const api = setup();
    const r = await call(api, 'fx', { action: 'add', target: 'Piano', plugin: 'harmonizer', params: { voice1: 2 } });
    const minor = SCALES.findIndex((s) => s.name === 'Natural minor');
    expect(trackOf(api, 'trk_piano').midiFx[0]?.params).toMatchObject({ key: 2, scale: minor, voice1: 2 });
    expect(r.text).toContain("in the song's key, D minor");
    const told = setup();
    await call(told, 'fx', { action: 'add', target: 'Piano', plugin: 'scale', params: { key: 'A', scale: 'Lydian' } });
    expect(trackOf(told, 'trk_piano').midiFx[0]?.params).toMatchObject({ key: 9, scale: 6 });
    // harmonic minor, as the song's key says
    const harmonic = fakeJobApi({ ...editSong(), key: 'E harmonic minor' });
    await call(harmonic, 'fx', { action: 'add', target: 'Piano', plugin: 'scale' });
    expect(trackOf(harmonic, 'trk_piano').midiFx[0]?.params).toMatchObject({ key: 4, scale: 2 });
    // a MIDI effect where the key changes: it stays in the first, and says so
    const changes = fakeJobApi({
      ...editSong(),
      keys: [
        { tick: 0, fifths: -1, mode: 'minor' },
        { tick: 8 * BAR, fifths: 2, mode: 'major' },
      ],
    });
    const said = await call(changes, 'fx', { action: 'add', target: 'Piano', plugin: 'harmonizer' });
    expect(said.text).toContain('it stays in D minor where the song changes key');
  });

  const tuner = PLUGINS.find((p) => p.kind !== 'midi' && p.params.some((x) => x.id === 'key'));
  // (an audio effect with a key and scale: Pitch Correction, once it's in the plugins)
  it.skipIf(!tuner)('an audio effect with a key follows the song’s key changes with automation', async () => {
    const api = fakeJobApi({
      ...editSong(),
      keys: [
        { tick: 0, fifths: -1, mode: 'minor' },
        { tick: 8 * BAR, fifths: 1, mode: 'major' },
      ],
    });
    await call(api, 'fx', { action: 'add', target: 'Vocal', plugin: tuner?.type });
    const lanes = Object.fromEntries(
      lastOps(api).flatMap((o) => (o.op === 'setAutomation' ? [[o.param.split(':')[2], o.points]] : [])),
    );
    // D minor, then G major
    expect(lanes.key).toEqual([
      [0, 2],
      [8 * BAR, 7],
    ]);
    expect(lanes.scale).toEqual([
      [0, SCALES.findIndex((s) => s.name === 'Natural minor')],
      [8 * BAR, 0],
    ]);
  });
});

describe('song_set: who it’s by and its album', () => {
  it('sets them beside the song, outside undo, with the song’s own settings in the same call', async () => {
    const api = setup();
    const r = await call(api, 'song_set', { title: 'Night Drive', artist: 'Es Claro', album: 'Cannibals' });
    expect(r.text).toBe(
      'Set title "Night Drive"; artist "Es Claro"; album "Cannibals". The artist and album are kept beside the song, outside undo: undo doesn\'t take them back.',
    );
    expect(api.calls.find((c) => c.method === 'details')?.args).toEqual([{ artist: 'Es Claro', album: 'Cannibals' }]);
    expect(lastOps(api)).toEqual([{ op: 'setProject', patch: { title: 'Night Drive' } }]);
    const cleared = await call(api, 'song_set', { album: 'none' });
    expect(cleared.text).toBe(
      "Set no album. The album is kept beside the song, outside undo: undo doesn't take it back.",
    );
    expect(api.batches).toHaveLength(1);
  });

  it("is refused for a creation's song, with HO[LO]'s reason", async () => {
    const api = setup({ details: { refuse: "This song is moon's; it stays with its creation" } });
    expect(await refused(api, 'song_set', { artist: 'Me' })).toBe("This song is moon's; it stays with its creation");
    // and nothing else in the call changes either
    await refused(api, 'song_set', { title: 'Mine', artist: 'Me' });
    expect(api.batches).toHaveLength(0);
  });
});

describe('ops_apply takes the new operations', () => {
  it('splitRegion and arrange; arrange deletes and moves only with confirm', async () => {
    const api = setup();
    await call(api, 'ops_apply', {
      ops: [{ op: 'splitRegion', track: 'trk_vocal', region: 'rgn_take', at: 5 * BAR, id: 'rgn_half' }],
      label: 'Split the take',
    });
    expect(regionOf(api, 'rgn_half').start).toBe(5 * BAR);
    expect(
      await refused(api, 'ops_apply', {
        ops: [{ op: 'arrange', edit: 'delete', from: 0, to: BAR }],
        label: 'Cut the intro',
      }),
    ).toMatch(/confirm/);
    await call(api, 'ops_apply', {
      ops: [{ op: 'arrange', edit: 'insert', from: 0, to: BAR }],
      label: 'A bar of count-in',
    });
    expect(regionOf(api, 'rgn_riff').start).toBe(BAR);
    expect(
      await refused(api, 'ops_apply', { ops: [{ op: 'arrange', edit: 'insert', from: 100, to: BAR }], label: 'x' }),
    ).toMatch(/bar line/);
  });
});
