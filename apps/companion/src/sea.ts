/**
 * HO[LO] Engine as one file (Node's single executable application): the render thread's code, the
 * code of the threads that render ahead and the native piece travel inside it as assets. The native piece is written to this user's cache once (a
 * library has to be a file to load), under a name that changes with its contents.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, renameSync, writeFileSync } from 'node:fs';
import { homedir, platform, tmpdir } from 'node:os';
import { join } from 'node:path';
import { getAsset, getRawAsset } from 'node:sea';
import { Worker } from 'node:worker_threads';
import { HELP, parseArgs, run, VERSION } from './server.ts';

function cacheDir(): string {
  const home = homedir();
  if (platform() === 'win32') return join(process.env.LOCALAPPDATA ?? join(home, 'AppData', 'Local'), 'HOLO Engine');
  if (platform() === 'darwin') return join(home, 'Library', 'Caches', 'HOLO Engine');
  return join(process.env.XDG_CACHE_HOME ?? join(home, '.cache'), 'holo-engine');
}

function nativeFile(): string {
  const bytes = new Uint8Array(getRawAsset('holo_native.node'));
  const hash = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
  for (const dir of [cacheDir(), join(tmpdir(), 'holo-engine')]) {
    const file = join(dir, `holo_native-${hash}.node`);
    if (existsSync(file)) return file;
    try {
      mkdirSync(dir, { recursive: true });
      const part = `${file}.${process.pid}`;
      writeFileSync(part, bytes);
      renameSync(part, file);
      return file;
    } catch {
      // not writable: the next place
    }
  }
  throw new Error('HO[LO] Engine couldn’t write its native piece to a cache folder');
}

const parsed = parseArgs(process.argv.slice(2));
if (parsed === 'help') {
  console.log(HELP);
  process.exit(0);
}
if (parsed === 'version') {
  console.log(VERSION);
  process.exit(0);
}
const render = getAsset('render.cjs', 'utf8');
const ahead = getAsset('ahead.cjs', 'utf8');
run(parsed, nativeFile(), {
  render: (workerData, transferList) => new Worker(render, { eval: true, workerData, transferList }),
  ahead: () => new Worker(ahead, { eval: true }),
}).catch((err: unknown) => {
  const m = err instanceof Error ? err.message : String(err);
  console.error(
    /EADDRINUSE/.test(m)
      ? 'HO[LO] Engine is already running (or something else has its port).'
      : `HO[LO] Engine couldn’t start: ${m}`,
  );
  // a window opened by a double click would close before the message could be read
  setTimeout(() => process.exit(1), 10_000);
});
