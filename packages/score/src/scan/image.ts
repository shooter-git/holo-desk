/**
 * A photo of a page made fit to read: gray, straightened from its four corners, its shadows and
 * paper tone taken out, and split into ink and paper. Plain arrays of bytes, so the same code runs
 * in a browser worker (from a canvas) and in tests.
 */

export interface Gray {
  w: number;
  h: number;
  /** 0 black … 255 white, row by row. */
  data: Uint8Array;
}

export type Point = [number, number];

/** RGBA pixels (a canvas's) as gray. */
export function toGray(rgba: Uint8ClampedArray | Uint8Array, w: number, h: number): Gray {
  const data = new Uint8Array(w * h);
  for (let i = 0, j = 0; i < data.length; i++, j += 4) {
    data[i] = (0.299 * (rgba[j] as number) + 0.587 * (rgba[j + 1] as number) + 0.114 * (rgba[j + 2] as number)) | 0;
  }
  return { w, h, data };
}

/** Solve A·x = b (n×n, by Gaussian elimination with pivoting). */
function solve(a: number[][], b: number[]): number[] {
  const n = b.length;
  const m = a.map((row, i) => [...row, b[i] as number]);
  for (let c = 0; c < n; c++) {
    let pivot = c;
    for (let r = c + 1; r < n; r++)
      if (Math.abs((m[r] as number[])[c] as number) > Math.abs((m[pivot] as number[])[c] as number)) pivot = r;
    [m[c], m[pivot]] = [m[pivot] as number[], m[c] as number[]];
    const row = m[c] as number[];
    const p = row[c] as number;
    if (Math.abs(p) < 1e-12) throw new Error('The corners don’t make a page');
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const other = m[r] as number[];
      const f = (other[c] as number) / p;
      for (let k = c; k <= n; k++) other[k] = (other[k] as number) - f * (row[k] as number);
    }
  }
  return m.map((row, i) => (row[n] as number) / (row[i] as number));
}

/**
 * The homography taking the rectangle w×h (its corners top-left, top-right, bottom-right,
 * bottom-left) to four points on the photo: where each pixel of the straightened page comes from.
 */
export function homography(corners: [Point, Point, Point, Point], w: number, h: number): number[] {
  const from: Point[] = [
    [0, 0],
    [w, 0],
    [w, h],
    [0, h],
  ];
  const a: number[][] = [];
  const b: number[] = [];
  for (let i = 0; i < 4; i++) {
    const [x, y] = from[i] as Point;
    const [u, v] = corners[i] as Point;
    a.push([x, y, 1, 0, 0, 0, -u * x, -u * y]);
    b.push(u);
    a.push([0, 0, 0, x, y, 1, -v * x, -v * y]);
    b.push(v);
  }
  return [...solve(a, b), 1];
}

/** The page inside four corners of a photo, straightened to w×h (bilinear). */
export function warp(img: Gray, corners: [Point, Point, Point, Point], w: number, h: number): Gray {
  const H = homography(corners, w, h);
  const [h0, h1, h2, h3, h4, h5, h6, h7] = H as [number, number, number, number, number, number, number, number];
  const out = new Uint8Array(w * h);
  const { w: sw, h: sh, data } = img;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const d = h6 * x + h7 * y + 1;
      const u = (h0 * x + h1 * y + h2) / d;
      const v = (h3 * x + h4 * y + h5) / d;
      const x0 = Math.floor(u);
      const y0 = Math.floor(v);
      if (x0 < 0 || y0 < 0 || x0 >= sw - 1 || y0 >= sh - 1) {
        out[y * w + x] = 255;
        continue;
      }
      const fx = u - x0;
      const fy = v - y0;
      const i = y0 * sw + x0;
      const top = (data[i] as number) * (1 - fx) + (data[i + 1] as number) * fx;
      const bottom = (data[i + sw] as number) * (1 - fx) + (data[i + sw + 1] as number) * fx;
      out[y * w + x] = (top * (1 - fy) + bottom * fy) | 0;
    }
  }
  return { w, h, data: out };
}

/** A sum table, so any box's total is four lookups. */
function integral(img: Gray, square = false): Float64Array {
  const { w, h, data } = img;
  const s = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      const v = data[y * w + x] as number;
      row += square ? v * v : v;
      s[(y + 1) * (w + 1) + x + 1] = (s[y * (w + 1) + x + 1] as number) + row;
    }
  }
  return s;
}

const boxSum = (s: Float64Array, w: number, x0: number, y0: number, x1: number, y1: number): number =>
  (s[y1 * (w + 1) + x1] as number) -
  (s[y0 * (w + 1) + x1] as number) -
  (s[y1 * (w + 1) + x0] as number) +
  (s[y0 * (w + 1) + x0] as number);

/**
 * The paper made white: each pixel divided by the brightness around it (shadows, a lamp's falloff,
 * a curled page's shading), so ink is ink wherever it is.
 */
export function flatten(img: Gray, radius = Math.max(15, Math.round(Math.min(img.w, img.h) / 40))): Gray {
  const { w, h, data } = img;
  // the paper's brightness: the bright end of each neighbourhood (ink is a small share of it)
  const small = Math.max(1, Math.round(radius / 2));
  const bw = Math.ceil(w / small);
  const bh = Math.ceil(h / small);
  const bright = new Float32Array(bw * bh);
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let max = 0;
      for (let y = by * small; y < Math.min(h, (by + 1) * small); y++) {
        for (let x = bx * small; x < Math.min(w, (bx + 1) * small); x++) max = Math.max(max, data[y * w + x] as number);
      }
      bright[by * bw + bx] = max;
    }
  }
  // spread the brightness (a box blur of the blocks) so a staff's ink doesn't darken its own paper
  const spread = new Float32Array(bw * bh);
  const r = 2;
  for (let by = 0; by < bh; by++) {
    for (let bx = 0; bx < bw; bx++) {
      let sum = 0;
      let n = 0;
      for (let y = Math.max(0, by - r); y <= Math.min(bh - 1, by + r); y++) {
        for (let x = Math.max(0, bx - r); x <= Math.min(bw - 1, bx + r); x++) {
          sum = Math.max(sum, bright[y * bw + x] as number);
          n++;
        }
      }
      spread[by * bw + bx] = n ? sum : 255;
    }
  }
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const paper = Math.max(40, spread[Math.floor(y / small) * bw + Math.floor(x / small)] as number);
      out[y * w + x] = Math.min(255, ((data[y * w + x] as number) / paper) * 255) | 0;
    }
  }
  return { w, h, data: out };
}

/** More contrast: the darkest tenth to black, the paper to white. */
export function enhance(img: Gray): Gray {
  const hist = new Uint32Array(256);
  for (const v of img.data) hist[v] = (hist[v] as number) + 1;
  let low = 0;
  let count = 0;
  const target = img.data.length * 0.01;
  while (low < 255 && count + (hist[low] as number) < target) count += hist[low++] as number;
  const out = new Uint8Array(img.data.length);
  const span = Math.max(1, 235 - low);
  for (let i = 0; i < out.length; i++)
    out[i] = Math.max(0, Math.min(255, (((img.data[i] as number) - low) / span) * 255)) | 0;
  return { ...img, data: out };
}

/**
 * Ink and paper: 1 where there's ink. Sauvola's threshold (the neighbourhood's mean, lowered where
 * it's flat), so thin staff lines on grey paper and bold noteheads both come through.
 */
export function binarize(img: Gray, radius = 12, k = 0.2): Uint8Array {
  const { w, h, data } = img;
  const sum = integral(img);
  const sq = integral(img, true);
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - radius);
    const y1 = Math.min(h, y + radius + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - radius);
      const x1 = Math.min(w, x + radius + 1);
      const n = (x1 - x0) * (y1 - y0);
      const mean = boxSum(sum, w, x0, y0, x1, y1) / n;
      const variance = Math.max(0, boxSum(sq, w, x0, y0, x1, y1) / n - mean * mean);
      const t = mean * (1 + k * (Math.sqrt(variance) / 128 - 1));
      // faint lines (a thin line in a small photo comes out light grey) still count; paper, flattened
      // to near white, doesn't
      out[y * w + x] = (data[y * w + x] as number) < Math.min(t, 232) ? 1 : 0;
    }
  }
  return out;
}

/** Where the ink is: a guess at the page's corners (the ink's box with a margin), for the user to adjust. */
export function guessCorners(ink: Uint8Array, w: number, h: number): [Point, Point, Point, Point] {
  let x0 = w;
  let y0 = h;
  let x1 = 0;
  let y1 = 0;
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) {
      if (!ink[y * w + x]) continue;
      x0 = Math.min(x0, x);
      x1 = Math.max(x1, x);
      y0 = Math.min(y0, y);
      y1 = Math.max(y1, y);
    }
  }
  if (x1 <= x0 || y1 <= y0) {
    return [
      [0, 0],
      [w, 0],
      [w, h],
      [0, h],
    ];
  }
  const mx = (x1 - x0) * 0.03;
  const my = (y1 - y0) * 0.03;
  const l = Math.max(0, x0 - mx);
  const r = Math.min(w, x1 + mx);
  const t = Math.max(0, y0 - my);
  const b = Math.min(h, y1 + my);
  return [
    [l, t],
    [r, t],
    [r, b],
    [l, b],
  ];
}

/** A rectangle of a gray image (a system's strip). */
export function crop(img: Gray, x: number, y: number, w: number, h: number): Gray {
  const cw = Math.max(1, Math.min(w, img.w - x));
  const ch = Math.max(1, Math.min(h, img.h - y));
  const out = new Uint8Array(cw * ch);
  for (let r = 0; r < ch; r++) out.set(img.data.subarray((y + r) * img.w + x, (y + r) * img.w + x + cw), r * cw);
  return { w: cw, h: ch, data: out };
}

/** The gray level that best splits an image in two (Otsu's). */
export function otsu(img: Gray): number {
  const hist = new Float64Array(256);
  for (const v of img.data) hist[v] = (hist[v] as number) + 1;
  const total = img.data.length;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * (hist[i] as number);
  let back = 0;
  let backSum = 0;
  let best = 0;
  let level = 128;
  for (let t = 0; t < 256; t++) {
    back += hist[t] as number;
    if (!back) continue;
    const fore = total - back;
    if (!fore) break;
    backSum += t * (hist[t] as number);
    const between = back * fore * (backSum / back - (sum - backSum) / fore) ** 2;
    if (between > best) {
      best = between;
      level = t;
    }
  }
  return level;
}

/**
 * Where the page is in a photo: the largest bright region (paper against a table or a lap), its four
 * corners where it reaches furthest toward each corner of the photo. Null when no region stands out.
 */
export function findPage(img: Gray): [Point, Point, Point, Point] | null {
  const { w, h, data } = img;
  // what the page lies on shows at the photo's edges: the page is anything clearly brighter than
  // that, even in a shadow (a plain threshold between the two would cut the shadowed paper away)
  const ring: number[] = [];
  const m = Math.max(2, Math.round(Math.min(w, h) * 0.02));
  for (let y = 0; y < h; y += 2) {
    for (let x = 0; x < w; x += 2) if (x < m || y < m || x >= w - m || y >= h - m) ring.push(data[y * w + x] as number);
  }
  ring.sort((a, b) => a - b);
  const table = ring[Math.floor(ring.length / 2)] ?? 0;
  const split = otsu(img);
  let paper = 0;
  let n = 0;
  for (const v of data) {
    if (v > split) {
      paper += v;
      n++;
    }
  }
  paper = n ? paper / n : 255;
  const level = paper - table > 30 ? table + Math.max(10, (paper - table) * 0.15) : split;
  const bright = new Uint8Array(w * h);
  for (let i = 0; i < data.length; i++) bright[i] = (data[i] as number) > level ? 1 : 0;
  // the largest bright region (4-connected)
  const label = new Int32Array(w * h);
  let best = 0;
  let bestSize = 0;
  let next = 1;
  const stack: number[] = [];
  for (let i = 0; i < bright.length; i++) {
    if (!bright[i] || label[i]) continue;
    let size = 0;
    stack.push(i);
    label[i] = next;
    while (stack.length) {
      const k = stack.pop() as number;
      size++;
      const x = k % w;
      const y = (k - x) / w;
      for (const n of [x > 0 ? k - 1 : -1, x < w - 1 ? k + 1 : -1, y > 0 ? k - w : -1, y < h - 1 ? k + w : -1]) {
        if (n >= 0 && bright[n] && !label[n]) {
          label[n] = next;
          stack.push(n);
        }
      }
    }
    if (size > bestSize) {
      bestSize = size;
      best = next;
    }
    next++;
  }
  if (bestSize < w * h * 0.15) return null;
  let tl: Point = [0, 0];
  let tr: Point = [w, 0];
  let br: Point = [w, h];
  let bl: Point = [0, h];
  let [a, b, c, d] = [Infinity, -Infinity, -Infinity, Infinity];
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (label[y * w + x] !== best) continue;
      if (x + y < a) [a, tl] = [x + y, [x, y]];
      if (x - y > b) [b, tr] = [x - y, [x, y]];
      if (x + y > c) [c, br] = [x + y, [x, y]];
      if (y - x > -d) [d, bl] = [-(y - x), [x, y]];
    }
  }
  return [tl, tr, br, bl];
}

/**
 * How far a page's lines slope, in radians: the small angle at which its ink's rows line up best
 * (a page photographed a little crooked, or straightened from corners set a little off).
 */
export function skewAngle(ink: Uint8Array, w: number, h: number): number {
  const points: [number, number][] = [];
  const x0 = Math.floor(w * 0.1);
  const x1 = Math.floor(w * 0.9);
  const step = Math.max(1, Math.floor((x1 - x0) / 400));
  for (let y = 0; y < h; y++) for (let x = x0; x < x1; x += step) if (ink[y * w + x]) points.push([x - w / 2, y]);
  if (points.length < 100) return 0;
  let best = 0;
  let bestScore = -1;
  const hist = new Float64Array(h + 200);
  for (let deg = -3; deg <= 3.0001; deg += 0.1) {
    const t = Math.tan((deg * Math.PI) / 180);
    hist.fill(0);
    for (const [x, y] of points) {
      const r = Math.round(y - x * t) + 100;
      if (r >= 0 && r < hist.length) hist[r] = (hist[r] as number) + 1;
    }
    let score = 0;
    for (const v of hist) score += v * v;
    if (score > bestScore) {
      bestScore = score;
      best = deg;
    }
  }
  return (best * Math.PI) / 180;
}

/** A page made level: each column moved up or down by its slope (a shear, near enough for a few degrees). */
export function level(img: Gray, angle: number): Gray {
  if (Math.abs(angle) < 0.0005) return img;
  const { w, h, data } = img;
  const t = Math.tan(angle);
  const out = new Uint8Array(w * h).fill(255);
  for (let x = 0; x < w; x++) {
    const dy = Math.round((x - w / 2) * t);
    for (let y = 0; y < h; y++) {
      const sy = y + dy;
      if (sy >= 0 && sy < h) out[y * w + x] = data[sy * w + x] as number;
    }
  }
  return { w, h, data: out };
}
