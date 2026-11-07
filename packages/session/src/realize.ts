/**
 * Ornaments as they sound. A trill, a mordent, a turn, a tremolo or an arpeggiated chord is written as
 * one note with the ornament in its hints (`n.a`), and played here as the notes it stands for: only
 * playback sees them, the song keeps the one written note.
 */
import { keyAt } from './keysig.ts';
import { bpmAt } from './time.ts';
import { type KeyPoint, type Note, PPQ, type TempoPoint } from './types.ts';

const ORNAMENTS = new Set(['tr', 'mord', 'pmord', 'turn', 'trem1', 'trem2', 'trem3', 'trem4', 'arp']);

/** Whether any of the notes has an ornament that plays as more than itself. */
export const hasOrnaments = (notes: readonly Note[]): boolean =>
  notes.some((n) => n.n?.a?.some((a) => ORNAMENTS.has(a)));

/** The pitch classes of a key signature's scale (C major's where there's none). */
function scale(fifths: number): Set<number> {
  const out = new Set<number>();
  for (let i = -1; i < 6; i++) out.add(((((i + fifths) * 7) % 12) + 12) % 12);
  return out;
}

/** The next note of the scale above (`dir` 1) or below (−1) a pitch. */
function neighbour(p: number, dir: 1 | -1, notes: Set<number>): number {
  const from = Math.round(p);
  for (let q = from + dir; Math.abs(q - from) <= 2; q += dir)
    if (notes.has(((q % 12) + 12) % 12)) return q + (p - from);
  return p + dir;
}

export interface RealizeContext {
  /** Where the notes' times count from, on the song's timeline (the region's start). */
  start: number;
  tempo: readonly TempoPoint[];
  keys: readonly KeyPoint[];
}

/** Ticks that last `seconds` at the tempo at a tick. */
const ticksFor = (seconds: number, tempo: readonly TempoPoint[], tick: number) =>
  Math.max(10, Math.round((seconds * bpmAt(tempo, tick) * PPQ) / 60));

/** Notes with their ornaments played out: the rest as they are (the same objects). */
export function realize(notes: readonly Note[], ctx: RealizeContext): Note[] {
  if (!hasOrnaments(notes)) return notes as Note[];
  const out: Note[] = [];
  // an arpeggiated chord: its notes (those marked, starting together) rolled from the lowest up
  const rolled = new Map<Note, number>();
  const chords = new Map<number, Note[]>();
  for (const n of notes) if (n.n?.a?.includes('arp')) chords.set(n.t, [...(chords.get(n.t) ?? []), n]);
  for (const [t, chord] of chords) {
    chord.sort((a, b) => a.p - b.p);
    const shortest = Math.min(...chord.map((n) => n.d));
    const step = Math.min(ticksFor(0.035, ctx.tempo, ctx.start + t), Math.floor(shortest / 2 / chord.length));
    chord.forEach((n, i) => {
      rolled.set(n, i * step);
    });
  }
  const sound = (n: Note, t: number, d: number, p: number, v: number): Note => ({
    t,
    d: Math.max(1, d),
    p,
    v: Math.max(1, Math.min(127, Math.round(v))),
    ...(n.art ? { art: n.art } : {}),
  });
  for (const n of notes) {
    const a = n.n?.a;
    if (!a?.some((x) => ORNAMENTS.has(x))) {
      out.push(n);
      continue;
    }
    const late = rolled.get(n) ?? 0;
    const t = n.t + late;
    const d = n.d - late;
    const at = ctx.start + n.t;
    const key = scale(keyAt(ctx.keys, at)?.fifths ?? 0);
    const trem = a.find((x) => x.startsWith('trem'));
    if (trem) {
      // a tremolo: the note again and again, in eighths for one stroke, sixteenths for two…
      const step = Math.max(30, PPQ / 2 ** Number(trem.slice(4)));
      for (let s = 0; s < d; s += step) out.push(sound(n, t + s, Math.min(step, d - s), n.p, s ? n.v - 4 : n.v));
      continue;
    }
    if (a.includes('tr')) {
      // a trill: the note and the one above, quickly (about 13 a second), ending on the note
      const step = ticksFor(1 / 13, ctx.tempo, at);
      let count = Math.floor(d / step);
      if (count % 2 === 0) count -= 1;
      if (count >= 3) {
        const upper = neighbour(n.p, 1, key);
        for (let i = 0; i < count; i++) {
          const last = i === count - 1;
          out.push(sound(n, t + i * step, last ? d - i * step : step, i % 2 ? upper : n.p, i ? n.v - 6 : n.v));
        }
        continue;
      }
    }
    if (a.includes('turn')) {
      // a turn: above, the note, below, the note (held)
      const step = Math.min(ticksFor(0.09, ctx.tempo, at), Math.floor(d / 5));
      const seq = [neighbour(n.p, 1, key), n.p, neighbour(n.p, -1, key)];
      seq.forEach((p, i) => {
        out.push(sound(n, t + i * step, step, p, i ? n.v - 6 : n.v));
      });
      out.push(sound(n, t + 3 * step, d - 3 * step, n.p, n.v - 6));
      continue;
    }
    if (a.includes('mord') || a.includes('pmord') || a.includes('tr')) {
      // a mordent: the note, the one below (above, for an upper mordent or a short trill), the note
      const step = Math.min(ticksFor(0.07, ctx.tempo, at), Math.floor(d / 4));
      const other = neighbour(n.p, a.includes('mord') ? -1 : 1, key);
      out.push(sound(n, t, step, n.p, n.v));
      out.push(sound(n, t + step, step, other, n.v - 6));
      out.push(sound(n, t + 2 * step, d - 2 * step, n.p, n.v - 6));
      continue;
    }
    out.push(late ? { ...n, t, d } : n);
  }
  return out.sort((x, y) => x.t - y.t || x.p - y.p);
}
