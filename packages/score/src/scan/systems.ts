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
  /** Between two staff lines (center to center), and a line's thickness. */
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
    let color = ink[x] as number;
    let lastBlack = 0;
    for (let y = 0; y <= h; y++) {
      const v = y < h ? (ink[y * w + x] as number) : 1 - color;
      if (v === color) {
        run++;
        continue;
      }
      if (color === 1 && run < 64) {
        black[run] = (black[run] as number) + 1;
        lastBlack = run;
      } else if (color === 0 && run < 128 && lastBlack > 0 && lastBlack < 8) {
        white[run] = (white[run] as number) + 1;
      }
      color = v;
      run = 1;
    }
  }
  const thickness = Math.max(1, mode(black, 1, 12));
  const gap = Math.max(3, mode(white, 3, 120));
  return { thickness, gap };
}

/** A staff line candidate: its row, and how much of the page's middle it crosses (0 to 1). */
interface LineRow {
  y: number;
  cover: number;
}

/**
 * Rows of ink that run across most of the page's middle, or a long way unbroken (a short last system
 * stops well before the right margin): staff line candidates, merged into lines.
 */
function lineRows(ink: Uint8Array, w: number, h: number, thickness: number, spacing: number): LineRow[] {
  const x0 = Math.floor(w * 0.2);
  const x1 = Math.floor(w * 0.8);
  const span = x1 - x0;
  // a row with its neighbors: a thin, faint line a little off level wanders over a few rows (staves
  // need five evenly spaced lines, so a little generosity here finds no false ones)
  const at = (x: number, y: number) =>
    ink[y * w + x] || (y > 0 && ink[(y - 1) * w + x]) || (y + 1 < h && ink[(y + 1) * w + x]) ? 1 : 0;
  // (how much of the row is ink over a stretch of it, an eighth of the page or eight staff spaces,
  // wherever along the row that's most: a short system's line nearly fills such a stretch, uneven or
  // broken as a photo leaves it, where a line of text, a beam or a row of noteheads doesn't come near)
  const stretch = Math.round(Math.max(w * 0.12, spacing * 8));
  const counts: number[] = [];
  const runs: number[] = [];
  const sums = new Int32Array(w + 1);
  for (let y = 0; y < h; y++) {
    let n = 0;
    for (let x = x0; x < x1; x++) n += at(x, y);
    counts.push(n);
    for (let x = 0; x < w; x++) sums[x + 1] = (sums[x] as number) + at(x, y);
    let most = 0;
    for (let x = 0; x + stretch <= w; x += 4)
      most = Math.max(most, (sums[x + stretch] as number) - (sums[x] as number));
    runs.push(most / stretch);
  }
  const across = counts.map((n) => n > span * 0.4);
  // the rows of each kind merged into lines, each line a few rows thick at most
  const bands = (take: (y: number) => boolean, cover: (y0: number, y1: number) => number): LineRow[] => {
    const out: LineRow[] = [];
    for (let y = 0; y < h; ) {
      if (!take(y)) {
        y++;
        continue;
      }
      let end = y;
      while (end + 1 < h && take(end + 1)) end++;
      if (end - y + 1 <= thickness * 3 + 4) out.push({ y: (y + end) / 2, cover: cover(y, end) });
      y = end + 1;
    }
    return out;
  };
  const found = bands(
    (y) => !!across[y],
    (a, b) => Math.max(...counts.slice(a, b + 1)) / span,
  );
  // a long run alone, apart from the lines across the page, is a line too unless it lies beside one of
  // them, nearer than a staff space: a curled page's line caught again at its other height (a staff's
  // next line is a whole space away, and a short last system has no line across the page at all)
  const alone = bands(
    (y) => !across[y] && (runs[y] as number) >= 0.6,
    (a, b) => (Math.max(...runs.slice(a, b + 1)) * stretch) / span,
  ).filter((l) => !found.some((o) => Math.abs(o.y - l.y) < spacing * 0.7));
  return [...found, ...alone].sort((a, b) => a.y - b.y);
}

/**
 * Five lines evenly spaced make a staff. A faint line a photo lost leaves four, one gap twice the
 * others: that's a staff too, its missing line put back. Dense writing adds strays among a staff's
 * lines (a long beam, a dash, a line of curled paper caught at a second height), so a staff's five
 * may pass over up to two strays between them. Where the staves found overlap, five lines win over
 * four, then the lines that cross more of the page (a stray is a stroke, a staff line runs across):
 * no line belongs to two staves, and a stray just above or below a staff doesn't take its place.
 */
function staves(lines: LineRow[], spacing: number): number[][] {
  const near = (g: number, want: number) => Math.abs(g - want) <= Math.max(2, want * 0.25);
  const gapsOf = (ys: number[]) => ys.slice(1).map((y, k) => y - (ys[k] as number));
  const found: { lines: number[]; count: number; cover: number }[] = [];
  const add = (picked: LineRow[], staff: number[]) =>
    found.push({ lines: staff, count: picked.length, cover: picked.reduce((a, l) => a + l.cover, 0) });
  // five from a line on, each of the next few passed over or taken (two strays at most)
  const reach = spacing * 1.35 * 4 + 2;
  const pick = (chosen: LineRow[], next: number, strays: number) => {
    if (chosen.length === 5) {
      const ys = chosen.map((l) => l.y);
      const gaps = gapsOf(ys);
      const mean = gaps.reduce((a, b) => a + b, 0) / 4;
      if (gaps.every((g) => near(g, mean)) && Math.abs(mean - spacing) <= spacing * 0.35) add(chosen, ys);
      return;
    }
    const top = (chosen[0] as LineRow).y;
    for (let j = next; j <= next + strays && j < lines.length; j++) {
      const line = lines[j] as LineRow;
      if (line.y - top > reach) break;
      pick([...chosen, line], j + 1, strays - (j - next));
    }
  };
  for (let i = 0; i < lines.length; i++) pick([lines[i] as LineRow], i + 1, 2);
  // four in a row, one gap doubled
  for (let i = 0; i + 3 < lines.length; i++) {
    const four = lines.slice(i, i + 4);
    const ys = four.map((l) => l.y);
    const gaps = gapsOf(ys);
    const span = ((ys[3] as number) - (ys[0] as number)) / 4;
    const double = gaps.findIndex((g) => near(g, span * 2));
    if (
      Math.abs(span - spacing) <= spacing * 0.35 &&
      double >= 0 &&
      gaps.every((g, k) => k === double || near(g, span))
    ) {
      ys.splice(double + 1, 0, ((ys[double] as number) + (ys[double + 1] as number)) / 2);
      add(four, ys);
    }
  }
  found.sort((a, b) => b.count - a.count || b.cover - a.cover || (a.lines[0] as number) - (b.lines[0] as number));
  const out: number[][] = [];
  for (const { lines: s } of found) {
    const clear = out.every((o) => (s[0] as number) > (o[4] as number) || (s[4] as number) < (o[0] as number));
    if (clear) out.push(s);
  }
  return out.sort((a, b) => (a[0] as number) - (b[0] as number));
}

/** Where a staff's lines start and end across the page. */
/**
 * Where a staff's lines start and end across the page: followed out from its middle each way while
 * four of its five lines go on, a row up or down a column at most (a curled page bends a staff, so
 * at its ends its lines aren't where they were across the middle), over gaps of up to a staff space;
 * or, where it reaches further, scanned in from the page's edge.
 */
function extent(
  ink: Uint8Array,
  w: number,
  h: number,
  lines: number[],
  space: number,
): { left: number; right: number } {
  const hits = (x: number, d: number) =>
    lines.filter((y) => {
      const r = Math.round(y + d);
      return [r - 1, r, r + 1].some((row) => row >= 0 && row < h && ink[row * w + x]);
    }).length;
  // a column where the lines are as found, nearest the page's middle
  let mid = -1;
  for (let k = 0; k < w && mid < 0; k++) {
    for (const x of [Math.floor(w / 2) - k, Math.floor(w / 2) + k]) {
      if (x >= 0 && x < w && hits(x, 0) >= 4) {
        mid = x;
        break;
      }
    }
  }
  // (as before: from each side of the page in, the first column with four lines where they were found
  // across the middle; a bar line at a staff's end is found so, where its lines may have faded)
  let left = 0;
  while (left < w && hits(left, 0) < 4) left++;
  let right = w - 1;
  while (right > left && hits(right, 0) < 4) right--;
  if (mid < 0) return { left, right };
  const reach = Math.max(2, Math.round(space * 0.6));
  const follow = (by: number) => {
    let d = 0;
    let last = mid;
    let gap = 0;
    for (let x = mid + by; x >= 0 && x < w; x += by) {
      let best = -1;
      let most = 0;
      for (const t of [d, d - 1, d + 1]) {
        if (Math.abs(t) > reach) continue;
        const n = hits(x, t);
        if (n > most) {
          most = n;
          best = t;
        }
      }
      if (most >= 4) {
        d = best;
        last = x;
        gap = 0;
      } else if (++gap > space) break;
    }
    return last;
  };
  // whichever reaches further: following finds a curled staff's start the scan from the edge passes
  return { left: Math.min(left, follow(-1)), right: Math.max(right, follow(1)) };
}

/**
 * Whether a line of ink runs from one staff's bottom line to the next one's top line, starting at
 * column x. A photo of curled paper slants and bends it, so it's followed down a row at a time, a
 * column either way at most; a faint print breaks it, so short gaps are passed over. Ink on four
 * rows in five, no gap longer than half a staff space, is a line: a stem or a word at the left of
 * two systems reaches only part of the way across, and leaves more paper than that.
 */
function joined(ink: Uint8Array, w: number, x: number, from: number, to: number, space: number): boolean {
  let n = 0;
  let total = 0;
  let gap = 0;
  // (a line leans a little; a slur's end, a glissando or a scribble crossing at the left leans far
  // more: it may wander a staff space from where it started, no further)
  const start = x;
  const reach = Math.max(3, space);
  for (let y = Math.round(from); y <= Math.round(to); y++, total++) {
    const at = [x, x - 1, x + 1].find((c) => c >= 0 && c < w && Math.abs(c - start) <= reach && ink[y * w + c]);
    if (at === undefined) {
      if (++gap > space / 2) return false;
      continue;
    }
    x = at;
    gap = 0;
    n++;
  }
  return total > 0 && n / total >= 0.8;
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

/**
 * Going from row `from` toward row `to` (up or down), the middle of the first band of clear paper
 * across columns x0 to x1: a space and a half of rows with next to no ink, more than lies between two
 * ledger lines, so where the music around a staff ends. With none (a title or text crowding in), the
 * row with least ink, the nearest of equals.
 */
function clearRow(
  ink: Uint8Array,
  w: number,
  h: number,
  x0: number,
  x1: number,
  from: number,
  to: number,
  spacing: number,
): number {
  const by = to < from ? -1 : 1;
  const need = Math.max(3, Math.round(spacing * 1.5));
  // a speck or two of dust is clear paper still
  const most = Math.max(2, Math.round((x1 - x0) / 400));
  let run = 0;
  let best = Math.round(from);
  let least = Number.POSITIVE_INFINITY;
  for (let y = Math.round(from); by < 0 ? y >= to : y <= to; y += by) {
    if (y < 0 || y >= h) break;
    let n = 0;
    for (let x = Math.max(0, x0); x < Math.min(w, x1); x += 2) n += ink[y * w + x] as number;
    if (n < least) {
      least = n;
      best = y;
    }
    run = n <= most ? run + 1 : 0;
    if (run >= need) return y - (by * need) / 2;
  }
  return Math.max(0, Math.min(h, best));
}

export function findSystems(ink: Uint8Array, w: number, h: number): PageLayout {
  const { thickness, gap } = measureLines(ink, w, h);
  const spacing = gap + thickness;
  const found = staves(lineRows(ink, w, h, thickness, spacing), spacing).map(
    (lines): FoundStaff => ({ lines, ...extent(ink, w, h, lines, spacing) }),
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
      for (let x = x0; x <= x1 && !link; x++) link = joined(ink, w, x, from, to, spacing);
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
  // stands above and below them (dynamics, lyrics, ledger lines), and more where notes on many ledger
  // lines reach further: on to the first clear paper, as far as a dozen spaces out
  systems.forEach((sys, i) => {
    const top = (sys.staves[0] as FoundStaff).lines[0] as number;
    const bottom = (sys.staves[sys.staves.length - 1] as FoundStaff).lines[4] as number;
    const prev = systems[i - 1];
    const next = systems[i + 1];
    sys.top = prev
      ? prev.bottom
      : Math.max(
          0,
          Math.round(clearRow(ink, w, h, sys.left, sys.right, top - spacing * 5, top - spacing * 12, spacing)),
        );
    sys.bottom = next
      ? quietRow(ink, w, bottom, (next.staves[0] as FoundStaff).lines[0] as number)
      : Math.min(
          h,
          Math.round(clearRow(ink, w, h, sys.left, sys.right, bottom + spacing * 6, bottom + spacing * 12, spacing)),
        );
  });
  return { space: spacing, thickness, systems };
}
