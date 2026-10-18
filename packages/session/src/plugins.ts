/**
 * The stock plugins: every parameter's range, default and unit. The studio's engine, its plugin
 * windows, the command line and the AI all read this one table, so a value means the same thing
 * everywhere. Choice parameters store the option's index.
 */

export interface ParamDef {
  id: string;
  name: string;
  min: number;
  max: number;
  default: number;
  unit?: string;
  /** "log" for frequencies and times: a knob's travel is even in octaves, not in hertz. */
  scale?: 'lin' | 'log';
  step?: number;
  options?: string[];
}

export interface PluginDef {
  type: string;
  name: string;
  kind: 'audio' | 'midi';
  category: string;
  description: string;
  params: ParamDef[];
}

const onOff = (id: string, name: string, on = 0): ParamDef => ({
  id,
  name,
  min: 0,
  max: 1,
  default: on,
  step: 1,
  options: ['Off', 'On'],
});
const hz = (id: string, name: string, min: number, max: number, def: number): ParamDef => ({
  id,
  name,
  min,
  max,
  default: def,
  unit: 'Hz',
  scale: 'log',
});
const db = (id: string, name: string, min: number, max: number, def: number): ParamDef => ({
  id,
  name,
  min,
  max,
  default: def,
  unit: 'dB',
});
const ms = (id: string, name: string, min: number, max: number, def: number, log = true): ParamDef => ({
  id,
  name,
  min,
  max,
  default: def,
  unit: 'ms',
  scale: log ? 'log' : 'lin',
});
const pct = (id: string, name: string, def: number, max = 100): ParamDef => ({
  id,
  name,
  min: 0,
  max,
  default: def,
  unit: '%',
});
const q = (id: string, name: string): ParamDef => ({
  id,
  name,
  min: 0.2,
  max: 10,
  default: 1,
  scale: 'log',
});

export const KEYS = ['C', 'C#', 'D', 'Eb', 'E', 'F', 'F#', 'G', 'Ab', 'A', 'Bb', 'B'];

/** Scales as semitones above the key. */
export const SCALES: { name: string; steps: number[] }[] = [
  { name: 'Major', steps: [0, 2, 4, 5, 7, 9, 11] },
  { name: 'Natural minor', steps: [0, 2, 3, 5, 7, 8, 10] },
  { name: 'Harmonic minor', steps: [0, 2, 3, 5, 7, 8, 11] },
  { name: 'Melodic minor', steps: [0, 2, 3, 5, 7, 9, 11] },
  { name: 'Dorian', steps: [0, 2, 3, 5, 7, 9, 10] },
  { name: 'Phrygian', steps: [0, 1, 3, 5, 7, 8, 10] },
  { name: 'Lydian', steps: [0, 2, 4, 6, 7, 9, 11] },
  { name: 'Mixolydian', steps: [0, 2, 4, 5, 7, 9, 10] },
  { name: 'Locrian', steps: [0, 1, 3, 5, 6, 8, 10] },
  { name: 'Major pentatonic', steps: [0, 2, 4, 7, 9] },
  { name: 'Minor pentatonic', steps: [0, 3, 5, 7, 10] },
  { name: 'Chromatic', steps: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] },
];

const keyParam: ParamDef = { id: 'key', name: 'Key', min: 0, max: 11, default: 0, step: 1, options: KEYS };
const scaleParam: ParamDef = {
  id: 'scale',
  name: 'Scale',
  min: 0,
  max: SCALES.length - 1,
  default: 0,
  step: 1,
  options: SCALES.map((s) => s.name),
};
const voice = (id: string, name: string, def: number): ParamDef => ({
  id,
  name,
  min: -14,
  max: 14,
  default: def,
  step: 1,
  unit: 'steps',
});

/** Space Designer's generated spaces, in its menu's order (the engine makes them: @holo/engine spaces.ts). */
export const SPACE_NAMES = [
  'room',
  'chamber',
  'hall',
  'scoring',
  'concert',
  'epic',
  'cathedral',
  'dark cathedral',
  'plate',
  'forest',
  'field',
  'underwater',
  'sky',
];
/** The space index that means "the impulse response file in its settings". */
export const SPACE_FILE = SPACE_NAMES.length;

/** The Space menu Space Designer and Shimmer share: the generated spaces, then a response file. */
const spaceParam = (def: string): ParamDef => ({
  id: 'space',
  name: 'Space',
  min: 0,
  max: SPACE_FILE,
  default: SPACE_NAMES.indexOf(def),
  step: 1,
  options: [...SPACE_NAMES.map((n) => n.replace(/\b\w/g, (c) => c.toUpperCase())), 'From a file'],
});

/** Parametric EQ: its bands, and what each band can be (the filters are the RBJ cookbook's, one biquad each). */
export const PEQ_BANDS = 8;
export const PEQ_TYPES = ['Off', 'Low Cut', 'Low Shelf', 'Bell', 'Notch', 'Band Pass', 'High Shelf', 'High Cut'];
const PEQ_FREQS = [40, 100, 250, 500, 1000, 2500, 6000, 12000];

function peqParams(): ParamDef[] {
  const out: ParamDef[] = [];
  for (let b = 1; b <= PEQ_BANDS; b++) {
    out.push({
      id: `t${b}`,
      name: `Band ${b} Type`,
      min: 0,
      max: PEQ_TYPES.length - 1,
      default: 0,
      step: 1,
      options: PEQ_TYPES,
    });
    out.push(hz(`f${b}`, `Band ${b} Freq`, 10, 22000, PEQ_FREQS[b - 1] ?? 1000));
    out.push(db(`g${b}`, `Band ${b} Gain`, -30, 30, 0));
    out.push({ id: `q${b}`, name: `Band ${b} Q`, min: 0.1, max: 20, default: Math.SQRT1_2, scale: 'log' });
  }
  out.push(db('output', 'Output', -24, 24, 0));
  return out;
}

export const ARP_MODES = ['Up', 'Down', 'Up/Down', 'As played', 'Random', 'Chord'];
export const ARP_RATES = ['1/4', '1/8', '1/8T', '1/16', '1/16T', '1/32'];
export const DELAY_DIVISIONS = ['1/2', '1/4', '1/4.', '1/8', '1/8.', '1/8T', '1/16'];

export const PLUGINS: PluginDef[] = [
  {
    type: 'eq',
    name: 'Channel EQ',
    kind: 'audio',
    category: 'EQ',
    description: 'Low and high cut, two shelves and three bells, drawn as one curve.',
    params: [
      onOff('hpOn', 'Low Cut'),
      hz('hpFreq', 'Low Cut Freq', 20, 1000, 80),
      hz('lsFreq', 'Low Shelf Freq', 30, 1000, 120),
      db('lsGain', 'Low Shelf Gain', -18, 18, 0),
      hz('b1Freq', 'Low Mid Freq', 40, 16000, 250),
      db('b1Gain', 'Low Mid Gain', -18, 18, 0),
      q('b1Q', 'Low Mid Q'),
      hz('b2Freq', 'Mid Freq', 40, 16000, 1000),
      db('b2Gain', 'Mid Gain', -18, 18, 0),
      q('b2Q', 'Mid Q'),
      hz('b3Freq', 'High Mid Freq', 40, 16000, 4000),
      db('b3Gain', 'High Mid Gain', -18, 18, 0),
      q('b3Q', 'High Mid Q'),
      hz('hsFreq', 'High Shelf Freq', 1000, 16000, 8000),
      db('hsGain', 'High Shelf Gain', -18, 18, 0),
      onOff('lpOn', 'High Cut'),
      hz('lpFreq', 'High Cut Freq', 1000, 20000, 16000),
      db('output', 'Output', -24, 24, 0),
    ],
  },
  {
    type: 'peq',
    name: 'Parametric EQ',
    kind: 'audio',
    category: 'EQ',
    description: 'Eight free bands, each a cut, shelf, bell, notch or band pass at any frequency and Q.',
    params: peqParams(),
  },
  {
    type: 'compressor',
    name: 'Compressor',
    kind: 'audio',
    category: 'Dynamics',
    description: 'A feed-forward compressor with a soft knee and a parallel mix.',
    params: [
      db('threshold', 'Threshold', -60, 0, -18),
      { id: 'ratio', name: 'Ratio', min: 1, max: 20, default: 3, scale: 'log', unit: ':1' },
      ms('attack', 'Attack', 0.1, 200, 10),
      ms('release', 'Release', 5, 2000, 120),
      db('knee', 'Knee', 0, 24, 6),
      db('makeup', 'Make-up', -12, 24, 0),
      pct('mix', 'Mix', 100),
      {
        id: 'detector',
        name: 'Detector',
        min: 0,
        max: 1,
        default: 0,
        step: 1,
        options: ['Log', 'Linear'],
      },
    ],
  },
  {
    type: 'gate',
    name: 'Noise Gate',
    kind: 'audio',
    category: 'Dynamics',
    description: 'Closes below the threshold, by as much as the range.',
    params: [
      db('threshold', 'Threshold', -90, 0, -50),
      db('range', 'Range', -90, 0, -60),
      ms('attack', 'Attack', 0.1, 50, 1),
      ms('hold', 'Hold', 0, 500, 20, false),
      ms('release', 'Release', 5, 2000, 100),
    ],
  },
  {
    type: 'softener',
    name: 'Transient Softener',
    kind: 'audio',
    category: 'Dynamics',
    description:
      'Pulls down the first milliseconds of each attack (a close mic’s click, a hammer, a mallet) against the body of the note.',
    params: [
      pct('amount', 'Amount', 50),
      ms('fast', 'Fast', 0.1, 5, 0.4),
      ms('slow', 'Slow', 2, 50, 10),
      ms('release', 'Release', 5, 200, 30),
    ],
  },
  {
    type: 'limiter',
    name: 'Limiter',
    kind: 'audio',
    category: 'Dynamics',
    description: 'A look-ahead brick-wall limiter for the master.',
    params: [
      db('gain', 'Gain', 0, 24, 0),
      db('ceiling', 'Ceiling', -12, 0, -1),
      ms('release', 'Release', 1, 1000, 50),
      ms('lookahead', 'Lookahead', 0, 10, 3, false),
    ],
  },
  {
    type: 'reverb',
    name: 'Space Reverb',
    kind: 'audio',
    category: 'Reverb',
    description: 'An algorithmic hall: eight delay lines in a feedback matrix.',
    params: [
      ms('predelay', 'Pre-delay', 0, 250, 20, false),
      pct('size', 'Size', 60),
      { id: 'decay', name: 'Decay', min: 0.2, max: 20, default: 2.2, unit: 's', scale: 'log' },
      hz('damping', 'Damping', 1000, 20000, 7000),
      hz('lowcut', 'Low Cut', 20, 1000, 120),
      pct('width', 'Width', 100),
      pct('mix', 'Mix', 30),
    ],
  },
  {
    type: 'space',
    name: 'Space Designer',
    kind: 'audio',
    category: 'Reverb',
    description:
      'Convolution with a real space: rooms, halls and cathedrals made to a design, or a recorded or exported response.',
    params: [
      spaceParam('concert'),
      { id: 'seed', name: 'Variation', min: 0, max: 99, default: 7, step: 1 },
      { id: 'decay', name: 'Decay', min: 0.5, max: 2, default: 1, unit: '×' },
      ms('predelay', 'Pre-delay', 0, 250, 0, false),
      pct('cross', 'Cross', 55),
      hz('lowcut', 'Low Cut', 20, 1000, 20),
      hz('highcut', 'High Cut', 1000, 20000, 20000),
      db('wet', 'Wet', -60, 12, 0),
      db('dry', 'Dry', -60, 0, -60),
    ],
  },
  {
    type: 'shimmer',
    name: 'Shimmer',
    kind: 'audio',
    category: 'Reverb',
    description:
      'A space whose sound is sent back into it an octave up, a generation at a time, each one darker and quieter. With Look-ahead, each octave sounds with what it came from (the mix waits for it).',
    params: [
      spaceParam('cathedral'),
      { id: 'seed', name: 'Variation', min: 0, max: 99, default: 7, step: 1 },
      { id: 'decay', name: 'Decay', min: 0.5, max: 2, default: 1, unit: '×' },
      { id: 'generations', name: 'Generations', min: 0, max: 4, default: 2, step: 1 },
      pct('feedback', 'Feedback', 45, 90),
      pct('cross', 'Cross', 55),
      hz('lowcut', 'Low Cut', 20, 1000, 20),
      db('wet', 'Wet', -60, 12, 0),
      db('dry', 'Dry', -60, 0, -60),
      onOff('lookahead', 'Look-ahead'),
    ],
  },
  {
    type: 'delay',
    name: 'Tape Delay',
    kind: 'audio',
    category: 'Delay',
    description: 'A stereo or ping-pong delay, free or in time with the song.',
    params: [
      onOff('sync', 'Sync', 1),
      {
        id: 'division',
        name: 'Division',
        min: 0,
        max: DELAY_DIVISIONS.length - 1,
        default: 3,
        step: 1,
        options: DELAY_DIVISIONS,
      },
      ms('time', 'Time', 1, 2000, 375),
      pct('feedback', 'Feedback', 35, 95),
      onOff('pingpong', 'Ping-pong'),
      hz('lowcut', 'Low Cut', 20, 2000, 150),
      hz('highcut', 'High Cut', 1000, 20000, 6000),
      pct('mix', 'Mix', 25),
    ],
  },
  {
    type: 'chorus',
    name: 'Chorus',
    kind: 'audio',
    category: 'Modulation',
    description: 'Two modulated delay voices, one per side.',
    params: [
      { id: 'rate', name: 'Rate', min: 0.05, max: 5, default: 0.6, unit: 'Hz', scale: 'log' },
      pct('depth', 'Depth', 40),
      ms('delay', 'Delay', 2, 30, 12, false),
      pct('mix', 'Mix', 50),
    ],
  },
  {
    type: 'wow',
    name: 'Wow & Flutter',
    kind: 'audio',
    category: 'Modulation',
    description: 'The slow drift and quick flutter of tape speed: a gentle wobble of pitch, never the same twice.',
    params: [
      { id: 'wow', name: 'Wow', min: 0, max: 0.5, default: 0.07, unit: '%' },
      { id: 'flutter', name: 'Flutter', min: 0, max: 0.2, default: 0.02, unit: '%' },
      { id: 'wowRate', name: 'Wow Rate', min: 0.1, max: 3, default: 0.55, unit: 'Hz', scale: 'log' },
      { id: 'flutterRate', name: 'Flutter Rate', min: 2, max: 20, default: 6.5, unit: 'Hz', scale: 'log' },
      { id: 'seed', name: 'Variation', min: 0, max: 99, default: 0, step: 1 },
    ],
  },
  {
    type: 'width',
    name: 'Stereo Width',
    kind: 'audio',
    category: 'Imaging',
    description:
      'Narrows or widens the image (mid and side), places it left or right at constant power, and can ease the lows towards mono.',
    params: [
      pct('width', 'Width', 100, 300),
      { id: 'position', name: 'Position', min: -100, max: 100, default: 0, unit: 'LR' },
      onOff('mono', 'Bass Mono'),
      hz('monoFreq', 'Mono Below', 20, 500, 120),
    ],
  },
  {
    type: 'tape',
    name: 'Tape Warmth',
    kind: 'audio',
    category: 'Distortion',
    description: 'Gentle tape saturation with a touch of even harmonics, a little low-mid body and a rounded top.',
    params: [
      { id: 'drive', name: 'Drive', min: 1, max: 4, default: 1.5, unit: '×' },
      pct('even', 'Even', 8, 30),
      pct('mix', 'Mix', 100),
      db('input', 'Input', -24, 24, 0),
      db('body', 'Body', -6, 6, 0),
      db('top', 'Top', -12, 6, 0),
      onOff('dcBlock', 'DC Block', 1),
    ],
  },
  {
    type: 'saturator',
    name: 'Saturation',
    kind: 'audio',
    category: 'Distortion',
    description: 'Soft tape-like saturation with a tone control.',
    params: [
      db('drive', 'Drive', 0, 36, 6),
      hz('tone', 'Tone', 1000, 20000, 12000),
      pct('mix', 'Mix', 100),
      db('output', 'Output', -24, 12, 0),
    ],
  },
  {
    type: 'arpeggiator',
    name: 'Arpeggiator',
    kind: 'midi',
    category: 'MIDI FX',
    description: 'Plays held notes one at a time, in time with the song.',
    params: [
      { id: 'mode', name: 'Mode', min: 0, max: ARP_MODES.length - 1, default: 0, step: 1, options: ARP_MODES },
      { id: 'rate', name: 'Rate', min: 0, max: ARP_RATES.length - 1, default: 3, step: 1, options: ARP_RATES },
      { id: 'octaves', name: 'Octaves', min: 1, max: 4, default: 1, step: 1 },
      pct('gate', 'Gate', 80, 200),
      onOff('latch', 'Latch'),
      pct('swing', 'Swing', 0, 75),
    ],
  },
  {
    type: 'harmonizer',
    name: 'Harmonizer',
    kind: 'midi',
    category: 'MIDI FX',
    description: 'Adds up to three voices a number of scale steps from each note played (0 is off).',
    params: [
      keyParam,
      scaleParam,
      voice('voice1', 'Voice 1', 2),
      voice('voice2', 'Voice 2', 0),
      voice('voice3', 'Voice 3', 0),
      pct('velocity', 'Voice Velocity', 80, 150),
      onOff('original', 'Play Original', 1),
    ],
  },
  {
    type: 'scale',
    name: 'Scale Quantizer',
    kind: 'midi',
    category: 'MIDI FX',
    description: 'Transposes, and moves every note onto the nearest note of a scale.',
    params: [
      { id: 'transpose', name: 'Transpose', min: -24, max: 24, default: 0, step: 1, unit: 'st' },
      keyParam,
      scaleParam,
      onOff('quantize', 'Snap to Scale', 1),
    ],
  },
  {
    type: 'velocity',
    name: 'Velocity Processor',
    kind: 'midi',
    category: 'MIDI FX',
    description: 'Scales, offsets, randomises and limits how hard notes play.',
    params: [
      pct('scale', 'Scale', 100, 200),
      { id: 'offset', name: 'Offset', min: -64, max: 64, default: 0, step: 1 },
      { id: 'random', name: 'Random', min: 0, max: 64, default: 0, step: 1 },
      { id: 'min', name: 'Min', min: 1, max: 127, default: 1, step: 1 },
      { id: 'max', name: 'Max', min: 1, max: 127, default: 127, step: 1 },
    ],
  },
];

const BY_TYPE = new Map(PLUGINS.map((p) => [p.type, p]));

export function pluginDef(type: string): PluginDef | undefined {
  return BY_TYPE.get(type);
}

export function defaultParams(type: string): Record<string, number> {
  const def = BY_TYPE.get(type);
  if (!def) throw new Error(`Unknown plugin type "${type}"`);
  return Object.fromEntries(def.params.map((p) => [p.id, p.default]));
}

/** Each plugin type's parameters by id (the engine asks for them every time a setting moves). */
const PARAMS_BY_ID = new Map(PLUGINS.map((p) => [p.type, new Map(p.params.map((x) => [x.id, x]))]));

/** A parameter's value, from its stored value or its default, kept inside its range. */
export function paramValue(type: string, params: Record<string, number>, id: string): number {
  const p = PARAMS_BY_ID.get(type)?.get(id);
  if (!p) return params[id] ?? 0;
  const v = params[id] ?? p.default;
  return Math.min(p.max, Math.max(p.min, v));
}

export function formatParam(p: ParamDef, v: number): string {
  if (p.options) return p.options[Math.round(v)] ?? String(v);
  if (p.unit === 'Hz') return v >= 1000 ? `${(v / 1000).toFixed(v >= 10000 ? 1 : 2)} kHz` : `${Math.round(v)} Hz`;
  if (p.unit === 'dB') return `${v > 0 ? '+' : ''}${v.toFixed(1)} dB`;
  if (p.unit === 'ms') return v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`;
  if (p.unit === 's') return `${v.toFixed(v < 10 ? 2 : 1)} s`;
  if (p.unit === '%') return v !== 0 && Math.abs(v) < 1 ? `${v.toFixed(2)}%` : `${Math.round(v)}%`;
  if (p.unit === 'LR') return Math.abs(v) < 0.5 ? 'Centre' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v))}`;
  if (p.unit === ':1') return `${v.toFixed(1)}:1`;
  if (p.unit) return `${Math.round(v * 100) / 100} ${p.unit}`;
  return String(Math.round(v * 100) / 100);
}

/** Knob position 0–1 for a value, and back: even in octaves for log parameters. */
export function toUnit(p: ParamDef, v: number): number {
  if (p.scale === 'log' && p.min > 0) return Math.log(v / p.min) / Math.log(p.max / p.min);
  return (v - p.min) / (p.max - p.min);
}

export function fromUnit(p: ParamDef, u: number): number {
  const x = Math.min(1, Math.max(0, u));
  let v = p.scale === 'log' && p.min > 0 ? p.min * (p.max / p.min) ** x : p.min + x * (p.max - p.min);
  if (p.step) v = Math.round(v / p.step) * p.step;
  return Math.min(p.max, Math.max(p.min, v));
}
