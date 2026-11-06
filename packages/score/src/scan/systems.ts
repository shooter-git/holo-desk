/**
 * Where the music is on a page: its staves (five lines each), the systems they make (staves joined
 * at the left by a bar line or a brace), the bar lines across each system, and a strip around each
 * system to read it by (the AI reads a system at a time: far more surely than a whole page).
 * Works on ink (1) and paper (0), as `binarize` gives them.
 */

export interface FoundStaff {
  /** Its five lines, from the top. */
  lines: number[];
  left: number;
  right: number;
}

export interface FoundSystem {
  staves: FoundStaff[];
  /** Bar lines across it, left to right (its start and its end among them). */
  bars: number[];
  /** The strip to read it by: from the cut above it to the cut below. */
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface PageLayout {
  /** Between two staff lines (centre to centre), and a line's thickness. */
  space: number;
  thickness: number;
  systems: FoundSystem[];
}

/** The most common value in a histogram's range. */
function mode(hist: Uint32Array, from: number, to: number): number {
  let best = from;
  for (let i = from; i <= to; i++) if ((hist[i] as number) > (hist[best] as number)) best = i;
  return best;
}

/**
 * A staff line's thickness and the gap between lines, from vertical runs: the commonest short run
 * of ink, and the commonest run of paper between two such.
 */
export function measureLines(ink: Uint8Array, w: number, h: number): { thickness: number; gap: number } {
  const black = new Uint32Array(64);
  const white = new Uint32Array(128);
  const step = Math.max(1, Math.floor(w / 80));
  for (let x = Math.floor(w * 0.1); x < w * 0.9; x += step) {
    let run = 0;
    let colour = ink[x] as number;
    let lastBlack = 0;
    for (let y = 0; y <= h; y++) {
      const v = y < h ? (ink[y * w + x] as number) : 1 - colour;
      if (v === colour) {
        run++;
        continue;
      }
      if (colour === 1 && run < 64) {
        black[run] = (black[run] as number) + 1;
        lastBlack = run;
      } else if (colour === 0 && run < 128 && lastBlack > 0 && lastBlack < 8) {
        white[run] = (white[run] as number) + 1;
      }
      colour = v;
      run = 1;
    }
  }
  const thickness = Math.max(1, mode(black, 1, 12));
  const gap = Math.max(3, mode(white, 3, 120));
  return { thickness, gap };
}

/** Rows of ink that run across most of the page's middle: staff line candidates, merged into lines. */
function lineRows(ink: Uint8Array, w: number, h: number, thickness: number): number[] {
  const x0 = Math.floor(w * 0.2);
  const x1 = Math.floor(w * 0.8);
  const span = x1 - x0;
  const rows: boolean[] = [];
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) n += ink[y * w + x] as number;
    rows.push(n > span * 0.45);
  }
  const lines: number[] = [];
  for (let y = 0; y < h; ) {
    if (!rows[y]) {
      y++;
      continue;
    }
    let end = y;
    while (end + 1 < h && rows[end + 1]) end++;
    if (end - y + 1 <= thickness * 3 + 2) lines.push((y + end) / 2);
    y = end + 1;
  }
  return lines;
}

/** Five lines evenly spaced make a staff. */
function staves(lines: number[], spacing: number): number[][] {
  const out: number[][] = [];
  for (let i = 0; i + 4 < lines.length; ) {
    const five = lines.slice(i, i + 5);
    const gaps = five.slice(1).map((y, k) => y - (five[k] as number));
    const mean = gaps.reduce((a, b) => a + b, 0) / 4;
    const even = gaps.every((g) => Math.abs(g - mean) <= Math.max(2, mean * 0.25));
    if (even && Math.abs(mean - spacing) <= spacing * 0.35) {
      out.push(five);
      i += 5;
    } else i++;
  }
  return out;
}

/** Where a staff's lines start and end across the page. */
function extent(ink: Uint8Array, w: number, lines: number[]): { left: number; right: number } {
  const hits = (x: number) =>
    lines.filter((y) => ink[Math.round(y) * w + x] || ink[(Math.round(y) + 1) * w + x]).length;
  let left = 0;
  while (left < w && hits(left) < 4) left++;
  let right = w - 1;
  while (right > left && hits(right) < 4) right--;
  return { left, right };
}

/** Whether a column of ink runs from one staff's bottom line to the next one's top line. */
function joined(ink: Uint8Array, w: number, x: number, from: number, to: number): boolean {
  let n = 0;
  let total = 0;
  for (let y = Math.round(from); y <= Math.round(to); y++, total++) n += ink[y * w + x] || ink[y * w + x + 1] ? 1 : 0;
  return total > 0 && n / total > 0.95;
}

/**
 * Bar lines across a system: thin columns of ink covering every staff's lines from top line to
 * bottom line, and not running on past them (a stem from a note above or below does).
 */
function barLines(
  ink: Uint8Array,
  w: number,
  h: number,
  sys: FoundStaff[],
  thickness: number,
  space: number,
): number[] {
  const first = sys[0] as FoundStaff;
  const last = sys[sys.length - 1] as FoundStaff;
  const left = Math.min(...sys.map((s) => s.left));
  const right = Math.max(...sys.map((s) => s.right));
  const covers = (x: number) =>
    sys.every((s) => {
      const top = Math.round(s.lines[0] as number);
      const bottom = Math.round(s.lines[4] as number);
      let n = 0;
      for (let y = top; y <= bottom; y++) n += ink[y * w + x] as number;
      return n >= (bottom - top + 1) * 0.92;
    });
  const pastTop = (x: number) => {
    const y = Math.round((first.lines[0] as number) - space * 0.9);
    return y >= 0 && ink[y * w + x] === 1;
  };
  const pastBottom = (x: number) => {
    const y = Math.round((last.lines[4] as number) + space * 0.9);
    return y < h && ink[y * w + x] === 1;
  };
  // a stem has a notehead on it: a wide run of ink across x in one of the staff's spaces
  const headed = (x: number) =>
    sys.some((s) =>
      s.lines.slice(0, 4).some((y, k) => {
        const row = Math.round((y + (s.lines[k + 1] as number)) / 2) * w;
        if (!ink[row + x]) return false;
        let a = x;
        let b = x;
        while (a > 0 && ink[row + a - 1]) a--;
        while (b < w - 1 && ink[row + b + 1]) b++;
        return b - a + 1 > Math.max(5, space * 0.6);
      }),
    );
  const xs: number[] = [];
  for (let x = Math.max(0, left - 2); x <= Math.min(w - 1, right + 2); ) {
    if (!covers(x)) {
      x++;
      continue;
    }
    let end = x;
    while (end + 1 < w && covers(end + 1)) end++;
    const wide = end - x + 1;
    const mid = Math.round((x + end) / 2);
    // thin (a line, or a thick final one), standing within the system
    if (wide <= Math.max(4, thickness * 6) && !(pastTop(mid) && pastBottom(mid)) && !headed(mid)) xs.push(mid);
    x = end + 1;
  }
  // the system's own start and end belong to it even when not drawn as lines
  const out = xs.filter((x, i) => i === 0 || x - (xs[i - 1] as number) > space * 1.5);
  if (!out.length || (out[0] as number) - left > space * 2) out.unshift(left);
  if (right - (out[out.length - 1] as number) > space * 2) out.push(right);
  return out;
}

/** The row with the least ink between two rows (a strip's cut), leaning toward the lower one. */
function quietRow(ink: Uint8Array, w: number, from: number, to: number): number {
  let best = Math.round((from + to) / 2);
  let least = Number.POSITIVE_INFINITY;
  const start = Math.round(from + (to - from) * 0.35);
  for (let y = start; y <= Math.round(to); y++) {
    let n = 0;
    for (let x = 0; x < w; x += 2) n += ink[y * w + x] as number;
    if (n < least) {
      least = n;
      best = y;
    }
  }
  return best;
}

export function findSystems(ink: Uint8Array, w: number, h: number): PageLayout {
  const { thickness, gap } = measureLines(ink, w, h);
  const spacing = gap + thickness;
  const found = staves(lineRows(ink, w, h, thickness), spacing).map(
    (lines): FoundStaff => ({ lines, ...extent(ink, w, lines) }),
  );
  // staves joined at the left are one system
  const groups: FoundStaff[][] = [];
  for (const s of found) {
    const prev = groups.at(-1);
    const above = prev?.at(-1);
    if (prev && above) {
      const from = above.lines[4] as number;
      const to = s.lines[0] as number;
      const x0 = Math.max(0, Math.min(above.left, s.left) - Math.round(spacing * 3));
      const x1 = Math.min(w - 2, Math.max(above.left, s.left) + Math.round(spacing * 1.5));
      let link = false;
      for (let x = x0; x <= x1 && !link; x++) link = joined(ink, w, x, from, to);
      if (link) {
        prev.push(s);
        continue;
      }
    }
    groups.push([s]);
  }
  const systems: FoundSystem[] = groups.map((g) => ({
    staves: g,
    bars: barLines(ink, w, h, g, thickness, spacing),
    top: 0,
    bottom: h,
    left: Math.min(...g.map((s) => s.left)),
    right: Math.max(...g.map((s) => s.right)),
  }));
  // the strips: cut in the quietest row between systems; the first and last get room for what
  // stands above and below them (dynamics, lyrics, ledger lines)
  systems.forEach((sys, i) => {
    const top = (sys.staves[0] as FoundStaff).lines[0] as number;
    const bottom = (sys.staves[sys.staves.length - 1] as FoundStaff).lines[4] as number;
    const prev = systems[i - 1];
    const next = systems[i + 1];
    sys.top = prev ? prev.bottom : Math.max(0, Math.round(top - spacing * 5));
    sys.bottom = next
      ? quietRow(ink, w, bottom, (next.staves[0] as FoundStaff).lines[0] as number)
      : Math.min(h, Math.round(bottom + spacing * 6));
  });
  return { space: spacing, thickness, systems };
}
