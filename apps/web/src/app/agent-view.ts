/**
 * What a reply's view does when it's clicked (the format is @holo/agent/view; ui/AgentView.tsx draws
 * it): it plays bars of a version of the song or of the song as it is, goes somewhere in the studio,
 * sets a setting (a click, or a slider's drag: one undo step each), keeps a version, runs one of the
 * bar's commands, or sends a next request. Each is something the user could do themselves, and
 * nothing here runs without their click, except a go the reply brings when they asked to see
 * something (live.ts runs it as the reply arrives, on the device that asked).
 */
import { AFTER, BEFORE, type Binding, bindingInfo, bindingOps, type Go, type Play, type View } from '@holo/agent/view';
import {
  type AudioNote,
  barToTick,
  fileToTicks,
  firstBar,
  type Note,
  type Project,
  parsePosition,
  parseProject,
  type Region,
} from '@holo/session';
import { useSyncExternalStore } from 'react';
import {
  apply,
  beginGesture,
  endGesture,
  ensureAudio,
  gestureChange,
  locate,
  playheadTick,
  playPasses,
  replaceSong,
  selectTrack,
  stopPasses,
} from './actions.ts';
import { ask, requestContext } from './agent.ts';
import { api } from './api.ts';
import { ACTIONS, barState, studioCommands } from './bar-actions.ts';
import { commandTable } from './commands.ts';
import { isPhone, layoutNow } from './layout.ts';
import { type AppState, closeBar, store } from './store.ts';

// ---- versions ----

/** Versions fetched from the song's history, by song and revision (a few, the newest kept). */
const versions = new Map<string, Promise<Project | null>>();
const KEEP_VERSIONS = 12;

/** A version a view names, as the song's history keeps it; null when it's no longer kept (or never was). */
export function versionSong(view: View, name: string): Promise<Project | null> {
  const id = store.get().project?.id;
  const revision = view.versions[name];
  if (!id || revision === undefined) return Promise.resolve(null);
  const key = `${id}:${revision}`;
  let found = versions.get(key);
  if (!found) {
    found = api
      .revision(id, revision)
      .then((p) => parseProject(p))
      .catch(() => null);
    versions.set(key, found);
    // (the oldest goes first)
    for (const k of versions.keys()) if (versions.size > KEEP_VERSIONS) versions.delete(k);
  }
  return found;
}

// ---- playing ----

/** Which of a view's play buttons is playing (its key), for the button to show Stop. */
let playing: string | null = null;
const listeners = new Set<() => void>();

function setPlaying(key: string | null): void {
  if (playing === key) return;
  playing = key;
  for (const fn of listeners) fn();
}

const subscribe = (fn: () => void) => {
  listeners.add(fn);
  return () => listeners.delete(fn);
};

/** The key of the play button that's playing, if one is. */
export function usePlaying(): string | null {
  return useSyncExternalStore(subscribe, () => playing);
}

/** A song with only these tracks soloed (for the audio thread alone: the song itself is left as it is). */
function soloed(song: Project, tracks: readonly string[]): Project {
  return {
    ...song,
    tracks: song.tracks.map((t) => ({ ...t, channel: { ...t.channel, solo: tracks.includes(t.id) } })),
  };
}

/**
 * Bars of a version (or the song as it is) played straight through, once; the same button clicked
 * again stops them. A plain reason when they can't be.
 */
export async function playBars(view: View, p: Play, key: string): Promise<string | null> {
  if (playing === key) {
    stopPasses();
    setPlaying(null);
    return null;
  }
  const now = store.get().project;
  if (!now) return 'No song is open';
  // the audio starts in the click itself, as the transport's Play starts it: a phone's browser may
  // refuse to start it once the version has been fetched and the click is over
  const audio = ensureAudio();
  let song: Project | null = null;
  if (p.version) {
    song = await versionSong(view, p.version);
    if (!song) return 'That version isn’t kept any more';
  }
  const base = song ?? now;
  // (a version, a solo, or the cycle in the way: a copy of its own plays, straight through)
  const own = song !== null || !!p.solo || (base.cycle.on && base.cycle.start < barToTick(base.meter, p.to));
  const played = own ? { ...base, cycle: { ...base.cycle, on: false } } : null;
  await audio;
  const from = barToTick(base.meter, Math.max(p.from, firstBar(base.meter)));
  const to = barToTick(base.meter, p.to);
  const r = playPasses([{ song: played && p.solo ? soloed(played, p.solo) : played, from, to }], () => {
    if (playing === key) setPlaying(null);
  });
  if (!r.ok) return r.error;
  setPlaying(key);
  return null;
}

// ---- going somewhere ----

/** A view's names for the studio's views, as the store opens them (as the bar's commands do). */
function viewPatch(view: NonNullable<Go['view']>, phone: boolean): Partial<AppState> {
  switch (view) {
    case 'tracks':
      return phone ? { mobileTab: 'tracks' } : { editor: null };
    case 'mixer':
      return { editor: 'mixer', mobileTab: 'mixer' };
    case 'score':
      return { editor: 'piano', noteView: 'score', mobileTab: 'editor' };
    case 'notes':
      // (a recording's notes; a MIDI track's show in the Piano Roll, as with "editor")
      return { editor: 'piano', noteView: 'roll', audioMode: 'notes', mobileTab: 'editor' };
    default:
      return { editor: 'piano', noteView: 'roll', mobileTab: 'editor' };
  }
}

/** A track's notes from one tick to another (song ticks), of one pitch or all: the song's own notes, and their regions. */
export function notesIn(
  song: Project,
  track: string,
  from: number,
  to: number,
  pitch?: number,
): { notes: Note[]; regions: string[] } {
  const t = song.tracks.find((x) => x.id === track);
  const notes: Note[] = [];
  const regions: string[] = [];
  for (const r of t?.regions ?? []) {
    const own = r.notes.filter((n) => {
      const at = r.start + n.t;
      return at >= from && at < to && (pitch === undefined || Math.round(n.p) === pitch);
    });
    if (own.length) {
      notes.push(...own);
      regions.push(r.id);
    }
  }
  return { notes, regions };
}

// ---- a recording's notes ----

/**
 * A region's notes as the Audio Editor's Notes view numbers them (its own, as edited, else those found
 * in its recording as its first edit keeps them); null while they're still being found. It's the
 * Notes view's own, given by ui/AgentView.tsx as it loads (the view lives with the editor).
 */
export type RecordingNoteLister = (song: Project, region: Region) => readonly AudioNote[] | null;

let listRecordingNotes: RecordingNoteLister = () => null;

export function setRecordingNoteLister(fn: RecordingNoteLister): void {
  listRecordingNotes = fn;
}

/**
 * A recording's note where it plays: its index in its region's notes, its start and end (song ticks),
 * and its pitch as sung and as it plays now (MIDI with cents: moved where an edit moved it).
 */
export interface PlacedNote {
  index: number;
  start: number;
  end: number;
  sung: number;
  pitch: number;
}

/** A region's sung notes (not its breaths and consonants, nor those muted) where they play; null while still being found. */
export function placedNotes(song: Project, region: Region): PlacedNote[] | null {
  if (!region.audio) return [];
  const list = listRecordingNotes(song, region);
  if (!list) return null;
  const asSung = fileToTicks(song, region);
  const asPlayed = fileToTicks(song, region, true);
  const out: PlacedNote[] = [];
  list.forEach((n, index) => {
    if (n.p === null || n.m) return;
    out.push({
      index,
      start: n.ts !== undefined ? asPlayed(n.ts) : asSung(n.t),
      end: n.te !== undefined ? asPlayed(n.te) : asSung(n.t + n.d),
      sung: n.p,
      pitch: n.to ?? n.p,
    });
  });
  return out;
}

/**
 * The studio goes where a go says: the track selected, a region selected and open in the editor, notes
 * selected in it (a recording's in the Audio Editor's Notes view), a view in front, a plugin's window
 * open, the playhead at a bar. A plain reason when what it names is gone from the song.
 */
export function goTo(go: Go): string | null {
  const s = store.get();
  const song = s.project;
  if (!song) return 'No song is open';
  const phone = isPhone(layoutNow());
  const track = go.track ? song.tracks.find((t) => t.id === go.track) : undefined;
  if (go.track && !track && go.track !== 'master' && !song.buses.some((b) => b.id === go.track))
    return 'That track is gone from the song';
  const patch: Partial<AppState> = {};
  let at: number | undefined;
  if (track) selectTrack(track.id);
  if (go.region) {
    const found = song.tracks.flatMap((t) => t.regions.map((r) => ({ t, r }))).find((x) => x.r.id === go.region);
    if (!found) return 'That region is gone from the song';
    if (!track) selectTrack(found.t.id);
    Object.assign(patch, { selectedRegions: [found.r.id], ...viewPatch('editor', phone) });
    at = found.r.start;
  }
  if (go.notes && track) {
    let from: number;
    let to: number;
    try {
      from = parsePosition(song.meter, String(go.notes.from));
      to = parsePosition(song.meter, String(go.notes.to));
    } catch {
      return 'Those notes aren’t in the song';
    }
    const pitch = typeof go.notes.pitch === 'number' ? go.notes.pitch : undefined;
    if (track.kind === 'audio') {
      const plays = (r: Region) => !!r.audio && r.start < to && r.start + r.length > from;
      const region = track.regions.find((r) => plays(r) && r.start <= from) ?? track.regions.find((r) => plays(r));
      if (!region) return 'Those notes are gone from the song';
      const placed = placedNotes(song, region);
      const chosen = (placed ?? [])
        .filter(
          (n) =>
            n.start >= from &&
            n.start < to &&
            (pitch === undefined || Math.round(n.pitch) === pitch || Math.round(n.sung) === pitch),
        )
        .map((n) => n.index);
      // (still being found: the Notes view opens there, and shows them as they come)
      if (placed && !chosen.length) return 'Those notes are gone from the song';
      Object.assign(patch, {
        selectedRegions: [region.id],
        selectedAudioNotes: chosen.length ? { region: region.id, notes: chosen } : null,
        ...viewPatch('notes', phone),
      });
    } else {
      const { notes, regions } = notesIn(song, track.id, from, to, pitch);
      if (!notes.length) return 'Those notes are gone from the song';
      Object.assign(patch, { selectedNotes: notes, selectedRegions: regions, ...viewPatch('editor', phone) });
    }
    at = from;
  }
  if (go.view) Object.assign(patch, viewPatch(go.view, phone));
  if (go.plugin && go.track) {
    const chain = [
      ...(track?.channel.inserts ?? []),
      ...(track?.midiFx ?? []),
      ...(go.track === 'master' ? song.master.inserts : []),
      ...(song.buses.find((b) => b.id === go.track)?.channel.inserts ?? []),
    ];
    if (!chain.some((p) => p.id === go.plugin)) return 'That plugin is gone from the song';
    patch.plugin = { target: go.track, id: go.plugin };
  }
  if (go.bar !== undefined) at = barToTick(song.meter, Math.max(go.bar, firstBar(song.meter)));
  store.set(patch);
  if (at !== undefined) locate(at);
  return null;
}

/**
 * Where a span of a track (a view's notes or wave) goes when it's clicked: its region there, in the
 * editor (a recording's notes strip, in the Audio Editor's Notes view).
 */
export function spanGo(song: Project, track: string, fromBar: number, notes = false): Go {
  const at = barToTick(song.meter, Math.max(fromBar, firstBar(song.meter)));
  const t = song.tracks.find((x) => x.id === track);
  const r = t?.regions.find((x) => x.start <= at && x.start + x.length > at) ?? t?.regions.find((x) => x.start >= at);
  const view = notes && t?.kind === 'audio' ? 'notes' : undefined;
  return r
    ? { track, region: r.id, bar: fromBar, ...(view ? { view } : {}) }
    : { track, bar: fromBar, view: view ?? 'editor' };
}

// ---- setting a setting ----

/** A binding's undo step's name: "Vocal: Volume". */
const stepName = (song: Project, b: Binding) => {
  const info = bindingInfo(song, b);
  return info ? `${info.channel === 'the master' ? 'Master' : info.channel}: ${info.name}` : 'Setting';
};

/** A setting set by a click: one undo step. False when it's gone from the song. */
export function setBinding(b: Binding, value: number): boolean {
  const song = store.get().project;
  if (!song) return false;
  const ops = bindingOps(song, b, value);
  return ops.length > 0 && apply(ops, stepName(song, b)) !== null;
}

/** A slider's drag begins: everything until it ends is one undo step. */
export function slideStart(b: Binding): void {
  const song = store.get().project;
  if (song) beginGesture(stepName(song, b));
}

/** Where the slider is now: heard at once. */
export function slide(b: Binding, value: number): void {
  const song = store.get().project;
  if (!song) return;
  const ops = bindingOps(song, b, value);
  if (ops.length) gestureChange(ops);
}

export function slideEnd(): void {
  endGesture();
}

// ---- keeping a version ----

/** A version as a person reads it: the original, the new version, or its own name. */
export const versionWords = (name: string): string =>
  name === BEFORE ? 'the original' : name === AFTER ? 'the new version' : `“${name}”`;

/** A version made the song again, one undo step ("Keep “Hall reverb”"). False when it's no longer kept. */
export async function keepVersion(view: View, name: string): Promise<boolean> {
  const song = await versionSong(view, name);
  if (!song) return false;
  stopPasses();
  return replaceSong(song, `Keep ${versionWords(name)}`) !== null;
}

// ---- the studio's commands ----

/** One of the bar's commands by its id: its title, and whether the studio can run it now (null: there's none). */
export function commandInfo(id: string): { title: string; available: boolean; keepOpen: boolean } | null {
  const s = barState();
  const c = commandTable(s, ACTIONS).find((x) => x.id === id && !x.id.includes(':'));
  return c ? { title: c.title, available: c.available?.(s) ?? true, keepOpen: !!c.keepOpen } : null;
}

/** Run one of the bar's commands, as the bar would (it closes unless the command keeps it open). */
export function runCommand(id: string): boolean {
  const c = studioCommands().find((x) => x.id === id);
  if (!c) return false;
  if (!c.keepOpen) closeBar();
  c.run();
  return true;
}

// ---- a next request ----

/** The request a view's button suggests, sent as if typed, with what the studio shows now. */
export function askNext(text: string): void {
  const s = store.get();
  const project = s.project?.id;
  if (project) void ask(text, project, requestContext(s, playheadTick(), isPhone(layoutNow())), []);
}
