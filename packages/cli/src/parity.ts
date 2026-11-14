/**
 * The terminal and the in-app agent: for each of the agent's tools (packages/agent/src/tools), the
 * `holo` commands that do the same, or why it has none: it belongs to how a request in the studio's
 * bar runs (a turn, its attachments, the user's click), which a terminal doesn't have.
 *
 * Every tool with commands also runs as itself through `holo tool NAME` (the agent's own code, the
 * agent's own answer), unless `asTool` is false because its command does all of it and more; `rest`
 * says what of a tool its named commands leave to `holo tool`. The parity test
 * (test/parity.test.ts) fails when a tool has no line here, so a new tool comes with its line.
 */
export type Parity =
  | {
      /** The `holo` commands (as main.ts takes them) that do what the tool does. */
      commands: readonly string[];
      /** What of the tool those commands don't do, done through `holo tool NAME`. */
      rest?: string;
      /** false: `holo tool` doesn't run it (its command does all of it, and more, from a terminal). */
      asTool?: false;
    }
  | {
      /** Why it belongs to a request in the bar, with no command of its own. */
      conversation: string;
    };

export const TOOL_PARITY: Readonly<Record<string, Parity>> = {
  // ---- the song ----
  song_status: { commands: ['status'] },
  song_show: { commands: ['show'] },
  song_set: {
    commands: ['details', 'tempo', 'key'],
    rest: 'a meter, and a tempo, key or meter change later in the song (--at)',
  },
  marker: { commands: ['marker'], rest: 'renaming or removing a marker' },
  cycle: { commands: ['loop'] },
  looping: { commands: ['looping'] },
  ops_apply: { commands: ['ops'] },
  timeline: { commands: ['timeline'] },

  // ---- notes and regions ----
  notes_show: { commands: ['show'] },
  notes_write: { commands: ['write'] },
  notes_clear: { commands: ['clear'] },
  regions: { commands: ['regions'] },

  // ---- tracks, sounds and the mix ----
  track_add: { commands: ['track'], rest: "a palette's sound (--sound), and a new track's fader and pan" },
  track_set: { commands: ['track'], rest: "a track's place in the list (--index) and its sends" },
  synth_set: { commands: ['synth'] },
  kit_set: { commands: ['kit'] },
  instruments: { commands: ['instruments'], rest: 'narrowing the list (--search)' },
  plugins: { commands: ['plugins'], rest: "one plugin's parameters alone (--type)" },
  fx: { commands: ['fx'], rest: 'showing a chain, moving a plugin in it, bypassing one' },
  automate: { commands: ['automate'], rest: 'listing what can move on a channel, and showing a lane' },
  finish_master: { commands: ['finish'] },

  // ---- scores and packs ----
  score_show: { commands: ['score'] },
  score_parts: { commands: ['score'] },
  score_write: { commands: ['score'] },
  score_part: { commands: ['score'] },
  score_meta: { commands: ['score'] },
  packs: { commands: ['packs'] },

  // ---- playing and listening ----
  transport: { commands: ['play', 'stop', 'locate'] },
  audition: { commands: ['audition'] },
  listen: { commands: ['listen'], asTool: false },
  played: { commands: ['played'] },
  analyze_played: { commands: ['played', 'listen'] },
  compare: {
    conversation:
      'A/B against the song as it was before the request: the studio plays from the undo step the request began with, which only a request in the bar has (from a terminal, holo play plays any bars)',
  },

  // ---- measuring ----
  measure: { commands: ['measure'] },

  // ---- scans ----
  scan_show: { commands: ['scan'], asTool: false },
  scan_status: { commands: ['scan'] },

  // ---- files ----
  import: { commands: ['import', 'audio'] },

  // ---- the conversation ----
  attachment_get: {
    conversation:
      "reads what the user dropped on the bar with their request (as the studio measured it); a terminal reads files itself, and holo import and holo measure take a file's path",
  },
  look: {
    conversation:
      'asks the user, with a button in the bar, for a screenshot, a photo or a recording, and ends the turn until they answer; in a terminal the user is there to ask',
  },
  ask_permission: {
    conversation:
      "asks the user's click in the bar (a pack, sending to the creation, a bounce, a creation's render, a capture) and ends the turn; in a terminal the user is asked directly, and holo bounce, holo send and holo render do those",
  },
  hand_off: {
    conversation:
      "writes a brief for the user's own coding agent when a request is for HO[LO]'s code, holo-packs or a creation; a terminal is that agent",
  },
  finish: {
    conversation: "ends a request's turn with the undo step's label and the reply under the bar; a command has no turn",
  },
};
