/**
 * The song's chord symbols, as the Chords lane and the agent's `chords` write them: one at a tick,
 * set, changed, moved or removed. They're the same list the Score writes over its staves (its own
 * `setChordSymbol` makes the same change), so a chord typed in either place shows in both.
 */
import type { ChordMark, Op, Project } from '@holo/session';

/** The chords with the one at `tick` set to `symbol` (empty: removed); the same list when nothing changes. */
export function withChord(chords: readonly ChordMark[], tick: number, symbol: string): ChordMark[] {
  const text = symbol.trim();
  const others = chords.filter((c) => c.tick !== tick);
  const there = chords.find((c) => c.tick === tick);
  if (!text) return others.length === chords.length ? (chords as ChordMark[]) : others;
  if (there?.symbol === text && others.length === chords.length - 1) return chords as ChordMark[];
  return [...others, { tick, symbol: text }].sort((a, b) => a.tick - b.tick);
}

/** A chord set at a tick (or, with an empty symbol, removed): the operation, or none when nothing changes. */
export function chordOps(project: Pick<Project, 'chords'>, tick: number, symbol: string): Op[] {
  const chords = withChord(project.chords, tick, symbol);
  return chords === project.chords ? [] : [{ op: 'setProject', patch: { chords } }];
}

/** A chord moved to another tick (taking the place of one there): the operation, or none. */
export function moveChordOps(project: Pick<Project, 'chords'>, from: number, to: number): Op[] {
  const chord = project.chords.find((c) => c.tick === from);
  if (!chord || to === from) return [];
  const chords = withChord(withChord(project.chords, from, ''), to, chord.symbol);
  return [{ op: 'setProject', patch: { chords } }];
}
