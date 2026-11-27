/**
 * The song's sections: the stretch from each marker to the next. The Arrangement lane draws them
 * and drags them, and the agent's `timeline` takes them by name; both read them here, so "the
 * Bridge" is the same bars in the lane and in a request.
 *
 * Nothing is stored for a section: a marker starts one, the next marker (or the song's end) ends it.
 * What comes before the first marker is a section too, with no name.
 */
import { type Marker, type MeterPoint, meterAt, onBarLine, type Project, projectEnd, ticksPerBar } from '@holo/session';

export interface Section {
  /** Its marker's id; `start` for what comes before the first marker. */
  id: string;
  /** Its marker's name ('' before the first marker). */
  name: string;
  from: number;
  to: number;
  /** The marker that starts it (null before the first). */
  marker: Marker | null;
  /** Whether it starts and ends on bar lines: only then can its bars be moved, copied or deleted. */
  whole: boolean;
}

/** The bar line at or after a tick. */
function barLineFrom(meter: readonly MeterPoint[], tick: number): number {
  const m = meterAt(meter, tick);
  const bar = ticksPerBar(m);
  return m.tick + Math.ceil((tick - m.tick) / bar) * bar;
}

/** Where the last section ends: the end of the song's music, on a bar line, a bar at least past its last marker. */
export function songEnd(project: Pick<Project, 'tracks' | 'markers' | 'meter'>): number {
  const last = Math.max(0, ...project.markers.map((m) => m.tick));
  const end = Math.max(projectEnd(project as Project), last + 1);
  return barLineFrom(project.meter, end);
}

/** The sections, in order (none for a song with no markers). */
export function sections(project: Pick<Project, 'tracks' | 'markers' | 'meter'>): Section[] {
  const marks = [...project.markers].sort((a, b) => a.tick - b.tick);
  if (!marks.length) return [];
  const end = songEnd(project);
  const whole = (from: number, to: number) => onBarLine(project.meter, from) && onBarLine(project.meter, to);
  const out: Section[] = [];
  const first = marks[0] as Marker;
  if (first.tick > 0)
    out.push({ id: 'start', name: '', from: 0, to: first.tick, marker: null, whole: whole(0, first.tick) });
  marks.forEach((m, i) => {
    const to = marks[i + 1]?.tick ?? end;
    // (two markers at one place: the later one's section is the one that has bars)
    if (to <= m.tick) return;
    out.push({ id: m.id, name: m.name, from: m.tick, to, marker: m, whole: whole(m.tick, to) });
  });
  return out;
}

/**
 * The sections a name means: every one with that name, whatever its case; "Theme 2" (or "Theme #2")
 * the second of the sections named Theme, when no section has that whole name itself.
 */
export function sectionsNamed(list: readonly Section[], text: string): Section[] {
  const want = text.trim().toLowerCase();
  if (!want) return [];
  const exact = list.filter((s) => s.name.trim().toLowerCase() === want);
  if (exact.length) return exact;
  const nth = /^(.*?)\s*#?\s*(\d+)$/.exec(want);
  if (!nth) return [];
  const same = list.filter((s) => s.name.trim().toLowerCase() === (nth[1] as string).trim());
  const one = same[Number(nth[2]) - 1];
  return one ? [one] : [];
}
