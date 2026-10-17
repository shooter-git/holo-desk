/**
 * The music of an experience, built with a pinned copy of HO[LO]'s engine: what a project runs
 * (`node music/holo/holo-music.mjs build`, or `npm run music`) to make its songs without HO[LO] Desk,
 * exactly as the studio renders them. `help` lists the commands.
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { decodeWav } from '@holo/engine';
import { parseProject } from '@holo/session';
import {
  buildMusic,
  checkNode,
  type Experience,
  encodeSong,
  findRoot,
  listSongs,
  openExperience,
  renderSong,
  writeAtomic,
} from './build.ts';
import { describeDistance, distance } from './compare.ts';
import { defaultCacheDir, type FetchOptions, fetchFiles, SampleCache } from './fetch.ts';
import { engineLabel } from './identity.ts';
import { type NeededFile, packPaths, songFiles } from './packs.ts';
import { PINNED } from './pinned.ts';
import { audioFolder } from './source.ts';

const argv = process.argv.slice(2);
const command = argv.shift() ?? 'help';
const flags = new Map<string, string | true>();
const words: string[] = [];
const SWITCHES = new Set(['force', 'any-node', 'all', 'json', 'help']);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i] as string;
  if (!a.startsWith('--')) {
    words.push(a);
    continue;
  }
  const [k, inline] = a.slice(2).split('=', 2) as [string, string | undefined];
  if (inline !== undefined) flags.set(k, inline);
  else if (SWITCHES.has(k)) flags.set(k, true);
  else if (argv[i + 1] !== undefined && !(argv[i + 1] as string).startsWith('--')) flags.set(k, argv[++i] as string);
  else flags.set(k, true);
}
const flag = (k: string) => {
  const v = flags.get(k);
  return v === true ? undefined : v;
};
const has = (k: string) => flags.has(k);
const say = (line: string) => console.log(line);
const warn = (line: string) => console.error(line);
const progress = process.stderr.isTTY ? (text: string) => process.stderr.write(`\r  ${text.padEnd(44)}`) : undefined;
const endProgress = () => progress && process.stderr.write(`\r${' '.repeat(47)}\r`);

const HELP = `holo-music: an experience's music, built with a pinned copy of HO[LO]'s engine${PINNED ? ` (${engineLabel(PINNED)})` : ''}

  build [PIECE…] [--force]       build the songs whose files changed (all of them with --force)
  render PIECE [--sessions DIR] [--out FILE.wav]
                                 one song to a file, wherever you like (the studio's "Hear it as…" runs this)
  fetch [--all]                  fetch and check the samples the songs play (--all: every pinned library)
  check                          the engine, Node.js, the songs and their samples, without building
  version [--json]               the engine this is
  compare A.wav B.wav            how far two renders are apart

  --root DIR      the project (else the nearest holo.creation.json at or above this folder)
  --from DIR      a folder that already has some libraries' files (a HO[LO] data folder, a download)
  --any-node      build with this Node.js even if it isn't the pinned one (the build records it)

Samples are fetched from each library's pinned source, checked by sha256 and kept in
${defaultCacheDir()} (HOLO_MUSIC_CACHE moves it). Nothing here needs HO[LO] Desk.`;

function open(): { exp: Experience; fetch: FetchOptions } {
  const root = flag('root') ? resolve(flag('root') as string) : findRoot(process.cwd());
  const exp = openExperience(root, PINNED);
  const from = flag('from');
  return {
    exp,
    fetch: {
      cache: new SampleCache(defaultCacheDir()),
      ...(from ? { from: [resolve(from)] } : {}),
      log: (line) => {
        endProgress();
        warn(`  ${line}`);
      },
    },
  };
}

async function main(): Promise<void> {
  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      say(HELP);
      return;

    case 'version': {
      const self = PINNED;
      if (has('json')) {
        say(JSON.stringify(self, null, 2));
        return;
      }
      if (!self) say("HO[LO]'s engine, run from its sources (not pinned)");
      else say(`HO[LO] engine ${engineLabel(self)}${self.date ? `, ${self.date.slice(0, 10)}` : ''} (${self.source})`);
      return;
    }

    case 'build': {
      const { exp, fetch } = open();
      checkNode(exp, has('any-node'), warn);
      const report = await buildMusic(exp, {
        only: words,
        force: has('force'),
        fetch,
        log: (line) => {
          endProgress();
          say(line);
        },
        ...(progress ? { progress } : {}),
      });
      endProgress();
      const here = relative(process.cwd(), exp.out);
      const where = here.startsWith('..') ? relative(exp.root, exp.out) : here || '.';
      for (const b of report.built)
        say(`  ${b.piece}.wav: ${b.seconds.toFixed(1)} s of music in ${b.took.toFixed(1)} s`);
      for (const r of report.removed) say(`  ${r}.wav: removed (its song is gone)`);
      say(
        report.built.length
          ? `Built ${report.built.length} song${report.built.length === 1 ? '' : 's'} into ${where}${report.fresh.length ? `; ${report.fresh.length} already up to date` : ''}.`
          : `Nothing to build: ${report.fresh.length} song${report.fresh.length === 1 ? ' is' : 's are'} up to date in ${where}.`,
      );
      return;
    }

    case 'render': {
      const piece = words[0];
      if (!piece) throw new Error('render PIECE [--sessions DIR] [--out FILE.wav]');
      const { exp, fetch } = open();
      // a preview to listen to: another Node.js is said, not refused
      checkNode(exp, true, warn);
      const sessions = flag('sessions') ? resolve(flag('sessions') as string) : exp.sessions;
      const file = join(sessions, `${piece}.holo.json`);
      if (!existsSync(file)) throw new Error(`No song ${piece} in ${sessions}`);
      const project = parseProject(JSON.parse(readFileSync(file, 'utf8')));
      const out = resolve(flag('out') ?? `${piece}.wav`);
      const started = Date.now();
      const rendered = await renderSong(exp, project, audioFolder(sessions, piece), fetch, progress);
      writeAtomic(out, encodeSong(exp, rendered));
      endProgress();
      say(
        `Rendered "${project.title}": ${((rendered.channels[0]?.length ?? 0) / rendered.rate).toFixed(1)} s at ${rendered.rate} Hz in ${((Date.now() - started) / 1000).toFixed(1)} s: ${out}`,
      );
      return;
    }

    case 'fetch':
    case 'check': {
      const { exp, fetch } = open();
      const problems: string[] = [];
      if (process.versions.node !== exp.engine.node)
        problems.push(`Node.js is ${process.versions.node}; the music builds with ${exp.engine.node}`);
      const need = new Map<string, NeededFile>();
      const songs = listSongs(exp);
      for (const s of songs) {
        try {
          const project = parseProject(JSON.parse(readFileSync(s.file, 'utf8')));
          const found = songFiles(project, exp.packs);
          for (const f of found.files) need.set(f.sha256, f);
          problems.push(...found.problems.map((p) => `${s.piece}: ${p}`));
          for (const a of project.files ?? []) {
            const dir = audioFolder(exp.sessions, s.piece);
            if (!existsSync(dir) || !readdirSync(dir).some((f) => f.startsWith(`${a.id}.`)))
              problems.push(`${s.piece}: its audio file ${a.name} isn't in ${relative(exp.root, dir)}`);
          }
        } catch (err) {
          problems.push(`${s.piece}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      if (has('all')) {
        for (const pack of exp.packs.packs) {
          if (pack.source.kind === 'local') continue;
          for (const path of packPaths(pack))
            need.set(pack.files[path] as string, { pack, path, sha256: pack.files[path] as string });
        }
      }
      const files = [...need.values()];
      const missing = files.filter((f) => !fetch.cache.has(f.sha256, f.path.slice(f.path.lastIndexOf('.'))));
      if (command === 'fetch') {
        await fetchFiles(files, fetch);
        endProgress();
        say(`${files.length} sample file(s) ready (${missing.length} fetched) in ${fetch.cache.dir}`);
      } else {
        say(`${exp.manifest.title}: engine ${engineLabel(exp.engine)}, Node.js ${exp.engine.node}`);
        say(
          `  ${songs.length} song(s) in ${relative(exp.root, exp.sessions)}, built into ${relative(exp.root, exp.out)}`,
        );
        say(`  ${files.length} sample file(s), ${missing.length} not fetched yet (\`fetch\` brings them)`);
      }
      for (const p of problems) warn(`  ${p}`);
      if (problems.length && command === 'check') process.exitCode = 1;
      return;
    }

    case 'compare': {
      const [a, b] = words;
      if (!a || !b) throw new Error('compare A.wav B.wav');
      const x = decodeWav(new Uint8Array(readFileSync(a)));
      const y = decodeWav(new Uint8Array(readFileSync(b)));
      if (x.rate !== y.rate) {
        say(`They're at different rates: ${x.rate} and ${y.rate} Hz`);
        process.exitCode = 1;
        return;
      }
      const d = distance(x.channels, y.channels);
      say(describeDistance(d, x.rate));
      if (!d.identical) process.exitCode = 1;
      return;
    }

    default:
      throw new Error(`Unknown command "${command}": help lists them`);
  }
}

main().catch((err: unknown) => {
  endProgress();
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
