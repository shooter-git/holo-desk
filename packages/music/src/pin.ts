/**
 * Pinning HO[LO]'s engine for an experience (on the computer with HO[LO]'s repository, by `holo init`
 * and `holo update-engine`): the engine as one commit has it, taken out of git (so work in progress
 * never goes into a pin), bundled into one file a project commits, beside the sample libraries it
 * plays (maps, sources and checksums) and HO[LO]'s license.
 */
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sha256 } from './fetch.ts';
import { ENGINE_PATHS, type EngineIdentity, engineCommit, engineSource, engineVersion } from './identity.ts';
import { formatPinnedPacks, type PackManifest, type PinnedPack, parseChecksums, pinPack } from './packs.ts';

export const RENDERER = 'holo-music.mjs';
export const PACKS = 'packs.json';

export interface Pin {
  identity: EngineIdentity & { packsSha256: string };
  /** sha256 of the renderer. */
  sha256: string;
  packsSha256: string;
  /** The files written, relative to the folder. */
  files: string[];
}

/** The engine's sources at a ref, in a scratch folder laid out as the repository. */
function checkout(repo: string, ref: string): string {
  const dir = mkdtempSync(join(tmpdir(), 'holo-pin-'));
  const tar = join(dir, 'engine.tar');
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
      ...ENGINE_PATHS,
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

/** The pinned libraries: every pack HO[LO] ships maps and checksums for. */
function pinnedPacks(src: string): PinnedPack[] {
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
      throw new Error(
        `${manifest.id} has no checksums (packs/checksums/${manifest.id}.sha256): run tools/pack-checksums.mjs`,
      );
    }
    out.push(pinPack(manifest, parseChecksums(sums)));
  }
  return out;
}

const README = (id: EngineIdentity & { packsSha256: string }, node: string) => `# HO[LO]'s engine, pinned

This folder is a copy of [HO[LO] Desk](https://github.com/shooter-git/holo-desk)'s engine, pinned so
this project builds its music itself, exactly as the studio renders it, with or without HO[LO] Desk.
Don't edit it: \`holo update-engine\` replaces it (and reports how far each song moves).

- \`${RENDERER}\`: the renderer and the build, one file (MIT, see LICENSE). Engine ${id.version}+${id.commit?.slice(0, 7) ?? id.source.slice(0, 7)}${id.date ? ` of ${id.date.slice(0, 10)}` : ''}.
- \`NOTICE.md\`: the code the engine follows and its authors (NumPy's generator, SciPy's filter design).
- \`${PACKS}\`: the sample libraries the engine plays: their instrument maps, where their files
  come from (a git commit, published downloads and how they're cut, or an archive and what's decoded
  from it) and every file's sha256.
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
    `licences are in ${PACKS} (each library's "credit" and "license").\n`
  );
}

/** Pin the engine at `ref` of the repository into `dir` (made if needed). */
export async function pinEngine(opts: { repo: string; ref?: string; dir: string; node?: string }): Promise<Pin> {
  const ref = opts.ref ?? 'HEAD';
  const src = checkout(opts.repo, ref);
  try {
    const at = engineCommit(opts.repo, ref);
    const packsText = formatPinnedPacks(pinnedPacks(src));
    const packsSha256 = sha256(Buffer.from(packsText));
    const identity = {
      version: engineVersion(src),
      source: engineSource(src),
      commit: at?.commit ?? null,
      date: at?.date ?? null,
      packsSha256,
    };
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
    return {
      identity,
      sha256: sha256(Buffer.from(code)),
      packsSha256,
      files: [RENDERER, PACKS, 'LICENSE', 'NOTICE.md', 'README.md'],
    };
  } finally {
    rmSync(src, { recursive: true, force: true });
  }
}
