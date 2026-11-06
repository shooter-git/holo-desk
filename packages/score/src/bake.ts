/**
 * How a score's markings sound, written into the notes themselves: dynamics and hairpins become
 * velocities, articulations become lengths and accents, fermatas and rit./accel. become tempo steps.
 * Because it's plain note data, every engine plays it (older ones too), and the Piano Roll shows it.
 * A note keeps the velocity the dynamics gave it (`n.dv`), so changing a dynamic later moves only the
 * notes nobody has shaped by hand.
 */
import type { Mark, Project, TempoPoint, Track } from '@holo/session';

/** Velocities of the dynamics. */
export const DYNAMICS: Record<string, number> = {
  pppp: 14,
  ppp: 22,
  pp: 34,
  p: 48,
  mp: 62,
  mf: 78,
  f: 94,
  ff: 108,
  fff: 120,
  ffff: 127,
};

/** Sudden accents: [this note's velocity, the level after it] (fp: loud, then soft). */
export const ACCENTS: Record<string, [number, string | null]> = {
  sf: [104, null],
  sfz: [110, null],
  sffz: [120, null],
  fz: [104, null],
  rfz: [100, null],
  fp: [100, 'p'],
  sfp: [108, 'p'],
};

export const isDynamic = (s: string): boolean => s in DYNAMICS || s in ACCENTS;

/** How much of its written length a note sounds. */
export function gateFor(artic: readonly string[], slurred: boolean): number {
  if (artic.includes('staccis')) return 0.25;
  if (artic.includes('stacc')) return 0.5;
  if (artic.includes('marc')) return 0.75;
  if (artic.includes('ten') || slurred) return 1;
  return 0.92;
}

/** A note's velocity from the level of the dynamics and its own accents. */
export function velocityFor(level: number, artic: readonly string[]): number {
  let v = level;
  if (artic.includes('acc')) v += 14;
  if (artic.includes('marc')) v += 20;
  if (artic.includes('ten')) v += 4;
  return Math.max(1, Math.min(127, Math.round(v)));
}

/** A staff's markings on the timeline (region marks moved to song ticks). */
export function staffMarks(track: Track, staff: number): Mark[] {
  const out: Mark[] = [];
  for (const r of track.regions) {
    for (const m of r.marks ?? []) {
      if ((m.st ?? 1) !== staff) continue;
      out.push({ ...m, t: r.start + m.t, ...(m.e !== undefined ? { e: r.start + m.e } : {}) });
    }
  }
  return out.sort((a, b) => a.t - b.t);
}

/**
 * The level of the dynamics at a tick on a staff: the last dynamic before it (mf when none), along
 * a hairpin from where it starts to the dynamic it reaches (or a step louder or softer). A sudden
 * accent (sfz) is that note's alone; fp is loud on its note, then soft.
 */
export function levelAt(marks: readonly Mark[], tick: number): number {
  let level = DYNAMICS.mf as number;
  let accent: number | null = null;
  for (const m of marks) {
    if (m.t > tick) break;
    if (m.k !== 'dyn') continue;
    const name = String(m.v ?? '');
    if (name in DYNAMICS) level = DYNAMICS[name] as number;
    else if (name in ACCENTS) {
      const [now, after] = ACCENTS[name] as [number, string | null];
      if (m.t === tick) accent = now;
      if (after) level = DYNAMICS[after] as number;
    }
  }
  if (accent !== null) return accent;
  const pin = [...marks]
    .reverse()
    .find((m) => (m.k === 'cresc' || m.k === 'dim') && m.t <= tick && (m.e ?? m.t) > tick);
  if (pin) {
    const from = levelAt(
      marks.filter((m) => m !== pin),
      pin.t,
    );
    const target = marks.find((m) => m.k === 'dyn' && m.t >= (pin.e ?? pin.t) && String(m.v) in DYNAMICS);
    const to = target ? (DYNAMICS[String(target.v)] as number) : from + (pin.k === 'cresc' ? 16 : -16);
    const span = Math.max(1, (pin.e ?? pin.t) - pin.t);
    return from + ((to - from) * (tick - pin.t)) / span;
  }
  return level;
}

/** Whether a tick falls under a slur on a staff (its last note excepted: it lets go). */
export function slurredAt(marks: readonly Mark[], tick: number): boolean {
  return marks.some((m) => m.k === 'slur' && m.t <= tick && (m.e ?? m.t) > tick);
}

const RAMP = /rit|rall|allarg|accel|stringendo/i;

/**
 * The song's tempo with what the score adds: a rit. or accel. eases to where it's going, beat by
 * beat; a fermata holds its note about twice as long. Points the score made before (`gen`) are made
 * afresh; the written ones stay as they are.
 */
export function bakeTempo(project: Project): TempoPoint[] {
  const written = project.tempo.filter((p) => !p.gen);
  const out: TempoPoint[] = [...written];
  const beat = 960;
  written.forEach((p, i) => {
    const next = written[i + 1];
    const end = p.ramp ?? (p.text && RAMP.test(p.text) ? next?.tick : undefined);
    if (end === undefined || end <= p.tick) return;
    const slower = /accel|stringendo/i.test(p.text ?? '') ? 1.25 : 0.75;
    const to = p.to ?? (p.ramp ? p.bpm : p.bpm * slower);
    const steps = Math.max(1, Math.round((end - p.tick) / beat));
    for (let k = 1; k < steps; k++) {
      const bpm = p.bpm + ((to - p.bpm) * k) / steps;
      out.push({ tick: p.tick + k * beat, bpm: Math.round(bpm * 100) / 100, gen: true });
    }
    // after the ramp, back to the next written tempo (or held at the end of the ramp)
    if (!next || next.tick > end) out.push({ tick: end, bpm: Math.round(to * 100) / 100, gen: true });
  });
  // fermatas, once per tick across the song's tracks
  const holds = new Map<number, number>();
  for (const t of project.tracks) {
    for (const r of t.regions) {
      if (r.muted) continue;
      for (const n of r.notes) {
        if (!n.n?.a?.includes('ferm')) continue;
        const at = r.start + n.t;
        holds.set(at, Math.max(holds.get(at) ?? 0, n.n.w?.[0] ?? n.d));
      }
    }
  }
  const held = new Set<number>();
  for (const [at, len] of holds) {
    const bpm = bpmAtList(out, at);
    out.push({ tick: at, bpm: Math.round((bpm / 2) * 100) / 100, gen: true });
    held.add(at);
    if (!out.some((p) => p.tick === at + len)) out.push({ tick: at + len, bpm, gen: true });
  }
  // one point per tick: a fermata's hold first, then a written point, then one the score made
  const rank = (p: TempoPoint) => (p.gen && held.has(p.tick) && p.bpm < bpmAtList(written, p.tick) ? 0 : p.gen ? 2 : 1);
  out.sort((a, b) => a.tick - b.tick || rank(a) - rank(b));
  const seen = new Set<number>();
  return out.filter((p) => {
    if (seen.has(p.tick)) return false;
    seen.add(p.tick);
    return true;
  });
}

function bpmAtList(points: readonly TempoPoint[], tick: number): number {
  let bpm = points[0]?.bpm ?? 120;
  for (const p of [...points].sort((a, b) => a.tick - b.tick)) {
    if (p.tick > tick) break;
    bpm = p.bpm;
  }
  return bpm;
}
