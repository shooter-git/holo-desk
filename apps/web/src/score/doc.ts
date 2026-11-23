/**
 * The score as laid out now, shared by the drawing, the writing and the editing: made again only
 * when the song's music changes. A change to the mix (a fader, a knob, a mute) is a new song with the
 * same music, and keeps the score it has: nothing is notated, engraved or measured again for it.
 */
import { notate, type ScoreDoc } from '@holo/score';
import type { Note, Project } from '@holo/session';
import { store } from '../app/store.ts';
import { Entry } from './entry.ts';
import { sameMusic } from './same-music.ts';

let cached: { project: Project; key: string; doc: ScoreDoc } | null = null;

export function scoreOf(project: Project): ScoreDoc {
  const s = store.get();
  const track = project.tracks.find((t) => t.id === s.selectedTrack);
  const part = !s.scoreAll && track?.kind === 'instrument' ? track.id : null;
  const key = s.scoreAll ? '*' : (part ?? '');
  if (cached && cached.key === key && sameMusic(cached.project, project)) {
    cached.project = project;
    return cached.doc;
  }
  const doc = notate(project, s.scoreAll || !part ? {} : { tracks: [part] });
  cached = { project, key, doc };
  return doc;
}

/** The score of the song now (null with no song). */
export function scoreNow(): ScoreDoc | null {
  const p = store.get().project;
  return p ? scoreOf(p) : null;
}

/** Writing in the Score: its caret, and what keys, clicks and the palette do there. */
export const entry = new Entry(scoreOf);

const shown = new WeakMap<ScoreDoc, Set<Note>>();

/** The notes a score draws. */
export function notesIn(doc: ScoreDoc): Set<Note> {
  let set = shown.get(doc);
  if (!set) {
    set = new Set([...doc.refs.values()].map((r) => r.note));
    shown.set(doc, set);
  }
  return set;
}
