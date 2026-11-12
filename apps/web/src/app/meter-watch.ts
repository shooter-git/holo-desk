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

interface Held {
  /** [time, left, right, gain reduction] of each reading in the seconds kept. */
  recent: [number, number, number, number][];
  maxL: number;
  maxR: number;
  grMax: number;
  clipped: boolean;
}

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
      const [l, r, g] = read(id);
      let h = this.held.get(id);
      if (!h) {
        h = { recent: [], maxL: 0, maxR: 0, grMax: 0, clipped: false };
        this.held.set(id, h);
      }
      h.recent.push([now, l, r, g]);
      while (h.recent.length && (h.recent[0] as [number, number, number, number])[0] < now - this.keepMs)
        h.recent.shift();
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
      let l = 0;
      let r = 0;
      let g = 0;
      for (const [at, a, b, c] of h.recent) {
        if (at < end - window) continue;
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
    const watched = this.watched(now);
    return {
      playing: this.playing,
      seconds: Math.round(watched / 100) / 10,
      covered: Math.round(Math.min(window, watched) / 100) / 10,
      channels,
    };
  }
}
