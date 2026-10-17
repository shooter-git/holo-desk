/**
 * The companion's engine: @holo/engine's EngineCore (the studio's audio thread, the bounce and
 * `holo render-audio` are the same code) rendering 128-frame blocks for the native sound device the
 * moment it asks for them, with every USB MIDI instrument's notes taken in just before each block.
 *
 * It runs on a worker thread of its own (render.ts) and takes the studio's messages between blocks.
 * When the song is rendered ahead (ahead.ts), workers play it and this plays the master and every
 * live note, as the studio's audio thread does (@holo/engine's AheadPlayer).
 *
 * How deep it buffers is its own business, not the user's: it keeps a period in hand, more when its
 * own blocks come close to the period or the device runs short, never again less than what ran
 * short on this device; it opens the device at a longer period (twice, then four times its
 * shortest) when running short or stopping persists, shares the device when even that fails, and
 * remembers what each device needed for the next time (memory.ts). The studio's latency setting is
 * a floor under all of that.
 */
import { AheadLink, AheadPlayer, EngineCore, METER_FLOATS } from '@holo/engine';
import {
  type CompanionDevice,
  type CompanionPort,
  type Depth,
  type FromCompanion,
  type LiveRoutes,
  routeLive,
  type ToCompanion,
} from '@holo/engine/companion';
import type { DeviceMemory } from './memory.ts';
import type { Native, OpenedDevice } from './native.ts';

const BLOCK = 128;
/**
 * Frames rendered ahead of the device: one period to start with (a block late is then still in
 * time), a block more each time it runs short or comes close after that, up to MAX_LEVEL.
 */
const MIN_LEVEL = 1;
const MAX_LEVEL = 4;
/** A message that takes this long (ms) is the studio handing over a song: the device may run short meanwhile. */
const BUSY_MS = 1;
/** Without trouble for this long (µs), the cushion comes down a step: minutes, not seconds. */
const CALM_US = 300e6;
/** The render thread's slowest block taking this share of the period, this many stats in a row, deepens the cushion early. */
const HOT_SHARE = 0.7;
const HOT_HOLD = 2;

export type Post = (msg: FromCompanion, transfer?: ArrayBuffer[]) => void;

/** Something to wait on for a moment (the render thread has no event loop to sleep in). */
const PAUSE = new Int32Array(new SharedArrayBuffer(4));

/** Internal: the studio that had the companion has gone. */
export type ToRenderer = ToCompanion | { type: 'close' };

export interface RendererOptions {
  /** The null backend (no sound device): for tests and for computers without one. */
  nullAudio?: boolean;
  /** Overrides what the studio asks for: shared mode always. */
  shared?: boolean;
  /** What each device needed last time (none: nothing is remembered). */
  memory?: DeviceMemory;
  log?: (line: string) => void;
}

/** The next depth up: twice the shortest period, then four times. */
function deeper(d: Depth): Depth {
  return d === 1 ? 2 : 4;
}

export class Renderer {
  private core: EngineCore | null = null;
  /** Rendering ahead: the song comes from the workers, block by block (null: this plays it all). */
  private player: AheadPlayer | null = null;
  private link: AheadLink | null = null;
  private aheadWorkers = 0;
  private device: CompanionDevice | null = null;
  /** What the studio asked for, and what the device is open as. */
  private asked = true;
  private exclusive = false;
  /** Engine frames rendered so far: the engine's clock (its "context frame"). */
  private rendered = 0;
  /** The engine frame the device's first frame was (the device's own count starts again when it reopens). */
  private ringBase = 0;
  private readonly left = new Float32Array(BLOCK);
  private readonly right = new Float32Array(BLOCK);
  /** Audio tracks' input, a block at a time (null while no track records or monitors). */
  private input: Float32Array[] | null = null;
  private readonly status = new Float64Array(9);
  private readonly midiBuf = new Float64Array(3 * 512);
  private readonly latBuf = new Float64Array(64);
  private routes: LiveRoutes = { armed: [], selected: null };
  private routeCache = new Map<number, number[]>();
  private names = new Map<number, string>();
  private portsKey = '';
  private played: number[] = [];
  private meterLength = METER_FLOATS;
  private openedAt = 0;
  private nextScan = 0;
  private nextStats = 0;
  private nextReopen = 0;
  private underrunsSeen = 0;
  private level = MIN_LEVEL;
  /** Never again below this: the level after one that ran short on this device (this session). */
  private minLevel = MIN_LEVEL;
  /** The device's period as a multiple of its shortest, and the floor the studio's latency setting puts under it. */
  private depth: Depth = 1;
  private floor: Depth = 1;
  /** The depth that ran short or stopped on this device (0: none yet): it's never opened that shallow again. */
  private failedDepth = 0;
  /** Times the device stopped under an exclusive stream, this device. */
  private stops = 0;
  /** Shared because exclusive mode kept failing (until the user chooses exclusive again). */
  private sharedByForce = false;
  /** The studio's current message is the user's own choice of mode. */
  private manual = false;
  /** Backend and name of the device open now: what the memory is kept by. */
  private deviceKey = '';
  /** How it's buffering and why, in words. */
  private why = '';
  /** The render thread's slowest block (ms) since the last stats, and how long it has been close to the period. */
  private peakMs = 0;
  private hot = 0;
  /** Until then, running short isn't the device's fault (a song arriving, the device just opened). */
  private quietUntil = 0;
  private calmSince = 0;
  private measureEnd = 0;
  private midiOn = false;

  private readonly native: Native;
  private readonly post: Post;
  private readonly opts: RendererOptions;

  constructor(native: Native, post: Post, opts: RendererOptions = {}) {
    this.native = native;
    this.post = post;
    this.opts = opts;
  }

  get open(): boolean {
    return this.device !== null;
  }

  /** One message from the studio (or the server). */
  receive(msg: ToRenderer): void {
    const t0 = performance.now();
    this.handle(msg);
    if (performance.now() - t0 > BUSY_MS) this.quietUntil = this.native.now() + 1e6;
  }

  private handle(msg: ToRenderer): void {
    switch (msg.type) {
      case 'open': {
        const floor: Depth = msg.floor === 2 || msg.floor === 4 ? msg.floor : 1;
        const changed = floor !== this.floor;
        this.floor = floor;
        this.asked = msg.exclusive && !this.opts.shared;
        this.manual = msg.manual === true;
        // the user's own choice of exclusive mode stands over what failed before
        if (this.manual && this.asked) this.sharedByForce = false;
        this.openDevice(changed || this.manual);
        this.manual = false;
        return;
      }
      case 'close':
        this.closeAll();
        return;
      case 'routes':
        this.routes = msg.routes;
        this.routeCache.clear();
        return;
      case 'measure':
        this.startMeasure(msg.seconds);
        return;
      case 'init': {
        this.core?.receive(msg);
        const a = msg.ahead;
        this.link = a && this.core ? new AheadLink(a.control, a.data, a.edges) : null;
        this.player = a && this.core && this.link ? new AheadPlayer(this.core, this.link, a.workers) : null;
        this.aheadWorkers = this.player ? (a?.workers ?? 0) : 0;
        return;
      }
      case 'live':
        // straight in, whoever plays the song: heard in the very next block
        this.core?.receive(msg);
        return;
      case 'inputs':
        this.setInput(msg.tracks.length > 0);
        break;
      case 'graph': {
        // meters go back for the channels there are, not all 512
        const nums = [...msg.graph.tracks, ...msg.graph.buses].map((c) => c.num);
        this.meterLength = (Math.max(0, ...nums) + 1) * METER_FLOATS;
        break;
      }
    }
    if (this.player) this.player.receive(msg);
    else this.core?.receive(msg);
  }

  /**
   * One turn: render what the device is waiting for, then (the caller) takes in messages. Returns
   * after `ms` at most when the device wants nothing.
   */
  tick(ms = 4): void {
    if (!this.device) return;
    const want = this.native.renderWait(ms);
    if (want > 0) this.render(want);
    this.housekeeping();
  }

  private render(frames: number): void {
    const core = this.core;
    if (!core) return;
    for (let done = 0; done < frames; done += BLOCK) {
      this.takeMidi(core);
      if (this.input) this.native.inputRead(this.input[0] as Float32Array, this.input[1] as Float32Array);
      const player = this.player;
      const t0 = performance.now();
      if (player) {
        const taken = player.taken;
        player.process(this.left, this.right, this.input ?? undefined, this.rendered);
        // the studio's messages are taken in here, before the block they belong to: a song arriving
        if (player.taken !== taken && performance.now() - t0 > BUSY_MS) this.quietUntil = this.native.now() + 1e6;
      } else core.process(this.left, this.right, this.input ?? undefined, this.rendered);
      // how close this thread comes to the period: what deepens the cushion before anything is heard
      const took = performance.now() - t0;
      if (took > this.peakMs) this.peakMs = took;
      this.native.renderWrite(this.left, this.right);
      this.rendered += BLOCK;
    }
    if (this.played.length) {
      this.post({ type: 'midi', events: this.played });
      this.played = [];
    }
  }

  /** MIDI that has arrived, into the block about to render: routed as the studio routes it. */
  private takeMidi(core: EngineCore): void {
    const count = this.midiOn ? this.native.midiRead(this.midiBuf) : 0;
    if (!count) return;
    const device = this.device as CompanionDevice;
    this.native.audioStatus(this.status);
    const clock = this.status[2] as number;
    const running = this.status[3] === 1;
    const live: number[] = [];
    for (let i = 0; i < count; i++) {
      const slot = this.midiBuf[i * 3] as number;
      const word = this.midiBuf[i * 3 + 1] as number;
      const arrived = this.midiBuf[i * 3 + 2] as number;
      const status = word & 0xff;
      if (status < 0x80 || status >= 0xf0) continue;
      const d1 = (word >> 8) & 0x7f;
      const d2 = (word >> 16) & 0x7f;
      const targets = this.targets(slot, (status & 0x0f) + 1);
      for (const num of targets) live.push(status, d1, d2, num);
      if ((status & 0xf0) === 0x90 && d2 > 0 && targets.length)
        this.native.noteMark(this.rendered - this.ringBase, arrived);
      // the frame being heard when it was played: what a recording lines it up with
      const heard = running ? this.ringBase + clock + (arrived * device.rate) / 1e6 - device.buffer : -1;
      this.played.push(slot, status, d1, d2, Math.round(heard));
    }
    if (live.length) core.receive({ type: 'live', events: live });
  }

  private targets(slot: number, channel: number): number[] {
    const key = slot * 32 + channel;
    let t = this.routeCache.get(key);
    if (!t) {
      const name = this.names.get(slot);
      t = name === undefined ? [] : routeLive(this.routes, name, channel);
      this.routeCache.set(key, t);
    }
    return t;
  }

  private housekeeping(): void {
    const now = this.native.now();
    if (now >= this.nextScan) {
      this.nextScan = now + 1e6;
      this.scanMidi();
    }
    if (this.measureEnd && now >= this.measureEnd) this.finishMeasure();
    this.native.audioStatus(this.status);
    const lost = this.status[4] === 1;
    if ((lost || this.status[8] === 1) && now >= this.nextReopen) {
      // the device went away (unplugged, or another app took it), or the system plays through another
      // one now: open the default one again
      this.nextReopen = now + 1e6;
      if (lost && this.exclusive) this.afterStop();
      this.reopen(lost ? 'The sound device stopped: opening it again' : 'The default output changed: opening it');
      return;
    }
    if (now >= this.nextStats) {
      this.nextStats = now + 5e5;
      this.adapt(now);
      const n = this.native.noteLatencies(this.latBuf);
      const lat = [...this.latBuf.subarray(0, n)].sort((a, b) => a - b);
      this.post({
        type: 'stats',
        stats: {
          notes: n
            ? { median: (lat[Math.floor(n / 2)] as number) / 1000, worst: (lat[n - 1] as number) / 1000, count: n }
            : null,
          underruns: this.status[1] as number,
          cushion: this.cushion(),
          why: this.why,
          floor: this.floor,
          ...(this.link ? { ahead: this.aheadStats(this.link) } : {}),
        },
      });
    }
  }

  /**
   * Buffering, decided here and nowhere else: when the device runs short while playing (not while a
   * song arrives), or this thread's blocks come close to the period, keep more rendered ahead, and
   * never again less than what ran short; when the deepest cushion still runs short, open the device
   * at a longer period, and share it when even that fails. After a calm five minutes, a step less.
   */
  private adapt(now: number): void {
    const device = this.device;
    if (!device) return;
    const underruns = this.status[1] as number;
    const fresh = underruns - this.underrunsSeen;
    this.underrunsSeen = underruns;
    const periodMs = (device.period / device.rate) * 1000;
    const close = this.peakMs > HOT_SHARE * periodMs;
    this.peakMs = 0;
    if (now < this.quietUntil || now - this.openedAt < 1e6) {
      this.calmSince = now;
      this.hot = 0;
      return;
    }
    if (fresh > 0) {
      this.calmSince = now;
      this.hot = 0;
      this.minLevel = Math.min(MAX_LEVEL, Math.max(this.minLevel, this.level + 1));
      if (this.level < MAX_LEVEL) {
        this.level++;
        this.native.setCushion(this.cushion());
        this.why = 'deepened after the device ran short';
        this.log(
          `The sound ran short ${fresh} time${fresh === 1 ? '' : 's'}: now rendering ${this.cushion()} frames ahead, and never less than that on this device today`,
        );
        this.remember();
      } else {
        this.failedDepth = this.depth;
        if (this.exclusive && this.depth < 4) {
          this.why = 'deepened after the device ran short';
          this.reopen(
            `The sound ran short ${fresh} time${fresh === 1 ? '' : 's'} even with ${this.cushion()} frames ahead: opening the device at a longer period`,
          );
        } else if (this.exclusive) {
          this.sharedByForce = true;
          this.why = 'shared, after exclusive mode kept running short on this device';
          this.reopen('The sound still ran short at the longest period: sharing the device instead');
        }
      }
      return;
    }
    if (close) {
      if (++this.hot >= HOT_HOLD && this.level < MAX_LEVEL) {
        this.hot = 0;
        this.calmSince = now;
        this.level++;
        this.native.setCushion(this.cushion());
        this.why = 'deepened before the device could run short';
        this.log(
          `The render thread came close to the period: now rendering ${this.cushion()} frames ahead, before anything is heard`,
        );
        this.remember();
      }
      return;
    }
    this.hot = 0;
    if (this.level > this.minLevel && now - this.calmSince > CALM_US) {
      this.calmSince = now;
      this.level--;
      this.native.setCushion(this.cushion());
      this.log(`Steady for a while: now rendering ${this.cushion()} frames ahead`);
      this.remember();
    }
  }

  /** The device stopped under an exclusive stream: the next open goes deeper, and after the deepest, shared. */
  private afterStop(): void {
    this.stops++;
    this.failedDepth = this.depth;
    if (this.depth < 4) {
      this.why = 'deepened after the device stopped';
    } else {
      this.sharedByForce = true;
      this.why = `shared, after the device stopped ${this.stops} times in exclusive mode`;
    }
  }

  /** The device opened again as it now should be (the input along with it). */
  private reopen(line: string): void {
    this.log(line);
    const input = this.input !== null;
    this.input = null;
    this.native.audioClose();
    this.device = null;
    this.openDevice(true);
    this.setInput(input);
  }

  private aheadStats(link: AheadLink): { loads: number[]; stalls: number } {
    return { loads: Array.from({ length: this.aheadWorkers }, (_, j) => link.load(j)), stalls: link.stalls() };
  }

  private cushion(): number {
    const period = this.device?.period ?? BLOCK;
    return this.level === 0 ? 0 : period + (this.level - 1) * BLOCK;
  }

  private remembered(key = this.deviceKey) {
    return key && this.opts.memory ? this.opts.memory.get(key) : null;
  }

  private remember(): void {
    const m = this.opts.memory;
    if (!m || !this.deviceKey) return;
    m.set(this.deviceKey, { depth: this.depth, level: this.level, shared: this.sharedByForce });
  }

  /** The depth to open at: the studio's floor, what failed on this device, and what's remembered for it. */
  private wantDepth(key: string): Depth {
    let d: Depth = this.floor;
    const mem = this.remembered(key);
    if (mem && mem.depth > d) d = mem.depth;
    if (this.failedDepth && deeper(this.failedDepth as Depth) > d) d = deeper(this.failedDepth as Depth);
    return d;
  }

  /**
   * The sound device, as it now should be: at the depth this device needs, exclusive unless that
   * keeps failing or the studio (or what's remembered) says shared. Opens again only when something
   * about that has changed, or when told to.
   */
  private openDevice(force = false): void {
    // before the device is named, what the one opened last time needed is the best guess
    const guess = this.deviceKey || this.opts.memory?.last() || '';
    const known = this.remembered(guess);
    const exclusive = this.asked && !this.sharedByForce && !(known?.shared === true && !this.manual);
    const depth = this.wantDepth(guess);
    if (this.device && this.exclusive === exclusive && this.depth === depth && !force) {
      this.post({ type: 'device', device: this.device });
      return;
    }
    if (this.device) {
      this.native.audioClose();
      this.device = null;
    }
    let opened = this.openOnce(exclusive, depth);
    if (!opened) return;
    // the device named: if it's a known one with other needs, open it as it held last time
    const key = `${opened.device.backend}|${opened.device.name}`;
    const fresh = key !== this.deviceKey;
    if (fresh) {
      this.deviceKey = key;
      this.minLevel = MIN_LEVEL;
      this.failedDepth = 0;
      this.stops = 0;
      this.hot = 0;
      if (!this.manual) this.sharedByForce = false;
      const mem = this.remembered(key);
      const shareIt = this.asked && mem?.shared === true && !this.manual;
      const want = this.wantDepth(key);
      if (shareIt) this.sharedByForce = true;
      if ((shareIt && opened.device.mode === 'exclusive') || want !== opened.device.depth) {
        this.native.audioClose();
        opened = this.openOnce(this.asked && !this.sharedByForce, want);
        if (!opened) return;
      }
      this.opts.memory?.setLast(key);
      if (mem)
        this.why =
          mem.shared && opened.device.mode === 'shared'
            ? 'shared, as this device needed last time'
            : 'remembered for this device';
      else if (opened.device.depth > 1 && opened.device.depth === this.floor) this.why = 'the latency setting';
      else this.why = 'the shortest the device offers';
    } else if (!this.why) {
      this.why = depth > 1 && depth === this.floor ? 'the latency setting' : 'the shortest the device offers';
    }
    const { device, note } = opened;
    this.exclusive = device.mode === 'exclusive';
    this.depth = device.depth;
    if (!this.core || this.core.sr !== device.rate) this.newCore(device.rate);
    if (this.core) this.core.budgetFrames = device.period;
    this.device = device;
    this.ringBase = this.rendered;
    this.openedAt = this.native.now();
    const mem = this.remembered(key);
    this.level = Math.max(this.minLevel, Math.min(MAX_LEVEL, mem?.level ?? MIN_LEVEL));
    this.native.setCushion(this.cushion());
    this.underrunsSeen = 0;
    this.calmSince = this.openedAt;
    this.peakMs = 0;
    if (!this.midiOn) {
      this.native.midiOpen();
      this.midiOn = true;
      this.nextScan = 0;
    }
    this.remember();
    this.log(
      `Playing through ${device.name}: ${device.backend} ${device.mode}, ${device.rate} Hz, ` +
        `${ms(device.period, device.rate)} ms period${device.depth > 1 ? ` (${device.depth}× its shortest)` : ''}, ` +
        `${ms(device.buffer, device.rate)} ms buffer, ${this.cushion()} frames in hand (${this.why})` +
        (note ? `. ${note}` : ''),
    );
    this.post({ type: 'device', device });
  }

  /** One attempt at the device, shared when exclusive mode isn't possible; null (and the studio told) when neither opens. */
  private openOnce(exclusive: boolean, depth: Depth): { device: CompanionDevice; note?: string } | null {
    let opened: OpenedDevice;
    let note: string | undefined;
    try {
      opened = this.openSoon(exclusive, depth);
    } catch (err) {
      if (!exclusive) {
        this.deviceError(err);
        return null;
      }
      // exclusive mode wasn't possible (another app has the device that way, or its format): share it
      note = `Exclusive mode wasn’t possible (${message(err)}), so the device is shared`;
      try {
        opened = this.native.audioOpen({ exclusive: false, depth, null: this.opts.nullAudio });
      } catch (err2) {
        this.deviceError(err2);
        return null;
      }
    }
    const device: CompanionDevice = {
      rate: opened.rate,
      period: opened.period,
      buffer: opened.buffer,
      depth: opened.depth === 2 || opened.depth === 4 ? opened.depth : depth,
      mode: opened.exclusive ? 'exclusive' : 'shared',
      backend: opened.backend,
      name: opened.name,
      ...(opened.bluetooth
        ? {
            note: 'These are Bluetooth headphones: their own link adds 100–250 ms that no app can take away, so HO[LO] Engine shares them rather than crackle. To play, use the laptop’s speakers or wired headphones.',
          }
        : note
          ? { note }
          : {}),
    };
    return { device, ...(note ? { note } : {}) };
  }

  /**
   * The device, in exclusive mode tried for a second: the browser that just let go of it may take a
   * moment to close its own stream.
   */
  private openSoon(exclusive: boolean, depth: Depth): OpenedDevice {
    for (let tries = 0; ; tries++) {
      try {
        return this.native.audioOpen({ exclusive, depth, null: this.opts.nullAudio });
      } catch (err) {
        if (!exclusive || tries >= 4) throw err;
        Atomics.wait(PAUSE, 0, 0, 250);
      }
    }
  }

  /** The default input for audio tracks, while one records or monitors. */
  private setInput(on: boolean): void {
    if (on === (this.input !== null) || !this.device) return;
    if (!on) {
      this.native.inputClose();
      this.input = null;
      return;
    }
    try {
      this.native.inputOpen();
      this.input = [new Float32Array(BLOCK), new Float32Array(BLOCK)];
    } catch (err) {
      this.log(`Couldn’t open the input: ${message(err)}`);
      this.post({ type: 'error', message: `HO[LO] Engine couldn’t open the input: ${message(err)}` });
    }
  }

  private deviceError(err: unknown): void {
    this.log(`Couldn’t open the sound device: ${message(err)}`);
    this.post({ type: 'deviceError', message: message(err) });
  }

  private newCore(rate: number): void {
    const core = new EngineCore(rate, (msg, transfer) => {
      if (msg.type === 'state') {
        // only the channels there are, a fresh copy each time (the core's own arrays it reuses)
        this.post({ type: 'state', transport: msg.transport, meters: msg.meters.slice(0, this.meterLength) });
        return;
      }
      this.post(msg, transfer);
    });
    core.clock = () => performance.now();
    core.fineClock = true;
    this.core = core;
    // (a studio starting again says whether it's rendered ahead)
    this.player = null;
    this.link = null;
    this.rendered = 0;
  }

  private scanMidi(): void {
    if (!this.midiOn) return;
    const ports: CompanionPort[] = this.native.midiScan().map((p) => ({ slot: p.slot, name: p.name, open: p.open }));
    const key = JSON.stringify(ports);
    if (key === this.portsKey) return;
    this.portsKey = key;
    this.names = new Map(ports.map((p) => [p.slot, p.name]));
    this.routeCache.clear();
    this.log(
      ports.length
        ? `MIDI: ${ports.map((p) => (p.open ? p.name : `${p.name} (in use by another app)`)).join(', ')}`
        : 'MIDI: no devices yet (plug one in: it’s found within a second)',
    );
    this.post({ type: 'midiPorts', ports });
  }

  private startMeasure(seconds: number): void {
    try {
      this.native.measureStart();
      this.measureEnd = this.native.now() + Math.max(1, Math.min(20, seconds)) * 1e6;
    } catch (err) {
      this.post({ type: 'measured', roundTrip: null, heard: 0, input: null, error: message(err) });
    }
  }

  private finishMeasure(): void {
    this.measureEnd = 0;
    const r = this.native.measureStop();
    const times = [...r.times].sort((a, b) => a - b);
    const roundTrip = times.length ? (times[Math.floor(times.length / 2)] as number) : null;
    this.log(
      roundTrip === null
        ? 'Round trip: no clicks heard'
        : `Round trip ${roundTrip.toFixed(1)} ms (${times.length} clicks)`,
    );
    // (the input's buffer is only the most it can add, so the round trip isn't split into out and in)
    this.post({ type: 'measured', roundTrip, heard: times.length, input: null });
  }

  private closeAll(): void {
    if (this.measureEnd) {
      this.measureEnd = 0;
      this.native.measureStop();
    }
    if (this.input) this.native.inputClose();
    this.input = null;
    if (this.device) this.native.audioClose();
    if (this.midiOn) this.native.midiClose();
    this.device = null;
    this.midiOn = false;
    this.portsKey = '';
    this.names.clear();
    this.routes = { armed: [], selected: null };
    this.routeCache.clear();
    this.core = null;
    this.player = null;
    this.link = null;
  }

  private log(line: string): void {
    this.opts.log?.(line);
  }
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function ms(frames: number, rate: number): string {
  return ((frames / rate) * 1000).toFixed(1);
}
