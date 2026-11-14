/**
 * The `holo` commands that do what the in-app agent's tools do: `holo regions`, `timeline`, `measure`,
 * `played`, `details`, `import`, `packs`, `holo listen --analyze`, and `holo tool NAME` for any of the
 * agent's tools by name. Each runs the agent's own tool (@holo/agent) through the terminal's API
 * (terminal-api.ts), so it does exactly what the agent does and says what it says, with the command
 * line's names for things: flags (`--to-track`) where the tool says fields ("to_track"), and `holo`
 * commands where it names its other tools.
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type Args,
  check,
  describeTool,
  newMemory,
  TOOLS,
  type Tool,
  ToolError,
  type ToolMemory,
  type ToolResult,
  toolNamed,
} from '@holo/agent';
import type { MiddleC } from '@holo/session';
import { TOOL_PARITY } from './parity.ts';
import { aboutLines, type TerminalApi, terminalApi } from './terminal-api.ts';

export interface ToolCommandContext {
  command: string;
  words: string[];
  flags: Map<string, string | true>;
  base: string;
  author: string;
  middleC: MiddleC;
  songId: () => Promise<string>;
}

/** What a tool runs with from the terminal. */
export interface ToolEnv {
  api: TerminalApi;
  middleC: MiddleC;
  memory: ToolMemory;
}

/** Flags every command takes, never a tool's field. */
const GENERAL = new Set(['song', 'names']);

/** How the agent's tools name each other, as the command line names them. */
const COMMAND_FOR: Record<string, string> = {
  song_status: 'holo status',
  song_show: 'holo show',
  song_set: 'holo details',
  ops_apply: 'holo ops',
  notes_show: 'holo show --track',
  notes_write: 'holo write',
  notes_clear: 'holo clear',
  track_add: 'holo track add',
  track_set: 'holo track set',
  synth_set: 'holo synth',
  kit_set: 'holo kit',
  finish_master: 'holo finish',
  score_show: 'holo score show',
  score_parts: 'holo score parts',
  score_write: 'holo score write',
  score_part: 'holo score part',
  score_meta: 'holo score meta',
  analyze_played: 'holo played --analyze',
  scan_show: 'holo scan show',
  scan_status: 'holo scan status',
  instruments: 'holo instruments',
  packs: 'holo packs',
  plugins: 'holo plugins',
  regions: 'holo regions',
  timeline: 'holo timeline',
  measure: 'holo measure',
  played: 'holo played',
  listen: 'holo listen',
  audition: 'holo audition',
};

const flagName = (field: string) => `--${field.replace(/_/g, '-')}`;

/** How a command takes a tool's fields: the one it takes as a word (its action), and what it's called. */
export interface Wording {
  /** "holo regions" */
  command: string;
  /** The field given as the command's first word ("action", "what"), and what usage calls it ("ACTION"). */
  positional?: { field: string; say: string };
}

/**
 * A tool's message as the command line says it: its fields as flags, "confirm": true as --confirm, a
 * JSON example as the command it stands for, and its other tools as `holo` commands. For what went
 * wrong (`fields`: the tool's own words about its fields); what it did is said as it is, its other
 * tools named as commands.
 */
export function terminalWords(text: string, tool: Tool | null, how: Wording | null, fields = true): string {
  let out = text;
  // the bar's asking, as a terminal does it
  out = out
    .replace(/\(ask_permission "bounce"\)/g, '(holo bounce, in the open studio)')
    .replace(/ask_permission "bounce"/g, 'holo bounce (in the open studio)')
    .replace(/ask_permission \{kind: "install-pack"\}/g, "install it from the studio's Library")
    .replace(/score_meta \{"pickup": ([\d.]+)\}/g, 'holo score pickup $1');
  if (fields && tool && how) {
    // (a list of the values a field takes is said as it is: a value may be spelled as a field is)
    const [head, ...values] = out.split(' must be one of ');
    if (values.length)
      return `${terminalWords(head as string, tool, how, fields)} must be one of ${values.join(' must be one of ')}`;
    out = out.replace(/(?:send |needs )?"confirm": true/g, (m) =>
      m.startsWith('send ') ? 'add --confirm' : m.startsWith('needs ') ? 'needs --confirm' : '--confirm',
    );
    // {"action": "show", "track": …} → holo regions show --track …
    out = out.replace(/\{("[a-z_]+":[^{}]*)\}/g, (whole, inner: string) => {
      const pairs = [...inner.matchAll(/"([a-z_]+)":\s*("(?:[^"\\]|\\.)*"|[^,]+)/g)];
      if (!pairs.length || !pairs.every((p) => tool.args.some((d) => d.name === p[1]))) return whole;
      const bits = [how.command];
      for (const [, k, raw] of pairs) {
        const v = (raw as string).trim();
        const value = v.startsWith('"') ? (JSON.parse(v) as string) : v;
        if (k === how.positional?.field) bits.push(value);
        else if (value === 'true') bits.push(flagName(k as string));
        else bits.push(flagName(k as string), /\s/.test(value) ? `"${value}"` : value);
      }
      return bits.join(' ');
    });
    for (const d of tool.args) {
      const said = d.name === how.positional?.field ? how.positional.say : flagName(d.name);
      out = out.replace(new RegExp(`"${d.name}"(?!:)`, 'g'), said);
    }
  }
  // the agent's other tools, as the commands that do the same
  out = out.replace(/\b[Tt]he (\w+) tool\b/g, (m, name: string) => COMMAND_FOR[name] ?? m);
  out = out.replace(/\b([a-z]+_[a-z_]+)\b/g, (m, name: string) => COMMAND_FOR[name] ?? m);
  return out;
}

/** A tool's fields from the command's flags (hyphens or underscores), checked as the agent's are. */
export function toolArgs(
  tool: Tool,
  flags: Map<string, string | true>,
  how: Wording,
  skip: readonly string[] = [],
): Args {
  const args: Args = {};
  const known = tool.args.filter((d) => d.name !== how.positional?.field);
  for (const [key, value] of flags) {
    if (GENERAL.has(key) || skip.includes(key)) continue;
    const field = key.replace(/-/g, '_');
    const def = known.find((d) => d.name === field);
    if (!def)
      throw new Error(
        `${how.command} has no --${key}. It takes ${[...known.map((d) => flagName(d.name)), ...skip.map((s) => `--${s}`)].join(', ') || 'no flags'}`,
      );
    if (value === true) {
      if (def.type !== 'boolean') throw new Error(`${flagName(field)} takes a value`);
      args[field] = true;
    } else if (def.type === 'boolean') {
      args[field] = /^(on|yes|true|1)$/i.test(value) ? true : /^(off|no|false|0)$/i.test(value) ? false : value;
    } else if (def.type === 'array' && !value.trim().startsWith('[')) {
      // a list by commas: "Violin I,Cello" or "1,3"
      args[field] = value
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => (/^\d+$/.test(s) ? Number(s) : s));
    } else args[field] = value;
  }
  return args;
}

/** Runs one of the agent's tools, its fields checked as the agent's are, its mistakes said in flags. */
export async function runTool(env: ToolEnv, name: string, given: Args, how: Wording): Promise<ToolResult> {
  const tool = toolNamed(name);
  if (!tool) throw new Error(`The agent has no tool "${name}"`);
  const checked = check(tool.args, given);
  if (!checked.ok) throw new Error(checked.errors.map((e) => terminalWords(e, tool, how)).join('\n'));
  try {
    const result = await tool.run({ api: env.api, middleC: env.middleC, memory: env.memory }, checked.args);
    return { ...result, text: terminalWords(result.text, tool, how, false) };
  } catch (err) {
    if (err instanceof ToolError) throw new Error(terminalWords(err.message, tool, how));
    throw err;
  }
}

/** Where its changes went, after what a tool says it did. */
function withChanges(text: string, api: TerminalApi): string {
  const last = api.changes.at(-1);
  if (!last) return text;
  const where = `${last.via === 'studio' ? 'In the open studio' : 'Saved'}${last.revision ? `, revision ${last.revision}` : ''}.`;
  // (on a line of its own after several)
  if (text.includes('\n')) return `${text}\n${where}`;
  return `${text}${/[.!?)]$/.test(text) ? '' : '.'} ${where}`;
}

/** "Still measuring the mix: 35% done…", as the tool says it, then what to do about it from here. */
function stillText(toolText: string): string {
  return [
    toolText.split('\n')[0],
    'It goes on in HO[LO]: run the same command again to get the result (each run waits up to 40 s), or add --wait SECONDS to wait for it here.',
  ].join('\n');
}

/** `holo tool`: the tools it runs, and each one's fields. */
function toolList(middleC: MiddleC): string {
  const lines = ['The in-app agent’s tools, as `holo tool NAME --FIELD VALUE…` runs them:'];
  for (const t of TOOLS) {
    const p = TOOL_PARITY[t.name];
    if (!p || !('commands' in p) || p.asTool === false) continue;
    const summary = terminalWords(describeTool(t, middleC), t, null, false).split(/(?<=\.)\s/)[0] ?? '';
    lines.push(`  ${t.name.padEnd(15)} ${summary}`);
  }
  lines.push('holo tool NAME --help shows its fields.');
  return lines.join('\n');
}

function toolHelp(t: Tool, middleC: MiddleC): string {
  const how: Wording = { command: `holo tool ${t.name}` };
  const lines = [`holo tool ${t.name}: ${terminalWords(describeTool(t, middleC), t, how)}`];
  for (const d of t.args) {
    const type = d.type === 'enum' ? (d.values ?? []).join('|') : d.type === 'boolean' ? 'on|off' : d.type;
    lines.push(`  ${flagName(d.name)} ${type}${d.required ? ' (required)' : ''}: ${d.describe}`);
  }
  return lines.join('\n');
}

/** The notes `holo listen` heard, analyzed as the agent's analyze_played does. */
export async function analyzeNotes(
  ctx: Pick<ToolCommandContext, 'base' | 'author' | 'middleC' | 'songId'>,
  notes: { tick: number | null; time: number; pitch: number; velocity: number; length: number | null }[],
): Promise<string> {
  const song = await ctx.songId().catch(() => '');
  const env: ToolEnv = {
    api: terminalApi({ base: ctx.base, song, author: ctx.author }),
    middleC: ctx.middleC,
    memory: newMemory(),
  };
  const given = notes.map((n) => ({
    pitch: n.pitch,
    time: n.time,
    velocity: n.velocity,
    length: n.length,
    ...(n.tick !== null ? { tick: n.tick } : {}),
  }));
  return (await runTool(env, 'analyze_played', { notes: given }, { command: 'holo listen --analyze' })).text;
}

export async function toolCommand(ctx: ToolCommandContext): Promise<void> {
  const { command, words, flags } = ctx;
  const flag = (k: string) => {
    const v = flags.get(k);
    return v === true ? '' : v;
  };
  if (command === 'tool' && (!words[0] || words[0] === 'help')) {
    console.log(toolList(ctx.middleC));
    return;
  }
  const song = await ctx.songId();
  const api = terminalApi({ base: ctx.base, song, author: ctx.author });
  const env: ToolEnv = { api, middleC: ctx.middleC, memory: newMemory() };
  const say = (r: ToolResult) => console.log(withChanges(r.text, api));

  switch (command) {
    case 'regions': {
      const how: Wording = { command: 'holo regions', positional: { field: 'action', say: 'ACTION' } };
      const tool = toolNamed('regions') as Tool;
      const args = toolArgs(tool, flags, how);
      const actions = tool.args.find((d) => d.name === 'action')?.values ?? [];
      // a first word that isn't an action is the region to show: holo regions Verse
      const action = actions.includes(words[0] ?? '') ? (words.shift() as string) : 'show';
      const region = words.join(' ').trim();
      if (region && args.region === undefined) args.region = region;
      say(await runTool(env, 'regions', { ...args, action }, how));
      return;
    }

    case 'timeline': {
      const how: Wording = { command: 'holo timeline', positional: { field: 'action', say: 'ACTION' } };
      const args = toolArgs(toolNamed('timeline') as Tool, flags, how);
      if (!words[0]) throw new Error('holo timeline insert|delete|copy|move …: say what to do (holo help)');
      say(await runTool(env, 'timeline', { ...args, action: words[0] }, how));
      return;
    }

    case 'measure': {
      const how: Wording = { command: 'holo measure', positional: { field: 'what', say: 'WHAT' } };
      const args = toolArgs(toolNamed('measure') as Tool, flags, how, ['file', 'json', 'wait']);
      if (args.attachment !== undefined) throw new Error('holo measure takes a recording as --file PATH');
      const what = words.shift();
      if (!what) throw new Error('holo measure take|mix|tracks|plugin|meters|file …: say what to measure (holo help)');
      const path = flag('file') || (what === 'file' ? words.join(' ').trim() : '');
      if (path) {
        const file = resolve(path);
        if (!existsSync(file)) throw new Error(`No file ${path}`);
        args.attachment = api.attach(file);
      }
      const wait = Number(flag('wait') ?? 0);
      if (!Number.isFinite(wait) || wait < 0) throw new Error('--wait takes seconds');
      const until = Date.now() + wait * 1000;
      let r = await runTool(env, 'measure', { ...args, what }, how);
      // asked to wait: the same question again joins the measurement (each call waits up to 40 s)
      while (api.measured && !api.measured.done && Date.now() < until)
        r = await runTool(env, 'measure', { ...args, what }, how);
      if (flags.has('json')) {
        console.log(JSON.stringify(api.measured, null, 2));
        return;
      }
      const a = api.measured;
      console.log(a && !a.done ? stillText(r.text) : r.text);
      return;
    }

    case 'played': {
      const how: Wording = { command: 'holo played' };
      const seconds = flag('seconds');
      const args: Args = seconds ? { seconds } : {};
      for (const k of flags.keys())
        if (!GENERAL.has(k) && k !== 'seconds' && k !== 'analyze')
          throw new Error(`holo played has no --${k}. It takes --seconds, --analyze`);
      say(await runTool(env, flags.has('analyze') ? 'analyze_played' : 'played', args, how));
      return;
    }

    case 'details': {
      const how: Wording = { command: 'holo details' };
      const fields = ['title', 'artist', 'album'];
      for (const k of flags.keys())
        if (!GENERAL.has(k) && !fields.includes(k))
          throw new Error('holo details takes --title, --artist and --album ("none" clears the artist or album)');
      const given = Object.fromEntries(fields.filter((f) => flags.has(f)).map((f) => [f, flag(f) ?? '']));
      if (!Object.keys(given).length) {
        const [project, rows] = await Promise.all([
          api.song(),
          (await fetch(`${ctx.base}/api/projects`)).json() as Promise<
            {
              id: string;
              artist?: string | null;
              album?: string | null;
              creation?: string | null;
              piece?: string | null;
            }[]
          >,
        ]);
        console.log(`"${project.title}" [${project.id}]`);
        for (const line of aboutLines(rows.find((r) => r.id === song) ?? null)) console.log(`  ${line}`);
        return;
      }
      say(await runTool(env, 'song_set', given, how));
      return;
    }

    case 'import': {
      const how: Wording = { command: 'holo import' };
      const args = toolArgs(toolNamed('import') as Tool, flags, how);
      if (args.attachment !== undefined) throw new Error('holo import FILE: the file comes first');
      const path = words.join(' ').trim();
      if (!path) throw new Error('holo import FILE.mid|.musicxml|.mxl|.wav|.flac|.aiff [--at 5] [--track T] …');
      const file = resolve(path);
      if (!existsSync(file)) throw new Error(`No file ${path}`);
      say(await runTool(env, 'import', { ...args, attachment: api.attach(file) }, how));
      return;
    }

    case 'packs': {
      const how: Wording = { command: 'holo packs' };
      say(await runTool(env, 'packs', toolArgs(toolNamed('packs') as Tool, flags, how), how));
      return;
    }

    case 'tool': {
      const name = words.shift() as string;
      const tool = toolNamed(name);
      const p = TOOL_PARITY[name];
      if (!tool) throw new Error(`The agent has no tool "${name}": holo tool lists them`);
      if (!p || !('commands' in p))
        throw new Error(`${name} belongs to a request in the studio's bar${p ? `: it ${p.conversation}` : ''}`);
      if (p.asTool === false)
        throw new Error(
          `From a terminal, ${p.commands.map((c) => `holo ${c}`).join(' or ')} does what ${name} does, and more`,
        );
      if (flags.has('help')) {
        console.log(toolHelp(tool, ctx.middleC));
        return;
      }
      const how: Wording = { command: `holo tool ${name}` };
      const args = toolArgs(tool, flags, how);
      if (typeof args.attachment === 'string') {
        const file = resolve(args.attachment);
        if (!existsSync(file)) throw new Error(`No file ${args.attachment}`);
        args.attachment = api.attach(file);
      }
      const r = await runTool(env, name, args, how);
      say(api.measured && !api.measured.done ? { text: stillText(r.text) } : r);
      return;
    }

    default:
      throw new Error(`Unknown command "${command}"`);
  }
}
