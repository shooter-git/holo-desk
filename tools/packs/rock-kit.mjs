// `node tools/packs/rock-kit.mjs [--cache DIR] [--out DIR]`: the Rock Kit pack, from Karoryfer's Big
// Rusty Drums (CC0): a 24" kick, a 14x8 wooden snare, 14", 15" and 18" toms and a 22" kick played as a
// floor tom, a 17" crash, a 17" sizzle crash, a 22" ride, an 18" china and 14" hi-hats, close
// microphones and overheads. Mixed as the library's own default mixer has it (its faders and pans), with
// a little of the overheads on the kick for the room it was played in.
import { buildKit, Downloads, githubTree, hitsIn, raw } from './kit.mjs';
import { arg } from './lib.mjs';

const REPO = 'sfzinstruments/karoryfer.big-rusty-drums';
const COMMIT = 'f07ce00df34a46b6b08375be56fe116cf15782bc';
const bases = { rusty: raw(REPO, COMMIT) };
const downloads = new Downloads(arg('cache', `${process.env.HOME}/.cache/holo-pack-sources/rock-kit`), bases);
const paths = await githubTree(REPO, COMMIT, downloads);

/** A fader of the library's mixer (a CC value) at a mapping's amplitude: the linear gain. */
const fader = (cc, amplitude = 100) => (cc / 127) * (amplitude / 100);
const vl = (prefix) => new RegExp(`^${prefix}_vl(\\d+)_rr(\\d+)\\.flac$`);
const hits = (folder, mics, prefix) => hitsIn(paths, 'rusty', `Samples/${folder}`, mics, vl(prefix));

const snareMics = { btm: [fader(100)], top: [fader(40)], oh: [fader(60)] };
const snareDirs = { btm: 'btm', top: 'top', oh: 'oh' };
const tom = (size, pan, keys) => ({
  name: `tom-${size}`,
  keys,
  hits: hits(`tom_${size}/center`, { cl: 'cl', oh: 'oh' }, `t${size}`),
  mics: { cl: [fader(100), pan], oh: [fader(70)] },
  ring: 2.6,
  fade: 0.5,
  leadsRange: true,
});
const cymbal = (name, folder, prefix, keys, amplitude, pan, extra = {}) => ({
  name,
  keys,
  hits: hits(folder, { cl: 'cl', oh: 'oh' }, prefix),
  mics: { cl: [fader(40, amplitude), pan], oh: [fader(100, amplitude)] },
  ring: 5,
  fade: 1.4,
  floor: 56,
  maxRR: 2,
  ...extra,
});
const hat = (name, folder, prefix, keys, extra = {}) => ({
  name,
  keys,
  hits: hits(`hihat_14/${folder}`, { cl: 'cl', oh: 'oh' }, prefix),
  mics: { cl: [fader(100, 70)], oh: [fader(100, 70)] },
  group: 1,
  ...extra,
});

await buildKit({
  id: 'rock-kit',
  name: 'Rock Kit (Karoryfer Big Rusty Drums)',
  license: 'CC0-1.0',
  credit:
    'Big Rusty Drums by Karoryfer Samples (CC0): a 24" kick, a 14x8 snare, 14/15/18" toms and a 22" floor, ' +
    'Sabian and Zildjian cymbals. Mixed for HO[LO] from its close and overhead microphones.',
  note: "Big Rusty Drums' close and overhead microphones (FLAC, at the pinned commit), mixed at its own mixer's levels.",
  folder: 'rock',
  instrument: { name: 'kit', title: 'Rock Kit' },
  level: -19,
  downloads,
  bases,
  pieces: [
    {
      name: 'kick',
      keys: [35, 36],
      hits: hits('kick_24/kick', { kick: 'kick', oh: 'oh' }, 'k'),
      mics: { kick: [fader(100)], oh: [0.3] },
      ring: 1.6,
      fade: 0.35,
      leadsRange: true,
    },
    { name: 'sidestick', keys: [37], hits: hits('snare_14/sidestick', snareDirs, 'sn_ss'), mics: snareMics, ring: 0.8 },
    {
      name: 'snare',
      keys: [38],
      hits: hits('snare_14/center', snareDirs, 'sn_center'),
      mics: snareMics,
      ring: 1.6,
      fade: 0.4,
      leadsRange: true,
    },
    {
      name: 'snare-edge',
      keys: [39],
      hits: hits('snare_14/edge', snareDirs, 'sn_edge'),
      mics: snareMics,
      ring: 1.6,
      fade: 0.4,
    },
    {
      name: 'rimshot',
      keys: [40],
      hits: hits('snare_14/rimshot', snareDirs, 'sn_rims'),
      mics: snareMics,
      ring: 1.8,
      fade: 0.4,
    },
    tom(22, 107, [41]),
    tom(18, 87, [43]),
    tom(15, 40, [45, 47]),
    tom(14, 20, [48, 50]),
    hat('hat-closed', 'tc', 'ht_tc', [42], { ring: 0.8 }),
    hat('hat-pedal', 'chik', 'ht_chik', [44], { ring: 0.8 }),
    hat('hat-open', 'open', 'ht_open', [46], { offBy: 1, ring: 3, fade: 0.8 }),
    hat('hat-loose', 'lc', 'ht_lc', [22], { offBy: 1, ring: 1.5, fade: 0.4 }),
    hat('hat-half', 'ho', 'ht_ho', [26], { offBy: 1, ring: 2.5, fade: 0.6 }),
    cymbal('crash', 'crash_17/cr', 'cr', [49], 70, 30),
    cymbal('crash-sizzle', 'crash_sizzle_17/cr', 'crs', [57], 60, 53),
    cymbal('china', 'china_18/cn', 'cn', [52], 70, 50),
    cymbal('ride', 'ride_22/rd', 'rd', [51], 60, 97, { ring: 4, maxRR: 3 }),
    cymbal('ride-bell', 'ride_22/bl', 'rd_bl', [53], 60, 97, { ring: 4 }),
    cymbal('ride-edge', 'ride_22/ed', 'rd_ed', [59], 60, 97, { ring: 4.5 }),
  ],
});
