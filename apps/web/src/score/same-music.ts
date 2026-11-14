/**
 * Whether two versions of a song are the same music, whatever happened to the mix between them.
 * The score is engraved from the music, and engraving is the most work the page does: a fader
 * dragged with the Score open is a new song on every move of the pointer, and none of them needs
 * a new score.
 *
 * Told by leaving the mix out, not by listing the music: everything else of the song, and of each
 * track, must be the very same object. A part of the song added later counts as music until it's
 * named here.
 */
import type { Project, Track } from '@holo/session';

/** The song's parts no score reads: the mix, where the cycle stands, and how many times it's been saved. */
const NOT_MUSIC: ReadonlySet<string> = new Set(['buses', 'master', 'cycle', 'revision', 'modified']);
/** And a track's: its channel (fader, pan, plugins, sends, stage), and how it's played into and recorded. */
const NOT_TRACK_MUSIC: ReadonlySet<string> = new Set(['channel', 'armed', 'input', 'audioInput', 'midiFx']);

function same(a: object, b: object, leaveOut: ReadonlySet<string>): boolean {
  const x = a as Record<string, unknown>;
  const y = b as Record<string, unknown>;
  for (const k of Object.keys(x)) if (!leaveOut.has(k) && x[k] !== y[k]) return false;
  for (const k of Object.keys(y)) if (!leaveOut.has(k) && !(k in x)) return false;
  return true;
}

function sameTracks(a: Track[], b: Track[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((t, i) => t === b[i] || same(t, b[i] as Track, NOT_TRACK_MUSIC));
}

export function sameMusic(a: Project, b: Project): boolean {
  if (a === b) return true;
  return same(a, b, new Set([...NOT_MUSIC, 'tracks'])) && sameTracks(a.tracks, b.tracks);
}
