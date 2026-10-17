/**
 * The Songs dialog's groups: your own songs, then each experience's (the creation a song belongs to),
 * with the pieces its folder has that the studio hasn't opened yet. You move between several
 * experiences' music in one studio; each group says whose songs these are and what builds them.
 */
import type { Creation, CreationEngine, CreationPiece, ProjectRow } from './api.ts';

export interface SongGroup {
  /** The creation's name; '' for your own songs. */
  key: string;
  title: string;
  /** As the creations folder has it (null for your own songs, or a creation that isn't there). */
  creation: Creation | null;
  songs: ProjectRow[];
  /** Pieces in the creation's folder not yet open in the studio. */
  pieces: CreationPiece[];
}

export function groupSongs(rows: ProjectRow[], creations: Creation[]): SongGroup[] {
  const own: SongGroup = { key: '', title: 'Your songs', creation: null, songs: [], pieces: [] };
  const groups = new Map<string, SongGroup>();
  for (const c of creations) {
    groups.set(c.name, {
      key: c.name,
      title: c.title,
      creation: c,
      songs: [],
      pieces: c.pieces.filter((p) => !p.project || !rows.some((r) => r.id === p.project)),
    });
  }
  for (const r of rows) {
    if (!r.creation) {
      own.songs.push(r);
      continue;
    }
    let g = groups.get(r.creation);
    if (!g) {
      g = { key: r.creation, title: r.creation, creation: null, songs: [], pieces: [] };
      groups.set(r.creation, g);
    }
    g.songs.push(r);
  }
  // the experiences worked on last come first; those with nothing in the studio after them
  const latest = (g: SongGroup) => g.songs.reduce((m, s) => (s.modified > m ? s.modified : m), '');
  const rest = [...groups.values()].sort(
    (a, b) => latest(b).localeCompare(latest(a)) || a.title.localeCompare(b.title),
  );
  return [own, ...rest];
}

/**
 * What a group says about the engine its experience builds with, when that isn't the studio's
 * (null when it is, or the creation pins none): a short badge and the longer story.
 */
export function engineBadge(title: string, e: CreationEngine | null): { text: string; detail: string } | null {
  if (!e || e.relation === 'same') return null;
  const day = (iso: string | null) => (iso ? ` of ${iso.slice(0, 10)}` : '');
  const builds = `${title} builds its music with HO[LO]'s engine ${e.label}${day(e.date)} (Node.js ${e.node})`;
  if (e.relation === 'older')
    return {
      text: `Builds with engine ${e.label} · holo update-engine`,
      detail:
        `${builds}; the studio plays a newer one, ${e.studio}${day(e.studioDate)}, so what you hear here can differ ` +
        `from its build. Run holo update-engine in the project to move it to the studio's engine: it rebuilds ` +
        `every song and says how far each one moved.`,
    };
  if (e.relation === 'newer')
    return {
      text: `Builds with a newer engine, ${e.label}`,
      detail: `${builds}, newer than the studio's (${e.studio}${day(e.studioDate)}). Rebuild the studio (pnpm up) to hear it as it builds.`,
    };
  return {
    text: `Builds with engine ${e.label}`,
    detail: `${builds}, not the studio's (${e.studio}). holo update-engine in the project moves it to the studio's engine.`,
  };
}
