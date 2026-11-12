import { newAudioTrack, newPlugin, newRegion, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  type FakeJobApi,
  type FakeJobApiOptions,
  fakeJobApi,
  type MeasureAnswer,
  type MeasureBody,
  type MeasureResult,
  type MetersMeasure,
  type MixMeasure,
  type TakeMeasure,
  type TracksMeasure,
} from '../src/api.ts';
import { BAR, call, refused, song } from './helpers.ts';

/** The helpers' song, with a "Vocals" take (two regions), a compressor and two EQs on Bass, and a key. */
function measuredSong(): Project {
  const p = song();
  p.key = 'D minor';
  const vocals = { ...newAudioTrack('Vocals'), id: 'trk_vox' };
  vocals.regions.push(
    { ...newRegion(0, BAR * 4, 'Verse take'), id: 'rgn_v1' },
    { ...newRegion(BAR * 8, BAR * 4, 'Chorus take'), id: 'rgn_v2' },
  );
  p.tracks.push(vocals);
  const bass = p.tracks.find((t) => t.id === 'trk_bass');
  bass?.channel.inserts.push(
    { ...newPlugin('eq'), id: 'fx_eq1' },
    { ...newPlugin('compressor'), id: 'fx_comp' },
    { ...newPlugin('eq'), id: 'fx_eq2' },
  );
  return p;
}

function setup(options: FakeJobApiOptions = {}): FakeJobApi {
  return fakeJobApi(measuredSong(), options);
}

type MeterChannels = MetersMeasure['channels'];

const done = (result: MeasureResult): MeasureAnswer => ({ done: true, task: 'msr_1', result });
const bodies = (api: FakeJobApi) =>
  api.calls.filter((c) => c.method === 'measure').map((c) => c.args[0] as MeasureBody);

const take: TakeMeasure = {
  kind: 'take',
  track: 'trk_vox',
  name: 'Vocals',
  regions: ['rgn_v1'],
  seconds: 8,
  against: { kind: 'key', keys: ['D minor'] },
  grid: 240,
  notes: [
    {
      tick: BAR,
      end: BAR + 960,
      at: 2,
      length: 0.5,
      pitch: 62.04,
      target: 62,
      cents: 4,
      inKey: true,
      drift: 0,
      vibrato: null,
      grid: 12,
      attack: true,
      db: -18,
      peak: -9,
      region: 'rgn_v1',
    },
    {
      tick: BAR + 1920,
      end: BAR * 2,
      at: 3,
      length: 1,
      pitch: 64.62,
      target: 65,
      cents: -38,
      inKey: true,
      drift: -16,
      vibrato: [5.4, 31],
      grid: -35,
      attack: false,
      db: -20,
      peak: -10,
      region: 'rgn_v1',
    },
  ],
  phrases: [
    { tick: BAR, end: BAR * 2, at: 2, length: 2, notes: 2, db: -19, peak: -9 },
    { tick: BAR * 3, end: BAR * 4, at: 6, length: 2, notes: 3, db: -24.5, peak: -14 },
    { tick: BAR * 5, end: BAR * 6, at: 10, length: 2, notes: 3, db: -19.2, peak: -9 },
  ],
  summary: {
    notes: 2,
    meanAbs: 21,
    bias: -17,
    within10: 0.5,
    within25: 0.5,
    sharp: 0,
    flat: 1,
    timing: { mean: -11.5, spread: 23.5, late: 0, early: 1 },
    vibrato: { notes: 1, rate: 5.4, depth: 31 },
    drifting: 1,
  },
};

const mix: MixMeasure = {
  kind: 'mix',
  source: 'render',
  tick: 0,
  end: BAR * 8,
  loudness: {
    seconds: 16,
    integrated: -14.2,
    momentaryMax: -9.8,
    shortTermMax: -11.6,
    range: 5.3,
    truePeak: 0.4,
    samplePeak: 0,
    over: 211,
    overRuns: 9,
  },
  sections: [
    { name: 'Verse', tick: 0, end: BAR * 4, at: 0, length: 8, lufs: -16.1, shortTermMax: -13 },
    { name: 'Chorus', tick: BAR * 4, end: BAR * 8, at: 8, length: 8, lufs: -12.9, shortTermMax: -11.6 },
  ],
  octaves: [-40, -22, -20, -21, -24, -26, -29, -33, -38, -50],
  tilt: -3.2,
  errors: [],
};

describe('measure', () => {
  it('measures a take: names and positions into ids and ticks, and the numbers said plainly', async () => {
    const api = setup({ measured: { take: done(take) } });
    const r = await call(api, 'measure', {
      what: 'take',
      track: 'vocals',
      from: '2',
      to: '4',
      against: 'Strings',
      grid: '1/8',
    });
    expect(bodies(api)).toEqual([
      { what: 'take', track: 'trk_vox', from: BAR, to: BAR * 3, against: 'trk_strings', grid: 480 },
    ]);
    expect(r.text).toContain('Vocals, bar 2: measured against the key (D minor)');
    expect(r.text).toContain('21 cents off on average, leaning 17 cents flat');
    expect(r.text).toContain('1 note drifts 15 cents or more');
    expect(r.text).toContain('2.3.1 -38c');
    expect(r.text).toContain('12 ms early on average, spread ±24 ms; 0 more than 30 ms late, 1 more than 30 ms early');
    expect(r.text).toContain('Vibrato on 1 note (5.4 Hz, ±31 cents on average)');
    expect(r.text).toContain('4.1.1–5.1.1 -24.5 dB (5.3 dB under the rest)');
    expect(r.text).toContain('2.1.1 D4 +4c +12 ms -18 dB');
    expect(r.text).toContain('2.3.1 F4 -38c -35 ms -20 dB vibrato 5.4 Hz ±31c drifts -16c');
  });

  it('names a take’s notes as the song’s key spells them there, with the studio’s middle C', async () => {
    const note = take.notes[0] as TakeMeasure['notes'][number];
    const at = (tick: number, target: number, extra: Partial<TakeMeasure['notes'][number]> = {}) => ({
      ...note,
      tick,
      end: tick + 960,
      target,
      pitch: target,
      cents: 0,
      ...extra,
    });
    // D minor, then B major from bar 5: B♭ and C♯ in D minor, A♯ in B major
    const notes = [at(BAR, 70), at(BAR + 960, 61), at(BAR * 4, 70)];
    const api = setup({ measured: { take: done({ ...take, notes }) } });
    api.project.keys = [
      { tick: 0, fifths: -1, mode: 'minor' },
      { tick: BAR * 4, fifths: 5, mode: 'major' },
    ];
    const r = await call(api, 'measure', { what: 'take', track: 'Vocals' });
    expect(r.text).toContain('2.1.1 Bb4 0c');
    expect(r.text).toContain('2.2.1 C#4 0c');
    expect(r.text).toContain('5.1.1 A#4 0c');
    expect(r.text).not.toContain('2.1.1 A#4');
    // Logic's names (middle C is C3), and against a track: what it plays, spelled the same way
    const ref = {
      ...take,
      against: { kind: 'track', track: 'trk_strings' } as const,
      notes: [at(BAR, 70, { ref: 74 })],
    };
    const logic = setup({ measured: { take: done(ref) } });
    logic.project.key = 'D minor';
    const c3 = await call(logic, 'measure', { what: 'take', track: 'Vocals' }, 'C3');
    expect(c3.text).toContain('2.1.1 Bb3 0c');
    expect(c3.text).toContain('(it plays D4)');
    // with no key, sharps
    const none = setup({ measured: { take: done({ ...take, notes: [at(BAR, 70)] }) } });
    none.project.key = null;
    expect((await call(none, 'measure', { what: 'take', track: 'Vocals' })).text).toContain('2.1.1 A#4 0c');
  });

  it('finds the take: the only audio track, a region by name, the selected one', async () => {
    const api = setup({
      measured: { take: done(take) },
      state: { selection: { track: 'trk_vox', regions: ['rgn_v2'] } },
    });
    await call(api, 'measure', { what: 'take', region: 'chorus take' });
    await call(api, 'measure', { what: 'take', track: 'Vocals', region: 'selected', against: 'none' });
    expect(bodies(api)).toEqual([
      { what: 'take', track: 'trk_vox', region: 'rgn_v2', grid: 240 },
      { what: 'take', track: 'trk_vox', region: 'rgn_v2', against: 'none', grid: 240 },
    ]);
    expect(await refused(api, 'measure', { what: 'take', track: 'Strings' })).toContain("isn't an audio track");
    expect(await refused(api, 'measure', { what: 'take', track: 'Vocals', region: 'Bridge' })).toContain(
      'Its regions: Verse take (rgn_v1), Chorus take (rgn_v2)',
    );
    expect(await refused(api, 'measure', { what: 'take', track: 'Vocals', against: 'Vocals' })).toContain(
      'an instrument track with notes',
    );
    expect(await refused(api, 'measure', { what: 'take', from: '5', to: '3' })).toContain('"to" must come after');
    // with two audio tracks, it asks which
    api.project.tracks.push({ ...newAudioTrack('Guitar'), id: 'trk_gtr' });
    expect(await refused(api, 'measure', { what: 'take' })).toContain('the audio tracks are "Vocals", "Guitar"');
  });

  it('says how far a long measurement got, and to call again rather than wait in a loop', async () => {
    const api = setup({
      measured: {
        mix: [{ done: false, task: 'msr_9', progress: 0.35, eta: 260, stage: 'Rendering… 30%' }, done(mix)],
      },
    });
    const first = await call(api, 'measure', { what: 'mix' });
    expect(first.text).toContain('Still measuring the mix: 35% done, about 4 min left (Rendering… 30%)');
    expect(first.text).toContain('call measure again with the same arguments');
    expect(first.text).toContain("don't call it over and over");
    const second = await call(api, 'measure', { what: 'mix' });
    expect(second.text).toContain('The mix, rendered, bars 1–8 (0:16), as it plays: unmastered.');
    expect(second.text).toContain('Integrated -14.2 LUFS; loudest 3 s -11.6 LUFS, loudest 400 ms -9.8 LUFS');
    expect(second.text).toContain(
      'True peak 0.4 dBTP, sample peak 0.0 dBFS; 211 samples at full scale in 9 places: it clips.',
    );
    expect(second.text).toContain('Verse (bars 1–4) -16.1; Chorus (bars 5–8) -12.9');
    expect(second.text).toContain('63 -22, 125 -20');
    expect(second.text).toContain('tilt -3.2 dB per octave');
  });

  it('says what was silent, or left out, because it plays a pack that isn’t installed here', async () => {
    const unplayable = {
      tracks: [
        { id: 'trk_strings', name: 'Strings', pack: 'vsco2' },
        { id: 'trk_bass', name: 'Bass', pack: 'vsco2' },
      ],
      plugins: [{ id: 'fx_rep', name: 'Drum Replacer', channel: 'trk_bass', pack: 'drums' }],
    };
    const tracks: TracksMeasure = {
      kind: 'tracks',
      tick: 0,
      end: BAR * 4,
      tracks: [
        { id: 'trk_strings', name: 'Strings', output: 'master', muted: false, silent: true, missing: 'vsco2' },
        { id: 'trk_bass', name: 'Bass', output: 'master', muted: false, silent: false, lufs: -20, peak: -6 },
      ].map((t) => ({ lufs: null, peak: null, truePeak: null, octaves: [], ...t })),
      masking: null,
      errors: [],
      unplayable: { tracks: [], plugins: unplayable.plugins },
    };
    const api = setup({ measured: { mix: done({ ...mix, unplayable }), tracks: done(tracks) } });
    const m = await call(api, 'measure', { what: 'mix' });
    expect(m.text).toContain(
      "Strings and Bass play packs that aren't installed here (vsco2), so they're silent in this measurement, as in the studio.",
    );
    expect(m.text).toContain(
      "The Drum Replacer on Bass plays a sound from a pack that isn't installed here (drums), so it's left out of this measurement.",
    );
    const t = await call(api, 'measure', { what: 'tracks' });
    expect(t.text).toContain("Strings: silent (it plays vsco2, a pack that isn't installed here).");
    expect(t.text).toContain('The Drum Replacer on Bass plays a sound');
    expect(t.text).not.toContain('Strings and Bass');
  });

  it('reads the newest bounce, and says when it’s older than the song', async () => {
    const bounce: MixMeasure = {
      ...mix,
      source: 'bounce',
      name: '2026-11-12 10.00.00 Song.wav',
      made: new Date(Date.now() - 30 * 60000).toISOString(),
      stale: true,
    };
    const api = setup({ measured: { mix: done(bounce), file: done(bounce) } });
    const r = await call(api, 'measure', { what: 'mix', source: 'bounce' });
    expect(r.text).toContain('The newest bounce, "2026-11-12 10.00.00 Song.wav" (0:16, made 30 min ago)');
    expect(r.text).toContain('the song has changed since');
    await call(api, 'measure', { what: 'file' });
    await call(api, 'measure', { what: 'file', attachment: 'att_0123456789ab' });
    expect(bodies(api)).toEqual([
      { what: 'mix', source: 'bounce' },
      { what: 'file', source: 'bounce' },
      { what: 'file', attachment: 'att_0123456789ab' },
    ]);
  });

  it('gives each track’s level, and where two compete', async () => {
    const api = setup({
      measured: {
        tracks: done({
          kind: 'tracks',
          tick: 0,
          end: BAR * 4,
          tracks: [
            {
              id: 'trk_bass',
              name: 'Bass',
              output: 'master',
              muted: false,
              silent: false,
              lufs: -21,
              peak: -6,
              truePeak: -5.8,
              octaves: [-40, -20, -24, -30, -40, -50, -60, -70, -80, -90],
            },
            {
              id: 'trk_vox',
              name: 'Vocals',
              output: 'Vox Bus',
              muted: true,
              silent: false,
              lufs: -19,
              peak: -4,
              truePeak: -4,
              octaves: [-80, -60, -40, -30, -22, -20, -26, -30, -40, -60],
              source: { lufs: -23, peak: -8 },
            },
          ],
          masking: { a: 'trk_bass', b: 'trk_vox', bands: [{ hz: 250, overlap: 0.62, diff: -3.1 }] },
          errors: [],
        }),
      },
    });
    const r = await call(api, 'measure', { what: 'tracks', track: 'Bass', against: 'Vocals' });
    expect(bodies(api)).toEqual([{ what: 'tracks', track: 'trk_bass', against: 'trk_vox' }]);
    expect(r.text).toContain('Bass: -21.0 LUFS, peak -6.0 dBFS; loudest around 63 Hz.');
    expect(r.text).toContain(
      'Vocals: -19.0 LUFS, peak -4.0 dBFS; loudest around 1 kHz; muted in the mix; goes to Vox Bus in the mix; its recordings -23.0 LUFS, peak -8.0 dBFS.',
    );
    expect(r.text).toContain(
      'Bass and Vocals compete at 250 Hz (both sound there within 10 dB of each other 62% of the time; Bass quieter by 3.1 dB).',
    );
    expect(await refused(api, 'measure', { what: 'tracks', against: 'Vocals' })).toContain('Say which "track"');
  });

  it('finds a plugin by id, type or its place, and says what it does', async () => {
    const response = done({
      kind: 'plugin',
      channel: 'trk_bass',
      plugin: { id: 'fx_eq2', type: 'eq', name: 'Channel EQ', bypass: false },
      method: 'response',
      response: { thirds: Array.from({ length: 30 }, (_, i) => (i === 16 ? 6.2 : i === 10 ? -4 : 0)), latency: 0 },
      errors: [],
    });
    const signal = done({
      kind: 'plugin',
      channel: 'trk_bass',
      plugin: { id: 'fx_comp', type: 'compressor', name: 'Compressor', bypass: false },
      method: 'signal',
      signal: {
        tick: 0,
        end: BAR * 4,
        in: { lufs: -18, peak: -3 },
        out: { lufs: -21.5, peak: -8 },
        octavesIn: [-40, -20, -24, -30, -40, -50, -60, -70, -80, -90],
        octavesOut: [-43, -23.5, -27, -33, -43, -53, -63, -73, -83, -93],
        gr: { active: 0.64, median: 3.2, p90: 7.8, max: 12.1 },
      },
      errors: [],
    });
    const api = setup({ measured: { plugin: [response, signal] } });
    const eq = await call(api, 'measure', { what: 'plugin', track: 'Bass', plugin: 'eq#2' });
    expect(eq.text).toContain('Channel EQ (fx_eq2) on Bass: its response to an impulse');
    expect(eq.text).toContain('250 -4.0, 1k +6.2');
    expect(eq.text).toContain('Most boost: +6.2 dB around 1 kHz.');
    const comp = await call(api, 'measure', { what: 'plugin', track: 'Bass', plugin: 'compressor' });
    expect(comp.text).toContain(
      'working 64% of the time; typically 3.2 dB, 7.8 dB at the 90th percentile, 12.1 dB at most',
    );
    expect(comp.text).toContain('In -18.0 LUFS (peak -3.0 dBFS), out -21.5 LUFS (peak -8.0 dBFS).');
    await call(api, 'measure', { what: 'plugin', track: 'Bass', plugin: 'fx_eq1' });
    expect(bodies(api).map((b) => [b.track, b.plugin])).toEqual([
      ['trk_bass', 'fx_eq2'],
      ['trk_bass', 'fx_comp'],
      ['trk_bass', 'fx_eq1'],
    ]);
    expect(await refused(api, 'measure', { what: 'plugin', track: 'Bass', plugin: 'eq' })).toContain(
      'Bass has 2 eq plugins: say "eq#1" or "eq#2"',
    );
    expect(await refused(api, 'measure', { what: 'plugin', track: 'Bass', plugin: 'reverb' })).toContain(
      'Its plugins: eq (fx_eq1), compressor (fx_comp), eq (fx_eq2)',
    );
    expect(await refused(api, 'measure', { what: 'plugin', plugin: 'eq' })).toContain('Say which "track"');
  });

  it('reads the studio’s meters over the last seconds of play, or says to play the song first', async () => {
    const channels: MeterChannels = [
      { id: 'master', peak: [-1.2, -1.4], max: [0.3, 0.1], gr: null, grMax: null, clipped: true },
      { id: 'trk_bass', peak: [-8, -8], max: [-6, -6], gr: -2.5, grMax: -6.1, clipped: false },
    ];
    const api = setup({
      measured: {
        meters: [
          done({ kind: 'meters', playing: false, seconds: 0, covered: 0, channels: [] }),
          done({ kind: 'meters', playing: true, seconds: 14, covered: 8, channels }),
          done({ kind: 'meters', playing: false, seconds: 1.2, covered: 1.2, channels }),
        ],
      },
    });
    expect((await call(api, 'measure', { what: 'meters' })).text).toContain('Start it (transport play)');
    const r = await call(api, 'measure', { what: 'meters' });
    expect(r.text).toContain(
      "The studio's meters, still playing: they cover the last 8 seconds of play (of 14 s watched since play started).",
    );
    expect(r.text).toContain('The master: -1.2/-1.4 (0.3/0.1 max); CLIPPED (went past full scale).');
    expect(r.text).toContain('Bass: -8.0/-8.0 (-6.0/-6.0 max); gain reduction 2.5 dB (6.1 max).');
    // how long they cover is passed on; a second of play is said to be too little to judge by
    const short = await call(api, 'measure', { what: 'meters', seconds: 20 });
    expect(short.text).toContain('stopped: they cover the last 1 second of play.');
    expect(short.text).toContain("That's only 1 second of the song");
    expect(bodies(api)).toEqual([{ what: 'meters' }, { what: 'meters' }, { what: 'meters', seconds: 20 }]);
    await expect(call(api, 'measure', { what: 'meters', seconds: 45 })).rejects.toThrow('"seconds" must be at most 30');
  });
});
