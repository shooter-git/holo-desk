/**
 * What the bar's commands (commands.ts) run, and what they read of the studio: the same actions the
 * keys and buttons use. The bar lists them by name; a reply's buttons run one by its id
 * (agent-view.ts), and the agent hears which the studio can run now (agent-commands.ts).
 */
import {
  addSectionAtPlayhead,
  addTrack,
  bounceSong,
  captureRecent,
  deleteSelection,
  locate,
  moveBars,
  moveIntoKey,
  playheadTick,
  quantizeSelection,
  redo,
  repeatRegions,
  saveNow,
  selectAll,
  selectTrack,
  setTrackActive,
  splitAtPlayhead,
  stop,
  toggleCycle,
  toggleFullscreen,
  toggleMetronome,
  togglePlay,
  toggleRecord,
  transposeSelection,
  undo,
  updateChannel,
} from './actions.ts';
import { type Actions, type BarState, type Command, commandTable } from './commands.ts';
import { toggleTyping } from './keys.ts';
import { isPhone, layoutNow } from './layout.ts';
import { isKitNow, shownNoteView } from './note-view.ts';
import { type AppState, store } from './store.ts';

/** What the bar's commands do: the same actions the keys and buttons use. */
export const ACTIONS: Actions = {
  set: (patch) => store.set(patch),
  togglePlay: () => void togglePlay(),
  toggleRecord: () => void toggleRecord(),
  captureRecent,
  addSection: () => void addSectionAtPlayhead(),
  toggleCycle,
  toggleMetronome,
  stop,
  locate,
  moveBars,
  toggleFullscreen,
  toggleTyping,
  undo,
  redo,
  deleteSelection,
  selectAll,
  quantizeSelection,
  splitAtPlayhead,
  repeatRegions,
  transposeSelection,
  moveIntoKey,
  selectTrack,
  setChannel: (track, patch, label) => updateChannel(track, patch, label),
  setActive: (track, active) => setTrackActive(track, active),
  newTrack: () => void addTrack({ type: 'synth', preset: 'Soft Keys' }),
  save: () => void saveNow(),
  bounce: () => void bounceSong(true),
  stems: () => store.set({ dialog: 'stems' }),
};

/**
 * What the bar reads of the studio, from the studio's state: the notes' view as it's shown (the Step
 * Grid only for a kit), and whether the selected track is one.
 */
export function barStateOf(s: AppState, playhead: number, phone: boolean): BarState {
  return {
    ...s,
    noteView: shownNoteView(s),
    kit: isKitNow(s.project?.tracks.find((t) => t.id === s.selectedTrack)),
    playhead,
    phone,
  };
}

/** What the bar reads of the studio, now. */
export function barState(): BarState {
  return barStateOf(store.get(), playheadTick(), isPhone(layoutNow()));
}

/**
 * The commands a reply's button may run: the bar's own, by their fixed ids (not a marker's or a track's,
 * which a go reaches), those the studio can run now.
 */
export function studioCommands(s: BarState = barState()): Command[] {
  return commandTable(s, ACTIONS).filter((c) => !c.id.includes(':') && (c.available?.(s) ?? true));
}
