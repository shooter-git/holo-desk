import { type AudioFile, newAudioTrack, newProject, newRegion, newTrack, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { ApiError, type ImportAnswer } from '../src/api.ts';
import { allOps, BAR, call, refused, setup } from './helpers.ts';

const TAKE: AudioFile = { id: 'aud_take000001', name: 'take.wav', seconds: 4, rate: 48000, channels: 2 };
const audio = (file: AudioFile, how: 'copied' | 'converted' | 'studio' = 'copied'): ImportAnswer => ({
  done: true,
  kind: 'audio',
  how,
  file,
});

/** A MIDI file as HO[LO] reads it: a bass line (bars 1–2) and a lead (bar 2), at 90. */
function midiSong(): Project {
  const p = newProject('groove');
  p.tempo = [{ tick: 0, bpm: 90 }];
  const bass = newTrack('Bass line', { type: 'synth', preset: 'Soft Keys' });
  const r = newRegion(0, BAR * 2, 'Bass line');
  r.notes = [
    { t: 0, d: PPQ, p: 40, v: 100 },
    { t: BAR, d: PPQ * 2, p: 43, v: 100 },
  ];
  bass.regions = [r];
  const lead = newTrack('Lead', { type: 'synth', preset: 'Soft Keys' });
  const l = newRegion(BAR, BAR, 'Lead');
  l.notes = [{ t: 0, d: PPQ, p: 72, v: 90 }];
  lead.regions = [l];
  p.tracks = [bass, lead];
  return p;
}
const notes = (song: Project, name = 'groove.mid'): ImportAnswer => ({
  done: true,
  kind: 'notes',
  format: 'midi',
  name,
  song,
  warnings: [],
});

const A = 'att_000000000001';

describe('importing a recording', () => {
  it('puts it on a new audio track from where it’s asked, as one batch: the file, the track, the region', async () => {
    const api = setup({ imports: { [A]: audio(TAKE) } });
    const r = await call(api, 'import', { attachment: A, at: '5' });
    expect(api.batches).toHaveLength(1);
    const [file, track, region] = allOps(api);
    expect(file).toEqual({ op: 'addFile', file: TAKE });
    expect(track).toMatchObject({ op: 'addTrack', track: { kind: 'audio', name: 'take' } });
    if (track?.op !== 'addTrack' || region?.op !== 'addRegion') throw new Error('ops');
    // 4 s at 120 is 8 beats: two bars
    expect(region).toMatchObject({
      track: track.track.id,
      region: {
        start: BAR * 4,
        length: BAR * 2,
        name: 'take',
        audio: { file: TAKE.id, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 },
      },
    });
    expect(api.project.files).toEqual([TAKE]);
    expect(r.text).toContain('Imported "take.wav" (4.0 s, 48 kHz stereo) onto a new audio track "take"');
    expect(r.progress).toBe('Imported take.wav on take, bars 5–6');
    expect(api.calls.find((c) => c.method === 'importAttachment')?.args).toEqual([A]);
  });

  it('goes onto the song’s audio track at the playhead, never onto an instrument track', async () => {
    const api = setup({
      imports: { [A]: audio({ ...TAKE, name: 'verse take.mp3', channels: 1, rate: 44100 }, 'studio') },
      state: { playhead: BAR * 2 + PPQ },
    });
    api.project.tracks.push({ ...newAudioTrack('Vocal'), id: 'trk_vocal' });
    const r = await call(api, 'import', { attachment: A, track: 'vocal', name: 'Verse' });
    const ops = allOps(api);
    expect(ops.map((o) => o.op)).toEqual(['addFile', 'addRegion']);
    expect(ops[1]).toMatchObject({ track: 'trk_vocal', region: { start: BAR * 2 + PPQ, name: 'Verse' } });
    expect(r.text).toContain('44.1 kHz mono, kept as WAV) onto "Vocal"');
    expect(await refused(setup({ imports: { [A]: audio(TAKE) } }), 'import', { attachment: A, track: 'Bass' })).toMatch(
      /"Bass" is an instrument track: a recording goes on an audio track/,
    );
  });

  it('says when the studio is still converting it, and the same call again finishes', async () => {
    const api = setup({
      imports: {
        [A]: [
          { done: false, line: 'The studio is still converting song.mp3' },
          audio({ ...TAKE, name: 'song.mp3' }, 'studio'),
        ],
      },
    });
    const first = await call(api, 'import', { attachment: A, at: '1' });
    expect(first.text).toMatch(/^The studio is still converting song\.mp3\. Call import again with the same arguments/);
    expect(api.batches).toHaveLength(0);
    await call(api, 'import', { attachment: A, at: '1' });
    expect(allOps(api).map((o) => o.op)).toEqual(['addFile', 'addTrack', 'addRegion']);
  });

  it('says plainly what can’t be imported', async () => {
    expect(await refused(setup(), 'import', { attachment: 'take.wav' })).toMatch(/isn't an attachment's id/);
    expect(await refused(setup(), 'import', { attachment: A })).toMatch(
      /is gone: HO\[LO\] keeps attachments for 7 days/,
    );
    const api = setup();
    api.importAttachment = async () => {
      throw new ApiError(415, 'page.png is a picture: a recording, a MIDI file or a MusicXML score can be imported');
    };
    expect(await refused(api, 'import', { attachment: A })).toBe(
      'page.png is a picture: a recording, a MIDI file or a MusicXML score can be imported',
    );
  });
});

describe('importing a MIDI or MusicXML file', () => {
  it('brings its parts in as new tracks from the playhead’s bar, keeping the song’s tempo', async () => {
    const api = setup({ imports: { [A]: notes(midiSong()) }, state: { playhead: BAR * 8 + PPQ } });
    const r = await call(api, 'import', { attachment: A });
    expect(api.batches).toHaveLength(1);
    const ops = allOps(api);
    expect(ops.map((o) => o.op)).toEqual(['addTrack', 'addRegion', 'addTrack', 'addRegion']);
    expect(ops[1]).toMatchObject({ region: { start: BAR * 8, length: BAR * 2 } });
    expect(ops[3]).toMatchObject({ region: { start: BAR * 9, length: BAR } });
    expect(api.project.tempo).toEqual([{ tick: 0, bpm: 120 }]);
    expect(r.text).toContain('Imported "groove.mid" (MIDI) at 9 1 1, the song\'s tempo kept:');
    expect(r.text).toContain('- new track "Bass line"');
    expect(r.text).toContain("The file's tempo is 90; the song keeps its 120");
    expect(r.text).toContain('give them instruments that fit with track_set');
    expect(r.progress).toBe('Imported groove.mid: 2 tracks, bars 9–10');
  });

  it('takes the parts asked for, adopts the file’s tempo, or puts one part on the song’s own track', async () => {
    const api = setup({ imports: { [A]: notes(midiSong()) } });
    await call(api, 'import', { attachment: A, at: '3', parts: ['bass'], tempo: 'adopt', name: 'Bass synth' });
    const ops = allOps(api);
    expect(ops.map((o) => o.op)).toEqual(['setProject', 'addTrack', 'addRegion']);
    expect(ops[1]).toMatchObject({ track: { name: 'Bass synth' } });
    // the song's Strings play to bar 8: its 120 comes back after the file's two bars
    expect(api.project.tempo).toEqual([
      { tick: 0, bpm: 120 },
      { tick: BAR * 2, bpm: 90 },
      { tick: BAR * 4, bpm: 120 },
    ]);

    const onto = setup({ imports: { [A]: notes(midiSong()) } });
    const r = await call(onto, 'import', { attachment: A, at: '5', parts: [2], track: 'Bass' });
    expect(allOps(onto)).toMatchObject([{ op: 'addRegion', track: 'trk_bass', region: { start: BAR * 5 } }]);
    expect(r.text).toContain('- onto "Bass", its part "Lead": 1 note, bar 6');

    expect(
      await refused(setup({ imports: { [A]: notes(midiSong()) } }), 'import', { attachment: A, parts: ['Flute'] }),
    ).toBe('The file has no part "Flute". Its parts: 1 "Bass line", 2 "Lead"');
    expect(
      await refused(setup({ imports: { [A]: notes(midiSong()) } }), 'import', { attachment: A, track: 'Bass' }),
    ).toMatch(/2 parts can't all go on "Bass"/);
    expect(
      await refused(setup({ imports: { [A]: notes(midiSong()) } }), 'import', { attachment: A, parts: [{ x: 1 }] }),
    ).toMatch(/"parts" are the names of the file's parts or their numbers/);
  });
});

describe('asking for a bounce or the creation’s render', () => {
  it('asks the user, who clicks', async () => {
    for (const kind of ['bounce', 'render'] as const) {
      const api = setup();
      const r = await call(api, 'ask_permission', { kind, detail: 'To measure how loud the mix is' });
      expect(api.calls.find((c) => c.method === 'permission')?.args).toEqual([
        { kind, detail: 'To measure how loud the mix is' },
      ]);
      expect(r.text).toContain(`Asked the user (${kind})`);
    }
  });
});
