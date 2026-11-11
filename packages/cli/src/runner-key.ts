/**
 * The runner's key, which HO[LO]'s server makes in its data folder (apps/server/src/agent/keys.ts):
 * said in the runner's hello, it's how the server knows this runner may be handed the agent's jobs.
 * Renders don't need it.
 */
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** Where the key is: `runner.key` in the data folder, found as the server finds it (apps/server/src/config.ts). */
export function runnerKeyFile(repo: string, env: NodeJS.ProcessEnv = process.env): string {
  return join(resolve(repo, env.HOLO_DATA_DIR ?? './data'), 'runner.key');
}

/** HOLO_RUNNER_KEY if it's set, else the key in the data folder; null when neither can be read. */
export function readRunnerKey(repo: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const given = env.HOLO_RUNNER_KEY?.trim();
  if (given) return given;
  try {
    return readFileSync(runnerKeyFile(repo, env), 'utf8').trim() || null;
  } catch {
    return null;
  }
}
