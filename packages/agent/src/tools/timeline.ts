/**
 * The song's bars, across every track at once: insert empty bars, delete bars, copy bars elsewhere
 * (what was there moving on), move bars. One `arrange` operation each, worked out on the song as the
 * studio has it when it's applied, and one undo step with the rest of the request.
 */
import { barToTick, meterBefore, type Op, onBarLine, type Project, ticksPerBar } from '@holo/session';
import { type Section, sections, sectionsNamed } from '../edits/sections.ts';
import { barOf, barsText, bool, change, num, position, str, type Tool, ToolError } from './common.ts';
import { posText } from './regions.ts';

/** A bar line, from a position the model gave: "17" (bars only). */
function barLine(project: Project, text: string | undefined, what: string): number {
  const tick = position(project, text, what);
  if (!onBarLine(project.meter, tick))
    throw new ToolError(
      `"${text}" isn't on a bar line: ${what} is a whole bar, e.g. "${barOf(project, tick)}" or "${barOf(project, tick) + 1}"`,
    );
  return tick;
}

/** The end of a span: "to" (not included), or "bars" from its start. */
function spanEnd(project: Project, from: number, toText: string | undefined, bars: number | undefined): number {
  if (toText) {
    const to = barLine(project, toText, '"to"');
    if (to <= from) throw new ToolError('"to" comes after "from" (it is where the bars stop, not included)');
    return to;
  }
  if (!bars) throw new ToolError('Say where the bars stop: "to" (not included, e.g. "17") or how many "bars"');
  return barToTick(project.meter, barOf(project, from) + bars);
}

export const timeline: Tool = {
  name: 'timeline',
  kind: 'change',
  summary:
    'Bars across the whole song, every track at once: its regions (cut where a span begins or ends inside one), automation, tempo and meter changes, keys, markers, chords, the cycle, repeats, and the score\'s breaks and clefs all move with their bars. action "insert" puts "bars" empty bars at "at" (what was there moves later); "delete" takes out the bars from "from" to "to" (not included) or "bars" of them; "copy" plays those bars again at "at" (what was there moves later); "move" takes them to "at"; "repeat" plays them again right after themselves. Positions are whole bars ("17"). The song\'s sections (each from a marker to the next, as the Arrangement lane shows them) are listed by "sections", and delete, copy, move and repeat take a "section" by name instead of "from" and "to" ("Bridge"; "Theme 2" for the second section named Theme), with "at" a bar or "before"/"after" another section\'s name. delete and move need "confirm": true. Examples: {"action": "insert", "at": "17", "bars": 4}; {"action": "copy", "from": "9", "to": "17", "at": "33"}; {"action": "move", "section": "Bridge", "at": "before Theme 2", "confirm": true}; {"action": "repeat", "section": "Chorus"}.',
  args: [
    {
      name: 'action',
      type: 'enum',
      values: ['sections', 'insert', 'delete', 'copy', 'move', 'repeat'],
      describe: 'What to do',
      required: true,
    },
    {
      name: 'at',
      type: 'string',
      describe:
        'insert: where the new bars go; copy, move: where the bars go (a bar, e.g. "17", or "before Chorus", "after Chorus")',
    },
    {
      name: 'section',
      type: 'string',
      describe: 'delete, copy, move, repeat: a section by its name, instead of "from" and "to"',
      maxLength: 80,
    },
    { name: 'from', type: 'string', describe: 'delete, copy, move: the first bar, e.g. "9"' },
    {
      name: 'to',
      type: 'string',
      describe: 'delete, copy, move: the bar where the span stops (not included), e.g. "17"',
    },
    {
      name: 'bars',
      type: 'integer',
      describe: "insert: how many bars; or the span's length in bars",
      min: 1,
      max: 999,
    },
    { name: 'confirm', type: 'boolean', describe: 'delete, move: true, once the user wants it', default: false },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const action = str(args, 'action') as 'sections' | 'insert' | 'delete' | 'copy' | 'move' | 'repeat';
    const bars = num(args, 'bars');
    const all = sections(project);
    if (action === 'sections') {
      if (!all.length)
        return { text: 'The song has no sections: a marker starts one (marker {"at": "9", "name": "Verse"}).' };
      return {
        text: all
          .map(
            (s) =>
              `${s.name ? `"${s.name}"` : '(before the first marker)'}: ${barsText(project, s.from, s.to)}${s.whole ? '' : ' (its marker is off a bar line: its bars can’t be moved until it is on one)'}`,
          )
          .join('\n'),
      };
    }
    /** A section by name: one, or a refusal that lists them. */
    const named = (text: string): Section => {
      const found = sectionsNamed(all, text);
      const listed = all
        .filter((s) => s.name)
        .map((s) => `"${s.name}" (${barsText(project, s.from, s.to)})`)
        .join(', ');
      if (!found.length) throw new ToolError(`No section "${text}". The sections: ${listed || 'none'}`);
      if (found.length > 1)
        throw new ToolError(
          `${found.length} sections are named "${text}": say which, "${text} 1" … "${text} ${found.length}" (${listed})`,
        );
      return found[0] as Section;
    };
    /** Where bars go: a bar, or before or after a section. */
    const place = (text: string | undefined): number => {
      const beside = /^(before|after)\s+(.+)$/i.exec(text?.trim() ?? '');
      if (!beside) return barLine(project, text, '"at"');
      const s = named(beside[2] as string);
      return (beside[1] as string).toLowerCase() === 'before' ? s.from : s.to;
    };
    let op: Op;
    let label: string;
    let after: string;
    if (action === 'insert') {
      const at = place(str(args, 'at'));
      if (!bars) throw new ToolError('Say how many "bars" to insert');
      const m = meterBefore(project.meter, at);
      op = { op: 'arrange', edit: 'insert', from: at, to: at + bars * ticksPerBar(m) };
      label = `Inserted ${bars} bar${bars === 1 ? '' : 's'} at ${barOf(project, at)}`;
      after = `${label} (${m.num}/${m.den}); what was at ${barOf(project, at)} is at ${barOf(project, at) + bars} now`;
    } else {
      if ((action === 'delete' || action === 'move') && bool(args, 'confirm') !== true)
        throw new ToolError(`To ${action} bars, send "confirm": true once the user wants it`);
      const sectionName = str(args, 'section')?.trim();
      const section = sectionName ? named(sectionName) : null;
      if (section && !section.whole)
        throw new ToolError(
          `"${section.name}" doesn't start and end on bar lines (its marker, or the next, is inside a bar): move the marker to a bar line first (marker)`,
        );
      const from = section ? section.from : barLine(project, str(args, 'from'), '"from"');
      const to = section ? section.to : spanEnd(project, from, str(args, 'to'), bars);
      const span = section ? `"${section.name}" (${barsText(project, from, to)})` : barsText(project, from, to);
      if (action === 'delete') {
        op = { op: 'arrange', edit: 'delete', from, to };
        label = `Deleted ${span}`;
        after = `${label}; what came after moved back to ${barOf(project, from)}`;
      } else if (action === 'repeat') {
        op = { op: 'arrange', edit: 'copy', from, to, at: to };
        label = `Repeated ${span}`;
        after = `${label}: it plays again from ${barOf(project, to)}, and what was there moved later`;
      } else {
        const at = place(str(args, 'at'));
        if (action === 'move' && at > from && at < to)
          throw new ToolError(`Bars can't move inside themselves (${span})`);
        if (action === 'move' && (at === from || at === to)) throw new ToolError(`${span} are there already`);
        op = { op: 'arrange', edit: action, from, to, at };
        label = `${action === 'copy' ? 'Copied' : 'Moved'} ${span} to ${barOf(project, at)}`;
        after =
          action === 'copy'
            ? `${label}; what was at ${barOf(project, at)} moved later by ${barOf(project, to) - barOf(project, from)} bars`
            : `${label} (bar ${posText(project, at)} of the song as it was)`;
      }
    }
    await change(ctx, project, [op], label);
    return { text: `${after}. One undo step takes it back.`, progress: label };
  },
};

export const timelineTools: Tool[] = [timeline];
