import {
  newAudioTrack,
  newBus,
  newPlugin,
  newProject,
  newRegion,
  newTrack,
  PPQ,
  type Project,
  type Track,
} from '@holo/session';
import { describe, expect, it } from 'vitest';
import { renderThreads, renderWorkersFor } from '../src/node.ts';
import {
  type InstrumentManifest,
  type RenderCosts,
  type Rendered,
  type RenderOptions,
  type RenderSource,
  type RenderSplit,
  type RenderThread,
  renderSession,
  type ZoneManifest,
} from '../src/render.ts';
import { encodeWav } from '../src/wav.ts';

// A render split over threads (render.ts, playSplit) is the render on one engine, to the byte: shown
// here on real threads, for a song with something of everything that meets in a mix, for loops,
// stretches and mastered songs, for a run of made-up mixes, and when a thread goes wrong.

const SR = 48000;
const BAR = PPQ * 4;

/** Numbers from a seed, the same every run. */
function seeded(seed: number) {
  let s = seed >>> 0 || 1;
  const next = () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
  return {
    next,
    int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)),
    of: <T>(list: readonly T[]) => list[Math.floor(next() * list.length)] as T,
    chance: (p: number) => next() < p,
  };
}

/** A kit on three microphones and a recording, as a data folder would hand them over. */
function source(): RenderSource {
  const r = seeded(11);
  const burst = (frames: number, level: number, decay: number) =>
    Float32Array.from({ length: frames }, (_, i) => (r.next() - 0.5) * level * Math.exp(-i / decay));
  const files = new Map<string, Uint8Array>();
  const zones: ZoneManifest[] = [];
  for (const [key, ring, extra] of [
    [36, 0.3, {}],
    [38, 0.25, {}],
    [42, 0.08, { group: 1 }],
    [46, 0.4, { offBy: 1 }],
  ] as const)
    for (const [lovel, hivel, level] of [
      [1, 80, 0.3],
      [81, 127, 0.8],
    ] as const)
      for (const rr of [1, 2])
        for (const [mic, stereo, gain] of [
          ['close', false, 1],
          ['oh', true, 0.4],
          ['room', true, 0.25],
        ] as const) {
          const frames = Math.round(SR * ring * (mic === 'room' ? 1.5 : 1));
          const left = burst(frames, level * gain, SR * ring * 0.2);
          const file = `kit/${key}-${hivel}-${rr}-${mic}.wav`;
          files.set(file, encodeWav(stereo ? [left, burst(frames, level * gain, SR * ring * 0.2)] : [left], SR));
          zones.push({
            file,
            root: key,
            lo: key,
            hi: key,
            lovel,
            hivel,
            gain: -1,
            start: 0,
            end: 0,
            loopStart: 0,
            loopEnd: 0,
            rate: SR,
            rr,
            mic,
            ...extra,
          });
        }
  const kit = {
    pack: 'test',
    name: 'kit',
    release: 0.08,
    attack: 0,
    oneShot: true,
    pitched: false,
    velocityRange: 30,
    zones,
    mics: [
      { id: 'close', name: 'Close' },
      { id: 'oh', name: 'Overheads', level: -2 },
      { id: 'room', name: 'Room', pan: 0.1 },
    ],
  } as InstrumentManifest;
  const take = encodeWav(
    [Float32Array.from({ length: SR * 3 }, (_, i) => Math.sin(i * 0.031) * Math.sin(i * 0.0007) * 0.4)],
    SR,
  );
  return {
    instrument: async () => kit,
    sample: async (_pack, file) => files.get(file) as Uint8Array,
    audio: async () => take,
    impulse: () => Promise.reject(new Error('no packs here')),
  };
}

const chord = (k: number, pitches: number[], beats: number) => {
  const notes = [];
  for (let b = 0; b < beats; b++)
    for (const [v, base] of pitches.entries())
      notes.push({ t: b * PPQ, d: Math.round(PPQ * 1.4), p: base + ((b * 3 + k) % 7), v: 70 + v * 9 });
  return notes;
};

/**
 * A song with something of everything that meets in a mix (the one the render-ahead tests play,
 * ahead.test.ts): halls, a bus into a bus, a stage, sends before and after the fader, look-ahead,
 * automation, an arpeggiator, a drummer, a planned part, a recording with a Drum Replacer, a kit on
 * three microphones, an equalizer on the master.
 */
function rich(bars = 2): Project {
  const p = newProject('Split');
  p.tempo = [{ tick: 0, bpm: 110 }];
  const hall = newBus('Hall');
  hall.channel.inserts = [newPlugin('space', { space: 2, dry: -60, wet: -3 })];
  const echo = newBus('Echo');
  echo.channel.inserts = [newPlugin('delay')];
  echo.channel.output = hall.id;
  const glow = newBus('Glow');
  glow.channel.inserts = [newPlugin('shimmer', { space: 0, generations: 1, lookahead: 1, decay: 0.5 })];
  const group = newBus('Group');
  group.channel.inserts = [newPlugin('compressor'), newPlugin('limiter')];
  group.channel.sends = [{ bus: hall.id, level: -14, pre: false }];
  p.buses = [hall, echo, glow, group];
  p.master.inserts = [newPlugin('eq', { b2Gain: 2 })];
  p.master.volume = -2;
  const length = BAR * bars;
  const beats = bars * 4;
  const tracks: Track[] = [];
  ['Soft Keys', 'Warm Pad', 'Electric Piano', 'Pluck', 'Bass'].forEach((preset, k) => {
    const t = newTrack(preset, { type: 'synth', preset });
    t.regions = [{ ...newRegion(0, length), notes: chord(k, k === 4 ? [36] : [52, 57, 61], beats) }];
    t.channel.inserts = [newPlugin(['eq', 'chorus', 'saturator', 'width', 'compressor'][k] as string)];
    t.channel.sends = [
      { bus: hall.id, level: -10 - k, pre: k === 1 },
      { bus: echo.id, level: -16, pre: false },
    ];
    t.channel.pan = (k - 2) * 0.3;
    if (k % 2 === 0) t.channel.output = group.id;
    tracks.push(t);
  });
  (tracks[0] as Track).channel.automation = [
    {
      param: 'volume',
      points: [
        [0, -6],
        [length / 2, 0],
        [length, -12],
      ],
      mode: 'read',
      curve: 'smooth',
    },
    {
      param: 'pan',
      points: [
        [0, -0.5],
        [length, 0.5],
      ],
      mode: 'read',
    },
    {
      param: `send:${hall.id}`,
      points: [
        [0, -20],
        [length, -6],
      ],
      mode: 'read',
    },
  ];
  const fx = (tracks[2] as Track).channel;
  fx.automation = [
    {
      param: `fx:${fx.inserts[0]?.id}:drive`,
      points: [
        [0, 0],
        [length, 18],
      ],
      mode: 'read',
    },
    {
      param: 'mute',
      points: [
        [0, 0],
        [length / 2, 1],
        [length / 2 + PPQ, 0],
      ],
      mode: 'read',
    },
  ];
  const staged = tracks[3] as Track;
  staged.channel.stage = {
    distance: 0.4,
    near: { depth: 0.2, sends: [{ bus: hall.id, level: -12 }] },
    far: {
      depth: 0.7,
      sends: [
        { bus: glow.id, level: -9 },
        { bus: hall.id, level: -6 },
      ],
    },
  };
  staged.channel.automation = [
    {
      param: 'distance',
      points: [
        [0, 0.1],
        [length, 0.9],
      ],
      mode: 'read',
    },
  ];
  (tracks[4] as Track).midiFx = [newPlugin('arpeggiator')];
  const lead = newTrack('Lead', { type: 'synth', preset: 'Soft Keys' });
  lead.regions = [{ ...newRegion(0, length), notes: chord(5, [76], beats).filter((_, i) => i % 2 === 0) }];
  const drums = newTrack('Drums', { type: 'synth', preset: 'Drum Synth' });
  drums.midiFx = [newPlugin('drummer', { genre: 2, complexity: 70, fills: 80, swing: 20 })];
  drums.channel.inserts = [newPlugin('resonance', { amount: 40, bass: 9 }), newPlugin('tremolo', { depth: 30 })];
  const keys = newTrack('Keys', { type: 'synth', preset: 'Electric Piano' });
  keys.regions = [{ ...newRegion(0, length), notes: chord(3, [55, 62], beats) }];
  keys.channel.inserts = [newPlugin('rotary', { speed: 2 }), newPlugin('phaser'), newPlugin('lofi', { wow: 40 })];
  const glass = newTrack('Glass', { type: 'glass', options: { gain: 0.5, seed: 3 } });
  glass.regions = [{ ...newRegion(0, length), notes: chord(9, [64, 71], beats).filter((_, i) => i % 3 === 0) }];
  glass.channel.sends = [{ bus: glow.id, level: -8, pre: false }];
  const vox = newAudioTrack('Vox');
  vox.regions = [
    {
      ...newRegion(BAR / 2, BAR),
      audio: { file: 'aud_test', offset: 0.1, gain: -3, fadeIn: 0.02, fadeOut: 0.05, stretch: 1 },
    },
  ];
  vox.channel.sends = [{ bus: hall.id, level: -8, pre: false }];
  vox.channel.inserts = [newPlugin('replacer', { threshold: -20, mix: 50 }), newPlugin('limiter')];
  const kit = newTrack('Kit', {
    type: 'sampler',
    pack: 'test',
    name: 'kit',
    params: { 'mic:room': -6, tune: 1, decay: 70 },
  });
  const beat = [36, 42, 38, 42, 36, 46, 38, 42];
  kit.regions = [
    {
      ...newRegion(0, length),
      notes: beat.flatMap((key, i) =>
        Array.from({ length: bars }, (_, bar) => ({
          t: bar * BAR + i * (PPQ / 2),
          d: PPQ / 4,
          p: key,
          v: 60 + ((i * 23 + bar * 7) % 67),
        })),
      ),
    },
  ];
  kit.channel.sends = [{ bus: hall.id, level: -12, pre: false }];
  p.tracks = [...tracks, lead, drums, keys, glass, vox, kit];
  return p;
}

const PRESETS = ['Soft Keys', 'Warm Pad', 'Electric Piano', 'Pluck', 'Bass', 'Drum Synth'];
const INSERTS = ['eq', 'chorus', 'saturator', 'width', 'compressor', 'limiter', 'delay', 'phaser', 'tremolo', 'reverb'];

/** A made-up mix: tracks into buses into buses, sends, plugins, a lane or two. */
function madeMix(seed: number): Project {
  const r = seeded(seed);
  const p = newProject(`Mix ${seed}`);
  p.tempo = r.chance(0.3)
    ? [
        { tick: 0, bpm: 150 },
        { tick: BAR, bpm: 200 },
      ]
    : [{ tick: 0, bpm: 180 }];
  p.buses = Array.from({ length: r.int(0, 3) }, (_, b) => {
    const bus = newBus(`Bus ${b}`);
    bus.channel.inserts = Array.from({ length: r.int(0, 2) }, () => newPlugin(r.of(INSERTS)));
    return bus;
  });
  // (a bus only ever goes into an earlier one, and sends to earlier ones: no loops)
  p.buses.forEach((bus, b) => {
    if (b > 0 && r.chance(0.5)) bus.channel.output = (p.buses[r.int(0, b - 1)] as (typeof p.buses)[number]).id;
    if (b > 0 && r.chance(0.3))
      bus.channel.sends = [{ bus: (p.buses[0] as (typeof p.buses)[number]).id, level: -12, pre: false }];
  });
  p.master.inserts = r.chance(0.5) ? [newPlugin(r.of(['eq', 'limiter', 'compressor']))] : [];
  p.tracks = Array.from({ length: r.int(2, 6) }, (_, t) => {
    const track = newTrack(`T${t}`, { type: 'synth', preset: r.of(PRESETS) });
    const notes = [];
    for (let at = 0; at < BAR * 2; at += r.int(120, 900))
      notes.push({ t: at, d: r.int(60, 900), p: r.int(40, 80), v: r.int(40, 120) });
    track.regions = [{ ...newRegion(0, BAR * 2), notes }];
    track.channel.inserts = Array.from({ length: r.int(0, 2) }, () => newPlugin(r.of(INSERTS)));
    track.channel.pan = r.of([-0.6, 0, 0, 0.4]);
    if (p.buses.length) {
      if (r.chance(0.5)) track.channel.output = r.of(p.buses).id;
      if (r.chance(0.6)) track.channel.sends = [{ bus: r.of(p.buses).id, level: -r.int(4, 18), pre: r.chance(0.3) }];
    }
    if (r.chance(0.3))
      track.channel.automation = [
        {
          param: r.of(['volume', 'pan']),
          points: [
            [0, -0.4],
            [BAR * 2, 0.4],
          ],
          mode: 'read',
        },
      ];
    if (r.chance(0.15)) track.midiFx = [newPlugin('arpeggiator')];
    return track;
  });
  return p;
}

/** A light mix with a room every track sends to: quick to render, with sound crossing between threads. */
function small(): Project {
  const p = madeMix(7);
  const room = newBus('Room');
  room.channel.inserts = [newPlugin('reverb'), newPlugin('delay')];
  p.buses.push(room);
  for (const t of p.tracks) t.channel.sends = [{ bus: room.id, level: -8, pre: false }];
  return p;
}

/** A source for a song that asks for nothing of one. */
const nothing: RenderSource = {
  instrument: () => Promise.reject(new Error('no packs here')),
  sample: () => Promise.reject(new Error('no packs here')),
  audio: () => Promise.reject(new Error('no audio here')),
  impulse: () => Promise.reject(new Error('no packs here')),
};

const sameBytes = (a: Float32Array, b: Float32Array) =>
  a.length === b.length &&
  Buffer.from(a.buffer, a.byteOffset, a.byteLength).equals(Buffer.from(b.buffer, b.byteOffset, b.byteLength));

/**
 * A song rendered split: checked to be `one`, its render on one engine, to the byte; and that it was
 * the threads that made it (`through`: a split that goes through tells what its strips cost), or,
 * where they couldn't, that it was made on one engine after all.
 */
async function matches(
  one: Rendered,
  song: Project,
  opts: Omit<RenderOptions, 'split'>,
  split: RenderSplit,
  from: RenderSource,
  through = true,
) {
  let told = 0;
  const watched: RenderSplit = {
    ...split,
    learned(costs) {
      told++;
      split.learned?.(costs);
    },
  };
  const many = await renderSession(song, from, { ...opts, split: watched });
  expect(many.errors).toEqual(one.errors);
  expect(many.channels.length).toBe(one.channels.length);
  for (const [c, channel] of one.channels.entries())
    expect(sameBytes(channel, many.channels[c] as Float32Array), `channel ${c}`).toBe(true);
  expect(told, through ? 'the threads made it' : 'one engine made it').toBe(through ? 1 : 0);
}

/** One song rendered on one engine and split: the one engine's render, after checking the split one is it. */
async function both(
  song: Project,
  opts: Omit<RenderOptions, 'split'>,
  split: RenderSplit,
  from: RenderSource,
  through = true,
) {
  const one = await renderSession(song, from, opts);
  await matches(one, song, opts, split, from, through);
  return one;
}

const loud = (channels: Float32Array[]) => (channels[0] as Float32Array).some((v) => v !== 0);

describe('a render split over threads', () => {
  const opts = { sampleRate: SR, tail: 1, finish: false };

  for (const workers of [2, 3])
    it(`is the render on one engine, to the byte, split ${workers} ways`, async () => {
      const one = await both(rich(1), opts, renderThreads(workers), source());
      expect(one.errors).toEqual([]);
      expect(loud(one.channels)).toBe(true);
    }, 120_000);

  it('is the same for a loop, which plays turn after turn until its tails have come around', async () => {
    // (a light one: a loop is rendered for most of a minute before its last turn is kept)
    const looped = small();
    looped.tracks = looped.tracks.slice(0, 3);
    looped.loop = { start: 0, end: BAR * 2, tail: 0.5 };
    const one = await both(looped, { sampleRate: SR }, renderThreads(3), nothing);
    expect(loud(one.channels)).toBe(true);
  }, 120_000);

  it('is the same for a stretch of a song, and for a mastered song at another rate', async () => {
    const stretch = await both(rich(1), { ...opts, from: PPQ, to: PPQ * 3 }, renderThreads(2), source());
    expect(loud(stretch.channels)).toBe(true);
    const mastered = rich(1);
    mastered.finish = { lufs: -16, ceiling: -1, glue: true, lowcut: 30, tilt: 0 };
    await both(mastered, { sampleRate: 44100, tail: 1 }, renderThreads(3), source());
  }, 120_000);

  it('is the same through long silences and to the end of a long tail (no strip rests)', async () => {
    // a few notes, then nothing for bars, then a few more, ringing out in a room for seconds: playing
    // live, a strip with nothing to play rests and gives up the last of its tail
    const sparse = small();
    for (const [k, t] of sparse.tracks.entries()) {
      const notes = (at: number) => [0, 1, 2].map((i) => ({ t: at + i * 240, d: 200, p: 50 + k * 5 + i * 4, v: 90 }));
      t.regions = [{ ...newRegion(0, BAR * 8), notes: [...notes(k * 120), ...notes(BAR * 6 + k * 120)] }];
    }
    const one = await both(sparse, { sampleRate: SR, tail: 6, finish: false }, renderThreads(3), nothing);
    expect(loud(one.channels)).toBe(true);
  }, 120_000);

  it('is the same for a run of made-up mixes', async () => {
    let sounded = 0;
    for (let n = 1; n <= 12; n++) {
      const song = madeMix(n + 300);
      const range = n % 4 === 0 ? { from: BAR / 2, to: BAR + BAR / 2 } : {};
      const split = renderThreads(2 + (n % 3));
      const one = await both(song, { sampleRate: SR, tail: 0.3, finish: false, ...range }, split, nothing);
      if (loud(one.channels)) sounded++;
    }
    expect(sounded).toBeGreaterThan(9);
  }, 120_000);

  it('says what its strips cost, and is the same render laid out by that', async () => {
    const song = small();
    let learned: RenderCosts | null = null;
    const first = renderThreads(3);
    first.learned = (costs) => {
      learned = costs;
    };
    const one = await both(song, opts, first, nothing);
    const costs = learned as RenderCosts | null;
    expect(costs).not.toBeNull();
    // every strip that sounded, by its id, with what it was; and this computer against the guesses
    const ids = new Set([...song.tracks.map((t) => t.id), ...song.buses.map((b) => b.id)]);
    expect(Object.keys(costs?.strips ?? {}).length).toBeGreaterThan(3);
    for (const [id, timing] of Object.entries(costs?.strips ?? {})) {
      expect(ids.has(id)).toBe(true);
      expect(timing.share).toBeGreaterThan(0);
      expect(timing.made.startsWith(`${id}|`)).toBe(true);
    }
    expect(costs?.scale.tracks).toBeGreaterThan(0);
    expect(costs?.scale.buses).toBeGreaterThan(0);
    // laid out by it, by nonsense, and by what was learned of another song's strips: the same render
    await matches(one, song, opts, { ...renderThreads(3), costs }, nothing);
    const odd: RenderCosts = {
      scale: { tracks: 4, buses: 0.02 },
      strips: { ...costs?.strips, nobody: { share: 9, made: 'x' } },
    };
    for (const [n, id] of [...ids].entries()) if (n % 2) odd.strips[id] = { share: 1e9, made: `${id}|` };
    await matches(one, song, opts, { ...renderThreads(2), costs: odd }, nothing);
    // and whoever keeps them failing to changes nothing
    const failing = renderThreads(2);
    failing.learned = () => {
      throw new Error('nowhere to keep them');
    };
    await matches(one, song, opts, failing, nothing);
  }, 120_000);

  it('ends its threads last first, each once the one after it has stopped, and goes through every time', async () => {
    // a thread waits on the threads before it without listening to anything else: stopped the other
    // way round, or all at once, one is now and then left waiting for good and taken for failed
    const song = small();
    const one = await renderSession(song, nothing, opts);
    for (let run = 0; run < 6; run++) {
      const real = renderThreads(3);
      const order: string[] = [];
      let n = 0;
      const split: RenderSplit = {
        ...real,
        start(spec, sampleRate, failed) {
          const thread = real.start(spec, sampleRate, failed);
          const self = n++;
          return {
            ...thread,
            end: async () => {
              order.push(`asked ${self}`);
              const said = await thread.end();
              order.push(`stopped ${self}`);
              return said;
            },
          };
        },
      };
      await matches(one, song, opts, split, nothing);
      expect(order).toEqual(['asked 2', 'stopped 2', 'asked 1', 'stopped 1', 'asked 0', 'stopped 0']);
    }
  }, 120_000);

  it('stays on one engine with fewer than two threads, starting none', async () => {
    let started = 0;
    const none: RenderSplit = {
      workers: 1,
      start: () => {
        started++;
        throw new Error('no thread should start');
      },
    };
    await both(small(), opts, none, nothing, false);
    expect(started).toBe(0);
  }, 60_000);
});

describe('a split render whose thread goes wrong', () => {
  const opts = { sampleRate: SR, tail: 0.5, finish: false };
  /** The song on one engine, rendered once for them all. */
  let plain: Promise<Rendered> | null = null;
  const again = async (split: RenderSplit) => {
    plain ??= renderSession(small(), nothing, opts);
    const one = await plain;
    await matches(one, small(), opts, split, nothing, false);
    return one;
  };

  /** Two threads, as they are, but for what `spoil` does to each thread's own doings. */
  const spoiled = (
    spoil: (thread: RenderThread, n: number, failed: (why: string) => void) => Partial<RenderThread>,
    more: Partial<RenderSplit> = {},
  ): { split: RenderSplit; ended: () => number } => {
    const real = renderThreads(2);
    let ended = 0;
    let n = 0;
    return {
      ended: () => ended,
      split: {
        ...real,
        ...more,
        start(spec, sampleRate, failed) {
          const thread = real.start(spec, sampleRate, failed);
          const own = spoil(thread, n++, failed);
          return {
            post: (msg) => (own.post ?? thread.post)(msg),
            go: () => (own.go ?? thread.go)(),
            end: async () => {
              ended++;
              const said = await thread.end();
              return own.end ? own.end() : said;
            },
          };
        },
      },
    };
  };

  it('is made again on one engine when a thread’s engine fails as it plays', async () => {
    const { split, ended } = spoiled((thread, n, failed) => ({
      go: () => {
        thread.go();
        if (n === 1) failed('its engine failed');
      },
    }));
    const one = await again(split);
    expect(one.errors).toEqual([]);
    expect(ended()).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('is made again when a thread says at the end that its engine failed', async () => {
    const { split } = spoiled((_thread, n) => (n === 0 ? { end: async () => 'its engine failed' } : {}));
    await again(split);
  }, 120_000);

  it('is made again when a thread stops by itself', async () => {
    const told: string[] = [];
    const real = renderThreads(2, new URL('./render-thread-exits.ts', import.meta.url));
    const split: RenderSplit = {
      ...real,
      start: (spec, sampleRate, failed) =>
        real.start(spec, sampleRate, (why) => {
          told.push(why);
          failed(why);
        }),
    };
    await again(split);
    expect(told).toContain('A render thread stopped by itself');
  }, 120_000);

  it('is made again when the threads never answer, after the time it gives them', async () => {
    const { split } = spoiled(() => ({ go: () => undefined }), { patience: 400 });
    const t0 = Date.now();
    await again(split);
    expect(Date.now() - t0).toBeLessThan(60_000);
  }, 120_000);

  it('is made on one engine when a thread can’t be started, the ones that were started ended', async () => {
    for (const failing of [0, 1]) {
      const real = renderThreads(2);
      let ended = 0;
      let n = 0;
      const split: RenderSplit = {
        ...real,
        start(spec, sampleRate, failed) {
          if (n++ === failing) throw new Error('This computer has no threads to give');
          const thread = real.start(spec, sampleRate, failed);
          return {
            ...thread,
            end: () => {
              ended++;
              return thread.end();
            },
          };
        },
      };
      await again(split);
      expect(ended).toBe(failing);
    }
  }, 120_000);

  it('is made on one engine when what its threads run isn’t there, or a thread can’t be spoken to', async () => {
    await again(renderThreads(2, new URL('./no-such-thread.ts', import.meta.url)));
    const { split } = spoiled((_thread, n) => ({
      post: () => {
        if (n === 1) throw new Error('The thread is gone');
      },
    }));
    await again(split);
  }, 120_000);

  it('is made on one engine when whoever starts the threads ends them badly', async () => {
    const { split } = spoiled(() => ({ end: () => Promise.reject(new Error('It wouldn’t end')) }));
    await again(split);
  }, 120_000);

  it('says what a song’s own fault is, as one engine does', async () => {
    // a song whose instrument can't be loaded fails the same either way: before any thread starts
    const song = rich(1);
    const none: RenderSource = { ...source(), instrument: () => Promise.reject(new Error('No instrument test/kit')) };
    await expect(renderSession(song, none, opts)).rejects.toThrow('No instrument test/kit');
    await expect(renderSession(song, none, { ...opts, split: renderThreads(2) })).rejects.toThrow(
      'No instrument test/kit',
    );
  }, 60_000);
});

describe('how many threads a render is split over', () => {
  it('is one fewer than the cores, six at most, and none where a split wouldn’t pay', () => {
    expect([1, 2, 3, 4, 6, 8, 16, 64].map((cores) => renderWorkersFor(cores))).toEqual([0, 0, 2, 3, 5, 6, 6, 6]);
  });

  it('is no more than it’s told, and none when told one', () => {
    expect(renderWorkersFor(8, 3)).toBe(3);
    expect(renderWorkersFor(8, 2)).toBe(2);
    expect(renderWorkersFor(8, 1)).toBe(0);
    expect(renderWorkersFor(8, 0)).toBe(0);
    expect(renderWorkersFor(4, 16)).toBe(3);
    expect(renderWorkersFor(Number.NaN)).toBe(0);
    expect(renderWorkersFor(8, Number.NaN)).toBe(6);
  });
});
