/**
 * Glass: Hallowed Lanterns' bowed-glass voices (hlaudio.electro.glass and glass_line), note for
 * note. A pure fundamental and a few soft partials, each from two rods a few cents apart beating
 * slowly, a faint inharmonic shimmer, a breath of bow noise through a narrow band pass at the note,
 * a slow tremolo; glass_line sings phrases, sliding from note to note. Their random choices are the
 * game's own draws, so they sound the same here.
 *
 * A note's breath is levelled by its own loudness over the whole note, so a note is planned (its
 * noise run once and measured) where the song is compiled; its voice then plays it sample by sample.
 */
import { roundHalfEven } from './performance.ts';
import { NumpyRandom, namedRandom } from './random.ts';

const clip01 = (x: number) => (x < 0 ? 0 : x > 1 ? 1 : x);
const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);
const vgain = (v: number, range: number) => 10 ** ((-range * (1 - clip01(v)) ** 1.3) / 20);

export interface GlassNote {
  t: number;
  d: number;
  p: number;
  v: number;
  x?: Record<string, unknown>;
}

export interface GlassOptions {
  gain?: number;
  seed?: number;
  attack?: number;
  release?: number;
  bright?: number;
  panSpread?: number;
  breath?: number;
  detune?: number;
  trem?: number;
}

/**
 * The game's time-varying TPT state-variable filter (nb.svf), one sample at a time, for planning a
 * note's breath (its voice runs the same filter in line). The sample is left in `out`.
 */
class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private readonly k: number;
  private readonly mode: number;
  private readonly sr: number;
  out = 0;
  constructor(q: number, mode: number, sr: number) {
    this.k = 1 / q;
    this.mode = mode;
    this.sr = sr;
  }
  run(x: number, fc: number): void {
    let f = fc;
    if (f < 10) f = 10;
    if (f > 0.45 * this.sr) f = 0.45 * this.sr;
    const g = Math.tan((Math.PI * f) / this.sr);
    const k = this.k;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    if (this.mode === 0) this.out = v2;
    else if (this.mode === 1) this.out = v1;
    else if (this.mode === 2) this.out = x - k * v1 - v2;
    else this.out = x - k * v1;
  }
}

/** One partial's rod: its frequency step, phase, and how its amplitude dies (∞: it doesn't). */
interface Rod {
  freq: number;
  amp: number;
  phase0: number;
  tau: number;
}

export interface GlassPlan {
  /** Output frame of its first sample. */
  at: number;
  n: number;
  f0: number;
  attack: number;
  /** When its release begins (s) and how long it rings. */
  relStart: number;
  release: number;
  vibRate: number;
  vibPhase: number;
  rods: Rod[];
  /** The breath: its noise stream (saved where it starts), and the level that evens it. */
  breath: number;
  noise: number[] | null;
  noiseScale: number;
  tremRate: number;
  tremPhase: number;
  trem: number;
  level: number;
  gain: number;
  pan: number;
}

/** Plan a part of glass notes as the game's glass() renders them (notes in seconds). */
export function planGlass(notes: GlassNote[], o: GlassOptions, sr: number): GlassPlan[] {
  const seed = o.seed ?? 0;
  const attackDef = o.attack ?? 0.35;
  const releaseDef = o.release ?? 2.5;
  const bright = o.bright ?? 1;
  const panSpread = o.panSpread ?? 0.6;
  const breath = o.breath ?? 0.15;
  const detune = o.detune ?? 4;
  const trem = o.trem ?? 0.25;
  const r0 = namedRandom('glass', seed);
  const sorted = notes
    .map((nt, i) => ({ nt, i }))
    .sort((a, b) => a.nt.t - b.nt.t || a.i - b.i)
    .map((o2) => o2.nt);
  return sorted.map((nt, i) => {
    const r = namedRandom('glass', seed, i);
    const x = nt.x ?? {};
    const a = (x.attack as number | undefined) ?? attackDef;
    const rel = (x.release as number | undefined) ?? releaseDef;
    const n = roundHalfEven((nt.d + rel * 1.5) * sr);
    const f0 = hz(nt.p);
    const vibRate = r.uniform(4.2, 5.2);
    const vibPhase = r.uniform(0, 6);
    const parts: [number, number][] = [
      [1, 1],
      [2, 0.28 * bright],
      [3, 0.09 * bright],
      [4, 0.035 * bright],
      [2.76, 0.03 * bright],
    ];
    const rods: Rod[] = [];
    parts.forEach(([ratio, amp], k) => {
      const f = f0 * ratio;
      if (f > 9000) return;
      for (const d of [-1, 1]) {
        const fd = f * 2 ** ((d * detune * r.uniform(0.6, 1.2)) / 1200);
        const phase0 = r.uniform(0, 6);
        const tau = k === 0 ? Number.POSITIVE_INFINITY : 2.5 + 2 * r.uniform();
        rods.push({ freq: fd, amp: 0.5 * amp, phase0, tau });
      }
    });
    let noise: number[] | null = null;
    let noiseScale = 0;
    if (breath) {
      // the breath's stream from here; run it once to find the level that evens it
      noise = r.save();
      const f = new Svf(35, 1, sr);
      let s = 0;
      let s2 = 0;
      for (let j = 0; j < n; j++) {
        r.drawNormal();
        f.run(r.drawn, f0);
        const v = f.out;
        s += v;
        s2 += v * v;
      }
      const mean = s / n;
      const std = Math.sqrt(Math.max(0, s2 / n - mean * mean));
      noiseScale = 1 / (std + 1e-9);
    }
    const tremRate = r.uniform(0.25, 0.6);
    const tremPhase = r.uniform(0, 6);
    const panDraw = r0.uniform(-panSpread, panSpread);
    const pan = (x.pan as number | undefined) ?? panDraw;
    return {
      at: roundHalfEven(nt.t * sr),
      n,
      f0,
      attack: a,
      relStart: nt.d,
      release: rel,
      vibRate,
      vibPhase,
      rods,
      breath,
      noise,
      noiseScale,
      tremRate,
      tremPhase,
      trem,
      level: vgain(nt.v, 16) * 0.3,
      gain: o.gain ?? 1,
      pan: Math.min(1, Math.max(-1, pan)),
    };
  });
}

const TAU = 2 * Math.PI;

/**
 * A planned glass note, sounding. Its sample is made in line and left in `y`: in a loop this busy a
 * call V8 doesn't inline boxes every double it passes or returns, a heap allocation each sample,
 * so the rods are arrays, the filter is its own fields, and what the note holds constant is worked
 * out once (the same expressions as the game's, on the same inputs).
 */
export class GlassVoice {
  done = false;
  private readonly p: GlassPlan;
  private readonly sr: number;
  private readonly acc: Float64Array;
  private readonly rodFreq: Float64Array;
  private readonly rodAmp: Float64Array;
  private readonly rodPhase0: Float64Array;
  private readonly rodTau: Float64Array;
  /** Which rods die away (the fundamental's don't). */
  private readonly rodDecays: Uint8Array;
  /** The breath's band pass (nb.svf at the note, mode 1), its coefficients fixed by the note's pitch. */
  private readonly svfA1: number;
  private readonly svfA2: number;
  private readonly svfA3: number;
  private ic1 = 0;
  private ic2 = 0;
  private readonly noise: NumpyRandom | null;
  private readonly vibW: number;
  private readonly tremW: number;
  private readonly tremAmt: number;
  private readonly breathAmt: number;
  private readonly attack: number;
  private readonly releases: boolean;
  private readonly relTau: number;
  private readonly gl: number;
  private readonly gr: number;
  /** The last sample sample() made. */
  private y = 0;
  private i = 0;
  constructor(plan: GlassPlan, sr: number) {
    this.p = plan;
    this.sr = sr;
    const rods = plan.rods;
    this.acc = new Float64Array(rods.length);
    this.rodFreq = new Float64Array(rods.length);
    this.rodAmp = new Float64Array(rods.length);
    this.rodPhase0 = new Float64Array(rods.length);
    this.rodTau = new Float64Array(rods.length);
    this.rodDecays = new Uint8Array(rods.length);
    rods.forEach((rod, k) => {
      this.rodFreq[k] = rod.freq;
      this.rodAmp[k] = rod.amp;
      this.rodPhase0[k] = rod.phase0;
      this.rodTau[k] = rod.tau;
      this.rodDecays[k] = Number.isFinite(rod.tau) ? 1 : 0;
    });
    // the filter's coefficients (Svf.run with q 35 at f0, which never moves)
    let f = plan.f0;
    if (f < 10) f = 10;
    if (f > 0.45 * sr) f = 0.45 * sr;
    const g = Math.tan((Math.PI * f) / sr);
    const k = 1 / 35;
    this.svfA1 = 1 / (1 + g * (g + k));
    this.svfA2 = g * this.svfA1;
    this.svfA3 = g * this.svfA2;
    this.noise = plan.noise ? NumpyRandom.resume(plan.noise) : null;
    this.vibW = 2 * Math.PI * plan.vibRate;
    this.tremW = 2 * Math.PI * plan.tremRate;
    this.tremAmt = plan.trem * 0.15;
    this.breathAmt = plan.breath * 0.15;
    this.attack = Math.max(plan.attack, 1e-3);
    this.releases = plan.relStart < plan.n / sr;
    this.relTau = Math.max(plan.release / 4, 1e-3);
    const a = ((plan.pan + 1) * Math.PI) / 4;
    // a mono voice: cos and sin, no make-up (the game's to_stereo for one channel)
    this.gl = plan.pan ? Math.cos(a) : Math.cos(Math.PI / 4);
    this.gr = plan.pan ? Math.sin(a) : Math.sin(Math.PI / 4);
  }

  /** The rods on by one sample at the vibrato's factor on their frequencies (the time from `i`: no double passed). */
  private advance(): void {
    const t = this.i / this.sr;
    let c = (t - 0.4) / 0.8;
    c = c < 0 ? 0 : c > 1 ? 1 : c;
    const vib = 1 + 0.0015 * Math.sin(this.vibW * t + this.p.vibPhase) * (c * c * (3 - 2 * c));
    const acc = this.acc;
    const freq = this.rodFreq;
    for (let k = 0; k < acc.length; k++) acc[k] = (acc[k] as number) + (freq[k] as number) * vib;
  }

  /** The breath's filtered noise for one sample, into `b` (the band pass's state moves on). */
  private b = 0;
  private breath(): void {
    const noise = this.noise as NumpyRandom;
    noise.drawNormal();
    const x = noise.drawn;
    const v3 = x - this.ic2;
    const v1 = this.svfA1 * this.ic1 + this.svfA2 * v3;
    const v2 = this.ic2 + this.svfA2 * this.ic1 + this.svfA3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.b = v1;
  }

  private sample(): void {
    const p = this.p;
    const sr = this.sr;
    const t = this.i / sr;
    this.advance();
    let y = 0;
    const acc = this.acc;
    for (let k = 0; k < acc.length; k++) {
      const ph = (TAU * (acc[k] as number)) / sr + (this.rodPhase0[k] as number);
      const decay = this.rodDecays[k] ? Math.exp(-t / (this.rodTau[k] as number)) : 1;
      y += (this.rodAmp[k] as number) * Math.sin(ph) * decay;
    }
    if (this.noise) {
      this.breath();
      y += this.breathAmt * this.b * p.noiseScale;
    }
    let c = t / this.attack;
    c = c < 0 ? 0 : c > 1 ? 1 : c;
    let env = c * c * (3 - 2 * c);
    if (this.releases && t >= p.relStart) env *= Math.exp(-(t - p.relStart) / this.relTau);
    env *= 1 + this.tremAmt * Math.sin(this.tremW * t + p.tremPhase);
    this.y = y * env * p.level;
  }

  /** On by `count` samples unheard: only what carries state moves (the rods' phases, the breath's stream and filter). */
  skip(count: number): void {
    const k = Math.min(count, this.p.n - this.i);
    for (let j = 0; j < k; j++) {
      this.advance();
      if (this.noise) this.breath();
      this.i++;
    }
    if (this.i >= this.p.n) this.done = true;
  }

  /** Its next `count` samples, added into l and r from `offset`. False once it has finished. */
  play(l: Float32Array, r: Float32Array, offset: number, count: number): boolean {
    const p = this.p;
    for (let o = offset; o < offset + count; o++) {
      if (this.i >= p.n) {
        this.done = true;
        return false;
      }
      this.sample();
      const y = this.y * p.gain;
      l[o] = (l[o] as number) + Math.fround(y * this.gl);
      r[o] = (r[o] as number) + Math.fround(y * this.gr);
      this.i++;
    }
    if (this.i >= p.n) this.done = true;
    return !this.done;
  }

  /** Song frames [from, to) into l and r from `offset`: joins late if it began before `from`. */
  render(l: Float32Array, r: Float32Array, from: number, to: number, offset = 0): boolean {
    const p = this.p;
    if (p.at + this.i < from) this.skip(from - p.at - this.i);
    const begin = Math.max(from, p.at + this.i);
    if (begin < to && !this.done) this.play(l, r, offset + begin - from, to - begin);
    return !this.done;
  }
}

// ---- glass_line: a singing line that slides between touching notes ----

export interface GlassLineOptions {
  gain?: number;
  seed?: number;
  glide?: number;
  attack?: number;
  release?: number;
  bright?: number;
  pan?: number;
  gap?: number;
  vib?: number;
  breath?: number;
}

export interface GlassLinePlan {
  at: number;
  n: number;
  /** The phrase's notes, relative to its start (s), and the glide between them. */
  notes: { t: number; p: number; lvl: number }[];
  glide: number;
  vibRate: number;
  vibDepth: number;
  rods: { mult: number; amp: number; phase0: number }[];
  breath: number;
  noise: number[] | null;
  noiseScale: number;
  attack: number;
  relStart: number;
  release: number;
  gain: number;
  pan: number;
}

/** The game's lines.phrases(): notes into phrases, a new one after a gap. */
function phrases<T extends { t: number; d: number }>(notes: T[], gap: number): T[][] {
  const sorted = notes
    .map((n, i) => ({ n, i }))
    .sort((a, b) => a.n.t - b.n.t || a.i - b.i)
    .map((o) => o.n);
  const out: T[][] = [];
  let cur: T[] = [];
  for (const n of sorted) {
    const last = cur[cur.length - 1];
    if (last && n.t - (last.t + last.d) > gap) {
      out.push(cur);
      cur = [];
    }
    cur.push(n);
  }
  if (cur.length) out.push(cur);
  return out;
}

export function planGlassLine(notes: GlassNote[], o: GlassLineOptions, sr: number): GlassLinePlan[] {
  const seed = o.seed ?? 0;
  const glide = o.glide ?? 0.45;
  const attack = o.attack ?? 0.6;
  const release = o.release ?? 3;
  const bright = o.bright ?? 0.8;
  const breath = o.breath ?? 0.12;
  return phrases(notes, o.gap ?? 0.6).map((ph, pi) => {
    const r = namedRandom('glassline', seed, pi);
    const first = ph[0] as GlassNote;
    const t0 = first.t;
    const end = Math.max(...ph.map((n) => n.t + n.d));
    const n = roundHalfEven((end - t0 + release * 1.5) * sr);
    const rel = ph.map((nt) => ({ t: nt.t - t0, p: nt.p, lvl: vgain(nt.v, 16) }));
    const vibRate = r.uniform(4.0, 5.0);
    const rods: { mult: number; amp: number; phase0: number }[] = [];
    for (const [ratio, amp] of [
      [1, 1],
      [2, 0.3 * bright],
      [3, 0.1 * bright],
      [4, 0.04 * bright],
    ] as [number, number][]) {
      for (const d of [-1, 1])
        rods.push({ mult: ratio * 2 ** ((d * 3.5) / 1200), amp: 0.5 * amp, phase0: r.uniform(0, 6) });
    }
    const plan: GlassLinePlan = {
      at: roundHalfEven(t0 * sr),
      n,
      notes: rel,
      glide,
      vibRate,
      vibDepth: o.vib ?? 0.003,
      rods,
      breath,
      noise: null,
      noiseScale: 0,
      attack,
      relStart: end - t0,
      release,
      gain: o.gain ?? 1,
      pan: o.pan ?? 0,
    };
    if (breath) {
      plan.noise = r.save();
      const f = new Svf(30, 1, sr);
      const line = new LineState(plan, sr);
      let s = 0;
      let s2 = 0;
      for (let j = 0; j < n; j++) {
        line.at(j);
        r.drawNormal();
        f.run(r.drawn, Math.min(8000, Math.max(60, line.f)));
        const v = f.out;
        s += v;
        s2 += v * v;
      }
      const mean = s / n;
      plan.noiseScale = 1 / (Math.sqrt(Math.max(0, s2 / n - mean * mean)) + 1e-9);
    }
    return plan;
  });
}

/**
 * A phrase's pitch and level at each sample: each note glides in over `glide` seconds, centred on
 * its time. at(i) leaves the semitone, level and frequency in fields (a call that returns a double
 * boxes it unless inlined; a tuple would be an allocation).
 */
class LineState {
  private readonly p: GlassLinePlan;
  private readonly sr: number;
  private readonly noteT: Float64Array;
  private readonly noteP: Float64Array;
  private readonly noteLvl: Float64Array;
  private readonly vibW: number;
  semi = 0;
  lvl = 0;
  f = 0;
  constructor(p: GlassLinePlan, sr: number) {
    this.p = p;
    this.sr = sr;
    this.noteT = Float64Array.from(p.notes, (n) => n.t);
    this.noteP = Float64Array.from(p.notes, (n) => n.p);
    this.noteLvl = Float64Array.from(p.notes, (n) => n.lvl);
    this.vibW = 2 * Math.PI * p.vibRate;
  }
  /** Sample i's semitone and level (the game's semi_lvl), and its frequency with the vibrato on it. */
  at(i: number): void {
    const p = this.p;
    const t = i / this.sr;
    const noteT = this.noteT;
    const noteP = this.noteP;
    const noteLvl = this.noteLvl;
    let semi = noteP[0] as number;
    let lvl = noteLvl[0] as number;
    for (let k = 1; k < noteT.length; k++) {
      const a = (noteT[k] as number) - p.glide * 0.5;
      let c = (t - a) / p.glide;
      c = c < 0 ? 0 : c > 1 ? 1 : c;
      const u = c * c * (3 - 2 * c);
      semi += ((noteP[k] as number) - (noteP[k - 1] as number)) * u;
      lvl += ((noteLvl[k] as number) - (noteLvl[k - 1] as number)) * u;
    }
    this.semi = semi;
    this.lvl = lvl;
    let c = (t - 0.6) / 1.0;
    c = c < 0 ? 0 : c > 1 ? 1 : c;
    this.f = 440 * 2 ** ((semi - 69) / 12) * (1 + p.vibDepth * Math.sin(this.vibW * t) * (c * c * (3 - 2 * c)));
  }
}

/** A planned glass_line phrase, sounding (its sample made in line, as GlassVoice's). */
export class GlassLineVoice {
  done = false;
  private readonly p: GlassLinePlan;
  private readonly sr: number;
  private readonly line: LineState;
  private readonly acc: Float64Array;
  private readonly rodMult: Float64Array;
  private readonly rodAmp: Float64Array;
  private readonly rodPhase0: Float64Array;
  /** The breath's band pass (nb.svf, q 30, mode 1), following the line. */
  private ic1 = 0;
  private ic2 = 0;
  private readonly noise: NumpyRandom | null;
  private readonly breathAmt: number;
  private readonly attack: number;
  private readonly releases: boolean;
  private readonly relTau: number;
  private readonly gl: number;
  private readonly gr: number;
  /** The last sample sample() made, and the last breath breath() made. */
  private y = 0;
  private b = 0;
  private i = 0;
  constructor(plan: GlassLinePlan, sr: number) {
    this.p = plan;
    this.sr = sr;
    this.line = new LineState(plan, sr);
    const rods = plan.rods;
    this.acc = new Float64Array(rods.length);
    this.rodMult = Float64Array.from(rods, (r) => r.mult);
    this.rodAmp = Float64Array.from(rods, (r) => r.amp);
    this.rodPhase0 = Float64Array.from(rods, (r) => r.phase0);
    this.noise = plan.noise ? NumpyRandom.resume(plan.noise) : null;
    this.breathAmt = plan.breath * 0.15;
    this.attack = Math.max(plan.attack, 1e-3);
    this.releases = plan.relStart < plan.n / sr;
    this.relTau = Math.max(plan.release / 4, 1e-3);
    const a = ((plan.pan + 1) * Math.PI) / 4;
    this.gl = Math.cos(a);
    this.gr = Math.sin(a);
  }

  /** The line at this sample, and the rods on by one sample at its frequency. */
  private advance(): void {
    const line = this.line;
    line.at(this.i);
    const f = line.f;
    const acc = this.acc;
    const mult = this.rodMult;
    for (let k = 0; k < acc.length; k++) acc[k] = (acc[k] as number) + f * (mult[k] as number);
  }

  /** The breath's filtered noise for one sample, into `b` (Svf.run at the line's frequency, within 60..8000). */
  private breath(): void {
    const noise = this.noise as NumpyRandom;
    noise.drawNormal();
    const x = noise.drawn;
    const sr = this.sr;
    let f = Math.min(8000, Math.max(60, this.line.f));
    if (f < 10) f = 10;
    if (f > 0.45 * sr) f = 0.45 * sr;
    const g = Math.tan((Math.PI * f) / sr);
    const k = 1 / 30;
    const a1 = 1 / (1 + g * (g + k));
    const a2 = g * a1;
    const a3 = g * a2;
    const v3 = x - this.ic2;
    const v1 = a1 * this.ic1 + a2 * v3;
    const v2 = this.ic2 + a2 * this.ic1 + a3 * v3;
    this.ic1 = 2 * v1 - this.ic1;
    this.ic2 = 2 * v2 - this.ic2;
    this.b = v1;
  }

  private sample(): void {
    const p = this.p;
    const sr = this.sr;
    const t = this.i / sr;
    this.advance();
    let y = 0;
    const acc = this.acc;
    for (let k = 0; k < acc.length; k++) {
      y += (this.rodAmp[k] as number) * Math.sin((TAU * (acc[k] as number)) / sr + (this.rodPhase0[k] as number));
    }
    if (this.noise) {
      this.breath();
      y += this.breathAmt * this.b * p.noiseScale;
    }
    let c = t / this.attack;
    c = c < 0 ? 0 : c > 1 ? 1 : c;
    let env = c * c * (3 - 2 * c);
    if (this.releases && t >= p.relStart) env *= Math.exp(-(t - p.relStart) / this.relTau);
    this.y = y * env * this.line.lvl * 0.3;
  }

  /** On by `count` samples unheard: only what carries state moves (the rods' phases, the breath's stream and filter). */
  skip(count: number): void {
    const k = Math.min(count, this.p.n - this.i);
    for (let j = 0; j < k; j++) {
      this.advance();
      if (this.noise) this.breath();
      this.i++;
    }
    if (this.i >= this.p.n) this.done = true;
  }

  /** Its next `count` samples, added into l and r from `offset`. False once it has finished. */
  play(l: Float32Array, r: Float32Array, offset: number, count: number): boolean {
    const p = this.p;
    for (let o = offset; o < offset + count; o++) {
      if (this.i >= p.n) {
        this.done = true;
        return false;
      }
      this.sample();
      const y = this.y * p.gain;
      l[o] = (l[o] as number) + Math.fround(y * this.gl);
      r[o] = (r[o] as number) + Math.fround(y * this.gr);
      this.i++;
    }
    if (this.i >= p.n) this.done = true;
    return !this.done;
  }

  /** Song frames [from, to) into l and r from `offset`: joins late if it began before `from`. */
  render(l: Float32Array, r: Float32Array, from: number, to: number, offset = 0): boolean {
    const p = this.p;
    if (p.at + this.i < from) this.skip(from - p.at - this.i);
    const begin = Math.max(from, p.at + this.i);
    if (begin < to && !this.done) this.play(l, r, offset + begin - from, to - begin);
    return !this.done;
  }
}
