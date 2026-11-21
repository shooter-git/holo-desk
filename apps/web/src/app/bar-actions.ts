/**
 * What the bar's commands (commands.ts) run, and what they read of the studio: the same actions the
 * keys and buttons use. The bar lists them by name; a reply's buttons run one by its id
 * (agent-view.ts), and the agent hears which the studio can run now (agent-commands.ts).
 */
import {
  addTrack,
  bounceSong,
  deleteSelection,
  locate,
  moveBars,
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
import { store } from './store.ts';

/** What the bar's commands do: the same actions the keys and buttons use. */
export const ACTIONS: Actions = {
  set: (patch) => store.set(patch),
  togglePlay: () => void togglePlay(),
  toggleRecord: () => void toggleRecord(),
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
  selectTrack,
  setChannel: (track, patch, label) => updateChannel(track, patch, label),
  setActive: (track, active) => setTrackActive(track, active),
  newTrack: () => void addTrack({ type: 'synth', preset: 'Soft Keys' }),
  save: () => void saveNow(),
  bounce: () => void bounceSong(true),
};

/** What the bar reads of the studio, now. */
export function barState(): BarState {
  return { ...store.get(), playhead: playheadTick(), phone: isPhone(layoutNow()) };
}

/**
 * The commands a reply's button may run: the bar's own, by their fixed ids (not a marker's or a track's,
 * which a go reaches), those the studio can run now.
 */
export function studioCommands(s: BarState = barState()): Command[] {
  return commandTable(s, ACTIONS).filter((c) => !c.id.includes(':') && (c.available?.(s) ?? true));
}
