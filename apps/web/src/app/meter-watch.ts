/**
 * What the studio's meters showed while the song played, kept for the agent (agent-meters.ts): each
 * channel's peaks (left, right) and gain reduction, the loudest of the last few seconds and the
 * loudest since play started, and whether it went past full scale (latched until play starts again).
 * Plain, with no browser in it: it's handed readings and the time.
 */

/** A channel's meter as the engine reads it: peak left, peak right (1 is full scale), gain reduction (dB, ≤ 0). */
export type MeterReading = readonly [number, number, number];

/** A channel as the agent reads it: levels in dBFS (null: silence), gain reduction in dB (≤ 0). */
export interface MeterReport {
  id: string;
  /** The loudest of the last few seconds, and since play started: [left, right]. */
  peak: [number | null, number | null];
  max: [number | null, number | null];
  /** The deepest gain reduction of the last few seconds, and since play started. */
  gr: number | null;
  grMax: number | null;
  clipped: boolean;
}

export interface MetersReport {
  playing: boolean;
  /** Seconds of play watched. */
  seconds: number;
  /** Channels that sounded, the master first. */
  channels: MeterReport[];
}

interface Held {
  /** [time, left, right, gain reduction] of each reading in the last few seconds. */
  recent: [number, number, number, number][];
  maxL: number;
  maxR: number;
  grMax: number;
  clipped: boolean;
}

const db = (v: number): number | null => (v > 1e-6 ? Math.round(20 * Math.log10(v) * 10) / 10 : null);
const gr = (v: number): number | null => (v < -0.05 ? Math.round(v * 10) / 10 : null);

export class MeterWatch {
  private readonly windowMs: number;
  private held = new Map<string, Held>();
  private started: number | null = null;
  private stopped: number | null = null;

  constructor(windowMs = 3000) {
    this.windowMs = windowMs;
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

  /** The channels' readings now. */
  sample(ids: readonly string[], read: (id: string) => MeterReading, now: number): void {
    if (!this.playing) return;
    for (const id of ids) {
      const [l, r, g] = read(id);
      let h = this.held.get(id);
      if (!h) {
        h = { recent: [], maxL: 0, maxR: 0, grMax: 0, clipped: false };
        this.held.set(id, h);
      }
      h.recent.push([now, l, r, g]);
      while (h.recent.length && (h.recent[0] as [number, number, number, number])[0] < now - this.windowMs)
        h.recent.shift();
      h.maxL = Math.max(h.maxL, l);
      h.maxR = Math.max(h.maxR, r);
      h.grMax = Math.min(h.grMax, g);
      if (l >= 1 || r >= 1) h.clipped = true;
    }
  }

  /** What was kept: the channels that sounded (or reduced gain), the master first, then as `ids` lists them. */
  report(now: number, ids?: readonly string[]): MetersReport {
    const end = this.stopped ?? now;
    const order = ids ?? [...this.held.keys()];
    const channels: MeterReport[] = [];
    for (const id of ['master', ...order.filter((x) => x !== 'master')]) {
      const h = this.held.get(id);
      if (!h || (h.maxL <= 1e-6 && h.maxR <= 1e-6 && h.grMax >= -0.05)) continue;
      let l = 0;
      let r = 0;
      let g = 0;
      for (const [at, a, b, c] of h.recent) {
        if (at < end - this.windowMs) continue;
        l = Math.max(l, a);
        r = Math.max(r, b);
        g = Math.min(g, c);
      }
      channels.push({
        id,
        peak: [db(l), db(r)],
        max: [db(h.maxL), db(h.maxR)],
        gr: gr(g),
        grMax: gr(h.grMax),
        clipped: h.clipped,
      });
    }
    return {
      playing: this.playing,
      seconds: this.started === null ? 0 : Math.round((end - this.started) / 100) / 10,
      channels,
    };
  }
}
