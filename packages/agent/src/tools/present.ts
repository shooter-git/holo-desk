/**
 * A reply's view (view.ts) as the agent writes it, in the song's own names ("Vocal", "pitch.amount",
 * a version it named), turned into the ids the studio draws it with, or a plain reason it can't be:
 * a track that isn't there, a setting it hasn't got, a version never made, a command the studio
 * doesn't have.
 */
import { type MiddleC, type Project, parseNoteName, pluginDef, type Track } from '@holo/session';
import {
  type Action,
  AFTER,
  BEFORE,
  type Binding,
  type Block,
  bindingInfo,
  checkGo,
  checkView,
  type Go,
  mapRefs,
  PREVIOUS,
  viewCommands,
} from '../view.ts';
import { barTick, channelRef, position, type ToolContext, ToolError, trackRef } from './common.ts';
import { pluginRef } from './mix.ts';

/** The settings a binding can name, said the same way in the tool's description and its refusals. */
export const PARAMS_TEXT =
  'volume, pan, mute, solo, send:BUS, TYPE.PARAM (a plugin\'s setting: "pitch.amount", "eq#2.hsGain"; the plugins tool lists them) or TYPE.on (the plugin on or bypassed)';

/** A binding's setting from the model's words, resolved on its channel. */
function bindingParam(project: Project, track: string, spec: string): string {
  const ch = channelRef(project, track);
  const text = spec.trim();
  const lower = text.toLowerCase();
  if (['volume', 'pan', 'mute'].includes(lower)) return lower;
  if (lower === 'solo') {
    if (ch.kind !== 'track') throw new ToolError(`Only a track can be soloed, not ${ch.name}`);
    return 'solo';
  }
  if (lower.startsWith('send:')) {
    const name = text.slice(5).trim();
    const bus = project.buses.find((b) => b.id === name || b.name.toLowerCase() === name.toLowerCase());
    if (!bus) throw new ToolError(`No bus "${name}": ${project.buses.map((b) => b.name).join(', ') || 'none'}`);
    if (!ch.channel.sends.some((s) => s.bus === bus.id))
      throw new ToolError(`${ch.name} doesn't send to ${bus.name}: add the send first (track_set with sends)`);
    return `send:${bus.id}`;
  }
  const raw = /^fx:([^:]+):([^:]+)$/.exec(text);
  const dot = text.lastIndexOf('.');
  if (!raw && dot <= 0) throw new ToolError(`"${text}" isn't a setting: a setting is ${PARAMS_TEXT}`);
  const ref = raw ? (raw[1] as string) : text.slice(0, dot);
  const id = raw ? (raw[2] as string) : text.slice(dot + 1);
  const chain = [...ch.channel.inserts, ...(ch.track?.midiFx ?? [])];
  const plugin = pluginRef(ch.channel.inserts, ref) ?? (ch.track ? pluginRef(ch.track.midiFx, ref) : undefined);
  if (!plugin)
    throw new ToolError(
      `${ch.name} has no ${ref}: its plugins are ${chain.map((p) => p.type).join(', ') || 'none'} (fx add puts one on)`,
    );
  if (/^(on|bypass)$/i.test(id)) return `on:${plugin.id}`;
  const def = pluginDef(plugin.type);
  const param =
    def?.params.find((p) => p.id === id) ?? def?.params.find((p) => p.name.toLowerCase() === id.toLowerCase());
  if (!def || !param)
    throw new ToolError(
      `${def?.name ?? plugin.type} has no "${id}": ${def?.params.map((p) => p.id).join(', ') ?? ''}, or on`,
    );
  return `fx:${plugin.id}:${param.id}`;
}

/** A region by id, or by its name (on the track given, or the only one of that name). */
function regionId(project: Project, ref: string, track: Track | undefined): string {
  const all = project.tracks.flatMap((t) => t.regions.map((r) => ({ t, r })));
  const byId = all.find((x) => x.r.id === ref);
  if (byId) return byId.r.id;
  const named = all.filter(
    (x) => (!track || x.t.id === track.id) && x.r.name.toLowerCase() === ref.trim().toLowerCase(),
  );
  if (named.length === 1) return (named[0] as { r: { id: string } }).r.id;
  throw new ToolError(
    named.length
      ? `"${ref}" names ${named.length} regions: say which by its id (regions with show lists them)`
      : `No region "${ref}"${track ? ` on ${track.name}` : ''} (regions with show lists them)`,
  );
}

/** The parts of the song a view's references are checked against. */
interface Refs {
  project: Project;
  middleC: MiddleC;
  versions: readonly string[];
  commands: readonly { id: string; title: string }[] | null;
}

function goOf(refs: Refs, g: Go): Go {
  const { project } = refs;
  const out: Go = { ...g };
  if (g.bar !== undefined) barTick(project, g.bar);
  let track: Track | undefined;
  if (g.track !== undefined) {
    const ch = channelRef(project, g.track);
    out.track = ch.id;
    track = ch.track;
    if (g.plugin !== undefined) {
      const plugin = pluginRef(ch.channel.inserts, g.plugin) ?? (track ? pluginRef(track.midiFx, g.plugin) : undefined);
      if (!plugin) throw new ToolError(`${ch.name} has no plugin "${g.plugin}"`);
      out.plugin = plugin.id;
    }
  }
  if (g.region !== undefined) out.region = regionId(project, g.region, track);
  if (g.notes) {
    if (!track) throw new ToolError(`Notes are a track's: "${g.track}" is a bus or the master`);
    const from = position(project, String(g.notes.from), 'notes "from"');
    const to = position(project, String(g.notes.to), 'notes "to"');
    if (to <= from) throw new ToolError('The notes\' "to" comes after "from"');
    let pitch: number | undefined;
    if (typeof g.notes.pitch === 'number') pitch = g.notes.pitch;
    else if (typeof g.notes.pitch === 'string') {
      try {
        pitch = Math.round(parseNoteName(g.notes.pitch, refs.middleC));
      } catch {
        throw new ToolError(
          `"${g.notes.pitch}" isn't a note: write it as E4 (middle C is ${refs.middleC}) or a MIDI number`,
        );
      }
      if (pitch < 0 || pitch > 127) throw new ToolError(`${g.notes.pitch} is out of MIDI's range`);
    }
    out.notes = { from: g.notes.from, to: g.notes.to, ...(pitch !== undefined ? { pitch } : {}) };
  }
  return out;
}

/** A block of the resolved view at a time, its own kind of check (what mapping each reference can't see). */
function checkBlock(refs: Refs, b: Block): void {
  const { project } = refs;
  const info = (bind: Binding) => {
    const i = bindingInfo(project, bind);
    if (!i) throw new ToolError('That setting is gone from the song');
    return i;
  };
  const span = (track: string, from: number, kind: 'notes' | 'wave') => {
    barTick(project, from);
    const t = project.tracks.find((x) => x.id === track) as Track;
    if (kind === 'wave' && t.kind !== 'audio')
      throw new ToolError(`${t.name} has notes, not a recording: show it with notes`);
  };
  const action = (a: Action) => {
    if ('play' in a) barTick(project, a.play.from);
    if ('set' in a) {
      const i = info(a.set);
      if (a.value < i.min || a.value > i.max)
        throw new ToolError(
          `${i.channel}'s ${i.name} goes from ${i.min} to ${i.max}${i.unit ? ` ${i.unit}` : ''} (got ${a.value})`,
        );
    }
  };
  if ('row' in b) {
    for (const c of b.row) checkBlock(refs, c);
  } else if ('group' in b) {
    for (const c of b.group) checkBlock(refs, c);
  } else if ('table' in b) {
    for (const r of b.table.rows) for (const c of r) if (typeof c === 'object') checkBlock(refs, c);
  } else if ('list' in b) {
    for (const it of b.list) if (it.do) action(it.do);
  } else if ('button' in b) {
    action(b.do);
  } else if ('choice' in b) {
    for (const c of b.choice) action(c.do);
  } else if ('slider' in b) {
    const i = info(b.slider);
    if (i.kind !== 'number')
      throw new ToolError(
        `${i.channel}'s ${i.name} is ${i.kind === 'switch' ? 'on or off: use a toggle' : 'a choice of options: use a choice of set buttons'}`,
      );
    for (const end of [b.min, b.max])
      if (end !== undefined && (end < i.min || end > i.max))
        throw new ToolError(`${i.channel}'s ${i.name} goes from ${i.min} to ${i.max}${i.unit ? ` ${i.unit}` : ''}`);
  } else if ('toggle' in b) {
    const i = info(b.toggle);
    if (i.kind !== 'switch') throw new ToolError(`${i.channel}'s ${i.name} isn't on or off: use a slider`);
  } else if ('notes' in b) {
    span(b.notes.track, b.notes.from, 'notes');
  } else if ('wave' in b) {
    span(b.wave.track, b.wave.from, 'wave');
  }
}

/**
 * The view and the go finish was given, in the song's ids, checked as the studio will check them.
 * Throws a ToolError saying what to fix.
 */
export async function resolvePresentation(
  ctx: ToolContext,
  rawView: unknown,
  rawGo: unknown,
): Promise<{ view?: Block[]; go?: Go }> {
  if (rawView === undefined && rawGo === undefined) return {};
  const written = rawView === undefined ? null : checkView(rawView);
  if (written && !written.ok) throw new ToolError(written.error);
  const writtenGo = rawGo === undefined ? null : checkGo(rawGo);
  if (writtenGo && !writtenGo.ok) throw new ToolError(writtenGo.error);
  const project = await ctx.api.song();
  const blocks = written?.ok ? written.blocks : [];
  const wanted = viewCommands(blocks);
  const commands = wanted.length ? (await ctx.api.commands()).commands : null;
  const refs: Refs = { project, middleC: ctx.middleC, versions: ctx.memory.versions, commands };
  const out: { view?: Block[]; go?: Go } = {};
  if (written?.ok) {
    const resolved = mapRefs(blocks, {
      track: (name) => trackRef(project, name).id,
      binding: (b) => {
        const track = channelRef(project, b.track).id;
        return { track, param: bindingParam(project, track, b.param) };
      },
      go: (g) => goOf(refs, g),
      version: (v) => {
        if (v === BEFORE || v === AFTER || v === PREVIOUS || refs.versions.includes(v)) return v;
        throw new ToolError(
          `No version "${v}": the versions are "before", "after", "previous"${refs.versions.map((x) => `, "${x}"`).join('')} (the version tool names the song as it is)`,
        );
      },
      command: (id) => {
        if (refs.commands?.some((c) => c.id === id)) return id;
        throw new ToolError(
          `The studio has no command "${id}"${refs.commands?.length ? `: ${refs.commands.map((c) => c.id).join(', ')}` : ' it can run now'}`,
        );
      },
    });
    for (const b of resolved) checkBlock(refs, b);
    const strict = checkView(resolved, true);
    if (!strict.ok) throw new ToolError(strict.error);
    out.view = strict.blocks;
  }
  if (writtenGo?.ok) {
    const strict = checkGo(goOf(refs, writtenGo.go), true);
    if (!strict.ok) throw new ToolError(strict.error);
    out.go = strict.go;
  }
  return out;
}
