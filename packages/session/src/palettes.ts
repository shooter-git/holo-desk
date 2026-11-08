/**
 * Palettes: packs that carry ready-made sounds. A sound is an instrument (a pack's, or a built-in
 * synth with its knobs set), the effects it plays through, the room it sits in and its level, so one
 * click puts a finished sound on a new track. A palette may hold no audio of its own: its sounds play
 * the packs it requires and HO[LO]'s synths. A sound that needs a synth, an effect or a pack this
 * engine doesn't have yet is shown as coming, never played half-made.
 */

import { newBus, newPlugin, newTrack } from './defaults.ts';
import { SYNTH_MACROS, SYNTH_PRESETS } from './instruments.ts';
import type { Op } from './ops.ts';
import { pluginDef } from './plugins.ts';
import type { Bus, Instrument, Plugin, Project, Track } from './types.ts';

/** The families a palette's sounds are found by, in the order the Library lists them. */
export const SOUND_FAMILIES = [
  'Keys',
  'Organs',
  'Strings',
  'Brass',
  'Woodwinds',
  'Voices',
  'Plucked',
  'Mallets and bells',
  'Drums and percussion',
  'Bass',
  'Synths',
  'Pads',
  'Textures',
] as const;

export type SoundFamily = (typeof SOUND_FAMILIES)[number];

/** What a sound plays: one of a pack's instruments, or a built-in synth with its knobs set. */
export type SoundInstrument = { pack: string; name: string } | { synth: string; params?: Record<string, number> };

/** An effect a sound plays through (an audio insert, or a MIDI effect such as the Arpeggiator). */
export interface SoundEffect {
  type: string;
  params?: Record<string, number>;
  /** Settings that aren't numbers (a Space Designer's response file: "pack/name"). */
  settings?: Record<string, string>;
}

/**
 * The room a sound sits in: a bus of that name with one reverb on it, which the track sends to.
 * Sounds that name the same room share its bus.
 */
export interface SoundSpace {
  /** The room's name, as its bus is called ("Warm Hall"). */
  name: string;
  /** Space Designer, Shimmer or Space Reverb. */
  type: 'space' | 'shimmer' | 'reverb';
  params?: Record<string, number>;
  settings?: Record<string, string>;
  /** How much the track sends to it, in dB. */
  send: number;
}

export interface PackSound {
  name: string;
  family: string;
  instrument: SoundInstrument;
  /** Its effects, in order: audio effects go on the track's inserts, MIDI effects before the instrument. */
  inserts?: SoundEffect[];
  space?: SoundSpace;
  /** The track's fader, in dB: a palette's sounds are levelled to sit together. */
  volume?: number;
  /** −1 (left) to 1 (right). */
  pan?: number;
  /** What it is, in a line. */
  note?: string;
  /**
   * Waits for a piece HO[LO] doesn't have yet (a synth, an effect or a pack still being made). The
   * Library asks this engine itself what it has; this says the palette knows.
   */
  coming?: boolean;
}

/** A pack's instrument a sound plays, if it plays one. */
export function soundSampler(sound: PackSound): { pack: string; name: string } | null {
  return 'pack' in sound.instrument ? { pack: sound.instrument.pack, name: sound.instrument.name } : null;
}

/** The packs a sound plays: its instrument's, and those of any response file its effects or room name. */
export function soundPacks(sound: PackSound): string[] {
  const out = new Set<string>();
  const sampler = soundSampler(sound);
  if (sampler) out.add(sampler.pack);
  for (const fx of [...(sound.inserts ?? []), ...(sound.space ? [sound.space] : [])]) {
    for (const [key, value] of Object.entries(fx.settings ?? {})) {
      if (/^ir\d*$/.test(key) && value.includes('/')) out.add(value.slice(0, value.indexOf('/')));
    }
  }
  return [...out].sort();
}

export interface SoundCheck {
  /** What this engine doesn't have (a synth or an effect): the sound is coming, not broken. */
  missing: string[];
  /** What's wrong with how it's written (a knob it doesn't have, a value out of range). */
  problems: string[];
}

function checkParams(
  what: string,
  params: Record<string, number> | undefined,
  defs: { id: string; min: number; max: number }[],
  problems: string[],
): void {
  for (const [id, v] of Object.entries(params ?? {})) {
    const def = defs.find((d) => d.id === id);
    if (!def) problems.push(`${what} has no "${id}"`);
    else if (typeof v !== 'number' || !Number.isFinite(v) || v < def.min || v > def.max)
      problems.push(`${what}'s ${id} is ${v}, outside ${def.min}…${def.max}`);
  }
}

/**
 * A sound checked against this engine: what it lacks (a synth preset or an effect not here yet) and
 * what's wrong (a knob a synth or effect doesn't have, a value out of range, a room that isn't a reverb).
 * Packs are checked by whoever knows them (the Library, holo-packs' check).
 */
export function checkSound(sound: PackSound): SoundCheck {
  const missing: string[] = [];
  const problems: string[] = [];
  if (!sound.name?.trim()) problems.push('it has no name');
  if (!(SOUND_FAMILIES as readonly string[]).includes(sound.family))
    problems.push(`its family "${sound.family}" isn't one of ${SOUND_FAMILIES.join(', ')}`);
  const inst = sound.instrument as Partial<{
    pack: string;
    name: string;
    synth: string;
    params: Record<string, number>;
  }>;
  if (inst?.synth !== undefined) {
    if (!(SYNTH_PRESETS as readonly string[]).includes(inst.synth)) missing.push(`the ${inst.synth} synth`);
    else checkParams(`the ${inst.synth} synth`, inst.params, SYNTH_MACROS[inst.synth] ?? [], problems);
  } else if (!inst?.pack || !inst.name) problems.push('its instrument is neither a pack instrument nor a synth');
  const effect = (fx: SoundEffect, where: string) => {
    const def = pluginDef(fx.type);
    if (!def) {
      missing.push(`the "${fx.type}" effect`);
      return null;
    }
    checkParams(`${where} ${def.name}`, fx.params, def.params, problems);
    return def;
  };
  for (const fx of sound.inserts ?? []) effect(fx, 'its');
  if (sound.space) {
    const s = sound.space;
    if (!s.name?.trim()) problems.push('its room has no name');
    if (!['space', 'shimmer', 'reverb'].includes(s.type))
      problems.push(`its room is a "${s.type}", not a Space Designer, Shimmer or Space Reverb`);
    else effect(s, 'its room’s');
    if (typeof s.send !== 'number' || s.send < -60 || s.send > 6)
      problems.push(`its send is ${s.send} dB, outside −60…6`);
  }
  if (sound.volume !== undefined && (sound.volume < -60 || sound.volume > 12))
    problems.push(`its volume is ${sound.volume} dB, outside −60…12`);
  if (sound.pan !== undefined && (sound.pan < -1 || sound.pan > 1))
    problems.push(`its pan is ${sound.pan}, outside −1…1`);
  return { missing, problems };
}

function plugin(fx: SoundEffect, extra: Record<string, number> = {}): Plugin {
  const p = newPlugin(fx.type, { ...extra, ...fx.params });
  if (fx.settings && Object.keys(fx.settings).length) p.settings = { ...fx.settings };
  return p;
}

/** The track's instrument for a sound. */
export function soundInstrument(sound: PackSound): Instrument {
  const i = sound.instrument;
  if ('pack' in i) return { type: 'sampler', pack: i.pack, name: i.name };
  return {
    type: 'synth',
    preset: i.synth,
    ...(i.params && Object.keys(i.params).length ? { params: { ...i.params } } : {}),
  };
}

/** A room's bus already in the song: the bus of that name whose first effect is that kind of reverb. */
export function soundRoom(project: Pick<Project, 'buses'>, space: SoundSpace): Bus | undefined {
  return project.buses.find((b) => b.name === space.name && b.channel.inserts[0]?.type === space.type);
}

/**
 * The changes that add a sound to a song as a new track: its instrument, effects, level and pan, and
 * a send to its room (the room's bus made when the song hasn't one yet). Without a room, it sends to
 * the song's first bus as a new track does. Throws for a sound this engine can't play (checkSound).
 */
export function soundTrack(
  project: Pick<Project, 'buses'>,
  sound: PackSound,
  opts: { color?: string; index?: number } = {},
): { ops: Op[]; track: Track } {
  const { missing, problems } = checkSound(sound);
  if (missing.length)
    throw new Error(`${sound.name} needs ${missing.join(' and ')}, which this HO[LO] doesn't have yet`);
  if (problems.length) throw new Error(`${sound.name}: ${problems.join('; ')}`);
  const track = newTrack(sound.name, soundInstrument(sound), opts.color);
  for (const fx of sound.inserts ?? []) {
    const p = plugin(fx);
    if (pluginDef(fx.type)?.kind === 'midi') track.midiFx.push(p);
    else track.channel.inserts.push(p);
  }
  track.channel.volume = sound.volume ?? 0;
  track.channel.pan = sound.pan ?? 0;
  const ops: Op[] = [];
  if (sound.space) {
    let bus = soundRoom(project, sound.space);
    if (!bus) {
      bus = newBus(sound.space.name);
      // a room's bus is all room: none of the dry sound comes back through it
      const wet: Record<string, number> = sound.space.type === 'reverb' ? { mix: 100 } : { dry: -60 };
      bus.channel.inserts.push(plugin(sound.space, wet));
      ops.push({ op: 'addBus', bus });
    }
    track.channel.sends.push({ bus: bus.id, level: sound.space.send, pre: false });
  } else {
    const first = project.buses[0];
    if (first) track.channel.sends.push({ bus: first.id, level: -18, pre: false });
  }
  ops.push({ op: 'addTrack', track, ...(opts.index !== undefined ? { index: opts.index } : {}) });
  return { ops, track };
}
