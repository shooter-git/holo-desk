/**
 * Before and after (A/B): the agent asks the studio to play some bars as they were before its request,
 * then as they are now. Which song "before" is, and where the bars fall in each, worked out here with
 * no browser in it; actions.ts plays it.
 */
import { barToTick, firstBar, type Project } from '@holo/session';
import type { Step } from './store.ts';

/** A stretch of a song to play: the song (its cycle off, so it plays straight through), from a tick to a tick. */
export interface Pass {
  song: Project;
  from: number;
  to: number;
}

/**
 * The two passes for bars `from` up to `to` (not played): the song from before the job, then the song
 * now. The song from before is the one under the job's first step still in the undo history (the
 * steps after it, a user's edit in between or the job's later batches, all come after it). The bars
 * are counted in each song's own meter, as each shows them.
 */
export function comparePlan(
  steps: readonly Step[],
  now: Project,
  from: number,
  to: number,
): { before: Pass; after: Pass } | { error: string } {
  const first = steps[0];
  if (!first) return { error: 'The song from before isn’t in the undo history any more' };
  if (!(to > from) || from < firstBar(now.meter)) return { error: 'Those aren’t bars of the song' };
  const pass = (song: Project): Pass => ({
    song: { ...song, cycle: { ...song.cycle, on: false } },
    from: barToTick(song.meter, from),
    to: barToTick(song.meter, to),
  });
  return { before: pass(first.project), after: pass(now) };
}
