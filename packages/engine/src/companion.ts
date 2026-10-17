/**
 * HO[LO] Engine, the companion app: what the studio and it say to each other over a WebSocket on
 * this device (127.0.0.1). The studio sends the same messages it sends its own audio thread
 * (ToWorklet) and hears the same answers (FromWorklet), plus a few of the companion's own: its sound
 * device, its MIDI devices and the notes played on them, and a round trip measured natively.
 *
 * Messages travel as one binary frame each: a JSON header, then every typed array's bytes, so samples
 * and sequences arrive exactly as they were (NaN, the infinities and -0 included).
 */
import type { FromWorklet, ToWorklet } from './protocol.ts';

/** The port HO[LO] Engine listens on, on 127.0.0.1 only. */
export const COMPANION_PORT = 47830;

/**
 * How deep the device's buffer is, as a multiple of its shortest period: 1 (the lowest latency), 2
 * or 4. The companion chooses it from how the device behaves and remembers it; the studio's latency
 * setting puts a floor under it (Lowest 1, Balanced 2, Safe 4).
 */
export type Depth = 1 | 2 | 4;

/** The companion's sound device, as it opened it. */
export interface CompanionDevice {
  /** The device's own rate: the studio compiles the song (and decodes its samples) at it. */
  rate: number;
  /** Frames the device asks for at a time, and the frames it holds before they're heard. */
  period: number;
  buffer: number;
  /** The period as a multiple of the device's shortest: deeper after trouble (see Depth). */
  depth: Depth;
  /** 'exclusive': WASAPI exclusive mode; 'shared': the OS mixer (in its low-latency mode where it has one). */
  mode: 'exclusive' | 'shared';
  /** miniaudio's name for the audio API: WASAPI, Core Audio, ALSA, PulseAudio, JACK, Null. */
  backend: string;
  name: string;
  /** Why it isn't in the mode asked for (another app holds the device in exclusive mode, say). */
  note?: string;
}

export interface CompanionPort {
  /** Stable while the device stays plugged in: notes from it name it. */
  slot: number;
  name: string;
  /** Open and playing; false when another app holds it (Windows lets one app at a time open most MIDI devices). */
  open: boolean;
}

/** How the companion is doing, a couple of times a second. */
export interface CompanionStats {
  /** From the cable to the speakers, ms: the last notes played (median, worst, how many). */
  notes: { median: number; worst: number; count: number } | null;
  /** Times the sound device found nothing ready (the companion then keeps a block or more in hand). */
  underruns: number;
  /** Frames rendered ahead of the device: 0 while it keeps up, more after underruns. */
  cushion: number;
  /** How it's buffering and why, in words ("deepened after the device ran short"). */
  why: string;
  /** The floor the studio's latency setting puts under the depth. */
  floor: Depth;
  /**
   * Rendering ahead on its own worker threads: each one's share of a block's time (smoothed), and
   * the blocks the render thread waited for them (played as silence) since it started.
   */
  ahead?: { loads: number[]; stalls: number };
}

export type ToCompanion =
  | ToWorklet
  /**
   * Open the sound and the MIDI devices (the studio that sends it takes the companion over). `floor`
   * is the studio's latency setting as a depth; `manual` marks the user's own choice of mode, which
   * stands over what failed before.
   */
  | { type: 'open'; exclusive: boolean; floor?: Depth; manual?: boolean }
  /** Where live MIDI goes: the same rule the studio follows with the browser's own MIDI. */
  | { type: 'routes'; routes: LiveRoutes }
  /** The round trip, measured natively: clicks out of the speakers, heard by the default microphone. */
  | { type: 'measure'; seconds: number };

export type FromCompanion =
  | FromWorklet
  | { type: 'hello'; version: string; platform: string }
  | { type: 'device'; device: CompanionDevice }
  | { type: 'deviceError'; message: string }
  | { type: 'midiPorts'; ports: CompanionPort[] }
  /**
   * Notes and controllers played on the companion's MIDI devices, already playing: [slot, status,
   * d1, d2, frame] each, where frame is the engine frame being heard when it was played.
   */
  | { type: 'midi'; events: number[] }
  | { type: 'measured'; roundTrip: number | null; heard: number; input: number | null; error?: string }
  | { type: 'stats'; stats: CompanionStats }
  /** Another studio took the companion over. */
  | { type: 'replaced' };

/**
 * Whether a host is this computer, the local network or a tailnet (where HO[LO] runs): a studio
 * served from one finds the companion by itself (browsers ask first only for public sites), and the
 * companion lets it in without being told.
 */
export function privateHost(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (/\.(ts\.net|local|lan|home\.arpa|internal)$/.test(host)) return true;
  const v4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    return (
      a === 127 ||
      a === 10 ||
      (a === 172 && b >= 16 && b < 32) ||
      (a === 192 && b === 168) ||
      (a === 169 && b === 254) ||
      (a === 100 && b >= 64 && b < 128)
    );
  }
  return host === '::1' || /^f[cd][0-9a-f]{2}:/.test(host) || /^fe[89ab][0-9a-f]:/.test(host);
}

// ---- live routing ----

export interface LiveRoute {
  num: number;
  /** A MIDI device's name, or '*' for any. */
  port: string;
  /** 1–16, or 0 for any. */
  channel: number;
}

/** Live MIDI goes to the armed tracks whose input matches; with none armed, to the selected track. */
export interface LiveRoutes {
  armed: LiveRoute[];
  selected: LiveRoute | null;
}

function matches(r: LiveRoute, port: string, channel: number): boolean {
  return (r.port === '*' || r.port === port) && (r.channel === 0 || r.channel === channel);
}

/** The track numbers live MIDI from a port and channel (1–16) plays. */
export function routeLive(routes: LiveRoutes, port: string, channel: number): number[] {
  const armed = routes.armed.filter((r) => matches(r, port, channel)).map((r) => r.num);
  if (armed.length) return armed;
  const s = routes.selected;
  return s && matches(s, port, channel) ? [s.num] : [];
}

// ---- the wire ----

const VIEWS = {
  f32: Float32Array,
  f64: Float64Array,
  i8: Int8Array,
  u8: Uint8Array,
  c8: Uint8ClampedArray,
  i16: Int16Array,
  u16: Uint16Array,
  i32: Int32Array,
  u32: Uint32Array,
} as const;
type ViewKind = keyof typeof VIEWS;
type View = InstanceType<(typeof VIEWS)[ViewKind]>;

function kindOf(v: ArrayBufferView): ViewKind | null {
  for (const [k, C] of Object.entries(VIEWS) as [ViewKind, (typeof VIEWS)[ViewKind]][]) {
    if (v instanceof C) return k;
  }
  return null;
}

/** A marker key no message uses: what stands in the header for a typed array or a number JSON can't hold. */
const TAG = '\u0000';

const align8 = (n: number) => (n + 7) & ~7;

/**
 * One message as one binary frame: the header's length and the number of arrays (two u32), the
 * header (JSON), each array's offset and byte length (two u32 each), then the arrays, 8-aligned so
 * the other side reads them in place.
 */
export function encodeMessage(msg: unknown): ArrayBuffer {
  const blobs: ArrayBufferView[] = [];
  const header = JSON.stringify(msg, function (this: unknown, key: string, value: unknown) {
    // the replacer sees typed arrays and numbers as they are, before JSON turns them into something else
    const raw = (this as Record<string, unknown>)[key];
    if (ArrayBuffer.isView(raw) && !(raw instanceof DataView)) {
      const kind = kindOf(raw);
      if (!kind) throw new Error('A BigInt array can’t go to HO[LO] Engine');
      blobs.push(raw);
      return { [TAG]: kind, i: blobs.length - 1 };
    }
    if (typeof raw === 'number' && (!Number.isFinite(raw) || Object.is(raw, -0)))
      return { [TAG]: 'n', v: Object.is(raw, -0) ? '-0' : String(raw) };
    if (raw === undefined && key !== '') return { [TAG]: 'u' };
    return value;
  });
  const text = new TextEncoder().encode(header);
  const table = align8(8 + text.length);
  let size = align8(table + blobs.length * 8);
  const offsets = blobs.map((b) => {
    const at = size;
    size = align8(size + b.byteLength);
    return at;
  });
  const out = new ArrayBuffer(size);
  const bytes = new Uint8Array(out);
  const view = new DataView(out);
  view.setUint32(0, text.length, true);
  view.setUint32(4, blobs.length, true);
  bytes.set(text, 8);
  blobs.forEach((b, i) => {
    const at = offsets[i] as number;
    view.setUint32(table + i * 8, at, true);
    view.setUint32(table + i * 8 + 4, b.byteLength, true);
    bytes.set(new Uint8Array(b.buffer, b.byteOffset, b.byteLength), at);
  });
  return out;
}

/** A frame back into its message. Its typed arrays are views of the frame: transfer the frame to move them. */
export function decodeMessage(frame: ArrayBuffer): unknown {
  const view = new DataView(frame);
  const textLength = view.getUint32(0, true);
  const count = view.getUint32(4, true);
  const header = new TextDecoder().decode(new Uint8Array(frame, 8, textLength));
  const table = align8(8 + textLength);
  return JSON.parse(header, (_key, value: unknown) => {
    if (!value || typeof value !== 'object' || !(TAG in value)) return value;
    const marker = value as { [TAG]: string; v?: string; i?: number };
    const tag = marker[TAG];
    if (tag === 'n') return Number(marker.v);
    if (tag === 'u') return undefined;
    const i = marker.i ?? -1;
    if (!(i >= 0 && i < count)) throw new Error('A message to or from HO[LO] Engine is cut short');
    const C = VIEWS[tag as ViewKind];
    const at = view.getUint32(table + i * 8, true);
    const bytes = view.getUint32(table + i * 8 + 4, true);
    return new C(frame, at, bytes / C.BYTES_PER_ELEMENT) as View;
  }) as unknown;
}
