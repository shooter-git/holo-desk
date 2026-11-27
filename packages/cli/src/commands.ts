/**
 * Every command `holo` takes, as main.ts's dispatcher has them (its `case` labels, in order; the
 * parity test checks the two agree). Kept apart from main.ts, which runs a command as it loads, so
 * tests and tools can read the list, and the help for the commands that do what the in-app agent's
 * tools do (tool-commands.ts).
 */
import { NOTE_EDIT_NAMES, NOTE_EXTRAS } from '@holo/session';

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
  'stems',
  'open',
  'new',
  'audio',
  'render-audio',
  'init',
  'update-engine',
  'runner',
  'pair',
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
  'capture',
  'chords',
  'steps',
  'details',
  'import',
  'packs',
  'tool',
] as const;

export type Command = (typeof COMMANDS)[number];

/** The note edits (and what's beside them: midi), as `holo help` lists them after `holo notes`: a few to a line. */
const noteActions = (indent: string, width = 104): string => {
  const lines: string[] = [];
  let line = indent;
  const names = ['show', 'detect', ...NOTE_EDIT_NAMES, ...NOTE_EXTRAS];
  for (const [i, name] of names.entries()) {
    const word = `${name}${i < names.length - 1 ? ',' : ''}`;
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
        stretch, mute, unmute, rename, quantize, transpose, into_key, cc: a region by id, name or "selected"
        e.g. holo regions show --track Vocal · holo regions split --track Vocal --at "17 21"
             holo regions fade selected --fade-out 1.5 · holo regions delete "Verse 2" --confirm
             holo regions cc rgn_… --lane pb --points "9=0 9.3=4096 10=0" · holo regions quantize --track Keys --unit 1/16 --swing 60
  holo notes [ACTION] [--track T] [--region R] [--notes all|selected|1-12,15|"bars 9-13"|"pitch E4"] [--ARG value…]
        a recording's notes, one by one, as the Audio Editor edits them (holo notes alone shows them):
${noteActions('        ')}
        e.g. holo notes show --track Vocal · holo notes shift --notes 5 --semitones 2
             holo notes vibrato --notes "bars 9-12" --keep 60 · holo notes reset --notes all
             holo notes correct-pitch --notes all --centre 90 --drift 40 · holo notes midi --track Vocal
             holo notes paste 7 --from 3 · holo notes copy-settings 5-9 --from 3
             holo notes shift 5 --semitones 2 --linked   (--linked: in every region playing the recording too)
        (holo notes help lists what each does; holo notes ACTION --help its flags)
  holo timeline sections | insert|delete|copy|move|repeat [--at 17] [--from 9] [--to 17] [--bars 4]
        [--section "Bridge"] [--confirm]   (sections lists them: each from a marker to the next; --section takes one
        by name instead of --from and --to, and --at takes "before Chorus" or "after Chorus")
        whole bars across every track (delete and move need --confirm)
  holo measure take|mix|tracks|plugin|meters|file [--track T] [--region R] [--plugin P] [--from 9] [--to 17]
        [--against key|none|TRACK] [--grid 1/16] [--through effects] [--source bounce] [--seconds 8]
        [--file REC.wav] [--json] [--wait SECONDS]
        a take's pitch and timing, the mix's loudness, each track, a plugin, the studio's meters, a file
  holo chords [--at 9.3 --symbol Dm7 | --at 9.3 --remove | --set "9=Dm7 9.3=G7 10=Cmaj7"]
                                              the song's chord symbols (the Chords lane's, and the Score's):
                                              listed with nothing, set, removed, or several written at once
  holo steps [ACTION] TRACK [--bars 9-12] [--grid 1/16] [--row "Snare"] [--lines "Kick: x...x...; Snare: ....X..."] …
        a drum track as the Step Grid shows it, a row a piece (X accent, x hit, o soft, g ghost, . none): shown
        with no action; write (--lines, or --row with --pattern), set, clear (--step N or --steps 1,5,9),
        velocity (--level accent | --velocity 90 | --by -10), fill (--every 4), euclid (--hits 5 --rotate 2),
        shift (--by 1), humanize (--amount 12), copy (--to 13 --times 3), swing (--amount 58), clear-row
        e.g. holo steps Drums --bars 9-10 · holo steps euclid Drums --bars 9-12 --row "Closed Hat" --hits 11
  holo capture                                keep what was just played in the studio as regions, on the tracks
                                              that sounded it (the studio's Capture, Shift R)
  holo played [--seconds 20] [--analyze]      what was just played in the studio; --analyze: tempo, meter,
                                              key and grid, and the notes as score text (holo listen --analyze too)
  holo details [--title T] [--artist A] [--album B]   who the song is by and its album ("none" clears one)
  holo import FILE.mid|.musicxml|.mxl|.wav|.flac|.aiff [--at 5] [--track T] [--name N] [--tempo keep|adopt]
        [--parts "Violin I,Cello"|1,3]        into the open song: a MIDI or score file as tracks, a recording
  holo packs [--available] [--search WORDS]   the installed packs (and palettes' sounds), or the catalog
  holo tool [NAME [--FIELD VALUE…]]           any of the agent's tools by name (holo tool lists them)`;
