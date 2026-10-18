/**
 * The Performance sampler: notes played the way Hallowed Lanterns' sampler plays them
 * (hlaudio.sampler: play() and Sampler.note()), so a part sounds the same in both.
 *
 * Each note is planned as the game plans it: its dynamic layer, its sample (the nearest recorded
 * note, round robins in turn), a jittered start, legato hand-overs between the notes of a voice
 * (and long notes re-bowed), a short slide into a legato note, a start a little before the beat so
 * a slow attack lands on it; then played: read through the game's interpolator (a Kaiser-windowed
 * sinc, 48 taps, 512 phases), a sustain's sample lengthened by looping its steady part, its
 * dynamics, envelope and release, its width and place in the stereo field. Every random choice is
 * the game's own draw (numpy's generator, named as the game names it).
 *
 * Planning needs the whole part (a note's legato depends on the next); it happens where the song
 * is compiled. Playing a plan is a voice, one sample after another.
 */
import { type NumpyRandom, namedRandom } from './random.ts';

/** Python's round(): halves go to the even neighbour. */
export function roundHalfEven(x: number): number {
  const f = Math.floor(x);
  const d = x - f;
  if (d > 0.5) return f + 1;
  if (d < 0.5) return f;
  return f % 2 === 0 ? f : f + 1;
}

/** The game's ns(): seconds to samples, rounded as Python rounds. */
const ns = (seconds: number, sr: number) => roundHalfEven(seconds * sr);
const undb = (d: number) => 10 ** (d / 20);
const clip01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** One recorded sample, as the game measured it. */
export interface PerfRow {
  /** Index into the instrument's sample files (the zone it plays). */
  sample: number;
  midi: number | null;
  layer: number;
  start: number;
  attack: number;
  /** Frames in the file. */
  frames: number;
  cleanEnd?: number;
  tune: number;
  gainDb: number;
  loopStart?: number;
  loopEnd?: number;
  loopRho?: number;
}

/** An instrument as the game defines it (hlaudio.sampler.Inst), with its measured samples in catalogue order. */
export interface PerfInstrument {
  name: string;
  kind: 'sus' | 'short' | 'oneshot' | 'drum';
  release: number;
  lag: number;
  maxLead: number;
  legatoSkip: number;
  xfade: number;
  pan: number;
  width: number;
  maxAttack: number;
  /** The longest bow or breath (s) before a re-bow, if it has one. */
  rebow?: number;
  rows: PerfRow[];
}

/** A control curve through (seconds, value) points, eased by a cosine between them (the game's Curve). */
export interface PerfCurve {
  t: number[];
  v: number[];
}

export function curveAt(c: PerfCurve, t: number): number {
  const ts = c.t;
  const vs = c.v;
  const last = ts.length - 1;
  if (t < (ts[0] as number)) return vs[0] as number;
  if (t > (ts[last] as number)) return vs[last] as number;
  // searchsorted(right) − 1, clipped to [0, len − 2]
  let lo = 0;
  let hi = ts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((ts[mid] as number) <= t) lo = mid + 1;
    else hi = mid;
  }
  const idx = Math.max(0, Math.min(last - 1, lo - 1));
  const t0 = ts[idx] as number;
  const t1 = ts[idx + 1] as number;
  let u = clip01((t - t0) / Math.max(t1 - t0, 1e-9));
  u = 0.5 - 0.5 * Math.cos(Math.PI * u);
  return (vs[idx] as number) + ((vs[idx + 1] as number) - (vs[idx] as number)) * u;
}

/** A note as the part plays it: start and length in seconds, pitch (≤ 0 unpitched), velocity 0–1, extras. */
export interface PerfNote {
  t: number;
  d: number;
  p: number;
  v: number;
  x?: Record<string, unknown>;
}

/** How the part is played (the game's play() arguments). */
export interface PlayOptions {
  seed: number;
  gainDb?: number;
  pan?: number;
  width?: number;
  /** Dynamics (a mod wheel) over the part, for sustains. */
  dyn?: PerfCurve;
  legato?: boolean;
  legatoGap?: number;
  xf?: number;
  detune?: number;
  layerBias?: number;
  release?: number;
  tail?: number;
  panSpread?: number;
  humanizeV?: number;
  slide?: number;
  lag?: number;
  shape?: { attack?: number; swell?: number; taper?: number };
}

const REBOW_OVERLAP = 0.35;

/** A sustain's lengthened source: its steady part looped, with matched joins (the game's extend()). */
export interface Extension {
  /** Frames of the source it makes, from the sample's start. */
  total: number;
  ls: number;
  le: number;
  /** The joins' fade length, and whether they're linear (well-correlated loops) or equal-power. */
  fade: number;
  linear: boolean;
  /** How many loop passes follow the first stretch. */
  passes: number;
}

/** A pitch curve (semitones) over a note: a slide into it, a bend, a vibrato. */
export interface GlideSpec {
  slide?: { k: number; delta: number };
  bend?: [number, number][];
  vib?: { depth: number; rate: number; delay: number; rise: number; up: number; ph0: number };
  /** The largest step through the source it takes (for the interpolator's cut-off). */
  top: number;
}

export interface NotePlan {
  /** Output frame its first sample lands on. */
  at: number;
  row: PerfRow;
  semis: number;
  /** Where in the source its first sample reads (frames). */
  start: number;
  /** Samples it plays. */
  length: number;
  extend: Extension | null;
  /** Played at its recorded pitch from a whole frame: copied, not interpolated. */
  copy: boolean;
  ratio: number;
  cut: number;
  glide: GlideSpec | null;
  /** The sample's levelling gain and the note's own (short notes: velocity; sustains: dynamics after). */
  gain: number;
  // ---- short, one-shot and drum notes
  fadeIn: number;
  damp: { n: number; tau: number } | null;
  endRamp: number;
  // ---- sustains
  sus: {
    n: number;
    dur: number;
    rel: number;
    tail: number;
    /** Dynamics at each frame: a constant, or the part's curve from the note's start, held after its length. */
    dynConst: number | null;
    dyn: PerfCurve | null;
    dynT0: number;
    dynOffset: number;
    dynN: number;
    shape: { swell: number; taper: number; attack: number } | null;
    legatoK: number;
    startK: number;
  } | null;
  // ---- placing it
  pan: number;
  width: number;
  stemGain: number;
}

// ---- Python's round(x, ndigits) for dictionary keys (exact, halves to even) ----

function pyRoundKey(x: number, digits: number): string {
  const scaled = x * 10 ** digits;
  const r = roundHalfEven(scaled);
  // a key only: the same for any two values Python would round alike, but for exact halves
  return `${r}`;
}

class Picker {
  private readonly inst: PerfInstrument;
  private readonly layers: number[];
  private readonly rr = new Map<string, number>();
  readonly r: NumpyRandom;
  constructor(inst: PerfInstrument, seed: number) {
    this.inst = inst;
    this.layers = [...new Set(inst.rows.map((x) => x.layer))].sort((a, b) => a - b);
    this.r = namedRandom('sampler', inst.name, seed);
  }

  get layerCount(): number {
    return this.layers.length;
  }

  private zone(midi: number | null, layer: number): PerfRow[] {
    const rows = this.inst.rows;
    let cands = rows.filter((x) => x.layer === layer);
    if (!cands.length) cands = rows;
    if (midi === null) return cands;
    const dist = (x: PerfRow) => Math.abs((x.midi as number) - midi);
    const dLayer = Math.min(...cands.map(dist));
    const dAll = Math.min(...rows.map(dist));
    if (dLayer > Math.max(2.6, dAll + 1.01)) {
      const near = rows.filter((x) => dist(x) - dAll < 0.01);
      // min over a set of small integers: ascending order, the first of equals
      const ls = [...new Set(near.map((x) => x.layer))].sort((a, b) => a - b);
      let ly = ls[0] as number;
      for (const l of ls) if (Math.abs(l - layer) < Math.abs(ly - layer)) ly = l;
      cands = rows.filter((x) => x.layer === ly);
    }
    const best = Math.min(...cands.map(dist));
    const pool = cands.filter((x) => Math.abs(dist(x) - best) < 0.01);
    // stable: nearest, then (on ties) the one below shifts up, preferred after the one above
    pool.sort((a, b) => dist(a) - dist(b) || Number((a.midi as number) < midi) - Number((b.midi as number) < midi));
    const bm = pool[0]?.midi as number;
    return pool.filter((x) => Math.abs((x.midi as number) - bm) < 0.01);
  }

  pick(midi: number | null, layer: number): PerfRow {
    const pool = this.zone(midi, layer);
    const key = `${pyRoundKey(pool[0]?.midi ?? 0, 2)}|${layer}`;
    // Python evaluates get()'s default first: the draw happens every time
    const fresh = this.r.integers(0, 8);
    const c = this.rr.get(key) ?? fresh;
    this.rr.set(key, c + 1);
    return pool[c % pool.length] as PerfRow;
  }

  layerFor(v: number): [number, number, number] {
    const L = this.layers.length;
    if (L === 1) return [this.layers[0] as number, this.layers[0] as number, 0];
    const p = clip01(v) * (L - 1);
    const lo = Math.min(L - 2, Math.floor(p));
    return [this.layers[lo] as number, this.layers[lo + 1] as number, p - lo];
  }
}

/** Split long sustained notes into overlapping bows, each a fresh attack (the game's rebow()). */
function rebow(notes: PerfNote[], limit: number): PerfNote[] {
  const out: PerfNote[] = [];
  for (const n of notes) {
    if (n.d <= limit + 0.5) {
      out.push(n);
      continue;
    }
    const k = Math.ceil(n.d / limit);
    const seg = n.d / k;
    for (let i = 0; i < k; i++) {
      const x = { ...(n.x ?? {}) };
      if (i > 0) {
        x.legato = false;
        x.rebow = true;
      }
      out.push({
        t: n.t + i * seg,
        d: seg + (i < k - 1 ? REBOW_OVERLAP : 0),
        p: n.p,
        v: Math.min(1, Math.max(0.02, n.v * (i ? 0.94 : 1))),
        x,
      });
    }
  }
  return out;
}

const round3 = (t: number) => roundHalfEven(t * 1000) / 1000;

/** Notes into monophonic voices, chords kept connected (hlaudio.bowed.split_voices). */
function splitVoices(notes: PerfNote[]): PerfNote[][] {
  if (notes.length && notes.every((n) => n.x && 'voice' in n.x)) {
    const vs = new Map<unknown, PerfNote[]>();
    for (const n of notes) {
      const k = (n.x as Record<string, unknown>).voice;
      if (!vs.has(k)) vs.set(k, []);
      vs.get(k)?.push(n);
    }
    return [...vs.values()];
  }
  const sorted = notes.map((n, i) => ({ n, i }));
  sorted.sort((a, b) => round3(a.n.t) - round3(b.n.t) || a.n.p - b.n.p || a.i - b.i);
  const groups = new Map<number, PerfNote[]>();
  for (const { n } of sorted) {
    const k = round3(n.t);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k)?.push(n);
  }
  const voices: PerfNote[][] = [];
  for (const t of [...groups.keys()].sort((a, b) => a - b)) {
    const g = groups.get(t) as PerfNote[];
    const free: number[] = [];
    voices.forEach((v, i) => {
      const last = v[v.length - 1] as PerfNote;
      if (last.t < t - 1e-6 && last.t + last.d <= t + 1.0) free.push(i);
    });
    const lastP = (i: number) => {
      const v = voices[i] as PerfNote[];
      return (v[v.length - 1] as PerfNote).p;
    };
    free.sort((a, b) => lastP(a) - lastP(b));
    g.forEach((n, k) => {
      if (k < free.length) {
        let best = free[0] as number;
        for (const i of free) if (Math.abs(lastP(i) - n.p) < Math.abs(lastP(best) - n.p)) best = i;
        free.splice(free.indexOf(best), 1);
        voices[best]?.push(n);
      } else voices.push([n]);
    });
  }
  return voices;
}

/** The interpolator's cut-off for a read speed (the game caches its filters by this, to three places). */
const cutFor = (top: number) => Math.min(1, 0.985 / Math.max(top, 1e-6));

/**
 * Plan a part's notes as the game's play() would render them. `notes` are in seconds; `frames`
 * of a row's sample file come with the rows. Plans are in the order the game renders them.
 *
 * The game keeps one interpolator filter per cut-off rounded to three places, made with the first
 * cut-off it met in its whole render; `firstCuts` (by that key) says which, when the creation says.
 */
export function planPart(
  inst: PerfInstrument,
  notes: PerfNote[],
  opts: PlayOptions,
  sr: number,
  firstCuts?: Record<string, number>,
): NotePlan[] {
  const picker = new Picker(inst, opts.seed);
  const r = namedRandom('play', inst.name, opts.seed);
  const g0 = undb(opts.gainDb ?? 0);
  const pan = opts.pan ?? inst.pan;
  const width = opts.width ?? inst.width;
  const legato = opts.legato ?? true;
  const legatoGap = opts.legatoGap ?? 0.06;
  const slide = opts.slide ?? 0.06;
  let humanizeV = opts.humanizeV ?? 0.05;
  const sus = inst.kind === 'sus';
  let list = notes;
  if (sus && inst.rebow !== undefined) list = rebow(list, inst.rebow);
  if (inst.name.endsWith('_pizz') || inst.name.endsWith('_spic')) humanizeV = Math.max(humanizeV, 0.12);
  const voices = sus ? splitVoices(list) : [stableSortByT(list)];
  const plans: NotePlan[] = [];
  for (const raw of voices) {
    const voice = stableSortByT(raw);
    let prev: PerfNote | null = null;
    voice.forEach((nt, k) => {
      const x = nt.x ?? {};
      const v = Math.min(1, Math.max(0.02, nt.v * (1 + r.normal(0, humanizeV))));
      const det = opts.detune ?? 0;
      const dt = opts.lag ?? 0;
      const skip = (x.skip as number | undefined) ?? 0;
      let leg: number | null = null;
      if (sus && legato && prev && truthy(x.legato) && nt.t - (prev.t + prev.d) <= legatoGap) leg = prev.p;
      let dur = nt.d;
      const nxt = voice[k + 1];
      let relN: number | undefined;
      let tailN: number | undefined;
      if (sus && legato && nxt && nxt.t - (nt.t + nt.d) <= legatoGap && truthy(nxt.x?.legato)) {
        const xfn = opts.xf ?? inst.xfade;
        dur = Math.max(0.05, nxt.t - nt.t + xfn * 0.5);
        relN = xfn / 2;
        tailN = xfn;
      } else {
        relN = (x.release as number | undefined) ?? opts.release;
        tailN = opts.tail;
      }
      const plan = planNote(inst, picker, sr, {
        midi: nt.p > 0 ? nt.p : null,
        v,
        dur,
        dyn: sus && opts.dyn ? opts.dyn : null,
        dynT0: nt.t,
        legatoIn: leg,
        xfIn: opts.xf,
        release: relN,
        tail: tailN,
        detune: det + ((x.detune as number | undefined) ?? 0),
        layerBias: (opts.layerBias ?? 0) + ((x.layer_bias as number | undefined) ?? 0),
        slide,
        shape: sus ? (opts.shape ?? null) : null,
        skip,
        bend: (x.bend as [number, number][] | undefined) ?? null,
        vib: (x.vib as Record<string, number> | undefined) ?? null,
        nb: (x.nb as number | undefined) ?? 0,
        playV: v,
      });
      const pnBase = pan + ((x.pan as number | undefined) ?? 0);
      const pn = pnBase + (opts.panSpread ? r.uniform(-opts.panSpread, opts.panSpread) : 0);
      plan.pan = Math.min(1, Math.max(-1, pn));
      plan.width = width;
      plan.stemGain = g0 * ((x.gain as number | undefined) ?? 1);
      const startS = nt.t + dt - (leg !== null ? 0 : ((x.xf_pre as number | undefined) ?? 0)) - plan.at / sr;
      plan.at = roundHalfEven(startS * sr);
      if (firstCuts && !plan.copy) plan.cut = firstCuts[cutKey(plan.cut)] ?? plan.cut;
      plans.push(plan);
      prev = nt;
    });
  }
  return plans;
}

/** A note's legato flag as Python reads it: missing is true; false, 0 and null are not. */
const truthy = (v: unknown) => v === undefined || Boolean(v);

function stableSortByT(notes: PerfNote[]): PerfNote[] {
  return notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.t - b.n.t || a.i - b.i)
    .map((o) => o.n);
}

interface NoteArgs {
  midi: number | null;
  v: number;
  dur: number;
  dyn: PerfCurve | null;
  dynT0: number;
  legatoIn: number | null;
  xfIn: number | undefined;
  release: number | undefined;
  tail: number | undefined;
  detune: number;
  layerBias: number;
  slide: number;
  shape: { attack?: number; swell?: number; taper?: number } | null;
  skip: number;
  bend: [number, number][] | null;
  vib: Record<string, number> | null;
  nb: number;
  /** The note's velocity after humanising (the dynamics offset uses it). */
  playV: number;
}

/** One note's plan (Sampler.note). Its `at` comes back holding the lead (frames early) for planPart to place. */
function planNote(inst: PerfInstrument, picker: Picker, sr: number, a: NoteArgs): NotePlan {
  const rel = a.release ?? inst.release;
  const tail = a.tail ?? rel * 2.5;
  const n = ns(a.dur, sr);
  const L = n + ns(tail, sr);
  const base: Omit<NotePlan, 'row' | 'semis' | 'start' | 'length' | 'ratio' | 'cut' | 'copy' | 'gain'> = {
    at: 0,
    extend: null,
    glide: null,
    fadeIn: 0,
    damp: null,
    endRamp: 0,
    sus: null,
    pan: 0,
    width: 1,
    stemGain: 1,
  };
  if (inst.kind !== 'sus') {
    const [lo, hi, mix] = picker.layerFor(clip01(a.v + a.layerBias));
    const lay = mix > 0.5 ? hi : lo;
    const e = picker.pick(a.midi === null ? null : a.midi + a.nb, lay);
    const off = Math.trunc(picker.r.uniform(0, 0.006) * sr) + ns(a.skip, sr);
    const shiftUp = 2 ** (((a.midi ?? 0) - (e.midi ?? 0)) / 12);
    let avail = Math.trunc((e.frames - e.start - off) / shiftUp) - 8;
    let glide: GlideSpec | null = null;
    if (a.bend || a.vib) {
      glide = pitchGlide(Math.min(avail, L), a.bend, a.vib, picker.r, sr);
      const peak = Math.max(0, glidePeak(glide, Math.min(avail, L), sr));
      avail = Math.trunc(avail / 2 ** (peak / 12)) - 8;
    }
    const want = Math.min(avail, L);
    const v = voiceRead(e, a.midi, want, off, a.detune, glide, sr, false);
    const gain = undb(-22 * (1 - clip01(a.v)) ** 1.3 + 6 * (mix - 0.5) * (picker.layerCount > 1 ? 1 : 0) * 0.3);
    return {
      ...base,
      ...v,
      gain: undb(e.gainDb) * gain,
      fadeIn: off > 0 ? Math.min(v.length, ns(0.004, sr)) : 0,
      damp:
        (inst.kind === 'oneshot' || inst.kind === 'short') && a.dur > 0 && n < v.length
          ? { n, tau: Math.max(rel / 4, 1e-3) }
          : null,
      endRamp: Math.min(v.length, ns(0.02, sr)) > 1 ? Math.min(v.length, ns(0.02, sr)) : 0,
    };
  }
  // ---- sustains: one recorded layer per note, chosen by its mean dynamic
  const dynAt = (i: number) =>
    a.dyn
      ? clip01(curveAt(a.dyn, a.dynT0 + Math.min(i, Math.max(0, n - 1)) / sr) + 0.3 * (a.playV - 0.6))
      : clip01(a.v);
  let dmean: number;
  if (a.dyn) {
    let s = 0;
    const m = Math.max(1, n);
    for (let i = 0; i < m; i++) s += dynAt(i);
    dmean = s / m;
  } else dmean = clip01(a.v);
  let [lo, , mix] = picker.layerFor(clip01(dmean + a.layerBias));
  const hiLayer = picker.layerFor(clip01(dmean + a.layerBias))[1];
  if (mix > 0.5) lo = hiLayer;
  const e = picker.pick(a.midi, lo);
  let off: number;
  if (a.legatoIn !== null) off = Math.max(0, e.attack - e.start) + ns(inst.legatoSkip, sr);
  else off = Math.trunc(picker.r.uniform(0, 0.006) * sr);
  off += ns(a.skip, sr);
  let glide: GlideSpec | null = null;
  if (a.legatoIn !== null && a.slide > 0 && a.midi !== null && Math.abs(a.legatoIn - a.midi) > 0.01) {
    glide = { slide: { k: ns(a.slide, sr), delta: a.legatoIn - a.midi }, top: 0 };
  }
  if (a.bend || a.vib) {
    const pc = pitchGlide(L, a.bend, a.vib, picker.r, sr);
    glide = glide ? { ...glide, bend: pc.bend, vib: pc.vib } : pc;
  }
  if (glide) glide.top = 0;
  const v = voiceRead(e, a.midi, L, off, a.detune, glide, sr, true);
  const length = Math.min(L, v.length);
  const shape = a.shape
    ? {
        swell: a.shape.swell ?? 0,
        taper: a.shape.taper ?? 0,
        attack: inst.maxAttack ? Math.min(a.shape.attack ?? 0, inst.maxAttack) : (a.shape.attack ?? 0),
      }
    : null;
  let lead = a.legatoIn !== null ? 0 : Math.min(Math.max(0, e.attack - e.start), ns(inst.maxLead, sr));
  lead = Math.max(0, lead - ns(inst.lag, sr));
  if (a.legatoIn !== null) lead = ns(0.5 * (a.xfIn ?? inst.xfade), sr);
  return {
    ...base,
    ...v,
    length,
    at: lead,
    gain: undb(e.gainDb),
    sus: {
      n,
      dur: a.dur,
      rel,
      tail,
      dynConst: a.dyn ? null : clip01(a.v),
      dyn: a.dyn,
      dynT0: a.dynT0,
      dynOffset: 0.3 * (a.playV - 0.6),
      dynN: n,
      shape,
      legatoK: a.legatoIn !== null ? Math.min(length, ns(a.xfIn ?? inst.xfade, sr)) : 0,
      startK: a.legatoIn !== null ? 0 : Math.min(length, 64),
    },
  };
}

/** The game's pitch_curve(): a bend through points (cosine-eased) and a pressed vibrato. */
function pitchGlide(
  _L: number,
  bend: [number, number][] | null,
  vib: Record<string, number> | null,
  r: NumpyRandom,
  _sr: number,
): GlideSpec {
  const out: GlideSpec = { top: 0 };
  if (bend?.length) out.bend = bend;
  if (vib) {
    out.vib = {
      depth: vib.depth ?? 0.25,
      rate: vib.rate ?? 5.5,
      delay: vib.delay ?? 0.3,
      rise: vib.rise ?? 0.4,
      up: vib.up ?? 0.7,
      ph0: r.uniform(0, 0.3),
    };
  }
  return out;
}

const HALF_PI = Math.PI / 2;

/**
 * A glide's semitones at each sample (the vibrato's phase runs on from the start). step() leaves the
 * sample's semitones in `s`: a call that returns a double boxes it unless inlined, and a voice
 * takes one every sample.
 */
export class GlidePlayer {
  private readonly g: GlideSpec;
  private readonly sr: number;
  /** The bend's points as a curve, laid out once. */
  private readonly bendT: Float64Array | null;
  private readonly bendV: Float64Array | null;
  private readonly rise: number;
  private readonly ph0: number;
  s = 0;
  private i = 0;
  private acc = 0;
  constructor(g: GlideSpec, sr: number) {
    this.g = g;
    this.sr = sr;
    this.bendT = g.bend ? Float64Array.from(g.bend, (b) => b[0]) : null;
    this.bendV = g.bend ? Float64Array.from(g.bend, (b) => b[1]) : null;
    this.rise = g.vib ? Math.max(g.vib.rise, 1e-3) : 1;
    this.ph0 = g.vib?.ph0 ?? 0;
  }
  step(): void {
    const { g, sr } = this;
    const i = this.i++;
    const t = i / sr;
    let s = 0;
    if (g.slide && i < g.slide.k) {
      let c = i / g.slide.k;
      c = c < 0 ? 0 : c > 1 ? 1 : c;
      s += g.slide.delta * (1 - c * c * (3 - 2 * c));
    }
    const ts = this.bendT;
    const vs = this.bendV;
    if (ts && vs) {
      if (ts.length === 1) s += vs[0] as number;
      else {
        // curveAt, in line
        const last = ts.length - 1;
        if (t < (ts[0] as number)) s += vs[0] as number;
        else if (t > (ts[last] as number)) s += vs[last] as number;
        else {
          let lo = 0;
          let hi = ts.length;
          while (lo < hi) {
            const mid = (lo + hi) >> 1;
            if ((ts[mid] as number) <= t) lo = mid + 1;
            else hi = mid;
          }
          const idx = Math.max(0, Math.min(last - 1, lo - 1));
          const t0 = ts[idx] as number;
          const t1 = ts[idx + 1] as number;
          let u = (t - t0) / Math.max(t1 - t0, 1e-9);
          u = u < 0 ? 0 : u > 1 ? 1 : u;
          u = 0.5 - 0.5 * Math.cos(Math.PI * u);
          s += (vs[idx] as number) + ((vs[idx + 1] as number) - (vs[idx] as number)) * u;
        }
      }
    }
    if (g.vib) {
      const { depth, rate, delay, up } = g.vib;
      const drift = 1 + 0.04 * Math.sin(2 * Math.PI * 0.7 * t + 1.3);
      // the phase: 2π · (the running sum of rate · drift, this sample's included) / sr, from ph0
      this.acc += rate * drift;
      const ph = (2 * Math.PI * this.acc) / sr + this.ph0;
      let c = (t - delay) / this.rise;
      c = c < 0 ? 0 : c > 1 ? 1 : c;
      const ramp = c * c * (3 - 2 * c);
      const osc = up * 0.5 * (1 - Math.cos(ph)) + (1 - up) * 0.5 * Math.sin(ph);
      s += depth * ramp * osc;
    }
    this.s = s;
  }
  next(): number {
    this.step();
    return this.s;
  }
}

function glidePeak(g: GlideSpec, L: number, sr: number): number {
  const p = new GlidePlayer(g, sr);
  let peak = Number.NEGATIVE_INFINITY;
  for (let i = 0; i < L; i++) peak = Math.max(peak, p.next());
  return peak;
}

/** How a note reads its sample (the game's _voice() and shift()): from where, how fast, how long. */
function voiceRead(
  e: PerfRow,
  midi: number | null,
  length: number,
  offset: number,
  detune: number,
  glide: GlideSpec | null,
  sr: number,
  sus: boolean,
): Pick<NotePlan, 'row' | 'semis' | 'start' | 'length' | 'extend' | 'copy' | 'ratio' | 'cut' | 'glide'> {
  const semis = midi === null || e.midi === null ? 0 : midi - e.midi + (detune - e.tune) / 100;
  const ratio = 2 ** (semis / 12);
  const start = e.start + offset;
  const needIn = Math.trunc(length * ratio) + 64;
  const clean = e.cleanEnd ?? e.frames;
  let srcLen = e.frames;
  let st = start;
  let extend: Extension | null = null;
  if (sus && clean - start < needIn) {
    extend = extension(e, needIn + offset, sr);
    if (extend) {
      srcLen = extend.total;
      st = offset;
    }
  }
  const avail = Math.trunc((srcLen - st - 2) / ratio);
  const len = Math.max(0, Math.min(length, avail));
  let top = ratio;
  if (glide) {
    // the fastest the read moves, for the cut-off (the game takes the whole curve's steepest step)
    const p = new GlidePlayer(glide, sr);
    top = 0;
    for (let i = 0; i < Math.max(1, len); i++) top = Math.max(top, ratio * 2 ** (p.next() / 12));
    glide.top = top;
  }
  const copy = Math.abs(semis) < 1e-4 && !glide && Number.isInteger(st);
  return { row: e, semis, start: st, length: len, extend, copy, ratio, cut: cutFor(top), glide };
}

/** The game's extend(): whether a sustain needs its loop, and the shape of the lengthened source. */
function extension(e: PerfRow, need: number, sr: number): Extension | null {
  const s = e.start;
  const usable = e.cleanEnd ?? e.frames;
  if (e.loopStart === undefined || e.loopEnd === undefined || usable - s >= need) return null;
  const ls = e.loopStart;
  const le = e.loopEnd;
  const rho = e.loopRho ?? 0;
  const xf = rho > 0.9 ? 0.04 : rho > 0.6 ? 0.15 : 0.9;
  const C = Math.min(ns(xf, sr), Math.floor((le - ls) / 3), ls - s);
  let total = le - s;
  let passes = 0;
  while (total < need + C) {
    passes++;
    total += le - ls;
  }
  return { total, ls, le, fade: C, linear: rho > 0.6, passes };
}

// ---- the interpolator ----

const TAPS = 24;
const PHASES = 512;
const kernels = new Map<string, Float64Array>();

/** numpy's kaiser window (np.kaiser, an exact Bessel I0 series). */
function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 500; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** The key the game files an interpolator's filter under: its cut-off to three places. */
export const cutKey = (cut: number) => (roundHalfEven(cut * 1000) / 1000).toFixed(3);

/** The interpolator's filters at a cut-off: per phase (513 of them), 48 taps of a windowed sinc. */
export function kernelFor(cut: number): Float64Array {
  const key = String(cut);
  let k = kernels.get(key);
  if (k) return k;
  const c = cut;
  const N = 2 * TAPS + 1;
  const w = new Float64Array(N);
  const i0 = besselI0(9);
  for (let n = 0; n < N; n++) {
    const r = (2 * n) / (N - 1) - 1;
    w[n] = besselI0(9 * Math.sqrt(Math.max(0, 1 - r * r))) / i0;
  }
  k = new Float64Array((PHASES + 1) * 2 * TAPS);
  for (let ph = 0; ph <= PHASES; ph++) {
    const fr = ph / PHASES;
    for (let j = 0; j < 2 * TAPS; j++) {
      const d = j - TAPS + 1 - fr;
      // the window, linearly interpolated at d (np.interp over −24..24)
      const pos = d + TAPS;
      const i = Math.floor(pos);
      const f = pos - i;
      const win = i >= N - 1 ? (w[N - 1] as number) : (w[i] as number) + ((w[i + 1] as number) - (w[i] as number)) * f;
      const arg = c * d;
      const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
      k[ph * 2 * TAPS + j] = c * sinc * win;
    }
  }
  kernels.set(key, k);
  return k;
}

// ---- playing a plan ----

/** A sample's two channels (a mono file plays on both). */
export type SampleData = [Float32Array, Float32Array];

/**
 * A planned note, sounding: reads its source through the interpolator and lays its samples, set in
 * the stereo field, into the output from `plan.at` on. What the note holds constant in its gain is
 * worked out once here (the same expressions as the game's, on the same inputs); gain() leaves
 * each sample's in `g`, since a call that returns a double boxes it unless inlined.
 */
export class PlanVoice {
  readonly plan: NotePlan;
  done = false;
  private readonly srcL: Float32Array;
  private readonly srcR: Float32Array;
  private readonly kernel: Float64Array | null;
  private readonly sr: number;
  private i = 0;
  // (a number a sample writes is declared with a value: made by a later assignment, V8 keeps it boxed)
  private pos = 0;
  /** A glide's read so far (the running sum of its steps). */
  private run = 0;
  private readonly glide: GlidePlayer | null;
  private readonly gl: number;
  private readonly gr: number;
  /** The sample's gain gain() made. */
  private g = 0;
  // ---- short notes: the fade in, the damping and the end ramp
  private readonly fadeDen: number;
  private readonly rampAt: number;
  private readonly rampDen: number;
  // ---- sustains: the dynamics, shape and envelope
  private readonly dynGainConst: number;
  private readonly dynLast: number;
  private readonly swellOn: boolean;
  private readonly durMax: number;
  private readonly taperOn: boolean;
  private readonly taperA: number;
  private readonly taperB: number;
  private readonly attackOn: boolean;
  private readonly legatoDen: number;
  private readonly startDen: number;
  private readonly relTau: number;

  constructor(plan: NotePlan, data: SampleData, sr: number) {
    this.plan = plan;
    this.sr = sr;
    if (plan.extend) {
      const [l, r] = lengthened(data, plan.row, plan.extend, sr);
      this.srcL = l;
      this.srcR = r;
    } else {
      this.srcL = data[0];
      this.srcR = data[1];
    }
    this.kernel = plan.copy ? null : kernelFor(plan.cut);
    this.pos = plan.start;
    this.glide = plan.glide ? new GlidePlayer(plan.glide, sr) : null;
    if (plan.pan) {
      // a stereo source panned at constant power and made up by 1.4142 (the game's to_stereo: not quite √2)
      const a = ((plan.pan + 1) * Math.PI) / 4;
      // biome-ignore lint/suspicious/noApproximativeNumericConstant: the game's own constant, kept for parity
      const makeUp = 1.4142;
      this.gl = Math.cos(a) * makeUp;
      this.gr = Math.sin(a) * makeUp;
    } else {
      this.gl = 1;
      this.gr = 1;
    }
    this.fadeDen = Math.max(1, plan.fadeIn - 1);
    this.rampAt = plan.length - plan.endRamp;
    this.rampDen = Math.max(1, plan.endRamp - 1);
    const s = plan.sus;
    this.dynGainConst =
      s?.dynConst !== null && s?.dynConst !== undefined ? undb(-20 * (1 - clip01(s.dynConst)) ** 1.25) : 0;
    this.dynLast = s ? Math.max(0, s.dynN - 1) : 0;
    this.swellOn = !!(s?.shape?.swell && s.n > ns(0.4, sr));
    this.durMax = s ? Math.max(s.dur, 1e-3) : 1;
    this.taperOn = !!(s?.shape?.taper && s.n > ns(0.5, sr));
    this.taperA = s ? 0.7 * s.dur : 0;
    this.taperB = s ? 0.3 * s.dur : 1;
    this.attackOn = !!(s?.shape?.attack && s.legatoK === 0);
    this.legatoDen = s ? Math.max(1, s.legatoK - 1) : 1;
    this.startDen = s ? Math.max(1, s.startK - 1) : 1;
    this.relTau = s ? Math.max(s.rel / 3, 1e-3) : 1;
  }

  /** One interpolated frame of the source at the current read position. */
  private read(out: Float64Array): void {
    const L = this.srcL;
    const R = this.srcR;
    const n = L.length;
    if (!this.kernel) {
      const s = this.pos;
      out[0] = L[s] as number;
      out[1] = R[s] as number;
      return;
    }
    const p = this.pos;
    const ip = Math.floor(p);
    const fr = p - ip;
    const ph = Math.floor(fr * PHASES + 0.5);
    const k = this.kernel;
    const base = ph * 2 * TAPS;
    let al = 0;
    let ar = 0;
    if (ip - TAPS + 1 < 0 || ip + TAPS >= n) {
      for (let j = 0; j < 2 * TAPS; j++) {
        const s = ip + j - TAPS + 1;
        if (s >= 0 && s < n) {
          al += (L[s] as number) * (k[base + j] as number);
          ar += (R[s] as number) * (k[base + j] as number);
        }
      }
    } else {
      const s0 = ip - TAPS + 1;
      for (let j = 0; j < 2 * TAPS; j++) {
        al += (L[s0 + j] as number) * (k[base + j] as number);
        ar += (R[s0 + j] as number) * (k[base + j] as number);
      }
    }
    out[0] = Math.fround(al);
    out[1] = Math.fround(ar);
  }

  private readonly frame = new Float64Array(2);

  /** The note's own gain at sample `i` (its velocity, dynamics, envelope, release), into `g`. */
  private gain(): void {
    const p = this.plan;
    const sr = this.sr;
    const i = this.i;
    if (!p.sus) {
      let g = p.gain;
      if (p.fadeIn && i < p.fadeIn) g *= Math.fround(0.5 - 0.5 * Math.cos((Math.PI * i) / this.fadeDen));
      if (p.damp && i >= p.damp.n) g *= Math.fround(Math.exp(-(i - p.damp.n) / sr / p.damp.tau));
      if (p.endRamp && i >= this.rampAt) {
        const j = i - this.rampAt;
        g *= Math.fround(1 - j / this.rampDen);
      }
      this.g = g;
      return;
    }
    const s = p.sus;
    let dynGain: number;
    if (s.dynConst !== null) dynGain = this.dynGainConst;
    else {
      // the part's curve at this sample (curveAt, in line), held past the note's length
      const c = s.dyn as PerfCurve;
      const ts = c.t;
      const vs = c.v;
      const t = s.dynT0 + Math.min(i, this.dynLast) / sr;
      const last = ts.length - 1;
      let v: number;
      if (t < (ts[0] as number)) v = vs[0] as number;
      else if (t > (ts[last] as number)) v = vs[last] as number;
      else {
        let lo = 0;
        let hi = ts.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if ((ts[mid] as number) <= t) lo = mid + 1;
          else hi = mid;
        }
        const idx = Math.max(0, Math.min(last - 1, lo - 1));
        const t0 = ts[idx] as number;
        const t1 = ts[idx + 1] as number;
        let u = (t - t0) / Math.max(t1 - t0, 1e-9);
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        u = 0.5 - 0.5 * Math.cos(Math.PI * u);
        v = (vs[idx] as number) + ((vs[idx + 1] as number) - (vs[idx] as number)) * u;
      }
      let d = v + s.dynOffset;
      d = d < 0 ? 0 : d > 1 ? 1 : d;
      dynGain = 10 ** ((-20 * (1 - d) ** 1.25) / 20);
    }
    let env = 1;
    if (s.shape) {
      const tt = i / sr;
      if (this.swellOn) {
        let u = tt / this.durMax;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        env *= 1 + s.shape.swell * (Math.sin(Math.PI * u) ** 1.4 - 0.35);
      }
      if (this.taperOn) {
        let u = (tt - this.taperA) / this.taperB;
        u = u < 0 ? 0 : u > 1 ? 1 : u;
        env *= 10 ** ((-s.shape.taper * u) / 20);
      }
      if (this.attackOn) {
        let c = tt / s.shape.attack;
        c = c < 0 ? 0 : c > 1 ? 1 : c;
        env *= (c * c * (3 - 2 * c)) ** 0.8;
      }
    }
    if (s.legatoK && i < s.legatoK) env = Math.sin((HALF_PI * i) / this.legatoDen) ** 2;
    else if (s.startK && i < s.startK) env = i / this.startDen;
    if (i >= s.n) {
      const t = (i - s.n) / sr;
      let c = t / s.tail;
      c = c < 0 ? 0 : c > 1 ? 1 : c;
      env *= Math.exp(-t / this.relTau) * Math.cos(c * HALF_PI);
    }
    this.g = p.gain * Math.fround(dynGain * env);
  }

  /** On by `count` samples without sounding them (the read position and a glide move on as they would). */
  skip(count: number): void {
    const p = this.plan;
    const k = Math.min(count, p.length - this.i);
    if (this.glide) {
      // a glide's read is a running sum: step by step
      for (let j = 0; j < k; j++) {
        this.i++;
        this.glide.step();
        this.run += p.ratio * 2 ** (this.glide.s / 12);
        this.pos = Math.min(p.start + this.run, this.srcL.length - 1);
      }
    } else if (k > 0) {
      // a plain read's position is a function of the sample: straight there
      this.i += k;
      this.pos = p.copy ? this.pos + k : p.start + this.i * p.ratio;
    }
    if (this.i >= p.length) this.done = true;
  }

  /** Its next `count` samples, added into l and r from `offset`. False once it has finished. */
  play(l: Float32Array, r: Float32Array, offset: number, count: number): boolean {
    const p = this.plan;
    const w = p.width;
    const f = this.frame;
    for (let o = offset; o < offset + count; o++) {
      if (this.i >= p.length) {
        this.done = true;
        return false;
      }
      this.read(f);
      this.gain();
      const g = this.g;
      let a = Math.fround((f[0] as number) * g);
      let b = Math.fround((f[1] as number) * g);
      if (w !== 1) {
        const mid = Math.fround(0.5 * Math.fround(a + b));
        const side = Math.fround(Math.fround(0.5 * Math.fround(a - b)) * w);
        a = Math.fround(mid + side);
        b = Math.fround(mid - side);
      }
      l[o] = (l[o] as number) + Math.fround(a * this.gl * p.stemGain);
      r[o] = (r[o] as number) + Math.fround(b * this.gr * p.stemGain);
      // on through the source
      this.i++;
      if (this.glide) {
        this.glide.step();
        this.run += p.ratio * 2 ** (this.glide.s / 12);
        this.pos = Math.min(p.start + this.run, this.srcL.length - 1);
      } else if (p.copy) this.pos += 1;
      else this.pos = p.start + this.i * p.ratio;
    }
    if (this.i >= p.length) this.done = true;
    return !this.done;
  }

  /** Song frames [from, to) into l and r from `offset`: joins late if it began before `from`. */
  render(l: Float32Array, r: Float32Array, from: number, to: number, offset = 0): boolean {
    const p = this.plan;
    if (p.at + this.i < from) this.skip(from - p.at - this.i);
    const begin = Math.max(from, p.at + this.i);
    if (begin < to && !this.done) this.play(l, r, offset + begin - from, to - begin);
    return !this.done;
  }
}

/**
 * Lengthened sources, each made once: a sustain's loop is seconds of audio, copied and measured,
 * and every note on the same sample with the same extension would make the same one again at the
 * frame it starts. Keyed by the sample's data (gone with it) and the extension's shape.
 */
const lengthenedCache = new WeakMap<Float32Array, Map<string, SampleData>>();

export function lengthened(data: SampleData, e: PerfRow, x: Extension, sr: number): SampleData {
  let byShape = lengthenedCache.get(data[0]);
  if (!byShape) {
    byShape = new Map();
    lengthenedCache.set(data[0], byShape);
  }
  const key = `${e.start}|${x.total}|${x.ls}|${x.le}|${x.fade}|${x.linear ? 1 : 0}|${x.passes}|${sr}`;
  let made = byShape.get(key);
  if (!made) {
    made = lengthen(data, e, x, sr);
    byShape.set(key, made);
  }
  return made;
}

/** Make every lengthened source a part's plans will need, ahead of their notes (their data at hand). */
export function prepareLengthened(
  plans: NotePlan[],
  dataFor: (sample: number) => SampleData | undefined,
  sr: number,
): void {
  for (const p of plans) {
    if (!p.extend) continue;
    const data = dataFor(p.row.sample);
    if (data) lengthened(data, p.row, p.extend, sr);
  }
}

/** The game's extend(), made: the sample from its start, its loop played on with matched joins. */
function lengthen(data: SampleData, e: PerfRow, x: Extension, sr: number): SampleData {
  const { ls, le, fade: C, linear, passes } = x;
  const s = e.start;
  const W = ns(0.4, sr);
  const rms = (ch: Float32Array[], a: number, b: number) => {
    let acc = 0;
    for (const c of ch) for (let i = a; i < b; i++) acc += (c[i] as number) ** 2;
    return Math.sqrt(acc / (ch.length * (b - a)) + 1e-12);
  };
  const ratio = Math.min(2, Math.max(0.5, rms(data, le - W, le) / rms(data, ls, ls + W)));
  const B = le - ls;
  const out: SampleData = [new Float32Array(x.total), new Float32Array(x.total)];
  for (let c = 0; c < 2; c++) {
    const src = data[c] as Float32Array;
    const dst = out[c] as Float32Array;
    dst.set(src.subarray(s, le), 0);
    let at = le - s;
    for (let k = 0; k < passes; k++) {
      // the stretch before ends in a join: out with it, in with the loop's lead-in
      for (let j = 0; j < C; j++) {
        const t = C > 1 ? j / (C - 1) : 0;
        const fo = linear ? 1 - t : Math.cos((t * Math.PI) / 2);
        const fi = linear ? t : Math.sin((t * Math.PI) / 2);
        const pre = Math.fround((src[ls - C + j] as number) * ratio);
        dst[at - C + j] = Math.fround(Math.fround((dst[at - C + j] as number) * fo) + Math.fround(pre * fi));
      }
      for (let j = 0; j < B; j++) {
        const ramp = Math.fround(ratio + ((1 - ratio) * j) / Math.max(1, B - 1));
        dst[at + j] = Math.fround((src[ls + j] as number) * ramp);
      }
      at += B;
    }
  }
  return out;
}
