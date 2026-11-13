import { Worker } from 'node:worker_threads';
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
import {
  AHEAD_BLOCK,
  AHEAD_LEAD,
  AheadLink,
  AheadPlayer,
  AheadPool,
  aheadControl,
  aheadData,
  aheadOwners,
  aheadPlan,
  aheadRoom,
} from '../src/ahead.ts';
import {
  clipKey,
  compileClips,
  compileGraph,
  compileTempo,
  compileTrack,
  meterTicks,
  songClips,
  songImpulses,
  tickToFrame,
} from '../src/compile.ts';
import { prepareImpulse } from '../src/convolver.ts';
import { EngineCore } from '../src/core.ts';
import { isPlanned, planTrack } from '../src/parts.ts';
import {
  EV_OFF,
  EV_ON,
  EVENT_SIZE,
  type GraphSpec,
  type SamplerSpec,
  type SampleZone,
  type ToWorklet,
} from '../src/protocol.ts';
import { generateSpace } from '../src/spaces.ts';

const SR = 48000;
const BAR = PPQ * 4;

/** A song with something of everything that meets in a mix: halls, a bus into a bus, a stage, sends before and after the fader, look-ahead, automation, a planned part and a recording. */
function song(): Project {
  const p = newProject('Ahead');
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

  const chord = (k: number, pitches: number[], beats: number) => {
    const notes = [];
    for (let b = 0; b < beats; b++)
      for (const [v, base] of pitches.entries())
        notes.push({ t: b * PPQ, d: Math.round(PPQ * 1.4), p: base + ((b * 3 + k) % 7), v: 70 + v * 9 });
    return notes;
  };
  const tracks: Track[] = [];
  const presets = ['Soft Keys', 'Warm Pad', 'Electric Piano', 'Pluck', 'Bass'];
  presets.forEach((preset, k) => {
    const t = newTrack(preset, { type: 'synth', preset });
    t.regions = [{ ...newRegion(0, BAR * 4), notes: chord(k, k === 4 ? [36] : [52, 57, 61], 16) }];
    t.channel.inserts = [newPlugin(['eq', 'chorus', 'saturator', 'width', 'compressor'][k] as string)];
    t.channel.sends = [
      { bus: hall.id, level: -10 - k, pre: k === 1 },
      { bus: echo.id, level: -16, pre: false },
    ];
    t.channel.pan = (k - 2) * 0.3;
    if (k % 2 === 0) t.channel.output = group.id;
    tracks.push(t);
  });
  // automation: the fader, the balance, a send, a plugin and a mute lane
  const lanes = (tracks[0] as Track).channel;
  lanes.automation = [
    {
      param: 'volume',
      points: [
        [0, -6],
        [BAR * 2, 0],
        [BAR * 4, -12],
      ],
      mode: 'read',
      curve: 'smooth',
    },
    {
      param: 'pan',
      points: [
        [0, -0.5],
        [BAR * 4, 0.5],
      ],
      mode: 'read',
    },
    {
      param: `send:${hall.id}`,
      points: [
        [0, -20],
        [BAR * 3, -6],
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
        [BAR * 4, 18],
      ],
      mode: 'read',
    },
    {
      param: 'mute',
      points: [
        [0, 0],
        [BAR * 2, 1],
        [BAR * 2 + PPQ, 0],
      ],
      mode: 'read',
    },
  ];
  // a stage: its seats send to the hall and the shimmer
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
        [BAR * 4, 0.9],
      ],
      mode: 'read',
    },
  ];
  // an arpeggiator on the bass
  (tracks[4] as Track).midiFx = [newPlugin('arpeggiator')];
  // and a lead with nothing on it, straight to the master
  const lead = newTrack('Lead', { type: 'synth', preset: 'Soft Keys' });
  lead.regions = [{ ...newRegion(0, BAR * 4), notes: chord(5, [76], 16).filter((_, i) => i % 2 === 0) }];
  tracks.push(lead);
  // a drummer playing a kit, its strings ringing, in time with the song
  const drums = newTrack('Drums', { type: 'synth', preset: 'Drum Synth' });
  drums.midiFx = [newPlugin('drummer', { genre: 2, complexity: 70, fills: 80, swing: 20 })];
  drums.channel.inserts = [newPlugin('resonance', { amount: 40, bass: 9 }), newPlugin('tremolo', { depth: 30 })];
  tracks.push(drums);
  // keys through a spinning speaker, a phaser and a worn tape
  const keys = newTrack('Keys', { type: 'synth', preset: 'Electric Piano' });
  keys.regions = [{ ...newRegion(0, BAR * 4), notes: chord(3, [55, 62], 16) }];
  keys.channel.inserts = [newPlugin('rotary', { speed: 2 }), newPlugin('phaser'), newPlugin('lofi', { wow: 40 })];
  tracks.push(keys);
  // Glass, planned whole
  const glass = newTrack('Glass', { type: 'glass', options: { gain: 0.5, seed: 3 } });
  glass.regions = [{ ...newRegion(0, BAR * 4), notes: chord(9, [64, 71], 16).filter((_, i) => i % 3 === 0) }];
  glass.channel.sends = [{ bus: glow.id, level: -8, pre: false }];
  // a recording
  const vox = newAudioTrack('Vox');
  vox.regions = [
    {
      ...newRegion(BAR, BAR * 2),
      audio: { file: 'aud_test', offset: 0.1, gain: -3, fadeIn: 0.02, fadeOut: 0.05, stretch: 1 },
    },
  ];
  vox.channel.sends = [{ bus: hall.id, level: -8, pre: false }];
  // a Drum Replacer on it (its look-ahead held back, everything else waiting for it)
  vox.channel.inserts = [newPlugin('replacer', { threshold: -20, mix: 50 }), newPlugin('limiter')];
  // a kit on three microphones, its room turned down, tuned and shortened
  const kit = newTrack('Kit', {
    type: 'sampler',
    pack: 'test',
    name: 'kit',
    params: { 'mic:room': -6, tune: 1, decay: 70 },
  });
  const beat = [36, 42, 38, 42, 36, 46, 38, 42];
  kit.regions = [
    {
      ...newRegion(0, BAR * 4),
      notes: beat.flatMap((key, i) =>
        [0, 1, 2, 3].map((bar) => ({
          t: bar * BAR + i * (PPQ / 2),
          d: PPQ / 4,
          p: key,
          v: 60 + ((i * 23 + bar * 7) % 67),
        })),
      ),
    },
  ];
  kit.channel.sends = [{ bus: hall.id, level: -12, pre: false }];
  p.tracks = [...tracks, glass, vox, kit];
  return p;
}

/**
 * A kit recorded on three microphones (a mono close one, stereo overheads and room): a kick, a snare
 * and hi-hats that choke, two velocity layers and two round robins of each, decaying noise.
 */
function testKit(key: string): SamplerSpec {
  let seed = 11;
  const noise = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  const burst = (frames: number, level: number, decay: number) =>
    Float32Array.from({ length: frames }, (_, i) => noise() * level * Math.exp(-i / decay));
  const zones: SampleZone[] = [];
  const pieces = [
    { key: 36, ring: 0.4, extra: {} },
    { key: 38, ring: 0.3, extra: {} },
    { key: 42, ring: 0.1, extra: { group: 1 } },
    { key: 46, ring: 0.5, extra: { offBy: 1 } },
  ];
  for (const piece of pieces)
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
          const frames = Math.round(SR * piece.ring * (mic === 'room' ? 1.5 : 1));
          const decay = SR * piece.ring * 0.2;
          zones.push({
            left: burst(frames, level * gain, decay),
            right: stereo ? burst(frames, level * gain, decay) : null,
            root: piece.key,
            lo: piece.key,
            hi: piece.key,
            lovel,
            hivel,
            gain: 0.9,
            loopStart: 0,
            loopEnd: 0,
            rr,
            mic,
            ...(mic === 'close' && piece.key === 42 ? { pan: 0.4 } : {}),
            ...piece.extra,
          });
        }
  return {
    key,
    zones,
    release: 0.08,
    oneShot: true,
    pitched: false,
    velocityRange: 30,
    attack: 0,
    polyphony: 12,
    notePolyphony: 2,
    offTime: 0.03,
    mics: [
      { id: 'close', name: 'Close' },
      { id: 'oh', name: 'Overheads', level: -2 },
      { id: 'room', name: 'Room', pan: 0.1 },
    ],
  };
}

/** Two tracks, a room and a master with nothing on it: what a live note leaves behind dies away. */
/** One of each family of synths with its own voices, effects or tail, sending to a hall. */
function families(): Project {
  const p = newProject('Families');
  p.tempo = [{ tick: 0, bpm: 104 }];
  const hall = newBus('Hall');
  hall.channel.inserts = [newPlugin('space', { space: 0, decay: 0.8, dry: -60, wet: -6 })];
  p.buses = [hall];
  const presets = ['Tonewheel Gospel', 'Tine Piano', 'FM Bells', 'Morph Pad', 'Drone Glass', 'Analog Machine'];
  presets.push('Bansuri', 'Tanpura', 'Harmonium', 'Choir Ahh', 'War Drums');
  p.tracks = presets.map((preset, k) => {
    const t = newTrack(preset, { type: 'synth', preset });
    const notes =
      preset === 'Analog Machine'
        ? [36, 42, 38, 42, 36, 46, 38, 39].map((key, i) => ({ t: i * (PPQ / 2), d: PPQ / 4, p: key, v: 100 }))
        : [0, 1, 2, 3].map((b) => ({ t: b * PPQ, d: Math.round(PPQ * 1.4), p: 55 + ((b * 3 + k) % 7), v: 90 }));
    t.regions = [{ ...newRegion(0, BAR * 2), notes }];
    t.channel.sends = [{ bus: hall.id, level: -14, pre: false }];
    t.channel.pan = ((k % 5) - 2) * 0.2;
    return t;
  });
  return p;
}

function light(): Project {
  const p = newProject('Live');
  p.tempo = [{ tick: 0, bpm: 120 }];
  const room = newBus('Room');
  room.channel.inserts = [newPlugin('space', { space: 0, decay: 0.5, dry: -60, wet: -6 })];
  p.buses = [room];
  p.master.inserts = [];
  const lead = newTrack('Lead', { type: 'synth', preset: 'Soft Keys' });
  lead.regions = [{ ...newRegion(0, BAR * 8), notes: [0, 2, 4, 6].map((b) => ({ t: b * BAR, d: BAR, p: 64, v: 90 })) }];
  lead.channel.sends = [{ bus: room.id, level: -10, pre: false }];
  const pad = newTrack('Pad', { type: 'synth', preset: 'Warm Pad' });
  pad.regions = [{ ...newRegion(0, BAR * 8), notes: [{ t: 0, d: BAR * 8, p: 52, v: 80 }] }];
  pad.channel.inserts = [newPlugin('eq', { b2Gain: 3 })];
  p.tracks = [lead, pad];
  return p;
}

/** Messages that give an engine the song, then play it. */
function setup(p: Project, nums: (id: string) => number): ToWorklet[] {
  const segments = compileTempo(p, SR);
  const out: ToWorklet[] = [{ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) }];
  const kits = new Set(
    p.tracks.flatMap((t) => (t.instrument.type === 'sampler' ? [`${t.instrument.pack}/${t.instrument.name}`] : [])),
  );
  for (const key of kits) out.push({ type: 'sampler', spec: testKit(key) });
  for (const { key, source } of songImpulses(p, SR))
    if (source.kind === 'space')
      out.push({
        type: 'impulse',
        key,
        data: prepareImpulse(generateSpace(source.name, source.seed, source.decay, SR)),
      });
  for (const clip of songClips(p)) {
    const n = SR * 3;
    const a = new Float32Array(n);
    for (let i = 0; i < n; i++) a[i] = Math.sin(i * 0.031) * Math.sin(i * 0.0007) * 0.4;
    out.push({ type: 'audio', key: clipKey(clip), channels: [a] });
  }
  out.push({ type: 'graph', graph: compileGraph(p, nums, segments) });
  for (const t of p.tracks) {
    const plans = isPlanned(t) ? planTrack(t, p, segments, SR) : null;
    if (plans) out.push({ type: 'plans', num: nums(t.id), plans });
    let events = compileTrack(t, segments);
    if (isPlanned(t)) {
      const kept: number[] = [];
      for (let i = 0; i < events.length; i += EVENT_SIZE) {
        const kind = events[i + 1];
        if (kind === EV_ON || kind === EV_OFF) continue;
        for (let j = 0; j < EVENT_SIZE; j++) kept.push(events[i + j] as number);
      }
      events = new Float64Array(kept);
    }
    out.push({ type: 'sequence', num: nums(t.id), events });
    if (t.kind === 'audio') out.push({ type: 'clips', num: nums(t.id), clips: compileClips(t, segments, SR) });
  }
  out.push({ type: 'play', frame: 0, record: false, countIn: 0 });
  return out;
}

function numbering(): (id: string) => number {
  const nums = new Map<string, number>();
  return (id) => {
    if (!nums.has(id)) nums.set(id, nums.size + 1);
    return nums.get(id) as number;
  };
}

/** Changes on the way: a fader and a new send, a jump, a cycle, a stop and a start elsewhere. */
function edits(p: Project, nums: (id: string) => number): Map<number, ToWorklet[]> {
  const segments = compileTempo(p, SR);
  const frame = (bars: number) => Math.round(tickToFrame(segments, bars * BAR));
  const edited = structuredClone(p);
  const t1 = edited.tracks[1] as Track;
  t1.channel.volume = -9;
  t1.channel.sends.push({ bus: (edited.buses[2] as Project['buses'][number]).id, level: -12, pre: false });
  // the kit's microphones mixed again while it plays (the same instrument takes them)
  const kit = edited.tracks.find((t) => t.name === 'Kit') as Track;
  kit.instrument = {
    type: 'sampler',
    pack: 'test',
    name: 'kit',
    params: { 'mic:close': -3, 'mic:room': 2, decay: 40 },
  };
  return new Map<number, ToWorklet[]>([
    [200, [{ type: 'locate', frame: frame(2.5) }]],
    [400, [{ type: 'graph', graph: compileGraph(edited, nums, segments) }]],
    [450, [{ type: 'cycle', on: true, start: frame(2.7), end: frame(3) }]],
    [800, [{ type: 'stop' }]],
    [840, [{ type: 'play', frame: frame(0.5), record: false, countIn: 0 }]],
  ]);
}

/** One engine, the whole mix: what a bounce plays. */
function one(
  batches: Map<number, ToWorklet[]>,
  blocks: number,
  rest = false,
  each?: (k: number, core: EngineCore) => void,
): Float32Array[] {
  const core = new EngineCore(SR, (m) => {
    if (m.type === 'error') throw new Error(m.message);
  });
  core.rest = rest;
  core.receive({ type: 'init', ring: null, meters: null, transport: null });
  return run(blocks, (k, l, r) => {
    for (const m of batches.get(k) ?? []) core.receive(structuredClone(m));
    core.process(l, r, undefined, k * AHEAD_BLOCK);
    each?.(k, core);
  });
}

function run(blocks: number, block: (k: number, l: Float32Array, r: Float32Array) => void): Float32Array[] {
  const L = new Float32Array(blocks * AHEAD_BLOCK);
  const R = new Float32Array(blocks * AHEAD_BLOCK);
  const l = new Float32Array(AHEAD_BLOCK);
  const r = new Float32Array(AHEAD_BLOCK);
  for (let k = 0; k < blocks; k++) {
    block(k, l, r);
    L.set(l, k * AHEAD_BLOCK);
    R.set(r, k * AHEAD_BLOCK);
  }
  return [L, R];
}

/**
 * The same, split between workers and the audio thread, every engine in this thread one after the
 * other (each worker only takes in from the ones before it, as the owners are laid out).
 */
function split(
  batches: Map<number, ToWorklet[]>,
  blocks: number,
  workers: number,
  owners: number[],
  live?: (k: number, core: EngineCore) => void,
  rest = false,
): Float32Array[] {
  const control = aheadControl();
  const room = 256;
  const data = aheadData(room);
  const link = new AheadLink(control, data, room);
  const engines = Array.from({ length: workers + 1 }, (_, i) => {
    const self = i < workers ? i : -1;
    const core = new EngineCore(SR, (m) => {
      if (m.type === 'error') throw new Error(m.message);
    });
    core.rest = rest;
    core.receive({
      type: 'init',
      ring: null,
      meters: null,
      transport: null,
      ahead: { control, data, edges: room, workers, self },
    });
    core.receive({ type: 'ahead', owners });
    return core;
  });
  return run(blocks, (k, l, r) => {
    const scratchL = new Float32Array(AHEAD_BLOCK);
    const scratchR = new Float32Array(AHEAD_BLOCK);
    link.open(k, 0);
    engines.forEach((core, i) => {
      for (const m of batches.get(k) ?? []) core.receive(structuredClone(m));
      core.aheadBlock(k);
      if (i < workers) {
        core.process(scratchL, scratchR, undefined, 0);
        link.finish(i, k + 1);
      } else {
        live?.(k, core);
        core.process(l, r, undefined, k * AHEAD_BLOCK);
        link.setConsumed(k + 1);
      }
    });
  });
}

const same = (a: Float32Array[], b: Float32Array[]) =>
  a.every((c, i) => Buffer.from(c.buffer).equals(Buffer.from((b[i] as Float32Array).buffer)));

function peak(x: Float32Array, from = 0, to = x.length): number {
  let m = 0;
  for (let i = from; i < to; i++) m = Math.max(m, Math.abs(x[i] as number));
  return m;
}

function graphOf(p: Project, nums: (id: string) => number): GraphSpec {
  return compileGraph(p, nums, compileTempo(p, SR));
}

describe('rendering ahead: every family of synths', () => {
  const p = families();
  const nums = numbering();
  // played straight through (the edits the main song makes along the way are its own)
  const batches = new Map<number, ToWorklet[]>([[0, setup(p, nums)]]);
  const graph = graphOf(p, nums);
  const BLOCKS = 500;
  const reference = one(batches, BLOCKS);

  it('has a song to play, the same numbers split three ways as on one engine', () => {
    expect(peak(reference[0] as Float32Array)).toBeGreaterThan(0.02);
    const owners = aheadOwners(graph, 3, () => 0.1);
    expect(same(split(batches, BLOCKS, 3, owners), reference)).toBe(true);
  }, 60_000);
});

describe('rendering ahead', () => {
  const p = song();
  const nums = numbering();
  const batches = edits(p, nums);
  batches.set(0, setup(p, nums));
  const graph = graphOf(p, nums);
  const BLOCKS = 900;
  const reference = one(batches, BLOCKS);

  it('has a song to play', () => {
    expect(peak(reference[0] as Float32Array)).toBeGreaterThan(0.05);
  });

  for (const workers of [1, 2, 3]) {
    it(`plays the same numbers as one engine, split ${workers} way${workers > 1 ? 's' : ''}`, () => {
      const owners = aheadOwners(graph, workers, () => 0.1);
      expect(same(split(batches, BLOCKS, workers, owners), reference)).toBe(true);
    }, 60_000);
  }

  it('lays the strips out in the order sound flows, cut where the work comes out even', () => {
    const cost = new Map(graph.buses.map((b, i) => [b.num, i === 2 ? 0.5 : 0.12]));
    const owners = aheadOwners(graph, 3, (num) => cost.get(num) ?? 0.05);
    const plan = aheadPlan(graph, owners);
    // a worker only takes in from itself or the ones before it
    const master = plan.owners.length - 1;
    for (const list of plan.edges)
      for (const e of list)
        if (e.to !== master) expect(plan.owners[e.to]).toBeGreaterThanOrEqual(plan.owners[e.from] as number);
    const load = [0, 0, 0];
    [...graph.tracks, ...graph.buses].forEach((s, i) => {
      const w = plan.owners[i] as number;
      load[w] = (load[w] as number) + (cost.get(s.num) ?? 0.05);
    });
    // the shimmer (0.5) alone sets the pace: nothing else piles onto it
    expect(Math.max(...load)).toBeLessThan(0.56);
  });

  it('keeps on the audio thread whatever a strip it plays feeds', () => {
    const owners = aheadOwners(graph, 2, () => 0.1);
    const hall = graph.buses.findIndex((b) => b.id === p.buses[0]?.id);
    const group = graph.buses.find((b) => b.id === p.buses[3]?.id);
    // the group bus played live: the hall it sends to must be too
    owners[group?.num as number] = -1;
    const plan = aheadPlan(graph, owners);
    expect(plan.owners[graph.tracks.length + hall]).toBe(-1);
    expect(same(split(batches, BLOCKS, 2, owners), reference)).toBe(true);
  }, 60_000);

  // owners at random: workers wait on each other both ways
  const shuffled = aheadOwners(graph, 3, () => 0.1).map((o, i) => (o < 0 ? o : (i * 7) % 3));
  // (no stop and start again: a start from a stop skips what the workers played of the stop)
  const going = new Map([...batches].filter(([k]) => k < 800));
  const all: ToWorklet[] = [
    { type: 'ahead', owners: shuffled },
    ...[...going].sort((a, b) => a[0] - b[0]).flatMap(([, list]) => list),
  ];

  it('hands over between threads and plays the same numbers, whoever plays what', async () => {
    const out = await threaded(going, BLOCKS, 3, shuffled);
    expect(same(out.channels, replayed(out, all))).toBe(true);
  }, 60_000);

  it('plays the same numbers when the workers are well ahead before the audio thread starts', async () => {
    // the song arrives after blocks the workers played stopped: the audio thread skips those and
    // starts at the block the song does (as it does starting from a stop)
    const out = await threaded(going, BLOCKS, 3, shuffled, 12);
    expect(out.played.some((b, k) => b > k)).toBe(true);
    expect(same(out.channels, replayed(out, all))).toBe(true);
  }, 60_000);
});

describe('the shared memory between engines', () => {
  it("keeps a strip's progress from going back when the worker it left finishes late", () => {
    const control = aheadControl();
    const link = new AheadLink(control, aheadData(64), 64);
    // the worker a strip went to has played well past the change; the one it left then finishes the block before it
    link.publish(5, 811);
    link.publish(5, 779);
    expect(link.progress(5)).toBe(811);
    link.publish(5, 812);
    expect(link.progress(5)).toBe(812);
  });

  it('has no place for a channel number past its room, and writes nothing for one', () => {
    const control = aheadControl();
    const link = new AheadLink(control, aheadData(64), 64);
    const before = Array.from(new Int32Array(control));
    for (const num of [512, 560, 600, 5000]) {
      link.publish(num, 1234);
      link.setCost(num, 0.5);
      link.await(num, 99);
      expect(link.progress(num)).toBe(0);
      expect(link.cost(num)).toBe(0);
    }
    expect(Array.from(new Int32Array(control))).toEqual(before);
  });

  it('leaves strips numbered past its room to the audio thread, and lays the rest out as ever', () => {
    const q = light();
    const nums = numbering();
    const graph = graphOf(q, nums);
    const far = { ...graph, tracks: graph.tracks.map((t, i) => (i === 0 ? { ...t, num: 700 } : t)) };
    const owners = aheadOwners(far, 3, () => 0.1);
    expect(owners[700]).toBe(-1);
    for (const s of [...far.tracks.slice(1), ...far.buses]) expect(owners[s.num]).toBeGreaterThanOrEqual(0);
    // a cost that isn't a number (a strip never timed, say) doesn't pile every strip onto one worker
    const lost = aheadOwners(graph, 3, () => Number.NaN);
    const used = new Set([...graph.tracks, ...graph.buses].map((s) => lost[s.num]));
    expect(used.size).toBeGreaterThan(1);
  });
});

/** A song with long silences: a lead that plays a bar, waits five and plays again; a pad that only comes in then; a room; a recording late on. */
function sparse(): Project {
  const p = newProject('Sparse');
  p.tempo = [{ tick: 0, bpm: 120 }];
  const room = newBus('Room');
  room.channel.inserts = [newPlugin('space', { space: 0, decay: 0.5, dry: -60, wet: -6 })];
  const echo = newBus('Echo');
  echo.channel.inserts = [newPlugin('delay')];
  p.buses = [room, echo];
  p.master.inserts = [];
  const lead = newTrack('Lead', { type: 'synth', preset: 'Soft Keys' });
  lead.regions = [{ ...newRegion(0, BAR * 8), notes: [0, 6].map((b) => ({ t: b * BAR, d: BAR / 2, p: 64, v: 90 })) }];
  lead.channel.inserts = [newPlugin('eq', { b2Gain: 3 }), newPlugin('compressor')];
  lead.channel.sends = [
    { bus: room.id, level: -10, pre: false },
    { bus: echo.id, level: -14, pre: false },
  ];
  const pad = newTrack('Pad', { type: 'synth', preset: 'Warm Pad' });
  pad.regions = [{ ...newRegion(0, BAR * 8), notes: [{ t: 6 * BAR, d: BAR, p: 52, v: 80 }] }];
  pad.channel.inserts = [newPlugin('eq', { b2Gain: 3 })];
  pad.channel.sends = [{ bus: room.id, level: -12, pre: false }];
  const take = newAudioTrack('Take');
  take.regions = [
    {
      ...newRegion(BAR * 6.5, BAR),
      audio: { file: 'aud_sparse', offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 },
    },
  ];
  take.channel.sends = [{ bus: room.id, level: -9, pre: false }];
  p.tracks = [lead, pad, take];
  return p;
}

describe('strips with nothing to play', () => {
  const p = sparse();
  const nums = numbering();
  const batches = new Map<number, ToWorklet[]>([[0, setup(p, nums)]]);
  const graph = graphOf(p, nums);
  // sixteen seconds: a bar played, ten seconds of nothing, then everything at once
  const BLOCKS = Math.round((16 * SR) / AHEAD_BLOCK);
  const at = (seconds: number) => Math.round((seconds * SR) / AHEAD_BLOCK);
  const through = one(batches, BLOCKS);
  const resting: number[] = [];
  const rested = one(batches, BLOCKS, true, (_k, core) => resting.push(core.resting));

  it('has a song with a long silence in it, and something after', () => {
    expect(peak(through[0] as Float32Array, 0, at(1) * AHEAD_BLOCK)).toBeGreaterThan(0.01);
    expect(peak(through[0] as Float32Array, at(9) * AHEAD_BLOCK, at(11) * AHEAD_BLOCK)).toBeLessThan(1e-5);
    expect(peak(through[0] as Float32Array, at(12.2) * AHEAD_BLOCK, at(14) * AHEAD_BLOCK)).toBeGreaterThan(0.01);
  });

  it('rest once they have been silent a few seconds, and wake when something comes', () => {
    // while the lead's note and the room's and the echo's tails sound, only what never played rests
    expect(resting[at(0.5)]).toBe(0);
    // (the pad and the recording have had nothing yet: asleep four seconds in)
    expect(resting[at(4.5)]).toBeGreaterThanOrEqual(2);
    // deep in the silence: every track and both buses
    expect(resting[at(11)]).toBe(5);
    // everything plays again
    expect(resting[at(13.5)]).toBe(0);
  });

  it('play what they would have, to within what no one can hear', () => {
    let worst = 0;
    for (let c = 0; c < 2; c++) {
      const a = through[c] as Float32Array;
      const b = rested[c] as Float32Array;
      for (let i = 0; i < a.length; i++) worst = Math.max(worst, Math.abs((a[i] as number) - (b[i] as number)));
    }
    // (-120 dB: the tails given up were below -140 dB before the fader, a few strips of them)
    expect(worst).toBeLessThan(1e-6);
    // and nothing at all comes out of a mix at rest
    expect(peak(rested[0] as Float32Array, at(10) * AHEAD_BLOCK, at(11.5) * AHEAD_BLOCK)).toBe(0);
  });

  it('rest the same split between engines as on one: the same numbers', () => {
    for (const workers of [1, 2]) {
      const owners = aheadOwners(graph, workers, () => 0.1);
      expect(same(split(batches, BLOCKS, workers, owners, undefined, true), rested)).toBe(true);
    }
  }, 120_000);

  it('are played through, every block, where nothing rests (a bounce): the numbers of before', () => {
    const again = one(batches, BLOCKS, false);
    expect(same(again, through)).toBe(true);
  });
});

describe('laying a song out by what its strips take on this computer', () => {
  const p = song();
  const nums = numbering();
  const graph = graphOf(p, nums);
  const strips = [...graph.tracks, ...graph.buses];
  /** A pool whose threads take their messages and do nothing. */
  const pool = (workers = 3) => {
    const made = new AheadPool(workers, () => ({ post: () => undefined, close: () => undefined }));
    return made;
  };
  /** As timed here: the tracks at a fifth of their guesses, one hall as heavy as all of them. */
  const timedHere = (num: number) =>
    num === graph.buses[0]?.num ? 0.3 : graph.tracks.some((t) => t.num === num) ? 0.02 : 0.03;
  const play = (a: AheadPool, rounds = 12) => {
    for (const s of strips) a.link.setCost(s.num, timedHere(s.num));
    for (let i = 0; i < rounds; i++) a.remember(true);
  };
  const busiest = (owners: number[], workers: number) => {
    const load = new Array<number>(workers).fill(0);
    for (const s of strips) {
      const o = owners[s.num] ?? -1;
      if (o >= 0) load[o] = (load[o] as number) + timedHere(s.num);
    }
    return Math.max(...load);
  };
  const ownersOf = (msgs: ToWorklet[]) => msgs.flatMap((m) => (m.type === 'ahead' ? [m.owners] : [])).at(-1);

  it('learns how far the guesses run from its timings, and lays the song out in its own terms', () => {
    const a = pool();
    const first = ownersOf(a.layout(graph, false)) as number[];
    for (const t of graph.tracks) a.setPart(t.num, 0.1);
    expect(a.calibration()).toEqual({ tracks: 1, buses: 1 });
    play(a);
    // the tracks take a fifth of what was guessed for them: the guesses still to be used are brought down
    expect(a.calibration().tracks).toBeLessThan(0.5);
    const again = ownersOf(a.rebalance(1)) ?? first;
    expect(busiest(again, 3)).toBeLessThanOrEqual(busiest(first, 3));
    // the heavy hall has a worker nearly to itself
    expect(busiest(again, 3)).toBeLessThan(0.3 + 0.1);
  });

  it("keeps a song's timings for the next time it's opened, for the strips that are still what they were", () => {
    const a = pool();
    a.layout(graph, false);
    for (const t of graph.tracks) a.setPart(t.num, 0.1);
    play(a);
    const kept = a.timings();
    expect(kept.size).toBe(strips.length);
    const settled = ownersOf(a.rebalance(1));
    // a fresh pool (the song opened again): laid out by the kept timings at once
    const b = pool();
    b.setCalibration(a.calibration());
    for (const t of graph.tracks) b.setPart(t.num, 0.1);
    const opened = ownersOf(b.layout(graph, false, kept)) as number[];
    if (settled) expect(busiest(opened, 3)).toBeCloseTo(busiest(settled, 3), 5);
    expect(busiest(opened, 3)).toBeLessThan(0.3 + 0.1);
    // a strip that has other plugins now is guessed afresh: its kept timing says nothing of it
    const hall = graph.buses[0] as GraphSpec['buses'][number];
    const other = { ...graph, buses: [{ ...hall, inserts: [] }, ...graph.buses.slice(1)] };
    const c = pool();
    c.layout(other, false, kept);
    expect(c.timings().has(hall.num)).toBe(false);
    expect(c.timings().size).toBe(strips.length - 1);
  });

  it('forgets what it knew of a channel number when another strip takes it', () => {
    const a = pool();
    a.layout(graph, false);
    play(a);
    const t0 = graph.tracks[0] as GraphSpec['tracks'][number];
    expect(a.timings().has(t0.num)).toBe(true);
    const taken = { ...graph, tracks: [{ ...t0, id: 'trk_another' }, ...graph.tracks.slice(1)] };
    a.layout(taken, false);
    expect(a.timings().has(t0.num)).toBe(false);
    expect(a.link.cost(t0.num)).toBe(0);
  });

  it('moves no strip while the song plays unless the audio thread keeps being kept waiting, and then not often', () => {
    const a = pool();
    a.layout(graph, false);
    for (const t of graph.tracks) a.setPart(t.num, 0.1);
    for (const s of strips) a.link.setCost(s.num, timedHere(s.num));
    // a worker nearly out of time, and a better layout there to be had
    for (let j = 0; j < 3; j++) a.link.setLoad(j, 0.95);
    for (let i = 0; i < 6; i++) expect(a.check(true, 20_000 + i * 2000)).toEqual([]);
    // the audio thread waited for a block: once is a hiccup
    a.link.stall();
    expect(a.check(true, 40_000)).toEqual([]);
    // and again in the next stretch: now the strips are laid out again, by the timings
    a.link.stall();
    expect(ownersOf(a.check(true, 42_000))).toBeDefined();
    // not again for half a minute, however it goes (a move costs blocks itself)
    for (const s of strips) a.link.setCost(s.num, timedHere(s.num) * (s.num % 2 ? 3 : 0.3));
    for (let i = 1; i <= 10; i++) {
      a.link.stall();
      expect(a.check(true, 42_000 + i * 2000)).toEqual([]);
    }
  });

  it('goes by timings taken while the song plays and the workers keep up, and by no others', () => {
    const a = pool();
    a.layout(graph, false);
    for (const t of graph.tracks) a.setPart(t.num, 0.1);
    // a song being loaded: every strip timed at many times what it takes
    for (const s of strips) a.link.setCost(s.num, 4);
    for (let i = 0; i < 5; i++) a.check(false, i * 2000);
    expect(a.timings().size).toBe(0);
    expect(a.calibration()).toEqual({ tracks: 1, buses: 1 });
    // playing, the workers far behind (the audio thread waiting for most blocks): still nothing kept
    a.check(true, 10_000);
    for (let i = 0; i < 5; i++) {
      for (let n = 0; n < 300; n++) a.link.stall();
      a.check(true, 12_000 + i * 2000);
    }
    expect(a.timings().size).toBe(0);
    expect(a.calibration()).toEqual({ tracks: 1, buses: 1 });
    // keeping up (a block late now and then): these count
    for (const s of strips) a.link.setCost(s.num, timedHere(s.num));
    for (let i = 0; i < 5; i++) {
      a.link.stall();
      a.check(true, 30_000 + i * 2000);
    }
    expect(a.timings().size).toBe(strips.length);
    expect(a.calibration().tracks).toBeLessThan(0.5);
    for (const s of strips) expect(a.cost(s.num)).toBeCloseTo(timedHere(s.num), 5);
  });

  it('has its engines time their strips afresh when the song starts', () => {
    const q = light();
    const numsOf = numbering();
    const messages = setup(q, numsOf);
    const play = messages.pop() as ToWorklet;
    const g = graphOf(q, numsOf);
    const control = aheadControl();
    const data = aheadData(64);
    const link = new AheadLink(control, data, 64);
    const core = new EngineCore(SR, () => undefined);
    core.receive({
      type: 'init',
      ring: null,
      meters: null,
      transport: null,
      ahead: { control, data, edges: 64, workers: 1, self: 0 },
    });
    core.receive({ type: 'ahead', owners: aheadOwners(g, 1, () => 0.1) });
    for (const m of messages) core.receive(structuredClone(m));
    // what a strip read while the song loaded
    for (const s of [...g.tracks, ...g.buses]) link.setCost(s.num, 3.5);
    core.receive(structuredClone(play));
    for (const s of [...g.tracks, ...g.buses]) expect(link.cost(s.num)).toBe(0);
  });
});

describe('strips changing hands while the song renders ahead', () => {
  it('goes on playing however often they move, with a worker behind the others', async () => {
    const p = song();
    const nums = numbering();
    const messages = setup(p, nums);
    const graph = graphOf(p, nums);
    const workers = 3;
    const control = aheadControl();
    const room = aheadRoom(64);
    const data = aheadData(room);
    const link = new AheadLink(control, data, room);
    const errors: string[] = [];
    const threads = Array.from({ length: workers }, (_, self) => {
      const w = new Worker(new URL('../bench/ahead-thread.ts', import.meta.url), {
        workerData: { sr: SR, ahead: { control, data, edges: room, workers, self } },
      });
      w.on('message', (m: { type: string; message?: string }) => {
        if (m.type === 'error') errors.push(m.message ?? '');
      });
      w.on('error', (e) => errors.push(String(e)));
      return w;
    });
    const core = new EngineCore(SR, (m) => {
      if (m.type === 'error') errors.push(m.message);
    });
    core.receive({
      type: 'init',
      ring: null,
      meters: null,
      transport: null,
      ahead: { control, data, edges: room, workers, self: -1 },
    });
    const player = new AheadPlayer(core, link, workers);
    const send = (m: ToWorklet) => {
      for (const t of threads) t.postMessage(m);
      player.receive(structuredClone(m));
    };
    // the strips dealt out anew each time, by turns in the order sound flows and against it
    const base = aheadOwners(graph, workers, () => 0.1);
    const dealt = (turn: number) => base.map((o, i) => (o < 0 ? o : (i * 7 + turn * (1 + (turn % 2))) % workers));
    send({ type: 'ahead', owners: dealt(0) });
    for (const m of messages) send(m);
    const l = new Float32Array(AHEAD_BLOCK);
    const r = new Float32Array(AHEAD_BLOCK);
    const BLOCKS = 1500;
    const deadline = Date.now() + 40_000;
    let k = 0;
    let turn = 0;
    let waits = 0;
    while (k < BLOCKS && !errors.length && Date.now() < deadline) {
      if (player.process(l, r, undefined, k * AHEAD_BLOCK)) {
        k++;
        waits = 0;
        // every strip to another worker, and the audio thread held up a moment so the workers that
        // can run on to the lead while the slowest is still on the blocks before the change
        if (k % 25 === 0) {
          send({ type: 'ahead', owners: dealt(++turn) });
          await new Promise((done) => setTimeout(done, 8));
        }
      } else {
        waits++;
        await new Promise((done) => setTimeout(done, 1));
      }
    }
    for (const t of threads) t.postMessage({ type: 'aheadQuit' });
    await Promise.all(threads.map((t) => t.terminate()));
    expect(errors).toEqual([]);
    expect(waits).toBeLessThan(2000);
    expect(k).toBe(BLOCKS);
    expect(turn).toBeGreaterThan(50);
  }, 60_000);
});

describe('starting while the song renders ahead', () => {
  it("starts from a stop at once, not after what's been played ahead", async () => {
    const q = light();
    const nums = numbering();
    const messages = setup(q, nums);
    const play = messages.pop() as ToWorklet;
    const graph = graphOf(q, nums);
    const control = aheadControl();
    const room = aheadRoom(16);
    const data = aheadData(room);
    const link = new AheadLink(control, data, room);
    const workers = 2;
    const threads = Array.from(
      { length: workers },
      (_, self) =>
        new Worker(new URL('../bench/ahead-thread.ts', import.meta.url), {
          workerData: { sr: SR, ahead: { control, data, edges: room, workers, self } },
        }),
    );
    const core = new EngineCore(SR, () => undefined);
    core.receive({
      type: 'init',
      ring: null,
      meters: null,
      transport: null,
      ahead: { control, data, edges: room, workers, self: -1 },
    });
    const player = new AheadPlayer(core, link, workers);
    const send = (m: ToWorklet) => {
      for (const t of threads) t.postMessage(m);
      player.receive(structuredClone(m));
    };
    send({ type: 'ahead', owners: aheadOwners(graph, workers, () => 0.1) });
    for (const m of messages) send(m);
    const l = new Float32Array(AHEAD_BLOCK);
    const r = new Float32Array(AHEAD_BLOCK);
    // a block every block's time, as the audio thread asks for them
    const until = async (done: () => boolean, each: () => void = () => undefined) => {
      while (!done()) {
        if (player.process(l, r, undefined, 0)) each();
        await new Promise((ok) => setTimeout(ok, (AHEAD_BLOCK / SR) * 1000));
      }
    };
    // stopped, and the workers as far ahead as the lead
    let played = 0;
    await until(
      () => played >= 100 && link.leader() - link.consumed() >= AHEAD_LEAD - 4,
      () => played++,
    );
    send(play);
    // blocks heard before the song starts: none of the stop the workers had played ahead
    let before = 0;
    await until(
      () => core.isPlaying,
      () => before++,
    );
    for (const t of threads) t.postMessage({ type: 'aheadQuit' });
    await Promise.all(threads.map((t) => t.terminate()));
    // (the leader opens a few blocks at a time: at most a few of them)
    expect(before).toBeLessThan(AHEAD_LEAD / 4);
  }, 30_000);
});

describe('a Session Drummer while the song renders ahead', () => {
  it("plays once: the audio thread's twin of its track, woken by a live controller, makes no notes of its own", () => {
    const q = light();
    const drums = newTrack('Drums', { type: 'synth', preset: 'Drum Synth' });
    drums.midiFx = [newPlugin('drummer', { genre: 0, fills: 100 })];
    q.tracks.push(drums);
    const nums = numbering();
    const batches = new Map([[0, setup(q, nums)]]);
    const owners = aheadOwners(graphOf(q, nums), 2, () => 0.1);
    const kit = nums(drums.id);
    // a worker plays the drums' song; the audio thread has its twin, for what's played live
    owners[kit] = 0;
    const blocks = 1600;
    const out = split(batches, blocks, 2, owners, (k, core) => {
      // the mod wheel on the drums wakes their twin (a kit makes no sound of it)
      if (k >= 100 && k < 1200 && k % 50 === 0) core.receive({ type: 'live', events: [0xb0, 1, k % 100, kit] });
    });
    const ref = one(batches, blocks);
    expect(peak(ref[0] as Float32Array)).toBeGreaterThan(0.05);
    expect(same(out, ref)).toBe(true);
  }, 60_000);
});

describe('live notes while the song renders ahead', () => {
  it('sound at once, and once they have died away the song is its own numbers again', () => {
    const q = light();
    const nums = numbering();
    const batches = new Map([[0, setup(q, nums)]]);
    const owners = aheadOwners(graphOf(q, nums), 2, () => 0.1);
    const lead = nums(q.tracks[0]?.id as string);
    const blocks = 2800;
    const out = split(batches, blocks, 2, owners, (k, core) => {
      if (k === 100) core.receive({ type: 'live', events: [0x90, 72, 110, lead] });
      if (k === 140) core.receive({ type: 'live', events: [0x80, 72, 0, lead] });
    });
    const ref = one(batches, blocks)[0] as Float32Array;
    const L = out[0] as Float32Array;
    const bytes = (x: Float32Array, from: number, to: number) =>
      Buffer.from(x.buffer, from * AHEAD_BLOCK * 4, (to - from) * AHEAD_BLOCK * 4);
    expect(bytes(L, 0, 100).equals(bytes(ref, 0, 100))).toBe(true);
    // the note, in the block it was played in
    let diff = 0;
    for (let i = 100 * AHEAD_BLOCK; i < 101 * AHEAD_BLOCK; i++)
      diff = Math.max(diff, Math.abs((L[i] as number) - (ref[i] as number)));
    expect(diff).toBeGreaterThan(1e-3);
    // its twins (the track's and the room's) asleep again
    expect(bytes(L, 2400, blocks).equals(bytes(ref, 2400, blocks))).toBe(true);
  }, 60_000);
});

/**
 * What the audio thread played, replayed on one engine: each message before the block the workers
 * took it in at, and each block heard compared with that block of the replay (the audio thread skips
 * the blocks the workers played stopped before the song starts, and plays every block after).
 */
function replayed(out: { counts: number[]; played: number[] }, all: ToWorklet[]): Float32Array[] {
  const start = all.findIndex((m) => m.type === 'play') + 1;
  const replay = new Map<number, ToWorklet[]>();
  let taken = 0;
  out.counts.forEach((count, k) => {
    const b = out.played[k] as number;
    if (k > 0) {
      const gap = b - (out.played[k - 1] as number);
      if (taken >= start) expect(gap).toBe(1);
      else expect(gap).toBeGreaterThan(0);
    }
    if (count > taken) replay.set(b, all.slice(taken, count));
    taken = count;
  });
  expect(taken).toBe(all.length);
  const ref = one(withoutOwners(replay), (out.played.at(-1) as number) + 1);
  return ref.map((c) => {
    const heard = new Float32Array(out.played.length * AHEAD_BLOCK);
    out.played.forEach((b, k) => {
      heard.set(c.subarray(b * AHEAD_BLOCK, (b + 1) * AHEAD_BLOCK), k * AHEAD_BLOCK);
    });
    return heard;
  });
}

/** The replay's messages without the owners (one engine has no use for them). */
function withoutOwners(replay: Map<number, ToWorklet[]>): Map<number, ToWorklet[]> {
  const out = new Map<number, ToWorklet[]>();
  for (const [k, list] of replay) {
    const kept = list.filter((m) => m.type !== 'ahead');
    if (kept.length) out.set(k, kept);
  }
  return out;
}

/**
 * Workers as threads, the audio thread here: as fast as they go, with messages sent as the song plays.
 * `late`: the song goes out once the workers have played that many blocks stopped, and until they have
 * taken it in the audio thread only plays when they are near the lead (so it is sure to
 * skip to the song's start). Returns the ring block each block heard was, and the messages taken in by then.
 */
async function threaded(
  batches: Map<number, ToWorklet[]>,
  blocks: number,
  workers: number,
  owners: number[],
  late = 0,
): Promise<{ channels: Float32Array[]; counts: number[]; played: number[]; stalls: number }> {
  const control = aheadControl();
  const room = aheadRoom(64);
  const data = aheadData(room);
  const link = new AheadLink(control, data, room);
  const errors: string[] = [];
  const threads = Array.from({ length: workers }, (_, self) => {
    const w = new Worker(new URL('../bench/ahead-thread.ts', import.meta.url), {
      workerData: { sr: SR, ahead: { control, data, edges: room, workers, self } },
    });
    w.on('message', (m: { type: string; message?: string }) => {
      if (m.type === 'error') errors.push(m.message ?? '');
    });
    w.on('error', (e) => errors.push(String(e)));
    return w;
  });
  const core = new EngineCore(SR, (m) => {
    if (m.type === 'error') errors.push(m.message);
  });
  core.receive({
    type: 'init',
    ring: null,
    meters: null,
    transport: null,
    ahead: { control, data, edges: room, workers, self: -1 },
  });
  const player = new AheadPlayer(core, link, workers);
  let sent = 0;
  const send = (m: ToWorklet) => {
    for (const t of threads) t.postMessage(m);
    player.receive(structuredClone(m));
    sent++;
  };
  send({ type: 'ahead', owners });
  while (link.leader() < late && !errors.length) await new Promise((done) => setTimeout(done, 1));
  const counts: number[] = [];
  const played: number[] = [];
  const L = new Float32Array(blocks * AHEAD_BLOCK);
  const R = new Float32Array(blocks * AHEAD_BLOCK);
  const l = new Float32Array(AHEAD_BLOCK);
  const r = new Float32Array(AHEAD_BLOCK);
  let k = 0;
  let sentUpTo = -1;
  let stalls = 0;
  while (k < blocks) {
    // messages go out as the audio thread reaches their block (the workers take them in later on)
    for (let b = sentUpTo + 1; b <= k; b++) for (const m of batches.get(b) ?? []) send(m);
    sentUpTo = k;
    if (late && link.messages(link.leader() - 1) < sent && link.leader() - link.consumed() < link.lead() - 8) {
      await new Promise((done) => setTimeout(done, 1));
      continue;
    }
    if (player.process(l, r, undefined, k * AHEAD_BLOCK)) {
      counts.push(player.taken);
      played.push(link.consumed() - 1);
      L.set(l, k * AHEAD_BLOCK);
      R.set(r, k * AHEAD_BLOCK);
      k++;
    } else {
      stalls++;
      await new Promise((done) => setTimeout(done, 1));
    }
    if (errors.length) break;
  }
  for (const t of threads) t.postMessage({ type: 'aheadQuit' });
  await Promise.all(threads.map((t) => t.terminate()));
  expect(errors).toEqual([]);
  return { channels: [L, R], counts, played, stalls };
}
