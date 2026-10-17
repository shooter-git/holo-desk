// `node tools/pack-checksums.mjs [--data DIR] [ID…]`: every file of each sample library HO[LO] ships
// maps for, by its sha256, into packs/checksums/<id>.sha256 (the lines `sha256sum -c` reads, run in
// the pack's samples folder). Read from the libraries installed in HO[LO]'s data folder (HOLO_DATA_DIR,
// ./data by default). An experience's build checks every sample it fetches against these, so its
// songs play exactly the files the studio plays.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { formatChecksums, packPaths } from '../packages/music/src/packs.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--data');
const data = resolve(at >= 0 ? args.splice(at, 2)[1] : (process.env.HOLO_DATA_DIR ?? 'data'));
const root = resolve(import.meta.dirname, '..');
const manifests = join(root, 'packs/manifests');
const out = join(root, 'packs/checksums');
mkdirSync(out, { recursive: true });

for (const f of readdirSync(manifests).filter((x) => x.endsWith('.json'))) {
  const pack = JSON.parse(readFileSync(join(manifests, f), 'utf8'));
  if (args.length && !args.includes(pack.id)) continue;
  const dir = join(data, 'packs', pack.id, pack.root || 'samples');
  if (!existsSync(dir)) {
    console.log(`${pack.id}: not installed in ${data} (skipped)`);
    continue;
  }
  const files = {};
  const missing = [];
  for (const p of packPaths(pack)) {
    const file = join(dir, p);
    if (!existsSync(file)) missing.push(p);
    else files[p] = createHash('sha256').update(readFileSync(file)).digest('hex');
  }
  if (missing.length) {
    console.error(`${pack.id}: ${missing.length} file(s) missing, e.g. ${missing[0]}: install it fully first`);
    process.exitCode = 1;
    continue;
  }
  writeFileSync(join(out, `${pack.id}.sha256`), formatChecksums(files));
  console.log(`${pack.id}: ${Object.keys(files).length} files`);
}
