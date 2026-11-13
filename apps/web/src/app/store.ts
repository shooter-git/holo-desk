/**
 * The studio's state: the open song, its undo history, what's selected and how the screen is laid
 * out. One small store; components read slices of it with useApp(selector).
 */
import type { ClickSound } from '@holo/engine';
import type { DIVISIONS, MiddleC, Note, Project } from '@holo/session';
import { useSyncExternalStore } from 'react';
import type { LatencyMode } from '../audio/engine.ts';
import type { MidiStatus, PortInfo } from '../audio/midi.ts';

export interface Step {
  project: Project;
  label: string;
  /** The agent's job whose changes this step holds (they merge into one step while it runs). */
  job?: string;
  /** When the change was made (ms since the epoch), undone or not: the history menu says how long ago. */
  at: number;
}

export type SaveState = 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict' | 'error';
export type Tool = 'pointer' | 'pencil' | 'eraser';
export type EditorPane = 'piano' | 'mixer' | null;
/** What the editor shows for a track's notes: the Piano Roll or the Score. */
export type NoteView = 'roll' | 'score';
export type MobileTab = 'tracks' | 'editor' | 'mixer' | 'play' | 'library';
export type Dialog = null | 'projects' | 'settings' | 'creations' | 'shortcuts' | 'about' | 'remote';
/** Settings' tabs. */
export type SettingsTab = 'general' | 'audio' | 'midi' | 'metronome' | 'view' | 'agent';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error';
  /** A button beside the words: what it says and does (the toast goes when it's pressed). */
  action?: { label: string; run: () => void };
}

export interface AppState {
  project: Project | null;
  /** The revision the server has: saves are based on it (undo never rewinds it). */
  serverRevision: number;
  undo: Step[];
  redo: Step[];
  saveState: SaveState;
  /** The agent's jobs this studio has had changes from: true while one runs. */
  agentJobs: Record<string, boolean>;
  /** Undo and Redo are reported to the host (the agent is on and this device is allowed). */
  agentReport: boolean;

  selectedTrack: string | null;
  selectedRegions: string[];
  selectedNotes: Note[];

  editor: EditorPane;
  noteView: NoteView;
  /** The Score shows every track (a full score), not just the selected one. */
  scoreAll: boolean;
  /** The Score's size, as a percentage. */
  scoreZoom: number;
  /** Writing in the Score: keys and clicks enter notes. */
  scoreWrite: boolean;
  /** The Scan window: a new scan being made (id null), or one being reviewed. */
  scanView: { id: string | null } | null;
  /** The Print window: the full score ("score"), every part ("parts"), or one track's part. */
  printView: { what: string } | null;
  /** Goes up when the host says a scan changed (the review reads it again). */
  scanTick: number;
  editorHeight: number;
  inspector: boolean;
  library: boolean;
  dialog: Dialog;
  /** The tab Settings opens on: the last one shown (for this session only), or the one a caller names. */
  settingsTab: SettingsTab;
  plugin: { target: string; id: string } | null;
  /** The channel whose Stage window is open. */
  stage: string | null;
  /** The track whose synth's knobs are open (Fat, Ethereal). */
  synth: string | null;
  mobileTab: MobileTab;
  /** The compact display (a phone, a narrow bar), which has room for one: the time instead of the position. */
  positionTime: boolean;

  tool: Tool;
  grid: keyof typeof DIVISIONS;
  /** Pixels per quarter note in the tracks area and the piano roll. */
  zoom: number;
  pianoZoom: number;
  trackHeight: number;
  keyHeight: number;
  follow: boolean;
  /** Automation lanes over the tracks (Logic's A), and the setting each track shows. */
  automationView: boolean;
  autoParam: Record<string, string>;
  /** The CC lane shown under the piano roll ("velocity", a CC number, "pb", "at"). */
  lane: string;

  audioReady: boolean;
  playing: boolean;
  recording: boolean;
  metronome: boolean;
  /** The metronome's volume on this device (0–1, the engine's level). */
  metronomeLevel: number;
  metronomeSound: ClickSound;
  countIn: number;
  latencyMode: LatencyMode;
  /** Logic's Low Latency Mode: nothing that delays the sound while you play. */
  lowLatency: boolean;
  /** This device's chosen sound output ('' = the system's default). */
  outputDevice: string;
  /** This device's input for audio tracks ('' = the system's default). */
  inputDevice: string;
  /** The round trip measured on this device (ms): recordings are moved back by it. */
  roundTrip: number | null;
  /** HO[LO] Engine shares the sound device with other apps (otherwise it has it to itself: WASAPI exclusive). */
  shareDevice: boolean;
  middleC: MiddleC;
  typing: boolean;
  typingOctave: number;
  typingVelocity: number;

  midiStatus: MidiStatus;
  midiPorts: PortInfo[];
  peers: { role: string; name: string }[];
  /** What this device calls itself to the others ("Studio laptop"); empty: worked out from the browser. */
  deviceName: string;
  /** The live channel to HO[LO]'s host. */
  connection: 'connecting' | 'online' | 'offline';
  toasts: Toast[];
  /** A bounce in progress: what it's doing now. */
  bouncing: string | null;
  /** Which parts of the studio show (View: the eye's menu, and Settings › View): everything, until you hide some. */
  show: Record<ShowKey, boolean>;
  /** The bar is open (Ctrl /): the studio's commands, tracks and markers, found by name. Never remembered. */
  bar: boolean;
  /** Words for the Library's search to show (the bar asked it to find a sound); null once it has them. */
  librarySearch: string | null;
}

/** The parts of the studio View shows or hides, all shown at first. */
export const SHOW_DEFAULTS = {
  barNav: true,
  barTime: true,
  barSig: true,
  barKey: true,
  barMetronome: true,
  barTyping: true,
  barMidi: true,
  barDsp: true,
  barRemote: true,
  barFullscreen: true,
  trackIcons: true,
  trackSub: true,
  trackButtons: true,
  regionNames: true,
  regionContents: true,
  gridLines: true,
  markers: true,
  stripInstrument: true,
  stripMidiFx: true,
  stripAudioFx: true,
  stripSends: true,
  stripStage: true,
  stripOutput: true,
  stripPan: true,
};
export type ShowKey = keyof typeof SHOW_DEFAULTS;

const stored = (() => {
  try {
    return JSON.parse(localStorage.getItem('holo:view') ?? '{}') as Partial<AppState>;
  } catch {
    return {};
  }
})();

const initial: AppState = {
  project: null,
  serverRevision: 0,
  undo: [],
  redo: [],
  saveState: 'saved',
  agentJobs: {},
  agentReport: false,
  selectedTrack: null,
  selectedRegions: [],
  selectedNotes: [],
  editor: 'piano',
  noteView: 'roll',
  scoreAll: false,
  scoreZoom: 45,
  scoreWrite: false,
  scanView: null,
  printView: null,
  scanTick: 0,
  // the editor takes a good share of the window to start with; a remembered height stands over this
  editorHeight:
    typeof window === 'undefined' ? 300 : Math.max(260, Math.min(520, Math.round(window.innerHeight * 0.42))),
  inspector: true,
  library: false,
  dialog: null,
  settingsTab: 'general',
  plugin: null,
  stage: null,
  synth: null,
  mobileTab: 'tracks',
  positionTime: false,
  tool: 'pointer',
  grid: '1/16',
  zoom: 40,
  pianoZoom: 90,
  trackHeight: 56,
  keyHeight: 14,
  follow: true,
  lane: 'velocity',
  automationView: false,
  autoParam: {},
  audioReady: false,
  playing: false,
  recording: false,
  metronome: false,
  metronomeLevel: 0.6,
  metronomeSound: 'beep',
  countIn: 1,
  latencyMode: 'lowest',
  lowLatency: true,
  outputDevice: '',
  inputDevice: '',
  roundTrip: null,
  shareDevice: false,
  middleC: 'C3',
  typing: false,
  typingOctave: 4,
  typingVelocity: 96,
  midiStatus: 'off',
  midiPorts: [],
  peers: [],
  deviceName: '',
  connection: 'connecting',
  toasts: [],
  bouncing: null,
  bar: false,
  librarySearch: null,
  ...stored,
  // parts added since this device last saved its view start shown
  show: { ...SHOW_DEFAULTS, ...(stored.show ?? {}) },
};

/** Settings that survive a reload on this device (never the song itself). */
const REMEMBER: (keyof AppState)[] = [
  'editor',
  'noteView',
  'scoreAll',
  'scoreZoom',
  'editorHeight',
  'inspector',
  'library',
  'grid',
  'zoom',
  'pianoZoom',
  'trackHeight',
  'keyHeight',
  'follow',
  'metronome',
  'metronomeLevel',
  'metronomeSound',
  'countIn',
  'latencyMode',
  'lowLatency',
  'outputDevice',
  'inputDevice',
  'roundTrip',
  'shareDevice',
  'middleC',
  'typingOctave',
  'typingVelocity',
  'mobileTab',
  'positionTime',
  'automationView',
  'deviceName',
  'show',
];

let state = initial;
const listeners = new Set<() => void>();
let rememberTimer = 0;

export const store = {
  get: (): AppState => state,
  set(patch: Partial<AppState> | ((s: AppState) => Partial<AppState>)): void {
    const p = typeof patch === 'function' ? patch(state) : patch;
    state = { ...state, ...p };
    for (const l of listeners) l();
    if (REMEMBER.some((k) => k in p)) {
      clearTimeout(rememberTimer);
      rememberTimer = window.setTimeout(() => {
        try {
          localStorage.setItem('holo:view', JSON.stringify(Object.fromEntries(REMEMBER.map((k) => [k, state[k]]))));
        } catch {
          // private windows may refuse storage: the view just isn't remembered
        }
      }, 300);
    }
  },
  subscribe(fn: () => void): () => void {
    listeners.add(fn);
    return () => listeners.delete(fn);
  },
};

export function useApp<T>(selector: (s: AppState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()));
}

let toastId = 0;
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 3500, action?: Toast['action']): void {
  const id = ++toastId;
  store.set((s) => ({ toasts: [...s.toasts, { id, text, kind, ...(action ? { action } : {}) }] }));
  window.setTimeout(() => store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

/** Open the bar (Ctrl /, the search button, or a swipe down on a phone's top bar). */
export function openBar(): void {
  if (!state.bar) store.set({ bar: true });
}

export function closeBar(): void {
  if (state.bar) store.set({ bar: false });
}

/** Open Settings on the tab named (the DSP meter on Audio, say), or on the last one shown. */
export function openSettings(tab?: SettingsTab): void {
  store.set(tab ? { dialog: 'settings', settingsTab: tab } : { dialog: 'settings' });
}

/** Whether a part of the studio shows (View). */
export function useShow(key: ShowKey): boolean {
  return useApp((s) => s.show[key]);
}
