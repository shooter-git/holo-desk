/**
 * What View shows or hides (the eye's menu, and Settings › View): the panes, then the parts of the
 * tracks, the mixer strips and the control bar. Kept out of React, so both show the same list.
 * Most are parts of what's drawn; Inactive tracks, Buses and Master leave whole tracks or strips out
 * (app/shown-tracks.ts), on this device only: the song is whole whatever is shown of it.
 */
import { type AppState, SHOW_DEFAULTS, type ShowKey, store } from '../app/store.ts';

export type Pane = 'library' | 'inspector' | 'editor' | 'score' | 'mixer' | 'automation';

export const PANES: [Pane, string, string][] = [
  ['library', 'Library', 'Y'],
  ['inspector', 'Inspector', 'I'],
  ['editor', 'Piano Roll / Audio Editor', 'P'],
  ['score', 'Score', 'N'],
  ['mixer', 'Mixer', 'X'],
  ['automation', 'Automation lanes', 'A'],
];

/** The control bar's group: a phone has no such bar, so it isn't offered there. */
export const CONTROL_BAR = 'Control bar';

export const GROUPS: [string, [ShowKey, string][]][] = [
  [
    'Tracks',
    [
      ['trackIcons', 'Track icons'],
      ['trackSub', 'Instrument or input under the name'],
      ['trackButtons', 'On/off, mute, solo and record buttons'],
      ['trackMix', 'Volume and pan'],
      ['trackNumbers', 'Track numbers (in the Mixer too)'],
      ['regionNames', 'Region names'],
      ['regionContents', 'Notes and waveforms in regions'],
      ['gridLines', 'Grid lines'],
      ['markers', 'Markers'],
      // (one choice for both: a track switched off is left out of the tracks and of the Mixer)
      ['inactiveTracks', 'Inactive tracks (in the Mixer too)'],
      // (a strip of its own, as tall as the studio, whether the Inspector is open or not; on a phone,
      // the Mixer's first strip, which stays while the others scroll)
      ['masterRail', 'Stereo Out, pinned at the left'],
    ],
  ],
  [
    'Mixer strips',
    [
      ['stripInstrument', 'Instrument or input'],
      ['stripMidiFx', 'MIDI effects'],
      ['stripAudioFx', 'Audio effects'],
      ['stripSends', 'Sends'],
      ['stripStage', 'Stage'],
      ['stripOutput', 'Output'],
      ['stripPan', 'Pan'],
      ['stripButtons', 'On/off, mute, solo and record buttons'],
      ['mixerBuses', 'Buses'],
      ['mixerMaster', 'Master'],
    ],
  ],
  [
    CONTROL_BAR,
    [
      ['barUndo', 'Undo and redo'],
      ['barNav', 'Back and forward buttons'],
      ['barCapture', 'Capture'],
      ['barTime', 'Time'],
      ['barSig', 'Time signature'],
      ['barKey', 'Key'],
      ['barMetronome', 'Metronome'],
      ['barTyping', 'Musical Typing'],
      ['barMidi', 'MIDI devices'],
      ['barDsp', 'DSP load'],
      ['barRemote', 'Remote'],
      ['barFullscreen', 'Full screen'],
    ],
  ],
];

/** The groups this layout offers: all of them, but a phone's leaves out the control bar's. */
export function viewGroups(phone: boolean): [string, [ShowKey, string][]][] {
  return phone ? GROUPS.filter(([group]) => group !== CONTROL_BAR) : GROUPS;
}

/**
 * How many parts View hides: the choices that begin on and are off now. A choice that begins off
 * (track numbers, Stereo Out pinned at the left) adds something when it's taken: left alone, it
 * hides nothing, and isn't counted.
 */
export function hiddenParts(show: AppState['show']): number {
  return (Object.keys(SHOW_DEFAULTS) as ShowKey[]).filter((key) => SHOW_DEFAULTS[key] && !show[key]).length;
}

/** Every hidden part shown again. The choices that begin off stay as they are: they aren't hidden parts. */
export function showEverything(show: AppState['show']): AppState['show'] {
  const all = { ...show };
  for (const key of Object.keys(SHOW_DEFAULTS) as ShowKey[]) if (SHOW_DEFAULTS[key]) all[key] = true;
  return all;
}

export function paneOn(s: AppState, pane: Pane): boolean {
  if (pane === 'library') return s.library;
  if (pane === 'inspector') return s.inspector;
  if (pane === 'editor') return s.editor === 'piano' && s.noteView === 'roll';
  if (pane === 'score') return s.editor === 'piano' && s.noteView === 'score';
  if (pane === 'mixer') return s.editor === 'mixer';
  return s.automationView;
}

export function togglePane(pane: Pane): void {
  const s = store.get();
  if (pane === 'library') store.set({ library: !s.library });
  else if (pane === 'inspector') store.set({ inspector: !s.inspector });
  else if (pane === 'editor' || pane === 'score') {
    const view = pane === 'score' ? 'score' : 'roll';
    store.set({ editor: s.editor === 'piano' && s.noteView === view ? null : 'piano', noteView: view });
  } else if (pane === 'mixer') store.set({ editor: s.editor === 'mixer' ? null : 'mixer' });
  else store.set({ automationView: !s.automationView });
}
