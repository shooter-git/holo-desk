/**
 * Track stacks: tracks kept together under one header. A stack is a folder (its header folds its
 * tracks away, and mutes, solos or switches them off together); it may also name a bus, which its
 * header then controls (a summing stack: the tracks routed to that bus are mixed through it).
 *
 * A stack never changes what's heard by being one. A track's output is the track's own: naming a
 * bus on a stack routes nothing, and no operation here, and no reading of a song, moves a track's
 * output. Whoever makes a summing stack routes its tracks there in so many words, in the same step.
 *
 * What holds of every song: a stack's tracks sit together in the track list, one block; a track's
 * `stack` names a stack the song has; a stack has at least one track; a stack's `bus` names a bus
 * the song has. `healStacks` makes a song so (a song put together from two versions of itself, or
 * written by hand): by gathering a stack's stragglers to its first track, and by dropping what
 * points at nothing. It never takes a track out of a stack the song has.
 */
import type { Project, Stack, Track } from './types.ts';

/** Where each stack's block is in a list of tracks: its first track's index, and one past its last. */
export function stackBlocks(tracks: readonly Pick<Track, 'stack'>[]): Map<string, { start: number; end: number }> {
  const out = new Map<string, { start: number; end: number }>();
  tracks.forEach((t, i) => {
    if (!t.stack) return;
    const b = out.get(t.stack);
    if (b) b.end = i + 1;
    else out.set(t.stack, { start: i, end: i + 1 });
  });
  return out;
}

/** A stack's tracks, in the song's order. */
export const stackTracks = (project: Pick<Project, 'tracks'>, stack: string): Track[] =>
  project.tracks.filter((t) => t.stack === stack);

/** The stack a track is in, if any. */
export function stackOf(project: Pick<Project, 'tracks' | 'stacks'>, track: string): Stack | undefined {
  const id = project.tracks.find((t) => t.id === track)?.stack;
  return id ? project.stacks?.find((s) => s.id === id) : undefined;
}

/**
 * Where a track may go in a list it isn't in: `index` as asked, moved to keep every stack one block.
 * A track of `stack` stays within that stack's block (anywhere in the list when it's the stack's only
 * one). Any other never lands inside a block: one that was in the list (`from`: where it was) goes on
 * past the block, the way it was heading; one new to the list goes to the block's nearer edge.
 */
export function settle(tracks: readonly Pick<Track, 'stack'>[], index: number, stack?: string, from?: number): number {
  const at = Math.max(0, Math.min(tracks.length, Math.round(index)));
  const blocks = stackBlocks(tracks);
  const own = stack ? blocks.get(stack) : undefined;
  if (own) return Math.max(own.start, Math.min(own.end, at));
  for (const b of blocks.values()) {
    if (at <= b.start || at >= b.end) continue;
    if (from !== undefined) return from <= b.start ? b.end : b.start;
    return at - b.start <= b.end - at ? b.start : b.end;
  }
  return at;
}

/** A song's tracks and stacks as they must be (see above); the same song when they are already. */
export function healStacks<P extends Pick<Project, 'tracks' | 'stacks' | 'buses'>>(project: P): P {
  const listed = project.stacks ?? [];
  if (!listed.length && !project.tracks.some((t) => t.stack !== undefined)) return project;
  const buses = new Set(project.buses.map((b) => b.id));
  const used = new Set(project.tracks.map((t) => t.stack).filter((s): s is string => !!s));
  const seen = new Set<string>();
  // the stacks that have tracks, each once, a bus only where the song has it
  const stacks: Stack[] = [];
  let changed = false;
  for (const s of listed) {
    if (!used.has(s.id) || seen.has(s.id)) {
      changed = true;
      continue;
    }
    seen.add(s.id);
    if (s.bus !== undefined && !buses.has(s.bus)) {
      const { bus: _bus, ...rest } = s;
      stacks.push(rest);
      changed = true;
    } else stacks.push(s);
  }
  // a track of a stack the song doesn't have is in none
  let tracks = project.tracks;
  if (tracks.some((t) => t.stack !== undefined && !seen.has(t.stack))) {
    changed = true;
    tracks = tracks.map((t) => {
      if (t.stack === undefined || seen.has(t.stack)) return t;
      const { stack: _stack, ...rest } = t;
      return rest as Track;
    });
  }
  // each stack one block: its stragglers gathered to its first track, in the order they were in
  const blocks = stackBlocks(tracks);
  const together = [...blocks.entries()].every(([id, b]) => tracks.slice(b.start, b.end).every((t) => t.stack === id));
  if (!together) {
    changed = true;
    const placed = new Set<string>();
    const out: Track[] = [];
    for (const t of tracks) {
      if (!t.stack) out.push(t);
      else if (!placed.has(t.stack)) {
        placed.add(t.stack);
        out.push(...tracks.filter((x) => x.stack === t.stack));
      }
    }
    tracks = out;
  }
  if (!changed) return project;
  const next = { ...project, tracks } as P;
  if (stacks.length) next.stacks = stacks;
  else delete next.stacks;
  return next;
}
