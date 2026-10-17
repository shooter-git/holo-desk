/**
 * HO[LO] Engine from the repository (`pnpm engine`): the same app as the downloads, with the native
 * piece built for this computer by `pnpm engine:build`.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { nativeName } from './native.ts';
import { HELP, parseArgs, run, VERSION } from './server.ts';

const parsed = parseArgs(process.argv.slice(2));
if (parsed === 'help') {
  console.log(HELP);
  process.exit(0);
}
if (parsed === 'version') {
  console.log(VERSION);
  process.exit(0);
}
const addon = fileURLToPath(new URL(`../native/build/${nativeName()}`, import.meta.url));
if (!existsSync(addon)) {
  console.error(
    `HO[LO] Engine's native piece isn't built for this computer yet: run \`pnpm engine:build\` (it needs Zig 0.16, or a C compiler), or use the download.`,
  );
  process.exit(1);
}
await run(parsed, addon, {
  render: (workerData, transferList) =>
    new Worker(new URL('./render.ts', import.meta.url), { workerData, transferList }),
  ahead: () => new Worker(new URL('./ahead-thread.ts', import.meta.url)),
});
