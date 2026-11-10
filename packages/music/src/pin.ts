/**
 * Pinning HO[LO]'s engine for an experience (on the computer with HO[LO]'s repository, by `holo init`
 * and `holo update-engine`): the engine as one commit has it, taken out of git (so work in progress
 * never goes into a pin), bundled into one file a project commits, beside the sample packs its songs
 * play (maps, sources and checksums) and HO[LO]'s license.
 *
 * The renderer knows every pack its commit's lock pins (the `catalog`: each pack's hash), and plays
 * the ones in packs.json if each is its catalog's map. So packs.json holds only what the songs play,
 * and a pack a new song plays can be added to it later (the studio's Send does) without pinning again,
 * as long as that pack hasn't changed since.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from './fetch.ts';
import {
  ENGINE_PATHS,
  type EngineIdentity,
  engineCode,
  engineCommit,
  engineSource,
  engineVersion,
  LEGACY_ENGINE_PATHS,
  LOCK_FILE,
} from './identity.ts';
import { mapsDir, PackMaps, readLock } from './pack-lock.ts';
import {
  formatPinnedPacks,
  type PackManifest,
  type PinnedPack,
  parseChecksums,
  pinPack,
  withRequired,
} from './packs.ts';

export const RENDERER = 'holo-music.mjs';
export const PACKS = 'packs.json';

export interface Pin {
  /** The engine, as its renderer knows itself. */
  identity: EngineIdentity;
  /** Every pack the engine's lock pins, by id and hash (absent for an engine from before the lock). */
  catalog?: Record<string, string>;
  /** The packs repository's commit that catalog is from. */
  packsAt?: { repo: string; commit: string };
  /** The packs in packs.json, by id. */
  pinned: string[];
  /** Packs asked for that the engine doesn't pin (an imported pack, or one newer than the engine). */
  unpinned: string[];
  /** sha256 of the renderer. */
  sha256: string;
  packsSha256: string;
  /** The files written, relative to the folder. */
  files: string[];
}

/** Whether a ref has a file. */
function hasAt(repo: string, ref: string, path: string): boolean {
  try {
    execFileSync('git', ['-C', repo, 'cat-file', '-e', `${ref}:${path}`], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/** The engine's sources at a ref, in a scratch folder laid out as the repository. */
function checkout(repo: string, ref: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'holo-pin-'));
  const tar = join(dir, 'engine.tar');
  // an engine from before the packs had a repository of their own carried their maps
  const paths = hasAt(repo, ref, LOCK_FILE) ? ENGINE_PATHS : LEGACY_ENGINE_PATHS;
  execFileSync(
    'git',
    [
      '-C',
      repo,
      'archive',
      '--format=tar',
      '-o',
      tar,
      ref,
      '--',
      ...paths,
      'packages/engine/package.json',
      'LICENSE',
      'CREDITS.md',
    ],
    {
      stdio: ['ignore', 'ignore', 'pipe'],
    },
  );
  execFileSync('tar', ['-xf', tar, '-C', dir], { stdio: ['ignore', 'ignore', 'pipe'] });
  rmSync(tar);
  return dir;
}

/** Every pack an engine from before the lock carried (it pinned them all). */
function legacyPacks(src: string): PinnedPack[] {
  const out: PinnedPack[] = [];
  const dir = join(src, 'packs/manifests');
  for (const f of readdirSync(dir)
    .filter((x) => x.endsWith('.json'))
    .sort()) {
    const manifest = JSON.parse(readFileSync(join(dir, f), 'utf8')) as PackManifest;
    let sums: string;
    try {
      sums = readFileSync(join(src, 'packs/checksums', `${manifest.id}.sha256`), 'utf8');
    } catch {
      throw new Error(`${manifest.id} has no checksums (packs/checksums/${manifest.id}.sha256)`);
    }
    out.push(pinPack(manifest, parseChecksums(sums)));
  }
  return out;
}

const README = (id: EngineIdentity, node: string) => `# HO[LO]'s engine, pinned

This folder is a copy of [HO[LO] Desk](https://github.com/shooter-git/holo-desk)'s engine, pinned so
this project builds its music itself, exactly as the studio renders it, with or without HO[LO] Desk.
Don't edit it: \`holo update-engine\` replaces it (and reports how far each song moves).

- \`${RENDERER}\`: the renderer and the build, one file (MIT, see LICENSE). Engine ${id.version}+${id.commit?.slice(0, 7) ?? id.source.slice(0, 7)}${id.date ? ` of ${id.date.slice(0, 10)}` : ''}.
- \`NOTICE.md\`: the code the engine follows and its authors (NumPy's generator, SciPy's filter design).
- \`${PACKS}\`: the sample packs this project's songs play: their instrument maps, where their
  files come from (a git commit, published downloads and how they're cut or mixed, or an archive and
  what's decoded from it) and every file's sha256. Only the packs the songs play are here: the studio's
  Send adds one a new song plays (or \`holo update-engine\` does), and the renderer checks each against
  the engine's own list of packs (from [HO[LO] Packs](https://github.com/shooter-git/holo-packs)).
  Samples are never committed: a build fetches what its songs play and checks each file.

Build the music with Node.js ${node} (the version it's pinned with):

\`\`\`bash
node music/holo/${RENDERER} build
\`\`\`

\`node music/holo/${RENDERER} help\` lists the rest.
`;

/** The credits for the code the engine carries (CREDITS.md's "Code"), and for the libraries it fetches. */
function notice(credits: string): string {
  const code = /\n## Code\n([\s\S]*?)(?=\n## |$)/.exec(credits)?.[1]?.trim();
  return (
    `# Notices\n\n${RENDERER} is HO[LO] Desk's engine (MIT, LICENSE beside this file). It carries code that ` +
    `follows other projects:\n\n${code ?? '(none)'}\n\nThe sample libraries it fetches, their authors and ` +
    `licenses are in ${PACKS} (each library's "credit" and "license").\n`
  );
}

export interface PinOptions {
  repo: string;
  /** The commit (or branch, tag) to pin: HEAD by default. */
  ref?: string;
  /** Where the pin goes (made if needed). */
  dir: string;
  node?: string;
  /** The packs to put in packs.json (those the songs play, and what they require): none by default. */
  packs?: string[];
  /** Where packs' maps come from: by default fetched from the packs repository, kept in HO[LO]'s data folder. */
  maps?: PackMaps;
}

/** Pin the engine at `ref` of the repository into `dir` (made if needed). */
export async function pinEngine(opts: PinOptions): Promise<Pin> {
  const ref = opts.ref ?? 'HEAD';
  const src = checkout(opts.repo, ref);
  try {
    const at = engineCommit(opts.repo, ref);
    const lock = readLock(src);
    const want = [...new Set(opts.packs ?? [])].sort();
    let packs: PinnedPack[];
    let catalog: Record<string, string> | undefined;
    let unpinned: string[];
    if (lock) {
      catalog = { ...lock.packs };
      const maps =
        opts.maps && opts.maps.lock.commit === lock.commit ? opts.maps : new PackMaps(lock, mapsDir(opts.repo));
      // the packs those require come too
      const ids = await withRequired(want, async (id) => (catalog?.[id] ? (await maps.get(id)).requires : null));
      const known = ids.filter((id) => catalog?.[id]).sort();
      unpinned = ids.filter((id) => !catalog?.[id]).sort();
      packs = await Promise.all(known.map((id) => maps.get(id)));
    } else {
      // an engine from before the lock: every pack it carried, as it pinned them
      packs = legacyPacks(src);
      unpinned = want.filter((id) => !packs.some((p) => p.id === id));
    }
    const packsText = formatPinnedPacks(packs);
    const packsSha256 = sha256(Buffer.from(packsText));
    const base = {
      version: engineVersion(src),
      source: engineSource(src),
      commit: at?.commit ?? null,
      date: at?.date ?? null,
    };
    // what the renderer knows of itself: the packs it may play (or, before the lock, the one file it plays)
    const identity = lock ? { ...base, code: engineCode(src), catalog } : { ...base, packsSha256 };
    const { rolldown } = await import('rolldown');
    const bundle = await rolldown({
      input: join(src, 'packages/music/src/main.ts'),
      // paths in the bundle as the repository has them, wherever it was taken out
      cwd: src,
      platform: 'node',
      tsconfig: false,
      logLevel: 'warn',
      resolve: {
        alias: {
          '@holo/session': join(src, 'packages/session/src/index.ts'),
          '@holo/engine': join(src, 'packages/engine/src/index.ts'),
        },
      },
      plugins: [
        {
          name: 'holo-pinned',
          transform(code, id) {
            if (!id.endsWith('/packages/music/src/pinned.ts')) return null;
            const filled = code.replace('/* @pinned */ null', JSON.stringify(identity));
            if (filled === code) throw new Error('pinned.ts has no place for the engine');
            return { code: filled };
          },
        },
      ],
    });
    const label = `${identity.version}+${identity.commit?.slice(0, 7) ?? identity.source.slice(0, 7)}`;
    const { output } = await bundle.generate({
      format: 'esm',
      codeSplitting: false,
      banner:
        `#!/usr/bin/env node\n` +
        `/*! HO[LO] Desk's engine ${label}${identity.date ? ` (${identity.date.slice(0, 10)})` : ''}, pinned: ` +
        `the renderer and build of this project's music. node ${RENDERER} help.\n` +
        ` * Copyright (c) 2026 The HO[LO] Desk authors. MIT License (LICENSE, beside this file).\n` +
        ` * Built from https://github.com/shooter-git/holo-desk${identity.commit ? ` at ${identity.commit}` : ''}. */`,
    });
    await bundle.close();
    const chunk = output.find((o) => o.type === 'chunk');
    if (!chunk || output.length !== 1) throw new Error('The renderer did not bundle into one file');
    const code = chunk.code;
    mkdirSync(opts.dir, { recursive: true });
    writeFileSync(join(opts.dir, RENDERER), code);
    writeFileSync(join(opts.dir, PACKS), packsText);
    copyFileSync(join(src, 'LICENSE'), join(opts.dir, 'LICENSE'));
    writeFileSync(join(opts.dir, 'NOTICE.md'), notice(readFileSync(join(src, 'CREDITS.md'), 'utf8')));
    writeFileSync(join(opts.dir, 'README.md'), README(identity, opts.node ?? process.versions.node));
    const {
      catalog: _c,
      packsSha256: _p,
      ...self
    } = identity as typeof identity & {
      catalog?: unknown;
      packsSha256?: unknown;
    };
    return {
      identity: self,
      ...(catalog && lock ? { catalog, packsAt: { repo: lock.repo, commit: lock.commit } } : {}),
      pinned: packs.map((p) => p.id).sort(),
      unpinned,
      sha256: sha256(Buffer.from(code)),
      packsSha256,
      files: [RENDERER, PACKS, 'LICENSE', 'NOTICE.md', 'README.md'],
    };
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}
