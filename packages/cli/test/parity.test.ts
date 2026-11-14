import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { TOOLS, toolNamed } from '@holo/agent';
import { missingNoteEdits, NOTE_EDITS } from '@holo/session';
import { describe, expect, it } from 'vitest';
import { COMMANDS, TOOL_HELP } from '../src/commands.ts';
import { TOOL_PARITY } from '../src/parity.ts';
import { notesHelp, terminalWords, toolArgs } from '../src/tool-commands.ts';

const main = readFileSync(join(import.meta.dirname, '../src/main.ts'), 'utf8');

describe('the terminal has what the in-app agent has', () => {
  it('lists the commands the dispatcher takes, in its order', () => {
    const cases = [...main.matchAll(/^ {4}case '([^']+)':/gm)].map((m) => m[1]);
    expect(cases).toEqual([...COMMANDS]);
  });

  it('maps every tool of the agent to the holo commands that do the same, or says why it has none', () => {
    const missing: string[] = [];
    for (const tool of TOOLS) {
      const p = TOOL_PARITY[tool.name];
      if (!p) {
        missing.push(tool.name);
        continue;
      }
      if ('commands' in p) {
        expect(p.commands.length, tool.name).toBeGreaterThan(0);
        for (const c of p.commands) expect(COMMANDS as readonly string[], `${tool.name}: holo ${c}`).toContain(c);
        // (holo tool runs any of them, but it's no command of a tool's own)
        expect(p.commands, tool.name).not.toContain('tool');
      } else {
        expect(p.conversation.length, tool.name).toBeGreaterThan(20);
        // a tool that only sees or plays isn't the conversation's
        expect(tool.kind === 'ask' || tool.name === 'compare' || tool.name === 'attachment_get', tool.name).toBe(true);
      }
    }
    expect(missing, 'tools with neither a holo command nor a reason (add their line to src/parity.ts)').toEqual([]);
  });

  it('has no line for a tool the agent no longer has', () => {
    const stale = Object.keys(TOOL_PARITY).filter((name) => !toolNamed(name));
    expect(stale).toEqual([]);
  });

  it('keeps the asking tools to the conversation', () => {
    for (const tool of TOOLS.filter((t) => t.kind === 'ask'))
      expect('conversation' in (TOOL_PARITY[tool.name] ?? {}), tool.name).toBe(true);
  });
});

describe('a recording’s notes: every edit in the studio, the agent and holo notes', () => {
  const tool = toolNamed('audio_notes');
  if (!tool) throw new Error('the agent lacks its audio_notes tool');

  it('runs the agent’s audio_notes, which takes every note edit as an action', () => {
    expect(TOOL_PARITY.audio_notes).toEqual({ commands: ['notes'] });
    expect(missingNoteEdits(tool.args.find((a) => a.name === 'action')?.values ?? [])).toEqual([]);
  });

  it('lists every edit in its help and holo help, and says each one’s flags from the list', () => {
    const help = notesHelp(undefined);
    expect(
      missingNoteEdits(NOTE_EDITS.map((e) => e.name).filter((n) => new RegExp(`^  ${n}\\b`, 'm').test(help))),
    ).toEqual([]);
    expect(missingNoteEdits(NOTE_EDITS.map((e) => e.name).filter((n) => TOOL_HELP.includes(n)))).toEqual([]);
    for (const e of NOTE_EDITS) {
      const one = notesHelp(e.name);
      expect(one, e.name).toContain(`holo notes ${e.name}: ${e.summary}`);
      for (const a of e.args) expect(one, `${e.name} --${a.name}`).toContain(`--${a.name} `);
      expect(one.includes('--notes SELECT (required)'), e.name).toBe(e.selection);
    }
  });

  it('reads an edit’s arguments from flags, and says the list’s refusals in flags', () => {
    const how = { command: 'holo notes', positional: { field: 'action', say: 'ACTION' } };
    expect(
      toolArgs(
        tool,
        new Map([
          ['notes', '5'],
          ['semitones', '2'],
          ['track', 'Vocal'],
        ]),
        how,
        ['wait'],
      ),
    ).toEqual({ notes: '5', semitones: '2', track: 'Vocal' });
    expect(terminalWords('Say "keep": 100 as sung, 0 none, 200 twice as wide (0 to 200 %)', tool, how)).toBe(
      'Say --keep: 100 as sung, 0 none, 200 twice as wide (0 to 200 %)',
    );
    expect(terminalWords('Say which "notes": "all", "selected"', tool, how)).toBe(
      'Say which --notes: "all", "selected"',
    );
    expect(terminalWords('call audio_notes again with the same arguments', null, null, false)).toBe(
      'call holo notes again with the same arguments',
    );
  });
});

describe('the agent’s tools, said in the command line’s words', () => {
  const regions = toolNamed('regions');
  const measure = toolNamed('measure');
  if (!regions || !measure) throw new Error('the agent lacks its regions or measure tool');
  const how = { command: 'holo regions', positional: { field: 'action', say: 'ACTION' } };

  it('says fields as flags, and confirm as --confirm', () => {
    expect(terminalWords('Deleting a region needs "confirm": true, once the user wants it gone', regions, how)).toBe(
      'Deleting a region needs --confirm, once the user wants it gone',
    );
    expect(terminalWords('Say "fade_in" and/or "fade_out" (seconds)', regions, how)).toBe(
      'Say --fade-in and/or --fade-out (seconds)',
    );
    expect(terminalWords('Say where to split: "at", e.g. "17" or "17 21 25"', regions, how)).toBe(
      'Say where to split: --at, e.g. "17" or "17 21 25"',
    );
    expect(
      terminalWords('No region "Verse". {"action": "show", "track": …} lists a track’s regions.', regions, how),
    ).toBe('No region "Verse". holo regions show --track … lists a track’s regions.');
  });

  it('leaves a list of values as it is, and names the positional word', () => {
    expect(
      terminalWords('"what" must be one of "take", "mix", "tracks", "plugin"', measure, {
        command: 'holo measure',
        positional: { field: 'what', say: 'WHAT' },
      }),
    ).toBe('WHAT must be one of "take", "mix", "tracks", "plugin"');
  });

  it('names the agent’s other tools as holo commands, in what a tool says it did too', () => {
    expect(terminalWords('give them instruments that fit with track_set.', null, null, false)).toBe(
      'give them instruments that fit with holo track set.',
    );
    expect(terminalWords('or bar 0 has nowhere to go: score_meta {"pickup": 1.5}.', null, null, false)).toBe(
      'or bar 0 has nowhere to go: holo score pickup 1.5.',
    );
    expect(terminalWords('The instruments tool lists them; the packs tool too', null, null, false)).toBe(
      'holo instruments lists them; holo packs too',
    );
  });

  it('reads a tool’s fields from flags, hyphens or underscores', () => {
    const flags = new Map<string, string | true>([
      ['to-track', 'Bass'],
      ['fade_out', '1.5'],
      ['confirm', true],
      ['song', 'prj_x'],
    ]);
    expect(toolArgs(regions, flags, how)).toEqual({ to_track: 'Bass', fade_out: '1.5', confirm: true });
    expect(() => toolArgs(regions, new Map([['colour', 'red']]), how)).toThrow(/holo regions has no --colour/);
    expect(() => toolArgs(regions, new Map([['action', 'show']]), how)).toThrow(/no --action/);
    expect(() => toolArgs(regions, new Map([['at', true]]), how)).toThrow(/--at takes a value/);
    const imp = toolNamed('import');
    if (!imp) throw new Error('no import tool');
    expect(toolArgs(imp, new Map([['parts', 'Violin I, Cello,3']]), { command: 'holo import' })).toEqual({
      parts: ['Violin I', 'Cello', 3],
    });
  });
});
