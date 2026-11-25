import { newAudioTrack, newPlugin, newProject, newRegion, PPQ, type Project } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { aheadShared } from '../src/ahead.ts';
import { compileGraph, compileTempo, compileTrack, meterTicks, pluginClips, songClips } from '../src/compile.ts';
import { EngineCore } from '../src/core.ts';
import type { ClipSpec, SampleFrames, ToWorklet } from '../src/protocol.ts';

// A recording held as 16-bit (a phone's, to take half the memory): its frames with what one step of
// theirs is worth, a power of two. It plays exactly as the floats it stands for, wherever the engine
// reads a clip: the song's clips with their fades and cuts, a crossfade between two lists, a patch
// beside its recording, an audition, and the transport's own fades.

const SR = 48000;
const BLOCK = 128;

/** Frames of noise as 16-bit PCM, the same every run. */
function pcm(n: number, seed: number): Int16Array {
  const out = new Int16Array(n);
  let x = seed;
  for (let i = 0; i < n; i++) {
    x = (x * 1103515245 + 12345) >>> 0;
    out[i] = (x >>> 16) - 32768;
  }
  return out;
}

/** A tone as 16-bit PCM (something a crossfade can line up). */
const tonePcm = (n: number, hz: number, level: number) =>
  Int16Array.from({ length: n }, (_, i) => Math.round(32767 * level * Math.sin((2 * Math.PI * hz * i) / SR)));

/** The floats 16-bit frames stand for, each step worth `scale`. */
const asFloats = (a: Int16Array, scale: number) => Float32Array.from(a, (v) => v * scale);

const same = (a: Float32Array, b: Float32Array) =>
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

const peak = (x: Float32Array) => x.reduce((m, v) => Math.max(m, Math.abs(v)), 0);

/** A song of one audio track: no plugins, no buses, so the mix is the clips' sum. */
function song(): Project {
  const p = newProject('Frames');
  p.buses = [];
  p.master.inserts = [];
  const t = { ...newAudioTrack('Vocal'), id: 'trk_v' };
  t.channel.sends = [];
  p.tracks = [t];
  return p;
}

/** The recordings every run plays: a stereo take, a mono one, and two tones a crossfade goes between. */
const TAKE = [pcm(SR * 2, 1), pcm(SR * 2, 2)];
const MONO = [pcm(SR, 3)];
const OLD = [tonePcm(SR * 2, 220, 0.4)];
const NEW = [tonePcm(SR * 2, 330, 0.3)];
/** A note edit's patch of the take (floats, as patches are): a second of something else. */
const PATCH = [
  Float32Array.from({ length: 4800 }, (_, i) => 0.2 * Math.sin(i / 9)),
  Float32Array.from({ length: 4800 }, (_, i) => 0.1 * Math.sin(i / 7)),
];

const at = (seconds: number) => Math.round(seconds * SR);

/**
 * A region of the take cut in three (the middle piece a patch of it), with the region's fades and a
 * cut at each end of the recording, then a region of the mono one.
 */
const REGION: ClipSpec[] = [
  {
    key: 'take',
    start: at(0.1),
    end: at(0.4),
    source: 700,
    regionStart: at(0.1),
    regionEnd: at(0.9),
    gain: 0.8,
    fadeIn: 2000,
    fadeOut: 3000,
    seamOut: true,
  },
  {
    key: 'take#patch',
    base: 'take',
    at: 700 + at(0.3),
    start: at(0.4),
    end: at(0.5),
    source: 0,
    regionStart: at(0.1),
    regionEnd: at(0.9),
    gain: 0.8,
    fadeIn: 2000,
    fadeOut: 3000,
    seamIn: true,
    seamOut: true,
  },
  {
    key: 'take',
    start: at(0.5),
    end: at(0.9),
    source: 700 + at(0.4),
    regionStart: at(0.1),
    regionEnd: at(0.9),
    gain: 0.8,
    fadeIn: 2000,
    fadeOut: 3000,
    seamIn: true,
  },
  {
    key: 'mono',
    start: at(1),
    end: at(1.6),
    source: 0,
    regionStart: at(1),
    regionEnd: at(1.6),
    gain: 1.3,
    fadeIn: 0,
    fadeOut: 4000,
  },
];

const tones = (key: string): ClipSpec[] => [
  { key, start: 0, end: SR * 2, source: 0, regionStart: 0, regionEnd: SR * 2, gain: 0.9, fadeIn: 0, fadeOut: 0 },
];

/** A piece to audition: joined to nothing either side. */
const heard = (key: string, source: number, length: number): ClipSpec => ({
  key,
  start: 0,
  end: length,
  source,
  regionStart: 0,
  regionEnd: length,
  gain: 0.7,
  fadeIn: 0,
  fadeOut: 0,
  seamIn: true,
  seamOut: true,
});

/** An engine with the song, its transport's fades on, and the recordings as `frames` makes them. */
function engine(frames: (a: Int16Array) => SampleFrames, scale?: number): EngineCore {
  const p = song();
  const core = new EngineCore(SR, (m) => {
    if (m.type === 'error') throw new Error(m.message);
  });
  core.transportFades = true;
  const segments = compileTempo(p, SR);
  core.receive({ type: 'init', ring: null, meters: null, transport: null });
  core.receive({ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) });
  const audio = (key: string, channels: Int16Array[]): ToWorklet => ({
    type: 'audio',
    key,
    channels: channels.map(frames),
    ...(scale === undefined ? {} : { scale }),
  });
  core.receive(audio('take', TAKE));
  core.receive(audio('mono', MONO));
  core.receive(audio('old', OLD));
  core.receive(audio('new', NEW));
  core.receive({ type: 'audio', key: 'take#patch', channels: PATCH });
  core.receive({ type: 'graph', graph: compileGraph(p, () => 1, segments) });
  core.receive({ type: 'sequence', num: 1, events: compileTrack(p.tracks[0] as Project['tracks'][number], segments) });
  return core;
}

/** `blocks` blocks played (left and right), each message sent before the block it's keyed by. */
function play(core: EngineCore, blocks: number, when: Record<number, ToWorklet[]> = {}): [Float32Array, Float32Array] {
  const outL = new Float32Array(blocks * BLOCK);
  const outR = new Float32Array(blocks * BLOCK);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  for (let b = 0; b < blocks; b++) {
    for (const m of when[b] ?? []) core.receive(m);
    core.process(l, r, undefined, b * BLOCK);
    outL.set(l, b * BLOCK);
    outR.set(r, b * BLOCK);
  }
  return [outL, outR];
}

const start = (frame: number): ToWorklet => ({ type: 'play', frame, record: false, countIn: 0 });

/**
 * Everything the engine does with a clip, one after another: the region played through its fades,
 * cuts and patch; a jump back while it plays and a stop (the transport's fades); two auditions, the
 * second taking over from the first; then the tones, crossfaded to and back while they play.
 */
const SCRIPT: Record<number, ToWorklet[]> = {
  0: [{ type: 'clips', num: 1, clips: REGION }, start(0)],
  500: [{ type: 'locate', frame: at(0.3) }],
  640: [{ type: 'stop' }],
  660: [{ type: 'audition', num: 1, clips: [heard('take', 5000, 9000)] }],
  690: [{ type: 'audition', num: 1, clips: [heard('mono', 300, 6000), heard('take#patch', 0, 2000)] }],
  780: [{ type: 'clips', num: 1, clips: tones('old') }, start(0)],
  800: [{ type: 'clips', num: 1, clips: tones('new'), fade: 960 }],
  900: [{ type: 'clips', num: 1, clips: tones('old'), fade: 960 }],
  1000: [{ type: 'stop' }],
};
const BLOCKS = 1040;

describe('a recording held as 16-bit', () => {
  it.each([
    ['a 32768th, as samples’', 2 ** -15],
    ['more: a take louder than full scale', 2 ** -13],
    ['less: a quiet take', 2 ** -18],
  ])('plays exactly as the floats it stands for, each step worth %s', (_name, scale) => {
    const [fl, fr] = play(
      engine((a) => asFloats(a, scale)),
      BLOCKS,
      SCRIPT,
    );
    const [il, ir] = play(
      engine((a) => a, scale),
      BLOCKS,
      SCRIPT,
    );
    expect(same(il, fl)).toBe(true);
    expect(same(ir, fr)).toBe(true);
    // (and it is something: every stretch of the script sounds)
    const span = (from: number, to: number) => peak(fl.subarray(from * BLOCK, to * BLOCK));
    for (const [from, to] of [
      [40, 340],
      [380, 600],
      [660, 690],
      [690, 740],
      [780, 1000],
    ] as const)
      expect(span(from, to)).toBeGreaterThan(0.004 * scale * 32768);
    // the two sides differ where the take plays (it is stereo), and not where the mono one does
    expect(same(fl.subarray(40 * BLOCK, 300 * BLOCK), fr.subarray(40 * BLOCK, 300 * BLOCK))).toBe(false);
    expect(same(fl.subarray(380 * BLOCK, 495 * BLOCK), fr.subarray(380 * BLOCK, 495 * BLOCK))).toBe(true);
  });

  it('is at a full scale of 32768 when it comes without a scale', () => {
    const [fl] = play(
      engine((a) => asFloats(a, 1 / 32768)),
      400,
      SCRIPT,
    );
    const [il] = play(
      engine((a) => a),
      400,
      SCRIPT,
    );
    expect(same(il, fl)).toBe(true);
  });

  it('plays its numbers as they are when each step is worth one', () => {
    const steps = Int16Array.from({ length: SR }, (_, i) => (i % 3) - 1);
    const run = (frames: SampleFrames, scale?: number) => {
      const core = engine((a) => a);
      core.receive({ type: 'audio', key: 'ones', channels: [frames], ...(scale === undefined ? {} : { scale }) });
      return play(core, 60, { 0: [{ type: 'clips', num: 1, clips: [heard('ones', 0, 6000)] }, start(0)] })[0];
    };
    const out = run(steps, 1);
    expect(same(out, run(Float32Array.from(steps)))).toBe(true);
    expect(peak(out)).toBeCloseTo(0.7, 5);
  });

  it('gives way to floats under the same key, and to floats after it was forgotten', () => {
    const floats = OLD.map((a) => asFloats(a, 2 ** -15));
    const want = play(
      engine((a) => asFloats(a, 2 ** -15)),
      200,
      { 0: [{ type: 'clips', num: 1, clips: tones('old') }, start(0)] },
    )[0];
    // held as 16-bit with steps worth four times as much, then replaced by the floats while it plays
    const replaced = engine((a) => a, 2 ** -13);
    const got = play(replaced, 200, {
      0: [{ type: 'clips', num: 1, clips: tones('old') }, start(0)],
      50: [{ type: 'audio', key: 'old', channels: floats }],
    })[0];
    expect(same(got.subarray(0, 50 * BLOCK), want.subarray(0, 50 * BLOCK))).toBe(false);
    expect(same(got.subarray(50 * BLOCK), want.subarray(50 * BLOCK))).toBe(true);
    // forgotten (silence meanwhile), then the floats
    const forgotten = engine((a) => a, 2 ** -13);
    const again = play(forgotten, 200, {
      0: [{ type: 'clips', num: 1, clips: tones('old') }, start(0)],
      50: [{ type: 'forgetAudio', key: 'old' }],
      80: [{ type: 'audio', key: 'old', channels: floats }],
    })[0];
    expect(peak(again.subarray(52 * BLOCK, 80 * BLOCK))).toBe(0);
    expect(same(again.subarray(80 * BLOCK), want.subarray(80 * BLOCK))).toBe(true);
  });

  it('is nothing a plugin reads as its data: a drift curve stays floats', () => {
    const core = engine((a) => a, 2 ** -15);
    const curve = [new Float32Array([0.001, 0.002]), new Float32Array([0, 0])];
    core.receive({ type: 'audio', key: 'curve', channels: curve });
    expect(core.clip('take')).toBeUndefined();
    expect(core.clip('curve')).toBe(curve);
    expect(core.clip('none')).toBeUndefined();
    // the floats that replace a 16-bit buffer are a plugin's to read again
    const floats = [new Float32Array(8)];
    core.receive({ type: 'audio', key: 'take', channels: floats });
    expect(core.clip('take')).toBe(floats);
  });

  it('stays 16-bit, with its scale, in the memory the engines share', () => {
    const msg = aheadShared({ type: 'audio', key: 'take', channels: TAKE, scale: 2 ** -14 });
    if (msg.type !== 'audio') throw new Error('not audio');
    expect(msg.scale).toBe(2 ** -14);
    for (const [i, c] of msg.channels.entries()) {
      expect(c).toBeInstanceOf(Int16Array);
      expect(c.buffer).toBeInstanceOf(SharedArrayBuffer);
      expect(Array.from(c.subarray(0, 64))).toEqual(Array.from((TAKE[i] as Int16Array).subarray(0, 64)));
    }
  });

  it('allocates nothing as it plays, is crossfaded and is auditioned', () => {
    const core = engine((a) => a, 2 ** -15);
    core.receive({ type: 'clips', num: 1, clips: tones('old') });
    core.receive(start(0));
    const l = new Float32Array(BLOCK);
    const r = new Float32Array(BLOCK);
    for (let b = 0; b < 4; b++) core.process(l, r, undefined, b * BLOCK);
    const when: Record<number, ToWorklet> = {
      10: { type: 'clips', num: 1, clips: tones('new'), fade: 960 },
      60: { type: 'stop' },
      70: { type: 'audition', num: 1, clips: [heard('take', 5000, 9000)] },
    };
    const saved = [globalThis.Float32Array, globalThis.Float64Array, globalThis.Array, globalThis.Map, globalThis.Set];
    const refuse = () => {
      throw new Error('allocated while playing');
    };
    let loudest = 0;
    try {
      Object.assign(globalThis, {
        Float32Array: refuse,
        Float64Array: refuse,
        Array: refuse,
        Map: refuse,
        Set: refuse,
      });
      for (let b = 4; b < 160; b++) {
        const m = when[b];
        if (m) core.receive(m);
        core.process(l, r, undefined, b * BLOCK);
        for (let i = 0; i < BLOCK; i++) loudest = Math.max(loudest, Math.abs(l[i] as number));
      }
    } finally {
      const [f32, f64, arr, map, set] = saved;
      Object.assign(globalThis, { Float32Array: f32, Float64Array: f64, Array: arr, Map: map, Set: set });
    }
    expect(loudest).toBeGreaterThan(0.1);
  });
});

describe('a plugin’s data among a song’s clips', () => {
  it('is named apart from its recordings, a file a region also plays included', () => {
    const p = song();
    const track = p.tracks[0] as Project['tracks'][number];
    const clip = { file: 'aud_curve', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
    const take = newRegion(0, PPQ * 4, 'Take');
    take.audio = { ...clip, file: 'aud_take' };
    const played = newRegion(PPQ * 8, PPQ * 4, 'Curve, played');
    played.audio = { ...clip, gain: -3 };
    track.regions = [take, played];
    const wow = newPlugin('wow');
    wow.settings = { curve: 'aud_curve' };
    track.channel.inserts = [wow];
    expect(pluginClips(p).map((c) => c.file)).toEqual(['aud_curve']);
    expect(
      songClips(p)
        .map((c) => c.file)
        .sort(),
    ).toEqual(['aud_curve', 'aud_take']);
    // a song with no such plugin has none
    expect(pluginClips(song())).toEqual([]);
  });
});
