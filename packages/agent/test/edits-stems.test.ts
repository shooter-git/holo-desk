/** A song's stems: which tracks have one, the song each renders, and what keeps them from adding up to the mix. */
import { newBus, newPlugin, newProject, newRegion, newTrack, PPQ, type Project, type Track } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { stemSongs, stemTracks, stemWarnings } from '../src/edits/stems.ts';

const BAR = PPQ * 4;

function track(name: string, id: string): Track {
  const t: Track = { ...newTrack(name, { type: 'synth', preset: 'Soft Keys' }), id };
  t.regions = [{ ...newRegion(0, BAR), notes: [{ t: 0, d: PPQ, p: 60, v: 90 }] }];
  return t;
}

function song(): Project {
  const p = newProject('Stems');
  p.tracks = [track('Piano', 'trk_a'), track('Bass', 'trk_b'), track('Pad', 'trk_c')];
  return p;
}

describe('which tracks have a stem', () => {
  it('is every track that is on, not muted and has something to play', () => {
    const p = song();
    (p.tracks[1] as Track).channel.mute = true;
    p.tracks.push({ ...track('Off', 'trk_d'), inactive: true });
    p.tracks.push({ ...track('Empty', 'trk_e'), regions: [] });
    p.tracks.push({
      ...track('Muted region', 'trk_f'),
      regions: [{ ...newRegion(0, BAR), muted: true, notes: [{ t: 0, d: 1, p: 60, v: 1 }] }],
    });
    expect(stemTracks(p).map((t) => t.name)).toEqual(['Piano', 'Pad']);
  });

  it('is the soloed tracks alone while any is soloed, muted or not', () => {
    const p = song();
    (p.tracks[1] as Track).channel.solo = true;
    (p.tracks[1] as Track).channel.mute = true;
    expect(stemTracks(p).map((t) => t.name)).toEqual(['Bass']);
  });

  it('counts a track the Session Drummer plays, though no note is written', () => {
    const p = song();
    const drums: Track = { ...track('Drums', 'trk_d'), regions: [], midiFx: [newPlugin('drummer')] };
    p.tracks.push(drums);
    expect(stemTracks(p).map((t) => t.name)).toContain('Drums');
    (drums.midiFx[0] as { bypass: boolean }).bypass = true;
    expect(stemTracks(p).map((t) => t.name)).not.toContain('Drums');
  });
});

describe('a stem’s song', () => {
  it('has every other track switched off, and no finish', () => {
    const p = song();
    p.finish = { lufs: -16, ceiling: -1, glue: true, lowcut: 28, tilt: 0 };
    (p.tracks[0] as Track).channel.solo = true;
    (p.tracks[2] as Track).channel.solo = true;
    const stems = stemSongs(p);
    expect(stems.map((s) => [s.name, s.file, s.tracks])).toEqual([
      ['Piano', '01 Piano.wav', ['trk_a']],
      ['Pad', '02 Pad.wav', ['trk_c']],
    ]);
    const pad = stems[1]?.song as Project;
    expect(pad.finish).toBeUndefined();
    expect(pad.tracks.map((t) => [t.name, t.inactive === true, t.channel.solo, t.channel.mute])).toEqual([
      ['Piano', true, false, false],
      ['Bass', true, false, false],
      ['Pad', false, false, false],
    ]);
    // the song it came from is as it was
    expect(p.finish).toBeDefined();
    expect(p.tracks.some((t) => t.inactive)).toBe(false);
    // its buses and master are the song's own: a stem carries its share of them
    expect(pad.buses).toBe(p.buses);
    expect(pad.master).toBe(p.master);
  });

  it('names its files so that none repeats, whatever the tracks are called', () => {
    const p = newProject('Names');
    p.tracks = [
      track('Lead/Vox: "main"', 'a'),
      track('Lead Vox main', 'b'),
      track('', 'c'),
      track('lead vox MAIN', 'd'),
    ];
    expect(stemSongs(p).map((s) => s.file)).toEqual([
      '01 Lead Vox main.wav',
      '02 Lead Vox main.wav',
      '03 Track.wav',
      '04 lead vox MAIN.wav',
    ]);
    const many = newProject('Many');
    many.tracks = Array.from({ length: 120 }, (_, i) => track(`T${i}`, `t${i}`));
    expect(
      stemSongs(many)
        .map((s) => s.file)
        .slice(0, 2),
    ).toEqual(['001 T0.wav', '002 T1.wav']);
  });

  it('has none for a song with nothing to hear', () => {
    expect(stemSongs(newProject('Empty'))).toEqual([]);
  });
});

describe('why stems might not add up to the mix', () => {
  it('says nothing for a song whose buses and master only add', () => {
    const p = song();
    // (a new song's master has a Limiter: without it, nothing here reacts to level)
    p.master.inserts = [];
    const hall = newBus('Hall');
    hall.channel.inserts = [newPlugin('reverb')];
    p.buses = [hall];
    for (const t of p.tracks) t.channel.sends = [{ bus: hall.id, level: -12, pre: false }];
    expect(stemWarnings(p)).toEqual([]);
    // a new song as it comes says its Limiter, and only that
    expect(stemWarnings(song()).map((w) => w.slice(0, 21))).toEqual(['Limiter on Stereo Out']);
  });

  it('names the finish, a dynamics plugin on the master, and one on a bus several stems reach', () => {
    const p = song();
    p.finish = { lufs: -16, ceiling: -1, glue: true, lowcut: 28, tilt: 0 };
    p.master.inserts = [newPlugin('limiter'), { ...newPlugin('compressor'), bypass: true }];
    const band = newBus('Band');
    band.channel.inserts = [newPlugin('compressor')];
    const solo = newBus('Solo bus');
    solo.channel.inserts = [newPlugin('compressor')];
    const sub = newBus('Sub');
    sub.channel.output = band.id;
    p.buses = [band, solo, sub];
    (p.tracks[0] as Track).channel.output = band.id;
    (p.tracks[1] as Track).channel.sends = [{ bus: sub.id, level: -6, pre: false }];
    // one stem alone reaches Solo bus: its compressor hears what it hears in the mix
    (p.tracks[2] as Track).channel.output = solo.id;
    const said = stemWarnings(p);
    expect(said).toHaveLength(3);
    expect(said[0]).toMatch(/finish/);
    expect(said[1]).toMatch(/^Limiter on Stereo Out works on the whole mix/);
    // Bass reaches Band through Sub
    expect(said[2]).toMatch(/^Compressor on Band reacts to Piano and Bass together/);
  });
});

describe('stems by stack', () => {
  /** Piano; Violins and Cellos stacked as "Strings" through a bus with a compressor; Flute stacked alone; Bass. */
  function stacked(): Project {
    const p = newProject('Stacked');
    p.master.inserts = [];
    const sum = { ...newBus('Strings'), id: 'bus_strings' };
    sum.channel.inserts = [newPlugin('compressor')];
    p.buses = [sum];
    const violins = { ...track('Violins', 'trk_v'), stack: 'stk_s' };
    const cellos = { ...track('Cellos', 'trk_c'), stack: 'stk_s' };
    violins.channel.output = 'bus_strings';
    cellos.channel.output = 'bus_strings';
    p.tracks = [
      track('Piano', 'trk_p'),
      violins,
      cellos,
      { ...track('Flute', 'trk_f'), stack: 'stk_w' },
      track('Bass', 'trk_b'),
    ];
    p.stacks = [
      { id: 'stk_s', name: 'Strings', bus: 'bus_strings' },
      { id: 'stk_w', name: 'Winds' },
    ];
    return p;
  }

  it('is a stem for each stack, its tracks together, and one for each track in none, in the song’s order', () => {
    const stems = stemSongs(stacked(), 'stacks');
    expect(stems.map((s) => [s.file, s.name, s.tracks])).toEqual([
      ['01 Piano.wav', 'Piano', ['trk_p']],
      ['02 Strings.wav', 'Strings', ['trk_v', 'trk_c']],
      ['03 Winds.wav', 'Winds', ['trk_f']],
      ['04 Bass.wav', 'Bass', ['trk_b']],
    ]);
    // the stack's stem plays its tracks and no others
    expect(stems[1]?.song.tracks.filter((t) => !t.inactive).map((t) => t.name)).toEqual(['Violins', 'Cellos']);
    // by track, as ever
    expect(stemSongs(stacked()).map((s) => s.name)).toEqual(['Piano', 'Violins', 'Cellos', 'Flute', 'Bass']);
    expect(stemSongs(stacked(), 'tracks')).toHaveLength(5);
  });

  it('leaves out a stack’s tracks that aren’t heard, and a stack with none that are', () => {
    const p = stacked();
    (p.tracks[2] as Track).channel.mute = true;
    (p.tracks[3] as Track).inactive = true;
    expect(stemSongs(p, 'stacks').map((s) => [s.name, s.tracks])).toEqual([
      ['Piano', ['trk_p']],
      ['Strings', ['trk_v']],
      ['Bass', ['trk_b']],
    ]);
  });

  it('is a song with no stacks by track either way', () => {
    expect(stemSongs(song(), 'stacks').map((s) => s.name)).toEqual(['Piano', 'Bass', 'Pad']);
  });

  it('warns of a bus that reacts to level only when stems of more than one group reach it', () => {
    const p = stacked();
    // by track: the violins and the cellos go through the compressor apart
    expect(stemWarnings(p).join(' ')).toMatch(/Compressor on Strings reacts to Violins and Cellos together/);
    // by stack: they go through it together, as in the mix
    expect(stemWarnings(p, 'stacks')).toEqual([]);
    // (another stem sent there too: then it's said, by the stems' names)
    (p.tracks[0] as Track).channel.sends = [{ bus: 'bus_strings', level: -6, pre: false }];
    expect(stemWarnings(p, 'stacks').join(' ')).toMatch(/reacts to Piano and Strings together/);
  });
});
