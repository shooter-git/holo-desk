/**
 * The bar's commands (Ctrl /): what the studio's keys do and a little more (go to a marker or a bar,
 * select a track, the dialogs), found by name. The table is built from the studio's state and the
 * actions it runs, both passed in, so it holds no browser and can be tried on its own: the bar
 * (ui/Bar.tsx) passes the real ones.
 */
import {
  firstBar,
  meterAt,
  type Note,
  PPQ,
  type Project,
  parsePosition,
  ticksPerBeat,
  tickToBarBeat,
} from '@holo/session';
import { type Field, rank, words } from '../ui/search.ts';
import type { AppState } from './store.ts';

/** What the bar reads of the studio: its state, where the playhead is, and whether it's laid out for a phone. */
export type BarState = Pick<
  AppState,
  | 'project'
  | 'selectedTrack'
  | 'selectedRegions'
  | 'selectedNotes'
  | 'editor'
  | 'noteView'
  | 'inspector'
  | 'library'
  | 'automationView'
  | 'playing'
  | 'recording'
  | 'typing'
  | 'undo'
  | 'redo'
  | 'bouncing'
> & { playhead: number; phone: boolean };

/** What the commands do: the studio's own actions (actions.ts, and the store's toggles as keys.ts sets them). */
export interface Actions {
  set(patch: Partial<AppState>): void;
  togglePlay(): void;
  toggleRecord(): void;
  toggleCycle(): void;
  toggleMetronome(): void;
  stop(): void;
  locate(tick: number): void;
  moveBars(bars: number): void;
  toggleFullscreen(): void;
  toggleTyping(): void;
  undo(): void;
  redo(): void;
  deleteSelection(): void;
  selectAll(): void;
  quantizeSelection(): void;
  splitAtPlayhead(): void;
  repeatRegions(): void;
  transposeSelection(semitones: number): void;
  selectTrack(id: string): void;
  setChannel(track: string, patch: { mute?: boolean; solo?: boolean }, label: string): void;
  newTrack(): void;
  save(): void;
  bounce(): void;
}

export interface Command {
  /** Unique in a table: a marker's and a track's carry their own id. */
  id: string;
  title: string;
  /** Where it belongs ("Transport", "Edit"…): searched too, but a match counts for less than in the title. */
  group: string;
  /** The keys that do the same, as the Key commands list writes them. */
  keys?: string;
  /** Shown where the keys would be, on a row that has none: the bar a marker is at. */
  note?: string;
  /** More words it's found by ("export" for Bounce), counted as the group is. */
  also?: string;
  /** Whether it can do anything now (what it acts on is there); always, when not given. */
  available?: (s: BarState) => boolean;
  /** Whether it's about what's selected: those come first, before anything is typed. */
  fits?: (s: BarState) => boolean;
  /** The bar stays open after it runs: what it starts shows there. */
  keepOpen?: boolean;
  run: () => void;
}

/** What the bar offers besides the studio's commands (the agent's, while it's on for this device). */
export interface Extra {
  /** Commands found by name like the others (never offered before anything is typed). */
  commands?: Command[];
  /** A row that sends what was typed as a request: last, or first when no command fits the words well. */
  ask?: (text: string) => Command;
}

/** How well a command must match what's typed to come before the request row: its title's words, typed. */
const WELL = 0.9;

/** The most rows the bar lists: a short list to read at a glance, not a menu to scroll. */
export const MAX_ROWS = 8;

/** Offered when nothing is typed, after what fits the selection (and the next marker). */
const COMMON = ['play', 'mixer', 'piano-roll', 'library', 'songs', 'settings'];

/** A group's match counts for less than the title's, as a pack's name does in the Library. */
const GROUP_WEIGHT = 0.4;

const song = (s: BarState) => s.project !== null;
const someNotes = (s: BarState) => s.selectedNotes.length > 0;
const someRegions = (s: BarState) => s.selectedRegions.length > 0;
const selected = (s: BarState) => s.project?.tracks.find((t) => t.id === s.selectedTrack) ?? null;

/** The regions the edits act on: the selected ones, or else every region of the selected track. */
function regionsInPlay(s: BarState) {
  const p = s.project;
  if (!p) return [];
  const all = p.tracks.flatMap((t) => t.regions);
  if (s.selectedRegions.length) return all.filter((r) => s.selectedRegions.includes(r.id));
  return selected(s)?.regions ?? [];
}

/** Whether Split would cut something: the playhead inside one of those regions. */
function splits(s: BarState): boolean {
  return regionsInPlay(s).some((r) => s.playhead > r.start && s.playhead < r.start + r.length);
}

/** Whether Quantize has notes to move: the selected ones, or those in the regions it acts on. */
function quantizes(s: BarState): boolean {
  return someNotes(s) || regionsInPlay(s).some((r) => r.notes.length > 0);
}

/** The panes, opened and closed as their keys do (X, P, N); a phone shows one at a time, so they go to its tab. */
function panes(s: BarState, act: Actions): Command[] {
  const notes = (view: 'roll' | 'score') => () => {
    if (s.phone) act.set({ noteView: view, mobileTab: 'editor' });
    else {
      const open = s.editor === 'piano' && s.noteView === view;
      act.set({ editor: open ? null : 'piano', noteView: view, mobileTab: 'editor' });
    }
  };
  return [
    {
      id: 'mixer',
      title: 'Mixer',
      group: 'Windows',
      keys: 'X',
      also: 'mix levels faders',
      run: () =>
        act.set(
          s.phone ? { mobileTab: 'mixer' } : { editor: s.editor === 'mixer' ? null : 'mixer', mobileTab: 'mixer' },
        ),
    },
    { id: 'piano-roll', title: 'Piano Roll', group: 'Windows', keys: 'P', also: 'notes editor', run: notes('roll') },
    { id: 'score', title: 'Score', group: 'Windows', keys: 'N', also: 'notation sheet music', run: notes('score') },
    {
      id: 'score-write',
      title: 'Write in the Score',
      group: 'Score',
      keys: 'Shift N',
      also: 'notation enter notes',
      available: song,
      run: () => act.set({ editor: 'piano', noteView: 'score', scoreWrite: true, mobileTab: 'editor' }),
    },
    {
      id: 'automation',
      title: 'Automation lanes',
      group: 'Windows',
      keys: 'A',
      run: () => act.set({ automationView: !s.automationView }),
    },
    {
      id: 'inspector',
      title: 'Inspector',
      group: 'Windows',
      keys: 'I',
      // a phone has no room for it beside the tracks
      available: (x) => !x.phone,
      run: () => act.set({ inspector: !s.inspector }),
    },
    {
      id: 'library',
      title: 'Library',
      group: 'Windows',
      keys: 'Y',
      also: 'sounds instruments packs',
      run: () => act.set(s.phone ? { mobileTab: 'library' } : { library: !s.library }),
    },
  ];
}

/**
 * Every command the bar knows, for the studio as it is now: the titles say what each will do ("Mute
 * Piano", "Undo Quantize"), and `available` says whether it can.
 */
export function commandTable(s: BarState, act: Actions): Command[] {
  const p = s.project;
  const track = selected(s);
  const lastUndo = s.undo[s.undo.length - 1]?.label;
  const lastRedo = s.redo[s.redo.length - 1]?.label;
  const regions = s.selectedRegions.length;
  const table: Command[] = [
    // transport
    {
      id: 'play',
      title: s.playing ? 'Stop' : 'Play',
      group: 'Transport',
      keys: 'Space',
      also: 'play stop start pause',
      available: song,
      run: act.togglePlay,
    },
    {
      id: 'record',
      title: s.recording ? 'Stop recording' : 'Record',
      group: 'Transport',
      keys: 'R',
      available: song,
      run: act.toggleRecord,
    },
    {
      id: 'cycle',
      title: 'Cycle on or off',
      group: 'Transport',
      keys: 'C',
      also: 'loop',
      available: song,
      run: act.toggleCycle,
    },
    { id: 'metronome', title: 'Metronome', group: 'Transport', keys: 'K', also: 'click', run: act.toggleMetronome },
    {
      id: 'go-to-start',
      title: 'Go to the beginning',
      group: 'Transport',
      keys: 'Return',
      also: 'start rewind',
      available: song,
      run: () => {
        if (s.playing) act.stop();
        act.locate(0);
      },
    },
    {
      id: 'bar-back',
      title: 'Back a bar',
      group: 'Transport',
      keys: ',',
      available: song,
      run: () => act.moveBars(-1),
    },
    {
      id: 'bar-forward',
      title: 'Forward a bar',
      group: 'Transport',
      keys: '.',
      available: song,
      run: () => act.moveBars(1),
    },

    // windows
    ...panes(s, act),
    {
      id: 'fullscreen',
      title: 'Full screen',
      group: 'Windows',
      keys: 'Ctrl Shift F',
      also: 'fullscreen',
      run: act.toggleFullscreen,
    },
    {
      id: 'typing',
      title: 'Musical Typing',
      group: 'Windows',
      keys: 'Ctrl K',
      also: 'computer keyboard piano',
      // it plays from a computer's keyboard, which a phone hasn't
      available: (x) => !x.phone,
      run: act.toggleTyping,
    },
    {
      id: 'shortcuts',
      title: 'Key commands',
      group: 'Windows',
      keys: '?',
      also: 'shortcuts keyboard',
      available: (x) => !x.phone,
      run: () => act.set({ dialog: 'shortcuts' }),
    },

    // edit
    {
      id: 'undo',
      title: lastUndo ? `Undo ${lastUndo}` : 'Undo',
      group: 'Edit',
      keys: 'Ctrl Z',
      available: (x) => x.undo.length > 0,
      run: act.undo,
    },
    {
      id: 'redo',
      title: lastRedo ? `Redo ${lastRedo}` : 'Redo',
      group: 'Edit',
      keys: 'Ctrl Shift Z',
      available: (x) => x.redo.length > 0,
      run: act.redo,
    },
    {
      id: 'quantize',
      title: someNotes(s) || regions ? 'Quantize the selection' : 'Quantize the track',
      group: 'Edit',
      keys: 'Q',
      also: 'grid timing',
      available: quantizes,
      fits: (x) => someNotes(x) || someRegions(x),
      run: act.quantizeSelection,
    },
    {
      id: 'repeat',
      title: regions > 1 ? 'Repeat the regions' : 'Repeat the region',
      group: 'Edit',
      keys: 'Ctrl R',
      also: 'copy duplicate loop',
      available: someRegions,
      fits: someRegions,
      run: act.repeatRegions,
    },
    {
      id: 'split',
      title: 'Split at the playhead',
      group: 'Edit',
      keys: 'Ctrl T',
      also: 'cut',
      available: splits,
      fits: someRegions,
      run: act.splitAtPlayhead,
    },
    {
      id: 'transpose-up',
      title: 'Transpose up a semitone',
      group: 'Edit',
      keys: '↑',
      also: 'pitch higher',
      available: someNotes,
      fits: someNotes,
      run: () => act.transposeSelection(1),
    },
    {
      id: 'transpose-down',
      title: 'Transpose down a semitone',
      group: 'Edit',
      keys: '↓',
      also: 'pitch lower',
      available: someNotes,
      fits: someNotes,
      run: () => act.transposeSelection(-1),
    },
    {
      id: 'transpose-octave-up',
      title: 'Transpose up an octave',
      group: 'Edit',
      keys: 'Shift ↑',
      also: 'pitch higher',
      available: someNotes,
      run: () => act.transposeSelection(12),
    },
    {
      id: 'transpose-octave-down',
      title: 'Transpose down an octave',
      group: 'Edit',
      keys: 'Shift ↓',
      also: 'pitch lower',
      available: someNotes,
      run: () => act.transposeSelection(-12),
    },
    {
      id: 'delete',
      title: 'Delete the selection',
      group: 'Edit',
      keys: 'Delete',
      also: 'remove erase',
      available: (x) => someNotes(x) || someRegions(x),
      run: act.deleteSelection,
    },
    { id: 'select-all', title: 'Select all', group: 'Edit', keys: 'Ctrl A', available: song, run: act.selectAll },

    // tracks
    {
      id: 'mute',
      title: track ? `${track.channel.mute ? 'Unmute' : 'Mute'} ${track.name}` : 'Mute the track',
      group: 'Tracks',
      keys: 'M',
      available: (x) => selected(x) !== null,
      run: () => track && act.setChannel(track.id, { mute: !track.channel.mute }, 'Mute'),
    },
    {
      id: 'solo',
      title: track ? `${track.channel.solo ? 'Unsolo' : 'Solo'} ${track.name}` : 'Solo the track',
      group: 'Tracks',
      keys: 'S',
      available: (x) => selected(x) !== null,
      run: () => track && act.setChannel(track.id, { solo: !track.channel.solo }, 'Solo'),
    },
    {
      id: 'new-track',
      title: 'New track',
      group: 'Tracks',
      keys: 'Alt Ctrl N',
      also: 'add',
      available: song,
      run: act.newTrack,
    },

    // the song
    { id: 'save', title: 'Save now', group: 'Project', keys: 'Ctrl S', available: song, run: act.save },
    {
      id: 'bounce',
      title: p?.cycle.on ? 'Bounce the cycle to a WAV file' : 'Bounce to a WAV file',
      group: 'Project',
      keys: 'Ctrl B',
      also: 'export render mixdown audio',
      available: (x) => x.project !== null && !x.bouncing,
      run: act.bounce,
    },
    {
      id: 'songs',
      title: 'Songs',
      group: 'Project',
      also: 'open new import project',
      run: () => act.set({ dialog: 'projects' }),
    },
    {
      id: 'settings',
      title: 'Settings',
      group: 'Project',
      also: 'audio midi devices preferences',
      run: () => act.set({ dialog: 'settings' }),
    },
  ];

  // a row for each marker, in the song's order, and one for each track
  const markers = [...(p?.markers ?? [])].sort((a, b) => a.tick - b.tick);
  for (const m of markers) {
    table.push({
      id: `marker:${m.id}`,
      title: `Go to marker: ${m.name}`,
      group: 'Markers',
      note: `bar ${tickToBarBeat(p?.meter ?? [], m.tick).bar}`,
      run: () => act.locate(m.tick),
    });
  }
  for (const t of p?.tracks ?? []) {
    table.push({
      id: `track:${t.id}`,
      title: `Select track: ${t.name}`,
      group: 'Tracks',
      run: () => act.selectTrack(t.id),
    });
  }
  return table;
}

/**
 * A position typed in the field, as the display shows one: "17" (bar 17), "17.3" (its third beat),
 * "17.3.2" (and sixteenth), with "bar" or "go to" before it if you like. Null when it isn't one, or
 * names a beat or a sixteenth the bar hasn't got.
 */
export function typedPosition(meter: Project['meter'], text: string): { tick: number; title: string } | null {
  const m = /^\s*(?:go\s+to\s+)?(?:bar\s+)?(\d{1,4}(?:\s*\.\s*\d{1,3}){0,2})\s*$/i.exec(text);
  if (!m?.[1]) return null;
  const parts = m[1].split('.').map((x) => Number(x.trim()));
  const [bar = 1, beat = 1, div = 1] = parts;
  if (bar < firstBar(meter)) return null;
  const at = meterAt(meter, parsePosition(meter, String(bar)));
  if (beat < 1 || beat > at.num || div < 1 || div > ticksPerBeat(at) / (PPQ / 4)) return null;
  const title =
    parts.length === 1
      ? `Go to bar ${bar}`
      : parts.length === 2
        ? `Go to bar ${bar}, beat ${beat}`
        : `Go to ${parts.join('.')}`;
  return { tick: parsePosition(meter, parts.join('.')), title };
}

/**
 * What's selected, by the song's ticks: the selected notes, or else the selected regions, and the
 * tracks they're on. Null when neither is.
 */
export function selectionSpan(
  p: Project,
  notes: readonly Note[],
  regions: readonly string[],
): { tracks: string[]; start: number; end: number } | null {
  const tracks = new Set<string>();
  let start = Number.POSITIVE_INFINITY;
  let end = 0;
  const take = (track: string, from: number, to: number) => {
    tracks.add(track);
    start = Math.min(start, from);
    end = Math.max(end, to);
  };
  if (notes.length) {
    const wanted = new Set(notes);
    for (const t of p.tracks)
      for (const r of t.regions)
        for (const n of r.notes) if (wanted.has(n)) take(t.name, r.start + n.t, r.start + n.t + n.d);
  } else if (regions.length) {
    for (const t of p.tracks)
      for (const r of t.regions) if (regions.includes(r.id)) take(t.name, r.start, r.start + r.length);
  }
  return tracks.size ? { tracks: [...tracks], start, end } : null;
}

/**
 * The selection in a few words, for the field's right side: "Piano · bars 5–8" (the selected notes,
 * or else the selected regions, and the track they're on), just the track when nothing on it is
 * selected, and nothing when no track is.
 */
export function selectionHint(s: BarState): string {
  const p = s.project;
  if (!p) return '';
  const span = selectionSpan(p, s.selectedNotes, s.selectedRegions);
  if (!span) return selected(s)?.name ?? '';
  const name = span.tracks.length === 1 ? span.tracks[0] : `${span.tracks.length} tracks`;
  const from = tickToBarBeat(p.meter, span.start).bar;
  // the last bar the selection reaches into: a note ending on a bar line doesn't reach the next bar
  const to = tickToBarBeat(p.meter, Math.max(span.start, span.end - 1)).bar;
  return `${name} · ${from === to ? `bar ${from}` : `bars ${from}–${to}`}`;
}

const fields = (c: Command): Field[] => [
  { text: c.title, weight: 1 },
  { text: c.group, weight: GROUP_WEIGHT },
  ...(c.also ? [{ text: c.also, weight: GROUP_WEIGHT }] : []),
];

/**
 * What the bar lists for what's typed, best first, at most `max` rows.
 *  - Nothing typed: the commands that fit the selection, the next marker, then a few common ones.
 *  - A position ("17", "17.3"): going there (and asking, with `extra.ask`).
 *  - Words: the commands they name; then finding them among the Library's sounds; and with
 *    `extra.ask`, sending them as a request, last, or first when no command fits them well.
 */
export function barRows(query: string, s: BarState, act: Actions, extra: Extra = {}, max = MAX_ROWS): Command[] {
  const table = commandTable(s, act).filter((c) => c.available?.(s) ?? true);
  const q = words(query);
  if (!q.length) {
    const markers = table.filter((c) => c.group === 'Markers');
    const ticks = [...(s.project?.markers ?? [])].sort((a, b) => a.tick - b.tick).map((m) => m.tick);
    const next = ticks.findIndex((t) => t > s.playhead);
    const rows = [
      ...table.filter((c) => c.fits?.(s)),
      // the next marker after the playhead, or the first when it's past the last
      ...(markers.length ? [markers[next < 0 ? 0 : next] as Command] : []),
      ...COMMON.flatMap((id) => table.filter((c) => c.id === id)),
    ];
    return rows.filter((c, i) => rows.indexOf(c) === i).slice(0, max);
  }
  const text = query.trim();
  const ask = extra.ask?.(text);
  if (s.project) {
    const at = typedPosition(s.project.meter, query);
    if (at) {
      const go: Command = { id: 'go-to-position', title: at.title, group: 'Transport', run: () => act.locate(at.tick) };
      return ask ? [go, ask] : [go];
    }
  }
  const ranked = rank(q, [...table, ...(extra.commands ?? []).filter((c) => c.available?.(s) ?? true)], fields);
  // a request in a sentence isn't a sound's name: the Library is offered for a word or two
  const library: Command[] =
    ask && q.length > 2
      ? []
      : [
          {
            id: 'find-sound',
            title: `Find “${text}” in the Library`,
            group: 'Sounds',
            run: () =>
              act.set(s.phone ? { mobileTab: 'library', librarySearch: text } : { library: true, librarySearch: text }),
          },
        ];
  const room = max - library.length - (ask ? 1 : 0);
  const found = ranked.slice(0, room).map((r) => r.item);
  if (!ask) return [...found, ...library];
  return (ranked[0]?.score ?? 0) >= WELL ? [...found, ...library, ask] : [ask, ...found, ...library];
}
