/**
 * Bringing what the user attached into the song (`import`): a recording onto an audio track (a new one,
 * or one the song has), or a MIDI or MusicXML file as tracks of notes, fitted to the song by
 * `mergeOps` (@holo/session). HO[LO] makes the recording one of the song's files (as WAV) or reads the
 * file into notes; the tool then sends the changes as one batch, one undo step with the rest of the
 * request. A recording only a browser can decode is converted by the studio, which can take longer than
 * a call: then the tool says so, and the same call again carries on.
 */
import {
  type AudioFile,
  barLineBefore,
  formatBarBeat,
  MergeError,
  mergeOps,
  newAudioTrack,
  newRegion,
  type Op,
  type Project,
  secondsToTick,
  TRACK_COLORS,
  tickToSeconds,
} from '@holo/session';
import { ApiError, type ImportAnswer } from '../api.ts';
import {
  barsText,
  change,
  need,
  plural,
  position,
  str,
  type Tool,
  type ToolContext,
  ToolError,
  type ToolResult,
  trackRef,
} from './common.ts';

/** An attachment's id, as HO[LO] makes them. */
const ATTACHMENT_ID = /^att_[0-9a-f]{12}$/;

/** What HO[LO] made of the attachment, or a plain reason it couldn't. */
async function bring(ctx: ToolContext, id: string): Promise<ImportAnswer> {
  if (!ATTACHMENT_ID.test(id))
    throw new ToolError(`"${id}" isn't an attachment's id: they look like att_0123456789ab, as the request lists them`);
  try {
    return await ctx.api.importAttachment(id);
  } catch (err) {
    if (!(err instanceof ApiError)) throw err;
    if (err.status === 404)
      throw new ToolError(
        `Attachment ${id} is gone: HO[LO] keeps attachments for 7 days (or there was never one with that id). Ask the user to attach it again.`,
      );
    if (err.status === 403 && /attachment/i.test(err.message))
      throw new ToolError(
        `Attachment ${id} isn't this conversation's: you can import only what was attached to this song's requests in it.`,
      );
    // a picture or a text, a file it can't read, a studio that couldn't convert it: said as HO[LO] says it
    if (err.status === 400 || err.status === 409 || err.status === 415) throw new ToolError(err.message);
    throw err;
  }
}

/** The parts asked for: names, or numbers from 1. */
function partsOf(raw: unknown): (string | number)[] | undefined {
  if (raw === undefined) return undefined;
  const list = raw as unknown[];
  if (
    !list.every(
      (p) => (typeof p === 'string' && p.trim() && p.length <= 80) || (Number.isInteger(p) && (p as number) > 0),
    )
  )
    throw new ToolError(
      '"parts" are the names of the file\'s parts or their numbers from 1, e.g. ["Violin I", "Cello"] or [1, 3]',
    );
  return list.length ? (list as (string | number)[]) : undefined;
}

const channelsText = (n: number) => (n === 1 ? 'mono' : n === 2 ? 'stereo' : `${n} channels`);

/** A recording as a region from `at`, on the audio track named or a new one. */
async function placeRecording(
  ctx: ToolContext,
  song: Project,
  file: AudioFile,
  how: 'copied' | 'converted' | 'studio',
  at: number,
  track: string | undefined,
  name: string | undefined,
  extra: string[],
): Promise<ToolResult> {
  const target = track ? trackRef(song, track) : null;
  if (target && target.kind !== 'audio')
    throw new ToolError(
      `"${target.name}" is an instrument track: a recording goes on an audio track (name one, or leave "track" out for a new one)`,
    );
  const label = name?.trim() || file.name.replace(/\.[^.]+$/, '') || 'Audio';
  const ops: Op[] = [{ op: 'addFile', file }];
  let onto = target;
  if (!onto) {
    onto = newAudioTrack(label, TRACK_COLORS[song.tracks.length % TRACK_COLORS.length]);
    ops.push({ op: 'addTrack', track: onto });
  }
  const end = Math.max(at + 1, Math.round(secondsToTick(song.tempo, tickToSeconds(song.tempo, at) + file.seconds)));
  const region = newRegion(at, end - at, label);
  region.audio = { file: file.id, offset: 0, gain: 0, fadeIn: 0, fadeOut: 0, stretch: 1 };
  ops.push({ op: 'addRegion', track: onto.id, region });
  await change(ctx, song, ops, `Import ${file.name}`);
  const overlaps = target
    ? target.regions.filter((r) => r.start < end && at < r.start + r.length && r.id !== region.id).length
    : 0;
  const lines = [
    `Imported "${file.name}" (${file.seconds.toFixed(1)} s, ${Math.round(file.rate / 100) / 10} kHz ${channelsText(file.channels)}${how === 'copied' ? '' : ', kept as WAV'}) onto ${target ? `"${onto.name}"` : `a new audio track "${onto.name}" (${onto.id})`}: region ${region.id} "${label}", ${formatBarBeat(song.meter, at)} to ${formatBarBeat(song.meter, end)}.`,
  ];
  if (overlaps)
    lines.push(
      `It overlaps ${plural(overlaps, 'region')} already on "${onto.name}": where takes overlap, the later one plays.`,
    );
  lines.push(...extra);
  return { text: lines.join('\n'), progress: `Imported ${file.name} on ${onto.name}, ${barsText(song, at, end)}` };
}

export const importTool: Tool = {
  name: 'import',
  kind: 'change',
  summary:
    'Bring an attachment into the song (its id is in the request\'s list): a recording (WAV, FLAC, AIFF, MP3, Ogg, M4A: a dropped file or a microphone take) becomes a region on an audio track; a MIDI or MusicXML file (.mid, .musicxml, .xml, .mxl) becomes tracks of notes. "at" is where it starts (bar.beat, e.g. "5"; the playhead when left out, at its bar for notes). "track": an audio track of the song\'s for a recording, or an instrument track for one part of a MIDI or MusicXML file (left out: a new track each). "name" names the new track. For MIDI and MusicXML only: "tempo" keep (default: the song keeps its tempo, the notes keep their beats) or adopt (the song takes the file\'s tempo for as long as the file runs), and "parts" which of the file\'s parts, by name or number (every part when left out; attachment_get lists them). The song keeps its meter and key; each part\'s region starts and ends on the song\'s bar lines; new tracks get a synth to stand in until you choose their instruments. A recording only a browser can decode (MP3, Ogg, M4A) is converted by the studio: if this answers that it\'s still converting, call it again with the same arguments.',
  args: [
    { name: 'attachment', type: 'string', describe: "The attachment's id (att_…)", required: true, maxLength: 80 },
    {
      name: 'at',
      type: 'string',
      describe: 'Where it starts: bar.beat.sixteenth, e.g. "5" or "17.3" (the playhead when left out)',
      maxLength: 40,
    },
    {
      name: 'track',
      type: 'string',
      describe:
        'An existing track to put it on: an audio track for a recording, an instrument track for one part of notes',
      maxLength: 120,
    },
    { name: 'name', type: 'string', describe: 'The new track’s (and a recording’s region’s) name', maxLength: 60 },
    {
      name: 'tempo',
      type: 'enum',
      values: ['keep', 'adopt'],
      describe: 'MIDI and MusicXML: keep the song’s tempo (the default), or adopt the file’s while it runs',
    },
    {
      name: 'parts',
      type: 'array',
      describe:
        'MIDI and MusicXML: which of the file’s parts, by name or number from 1, e.g. ["Violin I", "Cello"] or [2]',
      maxLength: 64,
    },
  ],
  async run(ctx, args) {
    const id = need(args, 'attachment');
    const parts = partsOf(args.parts);
    const song = await ctx.api.song();
    const atText = str(args, 'at')?.trim();
    // where it goes, read before the import (which can take a while): the playhead now, when unsaid
    const at = atText ? position(song, atText, 'at') : Math.max(0, Math.round((await ctx.api.state()).playhead ?? 0));
    const answer = await bring(ctx, id);
    if (!answer.done)
      return {
        text: `${answer.line}. Call import again with the same arguments: it carries on with the same conversion (each call waits up to 40 s). Meanwhile, tell the user if it's long.`,
      };
    const track = str(args, 'track')?.trim() || undefined;
    const name = str(args, 'name')?.trim() || undefined;
    if (answer.kind === 'audio') {
      const extra =
        args.tempo !== undefined || parts
          ? ['("tempo" and "parts" are for MIDI and MusicXML: a recording plays at its own speed.)']
          : [];
      return placeRecording(ctx, song, answer.file, answer.how, at, track, name, extra);
    }

    // notes: from the bar the playhead is in, when no place was said
    const from = atText ? at : barLineBefore(song.meter, at);
    const into = track ? trackRef(song, track) : undefined;
    if (into?.kind === 'audio')
      throw new ToolError(
        `"${into.name}" is an audio track: notes go on an instrument track (or leave "track" out for new ones)`,
      );
    let merged: ReturnType<typeof mergeOps>;
    try {
      merged = mergeOps(song, answer.song, {
        at: from,
        tempo: str(args, 'tempo') === 'adopt' ? 'adopt' : 'keep',
        ...(parts ? { parts } : {}),
        ...(into ? { into: into.id } : {}),
        ...(name ? { name } : {}),
      });
    } catch (err) {
      if (err instanceof MergeError) throw new ToolError(err.message);
      throw err;
    }
    await change(ctx, song, merged.ops, `Import ${answer.name}`);
    const kind = answer.format === 'midi' ? 'MIDI' : 'MusicXML';
    const lines = [
      `Imported "${answer.name}" (${kind}) at ${formatBarBeat(song.meter, from)}, the song's tempo ${merged.tempo === 'adopted' ? "giving way to the file's while it runs" : 'kept'}:`,
      ...merged.parts.map(
        (p) =>
          `- ${p.added ? `new track "${p.name}" (${p.track})` : `onto "${p.name}"`}${p.part !== p.name ? `, its part "${p.part}"` : ''}: ${plural(p.notes, 'note')}, ${barsText(song, p.start, p.end)}`,
      ),
      ...merged.notes,
      ...answer.warnings.slice(0, 5).map((w) => `The file: ${w}`),
    ];
    if (merged.parts.some((p) => p.added))
      lines.push('The new tracks play a synth for now: give them instruments that fit with track_set.');
    const end = Math.max(...merged.parts.map((p) => p.end));
    return {
      text: lines.join('\n'),
      progress: `Imported ${answer.name}: ${plural(merged.parts.length, merged.parts.some((p) => p.added) ? 'track' : 'part')}, ${barsText(song, Math.min(...merged.parts.map((p) => p.start)), end)}`,
    };
  },
};

export const importTools: Tool[] = [importTool];
