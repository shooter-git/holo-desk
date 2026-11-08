/**
 * Measuring recorded hits and notes (where a hit starts, how loud it is heard, its loudest sample),
 * and spreading velocity layers over velocities 1 to 127 by how loud they really are.
 *
 * Ported from HO[LO] Packs' `tools/lib.mjs` (github.com/shooter-git/holo-packs), which its kit and
 * piano recipes measure their recordings with; the arithmetic is the same step for step, so a kit
 * imported here gets its velocities the way the pinned kits got theirs.
 */

/** A sound's channels (decoded samples, as fractions of full scale). */
export type Channels = readonly ArrayLike<number>[];

type Coefficients = [b0: number, b1: number, b2: number, a1: number, a2: number];

/** RBJ biquad coefficients, normalised. */
function biquad(type: 'highshelf' | 'highpass', f0: number, rate: number, q: number, db = 0): Coefficients {
  const w0 = (2 * Math.PI * f0) / rate;
  const cos = Math.cos(w0);
  const alpha = Math.sin(w0) / (2 * q);
  let b0: number;
  let b1: number;
  let b2: number;
  let a0: number;
  let a1: number;
  let a2: number;
  if (type === 'highshelf') {
    const A = 10 ** (db / 40);
    const s = 2 * Math.sqrt(A) * alpha;
    b0 = A * (A + 1 + (A - 1) * cos + s);
    b1 = -2 * A * (A - 1 + (A + 1) * cos);
    b2 = A * (A + 1 + (A - 1) * cos - s);
    a0 = A + 1 - (A - 1) * cos + s;
    a1 = 2 * (A - 1 - (A + 1) * cos);
    a2 = A + 1 - (A - 1) * cos - s;
  } else {
    b0 = (1 + cos) / 2;
    b1 = -(1 + cos);
    b2 = (1 + cos) / 2;
    a0 = 1 + alpha;
    a1 = -2 * cos;
    a2 = 1 - alpha;
  }
  return [b0 / a0, b1 / a0, b2 / a0, a1 / a0, a2 / a0];
}

function filter(x: ArrayLike<number>, [b0, b1, b2, a1, a2]: Coefficients, from: number, to: number): Float64Array {
  const out = new Float64Array(to - from);
  let x1 = 0;
  let x2 = 0;
  let y1 = 0;
  let y2 = 0;
  for (let i = from; i < to; i++) {
    const v = x[i] as number;
    const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1;
    x1 = v;
    y2 = y1;
    y1 = y;
    out[i - from] = y;
  }
  return out;
}

/**
 * Loudness (as BS.1770 weighs it: a high shelf and a low cut) of `seconds` from `from`, in dB: how
 * loud a hit or a note is heard, which is what its velocity should follow.
 */
export function loudness(channels: Channels, rate: number, from = 0, seconds = 0.4): number {
  const first = channels[0];
  if (!first) return -120;
  const to = Math.min(first.length, from + Math.round(seconds * rate));
  if (to <= from) return -120;
  const shelf = biquad('highshelf', 1681, rate, Math.SQRT1_2, 4);
  const cut = biquad('highpass', 38, rate, 0.5);
  let sum = 0;
  for (const ch of channels) {
    const k = filter(filter(ch, shelf, from, to), cut, 0, to - from);
    let s = 0;
    for (let i = 0; i < k.length; i++) s += (k[i] as number) * (k[i] as number);
    sum += s / k.length;
  }
  return -0.691 + 10 * Math.log10(sum + 1e-20);
}

/** The loudest sample's level, in dB of full scale. */
export function peakDb(channels: Channels): number {
  let p = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) p = Math.max(p, Math.abs(ch[i] as number));
  return 20 * Math.log10(p + 1e-12);
}

/** The frame a hit starts on: where any channel first reaches `below` dB under the peak. */
export function onset(channels: Channels, below = 36): number {
  let peak = 0;
  for (const ch of channels) for (let i = 0; i < ch.length; i++) peak = Math.max(peak, Math.abs(ch[i] as number));
  const t = peak * 10 ** (-below / 20);
  let first = channels[0]?.length ?? 0;
  for (const ch of channels) {
    for (let i = 0; i < Math.min(first, ch.length); i++) {
      if (Math.abs(ch[i] as number) >= t) {
        first = i;
        break;
      }
    }
  }
  return first;
}

/** One layer's place: its velocities, the gain (dB) that brings it to the target, and its loudness. */
export interface SpreadLayer {
  lovel: number;
  hivel: number;
  gain: number;
  level: number;
  /** Squeezed out by its neighbours (or quieter than velocity 1 reaches): no velocity plays it. */
  unreachable: boolean;
}

export interface Spread {
  /** Each layer's place, in the order the levels were given. */
  layers: SpreadLayer[];
  /** The velocity curve's range used, in dB. */
  range: number;
  /** The range these layers need on their own. */
  need: number;
  /** Their level at velocity 127 with no target. */
  ref: number;
}

/**
 * Velocity layers spread over velocities 1 to 127 by how loud they are: `levels` are each layer's
 * loudness (dB, soft to loud). The sampler plays every layer at one level and turns it down by
 * velocity along a straight line of `range` dB, so each layer goes where that line meets its own
 * loudness, and the level never jumps from one layer to the next (only the timbre changes). Returns
 * each layer's velocities and the gain (dB) that brings it to `target`, its loudness at velocity 127.
 *
 * `range` is the whole instrument's (one velocity curve for every key or drum); left out, it's the
 * one these layers need.
 */
export function spreadLayers(levels: readonly number[], opts: { range?: number; target?: number } = {}): Spread {
  const { range, target } = opts;
  const k = levels.length;
  const order = levels.map((l, i): [number, number] => [l, i]).sort((a, b) => a[0] - b[0]);
  const sorted = order.map(([l]) => l);
  const top = sorted[k - 1] as number;
  const w = 126 / k;
  const need = k > 1 ? ((top - (sorted[0] as number)) / (126 - w)) * 126 : 12;
  const R = range ?? need;
  // the level at velocity 127: half a layer's worth above the loudest layer
  const ref = top + (R * (w / 2)) / 126;
  const centre = sorted.map((l) => 127 + (126 * (l - ref)) / R);
  // the layers that get velocities of their own: one quieter than velocity 1 reaches, or squeezed to
  // nothing between its neighbours, folds away (the quietest left plays from velocity 1)
  let kept = sorted.map((_, j) => j);
  for (;;) {
    const now = kept;
    const bounds = now.slice(0, -1).map((j, n) => {
      const b = Math.round(((centre[j] as number) + (centre[now[n + 1] as number] as number)) / 2);
      return Math.max(1, Math.min(126, b));
    });
    const empty = now.findIndex((_, n) => {
      const lo = n === 0 ? 1 : (bounds[n - 1] as number) + 1;
      const hi = n === now.length - 1 ? 127 : (bounds[n] as number);
      return hi < lo;
    });
    if (empty < 0) {
      const out: SpreadLayer[] = new Array(k);
      sorted.forEach((l, j) => {
        out[(order[j] as [number, number])[1]] = {
          lovel: 1,
          hivel: 0,
          gain: (target ?? ref) - l,
          level: l,
          unreachable: true,
        };
      });
      now.forEach((j, n) => {
        const o = out[(order[j] as [number, number])[1]] as SpreadLayer;
        o.lovel = n === 0 ? 1 : (bounds[n - 1] as number) + 1;
        o.hivel = n === now.length - 1 ? 127 : (bounds[n] as number);
        o.unreachable = false;
      });
      return { layers: out, range: R, need, ref };
    }
    // a squeezed layer goes; at the bottom, the quietest goes (the next takes velocity 1)
    kept = now.filter((_, n) => n !== empty);
  }
}
