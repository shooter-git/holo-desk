/**
 * Sample packs from the command line (`pnpm packs …`, or `docker compose exec holo pnpm packs …`):
 *
 *   list                         what's available and what's installed
 *   install [ids…|all] [--from DIR]
 *                                fetch the samples (sparse git checkouts of the libraries at their pinned
 *                                commits, notes cut from published downloads, files decoded from a
 *                                published archive, or made from a library's recordings: trimmed, a kit's
 *                                microphones mixed), or take them from a folder you already have
 *                                (hard-linked when it can); each file is checked against the pack's checksums
 *   import PATH [--name N] [--id ID] [--license L]
 *                                your own pack: an .sfz, a folder (of SFZ or of samples named by note), or a .zip
 *   refresh                      bring installed packs' maps up to date with the pinned ones (no download)
 *   remove ID                    uninstall a pack
 *   lock [REF] [--check]         pin the packs repository (github.com/shooter-git/holo-packs) at REF, main
 *                                by default: every pack's map fetched and hashed into packs.lock.json.
 *                                --check fetches the locked maps instead, and checks each against the lock
 *
 * The packs' maps and checksums live in the packs repository; packs.lock.json pins one commit of it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { formatLock, LOCK_FILE, lockAt, PackMaps, readLock } from '@holo/music';
import { loadConfig } from './config.ts';
import { extractZip, importFolder } from './pack-import.ts';
import {
  availablePacks,
  packFiles as files,
  installedPack,
  installPack,
  packChecksums,
  presentFiles,
  refreshPack,
  removePack,
  shippedMaps,
} from './pack-install.ts';

const config = loadConfig();
const packsDir = join(config.dataDir, 'packs');
const [command = 'list', ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
}

const installed = (id: string) => installedPack(packsDir, id);
const present = (pack: Parameters<typeof presentFiles>[1]) => presentFiles(packsDir, pack);

async function rescan(): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${config.port}/api/packs/rescan`, { method: 'POST' });
  } catch {
    // the server picks packs up when it next starts
  }
}

async function main(): Promise<void> {
  if (command === 'lock') {
    await lock();
    return;
  }
  mkdirSync(packsDir, { recursive: true });
  const available = availablePacks;
  if (command === 'list') {
    const ids = new Set<string>();
    for (const m of await available()) {
      ids.add(m.id);
      const inst = installed(m.id);
      const status = inst ? `installed (${present(inst)}/${files(inst).length} samples)` : 'not installed';
      console.log(
        `${m.id.padEnd(18)} ${m.name.padEnd(46)} ${String(m.instruments.length).padStart(3)} instruments  ${status}`,
      );
    }
    if (existsSync(packsDir)) {
      for (const id of readdirSync(packsDir)) {
        if (ids.has(id)) continue;
        const inst = installed(id);
        if (inst)
          console.log(
            `${id.padEnd(18)} ${inst.name.padEnd(46)} ${String(inst.instruments.length).padStart(3)} instruments  imported`,
          );
      }
    }
    return;
  }
  if (command === 'install') {
    const from = flag('from');
    const ids = shippedMaps()?.ids() ?? [];
    const want = rest.length === 0 || rest.includes('all') ? ids : rest;
    const all = await available();
    for (const id of want) {
      const m = all.find((x) => x.id === id);
      if (!m) {
        console.error(`No pack "${id}". Available: ${ids.join(', ') || 'none'}`);
        process.exitCode = 1;
        continue;
      }
      console.log(`${m.name}:`);
      try {
        const r = await installPack(packsDir, m.id, {
          ...(from ? { from } : {}),
          log: (line) => console.log(`  ${line}`),
        });
        console.log(`  ready: ${r.present}/${r.total} samples${packChecksums(m.id) ? ', checked' : ''}`);
        if (r.wrong.length) {
          console.error(`  ${r.wrong.length} file(s) aren't the ones HO[LO] pins, e.g. ${r.wrong[0]}`);
          process.exitCode = 1;
        }
      } catch (err) {
        console.error(`  ${err instanceof Error ? err.message : String(err)}`);
        process.exitCode = 1;
      }
    }
    await rescan();
    return;
  }
  if (command === 'import') {
    const name = flag('name');
    const id = flag('id');
    const license = flag('license');
    const path = rest[0];
    if (!path || !existsSync(path)) throw new Error('Give the .sfz, folder or .zip to import');
    let source = resolve(path);
    let temp: string | null = null;
    if (source.toLowerCase().endsWith('.zip')) {
      temp = mkdtempSync(join(tmpdir(), 'holo-pack-'));
      extractZip(source, temp);
      source = temp;
    } else if (source.toLowerCase().endsWith('.sfz')) {
      source = dirname(source);
    }
    try {
      const pack = importFolder(source, packsDir, {
        name: name ?? basename(path).replace(/\.(zip|sfz)$/i, ''),
        ...(id ? { id } : {}),
        ...(license ? { license } : {}),
      });
      console.log(
        `Imported "${pack.name}" as ${pack.id}: ${pack.instruments.map((i) => `${i.title} (${i.zones.length})`).join(', ')}`,
      );
    } finally {
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
    await rescan();
    return;
  }
  if (command === 'refresh') {
    for (const m of await available()) if (refreshPack(packsDir, m)) console.log(`${m.name}: map refreshed`);
    await rescan();
    return;
  }
  if (command === 'remove') {
    const id = rest[0];
    const freed = removePack(packsDir, id ?? '');
    console.log(`Removed ${id} (${(freed / 1e6).toFixed(0)} MB)`);
    await rescan();
    return;
  }
  console.log(
    readFileSync(import.meta.filename, 'utf8')
      .split('*/')[0]
      ?.replace(/^\/\*\*?/, '')
      .replace(/^ \* ?/gm, ''),
  );
}

/** `lock`: pin the packs repository at a commit, or check the pinned maps. */
async function lock(): Promise<void> {
  const repo = resolve(import.meta.dirname, '../../..');
  const file = join(repo, LOCK_FILE);
  const was = readLock(repo);
  if (rest.includes('--check')) {
    if (!was) throw new Error(`No ${LOCK_FILE}`);
    // no kept maps: every one fetched from the locked commit and checked against the lock
    const maps = await new PackMaps(was, null).all();
    console.log(`${LOCK_FILE}: ${maps.length} pack(s) at ${was.repo}@${was.commit.slice(0, 7)}, each its locked map`);
    return;
  }
  const ref = rest.find((a) => !a.startsWith('--')) ?? 'main';
  const next = await lockAt(was?.repo ?? 'shooter-git/holo-packs', ref);
  const ids = [...new Set([...Object.keys(was?.packs ?? {}), ...Object.keys(next.packs)])].sort();
  for (const id of ids) {
    const a = was?.packs[id];
    const b = next.packs[id];
    if (a === b) continue;
    console.log(`  ${id}: ${!a ? 'new' : !b ? 'no longer in the packs repository' : 'its map changed'}`);
  }
  writeFileSync(file, formatLock(next));
  console.log(
    was?.commit === next.commit
      ? `${LOCK_FILE} pins ${next.repo}@${next.commit.slice(0, 7)} already (${ids.length} packs)`
      : `${LOCK_FILE}: ${next.repo}@${next.commit.slice(0, 7)}, ${Object.keys(next.packs).length} packs. Commit it.`,
  );
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
