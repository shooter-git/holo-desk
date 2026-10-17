/**
 * The native piece (native/holo_native.c), as JavaScript sees it: the sound device, rendering into it,
 * and every MIDI input.
 */

export interface OpenedDevice {
  rate: number;
  period: number;
  buffer: number;
  /** The period as a multiple of the device's shortest (exclusive mode) or of a block: as asked. */
  depth: number;
  exclusive: boolean;
  backend: string;
  name: string;
  /** A Bluetooth output (Windows tells): opened shared, whatever was asked. */
  bluetooth: boolean;
}

export interface NativePort {
  slot: number;
  name: string;
  open: boolean;
}

export interface Native {
  /**
   * The default output at its own rate; WASAPI exclusive mode when asked (and it can), at `depth`
   * times its shortest period (elsewhere, `depth` blocks a period). Throws when it can't.
   */
  audioOpen(opts: { exclusive: boolean; depth?: 1 | 2 | 4; null?: boolean }): OpenedDevice;
  audioClose(): void;
  /** Frames to render now: what a waiting callback needs, or the cushion to top up (waits up to `ms` for either). */
  renderWait(ms: number): number;
  /** One block after the last (false when there's no room, which a worker keeping up never sees). */
  renderWrite(left: Float32Array, right: Float32Array): boolean;
  /**
   * [frames ready, underruns, the device's clock (it takes frame clock + t·rate at t µs), 1 once that
   * clock runs, lost, now µs, late callbacks, demand, 1 when the default output changed under an
   * exclusive stream].
   */
  audioStatus(out: Float64Array): void;
  setCushion(frames: number): void;
  noteMark(frame: number, arrivedUs: number): void;
  /** Fills `out` with the last notes' time from the cable to the speakers (µs), newest first. */
  noteLatencies(out: Float64Array): number;
  /** The default input, for audio tracks, at the device's rate. */
  inputOpen(): void;
  inputClose(): void;
  /** The next block of input (false, and silence, when there isn't one yet). */
  inputRead(left: Float32Array, right: Float32Array): boolean;
  measureStart(): void;
  measureStop(): { times: number[]; input: number };
  /** Raises the calling thread (the renderer) as far as the OS allows; says how. */
  boost(): string;
  /** µs on the clock the callbacks and MIDI use. */
  now(): number;
  midiOpen(): void;
  midiClose(): void;
  midiScan(): NativePort[];
  /** Fills `out` with [slot, status | d1 << 8 | d2 << 16, arrived µs] per message; returns how many. */
  midiRead(out: Float64Array): number;
}

/** Loads the native piece from a .node file (Node-API: the same file for every Node version). */
export function loadNative(path: string): Native {
  const mod = { exports: {} as Native };
  process.dlopen(mod, path);
  return mod.exports;
}

/** Where `pnpm companion:build` puts the native piece for this computer. */
export function nativeName(platform: string = process.platform, arch: string = process.arch): string {
  return `holo_native-${platform}-${arch}.node`;
}
