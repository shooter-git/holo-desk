/**
 * HO[LO] Engine, the companion app, when it runs on this device: the studio's sound comes from it
 * (native audio, every USB MIDI instrument read natively), and the browser's own audio stays quiet.
 * It's found by itself on 127.0.0.1; without it nothing changes (browser audio and Web MIDI).
 *
 * The engine talks to it as it talks to its own audio thread: this link takes the same messages.
 */
import type { FromWorklet, ToWorklet } from '@holo/engine';
import {
  COMPANION_PORT,
  type CompanionDevice,
  type CompanionPort,
  type CompanionStats,
  type Depth,
  decodeMessage,
  encodeMessage,
  type FromCompanion,
  type LiveRoutes,
  privateHost,
  type ToCompanion,
} from '@holo/engine/companion';

export interface CompanionSnapshot {
  /** Its sound device once it has opened it for this studio: the studio then plays through it. */
  device: CompanionDevice | null;
  ports: CompanionPort[];
  stats: CompanionStats | null;
  version: string;
  /** Something to tell (another tab took it, the device wouldn't open). */
  note: string | null;
  /** Looking for it by itself (a public site waits to be asked, as browsers then ask the user). */
  looking: boolean;
}

export interface Measured {
  roundTrip: number | null;
  heard: number;
  input: number | null;
}

class Companion {
  private snap: CompanionSnapshot = { device: null, ports: [], stats: null, version: '', note: null, looking: false };
  private ws: WebSocket | null = null;
  private exclusive = true;
  /** The studio's latency setting as a floor under the companion's buffer depth. */
  private floor: Depth = 1;
  private routes: LiveRoutes = { armed: [], selected: null };
  private retry = 2000;
  private timer = 0;
  private listeners = new Set<() => void>();
  private measuring: ((m: Measured) => void) | null = null;
  private measureFailed: ((err: Error) => void) | null = null;
  /** The engine's own answers (what its audio thread would say). */
  onmessage: ((msg: FromWorklet) => void) | null = null;
  /** Notes and controllers played on its MIDI devices: [slot, status, d1, d2, frame] each. */
  onmidi: ((events: number[]) => void) | null = null;
  /**
   * Before it opens the sound device: the browser lets go of it first (WASAPI's exclusive mode can't
   * be had while any app, the browser included, has the device open).
   */
  beforeOpen: (() => Promise<void>) | null = null;

  get device(): CompanionDevice | null {
    return this.snap.device;
  }

  readonly subscribe = (fn: () => void): (() => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  readonly snapshot = (): CompanionSnapshot => this.snap;

  private set(patch: Partial<CompanionSnapshot>): void {
    this.snap = { ...this.snap, ...patch };
    for (const fn of this.listeners) fn();
  }

  /**
   * Start looking: now, again after a while (less and less often), and whenever this window comes
   * back to the front (someone has just started it, most likely). `ask` looks even from a public
   * site, where the browser asks the user first.
   */
  async find(exclusive: boolean, ask = false): Promise<void> {
    this.exclusive = exclusive;
    if (!ask && !(await mayLook())) return;
    if (!this.snap.looking) {
      this.set({ looking: true });
      window.addEventListener('focus', () => this.connect());
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && this.connect());
    }
    this.connect();
  }

  /** Exclusive mode (the lowest latency, no other app's sound) or the shared device. */
  setExclusive(on: boolean): void {
    this.exclusive = on;
    if (this.snap.device) this.send({ type: 'open', exclusive: on, floor: this.floor, manual: true });
  }
  /** The studio's latency setting: Lowest lets the companion start at the shortest period; Balanced and Safe start deeper. */
  setFloor(mode: 'lowest' | 'balanced' | 'safe'): void {
    const floor: Depth = mode === 'safe' ? 4 : mode === 'balanced' ? 2 : 1;
    if (floor === this.floor) return;
    this.floor = floor;
    if (this.snap.device) this.send({ type: 'open', exclusive: this.exclusive, floor });
  }

  /** Where live MIDI from its devices goes (sent again whenever it connects). */
  setRoutes(routes: LiveRoutes): void {
    const key = JSON.stringify(routes);
    if (key === this.routesKey) return;
    this.routesKey = key;
    this.routes = routes;
    if (this.snap.device) this.send({ type: 'routes', routes });
  }
  private routesKey = '';

  /** As a MessagePort: the engine posts the audio thread's messages here while the companion plays. */
  postMessage(msg: ToWorklet, _transfer?: Transferable[]): void {
    this.send(msg);
  }

  /** The round trip through its own device and the default microphone. */
  measure(seconds: number): Promise<Measured> {
    return new Promise((resolve, reject) => {
      if (!this.snap.device) return reject(new Error('HO[LO] Engine isn’t connected'));
      this.measuring = resolve;
      this.measureFailed = reject;
      this.send({ type: 'measure', seconds });
    });
  }

  private send(msg: ToCompanion): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(encodeMessage(msg));
  }

  private connect(): void {
    if (this.ws || !this.snap.looking) return;
    window.clearTimeout(this.timer);
    let ws: WebSocket;
    try {
      ws = new WebSocket(`ws://127.0.0.1:${COMPANION_PORT}`);
    } catch {
      this.later();
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (e) => {
      if (!(e.data instanceof ArrayBuffer)) return;
      this.receive(decodeMessage(e.data) as FromCompanion);
    };
    ws.onclose = () => {
      if (this.ws !== ws) return;
      this.ws = null;
      const was = this.snap.device !== null;
      this.set({ device: null, ports: [], stats: null });
      if (was) this.retry = 2000;
      if (this.snap.note !== REPLACED) this.later();
    };
  }

  private later(): void {
    window.clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.connect(), this.retry);
    this.retry = Math.min(30_000, this.retry * 2);
  }

  private receive(msg: FromCompanion): void {
    switch (msg.type) {
      case 'hello':
        this.set({ version: msg.version, note: null });
        void (this.beforeOpen?.() ?? Promise.resolve()).finally(() =>
          this.send({ type: 'open', exclusive: this.exclusive, floor: this.floor }),
        );
        return;
      case 'device':
        this.retry = 2000;
        this.set({ device: msg.device, note: msg.device.note ?? null });
        this.send({ type: 'routes', routes: this.routes });
        return;
      case 'deviceError':
        this.set({ device: null, note: `HO[LO] Engine couldn’t open the sound device: ${msg.message}` });
        return;
      case 'midiPorts':
        this.set({ ports: msg.ports });
        return;
      case 'midi':
        this.onmidi?.(msg.events);
        return;
      case 'stats':
        this.set({ stats: msg.stats });
        return;
      case 'measured':
        if (msg.error) this.measureFailed?.(new Error(msg.error));
        else this.measuring?.({ roundTrip: msg.roundTrip, heard: msg.heard, input: msg.input });
        this.measuring = this.measureFailed = null;
        return;
      case 'replaced':
        this.set({ note: REPLACED });
        return;
      default:
        this.onmessage?.(msg);
    }
  }
}

const REPLACED = 'HO[LO] Engine is playing another studio tab now: reload this one to bring it back here.';

/**
 * Browsers ask before a public site reaches this computer's own addresses, so from one the studio
 * only looks once asked (or allowed). From this computer, the local network or a tailnet it just looks.
 */
async function mayLook(): Promise<boolean> {
  if (privateHost(location.hostname)) return true;
  try {
    const p = await navigator.permissions.query({ name: 'loopback-network' as PermissionName });
    return p.state === 'granted';
  } catch {
    return true; // a browser that doesn't ask
  }
}

export const companion = new Companion();
