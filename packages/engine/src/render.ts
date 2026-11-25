/**
 * Rendering a song to audio with the engine, anywhere: the studio's Bounce (in a worker) and headless
 * renders (the server, `holo render-audio`, a creation's build) run this same function with the
 * same sample decoding, so the same session always gives the same numbers.
 */
import {
  type AudioClip,
  cleanPad,
  type KitPad,
  type KitPadSettings,
  type Project,
  performed,
  playedAt,
  playedTimes,
  playMap,
  projectEnd,
  type SampleMic,
} from '@holo/session';
import {
  AheadPool,
  type AheadTiming,
  aheadGuess,
  aheadMade,
  aheadPartGuess,
  aheadShared,
  aheadTrackGuess,
} from './ahead.ts';
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
  songKits,
  tickToFrame,
} from './compile.ts';
import { prepareImpulse } from './convolver.ts';
import { EngineCore } from './core.ts';
import { finish } from './master.ts';
import { renderNotePatch } from './notes/patch.ts';
import { songPatches } from './notes/plan.ts';
import { isPlanned, type PerformanceManifest, partReach, partSamples, planTrack, wrapPlans } from './parts.ts';
import { playedKeys, playedZones } from './played.ts';
import { readPartials } from './prism-sources.ts';
import {
  type AheadSpec,
  EV_OFF,
  EV_ON,
  EVENT_SIZE,
  type GraphSpec,
  type SampleFrames,
  type SamplerSpec,
  type SampleZone,
  type ToWorklet,
} from './protocol.ts';
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
  /** Choke group, the group that chokes it, release trigger and release time (see SampleZone). */
  group?: number;
  offBy?: number;
  trigger?: 'release' | 'pedalDown' | 'pedalUp';
  part?: number;
  decay?: number;
  release?: number;
  /** Frames (at its rate) faded out before its end, as it's loaded: a sample kept shorter than its file. */
  fadeOut?: number;
  /** The microphone it was recorded with, and where it sits if mono (see SampleZone). */
  mic?: string;
  pan?: number;
  /** An instrument that plays through a synth: the synth's source the zone is for (see SampleZone). */
  source?: number;
  /** The file is a partial set (prism-sources.ts's writePartials), not audio. */
  partials?: boolean;
}

/**
 * Fade a loaded sample's last `frames` out (an S curve to silence), in place: where a pack keeps a
 * sample shorter than its file, it ends without a click.
 */
export function fadeTail(data: SampleFrames, frames: number): void {
  const n = Math.min(Math.round(frames), data.length);
  // (16-bit frames round to the nearest step: storing would cut toward zero)
  const whole = data instanceof Int16Array;
  for (let i = 0; i < n; i++) {
    const t = (i + 1) / n;
    const j = data.length - n + i;
    const v = (data[j] as number) * (1 - t * t * (3 - 2 * t));
    data[j] = whole ? Math.round(v) : v;
  }
}

/** What a played instrument asks of the sampler besides its zones (see SamplerSpec). */
export interface PlayingManifest {
  polyphony?: number;
  notePolyphony?: number;
  offTime?: number;
  undamped?: number;
  releaseDecay?: number;
  releaseVelocityRange?: number;
  /** A multi-microphone instrument's microphones (see SamplerSpec). */
  mics?: SampleMic[];
  /** A kit's pads, every piece once, in rows of four: the key each plays, what sounds there, and its own settings. */
  pads?: KitPad[];
}

/** The zone's and the instrument's optional settings, as the sampler takes them (only those the pack has). */
type ZoneExtras = Pick<
  SampleZone,
  'group' | 'offBy' | 'trigger' | 'part' | 'decay' | 'release' | 'mic' | 'pan' | 'source'
>;

export function zoneExtras(z: ZoneManifest): ZoneExtras {
  const out: ZoneExtras = {};
  if (z.group) out.group = z.group;
  if (z.offBy) out.offBy = z.offBy;
  if (z.trigger === 'release' || z.trigger === 'pedalDown' || z.trigger === 'pedalUp') out.trigger = z.trigger;
  if (z.part) out.part = z.part;
  if (z.decay !== undefined) out.decay = z.decay;
  if (z.release !== undefined) out.release = z.release;
  if (typeof z.mic === 'string' && z.mic) out.mic = z.mic;
  if (typeof z.pan === 'number' && Number.isFinite(z.pan) && z.pan !== 0) out.pan = Math.max(-1, Math.min(1, z.pan));
  if (typeof z.source === 'number' && Number.isInteger(z.source) && z.source >= 1) out.source = z.source;
  return out;
}

/** An instrument's synth, when it plays through one (its zones are then that synth's data, see SamplerSpec). */
export function synthExtras(m: { synth?: unknown; params?: unknown }): {
  synth?: string;
  params?: Record<string, number>;
} {
  if (typeof m.synth !== 'string' || !m.synth) return {};
  const params: Record<string, number> = {};
  if (m.params && typeof m.params === 'object')
    for (const [k, v] of Object.entries(m.params)) if (typeof v === 'number' && Number.isFinite(v)) params[k] = v;
  return { synth: m.synth, params };
}

/** A partial-set zone, loaded: its data in place of frames. */
export function partialZone(z: ZoneManifest, bytes: Uint8Array): SampleZone | null {
  const partials = readPartials(bytes);
  if (!partials) return null;
  return {
    left: new Float32Array(0),
    right: null,
    root: z.root,
    lo: z.lo,
    hi: z.hi,
    lovel: z.lovel,
    hivel: z.hivel,
    gain: 10 ** (z.gain / 20),
    loopStart: 0,
    loopEnd: 0,
    rr: z.rr,
    ...zoneExtras(z),
    partials,
  };
}

/** What a played instrument asks of the sampler, as the sampler takes it (its pads only those with settings). */
export type PlayingExtras = Omit<PlayingManifest, 'pads'> & { pads?: KitPadSettings[] };

export function playingExtras(m: PlayingManifest): PlayingExtras {
  const out: PlayingExtras = {};
  if (m.polyphony) out.polyphony = m.polyphony;
  if (m.notePolyphony) out.notePolyphony = m.notePolyphony;
  if (m.offTime !== undefined) out.offTime = m.offTime;
  if (m.undamped !== undefined) out.undamped = m.undamped;
  if (m.releaseDecay !== undefined) out.releaseDecay = m.releaseDecay;
  if (m.releaseVelocityRange !== undefined) out.releaseVelocityRange = m.releaseVelocityRange;
  if (Array.isArray(m.mics) && m.mics.length) {
    out.mics = m.mics
      .filter((x) => typeof x?.id === 'string' && x.id)
      .map((x) => ({
        id: x.id,
        name: typeof x.name === 'string' && x.name ? x.name : x.id,
        ...(typeof x.level === 'number' && Number.isFinite(x.level) ? { level: x.level } : {}),
        ...(typeof x.pan === 'number' && Number.isFinite(x.pan) && x.pan !== 0
          ? { pan: Math.max(-1, Math.min(1, x.pan)) }
          : {}),
      }));
  }
  // only the pads with settings of their own (their names are the screen's)
  if (Array.isArray(m.pads)) {
    const pads = m.pads.map(cleanPad).filter((p): p is KitPadSettings => p !== null);
    if (pads.length) out.pads = pads;
  }
  return out;
}

export interface InstrumentManifest extends PlayingManifest {
  pack: string;
  name: string;
  /** A built-in synth it plays through (Prism's sounds), and its patch. */
  synth?: string;
  params?: Record<string, number>;
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
  /**
   * 'all': every zone of every instrument is loaded. Otherwise only those the song can sound
   * (played.ts), which renders the same to the byte in less time and memory.
   */
  samples?: 'played' | 'all';
  /**
   * Engines side by side, on threads the caller starts (a host with cores to spare): the same
   * render to the byte, sooner. Without it, one engine on this thread, as ever.
   */
  split?: RenderSplit;
  onProgress?: (text: string) => void;
}

/** A thread of a split render, as the render sees it, wherever it runs. */
export interface RenderThread {
  /** A message of the song's, in the order every engine gets them. The thread plays nothing until `go`. */
  post(msg: ToWorklet): void;
  /** The whole song has been posted: play it, block after block. */
  go(): void;
  /** Stop, and say what went wrong in its engine, if anything did (null: nothing). */
  end(): Promise<string | null>;
}

/**
 * How a render is split over threads: how many, and how one is started. A thread runs an engine
 * that takes part in the pool (`spec`) with a render's own settings (every strip played through, no
 * fades at the transport), holds what it's posted until it's told to go, and then plays as a
 * render-ahead worker does (AheadWorker). `failed` is told when its engine reports an error or the
 * thread stops by itself: the render then starts over on one engine.
 */
export interface RenderSplit {
  workers: number;
  start(spec: AheadSpec, sampleRate: number, failed: (why: string) => void): RenderThread;
  /** How long the threads may go without a block before the render is made on one engine instead, ms (two minutes). */
  patience?: number;
  /**
   * What an earlier split render found each strip to cost (`learned`), for whoever keeps it: the
   * strips are shared out by it, more evenly than by guesses, so the render is sooner. It changes
   * nothing of what's rendered.
   */
  costs?: RenderCosts | null;
  /** Told, after a split render that went through, what its strips cost: to keep, and hand back as `costs`. */
  learned?(costs: RenderCosts): void;
}

/**
 * What a split render's strips cost on this computer: each one's share of a block's time, averaged
 * over the render, with what the strip was then (a strip with other plugins or another instrument
 * is guessed afresh), by the strip's id; and how far this computer's timings run from the guesses
 * (ahead.ts, AheadScale), for strips, and songs, that haven't been timed.
 */
export interface RenderCosts {
  scale: { tracks: number; buses: number };
  strips: Record<string, AheadTiming>;
}

export interface Rendered {
  sampleRate: number;
  channels: Float32Array[];
  /** What the engine reported on the way (an empty list is a clean render). */
  errors: string[];
}

/**
 * The zones of an instrument to load for a song that sends it `keys` (played.ts): all of them for an
 * instrument that plays through a synth (its zones are a patch's data, found by the synth's own
 * rule) or has a partial set among them (one that can't be read is left out as it loads), and
 * where playedZones doesn't reason about a zone.
 */
function zonesFor(manifest: InstrumentManifest, keys: readonly number[]): readonly ZoneManifest[] {
  if (synthExtras(manifest).synth || manifest.zones.some((z) => z.partials)) return manifest.zones;
  const played = playedZones(
    manifest.zones.map((z) => ({ lo: z.lo, hi: z.hi, lovel: z.lovel, hivel: z.hivel, ...zoneExtras(z) })),
    (playingExtras(manifest).mics ?? []).map((m) => m.id),
    keys,
  );
  return played ? manifest.zones.filter((_z, i) => played.has(i)) : manifest.zones;
}

/**
 * An instrument's samples at a rate, trimmed to their measured start and end (moved with the rate).
 * `keys`: the keys a song sends it, to load only the zones those can sound (each loaded just as it
 * would be among all of them); without them, or with null, every zone.
 */
export async function buildSampler(
  source: RenderSource,
  pack: string,
  name: string,
  sampleRate: number,
  keys?: readonly number[] | null,
): Promise<SamplerSpec> {
  const manifest = await source.instrument(pack, name);
  const zones: SampleZone[] = [];
  // zones that play the same stretch of the same file (a drum on two pads) share one copy
  const shared = new Map<string, { left: Float32Array; right: Float32Array | null; k: number }>();
  for (const z of keys ? zonesFor(manifest, keys) : manifest.zones) {
    if (z.partials) {
      const zone = partialZone(z, await source.sample(pack, z.file));
      if (zone) zones.push(zone);
      continue;
    }
    const key = `${z.file}|${z.start}|${z.end}|${z.fadeOut ?? 0}`;
    let copy = shared.get(key);
    if (!copy) {
      const decoded = decodeWav(await source.sample(pack, z.file));
      const k = sampleRate / decoded.rate;
      const convert = (c: Float32Array) => (decoded.rate === sampleRate ? c : resample(c, decoded.rate, sampleRate));
      const left = convert(decoded.channels[0] as Float32Array);
      const right = decoded.channels[1] ? convert(decoded.channels[1]) : null;
      const start = Math.max(0, Math.round(z.start * k));
      const end = Math.min(left.length, z.end > 0 ? Math.round(z.end * k) : left.length);
      const l = left.slice(start, end);
      const r = right ? right.slice(start, end) : null;
      if (z.fadeOut) {
        fadeTail(l, Math.round(z.fadeOut * k));
        if (r) fadeTail(r, Math.round(z.fadeOut * k));
      }
      copy = { left: l, right: r, k };
      shared.set(key, copy);
    }
    const { left: l, right: r, k } = copy;
    const at = (frames: number) => Math.round(frames * k);
    const start = Math.max(0, at(z.start));
    const loops = z.loopEnd > z.loopStart;
    zones.push({
      left: l,
      right: r,
      root: z.root,
      lo: z.lo,
      hi: z.hi,
      lovel: z.lovel,
      hivel: z.hivel,
      gain: 10 ** (z.gain / 20),
      loopStart: loops ? Math.max(0, at(z.loopStart) - start) : 0,
      loopEnd: loops ? Math.max(0, at(z.loopEnd) - start) : 0,
      rr: z.rr,
      ...zoneExtras(z),
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
    ...playingExtras(manifest),
    ...synthExtras(manifest),
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

/** How often a split render looks at its strips' timings, in blocks (about four times a second). */
const TIMED_EVERY = 94;

/**
 * What a split render's strips cost, from their timings added up over `looks` looks: each strip's
 * average share of a block, and how far the timed ones run from their guesses (tracks and buses
 * apart; with too few timed to tell, as it was).
 */
function costsOf(
  graph: GraphSpec,
  parts: ReadonlyMap<number, number>,
  timed: ReadonlyMap<number, number>,
  looks: number,
  was: RenderCosts['scale'] = { tracks: 1, buses: 1 },
): RenderCosts {
  const strips: RenderCosts['strips'] = {};
  const sum = { tracks: [0, 0, 0], buses: [0, 0, 0] };
  const tracks = new Set(graph.tracks.map((t) => t.num));
  for (const s of [...graph.tracks, ...graph.buses]) {
    const share = (timed.get(s.num) ?? 0) / looks;
    if (!(share > 0)) continue;
    strips[s.id] = { share, made: aheadMade(s) };
    const guess = aheadGuess(s, parts.get(s.num));
    // (an empty strip's guess says nothing)
    if (guess <= 0.004) continue;
    const of = tracks.has(s.num) ? sum.tracks : sum.buses;
    of[0] = (of[0] as number) + share;
    of[1] = (of[1] as number) + guess;
    of[2] = (of[2] as number) + 1;
  }
  const scale = (before: number, of: number[], least: number) =>
    (of[2] as number) >= least && (of[1] as number) > 0
      ? Math.min(4, Math.max(0.02, (of[0] as number) / (of[1] as number)))
      : before;
  return { scale: { tracks: scale(was.tracks, sum.tracks, 3), buses: scale(was.buses, sum.buses, 1) }, strips };
}

/** A split render that hears nothing from its threads for this long is given up (and made on one engine). */
const SPLIT_STUCK_MS = 120_000;

interface Played {
  late: number;
  left: Float32Array<ArrayBuffer>;
  right: Float32Array<ArrayBuffer>;
}

/**
 * A render's blocks from engines side by side: the render-ahead pool (ahead.ts), run so that what
 * comes out is one engine's render to the byte. That takes what playing live doesn't do:
 *
 * - every engine has the whole song before the first block (the threads hold it until told to go,
 *   this thread's engine takes it in at once), so every message lands before block 0, as in one;
 * - who plays which strip is laid out once, with the graph, and never again (a strip that changes
 *   hands starts afresh where it lands: its notes and its plugins' tails are cut);
 * - each block is waited for, as long as it takes (playing live, a late block is silence).
 *
 * Null when it can't be trusted or didn't finish: an engine reported an error (it hands silence on
 * from there), a thread stopped, or no block came for too long. The caller renders again on one.
 */
async function playSplit(
  split: RenderSplit,
  sr: number,
  song: readonly ToWorklet[],
  graph: GraphSpec,
  parts: ReadonlyMap<number, number>,
  play: (from: EngineCore, before: (k: number) => Promise<void>, after: (k: number) => void) => Promise<Played>,
): Promise<Played | null> {
  let failure: string | null = null;
  const threads: RenderThread[] = [];
  // (never more threads than there are strips to share out; with one strip, one engine)
  const workers = Math.min(Math.round(split.workers), graph.tracks.length + graph.buses.length);
  if (!(workers >= 2)) return null;
  const failed = (why: string) => {
    failure ??= why;
  };
  const patience = split.patience ?? SPLIT_STUCK_MS;
  let pool: AheadPool | null = null;
  class GivenUp extends Error {}
  try {
    pool = new AheadPool(
      workers,
      (spec) => {
        const thread = split.start(spec, sr, failed);
        threads.push(thread);
        // (the pool only posts and closes; a render's threads are ended below, each asked what went wrong)
        return { post: (msg) => thread.post(msg), close: () => undefined };
      },
      sr,
    );
    const link = pool.link;
    const mixer = new EngineCore(sr, (msg) => {
      if (msg.type === 'error') failed(msg.message);
    });
    mixer.receive({ type: 'init', ring: null, meters: null, transport: null, ahead: pool.spec(-1) });
    for (const [num, guess] of parts) pool.setPart(num, guess);
    // shared out by what the strips cost the last time, where that's known, and by guesses elsewhere
    const strips = [...graph.tracks, ...graph.buses];
    const known = new Map<number, AheadTiming>();
    if (split.costs) {
      pool.setCalibration(split.costs.scale);
      for (const s of strips) {
        const timing = split.costs.strips[s.id];
        if (timing && typeof timing.share === 'number' && typeof timing.made === 'string') known.set(s.num, timing);
      }
    }
    const laid = pool.layout(graph, false, known);
    for (const msg of song) {
      pool.post(msg);
      mixer.receive(msg);
      if (msg.type !== 'graph') continue;
      for (const own of laid) {
        pool.post(own);
        mixer.receive(own);
      }
    }
    for (const t of threads) t.go();
    let heard = Date.now();
    const timed = new Map<number, number>();
    let looks = 0;
    const played = await play(
      mixer,
      async (k) => {
        while (!link.ready(k, workers)) {
          if (failure !== null) throw new GivenUp(failure);
          if (Date.now() - heard > patience) throw new GivenUp('The render threads stopped answering');
          await link.untilReady(k, workers, 50);
        }
        if (failure !== null) throw new GivenUp(failure);
        heard = Date.now();
        // (each strip's timing, a few times a second: averaged, what the next render lays out by)
        if (k % TIMED_EVERY === 0 && k > 0) {
          looks++;
          for (const s of strips) timed.set(s.num, (timed.get(s.num) ?? 0) + link.cost(s.num));
        }
        mixer.aheadBlock(k);
      },
      (k) => link.setConsumed(k + 1),
    );
    // an engine that failed handed silence on from there: each thread is asked before its blocks are kept
    const said = await Promise.all(threads.splice(0).map((t) => t.end()));
    if (failure !== null || said.some((error) => error !== null)) return null;
    if (split.learned && looks > 0) {
      try {
        split.learned(costsOf(graph, parts, timed, looks, split.costs?.scale));
      } catch {
        // (whoever keeps them couldn't: the render is what was asked for)
      }
    }
    return played;
  } catch (err) {
    if (err instanceof GivenUp) return null;
    throw err;
  } finally {
    await Promise.all(threads.map((t) => t.end().catch(() => null)));
    pool?.close();
  }
}

export async function renderSession(written: Project, source: RenderSource, opts: RenderOptions): Promise<Rendered> {
  const sr = opts.sampleRate;
  // the song as it's heard: its repeats and jumps played out (`from` and `to` are where they first play)
  const map = playMap(written);
  const project = performed(written);
  const segments = compileTempo(project, sr);
  const loop = opts.loop !== false && opts.from === undefined && opts.to === undefined ? project.loop : undefined;
  const from = loop ? loop.start : opts.from !== undefined ? playedAt(map, opts.from) : 0;
  const reached = opts.to !== undefined ? playedTimes(map, opts.to, true).filter((t) => t > from) : [];
  const to = loop
    ? loop.end
    : opts.to === undefined
      ? projectEnd(project)
      : reached.length
        ? Math.min(...reached)
        : from + Math.max(0, opts.to - (opts.from ?? 0));
  const start = Math.round(tickToFrame(segments, from));
  const stop = Math.round(tickToFrame(segments, to));
  const turn = stop - start;
  const errors: string[] = [];
  /** One engine, as a render has always had: it says what goes wrong in it. */
  const engine = () => {
    const made = new EngineCore(sr, (msg) => {
      if (msg.type === 'error') errors.push(msg.message);
    });
    made.receive({ type: 'init', ring: null, meters: null, transport: null });
    return made;
  };
  // split over threads (two at least: one costs more than it saves), the song is kept as its
  // messages until it's whole, then given to every engine at once; else it goes straight to the one
  const split = opts.split && opts.split.workers >= 2 ? opts.split : null;
  const song: ToWorklet[] = [];
  const core = split ? null : engine();
  const send = (msg: ToWorklet) => {
    if (core) core.receive(msg);
    else song.push(aheadShared(msg));
  };
  /** Split: each instrument's share of the work, guessed from what it plays (by channel number). */
  const parts = new Map<number, number>();
  const mics = new Map<string, number>();
  let graph: GraphSpec | null = null;
  const nums = new Map<string, number>();
  const numOf = (id: string) => {
    let n = nums.get(id);
    if (n === undefined) {
      n = nums.size + 1;
      nums.set(id, n);
    }
    return n;
  };

  send({ type: 'tempo', segments, ppq: 960, ...meterTicks(project) });
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
  // and the kits plugins play (a Drum Replacer's)
  for (const kit of songKits(project)) keys.add(kit);
  // of each, the zones the song can sound (an instrument whose keys can't be told is loaded whole)
  const played = opts.samples === 'all' ? null : playedKeys(project);
  let k = 0;
  for (const key of keys) {
    opts.onProgress?.(`Loading instruments (${++k}/${keys.size})`);
    const [pack = '', ...rest] = key.split('/');
    const spec = await buildSampler(source, pack, rest.join('/'), sr, played?.get(key) ?? null);
    mics.set(key, Math.max(1, spec.mics?.length ?? 1));
    send({ type: 'sampler', spec });
  }
  const clips = songClips(project);
  const recordings = new Map<string, Float32Array[]>();
  let c = 0;
  for (const clip of clips) {
    opts.onProgress?.(`Loading audio (${++c}/${clips.length})`);
    const channels = await loadClipAudio(source, clip, sr);
    recordings.set(clipKey(clip), channels);
    send({ type: 'audio', key: clipKey(clip), channels });
  }
  // note edits: each stretch they change, rendered from its recording (notes/plan.ts)
  const patches = songPatches(project, sr);
  let edited = 0;
  for (const job of patches) {
    opts.onProgress?.(`Rendering note edits (${++edited}/${patches.length})`);
    const base = recordings.get(clipKey(job.base));
    if (base) send({ type: 'audio', key: job.key, channels: renderNotePatch(base, sr, job.spec) });
  }
  const impulses = songImpulses(project, sr);
  let q = 0;
  for (const { key, source: from } of impulses) {
    opts.onProgress?.(`Preparing spaces (${++q}/${impulses.length})`);
    send({ type: 'impulse', key, data: prepareImpulse(await loadImpulse(source, from, sr)) });
  }
  graph = compileGraph(project, numOf, segments);
  send({ type: 'graph', graph });
  /** The song's length in frames, for the guesses. */
  const songFrames = Math.round(tickToFrame(segments, projectEnd(project)));
  // planned parts: planned whole, their samples loaded, handed over as voices to start
  let pp = 0;
  /** How far past the loop's start its voices sound (a voice can outlast a turn, and come around onto itself). */
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
      send({ type: 'performance', key: plans.key, samples });
    }
    if (split) parts.set(numOf(t.id), aheadPartGuess(plans, songFrames));
    send({ type: 'plans', num: numOf(t.id), plans });
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
    if (split && !notesPlanned) {
      const inst = instrumentSpec(t.instrument);
      const sounding = inst.kind === 'sampler' ? (mics.get(inst.key) ?? 1) : 1;
      parts.set(numOf(t.id), aheadTrackGuess(all, inst, songFrames, sr, sounding));
    }
    send({
      type: 'sequence',
      num: numOf(t.id),
      events: loop ? wrapNotes(kept, start, stop) : new Float64Array(kept),
    });
    if (t.kind === 'audio') send({ type: 'clips', num: numOf(t.id), clips: compileClips(t, segments, sr) });
  }
  // a loop plays turn after turn until everything that rings past its end has come around (its longest
  // voice, and the halls after it), and keeps the last
  const turns = loop ? Math.ceil((reach + LOOP_SETTLE * sr) / Math.max(1, turn)) : 1;
  const length = loop ? turn * turns : Math.max(1, stop - start + Math.round((opts.tail ?? 4) * sr));
  if (loop) send({ type: 'cycle', on: true, start, end: stop, wrap: true });
  send({ type: 'play', frame: start, record: false, countIn: 0 });

  // the mix's sound comes out behind the song by its plugins' look-ahead: render that much more, and
  // keep from where the song begins. Whole blocks only (the convolution works in them).
  const blockL = new Float32Array(BLOCK);
  const blockR = new Float32Array(BLOCK);
  const tenth = Math.max(BLOCK, Math.floor(length / 10));
  /**
   * Every block of the render out of an engine that has the whole song. `before` a block: split,
   * the wait for the threads' share of it.
   */
  const play = async (
    from: EngineCore,
    before?: (k: number) => Promise<void>,
    after?: (k: number) => void,
  ): Promise<Played> => {
    const late = from.measureLatency();
    const blocks = Math.ceil((length + late) / BLOCK);
    const left = new Float32Array(blocks * BLOCK);
    const right = new Float32Array(blocks * BLOCK);
    for (let at = 0, k = 0; at < blocks * BLOCK; at += BLOCK, k++) {
      if (before) await before(k);
      from.process(blockL, blockR, undefined, at);
      after?.(k);
      left.set(blockL, at);
      right.set(blockR, at);
      if (at % tenth < BLOCK && at > 0)
        opts.onProgress?.(`Rendering… ${Math.min(100, Math.round((at / length) * 100))}%`);
    }
    return { late, left, right };
  };
  let mixed = core ? await play(core) : null;
  if (!mixed && split && graph) {
    mixed = await playSplit(split, sr, song, graph, parts, play);
    if (!mixed) {
      // a thread failed, or nothing came of them: the same song from its first block on one engine
      const one = engine();
      for (const msg of song) one.receive(msg);
      mixed = await play(one);
    }
  }
  if (!mixed) throw new Error('Nothing was rendered');
  const { late, left, right } = mixed;
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
 * start, and stops there where it would have (its end comes around again).
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
