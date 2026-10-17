/**
 * How big a song HO[LO] plays live: the engine (the same code the studio's audio thread runs) on
 * generated songs of growing size, timed block by block against the time a block has in real time.
 *
 *   pnpm bench                       every size, 8 seconds of each, at 48 kHz, on one thread
 *   pnpm bench --ahead 4             the same rendered ahead on 4 worker threads (as the studio plays)
 *   pnpm bench --seconds 4 --rate 44100 --only 3,4 --json results.json
 *   pnpm bench --session song.json --from 9 [--ahead 4]   a real song (its samples from the data folder)
 *
 * A song here is made up, nothing recorded: built-in synths playing chords and runs (so many voices
 * sound at once), plugins on every track, automation lanes on every track, sends to buses, and
 * convolution halls (Space Designer, generated). On one thread, "load" is the share of each block's
 * time the engine took (the studio's DSP meter without rendering ahead). With --ahead, the song is
 * played by worker threads and the audio thread plays only the master: "load" is then the audio
 * thread's, each worker's share is listed, and "speed" says whether they keep up (above 1×).
 * The live studio adds a little (the browser, the page); a bounce or a headless render can be any size.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import {
  newBus,
  newPlugin,
  newProject,
  newRegion,
  newTrack,
  PPQ,
  type Project,
  parseProject,
  projectEnd,
  SYNTH_PRESETS,
} from '@holo/session';
import {
  AheadLink,
  AheadPlayer,
  aheadControl,
  aheadData,
  aheadGuess,
  aheadOwners,
  aheadPartGuess,
  aheadPlan,
  aheadRoom,
  aheadTrackGuess,
} from '../src/ahead.ts';
import {
  clipKey,
  compileClips,
  compileGraph,
  compileTempo,
  compileTrack,
  instrumentSpec,
  meterTicks,
  songClips,
  songImpulses,
  tickToFrame,
} from '../src/compile.ts';
import { prepareImpulse } from '../src/convolver.ts';
import { EngineCore } from '../src/core.ts';
import { dataFolderSource } from '../src/node.ts';
import { isPlanned, partSamples, planTrack } from '../src/parts.ts';
import { EV_OFF, EV_ON, EVENT_SIZE, type GraphSpec, type ToWorklet } from '../src/protocol.ts';
import { buildSampler, loadClipAudio, loadImpulse } from '../src/render.ts';
import { resample } from '../src/resample.ts';
import { generateSpace } from '../src/spaces.ts';
import { decodeWav } from '../src/wav.ts';

interface Size {
  tracks: number;
  /** Notes sounding at once on each track. */
  voices: number;
  /** Plugins on each track (from a fixed rotation). */
  inserts: number;
  /** Automation lanes on each track. */
  lanes: number;
  /** Convolution halls (buses every track sends to). */
  halls: number;
}

const SIZES: Size[] = [
  { tracks: 8, voices: 4, inserts: 2, lanes: 2, halls: 0 },
  { tracks: 16, voices: 6, inserts: 3, lanes: 3, halls: 1 },
  { tracks: 32, voices: 8, inserts: 4, lanes: 4, halls: 2 },
  { tracks: 64, voices: 8, inserts: 4, lanes: 4, halls: 3 },
  { tracks: 128, voices: 8, inserts: 4, lanes: 4, halls: 4 },
  { tracks: 128, voices: 16, inserts: 6, lanes: 6, halls: 6 },
];

const INSERTS = ['eq', 'compressor', 'peq', 'chorus', 'delay', 'saturator', 'width', 'softener'];
const PRESETS = SYNTH_PRESETS.filter((p) => p !== 'Drum Synth');

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** A made-up song of that size: every track busy for the whole of it. */
function song(size: Size, seconds: number): Project {
  const p = newProject(`Bench ${size.tracks}×${size.voices}`);
  p.tempo = [{ tick: 0, bpm: 120 }];
  p.master.inserts = [newPlugin('limiter')];
  p.buses = [];
  const halls = Array.from({ length: size.halls }, (_, i) => {
    const b = newBus(`Hall ${i + 1}`);
    // room, hall, concert, cathedral, plate, scoring (Space Designer's menu): short to long
    b.channel.inserts = [newPlugin('space', { space: [0, 2, 4, 6, 8, 3][i % 6] as number, dry: -60, wet: 0 })];
    return b;
  });
  p.buses = halls;
  const beats = Math.ceil((seconds * 120) / 60);
  p.tracks = Array.from({ length: size.tracks }, (_, k) => {
    const t = newTrack(`Track ${k + 1}`, { type: 'synth', preset: PRESETS[k % PRESETS.length] as string });
    const notes = [];
    // a chord of `voices` notes every beat, each held a beat and a half: about that many sound at once
    for (let b = 0; b < beats; b++) {
      for (let v = 0; v < size.voices; v++) {
        notes.push({
          t: b * PPQ,
          d: Math.round(PPQ * 1.5),
          p: 40 + ((k * 7 + v * 5 + b * 2) % 40),
          v: 70 + ((v * 13) % 50),
        });
      }
    }
    t.regions = [{ ...newRegion(0, beats * PPQ), notes }];
    t.channel.inserts = Array.from({ length: size.inserts }, (_, i) =>
      newPlugin(INSERTS[(k + i) % INSERTS.length] as string),
    );
    t.channel.sends = halls.map((h) => ({ bus: h.id, level: -18, pre: false }));
    const lanes: NonNullable<typeof t.channel.automation> = [];
    const targets = ['volume', 'pan', ...t.channel.sends.map((s) => `send:${s.bus}`)];
    for (let i = 0; i < size.lanes; i++) {
      const param = targets[i] ?? `fx:${t.channel.inserts[i % Math.max(1, size.inserts)]?.id}:mix`;
      const points: [number, number][] = [];
      for (let b = 0; b <= beats; b += 2) points.push([b * PPQ, param === 'pan' ? Math.sin(b) * 0.5 : -6 - (b % 4)]);
      lanes.push({ param, points, mode: 'read', curve: 'smooth' });
    }
    t.channel.automation = lanes;
    return t;
  });
  return p;
}

/** A song, as the messages an engine takes in to play it (from `from` ticks), and its mixer. */
interface Played {
  messages: ToWorklet[];
  graph: GraphSpec;
  /** Instruments' guesses from their notes or plans (by channel number). */
  parts: Map<number, number>;
}

function numbering(): (id: string) => number {
  const nums = new Map<string, number>();
  return (id) => {
    if (!nums.has(id)) nums.set(id, nums.size + 1);
    return nums.get(id) as number;
  };
}

/** A made-up song's messages (its halls generated). */
function madeUp(p: Project, sr: number): Played {
  const segments = compileTempo(p, sr);
  const numOf = numbering();
  const messages: ToWorklet[] = [{ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) }];
  for (const { key, source } of songImpulses(p, sr)) {
    if (source.kind === 'space')
      messages.push({
        type: 'impulse',
        key,
        data: prepareImpulse(generateSpace(source.name, source.seed, source.decay, sr)),
      });
  }
  const graph = compileGraph(p, numOf, segments);
  messages.push({ type: 'graph', graph });
  const parts = new Map<number, number>();
  const length = Math.round(tickToFrame(segments, projectEnd(p)));
  for (const t of p.tracks) {
    const events = compileTrack(t, segments);
    parts.set(numOf(t.id), aheadTrackGuess(events, instrumentSpec(t.instrument), length, sr));
    messages.push({ type: 'sequence', num: numOf(t.id), events });
  }
  messages.push({ type: 'play', frame: 0, record: false, countIn: 0 });
  return { messages, graph, parts };
}

/** A real song's messages, with its samples, audio and halls from the data folder (as a headless render loads them). */
async function session(p: Project, dataDir: string, sr: number, fromBar: number): Promise<Played> {
  const source = dataFolderSource(dataDir, p.id);
  const segments = compileTempo(p, sr);
  const numOf = numbering();
  const messages: ToWorklet[] = [{ type: 'tempo', segments, ppq: PPQ, ...meterTicks(p) }];
  const keys = new Set<string>();
  for (const t of p.tracks) {
    if (isPlanned(t)) continue;
    for (const i of [t.instrument, ...t.articulations.map((a) => a.instrument)])
      if (i.type === 'sampler') keys.add(`${i.pack}/${i.name}`);
  }
  for (const key of keys) {
    const [pack = '', ...rest] = key.split('/');
    messages.push({ type: 'sampler', spec: await buildSampler(source, pack, rest.join('/'), sr) });
  }
  for (const clip of songClips(p))
    messages.push({ type: 'audio', key: clipKey(clip), channels: await loadClipAudio(source, clip, sr) });
  for (const { key, source: from } of songImpulses(p, sr))
    messages.push({ type: 'impulse', key, data: prepareImpulse(await loadImpulse(source, from, sr)) });
  const graph = compileGraph(p, numOf, segments);
  messages.push({ type: 'graph', graph });
  const parts = new Map<number, number>();
  for (const t of p.tracks.filter(isPlanned)) {
    const inst = t.instrument;
    const perf = inst.type === 'performance' ? (await source.instrument(inst.pack, inst.name)).performance : undefined;
    const plans = planTrack(t, p, segments, sr, perf);
    if (!plans) continue;
    parts.set(numOf(t.id), aheadPartGuess(plans, Math.round(tickToFrame(segments, projectEnd(p)))));
    if (plans.kind === 'performance' && perf && inst.type === 'performance') {
      const samples = [];
      for (const index of partSamples(plans)) {
        const decoded = decodeWav(await source.sample(inst.pack, perf.files[index] as string));
        const conv = (c: Float32Array) => (decoded.rate === sr ? c : resample(c, decoded.rate, sr));
        const left = conv(decoded.channels[0] as Float32Array);
        samples.push({ index, left, right: decoded.channels[1] ? conv(decoded.channels[1]) : left });
      }
      messages.push({ type: 'performance', key: plans.key, samples });
    }
    messages.push({ type: 'plans', num: numOf(t.id), plans });
  }
  for (const t of p.tracks) {
    let events = compileTrack(t, segments);
    if (!isPlanned(t))
      parts.set(
        numOf(t.id),
        aheadTrackGuess(events, instrumentSpec(t.instrument), Math.round(tickToFrame(segments, projectEnd(p))), sr),
      );
    if (isPlanned(t)) {
      const kept: number[] = [];
      for (let i = 0; i < events.length; i += EVENT_SIZE) {
        const kind = events[i + 1];
        if (kind === EV_ON || kind === EV_OFF) continue;
        for (let j = 0; j < EVENT_SIZE; j++) kept.push(events[i + j] as number);
      }
      events = new Float64Array(kept);
    }
    messages.push({ type: 'sequence', num: numOf(t.id), events });
    if (t.kind === 'audio') messages.push({ type: 'clips', num: numOf(t.id), clips: compileClips(t, segments, sr) });
  }
  const frame = Math.round(tickToFrame(segments, (fromBar - 1) * PPQ * 4));
  messages.push({ type: 'play', frame, record: false, countIn: 0 });
  return { messages, graph, parts };
}

/** The same samples and audio for every thread, in shared memory (as the studio hands them over). */
function shared<T extends ToWorklet>(msg: T): T {
  const share = (a: Float32Array) => {
    const s = new Float32Array(new SharedArrayBuffer(a.byteLength));
    s.set(a);
    return s;
  };
  const opt = (a: Float32Array | null) => (a ? share(a) : null);
  switch (msg.type) {
    case 'sampler':
      return {
        ...msg,
        spec: {
          ...msg.spec,
          zones: msg.spec.zones.map((z) => ({ ...z, left: share(z.left), right: opt(z.right) })),
        },
      };
    case 'performance':
      return {
        ...msg,
        samples: msg.samples.map((x) => {
          const left = share(x.left);
          return { ...x, left, right: x.right === x.left ? left : share(x.right) };
        }),
      };
    case 'audio':
      return { ...msg, channels: msg.channels.map(share) };
    case 'impulse': {
      const d = msg.data;
      return {
        ...msg,
        data: {
          ...d,
          head: d.head ? { ll: share(d.head.ll), rr: share(d.head.rr), lr: opt(d.head.lr), rl: opt(d.head.rl) } : null,
          segments: d.segments.map((s) => ({ ...s, ll: share(s.ll), rr: share(s.rr), lr: opt(s.lr), rl: opt(s.rl) })),
        },
      };
    }
    default:
      return msg;
  }
}

interface Result {
  name: string;
  /** Per block, as a share of its real-time budget: the mean, the 99th percentile and the worst (the audio thread's). */
  mean: number;
  p99: number;
  worst: number;
  /** Seconds of audio per second of work. */
  speed: number;
  /** With --ahead: each worker's share of the time a block has (smoothed), and the busiest strips. */
  workers?: number[];
  /** With --paced: blocks the audio thread had to wait for. */
  stalls?: number;
}

const BLOCK = 128;

function stats(name: string, times: Float64Array, total: number, sr: number, wall: number): Result {
  const budget = (BLOCK / sr) * 1000;
  const blocks = times.length;
  const sorted = Float64Array.from(times).sort();
  return {
    name,
    mean: total / blocks / budget,
    p99: sorted[Math.floor(blocks * 0.99)] as number,
    worst: sorted[blocks - 1] as number,
    speed: (blocks * BLOCK) / sr / (wall / 1000),
  };
}

/** One engine on one thread, as the audio thread plays without rendering ahead. */
function measureOne(name: string, played: Played, seconds: number, sr: number): Result {
  const core = new EngineCore(sr, () => undefined);
  core.receive({ type: 'init', ring: null, meters: null, transport: null });
  for (const m of played.messages) core.receive(m);
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  const budget = (BLOCK / sr) * 1000;
  // a second to warm up (the JIT, the halls' first long blocks), then the timed part
  for (let i = 0; i < sr / BLOCK; i++) core.process(l, r, undefined, i * BLOCK);
  const blocks = Math.floor((seconds * sr) / BLOCK);
  const times = new Float64Array(blocks);
  let total = 0;
  const start = performance.now();
  for (let i = 0; i < blocks; i++) {
    const t0 = performance.now();
    core.process(l, r, undefined, i * BLOCK);
    const ms = performance.now() - t0;
    times[i] = ms / budget;
    total += ms;
  }
  if (process.argv.includes('--trace')) {
    const worst = times.indexOf(Math.max(...times));
    console.error(
      `  worst block ${worst} (${((worst * BLOCK) / sr).toFixed(2)} s): ${(times[worst] as number).toFixed(1)}× its time`,
    );
  }
  return stats(name, times, total, sr, performance.now() - start);
}

/**
 * Rendered ahead: worker threads play the song, this thread plays what the audio thread does (the
 * master), taking each block as soon as the workers have it. The strips are laid out by a guess, then
 * again by how long each took (as the studio does when it starts playing).
 */
async function measureAhead(name: string, played: Played, seconds: number, sr: number, count: number): Promise<Result> {
  const control = aheadControl();
  const graph = played.graph;
  const guess = new Map<number, number>([
    ...graph.tracks.map((t) => [t.num, aheadGuess(t, played.parts.get(t.num))] as const),
    ...graph.buses.map((b) => [b.num, aheadGuess(b)] as const),
  ]);
  let owners = aheadOwners(graph, count, (num) => guess.get(num) ?? 0.01);
  const room = aheadRoom(
    Math.max(
      64,
      aheadPlan(
        graph,
        aheadOwners(graph, count, () => 1),
      ).handed * 2,
    ),
  );
  const data = aheadData(room);
  const link = new AheadLink(control, data, room);
  const errors: string[] = [];
  const threads = Array.from({ length: count }, (_, self) => {
    const w = new Worker(new URL('./ahead-thread.ts', import.meta.url), {
      workerData: { sr, ahead: { control, data, edges: room, workers: count, self } },
    });
    w.on('message', (m: { type: string; message?: string }) => {
      if (m.type === 'error') errors.push(m.message ?? '');
    });
    return w;
  });
  const core = new EngineCore(sr, (m) => {
    if (m.type === 'error') errors.push(m.message);
  });
  core.receive({
    type: 'init',
    ring: null,
    meters: null,
    transport: null,
    ahead: { control, data, edges: room, workers: count, self: -1 },
  });
  const player = new AheadPlayer(core, link, count);
  const send = (m: ToWorklet) => {
    for (const t of threads) t.postMessage(m);
    player.receive(m);
  };
  send({ type: 'ahead', owners });
  // everything but the start: as in the studio, the song is loaded and stopped, and laid out again
  // when it starts by what has been timed meanwhile
  const go = played.messages.at(-1) as ToWorklet;
  for (const m of played.messages.slice(0, -1)) send(shared(m));
  const l = new Float32Array(BLOCK);
  const r = new Float32Array(BLOCK);
  const budget = (BLOCK / sr) * 1000;
  /** Play `blocks` blocks as fast as the workers have them: the audio thread's time for each. */
  const paced = process.argv.includes('--paced');
  const tick = new Int32Array(new SharedArrayBuffer(4));
  let stalls = 0;
  const when: number[] = [];
  const play = async (blocks: number, times?: Float64Array): Promise<number> => {
    let total = 0;
    const begin = performance.now();
    for (let i = 0, q = 0; i < blocks; q++) {
      if (paced) {
        // as the audio thread: a block every block's time, whether the workers have it or not
        const due = begin + q * budget;
        while (performance.now() < due - 1) Atomics.wait(tick, 0, 0, 0.5);
        while (performance.now() < due);
      }
      const t0 = performance.now();
      if (player.process(l, r, undefined, i * BLOCK)) {
        const ms = performance.now() - t0;
        if (times) times[i] = ms / budget;
        total += ms;
        i++;
      } else if (paced) {
        if (times) {
          stalls++;
          when.push(Math.floor((i * BLOCK) / sr));
        }
      } else await new Promise((done) => setImmediate(done));
      if (errors.length) throw new Error(errors[0]);
    }
    return total;
  };
  // stopped a moment, then laid out by how long each strip took (and the planned parts by their plans)
  await play(Math.round((2 * sr) / BLOCK));
  // (a planned part's guess counts all along: it knows its busiest passages before they come)
  const planCost = (num: number) => {
    const g = guess.get(num) ?? 0.01;
    return played.parts.has(num) ? Math.max(link.cost(num), g) : link.cost(num) || g;
  };
  owners = aheadOwners(graph, count, planCost);
  send({ type: 'ahead', owners });
  send(go);
  if (process.argv.includes('--trace')) {
    const planned = new Array<number>(count).fill(0);
    for (const s of [...graph.tracks, ...graph.buses]) {
      const o = owners[s.num] ?? -1;
      if (o >= 0) planned[o] = (planned[o] as number) + planCost(s.num);
    }
    console.error(`  laid out for: ${planned.map(pct).join(' ')}`);
    const by = [...graph.tracks, ...graph.buses].map((x) => [x.id, planCost(x.num), link.cost(x.num)] as const);
    by.sort((a, b) => b[1] - a[1]);
    console.error(
      `  by: ${by
        .slice(0, 16)
        .map(([id, c, m]) => `${id} ${pct(c)} (timed ${pct(m)})`)
        .join(', ')}`,
    );
  }
  await play(Math.round((2 * sr) / BLOCK));
  const blocks = Math.floor((seconds * sr) / BLOCK);
  const times = new Float64Array(blocks);
  const start = performance.now();
  const total = await play(blocks, times);
  const wall = performance.now() - start;
  const res = stats(name, times, total, sr, wall);
  res.workers = Array.from({ length: count }, (_, j) => link.load(j));
  // paced, the speed is real time: what counts is how often the workers weren't ready
  if (paced) res.stalls = stalls;
  if (paced && process.argv.includes('--trace')) {
    const per = new Map<number, number>();
    for (const t of when) per.set(t, (per.get(t) ?? 0) + 1);
    console.error(`  stalls by second: ${[...per].map(([t, n]) => `${t}s:${n}`).join(' ')} (lead now ${link.lead()})`);
  }
  if (process.argv.includes('--trace')) {
    const strips = [
      ...graph.tracks.map((t) => [t.id, t.num] as const),
      ...graph.buses.map((b) => [b.id, b.num] as const),
    ];
    const top = strips.map(([id, num]) => ({ id, num, cost: link.cost(num), owner: owners[num], plan: planCost(num) }));
    top.sort((a, b) => b.cost - a.cost);
    for (const s of top.slice(0, 14))
      console.error(
        `  ${(s.cost * 100).toFixed(1).padStart(5)}% (planned ${(s.plan * 100).toFixed(1)}%)  ${s.id} (worker ${s.owner})`,
      );
  }
  for (const t of threads) t.postMessage({ type: 'aheadQuit' });
  await Promise.all(threads.map((t) => t.terminate()));
  return res;
}

const seconds = Number(arg('seconds') ?? 8);
const ahead = Number(arg('ahead') ?? 0);
const sessionFile = arg('session');
const cpu = cpus();
console.log(
  `HO[LO] engine scale test: ${cpu[0]?.model ?? 'unknown CPU'} (${cpu.length} threads), Node ${process.version}`,
);
const pct = (x: number) => `${(x * 100).toFixed(0)}%`;
const results: Result[] = [];
const report = (res: Result, cells: (string | number)[]) => {
  results.push(res);
  const workers = res.workers ? ` ${res.workers.map(pct).join(' ')} |` : '';
  const speed = res.stalls !== undefined ? `${res.stalls} stalls` : `${res.speed.toFixed(1)}×`;
  console.log(`| ${cells.join(' | ')} | ${pct(res.mean)} | ${pct(res.p99)} | ${pct(res.worst)} |${workers} ${speed} |`);
};
const how = ahead
  ? `rendered ahead on ${ahead} worker thread${ahead === 1 ? '' : 's'} (load: the audio thread's; workers: each one's share)`
  : 'one thread';
let sr = Number(arg('rate') ?? 48000);
if (sessionFile) {
  const project = parseProject(JSON.parse(readFileSync(resolve(sessionFile), 'utf8')));
  sr = Number(arg('rate') ?? project.sampleRate ?? 48000);
  const fromBar = Number(arg('from') ?? 1);
  console.log(`"${project.title}" from bar ${fromBar}, ${seconds} s at ${sr} Hz, blocks of 128 frames, ${how}\n`);
  console.log(`| song | load (mean) | 99% of blocks | worst block |${ahead ? ' workers |' : ''} speed |`);
  console.log(`|---|---|---|---|${ahead ? '---|' : ''}---|`);
  const played = await session(project, resolve(process.env.HOLO_DATA_DIR ?? 'data'), sr, fromBar);
  const res = ahead
    ? await measureAhead(project.title, played, seconds, sr, ahead)
    : measureOne(project.title, played, seconds, sr);
  report(res, [project.title]);
} else {
  const only = arg('only')
    ?.split(',')
    .map((x) => Number(x) - 1);
  console.log(
    `${seconds} s of each song at ${sr} Hz, blocks of 128 frames (${((128 / sr) * 1000).toFixed(2)} ms), ${how}\n`,
  );
  console.log(
    `| # | tracks | voices each | plugins each | lanes each | halls | load (mean) | 99% of blocks | worst block |${ahead ? ' workers |' : ''} speed |`,
  );
  console.log(`|---|---|---|---|---|---|---|---|---|${ahead ? '---|' : ''}---|`);
  for (const [i, size] of SIZES.entries()) {
    if (only && !only.includes(i)) continue;
    // (ahead, it warms up longer: the song lasts that much longer)
    const played = madeUp(song(size, ahead ? seconds + 4 : seconds), sr);
    const name = `${size.tracks}×${size.voices}`;
    const res = ahead ? await measureAhead(name, played, seconds, sr, ahead) : measureOne(name, played, seconds, sr);
    report(res, [i + 1, size.tracks, size.voices, size.inserts, size.lanes, size.halls]);
  }
}
console.log(
  ahead
    ? '\nThe song keeps up while every worker stays under 100% (speed above 1×); keep the audio thread under about 70%.'
    : '\nUnder 100% the audio thread keeps up; keep the mean under about 70% (and 99% of blocks under 100%) for',
);
if (!ahead) console.log('live playing without crackles, since the browser and the page share the machine.');
const out = arg('json');
if (out) {
  writeFileSync(
    out,
    `${JSON.stringify({ cpu: cpu[0]?.model, threads: cpu.length, node: process.version, seconds, sampleRate: sr, ahead, results }, null, 1)}\n`,
  );
}
