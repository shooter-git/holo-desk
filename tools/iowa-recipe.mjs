// `node tools/iowa-recipe.mjs [--data DIR]`: how to make the University of Iowa clarinet and bassoon
// notes from the university's own downloads, written into packs/manifests/iowa.json as its source.
//
// Each download is one dynamic's run of single notes. The pack's notes were cut out of them (from just
// before an attack to the end of its decay) with a 2 ms fade at each end. This finds where each
// installed note (HOLO_DATA_DIR's packs/iowa) sits in its run, checks that cutting it there gives the
// same file byte for byte, and records the downloads' checksums and every cut, so a build anywhere can
// fetch the runs and cut the notes itself.
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { decodeWav } from '../packages/engine/src/wav.ts';
import { cutNote, decodeAiff, floatWav } from '../packages/music/src/cut.ts';
import { packPaths } from '../packages/music/src/packs.ts';

const args = process.argv.slice(2);
const at = args.indexOf('--data');
const data = resolve(at >= 0 ? args[at + 1] : (process.env.HOLO_DATA_DIR ?? 'data'));
const manifestFile = resolve(import.meta.dirname, '../packs/manifests/iowa.json');
const text = readFileSync(manifestFile, 'utf8');
const pack = JSON.parse(text);
const samples = join(data, 'packs', 'iowa', pack.root || 'samples');

const BASE = 'https://theremin.music.uiowa.edu/sound files/MIS/Woodwinds/';
const RATE = 44100;
const FADE = Math.trunc(0.002 * RATE);
// the runs: [folder in the pack, folder on the site, file names]
const dyn = ['pp', 'mf', 'ff'];
const RUNS = [
  [
    'Clarinet',
    'Bbclarinet',
    [...dyn.flatMap((d) => ['D3B3', 'C4B4', 'C5B5', 'C6B6'].map((r) => `BbClar.${d}.${r}.aiff`)), 'BbClar.mf.C7.aiff'],
  ],
  [
    'Bassoon',
    'bassoon',
    [
      ...dyn.flatMap((d) => ['Bb1B1', 'C2B2', 'C4B4', 'C5D5'].map((r) => `Bassoon.${d}.${r}.aiff`)),
      'Bassoon.pp.C3B3.aiff',
      'Bassoon.mf.C3B3.aiff',
      'Bassoon.ff.C3Bb3.aiff',
    ],
  ],
];

const sha256 = (b) => createHash('sha256').update(b).digest('hex');
const encode = (p) => p.split('/').map(encodeURIComponent).join('/');

const downloads = {};
const cuts = {};
const wanted = new Set(packPaths(pack));
for (const [folder, site, names] of RUNS) {
  const notes = [...wanted].filter((p) => p.startsWith(`${folder}/`));
  for (const name of names) {
    const path = `${site}/${name}`;
    process.stdout.write(`${path}: `);
    const res = await fetch(`${BASE}${encode(path)}`);
    if (!res.ok) throw new Error(`${path}: ${res.status}`);
    const bytes = new Uint8Array(await res.arrayBuffer());
    downloads[path] = sha256(bytes);
    const run = decodeAiff(bytes);
    if (run.channels.length !== 1 || run.rate !== RATE) throw new Error(`${path}: not one channel at ${RATE} Hz`);
    const x = run.channels[0];
    const d = name.split('.')[1];
    let found = 0;
    for (const note of notes.filter((p) => p.endsWith(`_${d}.wav`) && !cuts[p])) {
      const file = join(samples, note);
      if (!existsSync(file)) continue;
      const own = readFileSync(file);
      const y = decodeWav(new Uint8Array(own)).channels[0];
      // the middle of the note (its start may be silence, which is everywhere); cuts begin on 10 ms
      const probe = Math.floor(y.length / 2);
      const mine = sha256(own);
      for (let s = 0; s + y.length <= x.length; s += 441) {
        let same = true;
        for (let i = probe; i < probe + 64 && same; i++) same = x[s + i] === y[i];
        if (same && sha256(floatWav(cutNote(x, s, y.length, FADE), RATE)) === mine) {
          cuts[note] = [path, s, y.length];
          found++;
          break;
        }
      }
    }
    console.log(`${found} note(s)`);
  }
}
const lost = [...wanted].filter((p) => !cuts[p]);
if (lost.length) {
  console.error(`${lost.length} note(s) not found in any run, e.g. ${lost[0]}`);
  process.exit(1);
}

const source = {
  kind: 'cut',
  note:
    "The University of Iowa Electronic Music Studios' recordings (free to use for any project, without restriction), " +
    'each note cut from its run as it is but for a 2 ms fade at each end.',
  base: BASE,
  rate: RATE,
  fade: FADE,
  // only the runs a note is cut from
  downloads: Object.fromEntries(
    Object.entries(downloads)
      .filter(([path]) => Object.values(cuts).some(([from]) => from === path))
      .sort(([a], [b]) => a.localeCompare(b)),
  ),
  cuts: Object.fromEntries(Object.entries(cuts).sort(([a], [b]) => a.localeCompare(b))),
};
// only the source changes: the rest of the file stays as it was written
// (a cut to a line)
const block = JSON.stringify(source, null, 1)
  .replace(/\[\n\s+("[^"]+"),\n\s+(\d+),\n\s+(\d+)\n\s+\]/g, '[$1, $2, $3]')
  .replace(/\n/g, '\n ');
const next = text.replace(/"source": \{[\s\S]*?\n \}/, () => `"source": ${block}`);
if (next === text && JSON.stringify(pack.source) !== JSON.stringify(source)) throw new Error('No source in iowa.json');
writeFileSync(manifestFile, next);
console.log(`iowa.json: ${Object.keys(source.downloads).length} downloads, ${Object.keys(cuts).length} notes`);
