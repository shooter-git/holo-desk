/**
 * Live MIDI in: USB keyboards and drum pads (Web MIDI), the computer keyboard (Musical Typing),
 * notes from other devices on your network and notes the AI plays. Every source goes through
 * `receive`, which writes the event straight to the audio thread before anything else happens,
 * then tells the recorder and the screen.
 *
 * While HO[LO] Engine plays, it reads the USB devices itself (natively, and plays them at once):
 * their notes arrive here already played, for the recorder, the lights and the AI.
 */
import { type CompanionPort, type LiveRoutes, routeLive } from '@holo/engine/companion';
import { companion } from './companion.ts';
import { engine } from './engine.ts';

export interface PortInfo {
  id: string;
  name: string;
  manufacturer: string;
  connected: boolean;
  source: 'device' | 'remote' | 'typing' | 'ai';
}

export interface MidiEvent {
  /** performance.now() when it arrived (the device's own timestamp for USB). */
  time: number;
  status: number;
  d1: number;
  d2: number;
  port: string;
  /** From HO[LO] Engine: its frame that was being heard when this was played. */
  frame?: number;
}

export type MidiStatus = 'off' | 'unsupported' | 'denied' | 'on';

export class MidiHub {
  status: MidiStatus = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator ? 'off' : 'unsupported';
  ports: PortInfo[] = [];
  private access: MIDIAccess | null = null;
  private routes: LiveRoutes = { armed: [], selected: null };
  private routeCache = new Map<string, readonly number[]>();
  /** HO[LO] Engine has the USB devices (and the browser lets go of them). */
  private native = false;
  private nativePorts: CompanionPort[] = [];
  private portListeners = new Set<() => void>();
  private eventListeners = new Set<(e: MidiEvent) => void>();
  /** performance.now() of each port's last event, for the activity lights. */
  readonly lastActivity = new Map<string, number>();
  private extra = new Map<string, PortInfo>();
  private delays = new Float32Array(64).fill(Number.NaN);
  private delayAt = 0;

  /** How long USB MIDI waited for the page, over the last notes (ms). */
  handling(): { median: number; worst: number; count: number } | null {
    const v = [...this.delays].filter((x) => !Number.isNaN(x)).sort((a, b) => a - b);
    if (!v.length) return null;
    return { median: v[Math.floor(v.length / 2)] as number, worst: v[v.length - 1] as number, count: v.length };
  }

  async enable(): Promise<MidiStatus> {
    if (this.native) {
      this.status = 'on';
      return this.status;
    }
    if (this.status === 'unsupported') return this.status;
    if (this.access) return this.status;
    try {
      this.access = await navigator.requestMIDIAccess({ sysex: false });
      this.status = 'on';
      this.access.onstatechange = () => this.scan();
      this.scan();
    } catch {
      this.status = 'denied';
      this.changed();
    }
    return this.status;
  }

  private scan(): void {
    if (this.native) {
      this.ports = [
        ...this.nativePorts.map((p) => ({
          id: `engine:${p.slot}`,
          name: p.name,
          manufacturer: p.open ? 'HO[LO] Engine' : 'in use by another app',
          connected: p.open,
          source: 'device' as const,
        })),
        ...this.extra.values(),
      ];
      this.changed();
      return;
    }
    const access = this.access;
    if (!access) return;
    const devices: PortInfo[] = [];
    access.inputs.forEach((input) => {
      const name = input.name ?? input.id;
      devices.push({
        id: input.id,
        name,
        manufacturer: input.manufacturer ?? '',
        connected: input.state === 'connected',
        source: 'device',
      });
      // the handler does as little as possible: this is the path your playing takes
      input.onmidimessage = (e: MIDIMessageEvent) => {
        if (!e.data) return;
        this.receive(name, e.data, e.timeStamp);
        // how long the page took to hand the note on: anything here is the page being busy
        this.delays[this.delayAt++ % this.delays.length] = performance.now() - e.timeStamp;
      };
    });
    this.ports = [...devices, ...this.extra.values()];
    this.changed();
  }

  /** A port that isn't USB: Musical Typing, a device on the network, the AI. */
  addVirtualPort(name: string, source: PortInfo['source']): void {
    if (this.extra.has(name)) return;
    this.extra.set(name, { id: `virtual:${name}`, name, manufacturer: 'HO[LO]', connected: true, source });
    this.ports = [...this.ports.filter((p) => p.source === 'device'), ...this.extra.values()];
    this.changed();
  }

  removeVirtualPort(name: string): void {
    if (!this.extra.delete(name)) return;
    this.ports = this.ports.filter((p) => p.name !== name);
    this.changed();
  }

  /** Where live MIDI goes (HO[LO] Engine follows the same routes for the devices it reads). */
  setRoutes(routes: LiveRoutes): void {
    this.routes = routes;
    this.routeCache.clear();
    companion.setRoutes(routes);
  }

  /**
   * HO[LO] Engine reads the USB devices while it plays: the browser's MIDI lets go of them (Windows
   * lets one app at a time open most of them) and takes them back when it stops.
   */
  setNative(on: boolean): void {
    if (on === this.native) return;
    this.native = on;
    if (on) {
      this.status = 'on';
      this.access?.inputs.forEach((input) => {
        input.onmidimessage = null;
        void input.close();
      });
    }
    if (!on && !this.access) {
      // the browser's MIDI was never turned on: it is turned on afresh
      this.status = typeof navigator !== 'undefined' && 'requestMIDIAccess' in navigator ? 'off' : 'unsupported';
      this.ports = [...this.extra.values()];
      this.changed();
      return;
    }
    this.scan();
  }

  /** HO[LO] Engine's devices, as it found them. */
  setNativePorts(ports: CompanionPort[]): void {
    this.nativePorts = ports;
    if (this.native) this.scan();
  }

  /** Played on HO[LO] Engine's devices (and already playing there): [slot, status, d1, d2, frame] each. */
  nativeEvents(events: number[]): void {
    const now = performance.now();
    for (let i = 0; i + 4 < events.length; i += 5) {
      const slot = events[i] as number;
      const port = this.nativePorts.find((p) => p.slot === slot)?.name;
      if (port === undefined) continue;
      this.lastActivity.set(port, now);
      if (!this.eventListeners.size) continue;
      const e: MidiEvent = {
        time: now,
        status: events[i + 1] as number,
        d1: events[i + 2] as number,
        d2: events[i + 3] as number,
        port,
        frame: events[i + 4] as number,
      };
      for (const fn of this.eventListeners) fn(e);
    }
  }

  receive(port: string, data: ArrayLike<number>, time: number): void {
    const status = data[0] ?? 0;
    if (status >= 0xf0 || status < 0x80) return; // clock, sensing, sysex: not for us
    const d1 = data[1] ?? 0;
    const d2 = data[2] ?? 0;
    const channel = (status & 0x0f) + 1;
    const key = `${port}\u0000${channel}`;
    let targets = this.routeCache.get(key);
    if (!targets) {
      targets = routeLive(this.routes, port, channel);
      this.routeCache.set(key, targets);
    }
    for (let i = 0; i < targets.length; i++) engine.liveNum(status, d1, d2, targets[i] as number);
    this.lastActivity.set(port, time);
    if (this.eventListeners.size) {
      const e: MidiEvent = { time, status, d1, d2, port };
      for (const fn of this.eventListeners) fn(e);
    }
  }

  onEvent(fn: (e: MidiEvent) => void): () => void {
    this.eventListeners.add(fn);
    return () => this.eventListeners.delete(fn);
  }

  onPorts(fn: () => void): () => void {
    this.portListeners.add(fn);
    return () => this.portListeners.delete(fn);
  }

  private changed(): void {
    this.routeCache.clear();
    for (const fn of this.portListeners) fn();
  }
}

export const midi = new MidiHub();
