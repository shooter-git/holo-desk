/**
 * The rows of the tracks pane where the song has stacks: a row for each track shown, and a header's
 * row before each stack's (its tracks folded away under it while the stack is closed here). A header
 * is a row as tall as a track's, so a row's place is still its number times a row's height, and the
 * pane lays out, draws and finds what's under the pointer as it always has.
 *
 * The pane works from a song whose tracks are its rows (`rowsSong`). A header's row is a stand-in
 * track there: it has the stack's name and colour and nothing to play, and `stackRow` tells it from
 * a track. Nothing made here reaches the song: a change is made by a track's or a stack's own id.
 *
 * Whether a stack is open is this device's own, kept by song (`folds`): closing one on a phone
 * doesn't close it on the desktop, and it's never an undo step.
 */
import { newChannel, type Op, type Project, type Stack, type Track } from '@holo/session';
import { type Show, shownTracks } from './shown-tracks.ts';

export type Row =
  | { kind: 'track'; track: Track; stack?: Stack }
  | { kind: 'stack'; stack: Stack; tracks: Track[]; open: boolean };

const FOLDED_NONE: readonly string[] = [];

/** The rows: the tracks shown, each stack's header before the first of its tracks. */
export function trackRows(project: Pick<Project, 'tracks' | 'stacks'>, show: Show): Row[] {
  const stacks = new Map((project.stacks ?? []).map((s) => [s.id, s]));
  const folded = show.folded ?? FOLDED_NONE;
  // (a stack is there when View shows any of its tracks, open or closed)
  const seen = shownTracks(project.tracks, { inactiveTracks: show.inactiveTracks });
  const rows: Row[] = [];
  const headed = new Set<string>();
  for (const track of seen) {
    const stack = track.stack ? stacks.get(track.stack) : undefined;
    if (!stack) {
      rows.push({ kind: 'track', track });
      continue;
    }
    const open = !folded.includes(stack.id);
    if (!headed.has(stack.id)) {
      headed.add(stack.id);
      rows.push({ kind: 'stack', stack, tracks: project.tracks.filter((t) => t.stack === stack.id), open });
    }
    if (open) rows.push({ kind: 'track', track, stack });
  }
  return rows;
}

/** A row's own id: a track's, or a stack's with this before it. */
export const STACK_ROW = 'stack:';
export const rowId = (row: Row): string => (row.kind === 'track' ? row.track.id : `${STACK_ROW}${row.stack.id}`);
export const isStackRowId = (id: string | null | undefined): boolean => !!id && id.startsWith(STACK_ROW);

// ---- the song as the pane lays it out ----

const stood = new WeakMap<Track, Extract<Row, { kind: 'stack' }>>();
const standIns = new WeakMap<Stack, Map<string, Track>>();
const laidOut = new WeakMap<Project, { inactive: boolean; folded: readonly string[]; song: Project; rows: Row[] }>();

/** The stack a row of the pane's song is the header of (undefined for a track). */
export const stackRow = (track: Track | null | undefined): Extract<Row, { kind: 'stack' }> | undefined =>
  track ? stood.get(track) : undefined;

/** A header's stand-in among the pane's tracks: the same one while the stack, its tracks and its fold are the same. */
function standIn(row: Extract<Row, { kind: 'stack' }>): Track {
  const key = `${row.open}|${row.tracks.map((t) => t.id).join(',')}|${row.tracks[0]?.color ?? ''}`;
  let made = standIns.get(row.stack);
  if (!made) {
    made = new Map();
    standIns.set(row.stack, made);
  }
  let track = made.get(key);
  if (!track) {
    made.clear();
    track = {
      id: `${STACK_ROW}${row.stack.id}`,
      name: row.stack.name,
      color: row.stack.color ?? row.tracks[0]?.color ?? '#7c8a99',
      kind: 'instrument',
      instrument: { type: 'none' },
      articulations: [],
      input: { port: '', channel: 0 },
      armed: false,
      midiFx: [],
      regions: [],
      channel: newChannel(),
      stack: row.stack.id,
    };
    made.set(key, track);
  }
  // (the row it stands for, as it is now: its tracks are new objects whenever one of them changes)
  stood.set(track, row);
  return track;
}

/**
 * The song as the tracks pane lays it out: its `tracks` are the pane's rows, a stand-in for each
 * stack's header among them. The song itself where it has no stacks and View leaves nothing out.
 */
export function rowsSong(project: Project, show: Show): Project {
  const folded = show.folded?.length ? show.folded : FOLDED_NONE;
  if (!project.stacks?.length) {
    const tracks = shownTracks(project.tracks, { inactiveTracks: show.inactiveTracks });
    if (tracks === project.tracks) return project;
  }
  const kept = laidOut.get(project);
  if (kept && kept.inactive === show.inactiveTracks && kept.folded === folded) return kept.song;
  const rows = trackRows(project, { inactiveTracks: show.inactiveTracks, folded });
  const song: Project = { ...project, tracks: rows.map((r) => (r.kind === 'track' ? r.track : standIn(r))) };
  laidOut.set(project, { inactive: show.inactiveTracks, folded, song, rows });
  return song;
}

// ---- dragging a row to a new place ----

/**
 * What dragging the row `id` to the `index`th place among the rows does to the song: a track moved
 * (into a stack when it lands among its tracks or under its open header, out of its own when it
 * lands outside it), or a stack moved whole. Null when nothing would change.
 *
 * At a stack's lower edge a track stays as it was: one of the stack's is still in it (at its end), and
 * another is below it, outside.
 */
export function planDrop(
  project: Pick<Project, 'tracks' | 'stacks'>,
  show: Show,
  id: string,
  index: number,
): Op | null {
  const rows = trackRows(project, show);
  const from = rows.findIndex((r) => rowId(r) === id);
  const moved = rows[from];
  if (!moved) return null;
  const others = rows.filter((_, i) => i !== from);
  const at = Math.max(0, Math.min(others.length, index));
  const firstOf = (row: Row | undefined): Track | undefined => (row?.kind === 'track' ? row.track : row?.tracks[0]);

  if (moved.kind === 'stack') {
    const mine = new Set(moved.tracks.map((t) => t.id));
    const rest = project.tracks.filter((t) => !mine.has(t.id));
    // the first row from there on that isn't this stack's own
    const below = others.slice(at).find((r) => !(r.kind === 'track' && r.stack?.id === moved.stack.id));
    const anchor = firstOf(below);
    const to = anchor ? rest.findIndex((t) => t.id === anchor.id) : rest.length;
    const was = project.tracks.findIndex((t) => mine.has(t.id));
    const before = project.tracks.slice(0, was).filter((t) => !mine.has(t.id)).length;
    return to === before ? null : { op: 'moveStack', stack: moved.stack.id, index: to };
  }

  const track = moved.track;
  const above = others[at - 1];
  const below = others[at];
  const stackOfRow = (row: Row | undefined): Stack | undefined => (row?.kind === 'track' ? row.stack : undefined);
  let into: Stack | undefined;
  if (above?.kind === 'stack') into = above.open ? above.stack : undefined;
  else if (stackOfRow(above) && stackOfRow(above)?.id === stackOfRow(below)?.id) into = stackOfRow(above);
  else if (stackOfRow(above) && stackOfRow(above)?.id === track.stack) into = stackOfRow(above);
  const rest = project.tracks.filter((t) => t.id !== track.id);
  // where it goes among the song's other tracks: before the track under it, or (kept in a stack at its
  // lower edge) after the track over it
  const edge = into && stackOfRow(below)?.id !== into.id && above?.kind === 'track';
  const anchor = edge ? undefined : firstOf(below);
  const to = edge
    ? rest.findIndex((t) => t.id === (above as Extract<Row, { kind: 'track' }>).track.id) + 1
    : anchor
      ? rest.findIndex((t) => t.id === anchor.id)
      : rest.length;
  const stays = (track.stack ?? null) === (into?.id ?? null);
  if (stays && to === project.tracks.findIndex((t) => t.id === track.id)) return null;
  return {
    op: 'moveTrack',
    track: track.id,
    index: to,
    ...(stays ? {} : { stack: into ? into.id : null }),
  };
}

// ---- which stacks are closed here ----

const KEY = 'holo:stack-folds';
/** How many songs' folds are remembered. */
const SONGS = 20;

type Shelf = Pick<Storage, 'getItem' | 'setItem'>;
const shelfNow = (): Shelf | null => {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    return null;
  }
};

function read(shelf: Shelf | null): [string, string[]][] {
  try {
    const raw = JSON.parse(shelf?.getItem(KEY) ?? '[]');
    if (!Array.isArray(raw)) return [];
    return raw.filter(
      (e): e is [string, string[]] =>
        Array.isArray(e) && typeof e[0] === 'string' && Array.isArray(e[1]) && e[1].every((x) => typeof x === 'string'),
    );
  } catch {
    return [];
  }
}

/** The stacks closed on this device in a song (none, for a song it hasn't closed any in). */
export function foldsOf(song: string, shelf: Shelf | null = shelfNow()): string[] {
  return read(shelf).find(([id]) => id === song)?.[1] ?? [];
}

/** Keep which stacks are closed in a song (the last few songs': the oldest is forgotten). */
export function keepFolds(song: string, folded: readonly string[], shelf: Shelf | null = shelfNow()): void {
  try {
    const others = read(shelf).filter(([id]) => id !== song);
    const next = folded.length ? [[song, [...folded]] as [string, string[]], ...others] : others;
    shelf?.setItem(KEY, JSON.stringify(next.slice(0, SONGS)));
  } catch {
    // (storage refused or full: the stacks are open again after a reload)
  }
}

/** The closed stacks that the song still has (one deleted, or unstacked elsewhere, is dropped). */
export function foldsKept(project: Pick<Project, 'stacks'> | null, folded: readonly string[]): readonly string[] {
  const have = new Set((project?.stacks ?? []).map((s) => s.id));
  const kept = folded.filter((id) => have.has(id));
  return kept.length === folded.length ? folded : kept;
}
