/**
 * Notes and the song's key: which notes are in it, where a note outside it goes, and how a note
 * moves by its steps. The Piano Roll's shading, Snap to key and Move into key, and the agent's
 * `regions into_key`, all come here.
 *
 * The key is the song's own, with its changes (`keys`): each note is read against the key in force
 * where it starts. A song with no key has no notes outside it, and nothing here moves one.
 */
import { keysOf, type Note, type Project, type Region, type Scale, scaleAt } from '@holo/session';

const mod12 = (n: number): number => ((Math.round(n) % 12) + 12) % 12;

/** Whether a pitch is one of the scale's (every pitch is, with no scale). */
export function inKey(scale: Scale | null, pitch: number): boolean {
  return !scale || scale.steps.includes(mod12(pitch - scale.tonic));
}

/**
 * The scale's pitch nearest a pitch: itself when it's in the scale, else the nearer neighbour, the
 * lower when it sits between two (as the Scale Quantizer effect goes).
 */
export function intoKey(scale: Scale | null, pitch: number): number {
  const p = Math.max(0, Math.min(127, Math.round(pitch)));
  if (!scale) return p;
  for (let d = 0; d < 12; d++) {
    if (p - d >= 0 && inKey(scale, p - d)) return p - d;
    if (p + d <= 127 && inKey(scale, p + d)) return p + d;
  }
  return p;
}

/**
 * A pitch moved by steps of the scale (up when positive): from a pitch outside it, the first step
 * is onto the scale. It stops at the ends of the keyboard. With no scale, a step is a semitone.
 */
export function stepInKey(scale: Scale | null, pitch: number, steps: number): number {
  let p = Math.max(0, Math.min(127, Math.round(pitch)));
  if (!scale) return Math.max(0, Math.min(127, p + Math.round(steps)));
  const way = Math.sign(steps);
  for (let left = Math.abs(Math.round(steps)); left > 0; ) {
    const next = p + way;
    if (next < 0 || next > 127) break;
    p = next;
    if (inKey(scale, p)) left--;
  }
  // (a pitch outside the scale that couldn't reach it, at an end of the keyboard, stays where it got to)
  return p;
}

/** A stretch of the song in one key. */
export interface KeySpan {
  from: number;
  to: number;
  scale: Scale;
}

/** The song's keys over [from, to): a span for each key in force there, none where there's no key. */
export function keySpans(project: Pick<Project, 'key' | 'keys'>, from: number, to: number): KeySpan[] {
  const cuts = [
    from,
    ...keysOf(project)
      .map((k) => k.tick)
      .filter((t) => t > from && t < to),
    to,
  ];
  const out: KeySpan[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i] as number;
    const b = cuts[i + 1] as number;
    const scale = scaleAt(project, Math.max(0, a));
    if (!scale || b <= a) continue;
    const last = out[out.length - 1];
    // (two points with the same key, or the text and its first point: one span)
    if (last && last.to === a && last.scale.name === scale.name) last.to = b;
    else out.push({ from: a, to: b, scale });
  }
  return out;
}

/** A region's notes that are outside the key in force where they start. */
export function outsideKey(project: Pick<Project, 'key' | 'keys'>, region: Region): Note[] {
  return region.notes.filter((n) => !inKey(scaleAt(project, Math.max(0, region.start + n.t)), n.p));
}

/**
 * A region's notes with those outside the key moved onto it (`only`: just these of them). Null
 * when none moves: every note is in the key already, or the song has none.
 */
export function notesIntoKey(
  project: Pick<Project, 'key' | 'keys'>,
  region: Region,
  only?: ReadonlySet<Note>,
): { notes: Note[]; moved: number } | null {
  let moved = 0;
  const notes = region.notes.map((n) => {
    if (only && !only.has(n)) return n;
    const p = intoKey(scaleAt(project, Math.max(0, region.start + n.t)), n.p);
    if (p === n.p) return n;
    moved++;
    return { ...n, p };
  });
  return moved ? { notes, moved } : null;
}
