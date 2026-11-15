import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { newPlugin } from '@holo/session';
import { describe, expect, it } from 'vitest';
import {
  type Block,
  bindingInfo,
  bindingOps,
  bindingText,
  checkGo,
  checkView,
  LIMITS,
  mapRefs,
  viewCommands,
  viewVersions,
} from '../src/view.ts';
import { song } from './helpers.ts';

const error = (input: unknown, strict = false): string => {
  const r = checkView(input, strict);
  if (r.ok) throw new Error('it passed');
  return r.error;
};

describe('a reply’s view, checked', () => {
  it('takes blocks of every kind, composed', () => {
    const view = [
      { text: 'Two takes of the chorus.' },
      {
        row: [
          {
            choice: [
              { label: 'Original', do: { play: { from: 9, to: 17, version: 'before' } } },
              { label: 'Lower', do: { play: { from: 9, to: 17, version: 'after' } } },
            ],
          },
          { button: 'Keep the original', do: { keep: 'before' } },
        ],
      },
      {
        group: [
          { slider: { track: 'Vocal', param: 'pitch.speed' }, label: 'Speed' },
          { toggle: { track: 'Vocal', param: 'pitch.on' } },
        ],
        title: 'Correction',
      },
      {
        list: [
          {
            text: 'Bar 12',
            detail: '30 cents flat',
            do: { go: { track: 'Vocal', notes: { from: '12', to: '12.3', pitch: 'E4' } } },
          },
          { text: 'Just a line' },
        ],
      },
      {
        table: {
          head: ['Track', 'Loudness', ''],
          rows: [['Vocal', -14.2, { slider: { track: 'Vocal', param: 'volume' } }]],
        },
      },
      { chart: [1, 2, { y: -3, label: 'bar 12', go: { bar: 12 } }], kind: 'bars', unit: 'cents', ref: 0 },
      { notes: { track: 'Strings', from: 1, to: 5 } },
      { wave: { track: 'Vocal', from: 9, to: 13, version: 'before' } },
      { button: 'Metronome', do: { command: 'metronome' } },
      { button: 'More air', do: { ask: 'Give the vocal a little more air' } },
      { button: 'Louder', do: { set: { track: 'Vocal', param: 'volume' }, value: -3 } },
    ];
    const r = checkView(view);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.blocks).toHaveLength(view.length);
  });

  it('says what’s wrong and where', () => {
    expect(error([{ banner: 'Hi' }])).toMatch(/^view\[0\]: the kinds: text, row/);
    expect(error([{ text: 'a', button: 'b' }])).toMatch(/one kind a block/);
    expect(error([{ text: 'a', colour: 'red' }])).toMatch(/view\[0\]: "colour" isn't one of its fields/);
    expect(error([{ row: [{ button: 'Play', do: { play: { from: 9, to: 9 } } }] }])).toMatch(
      /view\[0\]\.row\[0\]\.do\.play: "to" comes after "from"/,
    );
    expect(error([{ button: 'Go' }])).toMatch(/a button needs "do"/);
    expect(error([{ button: 'x', do: { play: { from: 1, to: 2 }, go: { bar: 1 } } }])).toMatch(/do is one of/);
    expect(error([{ text: '<b>bold</b>'.repeat(60) }])).toMatch(/at most 400/);
    expect(error([])).toMatch(/a list of blocks/);
    expect(error([{ keep: 'before' }])).toMatch(/the kinds/);
    expect(error([{ list: [{ text: 'x', do: { keep: 'before; drop table' } }] }])).toMatch(/isn't a version's name/);
  });

  it('keeps to its limits', () => {
    expect(error(Array.from({ length: LIMITS.top + 1 }, () => ({ text: 'a' })))).toMatch(/at most 24 blocks/);
    const deep = { row: [{ group: [{ row: [{ text: 'too deep' }] }] }] };
    expect(error([deep])).toMatch(/at most 3 deep/);
    expect(checkView([{ row: [{ group: [{ text: 'three deep' }] }] }]).ok).toBe(true);
    expect(error([{ table: { rows: [[{ chart: [1] }]] } }])).toMatch(/a table cell holds/);
    const many = Array.from({ length: 20 }, () => ({ row: Array.from({ length: 4 }, () => ({ text: 'a' })) }));
    expect(error(many)).toMatch(/at most 80 pieces/);
    expect(error([{ choice: [{ label: 'Only', do: { keep: 'before' } }] }])).toMatch(/at least two/);
  });

  it('wants resolved references when strict', () => {
    const named = [{ slider: { track: 'Vocal', param: 'pitch.speed' } }];
    expect(checkView(named).ok).toBe(true);
    expect(error(named, true)).toMatch(/isn't a resolved setting/);
    expect(checkView([{ slider: { track: 'trk_1', param: 'fx:fx_1:speed' } }], true).ok).toBe(true);
    expect(checkView([{ toggle: { track: 'trk_1', param: 'on:fx_1' } }], true).ok).toBe(true);
    const pitched = [{ list: [{ text: 'x', do: { go: { track: 't', notes: { from: 1, to: 2, pitch: 'E4' } } } }] }];
    expect(checkView(pitched).ok).toBe(true);
    expect(error(pitched, true)).toMatch(/pitch must be a MIDI note number/);
  });

  it('checks a go on its own', () => {
    expect(checkGo({ bar: 12 })).toEqual({ ok: true, go: { bar: 12 } });
    expect(checkGo({ notes: { from: 1, to: 2 } })).toEqual({ ok: false, error: 'go: say the "track" of the notes' });
    expect(checkGo({})).toMatchObject({ ok: false });
  });

  it('goes through every reference', () => {
    const r = checkView([
      { button: 'A', do: { play: { from: 1, to: 2, version: 'Low', solo: ['Vocal'] } } },
      { notes: { track: 'Keys', from: 1, to: 2, version: 'before' } },
      {
        list: [
          { text: 'x', do: { command: 'metronome' } },
          { text: 'y', do: { keep: 'Low' } },
        ],
      },
      { table: { rows: [[{ toggle: { track: 'Vocal', param: 'mute' } }]] } },
    ]);
    if (!r.ok) throw new Error(r.error);
    const blocks: Block[] = r.blocks;
    expect(viewVersions(blocks)).toEqual(['Low', 'before']);
    expect(viewCommands(blocks)).toEqual(['metronome']);
    const mapped = mapRefs(blocks, {
      track: (n) => `id:${n}`,
      binding: (b) => ({ track: `id:${b.track}`, param: 'mute' }),
      version: (v) => v.toUpperCase(),
    });
    expect(mapped[0]).toEqual({ button: 'A', do: { play: { from: 1, to: 2, version: 'LOW', solo: ['id:Vocal'] } } });
    expect(mapped[1]).toEqual({ notes: { track: 'id:Keys', from: 1, to: 2, version: 'BEFORE' } });
    expect(mapped[3]).toEqual({ table: { rows: [[{ toggle: { track: 'id:Vocal', param: 'mute' } }]] } });
  });

  it('runs anywhere: it imports only @holo/session', () => {
    const text = readFileSync(join(import.meta.dirname, '../src/view.ts'), 'utf8');
    const from = [...text.matchAll(/^import[^;]*from '([^']+)'/gm)].map((m) => m[1]);
    expect(from).toEqual(['@holo/session']);
  });
});

describe('a setting a view binds', () => {
  const withPlugin = () => {
    const p = song();
    const strings = p.tracks.find((t) => t.id === 'trk_strings');
    if (!strings) throw new Error('no strings');
    const reverb = { ...newPlugin('reverb'), id: 'fx_rev' };
    strings.channel.inserts.push(reverb);
    p.buses.push({ id: 'bus_room', name: 'Room', color: '#888', channel: { ...p.master, inserts: [], sends: [] } });
    strings.channel.sends.push({ bus: 'bus_room', level: -12, pre: false });
    return p;
  };

  it('says what it is, its range and its value', () => {
    const p = withPlugin();
    expect(bindingInfo(p, { track: 'trk_strings', param: 'volume' })).toMatchObject({
      channel: 'Strings',
      name: 'Volume',
      kind: 'number',
      scale: 'fader',
    });
    expect(bindingInfo(p, { track: 'trk_strings', param: 'send:bus_room' })).toMatchObject({
      value: -12,
      name: 'Send to Room',
    });
    expect(bindingInfo(p, { track: 'trk_strings', param: 'on:fx_rev' })).toMatchObject({ kind: 'switch', value: 1 });
    const mix = bindingInfo(p, { track: 'trk_strings', param: 'fx:fx_rev:mix' });
    expect(mix?.kind).toBe('number');
    expect(mix?.name).toMatch(/: /);
    expect(bindingInfo(p, { track: 'master', param: 'solo' })).toBeNull();
    expect(bindingInfo(p, { track: 'trk_gone', param: 'volume' })).toBeNull();
    expect(bindingInfo(p, { track: 'trk_strings', param: 'fx:fx_gone:mix' })).toBeNull();
  });

  it('sets it with the ops the mixer uses, clamped to its range', () => {
    const p = withPlugin();
    expect(bindingOps(p, { track: 'trk_strings', param: 'volume' }, 40)).toEqual([
      { op: 'updateChannel', target: 'trk_strings', patch: { volume: 6 } },
    ]);
    expect(bindingOps(p, { track: 'trk_strings', param: 'solo' }, 1)).toEqual([
      { op: 'updateChannel', target: 'trk_strings', patch: { solo: true } },
    ]);
    expect(bindingOps(p, { track: 'trk_strings', param: 'on:fx_rev' }, 0)).toEqual([
      { op: 'updatePlugin', target: 'trk_strings', plugin: 'fx_rev', patch: { bypass: true } },
    ]);
    expect(bindingOps(p, { track: 'trk_strings', param: 'send:bus_room' }, -6)).toEqual([
      { op: 'updateChannel', target: 'trk_strings', patch: { sends: [{ bus: 'bus_room', level: -6, pre: false }] } },
    ]);
    expect(bindingOps(p, { track: 'trk_strings', param: 'fx:fx_rev:mix' }, 30)[0]).toMatchObject({
      op: 'updatePlugin',
      plugin: 'fx_rev',
    });
    expect(bindingOps(p, { track: 'trk_gone', param: 'volume' }, 0)).toEqual([]);
  });

  it('says a value in words', () => {
    const p = withPlugin();
    const vol = bindingInfo(p, { track: 'trk_strings', param: 'volume' });
    const pan = bindingInfo(p, { track: 'trk_strings', param: 'pan' });
    if (!vol || !pan) throw new Error('missing');
    expect(bindingText(vol, -6)).toBe('-6.0 dB');
    expect(bindingText(vol, -144)).toBe('−∞ dB');
    expect(bindingText(pan, 0)).toBe('Center');
    expect(bindingText(pan, -0.5)).toBe('L 32');
  });
});
