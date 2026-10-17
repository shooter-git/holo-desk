// `node tools/engine-stamp.mjs` (pnpm up runs it): the engine's last commit and its date, written for
// the studio's Docker image, which has no git, so the studio can tell an experience whose pinned
// engine is older than its own (the stamp counts only while the engine's files still match it).
import { writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { engineCommit, engineSource, STAMP_FILE } from '../packages/music/src/identity.ts';

const root = resolve(import.meta.dirname, '..');
const at = engineCommit(root);
if (!at) {
  console.log('No git here: the studio will say only whether an engine differs from its own');
} else {
  writeFileSync(join(root, STAMP_FILE), `${JSON.stringify({ source: engineSource(root), ...at }, null, 2)}\n`);
}
