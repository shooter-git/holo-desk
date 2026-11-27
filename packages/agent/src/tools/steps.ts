/**
 * The Step Grid, for the agent: a drum track's bars as lines of steps, a row for each piece of the
 * kit, read and written. It makes the same edits the studio's grid does, from the same place
 * (edits/steps.ts), so a pattern written here is the one the person sees lit.
 */
import { barToTick, meterAt, type Project, type Track, ticksPerBar } from '@holo/session';
import {
  heldOf,
  kitRows,
  levelNamed,
  playsHits,
  readSteps,
  rowNamed,
  STEP_EDITS,
  STEP_GRIDS,
  STEP_LEVELS,
  type Step,
  type StepContext,
  type StepEdit,
  type StepRowName,
  stepLine,
  stepOps,
  stepRows,
  stepSize,
  stepsIn,
} from '../edits/steps.ts';
import {
  barOf,
  barsText,
  barTick,
  bool,
  change,
  num,
  plural,
  str,
  type Tool,
  type ToolContext,
  ToolError,
  trackRef,
} from './common.ts';

const ACTIONS = ['show', ...STEP_EDITS.map((e) => e.name)] as const;
const LEGEND = 'X accent, x hit, o soft, g ghost, . none.';
/** The most bars shown or written at once. */
const MOST_BARS = 16;

/** "9" or "9-12" as the ticks those bars run over. */
function barsOf(project: Project, text: string): { from: number; to: number } {
  const m = /^\s*(-?\d+)\s*(?:[-–]\s*(-?\d+))?\s*$/.exec(text);
  if (!m) throw new ToolError(`"${text}" isn't bars: use "9-12" or "9"`);
  const first = Number(m[1]);
  const last = m[2] === undefined ? first : Number(m[2]);
  if (last < first) throw new ToolError('The last bar comes after the first');
  if (last - first + 1 > MOST_BARS) throw new ToolError(`At most ${MOST_BARS} bars at a time`);
  return { from: barTick(project, first), to: barTick(project, last + 1) };
}

/** The bars a part is shown over when none are said: where its first region starts, up to four of them. */
function firstBars(project: Project, track: Track): { from: number; to: number } {
  const first = [...track.regions].filter((r) => !r.audio).sort((a, b) => a.start - b.start)[0];
  const bar = barOf(project, first?.start ?? 0);
  const from = barToTick(project.meter, bar);
  let to = from;
  for (let i = 0; i < 4; i++) {
    to += ticksPerBar(meterAt(project.meter, to));
    if (first && to >= first.start + first.length) break;
  }
  return { from, to };
}

/** The kit a track plays, as rows; a ToolError for an instrument played by pitch. */
async function kitOf(ctx: ToolContext, track: Track): Promise<StepRowName[]> {
  const inst = track.instrument;
  if (track.kind !== 'instrument') throw new ToolError(`${track.name} is an audio track: it has no steps`);
  if (inst.type === 'synth') {
    if (!playsHits(inst, null))
      throw new ToolError(
        `${track.name} plays "${inst.preset}" by pitch, not as a kit: the Step Grid is for drums (its notes are notes_show's)`,
      );
    return kitRows(null);
  }
  if (inst.type === 'sampler' || inst.type === 'performance') {
    const map = await ctx.api.instrument(inst.pack, inst.name);
    if (!playsHits(inst, map))
      throw new ToolError(
        `${track.name} plays ${inst.pack}/${inst.name} by pitch, not as a kit: the Step Grid is for drums (its notes are notes_show's)`,
      );
    const pads = (map.pads ?? []).filter(
      (p): p is { key: number; name: string } =>
        typeof (p as { key?: unknown })?.key === 'number' && typeof (p as { name?: unknown })?.name === 'string',
    );
    // (sounds with no names of their own: only the keys the part plays, by number)
    return pads.length ? kitRows(pads) : [];
  }
  // (no instrument yet: General MIDI's drums, as the studio's pads show)
  return kitRows(null);
}

/** A part's bars as lines, a row a piece: what `show` says, and what a change is answered with. */
export function stepLines(
  project: Project,
  track: Track,
  kit: readonly StepRowName[],
  span: { from: number; to: number },
  grid: string,
  all = false,
): string {
  const size = stepSize(grid);
  const steps = stepsIn(project.meter, span.from, span.to, size);
  const rows = readSteps(heldOf(track), steps, span.to);
  const shown = stepRows(kit, rows.keys(), all);
  const width = Math.max(4, ...shown.map((r) => r.name.length));
  // a bar's steps, then a bar line
  const barred = (text: string) => {
    let out = '';
    steps.forEach((s: Step, i) => {
      if (i > 0 && s.index === 0) out += ' | ';
      out += text[i] ?? '.';
    });
    return out;
  };
  const perBar = steps.filter((s) => s.bar === steps[0]?.bar).length;
  const lines = shown.map((r) => {
    const cells = rows.get(r.note);
    return `${r.name.padEnd(width)}  ${barred(cells ? stepLine(cells) : '.'.repeat(steps.length))}`;
  });
  const quiet = kit.filter((r) => !shown.includes(r));
  const drummer = track.midiFx.some((p) => p.type === 'drummer' && !p.bypass);
  return [
    `${track.name}, ${barsText(project, span.from, span.to)}, ${grid} (${perBar} steps a bar):`,
    ...(lines.length ? lines : ['(no notes here)']),
    ...(quiet.length && !all ? [`The kit also has: ${quiet.map((r) => r.name).join(', ')}.`] : []),
    ...(drummer
      ? ['The Session Drummer plays this track too (a MIDI effect): its hits aren’t notes, so they aren’t steps here.']
      : []),
    LEGEND,
  ].join('\n');
}

export const steps: Tool = {
  name: 'steps',
  kind: 'change',
  summary: `A drum track as the Step Grid shows it: its bars as lines of steps, a row for each piece of the kit (${LEGEND.slice(0, -1)}; a bar line between bars). With no "action" it shows them: {"track": "Drums", "bars": "9-10"}. To write rows, "lines" names each with its pattern, a character a step, repeated to fill the bars: {"track": "Drums", "bars": "9-12", "action": "write", "lines": "Kick: x...x...x...x...; Snare: ....X.......X...; Closed Hat: x.x.x.x.x.x.x.x."} (a row left out is left as it is). The other actions work on one "row" (a piece by name or key; left out, every row that has notes there, where that makes sense): ${STEP_EDITS.filter(
    (e) => e.name !== 'write',
  )
    .map((e) => `"${e.name}" (${e.does})`)
    .join(
      ', ',
    )}. "step" counts the steps of the bars from 1 (step 17 is the first of the second bar on a 1/16 grid). A lit step is a note: it keeps its exact place when it wasn't played on the grid, and looking never moves it. For a kit only; a pitched part's notes are notes_show's.`,
  args: [
    { name: 'track', type: 'string', describe: 'The drum track: its name (or the start of it) or id', required: true },
    {
      name: 'bars',
      type: 'string',
      describe: 'The bars, e.g. "9-12" or "9" (the part’s first bars when left out)',
      maxLength: 20,
    },
    { name: 'grid', type: 'enum', values: STEP_GRIDS, describe: 'The step', default: '1/16' },
    { name: 'action', type: 'enum', values: ACTIONS, describe: 'What to do', default: 'show' },
    {
      name: 'row',
      type: 'string',
      describe: 'A piece of the kit by name or key: "Snare", "Closed Hat", "38"',
      maxLength: 60,
    },
    {
      name: 'lines',
      type: 'string',
      describe: 'write: rows as "Name: pattern", one a line or split by ";"',
      maxLength: 4000,
    },
    {
      name: 'pattern',
      type: 'string',
      describe: 'write: one row’s pattern (with "row"), e.g. "x...x...x...x..."',
      maxLength: 600,
    },
    {
      name: 'step',
      type: 'integer',
      describe: 'set, clear: the step, counted from 1 over the bars',
      min: 1,
      max: 1024,
    },
    {
      name: 'steps',
      type: 'array',
      items: 'number',
      describe: 'set, clear, velocity: several steps, from 1',
      maxLength: 256,
    },
    { name: 'level', type: 'enum', values: STEP_LEVELS.map((l) => l.id), describe: 'How hard: a level' },
    { name: 'velocity', type: 'integer', describe: 'How hard: a velocity, 1-127', min: 1, max: 127 },
    {
      name: 'by',
      type: 'integer',
      describe: 'velocity: how much harder (or softer, below 0); shift: steps later (earlier, below 0)',
      min: -127,
      max: 127,
    },
    {
      name: 'every',
      type: 'integer',
      describe: 'fill: every this many steps (4 on a 1/16 grid is every beat)',
      min: 1,
      max: 64,
    },
    {
      name: 'offset',
      type: 'integer',
      describe: 'fill: the first step it lights, counted from 0',
      min: 0,
      max: 63,
      default: 0,
    },
    { name: 'hits', type: 'integer', describe: 'euclid: how many hits in each bar', min: 0, max: 64 },
    {
      name: 'rotate',
      type: 'integer',
      describe: 'euclid: turn the rhythm this many steps later',
      min: -64,
      max: 64,
      default: 0,
    },
    {
      name: 'amount',
      type: 'number',
      describe: 'humanize: how far velocities may move, 1-60; swing: % of half a step, 0-75 (0 straightens)',
      min: 0,
      max: 75,
    },
    {
      name: 'seed',
      type: 'integer',
      describe: 'humanize: another number gives another variation',
      min: 1,
      max: 1_000_000,
      default: 1,
    },
    { name: 'to', type: 'integer', describe: 'copy: the bar the copy starts at', min: -8, max: 9999 },
    { name: 'times', type: 'integer', describe: 'copy: how many times over', min: 1, max: 64, default: 1 },
    {
      name: 'all',
      type: 'boolean',
      describe: 'show: every piece of the kit, not only those played here',
      default: false,
    },
  ],
  async run(ctx, args) {
    const project = await ctx.api.song();
    const track = trackRef(project, str(args, 'track'));
    const kit = await kitOf(ctx, track);
    const grid = str(args, 'grid') ?? '1/16';
    const barsText_ = str(args, 'bars');
    const span = barsText_ ? barsOf(project, barsText_) : firstBars(project, track);
    const action = (str(args, 'action') ?? 'show') as (typeof ACTIONS)[number];
    if (action === 'show') return { text: stepLines(project, track, kit, span, grid, bool(args, 'all') === true) };

    const size = stepSize(grid);
    const sctx: StepContext = { project, track, from: span.from, to: span.to, size };
    const count = stepsIn(project.meter, span.from, span.to, size).length;
    const rowText = str(args, 'row')?.trim();
    const rowOf = (text: string): StepRowName => {
      const row = rowNamed(kit, text);
      if (!row)
        throw new ToolError(
          `No "${text}" in this kit. Its pieces: ${kit.map((r) => r.name).join(', ') || 'none named: say a key, like "38"'}`,
        );
      return row;
    };
    const row = rowText ? rowOf(rowText) : undefined;
    const needRow = (): StepRowName => {
      if (!row) throw new ToolError(`Say which "row": a piece of the kit by name or key`);
      return row;
    };
    const level = str(args, 'level');
    const v = num(args, 'velocity') ?? (level ? levelNamed(level)?.v : undefined);
    const many = (args.steps as number[] | undefined)?.map((n) => Math.round(Number(n)));
    const one = num(args, 'step');
    /** The steps asked for, from 0. */
    const asked = (): number[] => {
      const list = many?.length ? many : one !== undefined ? [one] : [];
      if (!list.length) throw new ToolError('Say which "step" (or "steps"), counted from 1 over the bars');
      for (const n of list)
        if (!Number.isInteger(n) || n < 1 || n > count)
          throw new ToolError(`The bars have ${count} steps on this grid: step ${n} isn't one of them`);
      return list.map((n) => n - 1);
    };
    const pitch = row ? { pitch: row.note } : {};

    let edits: StepEdit[];
    let label: string;
    const where = `${track.name}, ${barsText(project, span.from, span.to)}`;
    switch (action) {
      case 'set':
        edits = asked().map((step) => ({
          edit: 'set',
          pitch: needRow().note,
          step,
          ...(v !== undefined ? { v } : {}),
        }));
        label = `${needRow().name}: ${plural(edits.length, 'step')} lit`;
        break;
      case 'clear':
        edits = asked().map((step) => ({ edit: 'clear', pitch: needRow().note, step }));
        label = `${needRow().name}: ${plural(edits.length, 'step')} put out`;
        break;
      case 'velocity': {
        const by = num(args, 'by');
        if (v === undefined && !by) throw new ToolError('Say how hard: a "level", a "velocity", or "by" how much');
        const only = many?.length || one !== undefined ? { steps: asked() } : {};
        edits = [{ edit: 'velocity', ...pitch, ...only, ...(v !== undefined ? { v } : { by: by as number }) }];
        label = `${row?.name ?? 'Every row'}: ${v !== undefined ? `hit at ${level ?? v}` : `${(by as number) > 0 ? 'harder' : 'softer'} by ${Math.abs(by as number)}`}`;
        break;
      }
      case 'fill': {
        const every = num(args, 'every');
        if (!every) throw new ToolError('Say "every" how many steps');
        edits = [
          {
            edit: 'fill',
            pitch: needRow().note,
            every,
            offset: num(args, 'offset') ?? 0,
            ...(v !== undefined ? { v } : {}),
          },
        ];
        label = `${needRow().name}: every ${every === 1 ? 'step' : `${every} steps`}`;
        break;
      }
      case 'euclid': {
        const hits = num(args, 'hits');
        if (hits === undefined) throw new ToolError('Say how many "hits" in each bar');
        edits = [
          {
            edit: 'euclid',
            pitch: needRow().note,
            hits,
            rotate: num(args, 'rotate') ?? 0,
            ...(v !== undefined ? { v } : {}),
          },
        ];
        label = `${needRow().name}: ${plural(hits, 'hit')} spread over each bar`;
        break;
      }
      case 'shift': {
        const by = num(args, 'by');
        if (!by) throw new ToolError('Say "by" how many steps (below 0 is earlier)');
        edits = [{ edit: 'shift', ...pitch, by }];
        label = `${row?.name ?? 'The pattern'}: ${plural(Math.abs(by), 'step')} ${by > 0 ? 'later' : 'earlier'}`;
        break;
      }
      case 'humanize': {
        const amount = num(args, 'amount');
        if (!amount) throw new ToolError('Say the "amount": how far a velocity may move, 1-60');
        edits = [{ edit: 'humanize', ...pitch, amount: Math.min(60, amount), seed: num(args, 'seed') ?? 1 }];
        label = `${row?.name ?? 'Every row'}: velocities varied by up to ${Math.min(60, amount)}`;
        break;
      }
      case 'copy': {
        const to = num(args, 'to');
        if (to === undefined) throw new ToolError('Say the bar the copy starts at: "to"');
        const times = num(args, 'times') ?? 1;
        edits = [{ edit: 'copy', ...pitch, to: barTick(project, to), times }];
        const length = span.to - span.from;
        label = `${row?.name ?? 'The pattern'} copied to ${barsText(project, barTick(project, to), barTick(project, to) + length * times)}`;
        break;
      }
      case 'swing': {
        const amount = num(args, 'amount');
        if (amount === undefined) throw new ToolError('Say the "amount": % of half a step, 0-75 (0 straightens)');
        edits = [{ edit: 'swing', ...pitch, amount: amount / 100 }];
        label = amount ? `${row?.name ?? 'The pattern'}: swung ${amount} %` : `${row?.name ?? 'The pattern'}: straight`;
        break;
      }
      case 'clear-row':
        edits = [{ edit: 'clear-row', ...pitch }];
        label = `${row?.name ?? 'Every row'} put out`;
        break;
      case 'write': {
        const lines = str(args, 'lines');
        const pattern = str(args, 'pattern');
        edits = [];
        if (pattern) edits.push({ edit: 'write', pitch: needRow().note, pattern });
        for (const line of (lines ?? '').split(/[\n;]/)) {
          if (!line.trim()) continue;
          const cut = line.search(/[:=]/);
          if (cut < 1) throw new ToolError(`"${line.trim()}" isn't a row: write each as "Snare: ....X.......X..."`);
          edits.push({ edit: 'write', pitch: rowOf(line.slice(0, cut)).note, pattern: line.slice(cut + 1) });
        }
        if (!edits.length)
          throw new ToolError(
            'Say what to write: "lines" ("Kick: x...x...; Snare: ....X..."), or a "row" and its "pattern"',
          );
        label = `${plural(edits.length, 'row')} written`;
        break;
      }
    }

    let ops: ReturnType<typeof stepOps>;
    try {
      ops = stepOps(sctx, edits);
    } catch (err) {
      throw new ToolError(err instanceof Error ? err.message : String(err));
    }
    if (!ops.length)
      return {
        text: `Nothing to change: ${where} is like that already.\n${stepLines(project, track, kit, span, grid)}`,
      };
    const full = `${label} (${where})`;
    await change(ctx, project, ops, full);
    const after = (await ctx.api.song()).tracks.find((t) => t.id === track.id) ?? track;
    return { text: `${full}.\n${stepLines(project, after, kit, span, grid)}`, progress: label };
  },
};

export const stepTools: Tool[] = [steps];
