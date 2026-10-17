import { defaultParams } from './plugins.ts';
import {
  type Bus,
  type Channel,
  type Instrument,
  type Plugin,
  PPQ,
  type Project,
  type Region,
  SESSION_FORMAT,
  SESSION_VERSION,
  type Track,
} from './types.ts';

/** A short random id: a prefix and ten base-36 characters. */
export function newId(prefix: string): string {
  const bytes = new Uint8Array(8);
  globalThis.crypto.getRandomValues(bytes);
  let n = 0n;
  for (const b of bytes) n = (n << 8n) | BigInt(b);
  return `${prefix}_${n.toString(36).padStart(10, '0').slice(-10)}`;
}

/** Track colours, in the order new tracks take them. */
export const TRACK_COLORS = [
  '#3fa7d6',
  '#59c3a1',
  '#9ccc65',
  '#f2c14e',
  '#f78154',
  '#e85d75',
  '#b07bd9',
  '#6c8cf5',
  '#4dd0e1',
  '#c0ca33',
  '#ffb74d',
  '#a1887f',
];

export function newChannel(output = 'master'): Channel {
  return { volume: 0, pan: 0, mute: false, solo: false, inserts: [], sends: [], output };
}

export function newPlugin(type: string, params: Record<string, number> = {}): Plugin {
  return { id: newId('fx'), type, bypass: false, params: { ...defaultParams(type), ...params } };
}

export function newTrack(name: string, instrument: Instrument, color?: string): Track {
  return {
    id: newId('trk'),
    name,
    color: color ?? TRACK_COLORS[0] ?? '#3fa7d6',
    kind: 'instrument',
    instrument,
    articulations: [],
    input: { port: '*', channel: 0 },
    armed: false,
    midiFx: [],
    regions: [],
    channel: newChannel(),
  };
}

/** An audio track: it plays recordings, and records from an input. */
export function newAudioTrack(name: string, color?: string): Track {
  return {
    ...newTrack(name, { type: 'none' }, color),
    kind: 'audio',
    audioInput: { input: 0, channels: 1, monitor: false },
  };
}

export function newRegion(start: number, length: number, name = ''): Region {
  return { id: newId('rgn'), name, start, length, muted: false, notes: [], cc: {} };
}

export function newBus(name: string, color = '#7c8a99'): Bus {
  return { id: newId('bus'), name, color, channel: newChannel() };
}

export const DEFAULT_SYNTH: Instrument = { type: 'synth', preset: 'Soft Keys' };

export function newProject(title: string): Project {
  const now = new Date().toISOString();
  const reverb = newBus('Reverb');
  reverb.channel.inserts.push(newPlugin('reverb', { mix: 100 }));
  const master = newChannel('');
  master.inserts.push(newPlugin('limiter'));
  const track = newTrack('Keys', DEFAULT_SYNTH);
  track.armed = true;
  track.channel.sends.push({ bus: reverb.id, level: -12, pre: false });
  return {
    format: SESSION_FORMAT,
    version: SESSION_VERSION,
    id: newId('prj'),
    title,
    revision: 0,
    created: now,
    modified: now,
    tempo: [{ tick: 0, bpm: 120 }],
    meter: [{ tick: 0, num: 4, den: 4 }],
    key: null,
    markers: [],
    chords: [],
    tracks: [track],
    buses: [reverb],
    master,
    cycle: { on: false, start: 0, end: PPQ * 4 * 4 },
    origin: null,
    notes: '',
  };
}

/** A deep copy, through JSON: sessions are plain data. */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}
