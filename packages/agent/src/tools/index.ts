/**
 * Every tool the agent has, in the order the harness lists them: reading first, then changing,
 * playing, scans, and the conversation.
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

export const TOOLS: readonly Tool[] = [
  ...songTools,
  ...noteTools,
  ...trackTools,
  ...mixTools,
  ...scoreTools,
  ...packTools,
  ...playTools,
  ...scanTools,
  ...conversationTools,
];

export function toolNamed(name: string): Tool | undefined {
  return TOOLS.find((t) => t.name === name);
}
