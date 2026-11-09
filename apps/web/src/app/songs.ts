/**
 * The Songs dialog's groups: your own songs, then each album (or artist without one) you put some
 * of them on, then each experience's (the creation a song belongs to), with the pieces its folder
 * has that the studio hasn't opened yet. You move between several artists' and experiences' music
 * in one studio; each group says whose songs these are and, for an experience, what builds them.
 */
import { type Field, rank, WEIGHT, words } from '../ui/search.ts';
import type { Creation, CreationEngine, CreationPiece, ProjectRow } from './api.ts';

export interface SongGroup {
  /** '' for your own songs, `album:<artist>/<album>` for an album, the creation's name for one. */
  key: string;
  /** Your songs with neither artist nor album; an album (or an artist's songs on none); an experience's. */
  kind: 'own' | 'album' | 'creation';
  /** The album's name, the artist's when it's on none, the creation's. */
  title: string;
  /** An album group's artist and album (both null for any other group). */
  artist: string | null;
  album: string | null;
  /** As the creations folder has it (null for your own songs, an album, or a creation that isn't there). */
  creation: Creation | null;
  songs: ProjectRow[];
  /** Pieces in the creation's folder not yet open in the studio. */
  pieces: CreationPiece[];
}

/** When a group's songs were last worked on ('' for none). */
const latest = (g: SongGroup) => g.songs.reduce((m, s) => (s.modified > m ? s.modified : m), '');
/** Those worked on last first; those with nothing in the studio after them, by title. */
const byLatest = (a: SongGroup, b: SongGroup) => latest(b).localeCompare(latest(a)) || a.title.localeCompare(b.title);
/** Albums by their artist A to Z (those by no one said last), and each artist's latest first. */
const byArtist = (a: SongGroup, b: SongGroup) =>
  (a.artist === null ? 1 : 0) - (b.artist === null ? 1 : 0) ||
  (a.artist ?? '').localeCompare(b.artist ?? '') ||
  byLatest(a, b);

const group = (key: string, kind: SongGroup['kind'], title: string): SongGroup => ({
  key,
  kind,
  title,
  artist: null,
  album: null,
  creation: null,
  songs: [],
  pieces: [],
});

export function groupSongs(rows: ProjectRow[], creations: Creation[]): SongGroup[] {
  const own = group('', 'own', 'Your songs');
  const albums = new Map<string, SongGroup>();
  const groups = new Map<string, SongGroup>();
  for (const c of creations) {
    groups.set(c.name, {
      ...group(c.name, 'creation', c.title),
      creation: c,
      pieces: c.pieces.filter((p) => !p.project || !rows.some((r) => r.id === p.project)),
    });
  }
  for (const r of rows) {
    if (r.creation) {
      let g = groups.get(r.creation);
      if (!g) {
        g = group(r.creation, 'creation', r.creation);
        groups.set(r.creation, g);
      }
      g.songs.push(r);
    } else if (r.artist || r.album) {
      const key = `album:${r.artist ?? ''}/${r.album ?? ''}`;
      let g = albums.get(key);
      if (!g) {
        g = { ...group(key, 'album', r.album ?? r.artist ?? ''), artist: r.artist, album: r.album };
        albums.set(key, g);
      }
      g.songs.push(r);
    } else own.songs.push(r);
  }
  // your songs with neither, unless every one has one; then the albums, then the experiences
  const filed = [...albums.values()].sort(byArtist);
  return [...(own.songs.length || !filed.length ? [own] : []), ...filed, ...[...groups.values()].sort(byLatest)];
}

/** The artists and albums your songs have, A to Z, to pick from when giving a song one. */
export function songDetailNames(rows: ProjectRow[]): { artists: string[]; albums: string[] } {
  const artists = new Set<string>();
  const albums = new Set<string>();
  for (const r of rows) {
    if (r.creation) continue;
    if (r.artist) artists.add(r.artist);
    if (r.album) albums.add(r.album);
  }
  const az = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b));
  return { artists: az(artists), albums: az(albums) };
}

/**
 * The groups with only the songs and pieces a search finds, by their names, their artist and album,
 * the piece they are and the experience they're in ("mara" finds everything by Mara Vale); groups
 * it finds nothing in are left out. Songs keep their order (the latest first); only when nothing
 * matches as typed do near misses count ("lantrens"). No words: every group as it is.
 */
export function searchSongs(groups: SongGroup[], query: string): SongGroup[] {
  const q = words(query);
  if (!q.length) return groups;
  type Item = { group: SongGroup; song?: ProjectRow; piece?: CreationPiece };
  const items: Item[] = groups.flatMap((group) => [
    ...group.songs.map((song) => ({ group, song })),
    ...group.pieces.map((piece) => ({ group, piece })),
  ]);
  const fields = ({ group: g, song, piece }: Item): Field[] => [
    { text: song?.title ?? piece?.title ?? '', weight: WEIGHT.title },
    { text: song?.artist ?? '', weight: WEIGHT.category },
    { text: song?.album ?? '', weight: WEIGHT.category },
    { text: g.kind === 'creation' ? `${g.title} ${g.key}` : '', weight: WEIGHT.source },
    { text: song?.piece ?? piece?.piece ?? '', weight: WEIGHT.note },
  ];
  const found = new Set(rank(q, items, fields).map((x) => x.item));
  const songs = new Set([...found].flatMap((it) => (it.song ? [it.song] : [])));
  const pieces = new Set([...found].flatMap((it) => (it.piece ? [it.piece] : [])));
  return groups
    .map((g) => ({ ...g, songs: g.songs.filter((s) => songs.has(s)), pieces: g.pieces.filter((p) => pieces.has(p)) }))
    .filter((g) => g.songs.length || g.pieces.length);
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
