/**
 * Regions, the blocks on the tracks: split (chop) them, delete, copy, move (in time or to another
 * track), repeat, trim, gain, fade, stretch, mute, rename; a MIDI region's notes quantized or
 * transposed, and its controller and pitch-bend lanes. A region is named by its id, its name, or
 * "selected" (what's selected in the studio). Each change is one batch of operations, so the user
 * undoes it with the rest of the request.
 */
import {
  type AudioClip,
  barToTick,
  type CCPoint,
  fadeTo,
  newId,
  type Op,
  type Project,
  quantize,
  type Region,
  secondsToTick,
  setStretch,
  stretchMidi,
  type Track,
  tickToBarBeat,
  tickToSeconds,
  trimEnd,
  trimMidiStart,
  trimStart,
} from '@holo/session';
import {
  barsText,
  bool,
  change,
  num,
  plural,
  position,
  str,
  type Tool,
  type ToolContext,
  ToolError,
  trackRef,
  UNITS,
  unitTicks,
} from './common.ts';

/** A position as the tools take it back: "9", "9.3", "9.3.2" or "9.3.2.120". */
export function posText(project: Project, tick: number): string {
  const p = tickToBarBeat(project.meter, Math.round(tick));
  const parts = [p.bar, p.beat, p.div, p.tick];
  while (parts.length > 1 && parts[parts.length - 1] === (parts.length === 4 ? 0 : 1)) parts.pop();
  return parts.join('.');
}

interface Found {
  track: Track;
  region: Region;
}

const end = (r: Region) => r.start + r.length;

const regionLine = (project: Project, f: Found): string => {
  const r = f.region;
  const what = r.audio
    ? `audio, ${(project.files?.find((x) => x.id === r.audio?.file)?.name ?? r.audio.file).slice(0, 60)}`
    : plural(r.notes.length, 'note');
  return `"${r.name || 'untitled'}" [${r.id}] on ${f.track.name}, ${posText(project, r.start)} to ${posText(project, end(r))} (${barsText(project, r.start, end(r))}), ${what}${r.muted ? ', muted' : ''}`;
};

/** Every region the arguments name: by id, by name (on the track, if one is given), or "selected". */
async function regionsRef(
  ctx: ToolContext,
  project: Project,
  ref: string | undefined,
  trackText: string | undefined,
  at?: number[],
): Promise<Found[]> {
  const track = trackText ? trackRef(project, trackText) : undefined;
  const all = project.tracks.flatMap((t) => t.regions.map((region) => ({ track: t, region })));
  const listOf = (list: Found[]) => list.map((f) => `  ${regionLine(project, f)}`).join('\n');
  const text = ref?.trim();
  if (text && /^selected$/i.test(text)) {
    const ids = (await ctx.api.state()).selection?.regions ?? [];
    const found = all.filter((f) => ids.includes(f.region.id) && (!track || f.track.id === track.id));
    if (!found.length)
      throw new ToolError(
        `No region is selected in the studio${track ? ` on ${track.name}` : ''}: say the region by its id or name`,
      );
    return found;
  }
  if (text) {
    const byId = all.find((f) => f.region.id === text);
    if (byId) return [byId];
    const named = all.filter(
      (f) => (!track || f.track.id === track.id) && f.region.name.toLowerCase() === text.toLowerCase(),
    );
    if (named.length === 1) return named;
    if (named.length > 1)
      throw new ToolError(`"${text}" names ${named.length} regions; say which by its id:\n${listOf(named)}`);
    const here = track ? all.filter((f) => f.track.id === track.id) : [];
    throw new ToolError(
      `No region "${text}"${track ? ` on ${track.name}` : ''}.${here.length ? ` Its regions:\n${listOf(here)}` : ' {"action": "show", "track": …} lists a track’s regions.'}`,
    );
  }
  if (!track) throw new ToolError('Say "region" (its id, its name or "selected"), or the "track"');
  const mine = all.filter((f) => f.track.id === track.id);
  if (at?.length) {
    const under = mine.filter((f) => at.some((t) => t > f.region.start && t < end(f.region)));
    if (under.length) return under;
  }
  if (mine.length === 1) return mine;
  throw new ToolError(
    mine.length
      ? `${track.name} has ${plural(mine.length, 'region')}: say which ("region": an id or name)\n${listOf(mine)}`
      : `${track.name} has no regions`,
  );
}

/** Controller lanes by name: CC numbers, "pb" (pitch bend) and "at" (channel pressure). */
const LANES: Record<string, string> = {
  mod: '1',
  modulation: '1',
  'mod wheel': '1',
  breath: '2',
  volume: '7',
  pan: '10',
  expression: '11',
  sustain: '64',
  pedal: '64',
  damper: '64',
  pb: 'pb',
  pitchbend: 'pb',
  'pitch bend': 'pb',
  bend: 'pb',
  at: 'at',
  aftertouch: 'at',
  pressure: 'at',
};

function laneRef(text: string | undefined): string {
  const t =
    text
      ?.trim()
      .toLowerCase()
      .replace(/^cc\s*/, '') ?? '';
  const lane = LANES[t] ?? (/^\d{1,3}$/.test(t) && Number(t) >= 0 && Number(t) <= 127 ? String(Number(t)) : null);
  if (!lane)
    throw new ToolError('"lane" is a CC number (1 mod wheel, 7 volume, 11 expression, 64 sustain…), "pb" or "at"');
  return lane;
}

const laneName = (lane: string) =>
  lane === 'pb'
    ? 'pitch bend'
    : lane === 'at'
      ? 'pressure'
      : `CC ${lane}${{ '1': ' (mod)', '7': ' (volume)', '11': ' (expression)', '64': ' (sustain)' }[lane] ?? ''}`;

/** A whole MIDI region's notes, lanes and marks set from a changed copy, as few operations. */
function rewrite(track: Track, was: Region, next: Region): Op[] {
  const ops: Op[] = [];
  const patch: { start?: number; length?: number } = {};
  if (next.start !== was.start) patch.start = next.start;
  if (next.length !== was.length) patch.length = next.length;
  if (Object.keys(patch).length) ops.push({ op: 'updateRegion', track: track.id, region: was.id, patch });
  if (JSON.stringify(next.notes) !== JSON.stringify(was.notes)) {
    const ts = [0, ...was.notes.map((n) => n.t)];
    ops.push({
      op: 'setNotesIn',
      track: track.id,
      region: was.id,
      from: Math.min(...ts),
      to: Number.MAX_SAFE_INTEGER,
      notes: next.notes,
    });
  }
  for (const lane of new Set([...Object.keys(was.cc), ...Object.keys(next.cc)])) {
    const points = next.cc[lane] ?? [];
    if (JSON.stringify(points) !== JSON.stringify(was.cc[lane] ?? []))
      ops.push({ op: 'setCC', track: track.id, region: was.id, lane, points });
  }
  if (JSON.stringify(next.marks ?? []) !== JSON.stringify(was.marks ?? []))
    ops.push({
      op: 'setMarksIn',
      track: track.id,
      region: was.id,
      from: Math.min(0, ...(was.marks ?? []).map((m) => m.t)),
      to: Number.MAX_SAFE_INTEGER,
      marks: next.marks ?? [],
    });
  return ops;
}

const ACTIONS = [
  'show',
  'split',
  'delete',
  'copy',
  'move',
  'repeat',
  'trim',
  'gain',
  'fade',
  'stretch',
  'mute',
  'unmute',
  'rename',
  'quantize',
  'transpose',
  'cc',
] as const;

/** Seconds of the song between two ticks. */
const secondsBetween = (project: Project, a: number, b: number) =>
  tickToSeconds(project.tempo, b) - tickToSeconds(project.tempo, a);

function showRegion(project: Project, f: Found): string {
  const r = f.region;
  const lines = [regionLine(project, f)];
  if (r.audio) {
    const a = r.audio;
    lines.push(
      `  starts ${Math.round(a.offset * 1000) / 1000} s into the recording; gain ${a.gain} dB; fade in ${a.fadeIn} s, out ${a.fadeOut} s; stretch ${a.stretch} (1 as recorded); ${Math.round(secondsBetween(project, r.start, end(r)) * 100) / 100} s long`,
    );
  } else if (r.notes.length) {
    const ps = r.notes.map((n) => n.p);
    const vs = r.notes.map((n) => n.v);
    lines.push(
      `  pitches ${Math.min(...ps)}–${Math.max(...ps)} (MIDI), velocities ${Math.min(...vs)}–${Math.max(...vs)}`,
    );
  }
  const lanes = Object.entries(r.cc).filter(([, pts]) => pts.length);
  for (const [lane, pts] of lanes)
    lines.push(
      `  ${laneName(lane)}: ${pts
        .slice(0, 40)
        .map(([t, v]) => `${posText(project, r.start + t)}=${v}`)
        .join(' ')}${pts.length > 40 ? ` … (${pts.length} points)` : ''}`,
    );
  if (r.marks?.length) lines.push(`  ${plural(r.marks.length, 'score mark')}`);
  return lines.join('\n');
}

export const regions: Tool = {
  name: 'regions',
  kind: 'change',
  summary:
    'Edit regions (the blocks on the tracks), audio or MIDI. "region" is its id, its name, or "selected" (what\'s selected in the studio); with only "track", the region there ("at" for split) or its only one. Actions: show (a track\'s regions, or one in detail with its lanes); split at "at" (one position or several, e.g. "17 21 25", to chop); delete (with "confirm": true); copy or move to "at" and/or "to_track"; repeat it "times" after itself; trim its "start" and/or "end" (positions); gain "db" (audio: the region\'s gain, 0 as recorded; MIDI: scales velocities, −6 about halves them); fade "fade_in"/"fade_out" in seconds (MIDI: a velocity ramp); stretch by "ratio" (2 twice as long; audio keeps its pitch) or to an "end"; mute, unmute; rename to "name"; quantize (MIDI) to "unit" at "strength" %; transpose (MIDI) by "semitones"; cc (MIDI): a controller or pitch-bend "lane" ("1" mod, "7", "11" expression, "64" sustain, "pb", "at") written as "points" (position=value, replacing the lane from the first point to the last), or "clear", or shown. Examples: {"action": "split", "track": "Vocal", "at": "17"}; {"action": "fade", "region": "selected", "fade_out": 1.5}; {"action": "cc", "region": "rgn_…", "lane": "pb", "points": "9=0 9.3=4096 10=0"}.',
  args: [
    { name: 'action', type: 'enum', values: ACTIONS, describe: 'What to do', required: true },
    { name: 'region', type: 'string', describe: 'The region: its id (rgn_…), its name, or "selected"', maxLength: 120 },
    { name: 'track', type: 'string', describe: 'The track it is on (name or id)' },
    {
      name: 'at',
      type: 'string',
      describe: 'split: where (several positions cut it in pieces); copy, move: its new start (e.g. "17")',
      maxLength: 400,
    },
    { name: 'to_track', type: 'string', describe: 'copy, move: the track it goes to' },
    { name: 'times', type: 'integer', describe: 'repeat: how many copies after it', min: 1, max: 64, default: 1 },
    { name: 'start', type: 'string', describe: 'trim: its new start, e.g. "9.3"' },
    { name: 'end', type: 'string', describe: 'trim, stretch: its new end, e.g. "13"' },
    { name: 'db', type: 'number', describe: 'gain: dB', min: -60, max: 24 },
    { name: 'fade_in', type: 'number', describe: 'fade: the fade-in, in seconds', min: 0, max: 120 },
    { name: 'fade_out', type: 'number', describe: 'fade: the fade-out, in seconds', min: 0, max: 120 },
    {
      name: 'ratio',
      type: 'number',
      describe: 'stretch: how much longer it plays (0.5 half, 2 twice)',
      min: 0.25,
      max: 4,
    },
    { name: 'name', type: 'string', describe: 'rename: its new name', maxLength: 80 },
    { name: 'unit', type: 'enum', values: UNITS, describe: 'quantize: the grid', default: '1/16' },
    {
      name: 'strength',
      type: 'number',
      describe: 'quantize: how far toward the grid, %',
      min: 0,
      max: 100,
      default: 100,
    },
    { name: 'semitones', type: 'integer', describe: 'transpose: by how many semitones', min: -48, max: 48 },
    { name: 'lane', type: 'string', describe: 'cc: a CC number, "pb" (pitch bend) or "at" (pressure)' },
    {
      name: 'points',
      type: 'string',
      describe: 'cc: position=value pairs, e.g. "9=0 9.3=64 10=127" (CC 0–127, pb −8192–8191)',
      maxLength: 8000,
    },
    { name: 'clear', type: 'boolean', describe: 'cc: remove the lane' },
    { name: 'confirm', type: 'boolean', describe: 'delete: true, once the user wants it gone', default: false },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const action = str(args, 'action') as (typeof ACTIONS)[number];
    const atText = str(args, 'at')?.trim();
    const splitAt =
      action === 'split' && atText
        ? atText
            .split(/[\s,]+/)
            .filter(Boolean)
            .map((w) => position(project, w))
        : undefined;
    if (action === 'show' && !str(args, 'region') && str(args, 'track')) {
      const track = trackRef(project, str(args, 'track'));
      if (!track.regions.length) return { text: `${track.name} has no regions.` };
      return {
        text: [...track.regions]
          .sort((a, b) => a.start - b.start)
          .map((region) => regionLine(project, { track, region }))
          .join('\n'),
      };
    }
    const found = await regionsRef(ctx, project, str(args, 'region'), str(args, 'track'), splitAt);
    const named = found.length === 1 ? `"${found[0]?.region.name || 'the region'}"` : plural(found.length, 'region');
    const ops: Op[] = [];
    let label = '';
    const midiOnly = (what: string) => {
      const audio = found.find((f) => f.region.audio);
      if (audio) throw new ToolError(`${what} is for MIDI regions: "${audio.region.name}" is a recording`);
    };

    switch (action) {
      case 'show':
        return { text: found.map((f) => showRegion(project, f)).join('\n') };

      case 'split': {
        if (!splitAt?.length) throw new ToolError('Say where to split: "at", e.g. "17" or "17 21 25"');
        const made: string[] = [];
        for (const { track, region } of found) {
          const cuts = [...new Set(splitAt)].filter((t) => t > region.start && t < end(region)).sort((a, b) => b - a);
          for (const at of cuts) {
            const id = newId('rgn');
            made.push(id);
            ops.push({ op: 'splitRegion', track: track.id, region: region.id, at, id });
          }
        }
        if (!ops.length)
          throw new ToolError(
            `${atText} isn't inside ${named}: ${found.map((f) => regionLine(project, f)).join('; ')}`,
          );
        label = `Split ${named} at ${splitAt.map((t) => posText(project, t)).join(', ')}`;
        await change(ctx, project, ops, label);
        return { text: `${label}: ${plural(made.length, 'new region')} (${made.join(', ')}).`, progress: label };
      }

      case 'delete': {
        if (bool(args, 'confirm') !== true)
          throw new ToolError('Deleting a region needs "confirm": true, once the user wants it gone');
        for (const { track, region } of found) ops.push({ op: 'removeRegion', track: track.id, region: region.id });
        label = `Deleted ${named}`;
        break;
      }

      case 'copy':
      case 'move':
      case 'repeat': {
        const toText = str(args, 'to_track');
        const to = toText ? trackRef(project, toText) : undefined;
        const first = Math.min(...found.map((f) => f.region.start));
        const at = atText ? position(project, atText) : undefined;
        if (action !== 'repeat' && at === undefined && !to)
          throw new ToolError(`Say where to ${action} it: "at" and/or "to_track"`);
        const made: string[] = [];
        for (const { track, region } of found) {
          const dest = to ?? track;
          if (!!region.audio !== (dest.kind === 'audio'))
            throw new ToolError(
              region.audio
                ? `"${region.name}" is a recording: it goes on an audio track, and ${dest.name} isn't one`
                : `"${region.name}" is MIDI: it goes on an instrument track, and ${dest.name} is an audio track`,
            );
          if (action === 'move') {
            const start = at !== undefined ? at + (region.start - first) : region.start;
            ops.push({ op: 'moveRegion', from: track.id, to: dest.id, region: region.id, start });
            continue;
          }
          const starts =
            action === 'copy'
              ? [at !== undefined ? at + (region.start - first) : region.start]
              : Array.from({ length: num(args, 'times') ?? 1 }, (_, k) => region.start + (k + 1) * region.length);
          for (const start of starts) {
            const id = newId('rgn');
            made.push(id);
            ops.push({ op: 'addRegion', track: dest.id, region: { ...structuredClone(region), id, start } });
          }
        }
        const where = [at !== undefined ? posText(project, at) : '', to ? to.name : ''].filter(Boolean).join(' on ');
        label =
          action === 'move'
            ? `Moved ${named} to ${where}`
            : action === 'copy'
              ? `Copied ${named} to ${where}`
              : `Repeated ${named} ${plural(num(args, 'times') ?? 1, 'time')}`;
        await change(ctx, project, ops, label);
        return { text: `${label}${made.length ? ` (new: ${made.join(', ')})` : ''}.`, progress: label };
      }

      case 'trim': {
        const startText = str(args, 'start');
        const endText = str(args, 'end');
        if (!startText && !endText) throw new ToolError('Say the new "start" and/or "end"');
        const newStart = startText ? position(project, startText, 'start') : undefined;
        const newEnd = endText ? position(project, endText, 'end') : undefined;
        for (const { track, region } of found) {
          let next: Region = region;
          if (newStart !== undefined) {
            if (newStart >= end(next))
              throw new ToolError(`The start goes before the region's end (${posText(project, end(next))})`);
            next = next.audio
              ? { ...next, ...trimStart(project, next, next.audio, newStart) }
              : trimMidiStart(next, newStart);
          }
          if (newEnd !== undefined) {
            if (newEnd <= next.start)
              throw new ToolError(`The end goes after the region's start (${posText(project, next.start)})`);
            next = next.audio
              ? { ...next, ...trimEnd(project, next, next.audio, newEnd - next.start, false) }
              : { ...next, length: newEnd - next.start };
          }
          if (next.audio) {
            ops.push({
              op: 'updateRegion',
              track: track.id,
              region: region.id,
              patch: { start: next.start, length: next.length, audio: next.audio },
            });
          } else ops.push(...rewrite(track, region, next));
        }
        if (!ops.length) return { text: `${named} already starts and ends there.` };
        label = `Trimmed ${named}`;
        break;
      }

      case 'gain': {
        const db = num(args, 'db');
        if (db === undefined) throw new ToolError('Say "db"');
        for (const { track, region } of found) {
          if (region.audio) {
            ops.push({
              op: 'updateRegion',
              track: track.id,
              region: region.id,
              patch: { audio: { ...region.audio, gain: db } },
            });
          } else {
            const k = 10 ** (db / 20);
            const notes = region.notes.map((n) => ({ ...n, v: Math.max(1, Math.min(127, Math.round(n.v * k))) }));
            ops.push(...rewrite(track, region, { ...region, notes }));
          }
        }
        label = `${named}: gain ${db > 0 ? '+' : ''}${db} dB`;
        break;
      }

      case 'fade': {
        const fin = num(args, 'fade_in');
        const fout = num(args, 'fade_out');
        if (fin === undefined && fout === undefined) throw new ToolError('Say "fade_in" and/or "fade_out" (seconds)');
        for (const { track, region } of found) {
          const s0 = tickToSeconds(project.tempo, region.start);
          const s1 = tickToSeconds(project.tempo, end(region));
          if (region.audio) {
            let clip: AudioClip = region.audio;
            if (fin !== undefined)
              clip = fadeTo(project, region, clip, 'fadeIn', secondsToTick(project.tempo, s0 + fin));
            if (fout !== undefined)
              clip = fadeTo(project, region, clip, 'fadeOut', secondsToTick(project.tempo, Math.max(s0, s1 - fout)));
            ops.push({ op: 'updateRegion', track: track.id, region: region.id, patch: { audio: clip } });
          } else {
            const notes = region.notes.map((n) => {
              const at = tickToSeconds(project.tempo, region.start + n.t);
              let k = 1;
              if (fin) k *= Math.min(1, Math.max(0, at - s0) / fin);
              if (fout) k *= Math.min(1, Math.max(0, s1 - at) / fout);
              return { ...n, v: Math.max(1, Math.round(n.v * k)) };
            });
            ops.push(...rewrite(track, region, { ...region, notes }));
          }
        }
        const bits = [fin !== undefined ? `in ${fin} s` : '', fout !== undefined ? `out ${fout} s` : ''].filter(
          Boolean,
        );
        label = `Faded ${named} ${bits.join(', ')}`;
        break;
      }

      case 'stretch': {
        const ratio = num(args, 'ratio');
        const endText = str(args, 'end');
        if (ratio === undefined && !endText) throw new ToolError('Say "ratio" (2 twice as long) or the new "end"');
        const newEnd = endText ? position(project, endText, 'end') : undefined;
        for (const { track, region } of found) {
          if (newEnd !== undefined && newEnd <= region.start)
            throw new ToolError(`The end goes after the region's start (${posText(project, region.start)})`);
          if (region.audio) {
            const next =
              newEnd !== undefined
                ? { ...region, ...trimEnd(project, region, region.audio, newEnd - region.start, true) }
                : setStretch(project, region, region.audio, region.audio.stretch * (ratio as number));
            ops.push({
              op: 'updateRegion',
              track: track.id,
              region: region.id,
              patch: { length: next.length, audio: next.audio },
            });
          } else {
            const k = newEnd !== undefined ? (newEnd - region.start) / region.length : (ratio as number);
            ops.push(...rewrite(track, region, stretchMidi(region, k)));
          }
        }
        label = `Stretched ${named}${ratio !== undefined && newEnd === undefined ? ` ×${ratio}` : ` to ${posText(project, newEnd as number)}`}`;
        break;
      }

      case 'mute':
      case 'unmute':
        for (const { track, region } of found)
          ops.push({ op: 'updateRegion', track: track.id, region: region.id, patch: { muted: action === 'mute' } });
        label = `${action === 'mute' ? 'Muted' : 'Unmuted'} ${named}`;
        break;

      case 'rename': {
        const name = str(args, 'name')?.trim();
        if (name === undefined) throw new ToolError('Say the new "name"');
        for (const { track, region } of found)
          ops.push({ op: 'updateRegion', track: track.id, region: region.id, patch: { name } });
        label = `Renamed ${named} "${name}"`;
        break;
      }

      case 'quantize': {
        midiOnly('Quantizing');
        const grid = unitTicks(str(args, 'unit') ?? '1/16');
        const strength = (num(args, 'strength') ?? 100) / 100;
        for (const { track, region } of found) {
          const notes = region.notes.map((n) => {
            const at = region.start + n.t;
            const bar = barToTick(project.meter, tickToBarBeat(project.meter, at).bar);
            return { ...n, t: Math.max(0, bar + quantize(at - bar, grid, strength) - region.start) };
          });
          ops.push(...rewrite(track, region, { ...region, notes }));
        }
        if (!ops.length) return { text: `${named} is on the grid already.` };
        label = `Quantized ${named} to ${str(args, 'unit') ?? '1/16'}${strength < 1 ? ` at ${Math.round(strength * 100)}%` : ''}`;
        break;
      }

      case 'transpose': {
        midiOnly('Transposing');
        const by = num(args, 'semitones');
        if (!by) throw new ToolError('Say "semitones" (e.g. 12 for an octave up, -2 for a tone down)');
        for (const { track, region } of found) {
          const notes = region.notes.map((n) => ({ ...n, p: n.p + by }));
          if (notes.some((n) => n.p < 0 || n.p > 127)) throw new ToolError('That takes notes outside MIDI 0–127');
          ops.push(...rewrite(track, region, { ...region, notes }));
        }
        label = `Transposed ${named} ${by > 0 ? '+' : ''}${by}`;
        break;
      }

      case 'cc': {
        midiOnly('A controller lane');
        const pointsText = str(args, 'points')?.trim();
        const clear = bool(args, 'clear') === true;
        if (!str(args, 'lane') && !pointsText && !clear)
          return { text: found.map((f) => showRegion(project, f)).join('\n') };
        const lane = laneRef(str(args, 'lane'));
        const [lo, hi] = lane === 'pb' ? [-8192, 8191] : [0, 127];
        for (const { track, region } of found) {
          const was = region.cc[lane] ?? [];
          if (!pointsText && !clear) {
            return {
              text: `${laneName(lane)} on "${region.name}": ${
                was.map(([t, v]) => `${posText(project, region.start + t)}=${v}`).join(' ') || 'no points'
              }`,
            };
          }
          let points: CCPoint[] = [];
          if (pointsText) {
            const given = pointsText
              .split(/[\s,]+/)
              .filter(Boolean)
              .map((w): CCPoint => {
                const m = /^([\d.]+|t:\d+)=(-?\d+)$/.exec(w);
                if (!m) throw new ToolError(`"${w}": points are position=value, e.g. 9.3=64`);
                const v = Number(m[2]);
                if (v < lo || v > hi) throw new ToolError(`${laneName(lane)} goes from ${lo} to ${hi} (got ${v})`);
                const tick = position(project, m[1] as string);
                if (tick < region.start || tick > end(region))
                  throw new ToolError(
                    `${m[1]} is outside "${region.name}" (${barsText(project, region.start, end(region))})`,
                  );
                return [tick - region.start, v];
              })
              .sort((a, b) => a[0] - b[0]);
            const a = (given[0] as CCPoint)[0];
            const b = (given[given.length - 1] as CCPoint)[0];
            points = [...was.filter(([t]) => t < a || t > b), ...given].sort((x, y) => x[0] - y[0]);
          }
          ops.push({ op: 'setCC', track: track.id, region: region.id, lane, points });
        }
        label = clear ? `Cleared ${laneName(lane)} on ${named}` : `${laneName(lane)} on ${named}`;
        break;
      }
    }
    if (!ops.length) return { text: 'Nothing to change.' };
    await change(ctx, project, ops, label);
    return { text: `${label}.`, progress: label };
  },
};

export const regionTools: Tool[] = [regions];
