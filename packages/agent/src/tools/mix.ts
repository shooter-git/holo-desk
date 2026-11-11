/**
 * The mix: plugins on tracks, buses and the master, automation lanes, the master's finish, and the
 * list of the stock plugins with their parameters.
 */
import {
  automationTargets,
  formatParam,
  newPlugin,
  type Op,
  PLUGINS,
  type Plugin,
  type PluginDef,
  pluginDef,
  tickToBarBeat,
} from '@holo/session';
import {
  bool,
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

export const fx: Tool = {
  name: 'fx',
  kind: 'change',
  summary:
    'Plugins on a track, a bus or the master ("target": a track or bus name, or "master"). action "show" lists what\'s there with every value; "add" puts a plugin of "plugin" type on it (audio effects in its inserts, MIDI effects before a track\'s instrument) with optional "params"; "set" changes a plugin\'s "params" or "bypass"; "remove" takes it off. "plugin" is a type ("reverb") or a plugin id from show; params are numbers by parameter id (a choice may be given by its option name). Examples: {"action": "add", "target": "Keys", "plugin": "harmonizer", "params": {"key": 9, "scale": 6, "voice1": 2}}; {"action": "set", "target": "master", "plugin": "limiter", "params": {"ceiling": -1}}.',
  args: [
    { name: 'action', type: 'enum', values: ['show', 'add', 'set', 'remove'], describe: 'What to do', required: true },
    { name: 'target', type: 'string', describe: 'A track or bus name (or id), or "master"', required: true },
    { name: 'plugin', type: 'string', describe: 'A plugin type ("compressor") or a plugin id (fx_…)' },
    { name: 'params', type: 'object', describe: 'Parameter values by id, e.g. {"mix": 30, "decay": 2.5}' },
    { name: 'bypass', type: 'boolean', describe: 'With set: bypass the plugin (true) or turn it back on (false)' },
    { name: 'index', type: 'integer', describe: 'With add: its place in the chain, 1 first', min: 1 },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const target = channelRef(project, str(args, 'target'));
    const action = str(args, 'action');
    const midi = target.track?.midiFx ?? [];
    const chain = [...midi, ...target.channel.inserts];
    if (action === 'show') {
      return {
        text: chain.length
          ? [`${target.name}:`, ...chain.map((p) => `  ${pluginText(p)}`)].join('\n')
          : `${target.name} has no plugins.`,
      };
    }
    const ref = need(args, 'plugin');
    const given = obj(args, 'params') ?? {};
    if (action === 'add') {
      const def = pluginDef(ref) ?? PLUGINS.find((p) => p.name.toLowerCase() === ref.toLowerCase());
      if (!def) throw new ToolError(`No plugin type "${ref}": ${PLUGINS.map((p) => p.type).join(', ')}`);
      const slot = def.kind === 'midi' ? 'midiFx' : 'inserts';
      if (slot === 'midiFx' && target.kind !== 'track') throw new ToolError('MIDI effects go on tracks');
      const plugin = newPlugin(def.type, knobValues(given, def.params, def.name));
      const index = num(args, 'index');
      const label = `${def.name} on ${target.name}`;
      await change(
        ctx,
        project,
        [{ op: 'addPlugin', target: target.id, slot, plugin, ...(index !== undefined ? { index: index - 1 } : {}) }],
        label,
      );
      return { text: `${label}: ${pluginText(plugin)}.`, progress: label };
    }
    const plugin =
      chain.find((p) => p.id === ref) ??
      chain.find((p) => p.type === ref) ??
      chain.find((p) => pluginDef(p.type)?.name.toLowerCase() === ref.toLowerCase());
    if (!plugin)
      throw new ToolError(
        `No "${ref}" on ${target.name}. It has: ${chain.map((p) => `${p.type} (${p.id})`).join(', ') || 'nothing'}`,
      );
    const def = pluginDef(plugin.type);
    if (action === 'remove') {
      const label = `Removed ${def?.name ?? plugin.type} from ${target.name}`;
      await change(ctx, project, [{ op: 'removePlugin', target: target.id, plugin: plugin.id }], label);
      return { text: `${label}.`, progress: label };
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

export const automate: Tool = {
  name: 'automate',
  kind: 'change',
  summary:
    'An automation lane on a track, a bus or the master ("target"; "master" for the master): how a setting moves through the song. "param" is volume (dB), pan (-1..1), mute (0/1), distance (0 near … 1 far, for a channel on a stage), send:BUS (dB, e.g. send:Reverb) or TYPE.PARAM for a plugin\'s parameter (e.g. reverb.mix, on the first reverb there). "points" are position=value pairs, e.g. "9=-24 13=-6 17.3=-6 21=-30"; between them the value moves in a line ("smooth" eases it). "action" clear removes the lane, off keeps it but stops it playing, read turns it back on.',
  args: [
    { name: 'target', type: 'string', describe: 'A track or bus name (or id), or "master"', required: true },
    { name: 'param', type: 'string', describe: 'volume, pan, mute, distance, send:BUS or TYPE.PARAM', required: true },
    { name: 'points', type: 'string', describe: 'position=value pairs, e.g. "9=-24 13=-6 17=-6"', maxLength: 4000 },
    { name: 'smooth', type: 'boolean', describe: 'Ease between the points instead of straight lines' },
    {
      name: 'action',
      type: 'enum',
      values: ['set', 'clear', 'off', 'read'],
      describe: 'set (the default) writes the points',
      default: 'set',
    },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const target = channelRef(project, str(args, 'target'));
    const spec = need(args, 'param');
    let param = spec;
    if (/^send:/i.test(spec)) {
      const busName = spec.slice(5).trim().toLowerCase();
      const bus = project.buses.find((b) => b.name.toLowerCase() === busName || b.id === spec.slice(5).trim());
      if (!bus)
        throw new ToolError(`No bus "${spec.slice(5)}": ${project.buses.map((b) => b.name).join(', ') || 'none'}`);
      param = `send:${bus.id}`;
    } else if (spec.includes('.')) {
      const [type, id] = spec.split('.') as [string, string];
      const plugin = target.channel.inserts.find((p) => p.type === type);
      if (!plugin) throw new ToolError(`${target.name} has no ${type}: add it first (fx add)`);
      const def = pluginDef(type);
      if (def && !def.params.some((p) => p.id === id))
        throw new ToolError(`${def.name} has no "${id}": ${def.params.map((p) => p.id).join(', ')}`);
      param = `fx:${plugin.id}:${id}`;
    } else if (spec === 'distance') {
      if (!target.channel.stage)
        throw new ToolError(`${target.name} isn't on a stage (the mixer's Stage slot puts it on one)`);
    } else if (!['volume', 'pan', 'mute'].includes(spec)) {
      throw new ToolError('"param" is volume, pan, mute, distance, send:BUS or TYPE.PARAM (e.g. reverb.mix)');
    }
    const known = automationTargets(project, target.channel).find((t) => t.param === param);
    const name = known?.name ?? spec;
    const action = str(args, 'action') ?? 'set';
    const lane = target.channel.automation?.find((a) => a.param === param);
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
