/**
 * What every tool shares: its shape, its errors, and the small checks that turn the model's words
 * (a track's name, "9.3", "1/8") into the song's own references, or a plain reason they can't be.
 */
import {
  applyOps,
  type Bus,
  barToTick,
  type Channel,
  DIVISIONS,
  firstBar,
  type MiddleC,
  type Op,
  type Project,
  parsePosition,
  parseProject,
  type Track,
  tickToBarBeat,
} from '@holo/session';
import type { Image, JobApi } from '../api.ts';
import type { ArgDef, Args } from '../args.ts';

export type ToolKind = 'see' | 'change' | 'play' | 'ask';

export interface ToolContext {
  api: JobApi;
  /** How the studio names middle C (MIDI 60): the agent reads and writes note names the same way. */
  middleC: MiddleC;
}

export interface ToolResult {
  text: string;
  images?: Image[];
  /** A few words for the bar while the agent works, when the tool changed something. */
  progress?: string;
}

export interface Tool {
  name: string;
  kind: ToolKind;
  /** The description the model reads: what it does, units, an example. */
  summary: string | ((ctx: { middleC: MiddleC }) => string);
  args: ArgDef[];
  run(ctx: ToolContext, args: Args): Promise<ToolResult>;
}

/** A mistake in what the model asked for, said plainly so it can fix it and try again. */
export class ToolError extends Error {}

export function describeTool(tool: Tool, middleC: MiddleC): string {
  return typeof tool.summary === 'function' ? tool.summary({ middleC }) : tool.summary;
}

// ---- reading arguments (already checked against the tool's ArgDefs) ----

export const str = (a: Args, k: string): string | undefined =>
  typeof a[k] === 'string' ? (a[k] as string) : undefined;
export const num = (a: Args, k: string): number | undefined =>
  typeof a[k] === 'number' ? (a[k] as number) : undefined;
export const bool = (a: Args, k: string): boolean | undefined =>
  typeof a[k] === 'boolean' ? (a[k] as boolean) : undefined;
export const obj = (a: Args, k: string): Record<string, unknown> | undefined =>
  typeof a[k] === 'object' && a[k] !== null && !Array.isArray(a[k]) ? (a[k] as Record<string, unknown>) : undefined;

export function need(a: Args, k: string): string {
  const v = str(a, k)?.trim();
  if (!v) throw new ToolError(`Say "${k}"`);
  return v;
}

export const plural = (n: number, word: string, many = `${word}s`) => `${n} ${n === 1 ? word : many}`;

// ---- the song's references ----

const names = (project: Project) => project.tracks.map((t) => `"${t.name}"`).join(', ') || 'none';

/**
 * A track by id, exact name, or the start of one name (case aside). A start that fits two tracks is
 * refused rather than guessed: writing into the wrong part is worse than asking again.
 */
export function trackRef(project: Project, ref: string | undefined): Track {
  const text = ref?.trim();
  if (!text) throw new ToolError(`Say which track. The tracks: ${names(project)}`);
  const lower = text.toLowerCase();
  const exact = project.tracks.find((t) => t.id === text) ?? project.tracks.find((t) => t.name.toLowerCase() === lower);
  if (exact) return exact;
  const starts = project.tracks.filter((t) => t.name.toLowerCase().startsWith(lower));
  if (starts.length === 1) return starts[0] as Track;
  if (starts.length > 1)
    throw new ToolError(`"${text}" could be ${starts.map((t) => `"${t.name}"`).join(' or ')}: say which`);
  throw new ToolError(`No track "${text}". The tracks: ${names(project)}`);
}

/** Where a mix setting lives: a track's channel, a bus's, or the master's. */
export interface ChannelRef {
  /** The id ops use: a track id, a bus id or "master". */
  id: string;
  name: string;
  channel: Channel;
  kind: 'track' | 'bus' | 'master';
  track?: Track;
  bus?: Bus;
}

export function channelRef(project: Project, ref: string | undefined): ChannelRef {
  const text = ref?.trim() ?? '';
  const lower = text.toLowerCase();
  if (lower === 'master' || lower === 'stereo out')
    return { id: 'master', name: 'the master', channel: project.master, kind: 'master' };
  const bus = project.buses.find((b) => b.id === text || b.name.toLowerCase() === lower);
  if (bus) return { id: bus.id, name: bus.name, channel: bus.channel, kind: 'bus', bus };
  try {
    const track = trackRef(project, text);
    return { id: track.id, name: track.name, channel: track.channel, kind: 'track', track };
  } catch (err) {
    const buses = project.buses.map((b) => `"${b.name}"`).join(', ');
    throw new ToolError(
      `${err instanceof Error ? err.message : String(err)}${buses ? `; the buses: ${buses}` : ''}; or "master"`,
    );
  }
}

/** A position: "14" (bar 14), "14.3" (its third beat), "14.3.2" (and sixteenth), or "t:3840" (a tick). */
export function position(project: Project, text: string | undefined, what = 'position'): number {
  const t = text?.trim();
  if (!t) throw new ToolError(`Say the ${what} as bar.beat.sixteenth, e.g. "9" or "9.3"`);
  let tick: number;
  try {
    tick = parsePosition(project.meter, t);
  } catch {
    throw new ToolError(`"${t}" isn't a ${what}: use bar.beat.sixteenth, e.g. "9", "9.3" or "9.3.2"`);
  }
  const lowest = firstBar(project.meter);
  if (!Number.isFinite(tick)) throw new ToolError(`"${t}" isn't a ${what}: use bar.beat.sixteenth, e.g. "9" or "9.3"`);
  if (tick < 0 || (!t.startsWith('t:') && Number(t.split(/[.\s]/)[0]) < lowest))
    throw new ToolError(`"${t}" is before the song starts (its first bar is ${lowest})`);
  return Math.round(tick);
}

/** A bar number as the tick it starts at. */
export function barTick(project: Project, bar: number): number {
  const lowest = firstBar(project.meter);
  if (!Number.isInteger(bar) || bar < lowest) throw new ToolError(`Bars count from ${lowest}`);
  return barToTick(project.meter, bar);
}

export const barOf = (project: Project, tick: number): number => tickToBarBeat(project.meter, tick).bar;

/** "bar 9" or "bars 9–12", for the span [from, to). */
export function barsText(project: Project, from: number, to: number): string {
  const a = barOf(project, from);
  const b = barOf(project, Math.max(from, to - 1));
  return a === b ? `bar ${a}` : `bars ${a}–${b}`;
}

/** A note unit ("1/8", "1/16", "1/4T"…) in ticks. */
export function unitTicks(unit: string | undefined): number {
  const t = DIVISIONS[unit ?? '1/8'];
  if (!t) throw new ToolError(`"unit" must be one of ${Object.keys(DIVISIONS).join(', ')}`);
  return t;
}

export const UNITS = Object.keys(DIVISIONS);

// ---- changing the song ----

/**
 * Send changes to the requester's studio as one batch (a fresh id, so a retry can't apply it twice).
 * They're tried on this copy of the song first, so a change the studio would refuse is refused here,
 * with the reason, before anything is sent.
 */
export async function change(
  ctx: ToolContext,
  project: Project,
  ops: Op[],
  label: string,
): Promise<number | undefined> {
  if (!ops.length) throw new ToolError('Nothing to change');
  try {
    // the studio checks the result the same way before it takes the change
    parseProject(applyOps(project, ops));
  } catch (err) {
    throw new ToolError(`That change can't be made: ${err instanceof Error ? err.message : String(err)}`);
  }
  const r = await ctx.api.ops(ops, label.slice(0, 120), crypto.randomUUID());
  if (!r.ok) throw new ToolError('The studio refused the change');
  return r.revision;
}

/** A number set by name ("mix": 30), checked against a list of knobs; options may be given by name. */
export function knobValues(
  given: Record<string, unknown>,
  defs: readonly { id: string; name: string; min: number; max: number; options?: string[]; unit?: string }[],
  owner: string,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [k, raw] of Object.entries(given)) {
    const def = defs.find((d) => d.id === k) ?? defs.find((d) => d.name.toLowerCase() === k.toLowerCase());
    if (!def) throw new ToolError(`${owner} has no "${k}": ${defs.map((d) => d.id).join(', ')}`);
    let v: number;
    if (typeof raw === 'number') v = raw;
    else if (typeof raw === 'string' && /^\s*-?[\d.]+\s*$/.test(raw)) v = Number(raw);
    else if (typeof raw === 'string' && def.options) {
      const i = def.options.findIndex((o) => o.toLowerCase() === raw.trim().toLowerCase());
      if (i < 0) throw new ToolError(`${def.id} is one of ${def.options.map((o, j) => `${j}=${o}`).join(', ')}`);
      v = i;
    } else if (typeof raw === 'boolean' && def.options?.length === 2) v = raw ? 1 : 0;
    else throw new ToolError(`${def.id} takes a number${def.options ? ' or an option name' : ''}`);
    if (!Number.isFinite(v) || v < def.min || v > def.max) {
      const range = def.options
        ? def.options.map((o, j) => `${j}=${o}`).join(', ')
        : `${def.min} to ${def.max}${def.unit ? ` ${def.unit}` : ''}`;
      throw new ToolError(`${def.id} goes ${def.options ? 'through' : 'from'} ${range} (got ${raw})`);
    }
    out[def.id] = v;
  }
  return out;
}
