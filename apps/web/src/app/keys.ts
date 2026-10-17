/**
 * Key commands, laid out as Logic's (Ctrl stands in for ⌘ off a Mac), and Musical Typing: the
 * computer keyboard as a piano when there's no MIDI keyboard to hand.
 */
import { midi } from '../audio/midi.ts';
import {
  addTrack,
  bounceSong,
  deleteSelection,
  ensureAudio,
  locate,
  moveBars,
  quantizeSelection,
  redo,
  repeatRegions,
  saveNow,
  selectAll,
  selectTrack,
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
import { store } from './store.ts';

export interface KeyCommand {
  keys: string;
  what: string;
  group: string;
}

export const KEY_COMMANDS: KeyCommand[] = [
  { keys: 'Space', what: 'Play or stop', group: 'Transport' },
  { keys: 'R', what: 'Record', group: 'Transport' },
  { keys: 'C', what: 'Cycle on or off', group: 'Transport' },
  { keys: 'K', what: 'Metronome', group: 'Transport' },
  { keys: 'Return', what: 'Go to the beginning', group: 'Transport' },
  { keys: ', / .', what: 'Back or forward a bar', group: 'Transport' },
  { keys: 'X', what: 'Mixer', group: 'Windows' },
  { keys: 'A', what: 'Automation lanes', group: 'Windows' },
  { keys: 'P', what: 'Piano Roll', group: 'Windows' },
  { keys: 'Ctrl Shift F', what: 'Full screen', group: 'Windows' },
  { keys: 'I', what: 'Inspector', group: 'Windows' },
  { keys: 'Y', what: 'Library', group: 'Windows' },
  { keys: 'Ctrl K', what: 'Musical Typing', group: 'Windows' },
  { keys: '?', what: 'Key commands', group: 'Windows' },
  { keys: 'Ctrl Z / Ctrl Shift Z', what: 'Undo / Redo', group: 'Edit' },
  { keys: 'Delete', what: 'Delete the selection', group: 'Edit' },
  { keys: 'Ctrl A', what: 'Select all', group: 'Edit' },
  { keys: 'Q', what: 'Quantize', group: 'Edit' },
  { keys: 'Ctrl T', what: 'Split at the playhead', group: 'Edit' },
  { keys: 'Ctrl R', what: 'Repeat the region', group: 'Edit' },
  { keys: '↑ / ↓', what: 'Transpose notes (Shift: an octave) or select a track', group: 'Edit' },
  { keys: 'M / S', what: 'Mute or solo the track', group: 'Tracks' },
  { keys: 'Alt Ctrl N', what: 'New track', group: 'Tracks' },
  { keys: 'Ctrl S', what: 'Save now', group: 'Project' },
  { keys: 'Ctrl B', what: 'Bounce to a WAV file (the cycle, when it’s on)', group: 'Project' },
  { keys: 'A S D F… / W E T…', what: 'Musical Typing: white and black keys', group: 'Musical Typing' },
  { keys: 'Z / X', what: 'Musical Typing: octave down / up', group: 'Musical Typing' },
  { keys: 'C / V', what: 'Musical Typing: softer / harder', group: 'Musical Typing' },
];

/** Musical Typing: Logic's layout. A is C; W, E, T, Y, U, O, P the black keys. */
const TYPING: Record<string, number> = {
  KeyA: 0,
  KeyW: 1,
  KeyS: 2,
  KeyE: 3,
  KeyD: 4,
  KeyF: 5,
  KeyT: 6,
  KeyG: 7,
  KeyY: 8,
  KeyH: 9,
  KeyU: 10,
  KeyJ: 11,
  KeyK: 12,
  KeyO: 13,
  KeyL: 14,
  KeyP: 15,
  Semicolon: 16,
  Quote: 17,
};

const held = new Map<string, number>();
export const TYPING_PORT = 'Musical Typing';

function typingKey(e: KeyboardEvent, down: boolean): boolean {
  const s = store.get();
  if (!s.typing || e.ctrlKey || e.metaKey || e.altKey) return false;
  if (down && e.code === 'KeyZ') {
    store.set({ typingOctave: Math.max(-1, s.typingOctave - 1) });
    return true;
  }
  if (down && e.code === 'KeyX') {
    store.set({ typingOctave: Math.min(8, s.typingOctave + 1) });
    return true;
  }
  if (down && e.code === 'KeyC') {
    store.set({ typingVelocity: Math.max(1, s.typingVelocity - 16) });
    return true;
  }
  if (down && e.code === 'KeyV') {
    store.set({ typingVelocity: Math.min(127, s.typingVelocity + 16) });
    return true;
  }
  const offset = TYPING[e.code];
  if (offset === undefined) return false;
  if (down) {
    if (held.has(e.code)) return true; // key repeat
    void ensureAudio();
    const note = Math.max(0, Math.min(127, (s.typingOctave + 1) * 12 + offset));
    held.set(e.code, note);
    midi.receive(TYPING_PORT, [0x90, note, s.typingVelocity], performance.now());
  } else {
    const note = held.get(e.code);
    if (note === undefined) return false;
    held.delete(e.code);
    midi.receive(TYPING_PORT, [0x80, note, 0], performance.now());
  }
  return true;
}

function editing(target: EventTarget | null): boolean {
  const el = target as HTMLElement | null;
  if (!el) return false;
  return el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT';
}

function selectedTrackId(): string | null {
  return store.get().selectedTrack;
}

function onKeyDown(e: KeyboardEvent): void {
  if (editing(e.target)) return;
  if (typingKey(e, true)) {
    e.preventDefault();
    return;
  }
  const s = store.get();
  const ctrl = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  let handled = true;
  if (ctrl && e.altKey && key === 'n') addTrack({ type: 'synth', preset: 'Soft Keys' });
  else if (ctrl && e.shiftKey && key === 'f') toggleFullscreen();
  else if (ctrl && key === 'z') e.shiftKey ? redo() : undo();
  else if (ctrl && key === 'y') redo();
  else if (ctrl && key === 's') void saveNow();
  else if (ctrl && key === 'b') void bounceSong(true);
  else if (ctrl && key === 'a') selectAll();
  else if (ctrl && key === 't') splitAtPlayhead();
  else if (ctrl && key === 'r') repeatRegions();
  else if (ctrl && key === 'k') {
    store.set({ typing: !s.typing });
    if (!s.typing) midi.addVirtualPort(TYPING_PORT, 'typing');
  } else if (ctrl) handled = false;
  else if (e.code === 'Space') void togglePlay();
  else if (key === 'r') void toggleRecord();
  else if (key === 'c') toggleCycle();
  else if (key === 'k') toggleMetronome();
  else if (key === 'Enter' || key === 'Home') {
    if (s.playing) stop();
    locate(0);
  } else if (key === ',') moveBars(-1);
  else if (key === '.') moveBars(1);
  else if (key === 'a') store.set({ automationView: !s.automationView });
  else if (key === 'x') store.set({ editor: s.editor === 'mixer' ? null : 'mixer', mobileTab: 'mixer' });
  else if (key === 'p') store.set({ editor: s.editor === 'piano' ? null : 'piano', mobileTab: 'editor' });
  else if (key === 'i') store.set({ inspector: !s.inspector });
  else if (key === 'y') store.set({ library: !s.library });
  else if (key === '?') store.set({ dialog: s.dialog === 'shortcuts' ? null : 'shortcuts' });
  else if (key === 'q') quantizeSelection();
  else if (key === 'Delete' || key === 'Backspace') deleteSelection();
  else if (key === 'Escape') store.set({ selectedNotes: [], selectedRegions: [], dialog: null, plugin: null });
  else if (key === 'm' || key === 's') {
    const id = selectedTrackId();
    const t = s.project?.tracks.find((x) => x.id === id);
    if (t)
      updateChannel(
        t.id,
        key === 'm' ? { mute: !t.channel.mute } : { solo: !t.channel.solo },
        key === 'm' ? 'Mute' : 'Solo',
      );
  } else if (key === 'ArrowUp' || key === 'ArrowDown') {
    const up = key === 'ArrowUp';
    if (s.selectedNotes.length) transposeSelection((up ? 1 : -1) * (e.shiftKey ? 12 : 1));
    else if (s.project) {
      const tracks = s.project.tracks;
      const i = tracks.findIndex((t) => t.id === s.selectedTrack);
      const next = tracks[Math.max(0, Math.min(tracks.length - 1, i + (up ? -1 : 1)))];
      if (next) selectTrack(next.id);
    }
  } else handled = false;
  if (handled) e.preventDefault();
}

function onKeyUp(e: KeyboardEvent): void {
  if (typingKey(e, false)) e.preventDefault();
}

/** Lost focus: release every typed note so none hangs. */
function onBlur(): void {
  for (const note of held.values()) midi.receive(TYPING_PORT, [0x80, note, 0], performance.now());
  held.clear();
}

export function installKeys(): () => void {
  window.addEventListener('keydown', onKeyDown);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('blur', onBlur);
  return () => {
    window.removeEventListener('keydown', onKeyDown);
    window.removeEventListener('keyup', onKeyUp);
    window.removeEventListener('blur', onBlur);
  };
}
