/**
 * Building an experience's music: each song in its sessions folder rendered by the pinned engine,
 * exactly as HO[LO] renders it headless (`holo render-audio`: the same rate, tail, finish and loop),
 * into lossless files. A song is built again only when something it is made of changed: its file,
 * its audio files, the engine, the Node.js that runs it or the build's settings.
 */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, normalize, relative, resolve, sep } from 'node:path';
import { encodeWav, renderSession } from '@holo/engine';
import { type Project, parseProject } from '@holo/session';
import { type FetchOptions, fetchFiles, sha256 } from './fetch.ts';
import type { EngineIdentity } from './identity.ts';
import {
  type BuildSettings,
  DEFAULT_BUILD,
  type ExperienceManifest,
  MANIFEST,
  NAME,
  type PinnedEngine,
  readManifest,
} from './manifest.ts';
import { type PinnedPacks, parsePinnedPacks, songFiles } from './packs.ts';
import { audioFolder, experienceSource } from './source.ts';

export interface Experience {
  root: string;
  manifest: ExperienceManifest;
  engine: PinnedEngine;
  build: BuildSettings;
  /** Absolute folders. */
  sessions: string;
  out: string;
  packs: PinnedPacks;
}

const inside = (root: string, rel: string, what: string) => {
  const path = normalize(resolve(root, rel));
  if (path !== root && !path.startsWith(root + sep)) throw new Error(`${what} (${rel}) is outside the project`);
  return path;
};

/** The project around a folder: the nearest holo.creation.json at or above it. */
export function findRoot(from: string): string {
  let dir = resolve(from);
  for (;;) {
    if (existsSync(join(dir, MANIFEST))) return dir;
    const up = resolve(dir, '..');
    if (up === dir) throw new Error(`No ${MANIFEST} here or above (${from}): set the project up with \`holo init\``);
    dir = up;
  }
}

/**
 * An experience as its manifest pins it. `self` is the engine reading it: a pinned renderer checks
 * that it is the one the manifest names, and that the pinned libraries are the ones it was made with.
 */
export function openExperience(root: string, self?: (EngineIdentity & { packsSha256: string }) | null): Experience {
  const manifest = readManifest(root);
  const engine = manifest.engine;
  if (!engine) throw new Error(`${MANIFEST} pins no engine: set the project up with \`holo init\``);
  if (self && self.source !== engine.source) {
    throw new Error(
      `${MANIFEST} pins engine ${engine.commit?.slice(0, 7) ?? engine.source.slice(0, 7)}, but this renderer is ` +
        `${self.commit?.slice(0, 7) ?? self.source.slice(0, 7)}: \`holo update-engine\` pins both together`,
    );
  }
  const packsFile = inside(root, engine.packs, 'The pinned libraries');
  const text = readFileSync(packsFile);
  const got = sha256(text);
  if (got !== engine.packsSha256 || (self && self.packsSha256 !== got)) {
    throw new Error(`${engine.packs} isn't the file the engine was pinned with: restore it, or \`holo update-engine\``);
  }
  const build = { ...DEFAULT_BUILD, ...manifest.build };
  if (build.format !== 'wav' && build.format !== 'wav24')
    throw new Error(`build.format is "wav" (32-bit float) or "wav24" (24-bit PCM), not "${build.format}"`);
  return {
    root,
    manifest,
    engine,
    build,
    sessions: inside(root, manifest.sessions, 'The sessions folder'),
    out: inside(root, build.out, 'The build folder'),
    packs: parsePinnedPacks(text.toString('utf8')),
  };
}

/** The Node.js the music builds with: exactly the pinned one, unless told otherwise. */
export function checkNode(exp: Experience, anyNode: boolean, warn: (line: string) => void): void {
  const have = process.versions.node;
  if (have === exp.engine.node) return;
  const text = `This project's music builds with Node.js ${exp.engine.node}; this is ${have}.`;
  if (anyNode) {
    warn(`${text} Going on (--any-node): the result may differ from a build with ${exp.engine.node}.`);
    return;
  }
  throw new Error(
    `${text} Run it with that version (nvm install ${exp.engine.node}, then nvm exec ${exp.engine.node} …; ` +
      `fnm and volta work as well), or add --any-node to build with this one.`,
  );
}

export interface Song {
  piece: string;
  file: string;
}

/** The songs: every <piece>.holo.json in the sessions folder. */
export function listSongs(exp: Pick<Experience, 'sessions'>): Song[] {
  if (!existsSync(exp.sessions)) return [];
  return readdirSync(exp.sessions)
    .filter((f) => f.endsWith('.holo.json') && NAME.test(f.slice(0, -'.holo.json'.length)))
    .sort()
    .map((f) => ({ piece: f.slice(0, -'.holo.json'.length), file: join(exp.sessions, f) }));
}

export interface BuildState {
  format: 'holo-build';
  version: 1;
  songs: Record<
    string,
    {
      /** sha256 of everything the song is made of. */
      input: string;
      output: string;
      bytes: number;
      sha256: string;
      engine: string;
      node: string;
      seconds: number;
      rate: number;
      built: string;
    }
  >;
}

export const STATE_FILE = '.holo-build.json';

export function readState(out: string): BuildState {
  try {
    const s = JSON.parse(readFileSync(join(out, STATE_FILE), 'utf8')) as BuildState;
    if (s.format === 'holo-build' && s.songs) return s;
  } catch {
    // none yet
  }
  return { format: 'holo-build', version: 1, songs: {} };
}

function writeState(out: string, state: BuildState): void {
  const sorted = Object.fromEntries(Object.entries(state.songs).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(join(out, STATE_FILE), `${JSON.stringify({ ...state, songs: sorted }, null, 2)}\n`);
}

/** The rate a song is built at. */
export const songRate = (exp: Pick<Experience, 'build'>, project: Project) =>
  exp.build.rate ?? project.sampleRate ?? 48000;

/** What a song is made of, as one fingerprint (built by this Node.js, or the one named). */
export function songInput(
  exp: Experience,
  bytes: Uint8Array,
  project: Project,
  audioDir: string,
  node = process.versions.node,
): string {
  const h = createHash('sha256');
  h.update(
    JSON.stringify({
      engine: exp.engine.source,
      node,
      format: exp.build.format,
      rate: songRate(exp, project),
      tail: exp.build.tail,
    }),
  );
  h.update(bytes);
  const present = existsSync(audioDir) ? readdirSync(audioDir) : [];
  for (const f of [...(project.files ?? [])].sort((a, b) => a.id.localeCompare(b.id))) {
    const found = present.find((name) => name.startsWith(`${f.id}.`));
    h.update(`\0${f.id}\0${found ? sha256(readFileSync(join(audioDir, found))) : 'missing'}`);
  }
  return h.digest('hex');
}

export interface RenderedSong {
  channels: Float32Array[];
  rate: number;
}

/** One song through the engine, its samples fetched first. */
export async function renderSong(
  exp: Experience,
  project: Project,
  audioDir: string,
  fetch: FetchOptions,
  progress?: (text: string) => void,
): Promise<RenderedSong> {
  const { files, problems } = songFiles(project, exp.packs);
  if (problems.length) throw new Error(`"${project.title}" can't be built:\n  ${problems.join('\n  ')}`);
  await fetchFiles(files, fetch);
  const rate = songRate(exp, project);
  const out = await renderSession(project, experienceSource(exp.packs, audioDir, fetch), {
    sampleRate: rate,
    tail: exp.build.tail,
    ...(progress ? { onProgress: progress } : {}),
  });
  if (out.errors.length) throw new Error(`The engine stopped on "${project.title}": ${out.errors[0]}`);
  return { channels: out.channels, rate };
}

export const encodeSong = (exp: Pick<Experience, 'build'>, song: RenderedSong) =>
  encodeWav(song.channels, song.rate, exp.build.format === 'wav24' ? 'pcm24' : 'float32');

export function writeAtomic(file: string, bytes: Uint8Array): void {
  mkdirSync(resolve(file, '..'), { recursive: true });
  const tmp = `${file}.${process.pid}.part`;
  writeFileSync(tmp, bytes);
  renameSync(tmp, file);
}

export interface BuildReport {
  built: { piece: string; seconds: number; took: number }[];
  fresh: string[];
  removed: string[];
}

export interface BuildOptions {
  /** Only these pieces (all by default). */
  only?: string[];
  /** Build them even if nothing changed. */
  force?: boolean;
  fetch: FetchOptions;
  log: (line: string) => void;
  progress?: (text: string) => void;
}

/** Build every song whose file (or anything else it's made of) changed since it was last built. */
export async function buildMusic(exp: Experience, opts: BuildOptions): Promise<BuildReport> {
  const songs = listSongs(exp);
  const only = opts.only?.length ? new Set(opts.only) : null;
  if (only) {
    const unknown = [...only].filter((p) => !songs.some((s) => s.piece === p));
    if (unknown.length) throw new Error(`No song ${unknown.join(', ')} in ${relative(exp.root, exp.sessions) || '.'}`);
  }
  mkdirSync(exp.out, { recursive: true });
  const state = readState(exp.out);
  const report: BuildReport = { built: [], fresh: [], removed: [] };
  for (const song of songs) {
    if (only && !only.has(song.piece)) continue;
    const bytes = new Uint8Array(readFileSync(song.file));
    const project = parseProject(JSON.parse(Buffer.from(bytes).toString('utf8')));
    const audioDir = audioFolder(exp.sessions, song.piece);
    const input = songInput(exp, bytes, project, audioDir);
    const output = `${song.piece}.wav`;
    const file = join(exp.out, output);
    const was = state.songs[song.piece];
    if (!opts.force && was?.input === input && existsSync(file) && statSync(file).size === was.bytes) {
      report.fresh.push(song.piece);
      continue;
    }
    opts.log(`${song.piece}: building "${project.title}"…`);
    const started = Date.now();
    const rendered = await renderSong(exp, project, audioDir, opts.fetch, opts.progress);
    const wav = encodeSong(exp, rendered);
    writeAtomic(file, wav);
    const seconds = (rendered.channels[0]?.length ?? 0) / rendered.rate;
    state.songs[song.piece] = {
      input,
      output,
      bytes: wav.length,
      sha256: sha256(wav),
      engine: exp.engine.source,
      node: process.versions.node,
      seconds: Math.round(seconds * 1000) / 1000,
      rate: rendered.rate,
      built: new Date().toISOString(),
    };
    writeState(exp.out, state);
    report.built.push({ piece: song.piece, seconds, took: (Date.now() - started) / 1000 });
  }
  // a song that's gone takes its build with it
  if (!only) {
    for (const piece of Object.keys(state.songs)) {
      if (songs.some((s) => s.piece === piece)) continue;
      if (NAME.test(piece)) rmSync(join(exp.out, `${piece}.wav`), { force: true });
      delete state.songs[piece];
      report.removed.push(piece);
    }
    writeState(exp.out, state);
  }
  return report;
}
