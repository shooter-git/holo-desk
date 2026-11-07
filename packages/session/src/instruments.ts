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
  'FM Keys',
  'FM Bells',
  'FM Bass',
  'FM Brass',
  'FM Pluck',
  'FM Pad',
  'Morph Pad',
  'Morph Lead',
  'Morph Pluck',
  'Morph Bass',
  'Morph Choir',
  'Drone Field',
  'Drone Metal',
  'Drone Breath',
  'Drone Glass',
  'Shakuhachi',
  'Bansuri',
  'Dizi',
  'Celtic Pipes',
  'Koto',
  'Guzheng',
  'Gayageum',
  'Shamisen',
  'Pipa',
  'Sitar',
  'Tanpura',
  'Harmonium',
  'Sheng',
  'Glass Harmonica',
  'Choir Ahh',
  'Male Choir',
  'Taiko',
  'War Drums',
  'Frame Drum',
  'Opera Gongs',
  'Anvil',
  'Drum Synth',
  'Analog Machine',
  'Punch Machine',
  'Lo-fi Machine',
  'Hand Machine',
] as const;

export type SynthPreset = (typeof SYNTH_PRESETS)[number];

/**
 * The built-in synths in families, as the Library and the instrument menu show them. Every preset is
 * in exactly one.
 */
export const SYNTH_FAMILIES: { name: string; presets: readonly string[] }[] = [
  {
    name: 'Keys',
    presets: ['Soft Keys', 'Electric Piano', 'Tine Piano', 'Reed Piano', 'Clav Keys', 'FM Keys', 'Ethereal Keys'],
  },
  {
    name: 'Organs and reeds',
    presets: ['Tonewheel Jazz', 'Tonewheel Gospel', 'Tonewheel Rock', 'Tonewheel Ballad', 'Harmonium', 'Sheng'],
  },
  {
    name: 'Synths',
    presets: [
      'Fat Mono',
      'Fat Poly',
      'Analog Bass',
      'Sub Bass',
      'Bright Lead',
      'Pluck',
      'Warm Pad',
      'Strings Ensemble',
      'FM Bass',
      'FM Brass',
      'FM Pluck',
      'FM Pad',
      'Morph Pad',
      'Morph Lead',
      'Morph Pluck',
      'Morph Bass',
    ],
  },
  { name: 'Bells and glass', presets: ['Glass Bells', 'FM Bells', 'Glass Harmonica'] },
  { name: 'Textures', presets: ['Ethereal Pad', 'Drone Field', 'Drone Metal', 'Drone Breath', 'Drone Glass'] },
  { name: 'Voices', presets: ['Choir Ahh', 'Male Choir', 'Morph Choir'] },
  {
    name: 'World',
    presets: [
      'Shakuhachi',
      'Bansuri',
      'Dizi',
      'Celtic Pipes',
      'Koto',
      'Guzheng',
      'Gayageum',
      'Shamisen',
      'Pipa',
      'Sitar',
      'Tanpura',
    ],
  },
  {
    name: 'Drums and percussion',
    presets: [
      'Drum Synth',
      'Analog Machine',
      'Punch Machine',
      'Lo-fi Machine',
      'Hand Machine',
      'Taiko',
      'War Drums',
      'Frame Drum',
      'Opera Gongs',
      'Anvil',
    ],
  },
];

/** The synths that are drum kits: each key a sound of its own, laid out on the General MIDI drum keys. */
export const DRUM_PRESETS: readonly string[] = [
  'Drum Synth',
  'Analog Machine',
  'Punch Machine',
  'Lo-fi Machine',
  'Hand Machine',
];

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

/** The FM synth's Ratio knob: the main modulator's frequency over the note's. */
export const FM_RATIOS = [0.5, 1, 1.5, 2, 3, 3.5, 4, 5, 7, 9, 14];

const fm = (d: Record<'brightness' | 'ratio' | 'feedback' | 'attack' | 'decay' | 'release', number>): ParamDef[] => [
  { id: 'brightness', name: 'Brightness', min: 0, max: 2, default: d.brightness, unit: '×' },
  {
    id: 'ratio',
    name: 'Ratio',
    min: 0,
    max: FM_RATIOS.length - 1,
    default: FM_RATIOS.indexOf(d.ratio),
    step: 1,
    options: FM_RATIOS.map((r) => `${r}`),
  },
  { id: 'feedback', name: 'Feedback', min: 0, max: 1, default: d.feedback },
  { id: 'attack', name: 'Attack', min: 0.001, max: 4, default: d.attack, unit: 's', scale: 'log' },
  { id: 'decay', name: 'Decay', min: 0.05, max: 12, default: d.decay, unit: 's', scale: 'log' },
  { id: 'release', name: 'Release', min: 0.01, max: 8, default: d.release, unit: 's', scale: 'log' },
];
SYNTH_MACROS['FM Keys'] = fm({ brightness: 1, ratio: 14, feedback: 0.2, attack: 0.002, decay: 3.5, release: 0.35 });
SYNTH_MACROS['FM Bells'] = fm({ brightness: 1, ratio: 3.5, feedback: 0, attack: 0.002, decay: 6, release: 2.5 });
SYNTH_MACROS['FM Bass'] = fm({ brightness: 1, ratio: 1, feedback: 0.35, attack: 0.002, decay: 1.5, release: 0.08 });
SYNTH_MACROS['FM Brass'] = fm({ brightness: 1, ratio: 1, feedback: 0.25, attack: 0.06, decay: 1, release: 0.25 });
SYNTH_MACROS['FM Pluck'] = fm({ brightness: 1, ratio: 2, feedback: 0.1, attack: 0.002, decay: 0.9, release: 0.25 });
SYNTH_MACROS['FM Pad'] = fm({ brightness: 1, ratio: 2, feedback: 0, attack: 0.9, decay: 3, release: 2.5 });

const morph = (d: Record<'morph' | 'brightness' | 'motion' | 'texture' | 'release' | 'space', number>): ParamDef[] => [
  { id: 'morph', name: 'Morph', min: 0, max: 1, default: d.morph },
  { id: 'brightness', name: 'Brightness', min: 200, max: 14000, default: d.brightness, unit: 'Hz', scale: 'log' },
  { id: 'motion', name: 'Motion', min: 0, max: 1, default: d.motion },
  { id: 'texture', name: 'Texture', min: 0, max: 1, default: d.texture },
  { id: 'release', name: 'Release', min: 0.02, max: 10, default: d.release, unit: 's', scale: 'log' },
  { id: 'space', name: 'Space', min: 0, max: 1, default: d.space },
];
SYNTH_MACROS['Morph Pad'] = morph({ morph: 0.35, brightness: 2400, motion: 0.5, texture: 0.2, release: 3, space: 0.5 });
SYNTH_MACROS['Morph Lead'] = morph({
  morph: 0.2,
  brightness: 3800,
  motion: 0.15,
  texture: 0.05,
  release: 0.25,
  space: 0.2,
});
SYNTH_MACROS['Morph Pluck'] = morph({
  morph: 0.3,
  brightness: 1200,
  motion: 0.1,
  texture: 0.05,
  release: 0.3,
  space: 0.3,
});
SYNTH_MACROS['Morph Bass'] = morph({ morph: 0.3, brightness: 700, motion: 0.05, texture: 0, release: 0.12, space: 0 });
SYNTH_MACROS['Morph Choir'] = morph({
  morph: 0.2,
  brightness: 5000,
  motion: 0.4,
  texture: 0.15,
  release: 2.5,
  space: 0.55,
});

const drone = (d: Record<'tone' | 'motion' | 'density' | 'swell' | 'width' | 'space', number>): ParamDef[] => [
  { id: 'tone', name: 'Tone', min: 0, max: 1, default: d.tone },
  { id: 'motion', name: 'Motion', min: 0, max: 1, default: d.motion },
  { id: 'density', name: 'Density', min: 0, max: 1, default: d.density },
  { id: 'swell', name: 'Swell', min: 0.05, max: 10, default: d.swell, unit: 's', scale: 'log' },
  { id: 'width', name: 'Width', min: 0, max: 1, default: d.width },
  { id: 'space', name: 'Space', min: 0, max: 1, default: d.space },
];
SYNTH_MACROS['Drone Field'] = drone({ tone: 0.4, motion: 0.4, density: 0, swell: 3, width: 0.6, space: 0.6 });
SYNTH_MACROS['Drone Metal'] = drone({ tone: 0.55, motion: 0.5, density: 0.15, swell: 2, width: 0.7, space: 0.55 });
SYNTH_MACROS['Drone Breath'] = drone({ tone: 0.45, motion: 0.55, density: 0, swell: 2.5, width: 0.5, space: 0.5 });
SYNTH_MACROS['Drone Glass'] = drone({ tone: 0.6, motion: 0.5, density: 0.6, swell: 1.5, width: 0.8, space: 0.7 });

const machine = (d: Record<'tune' | 'decay' | 'snap' | 'tone' | 'drive' | 'width', number>): ParamDef[] => [
  { id: 'tune', name: 'Tune', min: -12, max: 12, default: d.tune, unit: 'st' },
  { id: 'decay', name: 'Decay', min: 0.25, max: 3, default: d.decay, unit: '×', scale: 'log' },
  { id: 'snap', name: 'Snap', min: 0, max: 1, default: d.snap },
  { id: 'tone', name: 'Tone', min: 0, max: 1, default: d.tone },
  { id: 'drive', name: 'Drive', min: 0, max: 1, default: d.drive },
  { id: 'width', name: 'Width', min: 0, max: 1, default: d.width },
];
SYNTH_MACROS['Analog Machine'] = machine({ tune: 0, decay: 1, snap: 0.5, tone: 0.5, drive: 0.1, width: 0.5 });
SYNTH_MACROS['Punch Machine'] = machine({ tune: 0, decay: 1, snap: 0.6, tone: 0.6, drive: 0.3, width: 0.4 });
SYNTH_MACROS['Lo-fi Machine'] = machine({ tune: -1, decay: 0.9, snap: 0.45, tone: 0.3, drive: 0.35, width: 0.3 });
SYNTH_MACROS['Hand Machine'] = machine({ tune: 0, decay: 1, snap: 0.5, tone: 0.5, drive: 0, width: 0.7 });

type Six<K extends string> = Record<K, number>;
const knob = (id: string, name: string, min: number, max: number, d: number, more?: Partial<ParamDef>): ParamDef => ({
  id,
  name,
  min,
  max,
  default: d,
  ...more,
});
const seconds = { unit: 's', scale: 'log' } as const;

const wind = (d: Six<'breath' | 'overblow' | 'vibrato' | 'attack' | 'release' | 'space'>): ParamDef[] => [
  knob('breath', 'Breath', 0, 1, d.breath),
  knob('overblow', 'Overblow', 0, 1, d.overblow),
  knob('vibrato', 'Vibrato', 0, 1, d.vibrato),
  knob('attack', 'Attack', 0.005, 2, d.attack, seconds),
  knob('release', 'Release', 0.02, 4, d.release, seconds),
  knob('space', 'Space', 0, 1, d.space),
];
SYNTH_MACROS.Shakuhachi = wind({ breath: 0.55, overblow: 0.1, vibrato: 0.35, attack: 0.12, release: 0.4, space: 0.5 });
SYNTH_MACROS.Bansuri = wind({ breath: 0.3, overblow: 0.05, vibrato: 0.45, attack: 0.08, release: 0.3, space: 0.45 });
SYNTH_MACROS.Dizi = wind({ breath: 0.25, overblow: 0.15, vibrato: 0.4, attack: 0.04, release: 0.2, space: 0.4 });
SYNTH_MACROS['Celtic Pipes'] = wind({
  breath: 0.1,
  overblow: 0,
  vibrato: 0.1,
  attack: 0.03,
  release: 0.15,
  space: 0.35,
});

const plucked = (d: Six<'tone' | 'buzz' | 'vibrato' | 'decay' | 'body' | 'space'>): ParamDef[] => [
  knob('tone', 'Tone', 0, 1, d.tone),
  knob('buzz', 'Buzz', 0, 1, d.buzz),
  knob('vibrato', 'Vibrato', 0, 1, d.vibrato),
  knob('decay', 'Decay', 0.25, 3, d.decay, { unit: '×', scale: 'log' }),
  knob('body', 'Body', 0, 1, d.body),
  knob('space', 'Space', 0, 1, d.space),
];
SYNTH_MACROS.Koto = plucked({ tone: 0.55, buzz: 0, vibrato: 0.2, decay: 1, body: 0.5, space: 0.35 });
SYNTH_MACROS.Guzheng = plucked({ tone: 0.65, buzz: 0, vibrato: 0.35, decay: 1, body: 0.5, space: 0.4 });
SYNTH_MACROS.Gayageum = plucked({ tone: 0.45, buzz: 0, vibrato: 0.5, decay: 1, body: 0.55, space: 0.35 });
SYNTH_MACROS.Shamisen = plucked({ tone: 0.7, buzz: 0.45, vibrato: 0.1, decay: 1, body: 0.6, space: 0.25 });
SYNTH_MACROS.Pipa = plucked({ tone: 0.65, buzz: 0.1, vibrato: 0.2, decay: 1, body: 0.5, space: 0.3 });
SYNTH_MACROS.Sitar = plucked({ tone: 0.7, buzz: 0.7, vibrato: 0.2, decay: 1, body: 0.4, space: 0.35 });
SYNTH_MACROS.Tanpura = plucked({ tone: 0.6, buzz: 0.8, vibrato: 0, decay: 1, body: 0.4, space: 0.45 });

const reed = (d: Six<'tone' | 'swell' | 'tremolo' | 'detune' | 'release' | 'space'>): ParamDef[] => [
  knob('tone', 'Tone', 0, 1, d.tone),
  knob('swell', 'Swell', 0.005, 3, d.swell, seconds),
  knob('tremolo', 'Tremolo', 0, 1, d.tremolo),
  knob('detune', 'Detune', 0, 1, d.detune),
  knob('release', 'Release', 0.02, 6, d.release, seconds),
  knob('space', 'Space', 0, 1, d.space),
];
SYNTH_MACROS.Harmonium = reed({ tone: 0.55, swell: 0.12, tremolo: 0.35, detune: 0.4, release: 0.2, space: 0.3 });
SYNTH_MACROS.Sheng = reed({ tone: 0.7, swell: 0.06, tremolo: 0.3, detune: 0.1, release: 0.15, space: 0.35 });
SYNTH_MACROS['Glass Harmonica'] = reed({
  tone: 0.5,
  swell: 0.35,
  tremolo: 0.1,
  detune: 0.5,
  release: 2.5,
  space: 0.55,
});

const choir = (d: Six<'vowel' | 'breath' | 'vibrato' | 'ensemble' | 'release' | 'space'>): ParamDef[] => [
  knob('vowel', 'Vowel', 0, 1, d.vowel),
  knob('breath', 'Breath', 0, 1, d.breath),
  knob('vibrato', 'Vibrato', 0, 1, d.vibrato),
  knob('ensemble', 'Ensemble', 0, 1, d.ensemble),
  knob('release', 'Release', 0.05, 8, d.release, seconds),
  knob('space', 'Space', 0, 1, d.space),
];
SYNTH_MACROS['Choir Ahh'] = choir({ vowel: 0.05, breath: 0.3, vibrato: 0.4, ensemble: 0.7, release: 1.5, space: 0.6 });
SYNTH_MACROS['Male Choir'] = choir({
  vowel: 0.45,
  breath: 0.25,
  vibrato: 0.3,
  ensemble: 0.8,
  release: 1.5,
  space: 0.65,
});

const struck = (d: Six<'tune' | 'decay' | 'hardness' | 'tone' | 'ensemble' | 'space'>): ParamDef[] => [
  knob('tune', 'Tune', -12, 12, d.tune, { unit: 'st' }),
  knob('decay', 'Decay', 0.25, 3, d.decay, { unit: '×', scale: 'log' }),
  knob('hardness', 'Hardness', 0, 1, d.hardness),
  knob('tone', 'Tone', 0, 1, d.tone),
  knob('ensemble', 'Ensemble', 0, 1, d.ensemble),
  knob('space', 'Space', 0, 1, d.space),
];
SYNTH_MACROS.Taiko = struck({ tune: 0, decay: 1, hardness: 0.55, tone: 0.5, ensemble: 0, space: 0.4 });
SYNTH_MACROS['War Drums'] = struck({ tune: 0, decay: 1, hardness: 0.45, tone: 0.4, ensemble: 0.7, space: 0.55 });
SYNTH_MACROS['Frame Drum'] = struck({ tune: 0, decay: 1, hardness: 0.4, tone: 0.55, ensemble: 0, space: 0.35 });
SYNTH_MACROS['Opera Gongs'] = struck({ tune: 0, decay: 1, hardness: 0.5, tone: 0.6, ensemble: 0, space: 0.4 });
SYNTH_MACROS.Anvil = struck({ tune: 0, decay: 1, hardness: 0.8, tone: 0.75, ensemble: 0, space: 0.3 });

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
  'FM Keys':
    'Four-operator FM keys: a glassy tine on the attack over two warm, slightly detuned bodies. Play harder and it brightens. Ratio sets the tine (whole numbers stay in tune; the others ring like bells).',
  'FM Bells':
    'Clear, long FM bells and chimes from inharmonic ratios. Brightness is how much shimmer; Decay how long they ring.',
  'FM Bass':
    'A punchy FM bass: a stacked modulator snaps open on the attack and settles into a round, solid tone. Feedback adds grit.',
  'FM Brass':
    'FM brass: the modulators swell in with the note, so it blares as it opens up. Attack sets how slowly it speaks.',
  'FM Pluck': 'A bright, short FM pluck, made for arpeggios and sequences.',
  'FM Pad': 'A slow, wide FM pad from two detuned pairs, one on each side, brightening as it swells.',
  'Morph Pad':
    'A wavetable pad gliding between a soft tone and glassy partials: Morph sets where, Motion sways it slowly, Texture breathes air into it, Space is its hall.',
  'Morph Lead': 'A wavetable lead between a saw and a narrow pulse, the filter snapping open on each note.',
  'Morph Pluck':
    'A short wavetable pluck whose filter closes fast: lovely under an arpeggiator. Morph darkens it from bright to soft.',
  'Morph Bass': 'A solid wavetable bass from hollow to saw. Brightness opens it up.',
  'Morph Choir': 'Wordless voices gliding from "ah" to "oo" (Morph), three to a note, in a hall.',
  'Drone Field':
    "A breathing field of tone: the note's harmonics as narrow bands of noise, each wandering on its own. Hold a chord and let it evolve; Swell is how slowly it rises.",
  'Drone Metal':
    'Bowed metal: the inharmonic ring of a struck bar, sustained and slowly shifting. Density breaks it into shimmering grains.',
  'Drone Breath': 'Airy, breathy harmonics, like wind across many pipes. Tone darkens or brightens it.',
  'Drone Glass': 'High glassy partials sparkling in and out (Density) in a wide hall: a cold, crystalline texture.',
  'Analog Machine':
    'A classic analog drum machine: a long booming kick that falls in pitch (Decay lengthens it), a hissing snare, handclaps, metallic hats and a cowbell, on the General MIDI drum keys.',
  'Punch Machine':
    'A harder, shorter machine kit for house and techno: a kick with a click on top, a snapping snare and crisp hats. Drive pushes it.',
  'Lo-fi Machine':
    'The analog machine through a few bits and a low sample rate, its top rolled off: dusty and warm. Tone opens it up a little.',
  'Hand Machine':
    'Synthesised hand percussion: congas, bongos, claves, wood blocks, shakers and a soft low drum, spread wide.',
  Shakuhachi:
    'An end-blown bamboo flute: hollow and breathy, each note scooping up into pitch, the vibrato arriving once it settles. Breath is how much air; Overblow pushes it up toward its octave.',
  Bansuri: 'A side-blown bamboo flute: sweet and soft with a wide, gentle vibrato.',
  Dizi: 'A side-blown bamboo flute with a buzzing membrane: bright and reedy. Overblow makes it cut through.',
  'Celtic Pipes':
    'A reedy chanter over two drones. The drones start on the first note of a phrase and hold until you let every key go.',
  Koto: 'A long zither plucked with picks: clean and bright, ringing through its wooden body. Vibrato is the left hand pressing the string after the pluck.',
  Guzheng: 'A zither with many strings: shimmering plucks and a singing left-hand vibrato. Lovely for glissandi.',
  Gayageum: 'A zither plucked with the fingers: warm and round, with a deep, slow vibrato.',
  Shamisen: 'A three-stringed lute with a skin body, struck with a large plectrum: sharp, percussive and buzzy (Buzz).',
  Pipa: 'A pear-shaped lute: held notes are played as a fast tremolo of plucks.',
  Sitar:
    'A long-necked lute whose strings buzz on a wide bridge (Buzz), with sympathetic strings tuned to the scale of the first note you play, ringing along.',
  Tanpura:
    'A drone lute that plays itself: hold a note and it cycles the fifth below, the note twice and the octave below, each string blooming as it buzzes.',
  Harmonium:
    'Hand-pumped free reeds in two ranks a little apart, breathing with the bellows (Tremolo). Detune is the celeste.',
  Sheng: 'Mouth-blown free reeds, bright, each note voiced with its fifth and octave.',
  'Glass Harmonica':
    'Rubbed glass bowls: pure, shimmering tones that swell in and ring on after. Detune is the shimmer.',
  'Choir Ahh':
    'A wordless mixed choir. Vowel glides from "ah" through "oh" to "oo"; Ensemble is how many singers and how loosely together.',
  'Male Choir': "Low, dark men's voices on a vowel: for chant and weight.",
  Taiko: 'A deep barrel drum: a boom that falls in pitch after the strike, and the slap of the stick. Play low notes.',
  'War Drums': 'Several big low drums struck together, a little apart (Ensemble): a massed thunder.',
  'Frame Drum': 'A shallow skin drum: more skin than boom.',
  'Opera Gongs': 'Hand gongs whose pitch slides after the strike: down for the low ones, up for the high ones.',
  Anvil: 'A struck steel block: a hard, high, ringing clang.',
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
