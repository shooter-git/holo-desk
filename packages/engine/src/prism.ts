/**
 * Prism: a morphing synthesizer of up to four sources. Each source is an oscillator bank (one
 * band-limited waveform read by up to 64 oscillators, each at its own pitch, level and place: a
 * single saw, a detuned stack or an organ of sine partials), partials (sine partials following a
 * sound's analysis over time, scrubbed or played along), a sample, or a cloud of grains. The four
 * sit at the corners of a pad and are heard by how near the morph point is to each. Each has its
 * own filter, then goes into one of two main filters (low- and high-pass, band-pass, notch, a diode
 * low-pass and a transistor ladder's two slopes). Eight LFOs, four envelopes, four drawn shapes,
 * four step sequencers and eight curves feed a matrix of 32 links, and six effects follow the
 * voices (delay, chorus, drive, band, compressor, reverb).
 *
 * A sound may carry a whole patch in its params (the format is in @holo/session's prism.ts), over
 * the preset it names. A pack instrument can play through Prism too: its zones are then the
 * sources' samples and partial sets, and its params its patch. The six knobs (m1…m6) are sources in
 * the matrix: each preset wires its own.
 *
 * Everything that moves is worked out every CTRL samples (the modulators, the matrix, each source's
 * pitch and level, the filters) and glides between, so the per-sample work is only the oscillators,
 * the filters and the effects.
 */
import {
  PER_FX,
  PER_SOURCE,
  PRISM_CONTROLS,
  PRISM_CURVES,
  PRISM_CUSTOM_WAVES,
  PRISM_ENVS,
  PRISM_FX,
  PRISM_FX_PARAMS,
  PRISM_LFOS,
  PRISM_LINKS,
  PRISM_MACRO_IDS,
  PRISM_MOD_SOURCES,
  PRISM_MOD_TARGETS,
  PRISM_POINTS,
  PRISM_SEQS,
  PRISM_SHAPES,
  PRISM_SOURCES,
  PRISM_STEPS,
  type PrismKey,
  prismKey,
  SRC_ENV,
  SRC_LFO,
  SRC_SEQ,
  SRC_SHAPE,
  TGT_ENV_TIME,
  TGT_F1_CUTOFF,
  TGT_F1_DRIVE,
  TGT_F1_RES,
  TGT_F2_CUTOFF,
  TGT_F2_DRIVE,
  TGT_F2_RES,
  TGT_FX,
  TGT_LEVEL,
  TGT_LFO_RATE,
  TGT_PAN,
  TGT_PITCH,
  TGT_X,
  TGT_Y,
} from '@holo/session';
import { type Controls, Instrument, type Voice } from './instrument.ts';
import { type Effect, type FxSettings, makeEffect, PrismFilter, soft } from './prism-fx.ts';
import {
  applyTarget,
  CTRL,
  type EnvPatch,
  fillModulators,
  fillPlayed,
  type LfoPatch,
  type Link,
  ModState,
  type Performance,
  type PointList,
  pointList,
  type SeqPatch,
  type ShapePatch,
} from './prism-mod.ts';
import { PRISM_PRESET_KEYS } from './prism-presets.ts';
import {
  ampSpread,
  builtInPartials,
  builtInRecording,
  builtInWave,
  customWave,
  GrainCloud,
  loopSpan,
  type Mips,
  OscBank,
  PartialPlayer,
  type PartialSet,
  panLeft,
  panRight,
  panSpread,
  pitchSpread,
  type Recording,
  SamplePlayer,
  type Spreads,
  spreads,
  zoneRecording,
} from './prism-sources.ts';
import type { SamplerSpec, SampleZone } from './protocol.ts';

// ---- the patch ---------------------------------------------------------------------------------------

export interface PrismSourcePatch {
  on: number;
  kind: number;
  level: number;
  pan: number;
  coarse: number;
  fine: number;
  keytrack: number;
  route: number;
  stereo: number;
  ftype: number;
  cutoff: number;
  res: number;
  wave: number;
  custom: number;
  count: number;
  ampa: number;
  ampb: number;
  amp: number;
  pitcha: number;
  pitchb: number;
  pitch: number;
  pana: number;
  panb: number;
  panmix: number;
  width: number;
  detune: number;
  sym: number;
  phase: number;
  free: number;
  data: number;
  pos: number;
  speed: number;
  loop: number;
  start: number;
  end: number;
  partials: number;
  size: number;
  density: number;
  jitter: number;
  spray: number;
}

export interface PrismFilterPatch {
  on: number;
  type: number;
  cutoff: number;
  res: number;
  drive: number;
}

export interface PrismLinkPatch {
  src: number;
  dst: number;
  depth: number;
  curve: number;
  via: number;
  viadepth: number;
  viacurve: number;
}

/** A whole patch, as the keys set it. */
export interface PrismPatch {
  src: PrismSourcePatch[];
  xy: { on: number; x: number; y: number; power: number };
  flt: PrismFilterPatch[];
  serial: number;
  amp: { level: number; pan: number; volume: number };
  voice: {
    poly: number;
    mono: number;
    legato: number;
    glide: number;
    glidemode: number;
    bend: number;
    transpose: number;
    tune: number;
  };
  lfo: LfoPatch[];
  env: EnvPatch[];
  shape: ShapePatch[];
  seq: SeqPatch[];
  curve: PointList[];
  ctl: number[];
  mod: PrismLinkPatch[];
  fx: FxSettings[];
  /** Points of the waveforms and LFO shapes a sound brings (by index; holes are absent). */
  waves: Map<number, number>[];
  lshapes: Map<number, number>[];
}

function blankSource(on: boolean): PrismSourcePatch {
  return {
    on: on ? 1 : 0,
    kind: 0,
    level: 1,
    pan: 0,
    coarse: 0,
    fine: 0,
    keytrack: 1,
    route: 0,
    stereo: 0,
    ftype: 0,
    cutoff: 20000,
    res: 0,
    wave: 2,
    custom: 0,
    count: 1,
    ampa: 0,
    ampb: 0,
    amp: 0,
    pitcha: 2,
    pitchb: 2,
    pitch: 0,
    pana: 0,
    panb: 0,
    panmix: 0,
    width: 1,
    detune: 10,
    sym: 0.5,
    phase: 0,
    free: 0,
    data: 1,
    pos: 0,
    speed: 1,
    loop: 0,
    start: 0,
    end: 0,
    partials: 32,
    size: 0.08,
    density: 4,
    jitter: 0.2,
    spray: 0,
  };
}

function blankShape(): ShapePatch {
  const p = pointList(PRISM_POINTS) as ShapePatch;
  p.n = 2;
  p.x[0] = 0;
  p.y[0] = 0;
  p.x[1] = 1;
  p.y[1] = 1;
  p.loop = 0;
  p.ls = 0;
  p.le = 1;
  p.sync = 0;
  return p;
}

function blankCurve(): PointList {
  const p = pointList(PRISM_POINTS);
  p.n = 2;
  p.x[1] = 1;
  p.y[1] = 1;
  return p;
}

function blankPatch(): PrismPatch {
  return {
    src: Array.from({ length: PRISM_SOURCES }, (_, i) => blankSource(i === 0)),
    xy: { on: 0, x: 0.5, y: 0.5, power: 1 },
    flt: [0, 1].map(() => ({ on: 0, type: 0, cutoff: 20000, res: 0, drive: 0 })),
    serial: 0,
    amp: { level: 0.25, pan: 0, volume: 0 },
    voice: { poly: 8, mono: 0, legato: 0, glide: 0, glidemode: 0, bend: 2, transpose: 0, tune: 0 },
    lfo: Array.from({ length: PRISM_LFOS }, () => ({
      shape: 0,
      custom: 0,
      rate: 1,
      sync: 0,
      beats: 1,
      bipolar: 1,
      delay: 0,
      fade: 0,
      phase: 0,
      mode: 0,
    })),
    env: Array.from({ length: PRISM_ENVS }, (_, i) =>
      i === 0
        ? { a: 0.005, h: 0, d: 0, s: 1, r: 0.3, ac: 0, dc: 0, rc: 0 }
        : { a: 0.005, h: 0, d: 0.5, s: 0, r: 0.3, ac: 0, dc: 0, rc: 0 },
    ),
    shape: Array.from({ length: PRISM_SHAPES }, blankShape),
    seq: Array.from({ length: PRISM_SEQS }, () => ({
      steps: 8,
      beats: 0.25,
      swing: 0,
      attack: 0,
      gate: 1,
      release: 0,
      v: new Float64Array(PRISM_STEPS).fill(1),
      t: new Float64Array(PRISM_STEPS),
    })),
    curve: Array.from({ length: PRISM_CURVES }, blankCurve),
    ctl: new Array(PRISM_CONTROLS).fill(0),
    mod: Array.from({ length: PRISM_LINKS }, (_, i) => ({
      src: i === 0 ? 1 : 0,
      dst: i === 0 ? TGT_LEVEL : 0,
      depth: i === 0 ? 0.5 : 0,
      curve: 0,
      via: 0,
      viadepth: 0,
      viacurve: 0,
    })),
    fx: Array.from({ length: PRISM_FX }, () => ({ type: 0, mix: 0.3 })),
    waves: Array.from({ length: PRISM_CUSTOM_WAVES }, () => new Map()),
    lshapes: Array.from({ length: PRISM_CUSTOM_WAVES }, () => new Map()),
  };
}

/** Fields that are whole numbers (a choice, a count of points), and fields that are on or off. */
const WHOLE = new Set([
  'kind',
  'ftype',
  'wave',
  'custom',
  'ampa',
  'ampb',
  'pitcha',
  'pitchb',
  'pana',
  'panb',
  'data',
  'loop',
  'type',
  'shape',
  'mode',
  'n',
  'ls',
  'le',
  'steps',
  'src',
  'dst',
  'curve',
  'via',
  'viacurve',
  'poly',
]);
const SWITCH = new Set([
  'on',
  'keytrack',
  'stereo',
  'free',
  'sync',
  'bipolar',
  'mono',
  'legato',
  'glidemode',
  'power',
  'blank',
]);

function applyKey(p: PrismPatch, k: PrismKey, raw: number): void {
  let v = Math.min(k.max, Math.max(k.min, raw));
  if (WHOLE.has(k.field)) v = Math.round(v);
  else if (SWITCH.has(k.field) || (k.part === 'seq' && k.field === 't')) v = v >= 0.5 ? 1 : 0;
  const set = (o: object, f: string) => {
    (o as Record<string, number>)[f] = v;
  };
  switch (k.part) {
    case 'src':
      set(p.src[k.index] as PrismSourcePatch, k.field);
      break;
    case 'flt':
      if (k.index < 0) p.serial = v;
      else set(p.flt[k.index] as PrismFilterPatch, k.field);
      break;
    case 'xy':
      set(p.xy, k.field);
      break;
    case 'amp':
      set(p.amp, k.field);
      break;
    case 'voice':
      set(p.voice, k.field);
      break;
    case 'lfo':
      set(p.lfo[k.index] as LfoPatch, k.field);
      break;
    case 'env':
      set(p.env[k.index] as EnvPatch, k.field);
      break;
    case 'shape':
    case 'curve': {
      const s = (k.part === 'shape' ? p.shape : p.curve)[k.index] as ShapePatch;
      if (k.sub < 0) set(s, k.field);
      else (s[k.field as 'x' | 'y' | 'c'] as Float64Array)[k.sub] = v;
      break;
    }
    case 'seq': {
      const s = p.seq[k.index] as SeqPatch;
      if (k.sub < 0) set(s, k.field);
      else (k.field === 'v' ? s.v : s.t)[k.sub] = v;
      break;
    }
    case 'ctl':
      p.ctl[k.index] = v;
      break;
    case 'mod':
      set(p.mod[k.index] as PrismLinkPatch, k.field);
      break;
    case 'fx':
      (p.fx[k.index] as FxSettings)[k.field] = v;
      break;
    case 'wave':
      (p.waves[k.index] as Map<number, number>).set(k.sub, v);
      break;
    case 'lshape':
      (p.lshapes[k.index] as Map<number, number>).set(k.sub, v);
      break;
  }
}

/** The points given, in order from 0 (null when fewer than four). */
function pointsOf(m: Map<number, number>): number[] | null {
  const out: number[] = [];
  for (let i = 0; m.has(i); i++) out.push(m.get(i) as number);
  return out.length >= 4 ? out : null;
}

const DEFAULT = 'Pulse Bells';

/** A preset's patch with a sound's keys over it (a whole patch starts blank instead). */
export function prismPatch(preset: string, params?: Record<string, number>): PrismPatch {
  const p = blankPatch();
  const blank = (params?.['patch:blank'] ?? 0) >= 0.5;
  const base = blank ? undefined : (PRISM_PRESET_KEYS[preset] ?? PRISM_PRESET_KEYS[DEFAULT]);
  for (const keys of [base, params]) {
    if (!keys) continue;
    for (const [id, v] of Object.entries(keys)) {
      if (typeof v !== 'number' || !Number.isFinite(v)) continue;
      const k = prismKey(id);
      if (k) applyKey(p, k, v);
    }
  }
  return p;
}

// ---- worked out for playing ------------------------------------------------------------------------------

/** A patch worked out for playing: what never changes while it plays, found once. */
interface Prism {
  patch: PrismPatch;
  macros: Float64Array;
  /** Links that move a voice, and those that move the effects (shared by every voice). */
  links: Link[];
  shared: Link[];
  used: Int32Array;
  usedShared: Int32Array;
  /** Which LFOs run shared (free or kept to the song) rather than per note. */
  lfoShared: Uint8Array;
  /** Which modulators anything listens to (the others aren't worked out). */
  lfoUsed: Uint8Array;
  envUsed: Uint8Array;
  shapeUsed: Uint8Array;
  seqUsed: Uint8Array;
  sharedUsed: boolean;
  waves: (Mips | null)[];
  lshapes: (Float32Array | null)[];
  /** Each source's waveform tables (oscillator kind). */
  srcMips: Mips[];
  /** Which sources' position the matrix moves (they scrub rather than play along). */
  posLinked: Uint8Array;
  /** Which sources' symmetry the matrix moves (their oscillators read tables, even sines). */
  symLinked: Uint8Array;
  /** The level after the effects (linear). */
  volume: number;
}

function derive(patch: PrismPatch, params: Record<string, number> | undefined, cache: Map<string, Mips>): Prism {
  const macros = new Float64Array(6);
  PRISM_MACRO_IDS.forEach((id, i) => {
    const v = params?.[id];
    macros[i] = typeof v === 'number' && Number.isFinite(v) ? Math.min(1, Math.max(0, v)) : 0.5;
  });
  const links: Link[] = [];
  const shared: Link[] = [];
  const lfoUsed = new Uint8Array(PRISM_LFOS);
  const envUsed = new Uint8Array(PRISM_ENVS);
  const shapeUsed = new Uint8Array(PRISM_SHAPES);
  const seqUsed = new Uint8Array(PRISM_SEQS);
  envUsed[0] = 1;
  const mark = (s: number) => {
    if (s >= SRC_LFO && s < SRC_LFO + PRISM_LFOS) lfoUsed[s - SRC_LFO] = 1;
    else if (s >= SRC_ENV && s < SRC_ENV + PRISM_ENVS) envUsed[s - SRC_ENV] = 1;
    else if (s >= SRC_SHAPE && s < SRC_SHAPE + PRISM_SHAPES) shapeUsed[s - SRC_SHAPE] = 1;
    else if (s >= SRC_SEQ && s < SRC_SEQ + PRISM_SEQS) seqUsed[s - SRC_SEQ] = 1;
  };
  for (const m of patch.mod) {
    if (m.src <= 0 || m.src >= PRISM_MOD_SOURCES.length || m.dst < 0 || m.dst >= PRISM_MOD_TARGETS.length) continue;
    if (m.depth === 0 && (m.via <= 0 || m.viadepth === 0)) continue;
    mark(m.src);
    if (m.via > 0) mark(m.via);
    const link: Link = {
      src: m.src,
      dst: m.dst,
      depth: m.depth,
      curve: m.curve - 1,
      via: m.via > 0 && m.via < PRISM_MOD_SOURCES.length ? m.via : 0,
      viaDepth: m.viadepth,
      viaCurve: m.viacurve - 1,
    };
    (m.dst >= TGT_FX ? shared : links).push(link);
  }
  const lfoShared = new Uint8Array(PRISM_LFOS);
  for (let i = 0; i < PRISM_LFOS; i++) lfoShared[i] = (patch.lfo[i] as LfoPatch).mode >= 1 ? 1 : 0;
  const waves = patch.waves.map((m) => {
    const pts = pointsOf(m);
    if (!pts) return null;
    const key = pts.join(',');
    let mips = cache.get(key);
    if (!mips) {
      mips = customWave(pts);
      cache.set(key, mips);
    }
    return mips;
  });
  const lshapes = patch.lshapes.map((m) => {
    const pts = pointsOf(m);
    return pts ? Float32Array.from(pts) : null;
  });
  const srcMips = patch.src.map((s) => (s.custom > 0 ? waves[s.custom - 1] : null) ?? builtInWave(s.wave));
  const distinct = (list: Link[]) => Int32Array.from(new Set(list.map((l) => l.dst)));
  const posLinked = new Uint8Array(PRISM_SOURCES);
  const symLinked = new Uint8Array(PRISM_SOURCES);
  for (const l of links) {
    if (l.dst >= PRISM_SOURCES * PER_SOURCE) continue;
    if (l.dst % PER_SOURCE === 3) posLinked[Math.floor(l.dst / PER_SOURCE)] = 1;
    if (l.dst % PER_SOURCE === 9) symLinked[Math.floor(l.dst / PER_SOURCE)] = 1;
  }
  return {
    patch,
    macros,
    links,
    shared,
    used: distinct(links),
    usedShared: distinct(shared),
    lfoShared,
    lfoUsed,
    envUsed,
    shapeUsed,
    seqUsed,
    sharedUsed: shared.length > 0 || lfoShared.some((x, i) => x && lfoUsed[i]),
    waves,
    lshapes,
    srcMips,
    posLinked,
    symLinked,
    volume: 10 ** (patch.amp.volume / 20),
  };
}

// ---- the voice -------------------------------------------------------------------------------------------

const hz = (note: number) => 440 * 2 ** ((note - 69) / 12);

/** What every voice of one instrument shares at a moment: the tempo, the song's beat, the knobs. */
interface Shared {
  sr: number;
  beatSeconds: number;
  /** The shared modulation: free LFOs and what the effects listen to. */
  mods: ModState;
  perf: Performance;
  media: SamplerSpec | null;
}

/** The pack's zone for a source at a key and velocity (zones without a source are source 1's). */
function zoneFor(media: SamplerSpec | null, source: number, key: number, velocity: number, partials: boolean) {
  if (!media) return null;
  let best: SampleZone | null = null;
  for (const z of media.zones) {
    if ((z.source ?? 1) !== source + 1) continue;
    if (partials ? !z.partials : z.partials || z.left.length < 2) continue;
    if (key < z.lo || key > z.hi || velocity < z.lovel || velocity > z.hivel) continue;
    best = z;
    break;
  }
  return best;
}

class PrismVoice implements Voice {
  key: number;
  sustained = false;
  released = false;
  done = false;
  age = 0;
  private readonly p: Prism;
  private readonly sh: Shared;
  private readonly m: ModState;
  private velocity: number;
  private readonly random: number;
  private gate = 1;
  /** Where in its control block it is (a new step when 0). */
  private at = 0;
  private note: number;
  private glideFrom: number;
  private glideTo: number;
  private glideT = 1;
  private glideTime = 0;
  private readonly oscs: (OscBank | null)[] = [];
  private readonly parts: (PartialPlayer | null)[] = [];
  private readonly samples: (SamplePlayer | null)[] = [];
  private readonly grains: (GrainCloud | null)[] = [];
  /** Partials' and grains' position along their data (seconds), and their direction. */
  private readonly time = new Float64Array(PRISM_SOURCES);
  private readonly dir = new Float64Array(PRISM_SOURCES).fill(1);
  private readonly sfilters: PrismFilter[] = [];
  private readonly f1 = new PrismFilter();
  private readonly f2 = new PrismFilter();
  private readonly sp: Spreads[] = [];
  /** What each source's spreads were worked out from (they're kept until one of these moves). */
  private readonly spreadKey = new Float64Array(PRISM_SOURCES * 5).fill(Number.NaN);
  private readonly sl = new Float32Array(CTRL);
  private readonly sr2 = new Float32Array(CTRL);
  private readonly al = new Float32Array(CTRL);
  private readonly ar = new Float32Array(CTRL);
  private readonly bl = new Float32Array(CTRL);
  private readonly br = new Float32Array(CTRL);
  // each source's gains into the filters (now, and their steps over the block)
  private readonly g = new Float64Array(PRISM_SOURCES * 4);
  private readonly dg = new Float64Array(PRISM_SOURCES * 4);
  private ampL = 0;
  private ampR = 0;
  private dampL = 0;
  private dampR = 0;
  private stereo = false;
  /** Whether anything goes into filter 2 (a source routed there, or filter 1 on into it). */
  private readonly useF2: boolean;
  private fade = 1;
  private killing = false;
  /** Seconds since the note started. */
  private t = 0;

  constructor(p: Prism, sh: Shared, key: number, velocity: number, seed: number, from: number) {
    this.p = p;
    this.sh = sh;
    this.key = key;
    this.velocity = velocity;
    this.m = new ModState(seed);
    this.random = 0.5 + 0.5 * this.m.rand.next();
    this.note = from;
    this.glideFrom = from;
    this.glideTo = key;
    for (let s = 0; s < PRISM_SOURCES; s++) {
      this.oscs.push(null);
      this.parts.push(null);
      this.samples.push(null);
      this.grains.push(null);
      this.sfilters.push(new PrismFilter());
      this.sp.push(spreads(128));
    }
    const P = p.patch;
    this.useF2 = P.src.some((sp) => sp.on && sp.route > 0) || ((P.flt[1] as PrismFilterPatch).on > 0 && P.serial > 0);
    this.setGlide(from, key);
    this.begin(false);
  }

  /**
   * The sources ready and the modulators started: a new note, or (`again`) a mono note played
   * again, whose envelopes rise from where they are and whose oscillators run on.
   */
  private begin(again: boolean): void {
    const P = this.p.patch;
    const m = this.m;
    const rand = () => m.rand.next();
    for (let s = 0; s < PRISM_SOURCES; s++) {
      const sp = P.src[s] as PrismSourcePatch;
      if (!sp.on) continue;
      if (again) {
        if (sp.kind >= 1) this.restartSource(s, sp);
        continue;
      }
      this.time[s] = 0;
      this.dir[s] = 1;
      switch (sp.kind) {
        case 0: {
          const o = this.oscs[s] ?? new OscBank();
          // plain sines as drawn all along: the cheaper recursion plays them
          const sine = sp.wave === 0 && sp.custom === 0 && Math.abs(sp.sym - 0.5) < 1e-4 && !this.p.symLinked[s];
          o.start(sp.phase, sp.free >= 0.5, rand, sine);
          this.oscs[s] = o;
          break;
        }
        case 1: {
          const z = sp.data === 0 ? zoneFor(this.sh.media, s, this.key, this.velocity, true) : null;
          const set: PartialSet | null = sp.data === 0 ? (z?.partials ?? null) : builtInPartials(sp.data - 1);
          const pp = this.parts[s] ?? new PartialPlayer();
          pp.start(set);
          this.parts[s] = pp;
          this.time[s] = set ? sp.pos * set.length : 0;
          break;
        }
        default: {
          const z = sp.data === 0 ? zoneFor(this.sh.media, s, this.key, this.velocity, false) : null;
          const rec: Recording | null = z
            ? zoneRecording(z, this.sh.sr)
            : sp.data > 0
              ? builtInRecording(sp.data - 1)
              : null;
          const span = rec ? loopSpan(rec, sp.start, sp.end, sp.loop) : { start: 0, end: 0, mode: 0 };
          if (sp.kind === 2) {
            const sm = this.samples[s] ?? new SamplePlayer();
            sm.start(rec, sp.pos, span);
            this.samples[s] = sm;
          } else {
            const gc = this.grains[s] ?? new GrainCloud();
            gc.start(rec, sp.pos, span);
            this.grains[s] = gc;
          }
          break;
        }
      }
    }
    for (let i = 0; i < PRISM_ENVS; i++) if (this.p.envUsed[i]) m.envs[i]?.trigger(again);
    for (let i = 0; i < PRISM_LFOS; i++)
      if (this.p.lfoUsed[i] && !this.p.lfoShared[i]) m.lfos[i]?.trigger(P.lfo[i] as LfoPatch, m.rand);
    for (let i = 0; i < PRISM_SHAPES; i++) if (this.p.shapeUsed[i]) m.shapes[i]?.trigger(P.shape[i] as ShapePatch);
    for (let i = 0; i < PRISM_SEQS; i++) if (this.p.seqUsed[i]) m.seqs[i]?.trigger(P.seq[i] as SeqPatch);
    if (!again) {
      for (const f of this.sfilters) f.reset();
      this.f1.reset();
      this.f2.reset();
      this.t = 0;
    }
  }

  private setGlide(from: number, to: number): void {
    const v = this.p.patch.voice;
    this.glideFrom = from;
    this.glideTo = to;
    this.glideTime = v.glide > 0 && from !== to ? (v.glidemode ? (v.glide * Math.abs(to - from)) / 12 : v.glide) : 0;
    this.glideT = this.glideTime > 0 ? 0 : 1;
    if (this.glideT >= 1) this.note = to;
  }

  /** Mono: on to another key; legato carries on, otherwise it starts again from where it is. */
  moveTo(key: number, velocity: number, legato: boolean, glide: boolean): void {
    this.setGlide(glide ? this.note : key, key);
    this.key = key;
    if (!legato) {
      this.velocity = velocity;
      this.released = false;
      this.sustained = false;
      this.gate = 1;
      this.endAfterBlock = false;
      this.begin(true);
    }
  }

  private restartSource(s: number, sp: PrismSourcePatch): void {
    this.time[s] = 0;
    this.dir[s] = 1;
    if (sp.kind === 1) {
      const set = this.parts[s]?.set;
      if (set) this.time[s] = sp.pos * set.length;
    } else if (sp.kind === 2) {
      const sm = this.samples[s];
      if (sm) sm.start(sm.rec, sp.pos, sm.span);
    } else {
      const gc = this.grains[s];
      if (gc) gc.start(gc.rec, sp.pos, gc.span);
    }
  }

  release(): void {
    if (this.released) return;
    this.released = true;
    this.gate = 0;
    for (const e of this.m.envs) e.release();
    for (const s of this.m.shapes) s.release();
    for (const s of this.samples) s?.release();
    for (const g of this.grains) g?.release();
  }

  kill(): void {
    this.killing = true;
  }

  /** One control step: the modulators and the matrix, then where every source is headed. */
  private control(ctl: Controls): void {
    const p = this.p;
    const P = p.patch;
    const sh = this.sh;
    const m = this.m;
    const sr = sh.sr;
    const dt = CTRL / sr;
    this.t += dt;
    // the knobs and the wheel are shared; this note's own sources
    fillPlayed(m, this.key, this.velocity, this.random, this.gate, sh.perf);
    // the modulators, each in turn (an LFO's rate may be moved by what came before)
    const add = m.add;
    for (let i = 0; i < PRISM_ENVS; i++) {
      if (!p.envUsed[i]) continue;
      const T = TGT_ENV_TIME + i * 3;
      const ka = add[T] ? 2 ** applyTarget(T, 0, add[T] as number, 1) : 1;
      const kd = add[T + 1] ? 2 ** applyTarget(T + 1, 0, add[T + 1] as number, 1) : 1;
      const kr = add[T + 2] ? 2 ** applyTarget(T + 2, 0, add[T + 2] as number, 1) : 1;
      m.envs[i]?.step(P.env[i] as EnvPatch, dt, ka, kd, kr);
    }
    for (let i = 0; i < PRISM_SHAPES; i++)
      if (p.shapeUsed[i]) {
        const s = P.shape[i] as ShapePatch;
        m.shapes[i]?.step(s, dt, s.sync ? 1 / sh.beatSeconds : 1);
      }
    for (let i = 0; i < PRISM_SEQS; i++)
      if (p.seqUsed[i]) {
        const s = P.seq[i] as SeqPatch;
        m.seqs[i]?.step(s, dt, 1 / Math.max(1e-3, s.beats * sh.beatSeconds));
      }
    for (let i = 0; i < PRISM_LFOS; i++) {
      if (!p.lfoUsed[i] || p.lfoShared[i]) continue;
      const l = P.lfo[i] as LfoPatch;
      const rate = l.sync ? 1 / Math.max(1e-3, l.beats * sh.beatSeconds) : l.rate;
      const oct = applyTarget(TGT_LFO_RATE + i, 0, m.add[TGT_LFO_RATE + i] as number, 1);
      m.lfos[i]?.step(l, rate * 2 ** oct, dt, m.rand, l.custom ? (p.lshapes[l.custom - 1] ?? null) : null, Number.NaN);
    }
    fillModulators(m, sh.mods, p.lfoShared);
    for (let i = 0; i < PRISM_LFOS; i++) m.bipolar[SRC_LFO + i] = (P.lfo[i] as LfoPatch).bipolar;
    m.apply(p.links, p.used, P.curve);
    const mul = m.mul;
    // the note: gliding, transposed, bent, and moved
    if (this.glideT < 1) {
      this.glideT = Math.min(1, this.glideT + dt / this.glideTime);
      this.note = this.glideFrom + (this.glideTo - this.glideFrom) * this.glideT;
    }
    const v = P.voice;
    const pitch = applyTarget(TGT_PITCH, 0, add[TGT_PITCH] as number, 1);
    const note = this.note + v.transpose + v.tune / 100 + ctl.bend + pitch;
    // the morph pad's weights
    let w0 = 1;
    let w1 = 1;
    let w2 = 1;
    let w3 = 1;
    if (P.xy.on) {
      const x = applyTarget(TGT_X, P.xy.x, add[TGT_X] as number, 1);
      const y = applyTarget(TGT_Y, P.xy.y, add[TGT_Y] as number, 1);
      w0 = (1 - x) * (1 - y);
      w1 = x * (1 - y);
      w2 = (1 - x) * y;
      w3 = x * y;
      if (P.xy.power) {
        w0 = Math.sqrt(w0);
        w1 = Math.sqrt(w1);
        w2 = Math.sqrt(w2);
        w3 = Math.sqrt(w3);
      }
    }
    let stereo = false;
    for (let s = 0; s < PRISM_SOURCES; s++) {
      const sp = P.src[s] as PrismSourcePatch;
      if (!sp.on) continue;
      const T = s * PER_SOURCE;
      const weight = s === 0 ? w0 : s === 1 ? w1 : s === 2 ? w2 : w3;
      const level = applyTarget(T, sp.level, 0, mul[T] as number) * weight;
      const pan = applyTarget(T + 1, sp.pan, add[T + 1] as number, 1);
      const srcNote =
        (sp.keytrack ? note : 60 + v.transpose + v.tune / 100) +
        sp.coarse +
        sp.fine / 100 +
        applyTarget(T + 2, 0, add[T + 2] as number, 1);
      const f0 = hz(srcNote);
      const st = sp.stereo >= 0.5;
      if (st || Math.abs(pan) > 1e-6) stereo = true;
      // its spreads, where its kind has them
      if (sp.kind <= 1) {
        const ampM = applyTarget(T + 6, sp.amp, add[T + 6] as number, 1);
        const pitchM = applyTarget(T + 7, sp.pitch, add[T + 7] as number, 1);
        const panM = applyTarget(T + 8, sp.panmix, add[T + 8] as number, 1);
        const detune = applyTarget(T + 10, sp.detune, add[T + 10] as number, 1);
        const count =
          sp.kind === 0
            ? Math.min(64, applyTarget(T + 5, sp.count, add[T + 5] as number, 1))
            : applyTarget(T + 5, sp.partials, add[T + 5] as number, 1);
        const n = Math.ceil(count);
        const sprd = this.sp[s] as Spreads;
        // (worked out again only when something they depend on moved)
        const c = this.spreadKey;
        const C = s * 5;
        const same = c[C] === ampM && c[C + 1] === pitchM && c[C + 2] === panM && c[C + 3] === detune && c[C + 4] === n;
        c[C] = ampM;
        c[C + 1] = pitchM;
        c[C + 2] = panM;
        c[C + 3] = detune;
        c[C + 4] = n;
        if (!same)
          for (let k = 0; k < n; k++) {
            sprd.amp[k] = ampSpread(sp.ampa, k) * (1 - ampM) + ampSpread(sp.ampb, k) * ampM;
            if (sp.kind === 0)
              sprd.ratio[k] =
                pitchSpread(sp.pitcha, k, detune) * (1 - pitchM) + pitchSpread(sp.pitchb, k, detune) * pitchM;
            sprd.pan[k] = panSpread(sp.pana, k, n, sp.width) * (1 - panM) + panSpread(sp.panb, k, n, sp.width) * panM;
          }
        if (sp.kind === 0) {
          const sym = applyTarget(T + 9, sp.sym, add[T + 9] as number, 1);
          this.oscs[s]?.control(p.srcMips[s] as Mips, f0, count, sprd, 1, st, sym, sr);
        } else {
          const pp = this.parts[s];
          const set = pp?.set;
          if (pp && set) {
            this.time[s] = this.advance(s, sp, set.length, set.loopStart, set.loopEnd, dt, T);
            pp.control(f0, this.time[s] as number, count, sprd, 1, st, sr);
          }
        }
      } else if (sp.kind === 2) {
        this.samples[s]?.control(f0, 1, 0, st, sr);
      } else {
        const gc = this.grains[s];
        if (gc) {
          const size = applyTarget(T + 11, sp.size, add[T + 11] as number, 1);
          const dens = applyTarget(T + 12, sp.density, add[T + 12] as number, 1);
          const jit = applyTarget(T + 13, sp.jitter, add[T + 13] as number, 1);
          const speed = applyTarget(T + 4, sp.speed, add[T + 4] as number, 1);
          gc.control(f0, 1, 0, st, size, dens, speed, jit, sp.spray, sr);
        }
      }
      // its filter
      if (sp.ftype > 0) {
        const cut = applyTarget(T + 14, sp.cutoff, add[T + 14] as number, 1);
        const res = applyTarget(T + 15, sp.res, add[T + 15] as number, 1);
        this.sfilters[s]?.set(sp.ftype - 1, cut, res, 0, sr);
      }
      // its gains into the two filters (a stereo source keeps its two sides, panned as a pair)
      const into2 = sp.route;
      const gl = level * (st ? Math.min(1, 1 - pan) : panLeft(pan) * Math.SQRT2);
      const gr = level * (st ? Math.min(1, 1 + pan) : panRight(pan) * Math.SQRT2);
      const G = s * 4;
      const g = this.g;
      const dg = this.dg;
      dg[G] = (gl * (1 - into2) - (g[G] as number)) / CTRL;
      dg[G + 1] = (gr * (1 - into2) - (g[G + 1] as number)) / CTRL;
      dg[G + 2] = (gl * into2 - (g[G + 2] as number)) / CTRL;
      dg[G + 3] = (gr * into2 - (g[G + 3] as number)) / CTRL;
    }
    this.stereo = stereo;
    // the main filters
    for (let f = 0; f < 2; f++) {
      const fp = P.flt[f] as PrismFilterPatch;
      if (!fp.on) continue;
      const base = f === 0 ? TGT_F1_CUTOFF : TGT_F2_CUTOFF;
      const cut = applyTarget(base, fp.cutoff, add[base] as number, 1);
      const resT = f === 0 ? TGT_F1_RES : TGT_F2_RES;
      const drvT = f === 0 ? TGT_F1_DRIVE : TGT_F2_DRIVE;
      const res = applyTarget(resT, fp.res, add[resT] as number, 1);
      const drv = applyTarget(drvT, fp.drive, add[drvT] as number, 1);
      (f === 0 ? this.f1 : this.f2).set(fp.type, cut, res, drv, sr);
    }
    // the amplitude: env 1, the level and what moves it, the place, the expression; a stolen note fades fast
    const env = m.envs[0] as (typeof m.envs)[number];
    if (this.killing) this.fade = Math.max(0, this.fade - dt / 0.006);
    const a = applyTarget(TGT_LEVEL, P.amp.level, 0, mul[TGT_LEVEL] as number) * env.value * ctl.expression * this.fade;
    const pan = applyTarget(TGT_PAN, P.amp.pan, add[TGT_PAN] as number, 1);
    this.dampL = (a * panLeft(pan) * Math.SQRT2 - this.ampL) / CTRL;
    this.dampR = (a * panRight(pan) * Math.SQRT2 - this.ampR) / CTRL;
    if ((env.done || this.fade <= 0) && this.ampL === 0 && this.ampR === 0) this.done = true;
    else if ((env.done || this.fade <= 0) && a === 0) {
      // fading its last block to nothing, then done
      this.endAfterBlock = true;
    }
  }
  private endAfterBlock = false;

  /** Where a partials source is along its data after one step (seconds). */
  private advance(s: number, sp: PrismSourcePatch, len: number, ls: number, le: number, dt: number, T: number): number {
    const m = this.m;
    const posMod = m.add[T + 3] as number;
    const speed = applyTarget(T + 4, sp.speed, m.add[T + 4] as number, 1);
    let t = this.time[s] as number;
    // moved by modulation, the position follows it (scrubbing); otherwise it plays along at its speed
    if (this.p.posLinked[s] || speed === 0) return applyTarget(T + 3, sp.pos, posMod, 1) * len;
    t += speed * dt * (this.dir[s] as number);
    let a = 0;
    let b = len;
    if (!(sp.start === 0 && sp.end === 0)) {
      a = Math.min(sp.start, sp.end) * len;
      b = Math.max(sp.start, sp.end) * len;
    } else if (le > ls) {
      a = ls;
      b = le;
    }
    const looping = sp.loop === 1 || sp.loop === 3 || sp.loop === 4 || (sp.loop === 2 && !this.released);
    if (sp.loop === 4) {
      a = 0;
      b = len;
    }
    if (looping && b - a > 1e-3) {
      if (sp.loop === 3) {
        if (t > b) {
          t = b - (t - b);
          this.dir[s] = -1;
        } else if (t < a && (this.dir[s] as number) < 0) {
          t = a + (a - t);
          this.dir[s] = 1;
        }
      } else if (t >= b) t = a + ((t - a) % (b - a));
    }
    return Math.min(len, Math.max(0, t));
  }

  render(l: Float32Array, r: Float32Array, start: number, end: number, ctl: Controls): void {
    let i = start;
    while (i < end && !this.done) {
      if (this.at === 0) {
        if (this.endAfterBlock) {
          this.done = true;
          break;
        }
        this.control(ctl);
        if (this.done) break;
      }
      const n = Math.min(end - i, CTRL - this.at);
      this.audio(l, r, i, n);
      i += n;
      this.at += n;
      if (this.at >= CTRL) this.at = 0;
    }
  }

  /** n samples (inside one control block) added into l and r from `off`. */
  private audio(l: Float32Array, r: Float32Array, off: number, n: number): void {
    const P = this.p.patch;
    const { sl, sr2, al, ar, bl, br, g, dg } = this;
    // a voice all in the middle works one side and copies it; one with nothing for filter 2 skips it
    const stereo = this.stereo;
    const useF2 = this.useF2;
    al.fill(0, 0, n);
    if (stereo) ar.fill(0, 0, n);
    if (useF2) {
      bl.fill(0, 0, n);
      if (stereo) br.fill(0, 0, n);
    }
    for (let s = 0; s < PRISM_SOURCES; s++) {
      const sp = P.src[s] as PrismSourcePatch;
      if (!sp.on) continue;
      const st = sp.stereo >= 0.5;
      sl.fill(0, 0, n);
      // a sample and grains always have two sides (one may be the other)
      const two = st || sp.kind >= 2;
      if (two) sr2.fill(0, 0, n);
      switch (sp.kind) {
        case 0:
          this.oscs[s]?.render(sl, sr2, n, st);
          break;
        case 1:
          this.parts[s]?.render(sl, sr2, n, st);
          break;
        case 2:
          this.samples[s]?.render(sl, sr2, n);
          break;
        default:
          this.grains[s]?.render(sl, sr2, n, this.m.rand);
          break;
      }
      if (sp.ftype > 0) (this.sfilters[s] as PrismFilter).process(sl, sr2, n, two);
      const G = s * 4;
      let g0 = g[G] as number;
      let g1 = g[G + 1] as number;
      let g2 = g[G + 2] as number;
      let g3 = g[G + 3] as number;
      const d0 = dg[G] as number;
      const d1 = dg[G + 1] as number;
      const d2 = dg[G + 2] as number;
      const d3 = dg[G + 3] as number;
      if (!stereo) {
        // (in the middle, its left gain is its level)
        for (let i = 0; i < n; i++) {
          al[i] = (al[i] as number) + (sl[i] as number) * g0;
          g0 += d0;
        }
        if (useF2)
          for (let i = 0; i < n; i++) {
            bl[i] = (bl[i] as number) + (sl[i] as number) * g2;
            g2 += d2;
          }
        g1 += d1 * n;
        if (!useF2) g2 += d2 * n;
        g3 += d3 * n;
      } else {
        // one channel, panned (a sample's first side only), or both
        const right = st ? sr2 : sl;
        for (let i = 0; i < n; i++) {
          al[i] = (al[i] as number) + (sl[i] as number) * g0;
          ar[i] = (ar[i] as number) + (right[i] as number) * g1;
          g0 += d0;
          g1 += d1;
        }
        if (useF2)
          for (let i = 0; i < n; i++) {
            bl[i] = (bl[i] as number) + (sl[i] as number) * g2;
            br[i] = (br[i] as number) + (right[i] as number) * g3;
            g2 += d2;
            g3 += d3;
          }
        else {
          g2 += d2 * n;
          g3 += d3 * n;
        }
      }
      g[G] = g0;
      g[G + 1] = g1;
      g[G + 2] = g2;
      g[G + 3] = g3;
    }
    const F1 = P.flt[0] as PrismFilterPatch;
    const F2 = P.flt[1] as PrismFilterPatch;
    if (F1.on) this.f1.process(al, ar, n, stereo);
    const serial = useF2 ? P.serial : 0;
    if (useF2) {
      if (serial > 0) {
        for (let i = 0; i < n; i++) bl[i] = (bl[i] as number) + serial * (al[i] as number);
        if (stereo) for (let i = 0; i < n; i++) br[i] = (br[i] as number) + serial * (ar[i] as number);
      }
      if (F2.on) this.f2.process(bl, br, n, stereo);
    }
    let aL = this.ampL;
    let aR = this.ampR;
    const dL = this.dampL;
    const dR = this.dampR;
    const keep = 1 - serial;
    if (!stereo && !useF2) {
      for (let i = 0; i < n; i++) {
        const v = al[i] as number;
        l[off + i] = (l[off + i] as number) + v * aL;
        r[off + i] = (r[off + i] as number) + v * aR;
        aL += dL;
        aR += dR;
      }
    } else {
      const R1 = stereo ? ar : al;
      const R2 = stereo ? br : bl;
      for (let i = 0; i < n; i++) {
        const a2 = useF2 ? (bl[i] as number) : 0;
        const b2 = useF2 ? (R2[i] as number) : 0;
        l[off + i] = (l[off + i] as number) + ((al[i] as number) * keep + a2) * aL;
        r[off + i] = (r[off + i] as number) + ((R1[i] as number) * keep + b2) * aR;
        aL += dL;
        aR += dR;
      }
    }
    this.ampL = Math.abs(aL) < 1e-9 ? 0 : aL;
    this.ampR = Math.abs(aR) < 1e-9 ? 0 : aR;
  }
}

// ---- the instrument ---------------------------------------------------------------------------------------

/** What Prism asks of the song: the tempo, and where the song is (for LFOs kept to it). */
export interface PrismHost {
  beatSeconds(): number;
  beatAt(): number;
  playing(): boolean;
}

export const PRISM_PRESETS = Object.keys(PRISM_PRESET_KEYS);

export class PrismSynth extends Instrument {
  private p: Prism;
  private readonly preset: string;
  private readonly host: PrismHost | null;
  private readonly media: SamplerSpec | null;
  private readonly cache = new Map<string, Mips>();
  private readonly sh: Shared;
  private fx: (Effect | null)[] = [];
  private fxTypes: number[] = [];
  private readonly fxSettings: FxSettings[] = [];
  private seed = 1;
  private dryL = new Float32Array(0);
  private dryR = new Float32Array(0);
  private tail = 0;
  private at = 0;
  private dcxL = 0;
  private dcxR = 0;
  private dcyL = 0;
  private dcyR = 0;
  private readonly dcPole: number;
  /** Mono: the keys held, the last on top, and its one voice. */
  private readonly held: number[] = [];
  private mono: PrismVoice | null = null;
  private last = -1;
  private level = 1;
  private dlevel = 0;
  /** The last note, for what the effects listen to. */
  private lastKey = 60;
  private lastVelocity = 100;
  private gateShared = 0;

  constructor(
    sr: number,
    preset: string,
    params?: Record<string, number>,
    host?: PrismHost | null,
    media?: SamplerSpec | null,
  ) {
    super(sr);
    this.preset = preset;
    this.host = host ?? null;
    this.media = media ?? null;
    this.p = derive(prismPatch(preset, params), params, this.cache);
    this.sh = {
      sr,
      beatSeconds: 0.5,
      mods: new ModState(7),
      perf: { macros: this.p.macros, controls: Float64Array.from(this.p.patch.ctl), wheel: 0, pressure: 0, bend: 0 },
      media: this.media,
    };
    this.dcPole = 1 - (Math.PI * 2 * 4) / sr;
    this.configure();
    this.level = this.p.volume;
  }

  private configure(): void {
    const P = this.p.patch;
    this.maxVoices = Math.max(1, Math.round(P.voice.mono ? 2 : P.voice.poly));
    this.bendRange = P.voice.bend;
    this.sh.perf.macros = this.p.macros;
    this.sh.perf.controls = Float64Array.from(P.ctl);
    // the effects: kept where a slot's type stays (its tail rings on), made where it changed
    const fx: (Effect | null)[] = [];
    const types: number[] = [];
    for (let k = 0; k < PRISM_FX; k++) {
      const type = Math.round((P.fx[k] as FxSettings).type ?? 0);
      types.push(type);
      fx.push(this.fxTypes[k] === type ? (this.fx[k] ?? null) : makeEffect(type, this.sr));
      this.fxSettings[k] = { ...(P.fx[k] as FxSettings) };
    }
    this.fx = fx;
    this.fxTypes = types;
    for (let i = 0; i < PRISM_LFOS; i++) this.sh.mods.bipolar[SRC_LFO + i] = (P.lfo[i] as LfoPatch).bipolar;
  }

  update(params?: Record<string, number>): void {
    // (the voices keep the patch they started with, so a sounding note never jumps)
    this.p = derive(prismPatch(this.preset, params), params, this.cache);
    this.configure();
  }

  protected startVoice(key: number, velocity: number): Voice | null {
    const v = this.p.patch.voice;
    const from = v.glide > 0 && this.last >= 0 ? this.last : key;
    this.last = key;
    this.triggerShared(key, velocity);
    return new PrismVoice(this.p, this.sh, key, velocity, this.seed++, from);
  }

  /** The shared modulators start again when a note comes out of silence (what the effects listen to). */
  private triggerShared(key: number, velocity: number): void {
    const p = this.p;
    if (!p.sharedUsed) return;
    let sounding = false;
    for (const v of this.voices) if (!v.done && !v.released) sounding = true;
    const m = this.sh.mods;
    this.lastKey = key;
    this.lastVelocity = velocity;
    this.gateShared = 1;
    if (sounding) return;
    for (let i = 0; i < PRISM_ENVS; i++) m.envs[i]?.trigger(false);
    for (let i = 0; i < PRISM_SHAPES; i++) m.shapes[i]?.trigger(p.patch.shape[i] as ShapePatch);
    for (let i = 0; i < PRISM_SEQS; i++) m.seqs[i]?.trigger(p.patch.seq[i] as SeqPatch);
    for (let i = 0; i < PRISM_LFOS; i++) if (!p.lfoShared[i]) m.lfos[i]?.trigger(p.patch.lfo[i] as LfoPatch, m.rand);
  }

  override noteOn(key: number, velocity: number, art = 0): void {
    const v = this.p.patch.voice;
    if (!v.mono) {
      super.noteOn(key, velocity, art);
      return;
    }
    if (velocity <= 0) {
      this.noteOff(key);
      return;
    }
    const at = this.held.indexOf(key);
    if (at >= 0) this.held.splice(at, 1);
    this.held.push(key);
    const mono = this.mono;
    if (mono && !mono.done) {
      const legato = v.legato >= 0.5 && !mono.released;
      mono.moveTo(key, velocity, legato, v.glide > 0);
      this.last = key;
      return;
    }
    const voice = this.startVoice(key, velocity) as PrismVoice;
    this.mono = voice;
    this.addVoice(voice);
  }

  override noteOff(key: number): void {
    if (!this.p.patch.voice.mono) {
      super.noteOff(key);
      this.releaseShared();
      return;
    }
    const at = this.held.indexOf(key);
    if (at >= 0) this.held.splice(at, 1);
    const v = this.mono;
    if (!v || v.done || v.released || v.key !== key) return;
    // back to the key still held, as mono synths do
    const back = this.held[this.held.length - 1];
    if (back !== undefined) v.moveTo(back, 64, true, this.p.patch.voice.glide > 0);
    else if (this.sustain) v.sustained = true;
    else v.release();
    this.releaseShared();
  }

  private releaseShared(): void {
    for (const v of this.voices) if (!v.done && !v.released) return;
    this.gateShared = 0;
    for (const e of this.sh.mods.envs) e.release();
    for (const s of this.sh.mods.shapes) s.release();
  }

  override allNotesOff(hard: boolean): void {
    this.held.length = 0;
    super.allNotesOff(hard);
  }

  override get active(): number {
    return super.active + (this.tail > 2e-5 ? 1 : 0);
  }

  /** The shared modulation and the effects' settings for the next block. */
  private sharedStep(): void {
    const p = this.p;
    const P = p.patch;
    const m = this.sh.mods;
    const sh = this.sh;
    const dt = CTRL / this.sr;
    sh.perf.wheel = this.controls.mod;
    sh.perf.pressure = this.controls.pressure;
    sh.perf.bend = this.bendRange > 0 ? this.controls.bend / this.bendRange : 0;
    const playing = this.host?.playing() ?? false;
    const beat = playing
      ? (this.host?.beatAt() ?? Number.NaN) + (this.at * CTRL) / (this.sr * sh.beatSeconds)
      : Number.NaN;
    for (let i = 0; i < PRISM_LFOS; i++) {
      const l = P.lfo[i] as LfoPatch;
      if (!p.lfoUsed[i]) continue;
      // the shared LFOs: free ones always, the per-note ones for the effects
      if (!p.lfoShared[i] && !p.shared.length) continue;
      const rate = l.sync ? 1 / Math.max(1e-3, l.beats * sh.beatSeconds) : l.rate;
      m.lfos[i]?.step(
        l,
        rate,
        dt,
        m.rand,
        l.custom ? (p.lshapes[l.custom - 1] ?? null) : null,
        l.mode === 2 ? beat : Number.NaN,
      );
    }
    if (p.shared.length) {
      for (let i = 0; i < PRISM_ENVS; i++) if (p.envUsed[i]) m.envs[i]?.step(P.env[i] as EnvPatch, dt);
      for (let i = 0; i < PRISM_SHAPES; i++)
        if (p.shapeUsed[i]) {
          const s = P.shape[i] as ShapePatch;
          m.shapes[i]?.step(s, dt, s.sync ? 1 / sh.beatSeconds : 1);
        }
      for (let i = 0; i < PRISM_SEQS; i++)
        if (p.seqUsed[i]) {
          const s = P.seq[i] as SeqPatch;
          m.seqs[i]?.step(s, dt, 1 / Math.max(1e-3, s.beats * sh.beatSeconds));
        }
    }
    fillPlayed(m, this.lastKey, this.lastVelocity, 0.5, this.gateShared, sh.perf);
    fillModulators(m, null, null);
    if (!p.shared.length) return;
    m.apply(p.shared, p.usedShared, P.curve);
    for (let k = 0; k < PRISM_FX; k++) {
      const type = this.fxTypes[k] ?? 0;
      if (!type) continue;
      const base = P.fx[k] as FxSettings;
      const out = this.fxSettings[k] as FxSettings;
      const T = TGT_FX + k * PER_FX;
      out.mix = Math.min(1, Math.max(0, (base.mix ?? 0.3) + (m.add[T] as number)));
      const defs = PRISM_FX_PARAMS[type] ?? [];
      for (let j = 0; j < 4 && j < defs.length; j++) {
        const d = defs[j] as (typeof defs)[number];
        const add = m.add[T + 1 + j] as number;
        const v = base[d.id] ?? d.min;
        if (add === 0) {
          out[d.id] = v;
          continue;
        }
        const lo = d.log ? Math.log2(d.min) : d.min;
        const span = (d.log ? Math.log2(d.max) : d.max) - lo;
        let u = ((d.log ? Math.log2(Math.max(v, 1e-9)) : v) - lo) / span + add;
        u = Math.min(1, Math.max(0, u));
        out[d.id] = d.log ? 2 ** (lo + u * span) : lo + u * span;
      }
    }
  }

  override render(l: Float32Array, r: Float32Array, start: number, end: number): void {
    if (this.active === 0 && this.at === 0) return;
    if (end > this.dryL.length) {
      this.dryL = new Float32Array(end);
      this.dryR = new Float32Array(end);
    }
    this.sh.beatSeconds = this.host?.beatSeconds() ?? 0.5;
    const dl = this.dryL;
    const dr = this.dryR;
    dl.fill(0, start, end);
    dr.fill(0, start, end);
    // the voices, in stretches that keep the shared modulation's blocks
    let i = start;
    let ringing = 0;
    while (i < end) {
      if (this.at === 0) {
        if (this.p.sharedUsed) this.sharedStep();
        else {
          const sh = this.sh;
          sh.perf.wheel = this.controls.mod;
          sh.perf.pressure = this.controls.pressure;
          sh.perf.bend = this.bendRange > 0 ? this.controls.bend / this.bendRange : 0;
        }
        for (let k = 0; k < PRISM_FX; k++) this.fx[k]?.set(this.fxSettings[k] as FxSettings, this.sh.beatSeconds);
        this.dlevel = (this.p.volume - this.level) / CTRL;
      }
      const n = Math.min(end - i, CTRL - this.at);
      for (const v of this.voices) if (!v.done) v.render(dl, dr, i, i + n, this.controls);
      for (let k = 0; k < PRISM_FX; k++) {
        const fx = this.fx[k];
        if (!fx) continue;
        fx.process(dl, dr, i, i + n);
        ringing = Math.max(ringing, fx.ringing);
      }
      // the level after the effects, the offset taken out, and a soft ceiling
      const pole = this.dcPole;
      let xl = this.dcxL;
      let xr = this.dcxR;
      let yl = this.dcyL;
      let yr = this.dcyR;
      let vol = this.level;
      const dv = this.dlevel;
      for (let j = i; j < i + n; j++) {
        const a = (dl[j] as number) * vol;
        const b = (dr[j] as number) * vol;
        vol += dv;
        yl = a - xl + pole * yl;
        yr = b - xr + pole * yr;
        xl = a;
        xr = b;
        l[j] =
          (l[j] as number) +
          (yl > 0.9 || yl < -0.9 ? Math.sign(yl) * (0.9 + 0.1 * soft((Math.abs(yl) - 0.9) / 0.1)) : yl);
        r[j] =
          (r[j] as number) +
          (yr > 0.9 || yr < -0.9 ? Math.sign(yr) * (0.9 + 0.1 * soft((Math.abs(yr) - 0.9) / 0.1)) : yr);
      }
      this.level = vol;
      this.dcxL = xl;
      this.dcxR = xr;
      this.dcyL = Math.abs(yl) < 1e-20 ? 0 : yl;
      this.dcyR = Math.abs(yr) < 1e-20 ? 0 : yr;
      i += n;
      this.at += n;
      if (this.at >= CTRL) this.at = 0;
    }
    this.tail = this.fx.some((x) => x) ? Math.max(ringing, this.tail * 0.9) : 0;
  }
}
