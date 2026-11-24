/**
 * A system's strip made ready for a reader that sees pictures at a limited size (the agent, whose
 * model is shown no more than about 1,600 pixels a side): cut into overlapping parts, each enlarged
 * so its staff lines stand well apart, about 34 pixels, wherever the page's music was small. On each
 * part, guides: every staff line drawn over in blue, so a notehead on a line has blue through its
 * middle; the middle of every space dotted in green, so one in a space has the dots through its
 * middle; the places of ledger lines above and below, dashed in orange; and at both margins each line
 * and space named (with the clefs, by pitch; without,
 * by place: L1 to L5 from the bottom line, S1 to S4 the spaces, +1 the first ledger line above, -1
 * the first below).
 *
 * The staff lines are the system finder's (systems.ts), found again on the strip. A system with
 * many staves is cut across too, a group of staves to a part, so no part has to shrink.
 */
import { binarize, type Gray } from './image.ts';
import { type FoundStaff, findSystems, measureLines } from './systems.ts';

/** A picture in colour: three bytes a pixel, red green blue. */
export interface Rgb {
  w: number;
  h: number;
  data: Uint8Array;
}

/** A picture of a palette's few colours: a pixel is its colour's place in `palette`. */
export interface Indexed {
  w: number;
  h: number;
  data: Uint8Array;
  palette: [number, number, number][];
}

export type Clef = 'treble' | 'bass' | 'alto' | 'tenor' | 'treble8' | 'percussion';

export interface ZoomOptions {
  /** The staff space a part gets (px). */
  space?: number;
  /** A part's longest side, and its area at most (px). */
  maxSide?: number;
  maxArea?: number;
  /**
   * A part's width at most (px), for narrower parts than its side and area allow. Such parts repeat two
   * staff spaces of the one before at least (half of it at most), so a notehead at an edge is whole in
   * one of them.
   */
  maxWidth?: number;
  /**
   * The strip's staves and the space between their lines, when they're known already (`stavesOf`, or a
   * larger strip's that this one was cut from): they aren't found again.
   */
  found?: { staves: FoundStaff[]; space: number };
  /** Guides drawn on the parts (else they're the strip, enlarged). */
  guides?: boolean;
  /** Each staff's clef, top to bottom, for naming lines and spaces by pitch. */
  clefs?: (Clef | null)[];
  /** How much of a part the next one repeats. */
  overlap?: number;
}

export interface ZoomPart {
  img: Rgb;
  /** How wide each of its two margins is, where the lines and spaces are named (px; none without guides). */
  margin: number;
  /** The strip's columns and rows it shows. */
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  /** The staves in it (their places in the system, from 0). */
  staves: number[];
}

export interface ZoomedSystem {
  parts: ZoomPart[];
  /** The staves found, and the space between their lines, in the strip (px). */
  staves: FoundStaff[];
  space: number;
  /** How much the parts are enlarged. */
  scale: number;
  /** How far each staff's lines are from `staves`' at each of the strip's columns (px; none without guides). */
  curves: Float32Array[];
  /** Whether the margins name pitches (the clefs given matched the staves found). */
  pitches: boolean;
}

const BLUE: [number, number, number] = [40, 110, 255];
const GREEN: [number, number, number] = [30, 160, 70];
const ORANGE: [number, number, number] = [235, 130, 20];
const MARGIN = 58;
/** Ledger lines marked above and below a staff. */
const LEDGERS = 6;

/**
 * The staves in the strip: all the whole ones found in it (a strip is cut round one system, so they're
 * its own, even where the finder didn't see what joins them).
 */
function theSystem(strip: Gray, ink: Uint8Array): { staves: FoundStaff[]; space: number } {
  const layout = findSystems(ink, strip.w, strip.h);
  const staves = layout.systems
    .flatMap((s) => s.staves)
    .sort((a, b) => (a.lines[0] as number) - (b.lines[0] as number));
  if (staves.length) return { staves, space: layout.space };
  const { thickness, gap } = measureLines(ink, strip.w, strip.h);
  return { staves: [], space: gap + thickness };
}

/**
 * How far each staff's lines are from where the finder put them, column by column: a photographed page
 * bends, so a staff's lines rise and fall across it. The five lines are matched together, a window at a
 * time, from the middle out to each side, each window a pixel or two from the last: a beam or a run of
 * notes lies along one line at most, never all five.
 */
export function staffCurve(ink: Uint8Array, w: number, h: number, staff: FoundStaff, space: number): Float32Array {
  const win = 24;
  const stepX = 12;
  const reach = Math.max(2, Math.round(space * 0.45));
  const score = (cx: number, d: number) => {
    let n = 0;
    for (const y of staff.lines) {
      const row = Math.round(y + d);
      for (let dy = -1; dy <= 1; dy++) {
        const r = row + dy;
        if (r < 0 || r >= h) continue;
        for (let x = Math.max(0, cx - win / 2); x < Math.min(w, cx + win / 2); x++) n += ink[r * w + x] as number;
      }
    }
    return n;
  };
  const centres: number[] = [];
  for (let cx = win / 2; cx < w; cx += stepX) centres.push(cx);
  const found = new Float32Array(centres.length);
  const start = Math.floor(centres.length / 2);
  const walk = (from: number, to: number, by: number) => {
    let d = 0;
    for (let i = from; by > 0 ? i < to : i > to; i += by) {
      let best = d;
      let most = -1;
      // (a step of a pixel or two from the last window, within reach of where the finder put it)
      for (let t = Math.max(-reach, d - 2); t <= Math.min(reach, d + 2); t++) {
        const v = score(centres[i] as number, t);
        if (v > most || (v === most && Math.abs(t - d) < Math.abs(best - d))) {
          most = v;
          best = t;
        }
      }
      // too little of the lines there (the staff hasn't started, or ends): it keeps on as it was
      if (most >= staff.lines.length * win * 0.6) d = best;
      found[i] = d;
    }
  };
  walk(start, centres.length, 1);
  walk(start, -1, -1);
  // smoothed, then for each column
  const smooth = found.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let k = Math.max(0, i - 3); k <= Math.min(found.length - 1, i + 3); k++, n++) sum += found[k] as number;
    return sum / n;
  });
  const out = new Float32Array(w);
  for (let x = 0; x < w; x++) {
    const f = (x - win / 2) / stepX;
    const a = Math.max(0, Math.min(smooth.length - 1, Math.floor(f)));
    const b = Math.min(smooth.length - 1, a + 1);
    const t = Math.max(0, Math.min(1, f - a));
    out[x] = (smooth[a] as number) * (1 - t) + (smooth[b] as number) * t;
  }
  return out;
}

/**
 * Rows of the strip for each group of staves: all of them, or fewer when a part would be too tall.
 * Each staff's rows go five spaces beyond its outer lines, or on to halfway to the staff beside it if
 * that's further, and the first and last staves' on to the strip's edges: a dozen spaces at most, so
 * nothing far above or below a staff, nor between two far apart, is lost.
 */
function groups(
  strip: Gray,
  staves: FoundStaff[],
  space: number,
  scale: number,
  tallest: number,
): [number, number, number[]][] {
  if (!staves.length || strip.h * scale <= tallest) return [[0, strip.h, staves.map((_, i) => i)]];
  const reach = space * 12;
  const top = (i: number) => {
    const line = (staves[i] as FoundStaff).lines[0] as number;
    const prev = staves[i - 1];
    const edge = prev ? Math.min(((prev.lines[4] as number) + line) / 2, line - space * 5) : 0;
    return Math.max(0, Math.round(Math.max(edge, line - reach)));
  };
  const bottom = (i: number) => {
    const line = (staves[i] as FoundStaff).lines[4] as number;
    const next = staves[i + 1];
    const edge = next ? Math.max((line + (next.lines[0] as number)) / 2, line + space * 5) : strip.h;
    return Math.min(strip.h, Math.round(Math.min(edge, line + reach)));
  };
  const out: [number, number, number[]][] = [];
  let first = 0;
  while (first < staves.length) {
    let last = first;
    while (last + 1 < staves.length && (bottom(last + 1) - top(first)) * scale <= tallest) last++;
    out.push([top(first), bottom(last), Array.from({ length: last - first + 1 }, (_, k) => first + k)]);
    first = last + 1;
  }
  return out;
}

/** Part of a grey picture, enlarged (bilinear), in colour. */
function enlarge(src: Gray, x0: number, y0: number, w: number, h: number, scale: number, margin: number): Rgb {
  const W = Math.round(w * scale) + margin * 2;
  const H = Math.round(h * scale);
  const data = new Uint8Array(W * H * 3).fill(255);
  for (let y = 0; y < H; y++) {
    const sy = Math.min(src.h - 1, Math.max(0, y0 + (y + 0.5) / scale - 0.5));
    const ya = Math.floor(sy);
    const yb = Math.min(src.h - 1, ya + 1);
    const fy = sy - ya;
    for (let x = 0; x < W - margin * 2; x++) {
      const sx = Math.min(src.w - 1, Math.max(0, x0 + (x + 0.5) / scale - 0.5));
      const xa = Math.floor(sx);
      const xb = Math.min(src.w - 1, xa + 1);
      const fx = sx - xa;
      const v =
        (src.data[ya * src.w + xa] as number) * (1 - fx) * (1 - fy) +
        (src.data[ya * src.w + xb] as number) * fx * (1 - fy) +
        (src.data[yb * src.w + xa] as number) * (1 - fx) * fy +
        (src.data[yb * src.w + xb] as number) * fx * fy;
      const i = (y * W + x + margin) * 3;
      data[i] = data[i + 1] = data[i + 2] = Math.round(v);
    }
  }
  return { w: W, h: H, data };
}

function dot(img: Rgb, x: number, y: number, c: [number, number, number]): void {
  if (x < 0 || y < 0 || x >= img.w || y >= img.h) return;
  const i = (y * img.w + x) * 3;
  img.data[i] = c[0];
  img.data[i + 1] = c[1];
  img.data[i + 2] = c[2];
}

/** A line across the music (not the margins) at `y(x)` for each column: solid, dashed or dotted. */
function across(
  img: Rgb,
  y: (x: number) => number,
  c: [number, number, number],
  style: 'solid' | 'dashed' | 'dotted',
  margin: number,
): void {
  for (let x = margin; x < img.w - margin; x++) {
    if (style === 'dashed' && x % 14 >= 8) continue;
    if (style === 'dotted' && x % 6 >= 2) continue;
    const row = Math.round(y(x) - 0.5);
    dot(img, x, row, c);
    // (a dotted line is a pixel thin: it marks a space's middle without filling it)
    if (style !== 'dotted') dot(img, x, row + 1, c);
  }
}

// a small font for the margins' names: 5 × 7, a row a number, the high bit the left
const GLYPHS: Record<string, number[]> = {
  A: [14, 17, 17, 31, 17, 17, 17],
  B: [30, 17, 17, 30, 17, 17, 30],
  C: [14, 17, 16, 16, 16, 17, 14],
  D: [30, 17, 17, 17, 17, 17, 30],
  E: [31, 16, 16, 30, 16, 16, 31],
  F: [31, 16, 16, 30, 16, 16, 16],
  G: [14, 17, 16, 23, 17, 17, 15],
  L: [16, 16, 16, 16, 16, 16, 31],
  S: [15, 16, 16, 14, 1, 1, 30],
  '0': [14, 17, 19, 21, 25, 17, 14],
  '1': [4, 12, 4, 4, 4, 4, 14],
  '2': [14, 17, 1, 2, 4, 8, 31],
  '3': [30, 1, 1, 14, 1, 1, 30],
  '4': [2, 6, 10, 18, 31, 2, 2],
  '5': [31, 16, 30, 1, 1, 17, 14],
  '6': [6, 8, 16, 30, 17, 17, 14],
  '7': [31, 1, 2, 4, 8, 8, 8],
  '8': [14, 17, 17, 14, 17, 17, 14],
  '9': [14, 17, 17, 15, 1, 2, 12],
  '+': [0, 4, 4, 31, 4, 4, 0],
  '-': [0, 0, 0, 31, 0, 0, 0],
};

function text(img: Rgb, s: string, x: number, midY: number, size: number, c: [number, number, number]): void {
  const top = Math.round(midY - (7 * size) / 2);
  let left = x;
  for (const ch of s) {
    const rows = GLYPHS[ch];
    if (rows) {
      rows.forEach((bits, r) => {
        for (let col = 0; col < 5; col++) {
          if (!(bits & (16 >> col))) continue;
          for (let dy = 0; dy < size; dy++)
            for (let dx = 0; dx < size; dx++) dot(img, left + col * size + dx, top + r * size + dy, c);
        }
      });
    }
    left += 6 * size;
  }
}

const LETTERS = 'CDEFGAB';
/** The bottom line's pitch for a clef, as a diatonic step (C0 = 0). */
const BOTTOM: Record<Exclude<Clef, 'percussion'>, number> = {
  treble: 4 * 7 + 2, // E4
  // as written: the score text's pitches are the page's, a staff with an 8 under its clef sounding an
  // octave lower
  treble8: 4 * 7 + 2, // E4
  bass: 2 * 7 + 4, // G2
  alto: 3 * 7 + 3, // F3
  tenor: 3 * 7 + 1, // D3
};
const stepName = (step: number) => `${LETTERS[((step % 7) + 7) % 7]}${Math.floor(step / 7)}`;

/** The name of the place `k` half-spaces above a staff's bottom line (0 its bottom line). */
export function placeName(k: number, clef: Clef | null | undefined): string {
  if (clef && clef !== 'percussion') return stepName(BOTTOM[clef] + k);
  if (k >= 0 && k <= 8) return k % 2 === 0 ? `L${k / 2 + 1}` : `S${(k + 1) / 2}`;
  if (k > 8) return k % 2 === 0 ? `+${(k - 8) / 2}` : '';
  return k % 2 === 0 ? `-${-k / 2}` : '';
}

/**
 * A system's strip as zoomed parts (with guides, unless asked not to). Parts go left to right, each
 * repeating the end of the one before; a system too tall for one part is cut across into groups of
 * staves first.
 */
export function zoomSystem(strip: Gray, options: ZoomOptions = {}): ZoomedSystem {
  const want = options.space ?? 34;
  const maxSide = options.maxSide ?? 1560;
  const maxArea = options.maxArea ?? 1_150_000;
  const overlap = options.overlap ?? 0.12;
  const guides = options.guides ?? true;
  const ink = binarize(strip);
  const { staves, space } = options.found ?? theSystem(strip, ink);
  // no staff found: nothing to size the parts by, nor to draw guides on
  if (!staves.length) return { parts: [], staves, space, scale: 1, curves: [], pitches: false };
  const curves = guides ? staves.map((staff) => staffCurve(ink, strip.w, strip.h, staff, space)) : [];
  // pitch names only when there's a clef for each staff found: one staff missed would name the rest
  // for the wrong clefs
  const clefs = options.clefs?.length === staves.length ? options.clefs : undefined;
  // (up to twelve times: a closer look at music printed small is twice as large as the first look too)
  const scale = Math.max(1, Math.min(12, want / Math.max(4, space)));
  const margin = guides ? MARGIN : 0;
  const parts: ZoomPart[] = [];
  for (const [y0, y1, inGroup] of groups(strip, staves, space, scale, maxSide * 0.75)) {
    const height = (y1 - y0) * scale;
    const width = Math.min(maxSide, options.maxWidth ?? maxSide, Math.floor(maxArea / Math.max(1, height)));
    const span = Math.max(40, Math.floor((width - margin * 2) / scale));
    // each part repeats the end of the one before: a share of it; of parts cut narrower, two staff spaces
    // at least (a notehead whole), though never more than half of one
    const lap =
      options.maxWidth === undefined ? span * overlap : Math.min(span / 2, Math.max(span * overlap, space * 2));
    const step = Math.max(1, Math.floor(span - lap));
    const count = strip.w <= span ? 1 : Math.ceil((strip.w - span) / step) + 1;
    const stride = count > 1 ? (strip.w - span) / (count - 1) : 0;
    for (let p = 0; p < count; p++) {
      const x0 = Math.round(p * stride);
      const x1 = Math.min(strip.w, x0 + span);
      const img = enlarge(strip, x0, y0, x1 - x0, y1 - y0, scale, margin);
      if (guides) {
        // a column of the part's music, as the strip's column
        const source = (x: number) => Math.min(strip.w - 1, Math.max(0, Math.round(x0 + (x - margin + 0.5) / scale)));
        for (const index of inGroup) {
          const staff = staves[index] as FoundStaff;
          const curve = curves[index] as Float32Array;
          const top = staff.lines[0] as number;
          const bottom = staff.lines[4] as number;
          const half = (bottom - top) / 8;
          // a place k half-spaces above the bottom line, at column x of the part
          const at = (k: number) => (x: number) =>
            (bottom - k * half + (curve[source(x)] as number) - y0 + 0.5) * scale - 0.5;
          // ledger lines and names up to halfway to the staff above or below (a grand staff's two
          // share the gap), and no nearer the middle than half a space
          const prev = staves[index - 1];
          const next = staves[index + 1];
          const highest = prev ? ((top - (prev.lines[4] as number)) / 2 - half) / half : LEDGERS * 2 + 1;
          const lowest = next ? -(((next.lines[0] as number) - bottom) / 2 - half) / half : -LEDGERS * 2 - 1;
          const kTop = Math.min(8 + LEDGERS * 2 + 1, 8 + Math.floor(highest));
          const kBottom = Math.max(-LEDGERS * 2 - 1, Math.ceil(lowest));
          for (let k = 0; k <= 8; k += 2) across(img, at(k), BLUE, 'solid', margin);
          for (let k = 10; k <= kTop; k += 2) across(img, at(k), ORANGE, 'dashed', margin);
          for (let k = -2; k >= kBottom; k -= 2) across(img, at(k), ORANGE, 'dashed', margin);
          // the middle of every space, in the staff and between its ledger lines, dotted: a head in a space
          // has the dots through its middle, as one on a line has the line
          for (let k = Math.abs(kBottom) % 2 ? kBottom : kBottom + 1; k <= kTop; k += 2)
            across(img, at(k), GREEN, 'dotted', margin);
          // each place's name, at both margins, beside where its line or space is at that edge
          const size = half * scale >= 15 ? 2 : 1;
          const clef = clefs?.[index];
          for (let k = kBottom; k <= kTop; k++) {
            const name = placeName(k, clef);
            if (!name) continue;
            const c = k % 2 ? GREEN : k >= 0 && k <= 8 ? BLUE : ORANGE;
            const left = at(k)(margin);
            const right = at(k)(img.w - margin - 1);
            if (left > 4 && left < img.h - 4) text(img, name, 4, left, size, c);
            if (right > 4 && right < img.h - 4) text(img, name, img.w - margin + 6, right, size, c);
          }
        }
      }
      parts.push({ img, margin, x0, x1, y0, y1, staves: inGroup });
    }
  }
  return { parts, staves, space, scale, curves, pitches: !!clefs };
}

/** A strip's staves, top to bottom, and the space between their lines (px): what `zoomSystem` finds first. */
export function stavesOf(strip: Gray): { staves: FoundStaff[]; space: number } {
  return theSystem(strip, binarize(strip));
}

/** The darkest a page's paper is taken to be (of 255): less than that, with no lighter paper near, is ink. */
const PAPER_FLOOR = 110;

/**
 * The paper's shade around each pixel of columns x0 to x1: the lightest of each block and those beside
 * it (pixels that are `skip`ped aside: guides drawn over the page), smoothed between.
 */
function paperLevel(grey: Uint8Array, skip: Uint8Array, w: number, h: number, x0: number, x1: number): Float32Array {
  const BLOCK = 32;
  const span = Math.max(1, x1 - x0);
  const cols = Math.ceil(span / BLOCK);
  const rows = Math.ceil(h / BLOCK);
  const most = new Uint8Array(cols * rows);
  for (let y = 0; y < h; y++) {
    const r = Math.floor(y / BLOCK) * cols;
    for (let x = x0; x < x1; x++) {
      if (skip[y * w + x]) continue;
      const v = grey[y * w + x] as number;
      const b = r + Math.floor((x - x0) / BLOCK);
      if (v > (most[b] as number)) most[b] = v;
    }
  }
  // a block all ink (inside a beam, a blot) takes its neighbours' paper; where there's none near (a dark
  // edge, a blot bigger than that), paper is taken no darker than PAPER_FLOOR, so the dark stays ink
  // rather than being stretched into every shade
  const wide = new Uint8Array(cols * rows);
  for (let r = 0; r < rows; r++) {
    for (let c = 0; c < cols; c++) {
      let m = PAPER_FLOOR;
      for (let dr = -1; dr <= 1; dr++)
        for (let dc = -1; dc <= 1; dc++) {
          const rr = r + dr;
          const cc = c + dc;
          if (rr >= 0 && rr < rows && cc >= 0 && cc < cols) m = Math.max(m, most[rr * cols + cc] as number);
        }
      wide[r * cols + c] = m;
    }
  }
  const out = new Float32Array(w * h).fill(255);
  for (let y = 0; y < h; y++) {
    const fy = Math.max(0, Math.min(rows - 1, (y + 0.5) / BLOCK - 0.5));
    const r0 = Math.floor(fy);
    const r1 = Math.min(rows - 1, r0 + 1);
    const ty = fy - r0;
    for (let x = x0; x < x1; x++) {
      const fx = Math.max(0, Math.min(cols - 1, (x - x0 + 0.5) / BLOCK - 0.5));
      const c0 = Math.floor(fx);
      const c1 = Math.min(cols - 1, c0 + 1);
      const tx = fx - c0;
      out[y * w + x] =
        (wide[r0 * cols + c0] as number) * (1 - tx) * (1 - ty) +
        (wide[r0 * cols + c1] as number) * tx * (1 - ty) +
        (wide[r1 * cols + c0] as number) * (1 - tx) * ty +
        (wide[r1 * cols + c1] as number) * tx * ty;
    }
  }
  return out;
}

const GUIDE_COLOURS = [BLUE, GREEN, ORANGE];

/**
 * A zoomed part in a palette's few colours, for a picture that has to be small: the paper white (its
 * tone and shadows evened out, which is most of a photographed page's bytes), the ink in `greys`
 * shades (2: ink or paper; 4: two greys between, which keeps a faint stroke), and the guides in their
 * own colours. As legible as the part in full colour, at a twentieth of its size as a PNG. `margin` is
 * how wide the part's two margins are (a `ZoomPart`'s): white already, they're no part of the page.
 */
export function fewColours(img: Rgb, greys: 2 | 4 = 4, margin = 0): Indexed {
  const n = img.w * img.h;
  const grey = new Uint8Array(n);
  const guide = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    const r = img.data[i * 3] as number;
    const g = img.data[i * 3 + 1] as number;
    const b = img.data[i * 3 + 2] as number;
    guide[i] = GUIDE_COLOURS.findIndex((c) => c[0] === r && c[1] === g && c[2] === b) + 1;
    grey[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  const edge = Math.max(0, Math.min(margin, Math.floor(img.w / 2)));
  const paper = paperLevel(grey, guide, img.w, img.h, edge, img.w - edge);
  const shades: [number, number, number][] =
    greys === 2
      ? [
          [255, 255, 255],
          [0, 0, 0],
        ]
      : [
          [255, 255, 255],
          [170, 170, 170],
          [95, 95, 95],
          [0, 0, 0],
        ];
  const data = new Uint8Array(n);
  for (let i = 0; i < n; i++) {
    if (guide[i]) {
      data[i] = shades.length + (guide[i] as number) - 1;
      continue;
    }
    const v = Math.min(255, ((grey[i] as number) * 255) / Math.max(1, paper[i] as number));
    data[i] = greys === 2 ? (v < 165 ? 1 : 0) : v < 90 ? 3 : v < 150 ? 2 : v < 205 ? 1 : 0;
  }
  // (a picture with no guide on it, a strip made small, needs only the shades: fewer bits a pixel)
  return { w: img.w, h: img.h, data, palette: guide.some((g) => g > 0) ? [...shades, ...GUIDE_COLOURS] : shades };
}

/** A strip made small, to see a system whole: no wider than `maxWidth`, each pixel the mean of those it covers. */
export function overview(strip: Gray, maxWidth: number): Rgb {
  const by = Math.max(1, Math.ceil(strip.w / Math.max(1, maxWidth)));
  const w = Math.max(1, Math.floor(strip.w / by));
  const h = Math.max(1, Math.floor(strip.h / by));
  const data = new Uint8Array(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let sum = 0;
      for (let dy = 0; dy < by; dy++)
        for (let dx = 0; dx < by; dx++) sum += strip.data[(y * by + dy) * strip.w + x * by + dx] as number;
      const v = Math.round(sum / (by * by));
      data.fill(v, (y * w + x) * 3, (y * w + x) * 3 + 3);
    }
  }
  return { w, h, data };
}
