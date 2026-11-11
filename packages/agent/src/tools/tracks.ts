/**
 * Tracks and what plays them: a new track, a track's settings, a synth's or a kit's own knobs, and
 * the list of what can play (the built-in synths and the installed packs' instruments).
 */
import {
  type ChannelPatch,
  type Instrument,
  macroValues,
  newTrack,
  type Op,
  type PackSound,
  SYNTH_FAMILIES,
  SYNTH_MACROS,
  SYNTH_NOTES,
  SYNTH_PRESETS,
  samplerKnobs,
  samplerKnobValue,
  soundTrack,
  TRACK_COLORS,
  type TrackPatch,
} from '@holo/session';
import type { JobApi, PackSummary } from '../api.ts';
import { bool, change, knobValues, need, num, obj, plural, str, type Tool, ToolError, trackRef } from './common.ts';

/**
 * An instrument as the model names it: "synth:Warm Pad" or a preset's bare name, or "pack/name" for
 * an installed pack's instrument. A pack that isn't installed is refused here, with what to do.
 */
export async function instrumentRef(api: JobApi, spec: string): Promise<Instrument> {
  const text = spec.trim();
  const bare = text.replace(/^synth:\s*/i, '').replace(/^"(.*)"$/, '$1');
  const preset = SYNTH_PRESETS.find((p) => p.toLowerCase() === bare.toLowerCase());
  if (preset) return { type: 'synth', preset };
  if (/^synth:/i.test(text))
    throw new ToolError(`No built-in synth "${bare}": the instruments tool lists them (e.g. synth:Soft Keys)`);
  const [pack, name, extra] = text.split('/');
  if (!pack || !name || extra !== undefined)
    throw new ToolError(
      `"${text}" isn't an instrument: use a built-in synth ("synth:Warm Pad") or an installed pack's "pack/name" (the instruments tool lists both)`,
    );
  const packs = await api.packs();
  const found = packs.find((p) => p.id === pack);
  if (!found)
    throw new ToolError(
      `The pack "${pack}" isn't installed. Installed: ${packs.map((p) => p.id).join(', ') || 'none'}. To install one, ask_permission {kind: "install-pack"}.`,
    );
  const inst =
    found.instruments.find((i) => i.name === name) ??
    found.instruments.find((i) => i.name.toLowerCase() === name.toLowerCase());
  if (!inst)
    throw new ToolError(`${pack} has no instrument "${name}": ${found.instruments.map((i) => i.name).join(', ')}`);
  return { type: 'sampler', pack, name: inst.name };
}

/** A palette's ready-made sound by "pack/Sound name". */
function soundRef(packs: PackSummary[], spec: string): PackSound {
  const at = spec.indexOf('/');
  const pack = packs.find((p) => p.id === spec.slice(0, at));
  const name = spec.slice(at + 1).toLowerCase();
  const sound = pack?.sounds?.find((s) => s.name.toLowerCase() === name);
  if (!pack || !sound)
    throw new ToolError(`No sound "${spec}": the packs tool lists each palette's sounds as pack/Sound name`);
  return sound as unknown as PackSound;
}

const describeInstrument = (i: Instrument): string =>
  i.type === 'synth' ? `synth:${i.preset}` : i.type === 'sampler' ? `${i.pack}/${i.name}` : i.type;

export const trackAdd: Tool = {
  name: 'track_add',
  kind: 'change',
  summary:
    'Add an instrument track. "instrument" is a built-in synth ("synth:Soft Keys", "synth:Warm Pad", "synth:Fat Mono") or an installed pack\'s instrument ("vsco2/violins_pizz"); "sound" is instead a palette\'s ready-made sound ("pack/Sound name", with its effects, room and level). The instruments and packs tools list them. A new track sends a little to the song\'s first reverb bus. Example: {"name": "Counter-melody", "instrument": "synth:Soft Keys"}.',
  args: [
    { name: 'name', type: 'string', describe: "The track's name", required: true, maxLength: 60 },
    { name: 'instrument', type: 'string', describe: 'synth:PRESET or pack/name', default: 'synth:Soft Keys' },
    { name: 'sound', type: 'string', describe: "A palette's sound, pack/Sound name (instead of instrument)" },
    { name: 'volume', type: 'number', describe: 'Fader in dB (0 is unity)', min: -60, max: 12 },
    { name: 'pan', type: 'number', describe: '-1 (left) to 1 (right)', min: -1, max: 1 },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const name = need(args, 'name');
    const color = TRACK_COLORS[project.tracks.length % TRACK_COLORS.length];
    let ops: Op[];
    let what: string;
    const soundSpec = str(args, 'sound');
    if (soundSpec) {
      const sound = soundRef(await ctx.api.packs(), soundSpec);
      let made: ReturnType<typeof soundTrack>;
      try {
        made = soundTrack(project, sound, color ? { color } : {});
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      made.track.name = name;
      ops = made.ops;
      what = `the sound ${soundSpec}`;
    } else {
      const instrument = await instrumentRef(ctx.api, str(args, 'instrument') ?? 'synth:Soft Keys');
      const track = newTrack(name, instrument, color);
      const reverb = project.buses[0];
      if (reverb) track.channel.sends.push({ bus: reverb.id, level: -18, pre: false });
      ops = [{ op: 'addTrack', track }];
      what = describeInstrument(instrument);
    }
    const added = ops.find((o) => o.op === 'addTrack');
    if (added?.op === 'addTrack') {
      const v = num(args, 'volume');
      const p = num(args, 'pan');
      if (v !== undefined) added.track.channel.volume = v;
      if (p !== undefined) added.track.channel.pan = p;
    }
    const same = project.tracks.some((t) => t.name.toLowerCase() === name.toLowerCase());
    const label = `New track ${name} (${what})`;
    await change(ctx, project, ops, label);
    return {
      text: `${label}.${same ? ` Another track is also called "${name}": refer to this one by its id from song_show.` : ''}`,
      progress: label,
    };
  },
};

export const trackSet: Tool = {
  name: 'track_set',
  kind: 'change',
  summary:
    'Change a track: its name, fader (volume in dB, 0 is unity), pan (-1 left … 1 right), mute, solo, record arm, instrument ("synth:PRESET" or "pack/name"), its place in the track list (1 is the top), or its sends to buses ({"Reverb": -12}, in dB; -144 or less is off). Example: {"track": "Strings", "volume": -4, "pan": -0.3}.',
  args: [
    { name: 'track', type: 'string', describe: 'The track: its name (or the start of it) or id', required: true },
    { name: 'name', type: 'string', describe: 'A new name', maxLength: 60 },
    { name: 'volume', type: 'number', describe: 'Fader in dB', min: -144, max: 12 },
    { name: 'pan', type: 'number', describe: '-1 (left) to 1 (right)', min: -1, max: 1 },
    { name: 'mute', type: 'boolean', describe: 'Mute it' },
    { name: 'solo', type: 'boolean', describe: 'Solo it' },
    { name: 'armed', type: 'boolean', describe: 'Arm it to record live MIDI' },
    { name: 'instrument', type: 'string', describe: 'synth:PRESET or pack/name' },
    { name: 'index', type: 'integer', describe: 'Its place in the track list, 1 at the top', min: 1 },
    { name: 'sends', type: 'object', describe: 'Send levels by bus name, in dB, e.g. {"Reverb": -12}' },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const track = trackRef(project, str(args, 'track'));
    const ops: Op[] = [];
    const done: string[] = [];
    const ch: ChannelPatch = {};
    const volume = num(args, 'volume');
    const pan = num(args, 'pan');
    const mute = bool(args, 'mute');
    const solo = bool(args, 'solo');
    if (volume !== undefined) {
      ch.volume = volume;
      done.push(`volume ${volume} dB`);
    }
    if (pan !== undefined) {
      ch.pan = pan;
      done.push(`pan ${pan}`);
    }
    if (mute !== undefined) {
      ch.mute = mute;
      done.push(mute ? 'muted' : 'unmuted');
    }
    if (solo !== undefined) {
      ch.solo = solo;
      done.push(solo ? 'solo' : 'solo off');
    }
    const sends = obj(args, 'sends');
    if (sends) {
      const next = track.channel.sends.slice();
      for (const [busName, level] of Object.entries(sends)) {
        const bus = project.buses.find((b) => b.name.toLowerCase() === busName.toLowerCase() || b.id === busName);
        if (!bus)
          throw new ToolError(`No bus "${busName}": ${project.buses.map((b) => `"${b.name}"`).join(', ') || 'none'}`);
        const db = Number(level);
        if (!Number.isFinite(db) || db > 12) throw new ToolError(`A send level is dB, at most 12 (got ${level})`);
        const i = next.findIndex((s) => s.bus === bus.id);
        if (i >= 0) next[i] = { ...(next[i] as (typeof next)[number]), level: db };
        else next.push({ bus: bus.id, level: db, pre: false });
        done.push(`send to ${bus.name} ${db} dB`);
      }
      ch.sends = next;
    }
    if (Object.keys(ch).length) ops.push({ op: 'updateChannel', target: track.id, patch: ch });
    const tp: TrackPatch = {};
    const name = str(args, 'name')?.trim();
    if (name) {
      tp.name = name;
      done.push(`renamed ${name}`);
    }
    const armed = bool(args, 'armed');
    if (armed !== undefined) {
      tp.armed = armed;
      done.push(armed ? 'armed' : 'disarmed');
    }
    const spec = str(args, 'instrument');
    if (spec) {
      if (track.kind === 'audio') throw new ToolError(`${track.name} is an audio track: it has no instrument`);
      tp.instrument = await instrumentRef(ctx.api, spec);
      done.push(`instrument ${describeInstrument(tp.instrument)}`);
    }
    if (Object.keys(tp).length) ops.push({ op: 'updateTrack', track: track.id, patch: tp });
    const index = num(args, 'index');
    if (index !== undefined) {
      ops.push({ op: 'moveTrack', track: track.id, index: Math.min(project.tracks.length, index) - 1 });
      done.push(`moved to place ${index}`);
    }
    if (!ops.length)
      throw new ToolError('Say what to change: name, volume, pan, mute, solo, armed, instrument, index or sends');
    const label = `${track.name}: ${done.join(', ')}`;
    await change(ctx, project, ops, label);
    return { text: `${label}.`, progress: label };
  },
};

function knobLines(
  defs: { id: string; name: string; min: number; max: number; unit?: string; options?: string[] }[],
  value: (id: string) => number,
): string[] {
  return defs.map((d) => {
    const range = d.options
      ? d.options.map((o, i) => `${i}=${o}`).join(' ')
      : `${d.min}..${d.max}${d.unit ? ` ${d.unit}` : ''}`;
    return `  ${d.id}: ${Math.round(value(d.id) * 1000) / 1000} (${range}) ${d.name}`;
  });
}

export const synthSet: Tool = {
  name: 'synth_set',
  kind: 'change',
  summary: `A built-in synth's own knobs on a track: without "knobs" it lists them with their values and ranges; with "knobs" ({"cutoff": 500, "glide": 0.12}) it sets them. Synths with knobs: ${Object.keys(SYNTH_MACROS).join(', ')}. A stepped knob takes its option's number. To change the preset itself, use track_set's instrument.`,
  args: [
    { name: 'track', type: 'string', describe: 'The track: its name (or the start of it) or id', required: true },
    { name: 'knobs', type: 'object', describe: 'Knob values by id, e.g. {"cutoff": 450, "drive": 0.7}' },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const track = trackRef(project, str(args, 'track'));
    const inst = track.instrument;
    const defs = inst.type === 'synth' ? SYNTH_MACROS[inst.preset] : undefined;
    if (inst.type !== 'synth' || !defs)
      throw new ToolError(
        `${track.name} plays ${describeInstrument(inst)}, which has no knobs here. Synths with knobs: ${Object.keys(SYNTH_MACROS).join(', ')}`,
      );
    const knobs = obj(args, 'knobs');
    if (!knobs || !Object.keys(knobs).length) {
      const now = macroValues(inst.preset, inst.params);
      return { text: [`${track.name}: synth:${inst.preset}`, ...knobLines(defs, (id) => now[id] ?? 0)].join('\n') };
    }
    const params = knobValues(knobs, defs, inst.preset);
    const label = `${track.name}'s ${inst.preset}: ${Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`;
    await change(
      ctx,
      project,
      [
        {
          op: 'updateTrack',
          track: track.id,
          patch: { instrument: { ...inst, params: { ...inst.params, ...params } } },
        },
      ],
      label,
    );
    return { text: `${label}.`, progress: label };
  },
};

export const kitSet: Tool = {
  name: 'kit_set',
  kind: 'change',
  summary:
    'A sampled kit\'s (or multi-microphone instrument\'s) own knobs on a track: each microphone\'s level ("mic:room", "mic:overheads", in dB; -60 is off), "tune" (semitones) and "decay" (% of each hit\'s ring kept). Without "knobs" it lists them; with "knobs" ({"mic:room": -6, "tune": -1, "decay": 70}) it sets them.',
  args: [
    { name: 'track', type: 'string', describe: 'The track: its name (or the start of it) or id', required: true },
    { name: 'knobs', type: 'object', describe: 'Knob values by id, e.g. {"mic:room": -6, "decay": 70}' },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const track = trackRef(project, str(args, 'track'));
    const inst = track.instrument;
    if (inst.type !== 'sampler') throw new ToolError(`${track.name} plays no sample-pack instrument`);
    const m = await ctx.api.instrument(inst.pack, inst.name);
    if (!m.pads?.length && m.pitched !== false && !m.mics?.length)
      throw new ToolError(`${inst.pack}/${inst.name} isn't a kit and has no microphones of its own`);
    const defs = samplerKnobs(m.mics);
    const knobs = obj(args, 'knobs');
    if (!knobs || !Object.keys(knobs).length) {
      return {
        text: [
          `${track.name}: ${inst.pack}/${inst.name}`,
          ...knobLines(defs, (id) => samplerKnobValue(defs, inst.params, id)),
        ].join('\n'),
      };
    }
    const params = knobValues(knobs, defs, `${inst.pack}/${inst.name}`);
    const label = `${track.name}'s kit: ${Object.entries(params)
      .map(([k, v]) => `${k}=${v}`)
      .join(' ')}`;
    await change(
      ctx,
      project,
      [
        {
          op: 'updateTrack',
          track: track.id,
          patch: { instrument: { ...inst, params: { ...inst.params, ...params } } },
        },
      ],
      label,
    );
    return { text: `${label}.`, progress: label };
  },
};

/** The most instrument lines listed at once. */
const LIST_MAX = 250;

export const instruments: Tool = {
  name: 'instruments',
  kind: 'see',
  summary:
    'What can play a track: the built-in synths by family (as "synth:NAME") and every installed pack\'s instruments (as "pack/name", with title and category). "search" narrows the list by words in names, titles, categories and descriptions (e.g. "cello", "pad", "drum"), and shows what each synth sounds like.',
  args: [
    { name: 'search', type: 'string', describe: 'Words to look for, e.g. "strings" or "pizzicato"', maxLength: 60 },
  ],
  async run(ctx, args) {
    const query = str(args, 'search')?.trim().toLowerCase();
    const fits = (...texts: (string | undefined)[]) =>
      !query || query.split(/\s+/).every((w) => texts.some((t) => t?.toLowerCase().includes(w)));
    const lines: string[] = ['Built-in synths (instrument "synth:NAME"):'];
    for (const family of SYNTH_FAMILIES) {
      const presets = family.presets.filter((p) => fits(p, family.name, SYNTH_NOTES[p]));
      if (!presets.length) continue;
      if (query)
        for (const p of presets) lines.push(`  synth:${p} [${family.name}]: ${SYNTH_NOTES[p] ?? ''}`.trimEnd());
      else lines.push(`  ${family.name}: ${presets.join(', ')}`);
    }
    const packs = await ctx.api.packs();
    let listed = 0;
    let more = 0;
    lines.push('Installed packs (instrument "pack/name"):');
    for (const p of packs) {
      const items = p.instruments.filter((i) => fits(i.name, i.title, i.category, p.name, p.id));
      if (!items.length) continue;
      lines.push(`  ${p.name} (${p.id})`);
      for (const i of items) {
        if (listed >= LIST_MAX) {
          more++;
          continue;
        }
        listed++;
        lines.push(`    ${p.id}/${i.name}  ${i.title} [${i.category}]${i.kit ? ' (kit: kit_set)' : ''}`);
      }
    }
    if (!packs.length) lines.push('  none');
    if (more) lines.push(`  … ${plural(more, 'more')}: narrow it with "search"`);
    if (query && lines.length <= 2 + (packs.length ? 0 : 1)) lines.push(`Nothing matches "${query}".`);
    return { text: lines.join('\n') };
  },
};

export const trackTools: Tool[] = [trackAdd, trackSet, synthSet, kitSet, instruments];
