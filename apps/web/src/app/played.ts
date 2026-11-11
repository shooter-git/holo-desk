/**
 * What was just played on this studio: the notes of the last minute, from every port (a keyboard, Musical
 * Typing, a device on the network), kept so the agent can ask for "what I just played" after the fact.
 * Plain, with no browser in it: the live channel feeds it and answers from it.
 */

/** A note as the host's listener keeps one (docs/agent.md: PlayedNote). */
export interface PlayedNote {
  /** The song's tick when it was played (null when the song wasn't playing). */
  tick: number | null;
  /** ms from the start of the stretch asked for. */
  time: number;
  pitch: number;
  velocity: number;
  /** How long it was held (ms); null while it still is. */
  length: number | null;
  port: string;
}

/** One MIDI message as it arrived: when (ms, the page's clock), what, from which port, and where the song was. */
export interface Heard {
  at: number;
  status: number;
  d1: number;
  d2: number;
  port: string;
  tick: number | null;
}

interface Kept {
  at: number;
  end: number | null;
  pitch: number;
  velocity: number;
  port: string;
  tick: number | null;
}

/** How long it remembers, and how many notes at most (a minute of fast trills is still far below it). */
export const KEEP_MS = 60_000;
export const MOST_NOTES = 4000;

export class PlayedMemory {
  private notes: Kept[] = [];
  private readonly keepMs: number;
  private readonly most: number;

  constructor(keepMs = KEEP_MS, most = MOST_NOTES) {
    this.keepMs = keepMs;
    this.most = most;
  }

  /** Take in a message: a note on starts a note, a note off (or on at velocity 0) ends the one it plays. */
  add(e: Heard): void {
    const kind = e.status & 0xf0;
    if (kind === 0x90 && e.d2 > 0) {
      this.notes.push({ at: e.at, end: null, pitch: e.d1, velocity: e.d2, port: e.port, tick: e.tick });
      if (this.notes.length > this.most) this.notes.splice(0, this.notes.length - this.most);
    } else if (kind === 0x80 || kind === 0x90) {
      for (let i = this.notes.length - 1; i >= 0; i--) {
        const n = this.notes[i] as Kept;
        if (n.end === null && n.pitch === e.d1 && n.port === e.port) {
          n.end = e.at;
          break;
        }
      }
    }
    this.forget(e.at);
  }

  /** Notes older than it remembers go (those still held stay: they're still being played). */
  private forget(now: number): void {
    const since = now - this.keepMs;
    let drop = 0;
    while (drop < this.notes.length) {
      const n = this.notes[drop] as Kept;
      if (n.at >= since || n.end === null) break;
      drop++;
    }
    if (drop) this.notes.splice(0, drop);
  }

  /** The notes started in the last `seconds` (at most what it remembers), times from the start of that stretch. */
  played(seconds: number, now: number): PlayedNote[] {
    this.forget(now);
    const from = now - Math.min(seconds * 1000, this.keepMs);
    return this.notes
      .filter((n) => n.at >= from && n.at <= now)
      .map((n) => ({
        tick: n.tick,
        time: Math.round(n.at - from),
        pitch: n.pitch,
        velocity: n.velocity,
        length: n.end === null ? null : Math.round(n.end - n.at),
        port: n.port,
      }));
  }

  get size(): number {
    return this.notes.length;
  }
}
