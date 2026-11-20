/**
 * What Prism's window draws, worked out away from the drawing: the four source tiles and the morph
 * pad between them, each modulator's shape as points, the matrix's links as rows, and the words for
 * what a link does. Pure, so it's tested without a canvas.
 */
import { bend, type PrismPatch } from '@holo/engine';
import {
  PER_FX,
  PER_SOURCE,
  PRISM_AMP_SPREADS,
  PRISM_FX_PARAMS,
  PRISM_KINDS,
  PRISM_MOD_SOURCES,
  PRISM_MOD_TARGETS,
  PRISM_PARTIAL_SETS,
  PRISM_PITCH_SPREADS,
  PRISM_SAMPLES,
  PRISM_WAVES,
  prismTargetName,
  SRC_CONTROL,
  SRC_ENV,
  SRC_LFO,
  SRC_MACRO,
  SRC_SEQ,
  SRC_SHAPE,
  TGT_FX,
} from '@holo/session';

/** Each source's color (the four corners), and each kind of modulator's. */
export const SOURCE_COLORS = ['#5ec8ff', '#ff9d5c', '#b48cff', '#6fe0a2'];
export const MOD_COLORS = {
  note: '#d7dde8',
  macro: '#ffd166',
  control: '#9aa4b5',
  lfo: '#5ec8ff',
  env: '#ff7a8a',
  shape: '#b48cff',
  seq: '#6fe0a2',
};

/** A matrix source's family, for its color. */
export function sourceFamily(src: number): keyof typeof MOD_COLORS {
  if (src >= SRC_SEQ) return 'seq';
  if (src >= SRC_SHAPE) return 'shape';
  if (src >= SRC_ENV) return 'env';
  if (src >= SRC_LFO) return 'lfo';
  if (src >= SRC_CONTROL) return 'control';
  if (src >= SRC_MACRO) return 'macro';
  return 'note';
}

// ---- the morph pad -------------------------------------------------------------------------------------

/** How much of each corner the morph point hears (1 top left, 2 top right, 3 bottom left, 4 bottom right). */
export function padWeights(x: number, y: number, power: boolean): [number, number, number, number] {
  const w: [number, number, number, number] = [(1 - x) * (1 - y), x * (1 - y), (1 - x) * y, x * y];
  return power ? (w.map(Math.sqrt) as [number, number, number, number]) : w;
}

export interface OverviewLayout {
  w: number;
  h: number;
  /** The pad, a square in the middle (phone: under the tiles). */
  pad: { x: number; y: number; s: number };
  /** The four tiles, in source order. */
  tiles: { x: number; y: number; w: number; h: number }[];
}

/** Where the tiles and the pad go at a width (narrow: the tiles in two rows, the pad under them). */
export function overviewLayout(width: number): OverviewLayout {
  const gap = 8;
  if (width < 470) {
    const tw = (width - gap) / 2;
    const th = 92;
    const s = Math.min(150, width - 40);
    const tiles = [0, 1, 2, 3].map((i) => ({
      x: (i % 2) * (tw + gap),
      y: Math.floor(i / 2) * (th + gap),
      w: tw,
      h: th,
    }));
    return { w: width, h: th * 2 + gap * 2 + s, pad: { x: (width - s) / 2, y: th * 2 + gap * 2, s }, tiles };
  }
  const s = Math.min(176, Math.round(width * 0.3));
  const tw = (width - s - gap * 2) / 2;
  const th = (s - gap) / 2;
  const tiles = [0, 1, 2, 3].map((i) => ({
    x: i % 2 ? tw + s + gap * 2 : 0,
    y: Math.floor(i / 2) * (th + gap),
    w: tw,
    h: th,
  }));
  return { w: width, h: s, pad: { x: tw + gap, y: 0, s }, tiles };
}

/** What's under a point of the overview: a tile (its source), the pad (with its x and y), or nothing. */
export function hitOverview(
  L: OverviewLayout,
  px: number,
  py: number,
): { tile: number } | { pad: [number, number] } | null {
  const { pad } = L;
  if (px >= pad.x && px <= pad.x + pad.s && py >= pad.y && py <= pad.y + pad.s)
    return { pad: [(px - pad.x) / pad.s, (py - pad.y) / pad.s] };
  for (let i = 0; i < L.tiles.length; i++) {
    const t = L.tiles[i] as OverviewLayout['tiles'][number];
    if (px >= t.x && px <= t.x + t.w && py >= t.y && py <= t.y + t.h) return { tile: i };
  }
  return null;
}

// ---- a source in words ---------------------------------------------------------------------------------

/** A source in a few words ("7 saws, detuned", "Bell partials", "Grains of air"). */
export function sourceSummary(p: PrismPatch, s: number, media?: number): string {
  const sp = p.src[s];
  if (!sp?.on) return 'Off';
  const fromPack = media ? 'the pack' : 'the pack (none here)';
  switch (sp.kind) {
    case 0: {
      const wave = sp.custom > 0 ? `wave ${sp.custom}` : (PRISM_WAVES[sp.wave] ?? '').toLowerCase();
      const n = Math.max(1, Math.round(sp.count));
      const spread = PRISM_PITCH_SPREADS[sp.pitch >= 0.5 ? sp.pitchb : sp.pitcha] ?? '';
      if (n === 1) return `One ${wave}`;
      return `${n} ${wave}${wave.endsWith('s') ? '' : 's'}, ${spread.toLowerCase()}`;
    }
    case 1:
      return `${sp.data === 0 ? `Partials from ${fromPack}` : `${PRISM_PARTIAL_SETS[sp.data - 1] ?? ''} partials`}`;
    case 2:
      return sp.data === 0 ? `Sample from ${fromPack}` : `${PRISM_SAMPLES[sp.data - 1] ?? ''} sample`;
    default:
      return sp.data === 0
        ? `Grains from ${fromPack}`
        : `Grains of ${(PRISM_SAMPLES[sp.data - 1] ?? '').toLowerCase()}`;
  }
}

export const kindName = (kind: number) => PRISM_KINDS[kind] ?? '';
export const ampSpreadName = (shape: number) => PRISM_AMP_SPREADS[shape] ?? '';

// ---- modulators as points -----------------------------------------------------------------------------------

/**
 * An LFO's shape over `cycles` cycles as n points (−1…1), as it plays: the random ones drawn from a
 * fixed sequence (only the look of them), a custom one from its points.
 */
export function lfoPoints(shape: number, custom: number[] | null, cycles: number, n: number): number[] {
  const out: number[] = [];
  let seed = 7;
  const draw = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed / 2147483647) * 2 - 1;
  };
  const steps: number[] = [];
  for (let c = 0; c <= Math.ceil(cycles) + 1; c++) steps.push(draw());
  for (let i = 0; i < n; i++) {
    const t = (i / (n - 1)) * cycles;
    const c = Math.floor(t);
    const p = t - c;
    let v: number;
    if (custom && custom.length >= 2) {
      const x = p * custom.length;
      const j = Math.floor(x);
      const a = custom[j % custom.length] as number;
      const b = custom[(j + 1) % custom.length] as number;
      v = a + (b - a) * (x - j);
    } else
      switch (shape) {
        case 0:
          v = Math.sin(2 * Math.PI * p);
          break;
        case 1:
          v = p < 0.25 ? 4 * p : p < 0.75 ? 2 - 4 * p : 4 * p - 4;
          break;
        case 2:
          v = 2 * p - 1;
          break;
        case 3:
          v = 1 - 2 * p;
          break;
        case 4:
          v = p < 0.5 ? 1 : -1;
          break;
        case 5:
          v = steps[c] as number;
          break;
        default: {
          const a = steps[c] as number;
          const b = steps[c + 1] as number;
          v = a + (b - a) * p;
        }
      }
    out.push(Math.max(-1, Math.min(1, v)));
  }
  return out;
}

/** An envelope's power for a curve value (as the engine bends its stages). */
const power = (c: number) => (c >= 0 ? 4 ** -c : 1 - 2 * c);

/**
 * An envelope as points (time in seconds, level 0…1): attack, hold, decay to the sustain, the sustain
 * held for `held` seconds, then the release.
 */
export function envPoints(
  e: { a: number; h: number; d: number; s: number; r: number; ac: number; dc: number; rc: number },
  held: number,
  per = 24,
): [number, number][] {
  const out: [number, number][] = [[0, 0]];
  let t = 0;
  for (let i = 1; i <= per; i++) out.push([t + (e.a * i) / per, (i / per) ** power(e.ac)]);
  t += e.a;
  if (e.h > 0) {
    t += e.h;
    out.push([t, 1]);
  }
  for (let i = 1; i <= per; i++) out.push([t + (e.d * i) / per, e.s + (1 - e.s) * (1 - i / per) ** power(-e.dc)]);
  t += e.d;
  t += held;
  out.push([t, e.s]);
  for (let i = 1; i <= per; i++) out.push([t + (e.r * i) / per, e.s * (1 - i / per) ** power(-e.rc)]);
  return out;
}

/** A drawn shape (or a curve) as points along its stretches, each bent as the engine bends it. */
export function shapePoints(x: ArrayLike<number>, y: ArrayLike<number>, c: ArrayLike<number>, n: number, per = 12) {
  const out: [number, number][] = [];
  for (let k = 0; k < n; k++) {
    const x0 = x[k] as number;
    const y0 = y[k] as number;
    if (k === n - 1) {
      out.push([x0, y0]);
      break;
    }
    const x1 = x[k + 1] as number;
    const y1 = y[k + 1] as number;
    for (let i = 0; i < per; i++) {
      const u = i / per;
      out.push([x0 + (x1 - x0) * u, y0 + (y1 - y0) * bend(u, c[k] as number)]);
    }
  }
  return out;
}

// ---- the matrix as rows ---------------------------------------------------------------------------------------

export interface LinkRow {
  /** The link's slot (0…31). */
  slot: number;
  src: number;
  dst: number;
  depth: number;
  via: number;
  srcName: string;
  dstName: string;
  /** What the depth does, in the target's own terms ("+12 st", "×0.5 level"). */
  amount: string;
  color: string;
}

/** The links that do anything, in slot order. */
export function linkRows(p: PrismPatch): LinkRow[] {
  const types = p.fx.map((f) => Math.round(f.type ?? 0));
  const out: LinkRow[] = [];
  p.mod.forEach((m, slot) => {
    if (m.src <= 0 || m.src >= PRISM_MOD_SOURCES.length || !PRISM_MOD_TARGETS[m.dst]) return;
    out.push({
      slot,
      src: m.src,
      dst: m.dst,
      depth: m.depth,
      via: m.via,
      srcName: PRISM_MOD_SOURCES[m.src] ?? '',
      dstName: prismTargetName(m.dst, types),
      amount: depthText(m.dst, m.depth, types),
      color: MOD_COLORS[sourceFamily(m.src)],
    });
  });
  return out;
}

/** A depth on a target in its own terms: a share of its range in its unit (in octaves where it's heard so). */
export function depthText(dst: number, depth: number, fxTypes?: readonly number[]): string {
  const t = PRISM_MOD_TARGETS[dst];
  if (!t) return '';
  const sign = depth > 0 ? '+' : depth < 0 ? '−' : '';
  const a = Math.abs(depth);
  if (t.kind === 'mul') return `${sign}${Math.round(a * 100)}% of the way`;
  if (t.log) {
    const oct = a * Math.log2(t.max / t.min);
    return `${sign}${oct >= 10 ? oct.toFixed(0) : oct.toFixed(1)} oct`;
  }
  if (dst >= TGT_FX && fxTypes) {
    const j = (dst - TGT_FX) % PER_FX;
    const type = fxTypes[Math.floor((dst - TGT_FX) / PER_FX)] ?? 0;
    const def = j > 0 ? PRISM_FX_PARAMS[type]?.[j - 1] : undefined;
    if (def?.log) return `${sign}${(a * Math.log2(def.max / def.min)).toFixed(1)} oct`;
  }
  const span = (t.max - t.min) * a;
  if (t.unit === 'st') return `${sign}${span >= 10 ? span.toFixed(0) : span.toFixed(1)} st`;
  if (t.unit) return `${sign}${span.toFixed(span >= 10 ? 0 : 1)} ${t.unit}`;
  return `${sign}${Math.round(a * 100)}%`;
}

/** Which of a source's targets a target is (−1: not a source's). */
export function sourceOfTarget(dst: number): number {
  return dst < PER_SOURCE * 4 ? Math.floor(dst / PER_SOURCE) : -1;
}

/** The first link slot nothing uses, or −1. */
export function freeSlot(p: PrismPatch): number {
  return p.mod.findIndex((m) => m.src <= 0);
}
