import type { ParamDef } from './plugins.ts';

/** The built-in synthesiser's presets: always there, before any sample pack is installed. */
export const SYNTH_PRESETS = [
  'Soft Keys',
  'Electric Piano',
  'Warm Pad',
  'Glass Bells',
  'Analog Bass',
  'Sub Bass',
  'Bright Lead',
  'Pluck',
  'Strings Ensemble',
  'Fat Mono',
  'Fat Poly',
  'Ethereal Pad',
  'Ethereal Keys',
  'Drum Synth',
] as const;

export type SynthPreset = (typeof SYNTH_PRESETS)[number];

/**
 * The synths with knobs of their own (shown in the instrument's window, stored as the instrument's
 * params): each knob's range, and where each preset starts it. A few big controls each; everything
 * else is the preset's.
 */
export const SYNTH_MACROS: Record<string, ParamDef[]> = {};

const fat = (d: Record<'cutoff' | 'emphasis' | 'contour' | 'decay' | 'glide' | 'drive', number>): ParamDef[] => [
  { id: 'cutoff', name: 'Cutoff', min: 40, max: 12000, default: d.cutoff, unit: 'Hz', scale: 'log' },
  { id: 'emphasis', name: 'Emphasis', min: 0, max: 1, default: d.emphasis },
  { id: 'contour', name: 'Contour', min: 0, max: 1, default: d.contour },
  { id: 'decay', name: 'Decay', min: 0.03, max: 4, default: d.decay, unit: 's', scale: 'log' },
  { id: 'glide', name: 'Glide', min: 0, max: 1, default: d.glide, unit: 's' },
  { id: 'drive', name: 'Drive', min: 0, max: 1, default: d.drive },
];
const ethereal = (
  d: Record<'brightness' | 'bloom' | 'release' | 'motion' | 'shimmer' | 'space', number>,
): ParamDef[] => [
  { id: 'brightness', name: 'Brightness', min: 200, max: 14000, default: d.brightness, unit: 'Hz', scale: 'log' },
  { id: 'bloom', name: 'Bloom', min: 0.005, max: 6, default: d.bloom, unit: 's', scale: 'log' },
  { id: 'release', name: 'Release', min: 0.1, max: 12, default: d.release, unit: 's', scale: 'log' },
  { id: 'motion', name: 'Motion', min: 0, max: 1, default: d.motion },
  { id: 'shimmer', name: 'Shimmer', min: 0, max: 1, default: d.shimmer },
  { id: 'space', name: 'Space', min: 0, max: 1, default: d.space },
];
SYNTH_MACROS['Fat Mono'] = fat({ cutoff: 700, emphasis: 0.35, contour: 0.55, decay: 0.4, glide: 0.06, drive: 0.55 });
SYNTH_MACROS['Fat Poly'] = fat({ cutoff: 1300, emphasis: 0.2, contour: 0.4, decay: 0.9, glide: 0, drive: 0.35 });
SYNTH_MACROS['Ethereal Pad'] = ethereal({
  brightness: 1800,
  bloom: 1.4,
  release: 4.5,
  motion: 0.5,
  shimmer: 0.35,
  space: 0.5,
});
SYNTH_MACROS['Ethereal Keys'] = ethereal({
  brightness: 3200,
  bloom: 0.005,
  release: 3,
  motion: 0.3,
  shimmer: 0.45,
  space: 0.42,
});

/** What each synth with knobs is, for its window. */
export const SYNTH_NOTES: Record<string, string> = {
  'Fat Mono':
    'Three drifting oscillators driven into a transistor-ladder filter. One note at a time, the last held: play legato and it glides (Glide sets how long), let go and it falls back to the note still held.',
  'Fat Poly':
    'The same ladder synth for chords: each voice a little to one side. With Glide up, every new note slides in from the last.',
  'Ethereal Pad':
    'A wide supersaw with shimmering partials and breath, blooming open as it swells, in its own shimmering hall. Motion sways the filter and the tuning; Space is how much hall.',
  'Ethereal Keys':
    'Glowing keys: bell and octave partials over a softer supersaw, ringing into a shimmering hall. Lovely under an arpeggiator.',
};

/** A synth's knob at its value in the instrument's params (its preset's default where it has none), kept in range. */
export function macroValue(preset: string, params: Record<string, number> | undefined, id: string): number {
  const def = SYNTH_MACROS[preset]?.find((p) => p.id === id);
  if (!def) return params?.[id] ?? 0;
  const v = params?.[id] ?? def.default;
  return Math.min(def.max, Math.max(def.min, v));
}

/** Every knob of a synth at its value (the preset's defaults filled in). */
export function macroValues(preset: string, params?: Record<string, number>): Record<string, number> {
  return Object.fromEntries((SYNTH_MACROS[preset] ?? []).map((p) => [p.id, macroValue(preset, params, p.id)]));
}

/**
 * A microphone a multi-microphone instrument was recorded with (a drum kit's kick, overheads, room):
 * its zones name it, and every microphone's zone for a hit sounds together, each at its own level.
 */
export interface SampleMic {
  id: string;
  name: string;
  /** dB it starts at (0 when absent): at MIC_OFF or below it's off. */
  level?: number;
  /** Where its mono samples sit, -1 (left) to 1 (right), unless a zone says (the centre when absent). */
  pan?: number;
}

/** A microphone's knob at its lowest: off. */
export const MIC_OFF = -60;

/** The param (in a sampler instrument's params) that sets a microphone's level, in dB. */
export const micParam = (id: string): string => `mic:${id}`;

/**
 * A sampler instrument's own knobs (shown in its window, stored as its params): each microphone's
 * level where it has microphones, then Tune (semitones, every hit) and Decay (how much of each
 * hit's ring is kept). They move while it plays.
 */
export function samplerKnobs(mics: readonly SampleMic[] | undefined): ParamDef[] {
  return [
    ...(mics ?? []).map(
      (m): ParamDef => ({
        id: micParam(m.id),
        name: m.name,
        min: MIC_OFF,
        max: 12,
        default: Math.min(12, Math.max(MIC_OFF, m.level ?? 0)),
        unit: 'dB',
      }),
    ),
    { id: 'tune', name: 'Tune', min: -12, max: 12, default: 0, unit: 'st' },
    { id: 'decay', name: 'Decay', min: 5, max: 100, default: 100, unit: '%' },
  ];
}

/** A sampler knob's value in the instrument's params (its default where it has none), kept in range. */
export function samplerKnobValue(defs: readonly ParamDef[], params: Record<string, number> | undefined, id: string): number {
  const def = defs.find((p) => p.id === id);
  const v = params?.[id];
  if (!def) return v ?? 0;
  return Math.min(def.max, Math.max(def.min, v ?? def.default));
}

/** General MIDI drum notes, as drum pads usually send them. */
export const GM_DRUMS: Record<number, string> = {
  35: 'Kick 2',
  36: 'Kick',
  37: 'Side Stick',
  38: 'Snare',
  39: 'Clap',
  40: 'Snare 2',
  41: 'Low Floor Tom',
  42: 'Closed Hat',
  43: 'High Floor Tom',
  44: 'Pedal Hat',
  45: 'Low Tom',
  46: 'Open Hat',
  47: 'Low-Mid Tom',
  48: 'Hi-Mid Tom',
  49: 'Crash',
  50: 'High Tom',
  51: 'Ride',
  52: 'China',
  53: 'Ride Bell',
  54: 'Tambourine',
  55: 'Splash',
  56: 'Cowbell',
  57: 'Crash 2',
  59: 'Ride 2',
  60: 'Hi Bongo',
  61: 'Low Bongo',
  62: 'Mute Hi Conga',
  63: 'Open Hi Conga',
  64: 'Low Conga',
  69: 'Cabasa',
  70: 'Maracas',
  75: 'Claves',
  76: 'Hi Wood Block',
  77: 'Low Wood Block',
};
