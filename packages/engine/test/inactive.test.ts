import {
  newAudioTrack,
  newPlugin,
  newProject,
  newRegion,
  newTrack,
  PPQ,
  type Project,
  performed,
  projectEnd,
  SPACE_FILE,
} from '@holo/session';
import { describe, expect, it } from 'vitest';
import { compileGraph, compileTempo, songClips, songImpulses, songKits } from '../src/compile.ts';
import { type RenderSource, renderSession } from '../src/render.ts';

const SR = 48000;

/**
 * Bass and Keys (synths) with a bar of notes each; Strings (a pack instrument) and Vox (a recording)
 * whose sounds the source below doesn't have, and a Space Designer and a Drum Replacer on Strings.
 */
function song(): Project {
  const p = newProject('Parked');
  p.tempo = [{ tick: 0, bpm: 120 }];
  const bass = newTrack('Bass', { type: 'synth', preset: 'Fat Mono' });
  bass.regions = [
    { ...newRegion(0, PPQ * 4), notes: [0, 1, 2, 3].map((i) => ({ t: i * PPQ, d: PPQ, p: 36 + i * 2, v: 100 })) },
  ];
  const keys = newTrack('Keys', { type: 'synth', preset: 'Soft Keys' });
  keys.regions = [{ ...newRegion(0, PPQ * 4), notes: [60, 64, 67].map((k) => ({ t: 0, d: PPQ * 2, p: k, v: 90 })) }];
  const strings = newTrack('Strings', { type: 'sampler', pack: 'nopack', name: 'strings' });
  strings.regions = [{ ...newRegion(0, PPQ * 8), notes: [{ t: 0, d: PPQ * 8, p: 55, v: 80 }] }];
  const space = newPlugin('space');
  space.params.space = SPACE_FILE;
  space.settings = { ir: 'nopack/hall' };
  const replacer = newPlugin('replacer');
  replacer.settings = { kit: 'nopack/kit' };
  strings.channel.inserts.push(space, replacer);
  const vox = newAudioTrack('Vox');
  vox.regions = [
    {
      ...newRegion(0, PPQ * 12),
      audio: { file: 'aud_missing', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 },
    },
  ];
  p.tracks = [bass, keys, strings, vox];
  return p;
}

/** A source that has none of the packs or recordings, and writes down what it was asked for. */
function source(): { source: RenderSource; asked: string[] } {
  const asked: string[] = [];
  const no = (what: string) => {
    asked.push(what);
    return Promise.reject(new Error(`no ${what} here`));
  };
  return {
    asked,
    source: {
      instrument: (pack, name) => no(`instrument ${pack}/${name}`),
      sample: (pack, file) => no(`sample ${pack}/${file}`),
      audio: (file) => no(`audio ${file}`),
      impulse: (pack, name) => no(`impulse ${pack}/${name}`),
    },
  };
}

const off = (p: Project, ...names: string[]): Project => ({
  ...p,
  tracks: p.tracks.map((t) => (names.includes(t.name) ? { ...t, inactive: true } : t)),
});
const without = (p: Project, ...names: string[]): Project => ({
  ...p,
  tracks: p.tracks.filter((t) => !names.includes(t.name)),
});
const same = (a: Float32Array, b: Float32Array) => Buffer.from(a.buffer).equals(Buffer.from(b.buffer));

describe('an inactive track in the engine', () => {
  it("asks for none of its sounds: its instrument, recordings, spaces or plugins' kits", () => {
    const p = off(song(), 'Strings', 'Vox');
    const heard = performed(p);
    expect(songClips(heard)).toEqual([]);
    expect(songKits(heard)).toEqual([]);
    expect(songImpulses(heard, SR)).toEqual([]);
    const graph = compileGraph(heard, (id) => heard.tracks.findIndex((t) => t.id === id) + 1, compileTempo(heard, SR));
    expect(graph.tracks.map((t) => t.id)).toEqual(heard.tracks.map((t) => t.id));
    expect(graph.tracks).toHaveLength(2);
  });

  it('renders the same as the song without it, and asks for nothing of it', async () => {
    const p = song();
    const a = source();
    const parked = await renderSession(off(p, 'Strings', 'Vox'), a.source, { sampleRate: SR, tail: 1 });
    const b = source();
    const gone = await renderSession(without(p, 'Strings', 'Vox'), b.source, { sampleRate: SR, tail: 1 });
    expect(a.asked).toEqual([]);
    expect(parked.errors).toEqual([]);
    expect(parked.channels[0]?.length).toBe(gone.channels[0]?.length);
    expect(same(parked.channels[0] as Float32Array, gone.channels[0] as Float32Array)).toBe(true);
    expect(same(parked.channels[1] as Float32Array, gone.channels[1] as Float32Array)).toBe(true);
    // (the bounce ends with the heard tracks: Vox's long recording no longer sets its length)
    expect(projectEnd(performed(off(p, 'Strings', 'Vox')))).toBeLessThan(projectEnd(p));
  });

  it("doesn't silence the others with its solo", async () => {
    const p = song();
    const keys = p.tracks.find((t) => t.name === 'Keys');
    if (!keys) throw new Error('no Keys');
    keys.channel.solo = true;
    const parked = await renderSession(off(p, 'Keys', 'Strings', 'Vox'), source().source, {
      sampleRate: SR,
      tail: 1,
    });
    const gone = await renderSession(without(p, 'Keys', 'Strings', 'Vox'), source().source, {
      sampleRate: SR,
      tail: 1,
    });
    expect(same(parked.channels[0] as Float32Array, gone.channels[0] as Float32Array)).toBe(true);
    let peak = 0;
    for (const x of parked.channels[0] as Float32Array) peak = Math.max(peak, Math.abs(x));
    expect(peak).toBeGreaterThan(0.01);
  });
});
