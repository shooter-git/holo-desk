/**
 * A song changed in two places since one version of it: what changed in one (`mine`) put onto the
 * other (`theirs`), part by part. The studio does this to keep the user's changes the host didn't get
 * when the agent saved its own there meanwhile (actions.ts, picking up), so the agent's are kept just
 * as the host has them, ids and all, whatever operations made them.
 *
 * Parts are matched by what names them: objects by key; lists of things with an id (tracks, regions,
 * plugins, buses, markers, files), an automation lane's setting or a send's bus, by that. A part only
 * one side changed takes that side's; one both changed alike is kept; one both changed differently (a
 * region's notes edited on both sides, a track renamed two ways, one deleted what the other edited) is
 * a clash, and nothing is merged. Anything else (a list of notes, a tempo map) is one part.
 */
import { type Project, parseProject } from '@holo/session';

const CLASH = Symbol('clash');
type Merged = unknown | typeof CLASH;

/**
 * `mine`'s changes since `base` put onto `theirs` (which keeps its id, revision and when it was saved),
 * or null when they clash, or the result isn't a song the studio could open.
 */
export function mergeSongs(base: Project, mine: Project, theirs: Project): Project | null {
  // (which revision each was saved as isn't a change of the song's)
  const stamp = { revision: theirs.revision, modified: theirs.modified };
  const merged = merge({ ...base, ...stamp }, { ...mine, ...stamp }, theirs);
  if (merged === CLASH) return null;
  try {
    return parseProject(merged);
  } catch {
    return null;
  }
}

/** Whether two parts of a song are the same: the same value, or the same parts throughout. */
export function same(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== 'object' || typeof b !== 'object' || a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => same(x, b[i]));
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  const keys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  if (keys.length !== Object.keys(bo).filter((k) => bo[k] !== undefined).length) return false;
  return keys.every((k) => same(ao[k], bo[k]));
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);

function merge(base: unknown, mine: unknown, theirs: unknown): Merged {
  if (same(mine, base)) return theirs;
  if (same(theirs, base)) return mine;
  if (same(mine, theirs)) return theirs;
  if (isRecord(base) && isRecord(mine) && isRecord(theirs)) return mergeRecords(base, mine, theirs);
  if (Array.isArray(base) && Array.isArray(mine) && Array.isArray(theirs)) {
    const key = keyOf(base, mine, theirs);
    if (key) return mergeLists(base, mine, theirs, key);
  }
  return CLASH;
}

function mergeRecords(
  base: Record<string, unknown>,
  mine: Record<string, unknown>,
  theirs: Record<string, unknown>,
): Merged {
  const out: Record<string, unknown> = {};
  for (const k of new Set([...Object.keys(theirs), ...Object.keys(mine), ...Object.keys(base)])) {
    const v = merge(base[k], mine[k], theirs[k]);
    if (v === CLASH) return CLASH;
    if (v !== undefined) out[k] = v;
  }
  return out;
}

/** What names the things in three lists, when the same field does in all of them, once each. */
function keyOf(...lists: unknown[][]): string | null {
  for (const key of ['id', 'param', 'bus']) {
    const names = (list: unknown[]) =>
      list.every((x) => isRecord(x) && typeof x[key] === 'string') &&
      new Set(list.map((x) => (x as Record<string, unknown>)[key])).size === list.length;
    if (lists.every(names)) return key;
  }
  return null;
}

function mergeLists(base: unknown[], mine: unknown[], theirs: unknown[], key: string): Merged {
  const named = (list: unknown[]) => new Map(list.map((x) => [(x as Record<string, unknown>)[key] as string, x]));
  const [b, m, t] = [named(base), named(mine), named(theirs)];
  const kept = new Map<string, unknown>();
  for (const name of new Set([...t.keys(), ...m.keys(), ...b.keys()])) {
    const [bi, mi, ti] = [b.get(name), m.get(name), t.get(name)];
    // gone on one side, and left alone on the other: it goes; edited on the other: a clash
    if (bi !== undefined && (mi === undefined || ti === undefined)) {
      const other = mi === undefined ? ti : mi;
      if (other === undefined || same(other, bi)) continue;
      return CLASH;
    }
    const v = merge(bi, mi, ti);
    if (v === CLASH) return CLASH;
    kept.set(name, v);
  }
  // in the order of the side that reordered what was there (theirs, if neither did), with the other
  // side's new things after what comes before them there
  const order = (list: unknown[]) =>
    list.map((x) => (x as Record<string, unknown>)[key] as string).filter((n) => b.has(n) && kept.has(n));
  const mineMoved = !same(order(mine), order(base));
  const theirsMoved = !same(order(theirs), order(base));
  if (mineMoved && theirsMoved && !same(order(mine), order(theirs))) return CLASH;
  const [first, second] = mineMoved ? [mine, theirs] : [theirs, mine];
  const names = (first.map((x) => (x as Record<string, unknown>)[key] as string) as string[]).filter((n) =>
    kept.has(n),
  );
  const secondNames = second.map((x) => (x as Record<string, unknown>)[key] as string);
  for (const [i, name] of secondNames.entries()) {
    if (names.includes(name) || !kept.has(name)) continue;
    const before = secondNames
      .slice(0, i)
      .reverse()
      .find((n) => names.includes(n));
    names.splice(before === undefined ? 0 : names.indexOf(before) + 1, 0, name);
  }
  return names.map((n) => kept.get(n));
}
