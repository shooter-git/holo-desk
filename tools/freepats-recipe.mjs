// `node tools/freepats-recipe.mjs [--data DIR]`: how to make the FreePats Spanish Classical Guitar's
// notes from the FreePats project's own download, written into packs/manifests/freepats-guitar.json as
// its source.
//
// The download is a 7z of FLAC files (one a note, CC0). The pack's notes were made from them with
// ffmpeg (`-c:a pcm_s16le`), which decodes each FLAC and writes a 16-bit WAV with an INFO tag naming
// itself. This fetches the archive, records its checksum, matches each installed note (HOLO_DATA_DIR's
// packs/freepats-guitar) to its FLAC, checks that decoding it and writing the WAV that way gives the
// same file byte for byte, and records the entries, so a build anywhere can fetch the archive and make
// the notes itself.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { decodeFlac, pcmWav } from '../packages/music/src/flac.ts';
import { packPaths } from '../packages/music/src/packs.ts';
import { SevenZip } from '../packages/music/src/sevenzip.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--data');
const data = resolve(at >= 0 ? args[at + 1] : (process.env.HOLO_DATA_DIR ?? 'data'));
const manifestFile = resolve(import.meta.dirname, '../packs/manifests/freepats-guitar.json');
const text = readFileSync(manifestFile, 'utf8');
const pack = JSON.parse(text);
const samples = join(data, 'packs', 'freepats-guitar', pack.root || 'samples');

const URL = 'https://freepats.zenvoid.org/Guitar/SpanishClassicalGuitar/SpanishClassicalGuitar-SFZ+FLAC-20190618.7z';

const sha256 = (b) => createHash('sha256').update(b).digest('hex');

/** The ISFT tag of a WAV's INFO list, if it has one. */
function software(wav) {
  let p = 12;
  while (p + 8 <= wav.length) {
    const id = wav.toString('latin1', p, p + 4);
    const size = wav.readUInt32LE(p + 4);
    if (id === 'LIST' && wav.toString('latin1', p + 8, p + 12) === 'INFO') {
      let q = p + 12;
      while (q + 8 <= p + 8 + size) {
        const tag = wav.toString('latin1', q, q + 4);
        const n = wav.readUInt32LE(q + 4);
        if (tag === 'ISFT') return wav.toString('latin1', q + 8, q + 8 + n).replace(/\0+$/, '');
        q += 8 + n + (n & 1);
      }
    }
    p += 8 + size + (size & 1);
  }
  return undefined;
}

process.stdout.write(`${URL}: `);
const res = await fetch(URL);
if (!res.ok) throw new Error(`${URL}: ${res.status}`);
const bytes = new Uint8Array(await res.arrayBuffer());
const hash = sha256(bytes);
console.log(`${bytes.length} bytes, sha256 ${hash}`);
const archive = new SevenZip(bytes);
const flacs = new Map(
  archive
    .names()
    .filter((n) => n.endsWith('.flac'))
    .map((n) => [basename(n, '.flac'), n]),
);

const entries = {};
let tag;
const wrong = [];
for (const path of packPaths(pack)) {
  const entry = flacs.get(basename(path, '.wav'));
  if (!entry) throw new Error(`${path}: no FLAC of that name in the archive`);
  entries[path] = entry;
  const file = join(samples, path);
  if (!existsSync(file)) {
    wrong.push(`${path} (not installed)`);
    continue;
  }
  const own = readFileSync(file);
  if (tag === undefined) tag = software(own);
  const made = pcmWav(decodeFlac(archive.read(entry)), tag);
  if (!own.equals(made)) wrong.push(path);
}
console.log(
  `${Object.keys(entries).length} notes, ${wrong.length} differ from the installed ones${tag ? ` (written by ${tag})` : ''}`,
);
if (wrong.length) {
  console.error(`  e.g. ${wrong.slice(0, 5).join(', ')}`);
  process.exitCode = 1;
}

const source = {
  kind: 'archive',
  note:
    "The FreePats project's SFZ+FLAC download (CC0), each note decoded from its FLAC and written as the 16-bit WAV " +
    'ffmpeg wrote the first time, its INFO tag and all.',
  url: URL,
  sha256: hash,
  ...(tag ? { software: tag } : {}),
  entries,
};
// only the source changes: the rest of the file stays as it was written
const block = JSON.stringify(source, null, 1).replace(/\n/g, '\n ');
const next = text.replace(/"source": \{[\s\S]*?\n \}/, () => `"source": ${block}`);
if (next === text && JSON.stringify(pack.source) !== JSON.stringify(source))
  throw new Error('No source in freepats-guitar.json');
writeFileSync(manifestFile, next);
console.log(`freepats-guitar.json: ${Object.keys(entries).length} entries of ${basename(URL)}`);
