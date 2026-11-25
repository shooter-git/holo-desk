import { compileGraph, compileTempo, compileTrack, EngineCore, meterTicks, type ToWorklet } from '@holo/engine';
import { newAudioTrack, newProject, PPQ } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { compactChannels, compactClip, scaleFor } from '../src/audio/compact.ts';

const FULL = 32768;

/** The floats 16-bit frames stand for. */
const back = (frames: Int16Array, scale: number) => Float32Array.from(frames, (v) => v * scale);

describe('what one 16-bit step is worth for a take', () => {
  it('is a 32768th when the take reaches full scale and no further', () => {
    expect(scaleFor(-1, 32767 / FULL)).toBe(1 / FULL);
    expect(scaleFor(-0.6, 0.9)).toBe(1 / FULL);
    // the lowest step there is fits; the highest float there is past it doesn't
    expect(scaleFor(0, 1)).toBe(2 / FULL);
    expect(scaleFor(-1.0001, 0)).toBe(2 / FULL);
  });

  it('is less for a quiet take, always by a power of two', () => {
    expect(scaleFor(-0.4, 0.3)).toBe(0.5 / FULL);
    expect(scaleFor(-0.01, 0.012)).toBe(2 ** -6 / FULL);
    expect(scaleFor(-0.5, 0)).toBe(0.5 / FULL);
    expect(Number.isInteger(Math.log2(scaleFor(-0.0003, 0.0002) * FULL))).toBe(true);
  });

  it('is more for a take louder than full scale', () => {
    expect(scaleFor(-1.5, 3.2)).toBe(4 / FULL);
    expect(scaleFor(-2, 0)).toBe(2 / FULL);
  });

  it('is full scale for silence, and stays within what a step can be worth', () => {
    expect(scaleFor(0, 0)).toBe(1 / FULL);
    expect(scaleFor(0, 1e-12)).toBe(2 ** -24 / FULL);
    expect(scaleFor(-1e9, 1e9)).toBe(1);
  });
});

describe('floats made 16-bit frames', () => {
  it('lose nothing when they were 16-bit to begin with, the lowest step included', async () => {
    const steps = [0, 1, -1, 12345, -12345, 32767, -32768, 255, -256];
    const floats = Float32Array.from(steps, (v) => v / FULL);
    const { channels, scale } = await compactChannels([floats], false);
    expect(scale).toBe(1 / FULL);
    expect(Array.from(channels[0] as Int16Array)).toEqual(steps);
    expect(back(channels[0] as Int16Array, scale)).toEqual(floats);
    // a quiet one too: its steps are doubled, each still a whole number
    const quiet = Float32Array.from([0, 3, -7, 16383, -16384], (v) => v / FULL);
    const small = await compactChannels([quiet], false);
    expect(small.scale).toBe(0.5 / FULL);
    expect(back(small.channels[0] as Int16Array, small.scale)).toEqual(quiet);
  });

  it('are rounded to the nearest step otherwise, never further off than half of one', async () => {
    const floats = Float32Array.from({ length: 5000 }, (_, i) => 0.37 * Math.sin(i / 11) + 0.2 * Math.sin(i / 3.7));
    const { channels, scale } = await compactChannels([floats], false);
    const got = back(channels[0] as Int16Array, scale);
    let worst = 0;
    for (let i = 0; i < floats.length; i++)
      worst = Math.max(worst, Math.abs((got[i] as number) - (floats[i] as number)));
    expect(worst).toBeLessThanOrEqual(scale / 2 + 1e-9);
    expect(worst).toBeGreaterThan(0);
  });

  it('keep a take louder than full scale whole: nothing is clipped', async () => {
    const floats = new Float32Array([0, 2.5, -3.1, 0.25, 1]);
    const { channels, scale } = await compactChannels([floats], false);
    expect(scale).toBe(4 / FULL);
    expect(Array.from(back(channels[0] as Int16Array, scale))).toEqual([0, 2.5, -3.0999755859375, 0.25, 1]);
  });

  it('are at one scale over every channel, the loudest deciding it', async () => {
    const left = new Float32Array([0.1, -0.1, 0.05]);
    const right = new Float32Array([0.9, -0.2, 0]);
    const { channels, scale } = await compactChannels([left, right], false);
    expect(scale).toBe(1 / FULL);
    expect(channels).toHaveLength(2);
    expect(Array.from(channels[0] as Int16Array)).toEqual([3277, -3277, 1638]);
    expect(Array.from(channels[1] as Int16Array)).toEqual([29491, -6554, 0]);
  });

  it('take what isn’t a number as silence, and don’t let it set the scale', async () => {
    const floats = new Float32Array([0.5, Number.NaN, Number.POSITIVE_INFINITY, -0.25, Number.NEGATIVE_INFINITY]);
    const { channels, scale } = await compactChannels([floats], false);
    expect(scale).toBe(1 / FULL);
    expect(Array.from(channels[0] as Int16Array)).toEqual([16384, 0, 0, -8192, 0]);
  });

  it('are silence at full scale for a silent take, and nothing for none', async () => {
    const silent = await compactChannels([new Float32Array(64)], false);
    expect(silent.scale).toBe(1 / FULL);
    expect(Array.from(silent.channels[0] as Int16Array).every((v) => v === 0)).toBe(true);
    expect(await compactChannels([], false)).toEqual({ channels: [], scale: 1 / FULL });
  });

  it('go into shared memory when every engine reads the one copy, and leave the floats as they were', async () => {
    const floats = Float32Array.from({ length: 300 }, (_, i) => Math.sin(i / 5) * 0.8);
    const before = floats.slice();
    const shared = await compactChannels([floats], true);
    const own = await compactChannels([floats], false);
    expect(shared.channels[0]?.buffer).toBeInstanceOf(SharedArrayBuffer);
    expect(own.channels[0]?.buffer).toBeInstanceOf(ArrayBuffer);
    expect(Array.from(shared.channels[0] as Int16Array)).toEqual(Array.from(own.channels[0] as Int16Array));
    expect(floats).toEqual(before);
  });

  it('go through a long take a stretch at a time, to the same frames', async () => {
    // (longer than one stretch: the page is given a moment in between)
    const n = (1 << 20) + 4321;
    const floats = Float32Array.from({ length: n }, (_, i) => ((i * 2654435761) % 65536) / 65536 - 0.5);
    const { channels, scale } = await compactChannels([floats], false);
    expect(scale).toBe(0.5 / FULL);
    const frames = channels[0] as Int16Array;
    expect(frames).toHaveLength(n);
    for (const i of [0, 1, (1 << 20) - 1, 1 << 20, n - 1])
      expect(frames[i]).toBe(Math.round((floats[i] as number) / scale));
  });
});

describe('a take held as 16-bit, played by the engine', () => {
  const SR = 48000;
  const BLOCK = 128;

  /** A take played through a song of one audio track with nothing on it, as `audio` hands it over. */
  function played(audio: Extract<ToWorklet, { type: 'audio' }>, frames: number): Float32Array {
    const p = newProject('Take');
    p.buses = [];
    p.master.inserts = [];
    const t = { ...newAudioTrack('Take'), id: 'trk_t' };
    t.channel.sends = [];
    p.tracks = [t];
    const core = new EngineCore(SR, (m) => {
      if (m.type === 'error') throw new Error(m.message);
    });
    const segments = compileTempo(p, SR);
    core.receive({ type: 'init', ring: null, meters: null, transport: null });
    core.receive({ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) });
    core.receive(audio);
    core.receive({ type: 'graph', graph: compileGraph(p, () => 1, segments) });
    core.receive({ type: 'sequence', num: 1, events: compileTrack(t, segments) });
    const clip = {
      key: 'take',
      start: 0,
      end: frames,
      source: 0,
      regionStart: 0,
      regionEnd: frames,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
    };
    core.receive({ type: 'clips', num: 1, clips: [clip] });
    core.receive({ type: 'play', frame: 0, record: false, countIn: 0 });
    const out = new Float32Array(frames);
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (let at = 0; at < frames; at += BLOCK) {
      core.process(l, r, undefined, at);
      out.set(l, at);
    }
    return out;
  }

  it.each([
    ['a take near full scale', 0.8],
    ['a quiet one', 0.003],
    ['one louder than full scale', 2.7],
  ])('is within half a step of the take as floats: %s', async (_name, level) => {
    const frames = BLOCK * 300;
    // a note that swells and dies away, with a little noise under it
    const take = Float32Array.from(
      { length: frames },
      (_, i) =>
        level * Math.sin((i / frames) * Math.PI) ** 2 * Math.sin(i / 23) + level * 1e-3 * Math.sin(i * 12.9898) ** 3,
    );
    const small = await compactChannels([take], false);
    const asFloats = played({ type: 'audio', key: 'take', channels: [take.slice()] }, frames);
    const as16 = played({ type: 'audio', key: 'take', ...small }, frames);
    let worst = 0;
    let loudest = 0;
    for (let i = 0; i < frames; i++) {
      worst = Math.max(worst, Math.abs((as16[i] as number) - (asFloats[i] as number)));
      loudest = Math.max(loudest, Math.abs(asFloats[i] as number));
    }
    // (a centred channel at unity passes the take as it is)
    expect(loudest).toBeGreaterThan(level * 0.9);
    expect(worst).toBeLessThanOrEqual(small.scale / 2 + 1e-9);
    // a step is no more than a 16384th of the take's own loudest frame: 84 dB under it at least
    expect(small.scale).toBeLessThanOrEqual(loudest / 16383);
  });
});

describe('whether a clip is held as 16-bit', () => {
  const plain = { touch: true, remote: false, pluginData: false, patchBase: false };

  it('is, for a plain recording on a phone or a tablet', () => {
    expect(compactClip(plain)).toBe(true);
  });

  it('isn’t on a computer, whatever the clip', () => {
    expect(compactClip({ ...plain, touch: false })).toBe(false);
  });

  it('isn’t while HO[LO] Engine plays', () => {
    expect(compactClip({ ...plain, remote: true })).toBe(false);
  });

  it('isn’t for a plugin’s data, nor for a recording whose notes are edited', () => {
    expect(compactClip({ ...plain, pluginData: true })).toBe(false);
    expect(compactClip({ ...plain, patchBase: true })).toBe(false);
  });
});
