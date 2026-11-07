/**
 * A scan: photographed or scanned pages of sheet music on their way into a song. Kept beside the song
 * on the host (`data/scans/<id>/`): the pages, a strip of each system to read it by, and this record of
 * where each system is and how far its reading has got. The server, the command line and the studio
 * all read it through `parseScan`.
 */

export type SystemState = 'new' | 'read' | 'checked' | 'approved';

export interface ScanSystem {
  /** Its place on its page, from the top. */
  k: number;
  /** Its strip (pixels on the straightened page). */
  top: number;
  bottom: number;
  left: number;
  right: number;
  /** How many staves it has, and its bar lines' x on the page. */
  staves: number;
  bars: number[];
  state: SystemState;
  /** The song's bar numbers it was written into: [first, last]. */
  written?: [number, number];
  /** What a check or a reading flagged. */
  flags?: string[];
}

export interface ScanPage {
  n: number;
  /** The straightened page's size, and its image's type. */
  w: number;
  h: number;
  type: 'png' | 'jpeg' | 'webp';
  systems: ScanSystem[];
}

export interface Scan {
  id: string;
  /** The song it goes into, and the part when it's for one. */
  project: string;
  track?: string;
  title: string;
  created: string;
  pages: ScanPage[];
}

export const SCAN_ID = /^scn_[a-z0-9]{6,24}$/;
const STATES = new Set<SystemState>(['new', 'read', 'checked', 'approved']);
const TYPES = new Set(['png', 'jpeg', 'webp']);

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === 'object' && v !== null && !Array.isArray(v);
const n = (v: unknown, lo = 0, hi = 1e6): number | null =>
  typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi ? v : null;

function system(v: unknown, k: number): ScanSystem | null {
  if (!isObj(v)) return null;
  const top = n(v.top);
  const bottom = n(v.bottom);
  const left = n(v.left);
  const right = n(v.right);
  if (top === null || bottom === null || left === null || right === null || bottom <= top) return null;
  const out: ScanSystem = {
    k,
    top,
    bottom,
    left,
    right,
    staves: Math.round(n(v.staves, 1, 32) ?? 1),
    bars: Array.isArray(v.bars)
      ? v.bars
          .map((x) => n(x))
          .filter((x): x is number => x !== null)
          .slice(0, 200)
      : [],
    state: STATES.has(v.state as SystemState) ? (v.state as SystemState) : 'new',
  };
  if (Array.isArray(v.written) && v.written.length === 2) {
    const a = n(v.written[0], 0, 100000);
    const b = n(v.written[1], 0, 100000);
    if (a !== null && b !== null) out.written = [a, b];
  }
  if (Array.isArray(v.flags))
    out.flags = v.flags
      .filter((f): f is string => typeof f === 'string')
      .map((f) => f.slice(0, 300))
      .slice(0, 40);
  return out;
}

/** A scan record from untrusted JSON, or null. */
export function parseScan(v: unknown): Scan | null {
  if (!isObj(v) || typeof v.id !== 'string' || !SCAN_ID.test(v.id) || typeof v.project !== 'string') return null;
  const pages: ScanPage[] = [];
  for (const [i, p] of (Array.isArray(v.pages) ? v.pages : []).entries()) {
    if (!isObj(p)) continue;
    const w = n(p.w, 1, 20000);
    const h = n(p.h, 1, 20000);
    if (w === null || h === null) continue;
    const systems = (Array.isArray(p.systems) ? p.systems : [])
      .map((s, k) => system(s, k))
      .filter((s): s is ScanSystem => s !== null);
    pages.push({ n: i, w, h, type: TYPES.has(p.type as string) ? (p.type as ScanPage['type']) : 'png', systems });
  }
  const scan: Scan = {
    id: v.id,
    project: v.project.slice(0, 64),
    title: typeof v.title === 'string' ? v.title.slice(0, 120) : 'Scan',
    created: typeof v.created === 'string' ? v.created : new Date().toISOString(),
    pages,
  };
  if (typeof v.track === 'string') scan.track = v.track.slice(0, 64);
  return scan;
}

/** Where a system's reading has got, across the scan: how many of each state. */
export function scanProgress(scan: Scan): Record<SystemState, number> {
  const out: Record<SystemState, number> = { new: 0, read: 0, checked: 0, approved: 0 };
  for (const p of scan.pages) for (const s of p.systems) out[s.state]++;
  return out;
}
