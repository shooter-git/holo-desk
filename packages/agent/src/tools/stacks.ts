/**
 * Track stacks, for the agent: tracks kept together under one header in the studio (a folder), and,
 * when the stack has a bus, mixed through it (a summing stack). Being in a stack routes nothing: where
 * a track's sound goes is its own output, and this tool changes it only in so many words, in the same
 * step, and says that it did.
 */
import { applyOps, newBus, newId, type Op, type Project, type Stack, stackBlocks, type Track } from '@holo/session';
import { bool, change, need, num, plural, str, type Tool, ToolError, trackRef } from './common.ts';

const ACTIONS = ['show', 'make', 'rename', 'add', 'remove', 'bus', 'move', 'unstack'] as const;

const list = (names: string[]): string =>
  names.length > 1 ? `${names.slice(0, -1).join(', ')} and ${names.at(-1)}` : (names[0] ?? '');

/** A stack by its name (or the start of it) or id. */
export function stackRef(project: Project, ref: string | undefined): Stack {
  const stacks = project.stacks ?? [];
  const names = stacks.map((s) => `"${s.name}"`).join(', ') || 'none yet';
  const text = ref?.trim();
  if (!text) throw new ToolError(`Say which stack. The stacks: ${names}`);
  const lower = text.toLowerCase();
  const exact = stacks.find((s) => s.id === text) ?? stacks.find((s) => s.name.toLowerCase() === lower);
  if (exact) return exact;
  const starts = stacks.filter((s) => s.name.toLowerCase().startsWith(lower));
  if (starts.length === 1) return starts[0] as Stack;
  throw new ToolError(
    starts.length
      ? `"${text}" could be ${list(starts.map((s) => `"${s.name}"`))}: say more of its name`
      : `No stack "${text}". The stacks: ${names}`,
  );
}

const busName = (project: Project, id: string | undefined): string =>
  id ? (project.buses.find((b) => b.id === id)?.name ?? id) : 'Stereo Out';
const outName = (project: Project, id: string): string => (id === 'master' ? 'Stereo Out' : busName(project, id));

/** A stack in a few lines: its tracks, its bus, and which of its tracks play through it. */
export function stackText(project: Project, stack: Stack): string {
  const members = project.tracks.filter((t) => t.stack === stack.id);
  const head = `"${stack.name}" [${stack.id}]: ${list(members.map((t) => t.name))}`;
  if (!stack.bus)
    return `${head}. A folder: its tracks play where they did (${list([...new Set(members.map((t) => outName(project, t.channel.output)))])}).`;
  const through = members.filter((t) => t.channel.output === stack.bus);
  const not = members.filter((t) => t.channel.output !== stack.bus);
  return `${head}. Its header controls the bus ${busName(project, stack.bus)} [${stack.bus}]${
    not.length
      ? `; ${through.length ? `${list(through.map((t) => t.name))} play through it, ` : ''}${list(not.map((t) => `${t.name} (to ${outName(project, t.channel.output)})`))} ${not.length > 1 ? 'do' : 'does'} not`
      : ': all its tracks play through it'
  }.`;
}

/** A track put into a stack (at the end of it), and routed to its bus when that's asked and it has one. */
export function joinOps(project: Project, stack: Stack, track: Track, route: boolean): { ops: Op[]; routed: boolean } {
  const ops: Op[] = [{ op: 'moveTrack', track: track.id, index: project.tracks.length, stack: stack.id }];
  const routed = route && !!stack.bus && track.channel.output !== stack.bus;
  if (routed) ops.push({ op: 'updateChannel', target: track.id, patch: { output: stack.bus as string } });
  return { ops, routed };
}

/** A track taken out of its stack (to just after it), and back to Stereo Out when that's asked and it played through the stack's bus. */
export function leaveOps(project: Project, stack: Stack, track: Track, route: boolean): { ops: Op[]; routed: boolean } {
  const end = stackBlocks(project.tracks).get(stack.id)?.end ?? project.tracks.length;
  const ops: Op[] = [{ op: 'moveTrack', track: track.id, index: end - 1, stack: null }];
  const routed = route && !!stack.bus && track.channel.output === stack.bus;
  if (routed) ops.push({ op: 'updateChannel', target: track.id, patch: { output: 'master' } });
  return { ops, routed };
}

/** The bus a "bus" argument means: a new one named after the stack, or one the song has, by name or id. */
function busFor(project: Project, text: string, name: string): { id: string; ops: Op[]; made: boolean } {
  if (text.trim().toLowerCase() === 'new') {
    const bus = newBus(name);
    return { id: bus.id, ops: [{ op: 'addBus', bus }], made: true };
  }
  const lower = text.trim().toLowerCase();
  const bus =
    project.buses.find((b) => b.id === text.trim()) ?? project.buses.find((b) => b.name.toLowerCase() === lower);
  if (!bus)
    throw new ToolError(
      `No bus "${text}": ${project.buses.map((b) => `"${b.name}"`).join(', ') || 'the song has none'}. "new" makes one for the stack.`,
    );
  return { id: bus.id, ops: [], made: false };
}

export const stack: Tool = {
  name: 'stack',
  kind: 'change',
  summary:
    'Track stacks: tracks kept together under one header in the studio, which folds them away and mutes or solos them together (a folder); with a bus, the header controls that bus and the tracks are mixed through it (a summing stack: one fader, one chain of effects for the group). With no action it lists them. {"action": "make", "name": "Strings", "tracks": ["Violins I", "Violins II", "Violas"]} makes a folder; add "bus": "new" for a summing stack (a bus named after it is made and the tracks are routed to it, which changes what\'s heard only by the bus\'s own fader and effects), or "bus": "Hall" for a bus the song has. "add" and "remove" put tracks in and take them out; "bus" gives a stack a bus ("new", or a name) or takes it away ("off"); "rename"; "move" (index: its place in the track list); "unstack" takes the stack apart and leaves the tracks where they are. Being in a stack never routes a track by itself: when this tool changes where a track plays (into the stack\'s bus on joining, back to Stereo Out on leaving) it says so, and "route": false leaves every output alone. Taking a bus away or unstacking leaves the tracks playing through the bus as they were ("route": true sends them back to Stereo Out).',
  args: [
    { name: 'action', type: 'enum', values: ACTIONS, describe: 'What to do', default: 'show' },
    { name: 'stack', type: 'string', describe: 'The stack: its name (or the start of it) or id', maxLength: 80 },
    { name: 'name', type: 'string', describe: 'make: its name; rename: the new name', maxLength: 60 },
    {
      name: 'tracks',
      type: 'array',
      items: 'string',
      describe: 'make, add, remove: tracks by name or id',
      maxLength: 64,
    },
    {
      name: 'bus',
      type: 'string',
      describe: 'make, bus: "new" (a bus for the stack), a bus by name, or "off"',
      maxLength: 80,
    },
    {
      name: 'route',
      type: 'boolean',
      describe:
        'Whether tracks are sent to the stack\'s bus as they join and back to Stereo Out as they leave (yes, unless said); for "off" and unstack, whether they go back to Stereo Out (no, unless said)',
    },
    {
      name: 'index',
      type: 'integer',
      describe: 'move: the place of its first track in the track list, 1 at the top',
      min: 1,
    },
    { name: 'color', type: 'string', describe: 'make, rename: a color, as #rrggbb', maxLength: 9 },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const action = (str(args, 'action') ?? 'show') as (typeof ACTIONS)[number];
    const stacks = project.stacks ?? [];
    if (action === 'show') {
      if (str(args, 'stack')) return { text: stackText(project, stackRef(project, str(args, 'stack'))) };
      return {
        text: stacks.length
          ? `The stacks:\n${stacks.map((s) => `  ${stackText(project, s)}`).join('\n')}`
          : 'The song has no stacks. {"action": "make", "name": …, "tracks": […]} makes one.',
      };
    }
    const tracks = ((args.tracks as unknown[] | undefined) ?? []).map((t) => trackRef(project, String(t)));
    const route = bool(args, 'route');
    const busText = str(args, 'bus')?.trim();
    const color = str(args, 'color')?.trim();
    if (color && !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color))
      throw new ToolError('A color is #rrggbb, e.g. "#5cb8ff"');
    const ops: Op[] = [];
    const said: string[] = [];
    let label: string;
    let id: string;

    if (action === 'make') {
      const name = need(args, 'name').trim();
      if (!tracks.length) throw new ToolError('Say which "tracks" go in the stack');
      if (stacks.some((s) => s.name.toLowerCase() === name.toLowerCase()))
        throw new ToolError(`There's a stack called "${name}" already: "add" puts tracks into it`);
      const made: Stack = { id: newId('stk'), name, ...(color ? { color } : {}) };
      id = made.id;
      if (busText && busText.toLowerCase() !== 'off') {
        const bus = busFor(project, busText, name);
        ops.push(...bus.ops);
        made.bus = bus.id;
        said.push(bus.made ? `a new bus "${name}" for it` : `its header controls the bus ${busName(project, bus.id)}`);
      }
      ops.push({ op: 'addStack', stack: made, tracks: tracks.map((t) => t.id) });
      if (made.bus && route !== false) {
        const moved = tracks.filter((t) => t.channel.output !== made.bus);
        for (const t of moved) ops.push({ op: 'updateChannel', target: t.id, patch: { output: made.bus } });
        if (moved.length)
          said.push(`${list(moved.map((t) => t.name))} now ${moved.length > 1 ? 'play' : 'plays'} through it`);
      }
      const was = [...new Set(tracks.map((t) => t.stack).filter(Boolean))];
      if (was.length)
        said.push(`taken out of ${list(was.map((s) => `"${stacks.find((x) => x.id === s)?.name ?? s}"`))}`);
      label = `Stacked ${list(tracks.map((t) => t.name))} as "${name}"`;
    } else {
      const s = stackRef(project, str(args, 'stack'));
      id = s.id;
      const members = project.tracks.filter((t) => t.stack === s.id);
      switch (action) {
        case 'rename': {
          const name = str(args, 'name')?.trim();
          if (!name && !color) throw new ToolError('Say the new "name" (or a "color")');
          ops.push({
            op: 'updateStack',
            stack: s.id,
            patch: { ...(name ? { name } : {}), ...(color ? { color } : {}) },
          });
          label = name ? `Stack "${s.name}" renamed "${name}"` : `Stack "${s.name}" recolored`;
          break;
        }
        case 'add': {
          if (!tracks.length) throw new ToolError('Say which "tracks" to put in');
          const joining = tracks.filter((t) => t.stack !== s.id);
          if (!joining.length)
            throw new ToolError(
              `${list(tracks.map((t) => t.name))} ${tracks.length > 1 ? 'are' : 'is'} in "${s.name}" already`,
            );
          // each on the song as the last left it (a track's place depends on those before it)
          let song = project;
          const routed: string[] = [];
          for (const t of joining) {
            const now = song.tracks.find((x) => x.id === t.id) as Track;
            const step = joinOps(song, s, now, route !== false);
            ops.push(...step.ops);
            song = applyOps(song, step.ops);
            if (step.routed) routed.push(t.name);
          }
          if (routed.length)
            said.push(`${list(routed)} now ${routed.length > 1 ? 'play' : 'plays'} through ${busName(project, s.bus)}`);
          label = `${list(joining.map((t) => t.name))} into the stack "${s.name}"`;
          break;
        }
        case 'remove': {
          if (!tracks.length) throw new ToolError('Say which "tracks" to take out');
          const leaving = tracks.filter((t) => t.stack === s.id);
          if (!leaving.length)
            throw new ToolError(
              `${list(tracks.map((t) => t.name))} ${tracks.length > 1 ? "aren't" : "isn't"} in "${s.name}"`,
            );
          let song = project;
          const routed: string[] = [];
          for (const t of leaving) {
            const now = song.tracks.find((x) => x.id === t.id) as Track;
            const step = leaveOps(song, s, now, route !== false);
            ops.push(...step.ops);
            song = applyOps(song, step.ops);
            if (step.routed) routed.push(t.name);
          }
          if (routed.length) said.push(`${list(routed)} now ${routed.length > 1 ? 'play' : 'plays'} to Stereo Out`);
          if (leaving.length === members.length) said.push('that was its last track: the stack is gone');
          label = `${list(leaving.map((t) => t.name))} out of the stack "${s.name}"`;
          break;
        }
        case 'bus': {
          if (!busText) throw new ToolError('Say the "bus": "new", a bus by name, or "off"');
          if (busText.toLowerCase() === 'off') {
            if (!s.bus) throw new ToolError(`"${s.name}" has no bus: it's a folder`);
            ops.push({ op: 'updateStack', stack: s.id, patch: { bus: null } });
            const through = members.filter((t) => t.channel.output === s.bus);
            if (route === true) {
              for (const t of through) ops.push({ op: 'updateChannel', target: t.id, patch: { output: 'master' } });
              if (through.length)
                said.push(
                  `${list(through.map((t) => t.name))} now ${through.length > 1 ? 'play' : 'plays'} to Stereo Out`,
                );
            } else if (through.length)
              said.push(
                `${list(through.map((t) => t.name))} still ${through.length > 1 ? 'play' : 'plays'} through ${busName(project, s.bus)} ("route": true sends them back to Stereo Out)`,
              );
            label = `Stack "${s.name}": a folder again`;
          } else {
            const bus = busFor(project, busText, s.name);
            if (bus.id === s.bus) throw new ToolError(`"${s.name}" has that bus already`);
            ops.push(...bus.ops, { op: 'updateStack', stack: s.id, patch: { bus: bus.id } });
            if (route !== false) {
              const moved = members.filter((t) => t.channel.output !== bus.id);
              for (const t of moved) ops.push({ op: 'updateChannel', target: t.id, patch: { output: bus.id } });
              if (moved.length)
                said.push(`${list(moved.map((t) => t.name))} now ${moved.length > 1 ? 'play' : 'plays'} through it`);
            }
            label = `Stack "${s.name}": mixed through ${bus.made ? `a new bus "${s.name}"` : busName(project, bus.id)}`;
          }
          break;
        }
        case 'move': {
          const index = num(args, 'index');
          if (index === undefined) throw new ToolError('Say the "index": the place of its first track, 1 at the top');
          ops.push({ op: 'moveStack', stack: s.id, index: Math.min(project.tracks.length, index) - 1 });
          label = `Stack "${s.name}" moved to place ${index}`;
          break;
        }
        case 'unstack': {
          ops.push({ op: 'removeStack', stack: s.id });
          const through = s.bus ? members.filter((t) => t.channel.output === s.bus) : [];
          if (route === true) {
            for (const t of through) ops.push({ op: 'updateChannel', target: t.id, patch: { output: 'master' } });
            if (through.length)
              said.push(
                `${list(through.map((t) => t.name))} now ${through.length > 1 ? 'play' : 'plays'} to Stereo Out`,
              );
          } else if (through.length)
            said.push(
              `${list(through.map((t) => t.name))} still ${through.length > 1 ? 'play' : 'plays'} through the bus ${busName(project, s.bus)}, which is still there`,
            );
          label = `Unstacked "${s.name}" (${plural(members.length, 'track')} stay where they are)`;
          break;
        }
      }
    }
    await change(ctx, project, ops, label);
    const after = await ctx.api.song();
    const now = after.stacks?.find((x) => x.id === id);
    return {
      text: `${label}${said.length ? `: ${said.join('; ')}` : ''}.${now ? `\n${stackText(after, now)}` : ''}`,
      progress: label,
    };
  },
};

export const stackTools: Tool[] = [stack];
