/**
 * Sample packs from the command line (`pnpm packs …`, or `docker compose exec holo pnpm packs …`):
 *
 *   list                         what's available and what's installed
 *   install [ids…|all] [--from DIR]
 *                                fetch the samples (sparse git checkouts of the CC0 libraries at their
 *                                pinned commits, notes cut from published downloads, or files decoded
 *                                from a published archive), or take them from a folder you already have
 *                                (hard-linked when it can); each file is checked against packs/checksums
 *   import PATH [--name N] [--id ID] [--license L]
 *                                your own pack: an .sfz, a folder (of SFZ or of samples named by note), or a .zip
 *   refresh                      bring installed packs' maps up to date with packs/manifests (no download)
 *   remove ID                    uninstall a pack
 */
import { execFileSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, extname, join, resolve } from 'node:path';
import { fetchFiles, type PackManifest, packPaths, parseChecksums, pinPack, SampleCache, sha256 } from '@holo/music';
import { loadConfig } from './config.ts';
import { extractZip, importFolder } from './pack-import.ts';
import type { Pack } from './packs.ts';

const config = loadConfig();
const packsDir = join(config.dataDir, 'packs');
const manifestsDir = resolve(import.meta.dirname, '../../../packs/manifests');
const checksumsDir = resolve(import.meta.dirname, '../../../packs/checksums');
const [command = 'list', ...rest] = process.argv.slice(2);

function flag(name: string): string | undefined {
  const i = rest.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const v = rest[i + 1];
  rest.splice(i, 2);
  return v;
}

type Manifest = Pack & { format: string; version: number; hlLibrary?: string };

function available(): Manifest[] {
  if (!existsSync(manifestsDir)) return [];
  return readdirSync(manifestsDir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => JSON.parse(readFileSync(join(manifestsDir, f), 'utf8')) as Manifest);
}

function installed(id: string): Manifest | null {
  const p = join(packsDir, id, 'holo-pack.json');
  return existsSync(p) ? (JSON.parse(readFileSync(p, 'utf8')) as Manifest) : null;
}

function files(pack: Pack): string[] {
  return packPaths(pack as unknown as PackManifest);
}

function checksums(id: string): Record<string, string> | null {
  const file = join(checksumsDir, `${id}.sha256`);
  return existsSync(file) ? parseChecksums(readFileSync(file, 'utf8')) : null;
}

/** Files that aren't the ones HO[LO] pins (an experience's build would refuse them). */
function mismatched(pack: Pack): string[] {
  const sums = checksums(pack.id);
  if (!sums) return [];
  const root = join(packsDir, pack.id, pack.root || 'samples');
  return files(pack).filter((f) => {
    const path = join(root, f);
    return existsSync(path) && sums[f] !== undefined && sha256(readFileSync(path)) !== sums[f];
  });
}

function present(pack: Pack): number {
  const root = join(packsDir, pack.id, pack.root || 'samples');
  return files(pack).filter((f) => existsSync(join(root, f))).length;
}

async function rescan(): Promise<void> {
  try {
    await fetch(`http://127.0.0.1:${config.port}/api/packs/rescan`, { method: 'POST' });
  } catch {
    // the server picks packs up when it next starts
  }
}

function place(src: string, dest: string): void {
  mkdirSync(dirname(dest), { recursive: true });
  if (existsSync(dest)) return;
  try {
    linkSync(src, dest);
  } catch {
    copyFileSync(src, dest);
  }
}

function fromFolder(pack: Manifest, from: string): number {
  const root = join(packsDir, pack.id, pack.root || 'samples');
  let n = 0;
  const missing: string[] = [];
  for (const f of files(pack)) {
    const candidates = [join(from, f), ...(pack.hlLibrary ? [join(from, pack.hlLibrary, f)] : [])];
    const src = candidates.find((c) => existsSync(c));
    if (src) {
      place(src, join(root, f));
      n++;
    } else missing.push(f);
  }
  if (missing.length) console.log(`  ${missing.length} sample(s) not found under ${from}, e.g. ${missing[0]}`);
  return n;
}

/**
 * Files made from the downloads the pack's recipe names (notes cut from runs, FLAC decoded from an
 * archive), each checked, into the pack's folder.
 */
async function fromRecipe(pack: Manifest): Promise<void> {
  const sums = checksums(pack.id);
  if (!sums) throw new Error(`${pack.name} has no checksums (packs/checksums/${pack.id}.sha256)`);
  const pinned = pinPack(pack as unknown as PackManifest, sums);
  // fetched beside the packs (in Docker the data folder is what's writable), then linked into place
  const cache = new SampleCache(mkdtempSync(join(packsDir, '.fetch-')));
  const root = join(packsDir, pack.id, pack.root || 'samples');
  try {
    const want = files(pack).map((path) => ({ pack: pinned, path, sha256: pinned.files[path] as string }));
    await fetchFiles(want, { cache, log: (line) => console.log(`  ${line}`) });
    for (const f of want) place(cache.path(f.sha256, extname(f.path)), join(root, f.path));
  } finally {
    rmSync(cache.dir, { recursive: true, force: true });
  }
}

function fromGit(pack: Manifest): void {
  if (pack.source.kind !== 'git')
    throw new Error(
      `${pack.name} can't be downloaded: install it with --from (${'note' in pack.source ? pack.source.note : ''})`,
    );
  const root = join(packsDir, pack.id, pack.root || 'samples');
  const dirs = [...new Set(files(pack).map((f) => dirname(f)))].map((d) => `/${d}/`);
  const git = (...args: string[]) => execFileSync('git', args, { stdio: 'inherit' });
  const commit = pack.source.commit;
  if (commit) {
    // the commit HO[LO] pins: the files every experience's build checks against
    if (!existsSync(join(root, '.git'))) {
      mkdirSync(root, { recursive: true });
      git('-C', root, 'init', '-q');
      git('-C', root, 'remote', 'add', 'origin', pack.source.url);
    }
    git('-C', root, 'sparse-checkout', 'set', '--no-cone', ...dirs);
    git('-C', root, 'fetch', '-q', '--depth', '1', '--filter=blob:none', 'origin', commit);
    git('-C', root, 'checkout', '-q', commit);
    return;
  }
  if (!existsSync(join(root, '.git'))) {
    mkdirSync(dirname(root), { recursive: true });
    git(
      'clone',
      '--filter=blob:none',
      '--no-checkout',
      '--depth',
      '1',
      '--branch',
      pack.source.branch ?? 'master',
      pack.source.url,
      root,
    );
  }
  git('-C', root, 'sparse-checkout', 'set', '--no-cone', ...dirs);
  git('-C', root, 'checkout');
}

async function main(): Promise<void> {
  mkdirSync(packsDir, { recursive: true });
  if (command === 'list') {
    const ids = new Set<string>();
    for (const m of available()) {
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
    const want = rest.length === 0 || rest.includes('all') ? available().map((m) => m.id) : rest;
    for (const id of want) {
      const m = available().find((x) => x.id === id);
      if (!m) {
        console.error(
          `No pack "${id}". Available: ${available()
            .map((x) => x.id)
            .join(', ')}`,
        );
        process.exitCode = 1;
        continue;
      }
      console.log(`${m.name}:`);
      try {
        if (from) console.log(`  ${fromFolder(m, resolve(from))} sample(s) from ${from}`);
        else if (m.source.kind === 'cut' || m.source.kind === 'archive') await fromRecipe(m);
        else fromGit(m);
        writeFileSync(join(packsDir, m.id, 'holo-pack.json'), `${JSON.stringify(m)}\n`);
        const wrong = mismatched(m);
        console.log(`  ready: ${present(m)}/${files(m).length} samples${checksums(m.id) ? ', checked' : ''}`);
        if (wrong.length) {
          console.error(`  ${wrong.length} file(s) aren't the ones HO[LO] pins, e.g. ${wrong[0]}`);
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
    for (const m of available()) {
      if (!installed(m.id)) continue;
      writeFileSync(join(packsDir, m.id, 'holo-pack.json'), `${JSON.stringify(m)}\n`);
      console.log(`${m.name}: map refreshed`);
    }
    await rescan();
    return;
  }
  if (command === 'remove') {
    const id = rest[0];
    if (!id || !installed(id)) throw new Error(`No installed pack "${id ?? ''}"`);
    rmSync(join(packsDir, id), { recursive: true, force: true });
    console.log(`Removed ${id}`);
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

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
