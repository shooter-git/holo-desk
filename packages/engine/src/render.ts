/**
 * Rendering a song to audio with the engine, anywhere: the studio's Bounce (in a worker) and headless
 * renders (the server, `holo render-audio`, a creation's build) run this same function with the
 * same sample decoding, so the same session always gives the same numbers.
 */
import { type AudioClip, type Project, projectEnd } from '@holo/session';
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
} from './compile.ts';
import { prepareImpulse } from './convolver.ts';
import { EngineCore } from './core.ts';
import { finish } from './master.ts';
import { isPlanned, type PerformanceManifest, partReach, partSamples, planTrack, wrapPlans } from './parts.ts';
import { EV_OFF, EV_ON, EVENT_SIZE, type SamplerSpec, type SampleZone } from './protocol.ts';
import { resample } from './resample.ts';
import { type ImpulseSource, impulseFromAudio } from './space.ts';
import { generateSpace } from './spaces.ts';
import { stretchAudio } from './stretch.ts';
import { decodeWav } from './wav.ts';

export interface ZoneManifest {
  file: string;
  root: number;
  lo: number;
  hi: number;
  lovel: number;
  hivel: number;
  /** dB */
  gain: number;
  start: number;
  end: number;
  loopStart: number;
  loopEnd: number;
  rate: number;
  rr: number;
}

export interface InstrumentManifest {
  pack: string;
  name: string;
  /** How a Performance instrument plays it (the creation's own sampler), when the pack has it. */
  performance?: PerformanceManifest;
  release: number;
  attack: number;
  oneShot: boolean;
  pitched?: boolean;
  velocityRange: number;
  zones: ZoneManifest[];
}

/** Where a render gets what it plays: instruments and their samples, and the song's audio files. */
export interface RenderSource {
  instrument(pack: string, name: string): Promise<InstrumentManifest>;
  /** A sample file of a pack (WAV). */
  sample(pack: string, file: string): Promise<Uint8Array>;
  /** One of the song's audio files (WAV). */
  audio(file: string): Promise<Uint8Array>;
  /** An impulse response file of a pack (WAV: 1, 2 or 4 channels). */
  impulse(pack: string, name: string): Promise<Uint8Array>;
}

export interface RenderOptions {
  /** Frames a second of the result (and of the engine). */
  sampleRate: number;
  /** Ticks; the whole song by default. */
  from?: number;
  to?: number;
  /** Seconds after the end for reverb and ringing notes. */
  tail?: number;
  /** false: the mix as it plays, without the song's finish (mastering). */
  finish?: boolean;
  /** false: from..to as it plays, even when the song is a loop. */
  loop?: boolean;
  onProgress?: (text: string) => void;
}

export interface Rendered {
  sampleRate: number;
  channels: Float32Array[];
  /** What the engine reported on the way (an empty list is a clean render). */
  errors: string[];
}

/** An instrument's samples at a rate, trimmed to their measured start and end (moved with the rate). */
export async function buildSampler(
  source: RenderSource,
  pack: string,
  name: string,
  sampleRate: number,
): Promise<SamplerSpec> {
  const manifest = await source.instrument(pack, name);
  const zones: SampleZone[] = [];
  for (const z of manifest.zones) {
    const decoded = decodeWav(await source.sample(pack, z.file));
    const k = sampleRate / decoded.rate;
    const at = (frames: number) => Math.round(frames * k);
    const convert = (c: Float32Array) => (decoded.rate === sampleRate ? c : resample(c, decoded.rate, sampleRate));
    const left = convert(decoded.channels[0] as Float32Array);
    const right = decoded.channels[1] ? convert(decoded.channels[1]) : null;
    const start = Math.max(0, at(z.start));
    const end = Math.min(left.length, z.end > 0 ? at(z.end) : left.length);
    const loops = z.loopEnd > z.loopStart;
    zones.push({
      left: left.slice(start, end),
      right: right ? right.slice(start, end) : null,
      root: z.root,
      lo: z.lo,
      hi: z.hi,
      lovel: z.lovel,
      hivel: z.hivel,
      gain: 10 ** (z.gain / 20),
      loopStart: loops ? Math.max(0, at(z.loopStart) - start) : 0,
      loopEnd: loops ? Math.max(0, at(z.loopEnd) - start) : 0,
      rr: z.rr,
    });
  }
  return {
    key: `${pack}/${name}`,
    zones,
    release: manifest.release,
    oneShot: manifest.oneShot,
    pitched: manifest.pitched !== false,
    velocityRange: manifest.velocityRange,
    attack: manifest.attack,
  };
}

/** A clip's recording at a rate, stretched if it asks. */
export async function loadClipAudio(
  source: RenderSource,
  clip: Pick<AudioClip, 'file' | 'stretch'>,
  sampleRate: number,
): Promise<Float32Array[]> {
  const decoded = decodeWav(await source.audio(clip.file));
  let channels = decoded.channels
    .slice(0, 2)
    .map((c) => (decoded.rate === sampleRate ? c : resample(c, decoded.rate, sampleRate)));
  if (Math.abs(clip.stretch - 1) >= 1e-4) channels = stretchAudio(channels, clip.stretch, sampleRate);
  return channels;
}

const BLOCK = 128;

/** A Space Designer's response at a rate: generated, or read from a pack. */
export async function loadImpulse(source: RenderSource, from: ImpulseSource, rate: number) {
  if (from.kind === 'space') return generateSpace(from.name, from.seed, from.decay, rate);
  return impulseFromAudio(decodeWav(await source.impulse(from.pack, from.name)), rate);
}

/** A loop's tails must have died away before its last turn is kept: this long at least before it. */
const LOOP_SETTLE = 45;

export async function renderSession(project: Project, source: RenderSource, opts: RenderOptions): Promise<Rendered> {
  const sr = opts.sampleRate;
  const segments = compileTempo(project, sr);
  const loop = opts.loop !== false && opts.from === undefined && opts.to === undefined ? project.loop : undefined;
  const from = loop ? loop.start : (opts.from ?? 0);
  const to = loop ? loop.end : (opts.to ?? projectEnd(project));
  const start = Math.round(tickToFrame(segments, from));
  const stop = Math.round(tickToFrame(segments, to));
  const turn = stop - start;
  const errors: string[] = [];
  const core = new EngineCore(sr, (msg) => {
    if (msg.type === 'error') errors.push(msg.message);
  });
  const nums = new Map<string, number>();
  const numOf = (id: string) => {
    let n = nums.get(id);
    if (n === undefined) {
      n = nums.size + 1;
      nums.set(id, n);
    }
    return n;
  };

  core.receive({ type: 'init', ring: null, meters: null, transport: null });
  core.receive({ type: 'tempo', segments, ppq: 960, ...meterTicks(project) });
  // the samples first: the mixer builds each track's instrument from them (a planned part plays its
  // own voices, so its instrument's plain sampler, there for live playing, isn't needed here)
  const keys = new Set<string>();
  for (const t of project.tracks) {
    if (isPlanned(t)) continue;
    for (const i of [t.instrument, ...t.articulations.map((a) => a.instrument)]) {
      const spec = instrumentSpec(i);
      if (spec.kind === 'sampler') keys.add(spec.key);
    }
  }
  let k = 0;
  for (const key of keys) {
    opts.onProgress?.(`Loading instruments (${++k}/${keys.size})`);
    const [pack = '', ...rest] = key.split('/');
    core.receive({ type: 'sampler', spec: await buildSampler(source, pack, rest.join('/'), sr) });
  }
  const clips = songClips(project);
  let c = 0;
  for (const clip of clips) {
    opts.onProgress?.(`Loading audio (${++c}/${clips.length})`);
    core.receive({ type: 'audio', key: clipKey(clip), channels: await loadClipAudio(source, clip, sr) });
  }
  const impulses = songImpulses(project, sr);
  let q = 0;
  for (const { key, source: from } of impulses) {
    opts.onProgress?.(`Preparing spaces (${++q}/${impulses.length})`);
    core.receive({ type: 'impulse', key, data: prepareImpulse(await loadImpulse(source, from, sr)) });
  }
  core.receive({ type: 'graph', graph: compileGraph(project, numOf, segments) });
  // planned parts: planned whole, their samples loaded, handed over as voices to start
  let pp = 0;
  /** How far past the loop's start its voices sound (a voice can outlast a turn, and come round onto itself). */
  let reach = turn;
  const planned = project.tracks.filter(isPlanned);
  for (const t of planned) {
    opts.onProgress?.(`Planning parts (${++pp}/${planned.length})`);
    const inst = t.instrument;
    let perf: PerformanceManifest | undefined;
    if (inst.type === 'performance') {
      perf = (await source.instrument(inst.pack, inst.name)).performance;
      if (!perf) {
        errors.push(`${inst.pack}/${inst.name} has no Performance data: ${t.name} is silent`);
        continue;
      }
    }
    let plans = planTrack(t, project, segments, sr, perf);
    if (!plans) continue;
    if (loop) {
      plans = wrapPlans(plans, start, stop);
      reach = Math.max(reach, partReach(plans) - start);
    }
    if (plans.kind === 'performance' && perf && inst.type === 'performance') {
      const samples: { index: number; left: Float32Array; right: Float32Array }[] = [];
      for (const index of partSamples(plans)) {
        const decoded = decodeWav(await source.sample(inst.pack, perf.files[index] as string));
        const conv = (c: Float32Array) => (decoded.rate === sr ? c : resample(c, decoded.rate, sr));
        const left = conv(decoded.channels[0] as Float32Array);
        samples.push({ index, left, right: decoded.channels[1] ? conv(decoded.channels[1]) : left });
      }
      core.receive({ type: 'performance', key: plans.key, samples });
    }
    core.receive({ type: 'plans', num: numOf(t.id), plans });
  }
  for (const t of project.tracks) {
    // nothing starts after the end; what started before it rings out into the tail; a planned part's
    // notes are its plans (its sequence keeps only its controllers)
    const all = compileTrack(t, segments);
    const kept: number[] = [];
    const notesPlanned = isPlanned(t);
    for (let i = 0; i < all.length; i += EVENT_SIZE) {
      const kind = all[i + 1] as number;
      if (notesPlanned && (kind === EV_ON || kind === EV_OFF)) continue;
      if (kind === EV_ON && (all[i] as number) >= stop) continue;
      for (let j = 0; j < EVENT_SIZE; j++) kept.push(all[i + j] as number);
    }
    core.receive({
      type: 'sequence',
      num: numOf(t.id),
      events: loop ? wrapNotes(kept, start, stop) : new Float64Array(kept),
    });
    if (t.kind === 'audio') core.receive({ type: 'clips', num: numOf(t.id), clips: compileClips(t, segments, sr) });
  }
  // a loop plays turn after turn until everything that rings past its end has come round (its longest
  // voice, and the halls after it), and keeps the last
  const turns = loop ? Math.ceil((reach + LOOP_SETTLE * sr) / Math.max(1, turn)) : 1;
  const length = loop ? turn * turns : Math.max(1, stop - start + Math.round((opts.tail ?? 4) * sr));
  if (loop) core.receive({ type: 'cycle', on: true, start, end: stop, wrap: true });
  core.receive({ type: 'play', frame: start, record: false, countIn: 0 });

  // the mix's sound comes out behind the song by its plugins' look-ahead: render that much more, and
  // keep from where the song begins. Whole blocks only (the convolution works in them).
  const late = core.measureLatency();
  const blocks = Math.ceil((length + late) / BLOCK);
  const left = new Float32Array(blocks * BLOCK);
  const right = new Float32Array(blocks * BLOCK);
  const blockL = new Float32Array(BLOCK);
  const blockR = new Float32Array(BLOCK);
  const tenth = Math.max(BLOCK, Math.floor(length / 10));
  for (let at = 0; at < blocks * BLOCK; at += BLOCK) {
    core.process(blockL, blockR, undefined, at);
    left.set(blockL, at);
    right.set(blockR, at);
    if (at % tenth < BLOCK && at > 0)
      opts.onProgress?.(`Rendering… ${Math.min(100, Math.round((at / length) * 100))}%`);
  }
  // a loop keeps its last turn
  const keep = loop ? late + turn * (turns - 1) : late;
  const keepLength = loop ? turn : length;
  let channels: Float32Array[] = [left.slice(keep, keep + keepLength), right.slice(keep, keep + keepLength)];
  const done = project.finish && opts.finish !== false ? project.finish : null;
  if (done) {
    opts.onProgress?.('Mastering…');
    const f = finish(channels, sr, {
      lufs: done.lufs,
      ceiling: done.ceiling,
      glue: done.glue,
      lowcut: done.lowcut,
      tilt: done.tilt,
      circular: !!loop,
    });
    channels = f.channels.map((c) => Float32Array.from(c));
  }
  if (loop && loop.tail > 0) {
    // the loop, then its start again for a player to cross into
    const tail = Math.min(turn, Math.round(loop.tail * sr));
    channels = channels.map((c) => {
      const out = new Float32Array(c.length + tail);
      out.set(c, 0);
      out.set(c.subarray(0, tail), c.length);
      return out;
    });
  }
  return { sampleRate: sr, channels, errors };
}

/**
 * A loop's notes as the loop plays them forever: a note still sounding at the end goes on into the
 * start, and stops there where it would have (its end comes round again).
 */
function wrapNotes(events: number[], start: number, stop: number): Float64Array {
  const turn = stop - start;
  const extra: number[] = [];
  for (let i = 0; i < events.length; i += EVENT_SIZE) {
    if ((events[i + 1] as number) !== EV_ON) continue;
    const pitch = events[i + 2] as number;
    const art = events[i + 4] as number;
    for (let j = i + EVENT_SIZE; j < events.length; j += EVENT_SIZE) {
      if ((events[j + 1] as number) !== EV_OFF || events[j + 2] !== pitch || events[j + 4] !== art) continue;
      const off = events[j] as number;
      if (off >= stop && off - turn >= start) extra.push(off - turn, EV_OFF, pitch, 0, art);
      break;
    }
  }
  if (!extra.length) return new Float64Array(events);
  const rows: number[][] = [];
  for (const list of [events, extra])
    for (let i = 0; i < list.length; i += EVENT_SIZE) rows.push(list.slice(i, i + EVENT_SIZE));
  rows.sort((a, b) => (a[0] as number) - (b[0] as number) || (a[1] as number) - (b[1] as number));
  return new Float64Array(rows.flat());
}
