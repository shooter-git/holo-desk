/**
 * Room Reverb: a room drawn as a floor plan, then left to ring.
 *
 * The early reflections come from the room itself: its walls are a regular polygon (three to eight
 * of them) as wide as Size, with a floor and a ceiling. The sound's images in the walls (each wall's,
 * and each pair's), the floor and the ceiling give every reflection's time (their path at the speed
 * of sound, less the direct path's) and level (one over the distance, a little lost at each wall) at
 * two ears Spread apart; the loudest of them (more with Density) are the taps, smeared by a pair of
 * short diffusers as much as Diffusion asks.
 *
 * The tail is eight delay lines (as long as sound takes to cross the room, give or take) mixed by a
 * Householder matrix, through diffusers that set how fast the echoes thicken. Each line's loop has a
 * three-band decay: Decay for the middle, Low Decay below Crossover, High Decay above about 4 kHz.
 * Two of the lines drift a little, so nothing rings metallic. Then High Cut and Low Level shape the
 * whole, Early / Late weighs the two, and Dry and Wet set the mix.
 */
import { paramValue } from '@holo/session';
import { Biquad } from './dsp.ts';
import type { Effect, Host } from './fx.ts';

/** The speed of sound (m/s). */
const SOUND = 343;
/** How much of the sound a wall gives back (amplitude). */
const WALL = 0.84;
/** The early reflections' level at each ear (the root of their summed energy). */
const ER_LEVEL = 0.4;
/** The tail's lines, as shares of the time sound takes to cross the room. */
const LINE_RATIOS = [0.62, 0.71, 0.79, 0.88, 0.97, 1.07, 1.18, 1.31];
/** Where the High Decay band starts (Hz). */
const HIGH_BAND = 4000;
/** The input diffusers' lengths (ms) at a 14 m room. */
const DIFFUSERS = [4.3, 5.9, 8.7, 11.3];
/** The early reflections' smearing diffusers (ms), left and right (their taps are read that much sooner, where they can be). */
const ER_DIFFUSERS = [
  [1.1, 1.7],
  [1.3, 1.9],
];

/** A reflection at one ear: seconds after the direct sound would arrive, and its level. */
export interface Reflection {
  time: number;
  gain: number;
}

interface Point {
  x: number;
  y: number;
}

/** The room's floor plan (meters, from its middle): its corners, where the sound is, and the two ears. */
export interface RoomPlan {
  corners: { x: number; y: number }[];
  source: { x: number; y: number };
  ears: [{ x: number; y: number }, { x: number; y: number }];
  /** How far a wall is from the middle. */
  apothem: number;
}

export function roomPlan(params: Record<string, number>): RoomPlan {
  const v = (id: string) => paramValue('roomreverb', params, id);
  const walls = Math.round(v('walls'));
  const radius = v('size') / 2;
  const apothem = radius * Math.cos(Math.PI / walls);
  const spread = v('spread') / 100;
  const corners = Array.from({ length: walls }, (_, k) => {
    const a = (2 * Math.PI * k) / walls;
    return { x: radius * Math.sin(a), y: radius * Math.cos(a) };
  });
  const ear = (side: number) => ({ x: side * (0.1 + 0.8 * spread), y: -0.3 * apothem });
  return { corners, source: { x: 0.07 * apothem, y: 0.4 * apothem }, ears: [ear(-1), ear(1)], apothem };
}

/** The room's early reflections at each ear, loudest first trimmed to the taps it uses, in time order. */
export function roomReflections(params: Record<string, number>): { left: Reflection[]; right: Reflection[] } {
  const v = (id: string) => paramValue('roomreverb', params, id);
  const size = v('size');
  const walls = Math.round(v('walls'));
  const plan = roomPlan(params);
  const apothem = plan.apothem;
  const height = Math.min(20, Math.max(2.5, size * 0.35));
  const ear = 1.5;
  // the walls: each one's outward normal and its distance from the middle
  const normals: Point[] = [];
  for (let k = 0; k < walls; k++) {
    const a = (2 * Math.PI * (k + 0.5)) / walls;
    normals.push({ x: Math.sin(a), y: Math.cos(a) });
  }
  const mirror = (p: Point, k: number): Point => {
    const n = normals[k] as Point;
    const d = 2 * (p.x * n.x + p.y * n.y - apothem);
    return { x: p.x - d * n.x, y: p.y - d * n.y };
  };
  const source: Point = plan.source;
  // (images of every order up to two, with the wall that made them: none for the source itself)
  const images: { p: Point; order: number }[] = [{ p: source, order: 0 }];
  for (let k = 0; k < walls; k++) {
    const p = mirror(source, k);
    images.push({ p, order: 1 });
    for (let j = 0; j < walls; j++) if (j !== k) images.push({ p: mirror(p, j), order: 2 });
  }
  const count = 6 + Math.round((26 * v('density')) / 100);
  const at = (side: number): Reflection[] => {
    const e: Point = plan.ears[side < 0 ? 0 : 1];
    const direct = Math.hypot(source.x - e.x, source.y - e.y);
    const all: Reflection[] = [];
    for (const im of images) {
      const flat = Math.hypot(im.p.x - e.x, im.p.y - e.y);
      // the wall image itself (not the source), then each image in the floor and in the ceiling
      const paths: [number, number][] = [
        [flat, im.order],
        [Math.hypot(flat, 2 * ear), im.order + 1],
        [Math.hypot(flat, 2 * (height - ear)), im.order + 1],
      ];
      for (const [d, order] of paths) {
        if (order === 0) continue;
        all.push({ time: (d - direct) / SOUND, gain: (direct / d) * WALL ** order });
      }
    }
    const kept = all.sort((a, b) => b.gain - a.gain).slice(0, count);
    // the same weight of reflections in any room (about a tail's of a second and a half): Early / Late sets how loud they are
    const energy = Math.sqrt(kept.reduce((s, r) => s + r.gain * r.gain, 0)) || 1;
    for (const r of kept) r.gain *= ER_LEVEL / energy;
    return kept.sort((a, b) => a.time - b.time);
  };
  return { left: at(-1), right: at(1) };
}

/** The decay (RT60, s) the tail is set to have at each of `freqs`, as its loops are built. */
export function roomDecay(params: Record<string, number>, freqs: ArrayLike<number>): Float64Array {
  const v = (id: string) => paramValue('roomreverb', params, id);
  const mid = v('decay');
  const low = (mid * v('lowDecay')) / 100;
  const high = (mid * v('highDecay')) / 100;
  const cross = v('crossover');
  const out = new Float64Array(freqs.length);
  for (let i = 0; i < freqs.length; i++) {
    const f = freqs[i] as number;
    // the one-pole bands' shares at f
    const lo = 1 / (1 + (f / cross) ** 2);
    const hi = 1 / (1 + (HIGH_BAND / f) ** 2);
    // (a band's gain per second is what blends: decay rates add)
    const rate = lo / low + hi / high + Math.max(0, 1 - lo - hi) / mid;
    out[i] = 1 / rate;
  }
  return out;
}

/** The smallest prime at or above `n` (the lines' lengths share no factor, so their echoes don't line up). */
function prime(n: number): number {
  let p = Math.max(2, Math.round(n));
  for (;;) {
    let ok = true;
    for (let d = 2; d * d <= p; d++) {
      if (p % d === 0) {
        ok = false;
        break;
      }
    }
    if (ok) return p;
    p++;
  }
}

/** A delay line a power of two long, read back by whole frames. */
class Line {
  readonly buf: Float32Array;
  readonly mask: number;
  w = 0;
  constructor(frames: number) {
    let size = 16;
    while (size < frames + 4) size <<= 1;
    this.buf = new Float32Array(size);
    this.mask = size - 1;
  }
  clear(): void {
    this.buf.fill(0);
  }
}

/** A one-pole low-pass coefficient with its corner at `f`. */
function onePole(f: number, sr: number): number {
  const k = Math.tan((Math.PI * Math.min(f, sr * 0.49)) / sr);
  return k / (1 + k);
}

export class RoomReverb implements Effect {
  gr = 0;
  private readonly pre: Line;
  private readonly lines: Line[];
  private readonly diff: Line[];
  private readonly erDiff: Line[];
  private readonly host: Host;
  /** The early taps: frames after the pre-delay, and gains, per ear. */
  private tapsL = new Int32Array(0);
  private tapsR = new Int32Array(0);
  private gainsL = new Float32Array(0);
  private gainsR = new Float32Array(0);
  private preFrames = 1;
  private readonly lengths = new Int32Array(8);
  private readonly gLo = new Float64Array(8);
  private readonly gMid = new Float64Array(8);
  private readonly gHi = new Float64Array(8);
  private readonly lo = new Float64Array(8);
  private readonly hi = new Float64Array(8);
  private readonly z = new Float64Array(8);
  private diffLen = new Int32Array(4);
  private diffCount = 4;
  private diffGain = 0.5;
  private erLen = new Int32Array(4);
  /** What the reflections were last worked out for (the room and the pre-delay). */
  private room = '';
  private erGain = 0.3;
  private cx = 0;
  private ch = 0;
  private early = 1;
  private late = 1;
  private width = 1;
  private lowGain = 1;
  private dry = 1;
  private wet = 0.25;
  private modDepth = 0;
  /** High Cut, on both sides of what the room gives back. */
  private readonly cut = new Biquad();
  private scratchL = new Float32Array(128);
  private scratchR = new Float32Array(128);
  private shelfL = 0;
  private shelfR = 0;
  /** The drift's oscillator (a rotating pair: no sine a frame). */
  private oc = 1;
  private os = 0;
  private rc = 1;
  private rs = 0;
  constructor(host: Host) {
    this.host = host;
    const sr = host.sr;
    this.pre = new Line(Math.ceil(sr * 0.85));
    this.lines = LINE_RATIOS.map(() => new Line(Math.ceil(sr * 0.26)));
    this.diff = DIFFUSERS.map(() => new Line(Math.ceil(sr * 0.05)));
    this.erDiff = [0, 1, 2, 3].map(() => new Line(Math.ceil(sr * 0.012)));
    this.erLen = Int32Array.from(ER_DIFFUSERS.flat(), (ms) => Math.round((ms / 1000) * sr));
    const turn = (2 * Math.PI * 0.43) / sr;
    this.rc = Math.cos(turn);
    this.rs = Math.sin(turn);
  }
  /** The early taps from the room's plan, after the pre-delay. */
  private reflect(p: Record<string, number>): void {
    const sr = this.host.sr;
    const { left, right } = roomReflections(p);
    const erLen = this.erLen;
    // (each ear's diffusers hold the sound back by their lengths: its taps are read that much sooner)
    const frames = (r: Reflection[], held: number) =>
      Int32Array.from(r, (x) => Math.max(1, this.preFrames + Math.max(1, Math.round(x.time * sr)) - held));
    this.tapsL = frames(left, (erLen[0] as number) + (erLen[1] as number));
    this.tapsR = frames(right, (erLen[2] as number) + (erLen[3] as number));
    this.gainsL = Float32Array.from(left, (x) => x.gain);
    this.gainsR = Float32Array.from(right, (x) => x.gain);
  }
  setParams(p: Record<string, number>): void {
    const v = (id: string) => paramValue('roomreverb', p, id);
    const sr = this.host.sr;
    this.preFrames = Math.max(0, Math.round((v('predelay') / 1000) * sr));
    // (the reflections are worked out again only when the room or the pre-delay changed: a lane
    // moving the decay sets every block)
    const room = `${v('size')} ${v('walls')} ${v('spread')} ${v('density')} ${this.preFrames}`;
    if (room !== this.room) {
      this.room = room;
      this.reflect(p);
    }
    const size = v('size');
    const cross = (size / SOUND) * sr;
    const mid = v('decay');
    const low = (mid * v('lowDecay')) / 100;
    const high = (mid * v('highDecay')) / 100;
    const used = new Set<number>();
    LINE_RATIOS.forEach((ratio, k) => {
      let len = prime(Math.max(0.006 * sr, Math.min(0.25 * sr, cross * ratio)));
      while (used.has(len)) len = prime(len + 1);
      used.add(len);
      this.lengths[k] = len;
      this.gLo[k] = 10 ** ((-3 * len) / (sr * low));
      this.gMid[k] = 10 ** ((-3 * len) / (sr * mid));
      this.gHi[k] = 10 ** ((-3 * len) / (sr * high));
    });
    const scale = Math.min(2.5, Math.max(0.4, Math.sqrt(size / 14)));
    this.diffLen = Int32Array.from(DIFFUSERS, (ms) => Math.round((ms / 1000) * sr * scale));
    this.diffCount = 1 + Math.round((3 * v('density')) / 100);
    this.diffGain = 0.72 * (v('diffusion') / 100);
    this.erGain = 0.55 * (v('diffusion') / 100);
    this.cx = onePole(v('crossover'), sr);
    this.ch = onePole(HIGH_BAND, sr);
    const balance = v('balance') / 100;
    this.early = Math.min(1, 2 * (1 - balance));
    this.late = Math.min(1, 2 * balance);
    this.width = v('spread') / 100;
    this.lowGain = 10 ** (v('lowLevel') / 20);
    const dry = v('dry');
    const wet = v('wet');
    this.dry = dry <= -60 ? 0 : 10 ** (dry / 20);
    this.wet = wet <= -60 ? 0 : 10 ** (wet / 20);
    this.cut.set('lowpass', v('highcut'), Math.SQRT1_2, 0, sr);
    // the drift: a fraction of a millisecond, more in a bigger room
    this.modDepth = Math.min(0.0012, 0.0002 + size * 0.00002) * sr;
  }
  process(l: Float32Array, r: Float32Array, n: number): void {
    const { pre, lines, diff, erDiff, tapsL, tapsR, gainsL, gainsR, lengths, gLo, gMid, gHi, lo, hi, z } = this;
    const { diffLen, diffCount, diffGain, erLen, erGain, cx, ch, early, late, width, lowGain, dry, wet, modDepth } =
      this;
    const pm = pre.mask;
    const pb = pre.buf;
    let { oc, os, shelfL, shelfR } = this;
    const { rc, rs } = this;
    const preFrames = this.preFrames;
    if (this.scratchL.length < n) {
      this.scratchL = new Float32Array(n);
      this.scratchR = new Float32Array(n);
    }
    const sl = this.scratchL;
    const sr = this.scratchR;
    const nl = tapsL.length;
    const nr = tapsR.length;
    for (let i = 0; i < n; i++) {
      const a = l[i] as number;
      const b = r[i] as number;
      const x = (a + b) * 0.5;
      pb[pre.w] = x;
      // the early reflections
      let el = 0;
      let er = 0;
      for (let k = 0; k < nl; k++) el += (pb[(pre.w - (tapsL[k] as number)) & pm] as number) * (gainsL[k] as number);
      for (let k = 0; k < nr; k++) er += (pb[(pre.w - (tapsR[k] as number)) & pm] as number) * (gainsR[k] as number);
      // smeared by two short diffusers a side
      for (let k = 0; k < 4; k++) {
        const line = erDiff[k] as Line;
        const d = line.buf[(line.w - (erLen[k] as number)) & line.mask] as number;
        const input = k < 2 ? el : er;
        const vv = input - erGain * d;
        line.buf[line.w] = vv;
        line.w = (line.w + 1) & line.mask;
        if (k < 2) el = d + erGain * vv;
        else er = d + erGain * vv;
      }
      // into the tail, through its diffusers
      let u = pb[(pre.w - preFrames) & pm] as number;
      pre.w = (pre.w + 1) & pm;
      for (let k = 0; k < diffCount; k++) {
        const line = diff[k] as Line;
        const d = line.buf[(line.w - (diffLen[k] as number)) & line.mask] as number;
        const vv = u - diffGain * d;
        line.buf[line.w] = vv;
        line.w = (line.w + 1) & line.mask;
        u = d + diffGain * vv;
      }
      // the drift
      const c2 = oc * rc - os * rs;
      os = oc * rs + os * rc;
      oc = c2;
      let sum = 0;
      for (let k = 0; k < 8; k++) {
        const line = lines[k] as Line;
        let y: number;
        if (k < 2) {
          const d = (lengths[k] as number) + (k === 0 ? oc : os) * modDepth;
          const pos = line.w - d;
          const fi = Math.floor(pos);
          const f = pos - fi;
          const y0 = line.buf[fi & line.mask] as number;
          const y1 = line.buf[(fi + 1) & line.mask] as number;
          y = y0 + (y1 - y0) * f;
        } else {
          y = line.buf[(line.w - (lengths[k] as number)) & line.mask] as number;
        }
        let low = lo[k] as number;
        let high = hi[k] as number;
        low += (y - low) * cx;
        high += (y - high) * ch;
        lo[k] = low;
        hi[k] = high;
        const m = gMid[k] as number;
        const out = m * y + ((gLo[k] as number) - m) * low + ((gHi[k] as number) - m) * (y - high);
        z[k] = out;
        sum += out;
      }
      const s = sum * 0.25;
      const z0 = z[0] as number;
      const z1 = z[1] as number;
      const z2 = z[2] as number;
      const z3 = z[3] as number;
      const z4 = z[4] as number;
      const z5 = z[5] as number;
      const z6 = z[6] as number;
      const z7 = z[7] as number;
      const inject = u * 0.5;
      for (let k = 0; k < 8; k++) {
        const line = lines[k] as Line;
        line.buf[line.w] = (z[k] as number) - s + (k & 1 ? -inject : inject);
        line.w = (line.w + 1) & line.mask;
      }
      const tl = (z0 - z1 + z2 - z3 + z4 - z5 + z6 - z7) * 0.35;
      const tr = (z0 + z1 - z2 - z3 + z4 + z5 - z6 - z7) * 0.35;
      const mid = (tl + tr) * 0.5;
      const side = (tl - tr) * 0.5 * width;
      let wl = early * el + late * (mid + side);
      let wr = early * er + late * (mid - side);
      // Low Level: the lows below the crossover raised or lowered
      shelfL += (wl - shelfL) * cx;
      shelfR += (wr - shelfR) * cx;
      wl += (lowGain - 1) * shelfL;
      wr += (lowGain - 1) * shelfR;
      sl[i] = wl;
      sr[i] = wr;
    }
    // High Cut on what the room gives back, then the mix
    this.cut.process(sl, sr, n);
    for (let i = 0; i < n; i++) {
      l[i] = (l[i] as number) * dry + (sl[i] as number) * wet;
      r[i] = (r[i] as number) * dry + (sr[i] as number) * wet;
    }
    // (the drift's pair kept on its circle)
    const norm = 1 / Math.sqrt(oc * oc + os * os);
    this.oc = oc * norm;
    this.os = os * norm;
    this.shelfL = Math.abs(shelfL) < 1e-20 ? 0 : shelfL;
    this.shelfR = Math.abs(shelfR) < 1e-20 ? 0 : shelfR;
  }
  reset(): void {
    this.pre.clear();
    for (const line of [...this.lines, ...this.diff, ...this.erDiff]) line.clear();
    this.lo.fill(0);
    this.hi.fill(0);
    this.cut.reset();
    this.shelfL = this.shelfR = 0;
  }
}
