/**
 * A kit's pads, each with settings of its own. A pad is the key that strikes one piece of a kit, and
 * a pack may give any pad its own level, tune and pan, a saturator, a velocity curve, a pitch
 * envelope, a filter, and whether a hit plays to its end or stops when let go. A song turns them as
 * a sampler instrument's params, `pad:KEY:ID` (`pad:38:drive`), over what the pack set. A setting
 * left out sounds exactly as the kit did before pads had settings, so a kit that sets none (every
 * pack before them) plays as it always did.
 *
 * A pad's hit, in the order its sound passes through:
 *
 *   the sample, at the pad's tune, swept by its pitch envelope
 *     → the saturator (per hit and per microphone, before the hit's level is set)
 *     → the filter
 *     → the amplifier: the velocity curve, the pad's level and pan, the kit's envelope and decay,
 *       each microphone's level
 *
 * In a pack, on a pad of an instrument's `pads` (beside its key and name), all optional:
 *
 *   level            dB, -60 (off) to 12                         0
 *   tune             semitones, -24 to 24                        0
 *   pan              -1 (left) to 1 (right), added to where       0
 *                    each sample already sits
 *   drive            the saturator, 0 to 100 %: up to 25 % its    0 (off)
 *                    curve is mixed in, from there to 100 % the
 *                    sound is driven up to 4x (12 dB) into it
 *   character        "soft" (peaks rounded over) or "hard"        "soft"
 *                    (flattened at the same level)
 *   output           dB after the saturator, -24 to 12           0
 *   curve            how velocity sets a hit's level:             "db"
 *                    "db"     straight in decibels, `range` dB from the softest to the hardest
 *                    "cubic"  amplitude (1 - (1 - v/127) × intensity)³: soft hits fall away fast
 *                    "linear" amplitude 1 - (1 - v/127) × intensity
 *   range            dB, 0 to 96, for "db"                        the instrument's velocityRange
 *   intensity        %, 0 to 100, for "cubic" and "linear"        100
 *   pitchEnv         semitones the pitch starts away, -48 to 48   0 (off)
 *   pitchDecay       seconds it takes to fall to the pad's pitch  0.08
 *   filter           "off", "lowpass" or "highpass" (12 dB an     "off"
 *                    octave, resonant)
 *   cutoff           Hz, 20 to 20000                              2000
 *   resonance        %, 0 to 100                                  0
 *   filterVelocity   %, -100 to 100: at 100 the softest hit's     0
 *                    cutoff is four octaves lower than the
 *                    hardest's (below 0, higher)
 *   play             "oneShot" (to its end, whatever the key      the instrument's oneShot
 *                    does) or "gated" (fades when let go)
 *
 * As params, a choice is its number: character 0 soft, 1 hard; curve 0 db, 1 cubic, 2 linear;
 * filter 0 off, 1 low-pass, 2 high-pass; play 0 one-shot, 1 gated.
 */

import type { ParamDef } from './plugins.ts';

export type PadCurve = 'db' | 'cubic' | 'linear';
export type PadFilter = 'off' | 'lowpass' | 'highpass';

/** A kit's pad as a pack writes it: the key it plays and what sounds there, and any settings of its own. */
export interface KitPad {
  key: number;
  name: string;
  level?: number;
  tune?: number;
  pan?: number;
  drive?: number;
  character?: 'soft' | 'hard';
  output?: number;
  curve?: PadCurve;
  range?: number;
  intensity?: number;
  pitchEnv?: number;
  pitchDecay?: number;
  filter?: PadFilter;
  cutoff?: number;
  resonance?: number;
  filterVelocity?: number;
  play?: 'oneShot' | 'gated';
}

/** A pad's settings without its name: what the engine plays. */
export type KitPadSettings = Omit<KitPad, 'name'>;

/** What a kit's own settings are, that its pads' defaults follow. */
export interface PadKit {
  velocityRange: number;
  oneShot: boolean;
}

/** Every setting of a pad, by id: its knob's id and the field a pack writes. */
export type PadField =
  | 'level'
  | 'tune'
  | 'pan'
  | 'drive'
  | 'character'
  | 'output'
  | 'curve'
  | 'range'
  | 'intensity'
  | 'pitchEnv'
  | 'pitchDecay'
  | 'filter'
  | 'cutoff'
  | 'resonance'
  | 'filterVelocity'
  | 'play';

/** A pad's settings as numbers (a choice by its place among its options), every one there. */
export type PadValues = Record<PadField, number>;

export const PAD_CHARACTERS = ['Soft', 'Hard'];
export const PAD_CURVES = ['dB', 'Cubic', 'Linear'];
export const PAD_FILTERS = ['Off', 'Low-pass', 'High-pass'];
export const PAD_PLAYS = ['One-shot', 'Gated'];

/** Each choice's words in a pack, by its number. */
const CHOICES: Partial<Record<PadField, readonly string[]>> = {
  character: ['soft', 'hard'],
  curve: ['db', 'cubic', 'linear'],
  filter: ['off', 'lowpass', 'highpass'],
  play: ['oneShot', 'gated'],
};

/** The param (in a sampler instrument's params) that sets one of a pad's settings. */
export const padParam = (key: number, id: PadField): string => `pad:${key}:${id}`;

/** A pad param's key and setting, or null when it isn't one. */
export function parsePadParam(id: string): { key: number; field: PadField } | null {
  if (!id.startsWith('pad:')) return null;
  const at = id.indexOf(':', 4);
  if (at < 0) return null;
  const key = Number(id.slice(4, at));
  const field = id.slice(at + 1) as PadField;
  if (!Number.isInteger(key) || key < 0 || key > 127 || !FIELDS.has(field)) return null;
  return { key, field };
}

/**
 * A pad's knobs, as a pad's window and the song's params know them (ids are the fields, a param is
 * `pad:KEY:ID`). Pan is -1 to 1 here, as a pack has it; a window shows it as L and R.
 */
export function padKnobs(kit: PadKit): ParamDef[] {
  return [
    { id: 'level', name: 'Level', min: -60, max: 12, default: 0, unit: 'dB', offAtMin: true },
    { id: 'tune', name: 'Tune', min: -24, max: 24, default: 0, unit: 'st' },
    { id: 'pan', name: 'Pan', min: -1, max: 1, default: 0 },
    { id: 'drive', name: 'Drive', min: 0, max: 100, default: 0, unit: '%' },
    { id: 'character', name: 'Character', min: 0, max: 1, default: 0, step: 1, options: PAD_CHARACTERS },
    { id: 'output', name: 'Output', min: -24, max: 12, default: 0, unit: 'dB' },
    { id: 'curve', name: 'Curve', min: 0, max: 2, default: 0, step: 1, options: PAD_CURVES },
    {
      id: 'range',
      name: 'Range',
      min: 0,
      max: 96,
      default: Math.min(96, Math.max(0, kit.velocityRange)),
      unit: 'dB',
    },
    { id: 'intensity', name: 'Intensity', min: 0, max: 100, default: 100, unit: '%' },
    { id: 'pitchEnv', name: 'Pitch Env', min: -48, max: 48, default: 0, unit: 'st' },
    { id: 'pitchDecay', name: 'Env Decay', min: 0.005, max: 2, default: 0.08, unit: 's', scale: 'log' },
    { id: 'filter', name: 'Filter', min: 0, max: 2, default: 0, step: 1, options: PAD_FILTERS },
    { id: 'cutoff', name: 'Cutoff', min: 20, max: 20000, default: 2000, unit: 'Hz', scale: 'log' },
    { id: 'resonance', name: 'Resonance', min: 0, max: 100, default: 0, unit: '%' },
    { id: 'filterVelocity', name: 'Velocity', min: -100, max: 100, default: 0, unit: '%' },
    { id: 'play', name: 'Play', min: 0, max: 1, default: kit.oneShot ? 0 : 1, step: 1, options: PAD_PLAYS },
  ];
}

const FIELDS = new Set<string>(padKnobs({ velocityRange: 0, oneShot: true }).map((d) => d.id));

/** A pack pad's setting as its knob's number (a choice by its place), or undefined when it has none (or none that's valid). */
function packValue(pad: Partial<KitPad>, def: ParamDef): number | undefined {
  const v = (pad as Record<string, unknown>)[def.id];
  const words = CHOICES[def.id as PadField];
  if (words) {
    const at = typeof v === 'string' ? words.indexOf(v) : -1;
    return at >= 0 ? at : undefined;
  }
  return typeof v === 'number' && Number.isFinite(v) ? Math.min(def.max, Math.max(def.min, v)) : undefined;
}

/**
 * A pad's settings, every one: the song's param where it has one, else what the pack set, else the
 * setting's default, each kept in its range.
 */
export function padValues(
  kit: PadKit,
  pad: Partial<KitPad> | undefined,
  params: Record<string, number> | undefined,
  key: number,
  defs: readonly ParamDef[] = padKnobs(kit),
): PadValues {
  const out = {} as PadValues;
  for (const def of defs) {
    const p = params?.[padParam(key, def.id as PadField)];
    let v = typeof p === 'number' && Number.isFinite(p) ? p : pad ? packValue(pad, def) : undefined;
    v ??= def.default;
    v = Math.min(def.max, Math.max(def.min, v));
    out[def.id as PadField] = def.options ? Math.round(v) : v;
  }
  return out;
}

/** The pack's own setting for each of a pad's knobs (its defaults in a window), the knob's default where it has none. */
export function padDefaults(kit: PadKit, pad: Partial<KitPad> | undefined): PadValues {
  return padValues(kit, pad, undefined, -1);
}

/** Whether a pad's settings leave its hits sounding exactly as the kit's always did. */
export function padIsPlain(kit: PadKit, v: PadValues): boolean {
  return (
    v.level === 0 &&
    v.tune === 0 &&
    v.pan === 0 &&
    v.drive === 0 &&
    v.curve === 0 &&
    v.range === Math.min(96, Math.max(0, kit.velocityRange)) &&
    v.pitchEnv === 0 &&
    v.filter === 0 &&
    v.play === (kit.oneShot ? 0 : 1)
  );
}

/**
 * The gain a velocity (1 to 127) gives a hit on a pad's curve: `curve` 0 is straight in decibels
 * (`range` dB from 1 to 127, as the sampler has always played a velocity), 1 cubic and 2 linear in
 * amplitude (`intensity` 0 to 1: at 0 every velocity is as loud).
 */
export function padVelocityGain(curve: number, range: number, intensity: number, velocity: number): number {
  if (curve === 1) {
    const a = 1 - (1 - velocity / 127) * intensity;
    return a * a * a;
  }
  if (curve === 2) return 1 - (1 - velocity / 127) * intensity;
  return 10 ** ((-((127 - velocity) / 126) * range) / 20);
}

/**
 * The saturator's curve on one sample: `drive` 0 to 4 (a pad's percent over 25), `hard` its
 * character. Up to 1 the curve is mixed in by `drive`; above, the sound goes into it `drive` times
 * louder. Fully in, both characters lift quiet sound by 6 dB and never pass full scale: soft rounds
 * toward it (2y - y²), hard flattens at it.
 */
export function saturate(x: number, drive: number, hard: boolean): number {
  if (drive <= 0) return x;
  const g = drive > 1 ? drive : 1;
  const a = x < 0 ? -x : x;
  let y: number;
  if (hard) {
    y = 2 * g * a;
    if (y > 1) y = 1;
  } else {
    y = g * a;
    if (y > 1) y = 1;
    y = 2 * y - y * y;
  }
  if (x < 0) y = -y;
  return drive < 1 ? drive * y + (1 - drive) * x : y;
}

/**
 * A pack pad's settings as the engine takes them: only those it sets, each valid, or null when it
 * sets none (nothing to send, so the kit plays exactly as before).
 */
export function cleanPad(pad: unknown): KitPadSettings | null {
  if (!pad || typeof pad !== 'object') return null;
  const p = pad as Record<string, unknown>;
  const key = p.key;
  if (typeof key !== 'number' || !Number.isInteger(key) || key < 0 || key > 127) return null;
  const out: Record<string, unknown> = {};
  let any = false;
  for (const def of padKnobs({ velocityRange: 0, oneShot: true })) {
    const v = packValue(p as Partial<KitPad>, def);
    if (v === undefined) continue;
    const words = CHOICES[def.id as PadField];
    out[def.id] = words ? words[v] : v;
    any = true;
  }
  return any ? ({ key, ...out } as KitPadSettings) : null;
}

/** What's wrong with a pack pad's settings: each one set but not valid (none for a pad without settings). */
export function padProblems(pad: unknown): string[] {
  if (!pad || typeof pad !== 'object') return ['a pad is not an object'];
  const p = pad as Record<string, unknown>;
  const at = `pad ${String(p.key)}`;
  const out: string[] = [];
  for (const def of padKnobs({ velocityRange: 0, oneShot: true })) {
    const v = p[def.id];
    if (v === undefined) continue;
    const words = CHOICES[def.id as PadField];
    if (words) {
      if (typeof v !== 'string' || !words.includes(v))
        out.push(`${at}: ${def.id} is ${JSON.stringify(v)}, not one of ${words.join(', ')}`);
    } else if (typeof v !== 'number' || !Number.isFinite(v) || v < def.min || v > def.max)
      out.push(`${at}: ${def.id} is ${JSON.stringify(v)}, not ${def.min} to ${def.max}`);
  }
  for (const k of Object.keys(p))
    if (k !== 'key' && k !== 'name' && !FIELDS.has(k)) out.push(`${at}: "${k}" isn't a pad setting`);
  return out;
}

/**
 * Every pad's knobs, each by its param (`pad:KEY:ID`) and named by its pad ("Snare Drive"): what the
 * terminal and the agent set, beside the kit's own (samplerKnobs).
 */
export function kitPadKnobs(kit: PadKit, pads: readonly { key: number; name: string }[]): ParamDef[] {
  const defs = padKnobs(kit);
  return pads.flatMap((p) =>
    defs.map((d) => ({ ...d, id: padParam(p.key, d.id as PadField), name: `${p.name} ${d.name}` })),
  );
}

/** A pad setting in words: its value in its unit, or its choice's name. */
export function padSettingText(def: ParamDef, v: number): string {
  if (def.options) return def.options[Math.round(v)] ?? String(v);
  if (def.id === 'pan') return Math.abs(v) < 0.005 ? 'center' : `${v < 0 ? 'L' : 'R'} ${Math.round(Math.abs(v) * 100)}`;
  const n = Math.round(v * 1000) / 1000;
  return def.unit ? `${n} ${def.unit}` : String(n);
}

/**
 * A line for each of a kit's pads that sounds other than the kit plays it (by its pack or the song),
 * with the settings that differ: what a listing of a kit's knobs adds.
 */
export function padLines(
  kit: PadKit,
  pads: readonly Partial<KitPad>[],
  params: Record<string, number> | undefined,
): string[] {
  const defs = padKnobs(kit);
  const plain = padValues(kit, undefined, undefined, -1, defs);
  const out: string[] = [];
  for (const p of pads) {
    if (typeof p.key !== 'number') continue;
    const v = padValues(kit, p, params, p.key, defs);
    if (padIsPlain(kit, v)) continue;
    const set = defs
      .filter((d) => v[d.id as PadField] !== plain[d.id as PadField])
      .map((d) => `${d.id}=${padSettingText(d, v[d.id as PadField])}`);
    out.push(`  pad ${p.key} ${p.name ?? ''}: ${set.join(' ')}`);
  }
  return out;
}
