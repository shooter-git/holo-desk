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
import { EV_OFF, EV_ON, EVENT_SIZE, type GraphSpec, type ToWorklet } from '../src/protocol.ts';
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
  vox.channel.inserts = [newPlugin('limiter')];
  p.tracks = [...tracks, glass, vox];
  return p;
}

/** Two tracks, a room and a master with nothing on it: what a live note leaves behind dies away. */
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
  return new Map<number, ToWorklet[]>([
    [200, [{ type: 'locate', frame: frame(2.5) }]],
    [400, [{ type: 'graph', graph: compileGraph(edited, nums, segments) }]],
    [450, [{ type: 'cycle', on: true, start: frame(2.7), end: frame(3) }]],
    [800, [{ type: 'stop' }]],
    [840, [{ type: 'play', frame: frame(0.5), record: false, countIn: 0 }]],
  ]);
}

/** One engine, the whole mix: what a bounce plays. */
function one(batches: Map<number, ToWorklet[]>, blocks: number): Float32Array[] {
  const core = new EngineCore(SR, (m) => {
    if (m.type === 'error') throw new Error(m.message);
  });
  core.receive({ type: 'init', ring: null, meters: null, transport: null });
  return run(blocks, (k, l, r) => {
    for (const m of batches.get(k) ?? []) core.receive(structuredClone(m));
    core.process(l, r, undefined, k * AHEAD_BLOCK);
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

  it('hands over between threads and plays the same numbers, whoever plays what', async () => {
    // owners at random: workers wait on each other both ways
    const shuffled = aheadOwners(graph, 3, () => 0.1).map((o, i) => (o < 0 ? o : (i * 7) % 3));
    // (no stop and start again: a start from a stop skips what the workers played of the stop)
    const going = new Map([...batches].filter(([k]) => k < 800));
    const out = await threaded(going, BLOCKS, 3, shuffled);
    // replayed with each message before the block the workers took it in at
    const all: ToWorklet[] = [
      { type: 'ahead', owners: shuffled },
      ...[...going].sort((a, b) => a[0] - b[0]).flatMap(([, list]) => list),
    ];
    const replay = new Map<number, ToWorklet[]>();
    let taken = 0;
    out.counts.forEach((count, k) => {
      if (count > taken) replay.set(k, all.slice(taken, count));
      taken = count;
    });
    expect(taken).toBe(all.length);
    expect(same(out.channels, one(withoutOwners(replay), BLOCKS))).toBe(true);
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

/** The replay's messages without the owners (one engine has no use for them). */
function withoutOwners(replay: Map<number, ToWorklet[]>): Map<number, ToWorklet[]> {
  const out = new Map<number, ToWorklet[]>();
  for (const [k, list] of replay) {
    const kept = list.filter((m) => m.type !== 'ahead');
    if (kept.length) out.set(k, kept);
  }
  return out;
}

/** Workers as threads, the audio thread here: as fast as they go, with messages sent as the song plays. */
async function threaded(
  batches: Map<number, ToWorklet[]>,
  blocks: number,
  workers: number,
  owners: number[],
): Promise<{ channels: Float32Array[]; counts: number[]; stalls: number }> {
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
  send({ type: 'ahead', owners });
  const counts: number[] = [];
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
    if (player.process(l, r, undefined, k * AHEAD_BLOCK)) {
      counts.push(link.messages(k));
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
  return { channels: [L, R], counts, stalls };
}
