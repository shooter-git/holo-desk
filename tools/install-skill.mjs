// Makes the `holo` command and the Claude Code skill available in every project on this machine:
//   ~/.local/bin/holo          a launcher for packages/cli (pass HOLO_URL to reach another machine)
//   ~/.claude/skills/holo      a link to skills/holo, so Claude can use HO[LO] from any folder
// Run it again after moving this folder. `pnpm skill:install --remove` takes both away.
import { chmodSync, existsSync, lstatSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const repo = resolve(import.meta.dirname, '..');
const bin = join(homedir(), '.local', 'bin');
const launcher = join(bin, 'holo');
const skills = join(homedir(), '.claude', 'skills');
const link = join(skills, 'holo');

const gone = (p) => {
  try {
    lstatSync(p);
    rmSync(p, { recursive: true, force: true });
  } catch {
    // nothing there
  }
};

if (process.argv.includes('--remove')) {
  gone(launcher);
  gone(link);
  console.log('Removed the holo command and the skill.');
  process.exit(0);
}

mkdirSync(bin, { recursive: true });
writeFileSync(
  launcher,
  `#!/bin/sh\n# HO[LO] Desk's command line (installed by pnpm skill:install)\nexec node --disable-warning=ExperimentalWarning "${join(repo, 'packages/cli/src/main.ts')}" "$@"\n`,
);
chmodSync(launcher, 0o755);

mkdirSync(skills, { recursive: true });
gone(link);
symlinkSync(join(repo, 'skills', 'holo'), link);

console.log(`holo command: ${launcher}`);
console.log(`Claude skill: ${link} -> skills/holo`);
if (!(process.env.PATH ?? '').split(':').includes(bin))
  console.log(`Add ${bin} to your PATH to type \`holo\` anywhere.`);
if (!existsSync(join(repo, 'node_modules'))) console.log('Run pnpm install first, or holo can’t find its parts.');
