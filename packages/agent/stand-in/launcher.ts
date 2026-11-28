/**
 * The programs HOLO_CLAUDE and HOLO_CODEX name for a runner that works with the stand-in: each a few
 * lines of sh that start main.ts as that harness, with the Node that wrote them (a harness's PATH is
 * the system's own folders, where Node may not be).
 */
import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

/** sh single quotes. */
const q = (s: string) => `'${s.replaceAll("'", "'\\''")}'`;

const MAIN = resolve(import.meta.dirname, 'main.ts');

export interface Launchers {
  claude: string;
  codex: string;
}

/** Write both launchers in `dir` (made if it isn't there), and say where they are. */
export function writeLaunchers(dir: string, node: string = process.execPath): Launchers {
  mkdirSync(dir, { recursive: true });
  const write = (name: 'claude' | 'codex') => {
    const path = join(dir, name);
    writeFileSync(path, `#!/bin/sh\nexec ${q(node)} --disable-warning=ExperimentalWarning ${q(MAIN)} ${name} "$@"\n`);
    chmodSync(path, 0o755);
    return path;
  };
  return { claude: write('claude'), codex: write('codex') };
}
