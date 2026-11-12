/**
 * The song's bars, across every track at once: insert empty bars, delete bars, copy bars elsewhere
 * (what was there moving on), move bars. One `arrange` operation each, worked out on the song as the
 * studio has it when it's applied, and one undo step with the rest of the request.
 */
import { barToTick, meterBefore, type Op, onBarLine, type Project, ticksPerBar } from '@holo/session';
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
    'Bars across the whole song, every track at once: its regions (cut where a span begins or ends inside one), automation, tempo and meter changes, keys, markers, chords, the cycle, repeats, and the score\'s breaks and clefs all move with their bars. action "insert" puts "bars" empty bars at "at" (what was there moves later); "delete" takes out the bars from "from" to "to" (not included) or "bars" of them; "copy" plays those bars again at "at" (what was there moves later); "move" takes them to "at". Positions are whole bars ("17"). delete and move need "confirm": true. Examples: {"action": "insert", "at": "17", "bars": 4}; {"action": "copy", "from": "9", "to": "17", "at": "33"}; {"action": "delete", "from": "25", "bars": 2, "confirm": true}.',
  args: [
    {
      name: 'action',
      type: 'enum',
      values: ['insert', 'delete', 'copy', 'move'],
      describe: 'What to do',
      required: true,
    },
    {
      name: 'at',
      type: 'string',
      describe: 'insert: where the new bars go; copy, move: where the bars go (a bar, e.g. "17")',
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
    const action = str(args, 'action') as 'insert' | 'delete' | 'copy' | 'move';
    const bars = num(args, 'bars');
    let op: Op;
    let label: string;
    let after: string;
    if (action === 'insert') {
      const at = barLine(project, str(args, 'at'), '"at"');
      if (!bars) throw new ToolError('Say how many "bars" to insert');
      const m = meterBefore(project.meter, at);
      op = { op: 'arrange', edit: 'insert', from: at, to: at + bars * ticksPerBar(m) };
      label = `Inserted ${bars} bar${bars === 1 ? '' : 's'} at ${barOf(project, at)}`;
      after = `${label} (${m.num}/${m.den}); what was at ${barOf(project, at)} is at ${barOf(project, at) + bars} now`;
    } else {
      if ((action === 'delete' || action === 'move') && bool(args, 'confirm') !== true)
        throw new ToolError(`To ${action} bars, send "confirm": true once the user wants it`);
      const from = barLine(project, str(args, 'from'), '"from"');
      const to = spanEnd(project, from, str(args, 'to'), bars);
      const span = barsText(project, from, to);
      if (action === 'delete') {
        op = { op: 'arrange', edit: 'delete', from, to };
        label = `Deleted ${span}`;
        after = `${label}; what came after moved back to ${barOf(project, from)}`;
      } else {
        const at = barLine(project, str(args, 'at'), '"at"');
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
