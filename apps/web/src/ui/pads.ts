/**
 * What the drum pads play, and what they're called: the pads follow the instrument the notes reach,
 * so every pad's name is what sounds when it's hit. A kit names its own pieces; the Drum Synth (or a
 * track with nothing on it yet) has the General MIDI drum map; a single sound is one pad; anything
 * played by pitch has its notes, chromatically, the lowest at the bottom left.
 */

import {
  DRUM_PRESETS,
  GM_DRUMS,
  type Instrument,
  type MiddleC,
  noteName,
  type Project,
  type Track,
} from '@holo/session';
import type { InstrumentMap } from '../audio/pack-files.ts';

export interface Pad {
  note: number;
  name: string;
}

export interface PadGrid {
  pads: Pad[];
  /** Pads a row (the grid's columns). */
  cols: number;
  /** Notes played by pitch: the pads follow the octave. */
  chromatic: boolean;
}

/** General MIDI's drums, in rows of four (the top row first): cymbals and hats, toms, the snare and kick, hand percussion. */
export const GM_PADS = [49, 51, 46, 42, 50, 47, 45, 43, 39, 37, 38, 36, 56, 54, 70, 75];

/** The most a single-sound instrument's distinct samples get (one pad each). */
const MAX_SOUNDS = 32;

/**
 * The track the pads' notes reach, as live MIDI is routed: the first armed track that listens to
 * the port and channel, else the selected track if it does.
 */
export function padTrack(
  project: Project | null,
  selected: string | null,
  port: string,
  channel: number,
): Track | null {
  if (!project) return null;
  const hears = (t: Track) =>
    t.kind === 'instrument' &&
    (t.input.port === '*' || t.input.port === port) &&
    (t.input.channel === 0 || t.input.channel === channel);
  const armed = project.tracks.find((t) => t.armed && hears(t));
  if (armed) return armed;
  const s = project.tracks.find((t) => t.id === selected);
  return s && hears(s) ? s : null;
}

/**
 * Whether an instrument plays each key as a sound of its own (a kit, the Drum Synth, a single
 * hit), not as a pitch: a MIDI effect that moves or adds notes then plays other drums.
 */
export function playsHits(instrument: Instrument | null | undefined, manifest: InstrumentMap | null): boolean {
  if (instrument?.type === 'synth') return DRUM_PRESETS.includes(instrument.preset);
  if (!padManifestKey(instrument) || !manifest) return false;
  return Boolean(manifest.pads?.length) || manifest.pitched === false;
}

/** The MIDI effects that change which notes play (not just how hard). */
export const NOTE_EFFECTS = new Set(['arpeggiator', 'harmonizer', 'scale']);

/** Whether pads for this instrument need its pack's map (and which). */
export function padManifestKey(instrument: Instrument | null | undefined): string | null {
  if (instrument?.type === 'sampler' || instrument?.type === 'performance')
    return `${instrument.pack}/${instrument.name}`;
  return null;
}

/**
 * The pads for an instrument: `manifest` is its pack's map (null while it loads, or for a synth),
 * `wide` lays them out in rows of eight instead of four, `octave` places chromatic pads.
 */
export function padsFor(
  instrument: Instrument | null | undefined,
  manifest: InstrumentMap | null,
  opts: { wide: boolean; octave: number; middleC: MiddleC },
): PadGrid {
  const cols = opts.wide ? 8 : 4;
  const gm: PadGrid = {
    pads: GM_PADS.map((n) => ({ note: n, name: GM_DRUMS[n] ?? noteName(n, opts.middleC) })),
    cols,
    chromatic: false,
  };
  if (!instrument || instrument.type === 'none') return gm;
  if (instrument.type === 'synth' && DRUM_PRESETS.includes(instrument.preset)) return gm;
  if (padManifestKey(instrument)) {
    // until the map comes, the pads it had: a kit's names the moment it's there
    if (!manifest) return gm;
    if (manifest.pads?.length) {
      const pads = manifest.pads.map((p) => ({ note: p.key, name: p.name }));
      return { pads, cols: Math.min(cols, pads.length), chromatic: false };
    }
    if (manifest.pitched === false) return sounds(manifest, cols, opts.middleC);
  }
  return chromatic(cols, opts.octave);

  function chromatic(n: number, octave: number): PadGrid {
    // n a row, four rows (sixteen pads; two rows of eight when wide): the lowest at the bottom left
    const rows = 16 / n;
    const low = Math.max(0, Math.min(127 - 15, (octave + 1) * 12));
    const pads: Pad[] = [];
    for (let r = rows - 1; r >= 0; r--)
      for (let c = 0; c < n; c++) {
        const note = low + r * n + c;
        pads.push({ note, name: noteName(note, opts.middleC) });
      }
    return { pads, cols: n, chromatic: true };
  }
}

/**
 * An unpitched instrument without named pads: a pad for each distinct sound it has (the keys that
 * play the same samples), named by the instrument when it has only the one.
 */
function sounds(manifest: InstrumentMap, cols: number, middleC: MiddleC): PadGrid {
  const ranges = new Map<string, { lo: number; hi: number }>();
  for (const z of manifest.zones) {
    if (z.trigger) continue;
    const lo = Math.max(0, z.lo);
    const hi = Math.min(127, z.hi);
    if (hi >= lo) ranges.set(`${lo}:${hi}`, { lo, hi });
  }
  const list = [...ranges.values()].sort((a, b) => a.lo - b.lo || a.hi - b.hi).slice(0, MAX_SOUNDS);
  const title = manifest.title ?? manifest.name;
  if (list.length <= 1) {
    const r = list[0] ?? { lo: 0, hi: 127 };
    // one sound on every key: middle C, which any kit or keyboard reads as a plain note
    return { pads: [{ note: Math.max(r.lo, Math.min(r.hi, 60)), name: title }], cols: 1, chromatic: false };
  }
  const pads = list.map((r) => ({ note: r.lo, name: noteName(r.lo, middleC) }));
  return { pads, cols: Math.min(cols, pads.length), chromatic: false };
}
