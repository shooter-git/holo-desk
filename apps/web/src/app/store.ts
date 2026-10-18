/**
 * The studio's state: the open song, its undo history, what's selected and how the screen is laid
 * out. One small store; components read slices of it with useApp(selector).
 */
import type { DIVISIONS, MiddleC, Note, Project } from '@holo/session';
import { useSyncExternalStore } from 'react';
import type { LatencyMode } from '../audio/engine.ts';
import type { MidiStatus, PortInfo } from '../audio/midi.ts';

export interface Step {
  project: Project;
  label: string;
}

export type SaveState = 'saved' | 'dirty' | 'saving' | 'offline' | 'conflict' | 'error';
export type Tool = 'pointer' | 'pencil' | 'eraser';
export type EditorPane = 'piano' | 'mixer' | null;
export type MobileTab = 'tracks' | 'editor' | 'mixer' | 'play' | 'library';
export type Dialog = null | 'projects' | 'settings' | 'creations' | 'shortcuts' | 'about' | 'remote';

export interface Toast {
  id: number;
  text: string;
  kind: 'info' | 'error' | 'ai';
}

export interface AppState {
  project: Project | null;
  /** The revision the server has: saves are based on it (undo never rewinds it). */
  serverRevision: number;
  undo: Step[];
  redo: Step[];
  saveState: SaveState;

  selectedTrack: string | null;
  selectedRegions: string[];
  selectedNotes: Note[];

  editor: EditorPane;
  editorHeight: number;
  inspector: boolean;
  library: boolean;
  dialog: Dialog;
  plugin: { target: string; id: string } | null;
  /** The channel whose Stage window is open. */
  stage: string | null;
  mobileTab: MobileTab;

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
  /** Which parts of the studio show (the View menu): everything, until you hide some. */
  show: Record<ShowKey, boolean>;
}

/** The parts of the studio the View menu shows or hides, all shown at first. */
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
  selectedTrack: null,
  selectedRegions: [],
  selectedNotes: [],
  editor: 'piano',
  // the editor takes a good share of the window to start with; a remembered height stands over this
  editorHeight:
    typeof window === 'undefined' ? 300 : Math.max(260, Math.min(520, Math.round(window.innerHeight * 0.42))),
  inspector: true,
  library: false,
  dialog: null,
  plugin: null,
  stage: null,
  mobileTab: 'tracks',
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
  ...stored,
  // parts added since this device last saved its view start shown
  show: { ...SHOW_DEFAULTS, ...(stored.show ?? {}) },
};

/** Settings that survive a reload on this device (never the song itself). */
const REMEMBER: (keyof AppState)[] = [
  'editor',
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
export function toast(text: string, kind: Toast['kind'] = 'info', ms = 3500): void {
  const id = ++toastId;
  store.set((s) => ({ toasts: [...s.toasts, { id, text, kind }] }));
  window.setTimeout(() => store.set((s) => ({ toasts: s.toasts.filter((t) => t.id !== id) })), ms);
}

/** Whether a part of the studio shows (the View menu). */
export function useShow(key: ShowKey): boolean {
  return useApp((s) => s.show[key]);
}
