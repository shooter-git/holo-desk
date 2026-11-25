/**
 * Which of the song's tracks this device shows: all of them, or, with View's Inactive tracks off,
 * only the ones that are on. The tracks pane and the Mixer leave the others out, and going from
 * track to track with the keyboard skips them; nothing else does. The song is whole whatever is
 * shown of it: the engine, the Score, the Inspector, the agent and every other device go by all of
 * its tracks, and a track left out is still selected when something selects it by name (the Score,
 * a reply's button, the commands).
 */
import type { Project, Track } from '@holo/session';
import type { AppState } from './store.ts';

type Show = Pick<AppState['show'], 'inactiveTracks'>;

// (a song's tracks are a new list whenever one of them changes, so what's shown of a list is worked
// out once and is the same list until then: what draws from it can tell that nothing changed)
const shownOf = new WeakMap<Track[], Track[]>();
const songOf = new WeakMap<Project, Project>();

/** The tracks shown, in the song's order: the song's own list where none is left out. */
export function shownTracks(tracks: Track[], show: Show): Track[] {
  if (show.inactiveTracks) return tracks;
  let shown = shownOf.get(tracks);
  if (!shown) {
    shown = tracks.some((t) => t.inactive) ? tracks.filter((t) => !t.inactive) : tracks;
    shownOf.set(tracks, shown);
  }
  return shown;
}

/**
 * The song as the tracks pane lays it out: its rows are the tracks shown, so a row's number and a
 * track's place in this list are the same thing. It's for laying out, drawing and finding what's
 * under the pointer; a change to the song is made by a track's id, on the song itself.
 */
export function shownSong(project: Project, show: Show): Project {
  const tracks = shownTracks(project.tracks, show);
  if (tracks === project.tracks) return project;
  let song = songOf.get(project);
  if (!song) {
    song = { ...project, tracks };
    songOf.set(project, song);
  }
  return song;
}

/** How many tracks are left out. */
export function hiddenTracks(tracks: Track[], show: Show): number {
  return tracks.length - shownTracks(tracks, show).length;
}

/**
 * Where in the song a track goes when it's dropped at `index` among the tracks shown: the place of
 * the track that is there now, so it lands where it was dropped whatever is left out in between.
 */
export function songIndex(tracks: Track[], show: Show, index: number): number {
  const shown = shownTracks(tracks, show);
  if (shown === tracks) return index;
  const at = shown[Math.max(0, Math.min(shown.length - 1, index))];
  return at ? tracks.indexOf(at) : index;
}

/**
 * The track shown a step up or down from the track `id`: from one that's left out (or from none),
 * the nearest shown that way, else the nearest the other way. Null when no track is shown.
 */
export function stepShown(tracks: Track[], show: Show, id: string | null, up: boolean): Track | null {
  const shown = shownTracks(tracks, show);
  const at = shown.findIndex((t) => t.id === id);
  if (at >= 0) return shown[Math.max(0, Math.min(shown.length - 1, at + (up ? -1 : 1)))] ?? null;
  return nearestShown(tracks, show, id === null ? -1 : tracks.findIndex((t) => t.id === id), up);
}

/**
 * The track shown nearest to the `from`th of the song's: the next one down (up first, with `up`),
 * else the next the other way. Null when no track is shown.
 */
export function nearestShown(tracks: Track[], show: Show, from: number, up = false): Track | null {
  const shown = new Set(shownTracks(tracks, show));
  const above = () => tracks.slice(0, Math.max(0, from)).findLast((t) => shown.has(t)) ?? null;
  const below = () => tracks.slice(Math.max(0, from)).find((t) => shown.has(t)) ?? null;
  return up ? (above() ?? below()) : (below() ?? above());
}

/** What the watch below compares: the song open, its tracks, and whether inactive ones are left out. */
export interface Sight {
  song: string | null;
  tracks: Track[];
  show: Show;
}

/**
 * What's selected once tracks have gone out of sight, between `was` and `now` (a track made
 * inactive while they're left out, by anyone; or leaving them out with one selected): the selected
 * track, when it's one of them, gives way to the nearest track shown, and the selected regions on
 * them are let go, so nothing that can't be seen is acted on by the next key. A song just opened
 * starts on a track that shows. A track that was out of sight already and is selected on purpose
 * (from the Score, say) stays selected. Null when the selection stands.
 */
export function selectionInSight(
  was: Sight,
  now: Sight,
  selectedTrack: string | null,
  selectedRegions: string[],
): { selectedTrack?: string | null; selectedRegions?: string[] } | null {
  const shown = new Set(shownTracks(now.tracks, now.show));
  if (shown.size === now.tracks.length) return null;
  const opened = was.song !== now.song;
  const before = new Set(shownTracks(was.tracks, was.show).map((t) => t.id));
  // the tracks that showed and no longer do (every one left out, for a song just opened)
  const gone = now.tracks.filter((t) => !shown.has(t) && (opened || before.has(t.id)));
  if (!gone.length) return null;
  const out: { selectedTrack?: string | null; selectedRegions?: string[] } = {};
  if (gone.some((t) => t.id === selectedTrack)) {
    const from = now.tracks.findIndex((t) => t.id === selectedTrack);
    out.selectedTrack = nearestShown(now.tracks, now.show, from)?.id ?? null;
  }
  const regions = new Set(gone.flatMap((t) => t.regions.map((r) => r.id)));
  if (selectedRegions.some((id) => regions.has(id)))
    out.selectedRegions = selectedRegions.filter((id) => !regions.has(id));
  return out.selectedTrack !== undefined || out.selectedRegions ? out : null;
}
