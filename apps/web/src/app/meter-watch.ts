/**
 * What the studio's meters showed while the song played, kept for the agent (agent-meters.ts): each
 * channel's peaks (left, right) and gain reduction, the loudest of the last seconds asked for (up to
 * the last 30) and the loudest since play started, and whether it went past full scale (latched until
 * play starts again). Plain, with no browser in it: it's handed readings and the time.
 */

/** A channel's meter as the engine reads it: peak left, peak right (1 is full scale), gain reduction (dB, ≤ 0). */
export type MeterReading = readonly [number, number, number];

/** A channel as the agent reads it: levels in dBFS (null: silence), gain reduction in dB (≤ 0). */
export interface MeterReport {
  id: string;
  /** The loudest of the seconds covered (the last of play), and since play started: [left, right]. */
  peak: [number | null, number | null];
  max: [number | null, number | null];
  /** The deepest gain reduction of the seconds covered, and since play started. */
  gr: number | null;
  grMax: number | null;
  clipped: boolean;
}

export interface MetersReport {
  playing: boolean;
  /** Seconds of play watched. */
  seconds: number;
  /** Seconds the peaks and gain reduction cover: the last of play, as many as were asked for and watched. */
  covered: number;
  /** Channels that sounded, the master first. */
  channels: MeterReport[];
}

/**
 * A channel's readings in the seconds kept: a ring of [time, left, right, gain reduction], four
 * numbers a reading in one array made once, so a reading taken twenty times a second for every
 * channel leaves nothing behind to be collected while the song plays.
 */
class Recent {
  private data: Float64Array;
  private head = 0;
  private count = 0;

  constructor(capacity: number) {
    this.data = new Float64Array(Math.max(4, capacity) * 4);
  }

  private get capacity(): number {
    return this.data.length / 4;
  }

  /** Add a reading, letting go of those from before `oldest`. */
  push(at: number, l: number, r: number, g: number, oldest: number): void {
    while (this.count && (this.data[this.head * 4] as number) < oldest) {
      this.head = (this.head + 1) % this.capacity;
      this.count--;
    }
    if (this.count === this.capacity) this.grow();
    const i = ((this.head + this.count) % this.capacity) * 4;
    this.data[i] = at;
    this.data[i + 1] = l;
    this.data[i + 2] = r;
    this.data[i + 3] = g;
    this.count++;
  }

  /** (readings came faster than the room was made for: twice the room, in order from the oldest) */
  private grow(): void {
    const next = new Float64Array(this.data.length * 2);
    for (let n = 0; n < this.count; n++) {
      const i = ((this.head + n) % this.capacity) * 4;
      next.set(this.data.subarray(i, i + 4), n * 4);
    }
    this.data = next;
    this.head = 0;
  }

  /** The loudest left and right and the deepest gain reduction of the readings from `since` on. */
  loudest(since: number): [number, number, number] {
    let l = 0;
    let r = 0;
    let g = 0;
    for (let n = 0; n < this.count; n++) {
      const i = ((this.head + n) % this.capacity) * 4;
      if ((this.data[i] as number) < since) continue;
      l = Math.max(l, this.data[i + 1] as number);
      r = Math.max(r, this.data[i + 2] as number);
      g = Math.min(g, this.data[i + 3] as number);
    }
    return [l, r, g];
  }
}

interface Held {
  recent: Recent;
  maxL: number;
  maxR: number;
  grMax: number;
  clipped: boolean;
}

/** How often the meters are expected to be read (ms): the room a channel's readings are given at first. */
const EXPECTED_EVERY_MS = 50;

const db = (v: number): number | null => (v > 1e-6 ? Math.round(20 * Math.log10(v) * 10) / 10 : null);
const gr = (v: number): number | null => (v < -0.05 ? Math.round(v * 10) / 10 : null);

/** The longest stretch of play the meters can be asked about (ms). */
export const METERS_KEEP_MS = 30_000;
/** How long the meters are watched for an answer unless the agent says (s). */
export const METERS_DEFAULT_S = 8;

/** How many seconds of play an answer covers: what was asked (8 unless it says), from 1 to 30. */
export function metersSeconds(asked: unknown): number {
  const s = typeof asked === 'number' && Number.isFinite(asked) ? asked : METERS_DEFAULT_S;
  return Math.max(1, Math.min(METERS_KEEP_MS / 1000, s));
}

export class MeterWatch {
  private readonly keepMs: number;
  private held = new Map<string, Held>();
  private started: number | null = null;
  private stopped: number | null = null;

  /** `keepMs`: how much of the last of play is kept, the most a report can cover. */
  constructor(keepMs = METERS_KEEP_MS) {
    this.keepMs = keepMs;
  }

  /** Play started: what was kept from before goes. */
  start(now: number): void {
    this.held = new Map();
    this.started = now;
    this.stopped = null;
  }

  /** Play stopped: what was kept stays, to be asked about. */
  stop(now: number): void {
    if (this.started !== null && this.stopped === null) this.stopped = now;
  }

  get playing(): boolean {
    return this.started !== null && this.stopped === null;
  }

  /** How long (ms) the last play has been watched, to now or to where it stopped. */
  watched(now: number): number {
    return this.started === null ? 0 : Math.max(0, (this.stopped ?? now) - this.started);
  }

  /**
   * While the song plays, waits until this play has been watched `ms` (at once if it has, or it isn't
   * playing; sooner if it stops), on the caller's clock.
   */
  async until(ms: number, now: () => number, sleep: (ms: number) => Promise<unknown>): Promise<void> {
    while (this.playing && this.watched(now()) < ms) await sleep(Math.min(250, ms - this.watched(now()) + 10));
  }

  /** The channels' readings now. */
  sample(ids: readonly string[], read: (id: string) => MeterReading, now: number): void {
    if (!this.playing) return;
    for (const id of ids) {
      // (read at once: the reader may hand every channel the same array)
      const [l, r, g] = read(id);
      let h = this.held.get(id);
      if (!h) {
        const room = Math.ceil(this.keepMs / EXPECTED_EVERY_MS) + 16;
        h = { recent: new Recent(room), maxL: 0, maxR: 0, grMax: 0, clipped: false };
        this.held.set(id, h);
      }
      h.recent.push(now, l, r, g, now - this.keepMs);
      h.maxL = Math.max(h.maxL, l);
      h.maxR = Math.max(h.maxR, r);
      h.grMax = Math.min(h.grMax, g);
      if (l >= 1 || r >= 1) h.clipped = true;
    }
  }

  /**
   * What was kept: the channels that sounded (or reduced gain), the master first, then as `ids` lists
   * them; their peaks and gain reduction over the last `windowMs` of play (as much as was kept).
   */
  report(now: number, ids?: readonly string[], windowMs = 3000): MetersReport {
    const end = this.stopped ?? now;
    const window = Math.min(windowMs, this.keepMs);
    const order = ids ?? [...this.held.keys()];
    const channels: MeterReport[] = [];
    for (const id of ['master', ...order.filter((x) => x !== 'master')]) {
      const h = this.held.get(id);
      if (!h || (h.maxL <= 1e-6 && h.maxR <= 1e-6 && h.grMax >= -0.05)) continue;
      const [l, r, g] = h.recent.loudest(end - window);
      channels.push({
        id,
        peak: [db(l), db(r)],
        max: [db(h.maxL), db(h.maxR)],
        gr: gr(g),
        grMax: gr(h.grMax),
        clipped: h.clipped,
      });
    }
    const watched = this.watched(now);
    return {
      playing: this.playing,
      seconds: Math.round(watched / 100) / 10,
      covered: Math.round(Math.min(window, watched) / 100) / 10,
      channels,
    };
  }
}
