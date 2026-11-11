/**
 * The runner's key: how the server knows the runner it hands the agent's jobs to is the one on this
 * computer, not a page or a program posing as it. It's made once, in the data folder, readable only
 * by its owner; the runner reads it there (or is given it as HOLO_RUNNER_KEY) and says it in its
 * hello. Renders don't need it, so a runner from before keys still renders.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const KEY = /^[0-9a-f]{64}$/;

/** The key in `dataDir/runner.key`, made (32 random bytes as hex, mode 0600) the first time it's asked for. */
export function runnerKey(dataDir: string): string {
  const file = join(dataDir, 'runner.key');
  try {
    const key = readFileSync(file, 'utf8').trim();
    if (KEY.test(key)) {
      // made by hand, or copied with looser permissions: only its owner reads it
      chmodSync(file, 0o600);
      return key;
    }
  } catch {
    // not made yet
  }
  mkdirSync(dataDir, { recursive: true });
  const key = randomBytes(32).toString('hex');
  try {
    // only if no other process made it in the meantime
    writeFileSync(file, `${key}\n`, { mode: 0o600, flag: 'wx' });
    return key;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
  }
  const made = readFileSync(file, 'utf8').trim();
  if (KEY.test(made)) return made;
  // an empty or damaged file: replaced
  writeFileSync(file, `${key}\n`, { mode: 0o600 });
  chmodSync(file, 0o600);
  return key;
}

/** Whether two keys are the same, in a time that says nothing about where they differ (or their lengths). */
export function sameKey(given: string, key: string): boolean {
  const a = createHash('sha256').update(given).digest();
  const b = createHash('sha256').update(key).digest();
  return timingSafeEqual(a, b);
}
