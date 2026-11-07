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
  'Tonewheel Jazz',
  'Tonewheel Gospel',
  'Tonewheel Rock',
  'Tonewheel Ballad',
  'Tine Piano',
  'Reed Piano',
  'Clav Keys',
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

/**
 * The tonewheel organ's drawbar settings, 16′ to 1′ (each drawbar 0 to 8), in the usual groups of two,
 * four and three. The Drawbars knob steps through them.
 */
export const ORGAN_REGISTRATIONS = [
  '88 8000 000',
  '83 8000 000',
  '80 8000 000',
  '88 8800 000',
  '68 8600 000',
  '86 8800 004',
  '88 8888 888',
  '88 8000 008',
  '00 8080 800',
  '00 6876 400',
  '80 0000 008',
];
export const ORGAN_PERCUSSION = ['Off', '2nd Fast', '3rd Fast', '2nd Slow', '3rd Slow'];
export const ORGAN_VIBRATO = ['Off', 'V1', 'V2', 'V3', 'C1', 'C2', 'C3'];
export const ORGAN_ROTOR = ['Off', 'Slow', 'Fast'];

const organ = (d: Record<'drawbars' | 'percussion' | 'click' | 'vibrato' | 'rotor' | 'drive', number>): ParamDef[] => [
  {
    id: 'drawbars',
    name: 'Drawbars',
    min: 0,
    max: ORGAN_REGISTRATIONS.length - 1,
    default: d.drawbars,
    step: 1,
    options: ORGAN_REGISTRATIONS,
  },
  {
    id: 'percussion',
    name: 'Percussion',
    min: 0,
    max: ORGAN_PERCUSSION.length - 1,
    default: d.percussion,
    step: 1,
    options: ORGAN_PERCUSSION,
  },
  { id: 'click', name: 'Click', min: 0, max: 1, default: d.click },
  {
    id: 'vibrato',
    name: 'Vibrato',
    min: 0,
    max: ORGAN_VIBRATO.length - 1,
    default: d.vibrato,
    step: 1,
    options: ORGAN_VIBRATO,
  },
  { id: 'rotor', name: 'Rotor', min: 0, max: ORGAN_ROTOR.length - 1, default: d.rotor, step: 1, options: ORGAN_ROTOR },
  { id: 'drive', name: 'Drive', min: 0, max: 1, default: d.drive },
];
SYNTH_MACROS['Tonewheel Jazz'] = organ({ drawbars: 1, percussion: 2, click: 0.6, vibrato: 6, rotor: 1, drive: 0.15 });
SYNTH_MACROS['Tonewheel Gospel'] = organ({ drawbars: 3, percussion: 0, click: 0.5, vibrato: 6, rotor: 1, drive: 0.35 });
SYNTH_MACROS['Tonewheel Rock'] = organ({ drawbars: 0, percussion: 0, click: 0.7, vibrato: 0, rotor: 1, drive: 0.7 });
SYNTH_MACROS['Tonewheel Ballad'] = organ({ drawbars: 5, percussion: 0, click: 0.3, vibrato: 5, rotor: 1, drive: 0.05 });

const keys = (d: Record<'tone' | 'bark' | 'decay' | 'tremolo' | 'pickup' | 'stereo', number>): ParamDef[] => [
  { id: 'tone', name: 'Tone', min: 0, max: 1, default: d.tone },
  { id: 'bark', name: 'Bark', min: 0, max: 1, default: d.bark },
  { id: 'decay', name: 'Decay', min: 0.2, max: 2, default: d.decay, unit: '×' },
  { id: 'tremolo', name: 'Tremolo', min: 0, max: 1, default: d.tremolo },
  { id: 'pickup', name: 'Pickup', min: 0, max: 1, default: d.pickup },
  { id: 'stereo', name: 'Stereo', min: 0, max: 1, default: d.stereo },
];
SYNTH_MACROS['Tine Piano'] = keys({ tone: 0.55, bark: 0.35, decay: 1, tremolo: 0.3, pickup: 0.45, stereo: 0.4 });
SYNTH_MACROS['Reed Piano'] = keys({ tone: 0.6, bark: 0.4, decay: 1, tremolo: 0.25, pickup: 0.5, stereo: 0.2 });
SYNTH_MACROS['Clav Keys'] = keys({ tone: 0.75, bark: 0.3, decay: 1, tremolo: 0, pickup: 0.6, stereo: 0 });

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
  'Tonewheel Jazz':
    'A drawbar organ through its rotating speaker, set for jazz: mellow drawbars, a crisp third-harmonic percussion that strikes only on detached notes, and the scanner chorus. The mod wheel switches the rotor between slow and fast.',
  'Tonewheel Gospel':
    'The drawbar organ fuller and pushed harder, with the scanner chorus: made for swelling chords and fast-rotor climaxes (mod wheel up).',
  'Tonewheel Rock':
    'The drawbar organ with the first three drawbars out and the preamp overdriven: growling chords and stabs. Drive is how hard it breaks up.',
  'Tonewheel Ballad':
    'A soft drawbar organ with a gentle chorus and a whisper of the top drawbar, for sustained chords under a ballad.',
  'Tine Piano':
    'A struck tine and tone bar read by a magnetic pickup: round and bell-like played softly, barking when hit hard (Bark is how much). Pickup moves it from mellow to hollow; Tremolo pans it between the sides.',
  'Reed Piano':
    'A struck steel reed read by an electrostatic pickup: sweet when soft, snarling when hard. Its tremolo swells the level, as the originals did.',
  'Clav Keys':
    'A string pinned by a hammer and read by pickups along it: bright, percussive and funky, with a yarn-damper thump when you let go. Pickup slides from the round neck sound to the thin bridge one.',
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
