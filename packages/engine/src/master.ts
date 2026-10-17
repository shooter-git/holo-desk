/**
 * Finishing a render: a low cut and a gentle tilt, glue compression, loudness to a target (EBU R128
 * integrated loudness, BS.1770) and a true-peak limiter, iterated until the loudness lands. It works
 * on the whole render at once (a limiter that looks both ways, a glue threshold set from the loud
 * parts), so it belongs to bounces and headless renders, not to the live mix.
 *
 * It is Hallowed Lanterns' mastering (hlaudio.master) as the same arithmetic: its K-weighting, its
 * gating, scipy's 4× polyphase interpolation for true peak (a Kaiser-windowed 81-tap filter), its
 * centred moving averages and minimums, edges and all. A loop is finished as a loop: filters and
 * dynamics see its end before its start.
 */

export interface FinishOptions {
  /** Integrated loudness to reach, in LUFS. */
  lufs: number;
  /** True-peak ceiling, in dBTP. */
  ceiling: number;
  /** Glue compression: about `glueGr` dB on the loud parts, at `glueRatio`. */
  glue: boolean;
  glueRatio?: number;
  glueGr?: number;
  /** Low cut (Hz) and the high shelf's tilt at 9 kHz (dB). */
  lowcut?: number;
  tilt?: number;
  /** The render is one turn of a loop: everything wraps around its ends. */
  circular?: boolean;
}

const ns = (seconds: number, sr: number) => Math.round(seconds * sr);
const db = (a: number) => 20 * Math.log10(Math.max(Math.abs(a), 1e-12));
const undb = (d: number) => 10 ** (d / 20);

/** One second-order section, transposed direct form II (as scipy's lfilter and sosfilt run them). */
function biquad(x: Float64Array, b: number[], a: number[], zi: [number, number] = [0, 0]): Float64Array {
  const y = new Float64Array(x.length);
  const [b0, b1, b2] = b as [number, number, number];
  const [, a1, a2] = a as [number, number, number];
  let z0 = zi[0];
  let z1 = zi[1];
  for (let i = 0; i < x.length; i++) {
    const v = x[i] as number;
    const o = b0 * v + z0;
    z0 = b1 * v - a1 * o + z1;
    z1 = b2 * v - a2 * o;
    y[i] = o;
  }
  return y;
}

/** RBJ sections as the game's `bq` makes them ("hp" and "hs"). */
function rbj(kind: 'hp' | 'hs', f0: number, q: number, gainDb: number, sr: number): { b: number[]; a: number[] } {
  const f = Math.min(Math.max(f0, 5), 0.49 * sr);
  const w = (2 * Math.PI * f) / sr;
  const cw = Math.cos(w);
  const sw = Math.sin(w);
  const A = 10 ** (gainDb / 40);
  const al = sw / (2 * q);
  let b: number[];
  let a: number[];
  if (kind === 'hp') {
    b = [(1 + cw) / 2, -(1 + cw), (1 + cw) / 2];
    a = [1 + al, -2 * cw, 1 - al];
  } else {
    const sq = 2 * Math.sqrt(A) * al;
    b = [A * (A + 1 + (A - 1) * cw + sq), -2 * A * (A - 1 + (A + 1) * cw), A * (A + 1 + (A - 1) * cw - sq)];
    a = [A + 1 - (A - 1) * cw + sq, 2 * (A - 1 - (A + 1) * cw), A + 1 - (A - 1) * cw - sq];
  }
  const a0 = a[0] as number;
  return { b: b.map((v) => v / a0), a: [1, (a[1] as number) / a0, (a[2] as number) / a0] };
}

/** A chain of sections over each channel; a loop's filters start from its last `warm` seconds. */
function filt(
  x: Float64Array[],
  sos: { b: number[]; a: number[] }[],
  circular: boolean,
  warm: number,
  sr: number,
): Float64Array[] {
  return x.map((ch) => {
    const n = ch.length;
    const w = circular ? Math.min(ns(warm, sr), n) : 0;
    let y: Float64Array = new Float64Array(n + w);
    y.set(ch.subarray(n - w), 0);
    y.set(ch, w);
    for (const s of sos) y = biquad(y, s.b, s.a);
    return y.slice(w);
  });
}

// ---- measurement ----

/** BS.1770 K-weighting, its coefficients worked out for the rate (as pyloudnorm does). */
function kWeight(x: Float64Array, sr: number): Float64Array {
  const G = 3.999843853973347;
  const Q = 0.7071752369554196;
  const fc = 1681.974450955533;
  let K = Math.tan((Math.PI * fc) / sr);
  const Vh = 10 ** (G / 20);
  const Vb = Vh ** 0.4996667741545416;
  let a0 = 1 + K / Q + K * K;
  const y = biquad(
    x,
    [(Vh + (Vb * K) / Q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / Q + K * K) / a0],
    [1, (2 * (K * K - 1)) / a0, (1 - K / Q + K * K) / a0],
  );
  const fc2 = 38.13547087602444;
  const Q2 = 0.5003270373238773;
  K = Math.tan((Math.PI * fc2) / sr);
  a0 = 1 + K / Q2 + K * K;
  return biquad(y, [1, -2, 1], [1, (2 * (K * K - 1)) / a0, (1 - K / Q2 + K * K) / a0]);
}

/** Integrated loudness (LUFS): 400 ms blocks every 100 ms, gated at −70 LUFS and 10 LU below. */
export function loudness(x: Float64Array[], sr: number): number {
  const y = x.map((ch) => kWeight(ch, sr));
  const blk = ns(0.4, sr);
  const hop = ns(0.1, sr);
  let n = y[0]?.length ?? 0;
  if (n < blk) {
    for (let c = 0; c < y.length; c++) {
      const p = new Float64Array(blk);
      p.set(y[c] as Float64Array);
      y[c] = p;
    }
    n = blk;
  }
  const sums = y.map((ch) => {
    const c = new Float64Array(n + 1);
    let acc = 0;
    for (let i = 0; i < n; i++) {
      const v = ch[i] as number;
      acc += v * v;
      c[i + 1] = acc;
    }
    return c;
  });
  const z: number[] = [];
  for (let s = 0; s <= n - blk; s += hop) {
    let total = 0;
    for (const c of sums) total += ((c[s + blk] as number) - (c[s] as number)) / blk;
    z.push(total);
  }
  const lk = z.map((v) => -0.691 + 10 * Math.log10(Math.max(v, 1e-20)));
  const z1 = z.filter((_, i) => (lk[i] as number) > -70);
  if (!z1.length) return -70;
  const mean = (a: number[]) => a.reduce((p, v) => p + v, 0) / a.length;
  const rel = -0.691 + 10 * Math.log10(mean(z1)) - 10;
  const z2 = z.filter((_, i) => (lk[i] as number) > rel);
  return -0.691 + 10 * Math.log10(Math.max(z2.length ? mean(z2) : 0, 1e-20));
}

function besselI0(x: number): number {
  let sum = 1;
  let term = 1;
  for (let k = 1; k < 200; k++) {
    term *= (x / (2 * k)) ** 2;
    sum += term;
    if (term < sum * 1e-17) break;
  }
  return sum;
}

/** scipy's firwin(81, 0.25, window=('kaiser', 5.0)), times 4: the 4× interpolator resample_poly makes. */
const INTERP4 = (() => {
  const N = 81;
  const h = new Float64Array(N);
  const i0b = besselI0(5);
  let sum = 0;
  for (let i = 0; i < N; i++) {
    const m = i - 40;
    const arg = 0.25 * m;
    const sinc = arg === 0 ? 1 : Math.sin(Math.PI * arg) / (Math.PI * arg);
    const r = (2 * i) / (N - 1) - 1;
    const w = besselI0(5 * Math.sqrt(Math.max(0, 1 - r * r))) / i0b;
    h[i] = 0.25 * sinc * w;
    sum += h[i] as number;
  }
  for (let i = 0; i < N; i++) h[i] = ((h[i] as number) / sum) * 4;
  return h;
})();

/** Each frame's true peak: the largest of the four 4×-interpolated points from it, over the channels. */
function truePeakEnv(x: Float64Array[]): Float64Array {
  const n = x[0]?.length ?? 0;
  const env = new Float64Array(n);
  for (const ch of x) {
    for (let k = 0; k < n * 4; k++) {
      // the interpolated point k: taps whose upsampled index k + 40 − i lands on an input frame
      let acc = 0;
      const top = k + 40;
      for (let i = top % 4; i <= 80; i += 4) {
        const m = (top - i) / 4;
        if (m >= 0 && m < n) acc += (INTERP4[i] as number) * (ch[m] as number);
      }
      const f = k >> 2;
      const v = Math.abs(acc);
      if (v > (env[f] as number)) env[f] = v;
    }
  }
  return env;
}

// ---- the filters the dynamics are made of (scipy.ndimage's, centred, with their edges) ----

type Edge = 'reflect' | 'nearest';
const at = (x: Float64Array, i: number, edge: Edge): number => {
  const n = x.length;
  if (i >= 0 && i < n) return x[i] as number;
  if (edge === 'nearest') return x[i < 0 ? 0 : n - 1] as number;
  // reflect: (d c b a | a b c d | d c b a)
  let j = i;
  const period = 2 * n;
  j = ((j % period) + period) % period;
  return x[j < n ? j : period - 1 - j] as number;
};

/** The mean over `size` frames, from i − size/2 (rounded down) on. */
function uniform(x: Float64Array, size: number, edge: Edge): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const lo = Math.floor(size / 2);
  let acc = 0;
  for (let j = -lo; j < -lo + size; j++) acc += at(x, j, edge);
  out[0] = acc / size;
  for (let i = 1; i < n; i++) {
    acc += at(x, i - lo + size - 1, edge) - at(x, i - lo - 1, edge);
    out[i] = acc / size;
  }
  return out;
}

/** The least over `size` frames, from i − size/2 (rounded down) on (a monotonic queue). */
function minimum(x: Float64Array, size: number, edge: Edge): Float64Array {
  const n = x.length;
  const out = new Float64Array(n);
  const lo = Math.floor(size / 2);
  const q: number[] = [];
  let head = 0;
  const push = (j: number) => {
    const v = at(x, j, edge);
    while (q.length > head && at(x, q[q.length - 1] as number, edge) >= v) q.pop();
    q.push(j);
  };
  for (let j = -lo; j < -lo + size - 1; j++) push(j);
  for (let i = 0; i < n; i++) {
    push(i - lo + size - 1);
    while ((q[head] as number) < i - lo) head++;
    out[i] = at(x, q[head] as number, edge);
    if (head > 4096) {
      q.splice(0, head);
      head = 0;
    }
  }
  return out;
}

/** One-pole follower: up at `att`, down at `rel` (the game's nb.follow). */
function follow(x: Float64Array, att: number, rel: number): Float64Array {
  const out = new Float64Array(x.length);
  let e = 0;
  for (let i = 0; i < x.length; i++) {
    const v = x[i] as number;
    e = v > e ? att * e + (1 - att) * v : rel * e + (1 - rel) * v;
    out[i] = e;
  }
  return out;
}

/** Drops at once, recovers at `rel` (the game's nb.release_smooth). */
function releaseSmooth(g: Float64Array, rel: number): Float64Array {
  const out = new Float64Array(g.length);
  let s = 1;
  for (let i = 0; i < g.length; i++) {
    const v = g[i] as number;
    s = v < s ? v : rel * s + (1 - rel) * v;
    out[i] = s;
  }
  return out;
}

const percentile = (x: Float64Array, p: number): number => {
  const s = Float64Array.from(x).sort();
  const pos = (p / 100) * (s.length - 1);
  const i = Math.floor(pos);
  const f = pos - i;
  return i + 1 < s.length ? (s[i] as number) * (1 - f) + (s[i + 1] as number) * f : (s[i] as number);
};

// ---- dynamics ----

/** Feed-forward glue compressor on the stereo-linked RMS level (30 ms), its gain smoothed after. */
function compress(x: Float64Array[], thr: number, ratio: number, attack: number, release: number, sr: number) {
  const n = x[0]?.length ?? 0;
  const pow = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const ch of x) s += (ch[i] as number) ** 2;
    pow[i] = s / x.length;
  }
  const mean = uniform(pow, ns(0.03, sr), 'reflect');
  const knee = 6;
  const gr = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const over = db(Math.sqrt((mean[i] as number) + 1e-12)) - thr;
    gr[i] =
      over <= -knee / 2
        ? 0
        : over >= knee / 2
          ? over * (1 - 1 / ratio)
          : ((1 - 1 / ratio) * (over + knee / 2) ** 2) / (2 * knee);
  }
  const grs = follow(gr, Math.exp(-1 / (attack * sr)), Math.exp(-1 / (release * sr)));
  return x.map((ch) => ch.map((v, i) => v * undb(-(grs[i] as number))));
}

/** Look-ahead brick-wall limiter on the true-peak envelope, and a safety pass for what slipped by. */
function limit(x: Float64Array[], ceilingDb: number, sr: number): Float64Array[] {
  const ceil = undb(ceilingDb);
  const need = (env: Float64Array) => env.map((e) => Math.min(1, ceil / Math.max(e, 1e-12)));
  const la = Math.max(1, ns(0.004, sr));
  const n1 = need(truePeakEnv(x));
  const m1 = minimum(n1, 2 * la + 1, 'nearest');
  let g = releaseSmooth(m1, Math.exp(-1 / (0.12 * sr)));
  g = uniform(g, la, 'nearest');
  g = g.map((v, i) => Math.min(v, (m1[i] as number) * 1 + 0));
  let y = x.map((ch) => ch.map((v, i) => v * (g[i] as number)));
  const env2 = truePeakEnv(y);
  let peak = 0;
  for (const v of env2) if (v > peak) peak = v;
  if (peak > ceil) {
    const n2 = need(env2);
    let g2 = minimum(n2, 2 * la + 1, 'nearest');
    g2 = uniform(g2, la, 'nearest');
    const m3 = minimum(n2, 3, 'nearest');
    g2 = g2.map((v, i) => Math.min(v, m3[i] as number));
    y = y.map((ch) => ch.map((v, i) => v * (g2[i] as number)));
  }
  return y;
}

/** A loop's dynamics see `warm` seconds of its end before it and of its start after it. */
function circWrap(
  fn: (s: Float64Array[]) => Float64Array[],
  x: Float64Array[],
  circular: boolean,
  sr: number,
  warm = 6,
): Float64Array[] {
  if (!circular) return fn(x);
  const n = x[0]?.length ?? 0;
  const w = Math.min(ns(warm, sr), n);
  const xx = x.map((ch) => {
    const out = new Float64Array(n + 2 * w);
    out.set(ch.subarray(n - w), 0);
    out.set(ch, w);
    out.set(ch.subarray(0, w), n + w);
    return out;
  });
  return fn(xx).map((ch) => ch.slice(w, w + n));
}

/** The whole finish. Returns the finished channels and the loudness they landed at. */
export function finish(
  input: ArrayLike<number>[],
  sr: number,
  opts: FinishOptions,
): { channels: Float64Array[]; lufs: number } {
  const circular = opts.circular ?? false;
  const ratio = opts.glueRatio ?? 1.8;
  const grDb = opts.glueGr ?? 2;
  let x: Float64Array[] = input.map((ch) => Float64Array.from(ch));
  x = filt(x, [rbj('hp', opts.lowcut ?? 28, 0.6, 0, sr), rbj('hs', 9000, 0.7, opts.tilt ?? -1, sr)], circular, 2, sr);
  x = x.map((ch) => {
    let m = 0;
    for (const v of ch) m += v;
    m /= Math.max(1, ch.length);
    return ch.map((v) => v - m);
  });
  if (opts.glue) {
    const n = x[0]?.length ?? 0;
    const pow = new Float64Array(n);
    for (let i = 0; i < n; i++) {
      let s = 0;
      for (const ch of x) s += (ch[i] as number) ** 2;
      pow[i] = s / x.length;
    }
    const lvl = uniform(pow, ns(0.4, sr), 'reflect').map((v) => Math.sqrt(v + 1e-12));
    const loud = db(percentile(lvl, 95));
    const thr = loud - (grDb * ratio) / Math.max(ratio - 1, 1e-3);
    x = circWrap((s) => compress(s, thr, ratio, 0.03, 0.4, sr), x, circular, sr);
  }
  let g = opts.lufs - loudness(x, sr);
  let y: Float64Array[] = x;
  for (let k = 0; k < 4; k++) {
    const gain = undb(g);
    y = circWrap(
      (s) =>
        limit(
          s.map((ch) => ch.map((v) => v * gain)),
          opts.ceiling,
          sr,
        ),
      x,
      circular,
      sr,
    );
    const err = opts.lufs - loudness(y, sr);
    if (Math.abs(err) < 0.1) break;
    g += err;
  }
  return { channels: y, lufs: loudness(y, sr) };
}
