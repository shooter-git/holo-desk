import type { SamplerSpec } from '@holo/engine';
import { beforeEach, describe, expect, it, vi } from 'vitest';

/** What the audio thread was given, by instrument. */
const given = new Map<string, SamplerSpec>();

vi.mock('../src/audio/engine.ts', () => ({
  engine: {
    ctx: { sampleRate: 48000 },
    sampleRate: 48000,
    playing: false,
    hasSampler: (key: string) => given.has(key),
    addSampler: (spec: SamplerSpec) => {
      given.set(spec.key, spec);
      return true;
    },
    onRestart: () => undefined,
    onForget: () => undefined,
  },
}));

/** A Prism patch whose sources are all drawn: no samples, its sound all in its params. */
const DRAWN = {
  pack: 'mine-patches',
  name: 'low-bass',
  title: 'low bass (patch)',
  pitched: true,
  release: 0.1,
  attack: 0,
  oneShot: false,
  velocityRange: 0,
  synth: 'Pulse Bells',
  params: { 'patch:blank': 1, 's1:on': 1, 's1:kind': 0, 'w1:0': -1, 'w1:1': 1 },
  zones: [],
  size: 0,
};

vi.mock('../src/audio/pack-files.ts', () => ({
  instrumentManifest: async (pack: string, name: string) => {
    if (pack === DRAWN.pack && name === DRAWN.name) return DRAWN;
    throw new Error(`No instrument ${pack}/${name}`);
  },
  packFileData: async () => {
    throw new Error('a patch with no samples fetches no files');
  },
  pcm16: () => null,
  channelData: () => new Float32Array(0),
  channelPcm: () => new Int16Array(0),
  pcmChannel: () => new Float32Array(0),
}));

const { SampleLibrary } = await import('../src/audio/samples.ts');

beforeEach(() => given.clear());

describe('a synth’s patch with no samples, from a pack', () => {
  it('goes to the audio thread with its patch, whole or for the keys a phone asks for', async () => {
    const key = `${DRAWN.pack}/${DRAWN.name}`;
    // a computer: the whole instrument
    const whole = new SampleLibrary();
    await whole.ensure(DRAWN.pack, DRAWN.name);
    expect(given.get(key)).toMatchObject({ key, zones: [], synth: 'Pulse Bells', params: DRAWN.params });
    expect(whole.state(DRAWN.pack, DRAWN.name)).toEqual({ state: 'ready' });

    // a phone: only the keys the song plays (here, a bass line's lowest)
    given.clear();
    const phone = new SampleLibrary();
    await phone.ensure(DRAWN.pack, DRAWN.name, 1, new Set([32, 36, 41]));
    expect(given.get(key)).toMatchObject({ key, zones: [], synth: 'Pulse Bells' });
    // more keys later: nothing more to send
    const before = given.get(key);
    await phone.ensure(DRAWN.pack, DRAWN.name, 1, new Set([29]));
    expect(given.get(key)).toBe(before);
  });
});
