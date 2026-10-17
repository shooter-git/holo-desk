/**
 * Music for an experience: a new project (a game, an app, an installation) whose music is composed in
 * HO[LO]. `holo init` sets one up to build its songs itself with a pinned copy of HO[LO]'s engine;
 * `holo update-engine` moves it to this HO[LO]'s engine, and says how far each song moved.
 */
import { execFileSync } from 'node:child_process';
import {
  appendFileSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, relative, resolve, sep } from 'node:path';
import { decodeWav } from '@holo/engine';
import {
  audioFolder,
  DEFAULT_BUILD,
  describeDistance,
  distance,
  type Experience,
  type ExperienceManifest,
  engineLabel,
  findRoot,
  listSongs,
  MANIFEST,
  NAME,
  openExperience,
  type PinnedEngine,
  readManifest,
  readState,
  sha256,
  slug,
  songInput,
  titleOf,
  writeManifest,
} from '@holo/music';
import { PACKS, type Pin, pinEngine, RENDERER } from '@holo/music/pin';
import { parseProject } from '@holo/session';

/** Where the pinned engine lives in a project. */
const PIN_DIR = 'music/holo';
const SCRIPT = `node ${PIN_DIR}/${RENDERER} build`;

type Log = (line: string) => void;

function pinned(pin: Pin): PinnedEngine {
  const { packsSha256, ...identity } = pin.identity;
  return {
    ...identity,
    node: process.versions.node,
    file: `${PIN_DIR}/${RENDERER}`,
    sha256: pin.sha256,
    packs: `${PIN_DIR}/${PACKS}`,
    packsSha256,
  };
}

/** The studio's "Hear it as…": the experience renders the song with its own pinned engine. */
const RENDER = {
  command: [
    'node',
    `${PIN_DIR}/${RENDERER}`,
    'render',
    '{piece}',
    '--sessions',
    '{sessions}',
    '--out',
    '{out}/{piece}.wav',
  ],
  output: '{out}/{piece}.wav',
};

/** Where the studio looks for experiences, if this computer says. */
function creationsDir(repo: string): string | null {
  const dir = process.env.HOLO_CREATIONS_DIR;
  return dir ? resolve(repo, dir) : null;
}

export interface InitOptions {
  name?: string;
  title?: string;
  sessions?: string;
  out?: string;
  format?: string;
  ref?: string;
}

export async function init(repo: string, dir: string, opts: InitOptions, log: Log): Promise<void> {
  const root = resolve(dir);
  if (existsSync(join(root, MANIFEST))) {
    throw new Error(
      `${root} is set up already (it has a ${MANIFEST}): \`holo update-engine\` moves it to this HO[LO]'s engine`,
    );
  }
  const name = opts.name ?? slug(basename(root));
  if (!NAME.test(name)) throw new Error(`"${name}" can't be a name: lower case letters, digits, - and _ (--name)`);
  const format = (opts.format ?? DEFAULT_BUILD.format) as 'wav' | 'wav24';
  if (format !== 'wav' && format !== 'wav24') throw new Error('--format is wav (32-bit float) or wav24 (24-bit PCM)');
  mkdirSync(root, { recursive: true });
  const pin = await pinEngine({ repo, dir: join(root, PIN_DIR), ...(opts.ref ? { ref: opts.ref } : {}) });
  const sessions = opts.sessions ?? 'music/sessions';
  mkdirSync(join(root, sessions), { recursive: true });
  if (!existsSync(join(root, sessions, '.gitkeep'))) writeFileSync(join(root, sessions, '.gitkeep'), '');
  const build = { ...DEFAULT_BUILD, out: opts.out ?? DEFAULT_BUILD.out, format };
  const manifest: ExperienceManifest = {
    format: 'holo-creation',
    version: 1,
    name,
    title: opts.title ?? titleOf(name),
    sessions,
    renderHelp: `npm run music builds every song whose file changed into ${build.out}`,
    render: RENDER,
    engine: pinned(pin),
    build,
  };
  writeManifest(root, manifest);

  // npm run music
  const pkgFile = join(root, 'package.json');
  let script = 'added';
  if (existsSync(pkgFile)) {
    const text = readFileSync(pkgFile, 'utf8');
    const pkg = JSON.parse(text) as { scripts?: Record<string, string> };
    if (pkg.scripts?.music && pkg.scripts.music !== SCRIPT) script = `left as it was ("${pkg.scripts.music}")`;
    else {
      pkg.scripts = { ...pkg.scripts, music: SCRIPT };
      const indent = /^\{\n(\s+)"/.exec(text)?.[1] ?? '  ';
      writeFileSync(pkgFile, `${JSON.stringify(pkg, null, indent)}\n`);
    }
  } else {
    writeFileSync(pkgFile, `${JSON.stringify({ name, private: true, scripts: { music: SCRIPT } }, null, 2)}\n`);
    script = 'in a new package.json';
  }
  // the built songs are made, not written: kept out of git unless the project wants them in
  const ignore = join(root, '.gitignore');
  const line = `/${build.out.replace(/^\/+|\/+$/g, '')}/`;
  const ignored = existsSync(ignore) ? readFileSync(ignore, 'utf8') : '';
  if (!ignored.split('\n').includes(line))
    appendFileSync(
      ignore,
      `${ignored && !ignored.endsWith('\n') ? '\n' : ''}# its songs, built by npm run music\n${line}\n`,
    );

  const e = manifest.engine as PinnedEngine;
  log(`"${manifest.title}" (${name}) is set up in ${root}:`);
  log(`  ${MANIFEST}   its name, its songs' folder, the engine (${engineLabel(e)}) and Node.js ${e.node}`);
  log(`  ${PIN_DIR}/          the pinned engine: ${RENDERER} (the renderer, one file), ${PACKS}, LICENSE, README.md`);
  log(`  ${sessions}/      its songs, a <piece>.holo.json each (and <piece>.audio/ for a song's recordings)`);
  log(`  npm run music        builds the songs whose files changed into ${build.out}/ (script ${script})`);
  const studio = creationsDir(repo);
  if (studio && !(root + sep).startsWith(studio + sep))
    log(`\nThe studio finds experiences in ${studio}: put the project there (or link it) for its songs to show.`);
  log(`\nNext: holo new "Theme" --for ${name}   (a song for it, open in the studio)`);
}

/** A song's render by a pinned renderer, into a file (null if it couldn't). */
function renderWith(file: string, root: string, piece: string, out: string): string | null {
  try {
    execFileSync(process.execPath, [file, 'render', piece, '--root', root, '--out', out], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    return null;
  } catch (err) {
    const text = (err as { stderr?: Buffer }).stderr?.toString().trim().split('\n').pop();
    return text || (err instanceof Error ? err.message : String(err));
  }
}

export async function updateEngine(repo: string, dir: string, opts: { ref?: string }, log: Log): Promise<void> {
  const root = findRoot(dir);
  const manifest = readManifest(root);
  const was = manifest.engine;
  if (!was) throw new Error(`${root} pins no engine: \`holo init\` sets it up`);
  const scratch = mkdtempSync(join(tmpdir(), 'holo-update-'));
  try {
    const pin = await pinEngine({ repo, dir: join(scratch, 'pin'), ...(opts.ref ? { ref: opts.ref } : {}) });
    const next = pinned(pin);
    const oldFile = join(root, was.file);
    const intact = existsSync(oldFile) && sha256(readFileSync(oldFile)) === was.sha256;
    if (next.source === was.source && next.node === was.node && intact) {
      log(`${manifest.title} is on this engine already (${engineLabel(was)}, Node.js ${was.node}): nothing to do.`);
      return;
    }
    const songs = listSongs({ sessions: resolve(root, manifest.sessions) });
    log(
      `${manifest.title}: engine ${engineLabel(was)} → ${engineLabel(next)}` +
        `${was.node !== next.node ? `, Node.js ${was.node} → ${next.node}` : ''}; ${songs.length} song(s)`,
    );
    // each song as the old engine made it: its last build, if that is still the song as it is now,
    // else rendered again by the old renderer (with this Node.js)
    const before = new Map<string, string | null>();
    let old: Experience | null = null;
    try {
      old = openExperience(root);
    } catch {
      // its libraries file changed: render instead
    }
    const state = old ? readState(old.out) : null;
    for (const s of songs) {
      const out = join(scratch, 'before', `${s.piece}.wav`);
      mkdirSync(join(scratch, 'before'), { recursive: true });
      const built = state?.songs[s.piece];
      const file = old ? join(old.out, `${s.piece}.wav`) : '';
      if (old && built && built.engine === was.source && existsSync(file)) {
        const bytes = new Uint8Array(readFileSync(s.file));
        const project = parseProject(JSON.parse(Buffer.from(bytes).toString('utf8')));
        const input = songInput(old, bytes, project, audioFolder(old.sessions, s.piece), built.node);
        if (built.input === input && sha256(readFileSync(file)) === built.sha256) {
          copyFileSync(file, out);
          before.set(s.piece, out);
          continue;
        }
      }
      const failed = intact ? renderWith(oldFile, root, s.piece, out) : 'the old renderer was missing or changed';
      before.set(s.piece, failed ? null : out);
      if (failed) log(`  ${s.piece}: no render with the old engine (${failed})`);
    }
    // the new engine in its place, then every song built with it
    const into = join(root, PIN_DIR);
    mkdirSync(into, { recursive: true });
    for (const f of pin.files) copyFileSync(join(scratch, 'pin', f), join(into, f));
    writeManifest(root, { ...manifest, engine: next, render: manifest.render ?? RENDER });
    execFileSync(process.execPath, [join(root, next.file), 'build', '--force', '--root', root], { stdio: 'inherit' });
    const out = resolve(root, manifest.build?.out ?? DEFAULT_BUILD.out);
    log('\nHow far each song moved:');
    for (const s of songs) {
      const old = before.get(s.piece);
      const now = join(out, `${s.piece}.wav`);
      if (!old || !existsSync(now)) {
        log(`  ${s.piece}: built with the new engine (nothing to compare it with)`);
        continue;
      }
      const a = decodeWav(new Uint8Array(readFileSync(old)));
      const b = decodeWav(new Uint8Array(readFileSync(now)));
      log(
        `  ${s.piece}: ${a.rate === b.rate ? describeDistance(distance(a.channels, b.channels), a.rate) : 'its rate changed'}`,
      );
    }
    log(`\nCommit ${MANIFEST} and ${relative(root, into)}/ together.`);
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}
