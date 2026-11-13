/**
 * The song as a whole: what's open and where the user is, its overview, and its settings (title,
 * tempo, meter, key, markers, the cycle, a loop). Also the raw operations, for what no other tool
 * covers.
 */
import {
  barToTick,
  type KeyPoint,
  keysOf,
  type MeterPoint,
  meterAt,
  newId,
  type Op,
  type Project,
  type ProjectPatch,
  parseKey,
  projectEnd,
  type TempoPoint,
  ticksPerBar,
  tickToBarBeat,
} from '@holo/session';
import { ApiError } from '../api.ts';
import { barOf, barsText, bool, change, need, num, plural, position, str, type Tool, ToolError } from './common.ts';

const at = (project: Project, tick: number): string => {
  const p = tickToBarBeat(project.meter, tick);
  return `${p.bar}.${p.beat}.${p.div}`;
};

export const songStatus: Tool = {
  name: 'song_status',
  kind: 'see',
  summary: ({ middleC }) =>
    `Where the user is now: the song's title, who it's by, its album and creation, tempo, meter, key and length; its tracks; the playhead (bar.beat.sixteenth) and whether it's playing; what's selected; the cycle; the editor in front; and how note names are written here (middle C, MIDI 60, is ${middleC}). Cheap: call it first, and again after the user may have moved.`,
  args: [],
  async run(ctx) {
    const [state, project] = await Promise.all([ctx.api.state(), ctx.api.song()]);
    const bars = barOf(project, projectEnd(project) - 1);
    const m = project.meter[0];
    const lines = [
      `"${project.title}": ${project.tempo[0]?.bpm ?? 120} bpm, ${m ? `${m.num}/${m.den}` : '4/4'}, ${project.key ?? 'no key set'}, ${plural(bars, 'bar')}`,
      ...(Array.isArray(state.about) ? state.about.filter((l): l is string => typeof l === 'string') : []),
      `Tracks: ${
        project.tracks
          .map((t) => `${t.name}${t.channel.mute ? ' (muted)' : ''}${t.channel.solo ? ' (solo)' : ''}`)
          .join(', ') || 'none'
      }`,
    ];
    if (typeof state.playhead === 'number')
      lines.push(
        `Playhead: ${at(project, state.playhead)}${state.recording ? ' (recording)' : state.playing ? ' (playing)' : ' (stopped)'}`,
      );
    const sel = state.selection;
    if (sel) {
      const track = sel.track ? (project.tracks.find((t) => t.id === sel.track)?.name ?? sel.track) : null;
      const bits = [
        track ? `track ${track}` : 'no track',
        sel.regions?.length ? plural(sel.regions.length, 'region') : '',
        sel.notes ? plural(sel.notes, 'note') : '',
        typeof sel.from === 'number' && typeof sel.to === 'number' && sel.to > sel.from
          ? barsText(project, sel.from, sel.to)
          : '',
      ].filter(Boolean);
      lines.push(`Selected: ${bits.join(', ')}`);
    }
    const cycle = state.cycle ?? project.cycle;
    lines.push(`Cycle: ${cycle.on ? `on, ${barsText(project, cycle.start, cycle.end)}` : 'off'}`);
    if (state.view) lines.push(`View: ${state.view}`);
    if (state.scan) lines.push(`Scan window open on scan ${state.scan}`);
    lines.push(`Note names: middle C (MIDI 60) is ${ctx.middleC}.`);
    return { text: lines.join('\n') };
  },
};

export const songShow: Tool = {
  name: 'song_show',
  kind: 'see',
  summary:
    'The whole song as text: tempo and meter changes, key, length, cycle, markers, repeats, mastering, and every track (id in [brackets], instrument, regions, note count, bars it spans, level, pan, plugins, automation) and bus. Read it before changing anything; use notes_show or score_show for the notes themselves.',
  args: [],
  async run(ctx) {
    return { text: (await ctx.api.describe()).text };
  },
};

/** "3/4", "6/8", "7/8 2+2+3" or "7/8 (2+2+3)". */
function parseMeter(text: string): Pick<MeterPoint, 'num' | 'den' | 'groups'> {
  const m = /^\s*(\d{1,2})\s*\/\s*(\d{1,2})\s*(?:\(?\s*(\d+(?:\s*\+\s*\d+)+)\s*\)?)?\s*$/.exec(text);
  const n = Number(m?.[1]);
  const d = Number(m?.[2]);
  if (!m || n < 1 || n > 32 || ![1, 2, 4, 8, 16, 32].includes(d))
    throw new ToolError(`"${text}" isn't a meter: use e.g. "3/4", "6/8" or "7/8 2+2+3"`);
  if (!m[3]) return { num: n, den: d };
  const groups = m[3].split('+').map((g) => Number(g.trim()));
  const eighths = (n * 8) / d;
  if (groups.reduce((a, b) => a + b, 0) !== eighths)
    throw new ToolError(`The groups of ${n}/${d} are eighth notes and add up to ${eighths}`);
  return { num: n, den: d, groups };
}

export const songSet: Tool = {
  name: 'song_set',
  kind: 'change',
  summary:
    'Change the song\'s settings: title, tempo (bpm), key ("D minor", "Bb major", "A lydian"; "none" clears it) and meter ("3/4", "6/8", "7/8 2+2+3" with the grouping in eighths). Without "at" they change from the start of the song; with "at" (a position, e.g. "17") a tempo, key or meter change is added there (a meter change only on a bar line). Also who it\'s by ("artist") and its "album" ("none" clears one): the library keeps those beside the song, so undo doesn\'t take them back, and a creation\'s song has its creation\'s. Example: {"tempo": 92, "key": "E minor"}; {"artist": "Example Artist"}.',
  args: [
    { name: 'title', type: 'string', describe: "The song's title", maxLength: 200 },
    { name: 'tempo', type: 'number', describe: 'Quarter notes per minute, e.g. 96', min: 20, max: 400 },
    {
      name: 'key',
      type: 'string',
      describe: 'e.g. "D minor", "F# major", "A lydian"; "none" for no key',
      maxLength: 40,
    },
    { name: 'meter', type: 'string', describe: 'e.g. "3/4", "6/8", "7/8 2+2+3"', maxLength: 20 },
    {
      name: 'artist',
      type: 'string',
      describe: 'Who the song is by; "none" for no one (outside undo)',
      maxLength: 120,
    },
    { name: 'album', type: 'string', describe: 'The album it is on; "none" for none (outside undo)', maxLength: 120 },
    {
      name: 'at',
      type: 'string',
      describe: 'Where a tempo, key or meter change starts, as bar.beat.sixteenth (e.g. "17"); leave out for the start',
    },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const atText = str(args, 'at');
    const tick = atText ? position(project, atText) : 0;
    const patch: ProjectPatch = {};
    const done: string[] = [];
    const where = tick > 0 ? ` at ${at(project, tick)}` : '';
    const title = str(args, 'title')?.trim();
    if (title) {
      patch.title = title;
      done.push(`title "${title}"`);
    }
    const bpm = num(args, 'tempo');
    if (bpm !== undefined) {
      const first = project.tempo[0] ?? { tick: 0, bpm: 120 };
      patch.tempo =
        tick === 0
          ? [{ ...first, tick: 0, bpm }, ...project.tempo.slice(1)]
          : [...project.tempo.filter((p) => p.tick !== tick), { tick, bpm } satisfies TempoPoint].sort(
              (a, b) => a.tick - b.tick,
            );
      done.push(`tempo ${bpm}${where}`);
    }
    const meterText = str(args, 'meter');
    if (meterText) {
      const next = parseMeter(meterText);
      if (tick === 0) {
        const { groups: _, ...first } = project.meter[0] ?? { tick: 0, num: 4, den: 4 };
        patch.meter = [{ ...first, ...next, tick: 0 }, ...project.meter.slice(1)];
      } else {
        if (barToTick(project.meter, barOf(project, tick)) !== tick)
          throw new ToolError(`A meter changes on a bar line: say a bar, e.g. "${barOf(project, tick) + 1}"`);
        patch.meter = [...project.meter.filter((p) => p.tick !== tick), { tick, ...next }].sort(
          (a, b) => a.tick - b.tick,
        );
      }
      done.push(`meter ${next.num}/${next.den}${next.groups ? ` (${next.groups.join('+')})` : ''}${where}`);
    }
    const keyText = str(args, 'key')?.trim();
    if (keyText !== undefined) {
      const none = keyText === '' || /^(none|no key|null)$/i.test(keyText);
      const parsed = none ? null : parseKey(keyText);
      if (!none && !parsed) throw new ToolError(`"${keyText}" isn't a key: use e.g. "D minor", "Bb major", "A lydian"`);
      if (tick === 0) patch.key = none ? null : keyText;
      else {
        if (!parsed) throw new ToolError('A key change later in the song needs a key');
        const keys: KeyPoint[] = [...keysOf(project).filter((k) => k.tick !== tick), { tick, ...parsed }];
        patch.keys = keys.sort((a, b) => a.tick - b.tick);
      }
      done.push(none ? 'no key' : `key ${keyText}${where}`);
    }
    // who it's by and its album: the library's, beside the song (outside undo)
    const details: { artist?: string | null; album?: string | null } = {};
    for (const field of ['artist', 'album'] as const) {
      const v = str(args, field)?.trim();
      if (v === undefined) continue;
      details[field] = v === '' || /^(none|no one|nobody|null)$/i.test(v) ? null : v.replace(/\s+/g, ' ');
    }
    const outside = Object.keys(details).length > 0;
    if (!done.length && !outside) throw new ToolError('Say what to set: title, tempo, key, meter, artist or album');
    const label = done.join('; ');
    // (asked first: a creation's song refuses them, and then nothing else changes either)
    let saved: { artist: string | null; album: string | null } = { artist: null, album: null };
    if (outside) {
      try {
        saved = await ctx.api.details(details);
      } catch (err) {
        if (err instanceof ApiError && err.status === 400) throw new ToolError(err.message);
        throw err;
      }
    }
    if (done.length)
      await change(ctx, project, [{ op: 'setProject', patch }], label[0]?.toUpperCase() + label.slice(1));
    if (!outside) return { text: `Set ${label}.`, progress: `Set ${label}` };
    const said = (['artist', 'album'] as const)
      .filter((f) => f in details)
      .map((f) => (saved[f] ? `${f} "${saved[f]}"` : `no ${f}`));
    const all = [...done, ...said].join('; ');
    const what = said.length === 1 ? `The ${Object.keys(details)[0]} is` : 'The artist and album are';
    return {
      text: `Set ${all}. ${what} kept beside the song, outside undo: undo doesn't take ${said.length === 1 ? 'it' : 'them'} back.`,
      progress: `Set ${all}`,
    };
  },
};

export const marker: Tool = {
  name: 'marker',
  kind: 'change',
  summary:
    'Add, rename or remove a marker (a named place on the timeline: "Verse", "Chorus"). {"at": "17", "name": "Chorus"} adds one at bar 17 (or renames the one already there); {"name": "Chorus", "remove": true} removes it (or give "at" to remove the one there).',
  args: [
    { name: 'at', type: 'string', describe: 'Its position, bar.beat.sixteenth, e.g. "17"' },
    { name: 'name', type: 'string', describe: 'Its name, e.g. "Chorus"', maxLength: 60 },
    { name: 'remove', type: 'boolean', describe: 'Remove the marker named, or the one at "at"', default: false },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const name = str(args, 'name')?.trim();
    const atText = str(args, 'at');
    const tick = atText ? position(project, atText) : undefined;
    if (bool(args, 'remove')) {
      const gone = project.markers.filter(
        (m) => (tick !== undefined && m.tick === tick) || (name && m.name.toLowerCase() === name.toLowerCase()),
      );
      if (!gone.length)
        throw new ToolError(
          `No such marker. The markers: ${project.markers.map((m) => `"${m.name}" at ${at(project, m.tick)}`).join(', ') || 'none'}`,
        );
      const markers = project.markers.filter((m) => !gone.includes(m));
      const label = `Removed marker ${gone.map((m) => `"${m.name}"`).join(', ')}`;
      await change(ctx, project, [{ op: 'setProject', patch: { markers } }], label);
      return { text: `${label}.`, progress: label };
    }
    if (tick === undefined || !name) throw new ToolError('A marker needs "at" and "name"');
    const there = project.markers.find((m) => m.tick === tick);
    const markers = there
      ? project.markers.map((m) => (m === there ? { ...m, name } : m))
      : [...project.markers, { id: newId('mrk'), tick, name }].sort((a, b) => a.tick - b.tick);
    const label = there
      ? `Renamed the marker at ${at(project, tick)} "${name}"`
      : `Marker "${name}" at ${at(project, tick)}`;
    await change(ctx, project, [{ op: 'setProject', patch: { markers } }], label);
    return { text: `${label}.`, progress: label };
  },
};

export const cycle: Tool = {
  name: 'cycle',
  kind: 'change',
  summary:
    'Set the cycle (the span playback loops over while the user works): {"from": "9", "to": "17"} loops bars 9–16 ("to" is where it ends, not played); "to" left out loops four bars. {"off": true} turns it off.',
  args: [
    { name: 'from', type: 'string', describe: 'Where it starts, bar.beat.sixteenth, e.g. "9"' },
    { name: 'to', type: 'string', describe: 'Where it ends (not played), e.g. "17"' },
    { name: 'off', type: 'boolean', describe: 'Turn the cycle off', default: false },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    if (bool(args, 'off')) {
      await change(
        ctx,
        project,
        [{ op: 'setProject', patch: { cycle: { ...project.cycle, on: false } } }],
        'Cycle off',
      );
      return { text: 'The cycle is off.', progress: 'Cycle off' };
    }
    const start = position(project, str(args, 'from'), 'start');
    const toText = str(args, 'to');
    const end = toText ? position(project, toText, 'end') : start + ticksPerBar(meterAt(project.meter, start)) * 4;
    if (end <= start) throw new ToolError('The cycle ends after it starts');
    const label = `Cycle ${barsText(project, start, end)}`;
    await change(ctx, project, [{ op: 'setProject', patch: { cycle: { on: true, start, end } } }], label);
    return { text: `${label}, on.`, progress: label };
  },
};

export const looping: Tool = {
  name: 'looping',
  kind: 'change',
  summary:
    'Make the song a loop (a game\'s or an app\'s music): bounces and renders play it as it loops forever, its end ringing into its start, then "tail" seconds of its start again. {"start": "1", "end": "57", "tail": 4}; {"off": true} makes it an ordinary song again.',
  args: [
    { name: 'start', type: 'string', describe: 'Where the loop starts, e.g. "1"' },
    { name: 'end', type: 'string', describe: 'Where it ends and goes back to the start, e.g. "57"' },
    { name: 'tail', type: 'number', describe: 'Seconds of the start played again after a turn', min: 0, max: 60 },
    { name: 'off', type: 'boolean', describe: 'No longer a loop', default: false },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    if (bool(args, 'off')) {
      await change(ctx, project, [{ op: 'setProject', patch: { loop: null } }], 'Not a loop');
      return { text: 'The song is no longer a loop.', progress: 'Not a loop' };
    }
    const start = position(project, str(args, 'start'), 'start');
    const end = position(project, str(args, 'end'), 'end');
    if (end <= start) throw new ToolError('The loop ends after it starts');
    const tail = num(args, 'tail') ?? project.loop?.tail ?? 0;
    const label = `A loop: ${barsText(project, start, end)}, tail ${tail} s`;
    await change(ctx, project, [{ op: 'setProject', patch: { loop: { start, end, tail } } }], label);
    return { text: `${label}.`, progress: label };
  },
};

/** Each operation: the fields it needs, or why it isn't taken here. */
const OPS: Record<Op['op'], Record<string, 'string' | 'number' | 'object' | 'array'> | 'confirm' | string> = {
  setProject: { patch: 'object' },
  addTrack: { track: 'object' },
  removeTrack: 'confirm',
  moveTrack: { track: 'string', index: 'number' },
  updateTrack: { track: 'string', patch: 'object' },
  updateChannel: { target: 'string', patch: 'object' },
  addPlugin: { target: 'string', slot: 'string', plugin: 'object' },
  updatePlugin: { target: 'string', plugin: 'string', patch: 'object' },
  removePlugin: { target: 'string', plugin: 'string' },
  movePlugin: { target: 'string', plugin: 'string', index: 'number' },
  addBus: { bus: 'object' },
  removeBus: 'confirm',
  updateBus: { bus: 'string', patch: 'object' },
  addRegion: { track: 'string', region: 'object' },
  updateRegion: { track: 'string', region: 'string', patch: 'object' },
  removeRegion: 'confirm',
  moveRegion: { from: 'string', to: 'string', region: 'string' },
  splitRegion: { track: 'string', region: 'string', at: 'number', id: 'string' },
  arrange: { edit: 'string', from: 'number', to: 'number' },
  setNotes:
    'setNotes replaces a whole region from your copy, and the user may be editing it: use setNotesIn (only the notes starting in [from, to)) or addNotes',
  addNotes: { track: 'string', region: 'string', notes: 'array' },
  setNotesIn: { track: 'string', region: 'string', from: 'number', to: 'number', notes: 'array' },
  setMarksIn: { track: 'string', region: 'string', from: 'number', to: 'number', marks: 'array' },
  setCC: { track: 'string', region: 'string', lane: 'string', points: 'array' },
  setAutomation: { target: 'string', param: 'string', points: 'array' },
  addFile: 'Files come from the user (a recording dropped on the studio); no tool adds one',
};

const CONFIRM_FIELDS: Record<string, Record<string, 'string'>> = {
  removeTrack: { track: 'string' },
  removeBus: { bus: 'string' },
  removeRegion: { track: 'string', region: 'string' },
};

export const opsApply: Tool = {
  name: 'ops_apply',
  kind: 'change',
  summary:
    'Raw session operations, for what no other tool covers (moving or splitting regions, region names and colors, controller lanes, buses, sends, score marks…). Each is an object {"op": KIND, …} as in HO[LO]\'s session format, with ids from song_show (track ids trk_…, region ids rgn_…, bus ids bus_…); ticks are 960 to a quarter note, and note times are ticks from their region\'s start. Kinds: setProject, addTrack, moveTrack, updateTrack, updateChannel, addPlugin, updatePlugin, removePlugin, movePlugin, addBus, updateBus, addRegion, updateRegion, moveRegion, splitRegion (track, region, at a tick inside it, id for the right half), arrange (edit insert, delete, copy or move; from, to and at in ticks on bar lines), addNotes, setNotesIn (replaces only the notes starting in [from, to)), setMarksIn, setCC, setAutomation; removeTrack, removeRegion, removeBus, and arrange\'s delete and move only with "confirm": true. They\'re tried first and refused, with the reason, if any would fail. Example: {"ops": [{"op": "updateRegion", "track": "trk_…", "region": "rgn_…", "patch": {"name": "Intro"}}], "label": "Named the intro"}.',
  args: [
    {
      name: 'ops',
      type: 'array',
      items: 'object',
      describe: 'The operations, in order',
      required: true,
      maxLength: 200,
    },
    { name: 'label', type: 'string', describe: 'What they do, in a few words', required: true, maxLength: 80 },
    {
      name: 'confirm',
      type: 'boolean',
      describe: 'true to allow removing tracks, regions or buses, or deleting or moving bars',
      default: false,
    },
  ],
  async run(ctx, args) {
    const list = (args.ops as Record<string, unknown>[]) ?? [];
    if (!list.length) throw new ToolError('No operations');
    const confirm = bool(args, 'confirm') === true;
    list.forEach((op, i) => {
      const kind = op.op;
      if (typeof kind !== 'string' || !(kind in OPS))
        throw new ToolError(`ops[${i}]: "op" must be one of ${Object.keys(OPS).join(', ')}`);
      let rule = OPS[kind as Op['op']];
      if (rule === 'confirm') {
        if (!confirm)
          throw new ToolError(`ops[${i}]: ${kind} removes something: send "confirm": true if the user wants it`);
        rule = CONFIRM_FIELDS[kind] ?? {};
      }
      if (typeof rule === 'string') throw new ToolError(`ops[${i}]: ${rule}`);
      if (kind === 'arrange' && (op.edit === 'delete' || op.edit === 'move') && !confirm)
        throw new ToolError(
          `ops[${i}]: arrange ${op.edit} takes bars out of the song: send "confirm": true if the user wants it`,
        );
      for (const [field, type] of Object.entries(rule)) {
        const v = op[field];
        const ok =
          type === 'array'
            ? Array.isArray(v)
            : type === 'object'
              ? typeof v === 'object' && v !== null && !Array.isArray(v)
              : typeof v === type;
        if (!ok)
          throw new ToolError(`ops[${i}] (${kind}): "${field}" must be ${type === 'array' ? 'a list' : `a ${type}`}`);
      }
    });
    const project = await ctx.api.song();
    const label = need(args, 'label');
    const revision = await change(ctx, project, list as unknown as Op[], label);
    return {
      text: `Applied ${plural(list.length, 'operation')}: ${label}${revision ? ` (revision ${revision})` : ''}.`,
      progress: label,
    };
  },
};

export const songTools: Tool[] = [songStatus, songShow, songSet, marker, cycle, looping, opsApply];
