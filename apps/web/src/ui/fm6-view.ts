/**
 * The six-operator synth's window, as numbers: where the matrix's cells sit and what each one sets,
 * how an envelope is laid out across its canvas, and the filter's response. Kept apart from the
 * drawing, so it is tested without a page.
 */
import { FM6_ENV_POINTS, FM6_OPS } from '@holo/session';

/** Each operator's color, the same in the matrix and on its envelope. */
export const OP_COLORS = ['#5cb8ff', '#4fd6c0', '#7ee08a', '#ffd75e', '#ffaa5c', '#ff8cc6'];
/** The filter's color, and pitch's. */
export const FILTER_COLOR = '#a58bff';
export const PITCH_COLOR = '#e4e8ef';

// ---- the matrix ----------------------------------------------------------------------------------

/**
 * The matrix: a row for what swings (the six operators, then the filter), a column for what it
 * swings (the six), then a column for the output and one for the filter's input. Each operator sits
 * where its row meets its column, so a link reads as a wire along its source's row and down its
 * target's column; the filter sits where its row meets the filter's column.
 */
export const COLS = FM6_OPS + 2;
export const ROWS = FM6_OPS + 1;
export const COL_OUT = FM6_OPS;
export const COL_FILTER = FM6_OPS + 1;
export const ROW_FILTER = FM6_OPS;

export type Cell =
  /** An operator (its own feedback is dragged there). */
  | { kind: 'node'; op: number }
  /** One operator (or the filter, `from` 6) swinging another. */
  | { kind: 'mod'; from: number; to: number }
  /** How much of an operator is heard. */
  | { kind: 'out'; op: number }
  /** How much of an operator goes into the filter. */
  | { kind: 'send'; op: number }
  /** How much of the filter is heard. */
  | { kind: 'filterOut' }
  | { kind: 'filter' };

export function cellAt(row: number, col: number): Cell {
  if (row === ROW_FILTER) {
    if (col === COL_OUT) return { kind: 'filterOut' };
    if (col === COL_FILTER) return { kind: 'filter' };
    return { kind: 'mod', from: FM6_OPS, to: col };
  }
  if (col === COL_OUT) return { kind: 'out', op: row };
  if (col === COL_FILTER) return { kind: 'send', op: row };
  if (row === col) return { kind: 'node', op: row };
  return { kind: 'mod', from: row, to: col };
}

/** The patch key a cell sets (an operator's node: its feedback), or null for the filter's. */
export function cellKey(c: Cell): string | null {
  switch (c.kind) {
    case 'node':
      return `mod:${c.op + 1}>${c.op + 1}`;
    case 'mod':
      return `mod:${c.from === FM6_OPS ? 'f' : c.from + 1}>${c.to + 1}`;
    case 'out':
      return `op${c.op + 1}:out`;
    case 'send':
      return `op${c.op + 1}:filter`;
    case 'filterOut':
      return 'flt:out';
    default:
      return null;
  }
}

/** A cell's name, for its readout and its undo step. */
export function cellName(c: Cell): string {
  switch (c.kind) {
    case 'node':
      return `Operator ${c.op + 1} feedback`;
    case 'mod':
      return `${c.from === FM6_OPS ? 'Filter' : c.from + 1} → ${c.to + 1}`;
    case 'out':
      return `Operator ${c.op + 1} out`;
    case 'send':
      return `Operator ${c.op + 1} into the filter`;
    case 'filterOut':
      return 'Filter out';
    default:
      return 'Filter';
  }
}

/** The most a cell's amount goes to: radians of phase for a link, a level for an output or a send. */
export function cellMax(c: Cell): number {
  return c.kind === 'node' || c.kind === 'mod' ? 32 : 4;
}

export interface MatrixLayout {
  /** Its top-left cell's corner, a cell's width and height, and the whole. */
  x0: number;
  y0: number;
  cw: number;
  ch: number;
  w: number;
  h: number;
}

/** The matrix in a canvas `width` wide: cells as wide as fit, up to 60 px, a little less tall. */
export function matrixLayout(width: number): MatrixLayout {
  const cw = Math.max(30, Math.min(60, Math.floor((width - 8) / COLS)));
  const ch = Math.round(cw * 0.74);
  const head = 18;
  const foot = 18;
  const w = width;
  const x0 = Math.round((width - cw * COLS) / 2);
  return { x0, y0: head, cw, ch, w, h: head + ch * ROWS + foot };
}

export function cellCenter(L: MatrixLayout, row: number, col: number): [number, number] {
  return [L.x0 + (col + 0.5) * L.cw, L.y0 + (row + 0.5) * L.ch];
}

/** The cell under a point, or null. */
export function hitCell(L: MatrixLayout, x: number, y: number): [number, number] | null {
  const col = Math.floor((x - L.x0) / L.cw);
  const row = Math.floor((y - L.y0) / L.ch);
  return col >= 0 && col < COLS && row >= 0 && row < ROWS ? [row, col] : null;
}

/** A drag's travel (0–1) for an amount, and back: cubed, so the small amounts most sounds use get most of it. */
export const amountToUnit = (a: number, max: number): number => Math.cbrt(Math.min(1, Math.abs(a) / max));
export const unitToAmount = (u: number, max: number): number => max * Math.min(1, Math.max(0, u)) ** 3;

/** An amount as its readout shows it. */
export function formatAmount(a: number): string {
  const m = Math.abs(a);
  return m === 0 ? '0' : m < 0.1 ? a.toFixed(3) : m < 10 ? a.toFixed(2) : a.toFixed(1);
}

// ---- envelopes -------------------------------------------------------------------------------------

/** An envelope as the patch has it (see packages/session/src/fm6.ts). */
export interface EnvShape {
  n: number;
  start: number;
  t: number[];
  l: number[];
  c: number[];
  sus: number;
  loop: number;
}

/** An envelope curve (-1…1) as the ratio its stretch moves by, as the engine works it out. */
export function curveRatio(c: number): number {
  const s = Math.min(0.999, Math.max(0.001, (c + 1) / 2));
  const x = s > 0.5 ? s * (4 - 2 * s) - 1 : 2 * s * s;
  return (1 / x - 1) ** 2;
}

/** Where a stretch is, `u` (0–1) of the way along it from `y0` to `y1`, bent by its curve. */
export function along(y0: number, y1: number, c: number, u: number): number {
  const r = curveRatio(c);
  if (Math.abs(r - 1) < 1e-5) return y0 + (y1 - y0) * u;
  const A = (y1 - r * y0) / (1 - r);
  return A + (y0 - A) * r ** u;
}

/** A stretch's width in the drawing for its time: a millisecond shows, a minute doesn't crowd out the rest. */
export const segWidth = (t: number): number => Math.log1p(Math.max(0, t) / 0.01);
export const timeOf = (w: number): number => 0.01 * Math.expm1(Math.max(0, w));

/** The share of the width the held part takes, between the sustain point and the release. */
const HELD = 0.14;

export interface EnvLayout {
  /** Pixels per unit of width (see segWidth), and the held part's span (or null). */
  px: number;
  held: [number, number] | null;
  /** Where it starts, and each point. */
  start: [number, number];
  points: [number, number][];
  /** The height of level 1, the pixels a level of 1 covers, and the lowest level shown (0, or -1). */
  top: number;
  unit: number;
  bottom: number;
}

export function envBipolar(e: EnvShape): boolean {
  if (e.start < 0) return true;
  for (let k = 0; k < e.n; k++) if ((e.l[k] as number) < 0) return true;
  return false;
}

/**
 * An envelope across a canvas: each stretch as wide as its time (segWidth), the held part a fixed
 * share after the sustain point. `px` keeps a scale (a drag's, so the point stays under the pointer).
 */
export function envLayout(
  e: EnvShape,
  width: number,
  height: number,
  bipolar: boolean,
  px?: number,
  pad = 12,
): EnvLayout {
  const n = Math.min(FM6_ENV_POINTS, Math.max(1, e.n));
  const holds = e.sus >= 0 && e.sus < n - 1;
  let total = 0;
  for (let k = 0; k < n; k++) total += segWidth(e.t[k] as number);
  const room = width - 2 * pad - (holds ? width * HELD : 0);
  const scale = px ?? room / Math.max(total, 1.5);
  const bottom = bipolar ? -1 : 0;
  const top = pad;
  const unit = (height - 2 * pad) / (1 - bottom);
  const L: EnvLayout = { px: scale, held: null, start: [pad, 0], points: [], top, unit, bottom };
  L.start[1] = envY(L, e.start);
  let x = pad;
  for (let k = 0; k < n; k++) {
    x += segWidth(e.t[k] as number) * scale;
    L.points.push([x, envY(L, e.l[k] as number)]);
    if (holds && k === e.sus) {
      L.held = [x, x + width * HELD];
      x += width * HELD;
    }
  }
  return L;
}

/** The height of a level in a layout. */
export const envY = (L: EnvLayout, v: number): number => L.top + (1 - Math.min(1, Math.max(L.bottom, v))) * L.unit;

/** The level at a height in a layout. */
export const levelAt = (L: EnvLayout, py: number): number => Math.min(1, Math.max(L.bottom, 1 - (py - L.top) / L.unit));

/** Points along the drawn envelope: each stretch bent as it plays, the held part flat. */
export function envPath(e: EnvShape, L: EnvLayout, steps = 24): [number, number][] {
  const out: [number, number][] = [L.start];
  let px = L.start[0];
  let level = e.start;
  for (let k = 0; k < L.points.length; k++) {
    const [qx, qy] = L.points[k] as [number, number];
    const to = e.l[k] as number;
    const c = e.c[k] as number;
    for (let s = 1; s < steps; s++) {
      const u = s / steps;
      out.push([px + (qx - px) * u, envY(L, along(level, to, c, u))]);
    }
    out.push([qx, qy]);
    px = qx;
    level = to;
    if (L.held && k === e.sus) {
      out.push([L.held[1], qy]);
      px = L.held[1];
    }
  }
  return out;
}

/**
 * The keys that put a new point into an envelope after point `at` (-1: before the first), halfway
 * along that stretch in time and level, with the sustain and loop points moved along with it.
 */
export function insertPoint(e: EnvShape, at: number, prefix: string): Record<string, number> | null {
  if (e.n >= FM6_ENV_POINTS) return null;
  const k = at + 1;
  const out: Record<string, number> = {};
  const t = [...e.t];
  const l = [...e.l];
  const c = [...e.c];
  const from = k === 0 ? e.start : (l[k - 1] as number);
  const half = (t[k] ?? 0.1) / 2;
  const mid = k < e.n ? along(from, l[k] as number, c[k] as number, 0.5) : from;
  t.splice(k, 0, k < e.n ? half : 0.2);
  l.splice(k, 0, mid);
  c.splice(k, 0, c[k] ?? 0);
  if (k < e.n) t[k + 1] = half;
  const n = e.n + 1;
  for (let j = 0; j < n; j++) {
    out[`${prefix}:t${j}`] = t[j] as number;
    out[`${prefix}:l${j}`] = l[j] as number;
    out[`${prefix}:c${j}`] = c[j] as number;
  }
  out[`${prefix}:n`] = n;
  if (e.sus >= k) out[`${prefix}:sus`] = e.sus + 1;
  if (e.loop >= k) out[`${prefix}:loop`] = e.loop + 1;
  return out;
}

/** The keys that take point `k` out of an envelope (its time going to the stretch after it). */
export function removePoint(e: EnvShape, k: number, prefix: string): Record<string, number> | null {
  if (e.n <= 1 || k < 0 || k >= e.n) return null;
  const t = [...e.t];
  const l = [...e.l];
  const c = [...e.c];
  if (k + 1 < e.n) t[k + 1] = (t[k + 1] as number) + (t[k] as number);
  t.splice(k, 1);
  l.splice(k, 1);
  c.splice(k, 1);
  const n = e.n - 1;
  const out: Record<string, number> = { [`${prefix}:n`]: n };
  for (let j = 0; j < n; j++) {
    out[`${prefix}:t${j}`] = t[j] as number;
    out[`${prefix}:l${j}`] = l[j] as number;
    out[`${prefix}:c${j}`] = c[j] as number;
  }
  const shift = (p: number) => (p > k ? p - 1 : p === k ? Math.min(p, n - 1) : p);
  out[`${prefix}:sus`] = e.sus < 0 ? -1 : shift(e.sus);
  out[`${prefix}:loop`] = e.loop < 0 ? -1 : Math.min(shift(e.loop), out[`${prefix}:sus`] as number);
  if ((out[`${prefix}:loop`] as number) >= (out[`${prefix}:sus`] as number)) out[`${prefix}:loop`] = -1;
  return out;
}

// ---- the filter --------------------------------------------------------------------------------------

export interface FilterShape {
  cutoff: number;
  spread: number;
  res1: number;
  res2: number;
  mode1: number;
  mode2: number;
  serial: number;
  mix: number;
  out: number;
}

const modeGains = (m: number): [number, number, number] => (m < 1 ? [1 - m, m, 0] : [0, 2 - m, m - 1]);

/**
 * The filter's response (dB) at each of `freqs`, as the engine's two state-variable filters have it
 * at their cutoffs (no envelope, key or LFO): each the analog filter its trapezoidal form follows,
 * side by side or one into the other, mixed, at the filter's output level.
 */
export function filterResponse(f: FilterShape, freqs: readonly number[], sr: number): number[] {
  const spread = 2 ** (f.spread / 12);
  const lift = Math.min(0.1, Math.max(0, (spread - 1) * 0.3));
  const k1 = 2 - 2 * f.res1;
  const k2 = 2 - 2 * f.res2;
  const gin1 = Math.sqrt(k1 + lift);
  const gin2 = Math.sqrt(k2 + lift);
  const m1 = modeGains(f.mode1);
  const m2 = modeGains(f.mode2);
  const fc1 = Math.min(sr * 0.45, Math.max(1, f.cutoff));
  const fc2 = Math.min(sr * 0.45, Math.max(1, f.cutoff * spread));
  const g1 = Math.tan((Math.PI * fc1) / sr);
  const g2 = Math.tan((Math.PI * fc2) / sr);
  // one filter's response (re, im) at frequency w (tan(πf/sr)) for its g, k and blend
  const one = (w: number, g: number, k: number, m: [number, number, number]): [number, number] => {
    const s = w / g; // s = j·s
    // denominator: 1 - s² + j·k·s
    const dr = 1 - s * s;
    const di = k * s;
    const dd = dr * dr + di * di;
    // numerator: m0 + m1·(j s) + m2·(j s)² = (m0 - m2 s²) + j·m1·s
    const numRe = m[0] - m[2] * s * s;
    const numIm = m[1] * s;
    return [(numRe * dr + numIm * di) / dd, (numIm * dr - numRe * di) / dd];
  };
  return freqs.map((hz) => {
    const w = Math.tan((Math.PI * Math.min(hz, sr * 0.499)) / sr);
    const [a, b] = one(w, g1, k1, m1);
    const y1r = gin1 * a;
    const y1i = gin1 * b;
    const [c, d] = one(w, g2, k2, m2);
    // filter 2's input: the note's (side by side) or filter 1's (in a row)
    const ur = (1 - f.serial) * gin2 + f.serial * y1r;
    const ui = f.serial * y1i;
    const y2r = c * ur - d * ui;
    const y2i = c * ui + d * ur;
    const yr = f.mix * y2r + (1 - f.mix) * y1r;
    const yi = f.mix * y2i + (1 - f.mix) * y1i;
    const mag = Math.hypot(yr, yi) * f.out;
    return 20 * Math.log10(Math.max(mag, 1e-6));
  });
}
