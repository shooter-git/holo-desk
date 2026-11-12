/**
 * The mix: plugins on tracks, buses and the master, automation lanes, the master's finish, and the
 * list of the stock plugins with their parameters.
 */
import {
  automationTargets,
  type Channel,
  formatParam,
  type KeyPoint,
  keysOf,
  keyText,
  keyTonic,
  newPlugin,
  type Op,
  PLUGINS,
  type Plugin,
  type PluginDef,
  type Project,
  pluginDef,
  SCALES,
  tickToBarBeat,
} from '@holo/session';
import {
  bool,
  type ChannelRef,
  change,
  channelRef,
  knobValues,
  need,
  num,
  obj,
  plural,
  position,
  str,
  type Tool,
  ToolError,
} from './common.ts';
import { posText } from './regions.ts';

const paramLine = (p: PluginDef['params'][number]): string =>
  p.options
    ? `${p.id} (${p.options.map((o, i) => `${i}=${o}`).join(' ')}; default ${p.default})`
    : `${p.id} ${p.min}..${p.max}${p.unit ? ` ${p.unit}` : ''} (default ${p.default})`;

export const plugins: Tool = {
  name: 'plugins',
  kind: 'see',
  summary:
    "The stock plugins: each type, what it does, and whether it's an audio effect (on a track, a bus or the master) or a MIDI effect (before a track's instrument: arpeggiator, harmonizer, chord…). With \"type\" it lists that plugin's parameters, ranges, units and defaults (choices are numbered options).",
  args: [{ name: 'type', type: 'string', describe: 'A plugin type, e.g. "compressor" or "harmonizer"', maxLength: 40 }],
  async run(_ctx, args) {
    const type = str(args, 'type')?.trim();
    if (type) {
      const def = pluginDef(type) ?? PLUGINS.find((p) => p.name.toLowerCase() === type.toLowerCase());
      if (!def) throw new ToolError(`No plugin "${type}": ${PLUGINS.map((p) => p.type).join(', ')}`);
      return {
        text: [
          `${def.type} (${def.name}, ${def.kind === 'midi' ? 'MIDI effect' : 'audio effect'}): ${def.description}`,
          ...def.params.map((p) => `  ${paramLine(p)}  ${p.name}`),
        ].join('\n'),
      };
    }
    return {
      text: PLUGINS.map(
        (p) =>
          `${p.type} (${p.name}, ${p.kind === 'midi' ? 'MIDI' : 'audio'}): ${p.description} Params: ${p.params.map((x) => x.id).join(', ')}`,
      ).join('\n'),
    };
  },
};

const pluginText = (p: Plugin): string => {
  const def = pluginDef(p.type);
  const values = def
    ? def.params.map((d) => `${d.id}=${formatParam(d, p.params[d.id] ?? d.default)}`).join(', ')
    : Object.entries(p.params)
        .map(([k, v]) => `${k}=${v}`)
        .join(', ');
  return `${def?.name ?? p.type} [${p.type}, ${p.id}]${p.bypass ? ' (bypassed)' : ''}: ${values}`;
};

/**
 * A plugin in a chain: by its id (fx_…), its type or its name ("eq", "Channel EQ"), the first of
 * them; "eq#2" is the second of them.
 */
export function pluginRef(chain: readonly Plugin[], ref: string): Plugin | undefined {
  const text = ref.trim();
  const byId = chain.find((p) => p.id === text);
  if (byId) return byId;
  const m = /^(.*?)\s*#\s*(\d+)$/.exec(text);
  const kind = (m ? (m[1] as string) : text).trim().toLowerCase();
  const same = chain.filter((p) => p.type.toLowerCase() === kind || pluginDef(p.type)?.name.toLowerCase() === kind);
  return same[(m ? Number(m[2]) : 1) - 1];
}

/** How a plugin is named back to the model: its type, and "#2" when it isn't the first of its type there. */
function pluginLabel(chain: readonly Plugin[], p: Plugin): string {
  const same = chain.filter((x) => x.type === p.type);
  const k = same.indexOf(p) + 1;
  return k > 1 ? `${p.type}#${k}` : p.type;
}

const NO_KEY = { key: undefined, scale: undefined } as const;

/** The song's key as a plugin's key (0 C … 11 B) and scale (an index in SCALES), from a key point. */
function keyValues(project: Project, k: KeyPoint | undefined): { key?: number; scale?: number } {
  if (!k) return NO_KEY;
  const tonic = keyTonic(k);
  const letter = 'C D EF G A B'.indexOf(tonic[0] as string);
  let pc = letter;
  for (const a of tonic.slice(1)) pc += a === '#' ? 1 : -1;
  const named: Record<string, string> = {
    major: 'Major',
    minor: 'Natural minor',
    dorian: 'Dorian',
    phrygian: 'Phrygian',
    lydian: 'Lydian',
    mixolydian: 'Mixolydian',
    locrian: 'Locrian',
  };
  let scale = named[k.mode] ?? 'Major';
  // the song's own words say which minor, at the start
  if (k.mode === 'minor' && k.tick === 0 && /harmonic/i.test(project.key ?? '')) scale = 'Harmonic minor';
  if (k.mode === 'minor' && k.tick === 0 && /melodic/i.test(project.key ?? '')) scale = 'Melodic minor';
  return { key: ((pc % 12) + 12) % 12, scale: SCALES.findIndex((s) => s.name === scale) };
}

export const fx: Tool = {
  name: 'fx',
  kind: 'change',
  summary:
    'Plugins on a track, a bus or the master ("target": a track or bus name, or "master"). action "show" lists what\'s there, in order, with every value; "add" puts a plugin of "plugin" type on it (audio effects in its inserts, MIDI effects before a track\'s instrument) with optional "params" and "index" (1 first); a plugin with a key and scale (Harmonizer, Scale Quantizer, Pitch Correction) takes the song\'s key unless "params" say otherwise; "set" changes a plugin\'s "params" or "bypass"; "move" puts it at "index", or "before" or "after" another; "remove" takes it off. "plugin" is a type ("reverb", the first one there), "eq#2" (the second), or a plugin id from show; params are numbers by parameter id (a choice may be given by its option name). Examples: {"action": "add", "target": "Keys", "plugin": "harmonizer", "params": {"voice1": 2}}; {"action": "move", "target": "Vocal", "plugin": "reverb", "before": "delay"}; {"action": "set", "target": "master", "plugin": "limiter", "params": {"ceiling": -1}}.',
  args: [
    {
      name: 'action',
      type: 'enum',
      values: ['show', 'add', 'set', 'move', 'remove'],
      describe: 'What to do',
      required: true,
    },
    { name: 'target', type: 'string', describe: 'A track or bus name (or id), or "master"', required: true },
    { name: 'plugin', type: 'string', describe: 'A plugin type ("compressor"), "eq#2", or a plugin id (fx_…)' },
    { name: 'params', type: 'object', describe: 'Parameter values by id, e.g. {"mix": 30, "decay": 2.5}' },
    { name: 'bypass', type: 'boolean', describe: 'With set: bypass the plugin (true) or turn it back on (false)' },
    { name: 'index', type: 'integer', describe: 'With add or move: its place in the chain, 1 first', min: 1 },
    { name: 'before', type: 'string', describe: 'With move: the plugin it goes before' },
    { name: 'after', type: 'string', describe: 'With move: the plugin it goes after' },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const target = channelRef(project, str(args, 'target'));
    const action = str(args, 'action');
    const midi = target.track?.midiFx ?? [];
    const inserts = target.channel.inserts;
    const chain = [...midi, ...inserts];
    if (action === 'show') {
      if (!chain.length) return { text: `${target.name} has no plugins.` };
      return {
        text: [
          `${target.name}:`,
          ...midi.map((p, i) => `  MIDI ${i + 1}. ${pluginText(p)}`),
          ...inserts.map((p, i) => `  ${i + 1}. ${pluginText(p)}`),
        ].join('\n'),
      };
    }
    const ref = need(args, 'plugin');
    const given = obj(args, 'params') ?? {};
    if (action === 'add') {
      const def = pluginDef(ref) ?? PLUGINS.find((p) => p.name.toLowerCase() === ref.toLowerCase());
      if (!def) throw new ToolError(`No plugin type "${ref}": ${PLUGINS.map((p) => p.type).join(', ')}`);
      const slot = def.kind === 'midi' ? 'midiFx' : 'inserts';
      if (slot === 'midiFx' && target.kind !== 'track') throw new ToolError('MIDI effects go on tracks');
      const values = knobValues(given, def.params, def.name);
      // a plugin that plays in a key plays in the song's, unless told otherwise
      const keys = keysOf(project);
      const hasKey = def.params.some((p) => p.id === 'key');
      const hasScale = def.params.some((p) => p.id === 'scale');
      const fromSong = keyValues(project, keys[0]);
      const filled: string[] = [];
      if (hasKey && values.key === undefined && fromSong.key !== undefined) {
        values.key = fromSong.key;
        filled.push('key');
      }
      if (hasScale && values.scale === undefined && fromSong.scale !== undefined && fromSong.scale >= 0) {
        values.scale = fromSong.scale;
        filled.push('scale');
      }
      const plugin = newPlugin(def.type, values);
      const index = num(args, 'index');
      const label = `${def.name} on ${target.name}`;
      const ops: Op[] = [
        { op: 'addPlugin', target: target.id, slot, plugin, ...(index !== undefined ? { index: index - 1 } : {}) },
      ];
      const notes: string[] = [];
      if (filled.length && keys[0]) notes.push(`in the song's key, ${keyText(keys[0])}`);
      if (filled.length && keys.length > 1) {
        if (slot === 'inserts') {
          // the key changes through the song: automation follows them
          for (const id of filled as ('key' | 'scale')[]) {
            const points = keys.map((k): [number, number] => [k.tick, keyValues(project, k)[id] ?? 0]);
            if (points.some((p) => p[1] !== points[0]?.[1]))
              ops.push({
                op: 'setAutomation',
                target: target.id,
                param: `fx:${plugin.id}:${id}`,
                points,
                mode: 'read',
              });
          }
          if (ops.length > 1) notes.push('its automation follows the key changes');
        } else
          notes.push(
            `it stays in ${keyText(keys[0] as KeyPoint)} where the song changes key (a MIDI effect has no automation)`,
          );
      }
      await change(ctx, project, ops, label);
      return {
        text: `${label}${notes.length ? `, ${notes.join('; ')}` : ''}: ${pluginText(plugin)}.`,
        progress: label,
      };
    }
    const plugin = pluginRef(chain, ref);
    if (!plugin)
      throw new ToolError(
        `No "${ref}" on ${target.name}. It has: ${chain.map((p) => `${pluginLabel(chain, p)} (${p.id})`).join(', ') || 'nothing'}`,
      );
    const def = pluginDef(plugin.type);
    if (action === 'remove') {
      const label = `Removed ${def?.name ?? plugin.type} from ${target.name}`;
      await change(ctx, project, [{ op: 'removePlugin', target: target.id, plugin: plugin.id }], label);
      return { text: `${label}.`, progress: label };
    }
    if (action === 'move') {
      const list = midi.includes(plugin) ? midi : inserts;
      const rest = list.filter((p) => p !== plugin);
      const beforeText = str(args, 'before');
      const afterText = str(args, 'after');
      const index = num(args, 'index');
      let to: number;
      if (beforeText || afterText) {
        const other = pluginRef(list, (beforeText ?? afterText) as string);
        if (!other || other === plugin)
          throw new ToolError(
            `No other "${beforeText ?? afterText}" in ${list === midi ? 'the MIDI effects' : 'the inserts'} of ${target.name}: ${list.map((p) => pluginLabel(list, p)).join(', ')}`,
          );
        to = rest.indexOf(other) + (beforeText ? 0 : 1);
      } else if (index !== undefined) to = Math.min(index - 1, rest.length);
      else throw new ToolError('Say where it goes: "index" (1 first), "before" or "after" another plugin');
      if (to === list.indexOf(plugin)) return { text: `${def?.name ?? plugin.type} is there already.` };
      const order = [...rest];
      order.splice(to, 0, plugin);
      const label = `Moved ${def?.name ?? plugin.type} on ${target.name} to place ${to + 1}`;
      await change(ctx, project, [{ op: 'movePlugin', target: target.id, plugin: plugin.id, index: to }], label);
      return {
        text: `${label}: ${order.map((p) => pluginDef(p.type)?.name ?? p.type).join(' → ')}.`,
        progress: label,
      };
    }
    const params = def ? knobValues(given, def.params, def.name) : {};
    const bypass = bool(args, 'bypass');
    if (!Object.keys(params).length && bypass === undefined) throw new ToolError('Say "params" or "bypass" to set');
    const op: Op = {
      op: 'updatePlugin',
      target: target.id,
      plugin: plugin.id,
      patch: { ...(Object.keys(params).length ? { params } : {}), ...(bypass !== undefined ? { bypass } : {}) },
    };
    const said = [
      ...Object.entries(params).map(([k, v]) => `${k}=${v}`),
      ...(bypass !== undefined ? [bypass ? 'bypassed' : 'on'] : []),
    ];
    const label = `${def?.name ?? plugin.type} on ${target.name}: ${said.join(' ')}`;
    await change(ctx, project, [op], label);
    return { text: `${label}.`, progress: label };
  },
};

/**
 * A lane's param from the model's words: volume, pan, mute, distance, send:BUS, a plugin's parameter
 * as TYPE.PARAM (the first of that type), TYPE#2.PARAM (the second), PLUGIN_ID.PARAM, or the lane's
 * own name (fx:ID:PARAM).
 */
function laneParam(project: Project, target: ChannelRef, spec: string): string {
  if (/^send:/i.test(spec)) {
    const name = spec.slice(5).trim();
    const bus = project.buses.find((b) => b.name.toLowerCase() === name.toLowerCase() || b.id === name);
    if (!bus) throw new ToolError(`No bus "${name}": ${project.buses.map((b) => b.name).join(', ') || 'none'}`);
    return `send:${bus.id}`;
  }
  if (['volume', 'pan', 'mute'].includes(spec)) return spec;
  if (spec === 'distance') {
    if (!target.channel.stage)
      throw new ToolError(`${target.name} isn't on a stage (the mixer's Stage slot puts it on one)`);
    return spec;
  }
  const inserts = target.channel.inserts;
  const raw = /^fx:([^:]+):([^:]+)$/.exec(spec);
  const dot = spec.lastIndexOf('.');
  if (!raw && dot <= 0)
    throw new ToolError(
      '"param" is volume, pan, mute, distance, send:BUS, or a plugin\'s TYPE.PARAM (e.g. reverb.mix, eq#2.high_gain, fx_….mix)',
    );
  const ref = raw ? (raw[1] as string) : spec.slice(0, dot);
  const id = raw ? (raw[2] as string) : spec.slice(dot + 1);
  const plugin = pluginRef(inserts, ref);
  if (!plugin) {
    if (target.track && pluginRef(target.track.midiFx, ref))
      throw new ToolError(`${ref} is a MIDI effect: MIDI effects' settings can't be automated, only audio effects'`);
    throw new ToolError(
      `${target.name} has no ${ref}: add it first (fx add). Its effects: ${inserts.map((p) => pluginLabel(inserts, p)).join(', ') || 'none'}`,
    );
  }
  const def = pluginDef(plugin.type);
  const param =
    def?.params.find((p) => p.id === id) ?? def?.params.find((p) => p.name.toLowerCase() === id.toLowerCase());
  if (def && !param) throw new ToolError(`${def.name} has no "${id}": ${def.params.map((p) => p.id).join(', ')}`);
  return `fx:${plugin.id}:${param?.id ?? id}`;
}

/** A lane's param in the model's words, the way back. */
function paramWords(project: Project, channel: Channel, param: string): string {
  if (param.startsWith('send:')) {
    const bus = project.buses.find((b) => b.id === param.slice(5));
    return bus ? `send:${bus.name}` : param;
  }
  const fxParam = /^fx:([^:]+):([^:]+)$/.exec(param);
  if (!fxParam) return param;
  const plugin = channel.inserts.find((p) => p.id === fxParam[1]);
  return plugin ? `${pluginLabel(channel.inserts, plugin)}.${fxParam[2]}` : param;
}

export const automate: Tool = {
  name: 'automate',
  kind: 'change',
  summary:
    'Automation on a track, a bus or the master ("target"; "master" for the master): how a setting moves through the song. action "list" gives every setting there that can move (with its range, its value now, and its lane if it has one); "show" a lane\'s points; "set" (the default) writes "points", position=value pairs, e.g. "9=-24 13=-6 17.3=-6 21=-30" (between them the value moves in a line; "smooth" eases it); "clear" removes the lane, "off" keeps it but stops it playing, "read" turns it back on. "param" is volume (dB), pan (-1..1), mute (0/1), distance (0 near … 1 far, for a channel on a stage), send:BUS (dB, e.g. send:Reverb), or an audio effect\'s parameter: TYPE.PARAM for the first of that type (reverb.mix), TYPE#2.PARAM for the second (eq#2.high_gain), or PLUGIN_ID.PARAM.',
  args: [
    { name: 'target', type: 'string', describe: 'A track or bus name (or id), or "master"', required: true },
    {
      name: 'param',
      type: 'string',
      describe: 'volume, pan, mute, distance, send:BUS, TYPE.PARAM, TYPE#2.PARAM or fx_ID.PARAM',
    },
    { name: 'points', type: 'string', describe: 'position=value pairs, e.g. "9=-24 13=-6 17=-6"', maxLength: 4000 },
    { name: 'smooth', type: 'boolean', describe: 'Ease between the points instead of straight lines' },
    {
      name: 'action',
      type: 'enum',
      values: ['set', 'list', 'show', 'clear', 'off', 'read'],
      describe: 'set (the default) writes the points',
      default: 'set',
    },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const target = channelRef(project, str(args, 'target'));
    const action = str(args, 'action') ?? 'set';
    const targets = automationTargets(project, target.channel);
    if (action === 'list') {
      const lines = targets.map((t) => {
        const lane = target.channel.automation?.find((a) => a.param === t.param);
        const range =
          t.stepped && t.min === 0 && t.max === 1 ? '0/1' : `${t.min}..${t.max}${t.unit ? ` ${t.unit}` : ''}`;
        const fxId = /^fx:([^:]+):/.exec(t.param)?.[1];
        return `  ${paramWords(project, target.channel, t.param)} (${t.name}${fxId ? `, ${fxId}` : ''}): ${range}${t.stepped && t.param !== 'mute' ? ', in steps' : ''}, now ${Math.round(t.value * 1000) / 1000}${lane ? `; lane: ${plural(lane.points.length, 'point')}${lane.mode === 'off' ? ', off' : ''}${lane.curve === 'smooth' ? ', smooth' : ''}` : ''}`;
      });
      return { text: [`${target.name}: what can be automated`, ...lines].join('\n') };
    }
    const spec = need(args, 'param');
    const param = laneParam(project, target, spec);
    const known = targets.find((t) => t.param === param);
    const name = known?.name ?? spec;
    const lane = target.channel.automation?.find((a) => a.param === param);
    if (action === 'show') {
      if (!lane) return { text: `${target.name} has no ${name} automation.` };
      return {
        text: `${target.name}: ${name} (${paramWords(project, target.channel, param)}), ${lane.mode === 'off' ? 'off' : 'read'}${lane.curve === 'smooth' ? ', smooth' : ''}: ${lane.points
          .map(([t, v]) => `${posText(project, t)}=${Math.round(v * 1000) / 1000}`)
          .join(' ')}`,
      };
    }
    if (action !== 'set') {
      if (!lane) throw new ToolError(`${target.name} has no ${spec} automation`);
      const label = `${target.name}: ${name} automation ${action === 'clear' ? 'removed' : action}`;
      await change(
        ctx,
        project,
        [
          {
            op: 'setAutomation',
            target: target.id,
            param,
            points: action === 'clear' ? [] : lane.points,
            mode: action === 'off' ? 'off' : 'read',
          },
        ],
        label,
      );
      return { text: `${label}.`, progress: label };
    }
    const words = (str(args, 'points') ?? '')
      .trim()
      .split(/[\s,]+/)
      .filter(Boolean);
    if (!words.length) throw new ToolError('Give the points, e.g. "9=-24 13=-6 17=-6"');
    const points = words.map((w): [number, number] => {
      const m = /^([\d.]+|t:\d+)=(-?[\d.]+)$/.exec(w);
      if (!m) throw new ToolError(`"${w}": points are position=value, e.g. 9=-12 or 9.3=0.5`);
      const value = Number(m[2]);
      if (known && (value < known.min || value > known.max))
        throw new ToolError(`${name} goes from ${known.min} to ${known.max} (got ${value})`);
      return [position(project, m[1] as string), value];
    });
    const smooth = bool(args, 'smooth');
    const curve = smooth === undefined ? undefined : smooth ? 'smooth' : 'linear';
    const first = tickToBarBeat(project.meter, Math.min(...points.map((p) => p[0]))).bar;
    const last = tickToBarBeat(project.meter, Math.max(...points.map((p) => p[0]))).bar;
    const label = `${target.name}: ${name} automation, bars ${first}–${last} (${plural(points.length, 'point')}${curve === 'smooth' ? ', smooth' : ''})`;
    await change(
      ctx,
      project,
      [{ op: 'setAutomation', target: target.id, param, points, mode: 'read', ...(curve ? { curve } : {}) }],
      label,
    );
    return { text: `${label}.`, progress: label };
  },
};

export const finishMaster: Tool = {
  name: 'finish_master',
  kind: 'change',
  summary:
    'How bounces and renders are mastered (the live mix plays without it): integrated loudness ("lufs", e.g. -16 for streaming, -14 louder), a true-peak "ceiling" (dBTP, e.g. -1), "glue" compression on the loud parts, a "lowcut" (Hz) and a high-shelf "tilt" at 9 kHz (dB). Values left out keep what\'s set (or the defaults -16, -1, glue on, 28 Hz, 0 dB). {"off": true} removes the finish.',
  args: [
    { name: 'lufs', type: 'number', describe: 'Loudness target in LUFS, e.g. -16', min: -40, max: -5 },
    { name: 'ceiling', type: 'number', describe: 'True-peak ceiling in dBTP, e.g. -1', min: -12, max: 0 },
    { name: 'glue', type: 'boolean', describe: 'Glue compression (about 2 dB at 1.8:1) on the loud parts' },
    { name: 'lowcut', type: 'number', describe: 'Low cut in Hz', min: 10, max: 200 },
    { name: 'tilt', type: 'number', describe: 'High shelf at 9 kHz, in dB', min: -6, max: 6 },
    { name: 'off', type: 'boolean', describe: 'No finish', default: false },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    if (bool(args, 'off')) {
      await change(ctx, project, [{ op: 'setProject', patch: { finish: null } }], 'No finish');
      return { text: 'Bounces and renders are no longer finished.', progress: 'No finish' };
    }
    const was = project.finish;
    const next = {
      lufs: num(args, 'lufs') ?? was?.lufs ?? -16,
      ceiling: num(args, 'ceiling') ?? was?.ceiling ?? -1,
      glue: bool(args, 'glue') ?? was?.glue ?? true,
      lowcut: num(args, 'lowcut') ?? was?.lowcut ?? 28,
      tilt: num(args, 'tilt') ?? was?.tilt ?? 0,
    };
    const label = `Finish: ${next.lufs} LUFS, ceiling ${next.ceiling} dBTP${next.glue ? ', glue' : ''}`;
    await change(ctx, project, [{ op: 'setProject', patch: { finish: next } }], label);
    return { text: `${label}, low cut ${next.lowcut} Hz, tilt ${next.tilt} dB.`, progress: label };
  },
};

export const mixTools: Tool[] = [plugins, fx, automate, finishMaster];
