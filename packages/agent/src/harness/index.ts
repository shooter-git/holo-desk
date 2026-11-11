/**
 * The harnesses the runner offers: Claude Code, Codex and Cursor, each found the way its installer
 * puts it (or named by HOLO_CLAUDE, HOLO_CODEX, HOLO_CURSOR), never through a shell.
 */
import type { AdapterOptions } from './adapter.ts';
import { claudeHarness } from './claude.ts';
import { codexHarness } from './codex.ts';
import { cursorHarness } from './cursor.ts';
import type { Harness, HarnessId, HarnessInfo } from './types.ts';

export type { AdapterOptions } from './adapter.ts';
export * from './types.ts';
export { agentRoot } from './workspace.ts';

export function createHarnesses(o: AdapterOptions): Record<HarnessId, Harness> {
  return { claude: claudeHarness(o), codex: codexHarness(o), cursor: cursorHarness(o) };
}

/** Every harness as the studio sees it, looked at side by side. */
export function detectAll(harnesses: Record<HarnessId, Harness>, fresh = false): Promise<HarnessInfo[]> {
  return Promise.all(Object.values(harnesses).map((h) => h.info(fresh)));
}
