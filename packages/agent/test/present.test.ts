import { newAudioTrack, newPlugin, newRegion } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { FAKE_COMMANDS } from '../src/api.ts';
import type { Block, Go } from '../src/view.ts';
import { call, memoryOf, refused, setup } from './helpers.ts';

/** The view and the go the last finish sent. */
const sent = (api: ReturnType<typeof setup>): { view?: Block[]; go?: Go } => {
  const c = api.calls.findLast((x) => x.method === 'finish');
  return { view: c?.args[2] as Block[] | undefined, go: c?.args[3] as Go | undefined };
};

/** The test song, its Strings with a reverb on them. */
const withReverb = () => {
  const api = setup();
  const strings = api.project.tracks.find((t) => t.id === 'trk_strings');
  strings?.channel.inserts.push({ ...newPlugin('reverb'), id: 'fx_rev' });
  return api;
};

describe('versions of the song, for a reply’s view', () => {
  it('keeps the song as it is under a name', async () => {
    const api = setup();
    const r = await call(api, 'version', { name: 'Half step down' });
    expect(r.text).toMatch(/"Half step down"/);
    expect(api.calls.at(-1)).toEqual({ method: 'version', args: ['Half step down'] });
    expect(memoryOf(api).versions).toEqual(['Half step down']);
  });

  it('refuses the names every turn has, one used already, and more than eight', async () => {
    const api = setup();
    expect(await refused(api, 'version', { name: 'before' })).toMatch(/there anyway/);
    expect(await refused(api, 'version', { name: 'previous' })).toMatch(/there anyway/);
    await call(api, 'version', { name: 'Hall' });
    expect(await refused(api, 'version', { name: 'Hall' })).toMatch(/already/);
    for (let i = 2; i <= 8; i++) await call(api, 'version', { name: `Take ${i}` });
    expect(await refused(api, 'version', { name: 'Take 9' })).toMatch(/At most 8/);
  });
});

describe('finish, with what the reply shows', () => {
  it('sends the view in the song’s ids', async () => {
    const api = withReverb();
    await call(api, 'version', { name: 'Lower' });
    await call(api, 'finish', {
      label: 'Strings down a half step',
      reply: 'The strings are a half step lower; compare them in bars 1–4.',
      view: [
        {
          choice: [
            { label: 'Original', do: { play: { from: 1, to: 5, version: 'before', solo: ['Strings'] } } },
            { label: 'Lower', do: { play: { from: 1, to: 5, version: 'Lower' } } },
          ],
        },
        { slider: { track: 'strings', param: 'reverb.mix' }, label: 'Room' },
        { toggle: { track: 'Strings', param: 'reverb.on' } },
        { list: [{ text: 'The A region', do: { go: { region: 'A', track: 'Strings' } } }] },
        { notes: { track: 'Strings', from: 1, to: 5, version: 'Lower' } },
        { button: 'Click', do: { command: 'metronome' } },
      ],
    });
    const { view } = sent(api);
    expect(view?.[0]).toEqual({
      choice: [
        { label: 'Original', do: { play: { from: 1, to: 5, version: 'before', solo: ['trk_strings'] } } },
        { label: 'Lower', do: { play: { from: 1, to: 5, version: 'Lower' } } },
      ],
    });
    expect(view?.[1]).toEqual({ slider: { track: 'trk_strings', param: 'fx:fx_rev:mix' }, label: 'Room' });
    expect(view?.[2]).toEqual({ toggle: { track: 'trk_strings', param: 'on:fx_rev' } });
    expect(view?.[3]).toEqual({
      list: [{ text: 'The A region', do: { go: { region: 'rgn_a', track: 'trk_strings' } } }],
    });
    expect(view?.[4]).toEqual({ notes: { track: 'trk_strings', from: 1, to: 5, version: 'Lower' } });
    // the studio's commands are asked only when a view runs one
    expect(api.calls.filter((c) => c.method === 'commands')).toHaveLength(1);
  });

  it('goes where they asked to see, its pitch a note number', async () => {
    const api = setup();
    await call(api, 'finish', {
      label: 'Read the strings',
      reply: 'Here are the strings’ notes in bar 3.',
      go: { track: 'Strings', notes: { from: '3', to: '4', pitch: 'E4' } },
    });
    expect(sent(api)).toEqual({
      view: undefined,
      go: { track: 'trk_strings', notes: { from: '3', to: '4', pitch: 64 } },
    });
  });

  it("goes to a recording's notes in the Audio Editor's Notes view, and draws them", async () => {
    const api = setup();
    const vocal = { ...newAudioTrack('Vocal'), id: 'trk_vocal' };
    vocal.regions.push({
      ...newRegion(0, 3840 * 8, 'Take'),
      id: 'rgn_take',
      audio: { file: 'aud_1', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 },
    });
    api.project.tracks.push(vocal);
    await call(api, 'finish', {
      label: 'Read the take',
      reply: 'Bar 3 is flat.',
      view: [
        { notes: { track: 'Vocal', from: 1, to: 5 } },
        {
          list: [
            {
              text: 'Bar 3',
              do: { go: { track: 'Vocal', notes: { from: '3', to: '4', pitch: 'E4' }, view: 'notes' } },
            },
          ],
        },
      ],
      go: { track: 'Vocal', region: 'Take', view: 'notes' },
    });
    expect(sent(api)).toEqual({
      view: [
        { notes: { track: 'trk_vocal', from: 1, to: 5 } },
        {
          list: [
            {
              text: 'Bar 3',
              do: { go: { track: 'trk_vocal', notes: { from: '3', to: '4', pitch: 64 }, view: 'notes' } },
            },
          ],
        },
      ],
      go: { track: 'trk_vocal', region: 'rgn_take', view: 'notes' },
    });
    // a waveform is still only a recording's
    expect(
      await refused(api, 'finish', { label: 'x', reply: 'y', view: [{ wave: { track: 'Strings', from: 1, to: 2 } }] }),
    ).toMatch(/show it with notes/);
  });

  it('says what to fix', async () => {
    const api = withReverb();
    const finish = (view: unknown) => refused(api, 'finish', { label: 'x', reply: 'y', view });
    expect(await finish([{ toggle: { track: 'Vocal', param: 'mute' } }])).toMatch(/No track "Vocal"/);
    expect(await finish([{ button: 'A', do: { play: { from: 1, to: 5, version: 'Hall' } } }])).toMatch(
      /No version "Hall": the versions are "before", "after"/,
    );
    expect(await finish([{ button: 'A', do: { command: 'launch' } }])).toMatch(
      new RegExp(`no command "launch": ${FAKE_COMMANDS.map((c) => c.id).join(', ')}`),
    );
    expect(await finish([{ slider: { track: 'Strings', param: 'mute' } }])).toMatch(/use a toggle/);
    expect(await finish([{ toggle: { track: 'Strings', param: 'volume' } }])).toMatch(/use a slider/);
    expect(await finish([{ slider: { track: 'Strings', param: 'eq.gain' } }])).toMatch(/Strings has no eq/);
    expect(await finish([{ slider: { track: 'Strings', param: 'reverb.wetness' } }])).toMatch(/has no "wetness"/);
    expect(await finish([{ button: 'Up', do: { set: { track: 'Strings', param: 'pan' }, value: 3 } }])).toMatch(
      /Pan goes from -1 to 1/,
    );
    expect(await finish([{ wave: { track: 'Strings', from: 1, to: 2 } }])).toMatch(/show it with notes/);
    expect(await finish([{ toggle: { track: 'master', param: 'solo' } }])).toMatch(/Only a track can be soloed/);
    expect(await finish([{ banner: 'Hi' }])).toMatch(/view\[0\]: the kinds/);
    // nothing was sent
    expect(api.calls.some((c) => c.method === 'finish')).toBe(false);
  });

  it('compares an earlier change with "previous", the song before the previous request', async () => {
    const api = setup();
    const view = [
      {
        choice: [
          { label: 'Untuned', do: { play: { from: 1, to: 5, version: 'previous' } } },
          { label: 'Tuned', do: { play: { from: 1, to: 5, version: 'before' } } },
        ],
      },
    ];
    await call(api, 'finish', { label: 'Showed the tuning', reply: 'Here it is.', view });
    expect(sent(api).view).toEqual(view);
  });

  it('finishes as before without one', async () => {
    const api = setup();
    await call(api, 'finish', { label: 'Bass line', reply: 'A walking bass under the verse.' });
    expect(api.calls.at(-1)).toEqual({ method: 'finish', args: ['Bass line', 'A walking bass under the verse.'] });
  });
});

describe('the studio’s commands', () => {
  it('are listed where the user is', async () => {
    const r = await call(setup(), 'song_status');
    expect(r.text).toMatch(/Commands a button can run: play \(Play\), metronome \(Metronome\)/);
  });

  it('are left out when the studio lists none', async () => {
    const r = await call(setup({ commands: [] }), 'song_status');
    expect(r.text).not.toMatch(/Commands a button/);
  });
});
