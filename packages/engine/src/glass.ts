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
const smoothstep = (x: number) => {
  const c = clip01(x);
  return c * c * (3 - 2 * c);
};
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

/** The game's time-varying TPT state-variable filter (nb.svf), one sample at a time. */
class Svf {
  private ic1 = 0;
  private ic2 = 0;
  private readonly k: number;
  private readonly mode: number;
  private readonly sr: number;
  constructor(q: number, mode: number, sr: number) {
    this.k = 1 / q;
    this.mode = mode;
    this.sr = sr;
  }
  run(x: number, fc: number): number {
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
    if (this.mode === 0) return v2;
    if (this.mode === 1) return v1;
    if (this.mode === 2) return x - k * v1 - v2;
    return x - k * v1;
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
        const v = f.run(r.standardNormal(), f0);
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

/** A planned glass note, sounding. */
export class GlassVoice {
  done = false;
  private readonly p: GlassPlan;
  private readonly sr: number;
  private readonly acc: Float64Array;
  private readonly svf: Svf;
  private readonly noise: NumpyRandom | null;
  private readonly gl: number;
  private readonly gr: number;
  private i = 0;
  constructor(plan: GlassPlan, sr: number) {
    this.p = plan;
    this.sr = sr;
    this.acc = new Float64Array(plan.rods.length);
    this.svf = new Svf(35, 1, sr);
    this.noise = plan.noise ? NumpyRandom.resume(plan.noise) : null;
    const a = ((plan.pan + 1) * Math.PI) / 4;
    // a mono voice: cos and sin, no make-up (the game's to_stereo for one channel)
    this.gl = plan.pan ? Math.cos(a) : Math.cos(Math.PI / 4);
    this.gr = plan.pan ? Math.sin(a) : Math.sin(Math.PI / 4);
  }

  private sample(): number {
    const p = this.p;
    const sr = this.sr;
    const i = this.i;
    const t = i / sr;
    const vib = 1 + 0.0015 * Math.sin(2 * Math.PI * p.vibRate * t + p.vibPhase) * smoothstep((t - 0.4) / 0.8);
    let y = 0;
    p.rods.forEach((rod, k) => {
      this.acc[k] = (this.acc[k] as number) + rod.freq * vib;
      const ph = (2 * Math.PI * (this.acc[k] as number)) / sr + rod.phase0;
      const decay = Number.isFinite(rod.tau) ? Math.exp(-t / rod.tau) : 1;
      y += rod.amp * Math.sin(ph) * decay;
    });
    if (this.noise) y += p.breath * 0.15 * this.svf.run(this.noise.standardNormal(), p.f0) * p.noiseScale;
    let env = smoothstep(t / Math.max(p.attack, 1e-3));
    if (p.relStart < p.n / sr && t >= p.relStart) env *= Math.exp(-(t - p.relStart) / Math.max(p.release / 4, 1e-3));
    env *= 1 + p.trem * 0.15 * Math.sin(2 * Math.PI * p.tremRate * t + p.tremPhase);
    return y * env * p.level;
  }

  /** On by `count` samples unheard (its oscillators and breath run on, as they would have). */
  skip(count: number): void {
    const k = Math.min(count, this.p.n - this.i);
    for (let j = 0; j < k; j++) {
      this.sample();
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
      const y = this.sample() * p.gain;
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
        const v = f.run(r.standardNormal(), Math.min(8000, Math.max(60, line.freq(j))));
        s += v;
        s2 += v * v;
      }
      const mean = s / n;
      plan.noiseScale = 1 / (Math.sqrt(Math.max(0, s2 / n - mean * mean)) + 1e-9);
    }
    return plan;
  });
}

/** A phrase's pitch and level at each sample: each note glides in over `glide` seconds, centred on its time. */
class LineState {
  private readonly p: GlassLinePlan;
  private readonly sr: number;
  constructor(p: GlassLinePlan, sr: number) {
    this.p = p;
    this.sr = sr;
  }
  semiLvl(i: number): [number, number] {
    const p = this.p;
    const t = i / this.sr;
    const first = p.notes[0] as { p: number; lvl: number };
    let semi = first.p;
    let lvl = first.lvl;
    for (let k = 1; k < p.notes.length; k++) {
      const cur = p.notes[k] as { t: number; p: number; lvl: number };
      const prev = p.notes[k - 1] as { p: number; lvl: number };
      const a = cur.t - p.glide * 0.5;
      const u = smoothstep((t - a) / p.glide);
      semi += (cur.p - prev.p) * u;
      lvl += (cur.lvl - prev.lvl) * u;
    }
    return [semi, lvl];
  }
  freq(i: number): number {
    const p = this.p;
    const t = i / this.sr;
    const [semi] = this.semiLvl(i);
    return hz(semi) * (1 + p.vibDepth * Math.sin(2 * Math.PI * p.vibRate * t) * smoothstep((t - 0.6) / 1.0));
  }
}

export class GlassLineVoice {
  done = false;
  private readonly p: GlassLinePlan;
  private readonly sr: number;
  private readonly line: LineState;
  private readonly acc: Float64Array;
  private readonly svf: Svf;
  private readonly noise: NumpyRandom | null;
  private readonly gl: number;
  private readonly gr: number;
  private i = 0;
  constructor(plan: GlassLinePlan, sr: number) {
    this.p = plan;
    this.sr = sr;
    this.line = new LineState(plan, sr);
    this.acc = new Float64Array(plan.rods.length);
    this.svf = new Svf(30, 1, sr);
    this.noise = plan.noise ? NumpyRandom.resume(plan.noise) : null;
    const a = ((plan.pan + 1) * Math.PI) / 4;
    this.gl = Math.cos(a);
    this.gr = Math.sin(a);
  }

  private sample(): number {
    const p = this.p;
    const sr = this.sr;
    const i = this.i;
    const t = i / sr;
    const f = this.line.freq(i);
    let y = 0;
    p.rods.forEach((rod, k) => {
      this.acc[k] = (this.acc[k] as number) + f * rod.mult;
      y += rod.amp * Math.sin((2 * Math.PI * (this.acc[k] as number)) / sr + rod.phase0);
    });
    if (this.noise) {
      const nz = this.svf.run(this.noise.standardNormal(), Math.min(8000, Math.max(60, f)));
      y += p.breath * 0.15 * nz * p.noiseScale;
    }
    let env = smoothstep(t / Math.max(p.attack, 1e-3));
    if (p.relStart < p.n / sr && t >= p.relStart) env *= Math.exp(-(t - p.relStart) / Math.max(p.release / 4, 1e-3));
    const [, lvl] = this.line.semiLvl(i);
    return y * env * lvl * 0.3;
  }

  /** On by `count` samples unheard (its line and breath run on, as they would have). */
  skip(count: number): void {
    const k = Math.min(count, this.p.n - this.i);
    for (let j = 0; j < k; j++) {
      this.sample();
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
      const y = this.sample() * p.gain;
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
