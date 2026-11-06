// `node tools/packs/jazz-kit.mjs [--cache DIR] [--out DIR]`: the Jazz Kit pack, from Virtuosity Drums
// by Versilian Studios and Karoryfer Samples (CC0): a contemporary jazz kit recorded at 48 kHz on six
// microphones at once. Every hit is mixed from the same four (kick, snare, the overheads and a little of
// the room), as a jazz session is: the overheads lead, the close microphones fill in, and each drum's
// sound carries what the others' microphones heard of it.
//
// The snare has 36 velocity layers at the centre and 36 off it: they take turns, so a snare played
// twice alike never sounds twice alike. The toms likewise (centre and off centre).
import { buildKit, Downloads, githubTree, hitsIn, raw } from './kit.mjs';
import { arg } from './lib.mjs';

const REPO = 'sfzinstruments/virtuosity_drums';
const COMMIT = '9f04cf9a734527edfbb0a4eee1f674e45bbf71bc';
const bases = { virt: raw(REPO, COMMIT) };
const downloads = new Downloads(arg('cache', `${process.env.HOME}/.cache/holo-pack-sources/jazz-kit`), bases);
const paths = await githubTree(REPO, COMMIT, downloads);

/** The console: kick and snare microphones, the overheads leading, a little of the room. */
const MICS = { kick: [0.8], snare: [0.7], oh: [1], room: [0.4] };
const DIRS = { kick: 'kickmic', snare: 'snaremic', oh: 'oh', room: 'room' };
const hits = (piece, art, rr) => {
  const mics = Object.fromEntries(Object.entries(DIRS).map(([m, d]) => [m, `${d}/${piece}`]));
  const found = hitsIn(
    paths,
    'virt',
    'Samples',
    mics,
    new RegExp(`^[a-z]+_${piece}_${art}_vl(\\d+)(?:_rr(\\d+))?\\.flac$`),
  );
  return rr ? found.map((h) => ({ ...h, rr })) : found;
};
/** Two articulations (centre and off centre) as round robins of one. */
const pair = (piece, a, b) => [...hits(piece, a, 1), ...hits(piece, b, 2)];
/** A layer the second set lacks plays the first's alone (layers are matched by number). */
const matched = (list) => {
  const layers = new Set(list.filter((h) => h.rr === 2).map((h) => h.layer));
  return list.filter((h) => h.rr === 1 || layers.has(h.layer));
};

const drum = (name, keys, list, extra = {}) => ({ name, keys, hits: list, mics: MICS, ring: 2, fade: 0.4, ...extra });
const cymbal = (name, keys, list, extra = {}) => drum(name, keys, list, { ring: 6, fade: 1.6, floor: 56, ...extra });

await buildKit({
  id: 'jazz-kit',
  name: 'Jazz Kit (Virtuosity Drums)',
  license: 'CC0-1.0',
  credit:
    'Virtuosity Drums by Versilian Studios and Karoryfer Samples (CC0): a contemporary jazz kit. Mixed for HO[LO] ' +
    'from its kick, snare, overhead and room microphones.',
  note: "Virtuosity Drums' kick, snare, overhead and room microphones (FLAC, at the pinned commit), mixed as one session.",
  folder: 'jazz',
  instrument: { name: 'kit', title: 'Jazz Kit' },
  level: -19,
  downloads,
  bases,
  pieces: [
    drum('kick', [35, 36], hits('kick', 'snon'), { ring: 1.4, fade: 0.3, leadsRange: true }),
    drum('cross-stick', [37], hits('snare', 'crossstick'), { ring: 0.8 }),
    drum('snare', [38], matched(pair('snare', 'center', 'offcenter')), { ring: 1.6, fade: 0.4, leadsRange: true }),
    drum('buzz', [39], hits('snare', 'buzz'), { ring: 1.6 }),
    drum('rimshot', [40], hits('snare', 'rimshot'), { ring: 1.8 }),
    drum('floor-tom', [41, 43, 45], matched(pair('ltom', 'center', 'offcenter')), {
      ring: 2.6,
      fade: 0.6,
      leadsRange: true,
    }),
    drum('rack-tom', [47, 48, 50], matched(pair('htom', 'center', 'offcenter')), {
      ring: 2.4,
      fade: 0.6,
      leadsRange: true,
    }),
    drum('hat-closed', [42], hits('hh', 'closed'), { group: 1, ring: 0.8, fade: 0.2 }),
    drum('hat-pedal', [44], hits('hh', 'pedal'), { group: 1, ring: 0.8, fade: 0.2 }),
    drum('hat-open', [46], hits('hh', 'open'), { group: 1, offBy: 1, ring: 3, fade: 0.8 }),
    drum('hat-half', [22], hits('hh', 'half'), { group: 1, offBy: 1, ring: 1.5, fade: 0.4 }),
    drum('hat-three-quarter', [26], hits('hh', '34'), { group: 1, offBy: 1, ring: 2.2, fade: 0.5 }),
    cymbal('ride', [51], hits('ride', 'ride')),
    cymbal('ride-bell', [53], hits('ride', 'bell')),
    cymbal('flat-ride', [59], hits('flatride', 'ride')),
    cymbal('crash', [49], hits('crash', 'crash')),
    cymbal('crash-sizzle', [57], hits('crash', 'sizzle')),
    cymbal('flat-ride-crash', [55], hits('flatride', 'crash'), { ring: 5 }),
  ],
});
