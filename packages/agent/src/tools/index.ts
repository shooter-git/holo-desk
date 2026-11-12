/**
 * Every tool the agent has, in the order the harness lists them: reading first, then changing,
 * playing, scans, and the conversation.
 *
 * A module of tools added later goes in its own labelled blocks: its import below, and its tools in the
 * list (so the modules added side by side keep their lines apart).
 */
import type { Tool } from './common.ts';
import { conversationTools } from './conversation.ts';
import { mixTools } from './mix.ts';
import { noteTools } from './notes.ts';
import { packTools } from './packs.ts';
import { playTools } from './play.ts';
import { scanTools } from './scan.ts';
import { scoreTools } from './score.ts';
import { songTools } from './song.ts';
import { trackTools } from './tracks.ts';

// ---- measure ----

// ---- import ----
import { importTools } from './import.ts';
// ---- regions ----
import { regionTools } from './regions.ts';
// ---- timeline ----
import { timelineTools } from './timeline.ts';

export const TOOLS: readonly Tool[] = [
  ...songTools,
  // ---- timeline ----
  ...timelineTools,

  ...noteTools,
  // ---- regions ----
  ...regionTools,

  ...trackTools,
  ...mixTools,
  ...scoreTools,
  ...packTools,
  ...playTools,
  // ---- measure ----

  ...scanTools,
  // ---- import ----
  ...importTools,

  ...conversationTools,
];

export function toolNamed(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
