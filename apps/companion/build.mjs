#!/usr/bin/env node
/**
 * Builds HO[LO] Engine.
 *
 *   pnpm engine:build                        the native piece for this computer (then `pnpm engine` runs it)
 *   pnpm engine:build --release              the download for this computer: dist/holo-engine-<os>-<arch>[.exe]
 *   pnpm engine:build --release win32-x64    …for another computer (Windows and Linux build anywhere with Zig;
 *                                            macOS builds on a Mac, where Apple's frameworks are)
 *
 * The native piece is one C file (native/holo_native.c) with miniaudio (fetched once, the release
 * pinned below and checked), compiled by Zig (`zig cc`, which cross-compiles with nothing else
 * installed) or this computer's C compiler. A download is Node's own
 * binary with the app inside it (a single executable application): the JavaScript bundled into three
 * files, the native piece as an asset. Set ZIG to Zig's path if it isn't on the PATH.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const nativeDir = join(here, 'native');
const out = join(nativeDir, 'build');
const dist = join(here, 'dist');
const cache = join(here, '.cache');
const host = `${process.platform}-${process.arch}`;

/** miniaudio (public domain or MIT-0, by David Reid): one header, this release, these bytes. */
const MINIAUDIO = {
  version: '0.11.25',
  sha256: 'ac7af4de748b7e26b777f37e01cee313a308a7296a3eb080e2906b320cc55c89',
};

async function miniaudio() {
  const file = join(cache, `miniaudio-${MINIAUDIO.version}.h`);
  const check = (bytes) => createHash('sha256').update(bytes).digest('hex') === MINIAUDIO.sha256;
  if (existsSync(file) && check(readFileSync(file))) return file;
  const url = `https://raw.githubusercontent.com/mackron/miniaudio/${MINIAUDIO.version}/miniaudio.h`;
  console.log(`miniaudio ${MINIAUDIO.version}: ${url}`);
  const bytes = Buffer.from(await (await fetch(url)).arrayBuffer());
  if (!check(bytes)) throw new Error(`miniaudio.h from ${url} isn’t the release this build expects`);
  mkdirSync(cache, { recursive: true });
  writeFileSync(file, bytes);
  return file;
}

const args = process.argv.slice(2);
const release = args.includes('--release');
const targets = args.filter((a) => !a.startsWith('--'));
if (!targets.length) targets.push(host);

const ZIG = {
  'win32-x64': 'x86_64-windows-gnu',
  'win32-arm64': 'aarch64-windows-gnu',
  'linux-x64': 'x86_64-linux-gnu.2.28',
  'linux-arm64': 'aarch64-linux-gnu.2.28',
};
const LIBS = {
  win32: ['-lwinmm', '-lavrt'],
  linux: ['-ldl', '-lpthread', '-lm'],
  darwin: [
    '-framework',
    'CoreMIDI',
    '-framework',
    'CoreAudio',
    '-framework',
    'AudioToolbox',
    '-framework',
    'CoreFoundation',
  ],
};

function zig() {
  const z = process.env.ZIG || 'zig';
  try {
    execFileSync(z, ['version'], { stdio: 'ignore' });
    return z;
  } catch {
    return null;
  }
}

/** The native piece for one target, compiled where it can be. */
function buildNative(target, header) {
  const [os, arch] = target.split('-');
  const file = join(out, `holo_native-${target}.node`);
  mkdirSync(out, { recursive: true });
  const common = [
    '-O2',
    '-g0',
    '-std=c11',
    '-fvisibility=hidden',
    '-shared',
    `-DHOLO_MINIAUDIO="${header}"`,
    '-o',
    file,
    join(nativeDir, 'holo_native.c'),
  ];
  let cmd;
  let argv;
  if (os === 'darwin') {
    if (process.platform !== 'darwin') throw new Error('macOS builds on a Mac (Apple’s frameworks are only there)');
    cmd = 'cc';
    argv = ['-arch', arch === 'x64' ? 'x86_64' : 'arm64', '-mmacosx-version-min=11.0', ...common, ...LIBS.darwin];
  } else {
    const z = zig();
    const triple = ZIG[target];
    if (z && triple) {
      cmd = z;
      argv = ['cc', '-target', triple, ...(os === 'win32' ? [] : ['-fPIC']), ...common, ...LIBS[os]];
    } else if (target === host) {
      cmd = process.env.CC || 'cc';
      argv = ['-fPIC', ...common, ...LIBS[os]];
    } else {
      throw new Error(
        `Building for ${target} needs Zig (https://ziglang.org/download/): set ZIG or put zig on the PATH`,
      );
    }
  }
  console.log(`native ${target}: ${cmd} ${argv.join(' ')}`);
  execFileSync(cmd, argv, { stdio: 'inherit' });
  return file;
}

/** Node's binary for a target, the same version as the one building (the app's blob is made for it). */
async function nodeBinary(target) {
  if (target === host) return process.execPath;
  const [os, arch] = target.split('-');
  const v = process.version;
  const dir = join(cache, `node-${v}-${target}`);
  const bin = join(dir, os === 'win32' ? 'node.exe' : 'node');
  if (existsSync(bin)) return bin;
  mkdirSync(dir, { recursive: true });
  const base = `https://nodejs.org/dist/${v}`;
  const sums = await (await fetch(`${base}/SHASUMS256.txt`)).text();
  const name = os === 'win32' ? `win-${arch}/node.exe` : `node-${v}-${os}-${arch}.tar.gz`;
  const want = sums
    .split('\n')
    .find((l) => l.endsWith(`  ${name}`))
    ?.split(' ')[0];
  if (!want) throw new Error(`nodejs.org has no ${name} for ${v}`);
  console.log(`node ${target}: ${base}/${name}`);
  const bytes = Buffer.from(await (await fetch(`${base}/${name}`)).arrayBuffer());
  const got = createHash('sha256').update(bytes).digest('hex');
  if (got !== want) throw new Error(`${name}: checksum ${got} isn’t nodejs.org’s ${want}`);
  if (os === 'win32') writeFileSync(bin, bytes);
  else {
    const tgz = join(dir, 'node.tar.gz');
    writeFileSync(tgz, bytes);
    execFileSync('tar', ['-xzf', tgz, '-C', dir, '--strip-components=2', `node-${v}-${os}-${arch}/bin/node`]);
    rmSync(tgz);
  }
  return bin;
}

/** The JavaScript, three files: the main thread, the render thread and the threads that render ahead. */
async function bundle() {
  const { build } = await import('rolldown');
  for (const [entry, name] of [
    ['src/sea.ts', 'main.cjs'],
    ['src/render.ts', 'render.cjs'],
    ['src/ahead-thread.ts', 'ahead.cjs'],
  ]) {
    await build({
      input: join(here, entry),
      platform: 'node',
      // ws asks for these two optional speed-ups and does without them
      external: [/^node:/, 'bufferutil', 'utf-8-validate'],
      output: { file: join(dist, name), format: 'cjs', codeSplitting: false },
      logLevel: 'warn',
    });
  }
}

async function single(target, native) {
  const [os, arch] = target.split('-');
  const name = `holo-engine-${os === 'win32' ? 'windows' : os === 'darwin' ? 'macos' : os}-${arch}`;
  const exe = join(dist, os === 'win32' ? `${name}.exe` : name);
  const blob = join(dist, `${name}.blob`);
  const config = join(dist, `${name}.sea.json`);
  writeFileSync(
    config,
    JSON.stringify({
      main: join(dist, 'main.cjs'),
      output: blob,
      disableExperimentalSEAWarning: true,
      useSnapshot: false,
      useCodeCache: false,
      assets: {
        'render.cjs': join(dist, 'render.cjs'),
        'ahead.cjs': join(dist, 'ahead.cjs'),
        'holo_native.node': native,
      },
    }),
  );
  execFileSync(process.execPath, ['--experimental-sea-config', config], { stdio: 'inherit' });
  copyFileSync(await nodeBinary(target), exe);
  chmodSync(exe, 0o755);
  if (os === 'darwin') execFileSync('codesign', ['--remove-signature', exe]);
  const { inject } = await import('postject');
  await inject(exe, 'NODE_SEA_BLOB', readFileSync(blob), {
    sentinelFuse: 'NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2',
    ...(os === 'darwin' ? { machoSegmentName: 'NODE_SEA' } : {}),
    overwrite: true,
  });
  if (os === 'darwin') execFileSync('codesign', ['--sign', '-', exe]);
  rmSync(blob);
  rmSync(config);
  console.log(`built ${exe}`);
}

const header = await miniaudio();
const natives = new Map(targets.map((t) => [t, buildNative(t, header)]));
if (release) {
  mkdirSync(dist, { recursive: true });
  await bundle();
  for (const t of targets) await single(t, natives.get(t));
}
