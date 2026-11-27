/**
 * What exporting a song's stems would make, worked out before the host is asked: the files, how
 * long each is and how big the ZIP, and why they wouldn't add up to the mix (the Stems dialog
 * shows it; the agent's offer and the terminal say the same from the same functions).
 */
import { type Stem, type StemsBy, stemSongs, stemWarnings } from '@holo/agent/edits';
import { type Project, projectEnd, tickToBarBeat, tickToSeconds } from '@holo/session';

export interface StemsPlan {
  stems: Stem[];
  /** The tracks of the song that get no stem: muted, off, or with nothing to play. */
  left: number;
  warnings: string[];
  /** The stretch they cover, in ticks, and each file's length with its tail. */
  from: number;
  to: number;
  seconds: number;
  /** About how big the ZIP is. */
  bytes: number;
  /** The cycle's bars, when it has a length: "bars 5–8" (null: only the whole song can be exported). */
  cycle: string | null;
  /** Whether it's the cycle these are of. */
  ofCycle: boolean;
  /** Whether the song has stacks: then the stems can be of them, their tracks together. */
  stacks: boolean;
}

/** The cycle's bars in words: "bar 5", "bars 5–8". */
function cycleBars(project: Project): string | null {
  const { start, end } = project.cycle;
  if (!(end > start)) return null;
  const first = tickToBarBeat(project.meter, start).bar;
  // (a cycle that ends on a bar line ends with the bar before it)
  const last = Math.max(first, tickToBarBeat(project.meter, Math.max(start, end - 1)).bar);
  return first === last ? `bar ${first}` : `bars ${first}–${last}`;
}

export function stemsPlan(project: Project, range: 'cycle' | 'song', tail: number, by: StemsBy = 'tracks'): StemsPlan {
  const cycle = cycleBars(project);
  const ofCycle = range === 'cycle' && cycle !== null;
  const from = ofCycle ? project.cycle.start : 0;
  const to = ofCycle ? project.cycle.end : projectEnd(project);
  const stems = stemSongs(project, by);
  const seconds = Math.max(0, tickToSeconds(project.tempo, to) - tickToSeconds(project.tempo, from)) + tail;
  // 24 bits, two channels, and a WAV's header and a ZIP's two records for each
  const each = Math.round(seconds * (project.sampleRate ?? 48000)) * 6 + 44 + 120;
  return {
    stems,
    left: project.tracks.length - new Set(stems.flatMap((s) => s.tracks)).size,
    warnings: stemWarnings(project, by),
    from,
    to,
    seconds,
    bytes: stems.length * each,
    cycle,
    ofCycle,
    stacks: (project.stacks?.length ?? 0) > 0,
  };
}
