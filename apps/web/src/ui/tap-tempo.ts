/** Tap tempo: the tempo of taps in time, from the gaps between them. */

/** A pause longer than this (30 bpm) and the next tap starts over. */
const RESET_MS = 2000;
/** Taps closer than this (300 bpm) are a double-click or a bounce, not a beat. */
const FASTEST_MS = 200;
/** A gap this far from the beat so far is a new tempo: the taps before it no longer count. */
const CHANGE = 0.3;
/** Taps before there's a tempo: two gaps that agree, so one stray click sets nothing. */
const FIRST = 3;
/** How many taps the tempo is measured over: enough to even out a hand, few enough to follow it. */
const KEEP = 8;

export interface TapTempo {
  /** A tap at `ms`: the tempo the taps so far make (whole beats per minute), or null while there's none yet. */
  tap(ms: number): number | null;
  reset(): void;
}

export function tapTempo(): TapTempo {
  let taps: number[] = [];
  const beat = () => ((taps[taps.length - 1] as number) - (taps[0] as number)) / (taps.length - 1);
  return {
    tap(ms) {
      const prev = taps[taps.length - 1];
      if (prev !== undefined) {
        const gap = ms - prev;
        if (gap >= 0 && gap < FASTEST_MS) return null;
        if (gap < 0 || gap > RESET_MS) taps = [];
        else if (taps.length > 1 && Math.abs(gap - beat()) > beat() * CHANGE) taps = [prev];
      }
      taps.push(ms);
      if (taps.length > KEEP) taps.shift();
      return taps.length >= FIRST ? Math.round(60000 / beat()) : null;
    },
    reset() {
      taps = [];
    },
  };
}
