import { type MeterPoint, PPQ, type TempoPoint } from './types.ts';

/** Seconds at a tick, through the tempo map. */
export function tickToSeconds(tempo: readonly TempoPoint[], tick: number): number {
  let seconds = 0;
  for (let i = 0; i < tempo.length; i++) {
    const point = tempo[i] as TempoPoint;
    const nextTick = tempo[i + 1]?.tick ?? Number.POSITIVE_INFINITY;
    if (tick <= nextTick) return seconds + ((tick - point.tick) / PPQ) * (60 / point.bpm);
    seconds += ((nextTick - point.tick) / PPQ) * (60 / point.bpm);
  }
  return (tick / PPQ) * 0.5;
}

/** The tick at a time in seconds, through the tempo map. */
export function secondsToTick(tempo: readonly TempoPoint[], seconds: number): number {
  let elapsed = 0;
  for (let i = 0; i < tempo.length; i++) {
    const point = tempo[i] as TempoPoint;
    const next = tempo[i + 1];
    const span = next ? ((next.tick - point.tick) / PPQ) * (60 / point.bpm) : Number.POSITIVE_INFINITY;
    if (seconds <= elapsed + span) return point.tick + ((seconds - elapsed) * point.bpm * PPQ) / 60;
    elapsed += span;
  }
  return 0;
}

export function bpmAt(tempo: readonly TempoPoint[], tick: number): number {
  let bpm = tempo[0]?.bpm ?? 120;
  for (const point of tempo) {
    if (point.tick > tick) break;
    bpm = point.bpm;
  }
  return bpm;
}

export function meterAt(meter: readonly MeterPoint[], tick: number): MeterPoint {
  let found = meter[0] ?? { tick: 0, num: 4, den: 4 };
  for (const point of meter) {
    if (point.tick > tick) break;
    found = point;
  }
  return found;
}

export const ticksPerBeat = (m: Pick<MeterPoint, 'den'>): number => (PPQ * 4) / m.den;
export const ticksPerBar = (m: Pick<MeterPoint, 'num' | 'den'>): number => m.num * ticksPerBeat(m);

/** The tick where a bar starts; bars count from 1, as on screen. */
export function barToTick(meter: readonly MeterPoint[], bar: number): number {
  let tick = 0;
  let barsSoFar = 1;
  for (let i = 0; i < meter.length; i++) {
    const point = meter[i] as MeterPoint;
    const next = meter[i + 1];
    const length = ticksPerBar(point);
    const barsHere = next ? Math.round((next.tick - point.tick) / length) : Number.POSITIVE_INFINITY;
    if (bar < barsSoFar + barsHere) return point.tick + (bar - barsSoFar) * length;
    barsSoFar += barsHere;
    tick = next ? next.tick : tick;
  }
  return tick;
}

export interface BarBeat {
  bar: number;
  beat: number;
  /** Sixteenth inside the beat, from 1. */
  div: number;
  /** Ticks left over inside the sixteenth. */
  tick: number;
}

/** A tick as bar, beat, sixteenth and remaining ticks, all from 1 except the ticks (as Logic shows it). */
export function tickToBarBeat(meter: readonly MeterPoint[], tick: number): BarBeat {
  let barsSoFar = 1;
  for (let i = 0; i < meter.length; i++) {
    const point = meter[i] as MeterPoint;
    const next = meter[i + 1];
    if (next && tick >= next.tick) {
      barsSoFar += Math.round((next.tick - point.tick) / ticksPerBar(point));
      continue;
    }
    const into = tick - point.tick;
    const barLength = ticksPerBar(point);
    const beatLength = ticksPerBeat(point);
    const bar = Math.floor(into / barLength);
    const inBar = into - bar * barLength;
    const beat = Math.floor(inBar / beatLength);
    const inBeat = inBar - beat * beatLength;
    const sixteenth = PPQ / 4;
    const div = Math.floor(inBeat / sixteenth);
    return {
      bar: barsSoFar + bar,
      beat: beat + 1,
      div: div + 1,
      tick: Math.floor(inBeat - div * sixteenth),
    };
  }
  return { bar: 1, beat: 1, div: 1, tick: 0 };
}

export function formatBarBeat(meter: readonly MeterPoint[], tick: number, ticks = false): string {
  const p = tickToBarBeat(meter, tick);
  const base = `${p.bar} ${p.beat} ${p.div}`;
  return ticks ? `${base} ${String(p.tick).padStart(3, ' ')}` : base;
}

/**
 * A position typed by a person or the AI: "14" (bar 14), "14.3" (its third beat), "14.3.2" (and
 * sixteenth), "14.3.2.120" (and ticks), or "t:3840" for a raw tick.
 */
export function parsePosition(meter: readonly MeterPoint[], text: string): number {
  const trimmed = text.trim();
  if (trimmed.startsWith('t:')) return Number(trimmed.slice(2));
  const parts = trimmed.split(/[.\s]+/).map(Number);
  if (parts.some((n) => !Number.isFinite(n)) || parts.length === 0) {
    throw new Error(`Not a position: "${text}" (use bar.beat.sixteenth, e.g. 14.3.1)`);
  }
  const [bar = 1, beat = 1, div = 1, tick = 0] = parts;
  const start = barToTick(meter, bar);
  const m = meterAt(meter, start);
  return start + (beat - 1) * ticksPerBeat(m) + (div - 1) * (PPQ / 4) + tick;
}

/** Note values for grids and quantizing, in ticks. */
export const DIVISIONS: Record<string, number> = {
  '1/1': PPQ * 4,
  '1/2': PPQ * 2,
  '1/4': PPQ,
  '1/8': PPQ / 2,
  '1/16': PPQ / 4,
  '1/32': PPQ / 8,
  '1/4T': (PPQ * 2) / 3,
  '1/8T': PPQ / 3,
  '1/16T': PPQ / 6,
  '1/8.': (PPQ * 3) / 4,
  '1/16.': (PPQ * 3) / 8,
};

export function quantize(tick: number, grid: number, strength = 1): number {
  const target = Math.round(tick / grid) * grid;
  return Math.round(tick + (target - tick) * strength);
}
