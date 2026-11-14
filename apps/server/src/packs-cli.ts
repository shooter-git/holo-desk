/**
 * Sample packs from the command line (`pnpm packs …`, or `docker compose exec holo pnpm packs …`):
 *
 *   list                         what's available and what's installed
 *   install [ids…|all] [--from DIR]
 *                                fetch the samples (sparse git checkouts of the libraries at their pinned
 *                                commits, notes cut from published downloads, files decoded from a
 *                                published archive, or made from a library's recordings: trimmed, a kit's
 *                                microphones mixed), or take them from a folder you already have
 *                                (hard-linked when it can); each file is checked against the pack's checksums.
 *                                A palette (ready-made sounds, no audio of its own) brings the packs it requires
 *   import PATH [--name N] [--id ID] [--license L]
 *                                your own pack: an .sfz, a folder (of SFZ or EXS instruments, of samples named
 *                                by note, or a drum kit: a folder for each piece, its microphones in folders of
 *                                their own or named in its files), or a .zip. Its id starts with mine-, so
 *                                installing HO[LO]'s packs never touches it; its samples are hard-linked into the
 *                                data folder when they can be
 *   import A.exs [B.exs…] [--name N] [--id ID] [--license L]
 *                                Logic's sampler instruments (EXS), exactly those: each an instrument, its
 *                                samples found where they are now
 *   import-bfd FOLDER [--name N] BFD, your own copy, from its folder: an inventory of what's there goes to
 *                                the data folder (bfd-inventory.txt). Plain WAV or FLAC files in a folder for each
 *                                piece are imported as a multi-microphone kit (mine-bfd-…); BFD's own sample
 *                                format isn't mapped yet, so otherwise it stops and asks for the inventory
 *   refresh                      bring installed packs' maps up to date with the pinned ones (no download)
 *   remove ID                    uninstall a pack
 *   lock [REF] [--check]         pin the packs repository (github.com/shooter-git/holo-packs) at REF, main
 *                                by default: every pack's map fetched and hashed into packs.lock.json.
 *                                --check fetches the locked maps instead, and checks each against the lock
 *
 * The packs' maps and checksums live in the packs repository; packs.lock.json pins one commit of it.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { formatLock, LOCK_FILE, lockAt, PackMaps, readLock } from '@holo/music';
import { loadConfig } from './config.ts';
import { extractZip, importBfd, importFolder, importPrograms, PRIVATE_AUDIO_NOTE } from './pack-import.ts';
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
import type { Pack } from './packs.ts';

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
      // a palette: sounds, and nothing of its own to install
      const what =
        m.sounds?.length && !m.instruments.length
          ? `${String(m.sounds.length).padStart(3)} sounds       palette, plays ${
              m.requires?.join(', ') ||
              (m.sounds.some((x) => 'synth' in x.instrument) ? 'the built-in synths' : 'packs still to come')
            }`
          : `${String(m.instruments.length).padStart(3)} instruments  ${status}`;
      console.log(`${m.id.padEnd(18)} ${m.name.padEnd(46)} ${what}`);
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
        // a palette brings the packs its sounds play
        const r = await installPack(packsDir, m.id, {
          ...(from ? { from } : {}),
          requires: true,
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
    if (!path || !existsSync(path)) throw new Error('Give the .sfz, .exs, folder or .zip to import');
    if (path.toLowerCase().endsWith('.exs')) {
      // EXS instruments: exactly the ones named (a library's folders hold many), their samples where they are
      const missing = rest.find((p) => !existsSync(p));
      if (missing) throw new Error(`${missing} isn't there`);
      const pack = importPrograms(
        rest.map((p) => resolve(p)),
        packsDir,
        {
          name: name ?? basename(path).replace(/\.exs$/i, ''),
          ...(id ? { id } : {}),
          ...(license ? { license } : {}),
          log: (line) => console.log(`  ${line}`),
        },
      );
      imported(pack);
      await rescan();
      return;
    }
    let source = resolve(path);
    let temp: string | null = null;
    if (source.toLowerCase().endsWith('.zip')) {
      // unpacked beside the packs, so its samples can be hard-linked into the pack (one disk, no second copy)
      temp = mkdtempSync(join(packsDir, '.import-'));
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
        log: (line) => console.log(`  ${line}`),
      });
      imported(pack);
    } finally {
      if (temp) rmSync(temp, { recursive: true, force: true });
    }
    await rescan();
    return;
  }
  if (command === 'import-bfd') {
    const name = flag('name');
    const path = rest[0];
    if (!path || !existsSync(path)) throw new Error('Give the folder BFD is in (copied from its discs)');
    const r = importBfd(path, config.dataDir, {
      ...(name ? { name } : {}),
      log: (line) => console.log(`  ${line}`),
    });
    console.log(`The inventory of ${basename(resolve(path))}: ${r.inventory}`);
    if (!r.pack) {
      console.error(r.reason);
      process.exitCode = 1;
      return;
    }
    imported(r.pack);
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

/** What an import made, and what becomes of a private pack's sound in a song. */
function imported(pack: Pack): void {
  console.log(
    `Imported "${pack.name}" as ${pack.id}: ${pack.instruments
      .map((i) => `${i.title} (${i.zones.length}${i.mics?.length ? `, ${i.mics.length} microphones` : ''})`)
      .join(', ')}`,
  );
  console.log(`Note: ${PRIVATE_AUDIO_NOTE}`);
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
