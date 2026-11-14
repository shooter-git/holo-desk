/**
 * Every command `holo` takes, as main.ts's dispatcher has them (its `case` labels, in order; the
 * parity test checks the two agree). Kept apart from main.ts, which runs a command as it loads, so
 * tests and tools can read the list, and the help for the commands that do what the in-app agent's
 * tools do (tool-commands.ts).
 */
import { NOTE_EDIT_NAMES } from '@holo/session';

export const COMMANDS = [
  'help',
  '--help',
  '-h',
  'status',
  'songs',
  'score',
  'scan',
  'show',
  'instruments',
  'plugins',
  'write',
  'clear',
  'track',
  'kit',
  'synth',
  'fx',
  'automate',
  'finish',
  'looping',
  'tempo',
  'key',
  'marker',
  'ops',
  'play',
  'stop',
  'locate',
  'loop',
  'audition',
  'listen',
  'bounce',
  'open',
  'new',
  'audio',
  'render-audio',
  'init',
  'update-engine',
  'runner',
  'render',
  'import-midi',
  'import-score',
  'export-score',
  'export-midi',
  'creations',
  'pull',
  'send',
  // ---- what the in-app agent's tools do (tool-commands.ts) ----
  'regions',
  'notes',
  'timeline',
  'measure',
  'played',
  'details',
  'import',
  'packs',
  'tool',
] as const;

export type Command = (typeof COMMANDS)[number];

/** The note edits, as `holo help` lists them after `holo notes`: a few to a line. */
const noteActions = (indent: string, width = 104): string => {
  const lines: string[] = [];
  let line = indent;
  for (const [i, name] of ['show', 'detect', ...NOTE_EDIT_NAMES].entries()) {
    const word = `${name}${i < NOTE_EDIT_NAMES.length + 1 ? ',' : ''}`;
    if (line.length + word.length + 1 > width && line.trim()) {
      lines.push(line.trimEnd());
      line = indent;
    }
    line += `${word} `;
  }
  return [...lines, line.trimEnd()].join('\n');
};

/** Their lines in `holo help`. */
export const TOOL_HELP = `What the in-app agent does, from here (each runs the agent's own tool, on the song)
  holo regions [ACTION] [REGION] [--track T] …   show, split, delete, copy, move, repeat, trim, gain, fade,
        stretch, mute, unmute, rename, quantize, transpose, cc: a region by id, name or "selected"
        e.g. holo regions show --track Vocal · holo regions split --track Vocal --at "17 21"
             holo regions fade selected --fade-out 1.5 · holo regions delete "Verse 2" --confirm
             holo regions cc rgn_… --lane pb --points "9=0 9.3=4096 10=0" · holo regions quantize --track Keys --unit 1/16
  holo notes [ACTION] [--track T] [--region R] [--notes all|selected|1-12,15|"bars 9-13"|"pitch E4"] [--ARG value…]
        a recording's notes, one by one, as the Audio Editor edits them (holo notes alone shows them):
${noteActions('        ')}
        e.g. holo notes show --track Vocal · holo notes shift --notes 5 --semitones 2
             holo notes vibrato --notes "bars 9-12" --keep 60 · holo notes reset --notes all
        (holo notes help lists what each does; holo notes ACTION --help its flags)
  holo timeline insert|delete|copy|move [--at 17] [--from 9] [--to 17] [--bars 4] [--confirm]
        whole bars across every track (delete and move need --confirm)
  holo measure take|mix|tracks|plugin|meters|file [--track T] [--region R] [--plugin P] [--from 9] [--to 17]
        [--against key|none|TRACK] [--grid 1/16] [--through effects] [--source bounce] [--seconds 8]
        [--file REC.wav] [--json] [--wait SECONDS]
        a take's pitch and timing, the mix's loudness, each track, a plugin, the studio's meters, a file
  holo played [--seconds 20] [--analyze]      what was just played in the studio; --analyze: tempo, meter,
                                              key and grid, and the notes as score text (holo listen --analyze too)
  holo details [--title T] [--artist A] [--album B]   who the song is by and its album ("none" clears one)
  holo import FILE.mid|.musicxml|.mxl|.wav|.flac|.aiff [--at 5] [--track T] [--name N] [--tempo keep|adopt]
        [--parts "Violin I,Cello"|1,3]        into the open song: a MIDI or score file as tracks, a recording
  holo packs [--available] [--search WORDS]   the installed packs (and palettes' sounds), or the catalog
  holo tool [NAME [--FIELD VALUE…]]           any of the agent's tools by name (holo tool lists them)`;
