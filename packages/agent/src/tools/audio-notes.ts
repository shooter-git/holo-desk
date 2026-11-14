/**
 * A recording's notes, edited note by note (an audio region's `notes`, audio-notes.ts in the session):
 * the Audio Editor's Notes, for the agent. Its actions are made from the session's list of note edits
 * (`NOTE_EDITS`), so each edit the studio offers is here by the same name, with the same arguments, and
 * comes out the same; an edit added to the list is an action here with no change to this tool.
 * `holo notes` runs this tool from a terminal.
 *
 * - **The region** is named as `regions` names one: its id, its name or "selected", on a track; with
 *   the track alone, its only recording; with neither, the only audio track's.
 * - **The notes** are chosen as the studio chooses them (`selectNotes`): "all", "selected", numbers
 *   counted from 1 ("1-12,15"), "bars 9-13", "pitch E4" (middle C named the studio's way).
 * - **Found, then kept.** Until a region's first edit its notes are found on the host (`measure` with
 *   `notes`: the studio's own detection, of its file), and viewing them changes nothing. They're
 *   numbered as that edit will keep them: the notes the region plays and the two nearest either side
 *   (`pruneNotes`, as a split keeps them). The first edit keeps them in the song with that edit, in
 *   one batch: one undo step.
 * - **Each edit** is one batch of operations, tried on a copy of the song first (`change`); its
 *   arguments are read as the registry reads them (`readNoteArgs`), and refused in its words.
 */
import {
  type AudioClip,
  type AudioNote,
  type AudioNotes,
  type AudioNotesMode,
  fileToTicks,
  isNoteEdited,
  keyAt,
  keysOf,
  type MiddleC,
  NOTE_ARG_UNITS,
  NOTE_EDIT_NAMES,
  NOTE_EDITS,
  type NoteArg,
  type NoteArgValue,
  type NoteEdit,
  noteChanges,
  noteChangesText,
  noteEdit,
  noteName,
  type Op,
  type Project,
  pruneNotes,
  type Region,
  readNoteArgs,
  scaleAt,
  selectNotes,
  type Track,
  tickToBarBeat,
  tickToFile,
} from '@holo/session';
import type { MeasureAnswer, NotesMeasure } from '../api.ts';
import type { ArgDef, ArgType } from '../args.ts';
import { barsText, change, num, plural, str, type Tool, type ToolContext, ToolError, trackRef } from './common.ts';
import { keyName } from './measure.ts';

/** The tool's own fields; every other field is an edit's argument, as the registry names it. */
export const NOTE_TOOL_FIELDS = ['action', 'track', 'region', 'notes', 'page'] as const;
/** Its actions besides the edits. */
const VIEWS = ['show', 'detect'] as const;
/** Notes on a page of `show`. */
const PAGE = 40;

const NOTES_HELP = '"all", "selected", numbers counted from 1 ("1-12,15"), "bars 9-13" or "pitch E4"';

const MODES: Record<AudioNotesMode, string> = {
  mono: 'a line’s notes (mono)',
  poly: 'chords’ notes (poly)',
  perc: 'hits (perc)',
};

const signed = (v: number, digits = 0) => `${v > 0 ? '+' : ''}${v.toFixed(digits)}`;
const pct = (v: number) => `${Math.round(v * 100)}%`;
const NUMERIC = new Set(['semitones', 'cents', 'seconds', 'percent', 'db']);

// ---- the edits' arguments ----

/** An argument's range in words: "-12 to 12 semitones", "0 or more s", "one of up, down". */
function rangeText(a: NoteArg): string {
  const unit = NOTE_ARG_UNITS[a.kind];
  const u = unit ? (unit === '%' ? '%' : ` ${unit}`) : '';
  if (a.values) return a.values.join('|');
  if (a.kind === 'pitch') return 'a note name (E4, F#3+20c) or a MIDI number';
  if (a.kind === 'boolean') return 'true or false';
  if (a.min !== undefined && a.max !== undefined) return `${a.min} to ${a.max}${u}`;
  if (a.min !== undefined) return `${a.min} or more${u}`;
  if (a.max !== undefined) return `${a.max} or less${u}`;
  return `a number${u}`;
}

/** An edit's argument in a line: what it is, its range, and its default (or that it must be given). */
export function noteArgText(a: NoteArg): string {
  const fallback = a.default !== undefined ? `; ${a.default} when left out` : a.required ? '; required' : '';
  return `${a.help} (${rangeText(a)}${fallback})`;
}

/**
 * The tool's field for each argument name the edits use, its type the loosest of theirs (each edit
 * reads its own strictly): numbers, a list of values, or text (a pitch's name). No defaults here: an
 * edit fills in its own.
 */
function editFields(): ArgDef[] {
  const named = new Map<string, { edit: NoteEdit; arg: NoteArg }[]>();
  for (const edit of NOTE_EDITS)
    for (const arg of edit.args) named.set(arg.name, [...(named.get(arg.name) ?? []), { edit, arg }]);
  return [...named].map(([name, uses]): ArgDef => {
    const kinds = new Set(uses.map((x) => x.arg.kind));
    const all = (fits: (k: string) => boolean) => [...kinds].every(fits);
    let type: ArgType = 'string';
    if (all((k) => k === 'snap' || k === 'choice')) type = 'enum';
    else if (all((k) => k === 'boolean')) type = 'boolean';
    else if (all((k) => k === 'index')) type = 'integer';
    else if (all((k) => NUMERIC.has(k) || k === 'index')) type = 'number';
    const describe = uses.map((x) => `${x.edit.name}: ${noteArgText(x.arg)}`).join('; ');
    return {
      name,
      type,
      describe,
      ...(type === 'enum' ? { values: [...new Set(uses.flatMap((x) => x.arg.values ?? []))] } : {}),
      ...(type === 'string' ? { maxLength: 40 } : {}),
    };
  });
}

/** An edit's arguments in brief, for the summary: "semitones"?, "pitch". */
const editLine = (e: NoteEdit) => {
  const args = e.args.map((a) => `"${a.name}"${a.required ? '' : '?'}`).join(', ');
  const only = e.modes.length === 1 ? ` (${MODES[e.modes[0] as AudioNotesMode].replace(/ \(.*\)$/, '')} only)` : '';
  return `${e.name}${args ? ` [${args}]` : ''}: ${e.summary.replace(/\.$/, '')}${only}`;
};

// ---- the region ----

interface Found {
  track: Track;
  region: Region;
}

const regionLine = (project: Project, f: Found) =>
  `"${f.region.name || 'untitled'}" [${f.region.id}] on ${f.track.name}, ${barsText(project, f.region.start, f.region.start + f.region.length)}`;

/** The recording the arguments name: a region by id, name or "selected" (on `track`), or a track's only one. */
async function audioRegion(
  ctx: ToolContext,
  project: Project,
  ref: string | undefined,
  trackText: string | undefined,
): Promise<Found> {
  const track = trackText ? trackRef(project, trackText) : undefined;
  if (track && track.kind !== 'audio')
    throw new ToolError(`${track.name} isn't an audio track: notes are edited in a recording`);
  const audio = project.tracks.filter((t) => t.kind === 'audio');
  const among = (list: Track[]) =>
    list.flatMap((t) => t.regions.filter((r) => r.audio).map((region) => ({ track: t, region })));
  const listOf = (list: Found[]) => list.map((f) => `  ${regionLine(project, f)}`).join('\n');
  const text = ref?.trim();
  if (text && /^selected$/i.test(text)) {
    const ids = (await ctx.api.state()).selection?.regions ?? [];
    const found = among(track ? [track] : audio).filter((f) => ids.includes(f.region.id));
    if (found.length === 1) return found[0] as Found;
    if (!found.length)
      throw new ToolError(
        `No recording is selected in the studio${track ? ` on ${track.name}` : ''}: say the region by its id or name`,
      );
    throw new ToolError(`${found.length} recordings are selected: say which by its id:\n${listOf(found)}`);
  }
  if (text) {
    const byId = among(audio).find((f) => f.region.id === text);
    if (byId) return byId;
    const named = among(track ? [track] : audio).filter((f) => f.region.name.toLowerCase() === text.toLowerCase());
    if (named.length === 1) return named[0] as Found;
    if (named.length > 1)
      throw new ToolError(`"${text}" names ${named.length} recordings; say which by its id:\n${listOf(named)}`);
    const here = among(track ? [track] : audio);
    throw new ToolError(
      `No recording "${text}"${track ? ` on ${track.name}` : ''}.${here.length ? ` The recordings:\n${listOf(here)}` : ''}`,
    );
  }
  const on = track ?? (audio.length === 1 ? (audio[0] as Track) : undefined);
  if (!on)
    throw new ToolError(
      audio.length
        ? `Say which "track" (or "region"): the audio tracks are ${audio.map((t) => `"${t.name}"`).join(', ')}`
        : 'The song has no audio tracks: notes are edited in a recording on one',
    );
  const mine = among([on]);
  if (mine.length === 1) return mine[0] as Found;
  throw new ToolError(
    mine.length
      ? `${on.name} has ${plural(mine.length, 'recording')}: say which ("region": an id or name)\n${listOf(mine)}`
      : `${on.name} has no recordings`,
  );
}

// ---- the notes ----

/** What's known of a region's notes: kept in the song, or found (and cut to what it plays) until its first edit. */
interface RegionNotes {
  notes: AudioNotes;
  kept: boolean;
  /** Each note's drift and vibrato as sung, found by its start, length and pitch; empty when they weren't found. */
  shapes: Map<string, NotesMeasure['shapes'][number]>;
  /** Kept notes' shapes are still being found. */
  shapesPending?: boolean;
  found: NotesMeasure | null;
}

const noteKey = (n: Pick<AudioNote, 't' | 'd' | 'p'>) => `${n.t}|${n.d}|${n.p}`;

/** The seconds of its recording a region plays, [from, to). */
function windowOf(project: Project, region: Region, clip: AudioClip): [number, number] {
  return [clip.offset, tickToFile(project, { start: region.start, audio: clip }, region.start + region.length)];
}

function pendingText(a: Extract<MeasureAnswer, { done: false }>, name: string): string {
  const left =
    a.eta === null ? '' : a.eta < 90 ? `, about ${a.eta} s left` : `, about ${Math.round(a.eta / 60)} min left`;
  return [
    `Still finding the notes of ${name}: ${pct(a.progress)} done${left} (${a.stage}).`,
    "It goes on in HO[LO]: call audio_notes again with the same arguments to get them (each call waits up to 40 s). Meanwhile carry on with other work; don't call it over and over.",
  ].join('\n');
}

/**
 * A region's notes: those it keeps, or those found in its recording on the host (when they're still
 * being found, the same call later gets them). Kept notes' drift and vibrato as sung are found too when
 * `shapes` (they're shown without them when that can't be done at once).
 */
async function regionNotes(
  ctx: ToolContext,
  project: Project,
  f: Found,
  shapes: boolean,
): Promise<RegionNotes | { pending: string }> {
  const clip = f.region.audio as AudioClip;
  const name = project.files?.find((x) => x.id === clip.file)?.name ?? 'the recording';
  const kept = clip.notes;
  let found: NotesMeasure | null = null;
  let pending = false;
  if (!kept || shapes) {
    try {
      const a = await ctx.api.measure({ what: 'notes', track: f.track.id, region: f.region.id });
      if (!a.done) {
        if (!kept) return { pending: pendingText(a, name) };
        pending = true;
      } else if (a.result.kind === 'notes') found = a.result;
    } catch (err) {
      // (kept notes are shown without their shapes when the recording can't be read)
      if (!kept) throw err;
    }
  }
  const byNote = new Map<string, NotesMeasure['shapes'][number]>();
  found?.notes.n.forEach((n, i) => {
    byNote.set(noteKey(n), found?.shapes[i] ?? null);
  });
  if (kept) return { notes: kept, kept: true, shapes: byNote, found, ...(pending ? { shapesPending: true } : {}) };
  if (!found) throw new ToolError(`The notes of ${name} couldn't be found`);
  return { notes: pruneNotes(found.notes, windowOf(project, f.region, clip)), kept: false, shapes: byNote, found };
}

// ---- saying them ----

/** A tick as bar.beat.sixteenth. */
function pos(project: Project, tick: number): string {
  const p = tickToBarBeat(project.meter, Math.round(tick));
  return `${p.bar}.${p.beat}.${p.div}`;
}

/** A pitch named as the song's key spells it there, with its cents: "E4 +26c". */
function pitchText(project: Project, pitch: number, tick: number, middleC: MiddleC): string {
  const k = Math.round(pitch);
  const cents = Math.round((pitch - k) * 100);
  return `${keyName(k, keyAt(keysOf(project), tick), middleC)}${cents ? ` ${signed(cents)}c` : ''}`;
}

/** A note's edits in words: "pitch +2 st, vibrato 0%". */
function editsText(n: AudioNote): string {
  const out: string[] = [];
  if (n.p !== null && n.to !== undefined && n.to !== n.p) {
    const st = n.to - n.p;
    out.push(`pitch ${signed(st, Math.abs(st - Math.round(st)) < 0.005 ? 0 : 2)} st`);
  }
  if (n.dr !== undefined && n.dr !== 1) out.push(`drift ${pct(n.dr)}`);
  if (n.mo !== undefined && n.mo !== 1) out.push(`vibrato ${pct(n.mo)}`);
  if (n.tr !== undefined && n.tr !== 1) out.push(`glide ${pct(n.tr)}`);
  if (n.fo !== undefined && n.fo !== 0) out.push(`formant ${signed(n.fo, 2).replace(/\.?0+$/, '')} st`);
  if (n.g !== undefined && n.g !== 0) out.push(`${signed(n.g, 1)} dB`);
  if (n.m) out.push('muted');
  if (n.ts !== undefined && n.ts !== n.t) out.push(`starts ${signed((n.ts - n.t) * 1000)} ms`);
  if (n.te !== undefined && Math.abs(n.te - (n.t + n.d)) > 1e-4)
    out.push(`ends ${signed((n.te - n.t - n.d) * 1000)} ms`);
  if (n.at !== undefined && n.at !== 1) out.push(`attack ${pct(n.at)}`);
  if (n.s !== undefined && n.s !== n.t) out.push('pasted');
  return out.join(', ');
}

/** One note in a line: its number, where, its pitch found → where it's moved, length, vibrato and drift as sung, edits. */
function noteLine(
  project: Project,
  rn: RegionNotes,
  i: number,
  tickOf: (s: number) => number,
  window: [number, number],
  middleC: MiddleC,
): string {
  const n = rn.notes.n[i] as AudioNote;
  const tick = tickOf(n.t + (n.u ?? 0));
  const parts = [`${i + 1}`, pos(project, Math.max(0, tick))];
  if (n.p === null) parts.push('no pitch (a breath, a consonant or a noise)');
  else {
    let pitch = pitchText(project, n.p, tick, middleC);
    const now = n.to ?? n.p;
    if (n.to !== undefined && n.to !== n.p) pitch += ` → ${pitchText(project, n.to, tick, middleC)}`;
    const scale = scaleAt(project, tick);
    if (scale && !scale.steps.includes((((Math.round(now) - scale.tonic) % 12) + 12) % 12)) pitch += ' (off the key)';
    parts.push(pitch);
  }
  parts.push(`${n.d.toFixed(2)} s`);
  const shape = rn.shapes.get(noteKey(n));
  if (shape?.vibrato) parts.push(`vibrato ${shape.vibrato[0].toFixed(1)} Hz ±${shape.vibrato[1].toFixed(0)}c`);
  if (shape && Math.abs(shape.drift) >= 10) parts.push(`drift ${signed(shape.drift)}c`);
  const edits = editsText(n);
  if (edits) parts.push(`[${edits}]`);
  if (n.t + n.d <= window[0] || n.t >= window[1]) parts.push('(outside the region)');
  return parts.join('  ');
}

/** What a region's notes are, in a line. */
function headLine(project: Project, f: Found, rn: RegionNotes): string {
  const edited = rn.notes.n.filter(isNoteEdited).length;
  const what = `${regionLine(project, f)}: ${plural(rn.notes.n.length, 'note')}, ${MODES[rn.notes.mode]}`;
  if (!rn.kept)
    return `${what}; not edited yet: found by HO[LO], and kept in the song with the first edit (one undo step).`;
  return `${what}, kept in the song; ${edited ? `${edited} edited` : 'none edited'}${rn.notes.off ? '; its edits are off (it plays as recorded)' : ''}.`;
}

/** The notes on a page, chosen by `notes` if given. */
function showText(
  ctx: ToolContext,
  project: Project,
  f: Found,
  rn: RegionNotes,
  chosen: number[] | null,
  page: number,
  chosenText?: string,
): string {
  const clip = f.region.audio as AudioClip;
  const tickOf = fileToTicks(project, { start: f.region.start, audio: { ...clip, notes: rn.notes } });
  const window = windowOf(project, f.region, clip);
  const list = chosen ?? rn.notes.n.map((_, i) => i);
  const lines = [headLine(project, f, rn)];
  if (rn.found?.looks === 'poly' || rn.found?.looks === 'perc')
    lines.push(
      'It sounds like chords or several voices: its notes are its strongest line’s, and editing a chord’s notes comes in a later version.',
    );
  if (!list.length) {
    lines.push(
      chosenText
        ? `"${chosenText}" chooses none of them.`
        : 'No notes were found: it may be silent there, or too quiet.',
    );
    return lines.join('\n');
  }
  const pages = Math.max(1, Math.ceil(list.length / PAGE));
  const p = Math.min(Math.max(1, page), pages);
  const shown = list.slice((p - 1) * PAGE, p * PAGE);
  const first = (shown[0] as number) + 1;
  const last = (shown[shown.length - 1] as number) + 1;
  lines.push(
    `${chosenText ? `"${chosenText}": ` : ''}${first === last ? `note ${first}` : `notes ${first}–${last}`}${pages > 1 ? ` (page ${p} of ${pages})` : ''} (number, where, the pitch found → where it's moved, length, vibrato and drift as sung, [edits]):`,
  );
  for (const i of shown) lines.push(noteLine(project, rn, i, tickOf, window, ctx.middleC));
  if (rn.shapesPending) lines.push('(Vibrato and drift as sung are still being found: show again for them.)');
  if (p < pages) lines.push(`More on page ${p + 1}.`);
  return lines.join('\n');
}

/** What was found, in a few lines. */
function detectText(project: Project, f: Found, rn: RegionNotes, middleC: MiddleC): string {
  const found = rn.found as NotesMeasure;
  const lines: string[] = [];
  if (rn.kept) {
    lines.push(
      `${headLine(project, f, rn)} They stay as they were found then; "show" lists them, and "reset" puts edits back.`,
    );
    return lines.join('\n');
  }
  const pitched = rn.notes.n.filter((n) => n.p !== null);
  const off = pitched.filter((n) => Math.abs((n.p as number) - Math.round(n.p as number)) > 0.25).length;
  const shapes = rn.notes.n.map((n) => rn.shapes.get(noteKey(n)) ?? null);
  const vibrato = shapes.filter((s) => s?.vibrato).length;
  const drifting = shapes.filter((s) => s && Math.abs(s.drift) >= 15).length;
  const ps = pitched.map((n) => n.p as number);
  lines.push(
    `Found ${plural(found.notes.n.length, 'note')} in ${found.name} (${found.seconds.toFixed(1)} s), ${MODES[found.notes.mode]}; "${f.region.name || 'the region'}" on ${f.track.name} has ${plural(rn.notes.n.length, 'note')} of them (those it plays, and the nearest just past its edges).`,
  );
  if (ps.length)
    lines.push(
      `Pitches ${noteName(Math.round(Math.min(...ps)), middleC)}–${noteName(Math.round(Math.max(...ps)), middleC)}; ${off} more than 25 cents off a semitone; vibrato on ${vibrato}, ${drifting} drifting 15 cents or more as held${pitched.length < rn.notes.n.length ? `; ${rn.notes.n.length - pitched.length} with no pitch (breaths, consonants)` : ''}.`,
    );
  if (found.looks !== 'mono')
    lines.push(
      'It sounds like chords or several voices: its notes are its strongest line’s, and editing a chord’s notes comes in a later version.',
    );
  lines.push(
    'Nothing is kept in the song yet: the first edit keeps them, with it, as one undo step. "show" lists them.',
  );
  return lines.join('\n');
}

/** The words that chose notes, said: "note 5", "notes 1-12", "all notes". */
function chosenWords(text: string, count: number): string {
  const t = text.trim();
  if (/^all$/i.test(t)) return 'all notes';
  if (/^selected$/i.test(t)) return `the ${plural(count, 'selected note')}`;
  if (/^(?:notes?\s+)?[\d\s,-]+$/i.test(t)) {
    const nums = t.replace(/^notes?\s+/i, '');
    return `${count === 1 && /^\d+$/.test(nums) ? 'note' : 'notes'} ${nums}`;
  }
  return t;
}

/** The arguments given, said: "2 semitones", "keep 0%", "snap scale". */
function argsWords(
  edit: NoteEdit,
  given: Record<string, unknown>,
  read: Record<string, NoteArgValue>,
  middleC: MiddleC,
) {
  return edit.args
    .filter((a) => given[a.name] !== undefined)
    .map((a) => {
      const v = read[a.name];
      const unit = NOTE_ARG_UNITS[a.kind];
      if (a.kind === 'pitch' && typeof v === 'number') return `${a.name} ${noteName(v, middleC)}`;
      if (typeof v !== 'number') return `${a.name} ${v}`;
      const bare = a.name === unit || (a.name === 'seconds' && unit === 's') || (a.name === 'db' && unit === 'dB');
      const value = `${v}${unit === '%' ? '%' : unit ? ` ${unit}` : ''}`;
      return bare ? value : `${a.name} ${value}`;
    })
    .join(', ');
}

// ---- the tool ----

const ACTIONS = [...VIEWS, ...NOTE_EDIT_NAMES];

export const audioNotes: Tool = {
  name: 'audio_notes',
  kind: 'change',
  summary: ({ middleC }) =>
    `Edit a recording's notes one by one, as the studio's Audio Editor does: their pitch, drift, vibrato, glide, formant, level and timing (an audio region; the recording itself is never changed). The region: "region" (its id, its name or "selected") and/or "track" (alone: its only recording; neither: the only audio track's). Actions: show (the notes, ${PAGE} a "page": number, where, the pitch found with its cents → where it's moved, length, vibrato and drift as sung, edits); detect (find them; nothing is kept in the song until the first edit, which keeps them with it as one undo step); and the edits, each on "notes" chosen as ${NOTES_HELP} (middle C is ${middleC}): ${NOTE_EDITS.map(editLine).join('; ')}. Example: {"action": "shift", "track": "Vocal", "notes": "5", "semitones": 2}. Check an edit with measure ("take"): it measures what plays, edits in.`,
  args: [
    { name: 'action', type: 'enum', values: ACTIONS, describe: 'What to do', required: true },
    { name: 'track', type: 'string', describe: 'The audio track (name or id)' },
    {
      name: 'region',
      type: 'string',
      describe: 'The recording: its region’s id (rgn_…), its name, or "selected"',
      maxLength: 120,
    },
    {
      name: 'notes',
      type: 'string',
      describe: `Which notes: ${NOTES_HELP}; show: only those`,
      maxLength: 400,
    },
    { name: 'page', type: 'integer', describe: `show: which page of ${PAGE} notes`, min: 1, max: 1000 },
    ...editFields(),
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const action = str(args, 'action') as string;
    const notesText = str(args, 'notes')?.trim() || undefined;
    const edit = noteEdit(action);
    // an edit's arguments are checked before anything is found
    const given: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(args))
      if (!(NOTE_TOOL_FIELDS as readonly string[]).includes(k) && v !== undefined) given[k] = v;
    let read: Record<string, NoteArgValue> = {};
    if (edit) {
      try {
        read = readNoteArgs(edit, given, ctx.middleC);
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
      if (edit.selection && !notesText) throw new ToolError(`Say which "notes": ${NOTES_HELP}`);
      if (!edit.selection && notesText) throw new ToolError(`${edit.name} chooses no notes: leave "notes" out`);
    } else if (Object.keys(given).length)
      throw new ToolError(
        `${action} takes no ${Object.keys(given)
          .map((k) => `"${k}"`)
          .join(', ')}`,
      );
    if (num(args, 'page') !== undefined && action !== 'show') throw new ToolError('"page" is for show');

    const f = await audioRegion(ctx, project, str(args, 'region'), str(args, 'track'));
    const clip = f.region.audio as AudioClip;
    const got = await regionNotes(ctx, project, f, action === 'show');
    if ('pending' in got) return { text: got.pending };
    const rn = got;
    const placing = { start: f.region.start, audio: clip };

    /** The notes the words choose, or why they choose none. */
    const choose = async (text: string): Promise<number[]> => {
      let selected: number[] = [];
      if (/^selected$/i.test(text)) {
        const sel = (await ctx.api.state()).selection?.audioNotes;
        selected = sel?.region === f.region.id ? sel.notes : [];
        if (!selected.length)
          throw new ToolError(
            `No notes of "${f.region.name}" are selected in the studio's Notes: say them by number, bars or pitch`,
          );
      }
      try {
        return selectNotes(rn.notes, text, { selected, project, region: placing, middleC: ctx.middleC });
      } catch (err) {
        throw new ToolError(err instanceof Error ? err.message : String(err));
      }
    };

    if (action === 'show') {
      const chosen = notesText ? await choose(notesText) : null;
      return { text: showText(ctx, project, f, rn, chosen, num(args, 'page') ?? 1, notesText) };
    }
    if (action === 'detect') return { text: detectText(project, f, rn, ctx.middleC) };

    const e = edit as NoteEdit;
    if (!e.modes.includes(rn.notes.mode))
      throw new ToolError(
        `${e.name} is for ${e.modes.map((m) => MODES[m]).join(' and ')}: the notes of "${f.region.name}" are ${MODES[rn.notes.mode]}`,
      );
    const indices = e.selection ? await choose(notesText as string) : [];
    if (e.selection && !indices.length)
      throw new ToolError(`"${notesText}" chooses none of the notes of "${f.region.name}"`);
    const editCtx = { project, region: placing, middleC: ctx.middleC };
    const next = e.apply(rn.notes, indices, read, editCtx);
    const said = [
      e.selection ? chosenWords(notesText as string, indices.length) : '',
      argsWords(e, given, read, ctx.middleC),
    ]
      .filter(Boolean)
      .join(', ');
    const label = `"${f.region.name || 'the region'}": ${e.name}${said ? ` ${said}` : ''}`;
    if (next === rn.notes) {
      // the notes chosen have no pitch, and the edit would change them if they had (a pitch edit on a breath)
      const unpitched = indices.length > 0 && indices.every((i) => rn.notes.n[i]?.p === null);
      const pitched = unpitched && {
        ...rn.notes,
        n: rn.notes.n.map((n, i) => (indices.includes(i) ? { ...n, p: 60 } : n)),
      };
      const why =
        pitched && e.apply(pitched, indices, read, editCtx) !== pitched
          ? `${indices.length === 1 ? `note ${(indices[0] as number) + 1} has` : 'those notes have'} no pitch (a breath, a consonant or a noise) for it to change`
          : 'they are that way already';
      return { text: `Nothing changed: ${label} leaves the notes as they are: ${why}.` };
    }
    const ops: Op[] = [
      { op: 'updateRegion', track: f.track.id, region: f.region.id, patch: { audio: { ...clip, notes: next } } },
    ];
    await change(ctx, project, ops, label);
    // (against the notes as found, before a first edit: a split or an added note is said too)
    const changes = noteChanges(rn.notes, next);
    const after: RegionNotes = { ...rn, notes: next, kept: true };
    const tickOf = fileToTicks(project, { start: f.region.start, audio: { ...clip, notes: next } });
    const window = windowOf(project, f.region, clip);
    const touched = new Set(changes.now);
    const shown = next.n.map((n, i) => (touched.has(n) ? i : -1)).filter((i) => i >= 0);
    const lines = [
      `${label}: ${noteChangesText(changes) || 'changed'}${rn.kept ? '' : '; its notes are kept in the song from now on, as found, with this edit'}.`,
    ];
    if (shown.length) {
      lines.push(shown.length > 12 ? `The first 12 of the ${shown.length} changed, now:` : 'Now:');
      for (const i of shown.slice(0, 12)) lines.push(noteLine(project, after, i, tickOf, window, ctx.middleC));
    }
    return { text: lines.join('\n'), progress: label };
  },
};

export const audioNoteTools: Tool[] = [audioNotes];
